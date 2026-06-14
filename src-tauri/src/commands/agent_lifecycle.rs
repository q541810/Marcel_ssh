use std::sync::Arc;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::agent::agent_loop::{run_agent_loop, LoopContext};
use crate::agent::system_prompt::build_system_prompt;
use crate::agent::task::{AgentMode, AgentStatus, AgentTask};
use crate::agent::tools::{mcp::register_mcp_tools, ToolRegistry};
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ProviderType, ToolDefinition};
use crate::AppState;
use crate::mcp::manager::McpManager;
use crate::mcp::store::McpServerConfig;

// ── helpers ──

async fn build_registry(
    mode: &AgentMode,
    enabled_skills: &[crate::skills::store::Skill],
    enabled_mcp_servers: &[McpServerConfig],
    mcp_manager: Arc<McpManager>,
    experimental_settings: &crate::config::settings::ExperimentalSettings,
) -> Arc<ToolRegistry> {
    let AgentMode::Chat = mode else {
        let mut registry =
            ToolRegistry::build_mut_for_mode(enabled_skills, experimental_settings);
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
        return Arc::new(registry);
    };
    Arc::new(ToolRegistry::new())
}

fn build_definitions(registry: &Arc<ToolRegistry>, mode: &AgentMode) -> Vec<ToolDefinition> {
    match mode {
        AgentMode::Chat => vec![],
        AgentMode::Agent | AgentMode::Auto => registry
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
) -> Vec<LlmMessage> {
    let has_tool = |name: &str| tools.iter().any(|t| t.name == name);
    let has_skills = tools.iter().any(|t| t.name.starts_with("skill_"));
    let system_prompt = build_system_prompt(
        session_id,
        has_skills,
        has_tool("web_search"),
        has_tool("http_get"),
        agent_system_prompt,
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

    let registry = build_registry(&mode, &enabled_skills, &enabled_mcp_servers, state.mcp_manager.clone(), &experimental_settings).await;
    let tools = build_definitions(&registry, &mode);
    let messages = build_agent_messages(&session_id, &tools, &history, &prompt, &agent_settings.system_prompt);

    spawn_agent_task(
        &state, &app, &task_id, &session_id, &conversation_id, &mode,
        provider, messages, tools, agent_settings, registry,
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
