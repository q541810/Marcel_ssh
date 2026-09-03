use tauri::State;
use uuid::Uuid;

use crate::config::connections::{ConnectionStore, SavedConnection};
use crate::config::keychain;
use crate::config::persist::JsonPersistable;
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
    let mut candidate = store.clone();
    candidate.remove(&id);
    candidate.add(connection);

    // 先持久化候选快照，成功后再提交内存。
    let path = ConnectionStore::default_file(&state.config_dir);
    tokio::task::block_in_place(|| candidate.save_to_path(&path))?;
    *store = candidate;

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
    let mut candidate = store.clone();
    if !candidate.remove(&id) {
        return Err(AppError::Config(format!("未找到连接: {}", id)));
    }
    let path = ConnectionStore::default_file(&state.config_dir);
    tokio::task::block_in_place(|| candidate.save_to_path(&path))?;
    *store = candidate;

    // Best-effort: also purge any stored password and passphrase from the keychain
    if let Err(e) = keychain::delete_password(&id) {
        log::warn!("清除密钥链条目失败（id={}): {}", id, e);
    }
    if let Err(e) = keychain::delete_password(&format!("pk:{}", id)) {
        log::warn!("清除密钥链 passphrase 条目失败（id={}): {}", id, e);
    }
    if let Err(e) = keychain::delete_password(&format!("jump:{}", id)) {
        log::warn!("清除跳板机密码密钥链条目失败（id={}): {}", id, e);
    }
    if let Err(e) = keychain::delete_password(&format!("jump:pk:{}", id)) {
        log::warn!("清除跳板机 passphrase 密钥链条目失败（id={}): {}", id, e);
    }
    Ok(())
}
