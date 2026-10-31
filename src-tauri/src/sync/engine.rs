//! 同步引擎：把账本（`ledger`）、各条流（`streams`）和存储后端（`backends`）编排成「一轮同步」。
//!
//! 引擎本身**不是并发的**：它被 `manager.rs` 的 actor 独占（同一时刻只有一个任务在动它），所以
//! 里面用 `&mut self`，没有任何锁。一台设备的远端目录分成几条互相独立的**流**：
//!
//! - 配置流（一期）：`devices/<id>/seg-…`，驱动是 [`ConfigStreamDriver`]，恒为开；
//! - 对话与记忆流（二期）：`devices/<id>/conv/…`，驱动由 T2 注册；
//! - 机密流（三期）：`devices/<id>/sec/…`，驱动由 T6 注册。
//!
//! 一轮同步（[`SyncEngine::run_round`]）= 对每条**开着的**流依次：
//!
//! 1. **捕获**本机改动；2. **上传**；3. **拉取**对端的段 / 快照；4. **落地**到本机；
//! 5. 落地时锁内再捕获一次，可能产生新 op，**再上传**；6. **压缩**（本机段攒够就写快照）。
//!
//! 一条流出错不影响别的流：错误记进该流的 `lastError`（`SyncStatus.streams`），循环继续；
//! 整轮最后仍返回错误，让调度器退避重试。**关着的流在捕获阶段就整条跳过**——关着时绝不产生
//! 任何远端写入，也不拉取。
//!
//! 「先捕获、再落地」这个顺序是配置流正确性的根：落地用 `affected_vs_doc`（文档现状 vs 镜像）
//! 把文档对齐到镜像，没有被捕获进镜像的本机修改会被当成「文档偏离镜像」而被旧值盖回去。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use zeroize::Zeroizing;

use super::backends::{Backend, BackendFactory};
use super::core::crypto::{self, DataKey, FileKind, RecoveryKey};
use super::core::format::{
    self, decode_sync_code, encode_snapshot, encode_sync_code, file_path, is_valid_device_id,
    new_device_id, parse_device_rel_path, RemoteFileKind, SyncCodePayload, SyncMeta, DEVICES_DIR,
    META_FILE,
};
use super::core::{DeviceInfo, Platform};
use super::history::HistoryStore;
use super::join::{HostKeyBundle, SftpBundle};
use super::ledger::Ledger;
use super::secrets::SyncSecretStore;
use super::sources::SourceAdapter;
use super::storage::{StorageConfig, StorageError};
use super::store::{Cursor, LedgerFiles, StreamName};
use super::streams::{
    seal_stream_file, BackendStreamRemote, ConfigStreamDriver, StreamApplied, StreamDriver,
    StreamDriverFactory, StreamFileKind, StreamProgress, StreamSnapshotLayout,
};
use super::types::{StreamStatus, SyncCreateResult, SyncDevice, SyncState, SyncStatus};
use crate::config::connections::ConnectionStore;
use crate::config::keychain::SecretSlot;
use crate::config::settings::AppSettings;
use crate::data::{DataSourceId, JsonStore, SyncTier};
use crate::error::AppError;
use crate::ssh::known_hosts::KnownHostsStore;

/// 本机增量段攒到这么多就压缩成快照。
pub const COMPACT_AFTER_SEGS: u32 = 50;

/// 前端事件的出口。
pub trait SyncEvents: Send + Sync {
    fn status(&self, status: &SyncStatus);
    fn data_applied(&self, source: &str);
    /// 带「哪些会话变了」的落地事件（对话流用）。
    fn data_applied_ids(&self, source: &str, _ids: &[String]) {
        self.data_applied(source);
    }
}

/// 引擎的外部依赖。
pub struct SyncDeps {
    pub config_dir: PathBuf,
    /// 六个同步源（顺序固定）。
    pub adapters: Vec<Arc<dyn SourceAdapter>>,
    /// 加入同步（带 SFTP 服务器）/ 创建同步（加受保护路径）要直接写这两份配置。
    pub settings: JsonStore<AppSettings>,
    pub connections: JsonStore<ConnectionStore>,
    pub known_hosts: Arc<KnownHostsStore>,
    pub secrets: Arc<dyn SyncSecretStore>,
    pub backends: Arc<dyn BackendFactory>,
    pub events: Arc<dyn SyncEvents>,
    /// 当前时间（Unix 毫秒）。测试可注入，生产用 `wall_clock_ms`。
    pub now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    pub app_version: String,
    pub platform: Platform,
    pub default_device_name: String,
    /// 启动加载时碰到损坏、被迫改用默认值的配置（需要从镜像恢复）。
    pub load_failures: Vec<DataSourceId>,
    /// 二、三期的流驱动构造器（T2 / T6 注册）。T0 为空：没有驱动的流整条跳过。
    pub stream_drivers: Vec<Arc<dyn StreamDriverFactory>>,
}

/// 命令层 / 界面读得到的共享视图（不用等引擎空闲）。
pub struct SharedView {
    pub status: RwLock<SyncStatus>,
    pub devices: RwLock<Vec<SyncDevice>>,
    pub history: Mutex<HistoryStore>,
    /// 当前生效的存储配置（生成同步码用）。
    pub storage: RwLock<Option<StorageConfig>>,
}

