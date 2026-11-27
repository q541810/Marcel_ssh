//! Background job operations: `job_output`, `job_kill`, and `job_list`.
//!
//! Exposes controls for monitoring and terminating background jobs initiated
//! via `bash(run_in_background: true)`. All operations delegate to
//! [`crate::command_exec::CommandExecutionManager`] — jobs live inside the
//! unified command execution system, not a separate manager.
//!
//! 原文案的坑（本次修掉）：工具描述把作业说成 "on the remote server" 的实体，
//! 于是「应用重启后作业凭空消失」在模型看来完全无法解释——它会猜「已完成、
//! 输出被清理」。事实是：命令跑在远端，但**作业记录（id、状态、已抓到的
//! 输出）是本应用的东西**，随应用进程存在。描述与文案都按这个事实写。
//!
//! 本机作业（`local_bash(run_in_background: true)`）与远端作业**完全同构**，
//! 只是进程跑在用户自己这台电脑上：
//! - **读 / 终止的路由判据是 `(id 形状 × ctx 侧别)` 四象限**（[`resolve_job_side`]）：
//!   `local_job_` 前缀 → `AppState.local_command_exec`，不分 ctx 侧别——根 agent
//!   是远端 ctx，可它同样要读自己对话名下、本机子 agent 派发的作业，判据不能是
//!   「调用方在哪一侧」；远端 id + 远端 ctx → `ctx.command_exec`（今天不变）；
//!   远端 id + 本机 ctx（本机子 agent 的 `ctx.command_exec` 挂的就是本机 manager）
//!   → **明确失败**并说明「那是远端作业、本机侧读不到、去远端读」——把「不在
//!   这一侧」说成「不存在」正是本模块顶部注释要避免的误导。
//! - `job_list` 把两台 manager 的结果**合并**（各自用与本侧语义相符的过滤，
//!   见 [`JobListFilters`]），按启动时间统一排序；围栏在 manager 内部，两边
//!   同一套（`owned_by_conversation`）。

use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;
use tauri::Manager;

use crate::agent::risk::Disposition;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::command_exec::{
    CancelReason, CommandExecutionManager, JobCaller, JobFilter, JobInfo, JobOutputResult,
    JobStatus,
};
use crate::error::AppError;

/// 单次 `job_output(wait=true)` 的等待上限（对齐 DSH 的 `maxWaitTimeoutMs`）。
///
/// 模型传更大的值也会被压到这里：等待是**模型自己选的**（它觉得下一步真的
/// 依赖结果），但一个超大的等待值会把整轮任务钉住——用户看到的「停止」也要
/// 等它返回才生效。等不到就先按现状回答（返回 `[status: running]`），
/// 作业的结局随后由通知交回来。
const MAX_JOB_WAIT_TIMEOUT_MS: u64 = 600_000;

/// `job_output(wait=true)` 未给 `timeout_ms` 时的默认等待时长。
const DEFAULT_JOB_WAIT_TIMEOUT_MS: u64 = 30_000;

/// 本工具调用的作业归属身份。
///
/// 归属对话是**根对话**（子 agent 派发的作业记在派它的那个用户对话名下），
/// 它跨应用重启仍然有效——重启后 `job_list` 靠它把上一次运行的作业认回来。
/// 拿不到时退化为"不设限"，避免老调用路径突然看不到自己的作业。
fn tool_caller(ctx: &ToolContext) -> JobCaller<'_> {
    JobCaller::Agent {
        owner_conversation_id: ctx.owner_conversation_id.as_deref(),
    }
}

/// 解析工具上下文中注入的统一命令执行管理器。
fn command_exec(
    ctx: &ToolContext,
) -> Result<&crate::command_exec::CommandExecutionManager, AppError> {
    ctx.command_exec.as_ref().ok_or_else(|| {
        AppError::Agent("command_exec manager not configured in tool context".into())
    })
}

/// 本机执行管理器句柄（经 AppHandle 取）。
///
/// 取法与 ctx 侧别无关：根 agent（远端 ctx）也要能读到本机子 agent 派发、
/// 记在同一归属对话名下的作业。
fn local_command_exec(ctx: &ToolContext) -> CommandExecutionManager {
    ctx.app_handle
        .state::<crate::AppState>()
        .local_command_exec
        .clone()
}

/// 作业 id 是不是本机（用户这台电脑）作业。
///
/// 判据是 **id 形状**：本机 id 前缀由本机 manager 构造时指定
/// （`with_id_prefix`），形状只在
/// [`CommandExecutionManager::LOCAL_JOB_ID_PREFIX`] 定义一次。
///
/// `pub(crate)`：界面侧的 `commands::job` 也按同一条前缀判据路由（它没有
/// 「ctx 侧别」这一维，理由见那里的说明），判据必须同源。
pub(crate) fn is_local_job_id(job_id: &str) -> bool {
    job_id.starts_with(CommandExecutionManager::LOCAL_JOB_ID_PREFIX)
}

/// 一次作业调用该走哪一侧的 manager。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JobSide {
    /// 远端（SSH 会话那台机器）的 manager。
    Remote,
    /// 本机（用户自己这台电脑）的 manager。
    Local,
}

impl JobSide {
    /// 作业所在的一侧是不是用户本机（决定收尾文案说「本机管道」还是
    /// 「SSH 通道」，不能另按 id 形状再判一次——两处判据迟早分叉）。
    fn is_local(self) -> bool {
        matches!(self, Self::Local)
    }
}

