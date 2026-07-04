use std::collections::HashMap;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::plugins::capability::as_hash_map;
use crate::plugins::manifest::PluginManifest;
use crate::plugins::registry::ReloadDiff;
use crate::AppState;

#[tauri::command]
pub async fn plugin_list(state: State<'_, AppState>) -> Result<Vec<PluginManifest>, AppError> {
    let reg = state.plugin_registry.read().await;
    Ok(reg.all_manifests())
}

/// Expose the command→capability map to the frontend so `pluginIpc.ts` can
/// build its `COMMAND_TO_CAPABILITY` table from a single source of truth
/// instead of hand-maintaining a parallel copy.
#[tauri::command]
pub async fn plugin_capability_map() -> Result<HashMap<String, String>, AppError> {
    Ok(as_hash_map())
}

/// Trigger a plugin registry reload (e.g. after the user enables/disables a
/// plugin or changes authorized capabilities). Emits `plugin-registry-changed`
/// with the diff so the frontend can refresh webviews/instructions incrementally
/// instead of nuke-and-rebuild.
#[tauri::command]
pub async fn plugin_reload(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ReloadDiff, AppError> {
    let config_dir = state.config_dir.clone();
    let settings = state.settings.read().await.clone();
    let diff = {
        let mut reg = state.plugin_registry.write().await;
        reg.reload(&config_dir, &settings).await
    };
    let _ = app.emit("plugin-registry-changed", &diff);
    Ok(diff)
}

#[tauri::command]
pub async fn get_plugin_dir(state: State<'_, AppState>) -> Result<String, AppError> {
    let plugins_dir = state.config_dir.join("plugins");
    Ok(plugins_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn open_plugin_dir(state: State<'_, AppState>) -> Result<(), AppError> {
    let plugins_dir = state.config_dir.join("plugins");
    if !plugins_dir.exists() {
        std::fs::create_dir_all(&plugins_dir)
            .map_err(|e| AppError::Other(format!("创建插件目录失败: {}", e)))?;
    }
    open_path(&plugins_dir)
}

fn open_path(path: &Path) -> Result<(), AppError> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| AppError::Other(format!("打开目录失败: {}", e)))?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| AppError::Other(format!("打开目录失败: {}", e)))?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| AppError::Other(format!("打开目录失败: {}", e)))?;
    }
    Ok(())
}
