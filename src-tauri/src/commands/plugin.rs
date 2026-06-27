use std::path::Path;
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
