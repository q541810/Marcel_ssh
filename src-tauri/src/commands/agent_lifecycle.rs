use chrono::Utc;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::agent::agent_loop::{run_agent_loop, LoopContext};
use crate::agent::task::{AgentMode, AgentStatus, AgentTask};
use crate::agent::sandbox::Sandbox;
use crate::agent::system_prompt::build_system_prompt;
use crate::agent::tools::ToolRegistry;
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

    // Snapshot config + skills
    let (llm_config, agent_settings, experimental_settings, _sandbox, enabled_skills) = {
        let settings = state.settings.read().await;
        let skills = state.skill_store.read().await;
        (
            settings.llm_config.clone(),
            settings.agent_mode_settings.clone(),
            settings.experimental_settings.clone(),
            Sandbox::default(),
            skills.list().iter().filter(|s| s.enabled).cloned().collect::<Vec<_>>(),
        )
    };

    let Some(llm_config) = llm_config else {
        return Err(AppError::Llm("尚未配置 LLM，请前往设置填写".into()));
    };
    if llm_config.provider_type != ProviderType::OpenAI {
        return Err(AppError::Llm("当前仅支持 OpenAI 兼容 Provider".into()));
    }

    let provider = OpenAiProvider::new(llm_config)?;

    // Build initial messages
    let system_prompt = build_system_prompt(&session_id, !enabled_skills.is_empty());
    let mut messages: Vec<LlmMessage> = Vec::with_capacity(history.len() + 2);
    messages.push(LlmMessage::system(system_prompt));
    for msg in &history {
        if msg.role == LlmRole::System {
            continue;
        }
        messages.push(msg.clone());
    }
    if !messages.last().map_or(false, |m| m.role == LlmRole::User && m.content == prompt) {
        messages.push(LlmMessage::user(prompt.clone()));
    }

    // Build the registry: start with built-ins, then register enabled skills
    // as tools (progressive disclosure), then conditionally add experimental tools.
    let mut registry = ToolRegistry::with_builtins();
    registry.register_skills(&enabled_skills);
    if experimental_settings.enable_cloud_page {
        registry.register(std::sync::Arc::new(
            crate::agent::tools::open_cloud_page::OpenCloudPageTool::new(),
        ));
    }
    let registry = std::sync::Arc::new(registry);

    // Choose which tools to expose based on mode
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

    // Clone what the spawned task needs
    let loop_ctx = LoopContext {
        ssh: state.ssh_manager.clone(),
        session_id: session_id.clone(),
        app: app.clone(),
        state: state.inner().clone(),
        registry: registry.clone(),
        conversation_id: conversation_id.clone(),
        conv_db: state.conversation_db.clone(),
    };
    let task_id_for_log = task_id.clone();
    let mode_for_log = mode.clone();

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
    });

    log::info!("Agent task started: {} ({:?})", task_id_for_log, mode_for_log);
    Ok(task_id_for_log)
}

/// Stop (cancel) a running agent task.
#[tauri::command]
pub async fn agent_stop_task(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), AppError> {
    let mut tasks = state.agent_tasks.write();
    match tasks.get_mut(&task_id) {
        Some(task) => {
            task.status = AgentStatus::Cancelled;
            Ok(())
        }
        None => Err(AppError::Agent(format!("Task not found: {}", task_id))),
    }
}

/// Approve a pending agent operation.
#[tauri::command]
pub async fn agent_approve_operation(
    state: State<'_, AppState>,
    _task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    log::info!("Operation approved: op={}", operation_id);
    let sender = state.pending_approvals.write().remove(&operation_id);
    if let Some(tx) = sender {
        let _ = tx.send(true);
    }
    Ok(())
}

/// Reject a pending agent operation.
#[tauri::command]
pub async fn agent_reject_operation(
    state: State<'_, AppState>,
    _task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    log::info!("Operation rejected: op={}", operation_id);
    let sender = state.pending_approvals.write().remove(&operation_id);
    if let Some(tx) = sender {
        let _ = tx.send(false);
    }

    Ok(())
}