/// `(id 形状 × ctx 侧别)` 四象限的**唯一判据**：哪一侧的 manager 读得到它。
///
/// - 本机 id → 本机 manager，不分 ctx 侧别：根 agent 是远端 ctx，可它同样要读
///   自己对话名下、本机子 agent 派发的作业；
/// - 远端 id + 远端 ctx → 远端 manager（不变）；
/// - 远端 id + 本机 ctx → `Err(文案)`：这一侧读不到。本机 ctx 的
///   `ctx.command_exec` 挂的就是本机 manager（见 `agent_loop` 的 ctx 组装），
///   拿它去查远端作业只会得到 manager 的「本进程在册表与台账里都查不到」——
///   而那条作业真实存在，只是记在**另一侧**的 manager 里、同一归属对话在远端
///   （根 agent）侧读得到。
///
/// 纯函数（不进 ctx / AppHandle）：单测能直接钉住四象限与失败文案。
fn resolve_job_side(local_side: bool, job_id: &str) -> Result<JobSide, String> {
    match (is_local_job_id(job_id), local_side) {
        (true, _) => Ok(JobSide::Local),
        (false, false) => Ok(JobSide::Remote),
        (false, true) => Err(remote_job_on_local_side_message(job_id)),
    }
}

/// 本机 ctx 拿到远端 id 时的失败文案。
///
/// **不能**沿用 manager 的 `job_not_found_message`（那段断言「本进程的在册作业表
/// 与作业台账里都查不到它」）：作业真实存在，只是记在另一侧的 manager 里。
/// 这里说清「它是什么、本机侧为什么读不到、该去哪一侧读」，不新造「查无此作业」
/// 的措辞。
fn remote_job_on_local_side_message(job_id: &str) -> String {
    format!(
        "job '{}' 是远端作业（id 形如 job_N，跑在 SSH 会话那台机器上），不是本机作业\
         （本机 id 形如 local_job_N）：本机侧读不到它——它记在远端侧，同一归属对话在\
         远端 / 根 agent 里读得到。要读它的输出或终止它，请在远端（根 agent）里调用\
         job_output / job_kill；本机侧能读的只有 local_job_N 开头的本机作业。",
        job_id
    )
}

/// 一条作业调用解析出的目标：manager 与侧别在**同一次判定**里一起给出。
struct JobTarget {
    manager: CommandExecutionManager,
    side: JobSide,
}

/// 解析处理这个 job_id 的 manager（含「这一侧读不到」的明确失败）。
///
/// 失败原样是工具失败（`AppError::Agent`），文案由
/// [`remote_job_on_local_side_message`] 给出——与 manager 自己的
/// `job_not_found_message` / `job_foreign_message` 区分开：那两条说的是
/// 「这一侧确实没有」，而这里是「在另一侧、本机读不到」。
fn job_target(ctx: &ToolContext, job_id: &str) -> Result<JobTarget, AppError> {
    match resolve_job_side(ctx.local_side, job_id) {
        Ok(JobSide::Remote) => Ok(JobTarget {
            manager: command_exec(ctx)?.clone(),
            side: JobSide::Remote,
        }),
        Ok(JobSide::Local) => Ok(JobTarget {
            manager: local_command_exec(ctx),
            side: JobSide::Local,
        }),
        Err(message) => Err(AppError::Agent(message)),
    }
}

/// `job_list` 半边各自的过滤条件（纯数据：不依赖 AppHandle，单测可直接覆盖
/// 「本机作业按归属对话围栏」这段决策）。
#[derive(Debug, PartialEq, Eq)]
enum JobScopeFilter {
    Session(String),
    OwnerConversation(String),
}

impl JobScopeFilter {
    fn as_filter(&self) -> JobFilter<'_> {
        match self {
            Self::Session(sid) => JobFilter::Session(sid),
            Self::OwnerConversation(conv) => JobFilter::OwnerConversation(conv),
        }
    }
}

/// `job_list` 两半各自的过滤条件。
struct JobListFilters {
    /// 远端半边：与今天完全一致（归属对话优先，拿不到归属才退到会话）。
    remote: JobScopeFilter,
    /// 本机半边。
    local: JobScopeFilter,
    /// 要不要查远端管理器。
    include_remote: bool,
}

impl JobListFilters {
    /// 拆成 `owner_conversation_id` / `session_id` / `local_side` 传参而不是收
    /// `&ToolContext`：这段决策不碰 AppHandle，单测能直接钉住。
    fn for_caller(owner_conversation_id: Option<&str>, session_id: &str, local_side: bool) -> Self {
        let remote = match owner_conversation_id {
            Some(conv) => JobScopeFilter::OwnerConversation(conv.to_string()),
            None => JobScopeFilter::Session(session_id.to_string()),
        };
        let local = match owner_conversation_id {
            // 本机作业的 session_id 恒是本机子任务的哨兵 "local"（`local_subagent`
            // 的固定值，**所有对话共用这一个**）：按会话过滤等于不过滤，会把别的
            // 对话的本机作业列出来。归属对话才是本机作业的围栏键，有归属就一定
            // 按归属过滤（与远端共用同一套 `owned_by_conversation` 语义）。
            Some(conv) => JobScopeFilter::OwnerConversation(conv.to_string()),
            // 拿不到归属（老调用路径 / 测试）：退回今天的按会话过滤。本机 ctx 的
            // 会话就是哨兵 "local"，照旧看得到本机作业；非本机 ctx 的会话是真
            // UUID，匹配不到任何本机作业——宁可不列，也不漏出别的对话的。
            None => JobScopeFilter::Session(session_id.to_string()),
        };
        // 本机 ctx（本机子 agent）不查远端半：它读不到——`job_output` /
        // `job_kill` 的四象限判据在「远端 id + 本机 ctx」这一格上是明确失败
        // （见 [`resolve_job_side`]）。列一条自己读不了的记录只会把模型引向
        // 错误结论（本机子 agent 的工具集本来就剔除了远端工具，见
        // `tools/mod.rs` 的 `LOCAL_SUB_EXCLUDED_TOOLS`）。
        Self {
            remote,
            local,
            include_remote: !local_side,
        }
    }
}

