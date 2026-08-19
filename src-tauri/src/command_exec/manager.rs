//! 命令执行的「协调层」。
//!
//! 对应分层架构中的 Manager 层（终末地语音系统的业务协调模块角色）：
//! 游戏系统只声明「播放一句战斗呐喊」，优先级、冲突解决、资源调度
//! 全部在子系统内闭环；同理，调用方只提交 [`CommandTicket`]（声明
//! 意图），执行记录、取消注册、断连级联取消全部在这里闭环。
//!
//! 职责：
//! 1. **统一入口**：所有命令执行（用户直发 / 系统长任务 / Agent 工具 /
//!    插件）都经 [`CommandExecutionManager::submit`]，获得全局唯一的
//!    `exec_id` 与生命周期记录（最近 100 条，含截断后的展示命令）。
//! 2. **取消注册表**：`task_id -> 取消信号` 集中管理，取代散落在
//!    AppState 上的 `long_exec_cancel_senders`。
//! 3. **断连级联取消**：向 [`SshManager`] 注册断连观察者，会话断开时
//!    自动取消该会话上所有仍在运行的执行（`Cancelled{Disconnected}`），
//!    多会话之间互不影响。
//! 4. **可测性**：执行经 [`ExecTransport`] 抽象注入，单测用 mock transport，
//!    不需要真实 SSH 连接。
//!
//! 安全约定：`ticket.command` 可能含 sudo 密码，绝不进入
//! [`ExecutionRecord`] / [`ExecutionSnapshot`] / 日志——记录里只有
//! 调用方声明的 `display_command`（已截断）。

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use tauri::AppHandle;
use tokio::sync::{watch, Mutex as TokioMutex};

use crate::error::AppError;
use crate::ssh::connection::SshManager;

use super::executor::{timeout_preview, ExecTransport, SshExecTransport};
use super::ticket::{
    truncate_display, CommandSource, CommandTicket, ExecutionSnapshot, ExecutionStatus,
};

/// 保留的最近完成记录条数。
const RECENT_LIMIT: usize = 100;

/// 取消原因。决定 [`SubmitOutcome::Cancelled`] 的语义与调用方映射的错误文案。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CancelReason {
    /// 用户通过 `ssh_exec_long_cancel(task_id)` 主动取消。
    User,
    /// 会话断开，由断连观察者级联取消。
    Disconnected,
}

/// 一次提交的最终结果。调用方据此映射业务事件与错误文案，
/// manager 本身不感知任何前端事件协议。
#[derive(Debug)]
pub enum SubmitOutcome {
    /// 命令正常结束（含非零退出码——与旧语义一致，由调用方从输出判断）。
    Completed { output: String },
    /// 超时，`output` 为已收到的部分输出。
    TimedOut { output: String },
    /// 被取消（用户取消或断连级联）。
    Cancelled { reason: CancelReason },
    /// 执行失败（会话不存在 / 开通道失败 / 断连检测等）。
    Failed { error: AppError },
}

/// 内部执行记录。只保存展示命令（截断），不保存实际命令全文。
pub(crate) struct ExecutionRecord {
    pub exec_id: u64,
    pub session_id: String,
    pub source: CommandSource,
    pub task_id: Option<String>,
    pub display_command: String,
    pub started_at: SystemTime,
    pub status: ExecutionStatus,
}

impl ExecutionRecord {
    fn snapshot(&self) -> ExecutionSnapshot {
        ExecutionSnapshot {
            exec_id: self.exec_id,
            session_id: self.session_id.clone(),
            source: self.source,
            task_id: self.task_id.clone(),
            display_command: self.display_command.clone(),
            started_at_millis: self
                .started_at
                .duration_since(SystemTime::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
        }
    }
}

struct RunningExecution {
    record: ExecutionRecord,
    cancel_tx: watch::Sender<CancelReason>,
}

struct ManagerInner {
    /// 生产传输层（经 SshManager）。测试可用 [`Self::with_transport`] 注入 mock。
    transport: Arc<dyn ExecTransport>,
    next_exec_id: AtomicU64,
    /// exec_id -> 运行中执行。
    running: TokioMutex<HashMap<u64, RunningExecution>>,
    /// task_id -> exec_id（用户取消注册表）。
    by_task_id: TokioMutex<HashMap<String, u64>>,
    /// 最近完成记录（环形，新在后）。
    recent: TokioMutex<VecDeque<ExecutionRecord>>,
}

impl ManagerInner {
    /// 取消某会话上所有运行中的执行（断连级联）。返回取消数量。
    async fn cancel_session(&self, session_id: &str, reason: CancelReason) -> usize {
        let running = self.running.lock().await;
        let mut count = 0;
        for entry in running.values() {
            if entry.record.session_id == session_id && entry.cancel_tx.send(reason).is_ok() {
                count += 1;
            }
        }
        count
    }

