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
    let formatted_title = format!("[{}] {}", plugin_id, title);

    app.notification()
        .builder()
        .title(&formatted_title)
        .body(&body)
        .show()
        .map_err(|e| AppError::Other(format!("failed to send notification: {}", e)))?;

    Ok(())
}
