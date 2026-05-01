use async_trait::async_trait;
use serde_json::json;

use crate::agent::context::SessionContext;
use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolOutput};
use crate::error::AppError;

/// Tool that retrieves system information from the remote server.
pub struct SystemInfoTool;

impl SystemInfoTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SystemInfoTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for SystemInfoTool {
    fn name(&self) -> &str {
        "system_info"
    }

    fn description(&self) -> &str {
        "Get system information from the remote server (OS, uptime, memory, disk, etc.)"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "category": {
                    "type": "string",
                    "description": "Category of info to retrieve: 'os', 'memory', 'disk', 'network', 'all'",
                    "enum": ["os", "memory", "disk", "network", "all"]
                }
            },
            "required": ["category"]
        })
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &SessionContext,
    ) -> Result<ToolOutput, AppError> {
        let category = params
            .get("category")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'category' parameter".into()))?;

        log::info!("SystemInfoTool stub: category={}", category);
        Ok(ToolOutput {
            success: true,
            output: format!("[stub] would retrieve system info: {}", category),
            metadata: None,
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }
}
