//! MCP 对外暴露的统一任务台账。
//!
//! - 命令任务不复制输出：直接复用 `command_exec` 的后台作业台账、输出缓冲和
//!   `kill_job`；这里只负责把命令作业投影成统一快照。
//! - 上传/下载与远程子 Agent 是 MCP 自己 spawn 的长任务：本模块保存它们的
//!   状态、进度和取消通道。
//!
//! 所有任务 ID 只在当前 MCP 服务进程内有效；命令作业的 `job_id` 保留原有
//! 台账语义，调用方统一通过 `task_status/list/output/cancel` 操作。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock as PlRwLock;
use serde::Serialize;
use tokio::task::JoinSet;

use crate::cancel::{CancellationRegistry, Registration};
use crate::command_exec::{
    CommandExecutionManager, JobCaller, JobFilter, JobInfo, JobOutputResult, JobStatus,
};
use crate::error::AppError;

const MCP_TASK_TAG: &str = "mcp-task:";
const MAX_SETTLED_MANAGED_TASKS: usize = 100;

/// 统一任务类型。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Command,
    Upload,
    Download,
    Agent,
}

/// 统一状态。命令作业的 `killed` 在这里收敛为 `cancelled`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatus {
    Running,
    Cancelling,
    Completed,
    Failed,
    Cancelled,
    Interrupted,
}

impl TaskStatus {
    fn is_terminal(self) -> bool {
        !matches!(self, Self::Running | Self::Cancelling)
    }
}

/// `task_status/list` 的公共快照。
#[derive(Debug, Clone, Serialize)]
pub struct TaskSnapshot {
    pub task_id: String,
    pub kind: TaskKind,
    pub status: TaskStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    pub connection_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remote_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_transferred: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_bytes: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code_known: Option<bool>,
    pub remote_may_continue: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_committed: Option<bool>,
    pub started_at_ms: u128,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at_ms: Option<u128>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
}

impl TaskSnapshot {
    pub fn new_managed(
        task_id: String,
        kind: TaskKind,
        connection_id: String,
        phase: &str,
        started_at_ms: u128,
    ) -> Self {
        Self {
            task_id,
            kind,
            status: TaskStatus::Running,
            phase: Some(phase.to_string()),
            connection_id,
            command: None,
            description: None,
            local_path: None,
            remote_path: None,
            bytes_transferred: None,
            total_bytes: None,
            output_bytes: None,
            exit_code: None,
            exit_code_known: None,
            remote_may_continue: false,
            target_committed: None,
            started_at_ms,
            finished_at_ms: None,
            error: None,
            result: None,
        }
    }
}

struct TaskInner {
    tasks: PlRwLock<HashMap<String, TaskSnapshot>>,
    /// session_id → 外部 connection_id。命令作业只记内部会话 ID，任务快照
    /// 必须换回调用方认识的那个连接 ID。
    session_connections: PlRwLock<HashMap<String, String>>,
    cancel: CancellationRegistry,
    command_exec: Arc<CommandExecutionManager>,
    workers: tokio::sync::Mutex<JoinSet<()>>,
}

/// 可克隆的 MCP 任务台账。
#[derive(Clone)]
pub struct TaskManager {
    inner: Arc<TaskInner>,
}

impl TaskManager {
    pub fn new(command_exec: Arc<CommandExecutionManager>) -> Self {
        Self {
            inner: Arc::new(TaskInner {
                tasks: PlRwLock::new(HashMap::new()),
                session_connections: PlRwLock::new(HashMap::new()),
                cancel: CancellationRegistry::default(),
                command_exec,
                workers: tokio::sync::Mutex::new(JoinSet::new()),
            }),
        }
    }

    pub fn allocate_id(kind: TaskKind) -> String {
        let prefix = match kind {
            TaskKind::Command => "mcp-command",
            TaskKind::Upload => "mcp-upload",
            TaskKind::Download => "mcp-download",
            TaskKind::Agent => "mcp-agent",
        };
        format!("{}-{}", prefix, uuid::Uuid::new_v4())
    }

