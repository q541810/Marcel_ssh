//! 同步调度器：防抖、启动拉取、轮询、WebSocket 变更通知。
//!
//! 触发时机：
//! - push：配置变更后 700ms 防抖（用户连续改多个设置时，只同步最终结果）
//! - pull：App 启动时立即拉取 + WS `changes_available` + 每 15 秒兜底轮询
//! - 对话：对话前 pull、对话后 push、空闲 3 分钟兜底
//!
//! 状态机：
//!   Idle → Pushing → Idle
//!   Idle → Pulling → Idle
//!   任何状态 → Error → Idle（下次触发重试）
//!
//! 并发控制：同一时间只允许一个 push 或 pull 操作（用 Mutex 串行化）。

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::time::{interval, sleep};

use crate::sync::client::SyncClient;
use crate::sync::engine::SyncEngine;
use crate::sync::ws_client;

/// push 防抖延迟（700ms）
const PUSH_DEBOUNCE: Duration = Duration::from_millis(700);

/// 轮询间隔（15 秒，WS 断线兜底）
const POLL_INTERVAL: Duration = Duration::from_secs(15);

/// WS 收到 changes_available 后防抖再 pull（合并连推）
const WS_PULL_DEBOUNCE: Duration = Duration::from_millis(200);

/// WS 断线重连：初始 / 上限
const WS_RECONNECT_BASE: Duration = Duration::from_secs(2);
const WS_RECONNECT_MAX: Duration = Duration::from_secs(60);

/// 对话空闲兜底间隔（3 分钟，Phase 5 对话触发点集成时使用）
#[allow(dead_code)]
const CONVERSATION_IDLE_INTERVAL: Duration = Duration::from_secs(180);

/// 同步状态（用于 UI 展示）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncState {
    /// 空闲
    Idle,
    /// 推送中
    Pushing,
    /// 拉取中
    Pulling,
    /// 错误
    Error,
    /// 未配置同步
    NotConfigured,
}

impl Default for SyncState {
    fn default() -> Self {
        SyncState::NotConfigured
    }
}

/// pull 进度（pulling 状态时非 None；push 不产生进度）
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProgress {
    /// 本次 pull 待处理的 item 总数（profile 过滤后）
    pub total: usize,
    /// 已处理 item 数
    pub done: usize,
}

/// 同步状态变更事件 payload
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateEvent {
    pub state: SyncState,
    pub pending_count: usize,
    pub error: Option<String>,
    /// pull 进度（非 pulling 状态为 None）
    pub progress: Option<SyncProgress>,
}

/// 冲突检测事件 payload（pull 后发现有冲突时 emit）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncConflictsEvent {
    /// 所有待解决的冲突（含 base/ours/theirs 明文 JSON）
    pub conflicts: Vec<crate::sync::engine::PendingConflict>,
    /// 冲突数量（前端可据此判断是否弹窗）
    pub count: usize,
}

/// 同步调度器
pub struct SyncScheduler {
    /// 引擎
    engine: Arc<SyncEngine>,
    /// 客户端
    client: Arc<SyncClient>,
    /// API Key
    api_key: RwLock<Option<String>>,
    /// 当前状态
    state: RwLock<SyncState>,
    /// 最近错误（用于事件 payload）
    last_error: RwLock<Option<String>>,
    /// 最近一次 pull 进度（供 sync_get_summary 读取，打开同步页时展示）
    last_progress: RwLock<Option<SyncProgress>>,
    /// 操作锁（push/pull 串行化）
    operation_lock: Mutex<()>,
    /// push 防抖通知
    push_notify: tokio::sync::Notify,
    /// WS 侧请求 pull（防抖合并）
    ws_pull_notify: tokio::sync::Notify,
    /// 是否已启动 push/poll/ws 循环
    started: parking_lot::Mutex<bool>,
    /// 关闭同步 / 换密钥时递增，令 WS 会话退出并重连
    ws_generation: AtomicU64,
    /// 明确要求 WS 停止（disable / 无 api_key）
    ws_stop: AtomicBool,
    /// pull 是否在执行（防排队风暴：执行期间的其他 pull 触发直接跳过）
    pull_in_flight: Arc<AtomicBool>,
    /// 连续 pull 失败次数（退避用，成功清零）
    consecutive_failures: AtomicU32,
    /// 自动 pull（轮询 / WS 通知）的最早允许时间（unix 毫秒），手动拉取不受限
    next_auto_pull_at_ms: AtomicU64,
    /// Tauri AppHandle（用于 emit 事件给前端），在 setup 阶段注入
    app_handle: RwLock<Option<AppHandle>>,
}

