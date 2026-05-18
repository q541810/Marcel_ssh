//! Agent tool framework.
//!
//! Each tool implements [`AgentTool`] and is registered in [`ToolRegistry`].
//! The registry is the single source of truth for tool metadata: its
//! [`ToolRegistry::definitions`] feeds the LLM tool-use API, and
//! [`ToolRegistry::get`] dispatches incoming tool calls.
//!
//! Tools execute by calling [`ToolContext::exec`], which opens a dedicated
//! SSH exec channel on the active session. This keeps tool implementations
//! self-contained and makes them trivially unit-testable: swap the
//! [`ToolContext`] and the rest is pure logic.

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::agent::sandbox::RiskLevel;
use crate::error::AppError;
use crate::ssh::connection::SshManager;

pub mod base64;
pub mod execute_cmd;
pub mod file_ops;
pub mod http_get;
pub mod open_cloud_page;
pub mod plan;
pub mod process;
pub mod search;
pub mod sftp_transfer;
pub mod system;
pub mod web_search;

// ───────────────────────── Public types ─────────────────────────

/// Output from a tool execution.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolOutput {
    pub success: bool,
    /// Short human-readable summary, shown in the UI tool-call card header.
    pub summary: String,
    /// Full output fed back to the LLM. Tools should pre-truncate when needed.
    pub output: String,
    /// Optional structured metadata (paths, byte counts, exit codes, ...).
    pub metadata: Option<serde_json::Value>,
}

impl ToolOutput {
    pub fn ok(summary: impl Into<String>, output: impl Into<String>) -> Self {
        Self {
            success: true,
            summary: summary.into(),
            output: output.into(),
            metadata: None,
        }
    }

    pub fn fail(summary: impl Into<String>, output: impl Into<String>) -> Self {
        Self {
            success: false,
            summary: summary.into(),
            output: output.into(),
            metadata: None,
        }
    }

    pub fn with_metadata(mut self, meta: serde_json::Value) -> Self {
        self.metadata = Some(meta);
        self
    }
}

/// Schema description of a tool, exposed to the LLM via the tool-use API.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolDefinition {
    pub name: String,
    pub description: String,
    pub parameters: serde_json::Value,
}

/// Summary information about a registered tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolInfo {
    pub name: String,
    pub description: String,
    pub risk_level: RiskLevel,
}

/// Execution context handed to a tool. Provides the live SSH session and
/// helper methods for running commands on it.
#[derive(Clone)]
pub struct ToolContext {
    pub ssh: SshManager,
    pub session_id: String,
    pub app_handle: AppHandle,
    /// Optional security policy. When set, tools that run a sandbox
    /// (e.g. `execute_command`) should honour it instead of falling back
    /// to [`crate::agent::sandbox::Sandbox::default`].
    pub policy: Option<Arc<crate::agent::sandbox::SecurityPolicy>>,
}

impl ToolContext {
    pub fn new(ssh: SshManager, session_id: impl Into<String>, app_handle: AppHandle) -> Self {
        Self {
            ssh,
            session_id: session_id.into(),
            app_handle,
            policy: None,
        }
    }

    /// Attach a security policy to this context (builder-style).
    pub fn with_policy(mut self, policy: Arc<crate::agent::sandbox::SecurityPolicy>) -> Self {
        self.policy = Some(policy);
        self
    }

    /// Run a command on a dedicated SSH exec channel and return combined stdout+stderr.
    pub async fn exec(&self, command: &str) -> Result<String, AppError> {
        self.ssh.exec_command(&self.session_id, command).await
    }
}

/// Trait implemented by every agent tool.
#[async_trait]
pub trait AgentTool: Send + Sync {
    /// Unique name used by the LLM to reference this tool.
    fn name(&self) -> &str;

    /// Human-readable description shown to the LLM.
    fn description(&self) -> &str;

    /// JSON Schema describing the tool's parameters.
    fn parameters_schema(&self) -> serde_json::Value;

    /// Baseline risk level. May be elevated by the caller (e.g. for
    /// `execute_command`, the actual risk is computed from the command text).
    fn risk_level(&self) -> RiskLevel;

    /// Execute the tool with the given parameters and SSH context.
    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError>;

    /// Default-derived [`ToolDefinition`] for the LLM tool-use API.
    fn definition(&self) -> ToolDefinition {
        ToolDefinition {
            name: self.name().to_string(),
            description: self.description().to_string(),
            parameters: self.parameters_schema(),
        }
    }
}

// ───────────────────────── Registry ─────────────────────────

