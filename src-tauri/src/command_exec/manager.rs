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

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use parking_lot::Mutex as PlMutex;
use parking_lot::RwLock as PlRwLock;
use tauri::AppHandle;
use tokio::sync::{watch, Mutex as TokioMutex};

use crate::error::AppError;
use crate::ssh::connection::SshManager;

use super::executor::{timeout_preview, ExecExit, ExecOutcome, ExecTransport, SshExecTransport};
use super::job::{JobInfo, JobInstance, JobOutputResult, JobStatus};
use super::ledger::{JobLedgerStore, LedgerJob, RETENTION_MILLIS};
use super::ticket::{
    truncate_display, CancelReason, CommandSource, CommandTicket, ExecutionSnapshot,
    ExecutionStatus, DEFAULT_EXEC_TIMEOUT,
};

/// 保留的最近完成记录条数。
const RECENT_LIMIT: usize = 100;

/// 「没有这个作业」时的模型可读说明。
///
/// 关键是把因果说清楚：模型手里往往捏着一条历史里记着的 `job_1`，而作业的
/// 在册状态是进程内的。只说 "Job 'job_1' not found" 会让模型以为远端不
/// 存在这么个东西，进而得出「作业已完成、输出被清理了」之类的错误结论。
///
/// 到这一步时可查范围已经不止进程内存（见 `CommandExecutionManager::resolve_job`
/// 的台账回退），所以能剩下的原因只有两类。**归属不属于原因**：真属于别的对话
/// 时会在查到的瞬间被 `JobCaller::allows` 拦下、走 [`job_foreign_message`]，
/// 这里结构上到不了；把「可能是别人的作业」写进来只会把模型引到错误的
/// 方向上去（它会去猜自己是不是看错了对话）。保留期也不该写死成「只保留
/// 最近 7 天」那种说法——内存收敛几分钟就能让一条记录从列表里消失，
/// 说成「太老才没了」同样会误导。
fn job_not_found_message(job_id: &str) -> String {
    format!(
        "没有 job '{}' 的记录——本进程的在册作业表与作业台账里都查不到它。两种可能：\
         ① job_id 写错了，用 job_list 看当前有哪些（它同时列出仍在保留期内的历史作业记录）；\
         ② 它早已结算、且过了 {} 天保留期，记录连同输出文件一起被清理了\
         （保留期内即使已从内存腾出，job_output / job_status 也照样能读到）。\
         无论哪种，远端进程是否还在跑都不由本应用决定，要用 bash 执行 ps / pgrep <关键字> 才能确认。",
        job_id,
        RETENTION_MILLIS / (24 * 60 * 60 * 1000)
    )
}

/// 作业存在但不属于调用方时的模型可读说明。
///
/// 对齐 DSH 的处理方式：id 是可预测的小序号，保密性靠不住，边界靠所有权
/// ——所以这里明说「它存在，但不是你的」，而不是假装查无此作业（那会让
/// 模型以为 id 打错了而反复重试）。
fn job_foreign_message(job_id: &str) -> String {
    format!(
        "job '{}' 是另一个对话派发的作业，不属于当前对话——job_list 只列你自己那摊，\
         不要读别人的作业、也不要终止它（那可能打断另一处正在做的事）。\
         如果你在找自己派发的作业，用 job_list 看当前有哪些。",
        job_id
    )
}

/// 一次作业操作的调用方身份。
///
/// 归属围栏的意义（对齐 DSH 的 owner fencing）：`job_id` 是可预测的
/// 小序号，保密性靠不住，所以访问边界必须是"所有权"——一个对话不该
/// 读到/杀掉另一个对话派发的作业。界面与内部调用不设限（用户本来就
/// 看得到自己机器上的全部作业）。
#[derive(Clone, Copy)]
pub enum JobCaller<'a> {
    Unscoped,
    Agent {
        /// 调用方所属的**根对话**（子 agent 的作业也记在派它的那个对话名下）。
        owner_conversation_id: Option<&'a str>,
    },
}

impl JobCaller<'_> {
    fn allows(&self, info: &JobInfo) -> bool {
        match self {
            Self::Unscoped => true,
            // 拿不到归属身份（老调用路径 / 测试）时不设限，避免误伤。
            Self::Agent {
                owner_conversation_id: None,
            } => true,
            Self::Agent {
                owner_conversation_id: Some(owner),
            } => info.owned_by_conversation(owner),
        }
    }
}

