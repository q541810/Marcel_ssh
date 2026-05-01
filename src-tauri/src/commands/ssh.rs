use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::ssh::connection::ConnectionConfig;
use crate::AppState;

/// Establish a new SSH connection. Returns the session ID.
///
/// On success, the backend spawns a background task that emits
/// `ssh://output/{session_id}` events with terminal data and
/// `ssh://status/{session_id}` events with connection lifecycle updates.
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<String, AppError> {
    state.ssh_manager.connect(config, app).await
}

/// Disconnect an active SSH session.
#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    state.ssh_manager.disconnect(&session_id).await
}

/// Send input data to an SSH session's shell channel.
#[tauri::command]
pub async fn ssh_send_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    state
        .ssh_manager
        .send_input(&session_id, data.as_bytes())
        .await
}

/// Resize the PTY associated with an SSH session.
#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    state.ssh_manager.resize(&session_id, cols, rows).await
}

/// List currently active SSH session IDs.
#[tauri::command]
pub async fn ssh_list_sessions(
    state: State<'_, AppState>,
) -> Result<Vec<String>, AppError> {
    Ok(state.ssh_manager.list_sessions().await)
}
