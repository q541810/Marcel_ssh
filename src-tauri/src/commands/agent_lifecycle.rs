use chrono::Utc;
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

/// Start a new agent task.
///
/// This is the **core** of Marcel SSH's Agent system. It:
///   1. Builds a conversation from history + system prompt
///   2. Calls the LLM (streaming)
///   3. If the LLM returns tool_calls → evaluates policy → executes via the
///      [`ToolRegistry`] → feeds results back → loops until the LLM gives a
///      final text answer
///   4. All progress is pushed as `agent://stream/{taskId}` events
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

    let task = AgentTask {
        id: task_id.clone(),
        session_id: session_id.clone(),
        prompt: prompt.clone(),
        mode: mode.clone(),
        status: AgentStatus::Planning,
        has_plan: false,
        created_at: Utc::now(),
    };
    state.agent_tasks.write().insert(task_id.clone(), task);

    // Snapshot config + skills + MCP servers
    let (llm_config, agent_settings, experimental_settings, enabled_skills, enabled_mcp_servers) = {
        let settings = state.settings.read().await;
        let skills = state.skill_store.read().await;
        let mcp_store = state.mcp_store.read().await;
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

    let Some(llm_config) = llm_config else {
        return Err(AppError::Llm("尚未配置 LLM，请前往设置填写".into()));
    };
    if llm_config.provider_type != ProviderType::OpenAI {
        return Err(AppError::Llm("当前仅支持 OpenAI 兼容 Provider".into()));
    }

    let provider = OpenAiProvider::new(llm_config)?;

    // Build only the registry allowed for this mode/settings. Chat mode gets no registry entries.
    let registry = match mode {
        AgentMode::Chat => Arc::new(ToolRegistry::new()),
        AgentMode::Agent | AgentMode::Auto => {
            let mut registry =
                ToolRegistry::build_mut_for_mode(&enabled_skills, &experimental_settings);
            let mut set = tokio::task::JoinSet::new();
            for server in enabled_mcp_servers {
                let mgr = state.mcp_manager.clone();
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
            Arc::new(registry)
        }
    };

    // Choose which tools to expose based on mode.
    let tools: Vec<ToolDefinition> = match mode {
        AgentMode::Chat => vec![], // No tools in chat mode
        AgentMode::Agent | AgentMode::Auto => registry
            .definitions()
            .into_iter()
            .map(|d| ToolDefinition {
                name: d.name,
                description: d.description,
                parameters: d.parameters,
            })
            .collect(),
    };

    // Build initial messages. Prompt hints are derived from the exact tool set sent to the LLM.
    let has_tool = |name: &str| tools.iter().any(|t| t.name == name);
    let has_skills = tools.iter().any(|t| t.name.starts_with("skill_"));
    let system_prompt = build_system_prompt(
        &session_id,
        has_skills,
        has_tool("web_search"),
        has_tool("http_get"),
        &agent_settings.system_prompt,
    );
    let mut messages: Vec<LlmMessage> = Vec::with_capacity(history.len() + 2);
    messages.push(LlmMessage::system(system_prompt));
    for msg in &history {
        if msg.role == LlmRole::System {
            continue;
        }
        messages.push(msg.clone());
    }
    if !messages
        .last()
        .map_or(false, |m| m.role == LlmRole::User && m.content == prompt)
    {
        messages.push(LlmMessage::user(prompt.clone()));
    }

    // Clone what the spawned task needs
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    state
        .cancel_senders
        .write()
        .insert(task_id.clone(), cancel_tx);

    let loop_ctx = LoopContext {
        ssh: state.ssh_manager.clone(),
        session_id: session_id.clone(),
        app: app.clone(),
        state: state.inner().clone(),
        registry: registry.clone(),
        conversation_id: conversation_id.clone(),
        conv_db: state.conversation_db.clone(),
        cancel_rx,
    };
    let task_id_for_log = task_id.clone();
    let mode_for_log = mode.clone();
    let state_for_cleanup = state.inner().clone();
    let task_id_for_cleanup = task_id_for_log.clone();

    tokio::spawn(async move {
        run_agent_loop(
            task_id,
            provider,
            messages,
            tools,
            mode,
            agent_settings,
            loop_ctx,
        )
        .await;

        // Clean up cancellation sender after the loop finishes
        state_for_cleanup
            .cancel_senders
            .write()
            .remove(&task_id_for_cleanup);
    });

    log::info!(
        "Agent task started: {} ({:?})",
        task_id_for_log,
        mode_for_log
    );
    Ok(task_id_for_log)
}

/// Stop (cancel) a running agent task.
#[tauri::command]
pub async fn agent_stop_task(state: State<'_, AppState>, task_id: String) -> Result<(), AppError> {
    let mut tasks = state.agent_tasks.write();
    match tasks.get_mut(&task_id) {
        Some(task) => {
            task.status = AgentStatus::Cancelled;
            // Send cancellation signal to abort in-progress LLM call
            if let Some(cancel_tx) = state.cancel_senders.write().remove(&task_id) {
                let _ = cancel_tx.send(true);
            }
            Ok(())
        }
        None => Err(AppError::Agent(format!("Task not found: {}", task_id))),
    }
}

/// Approve a pending agent operation.
#[tauri::command]
pub async fn agent_approve_operation(
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    log::info!("Operation approved: task={}, op={}", task_id, operation_id);
    let sender = state
        .pending_approvals
        .write()
        .remove(&(task_id, operation_id));
    if let Some(tx) = sender {
        let _ = tx.send(true);
    }
    Ok(())
}

/// Reject a pending agent operation.
#[tauri::command]
pub async fn agent_reject_operation(
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    log::info!("Operation rejected: task={}, op={}", task_id, operation_id);
    let sender = state
        .pending_approvals
        .write()
        .remove(&(task_id, operation_id));
    if let Some(tx) = sender {
        let _ = tx.send(false);
    }

    Ok(())
}
