//! `SyncManager`：同步的 manager。
//!
//! 它**协调**一堆东西——数据变更总线、定时器、前端命令、引擎的一轮同步、前端事件——所以是
//! manager 而不是纯功能。结构是一个 tokio 任务 + 命令通道的 actor：
//!
//! - 引擎 [`SyncEngine`] 被 actor **独占**，同一时刻只跑一轮同步（命令 / 定时 / 本机改动都排队）；
//! - 命令层不碰引擎：「读」（状态、设备、同步记录）直接读 [`SharedView`]，不用等一轮同步跑完；
//!   「写」（开启 / 加入 / 立即同步 / 停止……）发命令给 actor 并等回执；
//! - 触发：前端第一次 `sync_now`（或 15 秒兜底）后首轮；之后每 60 秒一轮；本机配置变了
//!   （订阅 `DataChangeBus`）2 秒防抖后捕获并上传；失败按 5 秒 → 5 分钟指数退避。
//!
//! **启动后不立刻落地**：首轮要等前端订阅好 `sync-data-applied` 之后（前端 `initSync` 订阅完会调
//! `sync_now`），否则启动期落地发出的事件前端收不到，界面就停在旧数据上，下一次保存还会把旧数据
//! 整份存回去。15 秒兜底是给「前端迟迟不来」（比如窗口没打开）的情形。

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::Value;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio::time::Instant;
use zeroize::Zeroizing;

use super::backends::ProductionBackends;
use super::core::path::{split_platform_prefix, PrefixKind};
use super::core::{wall_clock_ms, Platform, RecoveryKey, Seg};
use super::docedit;
use super::engine::{
    build_sync_code, plain_error, JoinSpec, RoundKind, SharedView, SyncDeps, SyncEngine, SyncEvents,
};
use super::history::{HistoryStore, UndoAction};
use super::secrets::{KeychainSecrets, SyncSecretStore};
use super::sources::{build_adapters, SourceStores};
use super::storage::StorageConfig;
use super::store::LedgerFiles;
use super::types::{
    SecretGroupEstimate, SyncCreateResult, SyncDataApplied, SyncDevice, SyncHistoryEntry,
    SyncStatus, TierEstimate,
};
use crate::config::keychain::SecretSlot;
use crate::data::{DataChange, DataChangeBus, DataSourceId};
use crate::error::AppError;
use crate::ssh::connection::SshManager;

/// 定时参数（测试里换成很短的）。
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// 前端一直不来调 `sync_now` 时，多久后兜底开始首轮。
    pub gate: Duration,
    /// 本机改动的防抖。
    pub debounce: Duration,
    /// 连续改动时防抖最多推迟多久（拖滑块这种会不停触发）。
    pub debounce_max: Duration,
    /// 完整一轮的周期。
    pub periodic: Duration,
    pub backoff_min: Duration,
    pub backoff_max: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            gate: Duration::from_secs(15),
            debounce: Duration::from_secs(2),
            debounce_max: Duration::from_secs(10),
            periodic: Duration::from_secs(60),
            backoff_min: Duration::from_secs(5),
            backoff_max: Duration::from_secs(300),
        }
    }
}

/// 什么时候该跑哪种轮次。**纯逻辑**（时间由调用方传入），单测直接钉。
pub struct Scheduler {
    timing: Timing,
    started: Instant,
    ready: bool,
    dirty_since: Option<Instant>,
    last_change: Option<Instant>,
    next_full: Option<Instant>,
    backoff: Option<Duration>,
    retry_at: Option<Instant>,
}

impl Scheduler {
    pub fn new(timing: Timing, now: Instant) -> Self {
        Scheduler {
            timing,
            started: now,
            ready: false,
            dirty_since: None,
            last_change: None,
            next_full: None,
            backoff: None,
            retry_at: None,
        }
    }

    /// 前端来过了（第一次 `sync_now`）：之后的轮次不再等兜底计时。
    pub fn mark_ready(&mut self) {
        self.ready = true;
    }

    pub fn is_ready(&self) -> bool {
        self.ready
    }

    /// 同步刚开启 / 刚停止：计时重来。开启意味着前端就在眼前，直接算 ready。
    pub fn reset(&mut self, enabled: bool, now: Instant) {
        self.dirty_since = None;
        self.last_change = None;
        self.backoff = None;
        self.retry_at = None;
        self.next_full = enabled.then(|| now + self.timing.periodic);
        if enabled {
            self.ready = true;
        }
    }

