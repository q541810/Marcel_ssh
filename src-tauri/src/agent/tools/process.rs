//! `process_management` — list / inspect / signal remote processes.
//!
//! Three actions:
//! - `list` (ReadOnly)         : `ps -eo pid,user,pcpu,pmem,etime,comm,args`
//! - `info` (ReadOnly)         : `ps -p <pid> -o ...` + `cat /proc/<pid>/status`
//! - `kill` (HighRisk)         : `kill -<sig> <pid>`
//!
//! For destructive actions (`kill`), the higher-level agent loop is expected
//! to gate the call behind a user-approval flow based on
//! [`AgentTool::risk_level`] and the per-action risk reported in metadata.

use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{shell_escape, truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

const MAX_OUTPUT_BYTES: usize = 8_000;
const DEFAULT_LIST_LIMIT: u64 = 50;

/// POSIX signal names accepted by `kill(1)`. Anything else is rejected.
const ALLOWED_SIGNALS: &[&str] = &[
    "TERM", "KILL", "HUP", "INT", "QUIT", "USR1", "USR2", "STOP", "CONT",
];

pub struct ProcessManagementTool;
impl ProcessManagementTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for ProcessManagementTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for ProcessManagementTool {
    fn name(&self) -> &str {
        "process_management"
    }

    fn description(&self) -> &str {
        "List, inspect, or signal remote processes. \
         action='list' enumerates processes (optionally filtered by name), \
         action='info' shows details for a PID, \
         action='kill' sends a signal (TERM by default) to a PID."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["list", "info", "kill"],
                    "description": "Operation to perform"
                },
                "pid": {
                    "type": "integer",
                    "description": "Target PID (required for 'info' and 'kill')"
                },
                "signal": {
                    "type": "string",
                    "description": "Signal name (TERM, KILL, HUP, INT, QUIT, USR1, USR2, STOP, CONT). Default: TERM",
                    "default": "TERM"
                },
                "filter": {
                    "type": "string",
                    "description": "For action='list': substring filter on command name"
                },
                "limit": {
                    "type": "integer",
                    "description": "For action='list': max rows (default 50)"
                }
            },
            "required": ["action"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        // Listing is harmless; killing is destructive. Report the worst-case
        // baseline so policy gates the tool conservatively.
        RiskLevel::HighRisk
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let action = params
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'action' parameter".into()))?;

        match action {
            "list" => list_processes(&params, ctx).await,
            "info" => info_process(&params, ctx).await,
            "kill" => kill_process(&params, ctx).await,
            other => Ok(ToolOutput::fail(
                "process_management",
                format!("unknown action: '{}'", other),
            )),
        }
    }
}

async fn list_processes(
    params: &serde_json::Value,
    ctx: &ToolContext,
) -> Result<ToolOutput, AppError> {
    let filter = params.get("filter").and_then(|v| v.as_str()).unwrap_or("");
    let limit = params
        .get("limit")
        .and_then(|v| v.as_u64())
        .unwrap_or(DEFAULT_LIST_LIMIT)
        .clamp(1, 1000);

    // ps with portable column set; sort by CPU descending.
    let header = "ps -eo pid,user,pcpu,pmem,etime,comm,args --sort=-pcpu --no-headers 2>/dev/null \
                  || ps -eo pid,user,pcpu,pmem,etime,comm,args";
    let cmd = if filter.is_empty() {
        format!("({h}) | head -n {n}", h = header, n = limit)
    } else {
        format!(
            "({h}) | grep -F -- {f} | head -n {n}",
            h = header,
            f = shell_escape(filter),
            n = limit
        )
    };

    match ctx.exec(&cmd).await {
        Ok(output) => {
            let rows = output.lines().filter(|l| !l.trim().is_empty()).count();
            let body = truncate_output(output, MAX_OUTPUT_BYTES);
            let summary = if filter.is_empty() {
                format!("processes ({} rows)", rows)
            } else {
                format!("processes matching '{}' ({} rows)", filter, rows)
            };
            Ok(ToolOutput::ok(summary, body).with_metadata(json!({
                "action": "list",
                "rows": rows,
                "filter": filter,
            })))
        }
        Err(e) => Ok(ToolOutput::fail(
            "process list",
            format!("list failed: {}", e),
        )),
    }
}

async fn info_process(
    params: &serde_json::Value,
    ctx: &ToolContext,
) -> Result<ToolOutput, AppError> {
    let pid = params
        .get("pid")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::Agent("Missing 'pid' for action 'info'".into()))?;
    if pid <= 0 {
        return Ok(ToolOutput::fail("process info", "pid must be positive"));
    }

    // ps for runtime stats + /proc/<pid>/status for kernel-side details.
    let cmd = format!(
        "ps -p {pid} -o pid,ppid,user,pcpu,pmem,etime,stat,comm,args 2>/dev/null \
         && echo '---' \
         && (cat /proc/{pid}/status 2>/dev/null || true)",
        pid = pid
    );

    match ctx.exec(&cmd).await {
        Ok(output) => {
            if output.trim().is_empty() {
                return Ok(ToolOutput::fail(
                    format!("process info pid={}", pid),
                    "process not found",
                ));
            }
            let body = truncate_output(output, MAX_OUTPUT_BYTES);
            Ok(ToolOutput::ok(format!("process info pid={}", pid), body)
                .with_metadata(json!({ "action": "info", "pid": pid })))
        }
        Err(e) => Ok(ToolOutput::fail(
            format!("process info pid={}", pid),
            format!("info failed: {}", e),
        )),
    }
}

async fn kill_process(
    params: &serde_json::Value,
    ctx: &ToolContext,
) -> Result<ToolOutput, AppError> {
    let pid = params
        .get("pid")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| AppError::Agent("Missing 'pid' for action 'kill'".into()))?;
    if pid <= 1 {
        // Block PID 0 (kernel scheduler) and PID 1 (init).
        return Ok(ToolOutput::fail(
            "process kill",
            format!("refusing to signal pid {} (reserved)", pid),
        ));
    }
    let signal = params
        .get("signal")
        .and_then(|v| v.as_str())
        .unwrap_or("TERM")
        .to_uppercase();
    if !ALLOWED_SIGNALS.contains(&signal.as_str()) {
        return Ok(ToolOutput::fail(
            "process kill",
            format!(
                "signal '{}' not allowed; permitted: {}",
                signal,
                ALLOWED_SIGNALS.join(", ")
            ),
        ));
    }

    let cmd = format!(
        "kill -{sig} {pid} && echo OK || echo FAIL",
        sig = signal,
        pid = pid
    );
    match ctx.exec(&cmd).await {
        Ok(output) => {
            let last = output
                .lines()
                .rev()
                .find(|l| !l.trim().is_empty())
                .unwrap_or("")
                .trim();
            if last == "OK" {
                Ok(ToolOutput::ok(
                    format!("kill -{} {}", signal, pid),
                    format!("sent SIG{} to pid {}", signal, pid),
                )
                .with_metadata(json!({ "action": "kill", "pid": pid, "signal": signal })))
            } else {
                Ok(ToolOutput::fail(
                    format!("kill -{} {}", signal, pid),
                    format!("kill failed: {}", output.trim()),
                ))
            }
        }
        Err(e) => Ok(ToolOutput::fail(
            format!("kill -{} {}", signal, pid),
            format!("kill failed: {}", e),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_whitelist_rejects_garbage() {
        assert!(!ALLOWED_SIGNALS.contains(&"DROP-TABLE"));
        assert!(ALLOWED_SIGNALS.contains(&"TERM"));
    }
}