/// RAII：pull 执行标志（panic / future 取消时 drop 复位，不会永久锁死）
struct InFlightGuard(Arc<AtomicBool>);

impl Drop for InFlightGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl SyncScheduler {
    pub fn new(engine: Arc<SyncEngine>, client: Arc<SyncClient>) -> Self {
        Self {
            engine,
            client,
            api_key: RwLock::new(None),
            state: RwLock::new(SyncState::NotConfigured),
            last_error: RwLock::new(None),
            last_progress: RwLock::new(None),
            operation_lock: Mutex::new(()),
            push_notify: tokio::sync::Notify::new(),
            ws_pull_notify: tokio::sync::Notify::new(),
            started: parking_lot::Mutex::new(false),
            ws_generation: AtomicU64::new(0),
            ws_stop: AtomicBool::new(true),
            pull_in_flight: Arc::new(AtomicBool::new(false)),
            consecutive_failures: AtomicU32::new(0),
            next_auto_pull_at_ms: AtomicU64::new(0),
            app_handle: RwLock::new(None),
        }
    }

    /// 注入 Tauri AppHandle，用于 emit sync-state-changed 事件。
    /// 在 setup 阶段调用。
    pub fn set_app_handle(&self, handle: AppHandle) {
        *self.app_handle.write() = Some(handle);
    }

    /// 设置 API Key（配置同步后调用）。
    pub fn set_api_key(&self, api_key: Option<String>) {
        let is_some = api_key.is_some();
        {
            let mut guard = self.api_key.write();
            *guard = api_key;
        }

        if is_some {
            self.ws_stop.store(false, Ordering::SeqCst);
            // 换密钥 / 重新配对：踢掉旧 WS，重连循环会用新 key
            self.ws_generation.fetch_add(1, Ordering::SeqCst);
            // 新凭证即新起点：重置失败退避，配对后的首次 pull 不被旧失败卡住
            self.consecutive_failures.store(0, Ordering::SeqCst);
            self.next_auto_pull_at_ms.store(0, Ordering::SeqCst);
        } else {
            self.ws_stop.store(true, Ordering::SeqCst);
            self.ws_generation.fetch_add(1, Ordering::SeqCst);
        }

        let new_state = if is_some {
            SyncState::Idle
        } else {
            SyncState::NotConfigured
        };
        // 状态变化时立即 emit 事件
        self.update_state_and_emit(new_state, None, None);
    }

    /// 配对 / 换服务器后更新客户端 base_url。
    ///
    /// App 启动时若尚未配对，scheduler 内 client 使用占位 URL；
    /// pair 成功后必须调用本方法，否则 push/pull 仍打到 localhost:0。
    pub fn set_server_url(&self, server_url: &str) {
        self.client.set_base_url(server_url);
        // URL 变更后踢 WS，重连到新 host
        self.ws_generation.fetch_add(1, Ordering::SeqCst);
    }

    /// 获取当前状态。
    pub fn state(&self) -> SyncState {
        *self.state.read()
    }

    /// 最近一次同步错误（无错为 None）。
    pub fn last_error(&self) -> Option<String> {
        self.last_error.read().clone()
    }

    /// 最近一次 pull 进度（未 pull / 非 pulling 时为 None）。
    pub fn last_progress(&self) -> Option<SyncProgress> {
        *self.last_progress.read()
    }

    /// 触发 push（防抖 700ms）。
    ///
    /// 由配置变更触发点调用。连续多次调用只会在最后一次后 700ms 执行一次。
    pub fn schedule_push(&self) {
        self.push_notify.notify_one();
    }

    /// 自动触发 pull（App 启动 / 收到 WebSocket 通知 / 轮询）。
    ///
    /// 受失败退避约束：连续失败后按 30→60→120s 抑制自动拉取，
    /// 避免"30 秒超时 + 15 秒重试"的无限循环。手动拉取用 `trigger_pull_manual`。
    pub async fn trigger_pull_now(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        if now < self.next_auto_pull_at_ms.load(Ordering::SeqCst) {
            log::debug!("[sync] 自动 pull 被退避抑制（失败退避中）");
            return;
        }
        self.do_pull().await;
    }