    pub fn on_local_change(&mut self, now: Instant) {
        self.dirty_since.get_or_insert(now);
        self.last_change = Some(now);
    }

    fn dirty_deadline(&self) -> Option<Instant> {
        let (since, last) = (self.dirty_since?, self.last_change?);
        Some((last + self.timing.debounce).min(since + self.timing.debounce_max))
    }

    /// 下一次需要醒来的时刻；`None` = 没有计划中的轮次。
    pub fn next_wake(&self) -> Option<Instant> {
        if !self.ready {
            return Some(self.started + self.timing.gate);
        }
        let floor = self.retry_at;
        let clamp = |t: Instant| floor.map_or(t, |f| t.max(f));
        let candidates = [self.next_full, self.dirty_deadline()];
        candidates.into_iter().flatten().map(clamp).min()
    }

    /// 取走到点的轮次（会清掉对应的待办标记）。
    pub fn take_due(&mut self, now: Instant) -> Option<RoundKind> {
        if !self.ready {
            if now >= self.started + self.timing.gate {
                self.ready = true; // 兜底：前端没来，自己上
                return Some(RoundKind::Full);
            }
            return None;
        }
        if self.retry_at.is_some_and(|t| now < t) {
            return None;
        }
        if self.next_full.is_some_and(|t| now >= t) {
            self.dirty_since = None;
            self.last_change = None;
            return Some(RoundKind::Full);
        }
        if self.dirty_deadline().is_some_and(|t| now >= t) {
            self.dirty_since = None;
            self.last_change = None;
            return Some(RoundKind::Local);
        }
        None
    }

