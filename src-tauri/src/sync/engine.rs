//! 同步引擎：diff 计算、push/pull、LWW 冲突解决、本地版本追踪。
//!
//! 核心概念：
//! - 每个同步项有一个 per-key 递增版本号
//! - push 时，服务端比较版本号：version > 当前版本 才接受
//! - 本地维护 `last_sync_versions`：上次成功同步后每个 key 的版本号
//! - diff = 本地当前值 vs 上次同步的值，算出变更集
//! - pull 返回 version > last_sync_versions[key] 的项
//!
//! 本地版本追踪：
//! - 每个设备维护一份 `local_versions.json`，记录每个 key 的版本号
//! - 本地值变更时，版本号 +1
//! - push 成功后，更新 last_sync_versions

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::AppError;
use crate::sync::accessor::SyncStoreAccessor;
use crate::sync::client::{
    PullRequest, PullResponse, PushRequest, PushResponse, SnapshotResponse, SyncClient, SyncItem,
};
use crate::sync::crypto;
use crate::sync::keychain;
use crate::sync::merge::{self, MergeResult};
use crate::sync::profile::{Platform, SyncProfile};

/// 本地版本追踪文件名
const LOCAL_VERSIONS_FILE: &str = "sync_local_versions.json";

/// SyncProfile 持久化文件名。
///
/// 与 `sync_local_versions.json` 同目录（config_dir）。
/// 用户在冲突 UI 选"永久跳过"会更新 SyncProfile.excluded_keys，
/// 必须持久化到磁盘，否则重启后失效。
const PROFILE_FILE: &str = "sync_profile.json";

/// 待解决冲突的持久化文件名。
/// 推迟功能：用户关闭冲突 UI（不解决）时，pending_conflicts 跨重启保留。
const PENDING_CONFLICTS_FILE: &str = "sync_pending_conflicts.json";

/// 一个待解决的冲突项。
///
/// pull 时检测到冲突（本地和远程都改了同一 key 且值不同），
/// 缓存到内存，等用户通过 UI 决策后调用 `resolve_conflict` 解决。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingConflict {
    /// 冲突的 key（如 `settings.fontSize`、`connections.abc`）
    pub key: String,
    /// 远程版本号
    pub remote_version: i64,
    /// base（上次同步的值，明文 JSON 字符串）
    pub base: Option<String>,
    /// ours（当前本地值，明文 JSON 字符串）
    pub ours: Option<String>,
    /// theirs（远程值，明文 JSON 字符串）
    pub theirs: Option<String>,
}

/// 冲突解决动作（用户在 UI 选择后传入 engine）。
#[derive(Debug, Clone)]
pub enum ConflictAction {
    /// 保留本地值（不 apply 本地；bump 版本号 + 触发 push 让远程更新）
    UseOurs,
    /// 用远程值（apply theirs；更新版本表为 remote_version；不 push）
    UseTheirs,
    /// 跳过本次（不 apply，不更新版本表；下次 pull 还会冲突）
    SkipOnce,
    /// 永久跳过（加进 excluded_keys + 持久化 SyncProfile；下次 pull 该 key 被 profile 过滤掉）
    SkipForever,
    /// 用自定义值（apply custom；bump 版本号 + 触发 push 让远程更新）
    UseCustom(String),
    /// Fork：保留本地原会话，远程内容另存为新会话（仅用于 conversations.* 冲突）。
    /// 新会话 id = `{原id}-fork-{ts}`，bump 原会话版本号 + 标记新会话为本地变更 + 触发 push。
    Fork,
}

/// 冲突解决结果（由 engine 返回，调用方据此决定是否触发 push）。
#[derive(Debug, Clone)]
pub enum ResolveOutcome {
    /// 已 bump 版本号，调用方应触发 push（UseOurs / UseCustom / Fork）
    PushNeeded,
    /// 已 apply theirs，无需 push（UseTheirs）
    AppliedTheirs,
    /// 跳过本次（SkipOnce）
    Skipped,
    /// 已加入排除清单并持久化（SkipForever）
    Excluded,
}

/// 本地版本表：每个 key 的当前版本号 + 上次同步的值（用于 diff）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct LocalVersionTable {
    /// key → 当前版本号
    pub versions: HashMap<String, i64>,
    /// key → 上次同步的加密值（用于 diff 比对）
    pub last_synced_values: HashMap<String, String>,
    /// key → 上次成功 push/pull 后的版本号（用于 pull 增量）
    pub last_sync_versions: HashMap<String, i64>,
}

impl LocalVersionTable {
    pub fn get_version(&self, key: &str) -> i64 {
        self.versions.get(key).copied().unwrap_or(0)
    }

    /// 本地值变更，递增版本号。
    pub fn bump_version(&mut self, key: &str) -> i64 {
        let v = self.versions.entry(key.to_string()).or_insert(0);
        *v += 1;
        *v
    }

