use tauri::State;
use uuid::Uuid;

use crate::config::connections::{ConnectionStore, SavedConnection};
use crate::config::keychain;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::AppState;

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

/// Get the current application settings.
#[tauri::command]
pub async fn config_get_settings(
    state: State<'_, AppState>,
) -> Result<AppSettings, AppError> {
    let settings = state.settings.read().await;
    Ok(settings.clone())
}

/// Save updated application settings. Persists to disk.
#[tauri::command]
pub async fn config_save_settings(
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), AppError> {
    let mut current = state.settings.write().await;
    *current = settings;
    let path = AppSettings::default_file(&state.config_dir);
    current.save_to_path(&path)?;
    Ok(())
}