    /// 登记一个 MCP 自管长任务。返回更新句柄和必须移进 worker 的取消凭据。
    pub fn start_managed(&self, snapshot: TaskSnapshot) -> Option<(TaskHandle, Registration)> {
        let mut tasks = self.inner.tasks.write();
        if tasks.contains_key(&snapshot.task_id) {
            return None;
        }
        let id = snapshot.task_id.clone();
        tasks.insert(id.clone(), snapshot);
        drop(tasks);
        let registration = self.inner.cancel.register(&id);
        Some((
            TaskHandle {
                inner: self.inner.clone(),
                task_id: id,
            },
            registration,
        ))
    }

    /// 把一个已经 spawn 的 worker 收进统一收尾表。
    pub async fn track_worker<F>(&self, future: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.inner.workers.lock().await.spawn(future);
    }

    pub fn cancel_registered(&self, task_id: &str) -> bool {
        self.inner.cancel.cancel(task_id)
    }

    /// 记下内部 session 对应的外部连接 ID，供命令任务快照回显。
    pub(crate) fn remember_session(&self, connection_id: &str, session_id: &str) {
        self.inner
            .session_connections
            .write()
            .insert(session_id.to_string(), connection_id.to_string());
    }

    pub fn snapshot_managed(&self, task_id: &str) -> Option<TaskSnapshot> {
        self.inner.tasks.read().get(task_id).cloned()
    }

    fn set_phase(&self, task_id: &str, phase: &str) {
        if let Some(task) = self.inner.tasks.write().get_mut(task_id) {
            if !task.status.is_terminal() {
                task.phase = Some(phase.to_string());
            }
        }
    }

    fn set_progress(&self, task_id: &str, written: u64, total: u64) {
        if let Some(task) = self.inner.tasks.write().get_mut(task_id) {
            if !task.status.is_terminal() {
                task.bytes_transferred = Some(written);
                task.total_bytes = Some(total);
                if written > 0 {
                    task.phase = Some("transferring".into());
                }
            }
        }
    }

    fn mark_cancelling(&self, task_id: &str) -> Option<TaskSnapshot> {
        let mut tasks = self.inner.tasks.write();
        let task = tasks.get_mut(task_id)?;
        if !task.status.is_terminal() {
            task.status = TaskStatus::Cancelling;
            task.phase = Some("cancelling".into());
        }
        Some(task.clone())
    }

    fn finish(
        &self,
        task_id: &str,
        status: TaskStatus,
        error: Option<String>,
        target_committed: Option<bool>,
        result: Option<String>,
    ) {
        let mut tasks = self.inner.tasks.write();
        let Some(task) = tasks.get_mut(task_id) else {
            return;
        };
        // 先到者为准：已完成的任务不能被迟到的取消/失败改写。
        if task.status.is_terminal() {
            return;
        }
        task.status = status;
        task.phase = Some(
            match status {
                TaskStatus::Running => "running",
                TaskStatus::Cancelling => "cancelling",
                TaskStatus::Completed => "completed",
                TaskStatus::Failed => "failed",
                TaskStatus::Cancelled => "cancelled",
                TaskStatus::Interrupted => "interrupted",
            }
            .into(),
        );
        if status == TaskStatus::Completed {
            task.progress_to_end();
        }
        task.finished_at_ms = Some(now_millis());
        task.error = error;
        task.result = result;
        if target_committed.is_some() {
            task.target_committed = target_committed;
        }
        task.remote_may_continue = matches!(status, TaskStatus::Cancelled | TaskStatus::Interrupted)
            && !matches!(task.kind, TaskKind::Upload | TaskKind::Download);
        prune_managed(&mut tasks);
    }