    /// 记录已同步的值（push 或 pull 后）。
    pub fn record_synced(&mut self, key: &str, version: i64, encrypted_value: Option<&str>) {
        self.versions.insert(key.to_string(), version);
        self.last_sync_versions.insert(key.to_string(), version);
        match encrypted_value {
            Some(v) => {
                self.last_synced_values.insert(key.to_string(), v.to_string());
            }
            None => {
                self.last_synced_values.remove(&key.to_string());
            }
        }
    }
}

/// 同步引擎状态
pub struct SyncEngine {
    /// 配置目录（用于持久化 local_versions.json）
    config_dir: PathBuf,
    /// 本地版本表（内存缓存，启动时加载，变更时持久化）
    local_versions: RwLock<LocalVersionTable>,
    /// 持久化锁（防止并发写入文件）
    persist_lock: Mutex<()>,
    /// sync_profile（用户选择的同步项）
    profile: RwLock<SyncProfile>,
    /// 平台
    platform: Platform,
    /// 数据访问器（在 lib.rs setup 阶段注入，用于读写真实配置值）
    accessor: RwLock<Option<Arc<SyncStoreAccessor>>>,
    /// 待解决的冲突列表（pull 时检测到，等用户通过 UI 决策）
    /// 非空时表示有冲突等待处理，下次 pull 会阻塞或追加
    pending_conflicts: RwLock<Vec<PendingConflict>>,
}

impl SyncEngine {
    /// 创建引擎实例。config_dir 用于持久化 local_versions.json。
    pub fn new(config_dir: PathBuf, profile: SyncProfile) -> Self {
        let platform = Platform::current();
        let local_versions = RwLock::new(LocalVersionTable::default());

        Self {
            config_dir,
            local_versions,
            persist_lock: Mutex::new(()),
            profile: RwLock::new(profile),
            platform,
            accessor: RwLock::new(None),
            pending_conflicts: RwLock::new(Vec::new()),
        }
    }

    /// 注入数据访问器（在 lib.rs setup 阶段调用）。
    pub fn set_accessor(&self, accessor: Arc<SyncStoreAccessor>) {
        *self.accessor.write() = Some(accessor);
    }

    /// 转发 AppHandle 给 accessor，让 accessor 能 emit "sync-data-applied" 事件。
    /// 在 lib.rs setup 阶段调用（此时 AppHandle 才可用）。
    pub fn set_accessor_app_handle(&self, handle: tauri::AppHandle) {
        if let Some(ref accessor) = *self.accessor.read() {
            accessor.set_app_handle(handle);
        }
    }

    /// 从磁盘加载本地版本表 + SyncProfile。
    ///
    /// 数据迁移：如果存在旧的 `"settings"` 整体 key（v1 同步格式），清理掉。
    /// v2 改为字段级同步（`settings.fontSize` 等），整体 key 不再使用。
    /// 旧 key 不清理会导致 `read_value("settings")` 返回整个 settings JSON，
    /// 与字段级 key 冲突（同一份数据两种 key 同时存在）。
    ///
    /// SyncProfile 加载：从 `sync_profile.json` 读取，覆盖构造时传入的 default。
    /// 文件不存在或解析失败时保留 default，不阻塞启动。
    pub async fn load(&self) -> Result<(), AppError> {
        let path = self.config_dir.join(LOCAL_VERSIONS_FILE);
        let mut table = if path.exists() {
            let data = tokio::fs::read_to_string(&path).await.map_err(|e| {
                AppError::Config(format!("读取 sync_local_versions.json 失败：{}", e))
            })?;
            if data.trim().is_empty() {
                LocalVersionTable::default()
            } else {
                serde_json::from_str(&data).map_err(|e| {
                    AppError::Config(format!("解析 sync_local_versions.json 失败：{}", e))
                })?
            }
        } else {
            LocalVersionTable::default()
        };

        // 数据迁移：清理旧的 "settings" 整体 key
        let was_migrated = table.versions.remove("settings").is_some()
            || table.last_sync_versions.remove("settings").is_some()
            || table.last_synced_values.remove("settings").is_some();
        if was_migrated {
            log::info!("[sync] 数据迁移：已清理旧的 'settings' 整体 key（v1 → v2 字段级）");
        }

        let mut local = self.local_versions.write();
        *local = table;
        drop(local);

        // 如果发生了迁移，立即持久化清理后的版本表
        if was_migrated {
            self.persist().await?;
        }

        // 加载 SyncProfile（失败不阻塞启动，保留 default）
        let profile_path = self.config_dir.join(PROFILE_FILE);
        if profile_path.exists() {
            match tokio::fs::read_to_string(&profile_path).await {
                Ok(data) if !data.trim().is_empty() => {
                    match serde_json::from_str::<SyncProfile>(&data) {
                        Ok(loaded) => {
                            log::info!(
                                "[sync] 已加载 SyncProfile（excluded_keys: {} 项）",
                                loaded.excluded_keys.len()
                            );
                            *self.profile.write() = loaded;
                        }
                        Err(e) => {
                            log::warn!(
                                "[sync] 解析 sync_profile.json 失败：{}，保留 default",
                                e
                            );
                        }
                    }
                }
                Ok(_) => {
                    log::warn!("[sync] sync_profile.json 为空，保留 default");
                }
                Err(e) => {
                    log::warn!(
                        "[sync] 读取 sync_profile.json 失败：{}，保留 default",
                        e
                    );
                }
            }
        }

        // 加载 pending_conflicts（推迟功能：未解决的冲突跨重启保留）
        let pending_path = self.config_dir.join(PENDING_CONFLICTS_FILE);
        if pending_path.exists() {
            match tokio::fs::read_to_string(&pending_path).await {
                Ok(data) if !data.trim().is_empty() => {
                    match serde_json::from_str::<Vec<PendingConflict>>(&data) {
                        Ok(loaded) => {
                            log::info!(
                                "[sync] 已加载 {} 项未解决冲突（推迟功能）",
                                loaded.len()
                            );
                            *self.pending_conflicts.write() = loaded;
                        }
                        Err(e) => {
                            log::warn!(
                                "[sync] 解析 sync_pending_conflicts.json 失败：{}，保留空",
                                e
                            );
                        }
                    }
                }
                Ok(_) => {
                    log::warn!("[sync] sync_pending_conflicts.json 为空");
                }
                Err(e) => {
                    log::warn!(
                        "[sync] 读取 sync_pending_conflicts.json 失败：{}，保留空",
                        e
                    );
                }
            }
        }

        Ok(())
    }

