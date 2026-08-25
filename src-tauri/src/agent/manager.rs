//! AgentManager — 统一 agent 的组装与生命周期管理。
//!
//! 职责边界（manager 而非纯功能）：
//! - **组装**：从 [`AgentSpec`]（声明式描述）派生出 provider / registry /
//!   messages，收敛 Plan / Agent / Auto 三种模式在工具集、system prompt、
//!   插件段上的差异。
//! - **生命周期**：注册 [`AgentTask`]、spawn [`run_agent_loop`]、统一终态
//!   更新、取消信号清理与 panic 兜底。
//!
//! 主任务与子任务（`task` 工具派发）共用同一个 [`AgentManager::spawn`]
//! 入口，子代理只是 [`AgentSpec`] 叠加了角色约束，不再复制组装逻辑。
//!
//! 调用方（`commands/agent_lifecycle`、`agent/tools/subagent`）负责「决定要
//! 跑什么」（spec）与前后的事件/对话准备，不各自实现组装与 spawn。

use std::sync::Arc;

use futures::FutureExt;
use tauri::AppHandle;
use tokio::sync::watch;

use crate::agent::agent_loop::{run_agent_loop, LoopContext};
use crate::agent::system_prompt::build_system_prompt;
use crate::agent::task::{AgentMode, AgentStatus, AgentTask, AgentTaskPlan};
use crate::agent::templates::TemplateManager;
use crate::agent::tools::{
    mcp::register_mcp_tools, plugin_tool::register_plugin_tools, subagent::TaskTool, ToolRegistry,
};
use crate::config::settings::ExperimentalSettings;
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ProviderType, ToolDefinition};
use crate::mcp::store::McpServerConfig;
use crate::plugins::context::{apply_to_string, SessionContext};
use crate::plugins::registry::PluginRegistry;
use crate::ssh::connection::SessionInfo;
use crate::AppState;

/// 单个插件贡献的 system prompt 段的最大字符数。
const PLUGIN_SECTION_MAX_CHARS: usize = 2000;

/// 一个 agent 实例的角色。
#[derive(Debug, Clone, PartialEq)]
pub enum AgentRole {
    /// 主任务：由用户直接发起。
    Main,
    /// 子任务：由 `task` 工具派发的调研子 agent。
    Sub { parent_task_id: String },
}

impl AgentRole {
    fn is_subtask(&self) -> bool {
        matches!(self, AgentRole::Sub { .. })
    }

    fn parent_task_id(&self) -> Option<&str> {
        match self {
            AgentRole::Sub { parent_task_id } => Some(parent_task_id),
            AgentRole::Main => None,
        }
    }
}

/// 声明式描述一次 agent 组装与运行。
pub struct AgentSpec {
    /// 任务实例标识，由调用方生成：主任务要返回给前端，子任务要在 spawn
    /// 前 emit `SubTaskStart` 注册子对话流监听。
    pub task_id: String,
    pub mode: AgentMode,
    pub role: AgentRole,
    pub session_id: String,
    pub conversation_id: String,
    pub prompt: String,
    /// 前端传入的历史消息（子任务通常为空）。
    pub history: Vec<LlmMessage>,
    /// 覆盖主模型的 model 名（子任务可选）。
    pub model_override: Option<String>,
    /// 追加到 system prompt 的角色约束段（子任务的调研约束）。
    /// 作为拼装组件传入，与基础段一样由模板拼装器统一拼接。
    pub prompt_extra: Vec<String>,
}

/// [`AgentManager::spawn`] 返回的任务句柄。
///
/// 主任务通常 fire-and-forget（drop 句柄即可，spawn 内部已保证终态与取消
/// 清理）；子任务需要 [`AgentTaskHandle::join`] 拿回调研结果文本。
pub struct AgentTaskHandle {
    pub task_id: String,
    join: tokio::task::JoinHandle<Option<String>>,
}

