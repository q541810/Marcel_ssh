use tauri::State;
use uuid::Uuid;

use crate::config::connections::{ConnectionStore, SavedConnection};
use crate::config::keychain;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::AppState;

/// Check if the given API key looks like a masked placeholder.
/// Front-end may display "sk-******" or similar to indicate "unchanged".
fn is_masked_key(key: &str) -> bool {
    // Common mask patterns — only check explicit mask indicators,
    // never block short real keys (e.g. Ollama local keys like "sk-test123")
    key.contains("******") ||
    key.chars().all(|c| c == '*') ||
    key == "sk-"
}

/// Get all saved connections.
#[tauri::command]
pub async fn config_get_connections(
    state: State<'_, AppState>,
) -> Result<Vec<SavedConnection>, AppError> {
    let store = state.connection_store.read().await;
    Ok(store.get_all().to_vec())
}

/// Save a new or updated connection. Returns the connection ID.
/// Persists the updated store to disk.
#[tauri::command]
pub async fn config_save_connection(
    state: State<'_, AppState>,
    mut connection: SavedConnection,
) -> Result<String, AppError> {
    if connection.id.is_empty() {
        connection.id = Uuid::new_v4().to_string();
    }
    let id = connection.id.clone();

    let mut store = state.connection_store.write().await;
    store.remove(&id);
    store.add(connection);

    // Persist
    let path = ConnectionStore::default_file(&state.config_dir);
    store.save_to_path(&path)?;

    Ok(id)
}

/// Delete a saved connection by ID. Persists the change and removes any
/// stored password from the system keychain.
#[tauri::command]
pub async fn config_delete_connection(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let mut store = state.connection_store.write().await;
    if !store.remove(&id) {
        return Err(AppError::Config(format!("未找到连接: {}", id)));
    }
    let path = ConnectionStore::default_file(&state.config_dir);
    store.save_to_path(&path)?;
    // Best-effort: also purge any stored password from the keychain
    if let Err(e) = keychain::delete_password(&id) {
        log::warn!("清除密钥链条目失败（id={}): {}", id, e);
    }
    Ok(())
}

/// Save a password for a connection into the OS keychain.
#[tauri::command]
pub async fn config_save_password(
    connection_id: String,
    password: String,
) -> Result<(), AppError> {
    keychain::save_password(&connection_id, &password)
}

/// Retrieve a previously stored password for a connection.
/// Returns `None` if no password has been saved.
#[tauri::command]
pub async fn config_get_password(
    connection_id: String,
) -> Result<Option<String>, AppError> {
    keychain::get_password(&connection_id)
}

/// Remove a stored password from the keychain without deleting the connection.
#[tauri::command]
pub async fn config_delete_password(
    connection_id: String,
) -> Result<(), AppError> {
    keychain::delete_password(&connection_id)
}

/// Save the LLM API key to the system keychain.
#[tauri::command]
pub async fn config_save_llm_api_key(
    api_key: String,
) -> Result<(), AppError> {
    keychain::save_llm_api_key(&api_key)
}

/// Retrieve the LLM API key from the system keychain.
/// Returns `None` if no API key has been saved.
#[tauri::command]
pub async fn config_get_llm_api_key() -> Result<Option<String>, AppError> {
    keychain::get_llm_api_key()
}

/// Remove the LLM API key from the system keychain.
#[tauri::command]
pub async fn config_delete_llm_api_key() -> Result<(), AppError> {
    keychain::delete_llm_api_key()
}

/// Get the current application settings.
#[tauri::command]
pub async fn config_get_settings(
    state: State<'_, AppState>,
) -> Result<AppSettings, AppError> {
    let mut settings = state.settings.read().await.clone();
    // 如果 keychain 中有 API Key，填充到返回的设置中
    if let Some(ref mut llm) = settings.llm_config {
        if llm.api_key.is_empty() {
            if let Ok(Some(key)) = keychain::get_llm_api_key() {
                llm.api_key = key;
            }
        }
    }
    Ok(settings)
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
    // If LLM config has changed, update the keychain
    if let Some(ref new_llm) = settings.llm_config {
        if !new_llm.api_key.is_empty() {
            // 前端可能使用遮罩字符串表示未修改，跳过 keychain 更新
            if !is_masked_key(&new_llm.api_key) {
                keychain::save_llm_api_key(&new_llm.api_key)?;
                log::info!("已将 LLM API Key 保存到密钥链");
            } else {
                log::info!("API Key 未修改，跳过密钥链更新");
            }
        } else {
            // API Key is empty — delete from keychain so the user can
            // effectively remove the key by clearing the input field.
            keychain::delete_llm_api_key()?;
            log::info!("已删除 LLM API Key");
        }
    }
    
    let mut current = state.settings.write().await;
    *current = settings;
    let path = AppSettings::default_file(&state.config_dir);
    current.save_to_path(&path)?;
    Ok(())
}
