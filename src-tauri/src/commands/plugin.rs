use tauri::State;

use crate::error::AppError;
use crate::plugins::manifest::PluginManifest;
use crate::plugins::scan::scan_plugins;
use crate::AppState;

#[tauri::command]
pub async fn plugin_list(state: State<'_, AppState>) -> Result<Vec<PluginManifest>, AppError> {
    let config_dir = state.config_dir.clone();
    tokio::task::spawn_blocking(move || scan_plugins(&config_dir))
        .await
        .map_err(|e| AppError::Other(format!("plugin scan failed: {}", e)))
}
