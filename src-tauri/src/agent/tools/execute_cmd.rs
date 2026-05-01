use async_trait::async_trait;
use serde_json::json;

use crate::agent::context::SessionContext;
use crate::agent::sandbox::{self, RiskLevel};
use crate::agent::tools::{AgentTool, ToolOutput};
use crate::error::AppError;

/// Tool that executes a shell command on the remote server.
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
        "Execute a shell command on the remote server"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute"
                }
            },
            "required": ["command"]
        })
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &SessionContext,
    ) -> Result<ToolOutput, AppError> {
        let command = params
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'command' parameter".into()))?;

        // Stub: return placeholder result
        log::info!("ExecuteCommandTool stub: {}", command);
        Ok(ToolOutput {
            success: true,
            output: format!("[stub] would execute: {}", command),
            metadata: None,
        })
    }

    fn risk_level(&self) -> RiskLevel {
        // Dynamic risk depends on the actual command; return Moderate as the baseline.
        // The sandbox will do per-command assessment at call time.
        sandbox::assess_risk("unknown")
    }
}