impl SharedView {
    pub fn new(history: HistoryStore) -> Self {
        Self {
            status: RwLock::new(SyncStatus::off()),
            devices: RwLock::new(Vec::new()),
            history: Mutex::new(history),
            storage: RwLock::new(None),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoundKind {
    /// 完整一轮：捕获 → 上传 → 拉取 → 落地 → 压缩。
    Full,
    /// 本机改动触发：只捕获并上传，不碰网络上别人的数据。
    Local,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyMode {
    /// 常规落地：锁内先捕获本机改动。
    Normal,
    /// 配置损坏恢复：不捕获（捕获到的只是「全变成默认值」），直接用镜像整份恢复。
    Restore,
    /// 加入同步：本机数据以 `Hlc::zero_for` 并入镜像（云端赢），再整份落地。
    Join,
}

pub enum JoinSpec {
    Code(Zeroizing<String>),
    Manual {
        storage: StorageConfig,
        secret: Option<Zeroizing<String>>,
        recovery_key: Zeroizing<String>,
    },
}

/// 一次拉取的结果。
#[derive(Default)]
pub struct PullReport {
    pub needs_upgrade: bool,
    pub soft_errors: Vec<String>,
}

/// 给人看的错误文案（不带 `Config error:` 之类的英文前缀）。
pub fn plain_error(e: &AppError) -> String {
    match e {
        AppError::Other(m)
        | AppError::Config(m)
        | AppError::Network(m)
        | AppError::Ssh(m)
        | AppError::Cancelled(m) => m.clone(),
        other => other.to_string(),
    }
}

pub(crate) fn storage_err(e: StorageError) -> AppError {
    AppError::from(e)
}

/// 一条流的中文名（错误文案 / 日志用）。
pub fn stream_label(name: StreamName) -> &'static str {
    match name {
        StreamName::Config => "普通配置",
        StreamName::Conv => "对话与记忆",
        StreamName::Sec => "机密",
    }
}

/// 一条流的中文名（`tier` 字段的字符串，同时是 `sync_set_tier` 的参数）。
pub fn tier_key(tier: SyncTier) -> &'static str {
    match tier {
        SyncTier::Config => "config",
        SyncTier::Conversation => "conversation",
        SyncTier::Secret => "secret",
        SyncTier::Local => "local",
    }
}

fn remote_stream_of(name: StreamName) -> format::RemoteStream {
    match name {
        StreamName::Config => format::RemoteStream::Config,
        StreamName::Conv => format::RemoteStream::Conv,
        StreamName::Sec => format::RemoteStream::Sec,
    }
}

pub struct SyncEngine {
    deps: Arc<SyncDeps>,
    view: Arc<SharedView>,
    files: LedgerFiles,
    pub(crate) ledger: Ledger,
    backend: Option<(StorageConfig, Arc<dyn Backend>)>,
    dk: Option<DataKey>,
    needs_upgrade: bool,
    last_error: Option<String>,
    syncing: bool,
    /// 上一次发布给前端的状态（没变就不再发）。
    last_published: Option<SyncStatus>,
    /// 加入同步时连接去重产生的 id 改写表（本机 id → 云端 id）。
    join_remap: BTreeMap<String, String>,
    /// 本轮各条流的错误（`SyncStatus.streams[].lastError`）。
    stream_errors: BTreeMap<StreamName, String>,
    /// 各条流的进度（首次加入时「已同步 N / 共 M 段对话」）。
    stream_progress: BTreeMap<StreamName, StreamProgress>,
    /// conv / sec 的驱动（每轮开始时按账本状态构造，结束时状态写回账本）。
    drivers: BTreeMap<StreamName, Box<dyn StreamDriver>>,
    /// 本轮捕获出来、还没上传的明文段（conv / sec 用；配置流走账本里的 outbox）。
    pending_segments: BTreeMap<StreamName, Vec<Vec<u8>>>,
}

impl SyncEngine {
    // ═══════════════════════════════════════════════════════════════════
    // 构造与基础设施
    // ═══════════════════════════════════════════════════════════════════

    pub fn new(deps: Arc<SyncDeps>, view: Arc<SharedView>) -> Self {
        let files = LedgerFiles::new(&deps.config_dir);
        let loaded = files.load();
        let mut ledger = Ledger::from_loaded(loaded);

        if ledger.enabled() {
            // 版本升级：每个源的第一次捕获不发 Remove
            if ledger.st.last_app_version != deps.app_version {
                for a in &deps.adapters {
                    ledger.suppress_pending.insert(a.key().to_string());
                }
            }
            // 配置损坏被迫用默认值：不要把「全变成默认值」当成用户的删除推出去，改从镜像恢复
            for failed in &deps.load_failures {
                if let Some(key) = failed.sync_key() {
                    ledger.set_needs_restore(key, true);
                }
            }
        }

        let engine = SyncEngine {
            deps,
            view,
            files,
            ledger,
            backend: None,
            dk: None,
            needs_upgrade: false,
            last_error: None,
            syncing: false,
            last_published: None,
            join_remap: BTreeMap::new(),
            stream_errors: BTreeMap::new(),
            stream_progress: BTreeMap::new(),
            drivers: BTreeMap::new(),
            pending_segments: BTreeMap::new(),
        };
        engine.refresh_view();
        engine
    }

    pub fn enabled(&self) -> bool {
        self.ledger.enabled()
    }

    fn now_ms(&self) -> u64 {
        (self.deps.now_ms)()
    }

    fn rfc3339(&self, ms: u64) -> String {
        rfc3339_from_ms(ms)
    }

    fn now_rfc3339(&self) -> String {
        self.rfc3339(self.now_ms())
    }

    fn device_info(&self) -> DeviceInfo {
        DeviceInfo {
            id: self.ledger.st.device_id.clone(),
            name: self.ledger.st.device_name.clone(),
            platform: self.deps.platform.as_str().to_string(),
            app_version: self.deps.app_version.clone(),
        }
    }

    pub fn status(&self) -> SyncStatus {
        let l = &self.ledger;
        if !l.enabled() {
            return SyncStatus::off();
        }
        let held = l.held_summary();
        let state = if self.syncing {
            SyncState::Syncing
        } else if !held.is_empty() {
            SyncState::NeedsConfirm
        } else if self.needs_upgrade {
            SyncState::NeedsUpgrade
        } else if self.last_error.is_some() {
            SyncState::Error
        } else {
            SyncState::Idle
        };
        let streams = StreamName::ALL
            .iter()
            .copied()
            .map(|name| StreamStatus {
                key: name.as_str().to_string(),
                tier: tier_key(name.tier()).to_string(),
                pending: self.stream_pending(name),
                last_error: self.stream_errors.get(&name).cloned(),
                progress: self.stream_progress.get(&name).cloned(),
            })
            .collect();
        SyncStatus {
            enabled: true,
            state,
            last_sync_at: l.st.last_sync_at.clone(),
            last_error: self.last_error.clone(),
            // 配置流按 op 数、conv / sec 按待上传段数；再加扣下的删除条数。
            pending_count: l.outbox.len()
                + self.pending_segments.values().map(Vec::len).sum::<usize>()
                + held.iter().map(|h| h.count).sum::<usize>(),
            device_id: Some(l.st.device_id.clone()),
            device_name: Some(l.st.device_name.clone()),
            storage: l.st.storage.clone(),
            held: if held.is_empty() { None } else { Some(held) },
            tiers: l.st.tiers,
            streams,
        }
    }

    /// 某条流有多少待上传内容（状态展示用）。
    fn stream_pending(&self, name: StreamName) -> usize {
        if name == StreamName::Config {
            return self.ledger.outbox.len();
        }
        self.pending_segments.get(&name).map(Vec::len).unwrap_or(0)
    }

    /// 把状态 / 设备 / 存储配置同步给共享视图并（有变化时）通知前端。
    fn publish(&mut self) {
        let status = self.status();
        self.refresh_view();
        if self.last_published.as_ref() != Some(&status) {
            self.deps.events.status(&status);
            self.last_published = Some(status);
        }
    }

    fn refresh_view(&self) {
        *self.view.status.write() = self.status();
        *self.view.storage.write() = self.ledger.st.storage.clone();
        *self.view.devices.write() = self.device_list();
    }

    fn device_list(&self) -> Vec<SyncDevice> {
        let l = &self.ledger;
        if !l.enabled() {
            return Vec::new();
        }
        let mut out = vec![SyncDevice {
            id: l.st.device_id.clone(),
            name: l.st.device_name.clone(),
            platform: self.deps.platform.as_str().to_string(),
            app_version: self.deps.app_version.clone(),
            last_seen_at: l
                .st
                .last_sync_at
                .clone()
                .unwrap_or_else(|| self.now_rfc3339()),
            is_self: true,
            tiers: l.st.tiers,
        }];
        for (id, rec) in &l.st.devices {
            if *id == l.st.device_id {
                continue;
            }
            out.push(SyncDevice {
                id: id.clone(),
                name: if rec.name.is_empty() {
                    "未命名设备".to_string()
                } else {
                    rec.name.clone()
                },
                platform: rec.platform.clone(),
                app_version: rec.app_version.clone(),
                last_seen_at: rec.last_seen_at.clone().unwrap_or_default(),
                is_self: false,
                tiers: rec.tiers,
            });
        }
        out
    }

    fn flush(&mut self) -> Result<(), AppError> {
        self.ledger.flush(&self.files)
    }

    fn set_syncing(&mut self, on: bool) {
        if self.syncing != on {
            self.syncing = on;
            self.publish();
        }
    }

    fn ensure_backend(&mut self) -> Result<Arc<dyn Backend>, AppError> {
        let Some(storage) = self.ledger.st.storage.clone() else {
            return Err(AppError::Other("还没有配置同步存储位置".into()));
        };
        if let Some((cfg, backend)) = &self.backend {
            if *cfg == storage {
                return Ok(backend.clone());
            }
        }
        let secret = self.storage_secret()?;
        let backend = self
            .deps
            .backends
            .build(&storage, secret.as_deref().map(|s| s.as_str()))
            .map_err(storage_err)?;
        self.backend = Some((storage, backend.clone()));
        Ok(backend)
    }

    /// WebDAV 的应用密码（SFTP 存储没有）。
    fn storage_secret(&self) -> Result<Option<Zeroizing<String>>, AppError> {
        if !matches!(self.ledger.st.storage, Some(StorageConfig::WebDav { .. })) {
            return Ok(None);
        }
        Ok(self
            .deps
            .secrets
            .get(&SecretSlot::SyncStoragePassword)?
            .map(Zeroizing::new))
    }

    fn data_key(&mut self) -> Result<DataKey, AppError> {
        if let Some(dk) = &self.dk {
            return Ok(dk.clone());
        }
        let Some(b64) = self
            .deps
            .secrets
            .get(&SecretSlot::SyncDataKey)?
            .map(Zeroizing::new)
        else {
            return Err(AppError::Other(
                "找不到同步的加密密钥（可能被系统清理了）。请先停止同步，再用恢复密钥重新加入。"
                    .into(),
            ));
        };
        let dk = DataKey::from_b64(&b64)?;
        self.dk = Some(dk.clone());
        Ok(dk)
    }

    /// 转发到账本的连接 id 别名换算（唯一实现在 `PersistedState::resolve_connection_id`）。
    pub fn resolve_connection_id(&self, id: &str) -> String {
        self.ledger.st.resolve_connection_id(id)
    }

    // ═══════════════════════════════════════════════════════════════════
    // 一轮同步
    // ═══════════════════════════════════════════════════════════════════

    pub async fn run_round(&mut self, kind: RoundKind) -> Result<(), AppError> {
        if !self.ledger.enabled() {
            return Ok(());
        }
        let result = self.round_inner(kind).await;
        self.syncing = false;
        match &result {
            Ok(()) => {
                self.last_error = None;
                if kind == RoundKind::Full {
                    self.ledger.st.last_sync_at = Some(self.now_rfc3339());
                    self.ledger.dirty.state = true;
                }
            }
            Err(e) => self.last_error = Some(plain_error(e)),
        }
        let flushed = self.flush();
        self.publish();
        match (result, flushed) {
            (Err(e), _) => Err(e),
            (Ok(()), Err(e)) => Err(e),
            (Ok(()), Ok(())) => Ok(()),
        }
    }

    async fn round_inner(&mut self, kind: RoundKind) -> Result<(), AppError> {
        // 每一轮重新算每条流的错误：上一轮的错误不该跟着下一轮。
        self.stream_errors.clear();
        self.pending_segments.clear();
        self.build_drivers();

        let enabled: Vec<StreamName> = StreamName::ALL
            .iter()
            .copied()
            .filter(|n| self.ledger.st.stream_enabled(*n))
            .collect();
        // 这一轮里已经失败的流：后面的阶段直接跳过它（网络断了没必要再试三次），
        // 但别的流照常走——「一条流失败不影响别的流」。
        let mut failed: BTreeSet<StreamName> = BTreeSet::new();
        let mut soft_errors: Vec<String> = Vec::new();
        let mut needs_upgrade = false;

        // 1. 捕获：每条开着的流各自捕获本机改动。
        //    配置流恒为开；conv / sec 关着时**整条流跳过**——关着的流绝不能产生任何上传。
        for name in &enabled {
            if let Err(e) = self.capture_stream(*name).await {
                self.note_stream_error(*name, &e);
                failed.insert(*name);
            }
        }
        self.ledger.flush(&self.files)?;
        self.publish();
        if !failed.is_empty() && kind == RoundKind::Local {
            return Err(self.round_error(&enabled, &failed, &soft_errors));
        }

        if kind == RoundKind::Local && !self.has_pending_work() {
            return Ok(()); // 本机改动被扣下了 / 根本没有：不碰网络
        }

        let backend = self.ensure_backend()?;
        let dk = self.data_key()?;
        self.set_syncing(true);

        // 2. 上传：每条开着的流把自己的待上传队列写成段。
        for name in &enabled {
            if failed.contains(name) {
                continue;
            }
            if let Err(e) = self.upload_stream(*name, &backend, &dk).await {
                self.note_stream_error(*name, &e);
                failed.insert(*name);
            }
        }
        if kind == RoundKind::Local {
            return if failed.is_empty() {
                Ok(())
            } else {
                Err(self.round_error(&enabled, &failed, &[]))
            };
        }

        // 3. 拉取：每条开着的流各自读对端文件、吸收进自己的镜像。
        for name in &enabled {
            if failed.contains(name) {
                continue;
            }
            match self.pull_stream(*name, &backend, &dk).await {
                Ok(report) => {
                    needs_upgrade |= report.needs_upgrade;
                    if !report.soft_errors.is_empty() {
                        // 软错误（某个对端文件坏了 / 读不懂）只影响那台设备，不拖累别的流；
                        // 但要记进这条流的 lastError，界面上才看得见。
                        self.stream_errors
                            .insert(*name, report.soft_errors.join("；"));
                    }
                    soft_errors.extend(
                        report
                            .soft_errors
                            .into_iter()
                            .map(|m| format!("{}：{}", stream_label(*name), m)),
                    );
                }
                Err(e) => {
                    self.note_stream_error(*name, &e);
                    failed.insert(*name);
                }
            }
        }
        self.needs_upgrade = needs_upgrade;

        // 4. 落地：把已吸收的远端改动写进本机（配置流在自己的写者锁内先捕获再对齐）。
        //
        // 配置流的「某个源落地失败」是**软错误**：与一期一致，这一轮照样把锁内捕获到的新 op
        // 传上去、照样压缩（否则失败的那个源会拖住其它源的新改动）。只有网络 / 存储层那样
        // 连拉都拉不下来的错误才算这条流这一轮失败。
        for name in &enabled {
            if failed.contains(name) {
                continue;
            }
            match self.land_stream(*name).await {
                Ok(apply_errors) => {
                    if !apply_errors.is_empty() {
                        self.stream_errors.insert(*name, apply_errors.join("；"));
                        soft_errors.extend(
                            apply_errors
                                .into_iter()
                                .map(|m| format!("{}：{}", stream_label(*name), m)),
                        );
                    }
                }
                Err(e) => {
                    self.note_stream_error(*name, &e);
                    failed.insert(*name);
                }
            }
        }

        // 5. 落地时锁内的再次捕获可能产生了新 op：配置流在 `apply_pending` 的写者锁里已经
        //    捕获进 outbox（直接上传即可）；conv / sec 的驱动没有「写者锁内捕获」这一步，
        //    所以再捕获一次再上传。
        for name in &enabled {
            if failed.contains(name) || *name == StreamName::Config {
                continue;
            }
            if let Err(e) = self.capture_stream(*name).await {
                self.note_stream_error(*name, &e);
                failed.insert(*name);
                continue;
            }
            if let Err(e) = self.upload_stream(*name, &backend, &dk).await {
                self.note_stream_error(*name, &e);
                failed.insert(*name);
            }
        }
        for name in &enabled {
            if failed.contains(name) || *name != StreamName::Config {
                continue;
            }
            if let Err(e) = self.upload_stream(*name, &backend, &dk).await {
                self.note_stream_error(*name, &e);
                failed.insert(*name);
            }
        }

        // 6. 压缩（失败不影响这一轮的结论）。
        for name in &enabled {
            if failed.contains(name) {
                continue;
            }
            if let Err(e) = self.compact_stream(*name, &backend, &dk).await {
                log::warn!(
                    "同步：压缩{}失败（下一轮再试）: {}",
                    stream_label(*name),
                    plain_error(&e)
                );
            }
        }

        if failed.is_empty() && soft_errors.is_empty() {
            Ok(())
        } else {
            Err(self.round_error(&enabled, &failed, &soft_errors))
        }
    }

    /// 记一条流这一轮的错误（`SyncStatus.streams[].lastError` 与整轮错误都用它）。
    fn note_stream_error(&mut self, name: StreamName, e: &AppError) {
        self.stream_errors.insert(name, plain_error(e));
    }

    /// 整轮的错误文案。
    ///
    /// 只开着一条流时（= 一期的「只开配置档」）**原样返回那条流的错误**，不带「上传普通配置：」
    /// 之类的前缀：一期的错误文案与测试都按这个形状钉着，别让多流的包装改变它。
    fn round_error(
        &self,
        enabled: &[StreamName],
        failed: &BTreeSet<StreamName>,
        soft_errors: &[String],
    ) -> AppError {
        if enabled.len() == 1 && failed.len() <= 1 && soft_errors.is_empty() {
            if let Some(text) = self.stream_errors.get(&enabled[0]) {
                return AppError::Other(text.clone());
            }
        }
        let mut parts: Vec<String> = failed
            .iter()
            .filter_map(|n| {
                self.stream_errors
                    .get(n)
                    .map(|t| format!("{}：{t}", stream_label(*n)))
            })
            .collect();
        parts.extend(soft_errors.iter().cloned());
        parts.sort();
        AppError::Other(parts.join("；"))
    }

    /// 有没有待上传的东西（`RoundKind::Local` 据此决定要不要碰网络）。
    fn has_pending_work(&self) -> bool {
        !self.ledger.outbox.is_empty()
            || self
                .pending_segments
                .values()
                .any(|segments| !segments.is_empty())
    }

    /// 每轮开始时按账本里的 `StreamState` 构造 conv / sec 的驱动（没有工厂的流不构造）。
    ///
    /// 构造失败只记该流的错误、跳过它：一条流的驱动坏了不该让配置流也同步不了。
    fn build_drivers(&mut self) {
        self.drivers.clear();
        for factory in self.deps.stream_drivers.clone() {
            let name = factory.name();
            if name == StreamName::Config {
                continue; // 配置流用内建驱动，不接受外部替换
            }
            if !self.ledger.st.stream_enabled(name) {
                continue; // 关着的流不构造驱动：连初始化错误都不该出现在状态里
            }
            let state = self.ledger.st.stream(name);
            match factory.create(state) {
                Ok(driver) => {
                    self.drivers.insert(name, driver);
                }
                Err(e) => {
                    self.stream_errors.insert(
                        name,
                        format!("初始化{}：{}", stream_label(name), plain_error(&e)),
                    );
                }
            }
        }
    }

    // ── 每条流的阶段 ─────────────────────────────────────────────────────

    fn config_driver(&mut self, dk: Option<DataKey>) -> ConfigStreamDriver<'_> {
        ConfigStreamDriver::new(
            &mut self.ledger,
            &self.deps,
            &self.view,
            &mut self.join_remap,
            self.files.clone(),
            dk,
        )
    }

    async fn capture_stream(&mut self, name: StreamName) -> Result<(), AppError> {
        if name == StreamName::Config {
            // 捕获不需要数据密钥：密钥链一时不可用也要先把本机改动记进账本。
            let mut driver = self.config_driver(None);
            driver.phase_capture().await?;
            return Ok(());
        }
        let Some(driver) = self.drivers.get_mut(&name) else {
            return Ok(()); // 还没有驱动（T2 / T6 之前）：不产生任何远端写入
        };
        let segments = driver.capture().await?;
        self.pending_segments.insert(name, segments);
        Ok(())
    }

    /// 上传一条流的待上传内容。
    ///
    /// 配置流的队列在账本里（一期的 outbox）；conv / sec 的段是驱动在 `capture` 里给的明文，
    /// 由引擎分配序号、封装、上传，最后 `ack_capture`。
    async fn upload_stream(
        &mut self,
        name: StreamName,
        backend: &Arc<dyn Backend>,
        dk: &DataKey,
    ) -> Result<(), AppError> {
        if name == StreamName::Config {
            let mut driver = self.config_driver(Some(dk.clone()));
            return driver.upload_outbox(backend).await;
        }
        let segments = self.pending_segments.remove(&name).unwrap_or_default();
        if segments.is_empty() {
            return Ok(());
        }
        // 先把驱动从表里取出来，避免「持着 `&mut self.drivers` 又去调 `&mut self`」的借用冲突；
        // 无论成败都放回去（它的状态还要写回账本）。
        let Some(mut driver) = self.drivers.remove(&name) else {
            return Ok(());
        };
        let outcome = self
            .upload_segments_with(name, &mut driver, &segments, backend, dk)
            .await;
        self.drivers.insert(name, driver);
        outcome
    }

    async fn upload_segments_with(
        &mut self,
        name: StreamName,
        driver: &mut Box<dyn StreamDriver>,
        segments: &[Vec<u8>],
        backend: &Arc<dyn Backend>,
        dk: &DataKey,
    ) -> Result<(), AppError> {
        for plain in segments {
            // **序号由引擎分配**（契约第 5 节）：账本是权威，驱动只负责把序号写进明文 JSON。
            let mut st = self.ledger.st.stream(name);
            st.seq += 1;
            let seq = st.seq;
            st.segs_since_snapshot += 1;
            self.ledger.st.set_stream(name, st.clone());
            driver.set_state(st);
            // 序号先落盘再 put：put 成功但随后记账失败时，重传用新序号，读的一方不会漏掉内容。
            self.ledger.dirty.state = true;
            self.ledger.flush(&self.files)?;
            let bytes = seal_stream_file(
                dk,
                name,
                StreamFileKind::Segment,
                &self.ledger.st.device_id,
                seq,
                None,
                plain,
            )?;
            let path =
                format::stream_segment_path(&self.ledger.st.device_id, remote_stream_of(name), seq);
            backend.put(&path, &bytes).await.map_err(storage_err)?;
        }
        driver.ack_capture().await?;
        self.ledger.flush(&self.files)
    }

    async fn pull_stream(
        &mut self,
        name: StreamName,
        backend: &Arc<dyn Backend>,
        dk: &DataKey,
    ) -> Result<PullReport, AppError> {
        if name == StreamName::Config {
            let mut driver = self.config_driver(Some(dk.clone()));
            let report = driver.pull(backend).await?;
            return Ok(PullReport {
                needs_upgrade: report.needs_upgrade,
                soft_errors: report.soft_errors,
            });
        }
        self.pull_generic_stream(name, backend, dk).await
    }

    /// conv / sec 的通用拉取：列 `devices/` → 每台对端设备 → 该流的目录 → 段按游标、
    /// 快照（目录或单文件）按「比游标新」优先。驱动只接受明文，AAD / 解密封装由
    /// [`BackendStreamRemote`] 做。
    async fn pull_generic_stream(
        &mut self,
        name: StreamName,
        backend: &Arc<dyn Backend>,
        dk: &DataKey,
    ) -> Result<PullReport, AppError> {
        let mut report = PullReport::default();
        if !self.drivers.contains_key(&name) {
            return Ok(report);
        }
        let entries = backend.list(DEVICES_DIR).await.map_err(storage_err)?;
        let mut devices: Vec<String> = entries
            .into_iter()
            .filter(|e| {
                e.is_dir && is_valid_device_id(&e.name) && e.name != self.ledger.st.device_id
            })
            .map(|e| e.name)
            .collect();
        devices.sort();

        for device in devices {
            let dir = name.remote_dir(&device);
            let files = backend.list(&dir).await.map_err(storage_err)?;
            let mut segs: Vec<u64> = Vec::new();
            let mut snaps: Vec<u64> = Vec::new();
            for f in files.iter().filter(|f| !f.is_dir) {
                match parse_device_rel_path(&format!("{dir}/{}", f.name)) {
                    Some(p) if p.kind == RemoteFileKind::Segment => segs.push(p.seq),
                    Some(p) if p.kind == RemoteFileKind::Snapshot => snaps.push(p.seq),
                    _ => {}
                }
            }
            // 分包快照是目录：`snap-<seq>/` 下放 index + part。
            for f in files.iter().filter(|f| f.is_dir) {
                if let Some(num) = f.name.strip_prefix("snap-") {
                    if !num.is_empty() && num.bytes().all(|b| b.is_ascii_digit()) {
                        if let Ok(seq) = num.parse::<u64>() {
                            snaps.push(seq);
                        }
                    }
                }
            }
            segs.sort_unstable();
            snaps.sort_unstable();

            let mut cursor = self
                .ledger
                .st
                .stream(name)
                .cursors
                .get(&device)
                .cloned()
                .unwrap_or_default();

            // 快照优先：比游标新的最新快照整份吸收，再把游标抬到它。
            if let Some(&latest) = snaps.last() {
                if latest > cursor.seg {
                    let remote =
                        BackendStreamRemote::new(backend.clone(), dk.clone(), device.clone(), name);
                    let outcome = self
                        .drivers
                        .get_mut(&name)
                        .expect("上面查过")
                        .apply_snapshot(&remote, latest)
                        .await;
                    match outcome {
                        Ok(applied) => {
                            self.record_stream_applied(name, &applied);
                            cursor = Cursor {
                                snap: latest,
                                seg: latest,
                            };
                            self.set_stream_cursor(name, &device, cursor.clone());
                        }
                        Err(e) => {
                            let text = plain_error(&e);
                            if text.contains("升级") {
                                report.needs_upgrade = true;
                            } else {
                                report
                                    .soft_errors
                                    .push(format!("读取「{device}」的快照失败：{text}"));
                            }
                            continue;
                        }
                    }
                }
            }

            for seq in segs {
                if seq <= cursor.seg {
                    continue;
                }
                let path = format::stream_segment_path(&device, remote_stream_of(name), seq);
                let Some(bytes) = backend.get(&path).await.map_err(storage_err)? else {
                    break; // 列出来又读不到（对方正在写）：下一轮重新列
                };
                let remote =
                    BackendStreamRemote::new(backend.clone(), dk.clone(), device.clone(), name);
                let plain = match super::streams::StreamRemote::open(
                    &remote,
                    StreamFileKind::Segment,
                    seq,
                    None,
                    &bytes,
                ) {
                    Ok(p) => p,
                    Err(e) => {
                        if e.is_too_new() {
                            report.needs_upgrade = true;
                        } else {
                            report
                                .soft_errors
                                .push(format!("读取「{device}」的同步数据失败：{e}"));
                        }
                        break;
                    }
                };
                // 二、三期的段结构由各自的驱动解析，但「格式过新要提示升级」是统一的：
                // 先看 format 再交给驱动，别让新版本的文件被当成损坏数据反复重读。
                if let Err(e) = format::check_format(&plain) {
                    if e.is_too_new() {
                        report.needs_upgrade = true;
                    } else {
                        report
                            .soft_errors
                            .push(format!("读取「{device}」的同步数据失败：{e}"));
                    }
                    break;
                }
                let outcome = self
                    .drivers
                    .get_mut(&name)
                    .expect("上面查过")
                    .apply_segment(&plain)
                    .await;
                if let Err(e) = outcome {
                    report.soft_errors.push(format!(
                        "读取「{device}」的同步数据失败：{}",
                        plain_error(&e)
                    ));
                    break;
                }
                cursor.seg = seq;
                self.set_stream_cursor(name, &device, cursor.clone());
            }
            self.ledger.flush(&self.files)?;
        }
        Ok(report)
    }

    /// 把已吸收的远端改动落地。返回「软错误」清单（配置流里某个源落地失败但其它源照常）。
    async fn land_stream(&mut self, name: StreamName) -> Result<Vec<String>, AppError> {
        if name == StreamName::Config {
            let dk = self.data_key()?;
            let mut driver = self.config_driver(Some(dk));
            return Ok(driver.apply_pending().await);
        }
        let Some(driver) = self.drivers.get_mut(&name) else {
            return Ok(Vec::new());
        };
        let applied: StreamApplied = driver.land().await?;
        let mut st = self.ledger.st.stream(name);
        st.applied = true;
        self.ledger.st.set_stream(name, st.clone());
        driver.set_state(st);
        self.ledger.dirty.state = true;
        self.record_stream_applied(name, &applied);
        Ok(Vec::new())
    }

    async fn compact_stream(
        &mut self,
        name: StreamName,
        backend: &Arc<dyn Backend>,
        dk: &DataKey,
    ) -> Result<(), AppError> {
        if name == StreamName::Config {
            let mut driver = self.config_driver(Some(dk.clone()));
            return driver.maybe_compact(backend).await;
        }
        let Some(driver) = self.drivers.get_mut(&name) else {
            return Ok(());
        };
        let st = self.ledger.st.stream(name);
        if st.segs_since_snapshot < COMPACT_AFTER_SEGS {
            return Ok(());
        }
        let Some(snapshot) = driver.make_snapshot().await? else {
            return Ok(());
        };
        let seq = st.seq;
        let device = self.ledger.st.device_id.clone();
        match driver.snapshot_layout() {
            StreamSnapshotLayout::SingleFile => {
                for (name_in_dir, plain) in &snapshot.files {
                    let path = format!("{}/{}", name.remote_dir(&device), name_in_dir);
                    let bytes = seal_stream_file(
                        dk,
                        name,
                        StreamFileKind::Snapshot,
                        &device,
                        seq,
                        None,
                        plain,
                    )?;
                    backend.put(&path, &bytes).await.map_err(storage_err)?;
                }
            }
            StreamSnapshotLayout::Directory => {
                for (name_in_dir, plain) in &snapshot.files {
                    let (kind, part) = if name_in_dir == "index.msync" {
                        (StreamFileKind::SnapshotIndex, None)
                    } else {
                        let p = name_in_dir
                            .trim_start_matches("part-")
                            .trim_end_matches(".msync")
                            .parse::<u32>()
                            .unwrap_or(0);
                        (StreamFileKind::SnapshotPart, Some(p))
                    };
                    let path = format!(
                        "{}/snap-{:012}/{}",
                        name.remote_dir(&device),
                        seq,
                        name_in_dir
                    );
                    let bytes = seal_stream_file(dk, name, kind, &device, seq, part, plain)?;
                    backend.put(&path, &bytes).await.map_err(storage_err)?;
                }
            }
        }
        let mut st = self.ledger.st.stream(name);
        st.segs_since_snapshot = 0;
        self.ledger.st.set_stream(name, st.clone());
        driver.set_state(st);
        self.ledger.dirty.state = true;
        self.ledger.flush(&self.files)
    }

    /// 记录一次落地结果：进度进 `sync_status`，变化的会话 id 发给前端。
    fn record_stream_applied(&mut self, name: StreamName, applied: &StreamApplied) {
        if !applied.conversation_ids.is_empty() {
            self.deps
                .events
                .data_applied_ids("conversations", &applied.conversation_ids);
        }
        if let Some(p) = &applied.progress {
            self.stream_progress.insert(name, p.clone());
        } else if applied.changed {
            // 这一轮落地完成且没有新进度：清掉「正在同步」的旧进度，别让界面停在 N/M。
            self.stream_progress.remove(&name);
        }
    }

    fn set_stream_cursor(&mut self, name: StreamName, device: &str, cursor: Cursor) {
        let mut st = self.ledger.st.stream(name);
        st.cursors.insert(device.to_string(), cursor);
        self.ledger.st.set_stream(name, st);
        self.ledger.dirty.state = true;
    }

    /// 测试专用：跳过「捕获」，直接拉取并落地——模拟「防抖窗口里本机刚改了东西、还没被捕获，
    /// 远端落地就来了」。落地步骤自己会在写者锁内先捕获一次，这里验证它没有把本机改动吞掉。
    #[cfg(test)]
    pub(crate) async fn test_pull_and_apply_without_capture(&mut self) -> Vec<String> {
        let backend = self.ensure_backend().expect("backend");
        let dk = self.data_key().expect("dk");
        let report = {
            let mut driver = self.config_driver(Some(dk.clone()));
            driver.pull(&backend).await.expect("pull")
        };
        let errors = {
            let mut driver = self.config_driver(Some(dk));
            driver.apply_pending().await
        };
        self.needs_upgrade = report.needs_upgrade;
        self.flush().expect("flush");
        self.publish();
        errors
    }

    // ═══════════════════════════════════════════════════════════════════
    // 三档开关
    // ═══════════════════════════════════════════════════════════════════

    /// 打开 / 关闭某一档。
    ///
    /// 打开：先把本机已有数据整份导出并上传（相当于「加入这条流」），再跑一轮完整同步追上别人的进度。
    /// 关闭：**不删**远端文件、不删本机数据，只是之后不再上传 / 拉取（关着的流在捕获阶段就跳过）。
    pub async fn enable_tier(&mut self, tier: &str, enabled: bool) -> Result<(), AppError> {
        if !self.ledger.enabled() {
            return Err(AppError::Other("还没有开启同步。".into()));
        }
        let tier = match tier {
            "conversation" => SyncTier::Conversation,
            "secret" => SyncTier::Secret,
            // 配置档恒为开：一期行为，不允许关掉它（否则这套同步就没有任何意义）
            "config" => {
                return Err(AppError::Other(
                    "「普通配置」这一档是同步的基础，不能关闭。".into(),
                ))
            }
            other => return Err(AppError::Other(format!("未知的同步档位：{other}"))),
        };
        let was_on = self.ledger.st.tier_enabled(tier);
        match tier {
            SyncTier::Conversation => self.ledger.st.tiers.conversation = enabled,
            SyncTier::Secret => self.ledger.st.tiers.secret = enabled,
            _ => {}
        }
        self.ledger.dirty.state = true;
        self.flush()?;
        if !enabled || was_on == enabled {
            // 关闭 / 本来就开着：不用补数据，下一轮自然只处理开着的流。
            self.publish();
            return Ok(());
        }

        // 第一次打开这一档：先把本机现有数据整份导出并上传（「加入该流」）。
        let name = match tier {
            SyncTier::Conversation => StreamName::Conv,
            SyncTier::Secret => StreamName::Sec,
            _ => unreachable!(),
        };
        // 这条流还没落地过别人的数据：拉到之后要整份落地。
        let mut st = self.ledger.st.stream(name);
        st.applied = false;
        self.ledger.st.set_stream(name, st);
        self.ledger.dirty.state = true;
        self.flush()?;

        self.build_drivers();
        let backend = self.ensure_backend()?;
        let dk = self.data_key()?;
        // 本机已有数据整份导出并上传（相当于「加入这条流」）。没有驱动（T2 / T6 之前）
        // 时什么都不做：开关照样记下来，等驱动接上后下一轮开始走这条流。
        if let Some(driver) = self.drivers.get_mut(&name) {
            let segments = driver.export_full().await?;
            self.pending_segments.insert(name, segments);
            self.upload_stream(name, &backend, &dk).await?;
        }
        self.flush()?;
        self.publish();
        // 再跑一轮完整同步：拉取别人的数据并落地。
        self.run_round(RoundKind::Full).await
    }

    /// 某一档是否开着（命令层 / 界面用）。
    pub fn tier_enabled(&self, tier: SyncTier) -> bool {
        self.ledger.st.tier_enabled(tier)
    }

    // ═══════════════════════════════════════════════════════════════════
    // 开启 / 加入 / 停止
    // ═══════════════════════════════════════════════════════════════════

    /// 连通性 + 权限自检。`secret` 为空且当前已开启同一份 WebDAV 存储时用已保存的密码。
    pub async fn test_storage(
        &self,
        storage: &StorageConfig,
        secret: Option<Zeroizing<String>>,
    ) -> Result<(), AppError> {
        let secret = match secret.filter(|s| !s.is_empty()) {
            Some(s) => Some(s),
            None if self.ledger.st.storage.as_ref() == Some(storage) => self.storage_secret()?,
            None => None,
        };
        let backend = self
            .deps
            .backends
            .build(storage, secret.as_deref().map(|s| s.as_str()))
            .map_err(storage_err)?;
        let result = backend.probe().await.map_err(storage_err);
        backend.close().await;
        result
    }

    /// 开启同步（第一台设备）。
    pub async fn create(
        &mut self,
        storage: StorageConfig,
        secret: Option<Zeroizing<String>>,
    ) -> Result<SyncCreateResult, AppError> {
        if self.ledger.enabled() {
            return Err(AppError::Other("同步已经开启了。".into()));
        }
        let secret = secret.filter(|s| !s.is_empty());
        let backend = self
            .deps
            .backends
            .build(&storage, secret.as_deref().map(|s| s.as_str()))
            .map_err(storage_err)?;
        backend.probe().await.map_err(storage_err)?;
        if backend.get(META_FILE).await.map_err(storage_err)?.is_some() {
            backend.close().await;
            return Err(AppError::Other(
                "该位置已有同步数据，请用「加入已有同步」。".into(),
            ));
        }

        let (rk, dk, wrapped) = crypto::generate_vault()?;
        let device_id = new_device_id();

        // SFTP 存储：把同步目录加进受保护路径，免得 Agent 把它删了
        let mut protected = None;
        if let Some(root) = backend.protected_root().await {
            self.add_protected_path(&root).await;
            protected = Some(root);
        }

        // 全新账本：每个源全量导出为 Set op（当前时钟）
        let previous = std::mem::replace(&mut self.ledger, Ledger::fresh());
        self.ledger.set_identity(&device_id);
        self.ledger.st.device_name = self.deps.default_device_name.clone();
        self.ledger.st.storage = Some(storage.clone());
        self.ledger.st.last_app_version = self.deps.app_version.clone();
        self.ledger.st.protected_path = protected;
        let built = self
            .create_inner(
                &backend,
                &dk,
                &wrapped,
                secret.as_deref().map(|s| s.as_str()),
                &rk,
            )
            .await;
        match built {
            Ok(result) => {
                backend.close().await;
                self.backend = None;
                self.dk = Some(dk);
                self.publish();
                Ok(result)
            }
            Err(e) => {
                // 回滚：远端只可能留下本机的设备目录与 meta（尽力清理），本机账本放回去
                let _ = backend.delete(&format::device_dir(&device_id)).await;
                let _ = backend.delete(META_FILE).await;
                backend.close().await;
                self.ledger = previous;
                let _ = self.files.wipe();
                for slot in SecretSlot::sync_slots() {
                    let _ = self.deps.secrets.delete(&slot);
                }
                self.publish();
                Err(e)
            }
        }
    }

    async fn create_inner(
        &mut self,
        backend: &Arc<dyn Backend>,
        dk: &DataKey,
        wrapped: &crypto::WrappedKey,
        storage_secret: Option<&str>,
        rk: &RecoveryKey,
    ) -> Result<SyncCreateResult, AppError> {
        let wall = self.now_ms();
        let platform = self.deps.platform;
        for adapter in self.deps.adapters.clone() {
            let key = adapter.key();
            let doc = adapter.read_json().await?;
            let ledger = &mut self.ledger;
            let idmaps = ledger.st.idmaps.entry(key.to_string()).or_default();
            let ops = {
                let mut ctx = super::core::DiffCtx {
                    rules: adapter.rules(),
                    platform,
                    idmaps,
                    clock: &mut ledger.clock,
                    wall_ms: wall,
                    suppress_removes: false,
                };
                super::core::export_all(key, &doc, &mut ctx)
            };
            let mirror = ledger.mirrors.entry(key.to_string()).or_default();
            for op in &ops {
                mirror.merge(op);
            }
            ledger.set_baseline(key, doc);
            ledger.set_applied(key, true);
        }

        // 快照先于 meta：meta 是「这份同步已经存在」的标记，放最后写
        let _ = self.files.wipe();
        self.view.history.lock().clear();
        self.ledger.st.seq = 1;
        let (mirrors, idmaps) = self.ledger.snapshot_parts();
        let snap = encode_snapshot(
            dk,
            &self.device_info(),
            1,
            &mirrors,
            &idmaps,
            self.ledger.st.tiers,
        )?;
        let device = self.ledger.st.device_id.clone();
        backend
            .put(&file_path(&device, FileKind::Snapshot, 1), &snap)
            .await
            .map_err(storage_err)?;
        let meta = SyncMeta::new(wrapped.clone(), self.now_rfc3339());
        backend
            .put(META_FILE, &meta.to_bytes())
            .await
            .map_err(storage_err)?;

        // 本机存密钥、落账本
        self.deps
            .secrets
            .set(&SecretSlot::SyncDataKey, &dk.to_b64())?;
        self.deps
            .secrets
            .set(&SecretSlot::SyncRecoveryKey, rk.canonical())?;
        if let (Some(StorageConfig::WebDav { .. }), Some(pw)) =
            (&self.ledger.st.storage, storage_secret)
        {
            self.deps
                .secrets
                .set(&SecretSlot::SyncStoragePassword, pw)?;
        }
        self.ledger.st.enabled = true;
        self.ledger.mark_all_dirty();
        self.flush()?;

        let storage = self.ledger.st.storage.clone().expect("刚设置过");
        let code = self
            .build_sync_code(&storage, storage_secret, rk.canonical())
            .await?;
        Ok(SyncCreateResult {
            recovery_key: rk.display().to_string(),
            sync_code: code.to_string(),
        })
    }

    /// 把同步目录（SFTP 服务器上的绝对路径）加进受保护路径。失败只记日志，不拦开启。
    async fn add_protected_path(&self, root: &str) {
        let root = root.to_string();
        let r = self
            .deps
            .settings
            .mutate(move |s| {
                if !s.custom_protected_paths.iter().any(|p| p == &root) {
                    s.custom_protected_paths.push(root);
                }
                Ok(())
            })
            .await;
        if let Err(e) = r {
            log::warn!("同步：把同步目录加入受保护路径失败: {e}");
        }
    }

    /// 生成同步码（加新设备用）。**本身就是机密**：含恢复密钥与存储密码。
    pub async fn build_sync_code(
        &self,
        storage: &StorageConfig,
        storage_secret: Option<&str>,
        rk_canonical: &str,
    ) -> Result<Zeroizing<String>, AppError> {
        build_sync_code(&self.deps, storage, storage_secret, rk_canonical).await
    }

    /// 加入已有同步。
    pub async fn join(&mut self, spec: JoinSpec) -> Result<(), AppError> {
        if self.ledger.enabled() {
            return Err(AppError::Other("同步已经开启了。".into()));
        }

        // ── 解析参数；同步码里的 SFTP 服务器先装进本机（失败要回滚） ──
        let mut installed = InstalledBundle::default();
        let (storage, secret, rk) = match spec {
            JoinSpec::Manual {
                storage,
                secret,
                recovery_key,
            } => (
                storage,
                secret.filter(|s| !s.is_empty()),
                RecoveryKey::parse(&recovery_key)?,
            ),
            JoinSpec::Code(code) => {
                let payload: SyncCodePayload<StorageConfig> = decode_sync_code(&code)?;
                let rk = RecoveryKey::parse(&payload.rk)?;
                let secret = Some(Zeroizing::new(payload.secret.clone())).filter(|s| !s.is_empty());
                let storage = payload.storage.clone();
                if matches!(storage, StorageConfig::Sftp { .. }) {
                    let bundle = payload
                        .sftp_connection
                        .clone()
                        .and_then(|v| serde_json::from_value::<SftpBundle>(v).ok())
                        .ok_or_else(|| {
                            AppError::Other(
                                "同步码里缺少 SFTP 服务器的信息，请在另一台设备上重新生成同步码。"
                                    .into(),
                            )
                        })?;
                    check_bundle_supported(&bundle)?;
                    installed = self
                        .install_bundle(&bundle, secret.as_deref().map(|s| s.as_str()))
                        .await?;
                }
                (storage, secret, rk)
            }
        };

        let result = self.join_inner(storage, secret, rk).await;
        if result.is_err() {
            self.rollback_bundle(installed).await;
        }
        result
    }

    async fn join_inner(
        &mut self,
        storage: StorageConfig,
        secret: Option<Zeroizing<String>>,
        rk: RecoveryKey,
    ) -> Result<(), AppError> {
        let backend = self
            .deps
            .backends
            .build(&storage, secret.as_deref().map(|s| s.as_str()))
            .map_err(storage_err)?;

        // ── 读 meta、解出数据密钥 ──
        let Some(meta_bytes) = backend.get(META_FILE).await.map_err(storage_err)? else {
            backend.close().await;
            return Err(AppError::Other(
                "在这个位置没有找到同步数据。请确认存储位置（地址 / 目录）和另一台设备上的一致。"
                    .into(),
            ));
        };
        let meta = SyncMeta::from_bytes(&meta_bytes)?;
        let dk = meta.unwrap_data_key(&rk)?;
        // 到这里才确定要加入了：清掉上一次残留的账本与记录，之后落地产生的同步记录才不会被误删
        let _ = self.files.wipe();
        self.view.history.lock().clear();

        // ── 换新身份，拉取全部设备的数据 ──
        let previous = std::mem::replace(&mut self.ledger, Ledger::fresh());
        self.join_remap.clear();
        self.ledger.set_identity(&new_device_id());
        self.ledger.st.device_name = self.deps.default_device_name.clone();
        self.ledger.st.storage = Some(storage.clone());
        self.ledger.st.last_app_version = self.deps.app_version.clone();

        let outcome = self.join_pull_and_merge(&backend, &dk).await;
        let outcome = match outcome {
            Ok(()) => self.finish_join(&storage, secret.as_deref().map(|s| s.as_str()), &dk, &rk),
            Err(e) => Err(e),
        };
        match outcome {
            Ok(()) => {
                backend.close().await;
                self.backend = None;
                self.dk = Some(dk);
                self.last_error = None;
                self.needs_upgrade = false;
                self.publish();
                Ok(())
            }
            Err(e) => {
                backend.close().await;
                self.ledger = previous;
                self.join_remap.clear();
                let _ = self.files.wipe();
                for slot in SecretSlot::sync_slots() {
                    let _ = self.deps.secrets.delete(&slot);
                }
                self.publish();
                Err(e)
            }
        }
    }

    async fn join_pull_and_merge(
        &mut self,
        backend: &Arc<dyn Backend>,
        dk: &DataKey,
    ) -> Result<(), AppError> {
        let report = {
            let mut driver = self.config_driver(Some(dk.clone()));
            driver.pull(backend).await?
        };
        if report.needs_upgrade {
            return Err(AppError::Other(
                "云端的数据来自更新版本的应用，请先把本机升级到最新版本再加入。".into(),
            ));
        }
        if let Some(first) = report.soft_errors.first() {
            return Err(AppError::Other(first.clone()));
        }

        // 连接先于其它源：去重产生的 id 改写表要在处理设置 / 快捷指令之前就位
        let adapters = self.deps.adapters.clone();
        let mut ordered: Vec<&Arc<dyn SourceAdapter>> = Vec::with_capacity(adapters.len());
        ordered.extend(adapters.iter().filter(|a| a.key() == "connections"));
        ordered.extend(adapters.iter().filter(|a| a.key() != "connections"));
        for adapter in ordered {
            let adapter = adapter.clone();
            let mut driver = self.config_driver(Some(dk.clone()));
            driver.merge_into_doc(&adapter, ApplyMode::Join).await?;
        }
        // 加入同步时连接去重产生的别名要**落盘**：以后任何一次上传（对话、记忆、凭据）
        // 和在其它设备上落地时都要按它换算。
        let pairs: Vec<(String, String)> = self
            .join_remap
            .iter()
            .map(|(a, b)| (a.clone(), b.clone()))
            .collect();
        super::join::record_connection_aliases(&mut self.ledger.st, &pairs);
        self.ledger.dirty.state = true;
        Ok(())
    }

    fn finish_join(
        &mut self,
        storage: &StorageConfig,
        storage_secret: Option<&str>,
        dk: &DataKey,
        rk: &RecoveryKey,
    ) -> Result<(), AppError> {
        self.deps
            .secrets
            .set(&SecretSlot::SyncDataKey, &dk.to_b64())?;
        self.deps
            .secrets
            .set(&SecretSlot::SyncRecoveryKey, rk.canonical())?;
        if let (StorageConfig::WebDav { .. }, Some(pw)) = (storage, storage_secret) {
            self.deps
                .secrets
                .set(&SecretSlot::SyncStoragePassword, pw)?;
        }
        self.ledger.st.enabled = true;
        // 所有源都已经在加入时对齐过镜像
        for adapter in &self.deps.adapters {
            self.ledger.set_applied(adapter.key(), true);
        }
        self.ledger.mark_all_dirty();
        self.flush()
    }

    async fn install_bundle(
        &self,
        bundle: &SftpBundle,
        password: Option<&str>,
    ) -> Result<InstalledBundle, AppError> {
        let mut installed = InstalledBundle::default();
        let conn = bundle.connection.clone();
        let id = conn.id.clone();

        // 连接：本机已有同 id 的就沿用（用户可能改过）
        let existed = self.deps.connections.read().await.get_by_id(&id).is_some();
        if !existed {
            let to_add = conn.clone();
            self.deps
                .connections
                .mutate(move |store| {
                    store.add(to_add);
                    Ok(())
                })
                .await?;
            installed.connection_added = Some(id.clone());
        }
        if let Some(pw) = password.filter(|p| !p.is_empty()) {
            let slot = SecretSlot::SshPassword(id.clone());
            if self.deps.secrets.get(&slot)?.is_none() {
                self.deps.secrets.set(&slot, pw)?;
                installed.password_set = Some(id.clone());
            }
        }
        // 主机指纹：同步码里带的等于用户在旧设备上确认过了
        if let Some(hk) = &bundle.host_key {
            match self
                .deps
                .known_hosts
                .record(&hk.host, hk.port, hk.entry.clone())
                .await
            {
                Ok(()) => installed.host_key = Some((hk.host.clone(), hk.port)),
                Err(_) => {
                    // 本机已有这台主机、指纹不同：不覆盖（安全边界），让用户自己去确认
                    self.rollback_bundle(installed).await;
                    return Err(AppError::Other(format!(
                        "本机已经记录了 {}:{} 的另一个主机指纹，和同步码里的不一致。请先在终端里连接这台服务器并确认指纹，再重新加入。",
                        hk.host, hk.port
                    )));
                }
            }
        }
        Ok(installed)
    }

    async fn rollback_bundle(&self, installed: InstalledBundle) {
        if let Some(id) = installed.connection_added {
            let _ = self
                .deps
                .connections
                .mutate(move |store| {
                    store.remove(&id);
                    Ok(())
                })
                .await;
        }
        if let Some(id) = installed.password_set {
            let _ = self.deps.secrets.delete(&SecretSlot::SshPassword(id));
        }
        if let Some((host, port)) = installed.host_key {
            let _ = self.deps.known_hosts.forget(&host, port).await;
        }
    }

    /// 停止同步：本机配置数据不动。`wipe_remote` 同时删掉云端本应用的同步文件。
    pub async fn disable(&mut self, wipe_remote: bool) -> Result<(), AppError> {
        if self.ledger.enabled() && wipe_remote {
            let backend = self.ensure_backend()?;
            backend.delete(DEVICES_DIR).await.map_err(storage_err)?;
            backend.delete(META_FILE).await.map_err(storage_err)?;
        }
        if let Some((_, backend)) = self.backend.take() {
            backend.close().await;
        }
        for slot in SecretSlot::sync_slots() {
            if let Err(e) = self.deps.secrets.delete(&slot) {
                log::warn!("同步：清理{}失败: {}", slot.describe(), e);
            }
        }
        self.files.wipe()?;
        self.ledger = Ledger::fresh();
        self.dk = None;
        self.needs_upgrade = false;
        self.last_error = None;
        self.syncing = false;
        self.join_remap.clear();
        self.drivers.clear();
        self.pending_segments.clear();
        self.stream_errors.clear();
        self.stream_progress.clear();
        self.view.history.lock().clear();
        self.publish();
        Ok(())
    }

    // ═══════════════════════════════════════════════════════════════════
    // 其它命令
    // ═══════════════════════════════════════════════════════════════════

    pub fn set_device_name(&mut self, name: &str) -> Result<(), AppError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(AppError::Other("设备名称不能为空。".into()));
        }
        if name.chars().count() > 64 {
            return Err(AppError::Other("设备名称太长了（最多 64 个字）。".into()));
        }
        if !self.ledger.enabled() {
            return Err(AppError::Other("还没有开启同步。".into()));
        }
        self.ledger.st.device_name = name.to_string();
        self.ledger.dirty.state = true;
        self.flush()?;
        self.publish();
        Ok(())
    }

    /// 处理「大量删除」的确认：`accept` 放行并同步给其它设备，否则撤销本机删除。
    pub async fn confirm_held(&mut self, accept: bool) -> Result<(), AppError> {
        if !self.ledger.enabled() {
            return Err(AppError::Other("还没有开启同步。".into()));
        }
        if self.ledger.held.is_empty() {
            return Ok(());
        }
        if accept {
            self.ledger.release_held();
        } else {
            self.ledger.discard_held();
        }
        self.flush()?;
        self.publish();
        // 放行 → 上传；撤销 → 把被删的元素从镜像写回本机。两种都跑一轮完整同步。
        self.run_round(RoundKind::Full).await
    }
}

