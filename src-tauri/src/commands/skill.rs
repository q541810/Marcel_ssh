use tauri::State;

use crate::error::AppError;
use crate::skills::store::{Skill, SkillStore};
use crate::AppState;

#[tauri::command]
pub async fn skill_list(state: State<'_, AppState>) -> Result<Vec<Skill>, AppError> {
    let store = state.skill_store.read().await;
    Ok(store.list().to_vec())
}

#[tauri::command]
pub async fn skill_add(
    state: State<'_, AppState>,
    name: String,
    description: String,
    prompt: String,
) -> Result<Skill, AppError> {
    let skill = Skill::new(name, description, prompt);
    let cloned = skill.clone();
    let path = SkillStore::default_file(&state.config_dir);
    let mut store = state.skill_store.write().await;
    store.add(skill);
    store.save_to_path(&path)?;
    Ok(cloned)
}

#[tauri::command]
pub async fn skill_update(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
    description: Option<String>,
    prompt: Option<String>,
) -> Result<(), AppError> {
    let path = SkillStore::default_file(&state.config_dir);
    let mut store = state.skill_store.write().await;
    if !store.update(&id, name, description, prompt) {
        return Err(AppError::Config(format!("skill not found: {}", id)));
    }
    store.save_to_path(&path)?;
    Ok(())
}

#[tauri::command]
pub async fn skill_toggle(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let path = SkillStore::default_file(&state.config_dir);
    let mut store = state.skill_store.write().await;
    if !store.toggle(&id) {
        return Err(AppError::Config(format!("skill not found: {}", id)));
    }
    store.save_to_path(&path)?;
    Ok(())
}

#[tauri::command]
pub async fn skill_delete(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), AppError> {
    let path = SkillStore::default_file(&state.config_dir);
    let mut store = state.skill_store.write().await;
    if !store.delete(&id) {
        return Err(AppError::Config(format!("skill not found: {}", id)));
    }
    store.save_to_path(&path)?;
    Ok(())
}
