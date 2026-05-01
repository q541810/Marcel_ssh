use async_trait::async_trait;
use serde_json::json;

use crate::agent::context::SessionContext;
use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolOutput};
use crate::error::AppError;

// ─── ReadFileTool ────────────────────────────────────────────────────────────

/// Tool that reads a file on the remote server.
pub struct ReadFileTool;

impl ReadFileTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ReadFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "Read the contents of a file on the remote server"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the file to read"
                }
            },
            "required": ["path"]
        })
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &SessionContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'path' parameter".into()))?;

        log::info!("ReadFileTool stub: {}", path);
        Ok(ToolOutput {
            success: true,
            output: format!("[stub] would read: {}", path),
            metadata: None,
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }
}

// ─── WriteFileTool ───────────────────────────────────────────────────────────

/// Tool that writes content to a file on the remote server.
pub struct WriteFileTool;

impl WriteFileTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for WriteFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "Write content to a file on the remote server"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the file to write"
                },
                "content": {
                    "type": "string",
                    "description": "Content to write to the file"
                }
            },
            "required": ["path", "content"]
        })
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &SessionContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'path' parameter".into()))?;
        let content = params
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'content' parameter".into()))?;

        log::info!("WriteFileTool stub: {} ({} bytes)", path, content.len());
        Ok(ToolOutput {
            success: true,
            output: format!("[stub] would write {} bytes to: {}", content.len(), path),
            metadata: None,
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::Moderate
    }
}

// ─── ListDirectoryTool ───────────────────────────────────────────────────────

/// Tool that lists directory contents on the remote server.
pub struct ListDirectoryTool;

impl ListDirectoryTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ListDirectoryTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for ListDirectoryTool {
    fn name(&self) -> &str {
        "list_directory"
    }

    fn description(&self) -> &str {
        "List the contents of a directory on the remote server"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Absolute path to the directory to list"
                }
            },
            "required": ["path"]
        })
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &SessionContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'path' parameter".into()))?;

        log::info!("ListDirectoryTool stub: {}", path);
        Ok(ToolOutput {
            success: true,
            output: format!("[stub] would list: {}", path),
            metadata: None,
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }
}