    /// 手动触发 pull（用户显式操作，不受失败退避限制）。
    pub async fn trigger_pull_manual(&self) {
        self.do_pull().await;
    }

    /// 启动调度器（后台任务）。
    ///
    /// 启动后：
    /// - 立即 pull 一次
    /// - push 防抖循环
    /// - 15 秒轮询兜底
    /// - WebSocket：收 changes_available → 防抖 pull
    pub async fn start(self: Arc<Self>) {
        {
            let mut started = self.started.lock();
            if *started {
                return;
            }
            *started = true;
        } // guard 在 await 前 drop

        self.ws_stop.store(false, Ordering::SeqCst);

        // 1. 启动时立即 pull
        self.trigger_pull_now().await;

        // 2. 启动 push 防抖循环
        let self_clone = self.clone();
        tokio::spawn(async move {
            self_clone.push_debounce_loop().await;
        });

        // 3. 启动轮询循环
        let self_clone = self.clone();
        tokio::spawn(async move {
            self_clone.poll_loop().await;
        });

        // 4. WS 变更通知 + 防抖 pull
        let self_clone = self.clone();
        tokio::spawn(async move {
            self_clone.ws_loop().await;
        });
        let self_clone = self.clone();
        tokio::spawn(async move {
            self_clone.ws_pull_debounce_loop().await;
        });
    }

    /// push 防抖循环。
    ///
    /// 等待通知 → 等 700ms → 执行 push（期间收到新通知则重置等待）。
    async fn push_debounce_loop(&self) {
        loop {
            self.push_notify.notified().await;

            // 防抖：等待 700ms，期间收到新通知则重置
            loop {
                tokio::select! {
                    _ = sleep(PUSH_DEBOUNCE) => break,
                    _ = self.push_notify.notified() => continue,
                }
            }

            self.do_push().await;
        }
    }

    /// 轮询循环（15 秒兜底；WS 正常时多数 pull 已由 changes_available 触发）。
    async fn poll_loop(&self) {
        let mut ticker = interval(POLL_INTERVAL);

        loop {
            ticker.tick().await;
            self.trigger_pull_now().await;
            // reset：以「本轮 pull 完成」为起点重新计时。
            // 不 reset 时若 pull 耗时超过 15 秒，下一次 tick 立即到期，
            // 轮询会退化成连续 pull（风暴）。
            ticker.reset();
        }
    }

    /// WS 收 `changes_available` 后的防抖 pull。
    async fn ws_pull_debounce_loop(&self) {
        loop {
            self.ws_pull_notify.notified().await;
            loop {
                tokio::select! {
                    _ = sleep(WS_PULL_DEBOUNCE) => break,
                    _ = self.ws_pull_notify.notified() => continue,
                }
            }
            self.do_pull().await;
        }
    }