    /// 持久化本地版本表到磁盘。
    async fn persist(&self) -> Result<(), AppError> {
        let _lock = self.persist_lock.lock().await;

        let path = self.config_dir.join(LOCAL_VERSIONS_FILE);
        let data = {
            let local = self.local_versions.read();
            serde_json::to_string_pretty(&*local)?
        };

        tokio::fs::write(&path, data)
            .await
            .map_err(|e| AppError::Config(format!("写入 sync_local_versions.json 失败：{}", e)))?;

        Ok(())
    }

    /// 持久化 SyncProfile 到磁盘。
    /// 在 `update_profile` / `add_excluded_key` / `remove_excluded_key` 后调用。
    pub async fn persist_profile(&self) -> Result<(), AppError> {
        let path = self.config_dir.join(PROFILE_FILE);
        let data = {
            let profile = self.profile.read();
            serde_json::to_string_pretty(&*profile)?
        };

        tokio::fs::write(&path, data)
            .await
            .map_err(|e| AppError::Config(format!("写入 sync_profile.json 失败：{}", e)))?;

        Ok(())
    }

    /// 持久化 pending_conflicts 到磁盘（推迟功能）。
    /// 在 pull 检测到新冲突 / resolve_conflict / resolve_all_conflicts / clear 后调用。
    /// 失败时只 log warn，不传播错误（写文件失败不应阻塞 pull 主流程，下次解决时会再写）。
    async fn persist_pending_conflicts(&self) {
        let path = self.config_dir.join(PENDING_CONFLICTS_FILE);
        let data = {
            let conflicts = self.pending_conflicts.read();
            match serde_json::to_string_pretty(&*conflicts) {
                Ok(d) => d,
                Err(e) => {
                    log::warn!("[sync] 序列化 pending_conflicts 失败：{}", e);
                    return;
                }
            }
        };
        if let Err(e) = tokio::fs::write(&path, data).await {
            log::warn!("[sync] 写入 sync_pending_conflicts.json 失败：{}", e);
        }
    }

    /// 读取当前 SyncProfile（克隆）。
    pub fn profile(&self) -> SyncProfile {
        self.profile.read().clone()
    }

    /// 添加字段级排除项并持久化（用户在冲突 UI 选"永久跳过"时调用）。
    pub async fn add_excluded_key(&self, key: impl Into<String>) -> Result<(), AppError> {
        {
            let mut profile = self.profile.write();
            profile.add_excluded_key(key);
        }
        self.persist_profile().await
    }

    /// 移除字段级排除项并持久化（用户在设置 UI 重新启用某字段时调用）。
    pub async fn remove_excluded_key(&self, key: &str) -> Result<(), AppError> {
        {
            let mut profile = self.profile.write();
            profile.remove_excluded_key(key);
        }
        self.persist_profile().await
    }

    /// 记录本地值变更（由配置变更触发点调用）。
    ///
    /// `key` 是扁平化路径（如 `settings.fontSize`）。
    /// `value` 是明文值（会被加密后存储到 last_synced_values 用于 diff）。
    ///
    /// 返回新的版本号。实际 push 由 scheduler 防抖后执行。
    pub fn record_local_change(&self, key: &str, value: &str) -> Result<i64, AppError> {
        // 平台 + profile 过滤
        let sync_key = crate::sync::profile::SyncKey::new(key);
        let profile = self.profile.read();
        if !profile.should_sync(&sync_key, self.platform) {
            return Ok(0); // 不同步，返回 0 表示跳过
        }

        let mut local = self.local_versions.write();

        // 检查值是否真的变了（避免无变更 bump 版本）
        if let Some(last) = local.last_synced_values.get(key) {
            if last == value {
                return Ok(local.get_version(key)); // 值没变，不 bump
            }
        }

        let new_version = local.bump_version(key);
        // 暂存新值（未加密，push 时才加密）
        // 注意：这里不存明文，只在 push 时加密。last_synced_values 存的是加密后的值。
        // 但为了 diff 比对，我们需要存明文用于比较。
        // 改为：存明文到临时字段，push 时加密后更新 last_synced_values。
        // 简化：直接用 value 做比较，push 时加密。
        drop(local);

        Ok(new_version)
    }

