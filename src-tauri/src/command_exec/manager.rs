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
//!    后台作业（`submit_background`）同样经此体系：立即返回 `job_id`，
//!    输出沉淀到 [`job::JobInstance`]（环形缓冲 + 溢出文件），执行记录、
//!    取消注册、断连级联与前台执行完全共用同一套设施。
//! 2. **取消注册表**：`task_id -> 取消信号` 集中管理，取代散落在
//!    AppState 上的 `long_exec_cancel_senders`。
//! 3. **断连级联取消**：向 [`SshManager`] 注册断连观察者，会话断开时
//!    自动取消该会话上所有仍在运行的执行（`Cancelled{Disconnected}`），
//!    多会话之间互不影响——后台作业无需额外观察者即被覆盖。
//! 4. **可测性**：执行经 [`ExecTransport`] 抽象注入，单测用 mock transport，
//!    不需要真实 SSH 连接。
//!
//! 安全约定：`ticket.command` 可能含 sudo 密码，绝不进入
//! [`ExecutionRecord`] / [`ExecutionSnapshot`] / 日志——记录里只有
//! 调用方声明的 `display_command`（已截断）。

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use parking_lot::Mutex as PlMutex;
use tauri::AppHandle;
use tokio::sync::{watch, Mutex as TokioMutex};

use crate::error::AppError;
use crate::ssh::connection::SshManager;

use super::executor::{timeout_preview, ExecOutcome, ExecTransport, SshExecTransport};
use super::job::{JobInfo, JobInstance, JobOutputResult, JobStatus};
use super::ticket::{
    truncate_display, CancelReason, CommandSource, CommandTicket, ExecutionSnapshot,
    ExecutionStatus,
};

/// 保留的最近完成记录条数。
const RECENT_LIMIT: usize = 100;

/// 后台作业的执行超时兜底。作业的意义就是长周期运行（编译、下载、
/// 常驻服务），超时只作为最终保险丝；真正的停止手段是 `job_kill`
/// 或会话断连级联取消。
const BACKGROUND_JOB_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

