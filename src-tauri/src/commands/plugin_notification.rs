use tauri::AppHandle;
// Windows 桌面走 notification::show_toast（带点击激活钩子），用不到插件 builder 扩展
#[cfg(not(windows))]
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
    // Windows 与 Agent 通知同一条带激活钩子的路径（点击弹窗回到应用）；
    // 发送失败在 show_toast 内部记 warn 日志，不向上报——插件通知本就是尽力而为
    #[cfg(windows)]
    crate::notification::show_toast(app, &formatted_title, body);
    #[cfg(not(windows))]
    app.notification()
        .builder()
        .title(&formatted_title)
        .body(body)
        .show()
        .map_err(|e| AppError::Other(format!("failed to send notification: {}", e)))?;
    Ok(())
}
