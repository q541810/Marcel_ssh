//! Background job operations: `job_output`, `job_kill`, and `job_list`.
//!
//! Exposes controls for monitoring and terminating background jobs initiated
//! via `bash(run_in_background: true)`. All operations delegate to
//! [`crate::command_exec::CommandExecutionManager`] — jobs live inside the
//! unified command execution system, not a separate manager.

use std::time::Duration;

use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::command_exec::{CancelReason, JobStatus};
use crate::error::AppError;

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
        Some(CancelReason::Disconnected) | None => None,
    }
}

/// `job_output` 输出尾巴：Killed 且来源明确 → 终止文案；
/// 其余（含旧数据 Killed 无来源）保持 `[status: ...]` 机器行不变。
fn job_status_suffix(status: JobStatus, cancel_reason: Option<CancelReason>) -> String {
    if status == JobStatus::Killed {
        if let Some(msg) = termination_message(cancel_reason) {
            return format!("\n{}", msg);
        }
    }
    format!("\n[status: {}]", status)
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
        "Read output from a running or completed background job. Supports incremental \
         streaming via offset tracking and optional blocking wait until new output or settlement."
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
                    "description": "If true, blocks until new output arrives or the job finishes (up to timeout_ms). Defaults to false."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Max time in milliseconds to wait when wait=true. Defaults to 30000 (30s)."
                }
            },
            "required": ["job_id"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
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
            .unwrap_or(30_000);

        let result = command_exec(ctx)?
            .job_output(job_id, offset, wait, Duration::from_millis(timeout_ms))
            .await?;

        let status_suffix = job_status_suffix(result.status, result.cancel_reason);
        let mut output_text = result.delta;
        output_text.push_str(&status_suffix);

        let summary = format!(
            "job_output({}) -> {} bytes{}",
            job_id,
            output_text.len(),
            status_suffix
        );

        Ok(ToolOutput::ok(summary, output_text).with_metadata(json!({
            "job_id": result.job_id,
            "offset": result.offset,
            "status": result.status.to_string(),
            "cancel_reason": result.cancel_reason,
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
        "Request cancellation/termination of a running background job by its job ID."
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

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::Moderate
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
        let info = command_exec(ctx)?
            .kill_job(job_id, CancelReason::Agent)
            .await?;

        let summary = format!("job_kill({}) -> {}", job_id, info.status);
        let output = format!(
            "Job '{}' is now {}. Reason: {}\n\
             已停止等待输出并向远端发送 close：普通命令通常已随之终止；\
             若作业创建了后台/守护进程（nohup、setsid、&），进程可能仍在远端运行，\
             必要时可用 bash 执行 pkill 清理。",
            job_id, info.status, reason
        );

        Ok(ToolOutput::ok(summary, output).with_metadata(json!({
            "job_id": info.job_id,
            "status": info.status.to_string(),
            "reason": reason,
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
        "List running or recent background jobs in the current SSH session with their IDs, descriptions, and statuses."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "status": {
                    "type": "string",
                    "enum": ["all", "running", "completed", "failed", "killed"],
                    "description": "Optional filter by job status. Defaults to 'all'."
                }
            }
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let status_filter = params.get("status").and_then(|v| v.as_str());

        let jobs = command_exec(ctx)?
            .list_jobs(Some(&ctx.session_id), status_filter)
            .await;

        let summary = format!("job_list -> {} jobs", jobs.len());
        let output = if jobs.is_empty() {
            "No matching background jobs found.".to_string()
        } else {
            let items: Vec<String> = jobs
                .iter()
                .map(|j| {
                    format!(
                        "- ID: {}\n  Description: {}\n  Command: {}\n  Status: {}\n  Bytes: {}",
                        j.job_id, j.description, j.command, j.status, j.total_output_bytes
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
    use super::{job_status_suffix, termination_message};
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
            job_status_suffix(JobStatus::Killed, None),
            "\n[status: killed]"
        );
        assert_eq!(
            job_status_suffix(JobStatus::Killed, Some(CancelReason::Disconnected)),
            "\n[status: killed]"
        );
    }

    #[test]
    fn non_killed_statuses_keep_machine_status_suffix() {
        assert_eq!(
            job_status_suffix(JobStatus::Running, None),
            "\n[status: running]"
        );
        assert_eq!(
            job_status_suffix(JobStatus::Completed, None),
            "\n[status: completed]"
        );
        assert_eq!(
            job_status_suffix(JobStatus::Failed, None),
            "\n[status: failed]"
        );
    }
}
