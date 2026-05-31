pub mod agent_conversation;
pub mod agent_lifecycle;
pub mod agent_policy;
pub mod connections;
pub mod keychain;
pub mod quick_command;
pub mod settings;
pub mod sftp;
pub mod skill;
pub mod ssh;
pub mod update;

use tauri::Manager;

#[tauri::command]
pub async fn app_ready(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}