/// Registry holding every available agent tool.
///
/// The registry is the single source of truth: the agent loop calls
/// [`ToolRegistry::definitions`] to advertise tools to the LLM and
/// [`ToolRegistry::get`] to dispatch tool calls. Adding a new tool requires
/// only:
///   1. Implementing [`AgentTool`] in `tools/<name>.rs`
///   2. Registering it inside [`ToolRegistry::with_builtins`]
///   3. Optionally listing it in `AGENTS.md`
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn AgentTool>>,
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self { tools: HashMap::new() }
    }

    /// Register a tool. The last registration wins on name collision.
    pub fn register(&mut self, tool: Arc<dyn AgentTool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    /// Look up a tool by name.
    pub fn get(&self, name: &str) -> Option<Arc<dyn AgentTool>> {
        self.tools.get(name).cloned()
    }

    /// JSON-Schema definitions for every tool, sorted by name (deterministic
    /// across runs to keep LLM caches happy).
    pub fn definitions(&self) -> Vec<ToolDefinition> {
        let mut defs: Vec<_> = self.tools.values().map(|t| t.definition()).collect();
        defs.sort_by(|a, b| a.name.cmp(&b.name));
        defs
    }

    /// Lightweight info entries for every tool.
    pub fn list_tools(&self) -> Vec<ToolInfo> {
        let mut infos: Vec<_> = self
            .tools
            .values()
            .map(|t| ToolInfo {
                name: t.name().to_string(),
                description: t.description().to_string(),
                risk_level: t.risk_level(),
            })
            .collect();
        infos.sort_by(|a, b| a.name.cmp(&b.name));
        infos
    }

    /// Build a registry pre-populated with all 14 built-in tools.
    ///
    /// Built-ins:
    /// - `execute_command`           (execute_cmd)
    /// - `read_file`, `write_file`,
    ///   `edit_file`, `list_directory` (file_ops)
    /// - `upload_file`, `download_file` (sftp_transfer)
    /// - `search_files`               (search)
    /// - `process_management`         (process)
    /// - `system_info`                (system)
    /// - `web_search`                 (web_search)
    /// - `http_get`                   (http_get)
    /// - `create_plan`                (plan)
    /// - `update_plan_item`           (plan)
    pub fn with_builtins() -> Self {
        let mut r = Self::new();
        r.register(Arc::new(execute_cmd::ExecuteCommandTool::new()));
        r.register(Arc::new(file_ops::ReadFileTool::new()));
        r.register(Arc::new(file_ops::WriteFileTool::new()));
        r.register(Arc::new(file_ops::EditFileTool::new()));
        r.register(Arc::new(file_ops::ListDirectoryTool::new()));
        r.register(Arc::new(sftp_transfer::UploadFileTool::new()));
        r.register(Arc::new(sftp_transfer::DownloadFileTool::new()));
        r.register(Arc::new(search::SearchFilesTool::new()));
        r.register(Arc::new(process::ProcessManagementTool::new()));
        r.register(Arc::new(system::SystemInfoTool::new()));
        r.register(Arc::new(web_search::WebSearchTool::new()));
        r.register(Arc::new(http_get::HttpGetTool::new()));
        r.register(Arc::new(plan::CreatePlanTool::new()));
        r.register(Arc::new(plan::UpdatePlanItemTool::new()));
        r
    }
}

impl Default for ToolRegistry {
    fn default() -> Self {
        Self::with_builtins()
    }
}

// ───────────────────────── Shared helpers ─────────────────────────

/// POSIX shell-escape a value: wrap in single quotes, escape embedded quotes.
/// Safe for `sh`, `bash`, `zsh`, `dash`.
pub(crate) fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Truncate a long string for inclusion in tool output. Adds a marker line
/// indicating the original size so the LLM can react appropriately.
pub(crate) fn truncate_output(s: String, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s;
    }
    // Find the closest valid char boundary <= max_bytes.
    let mut cut = max_bytes;
    while !s.is_char_boundary(cut) && cut > 0 {
        cut -= 1;
    }
    format!(
        "{}...\n[truncated to {} bytes; original {} bytes]",
        &s[..cut],
        cut,
        s.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_with_builtins_has_fourteen_tools() {
        let r = ToolRegistry::with_builtins();
        let names: Vec<_> = r.definitions().into_iter().map(|d| d.name).collect();
        assert_eq!(names.len(), 14, "expected 14 built-in tools, got {:?}", names);
        for expected in [
            "execute_command",
            "read_file",
            "write_file",
            "edit_file",
            "list_directory",
            "upload_file",
            "download_file",
            "search_files",
            "process_management",
            "system_info",
            "web_search",
            "http_get",
            "create_plan",
            "update_plan_item",
        ] {
            assert!(names.iter().any(|n| n == expected), "missing tool: {}", expected);
        }
    }

    #[test]
    fn shell_escape_handles_quotes() {
        assert_eq!(shell_escape("foo"), "'foo'");
        assert_eq!(shell_escape("it's"), "'it'\\''s'");
        assert_eq!(shell_escape("a b"), "'a b'");
    }

    #[test]
    fn truncate_output_respects_limit() {
        let s = "a".repeat(100);
        let out = truncate_output(s.clone(), 50);
        assert!(out.len() < 200);
        assert!(out.contains("truncated"));

        let short = "hello".to_string();
        assert_eq!(truncate_output(short.clone(), 100), short);
    }
}
