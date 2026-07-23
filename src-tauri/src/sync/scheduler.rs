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

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// 同步状态变更事件 payload
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStateEvent {
    pub state: SyncState,
    pub pending_count: usize,
    pub error: Option<String>,
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
    /// Tauri AppHandle（用于 emit 事件给前端），在 setup 阶段注入
    app_handle: RwLock<Option<AppHandle>>,
}

impl SyncScheduler {
    pub fn new(engine: Arc<SyncEngine>, client: Arc<SyncClient>) -> Self {
        Self {
            engine,
            client,
            api_key: RwLock::new(None),
            state: RwLock::new(SyncState::NotConfigured),
            last_error: RwLock::new(None),
            operation_lock: Mutex::new(()),
            push_notify: tokio::sync::Notify::new(),
            ws_pull_notify: tokio::sync::Notify::new(),
            started: parking_lot::Mutex::new(false),
            ws_generation: AtomicU64::new(0),
            ws_stop: AtomicBool::new(true),
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
        self.update_state_and_emit(new_state, None);
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

    /// 触发 push（防抖 700ms）。
    ///
    /// 由配置变更触发点调用。连续多次调用只会在最后一次后 700ms 执行一次。
    pub fn schedule_push(&self) {
        self.push_notify.notify_one();
    }

    /// 立即触发 pull（如 App 启动、收到 WebSocket 通知）。
    pub async fn trigger_pull_now(&self) {
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
            self.do_pull().await;
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

        // 1) pull first（已持锁，勿再调 do_pull）
        self.update_state_and_emit(SyncState::Pulling, None);
        match self.engine.pull_with_accessor(&self.client, &api_key).await {
            Ok(_) => {
                if self.engine.has_pending_conflicts() {
                    self.update_state_and_emit(SyncState::Idle, None);
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
        self.update_state_and_emit(SyncState::Pushing, None);
        let result = self.engine.push_with_accessor(&self.client, &api_key).await;

        match result {
            Ok(_) => {
                let pending = self.engine.pending_count();
                self.update_state_and_emit(SyncState::Idle, None);
                tracing_log_pending(pending);
            }
            Err(e) => {
                let msg = e.to_string();
                self.update_state_and_emit(SyncState::Error, Some(msg));
            }
        }
    }

    /// 执行 pull 操作。
    async fn do_pull(&self) {
        let _lock = self.operation_lock.lock().await;

        let api_key = {
            let guard = self.api_key.read();
            guard.clone()
        };
        let api_key = match api_key {
            Some(k) => k,
            None => return,
        };

        self.update_state_and_emit(SyncState::Pulling, None);

        let result = self.engine.pull_with_accessor(&self.client, &api_key).await;

        match result {
            Ok(_) => {
                self.update_state_and_emit(SyncState::Idle, None);
                // pull 后检测冲突，emit 事件让前端弹冲突 UI
                if self.engine.has_pending_conflicts() {
                    self.emit_conflicts_detected();
                }
            }
            Err(e) => {
                let msg = e.to_string();
                self.update_state_and_emit(SyncState::Error, Some(msg));
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
    fn update_state_and_emit(&self, new_state: SyncState, error: Option<String>) {
        {
            let mut state = self.state.write();
            *state = new_state;
        }
        {
            let mut err = self.last_error.write();
            *err = error.clone();
        }

        // emit 事件给前端（如果 app_handle 已注入）
        if let Some(ref handle) = *self.app_handle.read() {
            let payload = SyncStateEvent {
                state: new_state,
                pending_count: self.engine.pending_count(),
                error,
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

    // 注意：SyncScheduler 的完整测试需要 mock client，这里只测状态枚举
}