    async fn finalize_execution(
        &self,
        exec_id: u64,
        task_id: Option<String>,
        status: ExecutionStatus,
    ) {
        let mut running = self.running.lock().await;
        if let Some(entry) = running.remove(&exec_id) {
            let mut rec = entry.record;
            rec.status = status;
            let mut recent = self.recent.lock().await;
            recent.push_back(rec);
            while recent.len() > RECENT_LIMIT {
                recent.pop_front();
            }
        }
        drop(running);
        if let Some(tid) = task_id {
            let mut by = self.by_task_id.lock().await;
            // 只清理仍指向本次执行的注册项，避免误删同 task_id 的新注册。
            if by.get(&tid) == Some(&exec_id) {
                by.remove(&tid);
            }
        }
    }
}

/// 保证执行记录在 submit 任何退出路径（含 panic）都能落账的守卫。
struct FinalizeGuard {
    inner: Arc<ManagerInner>,
    exec_id: u64,
    task_id: Option<String>,
    finalized: bool,
}

impl FinalizeGuard {
    async fn finalize(mut self, status: ExecutionStatus) {
        self.finalized = true;
        let task_id = self.task_id.take();
        self.inner
            .finalize_execution(self.exec_id, task_id, status)
            .await;
    }
}

impl Drop for FinalizeGuard {
    fn drop(&mut self) {
        if !self.finalized {
            // panic 路径：best-effort 异步落账为 Failed。
            let inner = self.inner.clone();
            let exec_id = self.exec_id;
            let task_id = self.task_id.take();
            tokio::spawn(async move {
                inner
                    .finalize_execution(exec_id, task_id, ExecutionStatus::Failed)
                    .await;
            });
        }
    }
}

/// 命令执行统一管理器。Clone 共享同一份内部状态。
#[derive(Clone)]
pub struct CommandExecutionManager {
    inner: Arc<ManagerInner>,
}

impl CommandExecutionManager {
    /// 生产构造：绑定真实 SshManager，并注册断连观察者实现级联取消。
    pub async fn new(ssh: SshManager) -> Self {
        let inner = Arc::new(ManagerInner {
            transport: Arc::new(SshExecTransport { ssh: ssh.clone() }),
            next_exec_id: AtomicU64::new(0),
            running: TokioMutex::new(HashMap::new()),
            by_task_id: TokioMutex::new(HashMap::new()),
            recent: TokioMutex::new(VecDeque::new()),
        });

        // 断连级联取消：driver cleanup（真断连，含主动 disconnect）时，
        // 取消该会话上所有仍在运行的执行。stale driver 跳过 cleanup，
        // 不会误触发（见 SshManager generation 机制）。
        let observer_inner = inner.clone();
        ssh.register_disconnect_observer(Arc::new(move |session_id| {
            let inner = observer_inner.clone();
            let sid = session_id.to_string();
            tokio::spawn(async move {
                let n = inner.cancel_session(&sid, CancelReason::Disconnected).await;
                if n > 0 {
                    log::info!(
                        "command_exec: 会话 {} 断连，级联取消 {} 个运行中的命令",
                        sid,
                        n
                    );
                }
            });
        }))
        .await;

        Self { inner }
    }

    /// 测试构造：注入 mock transport，不注册断连观察者。
    pub fn with_transport(transport: Arc<dyn ExecTransport>) -> Self {
        Self {
            inner: Arc::new(ManagerInner {
                transport,
                next_exec_id: AtomicU64::new(0),
                running: TokioMutex::new(HashMap::new()),
                by_task_id: TokioMutex::new(HashMap::new()),
                recent: TokioMutex::new(VecDeque::new()),
            }),
        }
    }