    /// 服务结束：取消自管任务并等待 worker 清理，再终止本服务发起的命令作业。
    /// 只碰带 MCP 标记的命令作业，不能误杀 GUI/内置 Agent 的作业。
    pub async fn shutdown(&self) {
        self.inner.cancel.cancel_all();
        let mut workers = self.inner.workers.lock().await;
        while workers.join_next().await.is_some() {}
        drop(workers);

        let running = self
            .inner
            .command_exec
            .list_jobs(JobFilter::All, Some("running"))
            .await;
        for job in running {
            if is_mcp_job(&job) {
                let _ = self
                    .inner
                    .command_exec
                    .kill_job(
                        &job.job_id,
                        crate::command_exec::CancelReason::User,
                        JobCaller::Unscoped,
                    )
                    .await;
            }
        }
    }

    async fn command_jobs(&self) -> Vec<JobInfo> {
        let mut jobs: Vec<JobInfo> = self
            .inner
            .command_exec
            .list_jobs(JobFilter::All, None)
            .await
            .into_iter()
            .filter(is_mcp_job)
            .collect();
        jobs.sort_by_key(|j| j.started_at_millis);
        jobs
    }

    fn command_snapshot(&self, job: JobInfo) -> TaskSnapshot {
        let connection_id = self
            .inner
            .session_connections
            .read()
            .get(&job.session_id)
            .cloned()
            .unwrap_or_else(|| job.session_id.clone());
        command_snapshot(job, connection_id)
    }

    async fn find_mcp_command_job(&self, task_id: &str) -> Result<JobInfo, AppError> {
        self.command_jobs()
            .await
            .into_iter()
            .find(|j| j.job_id == task_id)
            .ok_or_else(|| unknown_task(task_id))
    }

    pub async fn task_status(&self, task_id: &str) -> Result<TaskSnapshot, AppError> {
        if let Some(task) = self.snapshot_managed(task_id) {
            return Ok(task);
        }
        let job = self.find_mcp_command_job(task_id).await?;
        Ok(self.command_snapshot(job))
    }

    pub async fn task_list(&self, active_only: bool) -> Vec<TaskSnapshot> {
        let mut tasks: Vec<TaskSnapshot> = self
            .inner
            .tasks
            .read()
            .values()
            .filter(|task| !active_only || !task.status.is_terminal())
            .cloned()
            .collect();
        tasks.extend(
            self.command_jobs()
                .await
                .into_iter()
                .filter(|job| !active_only || job.status == JobStatus::Running)
                .map(|job| self.command_snapshot(job)),
        );
        tasks.sort_by_key(|task| std::cmp::Reverse(task.started_at_ms));
        tasks
    }

    pub async fn task_output(
        &self,
        task_id: &str,
        offset: usize,
        budget: usize,
    ) -> Result<JobOutputResult, AppError> {
        if self.snapshot_managed(task_id).is_some() {
            return Err(AppError::Agent(format!(
                "任务 {} 不是命令任务，没有 stdout/stderr 可读；用 task_status 看进度。",
                task_id
            )));
        }
        let job = self.find_mcp_command_job(task_id).await?;
        self.inner
            .command_exec
            .job_output(
                &job.job_id,
                offset,
                budget,
                false,
                Duration::ZERO,
                JobCaller::Unscoped,
            )
            .await
    }

    pub async fn task_cancel(&self, task_id: &str) -> Result<TaskSnapshot, AppError> {
        if let Some(snapshot) = self.mark_cancelling(task_id) {
            if !snapshot.status.is_terminal() {
                self.inner.cancel.cancel(task_id);
            }
            return Ok(snapshot);
        }
        let job = self.find_mcp_command_job(task_id).await?;
        let killed = self
            .inner
            .command_exec
            .kill_job(
                &job.job_id,
                crate::command_exec::CancelReason::User,
                JobCaller::Unscoped,
            )
            .await?;
        Ok(self.command_snapshot(killed))
    }
}

