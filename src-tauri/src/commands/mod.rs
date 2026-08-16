pub mod agent_compact;
pub mod agent_conversation;
pub mod agent_lifecycle;
pub mod agent_policy;
pub mod connections;
pub mod keychain;
pub mod market;
pub mod mcp;
pub mod plugin;
pub mod plugin_api;
pub mod plugin_fs;
pub mod plugin_http;
pub mod plugin_install;
pub mod plugin_menu;
pub mod plugin_notification;
pub mod plugin_uri;
pub mod plugin_webview;
pub mod plugin_window;
pub mod quick_command;
pub mod settings;
pub mod sftp;
pub mod skill;
pub mod ssh;
pub mod sync;
pub mod update;

#[cfg(desktop)]
use tauri::Manager;

#[tauri::command]
pub async fn app_ready(app: tauri::AppHandle) -> Result<(), String> {
    // Desktop: the main window starts hidden (visible: false) and is revealed
    // once the frontend signals readiness, avoiding a white flash.
    #[cfg(desktop)]
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    // Mobile: the activity is always visible; nothing to do.
    #[cfg(mobile)]
    let _ = app;
    Ok(())
}

/// 移动端同步 App 前后台状态，供 Agent 系统通知决定是否发送。
/// 桌面端 no-op。
#[tauri::command]
pub fn mobile_set_app_foreground(in_foreground: bool) {
    #[cfg(mobile)]
    crate::notification::set_app_in_foreground(in_foreground);
    #[cfg(desktop)]
    let _ = in_foreground;
}
