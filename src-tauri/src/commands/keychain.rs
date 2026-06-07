use crate::config::keychain;
use crate::error::AppError;

/// Save a password for a connection into the OS keychain.
#[tauri::command]
pub async fn config_save_password(connection_id: String, password: String) -> Result<(), AppError> {
    keychain::save_password(&connection_id, &password)
}

/// Check whether a password has been saved for a connection.
/// Does NOT return the password itself — only a boolean.
/// 安全：不将密码返回给前端，只返回是否已保存。
#[tauri::command]
pub async fn config_has_password(connection_id: String) -> Result<bool, AppError> {
    match keychain::get_password(&connection_id) {
        Ok(Some(_)) => Ok(true),
        Ok(None) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Remove a stored password from the keychain without deleting the connection.
#[tauri::command]
pub async fn config_delete_password(connection_id: String) -> Result<(), AppError> {
    keychain::delete_password(&connection_id)
}

/// Save the LLM API key to the system keychain.
#[tauri::command]
pub async fn config_save_llm_api_key(api_key: String) -> Result<(), AppError> {
    keychain::save_llm_api_key(&api_key)
}

// config_get_llm_api_key 已移除。前端通过 SettingsResponse.has_api_key (bool) 判断是否有 API Key，
// 避免将原始 API Key 返回给 WebView。

/// Remove the LLM API key from the system keychain.
#[tauri::command]
pub async fn config_delete_llm_api_key() -> Result<(), AppError> {
    keychain::delete_llm_api_key()
}
