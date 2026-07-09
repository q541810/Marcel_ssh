use serde::Serialize;
use tauri::State;

use crate::agent::conversation::Conversation;
use crate::agent::task::AgentTaskPlan;
use crate::error::AppError;
use crate::AppState;

/// 持久化的 plan（已反序列化），用于返回给前端。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPlan {
    pub task_id: String,
    pub plan: AgentTaskPlan,
    pub updated_at: String,
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
    log::info!(
        "Created conversation: {} (connection={})",
        conversation.id,
        connection_id
    );
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

/// Delete a message and all messages after it from a conversation.
#[tauri::command]
pub async fn agent_truncate_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    from_timestamp: String,
) -> Result<usize, AppError> {
    let deleted = state
        .conversation_db
        .delete_messages_from_timestamp(&conversation_id, &from_timestamp)
        .map_err(|e| AppError::Agent(format!("Failed to truncate conversation: {}", e)))?;
    log::info!(
        "Truncated conversation: {} from {} (deleted={})",
        conversation_id,
        from_timestamp,
        deleted
    );
    Ok(deleted)
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
        .map_err(|e| {
            AppError::Agent(format!("Failed to delete conversations by session: {}", e))
        })?;
    log::info!(
        "Deleted all conversations for session: {} (connection={})",
        session_id,
        connection_id
    );
    Ok(())
}

/// 加载某对话下所有持久化的 plan（按 updated_at 倒序），已反序列化为 AgentTaskPlan。
/// 前端在 switchConversation/loadConversation 时调用，把结果写入 useTaskStore.plans，
/// 使重启后仍能恢复 plan 列表展示。
///
/// **降级处理**：重启后 agent 没在跑，plan 里的 in_progress item 对用户而言是
/// "未完成"而非"进行中"。这里在返回前把 in_progress → pending，使前端 data
/// 和 UI 一致，避免 spinning 图标误导。后端 state.plans 不受影响。
#[tauri::command]
pub async fn agent_load_plans_by_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<StoredPlan>, AppError> {
    let rows = state
        .conversation_db
        .load_plans_by_conversation(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to load plans: {}", e)))?;

    let mut plans = Vec::with_capacity(rows.len());
    for (task_id, plan_json, updated_at) in rows {
        match serde_json::from_str::<AgentTaskPlan>(&plan_json) {
            Ok(mut plan) => {
                // 迁移旧格式 id：item-N → N（1-based 纯数字）。
                // 旧版 create_plan 生成 "item-0" 格式，新版生成 "1" 格式。
                // 这里在 load 时统一转成新格式，并 reflow next_item_seq 避免
                // 后续 edit_plan add 生成冲突 id。
                let needs_migrate = plan
                    .items
                    .iter()
                    .any(|it| it.id.starts_with("item-"));
                if needs_migrate {
                    for it in &mut plan.items {
                        if let Some(num) = it.id.strip_prefix("item-") {
                            // 旧格式 item-N 是 0-based，转成 1-based（item-0 → 1）
                            if let Ok(n) = num.parse::<usize>() {
                                it.id = (n + 1).to_string();
                            }
                        }
                    }
                    // reflow next_item_seq：取当前最大数字 id + 1
                    let max_id = plan
                        .items
                        .iter()
                        .filter_map(|it| it.id.parse::<usize>().ok())
                        .max()
                        .unwrap_or(0);
                    plan.next_item_seq = max_id + 1;
                    log::info!(
                        "Migrated plan ids for task {} in conversation {}: next_item_seq={}",
                        task_id,
                        conversation_id,
                        plan.next_item_seq
                    );
                }
                // agent 没跑时降级 in_progress → pending（见 plan_handler 文档）
                let is_running =
                    crate::agent::plan_handler::is_task_running_for_load(&state, &task_id);
                let normalized =
                    crate::agent::plan_handler::normalize_plan_for_frontend(&plan, is_running);
                plans.push(StoredPlan {
                    task_id,
                    plan: normalized,
                    updated_at,
                });
            }
            Err(e) => log::warn!(
                "Failed to deserialize plan for task {} in conversation {}: {}",
                task_id,
                conversation_id,
                e
            ),
        }
    }
    Ok(plans)
}
