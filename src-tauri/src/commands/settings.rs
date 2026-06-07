use serde::Serialize;
use tauri::State;

use crate::config::keychain;
use crate::config::persist::JsonPersistable;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::llm::openai::validate_retry_conditions;
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
/// Front-end displays "sk-******" when a key exists in the keychain but
/// is not sent to the frontend (for security).
fn is_masked_key(key: &str) -> bool {
    key == "sk-******" || key.contains("******") || key.chars().all(|c| c == '*') || key == "sk-"
}

/// Get the current application settings.
#[tauri::command]
pub async fn config_get_settings(state: State<'_, AppState>) -> Result<SettingsResponse, AppError> {
    let settings = state.settings.read().await.clone();
    let has_api_key = keychain::get_llm_api_key().ok().flatten().is_some();
    Ok(SettingsResponse {
        settings,
        has_api_key,
    })
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
    // Validate retry conditions format
    if let Some(ref llm) = settings.llm_config {
        if let Err(err) = validate_retry_conditions(&llm.retry_http_statuses) {
            return Err(AppError::Config(format!("重试条件格式错误: {}", err)));
        }
    }

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

    let snapshot = {
        let mut current = state.settings.write().await;
        // Preserve the in-memory API key when the frontend sends an empty or masked value.
        // The key is not serialized (skip_serializing), so the frontend always sees ""
        // or "sk-******". Overwriting the entire settings object would lose the real key
        // from memory, causing it to be gone on the next restart.
        if let Some(ref new_llm) = settings.llm_config {
            if new_llm.api_key.is_empty() || is_masked_key(&new_llm.api_key) {
                if let Some(ref old_llm) = current.llm_config {
                    let mut final_settings = settings;
                    if let Some(ref mut llm) = final_settings.llm_config {
                        llm.api_key = old_llm.api_key.clone();
                    }
                    *current = final_settings;
                } else {
                    *current = settings;
                }
            } else {
                *current = settings;
            }
        } else {
            *current = settings;
        }
        current.clone()
    };
    // Write lock released — perform disk I/O without blocking readers.
    let path = AppSettings::default_file(&state.config_dir);
    snapshot.save_to_path(&path)?;
    Ok(())
}
