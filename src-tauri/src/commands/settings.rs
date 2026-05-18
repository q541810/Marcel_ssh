use serde::Serialize;
use tauri::State;

use crate::config::keychain;
use crate::config::persist::JsonPersistable;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::AppState;

/// Response type for `config_get_settings`.
/// Separates settings from keychain status to avoid serializing secrets.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    /// Application settings (api_key is excluded from serialization).
    pub settings: AppSettings,
    /// True if a key is currently stored in the keychain.
    pub has_api_key: bool,
}

/// Check if the given API key looks like a masked placeholder.
/// Front-end may display "sk-******" or similar to indicate "unchanged".
fn is_masked_key(key: &str) -> bool {
    // Common mask patterns — only check explicit mask indicators,
    // never block short real keys (e.g. Ollama local keys like "sk-test123")
    key.contains("******") ||
    key.chars().all(|c| c == '*') ||
    key == "sk-"
}

/// Get the current application settings.
#[tauri::command]
pub async fn config_get_settings(
    state: State<'_, AppState>,
) -> Result<SettingsResponse, AppError> {
    let settings = state.settings.read().await.clone();
    let has_api_key = keychain::get_llm_api_key().ok().flatten().is_some();
    Ok(SettingsResponse { settings, has_api_key })
}

/// Save updated application settings. Persists to disk.
/// 
/// Note: The LLM API key is stored in the system keychain for security.
/// The in-memory settings keep the key for the current session (the key is
/// excluded from disk serialization via `skip_serializing` in LlmConfig).
#[tauri::command]
pub async fn config_save_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), AppError> {
    // Only update keychain if the frontend explicitly provides a real API key.
    // `LlmConfig.api_key` is excluded from serialization, so an empty or masked
    // value means "leave the key as-is". Use `config_delete_llm_api_key` to
    // explicitly remove the key.
    if let Some(ref new_llm) = settings.llm_config {
        if !new_llm.api_key.is_empty() && !is_masked_key(&new_llm.api_key) {
            keychain::save_llm_api_key(&new_llm.api_key)?;
            log::info!("已将 LLM API Key 保存到密钥链");
        }
    }
    
    let mut current = state.settings.write().await;
    *current = settings;
    let path = AppSettings::default_file(&state.config_dir);
    current.save_to_path(&path)?;
    Ok(())
}