/// 合并两半的作业列表，按启动时间升序（与单台 `list_jobs` 的既有排序规则
/// 一致）。远端半边先入列且排序稳定，所以时间戳相同时保持「先远端后本机」，
/// 远端半边内部的相对顺序与今天逐条一致。
///
/// `pub(crate)`：界面侧的 `commands::job::job_list` 也合并同样两台 manager
/// 的列表，排序规则必须共用这一份（两边各写一套必然分叉）。
pub(crate) fn merge_job_lists(remote: Vec<JobInfo>, local: Vec<JobInfo>) -> Vec<JobInfo> {
    let mut merged = remote;
    merged.extend(local);
    merged.sort_by_key(|j| j.started_at_millis);
    merged
}

/// 终止来源的 Agent 可读文案。只有「用户在界面手动终止」（User）才说
/// 用户主动终止——Agent 自己 job_kill、任务级联取消各有独立文案；
/// 旧数据/未知来源（None）与断连保持中性，由调用方回退机器状态行，
/// 绝不冒充用户终止。
fn termination_message(reason: Option<CancelReason>) -> Option<&'static str> {
    match reason {
        Some(CancelReason::User) => {
            Some("[用户主动终止：作业已被用户在界面手动终止，命令未完成。]")
        }
        Some(CancelReason::Agent) => Some("[作业已被 Agent 终止（job_kill），命令未完成。]"),
        Some(CancelReason::Task) => Some("[所属 Agent 任务已取消，作业随之终止，命令未完成。]"),
        // 应用退出不是「谁终止了它」：没人发过信号，远端进程可能还在跑。
        // 这条文案只说明我们这侧的事实，不替远端下结论。
        Some(CancelReason::RuntimeRestart) => Some(
            "[作业随上一次应用运行中断：应用退出时通道被关闭，之后的输出再也读不到；\
             这条记录和你退出前抓到的输出保留了下来，远端命令是否还在运行未知（没人发过信号）。]",
        ),
        Some(CancelReason::Disconnected) | None => None,
    }
}

/// 作业状态尾巴：`[status: completed, exit code: 3]`（有退出事实时带上，
/// 格式对齐 DSH 的 status line）。
/// Killed 且来源明确 → 终止文案；其余（含旧数据 Killed 无来源）保持
/// `[status: ...]` 机器行不变。
fn job_status_suffix(
    status: JobStatus,
    cancel_reason: Option<CancelReason>,
    detail: Option<&str>,
) -> String {
    // 中断与终止都带「谁/什么结束了它」的说明——机器状态行不够用。
    if matches!(status, JobStatus::Killed | JobStatus::Interrupted) {
        if let Some(msg) = termination_message(cancel_reason) {
            return format!("\n{}", msg);
        }
    }
    match detail.filter(|d| !d.is_empty()) {
        Some(detail) => format!("\n[status: {}, {}]", status, detail),
        None => format!("\n[status: {}]", status),
    }
}

/// 回读丢内容时的说明。丢掉的字节数与「有没有别处能补」都写清楚——
/// 溢出文件在**用户本机**（应用私有目录），模型读不到，所以补的办法只有
/// 「服务端自己再跑一次产生同样的输出」，这里不编造别的出路。
fn lossy_notice(skipped_bytes: usize, spill_path: Option<&str>) -> String {
    let where_to = match spill_path {
        Some(path) => format!("；本机溢出文件：{}（该缺口未能从文件补齐）", path),
        None => "；溢出文件也不可用（写入被放弃或未覆盖该区间）".to_string(),
    };
    format!(
        "[本次跳过了 {} 字节无法读取的输出（内存窗口已滑出）{}。返回的 offset 已跨过该缺口；已展示的前缀和后续尾巴不代表连续内容。]",
        skipped_bytes, where_to
    )
}

/// 存储层已按预算分页。只说明未扫描的快照范围，不把它冒充为保证可读的字节数。
fn continuation_notice(next_offset: usize, snapshot_end: usize) -> Option<String> {
    (next_offset < snapshot_end).then(|| format!(
        "[本次快照中还有 {} 字节的输出范围未读（其中若有缺口，续读时会明确说明）：用 job_output(job_id=…, offset={}) 接着往下读，不要从头再读。offset 是原始字节偏移，不要用显示文本长度重算。]",
        snapshot_end - next_offset, next_offset
    ))
}

/// 对同一条作业连续不带 `wait` 读到第几次开始提醒模型别再轮询。
const UNWAITED_POLL_REMINDER_AT: u32 = 4;

/// 轮询提醒：对同一条仍在运行的作业连续不带 `wait` 读了 [`UNWAITED_POLL_REMINDER_AT`] 次
/// 及以上，就在结果末尾直说「别再这样等」以及该怎么办（此后每次读取都会带上，直到它
/// 传 `wait` 或作业结算）。
///
/// 只提醒，不替模型等、不改读取语义。措辞刻意不假定调用方是谁：根 agent 是被系统叫醒，
/// 子 agent 的作业结局则交给派发它的那条对话——两边都成立的说法只有「结算时系统会自动
/// 通知，不用盯着」。
fn unwaited_poll_notice(unwaited_polls: u32, status: JobStatus) -> Option<String> {
    if status != JobStatus::Running || unwaited_polls < UNWAITED_POLL_REMINDER_AT {
        return None;
    }
    Some(format!(
        "[提醒：你已对这条作业连续 {} 次不带 wait 地读取。反复轮询只是白花 token：作业结算时\
         系统会自动通知，不用盯着它。没有别的事可做，就结束这一轮；下一步确实依赖它的结果，\
         用 job_output(wait=true) 一次等够（单次最长 10 分钟）。]",
        unwaited_polls
    ))
}