    /// 提交一次命令执行并等待完成。
    ///
    /// 这是所有命令执行的唯一入口：分配 exec_id、登记记录、注册取消
    /// （ticket 带 task_id 时）、经 transport 执行、处理取消竞争、落账。
    pub async fn submit(&self, app: &AppHandle, ticket: CommandTicket) -> SubmitOutcome {
        self.submit_opt(Some(app), ticket).await
    }

    /// 同 [`Self::submit`]，但允许无 AppHandle（无流式输出场景 / 测试）。
    pub(crate) async fn submit_opt(
        &self,
        app: Option<&AppHandle>,
        ticket: CommandTicket,
    ) -> SubmitOutcome {
        let exec_id = self.inner.next_exec_id.fetch_add(1, Ordering::Relaxed) + 1;
        let (cancel_tx, mut cancel_rx) = watch::channel(CancelReason::User);

        let record = ExecutionRecord {
            exec_id,
            session_id: ticket.session_id.clone(),
            source: ticket.source,
            task_id: ticket.task_id.clone(),
            display_command: truncate_display(&ticket.display_command),
            started_at: SystemTime::now(),
            status: ExecutionStatus::Running,
        };

        if let Some(tid) = &ticket.task_id {
            self.inner.by_task_id.lock().await.insert(tid.clone(), exec_id);
        }
        self.inner
            .running
            .lock()
            .await
            .insert(exec_id, RunningExecution { record, cancel_tx });

        let guard = FinalizeGuard {
            inner: self.inner.clone(),
            exec_id,
            task_id: ticket.task_id.clone(),
            finalized: false,
        };

        // biased：取消优先——与旧 ssh_exec_long 的 select 语义一致
        //（取消信号与命令完成同时到达时，取消获胜）。
        let outcome = tokio::select! {
            biased;
            _ = cancel_rx.changed() => {
                let reason = *cancel_rx.borrow();
                SubmitOutcome::Cancelled { reason }
            }
            res = self.inner.transport.exec(&ticket, app) => match res {
                Ok((output, false)) => SubmitOutcome::Completed { output },
                Ok((output, true)) => SubmitOutcome::TimedOut { output },
                Err(error) => SubmitOutcome::Failed { error },
            },
        };

        let status = match &outcome {
            SubmitOutcome::Completed { .. } => ExecutionStatus::Completed,
            SubmitOutcome::TimedOut { .. } => ExecutionStatus::TimedOut,
            SubmitOutcome::Cancelled { .. } => ExecutionStatus::Cancelled,
            SubmitOutcome::Failed { .. } => ExecutionStatus::Failed,
        };
        guard.finalize(status).await;
        outcome
    }

    /// 便捷入口：等价旧 `SshManager::exec_command`（120s 超时，
    /// 超时错误文案一致），但会登记执行记录。适用于内部短命令
    /// （压缩前检查、解压探测等）。
    pub async fn exec_simple(
        &self,
        app: &AppHandle,
        session_id: &str,
        command: &str,
        source: CommandSource,
    ) -> Result<String, AppError> {
        let ticket = CommandTicket::new(session_id, command, source);
        match self.submit(app, ticket).await {
            SubmitOutcome::Completed { output } => Ok(output),
            SubmitOutcome::TimedOut { .. } => Err(AppError::Ssh(format!(
                "命令在 120 秒后超时: {}",
                timeout_preview(command)
            ))),
            // exec_simple 的 ticket 无 task_id，只有断连级联会走到这里。
            SubmitOutcome::Cancelled { .. } => {
                Err(AppError::Ssh("命令已取消（会话断开）".into()))
            }
            SubmitOutcome::Failed { error } => Err(error),
        }
    }

    /// 用户取消：按 task_id 取消一个运行中的执行。
    /// 返回是否命中（未命中 = 任务不存在或已结束），与旧
    /// `ssh_exec_long_cancel` 一致地不区分这两种情况。
    pub async fn cancel(&self, task_id: &str) -> bool {
        let exec_id = self.inner.by_task_id.lock().await.get(task_id).copied();
        match exec_id {
            Some(id) => {
                let running = self.inner.running.lock().await;
                match running.get(&id) {
                    Some(entry) => entry.cancel_tx.send(CancelReason::User).is_ok(),
                    None => false,
                }
            }
            None => false,
        }
    }

