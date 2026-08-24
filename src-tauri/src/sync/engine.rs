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
//! - push 成功后，更新 last_sync_versions + last_synced_values（三方合并 base）

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
use crate::sync::profile::{Platform, SyncProfile, SYNC_PROFILE_SCHEMA_VERSION};

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
    /// 保留本地值：越过已否决的 remote_version + 抬高本地 version 触发 push。
    /// 不跳过「处理冲突期间」远程更新的更高版本（见 `advance_past_remote`）。
    UseOurs,
    /// 用远程值（apply theirs；更新版本表为 remote_version；不 push）
    UseTheirs,
    /// 跳过本次（不 apply，不更新版本表；下次 pull 还会冲突）
    SkipOnce,
    /// 永久跳过（加进 excluded_keys + 持久化 SyncProfile；下次 pull 该 key 被 profile 过滤掉）
    SkipForever,
    /// 用自定义值（apply custom；越过 remote_version + 抬高 version 触发 push）
    UseCustom(String),
    /// Fork：保留本地原会话，远程内容另存为新会话（仅用于 conversations.* 冲突）。
    /// 新会话 id = `{原id}-fork-{ts}`；原会话按 UseOurs 推进版本 + 标记新会话为本地变更 + 触发 push。
    Fork,
}

/// 冲突解决结果（由 engine 返回，调用方据此决定是否触发 push）。
#[derive(Debug, Clone)]
pub enum ResolveOutcome {
    /// 已越过否决的远程版本并抬高本地 version，调用方应触发 push（UseOurs / UseCustom / Fork）
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

    /// 用户选择保留本地（UseOurs / UseCustom / Fork 原 key）时推进版本表。
    ///
    /// - `versions = max(local, remote_version) + 1`：保证 push 不会被服务端
    ///   `outdated_version` 拒绝（仅 `bump` 时本地可能仍 ≤ 远程）。
    /// - `last_sync_versions = max(existing, remote_version)`：否决**弹窗里那一版**
    ///   远程，打断「push 前 pull → 同一版再冲突」死循环；若处理冲突期间远程
    ///   已升到更高版本，下次 pull 仍会拿到并再 merge，不会静默吞掉。
    /// - **不**改 `last_synced_values`：base 仍指向上次真正同步的值，等 push
    ///   成功后再写入本次推送的密文。
    pub fn advance_past_remote(&mut self, key: &str, remote_version: i64) -> i64 {
        let local = self.get_version(key);
        let new_version = local.max(remote_version) + 1;
        self.versions.insert(key.to_string(), new_version);
        let last = self.last_sync_versions.get(key).copied().unwrap_or(0);
        if remote_version > last {
            self.last_sync_versions
                .insert(key.to_string(), remote_version);
        }
        new_version
    }

    /// 记录已同步的值（push 或 pull 后）。
    pub fn record_synced(&mut self, key: &str, version: i64, encrypted_value: Option<&str>) {
        self.versions.insert(key.to_string(), version);
        self.last_sync_versions.insert(key.to_string(), version);
        match encrypted_value {
            Some(v) => {
                self.last_synced_values
                    .insert(key.to_string(), v.to_string());
            }
            None => {
                self.last_synced_values.remove(&key.to_string());
            }
        }
    }

    /// push 被服务端接受后：只推进 last_sync_versions + last_synced_values，
    /// 不覆盖 `versions`（本地可能在 push 飞行中又 bump 了更高版本）。
    pub fn record_push_accepted(&mut self, key: &str, version: i64, encrypted_value: Option<&str>) {
        self.last_sync_versions.insert(key.to_string(), version);
        match encrypted_value {
            Some(v) => {
                self.last_synced_values
                    .insert(key.to_string(), v.to_string());
            }
            None => {
                self.last_synced_values.remove(key);
            }
        }
    }
}

/// pull 中待应用的一项（阶段 1 合并计算产出，阶段 2 批量写）。
#[derive(Debug, Clone)]
struct ApplyOp {
    key: String,
    /// 远程版本号（record_synced 用）
    version: i64,
    /// 远程密文（record_synced 存为三方合并 base）
    encrypted_value: Option<String>,
    /// 合并后的目标明文值（None = 删除）
    value: Option<String>,
    /// merge 时版本表里的本地版本号（写前校验：变了说明用户并发修改，跳过不覆盖）
    version_at_merge: i64,
}

