use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

pub struct ConnectionInfoTool;

impl ConnectionInfoTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ConnectionInfoTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for ConnectionInfoTool {
    fn name(&self) -> &str {
        "connection_info"
    }

    fn description(&self) -> &str {
        "Get the host and port of the current SSH session. Use this when you need to know the remote server's address."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {}
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    async fn execute(
        &self,
        _params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let info = ctx
            .ssh
            .get_connection_info(&ctx.session_id)
            .await
            .ok_or_else(|| AppError::Agent("当前会话不存在".into()))?;

        Ok(ToolOutput::ok(
            format!("connection_info ({}:{}", info.0, info.1),
            format!(
                "Current SSH session connection info:\nHost: {}\nPort: {}\nAddress: {}:{}",
                info.0, info.1, info.0, info.1
            ),
        ))
    }
}
