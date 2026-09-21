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
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::agent::risk::Disposition;
use crate::config::settings::ExperimentalSettings;
use crate::error::AppError;
use crate::ssh::connection::SshManager;

#[cfg(test)]
pub mod base64;
pub mod bash;
pub mod browser_cdp;
pub mod connection_info;
pub mod file_ops;
pub mod history;
pub mod http_get;
pub mod job_ops;
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
pub mod web_result;
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
    /// `subagent` 工具用它做子agent嵌套检查与子agent注册。
    pub task_id: Option<String>,
    /// 可选的安全策略：设置后，需要风险评估的工具（如 `bash`）遵循它，
    /// 而不是回落到 [`crate::agent::risk::RiskAssessor::default`]。
    pub policy: Option<Arc<crate::agent::risk::SecurityPolicy>>,
    /// Kernel-registered local handlers, keyed by name (e.g. `"fs.read"`).
    /// Shared via `Arc` so the context can be cloned cheaply per tool call.
    pub local_handlers: Arc<HashMap<String, Arc<dyn LocalHandler>>>,
    /// 命令执行统一管理器。生产路径由 agent_loop 注入；所有 exec* 辅助
    /// 方法优先经它执行（登记记录 + 断连级联取消 + 后台作业）。仅测试
    /// 场景为 None（回退到 SshManager 兼容 shim，行为一致但不登记）。
    pub command_exec: Option<crate::command_exec::CommandExecutionManager>,
    /// 多机操控：本工具调用的**目标机器**展示名（host 参数解析后由
    /// `fork_for` 设置；None = 当前会话机器）。用于传输中心条目与结果
    /// metadata 的归属展示，工具执行无需再自行解析 host。
    pub target_host_label: Option<String>,
    /// 本工具调用所属的会话 id（agent_loop 构造时注入）。
    /// 回读历史这类工具靠它知道"我在哪个会话里"——比从 `task_id` 反查
    /// `AppState.agent_tasks` 更直接，也不会在任务表里查不到时静默读到别的会话。
    pub conversation_id: Option<String>,
}

impl ToolContext {
    /// `conversation_id` 是**必填**参数而不是可选 builder：工具拿不到"我在哪个
    /// 会话里"就只能报错（回读历史全靠它）。放进构造函数，漏注入是**编译错误**
    /// 而不是运行时才发现。
    pub fn new(
        ssh: SshManager,
        session_id: impl Into<String>,
        conversation_id: impl Into<String>,
        app_handle: AppHandle,
    ) -> Self {
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
            target_host_label: None,
            conversation_id: Some(conversation_id.into()),
        }
    }

    /// Attach the owning agent task id (builder-style).
    pub fn with_task_id(mut self, task_id: impl Into<String>) -> Self {
        self.task_id = Some(task_id.into());
        self
    }

    /// Attach a security policy to this context (builder-style).
    pub fn with_policy(mut self, policy: Arc<crate::agent::risk::SecurityPolicy>) -> Self {
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

    /// 派生一个「执行目标」不同的工具上下文（多机操控换机执行）。
    /// 事件通道 / 工具调用 id / 任务 id / 安全策略 / 本地处理器全部保留，
    /// 仅替换 SSH 会话——工具换机执行时，审批与流式输出仍回到原任务的
    /// 事件通道，风险评估策略与取消归属也不变。
    pub fn fork_for(&self, session_id: impl Into<String>) -> Self {
        let mut next = self.clone();
        next.session_id = session_id.into();
        next
    }

    /// 多机跨机执行：换目标会话并记录目标机器展示名（传输中心条目 /
    /// 结果 metadata 归属展示用）。
    pub fn fork_to(&self, session_id: impl Into<String>, host_label: impl Into<String>) -> Self {
        let mut next = self.clone();
        next.session_id = session_id.into();
        next.target_host_label = Some(host_label.into());
        next
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
            SubmitOutcome::Cancelled { reason } => Err(match reason {
                crate::command_exec::CancelReason::User => AppError::Ssh("命令已取消".into()),
                // Agent/Task 变体只出现在后台作业与任务级联路径；
                // 前台命令穷尽匹配时按取消语义降级为同一文案。
                crate::command_exec::CancelReason::Agent
                | crate::command_exec::CancelReason::Task => AppError::Ssh("命令已取消".into()),
                crate::command_exec::CancelReason::Disconnected => {
                    AppError::Ssh("命令已取消（会话断开）".into())
                }
            }),
            SubmitOutcome::Failed { error } => Err(error),
        }
    }

    /// 以后台作业模式提交 ticket（`bash` 的
    /// `run_in_background` 语义）：立即返回 [`crate::command_exec::JobInfo`]，
    /// 输出沉淀进作业缓冲，经 `job_output` / `job_kill` / `job_list` 消费。
    /// 执行记录、取消注册、断连级联与前台执行共用。
    pub async fn submit_background(
        &self,
        ticket: crate::command_exec::CommandTicket,
        description: Option<String>,
    ) -> Result<crate::command_exec::JobInfo, AppError> {
        let mgr = self
            .command_exec
            .as_ref()
            .ok_or_else(|| AppError::Agent("command_exec manager not configured".into()))?;
        mgr.submit_background(Some(&self.app_handle), ticket, description)
            .await
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

    /// 以完整 ticket 提交执行（`bash` 等需要区分「实际命令」与
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

    /// 本工具默认的处置档位。
    ///
    /// 它只是**基线**：命令类工具的真实档位由 dispatcher 按命令文本现算，写路径类
    /// 工具写到受保护路径时会抬到强制审批。
    fn disposition(&self) -> Disposition;

    /// 本工具**即将执行的命令文本**，供风险评估与命令名单使用。默认 `None`。
    ///
    /// 内置工具都不需要实现它 —— 声明了 [`ToolSemantics::command_arg`] 的（目前是
    /// `bash`）由 dispatcher 直接从参数里取。这个是给**动态工具**用的：插件
    /// `kind=ssh` 的命令要先渲染模板才成型，参数里没有现成的字符串，于是它曾经
    /// 完全绕过命令名单、自己评一次就执行 —— 两份判定并存，而且那份只用等号比
    /// 「强制审批」，把更狠的「直接拒绝」漏了过去。
    async fn rendered_command(
        &self,
        _params: &serde_json::Value,
        _ctx: &ToolContext,
    ) -> Option<String> {
        None
    }

    /// External tools may request approval even when their coarse risk appears low.
    fn requires_approval_by_default(&self) -> bool {
        false
    }

    /// Whether this tool is safe to execute concurrently with adjacent concurrent-safe tools.
    /// Default is `false` (strictly sequential execution to preserve causal dependencies).
    /// Pure, read-only isolated subagents (`SubagentTool`) override this to `true`.
    fn is_concurrent_safe(&self) -> bool {
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
/// [`ToolRegistry::get`] to dispatch tool calls.
///
/// **新增内置工具只改两处**：
///   1. 在 `tools/<name>.rs` 里实现 [`AgentTool`]；
///   2. 在 [`BUILTIN_TOOLS_COMMON`]（或桌面专属的 [`BUILTIN_TOOLS_DESKTOP`]）
///      里加一行声明。
///
/// 「在哪些模式可用 / 子 agent 能不能拿到 / 挂在哪个实验性开关后面」全部写在
/// 声明里，三个 builder 从同一张表过滤生成；不要再往 builder 里加 `if`。
pub struct ToolRegistry {
    tools: HashMap<String, Arc<dyn AgentTool>>,
    local_handlers: HashMap<String, Arc<dyn LocalHandler>>,
    /// 内置工具的参数语义，按名字索引。动态工具（skill / 插件 / MCP 工具）没有
    /// 条目 —— 它们在 dispatcher 里一律走通用路径，风险取 `AgentTool::disposition()`。
    builtin_semantics: HashMap<String, ToolSemantics>,
}

/// Whether the `render_html` tool and the `builtin.visualize` skill are
/// available. Interactive visualization is desktop-only, so the platform is
/// part of the gate rather than a separate check at each call site.
pub(crate) fn html_render_enabled(experimental_settings: &ExperimentalSettings) -> bool {
    cfg!(desktop) && experimental_settings.enable_html_render
}

// ───────────────────── 内置工具声明表 ─────────────────────

/// Registry 的目标运行模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RegistryMode {
    /// Plan 模式：只读调研与规划，不含写工具、计划编排工具与本机文件系统工具。
    Plan,
    /// Agent / Auto 模式：读写执行。
    Execute,
}

/// 工具可用的运行模式集合。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolModes {
    plan: bool,
    execute: bool,
}