/// 判断 merge 后的目标值与本地当前值是否相同（相同则无需写盘，只推进版本表）。
/// 空字符串与 None 等价（与 merge_key 的规范化一致）。
fn value_unchanged(ours: Option<&str>, target: Option<&str>) -> bool {
    match (ours, target) {
        (Some(a), Some(b)) => a == b,
        (None, None) => true,
        (Some(a), None) => a.is_empty(),
        (None, Some(b)) => b.is_empty(),
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
                            let mut loaded = loaded;
                            let migrated = loaded.normalize();
                            if migrated {
                                log::info!(
                                    "[sync] SyncProfile 已迁移到 schema v{}（补上新增分类默认开启项）",
                                    SYNC_PROFILE_SCHEMA_VERSION
                                );
                            }
                            log::info!(
                                "[sync] 已加载 SyncProfile（excluded_keys: {} 项）",
                                loaded.excluded_keys.len()
                            );
                            *self.profile.write() = loaded;
                            if migrated {
                                self.persist_profile().await?;
                            }
                        }
                        Err(e) => {
                            log::warn!("[sync] 解析 sync_profile.json 失败：{}，保留 default", e);
                        }
                    }
                }
                Ok(_) => {
                    log::warn!("[sync] sync_profile.json 为空，保留 default");
                }
                Err(e) => {
                    log::warn!("[sync] 读取 sync_profile.json 失败：{}，保留 default", e);
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
                            log::info!("[sync] 已加载 {} 项未解决冲突（推迟功能）", loaded.len());
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

        // 保留已推送密文，accept 后写入 last_synced_values（三方合并 base）
        let encrypted_by_key: HashMap<String, Option<String>> = changes
            .iter()
            .map(|c| (c.key.clone(), c.encrypted_value.clone()))
            .collect();

        let request = PushRequest { changes };
        let response = client.push(api_key, request).await?;

        // 更新本地版本表：accepted 推进 last_sync + last_synced_values
        {
            let mut local = self.local_versions.write();
            for accepted in &response.accepted {
                let enc = encrypted_by_key
                    .get(&accepted.key)
                    .and_then(|v| v.as_deref());
                local.record_push_accepted(&accepted.key, accepted.version, enc);
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

        let request = PullRequest { last_sync_versions };
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
            .filter(|(key, &v)| v > local.last_sync_versions.get(*key).copied().unwrap_or(0))
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
                // 本地值不动：越过已否决的远程版 + 抬高 version，让 push 把 ours 推上云
                {
                    let mut local = self.local_versions.write();
                    local.advance_past_remote(&conflict.key, conflict.remote_version);
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
                accessor.apply_value(&conflict.key, Some(&value)).await?;

                // 越过否决的远程版 + 抬高 version，触发 push
                {
                    let mut local = self.local_versions.write();
                    local.advance_past_remote(&conflict.key, conflict.remote_version);
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
                accessor
                    .fork_conversation(conv_id, &forked_id, theirs_json)
                    .await?;

                // 原会话按 UseOurs 推进（越过否决的远程版，push 本地值）
                {
                    let mut local = self.local_versions.write();
                    local.advance_past_remote(&conflict.key, conflict.remote_version);
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

    /// 重置本地版本表：清空内存 + 删除 `sync_local_versions.json`。
    ///
    /// 必须在以下场景调用，避免旧 sync_key 加密的 `last_synced_values` 残留导致
    /// 下次 pull 解密 base 失败：
    /// - `sync_disable`：关闭同步后，若用户重新 pair 可能拿到不同 sync_key
    /// - `sync_pair_first` / `sync_pair_join`：新账户/新设备加入时，旧版本表已无意义
    ///
    /// 仅清理版本表，不动 SyncProfile（用户排除项偏好保留）和 pending_conflicts
    /// （pair 时理应为空，disable 时由 clear_pending_conflicts 单独处理）。
    pub async fn reset_local_versions(&self) -> Result<(), AppError> {
        {
            let mut local = self.local_versions.write();
            *local = LocalVersionTable::default();
        }
        let path = self.config_dir.join(LOCAL_VERSIONS_FILE);
        let _ = tokio::fs::remove_file(&path).await;
        log::info!("[sync] 已重置本地版本表（sync_local_versions.json 已删除）");
        Ok(())
    }

    /// 播种本地版本表（首次配对 / 新开启同步分类后复用）。
    ///
    /// 场景：
    /// 1. 用户在启用同步前已有本地数据，但 `local_versions.versions` 为空
    ///    （record_local_change 从未被调用）。此时直接 `schedule_push()` 不会推任何东西。
    /// 2. 用户在设置里新打开某个同步分类：该分类下本地数据此前被 profile 过滤，
    ///    未进版本表；不播种则要等用户再改一次数据或重启后偶然 pull，才会同步。
    ///
    /// 本方法遍历 accessor.enumerate_all_keys() 返回的所有本地 key，对每个 key：
    /// 1. 通过 accessor.read_value 读取当前明文值
    /// 2. 调用 record_local_change（与 last_synced_values 比对；无记录或值变化才 bump）
    /// 3. record_local_change 内部按 **当前** profile + platform 过滤，未开启分类的 key 跳过
    ///
    /// 调用方应在 `update_profile` 写入新 profile 之后调用，再 `schedule_push`。
    ///
    /// 返回实际 bump 版本号的 key 数量（被 profile 排除或值为空的 key 不计数）。
    pub async fn seed_local_versions(&self) -> Result<usize, AppError> {
        let accessor = self.require_accessor()?;
        let keys = accessor.enumerate_all_keys().await;
        let mut seeded = 0usize;
        for key in &keys {
            // 已进版本表的 key 跳过：首次配对 versions 为空会全部播种；
            // 新开分类时另走 seed_newly_enabled_categories，避免把无关已同步项整库 re-bump。
            {
                let local = self.local_versions.read();
                if local.get_version(key) > 0 {
                    continue;
                }
            }
            if let Some(value) = accessor.read_value(key).await {
                let v = self.record_local_change(key, &value)?;
                if v > 0 {
                    seeded += 1;
                }
            }
        }
        self.persist().await?;
        log::info!(
            "[sync] 本地版本播种完成：{} 个 key 进入版本表（共扫描 {} 个本地 key）",
            seeded,
            keys.len()
        );
        Ok(seeded)
    }

    /// 用户新打开同步分类后：把这些分类下的本地存量重新纳入版本表 / 待推送。
    ///
    /// 与 `seed_local_versions` 的区别：
    /// - 只处理给定分类的 key（不影响其他分类）
    /// - 即使 version 已存在也会 `record_local_change`（关闭期间本地改动此前被 profile 过滤未 bump）
    ///
    /// 须在 `update_profile` 写入**新** profile 之后调用（should_sync 依赖当前 profile）。
    pub async fn seed_newly_enabled_categories(
        &self,
        categories: &std::collections::HashSet<crate::sync::profile::SyncCategory>,
    ) -> Result<usize, AppError> {
        if categories.is_empty() {
            return Ok(0);
        }
        let accessor = self.require_accessor()?;
        let keys = accessor.enumerate_all_keys().await;
        let mut seeded = 0usize;
        for key in &keys {
            let sync_key = crate::sync::profile::SyncKey::new(key);
            match sync_key.category() {
                Some(cat) if categories.contains(&cat) => {}
                _ => continue,
            }
            if let Some(value) = accessor.read_value(key).await {
                let v = self.record_local_change(key, &value)?;
                if v > 0 {
                    seeded += 1;
                }
            }
        }
        self.persist().await?;
        log::info!(
            "[sync] 新开分类播种完成：{} 个 key 进入待推送（分类数 {}）",
            seeded,
            categories.len()
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
        let accessor = accessor
            .ok_or_else(|| AppError::Config("SyncStoreAccessor 未注入，无法执行 push".into()))?;

        // 第一步：在 guard 内收集 pending key + version，然后 drop guard
        // （guard 不是 Send，不能跨 await）
        let pending_keys: Vec<(String, i64)> = {
            let local = self.local_versions.read();
            local
                .versions
                .iter()
                .filter(|(key, &v)| v > local.last_sync_versions.get(*key).copied().unwrap_or(0))
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

        // 保留已推送密文，accept 后写入 last_synced_values（三方合并 base）
        let encrypted_by_key: HashMap<String, Option<String>> = changes
            .iter()
            .map(|c| (c.key.clone(), c.encrypted_value.clone()))
            .collect();

        let request = PushRequest { changes };
        let response = client.push(api_key, request).await?;

        // 更新本地版本表：accepted 推进 last_sync + last_synced_values
        {
            let mut local = self.local_versions.write();
            for accepted in &response.accepted {
                let enc = encrypted_by_key
                    .get(&accepted.key)
                    .and_then(|v| v.as_deref());
                local.record_push_accepted(&accepted.key, accepted.version, enc);
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
    ///
    /// 性能：三阶段结构（阶段 1 合并计算 → 阶段 2 按 store 批量写 → 阶段 3 推进版本表），
    /// 一次 pull 每个 store 只写一次磁盘（替代逐 key 全量重写）。
    /// - 值未变的 Resolved 跳过 apply（只推进版本表）
    /// - 写前版本号校验：pull 期间用户并发修改的 key 跳过，不覆盖用户新值
    /// - 单项失败收集，不中断其余 key（下次 pull 自动重试）
    ///
    /// `progress`：可选进度回调 (done, total)，阶段 1 每处理一个 item 调用一次。
    pub async fn pull_with_accessor(
        &self,
        client: &SyncClient,
        api_key: &str,
        progress: Option<&(dyn Fn(usize, usize) + Sync)>,
    ) -> Result<PullResponse, AppError> {
        let accessor = self.accessor.read().clone();
        let accessor = accessor
            .ok_or_else(|| AppError::Config("SyncStoreAccessor 未注入，无法执行 pull".into()))?;

        // 构建 last_sync_versions
        let last_sync_versions = {
            let local = self.local_versions.read();
            local.last_sync_versions.clone()
        };

        let request = PullRequest { last_sync_versions };
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
        let total = filtered_items.len();
        if let Some(cb) = progress {
            cb(0, total);
        }
        log::debug!("[sync] pull 收到 {} 项变更", total);
        let started = std::time::Instant::now();

        // ── 阶段 1：逐 item 解密 + 读 ours + 三方合并（纯计算，不写盘） ──
        let mut apply_ops: Vec<ApplyOp> = Vec::new();
        let mut new_conflicts: Vec<PendingConflict> = Vec::new();
        // 无需写盘的项（BothDeleted / 值未变）：直接推进版本表
        let mut synced_keys: Vec<(String, i64, Option<String>)> = Vec::new();
        let mut done = 0usize;

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
                    let apply_value = if value.is_empty() { None } else { Some(value) };
                    // 目标值与本地当前值相同：无需写盘（值没变），只推进版本表
                    if value_unchanged(ours_plaintext.as_deref(), apply_value.as_deref()) {
                        synced_keys.push((
                            item.key.clone(),
                            item.version,
                            item.encrypted_value.clone(),
                        ));
                    } else {
                        let version_at_merge = self.local_versions.read().get_version(&item.key);
                        apply_ops.push(ApplyOp {
                            key: item.key.clone(),
                            version: item.version,
                            encrypted_value: item.encrypted_value.clone(),
                            value: apply_value,
                            version_at_merge,
                        });
                    }
                }
                MergeResult::Conflict { base, ours, theirs } => {
                    log::info!(
                        "[sync] merge conflict: key={}, base={:?}, ours={:?}, theirs={:?}",
                        item.key,
                        base.as_deref().map(|s| s.get(..50).unwrap_or(s)),
                        ours.as_deref().map(|s| s.get(..50).unwrap_or(s)),
                        theirs.as_deref().map(|s| s.get(..50).unwrap_or(s)),
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
                    synced_keys.push((item.key.clone(), item.version, None));
                }
            }

            done += 1;
            if let Some(cb) = progress {
                cb(done, total);
            }
        }

        // ── 阶段 2：写前版本号校验 + 按 store 批量写 ──
        if !apply_ops.is_empty() {
            // 校验：pull 期间用户并发修改过的 key（版本已 bump）跳过，不覆盖用户新值。
            // 不推进版本表 → 下次 pull 用新 ours 重新合并（theirs==base 时收敛为 Ours）。
            let mut to_apply: Vec<(String, Option<String>)> = Vec::with_capacity(apply_ops.len());
            let mut applied_keys: Vec<String> = Vec::with_capacity(apply_ops.len());
            let mut skipped = 0usize;
            for op in apply_ops {
                let current_version = self.local_versions.read().get_version(&op.key);
                if current_version != op.version_at_merge {
                    log::info!("[sync] pull 跳过 key={}（版本已变，用户并发修改）", op.key);
                    skipped += 1;
                    continue;
                }
                applied_keys.push(op.key.clone());
                to_apply.push((op.key.clone(), op.value.clone()));
                synced_keys.push((op.key, op.version, op.encrypted_value));
            }
            if skipped > 0 {
                log::info!("[sync] pull 跳过 {} 个并发修改的 key", skipped);
            }

            if !to_apply.is_empty() {
                let failed_set: std::collections::HashSet<String> =
                    match accessor.apply_batch(to_apply).await {
                        Ok(batch) => {
                            if !batch.failed_keys.is_empty() {
                                log::warn!(
                                    "[sync] pull 应用失败 {} 个 key（不推进版本，下次重试）：{:?}",
                                    batch.failed_keys.len(),
                                    batch.failed_keys
                                );
                            }
                            batch.failed_keys.into_iter().collect()
                        }
                        Err(e) => {
                            // 整组保存失败：该组全部不推进版本，下次 pull 重试
                            log::warn!("[sync] pull 批量应用失败，相关 key 不推进版本：{}", e);
                            applied_keys.into_iter().collect()
                        }
                    };
                if !failed_set.is_empty() {
                    synced_keys.retain(|(k, _, _)| !failed_set.contains(k));
                }
            }
        }

        // ── 阶段 3：推进版本表 + 冲突入库 + 持久化 ──
        {
            let mut local = self.local_versions.write();
            for (key, version, encrypted) in synced_keys {
                local.record_synced(&key, version, encrypted.as_deref());
            }
        }

        // 把新冲突追加到 pending_conflicts（同 key 替换，避免推迟后重复）
        let this_pull_conflicts = new_conflicts.len();
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

        if let Some(cb) = progress {
            cb(total, total);
        }

        let conflict_count = this_pull_conflicts;
        log::debug!(
            "[sync] pull 处理完成（耗时 {:?}，{} 项，冲突 {} 项）",
            started.elapsed(),
            total,
            conflict_count
        );

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

    #[test]
    fn test_advance_past_remote_breaks_pull_loop() {
        // 冲突：远程 v5，本地 version 仍可能 ≤ 5；选本地后必须
        // last_sync=5（不再拉回 v5）且 versions>5（push 可被接受）
        let mut table = LocalVersionTable::default();
        table.versions.insert("k".into(), 3);
        table.last_sync_versions.insert("k".into(), 2);
        table
            .last_synced_values
            .insert("k".into(), "old_base_enc".into());

        let v = table.advance_past_remote("k", 5);
        assert_eq!(v, 6);
        assert_eq!(table.get_version("k"), 6);
        assert_eq!(table.last_sync_versions.get("k"), Some(&5));
        // base 不动，等 push accept 再写
        assert_eq!(
            table.last_synced_values.get("k"),
            Some(&"old_base_enc".to_string())
        );
        // 仍有 pending push
        assert!(table.get_version("k") > table.last_sync_versions["k"]);
    }

    #[test]
    fn test_advance_past_remote_when_local_already_higher() {
        let mut table = LocalVersionTable::default();
        table.versions.insert("k".into(), 10);
        table.last_sync_versions.insert("k".into(), 2);

        let v = table.advance_past_remote("k", 5);
        assert_eq!(v, 11); // max(10, 5) + 1
        assert_eq!(table.last_sync_versions.get("k"), Some(&5));
    }

    #[test]
    fn test_advance_past_remote_does_not_lower_last_sync() {
        let mut table = LocalVersionTable::default();
        table.versions.insert("k".into(), 8);
        table.last_sync_versions.insert("k".into(), 7);

        let v = table.advance_past_remote("k", 5);
        assert_eq!(v, 9);
        // 不回退 last_sync（防御；正常路径冲突 remote 应 ≥ last_sync）
        assert_eq!(table.last_sync_versions.get("k"), Some(&7));
    }

    #[test]
    fn test_record_push_accepted_updates_base_not_versions() {
        let mut table = LocalVersionTable::default();
        table.versions.insert("k".into(), 6);
        table.last_sync_versions.insert("k".into(), 5);

        // push 飞行中本地又改了 → versions 已到 7
        table.versions.insert("k".into(), 7);
        table.record_push_accepted("k", 6, Some("enc_ours"));

        assert_eq!(table.get_version("k"), 7); // 不覆盖更高本地 version
        assert_eq!(table.last_sync_versions.get("k"), Some(&6));
        assert_eq!(
            table.last_synced_values.get("k"),
            Some(&"enc_ours".to_string())
        );
        // 仍有 pending（7 > 6）
        assert!(table.get_version("k") > table.last_sync_versions["k"]);
    }

    #[test]
    fn test_value_unchanged_same_values() {
        assert!(value_unchanged(Some("a"), Some("a")));
        assert!(value_unchanged(None, None));
        // 空字符串与 None 等价（与 merge_key 规范化一致）
        assert!(value_unchanged(Some(""), None));
        assert!(value_unchanged(None, Some("")));
        assert!(value_unchanged(Some(""), Some("")));
    }

    #[test]
    fn test_value_unchanged_different_values() {
        assert!(!value_unchanged(Some("a"), Some("b")));
        assert!(!value_unchanged(Some("a"), None));
        assert!(!value_unchanged(None, Some("a")));
    }
}