impl TaskSnapshot {
    fn progress_to_end(&mut self) {
        if let (Some(total), Some(_)) = (self.total_bytes, self.bytes_transferred) {
            self.bytes_transferred = Some(total);
        }
    }
}

/// 一个自管任务的更新句柄。worker 拿它写进度/终态。
#[derive(Clone)]
pub struct TaskHandle {
    inner: Arc<TaskInner>,
    task_id: String,
}

impl TaskHandle {
    fn manager(&self) -> TaskManager {
        TaskManager {
            inner: self.inner.clone(),
        }
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn phase(&self, phase: &str) {
        self.manager().set_phase(&self.task_id, phase);
    }

    pub fn progress(&self, written: u64, total: u64) {
        self.manager().set_progress(&self.task_id, written, total);
    }

    pub fn complete(&self, target_committed: bool, result: Option<String>) {
        self.manager().finish(
            &self.task_id,
            TaskStatus::Completed,
            None,
            Some(target_committed),
            result,
        );
    }

    pub fn fail(&self, error: impl Into<String>) {
        self.manager().finish(
            &self.task_id,
            TaskStatus::Failed,
            Some(error.into()),
            Some(false),
            None,
        );
    }

    pub fn cancelled(&self, error: Option<String>) {
        self.manager().finish(
            &self.task_id,
            TaskStatus::Cancelled,
            error,
            Some(false),
            None,
        );
    }
}

fn prune_managed(tasks: &mut HashMap<String, TaskSnapshot>) {
    let mut settled: Vec<(String, u128)> = tasks
        .iter()
        .filter(|(_, task)| task.status.is_terminal())
        .map(|(id, task)| {
            (
                id.clone(),
                task.finished_at_ms.unwrap_or(task.started_at_ms),
            )
        })
        .collect();
    if settled.len() <= MAX_SETTLED_MANAGED_TASKS {
        return;
    }
    settled.sort_by_key(|(_, time)| *time);
    let remove_count = settled_count_over_limit(settled.len());
    for (id, _) in settled.into_iter().take(remove_count) {
        tasks.remove(&id);
    }
}

fn settled_count_over_limit(total: usize) -> usize {
    total.saturating_sub(MAX_SETTLED_MANAGED_TASKS)
}

fn is_mcp_job(job: &JobInfo) -> bool {
    job.task_id
        .as_deref()
        .is_some_and(|task_id| task_id.starts_with(MCP_TASK_TAG))
}

fn command_snapshot(job: JobInfo, connection_id: String) -> TaskSnapshot {
    let status = match job.status {
        JobStatus::Running => TaskStatus::Running,
        JobStatus::Completed => TaskStatus::Completed,
        JobStatus::Killed => TaskStatus::Cancelled,
        JobStatus::Failed => TaskStatus::Failed,
        JobStatus::Interrupted => TaskStatus::Interrupted,
    };
    let (exit_code, exit_code_known) = parse_exit_code(job.detail.as_deref());
    TaskSnapshot {
        task_id: job.job_id,
        kind: TaskKind::Command,
        status,
        phase: Some(status_phase(status).into()),
        connection_id,
        command: Some(job.command),
        description: Some(job.description),
        local_path: None,
        remote_path: None,
        bytes_transferred: None,
        total_bytes: None,
        output_bytes: Some(job.total_output_bytes),
        exit_code,
        exit_code_known: Some(exit_code_known),
        remote_may_continue: matches!(status, TaskStatus::Cancelled | TaskStatus::Interrupted),
        target_committed: None,
        started_at_ms: job.started_at_millis,
        finished_at_ms: job.finished_at_millis,
        error: if matches!(status, TaskStatus::Failed | TaskStatus::Cancelled) {
            job.detail
        } else {
            None
        },
        result: None,
    }
}

fn parse_exit_code(detail: Option<&str>) -> (Option<i32>, bool) {
    let Some(detail) = detail else {
        return (None, false);
    };
    let Some(rest) = detail.strip_prefix("exit code: ") else {
        return (None, false);
    };
    match rest.trim().parse::<i32>() {
        Ok(code) => (Some(code), true),
        Err(_) => (None, false),
    }
}

fn status_phase(status: TaskStatus) -> &'static str {
    match status {
        TaskStatus::Running => "running",
        TaskStatus::Cancelling => "cancelling",
        TaskStatus::Completed => "completed",
        TaskStatus::Failed => "failed",
        TaskStatus::Cancelled => "cancelled",
        TaskStatus::Interrupted => "interrupted",
    }
}