impl ToolModes {
    /// Plan 与 Agent/Auto 都能拿到。
    pub const ALL: Self = Self {
        plan: true,
        execute: true,
    };
    /// 仅 Agent / Auto（写工具、计划编排、需要本机文件系统的工具）。
    pub const EXECUTE: Self = Self {
        plan: false,
        execute: true,
    };
    /// 仅 Plan 模式。
    pub const PLAN: Self = Self {
        plan: true,
        execute: false,
    };

    fn matches(self, mode: RegistryMode) -> bool {
        match mode {
            RegistryMode::Plan => self.plan,
            RegistryMode::Execute => self.execute,
        }
    }
}

/// 工具面向哪一类 agent。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolAudience {
    /// 主任务：能拿到编排类工具（派发子 agent、维护 todolist）。
    Main,
    /// 子 agent：单任务执行者，不编排。这条收敛规则写在声明里，
    /// 不再「先注册全套、再回头按名字删掉」。
    Sub,
}

/// 工具对「角色」的限制。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRoles {
    /// 主任务与子 agent 都能拿到。
    Both,
    /// 只有主任务能拿到（编排类工具）。
    MainOnly,
}

impl ToolRoles {
    fn allows(self, audience: ToolAudience) -> bool {
        match self {
            Self::Both => true,
            Self::MainOnly => matches!(audience, ToolAudience::Main),
        }
    }
}

/// `ExperimentalSettings` 里控制工具可见性的开关。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolSwitch {
    WebSearch,
    HttpFetch,
    CloudPage,
    HtmlRender,
}

impl ToolSwitch {
    fn is_on(self, settings: &ExperimentalSettings) -> bool {
        match self {
            Self::WebSearch => settings.enable_web_search,
            Self::HttpFetch => settings.enable_http_fetch,
            Self::CloudPage => settings.enable_cloud_page,
            // 平台维度不在这里判断：`render_html` 的条目只在桌面端存在。
            Self::HtmlRender => settings.enable_html_render,
        }
    }
}

/// 工具对 `path_arg` 的写方式，决定「写前必须已读」的检查强度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathWrite {
    /// 不写路径（`read_file`）。
    None,
    /// 改写既有文件：目标没读过就直接失败，不进入审批 —— 注定失败的编辑不该
    /// 让用户白点一次审批。目标不存在的情况由 `execute()` 自己报错。
    Edit,
    /// 写入 / 覆盖：目标已存在且未读过才拦，新建放行。
    Overwrite,
}

/// `AgentModeSettings` 里的细粒度审批开关。
///
/// 与 `confirm_each_command`（按风险档位全局生效）不同，这类开关只约束
/// 声明了它的那些工具。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalSwitch {
    /// `confirm_edit_file`：编辑文件前必须人工确认。
    EditFile,
}

impl ApprovalSwitch {
    pub fn is_on(self, settings: &crate::config::settings::AgentModeSettings) -> bool {
        match self {
            Self::EditFile => settings.confirm_edit_file,
        }
    }
}