#[derive(Default)]
struct InstalledBundle {
    connection_added: Option<String>,
    password_set: Option<String>,
    host_key: Option<(String, u16)>,
}

/// 同步码带不过去的服务器：用私钥登录、或者要经过跳板机。
fn check_bundle_supported(bundle: &SftpBundle) -> Result<(), AppError> {
    let c = &bundle.connection;
    if c.auth_method != "Password" {
        return Err(AppError::Other(
            "这台服务器用私钥登录，同步码带不过去私钥。请先在本机添加这台服务器并导入私钥，再用「手动加入」输入恢复密钥。".into(),
        ));
    }
    if c.use_jump {
        return Err(AppError::Other(
            "这台服务器要经过跳板机登录，同步码带不过去跳板机的凭据。请先在本机添加这台服务器，再用「手动加入」输入恢复密钥。".into(),
        ));
    }
    Ok(())
}

/// 生成同步码。
pub async fn build_sync_code(
    deps: &SyncDeps,
    storage: &StorageConfig,
    storage_secret: Option<&str>,
    rk_canonical: &str,
) -> Result<Zeroizing<String>, AppError> {
    let mut secret = Zeroizing::new(storage_secret.unwrap_or("").to_string());
    let mut sftp_connection = None;
    if let StorageConfig::Sftp { connection_id, .. } = storage {
        let connection = deps
            .connections
            .read()
            .await
            .get_by_id(connection_id)
            .cloned()
            .ok_or_else(|| AppError::Other("同步用的服务器连接已经被删除了。".into()))?;
        if connection.auth_method == "Password" {
            if let Some(pw) = deps
                .secrets
                .get(&SecretSlot::SshPassword(connection_id.clone()))?
            {
                secret = Zeroizing::new(pw);
            }
        }
        let host_key = deps
            .known_hosts
            .list()
            .await
            .into_iter()
            .find(|(k, _)| *k == format!("{}:{}", connection.host.to_lowercase(), connection.port))
            .map(|(_, entry)| HostKeyBundle {
                host: connection.host.clone(),
                port: connection.port,
                entry,
            });
        let bundle = SftpBundle {
            connection,
            host_key,
        };
        sftp_connection = Some(
            serde_json::to_value(&bundle)
                .map_err(|e| AppError::Other(format!("生成同步码失败: {e}")))?,
        );
    }
    let payload = SyncCodePayload {
        storage: storage.clone(),
        secret: std::mem::take(&mut *secret),
        rk: rk_canonical.to_string(),
        sftp_connection,
    };
    Ok(encode_sync_code(&payload)?)
}