fn unknown_task(task_id: &str) -> AppError {
    AppError::Agent(format!(
        "没有任务 '{}' 的记录：ID 写错了，或它属于上一次 MCP 服务进程（任务表只在当前进程内有效）。用 task_list 查看现有任务。",
        task_id
    ))
}

pub(crate) fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_exec::CommandExecutionManager;

    async fn manager() -> TaskManager {
        let ssh = crate::SshManager::new();
        let dir = std::env::temp_dir().join(format!("marcel-mcp-tasks-{}", uuid::Uuid::new_v4()));
        let command_exec = Arc::new(
            CommandExecutionManager::new(ssh, dir.join("jobs_temp"), dir.join("ledger.jsonl"))
                .await,
        );
        TaskManager::new(command_exec)
    }

    fn snapshot(kind: TaskKind) -> TaskSnapshot {
        TaskSnapshot::new_managed(
            TaskManager::allocate_id(kind),
            kind,
            "conn-1".into(),
            "connecting",
            now_millis(),
        )
    }

    #[tokio::test]
    async fn managed_task_progresses_and_completes_once() {
        let manager = manager().await;
        let (handle, registration) = manager.start_managed(snapshot(TaskKind::Upload)).unwrap();
        let id = handle.task_id().to_string();
        handle.progress(10, 100);
        let running = manager.task_status(&id).await.unwrap();
        assert_eq!(running.status, TaskStatus::Running);
        assert_eq!(running.bytes_transferred, Some(10));
        assert_eq!(running.phase.as_deref(), Some("transferring"));

        handle.complete(true, None);
        drop(registration);
        let done = manager.task_status(&id).await.unwrap();
        assert_eq!(done.status, TaskStatus::Completed);
        assert_eq!(done.target_committed, Some(true));

        // 终态不可被迟到的取消改写。
        let after = manager.task_cancel(&id).await.unwrap();
        assert_eq!(after.status, TaskStatus::Completed);
    }

    #[tokio::test]
    async fn cancel_marks_cancelling_and_signals_worker() {
        let manager = manager().await;
        let (handle, registration) = manager.start_managed(snapshot(TaskKind::Download)).unwrap();
        let id = handle.task_id().to_string();
        let rx = registration.receiver();

        let requested = manager.task_cancel(&id).await.unwrap();
        assert_eq!(requested.status, TaskStatus::Cancelling);
        assert!(*rx.borrow(), "取消信号必须到达 worker");

        handle.cancelled(Some("cancelled by test".into()));
        drop(registration);
        let final_state = manager.task_status(&id).await.unwrap();
        assert_eq!(final_state.status, TaskStatus::Cancelled);
        assert_eq!(final_state.error.as_deref(), Some("cancelled by test"));
    }

    #[tokio::test]
    async fn task_list_filters_terminal_managed_tasks() {
        let manager = manager().await;
        let (done, done_reg) = manager.start_managed(snapshot(TaskKind::Upload)).unwrap();
        done.complete(true, None);
        drop(done_reg);
        let (running, _running_reg) = manager.start_managed(snapshot(TaskKind::Download)).unwrap();

        let all = manager.task_list(false).await;
        assert_eq!(all.len(), 2);
        let active = manager.task_list(true).await;
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].task_id, running.task_id());
    }

    #[tokio::test]
    async fn unknown_task_is_a_readable_error() {
        let manager = manager().await;
        let err = manager.task_status("missing").await.unwrap_err();
        assert!(err.to_string().contains("没有任务 'missing' 的记录"));
    }

    #[tokio::test]
    async fn cancelled_and_failed_transfers_preserve_progress_and_clear_remote_may_continue() {
        let manager = manager().await;
        let (cancelled_upload, reg1) = manager.start_managed(snapshot(TaskKind::Upload)).unwrap();
        cancelled_upload.progress(42, 100);
        cancelled_upload.cancelled(Some("user cancelled".into()));
        drop(reg1);
        let cancelled_snap = manager.task_status(cancelled_upload.task_id()).await.unwrap();
        assert_eq!(cancelled_snap.status, TaskStatus::Cancelled);
        assert_eq!(cancelled_snap.bytes_transferred, Some(42));
        assert!(!cancelled_snap.remote_may_continue);

        let (failed_download, reg2) = manager.start_managed(snapshot(TaskKind::Download)).unwrap();
        failed_download.progress(25, 100);
        failed_download.fail("io error");
        drop(reg2);
        let failed_snap = manager.task_status(failed_download.task_id()).await.unwrap();
        assert_eq!(failed_snap.status, TaskStatus::Failed);
        assert_eq!(failed_snap.bytes_transferred, Some(25));
        assert!(!failed_snap.remote_may_continue);

        let (done_upload, reg3) = manager.start_managed(snapshot(TaskKind::Upload)).unwrap();
        done_upload.progress(90, 100);
        done_upload.complete(true, None);
        drop(reg3);
        let done_snap = manager.task_status(done_upload.task_id()).await.unwrap();
        assert_eq!(done_snap.bytes_transferred, Some(100));

        let (cancelled_agent, reg4) = manager.start_managed(snapshot(TaskKind::Agent)).unwrap();
        cancelled_agent.cancelled(Some("stopped".into()));
        drop(reg4);
        let agent_snap = manager.task_status(cancelled_agent.task_id()).await.unwrap();
        assert!(agent_snap.remote_may_continue);
    }

    #[tokio::test]
    async fn non_mcp_command_jobs_are_isolated_from_task_tools() {
        use crate::command_exec::executor::{ExecExit, ExecOutcome, ExecTransport};
        use crate::command_exec::{CommandSource, CommandTicket};

        struct InstantOk;

        #[async_trait::async_trait]
        impl ExecTransport for InstantOk {
            async fn exec(
                &self,
                _ticket: &CommandTicket,
                _app: Option<&tauri::AppHandle>,
                _cancel: Option<&tokio::sync::watch::Receiver<crate::command_exec::CancelReason>>,
            ) -> Result<ExecOutcome, AppError> {
                Ok(ExecOutcome::Completed {
                    output: "gui-secret-output".into(),
                    exit: ExecExit {
                        code: Some(0),
                        signal: None,
                    },
                })
            }
        }

        let dir = std::env::temp_dir().join(format!("marcel-mcp-iso-{}", uuid::Uuid::new_v4()));
        let command_exec = Arc::new(CommandExecutionManager::with_transport_at(
            Arc::new(InstantOk),
            dir,
        ));
        let manager = TaskManager::new(command_exec.clone());

        let gui_job = command_exec
            .submit_background(
                None,
                CommandTicket::new("s1", "echo secret", CommandSource::Agent),
                None,
            )
            .await
            .unwrap();

        assert!(manager.task_list(false).await.is_empty());
        assert!(manager.task_status(&gui_job.job_id).await.is_err());
        assert!(manager.task_output(&gui_job.job_id, 0, 1024).await.is_err());
        assert!(manager.task_cancel(&gui_job.job_id).await.is_err());
    }
}
