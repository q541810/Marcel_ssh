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
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use parking_lot::RwLock as PlRwLock;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::oneshot;

use crate::agent::sandbox::RiskLevel;
use crate::error::AppError;
use crate::ssh::connection::SshManager;

#[cfg(test)]
pub mod base64;
pub mod browser_cdp;
pub mod connection_info;
pub mod execute_cmd;
pub mod file_ops;
pub mod http_get;
pub mod local_handlers;
pub mod mcp;
pub mod open_cloud_page;
pub mod plan;
pub mod plugin_tool;
pub mod question;
#[cfg(desktop)]
pub mod render_html;
pub mod search;
pub mod sftp_transfer;
pub mod skill;
pub mod subagent;
pub mod system;
pub mod web_search;

// ───────────────────────── Public types ─────────────────────────

/// A kernel-registered local handler invoked by plugin tools that declare
/// `kind: "local"`. Implementations live in [`local_handlers`] and are
/// registered once at app startup; plugins reference them by name (e.g.
/// `"fs.read"`, `"fs.append"`) without being able to register their own.
///
/// The handler receives the tool parameters (already substituted with
/// context variables) and the live [`ToolContext`]. It returns a JSON
/// value that [`PluginAgentTool`] wraps into a [`ToolOutput`].
///
/// Capability checks happen *before* the handler is called (in
/// [`PluginAgentTool::execute`]), so the handler itself can assume the
/// calling plugin has declared the required capability.
#[async_trait]
pub trait LocalHandler: Send + Sync {
    async fn call(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<serde_json::Value, AppError>;
}

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
    /// Application config directory. Used by local handlers (e.g. `fs.read`)
    /// to resolve plugin-relative paths.
    pub config_dir: PathBuf,
    pub tool_call_id: Option<String>,
    pub event_name: Option<String>,
    /// 当前所属的 agent task id（agent_loop 构造时注入）。
    /// `task` 工具用它做子agent嵌套检查与子agent注册。
    pub task_id: Option<String>,
    /// Optional security policy. When set, tools that run a sandbox
    /// (e.g. `execute_command`) should honour it instead of falling back
    /// to [`crate::agent::sandbox::Sandbox::default`].
    pub policy: Option<Arc<crate::agent::sandbox::SecurityPolicy>>,
    /// Kernel-registered local handlers, keyed by name (e.g. `"fs.read"`).
    /// Shared via `Arc` so the context can be cloned cheaply per tool call.
    pub local_handlers: Arc<HashMap<String, Arc<dyn LocalHandler>>>,
    /// 命令执行统一管理器。生产路径由 agent_loop 注入；所有 exec* 辅助
    /// 方法优先经它执行（登记记录 + 断连级联取消）。仅测试场景为 None
    /// （回退到 SshManager 兼容 shim，行为一致但不登记）。
    pub command_exec: Option<crate::command_exec::CommandExecutionManager>,
}

impl ToolContext {
    pub fn new(ssh: SshManager, session_id: impl Into<String>, app_handle: AppHandle) -> Self {
        Self {
            ssh,
            session_id: session_id.into(),
            app_handle,
            config_dir: PathBuf::new(),
            tool_call_id: None,
            event_name: None,
            task_id: None,
            policy: None,
            local_handlers: Arc::new(HashMap::new()),
            command_exec: None,
        }
    }

    /// Attach the owning agent task id (builder-style).
    pub fn with_task_id(mut self, task_id: impl Into<String>) -> Self {
        self.task_id = Some(task_id.into());
        self
    }

    /// Attach a security policy to this context (builder-style).
    pub fn with_policy(mut self, policy: Arc<crate::agent::sandbox::SecurityPolicy>) -> Self {
        self.policy = Some(policy);
        self
    }

    /// Attach a tool call ID to this context so the tool can emit streaming events.
    pub fn with_tool_call_id(mut self, id: impl Into<String>) -> Self {
        self.tool_call_id = Some(id.into());
        self
    }