// ───────────────────────── job_output ─────────────────────────

pub struct JobOutputTool;

impl JobOutputTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for JobOutputTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for JobOutputTool {
    fn name(&self) -> &str {
        "job_output"
    }

    fn description(&self) -> &str {
        "Read output from a background job started with `bash(run_in_background: true)` on the \
         remote server, or with `local_bash(run_in_background: true)` on the user's own \
         computer (local job ids look like `local_job_1`, remote ones like `job_1`). \
         The command runs on that machine, but the job record — its id, status, and \
         the output captured so far — belongs to this app, not to the machine. Records \
         survive an app restart: a job still running when the app exited comes back as \
         `interrupted`, with everything captured before the exit still readable here (the \
         channel died with the app, so no further output exists, and whether the process \
         is still running is unknown — check with ps/pgrep). \
         Reads are incremental via `offset` (pass back the offset from the previous read); \
         set `wait: true` to block until new output arrives or the job settles (only when \
         your next step genuinely depends on it; the wait is capped at 10 minutes, and a \
         timed-out wait returns `[status: running]`). \
         IF ALL YOU WANT IS TO WAIT for this job to finish: stop — do not call any tool, \
         do not poll. Just write a short line saying you are waiting for it to finish and \
         end your turn (an EMPTY reply is treated as a failure, so do not leave the reply \
         blank). The outcome comes back to you automatically when the job settles: if you \
         are still working, the settlement notice is injected into your current turn; if \
         you have already ended the turn, the system opens a NEW turn for you. Polling with \
         `wait` in the meantime only burns a call and at best hits the 10-minute cap. \
         Two limits on the automatic turn: it is only opened for jobs that finish on their \
         own — a job the user kills while you are idle is not re-announced (its outcome is \
         still readable here); and consecutive automatic turns are capped per user message, \
         past which the outcome waits until the user writes again — also readable here. \
         Every response ends with `[status: ...]` (plus the exit fact, e.g. \
         `[status: completed, exit code: 3]`). If output was dropped or clipped, the \
         response says so explicitly — read it."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "string",
                    "description": "Unique ID of the background job: `job_N` for a remote job, `local_job_N` for a job on the user's own computer (both from job_list)."
                },
                "offset": {
                    "type": "integer",
                    "description": "Starting byte offset to read output from. Defaults to 0 for initial read."
                },
                "wait": {
                    "type": "boolean",
                    "description": "If true, blocks until new output arrives or the job finishes (up to timeout_ms). Only when the next step genuinely depends on it. Defaults to false."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Max time in milliseconds to wait when wait=true. Defaults to 30000 (30s), capped at 600000 (10 min)."
                }
            },
            "required": ["job_id"]
        })
    }

    fn disposition(&self) -> Disposition {
        Disposition::Allow
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let job_id = params
            .get("job_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'job_id' parameter".into()))?;

        let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

        let wait = params
            .get("wait")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let timeout_ms = params
            .get("timeout_ms")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_JOB_WAIT_TIMEOUT_MS)
            .min(MAX_JOB_WAIT_TIMEOUT_MS);

        let target = job_target(ctx, job_id)?;
        let result = target
            .manager
            .job_output(
                job_id,
                offset,
                JobOutputResult::MAX_READ_BYTES,
                wait,
                Duration::from_millis(timeout_ms),
                tool_caller(ctx),
            )
            .await?;

        // 回读可能丢内容（内存窗口滑出、溢出文件不可用）：必须说出来。
        let mut notes: Vec<String> = Vec::new();
        if result.lossy {
            notes.push(lossy_notice(
                result.skipped_bytes,
                result.spill_path.as_deref(),
            ));
        }
        if result.invalid_utf8 {
            notes.push("[输出含无效 UTF-8，显示时已使用替换字符；offset 仍按原始字节推进，不代表丢失了额外字节。]".to_string());
        }
        if let Some(note) = continuation_notice(result.offset, result.snapshot_end) {
            notes.push(note);
        }
        if let Some(note) = unwaited_poll_notice(result.unwaited_polls, result.status) {
            notes.push(note);
        }

        let status_suffix = job_status_suffix(
            result.status,
            result.cancel_reason,
            result.detail.as_deref(),
        );
        let mut output_text = if result.delta.is_empty() {
            if result.lossy {
                "(该输出区间已无法读取)"
            } else {
                "(无新输出)"
            }
            .to_string()
        } else {
            result.delta
        };
        output_text.push_str(&status_suffix);
        for note in notes {
            output_text.push('\n');
            output_text.push_str(&note);
        }

        let summary = format!(
            "job_output({}) -> {} bytes{}",
            job_id,
            output_text.len(),
            status_suffix
        );

        Ok(ToolOutput::ok(summary, output_text).with_metadata(json!({
            "job_id": result.job_id,
            "offset": result.offset,
            "text_start_offset": result.text_start_offset,
            "snapshot_end": result.snapshot_end,
            "invalid_utf8": result.invalid_utf8,
            "status": result.status.to_string(),
            "detail": result.detail,
            "cancel_reason": result.cancel_reason,
            "lossy": result.lossy,
            "skipped_bytes": result.skipped_bytes,
            "spill_path": result.spill_path,
            "unwaited_polls": result.unwaited_polls,
        })))
    }
}