    /// 记录本地删除（key 被删除）。
    pub fn record_local_delete(&self, key: &str) -> Result<i64, AppError> {
        let sync_key = crate::sync::profile::SyncKey::new(key);
        let profile = self.profile.read();
        if !profile.should_sync(&sync_key, self.platform) {
            return Ok(0);
        }

        let mut local = self.local_versions.write();
        let new_version = local.bump_version(key);
        local.last_synced_values.remove(key); // 删除标记
        drop(local);

        Ok(new_version)
    }

    /// 计算 pending changes：本地版本 > last_sync_version 的项。
    ///
    /// `get_current_value` 是一个闭包，用于获取 key 的当前明文值。
    /// 返回需要 push 的 (key, version, encrypted_value) 列表。
    pub fn compute_pending_changes<F>(
        &self,
        get_current_value: F,
    ) -> Result<Vec<(String, i64, Option<String>)>, AppError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let local = self.local_versions.read();
        let mut changes = Vec::new();

        for (key, &current_version) in &local.versions {
            let last_synced = local.last_sync_versions.get(key).copied().unwrap_or(0);
            if current_version <= last_synced {
                continue; // 已同步
            }

            // 获取当前明文值
            let plaintext = get_current_value(key);

            // 加密
            let sync_key = match keychain::get_sync_key()? {
                Some(k) => k,
                None => return Err(AppError::Config("Sync Key 不存在，无法加密".into())),
            };

            let encrypted_value = match &plaintext {
                Some(text) => Some(crypto::encrypt_data(&sync_key, text.as_bytes())?),
                None => None, // 删除标记
            };

            changes.push((key.clone(), current_version, encrypted_value));
        }