    /// Attach the stream event name for streaming tool output.
    pub fn with_event_name(mut self, name: impl Into<String>) -> Self {
        self.event_name = Some(name.into());
        self
    }

    /// Attach the application config directory (used by local handlers for
    /// plugin-relative path resolution).
    pub fn with_config_dir(mut self, dir: PathBuf) -> Self {
        self.config_dir = dir;
        self
    }

    /// Attach the local handler registry (built once at app startup and shared
    /// across all tool calls).
    pub fn with_local_handlers(
        mut self,
        handlers: Arc<HashMap<String, Arc<dyn LocalHandler>>>,
    ) -> Self {
        self.local_handlers = handlers;
        self
    }

    /// Attach the unified command execution manager (builder-style).
    /// agent_loop 在生产路径注入；未注入时 exec* 回退到 SshManager
    /// 兼容 shim（仅测试场景）。
    pub fn with_command_exec(mut self, mgr: crate::command_exec::CommandExecutionManager) -> Self {
        self.command_exec = Some(mgr);
        self
    }

    /// 把管理器结果映射回旧 `(output, was_timeout)` 形状。
    /// 超时是 Ok（与旧 exec_timed / exec_streamed 语义一致，由调用方
    /// 处理 was_timeout）；断连级联取消与执行失败是 Err。
    async fn submit_shaped(
        &self,
        ticket: crate::command_exec::CommandTicket,
    ) -> Result<(String, bool), AppError> {
        use crate::command_exec::SubmitOutcome;
        let mgr = self.command_exec.as_ref().ok_or_else(|| {
            // 不可能到达：无 manager 时调用方走 ssh 回退分支
            AppError::Agent("command_exec manager not configured".into())
        })?;
        match mgr.submit(&self.app_handle, ticket).await {
            SubmitOutcome::Completed { output } => Ok((output, false)),
            SubmitOutcome::TimedOut { output } => Ok((output, true)),
            SubmitOutcome::Cancelled { .. } => Err(AppError::Ssh("命令已取消（会话断开）".into())),
            SubmitOutcome::Failed { error } => Err(error),
        }
    }

    /// Run a command on a dedicated SSH exec channel and return combined stdout+stderr.
    /// 120s 超时；超时返回 Err（与旧 `SshManager::exec_command` 一致）。
    pub async fn exec(&self, command: &str) -> Result<String, AppError> {
        if let Some(mgr) = &self.command_exec {
            let ticket = crate::command_exec::CommandTicket::new(
                &self.session_id,
                command,
                crate::command_exec::CommandSource::Agent,
            )
            .timeout(Duration::from_secs(120));
            match mgr.submit(&self.app_handle, ticket).await {
                crate::command_exec::SubmitOutcome::Completed { output } => return Ok(output),
                crate::command_exec::SubmitOutcome::TimedOut { .. } => {
                    return Err(AppError::Ssh(format!(
                        "命令在 120 秒后超时: {}",
                        crate::command_exec::executor::timeout_preview(command)
                    )))
                }
                crate::command_exec::SubmitOutcome::Cancelled { .. } => {
                    return Err(AppError::Ssh("命令已取消（会话断开）".into()))
                }
                crate::command_exec::SubmitOutcome::Failed { error } => return Err(error),
            }
        }
        self.ssh.exec_command(&self.session_id, command).await
    }

    /// Run a command with a timeout. Returns (output, was_timeout).
    pub async fn exec_timed(
        &self,
        command: &str,
        timeout: Duration,
    ) -> Result<(String, bool), AppError> {
        if self.command_exec.is_some() {
            let ticket = crate::command_exec::CommandTicket::new(
                &self.session_id,
                command,
                crate::command_exec::CommandSource::Agent,
            )
            .timeout(timeout);
            return self.submit_shaped(ticket).await;
        }
        self.ssh
            .exec_command_timed(&self.session_id, command, timeout)
            .await
    }