// ───────────────────────── job_kill ─────────────────────────

pub struct JobKillTool;

impl JobKillTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for JobKillTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for JobKillTool {
    fn name(&self) -> &str {
        "job_kill"
    }

    fn description(&self) -> &str {
        "Request cancellation of a running background job by its job ID (remote `job_N` from \
         `bash`, or local `local_job_N` from `local_bash` — the id shape tells which). \
         Stops waiting for its output and closes its channel (the SSH channel for a remote \
         job, the process pipe for a local one); the process itself is not guaranteed to stop \
         (a silent, output-redirected, or nohup/setsid-detached process keeps running — \
         verify with ps/pgrep if it matters). A job that already settled cannot be killed; \
         the response says which it was."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "string",
                    "description": "Unique ID of the background job to kill: `job_N` for a remote job, `local_job_N` for a job on the user's own computer."
                },
                "reason": {
                    "type": "string",
                    "description": "Optional human-readable reason for killing the job."
                }
            },
            "required": ["job_id"]
        })
    }

    fn disposition(&self) -> Disposition {
        Disposition::Approval
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let job_id = params
            .get("job_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'job_id' parameter".into()))?;

        let reason = params
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("Terminated by agent");

        // Agent 自己终止 → CancelReason::Agent；前端「终止」按钮经
        // commands::job::job_kill 传 User。来源会随 worker 结算落进
        // 作业实例，job_output 据此渲染「谁终止的」。
        //
        // 状态探测与终止必须走**同一台** manager（经 [`job_target`] 的四象限
        // 判据解析一次，manager 与侧别同源）：探测落到另一台上的话，那个状态
        // 与这次 kill 无关，`was_running` 会给出错误结论。
        let target = job_target(ctx, job_id)?;
        let is_local = target.side.is_local();
        let status_before = target.manager.job_status(job_id).await.ok();
        let was_running = status_before
            .map(|status| status == JobStatus::Running)
            .unwrap_or(true);
        let info = target
            .manager
            .kill_job(job_id, CancelReason::Agent, tool_caller(ctx))
            .await?;

        let summary = format!("job_kill({}) -> {}", job_id, info.status);
        let status_line = job_status_suffix(
            info.status,
            Some(CancelReason::Agent),
            info.detail.as_deref(),
        );
        let output = if status_before == Some(JobStatus::Interrupted) {
            // 上一次应用运行留下的作业：这侧早没有可关闭的通道了。说清
            // 「我们止不了它」以及现在能做什么，别假装刚把它终止了。
            // 目标机器不同，「通道」与「怎么确认残留进程」都不同：把远端那套
            // 原话套在本机作业上，会让模型去服务器上找一个本机进程。
            if is_local {
                format!(
                    "Job '{}' 是上一次应用运行留下的作业（状态 interrupted）：应用退出时它的本机管道就关闭了，本应用无法再终止它，也读不到它的新输出。{} 本机进程是否还在运行未知——要确认就在本机查（Windows 用 Get-Process / tasklist，macOS/Linux 用 ps / pgrep <关键字>）；需要停掉它，在本机按需结束对应进程。",
                    job_id,
                    status_line.trim_start()
                )
            } else {
                format!(
                    "Job '{}' 是上一次应用运行留下的作业（状态 interrupted）：应用退出时它的 SSH 通道就关闭了，本应用无法再终止它，也读不到它的新输出。{} 远端进程是否还在运行未知——要确认就用 bash 执行 ps / pgrep <关键字>；需要停掉它，在远端按需 kill 对应进程。",
                    job_id,
                    status_line.trim_start()
                )
            }
        } else if !was_running {
            // 已经结束的作业没什么可终止的：如实说「它早就结束了」，
            // 不假装刚刚终止、也不编一条没生效的理由。
            format!(
                "Job '{}' 早在这次调用之前就已经结束了，没有可终止的东西。{}\n原因参数 '{}' 未生效。",
                job_id, status_line, reason
            )
        } else if is_local {
            format!(
                "Job '{}' 已请求终止，作业结算为：{}\nReason: {}\n\
                 已停止等待输出并关闭本机命令的管道，但进程不保证已终止——只有它之后还往 stdout/stderr 写东西时，\
                 才可能因管道断开退出；静默运行、重定向了输出、脱离终端的进程会继续在这台电脑上运行。\
                 job_kill 只结算我们这侧的作业状态，不核对进程是否真的退出；必要时在本机确认残留进程（Windows：Get-Process / tasklist；macOS/Linux：ps/pgrep）并按需结束它。",
                job_id, status_line.trim_start_matches('\n'), reason
            )
        } else {
            format!(
                "Job '{}' 已请求终止，作业结算为：{}\nReason: {}\n\
                 已停止等待输出并关闭 SSH 通道，但远端进程不保证已终止——只有它之后还往 stdout/stderr 写东西时，\
                 才可能因管道断开（SIGPIPE）退出；静默运行、重定向了输出、被 nohup/setsid/& 脱离的进程会继续在服务器上运行。\
                 job_kill 只结算我们这侧的作业状态，不核对远端是否真的退出；必要时用 bash 执行 ps/pgrep 确认并按需 kill 清理。",
                job_id, status_line.trim_start_matches('\n'), reason
            )
        };

        Ok(ToolOutput::ok(summary, output).with_metadata(json!({
            "job_id": info.job_id,
            "status": info.status.to_string(),
            "detail": info.detail,
            "reason": reason,
            "was_running": was_running,
        })))
    }
}

