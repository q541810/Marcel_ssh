use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::agent::agent_loop::run_agent_loop;
use crate::agent::conversation::Conversation;
use crate::agent::runtime::{AgentMode, AgentStatus, AgentTask};
use crate::agent::sandbox::{assess_risk, RiskLevel, Sandbox};
use crate::agent::system_prompt::build_system_prompt;
use crate::agent::tools::ToolRegistry;
use crate::config::settings::CommandListMode;
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ProviderType, ToolDefinition};
use crate::AppState;

// ──────────────────────── Tauri Commands ────────────────────────

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
    let (llm_config, agent_settings, _sandbox, skill_prompts) = {
        let settings = state.settings.read().await;
        let skills = state.skill_store.read().await;
        (
            settings.llm_config.clone(),
            settings.agent_mode_settings.clone(),
            Sandbox::default(),
            skills.enabled_prompts(),
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
    let system_prompt = build_system_prompt(&session_id, &skill_prompts);
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

    // Build the registry once and reuse it for both tool advertisement
    // and dispatch. This keeps definitions and execution in sync.
    let registry = std::sync::Arc::new(ToolRegistry::with_builtins());

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
    let ssh = state.ssh_manager.clone_inner();
    let task_id_spawn = task_id.clone();
    let mode_spawn = mode.clone();
    let app_spawn = app.clone();
    let state_spawn = state.inner().clone();
    let registry_spawn = registry.clone();
    let conversation_id_spawn = conversation_id.clone();
    let conv_db_spawn = state.conversation_db.clone();

    tokio::spawn(async move {
        run_agent_loop(
            task_id_spawn,
            provider,
            messages,
            tools,
            mode_spawn,
            agent_settings,
            ssh,
            session_id,
            app_spawn,
            state_spawn,
            registry_spawn,
            conversation_id_spawn,
            conv_db_spawn,
        )
        .await;
    });

    log::info!("Agent task started: {} ({:?})", task_id, mode);
    Ok(task_id)
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

/// Create a new AI conversation for the given SSH session.
#[tauri::command]
pub async fn agent_create_conversation(
    state: State<'_, AppState>,
    session_id: String,
    title: Option<String>,
) -> Result<String, AppError> {
    let connection_id = state
        .ssh_manager
        .get_connection_id(&session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    let title = title.unwrap_or_else(|| "新会话".to_string());
    let conversation = state
        .conversation_db
        .create_conversation(&connection_id, &title)
        .map_err(|e| AppError::Agent(format!("Failed to create conversation: {}", e)))?;
    log::info!("Created conversation: {} (connection={})", conversation.id, connection_id);
    Ok(conversation.id)
}

/// List all conversations for a given SSH session.
#[tauri::command]
pub async fn agent_list_conversations(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Conversation>, AppError> {
    let connection_id = state
        .ssh_manager
        .get_connection_id(&session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    let conversations = state
        .conversation_db
        .list_conversations(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to list conversations: {}", e)))?;
    Ok(conversations)
}

/// Load all messages for a conversation.
#[tauri::command]
pub async fn agent_load_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<crate::agent::conversation::StoredMessage>, AppError> {
    let messages = state
        .conversation_db
        .load_messages(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to load messages: {}", e)))?;
    Ok(messages)
}

/// Delete a single conversation.
#[tauri::command]
pub async fn agent_delete_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), AppError> {
    state
        .conversation_db
        .delete_conversation(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to delete conversation: {}", e)))?;
    log::info!("Deleted conversation: {}", conversation_id);
    Ok(())
}

/// List all conversations for a given connection config ID (persistent, works without active session).
#[tauri::command]
pub async fn agent_list_conversations_by_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<Conversation>, AppError> {
    let conversations = state
        .conversation_db
        .list_conversations(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to list conversations: {}", e)))?;
    Ok(conversations)
}

/// Delete all conversations for a given SSH session.
#[tauri::command]
pub async fn agent_delete_conversations_by_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    let connection_id = state
        .ssh_manager
        .get_connection_id(&session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    state
        .conversation_db
        .delete_conversations_by_connection(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to delete conversations by session: {}", e)))?;
    log::info!("Deleted all conversations for session: {} (connection={})", session_id, connection_id);
    Ok(())
}

/// Result of evaluating a command against the current AGENT-mode policy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCheckResult {
    pub allowed: bool,
    pub requires_confirmation: bool,
    pub risk_level: RiskLevel,
    pub reason: String,
}

/// Evaluate a command against the current agent-mode settings.
#[tauri::command]
pub async fn agent_check_command(
    state: State<'_, AppState>,
    command: String,
    mode: AgentMode,
) -> Result<CommandCheckResult, AppError> {
    let trimmed = command.trim();
    let risk = assess_risk(trimmed);

    match mode {
        AgentMode::Chat => Ok(CommandCheckResult {
            allowed: false,
            requires_confirmation: false,
            risk_level: risk,
            reason: "CHAT 模式不执行任何命令".into(),
        }),
        AgentMode::Auto => Ok(CommandCheckResult {
            allowed: true,
            requires_confirmation: false,
            risk_level: risk,
            reason: "AUTO 模式自动同意所有命令".into(),
        }),
        AgentMode::Agent => {
            let settings = state.settings.read().await;
            let policy = &settings.agent_mode_settings;
            let base = trimmed
                .split_whitespace()
                .next()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("");
            let in_list = policy.command_list.iter().any(|c| c == base);

            match policy.list_mode {
                CommandListMode::Allowlist => {
                    if in_list {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: policy.confirm_each_command,
                            risk_level: risk,
                            reason: format!("'{}' 在白名单中", base),
                        })
                    } else {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: true,
                            risk_level: risk,
                            reason: format!("'{}' 不在白名单中，需要用户确认", base),
                        })
                    }
                }
                CommandListMode::Denylist => {
                    if in_list {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: true,
                            risk_level: risk,
                            reason: format!("'{}' 在黑名单中，需要用户确认", base),
                        })
                    } else {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: policy.confirm_each_command,
                            risk_level: risk,
                            reason: format!("'{}' 不在黑名单中", base),
                        })
                    }
                }
            }
        }
    }
}