    /// Run a command with a timeout and streaming output to frontend.
    /// Emits intermediate output chunks on the given event channel.
    pub async fn exec_streamed(
        &self,
        command: &str,
        timeout: Duration,
        event_name: &str,
        tool_call_id: &str,
    ) -> Result<(String, bool), AppError> {
        if self.command_exec.is_some() {
            let ticket = crate::command_exec::CommandTicket::new(
                &self.session_id,
                command,
                crate::command_exec::CommandSource::Agent,
            )
            .timeout(timeout)
            .streaming(event_name, tool_call_id);
            return self.submit_shaped(ticket).await;
        }
        self.ssh
            .exec_command_streamed(
                &self.session_id,
                command,
                timeout,
                &self.app_handle,
                event_name,
                tool_call_id,
            )
            .await
    }

    /// 以完整 ticket 提交执行（execute_command 等需要区分「实际命令」与
    /// 「展示命令」的调用方使用；sudo 重写后的命令只进 `command`，
    /// 原始命令进 `display_command`，密码绝不入记录）。
    /// 返回形状与 [`Self::exec_timed`] 一致。
    pub async fn exec_ticket(
        &self,
        ticket: crate::command_exec::CommandTicket,
    ) -> Result<(String, bool), AppError> {
        if self.command_exec.is_some() {
            return self.submit_shaped(ticket).await;
        }
        // 测试回退：ticket 的 streaming / display 差异在此路径不可用
        match ticket.streaming {
            Some(ref s) => {
                self.ssh
                    .exec_command_streamed(
                        &self.session_id,
                        &ticket.command,
                        ticket.timeout,
                        &self.app_handle,
                        &s.event_name,
                        &s.stream_id,
                    )
                    .await
            }
            None => {
                self.ssh
                    .exec_command_timed(&self.session_id, &ticket.command, ticket.timeout)
                    .await
            }
        }
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

    /// External tools may request approval even when their coarse risk appears low.
    fn requires_approval_by_default(&self) -> bool {
        false
    }

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
    local_handlers: HashMap<String, Arc<dyn LocalHandler>>,
}

/// Whether the `render_html` tool and the `builtin.visualize` skill are
/// available. Interactive visualization is desktop-only, so the platform is
/// part of the gate rather than a separate check at each call site.
pub(crate) fn html_render_enabled(
    experimental_settings: &crate::config::settings::ExperimentalSettings,
) -> bool {
    cfg!(desktop) && experimental_settings.enable_html_render
}

/// Register `render_html` for every mode builder that offers it.
///
/// [`html_render_enabled`] is the only gate: it already accounts for the
/// platform, so the `cfg(desktop)` below is not a second policy decision.
/// It exists purely because the tool module itself is desktop-only code and
/// does not compile for mobile targets.
#[cfg_attr(mobile, allow(unused_variables))]
fn register_html_render(
    registry: &mut ToolRegistry,
    experimental_settings: &crate::config::settings::ExperimentalSettings,
) {
    if !html_render_enabled(experimental_settings) {
        return;
    }
    #[cfg(desktop)]
    registry.register(Arc::new(render_html::RenderHtmlTool::new()));
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
            local_handlers: HashMap::new(),
        }
    }

    /// Register a tool. The last registration wins on name collision.
    pub fn register(&mut self, tool: Arc<dyn AgentTool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    /// Register a local handler by name. Plugins reference handlers by name
    /// via `kind: "local"` + `handler: "<name>"` in their manifest.
    /// Handlers are registered once at app startup; plugins cannot register
    /// their own (this is a deliberate security boundary).
    pub fn register_local_handler(&mut self, name: &str, handler: Arc<dyn LocalHandler>) {
        self.local_handlers.insert(name.to_string(), handler);
    }

    /// Look up a local handler by name. Returns a cloned `Arc` so the caller
    /// can invoke it without holding a borrow on the registry.
    pub fn get_local_handler(&self, name: &str) -> Option<Arc<dyn LocalHandler>> {
        self.local_handlers.get(name).cloned()
    }

    /// Snapshot the local handlers into a shared `Arc<HashMap>` suitable for
    /// attaching to a [`ToolContext`] via [`ToolContext::with_local_handlers`].
    pub fn local_handlers_arc(&self) -> Arc<HashMap<String, Arc<dyn LocalHandler>>> {
        Arc::new(self.local_handlers.clone())
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

    /// Register all enabled skills as tools (progressive disclosure).
    /// Each skill becomes a separate tool that the LLM explicitly calls to
    /// retrieve its full instructions.
    pub fn register_skills(&mut self, skills: &[crate::skills::store::Skill]) {
        for s in skills {
            if s.enabled {
                self.register(std::sync::Arc::new(skill::SkillTool::new(s)));
            }
        }
    }

    // ── Mode-aware registry builders ──────────────────────────────────────
    //
    // There are three agent modes (Plan / Agent / Auto), each registering a
    // different set of tools:
    //
    //   Plan  — Read-oriented tools only: ask_user, connection_info,
    //           execute_command, read_file, list_directory, search_files,
    //           system_info, plus skills, web_search, http_get.  No
    //           write/edit/create tools.  No plugin tools, no MCP tools.
    //           Intended for research & planning before execution.
    //
    //   Agent — All 12 core tools, skills, experimental tools, plugin
    //           tools, MCP tools.  Command execution is gated by
    //           allow/deny lists.
    //
    //   Auto  — Same tool set as Agent, but all commands execute without
    //           confirmation.
    //
    // When adding or removing a built-in tool, consider whether it should
    // be available in Plan mode.  Destructive tools (write_file, edit_file)
    // and offline-unavailable tools (open_cloud_page) should stay out of
    // Plan mode.

    /// Build a Plan-mode registry containing only read-oriented + research
    /// tools.  Excludes write/edit tools, plugin tools, and MCP tools.
    pub fn build_for_plan_mode(
        enabled_skills: &[crate::skills::store::Skill],
        experimental_settings: &crate::config::settings::ExperimentalSettings,
    ) -> Self {
        use std::sync::Arc;
        let mut registry = Self::new();
        registry.register(Arc::new(question::QuestionTool::new(true)));
        registry.register(Arc::new(connection_info::ConnectionInfoTool::new()));
        registry.register(Arc::new(execute_cmd::ExecuteCommandTool::new()));
        registry.register(Arc::new(file_ops::ReadFileTool::new()));
        registry.register(Arc::new(file_ops::ListDirectoryTool::new()));
        registry.register(Arc::new(search::SearchFilesTool::new()));
        registry.register(Arc::new(system::SystemInfoTool::new()));
        registry.register_skills(enabled_skills);
        if experimental_settings.enable_web_search {
            registry.register(Arc::new(web_search::WebSearchTool::new()));
        }
        if experimental_settings.enable_http_fetch {
            registry.register(Arc::new(http_get::HttpGetTool::new()));
        }
        register_html_render(&mut registry, experimental_settings);
        registry
    }

    /// Build a full registry for Agent/Auto mode from the current settings.
    /// This method does NOT register local handlers or plugin/MCP tools —
    /// use [`build_mut_for_mode`] when those are needed.
    pub fn build_for_mode(
        enabled_skills: &[crate::skills::store::Skill],
        experimental_settings: &crate::config::settings::ExperimentalSettings,
    ) -> Arc<Self> {
        let mut registry = Self::with_core_tools();
        registry.register_skills(enabled_skills);
        if experimental_settings.enable_web_search {
            registry.register(Arc::new(web_search::WebSearchTool::new()));
        }
        if experimental_settings.enable_http_fetch {
            registry.register(Arc::new(http_get::HttpGetTool::new()));
        }
        if experimental_settings.enable_cloud_page {
            registry.register(Arc::new(
                crate::agent::tools::open_cloud_page::OpenCloudPageTool::new(),
            ));
        }
        register_html_render(&mut registry, experimental_settings);
        Arc::new(registry)
    }

    pub fn build_mut_for_mode(
        enabled_skills: &[crate::skills::store::Skill],
        experimental_settings: &crate::config::settings::ExperimentalSettings,
    ) -> Self {
        let mut registry = Self::with_core_tools();
        // Register the 6 generic local handlers (fs.read/fs.write/fs.append/
        // session.info/connection.info/host_port) so any plugin tool declaring
        // `kind: "local"` + `handler: "<name>"` can invoke them. Without this
        // call, plugin local tools would always fail with "handler 未注册".
        local_handlers::register_default_handlers(&mut registry);
        registry.register_skills(enabled_skills);
        if experimental_settings.enable_web_search {
            registry.register(Arc::new(web_search::WebSearchTool::new()));
        }
        if experimental_settings.enable_http_fetch {
            registry.register(Arc::new(http_get::HttpGetTool::new()));
        }
        if experimental_settings.enable_cloud_page {
            registry.register(Arc::new(
                crate::agent::tools::open_cloud_page::OpenCloudPageTool::new(),
            ));
        }
        register_html_render(&mut registry, experimental_settings);
        registry
    }

    /// Build a registry pre-populated with all 12 built-in core tools.
    ///
    /// Built-ins:
    /// - `ask_user`                   (question)
    /// - `connection_info`            (connection_info)
    /// - `execute_command`           (execute_cmd)
    /// - `read_file`, `write_file`,
    ///   `edit_file`, `list_directory` (file_ops)
    /// - `search_files`               (search)
    /// - `system_info`                (system)
    /// - `create_plan`                (plan)
    /// - `update_plan_item`           (plan)
    /// - `edit_plan`                  (plan)
    ///
    /// Skills are NOT registered here — register them separately via
    /// [`register_skills`] for progressive disclosure.
    pub fn with_core_tools() -> Self {
        let mut r = Self::new();
        r.register(Arc::new(connection_info::ConnectionInfoTool::new()));
        r.register(Arc::new(execute_cmd::ExecuteCommandTool::new()));
        r.register(Arc::new(file_ops::ReadFileTool::new()));
        r.register(Arc::new(file_ops::WriteFileTool::new()));
        r.register(Arc::new(file_ops::EditFileTool::new()));
        r.register(Arc::new(file_ops::ListDirectoryTool::new()));
        r.register(Arc::new(search::SearchFilesTool::new()));
        r.register(Arc::new(system::SystemInfoTool::new()));
        r.register(Arc::new(plan::CreatePlanTool::new()));
        r.register(Arc::new(plan::UpdatePlanItemTool::new()));
        r.register(Arc::new(plan::EditPlanTool::new()));
        r.register(Arc::new(question::QuestionTool::new(false)));
        r.register(Arc::new(subagent::TaskTool));
        r
    }

    pub fn with_builtins() -> Self {
        let mut r = Self::with_core_tools();
        r.register(Arc::new(web_search::WebSearchTool::new()));
        r.register(Arc::new(http_get::HttpGetTool::new()));
        register_html_render(
            &mut r,
            &crate::config::settings::ExperimentalSettings::default(),
        );
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
pub(crate) use crate::util::{shell_escape, truncate_output};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_with_builtins_has_sixteen_tools() {
        let r = ToolRegistry::with_builtins();
        let names: Vec<_> = r.definitions().into_iter().map(|d| d.name).collect();
        assert_eq!(
            names.len(),
            16,
            "expected 16 built-in tools, got {:?}",
            names
        );
        for expected in [
            "ask_user",
            "connection_info",
            "execute_command",
            "read_file",
            "write_file",
            "edit_file",
            "list_directory",
            "search_files",
            "system_info",
            "web_search",
            "http_get",
            "render_html",
            "create_plan",
            "update_plan_item",
            "edit_plan",
            "task",
        ] {
            assert!(
                names.iter().any(|n| n == expected),
                "missing tool: {}",
                expected
            );
        }
    }

    #[test]
    fn registry_build_for_mode_respects_experimental_tool_toggles() {
        let disabled = crate::config::settings::ExperimentalSettings {
            enable_web_search: false,
            enable_http_fetch: false,
            enable_cloud_page: false,
            enable_html_render: false,
            web_search_mode: crate::config::settings::WebSearchMode::Browser,
            web_search_api_provider: crate::config::settings::WebSearchApiProvider::Brave,
            web_search_endpoint: crate::config::settings::WebSearchEndpoint::Cn,
            http_fetch_mode: crate::config::settings::HttpFetchMode::Browser,
        };
        let r = ToolRegistry::build_for_mode(&[], &disabled);
        let names: Vec<_> = r.definitions().into_iter().map(|d| d.name).collect();

        assert!(!names.iter().any(|n| n == "web_search"));
        assert!(!names.iter().any(|n| n == "http_get"));
        assert!(!names.iter().any(|n| n == "open_cloud_page"));
        assert!(!names.iter().any(|n| n == "render_html"));

        let r = ToolRegistry::build_mut_for_mode(&[], &disabled);
        let names: Vec<_> = r.definitions().into_iter().map(|d| d.name).collect();

        assert!(!names.iter().any(|n| n == "web_search"));
        assert!(!names.iter().any(|n| n == "http_get"));
        assert!(!names.iter().any(|n| n == "open_cloud_page"));
        assert!(!names.iter().any(|n| n == "render_html"));

        let enabled = crate::config::settings::ExperimentalSettings {
            enable_web_search: true,
            enable_http_fetch: true,
            enable_cloud_page: true,
            enable_html_render: true,
            web_search_mode: crate::config::settings::WebSearchMode::Browser,
            web_search_api_provider: crate::config::settings::WebSearchApiProvider::Brave,
            web_search_endpoint: crate::config::settings::WebSearchEndpoint::Cn,
            http_fetch_mode: crate::config::settings::HttpFetchMode::Browser,
        };

        let r = ToolRegistry::build_for_mode(&[], &enabled);
        let names: Vec<_> = r.definitions().into_iter().map(|d| d.name).collect();

        assert!(names.iter().any(|n| n == "web_search"));
        assert!(names.iter().any(|n| n == "http_get"));
        assert!(names.iter().any(|n| n == "open_cloud_page"));
        assert!(names.iter().any(|n| n == "render_html"));
    }

    #[test]
    fn registry_toggles_web_search_and_http_get_independently() {
        let only_search = crate::config::settings::ExperimentalSettings {
            enable_web_search: true,
            enable_http_fetch: false,
            enable_cloud_page: false,
            enable_html_render: false,
            web_search_mode: crate::config::settings::WebSearchMode::Html,
            web_search_api_provider: crate::config::settings::WebSearchApiProvider::Brave,
            web_search_endpoint: crate::config::settings::WebSearchEndpoint::Cn,
            http_fetch_mode: crate::config::settings::HttpFetchMode::Html,
        };
        let names: Vec<_> = ToolRegistry::build_for_mode(&[], &only_search)
            .definitions()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert!(names.iter().any(|n| n == "web_search"));
        assert!(!names.iter().any(|n| n == "http_get"));

        let only_http = crate::config::settings::ExperimentalSettings {
            enable_web_search: false,
            enable_http_fetch: true,
            enable_cloud_page: false,
            enable_html_render: false,
            web_search_mode: crate::config::settings::WebSearchMode::Browser,
            web_search_api_provider: crate::config::settings::WebSearchApiProvider::Brave,
            web_search_endpoint: crate::config::settings::WebSearchEndpoint::Cn,
            http_fetch_mode: crate::config::settings::HttpFetchMode::Browser,
        };
        let names: Vec<_> = ToolRegistry::build_for_mode(&[], &only_http)
            .definitions()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert!(!names.iter().any(|n| n == "web_search"));
        assert!(names.iter().any(|n| n == "http_get"));
    }

    #[test]
    fn tool_output_ok_builder() {
        let o = ToolOutput::ok("summary", "full output");
        assert!(o.success);
        assert_eq!(o.summary, "summary");
        assert_eq!(o.output, "full output");
        assert!(o.metadata.is_none());
    }

    #[test]
    fn tool_output_fail_builder() {
        let o = ToolOutput::fail("error summary", "error detail");
        assert!(!o.success);
        assert_eq!(o.summary, "error summary");
        assert_eq!(o.output, "error detail");
    }

    #[test]
    fn tool_output_with_metadata() {
        let meta = serde_json::json!({ "risk": "LowRisk", "was_timeout": true });
        let o = ToolOutput::ok("ok", "out").with_metadata(meta.clone());
        assert_eq!(o.metadata, Some(meta));
    }

    #[test]
    fn registry_definitions_sorted_by_name() {
        let r = ToolRegistry::with_builtins();
        let names: Vec<_> = r.definitions().into_iter().map(|d| d.name).collect();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted, "definitions must be sorted alphabetically");
    }

    #[test]
    fn registry_register_overwrites_by_name() {
        struct DummyTool;
        #[async_trait]
        impl AgentTool for DummyTool {
            fn name(&self) -> &str {
                "execute_command"
            }
            fn description(&self) -> &str {
                "dummy"
            }
            fn parameters_schema(&self) -> serde_json::Value {
                serde_json::json!({})
            }
            fn risk_level(&self) -> RiskLevel {
                RiskLevel::ReadOnly
            }
            async fn execute(
                &self,
                _: serde_json::Value,
                _: &ToolContext,
            ) -> Result<ToolOutput, AppError> {
                Ok(ToolOutput::ok("dummy", "dummy"))
            }
        }
        let mut r = ToolRegistry::with_builtins();
        let old_desc = r.get("execute_command").unwrap().description().to_string();
        r.register(Arc::new(DummyTool));
        assert_eq!(r.get("execute_command").unwrap().description(), "dummy");
        assert_ne!(old_desc, "dummy");
    }

    // ── Local handler registry tests (Task 2.4) ──

    /// A trivial LocalHandler that echoes back the `echo` field of its params.
    struct EchoHandler;
    #[async_trait]
    impl LocalHandler for EchoHandler {
        async fn call(
            &self,
            params: serde_json::Value,
            _ctx: &ToolContext,
        ) -> Result<serde_json::Value, AppError> {
            Ok(params)
        }
    }

    #[test]
    fn register_local_handler_then_lookup_succeeds() {
        let mut r = ToolRegistry::new();
        r.register_local_handler("echo", Arc::new(EchoHandler));
        assert!(r.get_local_handler("echo").is_some());
    }

    #[test]
    fn get_local_handler_returns_none_for_unregistered() {
        let r = ToolRegistry::new();
        assert!(r.get_local_handler("nope").is_none());
    }

    #[test]
    fn local_handlers_arc_snapshots_current_handlers() {
        let mut r = ToolRegistry::new();
        r.register_local_handler("echo", Arc::new(EchoHandler));
        let snapshot = r.local_handlers_arc();
        assert!(snapshot.contains_key("echo"));

        // Registering another handler after snapshot does not affect the snapshot
        // (it was cloned into a fresh Arc<HashMap>).
        r.register_local_handler("echo2", Arc::new(EchoHandler));
        assert!(!snapshot.contains_key("echo2"));
        assert!(r.local_handlers_arc().contains_key("echo2"));
    }
}