// ───────────────────────── job_list ─────────────────────────

pub struct JobListTool;

impl JobListTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for JobListTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for JobListTool {
    fn name(&self) -> &str {
        "job_list"
    }

    fn description(&self) -> &str {
        "List the background jobs this app is tracking for you (running and already finished), \
         with their ids, descriptions, commands and statuses. These are records of commands \
         started on the remote server (ids like `job_1`) or on the user's own computer via \
         `local_bash` (ids like `local_job_1`) — not any machine's process table; they also \
         include jobs from earlier app runs, kept as `interrupted` when the app exited \
         mid-job. Use `ps`/`pgrep` via `bash` when you need to know what is actually still \
         running on a server."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["all", "running", "completed", "failed", "killed", "interrupted"],
                    "description": "Optional filter by job status. Defaults to 'all'."
                }
            }
        })
    }

    fn disposition(&self) -> Disposition {
        Disposition::Allow
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let status_filter = params.get("status").and_then(|v| v.as_str());

        // 两台 manager（远端 / 本机）合并成一份列表：各自用与本侧语义相符的
        // 过滤（见 `JobListFilters`），最后按启动时间统一排序。围栏在各 manager
        // 内部完成，两边同一套语义——本机作业不会因为「共用一个哨兵会话 id」
        // 而漏给别的对话。
        let filters = JobListFilters::for_caller(
            ctx.owner_conversation_id.as_deref(),
            &ctx.session_id,
            ctx.local_side,
        );
        let remote_jobs = if filters.include_remote {
            command_exec(ctx)?
                .list_jobs(filters.remote.as_filter(), status_filter)
                .await
        } else {
            Vec::new()
        };
        // 本机半边总是要查：远端 ctx 的根 agent 也要能看到自己对话名下、
        // 本机子 agent 派发的作业（否则唤醒通知里的 `local_job_N` 在列表里
        // 找不到，模型只能当成查无此作业）。
        let local_jobs = local_command_exec(ctx)
            .list_jobs(filters.local.as_filter(), status_filter)
            .await;
        let jobs = merge_job_lists(remote_jobs, local_jobs);

        let summary = format!("job_list -> {} jobs", jobs.len());
        let output = if jobs.is_empty() {
            // 空列表最容易被误读成「远端没有这东西」：把记录边界说明白，
            // 免得模型得出「作业已完成、输出被清理」之类的错误结论。
            "没有匹配的后台作业。这里只列你自己派发的（上一次应用运行留下的也会列出来，状态记为 interrupted）；\
             若你确信派过却没看到：换个 status 再列一次，或者它已被清理（记录保留 7 天）。\
             另外这只是本应用的记录——远端是否还有进程在跑，要用 bash 执行 ps / pgrep <关键字> 确认\
             （本机作业则在本机确认：Windows 用 Get-Process，macOS/Linux 用 ps）。"
                .to_string()
        } else {
            let items: Vec<String> = jobs
                .iter()
                .map(|j| {
                    let detail = j
                        .detail
                        .as_deref()
                        .filter(|d| !d.is_empty())
                        .map(|d| format!(" ({})", d))
                        .unwrap_or_default();
                    format!(
                        "- ID: {}\n  Description: {}\n  Command: {}\n  Status: {}{}\n  Bytes: {}",
                        j.job_id, j.description, j.command, j.status, detail, j.total_output_bytes
                    )
                })
                .collect();
            items.join("\n\n")
        };

        Ok(ToolOutput::ok(summary, output).with_metadata(json!({
            "count": jobs.len(),
            "jobs": jobs,
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        continuation_notice, is_local_job_id, job_status_suffix, lossy_notice, merge_job_lists,
        remote_job_on_local_side_message, resolve_job_side, termination_message,
        unwaited_poll_notice, JobListFilters, JobScopeFilter, JobOutputTool, JobSide,
        UNWAITED_POLL_REMINDER_AT,
    };
    use crate::agent::tools::AgentTool;
    use crate::command_exec::{CancelReason, JobInfo, JobStatus};

    /// 描述里「只想等它跑完就别调工具」这句必须**照着真实机制**写。
    ///
    /// 三件事一起钉住：
    /// 1. 确实存在自动回来这回事（否则这句就是骗模型，它会放着作业不管）；
    /// 2. 不许写成「什么都不要做」——空回复会被 `classify_text_reply` 判成哑火，
    ///    补问一次后仍空就按失败收场（`phases.rs` 的 `TextReply::Empty`），
    ///    所以必须要求补一句「我在等」；
    /// 3. 两条边界（被用户掐掉的作业不重开轮、自动开轮有额度）要写出来，
    ///    免得模型以为任何结局都会自己找上来。
    #[test]
    fn description_says_idling_beats_polling_for_a_settling_job() {
        let tool = JobOutputTool::new();
        let desc = tool.description();
        assert!(desc.contains("IF ALL YOU WANT IS TO WAIT"), "缺少「只想等就别调工具」段");
        assert!(
            desc.contains("do not call any tool"),
            "要让模型明确不调工具，而不是继续用 wait 轮询"
        );
        assert!(
            desc.contains("EMPTY reply is treated as a failure"),
            "必须要求补一句「我在等」：空回复会被当成哑火判失败"
        );
        assert!(
            desc.contains("opens a NEW turn"),
            "自动回来这件事要写明（前端 jobWake 会为已收尾的回合开新一轮）"
        );
        assert!(
            desc.contains("finish on their own") && desc.contains("capped per user message"),
            "两条边界（用户掐掉的作业不重开轮、自动开轮有额度）都要写出来"
        );
    }

    /// 造一条作业记录（只给列表合并测试用，字段值不影响排序语义）。
    fn job(job_id: &str, started_at_millis: u128) -> JobInfo {
        JobInfo {
            job_id: job_id.into(),
            session_id: "local".into(),
            task_id: None,
            owner_conversation_id: Some("conv-a".into()),
            description: String::new(),
            command: String::new(),
            status: JobStatus::Running,
            detail: None,
            started_at_millis,
            finished_at_millis: None,
            total_output_bytes: 0,
        }
    }

    #[test]
    fn local_job_ids_are_recognized_by_prefix_only() {
        // 前缀识别是四象限判据的一半（另一半是 ctx 侧别，见 `resolve_job_side`）：
        // 把远端 `job_N` 误判成本机会让 job_output 打到本机管理器、把一条真实
        // 存在的远端作业报成这一侧没有它。
        assert!(is_local_job_id("local_job_1"));
        assert!(is_local_job_id("local_job_42"));
        assert!(!is_local_job_id("job_1"));
        assert!(!is_local_job_id("job_"));
        assert!(!is_local_job_id(""));
        // 必须从头匹配：只是包含前缀的不算（远端作业的 id 不会被"夹带"判成本机）
        assert!(!is_local_job_id("x_local_job_1"));
    }

    #[test]
    fn job_side_resolution_covers_all_four_quadrants() {
        // (id 形状 × ctx 侧别) 四象限。只有「远端 id + 本机 ctx」是失败——
        // 本机 ctx 的 ctx.command_exec 就是本机 manager，拿它查远端作业只会
        // 得到「本进程查不到」，而作业其实在另一侧。
        assert_eq!(resolve_job_side(false, "job_3"), Ok(JobSide::Remote));
        assert_eq!(resolve_job_side(false, "local_job_7"), Ok(JobSide::Local));
        // 远端 ctx（根 agent）也要读本机作业：本机 id 不分侧别
        assert_eq!(resolve_job_side(true, "local_job_7"), Ok(JobSide::Local));
        let err = resolve_job_side(true, "job_3").expect_err("远端 id + 本机 ctx 必须明确失败");
        assert!(err.contains("远端作业"), "{err}");
        // 失败只发生在那一个象限：其余三格都不许多报错
        assert!(resolve_job_side(true, "local_job_1").is_ok());
        assert!(resolve_job_side(false, "job_1").is_ok());
    }

    #[test]
    fn local_ctx_error_names_the_remote_side_not_a_missing_job() {
        // 本机 ctx 拿远端 id：文案必须说清「那是远端作业 / 本机侧读不到 /
        // 去远端（根 agent）读」，绝不能沿用 manager 那套「本进程的在册作业表
        // 与作业台账里都查不到它」——作业真实存在，只是记在另一侧的 manager 里。
        let msg = remote_job_on_local_side_message("job_3");
        assert!(msg.contains("job_3"), "{msg}");
        assert!(msg.contains("远端作业"), "{msg}");
        assert!(msg.contains("本机侧读不到"), "{msg}");
        assert!(msg.contains("根 agent"), "{msg}");
        assert!(msg.contains("job_output"), "{msg}");
        assert!(msg.contains("job_kill"), "{msg}");
        assert!(!msg.contains("查不到"), "{msg}");
        assert!(!msg.contains("查无此作业"), "{msg}");
        assert!(!msg.contains("在册作业表"), "{msg}");
    }

    #[test]
    fn list_filters_scope_local_half_by_owner_conversation() {
        // 有归属对话：两半都按归属过滤。本机作业共用一个哨兵会话 id
        // （"local"），按会话过滤会把别的对话的本机作业列出来。
        let f = JobListFilters::for_caller(Some("conv-a"), "local", false);
        assert_eq!(f.remote, JobScopeFilter::OwnerConversation("conv-a".into()));
        assert_eq!(f.local, JobScopeFilter::OwnerConversation("conv-a".into()));
        assert!(f.include_remote, "远端 ctx 照常查远端半边");

        // 本机 ctx（本机子 agent）：只列本机半边——远端 id 在它这里读不到
        // （job_output 按 id 形状路由到本机管理器），列出来只会误导。
        let f = JobListFilters::for_caller(Some("conv-a"), "local", true);
        assert!(!f.include_remote);
        assert_eq!(f.local, JobScopeFilter::OwnerConversation("conv-a".into()));

        // 拿不到归属（老调用路径 / 测试）：退回今天的按会话过滤。本机 ctx 的
        // 会话是哨兵 "local"；真会话 id 匹配不到任何本机作业（宁可不列）。
        let f = JobListFilters::for_caller(None, "local", true);
        assert_eq!(f.local, JobScopeFilter::Session("local".into()));
        assert_eq!(f.remote, JobScopeFilter::Session("local".into()));
        let f = JobListFilters::for_caller(None, "s-uuid", false);
        assert_eq!(f.local, JobScopeFilter::Session("s-uuid".into()));
        assert_eq!(f.remote, JobScopeFilter::Session("s-uuid".into()));
    }

    #[test]
    fn merged_list_sorts_by_started_at_keeping_remote_first_on_ties() {
        // 合并后只有一套排序规则（启动时间升序，与单台 list_jobs 一致）；
        // 时间戳相同的两条保持「先远端后本机」（排序稳定），远端半边的内部
        // 顺序因此与今天逐条一致。
        let remote = vec![job("job_2", 20), job("job_1", 10)];
        let local = vec![job("local_job_1", 15), job("local_job_2", 10)];
        let merged = merge_job_lists(remote, local);
        let ids: Vec<&str> = merged.iter().map(|j| j.job_id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["job_1", "local_job_2", "local_job_1", "job_2"],
            "合并列表必须按 started_at_millis 统一排序"
        );
    }

    #[test]
    fn user_kill_says_user_terminated() {
        let msg = termination_message(Some(CancelReason::User)).unwrap();
        assert!(msg.contains("用户主动终止"));
        assert!(!msg.contains("status: killed"));
    }

    #[test]
    fn agent_and_task_kills_do_not_impersonate_user() {
        let agent = termination_message(Some(CancelReason::Agent)).unwrap();
        let task = termination_message(Some(CancelReason::Task)).unwrap();
        for msg in [agent, task] {
            assert!(!msg.contains("用户主动终止"));
            assert!(msg.contains("命令未完成"));
        }
        assert!(agent.contains("Agent"));
        assert!(task.contains("任务已取消"));
    }

    #[test]
    fn unknown_reason_keeps_neutral_machine_status() {
        // 旧数据/原因缺失：保持原样，不冒充任何终止来源
        assert_eq!(
            job_status_suffix(JobStatus::Killed, None, None),
            "\n[status: killed]"
        );
        assert_eq!(
            job_status_suffix(JobStatus::Killed, Some(CancelReason::Disconnected), None),
            "\n[status: killed]"
        );
    }

    #[test]
    fn non_killed_statuses_keep_machine_status_suffix() {
        assert_eq!(
            job_status_suffix(JobStatus::Running, None, None),
            "\n[status: running]"
        );
        assert_eq!(
            job_status_suffix(JobStatus::Completed, None, None),
            "\n[status: completed]"
        );
        assert_eq!(
            job_status_suffix(JobStatus::Failed, None, None),
            "\n[status: failed]"
        );
    }

    #[test]
    fn exit_detail_is_rendered_into_the_status_line() {
        // 退出事实进状态行（对齐 DSH 的 `[status: completed, exit code: 3]`）
        assert_eq!(
            job_status_suffix(JobStatus::Completed, None, Some("exit code: 3")),
            "\n[status: completed, exit code: 3]"
        );
        // 空 detail 不制造空占位
        assert_eq!(
            job_status_suffix(JobStatus::Completed, None, Some("")),
            "\n[status: completed]"
        );
        // 终止来源文案优先于 detail（谁终止的比机器状态更重要）
        assert_eq!(
            job_status_suffix(
                JobStatus::Killed,
                Some(CancelReason::Agent),
                Some("signal: KILL")
            ),
            "\n[作业已被 Agent 终止（job_kill），命令未完成。]"
        );
    }

    #[test]
    fn lossy_notice_reports_bytes_and_where_to_find_more() {
        let with_spill = lossy_notice(
            4096,
            Some("/home/u/.config/app/jobs_temp/marcel-job-job_1-1.log"),
        );
        assert!(with_spill.contains("4096"));
        assert!(with_spill.contains("marcel-job-job_1-1.log"));
        let without = lossy_notice(12, None);
        assert!(without.contains("12"));
        assert!(without.contains("不可用"));
    }

    #[test]
    fn continuation_uses_storage_cursor_not_display_length() {
        // UTF-8 替换或缺口都可能让显示长度 != 原始游标；这里禁止再算 cut。
        let note = continuation_notice(131_077, 200_000).unwrap();
        assert!(note.contains("offset=131077"));
        assert!(note.contains("68923 字节的输出范围未读"));
        assert!(note.contains("若有缺口"));
        assert!(!note.contains("内容不会丢"));
        assert!(continuation_notice(200_000, 200_000).is_none());
        assert!(continuation_notice(200_001, 200_000).is_none());
    }

    #[test]
    fn poll_reminder_starts_at_the_fourth_unwaited_read_and_keeps_going() {
        assert_eq!(UNWAITED_POLL_REMINDER_AT, 4, "产品约定：连续第 4 次起提醒");
        for n in 0..4 {
            assert!(
                unwaited_poll_notice(n, JobStatus::Running).is_none(),
                "第 {n} 次不该提醒"
            );
        }
        // 第 4 次起每次都提醒（只提醒一次的话，模型第 5 次就又忘了）
        for n in 4..=9 {
            let notice = unwaited_poll_notice(n, JobStatus::Running).expect("该提醒");
            assert!(notice.contains(&format!("连续 {n} 次")), "{notice}");
        }
    }

    #[test]
    fn poll_reminder_tells_the_model_what_to_do_instead() {
        let notice = unwaited_poll_notice(4, JobStatus::Running).unwrap();
        assert!(notice.contains("job_output(wait=true)"), "{notice}");
        assert!(notice.contains("结束这一轮"), "{notice}");
        // 措辞不能假定调用方是根 agent（子 agent 的作业结局交给派它的对话）
        assert!(!notice.contains("唤醒你"), "{notice}");
        // 只提醒，不谎称系统替它做过什么
        assert!(!notice.contains("替你等"), "{notice}");
    }

    #[test]
    fn poll_reminder_is_silent_once_the_job_is_no_longer_running() {
        for status in [JobStatus::Completed, JobStatus::Failed, JobStatus::Killed] {
            assert!(unwaited_poll_notice(9, status).is_none(), "{status:?}");
        }
    }

    #[test]
    fn gap_notice_never_promises_a_complete_spill_file() {
        let note = lossy_notice(4096, Some("local.log"));
        assert!(note.contains("4096"));
        assert!(note.contains("未能从文件补齐"));
        assert!(note.contains("offset 已跨过"));
        assert!(!note.contains("完整输出文件在本机"));
    }
}
