//! `execute_command` — run an arbitrary shell command on the remote server.
//!
//! Security:
//! - The [`Sandbox`] is consulted before execution and rejects destructive
//!   patterns regardless of agent mode.
//! - Higher-level confirmation/approval flow is implemented in
//!   `commands/agent.rs`, which wraps this tool with mode-aware policy.

use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::{self, RiskLevel, Sandbox};
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

/// Maximum bytes of combined stdout+stderr returned to the LLM.
const MAX_OUTPUT_BYTES: usize = 8_000;

pub struct ExecuteCommandTool;

impl ExecuteCommandTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ExecuteCommandTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for ExecuteCommandTool {
    fn name(&self) -> &str {
        "execute_command"
    }

    fn description(&self) -> &str {
        "Execute a shell command on the remote server. Returns combined \
         stdout+stderr. Long output is truncated. The command is statically \
         analyzed by a security sandbox before execution; some patterns \
         (e.g. `rm -rf /`, `mkfs`, dd-to-block-device, shell evasion) are \
         always rejected."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command line to execute (run via the user's login shell)."
                }
            },
            "required": ["command"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        // Baseline. Real risk is computed per-invocation via [`sandbox::assess_risk`].
        RiskLevel::Moderate
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let command = params
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'command' parameter".into()))?
            .trim();

        if command.is_empty() {
            return Ok(ToolOutput::fail(
                "execute_command",
                "Error: empty command",
            ));
        }

        // Static safety check. Higher-level policy (allow/deny lists, user
        // approval) is applied by `commands/agent.rs`.
        let sandbox = Sandbox::default();
        if let Err(e) = sandbox.check_command(command) {
            return Ok(ToolOutput::fail(
                format!("$ {}", command),
                format!("BLOCKED by sandbox: {}", e),
            )
            .with_metadata(json!({
                "blocked": true,
                "reason": e.to_string(),
            })));
        }

        let risk = sandbox::assess_risk(command);
        log::info!("execute_command: risk={:?} cmd={}", risk, command);

        match ctx.exec(command).await {
            Ok(output) => {
                let truncated = truncate_output(output, MAX_OUTPUT_BYTES);
                Ok(ToolOutput::ok(format!("$ {}", command), truncated)
                    .with_metadata(json!({ "risk": format!("{:?}", risk) })))
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("$ {}", command),
                format!("execution failed: {}", e),
            )),
        }
    }
}