/// 工具的参数语义 —— 让 dispatcher 不必靠工具名硬编码就能正确处理它。
///
/// 这些字段回答的是「这个工具的参数里，哪个键是命令、哪个是路径、它会不会写路径、
/// 受哪个审批开关约束」。dispatcher 只认这些声明，不再出现
/// `if tc.name == "bash"` / `if tc.name == "edit_file"` 这类判断：
/// 新增一个「执行命令」或「改远端文件」的工具时，填好这里的声明就自动获得
/// 动态风险、读前检查、受保护路径提权、审批摘要等全部通用处理。
#[derive(Debug, Clone, Copy)]
pub struct ToolSemantics {
    /// 参数里承载「要执行的 shell 命令」的键。有它的工具会：按命令文本算动态
    /// 风险、走命令名单审批、走模型审批、被拒绝时摘要格式化成 `$ cmd`。
    pub command_arg: Option<&'static str>,
    /// 参数里承载「远端路径」的键。有它的工具会：成功执行后把该路径记入
    /// 「本任务已读」、写到 `protected_paths` 命中时把档位抬到强制审批
    /// （见 `tool_dispatcher::resolve_disposition`）。
    pub path_arg: Option<&'static str>,
    /// 该工具会写 `path_arg` 指向的路径，以及写前检查的强度。
    pub path_write: PathWrite,
    /// 受哪个细粒度审批开关约束。
    pub approval_switch: Option<ApprovalSwitch>,
    /// 弹审批前先预演一次（目前只有编辑预览）：预演就会失败的调用不弹窗。
    pub preview_before_approval: bool,
}

impl ToolSemantics {
    /// 无参数语义：dispatcher 走通用路径，风险直接取 `AgentTool::disposition()`。
    pub const NONE: Self = Self {
        command_arg: None,
        path_arg: None,
        path_write: PathWrite::None,
        approval_switch: None,
        preview_before_approval: false,
    };

    /// 命令类工具（`bash`）：风险由命令文本决定，走名单与模型审批。
    pub const fn command(key: &'static str) -> Self {
        Self {
            command_arg: Some(key),
            ..Self::NONE
        }
    }

    /// 只读路径类工具（`read_file`）：成功即记账，不参与写前检查。
    pub const fn reads_path(key: &'static str) -> Self {
        Self {
            path_arg: Some(key),
            ..Self::NONE
        }
    }

    /// 编辑类工具（`edit_file`）：改写既有文件，受 `confirm_edit_file` 约束，
    /// 弹窗前先预演。
    pub const fn edits_path(key: &'static str) -> Self {
        Self {
            path_arg: Some(key),
            path_write: PathWrite::Edit,
            approval_switch: Some(ApprovalSwitch::EditFile),
            preview_before_approval: true,
            command_arg: None,
        }
    }

    /// 写入类工具（`write_file`）：可新建可覆盖，覆盖前要求已读过。
    pub const fn overwrites_path(key: &'static str) -> Self {
        Self {
            path_arg: Some(key),
            path_write: PathWrite::Overwrite,
            ..Self::NONE
        }
    }
}

/// 工具在系统提示词里需要的附加段。
///
/// 这里只说「语义需求」（这个工具需要联网搜索的说明段），具体渲染成哪个模板、
/// 排在什么位置由 `templates.rs` 的 `render_agent_prompt` 决定 —— 提示词结构的
/// 权威在那里，工具层不该知道模板文件名。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum PromptSection {
    /// 「联网搜索」段。
    WebSearch,
    /// 「网页访问」段。
    HttpFetch,
    /// 「子agent 派发」段。
    Subagent,
}

/// 工具作用在哪一侧。
///
/// 模型最容易在这里想错：系统提示词曾断言过"你的操作均在远程服务器上进行"
/// （`templates/agent/角色.hbs` 里那句历史遗留），而 `http_get` / `web_search`
/// 其实从运行 Marcel SSH 的这台电脑发起、`render_html` 只在应用内渲染。
///
/// **权威写在各工具自己的 `description()` 里**——它是模型每轮都会读到的、
/// 且与工具同生共死（不注册就不出现，不会说隔夜话）的那一处。这里只声明事实，
/// 供 `acting_tools_state_their_side` 测试核对描述有没有跟上。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolSide {
    /// 经 SSH 在远端服务器上执行（命令、远端文件、远端系统信息）。
    Remote,
    /// 在用户本机执行（本机浏览器、从本机发起的网络请求）。
    Local,
    /// 两端都有：文件在用户本机与远端之间搬运。
    Both,
    /// 不作用于任何一台机器：应用内的弹窗、计划、会话库、渲染。
    App,
}

/// 一个内置工具的完整声明。
///
/// 三个模式 builder 都从声明表过滤生成，所以「要不要在 Plan 模式出现」
/// （`modes`）、「子 agent 能不能拿到」（`roles`）、「挂在哪个实验性开关后面」
/// （`switch`）、「参数里哪个是命令/路径」（`semantics`）、「要不要提示词段」
/// （`prompt_section`）、「作用在哪一侧」（`side`）都只在这里写一遍，不必再去
/// builder / dispatcher / 提示词拼装处找对应的 `if`。
#[derive(Clone, Copy)]
struct BuiltinToolSpec {
    /// 工具名，必须与 `AgentTool::name()` 完全一致。同名条目允许出现两条，
    /// 只要 `modes` 不重叠 —— Plan 模式的 `ask_user` 就是这样（见下）。
    name: &'static str,
    /// 作用在哪一侧。**必填**（不是 `Option`、没有默认值）是刻意的：新工具
    /// 不声明就编译不过；声明了但描述里没写，由 `acting_tools_state_their_side`
    /// 测试拦下。两处都拦不住才是这次想修的漏。
    side: ToolSide,
    modes: ToolModes,
    roles: ToolRoles,
    /// 需要在「设置 → 实验性功能」里打开的开关；`None` = 无条件可用。
    switch: Option<ToolSwitch>,
    semantics: ToolSemantics,
    /// 注册时要在系统提示词里追加的段。
    prompt_section: Option<PromptSection>,
    build: fn() -> Arc<dyn AgentTool>,
}

/// 声明表里「工具名 → 提示词段」的查询。
///
/// 提示词拼装处拿到的是一份扁平的 [`ToolDefinition`] 列表（名字 + 描述 + schema），
/// 拿不到 registry，所以这里提供按名字查声明的能力 —— 它仍然只有一个数据来源。
pub(crate) fn prompt_section_of(tool_name: &str) -> Option<PromptSection> {
    builtin_tool_specs()
        .into_iter()
        .find(|spec| spec.name == tool_name)
        .and_then(|spec| spec.prompt_section)
}