/// `job_list` 的过滤条件。
pub enum JobFilter<'a> {
    /// 全部会话 / 全部对话（界面用）。
    All,
    /// 按 SSH 会话（界面按机器筛）。
    Session(&'a str),
    /// 按归属对话（agent 的 `job_list`：只要自己那摊）。
    OwnerConversation(&'a str),
}

/// 每个作业归属者同时可运行的后台作业上限。
///
/// 这是资源护栏，不是产品限制：后台作业是长周期进程，一个跑飞的模型
/// 可以在几轮里派出几十条编译 / curl / 常驻服务，把远端拖垮、把内存与
/// 溢出文件堆满。到顶时如实拒绝并告诉模型怎么腾位置（对齐 DSH 的
/// `maxConcurrentJobsPerOwner`，同样取 10）。
const MAX_RUNNING_JOBS_PER_OWNER: usize = 10;

/// 内存里保留的**已结束**作业条数上限（运行中的不受限）。
///
/// 台账保留 7 天 / 500 条，但那是磁盘；进程内存没必要跟着涨——长时间
/// 开着的应用会被一条条历史作业垒起来（每条都带着自己的输出缓冲）。
/// 超出的从最旧的开始丢，只丢内存：台账与溢出文件仍在，重启后照旧恢复，
/// 运行期读路径也会回退到台账（见 `resolve_job`），列表与回读都不受影响。
const MAX_SETTLED_JOBS_IN_MEMORY: usize = 200;

/// 后台作业的执行超时兜底。作业的意义就是长周期运行（编译、下载、
/// 常驻服务），超时只作为最终保险丝；真正的停止手段是 `job_kill`
/// 或会话断连级联取消。
const BACKGROUND_JOB_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

/// 一次提交的最终结果。调用方据此映射业务事件与错误文案，
/// manager 本身不感知任何前端事件协议。
#[derive(Debug)]
pub enum SubmitOutcome {
    /// 命令正常结束。非零退出码与「被信号打死」都不算失败（与旧语义
    /// 一致），但退出事实随 `exit` 一起交给调用方，不再从输出里猜。
    Completed { output: String, exit: ExecExit },
    /// 超时（executor 已宽限关闭通道），`output` 为已收到的部分输出。
    TimedOut { output: String },
    /// 被取消（executor 已宽限关闭通道并停止等待；远端进程不保证随之结束，
    /// 见 `executor` 模块注释）。
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
    /// 作业台账：job 序号水位（跨应用运行单调，见 [`JobLedgerStore`]）。
    ledger: Arc<JobLedgerStore>,
    /// 溢出文件目录（应用配置目录下的 jobs_temp）。
    temp_dir: PathBuf,
    /// 末条作业结算后回收任务级资源的钩子（见
    /// [`CommandExecutionManager::set_task_drain_hook`]）。`None` = 没接
    /// （单元测试、以及没有任务级子资源的宿主）。
    ///
    /// 为什么需要它：作业**活得比回合久**（对齐 DSH）——任务收尾时名下还有
    /// 作业在跑，那些资源（多机操控自动拉起的会话）必须留着给作业用；等到
    /// 末条作业结算，由这里回收。没有这个钩子，那些会话会一直挂到应用退出。
    task_drain_hook: PlRwLock<Option<Arc<dyn Fn(&str) + Send + Sync>>>,
}

impl ManagerInner {
    /// 末条作业结算 → 跑一次任务级资源回收。
    ///
    /// 还有作业在跑就先不跑：那些资源（多机自动拉起的会话）正被它们用着。
    /// 取锁顺序与全局一致（先 `jobs` 再实例），并且**在锁外**调钩子——
    /// 钩子会去碰 SSH 会话与子资源表，不能在我们的锁里做。
    fn run_task_drain_hook(&self, task_id: &Option<String>) {
        let Some(tid) = task_id.as_deref() else { return };
        let hook = self.task_drain_hook.read().clone();
        let Some(hook) = hook else { return };
        let busy = {
            let jobs = self.jobs.lock();
            jobs.values().any(|inst_lock| {
                let inst = inst_lock.lock();
                inst.info.task_id.as_deref() == Some(tid) && inst.info.status == JobStatus::Running
            })
        };
        if busy {
            return;
        }
        hook(tid);
    }

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

    /// 落「作业已结算」：状态、退出细节、抓到的输出与落点、终止来源。
    /// 结算路径（kill / worker / panic 兜底）都从这里走，台账与内存状态
    /// 不会分叉；找不到记录（记录已被清理）时静默忽略。
    ///
    /// **这里是台账唯一的结算写者，字段集必须与读路径（`recover_ledger_jobs`
    /// / `project_ledger_entry` 的投影）一一对应**：漏写一个字段不会报错，
    /// 只会在下一次应用重启后表现成「重启前的说法和重启后不一样」。
    /// 加字段时同时改 [`LedgerJob`] 与读路径，并补一条跨重启的测试。
    fn record_job_settled(&self, inst: &JobInstance) {
        let info = &inst.info;
        // 落点只在确实写下过内容时记（`JobOutputResult::spill_path` 同规矩）：
        // 溢出写作全失败（目录不可用 / 权限）时，报一个空文件或事实上不存在
        // 的路径，只会让调用方以为「完整输出在本机」。总量不受这条影响——
        // 它单独记在 `captured_bytes`（读路径用 `captured_total` 取大者），
        // 「有输出但没写进文件」因此仍然如实表现为 lossy，而不是没有输出。
        let spill_path = inst
            .spill_path()
            .map(|p| p.display().to_string())
            .filter(|_| inst.spill_bytes() > 0);
        self.ledger.update(&info.job_id, |entry| {
            entry.status = info.status;
            entry.detail = info.detail.clone();
            entry.finished_at_millis = info.finished_at_millis;
            entry.captured_bytes = info.total_output_bytes;
            entry.spill_path = spill_path.clone();
            // 终止来源（User / Agent / Task / Disconnected）：界面终止与
            // 任务级联取消的作业重启后要认得出「谁终止的」。旧实现唯独漏了
            // 这一条，于是重启后终止文案静默降级成中性的 `[status: killed]`。
            // 取实例上的值而不是调用方传参：首次结算者为准（见
            // `JobInstance::finalize_with_reason`），后续 no-op 结算不会
            // 把先落定的来源改写掉。
            entry.cancel_reason = inst.cancel_reason;
        });
    }

    /// 收敛进程内注册表的规模：已结束的作业超过上限时，从最旧的开始丢
    /// （运行中的一条都不动）。台账不受影响——历史记录与溢出文件仍在，
    /// 只是这个进程的内存里不再留着它们；重启后照样能从台账恢复，
    /// 运行期也照样读得到（`list_jobs` / `job_status` / `job_output` 会回退
    /// 到台账，见 `resolve_job`）。淘汰因此只影响内存占用与「还能不能
    /// kill」（没了通道就终止不了），不影响可读性。
    ///
    /// 调用点必须**不持有任何作业实例锁**：这里会先锁注册表再逐个锁实例，
    /// 反过来的顺序会自死锁（见 `record_job_settled` 的调用约定）。
    fn trim_settled_jobs(&self) {
        let mut jobs = self.jobs.lock();
        let mut settled: Vec<(u128, String)> = jobs
            .values()
            .filter_map(|inst_lock| {
                let inst = inst_lock.lock();
                inst.info
                    .status
                    .is_terminal()
                    .then(|| (inst.info.started_at_millis, inst.info.job_id.clone()))
            })
            .collect();
        if settled.len() <= MAX_SETTLED_JOBS_IN_MEMORY {
            return;
        }
        settled.sort_by_key(|(started, _)| *started);
        let drop_count = settled.len() - MAX_SETTLED_JOBS_IN_MEMORY;
        for (_, job_id) in settled.into_iter().take(drop_count) {
            jobs.remove(&job_id);
        }
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
    /// `temp_dir` 用于后台作业的输出溢出文件（应用配置目录下），
    /// `ledger_path` 是作业台账文件（job 序号水位）。
    pub async fn new(ssh: SshManager, temp_dir: PathBuf, ledger_path: PathBuf) -> Self {
        // 溢出目录必须在这里建：`append_output` 只会 create 文件，父目录
        // 不存在时每次写入都静默失败——回读超出内存窗口时就会既没有完整
        // 输出、又（修好前）谎报读全了。建不成就降级为「只留内存尾巴」，
        // 由 lossy 如实上报。
        if let Err(e) = std::fs::create_dir_all(&temp_dir) {
            log::warn!(
                "command_exec: 后台作业溢出目录 {} 创建失败（{}），本次运行只保留内存尾巴",
                temp_dir.display(),
                e
            );
        }
        let inner = Arc::new(ManagerInner {
            transport: Arc::new(SshExecTransport { ssh: ssh.clone() }),
            next_exec_id: AtomicU64::new(0),
            running: TokioMutex::new(HashMap::new()),
            by_task_id: TokioMutex::new(HashMap::new()),
            recent: TokioMutex::new(VecDeque::new()),
            jobs: PlMutex::new(HashMap::new()),
            ledger: Arc::new(JobLedgerStore::load(ledger_path)),
            temp_dir,
            task_drain_hook: PlRwLock::new(None),
        });
        recover_ledger_jobs(&inner);

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
    /// 台账落在系统临时目录里的一次性文件名上（每个实例一份，互不干扰），
    /// 溢出目录同样用一次性临时目录。
    pub fn with_transport(transport: Arc<dyn ExecTransport>) -> Self {
        static TEST_SEQ: AtomicU64 = AtomicU64::new(0);
        let seq = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        let base = std::env::temp_dir().join(format!(
            "marcel-cmd-test-{}-{}",
            std::process::id(),
            seq
        ));
        // **先清空再构造**：目录名是「进程 id + 本进程第几次调用」，两次运行
        // 之间会重名（操作系统会复用 pid，而某个测试排到第几个 seq 会随「同一
        // 文件里有哪些测试」漂移）。不清理的话，上一次运行留下的台账会被这次
        // 当成自己的历史读进来 —— 实测表现成「同一 session 的作业列表多出一条」，
        // 而且只在整文件一起跑时出现（单独跑就绿）。
        let _ = std::fs::remove_dir_all(&base);
        Self::with_transport_at(transport, base)
    }

    /// 与 [`Self::with_transport`] 同，但把台账与溢出目录钉在指定目录上
    /// （测试用同一目录构造两次即可模拟「应用重启」）。
    pub fn with_transport_at(transport: Arc<dyn ExecTransport>, base: PathBuf) -> Self {
        let temp_dir = base.join("jobs_temp");
        let _ = std::fs::create_dir_all(&temp_dir);
        let inner = Arc::new(ManagerInner {
            transport,
            next_exec_id: AtomicU64::new(0),
            running: TokioMutex::new(HashMap::new()),
            by_task_id: TokioMutex::new(HashMap::new()),
            recent: TokioMutex::new(VecDeque::new()),
            jobs: PlMutex::new(HashMap::new()),
            ledger: Arc::new(JobLedgerStore::load(base.join("jobs.json"))),
            temp_dir,
            task_drain_hook: PlRwLock::new(None),
        });
        recover_ledger_jobs(&inner);
        Self { inner }
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
        // 「取消 = 停止等待并关闭通道」这一语义在本层闭环；远端进程是否
        // 随之结束不由我们决定（见 executor 模块注释）。
        let outcome = match self
            .inner
            .transport
            .exec(&ticket, app, Some(&cancel_rx))
            .await
        {
            Ok(ExecOutcome::Completed { output, exit }) => SubmitOutcome::Completed { output, exit },
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
                CancelReason::User
                | CancelReason::Agent
                | CancelReason::Task
                | CancelReason::RuntimeRestart => ExecutionStatus::Killed,
                CancelReason::Disconnected => ExecutionStatus::Cancelled,
            },
            SubmitOutcome::Failed { .. } => ExecutionStatus::Failed,
        };
        guard.finalize(status).await;
        outcome
    }

    /// 便捷入口：等价旧 `SshManager::exec_command`（[`DEFAULT_EXEC_TIMEOUT`]
    /// 即 120s 超时，超时错误文案一致），但会登记执行记录。适用于内部短命令
    /// （压缩前检查、解压探测等）。
    pub async fn exec_simple(
        &self,
        app: &AppHandle,
        session_id: &str,
        command: &str,
        source: CommandSource,
    ) -> Result<String, AppError> {
        self.exec_simple_with_timeout(app, session_id, command, source, DEFAULT_EXEC_TIMEOUT)
            .await
    }

    /// 同 [`Self::exec_simple`]，但允许调用方显式指定超时。
    ///
    /// 长周期系统任务（远端压缩 / 解压 / 快速删除等）必须覆写默认 120s——
    /// 大文件夹/大压缩包在慢服务器上的解压可能远超 120s，停留在默认值会
    /// 让 UI 在任务中途误报「命令在 120 秒后超时」。参考
    /// [`super::ticket::DEFAULT_EXEC_TIMEOUT`] 的约定。
    pub async fn exec_simple_with_timeout(
        &self,
        app: &AppHandle,
        session_id: &str,
        command: &str,
        source: CommandSource,
        timeout: Duration,
    ) -> Result<String, AppError> {
        self.exec_simple_with_timeout_opt(Some(app), session_id, command, source, timeout)
            .await
    }

    /// 同 [`Self::exec_simple_with_timeout`]，但允许无 AppHandle（测试 /
    /// 无流式输出场景），与 [`Self::submit_opt`] 对应。
    pub(crate) async fn exec_simple_with_timeout_opt(
        &self,
        app: Option<&AppHandle>,
        session_id: &str,
        command: &str,
        source: CommandSource,
        timeout: Duration,
    ) -> Result<String, AppError> {
        let ticket = CommandTicket::new(session_id, command, source).timeout(timeout);
        match self.submit_opt(app, ticket).await {
            SubmitOutcome::Completed { output, .. } => Ok(output),
            SubmitOutcome::TimedOut { .. } => Err(AppError::Ssh(format!(
                "命令在 {} 秒后超时: {}",
                timeout.as_secs(),
                timeout_preview(command)
            ))),
            // ticket 无 task_id，只有断连级联会走到这里。
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

        // 并发准入：按归属者（同一 SSH 会话）计运行中的作业。到顶如实拒绝，
        // 并把「怎么腾位置」说给模型听。
        {
            let running = self.count_running_jobs(&ticket.session_id);
            if running >= MAX_RUNNING_JOBS_PER_OWNER {
                return Err(AppError::Agent(format!(
                    "后台作业并发已达上限（{}，当前会话已有 {} 个在运行）：先用 job_list 看一眼、job_kill 掉不再需要的作业，或等某个作业结束再派新的，不要靠重复派发硬挤。",
                    MAX_RUNNING_JOBS_PER_OWNER, running
                )));
            }
        }

        let exec_id = self.inner.next_exec_id.fetch_add(1, Ordering::Relaxed) + 1;
        // 序号来自落盘台账：跨应用运行单调递增，旧 job_id 永不复用
        // （模型的历史里可能一直记着上一次运行的 job_1）。
        let job_num = self.inner.ledger.allocate_job_num();
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
            ticket.owner_conversation_id.clone(),
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
        // 台账先落「谁派了什么」：进程随即崩掉也认得出这条作业。
        self.record_job_started(&info);

        let inner = self.inner.clone();
        let app_owned = app.cloned();
        tokio::spawn(run_background_worker(
            inner, app_owned, exec_id, job_id, ticket, instance, cancel_rx,
        ));

        Ok(info)
    }

    /// 读取作业增量输出。`wait=true` 时挂起等待，直到有新输出或作业
    /// 结算（`tokio::sync::watch` 通知，非忙轮询），最长等 `timeout`。
    ///
    /// 读到终态即视为「这条作业的结局已经被消费」，置位 `settled_notified`
    /// ——与 DSH 的 `reported` 同义：读取方已经知道结果，系统不必再为它
    /// 注入一条「作业已完成」通知（那会白花一轮模型请求）。
    ///
    /// 内存里找不到时回退台账（见本文件 `resolve_job`）：已结算、已从
    /// 内存腾出的作业在保留期内照样读得到。这类回退没有活着的通道，
    /// `wait` 对它不生效，立即返回当前能读到的部分。
    pub async fn job_output(
        &self,
        job_id: &str,
        offset: usize,
        wait: bool,
        timeout: Duration,
        caller: JobCaller<'_>,
    ) -> Result<JobOutputResult, AppError> {
        let (instance, from_ledger) = self.resolve_job(job_id, caller)?;
        if from_ledger {
            // 台账投影：没有通道可等、没有取消可发，作业也早已结算——直接
            // 给当前能读到的部分，不占用调用方的超时。
            let inst = instance.lock();
            return Ok(Self::job_output_snapshot(&inst, offset));
        }

        // 已完结或已有超出 offset 的新输出：立即返回
        {
            let mut inst = instance.lock();
            if inst.info.status != JobStatus::Running {
                inst.settled_notified = true;
                return Ok(Self::job_output_snapshot(&inst, offset));
            }
            if inst.total_bytes_written > offset {
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
                let mut inst = instance.lock();
                // 等待超时：job 可能已结算（通知刚错过）——如实返回，
                // 由调用方（模型 job_output）自行判断；若已结算则视为
                // 已被看到，标记 notified 防系统重复注入。
                if inst.info.status != JobStatus::Running {
                    inst.settled_notified = true;
                }
                Ok(Self::job_output_snapshot(&inst, offset))
            }
            _ = notify_rx.changed() => {
                let mut inst = instance.lock();
                // 新输出或结算到达。若已结算（模型主动 wait 等到结果），
                // 标记 notified——等价 DSH reported：等待方已消费结算，
                // 不再需要额外的「作业已完成」系统通知。
                if inst.info.status != JobStatus::Running {
                    inst.settled_notified = true;
                }
                Ok(Self::job_output_snapshot(&inst, offset))
            }
        }
    }

    /// 只读地看一眼作业当前状态，不消费输出、不改动任何读取游标
    /// （对齐 DSH 的 `get()`：快照是只读投影）。与 [`Self::job_output`]
    /// 同规矩：内存未命中就回退台账，两个读路径对同一作业不许给出
    /// 两个答案（否则「界面说还在、工具说查无此作业」）。
    ///
    /// 本函数不做归属围栏（调用方是按 id 的内部探测，不是工具入口），
    /// 与内存路径的既有语义一致。
    pub async fn job_status(&self, job_id: &str) -> Result<JobStatus, AppError> {
        let in_memory = {
            let jobs = self.inner.jobs.lock();
            jobs.get(job_id).cloned()
        };
        if let Some(inst) = in_memory {
            return Ok(inst.lock().info.status);
        }
        self.inner
            .ledger
            .entry(job_id)
            .map(|entry| {
                let spill_file_len = spill_file_len(entry.spill_path.as_deref().map(Path::new));
                project_ledger_info(&entry, spill_file_len).status
            })
            .ok_or_else(|| AppError::Agent(job_not_found_message(job_id)))
    }

    /// 定位一个作业：优先本进程在册表，未命中则回退台账。
    ///
    /// 为什么要回退：`trim_settled_jobs` 只是把**已结算**作业从进程内存里
    /// 腾出去（台账记录与溢出文件都还在保留期内），读路径只看内存的话，
    /// 「记录明明还在、只是内存腾了」就会表现成「查无此作业」——与
    /// 「重启后照样能从台账恢复」的设计自相矛盾。
    ///
    /// 返回的 `bool` 说明这是不是台账投影。投影是**只读**的：
    /// - 绝不进 `jobs` 注册表（否则内存收敛就白做了），因此不能被 kill
    ///   （没有取消通道），也不会给任何 task 注入结算通知；
    /// - 状态里不可能出现 `running`——本进程在册表里没有它的作业，
    ///   不可能是这次运行还在跑的作业（`running` 只是上次运行没结算完
    ///   的痕迹，按 `interrupted` 呈现）。
    ///
    /// 归属围栏对两条路径一视同仁，且都在**查到之后**才判：真属于别的
    /// 对话的作业走 [`job_foreign_message`]（明说「不是你的」），而不是
    /// 假装查无此作业（那会让模型以为 id 打错而反复重试）。
    fn resolve_job(
        &self,
        job_id: &str,
        caller: JobCaller<'_>,
    ) -> Result<(Arc<PlMutex<JobInstance>>, bool), AppError> {
        let in_memory = {
            let jobs = self.inner.jobs.lock();
            jobs.get(job_id).cloned()
        };
        if let Some(instance) = in_memory {
            if !caller.allows(&instance.lock().info) {
                return Err(AppError::Agent(job_foreign_message(job_id)));
            }
            return Ok((instance, false));
        }
        if let Some(entry) = self.inner.ledger.entry(job_id) {
            let projected = Arc::new(PlMutex::new(project_ledger_entry(
                &entry,
                spill_file_len(entry.spill_path.as_deref().map(Path::new)),
            )));
            if !caller.allows(&projected.lock().info) {
                return Err(AppError::Agent(job_foreign_message(job_id)));
            }
            return Ok((projected, true));
        }
        Err(AppError::Agent(job_not_found_message(job_id)))
    }

    // ───────────────────────── 台账读写 ─────────────────────────

    /// 落「作业已派发」。
    fn record_job_started(&self, info: &JobInfo) {
        self.inner.ledger.upsert(LedgerJob {
            job_id: info.job_id.clone(),
            session_id: info.session_id.clone(),
            owner_conversation_id: info.owner_conversation_id.clone(),
            task_id: info.task_id.clone(),
            description: info.description.clone(),
            command: info.command.clone(),
            status: info.status,
            detail: info.detail.clone(),
            started_at_millis: info.started_at_millis,
            finished_at_millis: info.finished_at_millis,
            captured_bytes: info.total_output_bytes,
            // 溢出文件名是确定性的，派发时就写进台账：应用在作业跑着时
            // 退出，重启后才有路径把「退出前抓到的输出」找回来。
            spill_path: Some(
                self.inner
                    .temp_dir
                    .join(super::job::spill_file_name(
                        &info.job_id,
                        info.started_at_millis,
                    ))
                    .display()
                    .to_string(),
            ),
            cancel_reason: None,
        });
    }

    fn job_output_snapshot(inst: &JobInstance, offset: usize) -> JobOutputResult {
        let read = inst.read_output_from(offset);
        JobOutputResult {
            job_id: inst.info.job_id.clone(),
            delta: read.text,
            offset: read.next_offset,
            // 本次返回的文本在整个输出流里的起始偏移（丢内容时文本从更靠后的
            // 位置开始，不等于调用方传进来的 offset——调用方据此知道读到的是
            // 哪一段）。原样透传 job 层的读数，本层不重算。
            text_start_offset: read.text_start_offset,
            status: inst.info.status,
            cancel_reason: inst.cancel_reason,
            detail: inst.info.detail.clone(),
            lossy: read.lossy,
            skipped_bytes: read.skipped_bytes,
            spill_path: inst
                .spill_path()
                .map(|p| p.display().to_string())
                .filter(|_| inst.spill_bytes() > 0),
        }
    }

    /// 某会话名下仍在运行的后台作业数（并发准入用）。恢复出来的历史作业
    /// 不算——它们没有可挤占的通道。
    fn count_running_jobs(&self, session_id: &str) -> usize {
        let jobs = self.inner.jobs.lock();
        jobs.values()
            .filter(|inst_lock| {
                let inst = inst_lock.lock();
                inst.info.status == JobStatus::Running && inst.info.session_id == session_id
            })
            .count()
    }

    /// 停止并清理某 task 的结算通知通道——任务被停止/取消时调用，
    /// 让挂起中的 agent loop 立即醒来并以取消收场（而不是永久挂起）。
    /// 同时取消该 task 名下所有运行中作业（任务停止的级联语义，与
    /// `cancel_with_reason(.., Task)` 一致，但覆盖**全部**运行作业，
    /// 而非仅注册表里最后一条 exec）。
    pub async fn cancel_task_jobs(&self, task_id: &str) -> usize {
        let mut killed = 0usize;
        let job_ids: Vec<String> = {
            let jobs = self.inner.jobs.lock();
            jobs.iter()
                .filter_map(|(jid, inst_lock)| {
                    let inst = inst_lock.lock();
                    if inst.info.task_id.as_deref() == Some(task_id)
                        && inst.info.status == JobStatus::Running
                    {
                        Some(jid.clone())
                    } else {
                        None
                    }
                })
                .collect()
        };
        for jid in job_ids {
            if let Ok(info) = self
                .kill_job(&jid, CancelReason::Task, JobCaller::Unscoped)
                .await
            {
                if info.status == JobStatus::Killed {
                    killed += 1;
                }
            }
        }
        // 每个 kill 自己会跑一次任务级资源回收（见 `set_task_drain_hook`）；
        // 这里补一次兜底：一件都没杀成（作业已在别处结算）时也要回收。
        self.run_task_drain_hook(&Some(task_id.to_string()));
        killed
    }

    /// 终止一个后台作业。向**仍在运行表里**的 exec 发送终止信号，随后**同步**落
    /// 一次 `killed` + 终止来源，让调用方不必等 worker 醒来就能拿到终止后的状态
    /// 并落账；exec 已经不在运行表里时只如实返回记录，不改任何状态（见下）。
    ///
    /// 谁先落定谁的结算生效（[`JobInstance::finalize_with_reason`] 的
    /// 「先到者为准」）——**「后到的 kill 赢」是不成立的**：
    ///
    /// - 作业本来就已经结算（Completed / Failed）：这次调用连状态都不改，
    ///   原样返回（调用方据此看到「它早就结束了，kill 没生效」，而不是被
    ///   谎报成刚被终止）。
    /// - exec 已不在运行表：worker 的收尾顺序是「先把 exec 摘出 `running`、
    ///   再落实例终态」，夹在这两步之间的微秒窗口里实例**还是** `Running`
    ///   ——这一刻的先到者是 worker（它手里拿着这次执行的真实结果），所以
    ///   这里同样不落 `Killed`，原样返回。否则一条其实已经成功结束的作业会
    ///   被记成被终止，而且实例已是终态，worker 随后那份带退出细节的结算会被
    ///   幂等挡掉，退出事实一并丢掉。worker 转瞬就会落定真实终态（exec 一旦
    ///   离开运行表，它就是本进程里唯一还在写这条作业的人），调用方稍后从
    ///   `job_status` / `job_output` 看到的是真实结果。
    ///
    /// 竞争期间终止来源不会分叉：两个结算路径携带的是
    /// 同一个 `CancelReason`，先落定者写进实例，后到的 no-op 不会改写它；
    /// 台账的 `cancel_reason` 就取实例上的值（见 `record_job_settled`），
    /// 因此重启后读到的来源与本次调用传的 reason 一致。
    ///
    /// 终止来源由调用方声明：前端「终止」按钮经 Tauri command 传
    /// [`CancelReason::User`]（真·用户手动终止）；Agent 的 `job_kill`
    /// 工具传 [`CancelReason::Agent`]。两者绝不混用。
    ///
    /// 内存里没有、台账里还有的作业（内存收敛腾出的、或上一次运行留下的）
    /// **返回原样记录而不是报错**：它就在 `job_list` 里列着，报「查无此作业」
    /// 只会让调用方（界面按钮 / job_kill 工具）以为 id 打错了。这本进程没有
    /// 它的通道，终止不了，返回的记录说明它早已结算。
    pub async fn kill_job(
        &self,
        job_id: &str,
        reason: CancelReason,
        caller: JobCaller<'_>,
    ) -> Result<JobInfo, AppError> {
        let (instance, from_ledger) = self.resolve_job(job_id, caller)?;
        if from_ledger {
            // 台账投影：没有取消通道可发，也没有状态可改（它不在这次运行
            // 的在册表里）。
            return Ok(instance.lock().info.clone());
        }

        let exec_id = instance.lock().exec_id;
        // exec 还在运行表里 = 这条作业确实还有可取消的通道（信号发进去，
        // executor 的取消竞争会宽限关闭通道）；不在 = worker 已经收完了它的
        // 尾（先摘 exec、再落实例终态，见 `JobFinalizeGuard::finalize`），这一刻
        // 不该再由 kill 落 `Killed`——理由见本函数文档的「先到者为准」。
        // 台账恢复出来的作业也走这条路（exec_id 为 0、实例早是终态），返回的
        // 是它原来的记录，与从前那个必然 no-op 的结算结果一致。
        let exec_in_flight = {
            let running = self.inner.running.lock().await;
            match running.get(&exec_id) {
                Some(entry) => {
                    let _ = entry.cancel_tx.send(reason);
                    true
                }
                None => false,
            }
        };
        if !exec_in_flight {
            return Ok(instance.lock().info.clone());
        }

        let mut inst = instance.lock();
        inst.finalize_with_reason(JobStatus::Killed, Some(reason));
        // Agent 自己 job_kill：工具结果已经把「已终止 + 远端进程不保证结束」
        // 说全了，系统不必再注入一条「作业已终止」通知（那会白花一轮）。
        // 界面用户终止 / 任务级联不同——那是别人动的手，模型必须被告知。
        if reason == CancelReason::Agent {
            inst.settled_notified = true;
        }
        let task_id = inst.info.task_id.clone();
        self.inner.record_job_settled(&inst);
        drop(inst);
        // kill 也是一种结算：末条作业被杀同样要回收任务级资源（见
        // `with_task_drain_hook`），否则多机自动拉起的会话会挂到应用退出。
        self.run_task_drain_hook(&task_id);
        let info = instance.lock().info.clone();
        drop(instance);
        self.inner.trim_settled_jobs();
        Ok(info)
    }

    /// 列出后台作业（可选按会话 / 归属对话 / 状态过滤），按启动时间升序。
    ///
    /// [`JobFilter::OwnerConversation`] 是 agent 的 `job_list` 用的：只要
    /// 自己那个对话（含它派发的子 agent）派出去的作业——**包括上一次应用
    /// 运行留下的**（从台账恢复的 `interrupted` 记录），这正是重启后模型
    /// 不懵的关键。归属为空的旧记录不设限，任何过滤条件都能看到。
    ///
    /// 数据来自两处：本进程在册表 + **在册表已腾出但台账仍在保留期内**的
    /// 记录（内存收敛不是删除）。两条来源共用同一套过滤与状态投影，
    /// 否则同一批数据会在「内存里」与「台账里」之间分叉出两种答案；
    /// 台账投影不可能显示成 `running`（见 `resolve_job`）。
    pub async fn list_jobs(&self, filter: JobFilter<'_>, status_filter: Option<&str>) -> Vec<JobInfo> {
        let status = status_filter.and_then(JobStatus::parse_filter);
        let mut res = Vec::new();
        let mut in_memory: HashSet<String> = HashSet::new();
        {
            let jobs = self.inner.jobs.lock();
            for inst_lock in jobs.values() {
                let inst = inst_lock.lock();
                // 在册表全体先登记 id：台账回退按 id 去重，同一条作业绝不
                // 列两遍（在册表里的那份才是权威视图）。
                in_memory.insert(inst.info.job_id.clone());
                if job_matches(&inst.info, &filter, status) {
                    res.push(inst.info.clone());
                }
            }
        }
        for entry in self.inner.ledger.entries() {
            if in_memory.contains(&entry.job_id) {
                continue;
            }
            let info = project_ledger_info(
                &entry,
                spill_file_len(entry.spill_path.as_deref().map(Path::new)),
            );
            if job_matches(&info, &filter, status) {
                res.push(info);
            }
        }
        res.sort_by_key(|j| j.started_at_millis);
        res
    }

    /// 某个 agent task 名下仍在运行的后台作业。
    ///
    /// 现在的用处是「作业活得比回合久」那条新语义：任务收尾时用它区分
    /// ——还有作业在跑的会话留着（作业还得用），没有的照常回收
    /// （见 `agent::manager::finalize_task` 与 `multi_host::cleanup_task_targets_except`）。
    /// 它按 `task_id` 问，所以只回答「这一轮派的作业」；跨轮的作业属于会话
    /// （见 [`JobFilter::OwnerConversation`]）。
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

    /// 取出某 task 名下**已结算、尚未通知过**的作业列表（取出即标记
    /// notified）。agent loop 在自然结束守卫里调用：模型还在跑，就把刚
    /// 结算的结局当场注入下一轮，让它读进结论（DSH 的 busy-owner 注入）。
    /// 返回按启动时间升序（先结算的先注入）。
    ///
    /// 只按 `task_id` 取：这是**同一轮之内**的通知路径。一轮结束后才结算的
    /// 作业属于「唤醒」路径，按会话取，见 [`Self::pending_job_notices`]。
    pub fn take_settled_jobs_for_task(&self, task_id: &str) -> Vec<JobInfo> {
        let jobs = self.inner.jobs.lock();
        let mut settled: Vec<JobInfo> = Vec::new();
        for inst_lock in jobs.values() {
            let mut inst = inst_lock.lock();
            if inst.info.task_id.as_deref() != Some(task_id) || inst.settled_notified {
                continue;
            }
            if inst.info.status == JobStatus::Running {
                continue;
            }
            inst.settled_notified = true;
            settled.push(inst.info.clone());
        }
        drop(jobs);
        settled.sort_by_key(|j| j.started_at_millis);
        settled
    }

    /// 接上「末条作业结算后回收任务级资源」的钩子。
    ///
    /// 由宿主（`lib.rs`）在构造之后调用一次，接的是多机操控的会话回收：
    /// 任务收尾时若名下还有作业在跑，那些自动拉起的会话**不能**关（关了会
    /// 连坐杀掉作业），留给这个钩子在末条作业结算时收尾。
    ///
    /// 钩子拿不到锁、也拿不到 app handle：它只收到 `task_id`，自己去
    /// `AppState` 取需要的东西（闭包在 `lib.rs` 里捕获 state 即可）——
    /// 这样 command_exec 不必知道多机操控、也不必知道应用状态长什么样。
    pub fn set_task_drain_hook(&self, hook: Arc<dyn Fn(&str) + Send + Sync>) {
        *self.inner.task_drain_hook.write() = Some(hook);
    }

    /// 某会话名下**该告知模型、但还没告知过**的作业（按启动时间升序）。
    ///
    /// 「唤醒」路径的读取端：这一轮已经收尾了，作业才结算 —— 按会话（而不是
    /// task_id，它每轮都换）找出这些结局，交给前端自动开一轮投递。
    ///
    /// **只读**：不置 `settled_notified`。真的把告知交给模型之后由
    /// [`Self::ack_job_notices`] 确认 —— 少了这一步，一次「问了但没送出去」
    /// （会话已关、应用正在退）就会把结局吞掉，模型再也等不到通知。
    ///
    /// **只收自然结束的**（对齐 DSH 的 `reported`）：完成 / 真正的执行失败。
    /// 凡是带终止来源的（用户掐的、任务停止带走的、会话断开杀的、重启中断的）
    /// 都不在这里 —— 那些结局要么是用户自己干的，要么唤醒也没用（会话都没了），
    /// 为它们开一轮只会白花一次模型请求。它们的结局仍可从 `job_list` /
    /// `job_output` 读到，模型下次开口时会顺带知道（见 [`Self::list_jobs`]）。
    pub fn pending_job_notices(&self, conversation_id: &str) -> Vec<JobInfo> {
        let mut out: Vec<JobInfo> = Vec::new();
        let jobs = self.inner.jobs.lock();
        for inst_lock in jobs.values() {
            let inst = inst_lock.lock();
            if inst.settled_notified
                || inst.cancel_reason.is_some()
                || inst.info.status == JobStatus::Running
                // **精确匹配**，不用 `owned_by_conversation`：那个谓词把「无归属」
                // 作业当成对任何调用方可见（读路径的宽容语义），拿它做唤醒会让
                // 同一条无归属作业去叫醒**每一条**会话，而且谁先问谁先醒 —— 很
                // 可能是错的会话。无归属 = 旧记录 / 界面直接派发的作业，没有该
                // 通知的对象，不唤醒。
                || inst.info.owner_conversation_id.as_deref() != Some(conversation_id)
            {
                continue;
            }
            out.push(inst.info.clone());
        }
        out.sort_by_key(|j| j.started_at_millis);
        // 只看在册表：台账没有「播报过没有」这一列，而**从台账恢复的作业一律
        // 已置 reported**（见 `JobInstance::restore`）——上一次应用运行留下的
        // 结局绝不该被当成「刚要告诉你的新结果」再播一遍。
        out
    }

    /// 确认这些作业的结局已经交给模型（置 `settled_notified`，等价 DSH 的
    /// `reported`）。返回真的被确认的条数（已被别的路径消费的不算）。
    pub fn ack_job_notices(&self, job_ids: &[String]) -> usize {
        let jobs = self.inner.jobs.lock();
        let mut acked = 0usize;
        for id in job_ids {
            if let Some(inst_lock) = jobs.get(id) {
                let mut inst = inst_lock.lock();
                if !inst.settled_notified {
                    inst.settled_notified = true;
                    acked += 1;
                }
            }
        }
        acked
    }

    /// 给 ManagerInner 用：末条作业结算后跑一次任务级资源回收（无钩子/无
    /// task_id 时是空操作）。
    fn run_task_drain_hook(&self, task_id: &Option<String>) {
        self.inner.run_task_drain_hook(task_id)
    }
}

/// 溢出文件**当前**的字节数（文件不存在 / 读不到按 0）。
///
/// 刻意与台账里的 `captured_bytes` 分开取名：一个是「抓到的总量」（只由
/// 结算写入，可能大于文件长度），一个是「文件现在有多长」（只是前者的
/// 下界）。两者谁也不能顶替谁，最终值由 [`LedgerJob::captured_total`] 取大者。
fn spill_file_len(path: Option<&Path>) -> usize {
    path.and_then(|p| std::fs::metadata(p).ok())
        .map(|m| m.len() as usize)
        .unwrap_or(0)
}

/// 一套过滤条件同时适用于在册实例与台账投影——两处必须一致，否则同一批
/// 数据会在「内存里看得到」与「台账里看得到」之间分叉。
fn job_matches(info: &JobInfo, filter: &JobFilter<'_>, status: Option<JobStatus>) -> bool {
    let owner_match = match filter {
        JobFilter::All => true,
        JobFilter::Session(sid) => info.session_id == *sid,
        JobFilter::OwnerConversation(conv) => info.owned_by_conversation(conv),
    };
    owner_match && status.map_or(true, |f| info.status == f)
}

/// 台账记录 → 只读作业元数据。启动恢复与运行期回退共用同一套投影规则：
///
/// - `total_output_bytes` 取台账计数与溢出文件长度的较大者
///   （见 [`LedgerJob::captured_total`]）；
/// - 本进程在册表里没有它的 `running` 记录，一律呈现成 `interrupted`：
///   通道随进程消失，之后的输出再也读不到。**这一条不能少**——否则一条
///   上次运行留下的 `running` 记录会在 `job_list` 里冒充「还在跑」，
///   而它既不会结算、也没有通道可等。
fn project_ledger_info(entry: &LedgerJob, spill_file_len: usize) -> JobInfo {
    let mut info = entry.to_info(spill_file_len);
    if info.status == JobStatus::Running {
        info.status = JobStatus::Interrupted;
        // 中断不编造退出码之类的细节（展示层有专门的 interrupted 文案）。
        info.detail = None;
    }
    info
}

/// [`project_ledger_info`] 之上再补出可回读的只读作业视图（不进注册表）。
///
/// `captured` 直接取 `info.total_output_bytes`：它就是
/// [`LedgerJob::captured_total`] 的结果，`JobInstance::restore` 拿它当
/// 「已抓总量 + 已落盘量」，与元数据天然同源，不会出现「列表说 8MB、
/// 读起来只有 4 字节」这种两套账。
fn project_ledger_entry(entry: &LedgerJob, spill_file_len: usize) -> JobInstance {
    let info = project_ledger_info(entry, spill_file_len);
    let cancel_reason = if entry.status == JobStatus::Running {
        Some(CancelReason::RuntimeRestart)
    } else {
        entry.cancel_reason
    };
    // 落点只在文件里确实有内容时才给：报一个不存在/空文件的路径，会让
    // 调用方（与模型）以为「完整输出在本机」——与 record_job_settled 的
    // 过滤条件同一规矩。
    let spill_path = if spill_file_len > 0 {
        entry.spill_path.as_deref().map(PathBuf::from)
    } else {
        None
    };
    let captured = info.total_output_bytes;
    JobInstance::restore(info, spill_path, captured, cancel_reason)
}

/// 启动恢复：把台账里的作业装回注册表，顺手清理过期的记录与孤儿溢出文件。
///
/// 这一步是「重启后 agent 不懵」的全部实现：
/// - 上一次运行**没结算完**的作业一律恢复成 [`JobStatus::Interrupted`]
///   （通道随进程没了，之后的输出再也读不到；远端进程是否还在跑无从得知）；
/// - 已结算的作业保持原状态与退出细节；
/// - 两者都带着「退出前抓到的输出」——溢出文件还在硬盘上，回读直接走它。
///
/// 恢复的作业 `settled_notified` 已置位：它们绝不该给这一轮的对话注入
/// 「作业已完成」通知（那是上一次运行的事）。
fn recover_ledger_jobs(inner: &ManagerInner) {
    let entries = inner.ledger.entries();
    if entries.is_empty() {
        // 没有作业记录也要清一次孤儿溢出文件（可能来自更早版本或写失败）。
        sweep_orphan_spill_files(inner, &HashSet::new());
        return;
    }
    let now = now_millis();
    let mut recovered: HashSet<PathBuf> = HashSet::new();
    {
        let mut jobs = inner.jobs.lock();
        for entry in &entries {
            // 溢出文件的实际长度只是「抓到多少」的下界（可能被 MAX_SPILL_BYTES
            // 截断、写入中途失败、或被外部清掉）：真正的「一共抓到多少」由
            // `LedgerJob::captured_total` 在台账计数与文件长度之间取大者决定，
            // 这里只负责把文件长度读出来交给它。
            let spill_file_len = spill_file_len(entry.spill_path.as_deref().map(Path::new));
            if spill_file_len > 0 {
                if let Some(path) = entry.spill_path.as_deref() {
                    recovered.insert(PathBuf::from(path));
                }
            }

            let inst = project_ledger_entry(entry, spill_file_len);
            let job_id = inst.info.job_id.clone();
            // 把「中断」这个结论落回台账：否则每次重启都会重新判一次，
            // 而且记录会一直显示成 running。
            if inst.info.status != entry.status {
                let status = inst.info.status;
                let detail = inst.info.detail.clone();
                let reason = inst.cancel_reason;
                inner.ledger.update(&job_id, |j| {
                    j.status = status;
                    j.detail = detail;
                    j.cancel_reason = reason;
                });
            }
            jobs.insert(job_id, Arc::new(PlMutex::new(inst)));
        }
    }
    log::info!(
        "command_exec: 从台账恢复 {} 条历史作业（其中 {} 条在应用退出时被打断）",
        entries.len(),
        entries
            .iter()
            .filter(|e| e.status == JobStatus::Running)
            .count()
    );

    // 清理：过期记录（连带溢出文件）+ 没有任何记录指向的孤儿溢出文件。
    let mut keep_paths: HashSet<PathBuf> = recovered;
    for entry in inner.ledger.entries() {
        if let Some(path) = entry.spill_path.as_deref() {
            keep_paths.insert(PathBuf::from(path));
        }
    }
    for path in inner.ledger.prune(now) {
        remove_file_quietly(Path::new(&path));
    }
    sweep_orphan_spill_files(inner, &keep_paths);
}

/// 删掉 `temp_dir` 里没有台账记录指向、且已超过保留期与当前运行无关的
/// 溢出文件（历史遗留 / 台账损坏后留下的）。启动时跑，此刻不存在本进程
/// 正在写的文件，所以按年龄筛是安全的。
fn sweep_orphan_spill_files(inner: &ManagerInner, keep: &HashSet<PathBuf>) {
    let dir = &inner.temp_dir;
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now();
    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("marcel-job-") || !name.ends_with(".log") {
            continue;
        }
        if keep.contains(&path) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age.as_millis() > RETENTION_MILLIS);
        if stale {
            remove_file_quietly(&path);
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!("command_exec: 清理 {} 个过期的作业输出文件", removed);
    }
}

fn remove_file_quietly(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => log::warn!("command_exec: 删除作业输出文件 {} 失败: {}", path.display(), e),
    }
}

fn now_millis() -> u128 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
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

    // 任何退出路径（含 panic）都保证三件事一起收尾：执行记录、作业状态、
    // 台账记录。缺任何一样都会让同一个作业出现两三个互相矛盾的答案
    // （内存 failed / 盘上 running / 重启后 interrupted），见 JobFinalizeGuard。
    let guard = JobFinalizeGuard {
        inner: inner.clone(),
        app: app.clone(),
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
        Ok(ExecOutcome::Completed { output, exit }) => SubmitOutcome::Completed { output, exit },
        Ok(ExecOutcome::TimedOut { output }) => SubmitOutcome::TimedOut { output },
        Ok(ExecOutcome::Cancelled { reason }) => SubmitOutcome::Cancelled { reason },
        Err(error) => SubmitOutcome::Failed { error },
    };

    let (exec_status, job_status, cancel_reason, detail) = match &outcome {
        // 非零退出码与「被信号打死」都算正常结束（与旧语义一致），但退出
        // 事实进 detail：模型据此知道命令到底成功没有，不必读输出猜。
        SubmitOutcome::Completed { exit, .. } => (
            ExecutionStatus::Completed,
            JobStatus::Completed,
            None,
            Some(exit.describe()).filter(|d| !d.is_empty()),
        ),
        SubmitOutcome::TimedOut { .. } => (
            ExecutionStatus::TimedOut,
            JobStatus::Failed,
            None,
            Some("timeout".to_string()),
        ),
        // 终止来源随 CancelReason 流入作业实例：User（界面终止）/
        // Agent（job_kill）/ Task（任务停止级联）→ killed 并记录来源；
        // 断连级联 → failed（会话已不存在）。执行记录沿用同一语义。
        SubmitOutcome::Cancelled { reason } => match reason {
            CancelReason::Disconnected => (
                ExecutionStatus::Cancelled,
                JobStatus::Failed,
                Some(*reason),
                Some("session disconnected".to_string()),
            ),
            r => (ExecutionStatus::Killed, JobStatus::Killed, Some(*r), None),
        },
        SubmitOutcome::Failed { error } => {
            let msg = format!("\n[Error: {}]", error);
            instance.lock().append_output(msg.as_bytes(), &temp_dir);
            (
                ExecutionStatus::Failed,
                JobStatus::Failed,
                None,
                Some("execution error".to_string()),
            )
        }
    };

    guard
        .finalize(exec_status, job_status, cancel_reason, detail)
        .await;
    // 内存里只留最近的一批已结束作业（此时不持有任何实例锁）。
    inner.trim_settled_jobs();

    if let Some(app) = &app {
        let info = instance.lock().info.clone();
        crate::emit_event(app, "job://updated", &info);
    }

    // 末条作业结算 → 回收该任务的资源（多机自动拉起的会话等；见
    // `with_task_drain_hook`）。任务收尾时若还有作业在跑，那些会话会被
    // 留着（它们还得给作业用），由这里收尾。
    inner.run_task_drain_hook(&ticket.task_id);
}

