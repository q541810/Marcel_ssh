use async_trait::async_trait;
use serde_json::json;

use crate::agent::context::SessionContext;
use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolOutput};
use crate::error::AppError;

/// Tool that searches for files on the remote server.
pub struct SearchFilesTool;

impl SearchFilesTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SearchFilesTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for SearchFilesTool {
    fn name(&self) -> &str {
        "search_files"
    }

    fn description(&self) -> &str {
        "Search for files matching a pattern on the remote server"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "pattern": {
                    "type": "string",
                    "description": "Search pattern (glob or regex)"
                },
                "directory": {
                    "type": "string",
                    "description": "Directory to search in (defaults to current directory)"
                }
            },
            "required": ["pattern"]
        })
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &SessionContext,
    ) -> Result<ToolOutput, AppError> {
        let pattern = params
            .get("pattern")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'pattern' parameter".into()))?;
        let directory = params
            .get("directory")
            .and_then(|v| v.as_str())
            .unwrap_or(".");

        log::info!("SearchFilesTool stub: {} in {}", pattern, directory);
        Ok(ToolOutput {
            success: true,
            output: format!("[stub] would search for '{}' in {}", pattern, directory),
            metadata: None,
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }
}
