use tauri::State;

use crate::agent::conversation::Conversation;
use crate::error::AppError;
use crate::AppState;

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
