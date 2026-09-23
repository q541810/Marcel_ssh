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

use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;

use crate::agent::risk::Disposition;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::command_exec::{CancelReason, JobCaller, JobFilter, JobStatus};
use crate::error::AppError;

/// 单次 `job_output` 回给模型的字节上限。
///
/// 超出就只回前一段并把 `offset` 推到读到的位置：模型可以继续用
/// `offset` 往下读，整段内容一条不丢（这是 offset 语义的好处，不学
/// DSH 的滚动窗口——那个窗口滑过就把开头吞了）。
const MAX_JOB_READ_BYTES: usize = 32_000;

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

fn owner_filter(ctx: &ToolContext) -> JobFilter<'_> {
    match ctx.owner_conversation_id.as_deref() {
        Some(conv) => JobFilter::OwnerConversation(conv),
        None => JobFilter::Session(&ctx.session_id),
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
        Some(path) => format!("；完整输出文件在本机：{}", path),
        None => "；完整输出文件也不可用（写入被放弃或未覆盖该区间）".to_string(),
    };
    format!(
        "[有 {} 字节的输出不在本应用里了（内存窗口已滑出）{}。下面是其后仍能读到的部分。]",
        skipped_bytes, where_to
    )
}

/// 按单次上限切一段回读结果。切在字符边界上，返回（给模型的文本、
/// 下次该用的 offset、截断说明）。
///
/// 续读偏移必须从**这段文本在输出流里的起点**推（`text_start_offset + cut`），
/// 不能拿请求的 `from_offset` 推：回读丢内容时文本起点在请求起点之后
/// （只回尾巴时起点是内存窗口起点），按请求起点推出来的偏移会落回已读过
/// 的那段之前，模型会反复拿到同一段首字节。
fn chunk_read(
    text: &str,
    text_start_offset: usize,
    next_offset: usize,
    skipped_bytes: usize,
) -> (String, usize, Option<String>) {
    if text.len() <= MAX_JOB_READ_BYTES {
        return (text.to_string(), next_offset, None);
    }
    let mut cut = MAX_JOB_READ_BYTES;
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    let kept = &text[..cut];
    let remaining = text.len() - cut;
    let resume = text_start_offset + cut;
    let note = if skipped_bytes > 0 {
        format!(
            "[本次只回读了从输出流第 {} 字节起的这段文本的前 {} 字节（这段还剩 {} 字节没读，其中夹着 {} 字节读不到的空洞——那部分内容已经不在本应用里了）：用 job_output(job_id=…, offset={}) 接着往下读，不要从头再读。]",
            text_start_offset, cut, remaining, skipped_bytes, resume
        )
    } else {
        format!(
            "[本次只回读了从输出流第 {} 字节起的这段文本的前 {} 字节（这段还剩 {} 字节没读）：用 job_output(job_id=…, offset={}) 接着往下读，内容不会丢。]",
            text_start_offset, cut, remaining, resume
        )
    };
    (kept.to_string(), resume, Some(note))
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
        "Read output from a background job started with `bash(run_in_background: true)`. \
         The command runs on the remote server, but the job record — its id, status, and \
         the output captured so far — belongs to this app, not to the server. Records \
         survive an app restart: a job still running when the app exited comes back as \
         `interrupted`, with everything captured before the exit still readable here (the \
         channel died with the app, so no further output exists, and whether the remote \
         process is still running is unknown — check with ps/pgrep). \
         Reads are incremental via `offset` (pass back the offset from the previous read); \
         set `wait: true` to block until new output arrives or the job settles (only when \
         your next step genuinely depends on it; the wait is capped at 10 minutes, and a \
         timed-out wait returns `[status: running]`). \
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
                    "description": "Unique ID of the background job (e.g. 'job_1')."
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

        let result = command_exec(ctx)?
            .job_output(
                job_id,
                offset,
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
        let (delta, offset_used, chunk_note) = chunk_read(
            &result.delta,
            result.text_start_offset,
            result.offset,
            result.skipped_bytes,
        );
        if let Some(note) = chunk_note {
            notes.push(note);
        }

        let status_suffix = job_status_suffix(result.status, result.cancel_reason, result.detail.as_deref());
        let mut output_text = if delta.is_empty() {
            "(无新输出)".to_string()
        } else {
            delta
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
            "offset": offset_used,
            "text_start_offset": result.text_start_offset,
            "status": result.status.to_string(),
            "detail": result.detail,
            "cancel_reason": result.cancel_reason,
            "lossy": result.lossy,
            "skipped_bytes": result.skipped_bytes,
            "spill_path": result.spill_path,
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
        "Request cancellation of a running background job by its job ID. Stops waiting for \
         its output and closes the SSH channel; the remote process is not guaranteed to stop \
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
                    "description": "Unique ID of the background job to kill."
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
        let status_before = command_exec(ctx)?.job_status(job_id).await.ok();
        let was_running = status_before
            .map(|status| status == JobStatus::Running)
            .unwrap_or(true);
        let info = command_exec(ctx)?
            .kill_job(job_id, CancelReason::Agent, tool_caller(ctx))
            .await?;

        let summary = format!("job_kill({}) -> {}", job_id, info.status);
        let status_line = job_status_suffix(info.status, Some(CancelReason::Agent), info.detail.as_deref());
        let output = if status_before == Some(JobStatus::Interrupted) {
            // 上一次应用运行留下的作业：这侧早没有可关闭的通道了。说清
            // 「我们止不了它」以及现在能做什么，别假装刚把它终止了。
            format!(
                "Job '{}' 是上一次应用运行留下的作业（状态 interrupted）：应用退出时它的 SSH 通道就关闭了，本应用无法再终止它，也读不到它的新输出。{} 远端进程是否还在运行未知——要确认就用 bash 执行 ps / pgrep <关键字>；需要停掉它，在远端按需 kill 对应进程。",
                job_id,
                status_line.trim_start()
            )
        } else if !was_running {
            // 已经结束的作业没什么可终止的：如实说「它早就结束了」，
            // 不假装刚刚终止、也不编一条没生效的理由。
            format!(
                "Job '{}' 早在这次调用之前就已经结束了，没有可终止的东西。{}\n原因参数 '{}' 未生效。",
                job_id, status_line, reason
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
         started on the remote server — not the server's process table; they also include \
         jobs from earlier app runs, kept as `interrupted` when the app exited mid-job. \
         Use `ps`/`pgrep` via `bash` when you need to know what is actually still running there."
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

        let jobs = command_exec(ctx)?
            .list_jobs(owner_filter(ctx), status_filter)
            .await;

        let summary = format!("job_list -> {} jobs", jobs.len());
        let output = if jobs.is_empty() {
            // 空列表最容易被误读成「远端没有这东西」：把记录边界说明白，
            // 免得模型得出「作业已完成、输出被清理」之类的错误结论。
            "没有匹配的后台作业。这里只列你自己派发的（上一次应用运行留下的也会列出来，状态记为 interrupted）；\
             若你确信派过却没看到：换个 status 再列一次，或者它已被清理（记录保留 7 天）。\
             另外这只是本应用的记录——远端是否还有进程在跑，要用 bash 执行 ps / pgrep <关键字> 确认。"
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
    use super::{chunk_read, job_status_suffix, lossy_notice, termination_message, MAX_JOB_READ_BYTES};
    use crate::command_exec::{CancelReason, JobStatus};

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
            job_status_suffix(JobStatus::Killed, Some(CancelReason::Agent), Some("signal: KILL")),
            "\n[作业已被 Agent 终止（job_kill），命令未完成。]"
        );
    }

    #[test]
    fn lossy_notice_reports_bytes_and_where_to_find_more() {
        let with_spill = lossy_notice(4096, Some("/home/u/.config/app/jobs_temp/marcel-job-job_1-1.log"));
        assert!(with_spill.contains("4096"));
        assert!(with_spill.contains("marcel-job-job_1-1.log"));
        let without = lossy_notice(12, None);
        assert!(without.contains("12"));
        assert!(without.contains("不可用"));
    }

    #[test]
    fn oversized_read_is_chunked_with_a_resumable_offset() {
        let long = "a".repeat(MAX_JOB_READ_BYTES + 500);
        // 无空洞路径：文本起点 = 请求起点
        let (text, next, note) = chunk_read(&long, 0, long.len(), 0);
        assert_eq!(text.len(), MAX_JOB_READ_BYTES);
        let note = note.expect("超上限必有说明");
        assert!(note.contains(&format!("offset={}", MAX_JOB_READ_BYTES)));
        assert_eq!(next, MAX_JOB_READ_BYTES);
        // 不超上限：原样返回、不加说明
        let short = "abc";
        let (text, next, note) = chunk_read(short, 3, 3, 0);
        assert_eq!(text, short);
        assert_eq!(next, 3);
        assert!(note.is_none());
    }

    /// 回归：续读偏移必须按文本起点推，不能按请求的 offset 推。
    ///
    /// 丢内容时（溢出文件不可用 / 超上限）回读只能给内存尾巴，文本起点是
    /// 内存窗口起点——比请求起点靠后一大截。旧算法用 `from_offset + cut`
    /// 推续读偏移，落回尾巴开头之前，模型每次续读都拿到同一段首字节。
    #[test]
    fn chunked_read_resumes_from_the_text_start_not_the_requested_offset() {
        let ring_start = 128 * 1024;
        let skipped = 4096;
        let tail = "b".repeat(MAX_JOB_READ_BYTES + 64);
        // 调用方请求 offset=0，但返回文本的起点是 128KB 处的尾巴起点
        let (kept, resume, note) = chunk_read(&tail, ring_start, ring_start + tail.len(), skipped);

        assert_eq!(kept.len(), MAX_JOB_READ_BYTES);
        assert_eq!(
            resume,
            ring_start + MAX_JOB_READ_BYTES,
            "续读偏移要落在文本之内（起点 + 已取走字节数），不能回到请求起点"
        );

        let note = note.expect("超上限必有说明");
        assert!(note.contains(&format!("offset={}", resume)));
        assert!(
            note.contains(&format!("第 {} 字节", ring_start)),
            "{}",
            note
        );
        assert!(
            note.contains(&format!("{} 字节读不到", skipped)),
            "{}",
            note
        );
    }

    #[test]
    fn chunk_split_stays_on_char_boundary() {
        // 上限正好落在多字节字符中间时，切点必须往回收（否则会 panic）
        let unit = "测"; // 3 字节
        let count = MAX_JOB_READ_BYTES / unit.len() + 1;
        let text = unit.repeat(count);
        let (kept, next, _) = chunk_read(&text, 0, text.len(), 0);
        assert!(kept.len() <= MAX_JOB_READ_BYTES);
        assert!(text.is_char_boundary(kept.len()));
        assert_eq!(next, kept.len());
    }
}