/// 保证后台作业在任何退出路径（含 panic）都完成结算的守卫，
/// 与前台路径的 [`FinalizeGuard`] 同构。
///
/// 正常路径在 [`JobFinalizeGuard::finalize`] 里一次收尾三处，Drop 走的是
/// panic 兜底，同样必须收齐三处——只补内存会让盘上那份停在 `running`，
/// 重启后又变成 `interrupted`，同一个作业三个答案。
struct JobFinalizeGuard {
    inner: Arc<ManagerInner>,
    /// 前端事件也要在 panic 路径上发出去（`job://updated`），否则界面
    /// 只会看到一个永远 running 的作业。
    app: Option<AppHandle>,
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
        detail: Option<String>,
    ) {
        self.finalized = true;
        let task_id = self.task_id.take();
        self.inner
            .finalize_execution(self.exec_id, task_id, exec_status)
            .await;
        let mut inst = self.instance.lock();
        inst.finalize_with_detail(job_status, cancel_reason, detail);
        // 台账收尾：状态、退出细节、抓到的输出与落点、终止来源一次写全。
        self.inner.record_job_settled(&inst);
    }
}

impl Drop for JobFinalizeGuard {
    fn drop(&mut self) {
        if self.finalized {
            return;
        }
        // panic 路径。**作业状态与台账先就地同步结算**（两个都是同步调用，
        // 不需要 await），执行记录（tokio Mutex，只能 await 拿）才交给
        // `tokio::spawn`。
        //
        // 顺序不是随手排的：spawn 出去的任务不保证在进程退出前被调度到，
        // 而「内存 failed / 盘上 running / 重启后 interrupted」三个答案的
        // 根因正是盘上那份没人写。落账这一跳不能押在一个可能跑不起来的
        // 任务上。
        let info = {
            let mut inst = self.instance.lock();
            inst.append_output(b"\n[Error: job worker panicked]", &self.temp_dir);
            inst.finalize(JobStatus::Failed);
            self.inner.record_job_settled(&inst);
            inst.info.clone()
        };
        // 正常路径的 emit 在 worker 末尾，panic 会绕过它——界面因此收不到
        // 失败通知，补在这里（同步 emit，不需要运行时调度）。
        if let Some(app) = &self.app {
            crate::emit_event(app, "job://updated", &info);
        }
        let inner = self.inner.clone();
        let exec_id = self.exec_id;
        let task_id = self.task_id.take();
        let task_id_for_drain = task_id.clone();
        tokio::spawn(async move {
            inner
                .finalize_execution(exec_id, task_id, ExecutionStatus::Failed)
                .await;
            // panic 也是一种结算：末条作业照样要回收任务级资源。
            inner.run_task_drain_hook(&task_id_for_drain);
        });
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
        /// 立即返回 (输出, 退出码)——用于验证退出事实如实落进作业细节。
        ReturnExit(&'static str, u32),
        /// 先推一段输出、之后一直挂着（模拟「输出已沉淀、应用退出时作业
        /// 还在跑」的那种作业）。
        OutputThenHang(&'static str),
        /// 立即失败。
        Fail(&'static str),
        /// 直接 panic（模拟 worker 里没接住的崩溃：正常结算路径被绕过，
        /// 只剩 JobFinalizeGuard::Drop 兜底）。
        Panic,
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
                        exit: ExecExit::default(),
                    }
                }),
                MockBehavior::ReturnExit(output, code) => Ok(ExecOutcome::Completed {
                    output: output.to_string(),
                    exit: ExecExit {
                        code: Some(*code),
                        signal: None,
                    },
                }),
                MockBehavior::OutputThenHang(_) => match cancel {
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
                MockBehavior::Fail(msg) => Err(AppError::Ssh(msg.to_string())),
                // 从 worker 的 `.await` 里 unwind 出去：guard 的 Drop 负责兜底。
                MockBehavior::Panic => panic!("mock transport panicked"),
            }
        }