    /// 一轮跑完（不论谁触发的）。失败按指数退避，成功重新计时。
    pub fn after_round(&mut self, kind: RoundKind, ok: bool, now: Instant) {
        if kind == RoundKind::Full {
            // 完整一轮在开头就捕获过所有本机改动：防抖待办到此为止。
            // 不清的话，退避期间攒下的脏标记会在成功之后把下一轮提前到「别处改了东西」的时刻，
            // 白跑一轮（内容为空，但会碰网络）。
            self.dirty_since = None;
            self.last_change = None;
        }
        if ok {
            self.backoff = None;
            self.retry_at = None;
            if kind == RoundKind::Full {
                self.next_full = Some(now + self.timing.periodic);
            }
            return;
        }
        let next = match self.backoff {
            None => self.timing.backoff_min,
            Some(b) => (b * 2).min(self.timing.backoff_max),
        };
        self.backoff = Some(next);
        let retry = now + next;
        self.retry_at = Some(retry);
        // 失败后的重试一律走完整一轮（它会顺带把没传上去的补传）
        self.next_full = Some(retry);
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 命令
// ═══════════════════════════════════════════════════════════════════════

type Reply<T> = oneshot::Sender<Result<T, AppError>>;

enum Cmd {
    SyncNow(Reply<()>),
    Create {
        storage: StorageConfig,
        secret: Option<Zeroizing<String>>,
        reply: Reply<SyncCreateResult>,
    },
    Join {
        spec: JoinSpec,
        reply: Reply<()>,
    },
    SetDeviceName {
        name: String,
        reply: Reply<()>,
    },
    ConfirmHeld {
        accept: bool,
        reply: Reply<()>,
    },
    SetTier {
        tier: String,
        enabled: bool,
        reply: Reply<()>,
    },
    Disable {
        wipe_remote: bool,
        reply: Reply<()>,
    },
}

// ═══════════════════════════════════════════════════════════════════════
// Tauri 事件
// ═══════════════════════════════════════════════════════════════════════

/// `AppHandle` 要到 `setup` 才有，所以先造一个空壳，`start` 时再装上。
#[derive(Default)]
pub struct TauriEvents {
    app: RwLock<Option<tauri::AppHandle>>,
}

impl TauriEvents {
    fn attach(&self, app: tauri::AppHandle) {
        *self.app.write() = Some(app);
    }
}

impl SyncEvents for TauriEvents {
    fn status(&self, status: &SyncStatus) {
        use tauri::Emitter;
        // 直接 `emit`，不走 `emit_event`：状态里有存储地址 / 账号，不该镜像给插件事件总线。
        if let Some(app) = self.app.read().as_ref() {
            let _ = app.emit("sync-status", status);
        }
    }

    fn data_applied(&self, source: &str) {
        self.data_applied_ids(source, &[]);
    }

    fn data_applied_ids(&self, source: &str, ids: &[String]) {
        use tauri::Emitter;
        if let Some(app) = self.app.read().as_ref() {
            let _ = app.emit(
                "sync-data-applied",
                SyncDataApplied {
                    source: source.to_string(),
                    conversation_ids: ids.to_vec(),
                },
            );
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════
// SyncManager
// ═══════════════════════════════════════════════════════════════════════

/// 构造 `SyncManager` 需要的东西（都来自 `AppState`）。
pub struct SyncWiring {
    pub config_dir: PathBuf,
    pub stores: SourceStores,
    pub ssh_manager: SshManager,
    pub data_changes: DataChangeBus,
    /// 启动加载时碰到损坏、被迫改用默认值的配置。
    pub load_failures: Vec<DataSourceId>,
}

struct Inner {
    tx: mpsc::UnboundedSender<Cmd>,
    rx: Mutex<Option<mpsc::UnboundedReceiver<Cmd>>>,
    engine: Mutex<Option<SyncEngine>>,
    view: Arc<SharedView>,
    deps: Arc<SyncDeps>,
    bus: DataChangeBus,
    events: Option<Arc<TauriEvents>>,
}

#[derive(Clone)]
pub struct SyncManager {
    inner: Arc<Inner>,
}

impl SyncManager {
    /// 生产构造：系统密钥链 + 真实存储后端 + Tauri 事件。不起任何任务，等 [`Self::start`]。
    pub fn new(wiring: SyncWiring) -> Self {
        let secrets: Arc<dyn SyncSecretStore> = Arc::new(KeychainSecrets);
        let adapters = build_adapters(&wiring.stores, secrets.clone());
        let events = Arc::new(TauriEvents::default());
        let deps = Arc::new(SyncDeps {
            config_dir: wiring.config_dir,
            adapters,
            settings: wiring.stores.settings.clone(),
            connections: wiring.stores.connections.clone(),
            known_hosts: wiring.stores.known_hosts.clone(),
            secrets,
            backends: Arc::new(ProductionBackends::new(
                wiring.ssh_manager,
                wiring.stores.connections.clone(),
            )),
            events: events.clone(),
            now_ms: Arc::new(wall_clock_ms),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            platform: Platform::current(),
            default_device_name: default_device_name(),
            load_failures: wiring.load_failures,
            stream_drivers: Vec::new(),
        });
        Self::with_deps(deps, wiring.data_changes, Some(events))
    }

    /// 用现成的依赖构造（测试）。
    pub(crate) fn with_deps(
        deps: Arc<SyncDeps>,
        bus: DataChangeBus,
        events: Option<Arc<TauriEvents>>,
    ) -> Self {
        let files = LedgerFiles::new(&deps.config_dir);
        let view = Arc::new(SharedView::new(HistoryStore::load(files.history_file())));
        Self::with_deps_and_view(deps, bus, events, view)
    }

    /// 同上，并指定共享视图（测试里想让 manager 与另一个引擎共用同一份同步记录时用）。
    pub(crate) fn with_deps_and_view(
        deps: Arc<SyncDeps>,
        bus: DataChangeBus,
        events: Option<Arc<TauriEvents>>,
        view: Arc<SharedView>,
    ) -> Self {
        let engine = SyncEngine::new(deps.clone(), view.clone());
        let (tx, rx) = mpsc::unbounded_channel();
        SyncManager {
            inner: Arc::new(Inner {
                tx,
                rx: Mutex::new(Some(rx)),
                engine: Mutex::new(Some(engine)),
                view,
                deps,
                bus,
                events,
            }),
        }
    }

    /// 在 `setup` 里调用：装上 `AppHandle`、清理旧版残留、起 actor。重复调用无效。
    pub fn start(&self, app: tauri::AppHandle) {
        if let Some(events) = &self.inner.events {
            events.attach(app);
        }
        let Some(actor) = self.take_actor(Timing::default()) else {
            return;
        };
        let config_dir = self.inner.deps.config_dir.clone();
        let secrets = self.inner.deps.secrets.clone();
        tauri::async_runtime::spawn(async move {
            // 旧版同步残留：不管开没开同步每次启动都清（几个 remove_file + 四次密钥链删除）
            let _ = tokio::task::spawn_blocking(move || {
                cleanup_legacy_sync(&config_dir, secrets.as_ref())
            })
            .await;
        });
        tauri::async_runtime::spawn(actor);
    }

    /// 取出 actor 的运行体（只能取一次）。
    pub(crate) fn take_actor(
        &self,
        timing: Timing,
    ) -> Option<impl std::future::Future<Output = ()> + Send + 'static> {
        let engine = self.inner.engine.lock().take()?;
        let rx = self.inner.rx.lock().take()?;
        let changes = self.inner.bus.subscribe();
        Some(actor_loop(engine, rx, changes, timing))
    }

    // ── 读（不等引擎） ──

    pub fn status(&self) -> SyncStatus {
        self.inner.view.status.read().clone()
    }

    pub fn list_devices(&self) -> Vec<SyncDevice> {
        self.inner.view.devices.read().clone()
    }

    pub fn list_history(&self, limit: usize) -> Vec<SyncHistoryEntry> {
        self.inner.view.history.lock().list(limit)
    }

    pub fn get_recovery_key(&self) -> Result<String, AppError> {
        if !self.status().enabled {
            return Err(AppError::Other("还没有开启同步。".into()));
        }
        let rk = self
            .inner
            .deps
            .secrets
            .get(&SecretSlot::SyncRecoveryKey)?
            .map(Zeroizing::new)
            .ok_or_else(|| AppError::Other("本机没有保存恢复密钥。".into()))?;
        Ok(RecoveryKey::parse(&rk)?.display().to_string())
    }

    pub async fn get_sync_code(&self) -> Result<String, AppError> {
        let deps = &self.inner.deps;
        let Some(storage) = self.inner.view.storage.read().clone() else {
            return Err(AppError::Other("还没有开启同步。".into()));
        };
        let rk = deps
            .secrets
            .get(&SecretSlot::SyncRecoveryKey)?
            .map(Zeroizing::new)
            .ok_or_else(|| AppError::Other("本机没有保存恢复密钥。".into()))?;
        let storage_secret = match storage {
            StorageConfig::WebDav { .. } => deps
                .secrets
                .get(&SecretSlot::SyncStoragePassword)?
                .map(Zeroizing::new),
            StorageConfig::Sftp { .. } => None,
        };
        let code = build_sync_code(
            deps,
            &storage,
            storage_secret.as_deref().map(|s| s.as_str()),
            &rk,
        )
        .await?;
        Ok(code.to_string())
    }

    /// 连通性 + 权限自检。不经 actor：开启向导里「测试连接」不该排在一轮同步后面。
    pub async fn test_storage(
        &self,
        storage: StorageConfig,
        secret: Option<String>,
    ) -> Result<(), AppError> {
        let deps = &self.inner.deps;
        let secret = secret.map(Zeroizing::new).filter(|s| !s.is_empty());
        let secret = match secret {
            Some(s) => Some(s),
            // 已开启同一份 WebDAV 存储时用已保存的密码（设置页里不会再要用户输一遍）
            None if self.inner.view.storage.read().as_ref() == Some(&storage) => deps
                .secrets
                .get(&SecretSlot::SyncStoragePassword)?
                .map(Zeroizing::new),
            None => None,
        };
        let backend = deps
            .backends
            .build(&storage, secret.as_deref().map(|s| s.as_str()))
            .map_err(AppError::from)?;
        let result = backend.probe().await.map_err(AppError::from);
        backend.close().await;
        result
    }

    // ── 写（经 actor） ──

    async fn request<R>(&self, make: impl FnOnce(Reply<R>) -> Cmd) -> Result<R, AppError> {
        let (tx, rx) = oneshot::channel();
        self.inner
            .tx
            .send(make(tx))
            .map_err(|_| AppError::Other("同步服务没有在运行。".into()))?;
        rx.await
            .map_err(|_| AppError::Other("同步服务已经停止。".into()))?
    }

    /// 立即同步一次（前端窗口获得焦点 / 手机回到前台 / 用户点按钮都走这里）。
    /// 没开同步时什么都不做；**第一次调用**同时解除启动后的「等前端」闸门。
    pub async fn sync_now(&self) -> Result<(), AppError> {
        self.request(Cmd::SyncNow).await
    }

    pub async fn create(
        &self,
        storage: StorageConfig,
        secret: Option<String>,
    ) -> Result<SyncCreateResult, AppError> {
        let secret = secret.map(Zeroizing::new);
        self.request(|reply| Cmd::Create {
            storage,
            secret,
            reply,
        })
        .await
    }

    pub async fn join_code(&self, code: String) -> Result<(), AppError> {
        let spec = JoinSpec::Code(Zeroizing::new(code));
        self.request(|reply| Cmd::Join { spec, reply }).await
    }

    pub async fn join_manual(
        &self,
        storage: StorageConfig,
        secret: Option<String>,
        recovery_key: String,
    ) -> Result<(), AppError> {
        let spec = JoinSpec::Manual {
            storage,
            secret: secret.map(Zeroizing::new),
            recovery_key: Zeroizing::new(recovery_key),
        };
        self.request(|reply| Cmd::Join { spec, reply }).await
    }

    pub async fn set_device_name(&self, name: String) -> Result<(), AppError> {
        self.request(|reply| Cmd::SetDeviceName { name, reply })
            .await
    }

    pub async fn confirm_held(&self, accept: bool) -> Result<(), AppError> {
        self.request(|reply| Cmd::ConfirmHeld { accept, reply })
            .await
    }

    /// 打开 / 关闭某一档（`"conversation"` / `"secret"`）。
    pub async fn set_tier(&self, tier: String, enabled: bool) -> Result<(), AppError> {
        self.request(|reply| Cmd::SetTier {
            tier,
            enabled,
            reply,
        })
        .await
    }

    /// 某一档的规模估算。**只有数量与名称，绝无值。**
    ///
    /// T0 只给出结构（对话数与图片数先按 0、机密分组为空）：真正的统计要等 T2 / T6
    /// 把对话库与密钥链枚举接进来。前端在此之前显示「暂不可用」而不是瞎猜一个数字。
    pub fn tier_estimate(&self, tier: String) -> Result<TierEstimate, AppError> {
        if !self.status().enabled {
            return Err(AppError::Other("还没有开启同步。".into()));
        }
        if tier == "config" {
            return Ok(TierEstimate {
                tier,
                ..Default::default()
            });
        }
        if tier != "conversation" && tier != "secret" {
            return Err(AppError::Other(format!("未知的同步档位：{tier}")));
        }
        Ok(TierEstimate {
            tier,
            conversations: 0,
            images: 0,
            total_bytes: 0,
            secret_groups: Vec::<SecretGroupEstimate>::new(),
        })
    }

    pub async fn disable(&self, wipe_remote: bool) -> Result<(), AppError> {
        self.request(|reply| Cmd::Disable { wipe_remote, reply })
            .await
    }

    /// 撤销一条同步记录：把该处改回旧值。**走一次本机写入**——成功落盘后经总线广播，同步引擎
    /// 照常把它捕获成一条新的本机改动再同步给其它设备，没有任何特殊通道。
    pub async fn undo(&self, entry_id: &str) -> Result<(), AppError> {
        let deps = &self.inner.deps;
        let record = self
            .inner
            .view
            .history
            .lock()
            .get(entry_id)
            .cloned()
            .ok_or_else(|| AppError::Other("找不到这条同步记录（可能已经被清理）。".into()))?;
        if record.undone {
            return Err(AppError::Other("这条改动已经撤销过了。".into()));
        }
        let Some(action) = record.undo.clone() else {
            return Err(AppError::Other("这条记录无法撤销。".into()));
        };
        let adapter = deps
            .adapters
            .iter()
            .find(|a| a.key() == record.source)
            .cloned()
            .ok_or_else(|| AppError::Other("这条记录对应的数据已不再同步。".into()))?;
        let platform = deps.platform;
        let update = adapter
            .update(Box::new(move |current: &Value| {
                let mut doc = current.clone();
                let changed = apply_undo(&mut doc, &action, platform)?;
                Ok(changed.then_some(doc))
            }))
            .await?;
        if update.committed {
            adapter.after_apply(&update.before, &update.json).await;
            deps.events.data_applied(adapter.key());
        }
        self.inner.view.history.lock().mark_undone(entry_id);
        Ok(())
    }
}

/// 对文档 JSON 执行撤销。返回文档是否真的变了。
fn apply_undo(doc: &mut Value, action: &UndoAction, platform: Platform) -> Result<bool, AppError> {
    fn own_path(path: &[Seg], platform: Platform) -> Result<Vec<Seg>, AppError> {
        match split_platform_prefix(path, platform) {
            (PrefixKind::Other, _) => Err(AppError::Other(
                "这条改动属于另一类设备（桌面 / 手机）的设置，无法在这台设备上撤销。".into(),
            )),
            (_, rest) => Ok(rest.to_vec()),
        }
    }
    match action {
        UndoAction::Leaf { path, old } => {
            let p = own_path(path, platform)?;
            Ok(match old {
                Some(v) => {
                    if docedit::get_leaf(doc, &p) == Some(v) {
                        false
                    } else {
                        docedit::set_leaf(doc, &p, v.clone())
                    }
                }
                None => docedit::remove_leaf(doc, &p),
            })
        }
        UndoAction::RemoveElement { path } => {
            Ok(docedit::remove_element(doc, &own_path(path, platform)?))
        }
        UndoAction::RestoreElement { path, element } => Ok(docedit::restore_element(
            doc,
            &own_path(path, platform)?,
            element.clone(),
        )),
    }
}

/// 旧版同步遗留：文件 + 密钥链条目。
pub(crate) fn cleanup_legacy_sync(config_dir: &std::path::Path, secrets: &dyn SyncSecretStore) {
    let removed = crate::data::legacy::cleanup_legacy_sync_files(config_dir);
    if !removed.is_empty() {
        log::info!("已清理旧版同步遗留文件: {}", removed.join("、"));
    }
    for slot in SecretSlot::legacy_sync_slots() {
        if let Err(e) = secrets.delete(&slot) {
            log::warn!("清理旧版同步遗留的{}失败: {}", slot.describe(), e);
        }
    }
}

/// 默认的设备名：主机名 / 机型。取不到就给一个通用名——用户可以随时改。
pub fn default_device_name() -> String {
    fn clean(s: String) -> Option<String> {
        let s = s.trim().to_string();
        (!s.is_empty()).then(|| s.chars().take(64).collect())
    }
    #[cfg(target_os = "android")]
    {
        let model = std::process::Command::new("getprop")
            .arg("ro.product.model")
            .output()
            .ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .and_then(clean);
        model.unwrap_or_else(|| "我的手机".to_string())
    }
    #[cfg(not(target_os = "android"))]
    {
        std::env::var("COMPUTERNAME")
            .ok()
            .and_then(clean)
            .or_else(|| std::env::var("HOSTNAME").ok().and_then(clean))
            .or_else(|| {
                std::process::Command::new("hostname")
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .and_then(clean)
            })
            .unwrap_or_else(|| "我的电脑".to_string())
    }
}

// ═══════════════════════════════════════════════════════════════════════
// actor
// ═══════════════════════════════════════════════════════════════════════

async fn actor_loop(
    mut engine: SyncEngine,
    mut rx: mpsc::UnboundedReceiver<Cmd>,
    mut changes: broadcast::Receiver<DataChange>,
    timing: Timing,
) {
    let mut sched = Scheduler::new(timing, Instant::now());
    let mut changes_open = true;
    loop {
        let wake = if engine.enabled() {
            sched.next_wake()
        } else {
            None
        };
        tokio::select! {
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                handle_cmd(&mut engine, &mut sched, cmd).await;
            }
            change = changes.recv(), if changes_open => {
                match change {
                    Ok(c) => {
                        if c.source.sync_trigger() && engine.enabled() {
                            sched.on_local_change(Instant::now());
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // 漏了几条：不知道是哪份变了，当成都变了
                        if engine.enabled() {
                            sched.on_local_change(Instant::now());
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => changes_open = false,
                }
            }
            _ = sleep_until_opt(wake), if wake.is_some() => {
                if let Some(kind) = sched.take_due(Instant::now()) {
                    let result = engine.run_round(kind).await;
                    if let Err(e) = &result {
                        log::warn!("同步失败（稍后退避重试）: {}", plain_error(e));
                    }
                    sched.after_round(kind, result.is_ok(), Instant::now());
                }
            }
        }
    }
}

async fn sleep_until_opt(t: Option<Instant>) {
    match t {
        Some(t) => tokio::time::sleep_until(t).await,
        None => std::future::pending::<()>().await,
    }
}

async fn handle_cmd(engine: &mut SyncEngine, sched: &mut Scheduler, cmd: Cmd) {
    match cmd {
        Cmd::SyncNow(reply) => {
            sched.mark_ready();
            let result = if engine.enabled() {
                let r = engine.run_round(RoundKind::Full).await;
                sched.after_round(RoundKind::Full, r.is_ok(), Instant::now());
                r
            } else {
                Ok(())
            };
            let _ = reply.send(result);
        }
        Cmd::Create {
            storage,
            secret,
            reply,
        } => {
            let result = engine.create(storage, secret).await;
            sched.reset(engine.enabled(), Instant::now());
            let _ = reply.send(result);
        }
        Cmd::Join { spec, reply } => {
            let result = engine.join(spec).await;
            sched.reset(engine.enabled(), Instant::now());
            if result.is_ok() {
                // 本机独有的数据（ZERO 并入的）在队列里，马上传上去；失败了由退避重试，不影响「加入成功」
                let r = engine.run_round(RoundKind::Full).await;
                sched.after_round(RoundKind::Full, r.is_ok(), Instant::now());
            }
            let _ = reply.send(result);
        }
        Cmd::SetDeviceName { name, reply } => {
            let _ = reply.send(engine.set_device_name(&name));
        }
        Cmd::ConfirmHeld { accept, reply } => {
            let result = engine.confirm_held(accept).await;
            sched.after_round(RoundKind::Full, result.is_ok(), Instant::now());
            let _ = reply.send(result);
        }
        Cmd::SetTier {
            tier,
            enabled,
            reply,
        } => {
            let result = engine.enable_tier(&tier, enabled).await;
            // 打开某一档会顺带跑一轮完整同步：按「刚跑完一轮」记时（成功重排周期、失败退避）。
            // 关闭不跑同步，不必动调度器。
            if enabled {
                sched.after_round(RoundKind::Full, result.is_ok(), Instant::now());
            }
            let _ = reply.send(result);
        }
        Cmd::Disable { wipe_remote, reply } => {
            let result = engine.disable(wipe_remote).await;
            sched.reset(engine.enabled(), Instant::now());
            let _ = reply.send(result);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn timing() -> Timing {
        Timing {
            gate: Duration::from_secs(15),
            debounce: Duration::from_secs(2),
            debounce_max: Duration::from_secs(10),
            periodic: Duration::from_secs(60),
            backoff_min: Duration::from_secs(5),
            backoff_max: Duration::from_secs(40),
        }
    }

    fn at(base: Instant, secs: u64) -> Instant {
        base + Duration::from_secs(secs)
    }

    #[test]
    fn nothing_runs_before_the_frontend_arrives_except_the_gate_fallback() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(timing(), t0);
        // 启动后本机改了东西：也不能跑（落地事件会丢）
        s.on_local_change(t0);
        assert_eq!(s.next_wake(), Some(at(t0, 15)), "只等兜底计时");
        assert_eq!(s.take_due(at(t0, 5)), None);
        assert_eq!(s.take_due(at(t0, 14)), None);
        // 兜底到点：自己上，跑完整一轮
        assert_eq!(s.take_due(at(t0, 15)), Some(RoundKind::Full));
        assert!(s.is_ready());
    }

    #[test]
    fn frontend_arrival_opens_the_gate_and_a_full_round_follows_every_period() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(timing(), t0);
        s.mark_ready();
        assert_eq!(
            s.next_wake(),
            None,
            "ready 之后还没排过完整一轮：由调用方的 sync_now 先跑"
        );
        s.after_round(RoundKind::Full, true, at(t0, 1));
        assert_eq!(s.next_wake(), Some(at(t0, 61)));
        assert_eq!(s.take_due(at(t0, 30)), None);
        assert_eq!(s.take_due(at(t0, 61)), Some(RoundKind::Full));
    }

    #[test]
    fn local_changes_debounce_but_cannot_be_postponed_forever() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(timing(), t0);
        s.mark_ready();
        s.after_round(RoundKind::Full, true, t0);

        s.on_local_change(at(t0, 10));
        assert_eq!(s.next_wake(), Some(at(t0, 12)), "2 秒防抖");
        // 又改了：往后推
        s.on_local_change(at(t0, 11));
        assert_eq!(s.next_wake(), Some(at(t0, 13)));
        // 一直在改（拖滑块）：从第一次改动起最多推迟 10 秒
        for secs in 12..=25 {
            s.on_local_change(at(t0, secs));
        }
        assert_eq!(s.next_wake(), Some(at(t0, 20)));
        assert_eq!(s.take_due(at(t0, 19)), None);
        assert_eq!(s.take_due(at(t0, 20)), Some(RoundKind::Local));
        assert_eq!(s.take_due(at(t0, 20)), None, "取走后待办清空");
    }

    #[test]
    fn failures_back_off_exponentially_and_success_resets() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(timing(), t0);
        s.mark_ready();

        s.after_round(RoundKind::Full, false, at(t0, 0));
        assert_eq!(s.next_wake(), Some(at(t0, 5)));
        assert_eq!(s.take_due(at(t0, 4)), None);
        assert_eq!(s.take_due(at(t0, 5)), Some(RoundKind::Full));

        s.after_round(RoundKind::Full, false, at(t0, 5));
        assert_eq!(s.next_wake(), Some(at(t0, 15)), "5 → 10 秒");
        s.after_round(RoundKind::Full, false, at(t0, 15));
        assert_eq!(s.next_wake(), Some(at(t0, 35)), "→ 20 秒");
        s.after_round(RoundKind::Full, false, at(t0, 35));
        assert_eq!(s.next_wake(), Some(at(t0, 75)), "→ 40 秒（封顶）");
        s.after_round(RoundKind::Full, false, at(t0, 75));
        assert_eq!(s.next_wake(), Some(at(t0, 115)), "封顶后不再增长");

        // 退避期间本机又改了东西：也要等退避结束
        s.on_local_change(at(t0, 76));
        assert!(s.next_wake().unwrap() >= at(t0, 115));

        s.after_round(RoundKind::Full, true, at(t0, 115));
        assert_eq!(s.next_wake(), Some(at(t0, 175)), "成功：回到 60 秒周期");
        s.after_round(RoundKind::Full, false, at(t0, 120));
        assert_eq!(s.next_wake(), Some(at(t0, 125)), "退避从头开始");
    }

    #[test]
    fn enabling_starts_the_clock_and_disabling_clears_it() {
        let t0 = Instant::now();
        let mut s = Scheduler::new(timing(), t0);
        s.reset(true, at(t0, 100));
        assert!(s.is_ready());
        assert_eq!(s.next_wake(), Some(at(t0, 160)));
        s.on_local_change(at(t0, 101));
        s.reset(false, at(t0, 200));
        assert_eq!(s.next_wake(), None, "停止同步后没有任何计划中的轮次");
    }

    #[test]
    fn undo_actions_edit_the_document() {
        use serde_json::json;
        let k = |s: &str| Seg::key(s);
        let mut doc = json!({"fontSize": 18, "list": [{"id": "a", "n": 1}]});

        // 叶子改回旧值（平台前缀被剥掉）
        let own = if Platform::current() == Platform::Desktop {
            "@desktop"
        } else {
            "@android"
        };
        let changed = apply_undo(
            &mut doc,
            &UndoAction::Leaf {
                path: vec![k(own), k("fontSize")],
                old: Some(json!(14)),
            },
            Platform::current(),
        )
        .unwrap();
        assert!(changed);
        assert_eq!(doc["fontSize"], json!(14));
        // 已经是旧值：不算改动
        assert!(!apply_undo(
            &mut doc,
            &UndoAction::Leaf {
                path: vec![k(own), k("fontSize")],
                old: Some(json!(14))
            },
            Platform::current(),
        )
        .unwrap());
        // 本来没有 → 删掉
        assert!(apply_undo(
            &mut doc,
            &UndoAction::Leaf {
                path: vec![k("fontSize")],
                old: None
            },
            Platform::current(),
        )
        .unwrap());
        assert!(doc.get("fontSize").is_none());

        // 元素：删 / 放回
        assert!(apply_undo(
            &mut doc,
            &UndoAction::RemoveElement {
                path: vec![k("list"), Seg::id("a")]
            },
            Platform::current()
        )
        .unwrap());
        assert_eq!(doc["list"], json!([]));
        assert!(apply_undo(
            &mut doc,
            &UndoAction::RestoreElement {
                path: vec![k("list"), Seg::id("a")],
                element: json!({"id": "a", "n": 1})
            },
            Platform::current(),
        )
        .unwrap());
        assert_eq!(doc["list"], json!([{"id": "a", "n": 1}]));

        // 另一类设备的叶子：拒绝
        let other = if Platform::current() == Platform::Desktop {
            "@android"
        } else {
            "@desktop"
        };
        assert!(apply_undo(
            &mut doc,
            &UndoAction::Leaf {
                path: vec![k(other), k("fontSize")],
                old: Some(json!(1))
            },
            Platform::current(),
        )
        .is_err());
    }
}
