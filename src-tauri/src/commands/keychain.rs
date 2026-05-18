use crate::config::keychain;
use crate::error::AppError;

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