/// 全平台共用的内置工具声明。
///
/// 顺序不影响行为（[`ToolRegistry::definitions`] 按名字排序），按「核心执行 →
/// 计划编排 → 实验性」分组只是为了好读。
static BUILTIN_TOOLS_COMMON: &[BuiltinToolSpec] = &[
    // ── 只读 / 通用 ──
    BuiltinToolSpec {
        name: "connection_info",
        side: ToolSide::App,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(connection_info::ConnectionInfoTool::new()),
    },
    BuiltinToolSpec {
        name: "bash",
        side: ToolSide::Remote,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::command("command"),
        prompt_section: None,
        build: || Arc::new(bash::BashTool::new()),
    },
    BuiltinToolSpec {
        // 回读会话历史原文（含被压缩掉的归档原文）：本机只读，不需要审批；
        // 范围与上限由工具自己把关（见 tools/history.rs）。
        name: "read_history",
        side: ToolSide::App,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(history::ReadHistoryTool::new()),
    },
    BuiltinToolSpec {
        name: "read_file",
        side: ToolSide::Remote,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::reads_path("path"),
        prompt_section: None,
        build: || Arc::new(file_ops::ReadFileTool::new()),
    },
    BuiltinToolSpec {
        name: "list_directory",
        side: ToolSide::Remote,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(file_ops::ListDirectoryTool::new()),
    },
    BuiltinToolSpec {
        name: "search_files",
        side: ToolSide::Remote,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(search::SearchFilesTool::new()),
    },
    BuiltinToolSpec {
        name: "system_info",
        side: ToolSide::Remote,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(system::SystemInfoTool::new()),
    },
    // ── 后台作业 ──
    BuiltinToolSpec {
        name: "job_output",
        side: ToolSide::Remote,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(job_ops::JobOutputTool::new()),
    },
    BuiltinToolSpec {
        name: "job_kill",
        side: ToolSide::Remote,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(job_ops::JobKillTool::new()),
    },
    BuiltinToolSpec {
        name: "job_list",
        side: ToolSide::Remote,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(job_ops::JobListTool::new()),
    },
    // ── 提问：两种模式各一个实例 ──
    // Plan 模式是「先调研清楚再动手」，不接受「要不要切到 Auto 模式」这类提问，
    // 所以 Plan 用的实例开 `reject_plan_mode_switch_questions`。
    BuiltinToolSpec {
        name: "ask_user",
        side: ToolSide::App,
        modes: ToolModes::PLAN,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(question::QuestionTool::new(true)),
    },
    BuiltinToolSpec {
        name: "ask_user",
        side: ToolSide::App,
        modes: ToolModes::EXECUTE,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(question::QuestionTool::new(false)),
    },
    // ── 写工具：Plan 模式不提供 ──
    BuiltinToolSpec {
        name: "write_file",
        side: ToolSide::Remote,
        modes: ToolModes::EXECUTE,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::overwrites_path("path"),
        prompt_section: None,
        build: || Arc::new(file_ops::WriteFileTool::new()),
    },
    BuiltinToolSpec {
        name: "edit_file",
        side: ToolSide::Remote,
        modes: ToolModes::EXECUTE,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::edits_path("path"),
        prompt_section: None,
        build: || Arc::new(file_ops::EditFileTool::new()),
    },
    // ── 编排：子 agent 是「单任务执行者」，不派发子 agent、不维护 todolist ──
    BuiltinToolSpec {
        name: "create_plan",
        side: ToolSide::App,
        modes: ToolModes::EXECUTE,
        roles: ToolRoles::MainOnly,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(plan::CreatePlanTool::new()),
    },
    BuiltinToolSpec {
        name: "update_plan_item",
        side: ToolSide::App,
        modes: ToolModes::EXECUTE,
        roles: ToolRoles::MainOnly,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(plan::UpdatePlanItemTool::new()),
    },
    BuiltinToolSpec {
        name: "edit_plan",
        side: ToolSide::App,
        modes: ToolModes::EXECUTE,
        roles: ToolRoles::MainOnly,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(plan::EditPlanTool::new()),
    },
    BuiltinToolSpec {
        name: "subagent",
        side: ToolSide::App,
        modes: ToolModes::ALL,
        roles: ToolRoles::MainOnly,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: Some(PromptSection::Subagent),
        build: || Arc::new(subagent::SubagentTool),
    },
    // ── 实验性：联网能力 ──
    BuiltinToolSpec {
        name: "web_search",
        side: ToolSide::Local,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: Some(ToolSwitch::WebSearch),
        semantics: ToolSemantics::NONE,
        prompt_section: Some(PromptSection::WebSearch),
        build: || Arc::new(web_search::WebSearchTool::new()),
    },
    BuiltinToolSpec {
        name: "http_get",
        side: ToolSide::Local,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: Some(ToolSwitch::HttpFetch),
        semantics: ToolSemantics::NONE,
        prompt_section: Some(PromptSection::HttpFetch),
        build: || Arc::new(http_get::HttpGetTool::new()),
    },
    // 需要联网打开云厂商控制台；离线不可用，也不属于只读调研，故不进 Plan 模式。
    BuiltinToolSpec {
        name: "open_cloud_page",
        side: ToolSide::Local,
        modes: ToolModes::EXECUTE,
        roles: ToolRoles::Both,
        switch: Some(ToolSwitch::CloudPage),
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(open_cloud_page::OpenCloudPageTool::new()),
    },
];