/// 一次提交的最终结果。调用方据此映射业务事件与错误文案，
/// manager 本身不感知任何前端事件协议。
#[derive(Debug)]
pub enum SubmitOutcome {
    /// 命令正常结束（含非零退出码——与旧语义一致，由调用方从输出判断）。
    Completed { output: String },
    /// 超时（executor 已宽限关闭通道），`output` 为已收到的部分输出。
    TimedOut { output: String },
    /// 被取消（executor 已宽限关闭通道，尽力终止远端进程）。
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
    /// exec_id -> 运行中执行（前台与后台作业共用）。
    running: TokioMutex<HashMap<u64, RunningExecution>>,
    /// task_id -> exec_id（用户取消注册表）。
    by_task_id: TokioMutex<HashMap<String, u64>>,
    /// 最近完成记录（环形，新在后）。
    recent: TokioMutex<VecDeque<ExecutionRecord>>,
    /// job_id -> 后台作业状态（含输出沉淀）。作业结束后保留供
    /// `job_output` 回读与 `job_list` 查询。
    jobs: PlMutex<HashMap<String, Arc<PlMutex<JobInstance>>>>,
    next_job_num: AtomicU64,
    /// 溢出文件目录（应用配置目录下的 jobs_temp）。
    temp_dir: PathBuf,
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
    /// `temp_dir` 用于后台作业的输出溢出文件（应用配置目录下）。
    pub async fn new(ssh: SshManager, temp_dir: PathBuf) -> Self {
        let inner = Arc::new(ManagerInner {
            transport: Arc::new(SshExecTransport { ssh: ssh.clone() }),
            next_exec_id: AtomicU64::new(0),
            running: TokioMutex::new(HashMap::new()),
            by_task_id: TokioMutex::new(HashMap::new()),
            recent: TokioMutex::new(VecDeque::new()),
            jobs: PlMutex::new(HashMap::new()),
            next_job_num: AtomicU64::new(0),
            temp_dir,
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
                jobs: PlMutex::new(HashMap::new()),
                next_job_num: AtomicU64::new(0),
                temp_dir: std::env::temp_dir(),
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
            self.inner
                .by_task_id
                .lock()
                .await
                .insert(tid.clone(), exec_id);
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

        // 取消信号直达 executor：它对通道的竞争（数据 / 超时 / 取消）
        // 是 biased 且取消优先的，取消后会宽限关闭通道再返回——
        // 「取消 = 显式 close 尽力终止远端」这一语义在本层闭环。
        let outcome = match self
            .inner
            .transport
            .exec(&ticket, app, Some(&cancel_rx))
            .await
        {
            Ok(ExecOutcome::Completed { output }) => SubmitOutcome::Completed { output },
            Ok(ExecOutcome::TimedOut { output }) => SubmitOutcome::TimedOut { output },
            Ok(ExecOutcome::Cancelled { reason }) => SubmitOutcome::Cancelled { reason },
            Err(error) => SubmitOutcome::Failed { error },
        };

        let status = match &outcome {
            SubmitOutcome::Completed { .. } => ExecutionStatus::Completed,
            SubmitOutcome::TimedOut { .. } => ExecutionStatus::TimedOut,
            // 前台路径只会收到 User（界面取消）与 Disconnected；Agent/Task
            // 变体仅供后台作业与级联使用，这里穷尽映射保持 Killed 语义一致。
            SubmitOutcome::Cancelled { reason } => match reason {
                CancelReason::User | CancelReason::Agent | CancelReason::Task => {
                    ExecutionStatus::Killed
                }
                CancelReason::Disconnected => ExecutionStatus::Cancelled,
            },
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
            SubmitOutcome::Cancelled { .. } => Err(AppError::Ssh("命令已取消（会话断开）".into())),
            SubmitOutcome::Failed { error } => Err(error),
        }
    }

    /// 用户取消：按 task_id 取消一个运行中的执行。
    /// 返回是否命中（未命中 = 任务不存在或已结束），与旧
    /// `ssh_exec_long_cancel` 一致地不区分这两种情况。
    pub async fn cancel(&self, task_id: &str) -> bool {
        self.cancel_with_reason(task_id, CancelReason::User).await
    }

    /// 带终止来源的取消。来源会随 [`CancelReason`] 流入执行 worker 并
    /// 落进作业实例，`job_output` 据此区分「用户手动终止」「Agent
    /// job_kill」「任务级联取消」——不同来源绝不共用一个变体。
    /// 界面取消按钮走 [`Self::cancel`]（User）。
    pub async fn cancel_with_reason(&self, task_id: &str, reason: CancelReason) -> bool {
        let exec_id = self.inner.by_task_id.lock().await.get(task_id).copied();
        match exec_id {
            Some(id) => {
                let running = self.inner.running.lock().await;
                match running.get(&id) {
                    Some(entry) => entry.cancel_tx.send(reason).is_ok(),
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

    // ───────────────────── 后台作业（Background Jobs） ─────────────────────

    /// 提交一次后台作业：立即返回 [`JobInfo`]，命令在独立任务中执行，
    /// 输出实时沉淀到作业缓冲（环形 + 溢出文件）。
    ///
    /// 与前台 [`Self::submit`] 共用同一套设施：
    /// - 全局唯一 `exec_id`，执行记录进同一张运行表 / 最近记录；
    /// - `ticket.task_id` 注册进同一张取消注册表（Agent 任务取消即级联）；
    /// - 断连观察者级联取消自动覆盖（无需额外观察者）。
    ///
    /// 作业超时强制为 [`BACKGROUND_JOB_TIMEOUT`]——长周期是后台作业的
    /// 语义本身，调用方传来的 timeout 在此被覆盖。
    pub async fn submit_background(
        &self,
        app: Option<&AppHandle>,
        ticket: CommandTicket,
        description: Option<String>,
    ) -> Result<JobInfo, AppError> {
        let mut ticket = ticket;
        ticket.timeout = BACKGROUND_JOB_TIMEOUT;

        let exec_id = self.inner.next_exec_id.fetch_add(1, Ordering::Relaxed) + 1;
        let job_num = self.inner.next_job_num.fetch_add(1, Ordering::Relaxed) + 1;
        let job_id = format!("job_{}", job_num);

        let (cancel_tx, cancel_rx) = watch::channel(CancelReason::User);
        let (notify_tx, _) = watch::channel(0usize);

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
            self.inner
                .by_task_id
                .lock()
                .await
                .insert(tid.clone(), exec_id);
        }
        self.inner
            .running
            .lock()
            .await
            .insert(exec_id, RunningExecution { record, cancel_tx });

        let instance = Arc::new(PlMutex::new(JobInstance::new(
            job_id.clone(),
            exec_id,
            ticket.session_id.clone(),
            ticket.task_id.clone(),
            description,
            ticket.display_command.clone(),
            notify_tx,
        )));
        self.inner
            .jobs
            .lock()
            .insert(job_id.clone(), instance.clone());

        let info = instance.lock().info.clone();
        if let Some(app) = app {
            crate::emit_event(app, "job://started", &info);
        }

        let inner = self.inner.clone();
        let app_owned = app.cloned();
        tokio::spawn(run_background_worker(
            inner, app_owned, exec_id, job_id, ticket, instance, cancel_rx,
        ));

        Ok(info)
    }

    /// 读取作业增量输出。`wait=true` 时挂起等待，直到有新输出或作业
    /// 结算（`tokio::sync::watch` 通知，非忙轮询），最长等 `timeout`。
    pub async fn job_output(
        &self,
        job_id: &str,
        offset: usize,
        wait: bool,
        timeout: Duration,
    ) -> Result<JobOutputResult, AppError> {
        let instance = {
            let jobs = self.inner.jobs.lock();
            jobs.get(job_id)
                .cloned()
                .ok_or_else(|| AppError::Agent(format!("Job '{}' not found", job_id)))?
        };

        // 已完结或已有超出 offset 的新输出：立即返回
        {
            let inst = instance.lock();
            if inst.info.status != JobStatus::Running || inst.total_bytes_written > offset {
                return Ok(Self::job_output_snapshot(&inst, offset));
            }
        }

        if !wait {
            let inst = instance.lock();
            return Ok(Self::job_output_snapshot(&inst, offset));
        }

        let mut notify_rx = instance.lock().notify_tx.subscribe();
        let sleep = tokio::time::sleep(timeout);
        tokio::pin!(sleep);
        tokio::select! {
            _ = &mut sleep => {
                let inst = instance.lock();
                Ok(Self::job_output_snapshot(&inst, offset))
            }
            _ = notify_rx.changed() => {
                let inst = instance.lock();
                Ok(Self::job_output_snapshot(&inst, offset))
            }
        }
    }

    fn job_output_snapshot(inst: &JobInstance, offset: usize) -> JobOutputResult {
        let (delta, new_offset) = inst.read_output_from(offset);
        JobOutputResult {
            job_id: inst.info.job_id.clone(),
            delta,
            offset: new_offset,
            status: inst.info.status,
            cancel_reason: inst.cancel_reason,
        }
    }

    /// 终止一个后台作业。经统一取消注册表发送终止信号，执行 worker
    /// 结算状态并落账；此处幂等地先落 `killed` 并记录终止来源，让
    /// 调用方立即拿到终止后的状态（worker 后续结算为 no-op）。
    /// 作业已结束时不改动其状态，原样返回。
    ///
    /// 终止来源由调用方声明：前端「终止」按钮经 Tauri command 传
    /// [`CancelReason::User`]（真·用户手动终止）；Agent 的 `job_kill`
    /// 工具传 [`CancelReason::Agent`]。两者绝不混用。
    pub async fn kill_job(&self, job_id: &str, reason: CancelReason) -> Result<JobInfo, AppError> {
        let instance = {
            let jobs = self.inner.jobs.lock();
            jobs.get(job_id)
                .cloned()
                .ok_or_else(|| AppError::Agent(format!("Job '{}' not found", job_id)))?
        };

        let exec_id = instance.lock().exec_id;
        {
            let running = self.inner.running.lock().await;
            if let Some(entry) = running.get(&exec_id) {
                let _ = entry.cancel_tx.send(reason);
            }
        }

        let mut inst = instance.lock();
        inst.finalize_with_reason(JobStatus::Killed, Some(reason));
        Ok(inst.info.clone())
    }

    /// 列出后台作业（可选按会话 / 状态过滤），按启动时间升序。
    /// `session_id = None` 时列出全部会话的作业（前端启动恢复用）。
    pub async fn list_jobs(
        &self,
        session_id: Option<&str>,
        status_filter: Option<&str>,
    ) -> Vec<JobInfo> {
        let filter = status_filter.and_then(JobStatus::parse_filter);
        let jobs = self.inner.jobs.lock();
        let mut res = Vec::new();
        for inst_lock in jobs.values() {
            let inst = inst_lock.lock();
            if let Some(sid) = session_id {
                if inst.info.session_id != sid {
                    continue;
                }
            }
            if let Some(f) = filter {
                if inst.info.status != f {
                    continue;
                }
            }
            res.push(inst.info.clone());
        }
        drop(jobs);
        res.sort_by_key(|j| j.started_at_millis);
        res
    }

    /// 某个 agent task 名下仍在运行的后台作业。
    /// agent 循环结束守卫用它防止子 agent 留下「孤儿作业」。
    pub async fn running_jobs_for_task(&self, task_id: &str) -> Vec<JobInfo> {
        let jobs = self.inner.jobs.lock();
        jobs.values()
            .filter_map(|inst_lock| {
                let inst = inst_lock.lock();
                if inst.info.status == JobStatus::Running
                    && inst.info.task_id.as_deref() == Some(task_id)
                {
                    Some(inst.info.clone())
                } else {
                    None
                }
            })
            .collect()
    }
}

/// 后台作业执行 worker：跑 transport、把输出 chunk 沉淀进作业缓冲、
/// 处理取消竞争、结算执行记录与作业状态。
async fn run_background_worker(
    inner: Arc<ManagerInner>,
    app: Option<AppHandle>,
    exec_id: u64,
    _job_id: String,
    ticket: CommandTicket,
    instance: Arc<PlMutex<JobInstance>>,
    mut cancel_rx: watch::Receiver<CancelReason>,
) {
    let temp_dir = inner.temp_dir.clone();

    // 任何退出路径（含 panic）都保证执行记录与作业状态完成结算。
    let guard = JobFinalizeGuard {
        inner: inner.clone(),
        exec_id,
        task_id: ticket.task_id.clone(),
        instance: instance.clone(),
        temp_dir: temp_dir.clone(),
        finalized: false,
    };

    // 输出沉淀回调：同步锁 + 快速落盘，不阻塞执行循环的读取。
    let sink: super::executor::ChunkCallback = {
        let inst = instance.clone();
        let td = temp_dir.clone();
        Arc::new(move |chunk: &str| {
            inst.lock().append_output(chunk.as_bytes(), &td);
        })
    };

    // 取消信号直达 executor（见 submit_opt）：kill / 任务取消 / 断连级联
    // 都会触发通道的宽限关闭，然后以 Cancelled 结算。
    let outcome = match inner
        .transport
        .exec_observable(&ticket, app.as_ref(), sink, Some(&cancel_rx))
        .await
    {
        Ok(ExecOutcome::Completed { output }) => SubmitOutcome::Completed { output },
        Ok(ExecOutcome::TimedOut { output }) => SubmitOutcome::TimedOut { output },
        Ok(ExecOutcome::Cancelled { reason }) => SubmitOutcome::Cancelled { reason },
        Err(error) => SubmitOutcome::Failed { error },
    };

    let (exec_status, job_status, cancel_reason) = match &outcome {
        SubmitOutcome::Completed { .. } => (ExecutionStatus::Completed, JobStatus::Completed, None),
        SubmitOutcome::TimedOut { .. } => (ExecutionStatus::TimedOut, JobStatus::Failed, None),
        // 终止来源随 CancelReason 流入作业实例：User（界面终止）/
        // Agent（job_kill）/ Task（任务停止级联）→ killed 并记录来源；
        // 断连级联 → failed（会话已不存在）。执行记录沿用同一语义。
        SubmitOutcome::Cancelled { reason } => match reason {
            CancelReason::Disconnected => {
                (ExecutionStatus::Cancelled, JobStatus::Failed, Some(*reason))
            }
            r => (ExecutionStatus::Killed, JobStatus::Killed, Some(*r)),
        },
        SubmitOutcome::Failed { error } => {
            let msg = format!("\n[Error: {}]", error);
            instance.lock().append_output(msg.as_bytes(), &temp_dir);
            (ExecutionStatus::Failed, JobStatus::Failed, None)
        }
    };

    guard.finalize(exec_status, job_status, cancel_reason).await;

    if let Some(app) = &app {
        let info = instance.lock().info.clone();
        crate::emit_event(app, "job://updated", &info);
    }
}

/// 保证后台作业在任何退出路径（含 panic）都完成结算的守卫，
/// 与前台路径的 [`FinalizeGuard`] 同构。
struct JobFinalizeGuard {
    inner: Arc<ManagerInner>,
    exec_id: u64,
    task_id: Option<String>,
    instance: Arc<PlMutex<JobInstance>>,
    temp_dir: PathBuf,
    finalized: bool,
}

impl JobFinalizeGuard {
    async fn finalize(
        mut self,
        exec_status: ExecutionStatus,
        job_status: JobStatus,
        cancel_reason: Option<CancelReason>,
    ) {
        self.finalized = true;
        let task_id = self.task_id.take();
        self.inner
            .finalize_execution(self.exec_id, task_id, exec_status)
            .await;
        self.instance
            .lock()
            .finalize_with_reason(job_status, cancel_reason);
    }
}

impl Drop for JobFinalizeGuard {
    fn drop(&mut self) {
        if !self.finalized {
            // panic 路径：best-effort 异步结算为 Failed。
            let inner = self.inner.clone();
            let exec_id = self.exec_id;
            let task_id = self.task_id.take();
            let instance = self.instance.clone();
            let temp_dir = self.temp_dir.clone();
            tokio::spawn(async move {
                inner
                    .finalize_execution(exec_id, task_id, ExecutionStatus::Failed)
                    .await;
                let mut inst = instance.lock();
                inst.append_output(b"\n[Error: job worker panicked]", &temp_dir);
                inst.finalize(JobStatus::Failed);
            });
        }
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
        /// 永不返回（模拟长命令）；取消信号到达时模拟真实 transport 的
        /// 宽限关闭语义，以 Cancelled 结束。
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
            cancel: Option<&watch::Receiver<CancelReason>>,
        ) -> Result<ExecOutcome, AppError> {
            match &self.behavior {
                MockBehavior::Hang => match cancel {
                    Some(rx) => {
                        let mut rx_clone = rx.clone();
                        rx_clone
                            .changed()
                            .await
                            .map_err(|_| AppError::Ssh("取消通道已关闭".into()))?;
                        Ok(ExecOutcome::Cancelled {
                            reason: *rx.borrow(),
                        })
                    }
                    None => std::future::pending().await,
                },
                MockBehavior::Return(output, was_timeout) => Ok(if *was_timeout {
                    ExecOutcome::TimedOut {
                        output: output.to_string(),
                    }
                } else {
                    ExecOutcome::Completed {
                        output: output.to_string(),
                    }
                }),
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
        let ticket =
            CommandTicket::new("s1", "ls", CommandSource::User).cancellable("t1", "命令已取消");
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
            mgr2.submit_opt(
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
        let n = mgr
            .cancel_session("session-a", CancelReason::Disconnected)
            .await;
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

    // ─────────────── 后台作业（submit_background 统一体系） ───────────────

    /// 轮询直到作业结算（worker 在独立任务里跑，给调度留时间），
    /// 返回最终状态。
    async fn wait_for_job_settlement(
        mgr: &CommandExecutionManager,
        job_id: &str,
        session: &str,
    ) -> JobStatus {
        for _ in 0..400 {
            let jobs = mgr.list_jobs(Some(session), None).await;
            if let Some(j) = jobs.iter().find(|j| j.job_id == job_id) {
                if j.status != JobStatus::Running {
                    return j.status;
                }
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("作业未在预期时间内结算");
    }

    #[tokio::test]
    async fn background_job_completes_and_collects_output() {
        let mgr = manager(MockBehavior::Return("job output", false));
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "long-cmd", CommandSource::Agent).display_as("long-cmd"),
                Some("测试作业".into()),
            )
            .await
            .unwrap();
        assert_eq!(info.job_id, "job_1");
        assert_eq!(info.status, JobStatus::Running);
        assert_eq!(info.description, "测试作业");

        let status = wait_for_job_settlement(&mgr, &info.job_id, "s1").await;
        assert_eq!(status, JobStatus::Completed);

        // 输出经 sink 沉淀，可增量回读
        let out = mgr
            .job_output(&info.job_id, 0, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(out.delta, "job output");
        assert_eq!(out.status, JobStatus::Completed);

        // 执行记录进统一最近记录表（与前台共用）
        let snaps = mgr.snapshots().await;
        assert!(snaps.iter().any(|s| s.display_command == "long-cmd"));

        // list_jobs 反映完结状态
        let jobs = mgr.list_jobs(Some("s1"), Some("completed")).await;
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].job_id, info.job_id);
    }

    #[tokio::test]
    async fn background_job_kill_sets_killed_and_cleans_registry() {
        let mgr = manager(MockBehavior::Hang);
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "hang", CommandSource::Agent)
                    .cancellable("agent-task-1", "取消"),
                None,
            )
            .await
            .unwrap();

        let killed = mgr
            .kill_job(&info.job_id, CancelReason::Agent)
            .await
            .unwrap();
        assert_eq!(killed.status, JobStatus::Killed);

        // kill_job 同步落状态，但取消注册表的清理由 worker 异步完成——轮询之
        let mut cleaned = false;
        for _ in 0..400 {
            if !mgr.cancel("agent-task-1").await {
                cleaned = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(cleaned, "task_id 注册项应被清理");

        let status = wait_for_job_settlement(&mgr, &info.job_id, "s1").await;
        assert_eq!(status, JobStatus::Killed);

        let jobs = mgr.list_jobs(Some("s1"), Some("killed")).await;
        assert_eq!(jobs.len(), 1);

        // job_output 带出终止来源：Agent 自己 job_kill → Agent
        let out = mgr
            .job_output(&info.job_id, 0, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(out.cancel_reason, Some(CancelReason::Agent));
    }

    #[tokio::test]
    async fn background_job_task_cancel_records_task_reason() {
        let mgr = manager(MockBehavior::Hang);
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "hang", CommandSource::Agent)
                    .cancellable("agent-task-2", "取消"),
                None,
            )
            .await
            .unwrap();

        // 任务停止级联 → Task，作业状态仍为 Killed（不冒充用户终止）
        assert!(
            mgr.cancel_with_reason("agent-task-2", CancelReason::Task)
                .await
        );

        let status = wait_for_job_settlement(&mgr, &info.job_id, "s1").await;
        assert_eq!(status, JobStatus::Killed);
        let out = mgr
            .job_output(&info.job_id, 0, false, Duration::ZERO)
            .await
            .unwrap();
        assert_eq!(out.cancel_reason, Some(CancelReason::Task));
    }

    #[tokio::test]
    async fn background_job_wait_blocks_until_new_output_or_settlement() {
        let mgr = manager(MockBehavior::Return("done", false));
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "quick", CommandSource::Agent),
                None,
            )
            .await
            .unwrap();
        // wait=true：worker 结算后立即返回，不傻等满超时
        let started = std::time::Instant::now();
        let out = mgr
            .job_output(&info.job_id, 0, true, Duration::from_secs(5))
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(out.delta, "done");
        assert_eq!(out.status, JobStatus::Completed);
    }

    #[tokio::test]
    async fn background_job_failed_transport_records_error() {
        let mgr = manager(MockBehavior::Fail("boom"));
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "bad", CommandSource::Agent),
                None,
            )
            .await
            .unwrap();

        let status = wait_for_job_settlement(&mgr, &info.job_id, "s1").await;
        assert_eq!(status, JobStatus::Failed);
        let out = mgr
            .job_output(&info.job_id, 0, false, Duration::ZERO)
            .await
            .unwrap();
        assert!(
            out.delta.contains("boom"),
            "错误信息应沉淀进输出: {}",
            out.delta
        );
    }

    #[tokio::test]
    async fn job_output_unknown_id_errors() {
        let mgr = manager(MockBehavior::Return("x", false));
        let err = mgr
            .job_output("nope", 0, false, Duration::ZERO)
            .await
            .unwrap_err();
        assert!(err.to_string().contains("nope"));
    }
}
