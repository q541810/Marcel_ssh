use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

use crate::error::AppError;

#[tauri::command]
pub async fn plugin_send_notification(
    app: AppHandle,
    plugin_id: String,
    title: String,
    body: String,
) -> Result<(), AppError> {
    plugin_send_notification_inner(&app, &plugin_id, &title, &body)
}

/// Shared inner implementation — called by both the Tauri command (event IPC
/// channel) and the HTTP API dispatcher. Ensures both channels produce
/// identical notification behaviour.
pub(crate) fn plugin_send_notification_inner<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_id: &str,
    title: &str,
    body: &str,
) -> Result<(), AppError> {
    let formatted_title = format!("[{}] {}", plugin_id, title);
    app.notification()
        .builder()
        .title(&formatted_title)
        .body(body)
        .show()
        .map_err(|e| AppError::Other(format!("failed to send notification: {}", e)))?;
    Ok(())
}