/// 仅桌面端存在的内置工具声明。
///
/// 整段用 `cfg(desktop)` 隔开而不是塞一个恒假的开关：`render_html` 模块本身是
/// 桌面专属代码，`upload_file` / `download_file` 读写本机文件系统（Android 走
/// SAF，没有对应语义），移动端连类型都不编译。
#[cfg(desktop)]
static BUILTIN_TOOLS_DESKTOP: &[BuiltinToolSpec] = &[
    BuiltinToolSpec {
        name: "render_html",
        side: ToolSide::App,
        modes: ToolModes::ALL,
        roles: ToolRoles::Both,
        switch: Some(ToolSwitch::HtmlRender),
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(render_html::RenderHtmlTool::new()),
    },
    BuiltinToolSpec {
        name: "upload_file",
        side: ToolSide::Both,
        modes: ToolModes::EXECUTE,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(sftp_transfer::UploadFileTool::new()),
    },
    BuiltinToolSpec {
        name: "download_file",
        side: ToolSide::Both,
        modes: ToolModes::EXECUTE,
        roles: ToolRoles::Both,
        switch: None,
        semantics: ToolSemantics::NONE,
        prompt_section: None,
        build: || Arc::new(sftp_transfer::DownloadFileTool::new()),
    },
];

/// 当前平台的全部内置工具声明。
///
/// 每次构建 registry 时取一份 `Vec`（二十余个 `Copy` 元素），相对一次任务派发
/// 的开销可以忽略，换来的是移动端不必为桌面专属工具维护一个永远为假的分支。
#[cfg_attr(mobile, allow(unused_mut))]
fn builtin_tool_specs() -> Vec<BuiltinToolSpec> {
    let mut specs = BUILTIN_TOOLS_COMMON.to_vec();
    #[cfg(desktop)]
    specs.extend_from_slice(BUILTIN_TOOLS_DESKTOP);
    specs
}

impl ToolRegistry {
    pub fn new() -> Self {
        Self {
            tools: HashMap::new(),
            local_handlers: HashMap::new(),
            builtin_semantics: HashMap::new(),
        }
    }

    /// 按声明注册一个内置工具：工具本体 + 它的参数语义一起登记，两者不会走散。
    fn register_builtin(&mut self, spec: &BuiltinToolSpec) {
        let tool = (spec.build)();
        debug_assert_eq!(
            tool.name(),
            spec.name,
            "内置工具声明表里的 name 与 AgentTool::name() 不一致"
        );
        self.builtin_semantics
            .insert(spec.name.to_string(), spec.semantics);
        self.register(tool);
    }

    /// 查内置工具的参数语义。动态工具（skill / 插件 / MCP）返回 `None`，
    /// dispatcher 据此走通用路径。
    pub fn semantics(&self, name: &str) -> Option<ToolSemantics> {
        self.builtin_semantics.get(name).copied()
    }

    /// Register a tool. The last registration wins on name collision.
    pub fn register(&mut self, tool: Arc<dyn AgentTool>) {
        self.tools.insert(tool.name().to_string(), tool);
    }