        Ok(changes)
    }

    /// 执行 push。
    ///
    /// `get_current_value` 闭包用于获取 key 的当前明文值（用于加密）。
    pub async fn push<F>(
        &self,
        client: &SyncClient,
        api_key: &str,
        get_current_value: F,
    ) -> Result<PushResponse, AppError>
    where
        F: Fn(&str) -> Option<String>,
    {
        let pending = self.compute_pending_changes(get_current_value)?;

        if pending.is_empty() {
            return Ok(PushResponse {
                accepted: vec![],
                rejected: vec![],
            });
        }

        let changes: Vec<SyncItem> = pending
            .into_iter()
            .map(|(key, version, encrypted_value)| SyncItem {
                key,
                version,
                encrypted_value,
            })
            .collect();

        let request = PushRequest { changes };
        let response = client.push(api_key, request).await?;

        // 更新本地版本表：只更新 accepted 的项
        {
            let mut local = self.local_versions.write();
            for accepted in &response.accepted {
                local.last_sync_versions.insert(accepted.key.clone(), accepted.version);
            }
        }
        self.persist().await?;

        Ok(response)
    }

    /// 执行 pull（增量）。
    ///
    /// `apply_value` 闭包用于将解密后的值应用到本地配置。
    pub async fn pull<F>(
        &self,
        client: &SyncClient,
        api_key: &str,
        apply_value: F,
    ) -> Result<PullResponse, AppError>
    where
        F: Fn(&str, Option<&str>) -> Result<(), AppError>,
    {
        // 构建 last_sync_versions
        let last_sync_versions = {
            let local = self.local_versions.read();
            local.last_sync_versions.clone()
        };

        let request = PullRequest {
            last_sync_versions,
        };
        let response = client.pull(api_key, request).await?;

        // 解密并应用
        let sync_key = match keychain::get_sync_key()? {
            Some(k) => k,
            None => return Err(AppError::Config("Sync Key 不存在，无法解密".into())),
        };

        // profile + 平台过滤
        let filtered_items: Vec<&SyncItem> = {
            let profile = self.profile.read();
            response
                .items
                .iter()
                .filter(|item| {
                    let sync_key_obj = crate::sync::profile::SyncKey::new(&item.key);
                    profile.should_sync(&sync_key_obj, self.platform)
                })
                .collect()
        };

        for item in &filtered_items {
            // 解密
            let plaintext = match &item.encrypted_value {
                Some(encrypted) => {
                    let bytes = crypto::decrypt_data(&sync_key, encrypted)?;
                    Some(String::from_utf8(bytes).map_err(|e| {
                        AppError::Config(format!("解密后的值不是有效 UTF-8：{}", e))
                    })?)
                }
                None => None, // 删除标记
            };

            // 应用到本地
            apply_value(&item.key, plaintext.as_deref())?;

            // 更新本地版本表
            let mut local = self.local_versions.write();
            local.record_synced(&item.key, item.version, item.encrypted_value.as_deref());
        }

        self.persist().await?;

        Ok(response)
    }

    /// 全量快照拉取（新设备首次同步）。
    pub async fn snapshot_pull<F>(
        &self,
        client: &SyncClient,
        api_key: &str,
        apply_value: F,
    ) -> Result<SnapshotResponse, AppError>
    where
        F: Fn(&str, Option<&str>) -> Result<(), AppError>,
    {
        let response = client.snapshot(api_key).await?;

        let sync_key = match keychain::get_sync_key()? {
            Some(k) => k,
            None => return Err(AppError::Config("Sync Key 不存在，无法解密".into())),
        };

        let filtered_items: Vec<&SyncItem> = {
            let profile = self.profile.read();
            response
                .items
                .iter()
                .filter(|item| {
                    let sync_key_obj = crate::sync::profile::SyncKey::new(&item.key);
                    profile.should_sync(&sync_key_obj, self.platform)
                })
                .collect()
        };

        for item in &filtered_items {
            let plaintext = match &item.encrypted_value {
                Some(encrypted) => {
                    let bytes = crypto::decrypt_data(&sync_key, encrypted)?;
                    Some(String::from_utf8(bytes).map_err(|e| {
                        AppError::Config(format!("解密后的值不是有效 UTF-8：{}", e))
                    })?)
                }
                None => None,
            };

            apply_value(&item.key, plaintext.as_deref())?;

            let mut local = self.local_versions.write();
            local.record_synced(&item.key, item.version, item.encrypted_value.as_deref());
        }

        self.persist().await?;

        Ok(response)
    }

    /// 获取 pending changes 数量（用于 UI 状态展示）。
    pub fn pending_count(&self) -> usize {
        let local = self.local_versions.read();
        local
            .versions
            .iter()
            .filter(|(key, &v)| {
                v > local.last_sync_versions.get(*key).copied().unwrap_or(0)
            })
            .count()
    }

    /// 更新 sync_profile。
    pub fn update_profile(&self, new_profile: SyncProfile) {
        let mut profile = self.profile.write();
        *profile = new_profile;
    }

    /// 获取当前平台。
    pub fn platform(&self) -> Platform {
        self.platform
    }

    /// 获取待解决冲突列表（UI 读取后渲染冲突 Modal/Sheet）。
    pub fn pending_conflicts(&self) -> Vec<PendingConflict> {
        self.pending_conflicts.read().clone()
    }

    /// 是否有未解决的冲突。
    pub fn has_pending_conflicts(&self) -> bool {
        !self.pending_conflicts.read().is_empty()
    }

    /// 解决一个冲突（用户通过 UI 选择后调用）。
    ///
    /// 内部完成所有操作：apply 值（如需）+ 更新版本表 + 持久化。
    /// 调用方根据返回的 `ResolveOutcome` 决定是否触发 push。
    pub async fn resolve_conflict(
        &self,
        key: &str,
        action: ConflictAction,
    ) -> Result<ResolveOutcome, AppError> {
        // 从 pending_conflicts 移除
        let conflict = {
            let mut conflicts = self.pending_conflicts.write();
            let idx = conflicts
                .iter()
                .position(|c| c.key == key)
                .ok_or_else(|| AppError::Config(format!("冲突项不存在: {}", key)))?;
            conflicts.remove(idx)
        };
        // 持久化剩余 conflicts（推迟的冲突跨重启保留）
        self.persist_pending_conflicts().await;

        self.apply_conflict_action(conflict, action).await
    }

    /// 解决所有冲突（批量操作）。
    ///
    /// `resolver` 闭包接收冲突项，返回对应的 `ConflictAction`。
    /// 返回每项的解决结果，调用方据此决定是否触发 push。
    pub async fn resolve_all_conflicts<F>(
        &self,
        resolver: F,
    ) -> Result<Vec<ResolveOutcome>, AppError>
    where
        F: Fn(&PendingConflict) -> ConflictAction,
    {
        // 取出所有冲突（一次性 take，避免在循环中反复 lock）
        let conflicts = {
            let mut c = self.pending_conflicts.write();
            std::mem::take(&mut *c)
        };
        // 持久化空 conflicts（全部已解决）
        self.persist_pending_conflicts().await;

        let mut results = Vec::with_capacity(conflicts.len());
        for conflict in conflicts {
            let action = resolver(&conflict);
            let outcome = self.apply_conflict_action(conflict, action).await?;
            results.push(outcome);
        }
        Ok(results)
    }

    /// 内部：对单个 conflict 应用 action（apply/persist 全部在此完成）。
    /// 不操作 pending_conflicts，调用方负责移除。
    async fn apply_conflict_action(
        &self,
        conflict: PendingConflict,
        action: ConflictAction,
    ) -> Result<ResolveOutcome, AppError> {
        match action {
            ConflictAction::UseOurs => {
                // 本地值不动，bump 版本号让 push 把 ours 推到远程
                {
                    let mut local = self.local_versions.write();
                    local.bump_version(&conflict.key);
                }
                self.persist().await?;
                Ok(ResolveOutcome::PushNeeded)
            }
            ConflictAction::UseTheirs => {
                // apply theirs 到本地
                let accessor = self.require_accessor()?;
                accessor
                    .apply_value(&conflict.key, conflict.theirs.as_deref())
                    .await?;

                // 更新版本表：用 remote_version + 加密 theirs 作为 last_synced
                let sync_key = match keychain::get_sync_key()? {
                    Some(k) => k,
                    None => return Err(AppError::Config("Sync Key 不存在，无法加密".into())),
                };
                let encrypted_theirs = match &conflict.theirs {
                    Some(plain) => Some(crypto::encrypt_data(&sync_key, plain.as_bytes())?),
                    None => None,
                };
                {
                    let mut local = self.local_versions.write();
                    local.record_synced(
                        &conflict.key,
                        conflict.remote_version,
                        encrypted_theirs.as_deref(),
                    );
                }
                self.persist().await?;
                Ok(ResolveOutcome::AppliedTheirs)
            }
            ConflictAction::SkipOnce => {
                // 不 apply，不更新版本表；下次 pull 还会冲突
                Ok(ResolveOutcome::Skipped)
            }
            ConflictAction::SkipForever => {
                // 加进 excluded_keys + 持久化 SyncProfile
                self.add_excluded_key(&conflict.key).await?;
                Ok(ResolveOutcome::Excluded)
            }
            ConflictAction::UseCustom(value) => {
                // apply custom value
                let accessor = self.require_accessor()?;
                accessor
                    .apply_value(&conflict.key, Some(&value))
                    .await?;

                // bump 版本号触发 push
                {
                    let mut local = self.local_versions.write();
                    local.bump_version(&conflict.key);
                }
                self.persist().await?;
                Ok(ResolveOutcome::PushNeeded)
            }
            ConflictAction::Fork => {
                // Fork：保留本地原会话，远程内容另存为新会话
                // 仅支持 conversations.* key
                let conv_id = conflict.key.strip_prefix("conversations.").ok_or_else(|| {
                    AppError::Config(format!(
                        "Fork 只支持 conversations.* key，收到: {}",
                        conflict.key
                    ))
                })?;

                // 远程内容必须存在（theirs 为空说明远程删除，fork 无意义）
                let theirs_json = conflict.theirs.as_deref().ok_or_else(|| {
                    AppError::Config(format!(
                        "Fork 需要远程内容，但 theirs 为空（key={}，远程可能已删除）",
                        conflict.key
                    ))
                })?;

                // 生成 forked id
                let ts = chrono::Utc::now().timestamp();
                let forked_id = format!("{}-fork-{}", conv_id, ts);
                let forked_key = format!("conversations.{}", forked_id);

                // 执行 fork：把远程 theirs 写入新会话（本地原会话不动）
                let accessor = self.require_accessor()?;
                accessor.fork_conversation(conv_id, &forked_id, theirs_json).await?;

                // bump 原会话版本号（相当于 UseOurs，让 push 把本地值推到远程）
                {
                    let mut local = self.local_versions.write();
                    local.bump_version(&conflict.key);
                }
                // 标记新会话为本地变更（让 push 把新会话推到远程）
                let marker = chrono::Utc::now().to_rfc3339();
                self.record_local_change(&forked_key, &marker)?;
                self.persist().await?;
                Ok(ResolveOutcome::PushNeeded)
            }
        }
    }

    /// 内部辅助：获取 accessor，未注入时返回错误
    fn require_accessor(&self) -> Result<Arc<SyncStoreAccessor>, AppError> {
        self.accessor.read().clone().ok_or_else(|| {
            AppError::Config("SyncStoreAccessor 未注入，无法执行 apply_value".into())
        })
    }

    /// 清空所有待解决冲突（用于"全部跳过本次"后重置状态）。
    pub async fn clear_pending_conflicts(&self) {
        self.pending_conflicts.write().clear();
        self.persist_pending_conflicts().await;
    }

    /// 首次配对后播种本地版本表。
    ///
    /// 场景：用户在启用同步前已有本地数据（连接、快捷命令、技能、MCP、会话、设置），
    /// 但 `local_versions.versions` 为空（record_local_change 从未被调用过）。
    /// 此时直接 `schedule_push()` 不会推送任何东西，因为 push 只推送 version > 0 的项。
    ///
    /// 本方法遍历 accessor.enumerate_all_keys() 返回的所有本地 key，对每个 key：
    /// 1. 通过 accessor.read_value 读取当前明文值
    /// 2. 调用 record_local_change（内部会与 last_synced_values 比对，首次配对时为空必然 bump 到 1）
    /// 3. record_local_change 内部会按 profile + platform 过滤，不同步的 key 跳过
    ///
    /// 播种后所有本地数据都有 version=1，scheduler.schedule_push() 会全量推送到服务端。
    ///
    /// 返回实际 bump 版本号的 key 数量（被 profile 排除或值为空的 key 不计数）。
    pub async fn seed_local_versions(&self) -> Result<usize, AppError> {
        let accessor = self.require_accessor()?;
        let keys = accessor.enumerate_all_keys().await;
        let mut seeded = 0usize;
        for key in &keys {
            if let Some(value) = accessor.read_value(key).await {
                let v = self.record_local_change(key, &value)?;
                if v > 0 {
                    seeded += 1;
                }
            }
        }
        self.persist().await?;
        log::info!(
            "[sync] 首次配对播种完成：{} 个 key 进入版本表（共 {} 个本地 key）",
            seeded,
            keys.len()
        );
        Ok(seeded)
    }

    // ── 基于 accessor 的 push/pull（不使用闭包，直接读写 store） ─────

    /// 使用 accessor 读取本地值执行 push。
    /// 替代旧的 `push(client, api_key, |key| None)` 占位实现。
    pub async fn push_with_accessor(
        &self,
        client: &SyncClient,
        api_key: &str,
    ) -> Result<PushResponse, AppError> {
        let accessor = self.accessor.read().clone();
        let accessor = accessor.ok_or_else(|| {
            AppError::Config("SyncStoreAccessor 未注入，无法执行 push".into())
        })?;

        // 第一步：在 guard 内收集 pending key + version，然后 drop guard
        // （guard 不是 Send，不能跨 await）
        let pending_keys: Vec<(String, i64)> = {
            let local = self.local_versions.read();
            local
                .versions
                .iter()
                .filter(|(key, &v)| {
                    v > local.last_sync_versions.get(*key).copied().unwrap_or(0)
                })
                .map(|(k, &v)| (k.clone(), v))
                .collect()
        };

        if pending_keys.is_empty() {
            return Ok(PushResponse {
                accepted: vec![],
                rejected: vec![],
            });
        }

        // 第二步：获取 sync_key 用于加密
        let sync_key = match keychain::get_sync_key()? {
            Some(k) => k,
            None => return Err(AppError::Config("Sync Key 不存在，无法加密".into())),
        };

        // 第三步：对每个 pending key，通过 accessor 异步读取当前值并加密
        let mut changes: Vec<SyncItem> = Vec::with_capacity(pending_keys.len());
        for (key, version) in pending_keys {
            let plaintext = accessor.read_value(&key).await;
            let encrypted_value = match &plaintext {
                Some(text) => Some(crypto::encrypt_data(&sync_key, text.as_bytes())?),
                None => None, // 删除标记
            };
            changes.push(SyncItem {
                key,
                version,
                encrypted_value,
            });
        }

        let request = PushRequest { changes };
        let response = client.push(api_key, request).await?;

        // 更新本地版本表：只更新 accepted 的项
        {
            let mut local = self.local_versions.write();
            for accepted in &response.accepted {
                local
                    .last_sync_versions
                    .insert(accepted.key.clone(), accepted.version);
            }
        }
        self.persist().await?;

        Ok(response)
    }

    /// 使用 accessor 应用值执行 pull。
    ///
    /// 三方合并流程（仅对 settings 字段级 key）：
    /// 1. 解密 theirs（pull 下来的值）
    /// 2. 解密 base（last_synced_values 中的值，如果存在）
    /// 3. 读取 ours（通过 accessor.read_value 实时读取）
    /// 4. 调用 merge::merge_key(base, ours, theirs)
    /// 5. 无冲突：apply + 更新版本表
    /// 6. 有冲突：缓存到 pending_conflicts，不 apply
    ///
    /// 对于整体 LWW key（connections/quickCommands/skills/mcpServers/secrets）：
    /// - 如果本地未改（ours == base）→ 用 theirs
    /// - 如果本地已改且与远程不同 → 冲突
    /// - 如果本地与远程相同 → 无冲突
    ///
    /// 对于 conversations：Phase 4 实现 fork 逻辑，当前按整体 LWW 处理。
    pub async fn pull_with_accessor(
        &self,
        client: &SyncClient,
        api_key: &str,
    ) -> Result<PullResponse, AppError> {
        let accessor = self.accessor.read().clone();
        let accessor = accessor.ok_or_else(|| {
            AppError::Config("SyncStoreAccessor 未注入，无法执行 pull".into())
        })?;

        // 构建 last_sync_versions
        let last_sync_versions = {
            let local = self.local_versions.read();
            local.last_sync_versions.clone()
        };

        let request = PullRequest {
            last_sync_versions,
        };
        let response = client.pull(api_key, request).await?;

        // 解密 sync_key
        let sync_key = match keychain::get_sync_key()? {
            Some(k) => k,
            None => return Err(AppError::Config("Sync Key 不存在，无法解密".into())),
        };

        // profile + 平台过滤
        let filtered_items: Vec<SyncItem> = {
            let profile = self.profile.read();
            response
                .items
                .iter()
                .filter(|item| {
                    let sync_key_obj = crate::sync::profile::SyncKey::new(&item.key);
                    profile.should_sync(&sync_key_obj, self.platform)
                })
                .cloned()
                .collect()
        };

        // 预读 base（last_synced_values 的加密值）+ ours（accessor 实时读取）
        // 解密 base 后做三方合并
        let mut new_conflicts: Vec<PendingConflict> = Vec::new();

        for item in &filtered_items {
            // 解密 theirs
            let theirs_plaintext = match &item.encrypted_value {
                Some(encrypted) => {
                    let bytes = crypto::decrypt_data(&sync_key, encrypted)?;
                    Some(String::from_utf8(bytes).map_err(|e| {
                        AppError::Config(format!("解密后的值不是有效 UTF-8：{}", e))
                    })?)
                }
                None => None, // 远程删除
            };

            // 解密 base（last_synced_values 存的是加密值）
            let base_encrypted = {
                let local = self.local_versions.read();
                local.last_synced_values.get(&item.key).cloned()
            };
            let base_plaintext = match &base_encrypted {
                Some(encrypted) => {
                    let bytes = crypto::decrypt_data(&sync_key, encrypted)?;
                    Some(String::from_utf8(bytes).map_err(|e| {
                        AppError::Config(format!("解密 base 值不是有效 UTF-8：{}", e))
                    })?)
                }
                None => None, // 首次同步或新 key
            };

            // 读取 ours（当前本地值）
            let ours_plaintext = accessor.read_value(&item.key).await;

            // 三方合并
            let merge_result = merge::merge_key(
                base_plaintext.as_deref(),
                ours_plaintext.as_deref(),
                theirs_plaintext.as_deref(),
            );

            match merge_result {
                MergeResult::Resolved { value, source } => {
                    log::debug!(
                        "[sync] merge resolved: key={}, source={:?}",
                        item.key,
                        source
                    );
                    // apply 解决后的值
                    let apply_value = if value.is_empty() {
                        None
                    } else {
                        Some(value.as_str())
                    };
                    accessor.apply_value(&item.key, apply_value).await?;

                    // 更新版本表：用远程加密值作为 last_synced（保持与远程一致）
                    let synced_encrypted = item.encrypted_value.clone();
                    let mut local = self.local_versions.write();
                    local.record_synced(
                        &item.key,
                        item.version,
                        synced_encrypted.as_deref(),
                    );
                }
                MergeResult::Conflict { base, ours, theirs } => {
                    log::info!(
                        "[sync] merge conflict: key={}, base={:?}, ours={:?}, theirs={:?}",
                        item.key,
                        base.as_deref().map(|s| &s[..s.len().min(50)]),
                        ours.as_deref().map(|s| &s[..s.len().min(50)]),
                        theirs.as_deref().map(|s| &s[..s.len().min(50)]),
                    );
                    // 缓存冲突，不 apply
                    new_conflicts.push(PendingConflict {
                        key: item.key.clone(),
                        remote_version: item.version,
                        base,
                        ours,
                        theirs,
                    });
                }
                MergeResult::BothDeleted => {
                    // 两端都删除，无需 apply
                    let mut local = self.local_versions.write();
                    local.record_synced(&item.key, item.version, None);
                }
            }
        }

        // 把新冲突追加到 pending_conflicts（同 key 替换，避免推迟后重复）
        if !new_conflicts.is_empty() {
            let new_count = new_conflicts.len();
            {
                let mut conflicts = self.pending_conflicts.write();
                // 先收集本次 pull 检测到的 key，用于去重
                let new_keys: std::collections::HashSet<&str> =
                    new_conflicts.iter().map(|c| c.key.as_str()).collect();
                // 移除同 key 的旧 conflict（ours/theirs 可能已变，用新值替换）
                conflicts.retain(|c| !new_keys.contains(c.key.as_str()));
                conflicts.extend(new_conflicts);
                log::info!(
                    "[sync] pull 产生 {} 个冲突，总计 {} 个待解决",
                    new_count,
                    conflicts.len()
                );
            }
            // 持久化新冲突到磁盘（推迟功能：跨重启保留）
            self.persist_pending_conflicts().await;
        }

        self.persist().await?;

        Ok(response)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_local_version_table_bump() {
        let mut table = LocalVersionTable::default();
        assert_eq!(table.get_version("key1"), 0);

        let v1 = table.bump_version("key1");
        assert_eq!(v1, 1);
        assert_eq!(table.get_version("key1"), 1);

        let v2 = table.bump_version("key1");
        assert_eq!(v2, 2);
    }

    #[test]
    fn test_local_version_table_record_synced() {
        let mut table = LocalVersionTable::default();

        table.bump_version("key1");
        table.record_synced("key1", 1, Some("encrypted_value"));

        assert_eq!(table.get_version("key1"), 1);
        assert_eq!(table.last_sync_versions.get("key1"), Some(&1));
        assert_eq!(
            table.last_synced_values.get("key1"),
            Some(&"encrypted_value".to_string())
        );
    }

    #[test]
    fn test_local_version_table_record_delete() {
        let mut table = LocalVersionTable::default();

        table.record_synced("key1", 1, Some("encrypted_value"));
        assert!(table.last_synced_values.contains_key("key1"));

        // 删除：版本 +1，值移除
        table.bump_version("key1");
        table.last_synced_values.remove("key1");
        assert!(!table.last_synced_values.contains_key("key1"));
    }
}