    /// 维护到同步服务端的 WebSocket：断线指数退避重连。
    async fn ws_loop(self: Arc<Self>) {
        let mut backoff = WS_RECONNECT_BASE;
        loop {
            if self.ws_stop.load(Ordering::SeqCst) {
                sleep(Duration::from_secs(2)).await;
                continue;
            }

            let api_key = {
                let guard = self.api_key.read();
                guard.clone()
            };
            let api_key = match api_key {
                Some(k) if !k.is_empty() => k,
                _ => {
                    sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            let base_url = self.client.base_url();
            let gen_at_connect = self.ws_generation.load(Ordering::SeqCst);
            let this_notify = self.clone();
            let on_changes = move || {
                this_notify.ws_pull_notify.notify_one();
            };
            let this_stop = self.clone();
            let should_stop = move || {
                this_stop.ws_stop.load(Ordering::SeqCst)
                    || this_stop.ws_generation.load(Ordering::SeqCst) != gen_at_connect
            };

            match ws_client::run_session(&base_url, &api_key, should_stop, on_changes).await {
                Ok(()) => {
                    log::info!("[sync-ws] 会话结束，准备重连");
                    backoff = WS_RECONNECT_BASE;
                }
                Err(e) => {
                    log::warn!("[sync-ws] 会话失败：{}，{}s 后重连", e, backoff.as_secs());
                }
            }

            if self.ws_stop.load(Ordering::SeqCst) {
                sleep(Duration::from_secs(2)).await;
                continue;
            }
            sleep(backoff).await;
            backoff = (backoff * 2).min(WS_RECONNECT_MAX);
        }
    }

    /// 执行 push 操作。
    ///
    /// 顺序：先 pull（合并远端、暴露冲突）再 push。
    /// 避免「本机直接推 → 对端再 pull 才发现冲突 → 双端都弹窗」。
    /// 若 pull 后已有待解决冲突，则中止本次 push，等用户处理。
    async fn do_push(&self) {
        let _lock = self.operation_lock.lock().await;

        let api_key = {
            let guard = self.api_key.read();
            guard.clone()
        };
        let api_key = match api_key {
            Some(k) => k,
            None => return,
        };

        let started = std::time::Instant::now();
        log::debug!("[sync] push 开始（先 pull 合并）");

        // 1) pull first（已持锁，勿再调 do_pull）
        self.update_state_and_emit(SyncState::Pulling, None, None);
        match self
            .engine
            .pull_with_accessor(&self.client, &api_key, None)
            .await
        {
            Ok(_) => {
                if self.engine.has_pending_conflicts() {
                    self.update_state_and_emit(SyncState::Idle, None, None);
                    self.emit_conflicts_detected();
                    log::info!("[sync] push 前 pull 发现冲突，跳过本次 push");
                    return;
                }
            }
            Err(e) => {
                // 网络失败不阻断本地变更上云；日志备查
                log::warn!("[sync] push 前 pull 失败，仍继续 push：{}", e);
            }
        }

        // 2) push
        self.update_state_and_emit(SyncState::Pushing, None, None);
        let result = self.engine.push_with_accessor(&self.client, &api_key).await;

        match result {
            Ok(_) => {
                let pending = self.engine.pending_count();
                log::debug!("[sync] push 完成（耗时 {:?}）", started.elapsed());
                self.update_state_and_emit(SyncState::Idle, None, None);
                tracing_log_pending(pending);
            }
            Err(e) => {
                let msg = e.to_string();
                log::warn!("[sync] push 失败（耗时 {:?}）：{}", started.elapsed(), e);
                self.update_state_and_emit(SyncState::Error, Some(msg), None);
            }
        }
    }

    /// 执行 pull 操作。
    async fn do_pull(&self) {
        // PullGuard：已有 pull 在执行（或排队等待）时直接跳过，防止排队 pull 风暴。
        // guard 先于 operation_lock 声明：drop 顺序逆序 → 锁先释放、标志后复位，
        // 下一个 pull 在无锁竞争时启动。
        if self.pull_in_flight.swap(true, Ordering::SeqCst) {
            return;
        }
        let _guard = InFlightGuard(self.pull_in_flight.clone());
        let _lock = self.operation_lock.lock().await;

        let api_key = {
            let guard = self.api_key.read();
            guard.clone()
        };
        let api_key = match api_key {
            Some(k) => k,
            None => return,
        };

        let started = std::time::Instant::now();
        log::debug!("[sync] pull 开始");
        self.update_state_and_emit(SyncState::Pulling, None, None);

        // 进度回调：1s 节流 + done == total 强制末次 + 首个立即发
        let last_emit = std::sync::Arc::new(parking_lot::Mutex::new(None::<std::time::Instant>));
        let progress_cb = |done: usize, total: usize| {
            let now = std::time::Instant::now();
            let should_emit = {
                let mut last = last_emit.lock();
                match *last {
                    None => {
                        *last = Some(now);
                        true
                    }
                    Some(prev) => {
                        let elapsed = now.duration_since(prev);
                        if elapsed >= Duration::from_secs(1) || done >= total {
                            *last = Some(now);
                            true
                        } else {
                            false
                        }
                    }
                }
            };
            if should_emit {
                self.update_state_and_emit(
                    SyncState::Pulling,
                    None,
                    Some(SyncProgress { total, done }),
                );
            }
        };

        let result = self
            .engine
            .pull_with_accessor(&self.client, &api_key, Some(&progress_cb))
            .await;

        match result {
            Ok(_) => {
                self.consecutive_failures.store(0, Ordering::SeqCst);
                self.next_auto_pull_at_ms.store(0, Ordering::SeqCst);
                log::debug!("[sync] pull 完成（耗时 {:?}）", started.elapsed());
                self.update_state_and_emit(SyncState::Idle, None, None);
                // pull 后检测冲突，emit 事件让前端弹冲突 UI
                if self.engine.has_pending_conflicts() {
                    self.emit_conflicts_detected();
                }
            }
            Err(e) => {
                let msg = e.to_string();
                // 失败退避：30→60→120s（只抑制自动触发，手动拉取不受限）
                let failures = self
                    .consecutive_failures
                    .fetch_add(1, Ordering::SeqCst)
                    .saturating_add(1);
                let backoff_secs = 15u64 * 2u64.pow(failures.min(3));
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                self.next_auto_pull_at_ms
                    .store(now + backoff_secs * 1000, Ordering::SeqCst);
                log::warn!(
                    "[sync] pull 失败（耗时 {:?}，连续失败 {} 次，自动重试退避 {}s）：{}",
                    started.elapsed(),
                    failures,
                    backoff_secs,
                    msg
                );
                self.update_state_and_emit(SyncState::Error, Some(msg), None);
            }
        }
    }

    /// 通知前端有待解决的冲突。
    fn emit_conflicts_detected(&self) {
        if let Some(ref handle) = *self.app_handle.read() {
            let conflicts = self.engine.pending_conflicts();
            let count = conflicts.len();
            let payload = SyncConflictsEvent { conflicts, count };
            let _ = handle.emit("sync-conflicts-detected", &payload);
        }
    }

    /// 更新状态并发送 sync-state-changed 事件。
    ///
    /// `progress`：pull 进度；同步写入 last_progress（供 sync_get_summary 读取），
    /// 非 pulling 状态传 None 会清空。
    fn update_state_and_emit(
        &self,
        new_state: SyncState,
        error: Option<String>,
        progress: Option<SyncProgress>,
    ) {
        {
            let mut state = self.state.write();
            *state = new_state;
        }
        {
            let mut err = self.last_error.write();
            *err = error.clone();
        }
        {
            let mut p = self.last_progress.write();
            *p = progress;
        }

        // emit 事件给前端（如果 app_handle 已注入）
        if let Some(ref handle) = *self.app_handle.read() {
            let payload = SyncStateEvent {
                state: new_state,
                pending_count: self.engine.pending_count(),
                error,
                progress,
            };
            let _ = handle.emit("sync-state-changed", &payload);
        }
    }
}

/// 简单日志
fn tracing_log_pending(count: usize) {
    if count > 0 {
        log::debug!("同步后仍有 {} 个 pending changes", count);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::profile::SyncProfile;

    #[test]
    fn test_sync_state_default() {
        assert_eq!(SyncState::default(), SyncState::NotConfigured);
    }

    #[test]
    fn test_sync_state_serde() {
        let json = serde_json::to_string(&SyncState::Pushing).unwrap();
        assert_eq!(json, "\"pushing\"");

        let state: SyncState = serde_json::from_str("\"pulling\"").unwrap();
        assert_eq!(state, SyncState::Pulling);
    }

    #[test]
    fn test_in_flight_guard_resets_on_drop() {
        // PullGuard 语义：drop（正常返回 / panic 展开 / future 取消）后标志复位，
        // 不会永久锁死后续 pull。
        let flag = Arc::new(AtomicBool::new(true));
        {
            let _guard = InFlightGuard(flag.clone());
            assert!(flag.load(Ordering::SeqCst));
        }
        assert!(!flag.load(Ordering::SeqCst));
    }

    #[test]
    fn test_in_flight_guard_swap_excludes_concurrent() {
        // swap 语义：已有 pull 在执行时，后来的触发直接返回 true（跳过）。
        let flag = Arc::new(AtomicBool::new(false));
        assert!(!flag.swap(true, Ordering::SeqCst)); // 第一个进入
        assert!(flag.swap(true, Ordering::SeqCst)); // 第二个跳过
        let _guard = InFlightGuard(flag.clone());
        drop(_guard);
        assert!(!flag.swap(true, Ordering::SeqCst)); // 复位后可再进入
        let _guard = InFlightGuard(flag.clone());
    }

    // 注意：SyncScheduler 的完整测试需要 mock client，这里只测状态枚举与 guard
}