    /// Remove a tool by name. Used to converge a registry for a sub-agent
    /// role (e.g. strip `subagent`/plan orchestration tools from execution
    /// sub-agents). Missing name is a no-op.
    pub fn remove(&mut self, name: &str) {
        self.tools.remove(name);
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

    // ── 模式感知的 registry 构建 ──────────────────────────────────────────
    //
    // 三种模式的工具集不再各写一份 if-else，而是同一张声明表
    // （`BUILTIN_TOOLS_COMMON` / `BUILTIN_TOOLS_DESKTOP`）按三个维度过滤：
    //
    //   modes   —— Plan（只读调研）/ Execute（Agent 与 Auto）
    //   roles   —— Main 能编排，Sub 只执行
    //   switch  —— 实验性开关（联网搜索 / 网页抓取 / 云控制台 / 交互式可视化）
    //
    // Plan 与 Agent/Auto 的差异全部落在声明里：写工具、计划编排、本机文件系统
    // 工具标 `EXECUTE`，编排类标 `MainOnly`，联网类挂各自的开关。一个新工具该不该
    // 进 Plan 模式，看声明表就能回答，不必翻 builder。

    /// 从声明表构建 registry。
    ///
    /// skills 在最后注册（渐进披露）；插件本地处理器不在这里，见
    /// [`Self::build_mut_for_mode`]。
    fn build_from_specs(
        mode: RegistryMode,
        audience: ToolAudience,
        enabled_skills: &[crate::skills::store::Skill],
        experimental_settings: &ExperimentalSettings,
    ) -> Self {
        let mut registry = Self::new();
        for spec in builtin_tool_specs() {
            if !spec.modes.matches(mode) || !spec.roles.allows(audience) {
                continue;
            }
            if let Some(switch) = spec.switch {
                if !switch.is_on(experimental_settings) {
                    continue;
                }
            }
            registry.register_builtin(&spec);
        }
        registry.register_skills(enabled_skills);
        registry
    }

    /// Plan 模式的 registry：只读调研 + 规划所需工具，不含写工具与计划编排工具。
    pub fn build_for_plan_mode(
        audience: ToolAudience,
        enabled_skills: &[crate::skills::store::Skill],
        experimental_settings: &ExperimentalSettings,
    ) -> Self {
        Self::build_from_specs(
            RegistryMode::Plan,
            audience,
            enabled_skills,
            experimental_settings,
        )
    }

    /// Agent / Auto 模式的 registry + 插件本地处理器。
    ///
    /// 这是 Agent/Auto 的唯一构建入口：生产路径需要 `kind: "local"` 处理器，
    /// 而「不加本地处理器」的变体没有任何调用方，故不再单独提供。
    pub fn build_mut_for_mode(
        audience: ToolAudience,
        enabled_skills: &[crate::skills::store::Skill],
        experimental_settings: &ExperimentalSettings,
    ) -> Self {
        let mut registry = Self::build_from_specs(
            RegistryMode::Execute,
            audience,
            enabled_skills,
            experimental_settings,
        );
        // Register the 6 generic local handlers (fs.read/fs.write/fs.append/
        // session.info/connection.info/host_port) so any plugin tool declaring
        // `kind: "local"` + `handler: "<name>"` can invoke them. Without this
        // call, plugin local tools would always fail with "handler 未注册".
        local_handlers::register_default_handlers(&mut registry);
        registry
    }

    /// 默认设置下的完整内置工具集（主任务视角）。
    ///
    /// 只给测试与 [`Default`] 用：生产路径一律走 [`Self::build_mut_for_mode`] 与
    /// [`Self::build_for_plan_mode`]，由那里把真实设置与角色传进来。
    pub fn with_builtins() -> Self {
        Self::build_from_specs(
            RegistryMode::Execute,
            ToolAudience::Main,
            &[],
            &ExperimentalSettings::default(),
        )
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

/// `host` 参数“机器名必须逐字符一致”的权威短提示。四个带 host 的工具
/// （bash / subagent / upload_file / download_file）共用这一份，改这里就够。
/// 完整说明只在系统提示词的多机段（`templates/agent/多机.hbs`）——工具侧不得
/// 再复述一遍，`host_rule_is_single_sourced` 会拦下顺手抄的那一份。
pub(crate) const HOST_MATCH_RULE: &str = "IMPORTANT: must match the machine name in the multi-host list character-for-character, case-sensitive — any single-character difference (case, space, punctuation) is rejected, never silently redirected.";

#[cfg(test)]
mod tests {
    use super::*;

    /// host 规则只允许出现在两处：系统提示词的多机段（完整说明）与本文件的
    /// `HOST_MATCH_RULE`（工具侧短提示）。
    #[test]
    fn host_rule_is_single_sourced() {
        let r = ToolRegistry::with_builtins();
        let mut host_params = 0;
        for def in r.definitions() {
            assert!(
                !def.description
                    .to_lowercase()
                    .contains("character-for-character"),
                "{} 的工具描述里又抄了一份 host 规则；完整说明在多机段，工具侧用 HOST_MATCH_RULE",
                def.name
            );
            let Some(host) = def
                .parameters
                .get("properties")
                .and_then(|p| p.get("host"))
                .and_then(|h| h.get("description"))
                .and_then(|d| d.as_str())
            else {
                continue;
            };
            assert!(
                host.ends_with(HOST_MATCH_RULE),
                "{} 的 host 参数没有复用 HOST_MATCH_RULE：{}",
                def.name,
                host
            );
            host_params += 1;
        }
        // 桌面构建下应有 bash / subagent / upload_file / download_file 四个。
        assert!(
            host_params >= 2,
            "带 host 参数的工具数异常：{}",
            host_params
        );
    }

    /// 作用于机器的工具，必须在自己的 `description()` 里写明作用侧。
    ///
    /// 「模型知道这个工具动的是哪台机器」由三处合起来保证：
    /// 1. `templates/agent/角色.hbs` 只纠正"操作全在远端"这个心智模型 —— 它**不能
    ///    点名工具**（无工具段的构建里出现工具名会碎掉模板测试），所以它只能说
    ///    "以工具说明为准"；
    /// 2. 各工具自己的描述是**权威**：模型每轮请求都会读到工具 schema，且描述与
    ///    工具同生共死（不注册就不出现，不会说隔夜话）；
    /// 3. 这条测试拦住第三件事——新工具加了、`side` 声明了、描述忘了写。
    ///
    /// `side` 必填只保证"声明过"，声明的兑现靠这里。`ToolSide::App` 不要求：
    /// 它压根不碰机器，硬要它写一句"我在应用内跑"只会变成凑词。
    ///
    /// 这是**下限**检查：远端侧只要求描述里出现指向远端的词，不钉具体措辞——
    /// 它拦的是"整篇描述一个字没提作用侧"，不是审文案。
    #[test]
    fn acting_tools_state_their_side() {
        const REMOTE: &[&str] = &["remote", "远端", "远程"];
        const LOCAL: &[&str] = &[
            "this computer",
            "where marcel ssh runs",
            "user's own computer",
            "本机",
            "这台电脑",
        ];
        let has_any = |hay: &str, words: &[&str]| words.iter().any(|w| hay.contains(*w));

        let mut checked = 0;
        for spec in builtin_tool_specs() {
            let wanted: &[(&str, &[&str])] = match spec.side {
                ToolSide::App => continue,
                ToolSide::Remote => &[("远端", REMOTE)],
                ToolSide::Local => &[("本机", LOCAL)],
                ToolSide::Both => &[("远端", REMOTE), ("本机", LOCAL)],
            };
            // 直接构造工具读描述，不走注册表：注册表按模式/角色/开关过滤，
            // 那样会漏掉「这次没被注册」的那些（例如开关关掉的 web_search）。
            let desc = (spec.build)().description().to_lowercase();
            for (label, words) in wanted {
                assert!(
                    has_any(&desc, words),
                    "工具 {} 声明作用于{}侧，但它的 description() 里没有任何对应的词（{}）。\n作用在哪一侧的权威在各工具自己的描述里，补上描述再改声明：\n{}",
                    spec.name,
                    label,
                    words.join(" / "),
                    desc
                );
            }
            checked += 1;
        }
        // 桌面构建下应为 10 Remote + 3 Local + 2 Both。这个下限只防"声明表没读全
        // 导致测试空转"。
        assert!(
            checked >= 10,
            "只核对到 {} 个作用于机器的工具，声明表可能没读全",
            checked
        );
    }

    /// 全部实验性开关关闭。
    fn all_switches_off() -> ExperimentalSettings {
        ExperimentalSettings {
            enable_web_search: false,
            enable_http_fetch: false,
            enable_cloud_page: false,
            enable_html_render: false,
            ..Default::default()
        }
    }

    /// 全部实验性开关打开。
    fn all_switches_on() -> ExperimentalSettings {
        ExperimentalSettings {
            enable_web_search: true,
            enable_http_fetch: true,
            enable_cloud_page: true,
            enable_html_render: true,
            ..Default::default()
        }
    }

    /// 声明表自身的不变量，两条都在这个测试里钉死：
    /// 1. 每个条目都能构造出来，且工具的 `name()` 与声明的 `name` 一致；
    /// 2. 同名条目在任一「模式 × 角色」组合下**至多命中一条** —— `ask_user`
    ///    有两条（Plan 版 / Execute 版），靠 `modes` 互斥分开，一旦有人把它们
    ///    的模式改成重叠，这里会立刻报出来，而不是让后者静默覆盖前者。
    #[test]
    fn builtin_tool_specs_are_well_formed() {
        for spec in builtin_tool_specs() {
            let tool = (spec.build)();
            assert_eq!(
                tool.name(),
                spec.name,
                "声明表的 name 与 AgentTool::name() 不一致"
            );
        }
        for mode in [RegistryMode::Plan, RegistryMode::Execute] {
            for audience in [ToolAudience::Main, ToolAudience::Sub] {
                let mut seen = std::collections::BTreeSet::new();
                for spec in builtin_tool_specs() {
                    if !spec.modes.matches(mode) || !spec.roles.allows(audience) {
                        continue;
                    }
                    assert!(
                        seen.insert(spec.name),
                        "{} 在 {:?} / {:?} 下被声明了两次",
                        spec.name,
                        mode,
                        audience
                    );
                }
            }
        }
    }

    /// 各「模式 × 角色」的工具集契约。
    ///
    /// 只断言**已有工具**的归位，不做「总数等于 N」的穷举 —— 那样每加一个工具都要
    /// 回来改测试。新工具该进哪个集合，由 `BUILTIN_TOOLS_COMMON` 的声明决定。
    #[test]
    fn registry_tool_sets_per_mode_and_audience() {
        let on = all_switches_on();

        // Plan（只读调研）：有读工具与联网工具，没有写工具、计划编排、本机文件系统工具。
        let plan_main = ToolRegistry::build_for_plan_mode(ToolAudience::Main, &[], &on);
        for name in [
            "ask_user",
            "connection_info",
            "bash",
            "read_file",
            "read_history",
            "list_directory",
            "search_files",
            "system_info",
            "job_output",
            "job_kill",
            "job_list",
            "subagent",
            "web_search",
            "http_get",
        ] {
            assert!(plan_main.get(name).is_some(), "Plan/Main 应含 {}", name);
        }
        for name in [
            "write_file",
            "edit_file",
            "create_plan",
            "update_plan_item",
            "edit_plan",
            "open_cloud_page",
        ] {
            assert!(plan_main.get(name).is_none(), "Plan/Main 不应有 {}", name);
        }

        // Plan 子 agent 不能派发子 agent。
        let plan_sub = ToolRegistry::build_for_plan_mode(ToolAudience::Sub, &[], &on);
        assert!(
            plan_sub.get("subagent").is_none(),
            "Plan/Sub 不应有 subagent"
        );
        assert!(plan_sub.get("bash").is_some(), "Plan/Sub 应保留 bash");
        assert!(
            plan_sub.get("read_history").is_some(),
            "Plan/Sub 应保留 read_history（子代理要能回读主 agent 派发它时的上下文）"
        );

        // Agent/Auto：读写执行 + 计划编排 + 云控制台；插件本地处理器随之注册。
        let exec_main = ToolRegistry::build_mut_for_mode(ToolAudience::Main, &[], &on);
        for name in [
            "bash",
            "read_file",
            "read_history",
            "write_file",
            "edit_file",
            "list_directory",
            "search_files",
            "system_info",
            "create_plan",
            "update_plan_item",
            "edit_plan",
            "subagent",
            "job_output",
            "job_kill",
            "job_list",
            "web_search",
            "http_get",
            "open_cloud_page",
        ] {
            assert!(exec_main.get(name).is_some(), "Execute/Main 应含 {}", name);
        }
        assert!(
            exec_main.get_local_handler("fs.read").is_some(),
            "build_mut_for_mode 必须注册插件本地处理器"
        );

        // Execute 子 agent 拿不到任何编排工具。
        let exec_sub = ToolRegistry::build_mut_for_mode(ToolAudience::Sub, &[], &on);
        for name in ["subagent", "create_plan", "update_plan_item", "edit_plan"] {
            assert!(exec_sub.get(name).is_none(), "Execute/Sub 不应有 {}", name);
        }
        assert!(
            exec_sub.get("write_file").is_some(),
            "Execute/Sub 应保留写工具"
        );
        assert!(
            exec_sub.get("read_history").is_some(),
            "Execute/Sub 应保留 read_history（只读，与 Main 一致）"
        );
    }

    /// 实验性开关必须逐项独立生效：关掉谁就只少谁。
    #[test]
    fn registry_respects_experimental_tool_toggles() {
        let off = all_switches_off();
        for (mode, names) in [
            (
                RegistryMode::Plan,
                ToolRegistry::build_for_plan_mode(ToolAudience::Main, &[], &off),
            ),
            (
                RegistryMode::Execute,
                ToolRegistry::build_mut_for_mode(ToolAudience::Main, &[], &off),
            ),
        ] {
            let names: Vec<String> = names.definitions().into_iter().map(|d| d.name).collect();
            for absent in ["web_search", "http_get", "open_cloud_page", "render_html"] {
                assert!(
                    !names.iter().any(|n| n == absent),
                    "{:?} 模式在开关全关时不应有 {}",
                    mode,
                    absent
                );
            }
        }

        let on = all_switches_on();
        let names: Vec<String> = ToolRegistry::build_mut_for_mode(ToolAudience::Main, &[], &on)
            .definitions()
            .into_iter()
            .map(|d| d.name)
            .collect();
        for present in ["web_search", "http_get", "open_cloud_page", "render_html"] {
            assert!(
                names.iter().any(|n| n == present),
                "开关全开时应有 {}",
                present
            );
        }
    }

    /// 联网两个开关互不影响：只开一个就只多一个。
    #[test]
    fn registry_toggles_web_search_and_http_get_independently() {
        let only_search = ExperimentalSettings {
            enable_web_search: true,
            enable_http_fetch: false,
            ..all_switches_off()
        };
        let names: Vec<_> = ToolRegistry::build_mut_for_mode(ToolAudience::Main, &[], &only_search)
            .definitions()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert!(names.iter().any(|n| n == "web_search"));
        assert!(!names.iter().any(|n| n == "http_get"));

        let only_http = ExperimentalSettings {
            enable_web_search: false,
            enable_http_fetch: true,
            ..all_switches_off()
        };
        let names: Vec<_> = ToolRegistry::build_mut_for_mode(ToolAudience::Main, &[], &only_http)
            .definitions()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert!(!names.iter().any(|n| n == "web_search"));
        assert!(names.iter().any(|n| n == "http_get"));
    }

    /// 参数语义声明的契约。
    ///
    /// dispatcher 不再按工具名硬编码，而是读这些声明来决定：风险怎么算、写前
    /// 要不要检查、受保护路径要不要提权、受哪个审批开关约束、弹窗前要不要预演。
    /// 所以「哪个工具属于哪一类」必须在这里被钉住 —— 新增同类工具时应当是有意
    /// 为之，而不是被静默继承。
    #[test]
    fn builtin_tool_semantics_are_declared() {
        let sem = |name: &str| {
            builtin_tool_specs()
                .into_iter()
                .find(|s| s.name == name)
                .unwrap_or_else(|| panic!("声明表里没有 {} ", name))
                .semantics
        };

        // 命令类：目前只有 bash 执行 shell 命令，因而只有它按命令文本算风险、
        // 走命令名单与模型审批、用 `$ cmd` 作拒绝摘要。
        let command_tools: Vec<&str> = builtin_tool_specs()
            .iter()
            .filter(|s| s.semantics.command_arg.is_some())
            .map(|s| s.name)
            .collect();
        assert_eq!(
            command_tools,
            vec!["bash"],
            "命令类工具的归属变了：请确认是新增了执行命令的工具，而不是漏改声明"
        );

        // 路径类：都声明了路径参数键；读工具不参与写前检查。
        assert_eq!(sem("read_file").path_arg, Some("path"));
        assert_eq!(sem("read_file").path_write, PathWrite::None);
        // 写工具必须声明路径参数，否则「写前必须已读」无从下手。
        assert_eq!(sem("edit_file").path_arg, Some("path"));
        assert_eq!(sem("write_file").path_arg, Some("path"));
        // 写前检查的强度不同：改既有文件必须已读；覆盖才查存在性。
        assert_eq!(sem("edit_file").path_write, PathWrite::Edit);
        assert_eq!(sem("write_file").path_write, PathWrite::Overwrite);

        // 编辑类工具受 confirm_edit_file 约束，且弹审批前先预演。
        assert_eq!(
            sem("edit_file").approval_switch,
            Some(ApprovalSwitch::EditFile)
        );
        let previewing: Vec<&str> = builtin_tool_specs()
            .iter()
            .filter(|s| s.semantics.preview_before_approval)
            .map(|s| s.name)
            .collect();
        assert_eq!(
            previewing,
            vec!["edit_file"],
            "dispatcher 只实现了编辑预览；多出别的预演工具说明这里没跟上"
        );

        // 其余工具不应误声明语义：随手写上 path_arg 会让它无端参与写前检查。
        let with_semantics: Vec<&str> = builtin_tool_specs()
            .iter()
            .filter(|s| {
                s.semantics.command_arg.is_some()
                    || s.semantics.path_arg.is_some()
                    || s.semantics.approval_switch.is_some()
                    || s.semantics.preview_before_approval
            })
            .map(|s| s.name)
            .collect();
        assert_eq!(
            with_semantics,
            vec!["bash", "read_file", "write_file", "edit_file"]
        );
    }

    /// 提示词段声明的契约。
    ///
    /// 系统提示词的组装不再判断「有没有 web_search 工具」，而是问声明表：
    /// 「这次注册进来的工具里有谁需要提示词段」。所以这里既钉住归属，也验证
    /// 这条推导链真的通（声明 → 注册集合 → 派生出的段）。
    #[test]
    fn builtin_tool_prompt_sections_are_declared() {
        let declared: Vec<(&str, PromptSection)> = builtin_tool_specs()
            .iter()
            .filter_map(|spec| spec.prompt_section.map(|section| (spec.name, section)))
            .collect();
        assert_eq!(
            declared,
            vec![
                ("subagent", PromptSection::Subagent),
                ("web_search", PromptSection::WebSearch),
                ("http_get", PromptSection::HttpFetch),
            ],
            "带提示词段的工具集变了：请同步确认 templates/agent 下的模板仍对应"
        );

        // 开关全开时，从注册集合推导出的段应与声明一致 —— 验证推导链本身。
        let registry =
            ToolRegistry::build_mut_for_mode(ToolAudience::Main, &[], &all_switches_on());
        let derived: std::collections::BTreeSet<PromptSection> = registry
            .definitions()
            .iter()
            .filter_map(|def| prompt_section_of(&def.name))
            .collect();
        assert_eq!(
            derived,
            std::collections::BTreeSet::from([
                PromptSection::Subagent,
                PromptSection::WebSearch,
                PromptSection::HttpFetch,
            ]),
            "从注册集合推导出的提示词段与声明表不一致"
        );
    }

    /// 桌面专属工具只在桌面注册（移动端连类型都不编译）。
    #[test]
    fn desktop_only_tools_are_platform_gated() {
        let r = ToolRegistry::build_mut_for_mode(ToolAudience::Main, &[], &all_switches_on());
        for name in ["render_html", "upload_file", "download_file"] {
            #[cfg(desktop)]
            assert!(r.get(name).is_some(), "桌面应注册 {}", name);
            #[cfg(not(desktop))]
            assert!(r.get(name).is_none(), "移动端不应注册 {}", name);
        }
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
                "bash"
            }
            fn description(&self) -> &str {
                "dummy"
            }
            fn parameters_schema(&self) -> serde_json::Value {
                serde_json::json!({})
            }
            fn disposition(&self) -> Disposition {
                Disposition::Allow
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
        let old_desc = r.get("bash").unwrap().description().to_string();
        r.register(Arc::new(DummyTool));
        assert_eq!(r.get("bash").unwrap().description(), "dummy");
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