pub fn rfc3339_from_ms(ms: u64) -> String {
    chrono::DateTime::from_timestamp_millis(ms as i64)
        .unwrap_or_default()
        .to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::connections::SavedConnection;

    fn conn(auth: &str, use_jump: bool) -> SavedConnection {
        SavedConnection {
            id: "c1".into(),
            name: "服务器".into(),
            host: "example.com".into(),
            port: 22,
            username: "root".into(),
            auth_method: auth.into(),
            key_path: None,
            key_id: None,
            group: None,
            last_connected: None,
            use_jump,
            jump_host: None,
            jump_port: None,
            jump_username: None,
            jump_auth_method: None,
            jump_key_path: None,
            jump_key_id: None,
            remote_platform: None,
        }
    }

    fn bundle(auth: &str, use_jump: bool) -> SftpBundle {
        SftpBundle {
            connection: conn(auth, use_jump),
            host_key: None,
        }
    }

    #[test]
    fn sync_codes_cannot_carry_private_keys_or_jump_hosts() {
        assert!(check_bundle_supported(&bundle("Password", false)).is_ok());

        let key = check_bundle_supported(&bundle("PrivateKey", false)).unwrap_err();
        let text = plain_error(&key);
        assert!(text.contains("私钥"), "{text}");
        assert!(
            text.contains("手动加入"),
            "要告诉用户下一步怎么办（手动加入 + 恢复密钥）: {text}"
        );

        let jump = check_bundle_supported(&bundle("Password", true)).unwrap_err();
        assert!(plain_error(&jump).contains("跳板机"));
    }

    #[test]
    fn tier_keys_match_the_frontend_contract() {
        assert_eq!(tier_key(SyncTier::Config), "config");
        assert_eq!(tier_key(SyncTier::Conversation), "conversation");
        assert_eq!(tier_key(SyncTier::Secret), "secret");
        assert_eq!(stream_label(StreamName::Conv), "对话与记忆");
    }
}
