use std::sync::Arc;

use async_trait::async_trait;
use tauri::Manager;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;
use crate::mcp::protocol::McpToolInfo;
use crate::mcp::store::McpServerConfig;

pub struct McpTool {
    exposed_name: String,
    server: McpServerConfig,
    tool: McpToolInfo,
}

impl McpTool {
    pub fn new(exposed_name: String, server: McpServerConfig, tool: McpToolInfo) -> Self {
        Self {
            exposed_name,
            server,
            tool,
        }
    }
}

#[async_trait]
impl AgentTool for McpTool {
    fn name(&self) -> &str {
        &self.exposed_name
    }

    fn description(&self) -> &str {
        &self.tool.description
    }

    fn parameters_schema(&self) -> serde_json::Value {
        if self.tool.input_schema.is_null() {
            serde_json::json!({ "type": "object", "properties": {} })
        } else {
            self.tool.input_schema.clone()
        }
    }

    fn risk_level(&self) -> RiskLevel {
        if self.server.trusted {
            RiskLevel::LowRisk
        } else {
            RiskLevel::Moderate
        }
    }

    fn requires_approval_by_default(&self) -> bool {
        !self.server.trusted
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let output = ctx
            .app_handle
            .state::<crate::AppState>()
            .mcp_manager
            .call_tool(&self.server, &self.tool.name, params)
            .await?;
        Ok(ToolOutput::ok(
            format!("MCP {} / {}", self.server.name, self.tool.name),
            output,
        ))
    }
}

pub fn build_mcp_tool_name(server_name: &str, tool_name: &str) -> String {
    format!(
        "mcp__{}__{}",
        slugify_tool_part(server_name),
        slugify_tool_part(tool_name)
    )
}

fn slugify_tool_part(input: &str) -> String {
    let mut out = String::new();
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "tool".into()
    } else {
        trimmed
    }
}

pub fn register_mcp_tools(
    registry: &mut crate::agent::tools::ToolRegistry,
    server: &McpServerConfig,
    tools: Vec<McpToolInfo>,
) {
    for tool in tools {
        let name = build_mcp_tool_name(&server.name, &tool.name);
        registry.register(Arc::new(McpTool::new(name, server.clone(), tool)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_tool_name_is_openai_safe() {
        assert_eq!(
            build_mcp_tool_name("File System", "read-file"),
            "mcp__file_system__read_file"
        );
        assert_eq!(build_mcp_tool_name("中文", "!!!"), "mcp__tool__tool");
    }
}
