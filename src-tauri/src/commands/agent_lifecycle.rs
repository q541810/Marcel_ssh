use std::collections::HashMap;
use std::sync::Arc;

use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::agent::agent_loop::{run_agent_loop, LoopContext};
use crate::agent::system_prompt::build_system_prompt;
use crate::agent::task::{AgentMode, AgentStatus, AgentTask};
use crate::agent::tools::{mcp::register_mcp_tools, plugin_tool::register_plugin_tools, ToolRegistry};
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ProviderType, ToolDefinition};
use crate::plugins::context::{apply_to_string, SessionContext};
use crate::plugins::manifest::PluginManifest;
use crate::plugins::registry::PluginRegistry;
use crate::ssh::connection::SessionInfo;
use crate::AppState;
use crate::mcp::manager::McpManager;
use crate::mcp::store::McpServerConfig;

/// Maximum length (in chars) of a single plugin-contributed system-prompt
/// section. Sections exceeding this are truncated and a warning is logged.
const PLUGIN_SECTION_MAX_CHARS: usize = 2000;

// ── helpers ──

async fn build_registry(
    mode: &AgentMode,
    enabled_skills: &[crate::skills::store::Skill],
    enabled_mcp_servers: &[McpServerConfig],
    mcp_manager: Arc<McpManager>,
    experimental_settings: &crate::config::settings::ExperimentalSettings,
    plugin_registry: &PluginRegistry,
) -> (Arc<ToolRegistry>, Vec<PluginManifest>) {
    match mode {
        AgentMode::Plan => {
            let registry =
                ToolRegistry::build_for_plan_mode(enabled_skills, experimental_settings);
            (Arc::new(registry), Vec::new())
        }
        AgentMode::Agent | AgentMode::Auto => {
            let mut registry =
                ToolRegistry::build_mut_for_mode(enabled_skills, experimental_settings);

            let manifests = plugin_registry.enabled_manifests();
            for m in &manifests {
                register_plugin_tools(&mut registry, &m.id, &m.capabilities, &m.agent_tools);
            }

            let mut set = tokio::task::JoinSet::new();
            for server in enabled_mcp_servers {
                let mgr = mcp_manager.clone();
                let server = server.clone();
                set.spawn(async move {
                    let result = mgr.refresh_tools(&server).await;
                    (server, result)
                });
            }
            while let Some(result) = set.join_next().await {
                match result {
                    Ok((server, Ok(tools))) => register_mcp_tools(&mut registry, &server, tools),
                    Ok((server, Err(err))) => {
                        log::warn!("刷新 MCP tools 失败 [{}]: {}", server.name, err)
                    }
                    Err(join_err) => log::warn!("MCP 刷新任务 panic: {}", join_err),
                }
            }
            (Arc::new(registry), manifests)
        }
    }
}

/// Replace all 7 context variables in `s` using the given session info.
/// Missing session info (None) yields empty-string substitutions.
fn apply_section_context_variables(s: &str, info: Option<&SessionInfo>, session_id: &str) -> String {
    match info {
        Some(i) => apply_to_string(s, &SessionContext::from_session(i, session_id)),
        None => {
            log::warn!("无法获取会话上下文，systemPromptSection 中的上下文变量替换为空字符串");
            apply_to_string(s, &SessionContext::empty(session_id))
        }
    }
}

/// Collect plugin-contributed system-prompt sections from enabled plugins.
///
    /// - **Plan mode**: returns an empty vec (no plugin sections injected).
