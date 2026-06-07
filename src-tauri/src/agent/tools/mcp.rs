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

    #[test]
    fn requires_approval_by_default_untrusted() {
        let server = make_server("s1", false);
        let tool = McpTool::new("mcp__s1__read".into(), server, make_info("read"));
        assert!(tool.requires_approval_by_default());
    }

    #[test]
    fn requires_approval_by_default_trusted() {
        let server = make_server("s1", true);
        let tool = McpTool::new("mcp__s1__read".into(), server, make_info("read"));
        assert!(!tool.requires_approval_by_default());
    }

    #[test]
    fn risk_level_untrusted() {
        let server = make_server("s1", false);
        let tool = McpTool::new("mcp__s1__read".into(), server, make_info("read"));
        assert_eq!(tool.risk_level(), RiskLevel::Moderate);
    }

    #[test]
    fn risk_level_trusted() {
        let server = make_server("s1", true);
        let tool = McpTool::new("mcp__s1__read".into(), server, make_info("read"));
        assert_eq!(tool.risk_level(), RiskLevel::LowRisk);
    }

    #[test]
    fn slugify_preserves_alphanumeric() {
        assert_eq!(slugify_tool_part("hello123"), "hello123");
    }

    #[test]
    fn slugify_replaces_dots_and_dashes() {
        assert_eq!(slugify_tool_part("my-tool.v1"), "my_tool_v1");
    }

    #[test]
    fn slugify_trims_leading_trailing_underscores() {
        assert_eq!(slugify_tool_part("--tool--"), "tool");
    }

    #[test]
    fn slugify_empty_falls_back_to_tool() {
        assert_eq!(slugify_tool_part("___"), "tool");
    }

    #[test]
    fn register_mcp_tools_populates_registry() {
        let mut registry = crate::agent::tools::ToolRegistry::new();
        let server = make_server("filesystem", false);
        let tools = vec![make_info("read"), make_info("write")];
        register_mcp_tools(&mut registry, &server, tools);
        let defs = registry.definitions();
        let names: Vec<_> = defs.into_iter().map(|d| d.name).collect();
        assert!(names.contains(&"mcp__filesystem__read".to_string()));
        assert!(names.contains(&"mcp__filesystem__write".to_string()));
        assert_eq!(names.len(), 2);
    }

    #[test]
    fn parameters_schema_null_input_schema() {
        let server = make_server("s1", false);
        let mut info = make_info("read");
        info.input_schema = serde_json::Value::Null;
        let tool = McpTool::new("mcp__s1__read".into(), server, info);
        let schema = tool.parameters_schema();
        assert_eq!(schema["type"], "object");
    }

    #[test]
    fn parameters_schema_preserves_input_schema() {
        let server = make_server("s1", false);
        let mut info = make_info("read");
        info.input_schema =
            serde_json::json!({"type": "object", "properties": {"path": {"type": "string"}}});
        let tool = McpTool::new("mcp__s1__read".into(), server, info);
        let schema = tool.parameters_schema();
        assert_eq!(schema["properties"]["path"]["type"], "string");
    }

    fn make_server(id: &str, trusted: bool) -> McpServerConfig {
        McpServerConfig {
            id: id.into(),
            name: id.into(),
            url: "https://example.com".into(),
            headers: Default::default(),
            enabled: true,
            trusted,
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-01T00:00:00Z".into(),
        }
    }

    fn make_info(name: &str) -> McpToolInfo {
        McpToolInfo {
            name: name.into(),
            description: format!("{} tool", name),
            input_schema: serde_json::json!({}),
        }
    }
}