impl AgentTaskHandle {
    pub async fn join(self) -> Option<String> {
        let task_id = self.task_id.clone();
        match self.join.await {
            Ok(result) => result,
            Err(e) => {
                log::error!("agent task {} join error: {}", task_id, e);
                None
            }
        }
    }
}

/// 统一管理 agent 的组装与生命周期。
pub struct AgentManager {
    state: AppState,
}

impl AgentManager {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    /// 组装并启动一个 agent 实例。负责：
    /// 1. 注册 [`AgentTask`]（主任务额外恢复最近一次 plan）；
    /// 2. 从 spec 派生 provider / registry / messages；
    /// 3. spawn [`run_agent_loop`] 并统一终态更新、取消清理与 panic 兜底。
    pub async fn spawn(
        &self,
        app: &AppHandle,
        spec: AgentSpec,
    ) -> Result<AgentTaskHandle, AppError> {
        let task_id = spec.task_id.clone();

        // ── 1. 读取设置 ──
        let (
            llm_config,
            agent_settings,
            experimental_settings,
            mut enabled_skills,
            enabled_mcp_servers,
        ) = {
            let settings = self.state.settings.read().await;
            let skills = self.state.skill_store.read().await;
            let mcp_store = self.state.mcp_store.read().await;
            (
                settings.llm_config.clone(),
                settings.agent_mode_settings.clone(),
                settings.experimental_settings.clone(),
                skills
                    .list()
                    .iter()
                    .filter(|s| s.enabled)
                    .cloned()
                    .collect::<Vec<_>>(),
                mcp_store
                    .list()
                    .iter()
                    .filter(|s| s.enabled)
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        };

        let llm_config =
            llm_config.ok_or_else(|| AppError::Llm("尚未配置 LLM，请前往设置填写".into()))?;
        if !crate::agent::tools::html_render_enabled(&experimental_settings) {
            enabled_skills.retain(|skill| skill.id != "builtin.visualize");
        }
        if llm_config.provider_type != ProviderType::OpenAI {
            return Err(AppError::Llm("当前仅支持 OpenAI 兼容 Provider".into()));
        }
        let mut provider_cfg = llm_config.clone();
        if let Some(model) = spec.model_override {
            provider_cfg.model = model;
        }
        let provider = OpenAiProvider::new(provider_cfg)?;

        // ── 4. 派生工具集 / 插件段 ──
        let plugin_registry_guard = self.state.plugin_registry.read().await;
        let registry = self
            .build_registry(
                &spec.role,
                &spec.mode,
                &enabled_skills,
                &enabled_mcp_servers,
                &experimental_settings,
                &plugin_registry_guard,
            )
            .await;
        let tools = build_definitions(&registry, &spec.mode);
        let plugin_sections = collect_plugin_sections(
            &plugin_registry_guard,
            &self.state.ssh_manager,
            &spec.session_id,
            &spec.mode,
        )
        .await;
        drop(plugin_registry_guard);

        // ── 5. 组装 messages（含角色约束段统一拼装） ──
        let messages = build_agent_messages(
            &TemplateManager,
            &spec.session_id,
            &tools,
            &spec.history,
            &spec.prompt,
            &agent_settings.system_prompt,
            &plugin_sections,
            matches!(spec.mode, AgentMode::Plan),
            &spec.prompt_extra,
        )?;

        // 所有可能失败的组装步骤完成后再提交运行态。spawn 返回 Err 时，
        // 不会留下前端拿不到 task_id、后端却永久视为 running 的幽灵任务。
        self.state.agent_tasks.write().insert(
            task_id.clone(),
            AgentTask {
                id: task_id.clone(),
                session_id: spec.session_id.clone(),
                conversation_id: spec.conversation_id.clone(),
                prompt: spec.prompt.clone(),
                mode: spec.mode.clone(),
                status: AgentStatus::Planning,
                has_plan: false,
                created_at: chrono::Utc::now(),
                parent_task_id: spec.role.parent_task_id().map(String::from),
            },
        );
        if spec.role == AgentRole::Main {
            self.restore_latest_plan(&task_id, &spec.conversation_id);
        }

        // ── 6. spawn + 生命周期 ──
        let (cancel_tx, cancel_rx) = watch::channel(false);
        self.state
            .cancel_senders
            .write()
            .insert(task_id.clone(), cancel_tx);

        let loop_ctx = LoopContext {
            ssh: self.state.ssh_manager.clone(),
            session_id: spec.session_id.clone(),
            app: app.clone(),
            state: self.state.clone(),
            registry,
            conversation_id: spec.conversation_id.clone(),
            conv_db: self.state.conversation_db.clone(),
            cancel_rx,
            config_dir: self.state.config_dir.clone(),
            is_subtask: spec.role.is_subtask(),
        };

        let state_cleanup = self.state.clone();
        let task_id_owned = task_id.clone();
        let mode_owned = spec.mode.clone();
        let join = tokio::spawn(async move {
            // catch_unwind：无论 run_agent_loop 内部是否 panic，终态更新与
            // 取消清理都保证执行（此前主任务丢弃 JoinHandle，panic 时泄漏）。
            let result = std::panic::AssertUnwindSafe(run_agent_loop(
                task_id_owned.clone(),
                provider,
                messages,
                tools,
                mode_owned,
                agent_settings,
                loop_ctx,
            ))
            .catch_unwind()
            .await;
            let result = match result {
                Ok(r) => r,
                Err(e) => {
                    log::error!("agent task {} panicked: {:?}", task_id_owned, e);
                    None
                }
            };
            finalize_task(&state_cleanup, &task_id_owned, &result);
            prune_terminal_tasks(&state_cleanup, 200);
            result
        });

        log::info!("Agent task started: {} ({:?})", task_id, spec.mode);
        Ok(AgentTaskHandle { task_id, join })
    }

    /// 按模式派生工具集（含插件/MCP 注册）。
    async fn build_registry(
        &self,
        role: &AgentRole,
        mode: &AgentMode,
        enabled_skills: &[crate::skills::store::Skill],
        enabled_mcp_servers: &[McpServerConfig],
        experimental_settings: &ExperimentalSettings,
        plugin_registry: &PluginRegistry,
    ) -> Arc<ToolRegistry> {
        match mode {
            AgentMode::Plan => Arc::new(build_plan_registry(
                role,
                enabled_skills,
                experimental_settings,
            )),
            AgentMode::Agent | AgentMode::Auto => {
                let mut registry =
                    ToolRegistry::build_mut_for_mode(enabled_skills, experimental_settings);
                let manifests = plugin_registry.enabled_manifests();
                for m in &manifests {
                    register_plugin_tools(&mut registry, &m.id, &m.capabilities, &m.agent_tools);
                }
                let mut set = tokio::task::JoinSet::new();
                for server in enabled_mcp_servers {
                    let mgr = self.state.mcp_manager.clone();
                    let server = server.clone();
                    set.spawn(async move {
                        let result = mgr.refresh_tools(&server).await;
                        (server, result)
                    });
                }
                while let Some(result) = set.join_next().await {
                    match result {
                        Ok((server, Ok(tools))) => {
                            register_mcp_tools(&mut registry, &server, tools)
                        }
                        Ok((server, Err(err))) => {
                            log::warn!("刷新 MCP tools 失败 [{}]: {}", server.name, err)
                        }
                        Err(join_err) => log::warn!("MCP 刷新任务 panic: {}", join_err),
                    }
                }
                Arc::new(registry)
            }
        }
    }

    /// 主任务：从 SQLite 恢复该 conversation 最近一条 plan 挂到新 task。
    fn restore_latest_plan(&self, task_id: &str, conversation_id: &str) {
        if self.state.plans.read().get(task_id).is_some() {
            return;
        }
        match self
            .state
            .conversation_db
            .load_latest_plan_by_conversation(conversation_id)
        {
            Ok(Some(plan_json)) => match serde_json::from_str::<AgentTaskPlan>(&plan_json) {
                Ok(mut plan) => {
                    plan.task_id = task_id.to_string();
                    self.state.plans.write().insert(task_id.to_string(), plan);
                    if let Some(task) = self.state.agent_tasks.write().get_mut(task_id) {
                        task.has_plan = true;
                    }
                    log::info!(
                        "Restored plan for new task {} from conversation {}",
                        task_id,
                        conversation_id
                    );
                }
                Err(e) => {
                    log::warn!(
                        "Failed to deserialize plan for conversation {}: {}",
                        conversation_id,
                        e
                    );
                }
            },
            Ok(None) => {}
            Err(e) => {
                log::warn!(
                    "Failed to load latest plan for conversation {}: {}",
                    conversation_id,
                    e
                );
            }
        }
    }
}

// ── 私有组装辅助 ──

/// 按角色构建 Plan 模式工具集。
///
/// 顶层 Plan agent（`AgentRole::Main`）额外注册 `task` 子agent 工具，
/// 以便派发只读调研子agent；子agent（`AgentRole::Sub`）是 Plan 只读模式，
/// 不注册 `task`，从而保证「子agent 没有子agent」。运行时 `parent_task_id`
/// 二次防御（`tools/subagent.rs`）仍保留作纵深防御。
///
/// 抽成自由函数便于单测，避免为 `build_registry` 私有方法构造整个 `AppState`。
fn build_plan_registry(
    role: &AgentRole,
    enabled_skills: &[crate::skills::store::Skill],
    experimental_settings: &ExperimentalSettings,
) -> ToolRegistry {
    let mut registry = ToolRegistry::build_for_plan_mode(enabled_skills, experimental_settings);
    if !role.is_subtask() {
        registry.register(Arc::new(TaskTool));
    }
    registry
}

fn build_definitions(registry: &Arc<ToolRegistry>, mode: &AgentMode) -> Vec<ToolDefinition> {
    match mode {
        AgentMode::Plan | AgentMode::Agent | AgentMode::Auto => registry
            .definitions()
            .into_iter()
            .map(|d| ToolDefinition {
                name: d.name,
                description: d.description,
                parameters: d.parameters,
            })
            .collect(),
    }
}

fn apply_section_context_variables(
    s: &str,
    info: Option<&SessionInfo>,
    session_id: &str,
) -> String {
    match info {
        Some(i) => apply_to_string(s, &SessionContext::from_session(i, session_id)),
        None => {
            log::warn!("无法获取会话上下文，systemPromptSection 中的上下文变量替换为空字符串");
            apply_to_string(s, &SessionContext::empty(session_id))
        }
    }
}

async fn collect_plugin_sections(
    registry: &PluginRegistry,
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    mode: &AgentMode,
) -> Vec<String> {
    if matches!(mode, AgentMode::Plan) {
        return Vec::new();
    }
    let session_info = ssh.get_session_info(session_id).await;
    let mut sections = Vec::new();
    for entry in registry.enabled_manifests() {
        if entry.system_prompt_section.is_none() {
            continue;
        }
        let content = match registry.section_for(&entry.id) {
            Some(c) => c.to_string(),
            None => continue,
        };
        let substituted =
            apply_section_context_variables(&content, session_info.as_ref(), session_id);
        let char_count = substituted.chars().count();
        let truncated: String = if char_count > PLUGIN_SECTION_MAX_CHARS {
            log::warn!(
                "插件 {} systemPromptSection 超过 {} 字符（{}），已截断",
                entry.id,
                PLUGIN_SECTION_MAX_CHARS,
                char_count
            );
            substituted.chars().take(PLUGIN_SECTION_MAX_CHARS).collect()
        } else {
            substituted
        };
        sections.push(truncated);
    }
    sections
}

fn build_agent_messages(
    template_manager: &TemplateManager,
    session_id: &str,
    tools: &[ToolDefinition],
    history: &[LlmMessage],
    prompt: &str,
    agent_system_prompt: &str,
    plugin_sections: &[String],
    plan_mode: bool,
    extra_sections: &[String],
) -> Result<Vec<LlmMessage>, AppError> {
    let has_tool = |name: &str| tools.iter().any(|t| t.name == name);
    let has_skills = tools.iter().any(|t| t.name.starts_with("skill_"));
    let system_prompt = build_system_prompt(
        template_manager,
        session_id,
        has_skills,
        has_tool("web_search"),
        has_tool("http_get"),
        agent_system_prompt,
        plugin_sections,
        plan_mode,
        has_tool("task"),
        extra_sections,
    )?;
    let mut messages: Vec<LlmMessage> = Vec::with_capacity(history.len() + 2);
    messages.push(LlmMessage::system(system_prompt));
    for msg in history {
        if msg.role == LlmRole::System {
            continue;
        }
        messages.push(msg.clone());
    }
    if !messages
        .last()
        .map_or(false, |m| m.role == LlmRole::User && m.content == prompt)
    {
        messages.push(LlmMessage::user(prompt.to_string()));
    }
    Ok(messages)
}

/// 统一的任务收尾：更新终态 + 清理取消信号。
/// 停止路径已置 Cancelled 则保留；自然结束=Completed，其余（LLM 失败 /
/// 达最大轮数 / panic）=Failed。
fn finalize_task(state: &AppState, task_id: &str, result: &Option<String>) {
    if let Some(task) = state.agent_tasks.write().get_mut(task_id) {
        if task.status != AgentStatus::Cancelled {
            task.status = if result.is_some() {
                AgentStatus::Completed
            } else {
                AgentStatus::Failed
            };
        }
    }
    state.cancel_senders.write().remove(task_id);
}

fn prune_terminal_tasks(state: &AppState, max_terminal: usize) {
    let mut tasks = state.agent_tasks.write();
    let mut terminal: Vec<(String, chrono::DateTime<chrono::Utc>)> = tasks
        .iter()
        .filter(|(_, task)| {
            matches!(
                task.status,
                AgentStatus::Completed | AgentStatus::Failed | AgentStatus::Cancelled
            )
        })
        .map(|(id, task)| (id.clone(), task.created_at))
        .collect();
    if terminal.len() <= max_terminal {
        return;
    }
    terminal.sort_by_key(|(_, created_at)| *created_at);
    let remove_count = terminal.len() - max_terminal;
    let remove_ids: Vec<String> = terminal
        .into_iter()
        .take(remove_count)
        .map(|(task_id, _)| task_id)
        .collect();
    for task_id in &remove_ids {
        tasks.remove(task_id);
    }
    drop(tasks);
    let mut plans = state.plans.write();
    for task_id in &remove_ids {
        plans.remove(task_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::settings::ExperimentalSettings;

    fn exp() -> ExperimentalSettings {
        ExperimentalSettings::default()
    }

    #[test]
    fn plan_main_agent_gets_task_tool() {
        let registry = build_plan_registry(&AgentRole::Main, &[], &exp());
        assert!(
            registry.get("task").is_some(),
            "顶层 Plan agent 应注册 task 子agent 工具"
        );
    }

    #[test]
    fn plan_sub_agent_does_not_get_task_tool() {
        let registry = build_plan_registry(&AgentRole::Sub {
            parent_task_id: "parent-1".to_string(),
        }, &[], &exp());
        assert!(
            registry.get("task").is_none(),
            "子agent（Plan 只读）不应注册 task 工具，保证子agent 不派发子agent"
        );
    }

    #[test]
    fn plan_registry_keeps_read_only_tools() {
        let registry = build_plan_registry(&AgentRole::Main, &[], &exp());
        assert!(registry.get("read_file").is_some());
        assert!(registry.get("search_files").is_some());
        assert!(registry.get("execute_command").is_some());
        // Plan 模式仍不含写/改工具
        assert!(registry.get("write_file").is_none());
        assert!(registry.get("edit_file").is_none());
    }
}