/// - **Agent/Auto mode**: for each manifest with a `systemPromptSection`:
///   1. Look up the cached section content from the `PluginRegistry`
///      (mtime-invalidated, single source of truth). Skip if absent.
///   2. Substitute the 7 context variables (`{{__host__}}` etc.).
///   3. Truncate to `PLUGIN_SECTION_MAX_CHARS` chars; warn if truncated.
async fn collect_plugin_sections(
    registry: &PluginRegistry,
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    mode: &AgentMode,
) -> Vec<String> {
    // Plan mode: never inject plugin sections (plugin tools are not registered).
    if matches!(mode, AgentMode::Plan) {
        return Vec::new();
    }

    // Fetch session info once for context-variable substitution.
    let session_info = ssh.get_session_info(session_id).await;

    let mut sections = Vec::new();
    for entry in registry.enabled_manifests() {
        // Only enabled plugins with a declared section contribute. The
        // registry caches the (mtime, content) pair so no filesystem I/O
        // happens here even on repeated agent task launches.
        if entry.system_prompt_section.is_none() {
            continue;
        }
        let content = match registry.section_for(&entry.id) {
            Some(c) => c.to_string(),
            None => continue, // declared but file missing/unreadable — already warned at reload
        };

        let substituted = apply_section_context_variables(&content, session_info.as_ref(), session_id);

        // Enforce per-section length limit (char count, not bytes).
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

fn build_agent_messages(
    session_id: &str,
    tools: &[ToolDefinition],
    history: &[LlmMessage],
    prompt: &str,
    agent_system_prompt: &str,
    plugin_sections: &[String],
    plan_mode: bool,
) -> Vec<LlmMessage> {
    let has_tool = |name: &str| tools.iter().any(|t| t.name == name);
    let has_skills = tools.iter().any(|t| t.name.starts_with("skill_"));
    let system_prompt = build_system_prompt(
        session_id,
        has_skills,
        has_tool("web_search"),
        has_tool("http_get"),
        agent_system_prompt,
        plugin_sections,
        plan_mode,
    );
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
    messages
}

fn spawn_agent_task(
    state: &AppState,
    app: &AppHandle,
    task_id: &str,
    session_id: &str,
    conversation_id: &str,
    mode: &AgentMode,
    provider: OpenAiProvider,
    messages: Vec<LlmMessage>,
    tools: Vec<ToolDefinition>,
    agent_settings: crate::config::settings::AgentModeSettings,
    registry: Arc<ToolRegistry>,
) {
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    state
        .cancel_senders
        .write()
        .insert(task_id.to_string(), cancel_tx);

    let loop_ctx = LoopContext {
        ssh: state.ssh_manager.clone(),
        session_id: session_id.to_string(),
        app: app.clone(),
        state: state.clone(),
        registry,
        conversation_id: conversation_id.to_string(),
        conv_db: state.conversation_db.clone(),
        cancel_rx,
        config_dir: state.config_dir.clone(),
    };

    let state_for_cleanup = state.clone();
    let task_id_for_cleanup = task_id.to_string();
    let task_id_owned = task_id.to_string();
    let mode_owned = mode.clone();
    let task_id_log = task_id.to_string();
    let mode_log = mode.clone();

    tokio::spawn(async move {
        run_agent_loop(
            task_id_owned,
            provider,
            messages,
            tools,
            mode_owned,
            agent_settings,
            loop_ctx,
        )
        .await;

        state_for_cleanup
            .cancel_senders
            .write()
            .remove(&task_id_for_cleanup);
    });

    log::info!("Agent task started: {} ({:?})", task_id_log, mode_log);
}

fn send_approval(
    state: &AppState,
    task_id: &str,
    operation_id: &str,
    approved: bool,
) {
    let label = if approved { "approved" } else { "rejected" };
    log::info!("Operation {}: task={}, op={}", label, task_id, operation_id);
    let sender = state
        .pending_approvals
        .write()
        .remove(&(task_id.to_string(), operation_id.to_string()));
    if let Some(tx) = sender {
        let _ = tx.send(approved);
    }
}

// ── commands ──

#[tauri::command]
pub async fn agent_start_task(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    prompt: String,
    mode: AgentMode,
    history: Vec<LlmMessage>,
    conversation_id: String,
) -> Result<String, AppError> {
    let task_id = Uuid::new_v4().to_string();

    state.agent_tasks.write().insert(task_id.clone(), AgentTask {
        id: task_id.clone(),
        session_id: session_id.clone(),
        prompt: prompt.clone(),
        mode: mode.clone(),
        status: AgentStatus::Planning,
        has_plan: false,
        created_at: chrono::Utc::now(),
    });

    let (llm_config, agent_settings, experimental_settings, enabled_skills, enabled_mcp_servers) = {
        let settings = state.settings.read().await;
        let skills = state.skill_store.read().await;
        let mcp_store = state.mcp_store.read().await;
        (
            settings.llm_config.clone(),
            settings.agent_mode_settings.clone(),
            settings.experimental_settings.clone(),
            skills.list().iter().filter(|s| s.enabled).cloned().collect::<Vec<_>>(),
            mcp_store.list().iter().filter(|s| s.enabled).cloned().collect::<Vec<_>>(),
        )
    };

    let Some(llm_config) = llm_config else {
        return Err(AppError::Llm("尚未配置 LLM，请前往设置填写".into()));
    };
    if llm_config.provider_type != ProviderType::OpenAI {
        return Err(AppError::Llm("当前仅支持 OpenAI 兼容 Provider".into()));
    }
    let provider = OpenAiProvider::new(llm_config)?;

let plugin_registry_guard = state.plugin_registry.read().await;
    let (tool_registry, _manifests) = build_registry(&mode, &enabled_skills, &enabled_mcp_servers, state.mcp_manager.clone(), &experimental_settings, &plugin_registry_guard).await;
    let tools = build_definitions(&tool_registry, &mode);
    let plugin_sections = collect_plugin_sections(&plugin_registry_guard, &state.ssh_manager, &session_id, &mode).await;
    drop(plugin_registry_guard); // release before agent loop runs (no longer needed)
    let messages = build_agent_messages(&session_id, &tools, &history, &prompt, &agent_settings.system_prompt, &plugin_sections, matches!(mode, AgentMode::Plan));

    spawn_agent_task(
        &state, &app, &task_id, &session_id, &conversation_id, &mode,
        provider, messages, tools, agent_settings, tool_registry,
    );

    Ok(task_id)
}

#[tauri::command]
pub async fn agent_stop_task(state: State<'_, AppState>, task_id: String) -> Result<(), AppError> {
    let mut tasks = state.agent_tasks.write();
    match tasks.get_mut(&task_id) {
        Some(task) => {
            task.status = AgentStatus::Cancelled;
            if let Some(cancel_tx) = state.cancel_senders.write().remove(&task_id) {
                let _ = cancel_tx.send(true);
            }
            Ok(())
        }
        None => Err(AppError::Agent(format!("Task not found: {}", task_id))),
    }
}

#[tauri::command]
pub async fn agent_approve_operation(
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    send_approval(&state, &task_id, &operation_id, true);
    Ok(())
}

#[tauri::command]
pub async fn agent_reject_operation(
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    send_approval(&state, &task_id, &operation_id, false);
    Ok(())
}

fn send_question_answer(
    state: &AppState,
    task_id: &str,
    question_id: &str,
    answers: Vec<serde_json::Value>,
) {
    log::info!(
        "Question answered: task={}, question={}, answers={}",
        task_id,
        question_id,
        answers.len()
    );
    let sender = state
        .pending_questions
        .write()
        .remove(&(task_id.to_string(), question_id.to_string()));
    if let Some(tx) = sender {
        let _ = tx.send(answers);
    }
}

#[tauri::command]
pub async fn agent_answer_question(
    state: State<'_, AppState>,
    task_id: String,
    question_id: String,
    answers: Vec<serde_json::Value>,
) -> Result<(), AppError> {
    send_question_answer(&state, &task_id, &question_id, answers);
    Ok(())
}