        /// `OutputThenHang` 必须走这里：输出要先经 `on_chunk` 沉淀进作业
        /// 缓冲（默认实现只在整体执行完才回调，那样挂住的作业永远没有输出）。
        async fn exec_observable(
            &self,
            ticket: &CommandTicket,
            app: Option<&AppHandle>,
            on_chunk: crate::command_exec::executor::ChunkCallback,
            cancel: Option<&watch::Receiver<CancelReason>>,
        ) -> Result<ExecOutcome, AppError> {
            if let MockBehavior::OutputThenHang(text) = &self.behavior {
                on_chunk(text);
            }
            let outcome = self.exec(ticket, app, cancel).await?;
            match &outcome {
                ExecOutcome::Completed { output, .. } | ExecOutcome::TimedOut { output } => {
                    on_chunk(output);
                }
                ExecOutcome::Cancelled { .. } => {}
            }
            Ok(outcome)
        }
    }

    fn manager(behavior: MockBehavior) -> CommandExecutionManager {
        CommandExecutionManager::with_transport(Arc::new(MockTransport { behavior }))
    }

    /// 固定台账路径的 manager：用来模拟「应用重启」——同一个台账文件被
    /// 第二个 manager 读回来，序号接着数。
    fn manager_at(behavior: MockBehavior, base: PathBuf) -> CommandExecutionManager {
        CommandExecutionManager::with_transport_at(Arc::new(MockTransport { behavior }), base)
    }

    #[tokio::test]
    async fn exit_code_lands_in_job_detail_and_output() {
        // 非零退出不算执行失败（旧语义），但退出码必须能被读到：
        // detail 进 JobInfo，job_output 的 status 行也带上。
        let mgr = manager(MockBehavior::ReturnExit("boom\n", 2));
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "false-ish", CommandSource::Agent),
                None,
            )
            .await
            .unwrap();

        // 等 worker 结算（mock 立即返回）
        for _ in 0..200 {
            if mgr.job_status(&info.job_id).await.unwrap() != JobStatus::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        let read = mgr
            .job_output(&info.job_id, 0, false, Duration::ZERO, JobCaller::Unscoped).await
            .unwrap();
        assert_eq!(read.status, JobStatus::Completed);
        assert_eq!(read.detail.as_deref(), Some("exit code: 2"));
        assert!(read.delta.contains("boom"));
        assert_eq!(read.lossy, false);
    }

    #[tokio::test]
    async fn job_ids_stay_monotonic_across_restart() {
        // 模拟应用重启：同一台账文件被第二个 manager 读回来。旧 job_id
        // 绝不能复用——模型历史里可能一直记着上一次运行的 job_1。
        let base = std::env::temp_dir().join(format!("marcel-ledger-restart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        let first = manager_at(MockBehavior::Return("ok", false), base.clone());
        let a = first
            .submit_background(None, CommandTicket::new("s1", "one", CommandSource::Agent), None)
            .await
            .unwrap();
        assert_eq!(a.job_id, "job_1");
        drop(first);

        let second = manager_at(MockBehavior::Return("ok", false), base.clone());
        let b = second
            .submit_background(None, CommandTicket::new("s1", "two", CommandSource::Agent), None)
            .await
            .unwrap();
        assert_eq!(b.job_id, "job_2", "重启后序号必须接着数，不能回到 job_1");

        // 老 id 在新进程里查不到，且给的是可解释的说明（不是裸 not found）
        let err = second
            .job_output("job_9", 0, false, Duration::ZERO, JobCaller::Unscoped).await
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("job_9"));
        assert!(msg.contains("job_list"), "要给出下一步动作：{}", msg);
    }

    #[tokio::test]
    async fn concurrent_job_limit_rejects_with_guidance() {
        let mgr = manager(MockBehavior::Hang);
        for i in 0..MAX_RUNNING_JOBS_PER_OWNER {
            mgr.submit_background(
                None,
                CommandTicket::new("s1", format!("hang-{}", i), CommandSource::Agent),
                None,
            )
            .await
            .unwrap_or_else(|e| panic!("第 {} 个作业不该被拒绝: {}", i + 1, e));
        }
        let err = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "hang-overflow", CommandSource::Agent),
                None,
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("上限"), "{}", err);
        assert!(err.contains("job_kill"), "拒绝时要给腾位置的指引: {}", err);
    }

    #[tokio::test]
    async fn settled_jobs_are_trimmed_in_memory() {
        // 进程内存只留最近的一批已结束作业；运行中的一条都不能丢。
        let mgr = manager(MockBehavior::Hang);
        let running = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "hang", CommandSource::Agent),
                None,
            )
            .await
            .unwrap();

        let total = MAX_SETTLED_JOBS_IN_MEMORY + 5;
        for i in 0..total {
            let (tx, _) = watch::channel(0);
            let mut inst = JobInstance::new(
                format!("job_fake_{}", i),
                0,
                "s1".into(),
                None,
                None,
                None,
                "echo".into(),
                tx,
            );
            // 用启动时间当"新旧"：序号越大越新
            inst.info.started_at_millis = i as u128 + 1;
            inst.finalize(JobStatus::Completed);
            mgr.inner
                .jobs
                .lock()
                .insert(inst.info.job_id.clone(), Arc::new(PlMutex::new(inst)));
        }

        mgr.inner.trim_settled_jobs();

        let jobs = mgr.inner.jobs.lock();
        let settled = jobs
            .values()
            .filter(|inst| inst.lock().info.status.is_terminal())
            .count();
        assert_eq!(settled, MAX_SETTLED_JOBS_IN_MEMORY);
        assert!(
            jobs.contains_key(&running.job_id),
            "运行中的作业不能被内存收敛清掉"
        );
        // 保留的是较新的那批
        assert!(jobs.contains_key(&format!("job_fake_{}", total - 1)));
        assert!(!jobs.contains_key("job_fake_0"));
    }

    #[tokio::test]
    async fn restart_recovers_interrupted_job_with_captured_output() {
        // 这条是「重启后 agent 不懵」的总验收：作业跑到一半应用退出，
        // 重启后 job_list 认得出它、job_output 读得到退出前抓到的输出、
        // 状态明确是 interrupted（而不是查无此作业、也不是假装已完成）。
        let base = std::env::temp_dir().join(format!("marcel-recover-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);

        let job_id = {
            let mgr = manager_at(
                MockBehavior::OutputThenHang("build: 42% done\n"),
                base.clone(),
            );
            let info = mgr
                .submit_background(
                    None,
                    CommandTicket::new("s1", "make -j8", CommandSource::Agent)
                        .cancellable("agent-task-rec", "取消")
                        .owned_by("conv_1"),
                    Some("编译".into()),
                )
                .await
                .unwrap();
            assert_eq!(info.owner_conversation_id.as_deref(), Some("conv_1"));

            // 等第一段输出沉淀（内存缓冲 + 溢出文件）
            let mut seen = false;
            for _ in 0..200 {
                let read = mgr
                    .job_output(&info.job_id, 0, false, Duration::ZERO, JobCaller::Unscoped)
                    .await
                    .unwrap();
                if !read.delta.is_empty() {
                    seen = true;
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            assert!(seen, "输出应在重启前落进作业缓冲");
            info.job_id
            // manager 在此 drop：等价于应用退出（作业还在跑）
        };

        // 「应用重启」：同一配置目录重建 manager
        let mgr = manager_at(MockBehavior::Hang, base.clone());

        // 1) 自己的对话看得到它，状态是 interrupted，细节说明是应用退出
        let jobs = mgr
            .list_jobs(JobFilter::OwnerConversation("conv_1"), None)
            .await;
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].job_id, job_id);
        assert_eq!(jobs[0].status, JobStatus::Interrupted);
        assert_eq!(jobs[0].detail, None, "中断不编造退出码之类的细节");

        // 2) 退出前抓到的输出还在（走溢出文件），且不是 lossy
        let read = mgr
            .job_output(
                &job_id,
                0,
                false,
                Duration::ZERO,
                JobCaller::Agent {
                    owner_conversation_id: Some("conv_1"),
                },
            )
            .await
            .unwrap();
        assert_eq!(read.status, JobStatus::Interrupted);
        assert!(read.delta.contains("42% done"), "{}", read.delta);
        assert!(!read.lossy);
        assert_eq!(read.cancel_reason, Some(CancelReason::RuntimeRestart));
        assert!(read.spill_path.is_some(), "输出落点要能报给调用方");

        // 3) 别的对话看不见它，也读不到它
        assert!(mgr
            .list_jobs(JobFilter::OwnerConversation("conv_2"), None)
            .await
            .is_empty());
        let blocked = mgr
            .job_output(
                &job_id,
                0,
                false,
                Duration::ZERO,
                JobCaller::Agent {
                    owner_conversation_id: Some("conv_2"),
                },
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(blocked.contains("另一个对话"), "{}", blocked);

        // 4) 恢复的作业不产生结算通知（那是上一次运行的事）
        assert!(
            mgr.take_settled_jobs_for_task("agent-task-rec").is_empty(),
            "历史作业不该给这一轮对话注入通知"
        );
    }

    #[tokio::test]
    async fn fence_keeps_other_conversations_out() {
        let mgr = manager(MockBehavior::Hang);
        let mine = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "mine", CommandSource::Agent).owned_by("conv_a"),
                None,
            )
            .await
            .unwrap();

        let agent = |conv: &'static str| JobCaller::Agent {
            owner_conversation_id: Some(conv),
        };
        // 自己的：照常可读
        assert!(mgr
            .job_output(&mine.job_id, 0, false, Duration::ZERO, agent("conv_a"))
            .await
            .is_ok());
        // 别人的：读 / 杀都被挡，且文案说明是归属问题而不是 id 打错
        let read_err = mgr
            .job_output(&mine.job_id, 0, false, Duration::ZERO, agent("conv_b"))
            .await
            .unwrap_err()
            .to_string();
        assert!(read_err.contains("另一个对话"), "{}", read_err);
        let kill_err = mgr
            .kill_job(&mine.job_id, CancelReason::Agent, agent("conv_b"))
            .await
            .unwrap_err()
            .to_string();
        assert!(kill_err.contains("另一个对话"), "{}", kill_err);
        // 作业仍在运行（被挡的 kill 不该动它）
        assert_eq!(
            mgr.job_status(&mine.job_id).await.unwrap(),
            JobStatus::Running
        );
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
            SubmitOutcome::Completed { output, .. } => assert_eq!(output, "ok"),
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
    async fn exec_simple_with_timeout_propagates_custom_timeout_in_error() {
        // 回归测试：SFTP 解压路径用自定义长超时（1800s）走
        // exec_simple_with_timeout，超时文案必须体现自定义秒数，
        // 而不是写死的 120s（曾是「上传文件夹 120s 超时」误报根因）。
        let mgr = manager(MockBehavior::Return("partial", true));
        let err = mgr
            .exec_simple_with_timeout_opt(
                None,
                "s1",
                "unzip -q /tmp/a.zip -d /srv",
                CommandSource::SystemTask,
                Duration::from_secs(1800),
            )
            .await
            .expect_err("TimedOut 应映射为 Err");
        let msg = err.to_string();
        assert!(msg.contains("1800 秒后超时"), "实际: {}", msg);
        assert!(!msg.contains("120 秒"), "不应残留写死的 120s: {}", msg);
        assert!(msg.contains("unzip"), "应包含命令预览: {}", msg);
    }

    #[tokio::test]
    async fn exec_simple_with_timeout_completed_returns_output() {
        let mgr = manager(MockBehavior::Return("OK\n", false));
        let out = mgr
            .exec_simple_with_timeout_opt(
                None,
                "s1",
                "unzip -q /tmp/a.zip -d /srv",
                CommandSource::SystemTask,
                Duration::from_secs(1800),
            )
            .await
            .expect("Completed 应返回输出");
        assert_eq!(out, "OK\n");
    }

    #[tokio::test]
    async fn exec_simple_with_timeout_failure_maps_to_failed() {
        let mgr = manager(MockBehavior::Fail("boom"));
        let err = mgr
            .exec_simple_with_timeout_opt(
                None,
                "s1",
                "unzip -q /tmp/a.zip -d /srv",
                CommandSource::SystemTask,
                Duration::from_secs(1800),
            )
            .await
            .expect_err("Failed 应映射为 Err");
        assert!(err.to_string().contains("boom"));
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
            let jobs = mgr.list_jobs(JobFilter::Session(session), None).await;
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
            .job_output(&info.job_id, 0, false, Duration::ZERO, JobCaller::Unscoped).await
            .unwrap();
        assert_eq!(out.delta, "job output");
        assert_eq!(out.status, JobStatus::Completed);

        // 执行记录进统一最近记录表（与前台共用）
        let snaps = mgr.snapshots().await;
        assert!(snaps.iter().any(|s| s.display_command == "long-cmd"));

        // list_jobs 反映完结状态
        let jobs = mgr.list_jobs(JobFilter::Session("s1"), Some("completed")).await;
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
            .kill_job(&info.job_id, CancelReason::Agent, JobCaller::Unscoped)
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

        let jobs = mgr.list_jobs(JobFilter::Session("s1"), Some("killed")).await;
        assert_eq!(jobs.len(), 1);

        // job_output 带出终止来源：Agent 自己 job_kill → Agent
        let out = mgr
            .job_output(&info.job_id, 0, false, Duration::ZERO, JobCaller::Unscoped).await
            .unwrap();
        assert_eq!(out.cancel_reason, Some(CancelReason::Agent));
    }

    /// **worker 收尾的微秒窗口**：收尾顺序是「先把 exec 摘出 `running`、再落
    /// 实例终态」。夹在这两步之间的 kill 若照旧落 `Killed`，就会把一条**已经
    /// 成功结束**的作业记成被终止——而且实例已是终态，worker 随后那份带退出
    /// 细节的结算会被幂等挡掉，退出事实一并丢失。
    ///
    /// 这个中间态等调度去撞是不可复现的，直接构造它：实例仍 `Running`、exec
    /// 已不在运行表（正是 `JobFinalizeGuard::finalize` 里那两步之间的状态）。
    #[tokio::test]
    async fn kill_in_the_worker_finalize_window_does_not_forge_a_kill() {
        let mgr = manager(MockBehavior::Hang);
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "quick", CommandSource::Agent)
                    .cancellable("agent-task-window", "取消"),
                None,
            )
            .await
            .unwrap();
        let instance = mgr
            .inner
            .jobs
            .lock()
            .get(&info.job_id)
            .cloned()
            .expect("作业应在册");
        let exec_id = instance.lock().exec_id;
        assert!(
            mgr.inner.running.lock().await.remove(&exec_id).is_some(),
            "worker 收尾第一步：exec 摘出运行表"
        );
        assert_eq!(
            instance.lock().info.status,
            JobStatus::Running,
            "worker 收尾第二步（落实例终态）还没发生——这正是那个窗口"
        );

        // 窗口里到达的 kill：这一刻的先到者是 worker，不许把作业写成 killed
        let returned = mgr
            .kill_job(&info.job_id, CancelReason::User, JobCaller::Unscoped)
            .await
            .unwrap();
        assert_ne!(
            returned.status,
            JobStatus::Killed,
            "exec 已不在运行表 ⇒ kill 不能抢先落 Killed"
        );
        assert_eq!(instance.lock().info.status, JobStatus::Running);

        // worker 随后落它的真实终态（带退出细节）：没被那次 Kill 挡掉
        instance.lock().finalize_with_detail(
            JobStatus::Completed,
            None,
            Some("exit code: 0".into()),
        );
        let out = mgr
            .job_output(&info.job_id, 0, false, Duration::ZERO, JobCaller::Unscoped).await
            .unwrap();
        assert_eq!(out.status, JobStatus::Completed);
        assert_eq!(
            out.detail.as_deref(),
            Some("exit code: 0"),
            "退出细节必须能落定（Killed 抢先会让它静默丢失）"
        );
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
            .job_output(&info.job_id, 0, false, Duration::ZERO, JobCaller::Unscoped).await
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
            .job_output(&info.job_id, 0, true, Duration::from_secs(5), JobCaller::Unscoped).await
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
            .job_output(&info.job_id, 0, false, Duration::ZERO, JobCaller::Unscoped).await
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
            .job_output("nope", 0, false, Duration::ZERO, JobCaller::Unscoped).await
            .unwrap_err();
        assert!(err.to_string().contains("nope"));
    }

    // ─────────────── 任务结算通知（job → agent loop 唤醒） ───────────────

    #[tokio::test]
    async fn settled_jobs_are_delivered_once_per_task() {
        let mgr = manager(MockBehavior::Return("out", false));
        // 不带 task_id：不注册结算通道，take 也取不到
        let info_plain = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "plain", CommandSource::Agent),
                None,
            )
            .await
            .unwrap();
        // 带 task_id：结算后 take 可取一次，再取为空（防重）
        let info_task = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "tasked", CommandSource::Agent)
                    .cancellable("agent-task-9", "取消"),
                Some("带任务作业".into()),
            )
            .await
            .unwrap();
        assert_eq!(
            wait_for_job_settlement(&mgr, &info_task.job_id, "s1").await,
            JobStatus::Completed
        );
        // 等结算 bump 落地（worker 结算后 bump 与 list_jobs 更新几乎同步）
        tokio::time::sleep(Duration::from_millis(20)).await;

        // 无 task_id 的作业不进任何 task 的通知队列
        let plain_settled = mgr.take_settled_jobs_for_task("nobody");
        assert!(
            plain_settled.iter().all(|j| j.job_id != info_plain.job_id),
            "无 task_id 作业不应出现在任务通知里"
        );

        let first = mgr.take_settled_jobs_for_task("agent-task-9");
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].job_id, info_task.job_id);
        assert_eq!(first[0].description, "带任务作业");

        // 第二次 take：已被标记 notified，返回空
        let second = mgr.take_settled_jobs_for_task("agent-task-9");
        assert!(second.is_empty(), "结算通知应只投递一次");
    }

    #[tokio::test]
    async fn user_kill_still_notifies_the_task() {
        // 界面用户终止不是 Agent 自己动的手：模型必须被告知（它可能在等
        // 这个作业），所以照旧走结算通知。
        let mgr = manager(MockBehavior::Hang);
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "hang", CommandSource::Agent)
                    .cancellable("agent-task-10", "取消"),
                None,
            )
            .await
            .unwrap();

        mgr.kill_job(&info.job_id, CancelReason::User, JobCaller::Unscoped)
            .await
            .unwrap();

        // 还在同一轮里 → 走「本轮注入」那条路（take 得到 killed 作业）
        let settled = mgr.take_settled_jobs_for_task("agent-task-10");
        assert_eq!(settled.len(), 1);
        assert_eq!(settled[0].status, JobStatus::Killed);

        // 但**不**走「唤醒」那条路：用户自己掐的作业不该把 agent 叫起来
        // （对齐 DSH：带终止来源的结算不播报）。
        assert!(
            mgr.pending_job_notices("conv-nobody").is_empty(),
            "无归属会话的作业不该出现在任何会话的待播报里"
        );
    }

    #[tokio::test]
    async fn agent_self_kill_does_not_re_notify() {
        // Agent 自己 job_kill：工具结果已经把「已终止 + 远端进程不保证
        // 结束」说全了，系统不再注入一条「作业已终止」通知（省一轮模型
        // 请求）。作业本身照常结算、照常从 job_list 可见。
        let mgr = manager(MockBehavior::Hang);
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "hang", CommandSource::Agent)
                    .cancellable("agent-task-13", "取消"),
                None,
            )
            .await
            .unwrap();

        mgr.kill_job(&info.job_id, CancelReason::Agent, JobCaller::Unscoped)
            .await
            .unwrap();

        let settled = mgr.take_settled_jobs_for_task("agent-task-13");
        assert!(settled.is_empty(), "自己杀的作业不该再通知一轮");
        let jobs = mgr.list_jobs(JobFilter::Session("s1"), Some("killed")).await;
        assert_eq!(jobs.len(), 1, "作业本身仍要能从列表里看到");
    }

    #[tokio::test]
    async fn cancel_task_jobs_kills_every_running_job_of_the_task() {
        let mgr = manager(MockBehavior::Hang);
        // 同名 task 派两个并行 hang 作业
        let a = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "hang-a", CommandSource::Agent)
                    .cancellable("agent-task-11", "取消"),
                None,
            )
            .await
            .unwrap();
        let b = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "hang-b", CommandSource::Agent)
                    .cancellable("agent-task-11", "取消"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(mgr.running_jobs_for_task("agent-task-11").await.len(), 2);

        let killed = mgr.cancel_task_jobs("agent-task-11").await;
        assert_eq!(killed, 2);

        // 两个作业都应结算为 Killed（cancel_task_jobs 同步 kill）
        let sa = wait_for_job_settlement(&mgr, &a.job_id, "s1").await;
        let sb = wait_for_job_settlement(&mgr, &b.job_id, "s1").await;
        assert_eq!(sa, JobStatus::Killed);
        assert_eq!(sb, JobStatus::Killed);
    }

    #[tokio::test]
    async fn job_output_wait_marks_settled_notified() {
        // 模型主动 job_output(wait=true) 等到结算 → 不再产生系统通知
        let mgr = manager(MockBehavior::Return("done", false));
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "quick", CommandSource::Agent)
                    .cancellable("agent-task-12", "取消"),
                None,
            )
            .await
            .unwrap();
        let out = mgr
            .job_output(&info.job_id, 0, true, Duration::from_secs(5), JobCaller::Unscoped).await
            .unwrap();
        assert_eq!(out.status, JobStatus::Completed);

        let settled = mgr.take_settled_jobs_for_task("agent-task-12");
        assert!(
            settled.is_empty(),
            "模型已 wait 等到结算，不应再产生系统通知"
        );
    }

    // ────────── 台账回读：写者/读者字段集一致（跨重启的回归） ──────────

    /// 每个测试用独立配置目录（台账 + 溢出目录都钉在里面）。
    fn cross_run_base(tag: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "marcel-ledger-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        base
    }

    #[tokio::test]
    async fn recovery_keeps_captured_total_and_reports_lossy_when_spill_was_truncated() {
        // 溢出文件被 MAX_SPILL_BYTES 截断（或写到一半失败）时，台账里的
        // captured_bytes 远大于文件长度。恢复必须按「抓到的更多」走：
        // 拿文件长度顶掉台账计数，会让同一条作业在运行期报 lossy、
        // 重启后摇身一变报无损——正是在骗模型。
        let base = cross_run_base("captured");
        let spill = base.join("jobs_temp").join("marcel-job-job_1-1.log");
        std::fs::create_dir_all(spill.parent().unwrap()).unwrap();
        std::fs::write(&spill, b"head").unwrap();
        const CAPTURED: usize = 8 * 1024 * 1024;
        {
            let ledger = JobLedgerStore::load(base.join("jobs.json"));
            ledger.upsert(LedgerJob {
                job_id: "job_1".into(),
                session_id: "sess_1".into(),
                owner_conversation_id: Some("conv_1".into()),
                task_id: None,
                description: "下载大文件".into(),
                command: "curl -O big.iso".into(),
                // 上一次运行派发、应用退出时还没结算（开始时间取当下：
                // 恢复时的保留期清理按 started_at 兜底，老时间会被连带
                // 删掉输出文件，测的就不是这里要证的那件事了）
                status: JobStatus::Running,
                detail: None,
                started_at_millis: now_millis(),
                finished_at_millis: None,
                captured_bytes: CAPTURED,
                spill_path: Some(spill.display().to_string()),
                cancel_reason: None,
            });
        }

        let mgr = manager_at(MockBehavior::Hang, base.clone());
        let jobs = mgr.list_jobs(JobFilter::All, None).await;
        assert_eq!(jobs.len(), 1);
        assert_ne!(
            jobs[0].total_output_bytes, 4,
            "溢出文件长度只是下界，不能顶掉台账里的 captured_bytes"
        );
        assert_eq!(jobs[0].total_output_bytes, CAPTURED);

        let read = mgr
            .job_output("job_1", 0, false, Duration::ZERO, JobCaller::Unscoped)
            .await
            .unwrap();
        assert!(read.lossy, "被截断的那段读不到，必须如实报 lossy");
        assert_eq!(read.delta, "head");
        assert_eq!(read.skipped_bytes, CAPTURED - 4);
    }

    #[tokio::test]
    async fn output_without_a_spill_file_is_reported_lossy_not_empty() {
        // 另一种「输出丢了」：作业确实产出了输出，但溢出文件一次都没写成功
        // （目录不可用 / 权限）——结算时 spill_path 记成 None、只有总量留下。
        // 恢复绝不能因此把总量当成 0：那是「根本没有输出」，等于把丢掉的
        // 输出说成没发生过。
        let base = cross_run_base("no-spill");
        const CAPTURED: usize = 5000;
        {
            let ledger = JobLedgerStore::load(base.join("jobs.json"));
            ledger.upsert(LedgerJob {
                job_id: "job_1".into(),
                session_id: "sess_1".into(),
                owner_conversation_id: Some("conv_1".into()),
                task_id: None,
                description: "写不出去".into(),
                command: "make".into(),
                status: JobStatus::Failed,
                detail: Some("execution error".into()),
                started_at_millis: now_millis(),
                finished_at_millis: Some(now_millis()),
                captured_bytes: CAPTURED,
                // 溢出文件没写成 → 落点为空（与 record_job_settled 的过滤同规矩）
                spill_path: None,
                cancel_reason: None,
            });
        }

        let mgr = manager_at(MockBehavior::Hang, base);
        let jobs = mgr.list_jobs(JobFilter::All, None).await;
        assert_eq!(jobs.len(), 1);
        assert_eq!(
            jobs[0].total_output_bytes, CAPTURED,
            "总量不能因为「没有落点」就归零"
        );
        let read = mgr
            .job_output("job_1", 0, false, Duration::ZERO, JobCaller::Unscoped)
            .await
            .unwrap();
        assert_eq!(read.status, JobStatus::Failed);
        assert!(read.lossy, "输出读不到就必须报 lossy，而不是「没有输出」");
        assert_eq!(read.skipped_bytes, CAPTURED);
        assert_eq!(read.delta, "");
        assert!(read.spill_path.is_none(), "没有可读的溢出文件就不该报落点");
    }

    #[tokio::test]
    async fn killed_job_keeps_its_cancel_reason_across_restart() {
        // 界面「终止」/ job_kill / 任务级联取消的作业，重启后必须还认得出
        // 「谁终止的」：丢了来源，终止文案会静默降级成中性的 [status: killed]。
        let base = cross_run_base("kill-reason");
        let job_id = {
            let mgr = manager_at(MockBehavior::Hang, base.clone());
            let info = mgr
                .submit_background(
                    None,
                    CommandTicket::new("s1", "hang", CommandSource::Agent),
                    None,
                )
                .await
                .unwrap();
            let killed = mgr
                .kill_job(&info.job_id, CancelReason::User, JobCaller::Unscoped)
                .await
                .unwrap();
            assert_eq!(killed.status, JobStatus::Killed);
            // 等 worker 也把自己的结算走完（它会带着同一个来源再写一次台账）
            assert_eq!(
                wait_for_job_settlement(&mgr, &info.job_id, "s1").await,
                JobStatus::Killed
            );
            tokio::time::sleep(Duration::from_millis(30)).await;
            info.job_id
        };

        // 「应用重启」：同一配置目录重建 manager，来源要从台账读回来
        let mgr = manager_at(MockBehavior::Hang, base.clone());
        let out = mgr
            .job_output(&job_id, 0, false, Duration::ZERO, JobCaller::Unscoped)
            .await
            .unwrap();
        assert_eq!(out.status, JobStatus::Killed);
        assert_eq!(
            out.cancel_reason,
            Some(CancelReason::User),
            "终止来源必须跨重启存活（写入侧漏一个字段，界面就再也说不出是谁终止的）"
        );
    }

    #[tokio::test]
    async fn panicked_worker_settles_memory_and_ledger_the_same_way() {
        // worker panic 绕过正常结算路径，只剩 guard 的 Drop 兜底：内存、
        // 台账、前端事件三处都必须在 Drop 里收尾。只补内存会让盘上停在
        // running → 重启后变成 interrupted，同一个作业三个答案。
        let base = cross_run_base("panic");
        let job_id = {
            let mgr = manager_at(MockBehavior::Panic, base.clone());
            let info = mgr
                .submit_background(
                    None,
                    CommandTicket::new("s1", "boom", CommandSource::Agent),
                    None,
                )
                .await
                .unwrap();
            assert_eq!(
                wait_for_job_settlement(&mgr, &info.job_id, "s1").await,
                JobStatus::Failed,
                "内存里必须结算成 failed"
            );
            info.job_id
        };

        let mgr = manager_at(MockBehavior::Hang, base.clone());
        let out = mgr
            .job_output(&job_id, 0, false, Duration::ZERO, JobCaller::Unscoped)
            .await
            .unwrap();
        assert_eq!(
            out.status,
            JobStatus::Failed,
            "台账里也必须是 failed，而不是 running（重启后会被读成 interrupted）"
        );
        assert!(
            out.delta.contains("panicked"),
            "崩溃痕迹要留在输出里: {}",
            out.delta
        );
    }

    #[tokio::test]
    async fn settled_job_stays_readable_from_the_ledger_after_memory_trim() {
        // 内存收敛只是把已结算作业腾出内存（台账与溢出文件仍在保留期内）：
        // 状态、输出、列表三处都要能回退到台账，否则「记录明明还在、只是
        // 内存腾了」会表现成查无此作业，与「重启后照样能恢复」自相矛盾。
        let base = cross_run_base("trim");
        let mgr = manager_at(MockBehavior::Return("trimmed output", false), base);
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "echo hi", CommandSource::Agent).owned_by("conv_1"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            wait_for_job_settlement(&mgr, &info.job_id, "s1").await,
            JobStatus::Completed
        );

        // 模拟内存收敛（Trim 的策略本身不动）
        mgr.inner.jobs.lock().remove(&info.job_id);

        assert_eq!(
            mgr.job_status(&info.job_id).await.unwrap(),
            JobStatus::Completed
        );
        let read = mgr
            .job_output(&info.job_id, 0, false, Duration::ZERO, JobCaller::Unscoped)
            .await
            .unwrap();
        assert_eq!(read.status, JobStatus::Completed);
        assert_eq!(read.delta, "trimmed output");

        let listed = mgr
            .list_jobs(JobFilter::OwnerConversation("conv_1"), None)
            .await;
        assert_eq!(listed.len(), 1, "台账里还在保留期内的作业不该从列表里消失");
        assert_eq!(listed[0].job_id, info.job_id);

        // 归属围栏在回退路径上同样生效（真属于别人的作业要说「不是你的」，
        // 而不是假装查无此作业）
        let blocked = mgr
            .job_output(
                &info.job_id,
                0,
                false,
                Duration::ZERO,
                JobCaller::Agent {
                    owner_conversation_id: Some("conv_2"),
                },
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(blocked.contains("另一个对话"), "{}", blocked);

        // wait=true 对台账投影不生效：没有通道可等，立即返回而不是挂满超时
        let started = std::time::Instant::now();
        let waited = mgr
            .job_output(&info.job_id, 0, true, Duration::from_secs(5), JobCaller::Unscoped)
            .await
            .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(waited.status, JobStatus::Completed);

        // 对内存里已腾出的作业点终止：如实返回原记录（它早就结束了），
        // 既不报「查无此作业」，也不谎报成刚被终止
        let killed = mgr
            .kill_job(&info.job_id, CancelReason::User, JobCaller::Unscoped)
            .await
            .unwrap();
        assert_eq!(killed.status, JobStatus::Completed);
        let blocked_kill = mgr
            .kill_job(
                &info.job_id,
                CancelReason::User,
                JobCaller::Agent {
                    owner_conversation_id: Some("conv_2"),
                },
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(blocked_kill.contains("另一个对话"), "{}", blocked_kill);
    }

    #[tokio::test]
    async fn job_not_found_message_lists_only_real_causes() {
        // 到这一步时归属已被 caller.allows 判过（真属于别人的会走
        // job_foreign_message），保留期也不再是「只保留最近 7 天」那句
        // ——内存收敛几分钟就能让一条记录从列表里消失。
        let mgr = manager(MockBehavior::Return("x", false));
        let msg = mgr
            .job_output("job_nope", 0, false, Duration::ZERO, JobCaller::Unscoped)
            .await
            .unwrap_err()
            .to_string();
        assert!(!msg.contains("另一个对话"), "归属不是这里的可能原因: {}", msg);
        assert!(!msg.contains("只保留最近 7 天"), "保留期不许写死: {}", msg);
        assert!(msg.contains("job_list"), "要给出下一步动作: {}", msg);
        assert!(msg.contains("台账"), "要说明已查过台账: {}", msg);
    }

    // ────────── 待播报告知（唤醒路径）：按会话、只收自然结束、取出要确认 ──────────

    #[tokio::test]
    async fn pending_notices_are_per_conversation_and_need_ack() {
        let mgr = manager(MockBehavior::Return("done", false));
        let mine = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "build", CommandSource::Agent)
                    .cancellable("task-notice-1", "构建")
                    .owned_by("conv-a"),
                None,
            )
            .await
            .unwrap();
        let other = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "other", CommandSource::Agent)
                    .cancellable("task-notice-2", "别的会话")
                    .owned_by("conv-b"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            wait_for_job_settlement(&mgr, &mine.job_id, "s1").await,
            JobStatus::Completed
        );
        assert_eq!(
            wait_for_job_settlement(&mgr, &other.job_id, "s1").await,
            JobStatus::Completed
        );

        let pending = mgr.pending_job_notices("conv-a");
        assert_eq!(pending.len(), 1, "只收本会话的作业: {pending:?}");
        assert_eq!(pending[0].job_id, mine.job_id);

        // **只读**：再读一次仍在 —— 送不出去就不算已读（会话已关、应用正在退
        // 时不能让结局被静默吞掉）。
        assert_eq!(
            mgr.pending_job_notices("conv-a").len(),
            1,
            "读取本身不得消费结局"
        );

        // 真的交给模型之后确认 → 不再播报；重复确认是幂等的
        assert_eq!(mgr.ack_job_notices(&[mine.job_id.clone()]), 1);
        assert!(mgr.pending_job_notices("conv-a").is_empty(), "确认过的不再播报");
        assert_eq!(mgr.ack_job_notices(&[mine.job_id.clone()]), 0);

        // 别的会话不受影响
        assert_eq!(mgr.pending_job_notices("conv-b").len(), 1);
    }

    #[tokio::test]
    async fn unowned_jobs_never_wake_a_conversation() {
        // 无归属作业（旧记录 / 界面直接派发）：读路径上它们对谁都可见（宽容
        // 语义），但**唤醒**必须精确匹配 —— 否则同一条作业会去叫醒每一条会话，
        // 而且谁先问谁先醒，很可能是错的会话。
        let mgr = manager(MockBehavior::Return("done", false));
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "orphan", CommandSource::Agent)
                    .cancellable("task-notice-4", "无归属"),
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            wait_for_job_settlement(&mgr, &info.job_id, "s1").await,
            JobStatus::Completed
        );

        assert!(mgr.pending_job_notices("conv-x").is_empty());
        assert!(mgr.pending_job_notices("conv-y").is_empty());
        // 但读路径照旧能看到它（宽容语义不变）
        assert_eq!(
            mgr.list_jobs(JobFilter::OwnerConversation("conv-x"), None)
                .await
                .len(),
            1
        );
    }

    #[tokio::test]
    async fn cancelled_jobs_are_never_wake_notices() {
        // 带终止来源的结算（用户掐的、任务停止带走的、断连杀的）不走唤醒：
        // 那是用户自己干的事，或者会话已经没了 —— 为它开一轮只会白花一次
        // 模型请求（对齐 DSH 的 `reported`）。结局本身仍可从列表读到。
        let mgr = manager(MockBehavior::Hang);
        let info = mgr
            .submit_background(
                None,
                CommandTicket::new("s1", "hang", CommandSource::Agent)
                    .cancellable("task-notice-3", "挂着")
                    .owned_by("conv-c"),
                None,
            )
            .await
            .unwrap();
        assert!(mgr.pending_job_notices("conv-c").is_empty(), "还在跑就没有结局可播");

        mgr.kill_job(&info.job_id, CancelReason::User, JobCaller::Unscoped)
            .await
            .unwrap();
        assert!(
            mgr.pending_job_notices("conv-c").is_empty(),
            "用户掐掉的作业不该把 agent 叫起来"
        );

        let jobs = mgr
            .list_jobs(JobFilter::OwnerConversation("conv-c"), None)
            .await;
        assert_eq!(jobs.len(), 1);
        assert_eq!(jobs[0].status, JobStatus::Killed);
    }
}
