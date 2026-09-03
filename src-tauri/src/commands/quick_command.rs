use tauri::State;
use uuid::Uuid;

use crate::config::persist::JsonPersistable;
use crate::config::quick_commands::{
    QuickCommand, QuickCommandInput, QuickCommandPatch, QuickCommandStore,
};
use crate::error::AppError;
use crate::AppState;

#[tauri::command]
pub async fn quick_command_list(
    state: State<'_, AppState>,
    session_key: Option<String>,
) -> Result<Vec<QuickCommand>, AppError> {
    let store = state.quick_command_store.read().await;
    Ok(store.list_for_session(session_key.as_deref()))
}

#[tauri::command]
pub async fn quick_command_add(
    state: State<'_, AppState>,
    command: QuickCommandInput,
) -> Result<QuickCommand, AppError> {
    let mut store = state.quick_command_store.write().await;
    let mut candidate = store.clone();
    let id = Uuid::new_v4().to_string();
    let created = candidate.add(id.clone(), command)?;
    let path = QuickCommandStore::default_file(&state.config_dir);
    candidate.save_to_path(&path)?;
    *store = candidate;

    Ok(created)
}

#[tauri::command]
pub async fn quick_command_update(
    state: State<'_, AppState>,
    id: String,
    patch: QuickCommandPatch,
) -> Result<(), AppError> {
    let path = QuickCommandStore::default_file(&state.config_dir);
    {
        let mut store = state.quick_command_store.write().await;
        let mut candidate = store.clone();
        candidate.update(&id, patch)?;
        candidate.save_to_path(&path)?;
        *store = candidate;
    }

    Ok(())
}

#[tauri::command]
pub async fn quick_command_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let mut store = state.quick_command_store.write().await;
    let mut candidate = store.clone();
    if !candidate.remove(&id) {
        return Err(AppError::Config(format!("未找到快捷指令: {}", id)));
    }
    let path = QuickCommandStore::default_file(&state.config_dir);
    candidate.save_to_path(&path)?;
    *store = candidate;

    Ok(())
}