    /// 会话级联取消：取消 `session_id` 上所有运行中的执行（无论是否带
    /// task_id）。断连观察者用它实现级联取消；也适用于未来的
    /// 「一键停止该会话所有命令」能力。返回取消的数量。
    pub async fn cancel_session(&self, session_id: &str, reason: CancelReason) -> usize {
        self.inner.cancel_session(session_id, reason).await
    }

    /// 当前运行中 + 最近完成的执行快照（按 exec_id 升序）。
    /// `display_command` 已截断，绝不含 sudo 密码。
    pub async fn snapshots(&self) -> Vec<ExecutionSnapshot> {
        let running = self.inner.running.lock().await;
        let mut list: Vec<ExecutionSnapshot> =
            running.values().map(|e| e.record.snapshot()).collect();
        list.sort_by_key(|s| s.exec_id);
        drop(running);
        let recent = self.inner.recent.lock().await;
        list.extend(recent.iter().map(|r| r.snapshot()));
        list
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_exec::ticket::CommandSource;
    use async_trait::async_trait;
    use std::time::Duration;

    /// 可编程 mock 传输层。
    enum MockBehavior {
        /// 永不返回（模拟长命令，直到被取消 drop）。
        Hang,
        /// 立即返回 (output, was_timeout)。
        Return(&'static str, bool),
        /// 立即失败。
        Fail(&'static str),
    }

    struct MockTransport {
        behavior: MockBehavior,
    }

    #[async_trait]
    impl ExecTransport for MockTransport {
        async fn exec(
            &self,
            _ticket: &CommandTicket,
            _app: Option<&AppHandle>,
        ) -> Result<(String, bool), AppError> {
            match &self.behavior {
                MockBehavior::Hang => std::future::pending().await,
                MockBehavior::Return(output, was_timeout) => {
                    Ok((output.to_string(), *was_timeout))
                }
                MockBehavior::Fail(msg) => Err(AppError::Ssh(msg.to_string())),
            }
        }
    }

    fn manager(behavior: MockBehavior) -> CommandExecutionManager {
        CommandExecutionManager::with_transport(Arc::new(MockTransport { behavior }))
    }

    /// 轮询快照直到出现至少 `expect` 条记录（submit 在 select 前完成注册，
    /// 这里只是给调度留一点时间）。
    async fn wait_for_records(mgr: &CommandExecutionManager, expect: usize) {
        for _ in 0..400 {
            if mgr.snapshots().await.len() >= expect {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("执行未在预期时间内进入运行状态");
    }

    #[tokio::test]
    async fn submit_completed_records_and_cleans_registry() {
        let mgr = manager(MockBehavior::Return("ok", false));
        let ticket = CommandTicket::new("s1", "ls", CommandSource::User)
            .cancellable("t1", "命令已取消");
        let outcome = mgr.submit_opt(None, ticket).await;
        match outcome {
            SubmitOutcome::Completed { output } => assert_eq!(output, "ok"),
            other => panic!("expected Completed, got {:?}", other),
        }
        // 注册表已清理
        assert!(!mgr.cancel("t1").await, "task_id 应已从注册表移除");
        // 完成后从运行表移入最近记录
        let snaps = mgr.snapshots().await;
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].task_id.as_deref(), Some("t1"));
    }

    #[tokio::test]
    async fn submit_timeout_maps_to_timed_out() {
        let mgr = manager(MockBehavior::Return("partial", true));
        let outcome = mgr
            .submit_opt(None, CommandTicket::new("s1", "sleep", CommandSource::User))
            .await;
        match outcome {
            SubmitOutcome::TimedOut { output } => assert_eq!(output, "partial"),
            other => panic!("expected TimedOut, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn submit_failure_maps_to_failed() {
        let mgr = manager(MockBehavior::Fail("boom"));
        let outcome = mgr
            .submit_opt(None, CommandTicket::new("s1", "ls", CommandSource::User))
            .await;
        match outcome {
            SubmitOutcome::Failed { error } => {
                assert!(error.to_string().contains("boom"))
            }
            other => panic!("expected Failed, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn user_cancel_interrupts_hanging_command() {
        let mgr = manager(MockBehavior::Hang);
        let mgr2 = mgr.clone();
        let handle = tokio::spawn(async move {
            mgr2
                .submit_opt(
                    None,
                    CommandTicket::new("s1", "long", CommandSource::SystemTask)
                        .cancellable("task-1", "命令已取消"),
                )
                .await
        });

        // 等待注册可见（用快照轮询，避免用 cancel 探测——那会发送信号）
        wait_for_records(&mgr, 1).await;
        assert!(mgr.cancel("task-1").await);

        let outcome = handle.await.expect("join");
        match outcome {
            SubmitOutcome::Cancelled { reason } => assert_eq!(reason, CancelReason::User),
            other => panic!("expected Cancelled, got {:?}", other),
        }
        assert!(!mgr.cancel("task-1").await, "取消注册表应已清理");
    }

    #[tokio::test]
    async fn cancel_session_only_touches_that_session() {
        let mgr = manager(MockBehavior::Hang);
        let mgr_a = mgr.clone();
        let mgr_b = mgr.clone();
        let h_a = tokio::spawn(async move {
            mgr_a
                .submit_opt(
                    None,
                    CommandTicket::new("session-a", "cmd", CommandSource::User)
                        .cancellable("ta", "取消"),
                )
                .await
        });
        let h_b = tokio::spawn(async move {
            mgr_b
                .submit_opt(
                    None,
                    CommandTicket::new("session-b", "cmd", CommandSource::User)
                        .cancellable("tb", "取消"),
                )
                .await
        });

        wait_for_records(&mgr, 2).await;

        // 级联取消只影响 session-a
        let n = mgr.cancel_session("session-a", CancelReason::Disconnected).await;
        assert_eq!(n, 1);

        let out_a = h_a.await.expect("join a");
        match out_a {
            SubmitOutcome::Cancelled { reason } => assert_eq!(reason, CancelReason::Disconnected),
            other => panic!("expected Cancelled, got {:?}", other),
        }
        // session-b 仍在运行
        assert_eq!(mgr.snapshots().await.len(), 2);
        // 再手动取消 b
        assert!(mgr.cancel("tb").await);
        match h_b.await.expect("join b") {
            SubmitOutcome::Cancelled { reason } => assert_eq!(reason, CancelReason::User),
            other => panic!("expected Cancelled, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn cancel_unknown_task_is_noop() {
        let mgr = manager(MockBehavior::Return("x", false));
        assert!(!mgr.cancel("nope").await);
    }

    #[tokio::test]
    async fn snapshot_truncates_display_command() {
        let mgr = manager(MockBehavior::Return("ok", false));
        let long = "测".repeat(300);
        let secret_cmd = format!("printf 'pw' | sudo -S -- {}", long);
        let ticket = CommandTicket::new("s1", secret_cmd.clone(), CommandSource::Agent)
            .display_as(format!("sudo {}", long));
        mgr.submit_opt(None, ticket).await;

        let snaps = mgr.snapshots().await;
        assert_eq!(snaps.len(), 1);
        let display = &snaps[0].display_command;
        assert!(display.chars().count() <= 121);
        assert!(display.ends_with('…'));
        // 实际命令（含密码）绝不出现
        assert!(!display.contains("printf"));
    }

    #[tokio::test]
    async fn recent_records_are_capped() {
        let mgr = manager(MockBehavior::Return("ok", false));
        for i in 0..(RECENT_LIMIT + 20) {
            mgr.submit_opt(
                None,
                CommandTicket::new("s1", format!("cmd-{}", i), CommandSource::User),
            )
            .await;
        }
        assert_eq!(mgr.snapshots().await.len(), RECENT_LIMIT);
    }

    #[tokio::test]
    async fn exec_ids_are_unique_and_monotonic() {
        let mgr = manager(MockBehavior::Return("ok", false));
        mgr.submit_opt(None, CommandTicket::new("s", "a", CommandSource::User))
            .await;
        mgr.submit_opt(None, CommandTicket::new("s", "b", CommandSource::User))
            .await;
        let snaps = mgr.snapshots().await;
        assert_eq!(snaps[0].exec_id, 1);
        assert_eq!(snaps[1].exec_id, 2);
    }
}
