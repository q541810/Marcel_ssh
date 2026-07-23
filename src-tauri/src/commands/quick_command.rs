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
    let id = Uuid::new_v4().to_string();
    let created = store.add(id.clone(), command)?;
    let path = QuickCommandStore::default_file(&state.config_dir);
    store.save_to_path(&path)?;

    // 触发跨设备同步：quickCommands 变更
    if let Some(ref scheduler) = state.sync_scheduler {
        if let Some(ref engine) = state.sync_engine {
            let _ = engine.record_local_change(
                &format!("quickCommands.{}", created.id),
                &serde_json::to_string(&created).unwrap_or_default(),
            );
            scheduler.schedule_push();
        }
    }

    Ok(created)
}

#[tauri::command]
pub async fn quick_command_update(
    state: State<'_, AppState>,
    id: String,
    patch: QuickCommandPatch,
) -> Result<(), AppError> {
    let updated = {
        let mut store = state.quick_command_store.write().await;
        store.update(&id, patch)?;
        let updated = store
            .commands
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| AppError::Config(format!("未找到快捷指令: {}", id)))?;
        let path = QuickCommandStore::default_file(&state.config_dir);
        store.save_to_path(&path)?;
        updated
    };

    // 触发跨设备同步：quickCommands 变更
    if let Some(ref scheduler) = state.sync_scheduler {
        if let Some(ref engine) = state.sync_engine {
            let _ = engine.record_local_change(
                &format!("quickCommands.{}", id),
                &serde_json::to_string(&updated).unwrap_or_default(),
            );
            scheduler.schedule_push();
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn quick_command_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let mut store = state.quick_command_store.write().await;
    if !store.remove(&id) {
        return Err(AppError::Config(format!("未找到快捷指令: {}", id)));
    }
    let path = QuickCommandStore::default_file(&state.config_dir);
    store.save_to_path(&path)?;
    drop(store);

    // 触发跨设备同步：quickCommands 删除
    if let Some(ref scheduler) = state.sync_scheduler {
        if let Some(ref engine) = state.sync_engine {
            let _ = engine.record_local_delete(&format!("quickCommands.{}", id));
            scheduler.schedule_push();
        }
    }

    Ok(())
}
