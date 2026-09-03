use base64::Engine;
use tauri::State;

use crate::config::persist::JsonPersistable;
use crate::error::AppError;
use crate::skills::parser::{process_md, process_zip, ParsedSkill};
use crate::skills::store::{Skill, SkillStore};
use crate::AppState;

#[tauri::command]
pub async fn import_skill_file(
    _state: State<'_, AppState>,
    file_data: String,
    file_name: String,
) -> Result<ParsedSkill, AppError> {
    let lower = file_name.to_lowercase();

    // .md file: base64-encoded text content → parse frontmatter directly
    if lower.ends_with(".md") {
        let content = String::from_utf8(
            base64::engine::general_purpose::STANDARD
                .decode(&file_data)
                .map_err(|e| AppError::Config(format!("base64 解码失败: {}", e)))?,
        )
        .map_err(|e| AppError::Config(format!("不是有效的 UTF-8: {}", e)))?;
        return process_md(&content, &file_name).map_err(AppError::Config);
    }

    // .zip / .skill: unzip → find .md → parse frontmatter
    if lower.ends_with(".zip") || lower.ends_with(".skill") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&file_data)
            .map_err(|e| AppError::Config(format!("base64 解码失败: {}", e)))?;
        return process_zip(&bytes).map_err(AppError::Config);
    }

    Err(AppError::Config("仅支持 .md / .zip / .skill 文件".into()))
}

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
    if name.trim().is_empty() {
        return Err(AppError::Config("Skill 名称不能为空".into()));
    }
    if prompt.trim().is_empty() {
        return Err(AppError::Config("Skill 提示词不能为空".into()));
    }
    let path = SkillStore::default_file(&state.config_dir);
    let mut store = state.skill_store.write().await;
    let mut candidate = store.clone();
    let mut skill = Skill::new(name, description, prompt);
    // 新 skill 追加到用户排序列表末尾
    skill.position = candidate.next_position();
    let cloned = skill.clone();
    candidate.add(skill);
    candidate.save_to_path(&path)?;
    *store = candidate;
    drop(store);

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
    if crate::skills::builtin::is_builtin_skill_id(&id) {
        return Err(AppError::Config(
            "内置 Skill 不可编辑，只能启用或禁用".into(),
        ));
    }
    if let Some(ref n) = name {
        if n.trim().is_empty() {
            return Err(AppError::Config("skill name cannot be empty".into()));
        }
    }
    if let Some(ref p) = prompt {
        if p.trim().is_empty() {
            return Err(AppError::Config("skill prompt cannot be empty".into()));
        }
    }
    let path = SkillStore::default_file(&state.config_dir);
    {
        let mut store = state.skill_store.write().await;
        let mut candidate = store.clone();
        if !candidate.update(&id, name, description, prompt) {
            return Err(AppError::Config(format!("skill not found: {}", id)));
        }
        candidate.save_to_path(&path)?;
        *store = candidate;
    }

    Ok(())
}

#[tauri::command]
pub async fn skill_toggle(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let path = SkillStore::default_file(&state.config_dir);
    {
        let mut store = state.skill_store.write().await;
        let mut candidate = store.clone();
        if !candidate.toggle(&id) {
            return Err(AppError::Config(format!("skill not found: {}", id)));
        }
        candidate.save_to_path(&path)?;
        *store = candidate;
    }

    Ok(())
}

#[tauri::command]
pub async fn skill_delete(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    if crate::skills::builtin::is_builtin_skill_id(&id) {
        return Err(AppError::Config(
            "内置 Skill 不可删除，可在列表中禁用".into(),
        ));
    }
    let path = SkillStore::default_file(&state.config_dir);
    let mut store = state.skill_store.write().await;
    let mut candidate = store.clone();
    if !candidate.delete(&id) {
        return Err(AppError::Config(format!("skill not found: {}", id)));
    }
    candidate.save_to_path(&path)?;
    *store = candidate;
    drop(store);

    Ok(())
}

/// 用户 skill 手动排序（拖拽 / 上移下移）。ids 为完整的用户 skill id 顺序，
/// 内置 skill 不参与排序（前端置顶展示，后端拒绝）。
#[tauri::command]
pub async fn skill_reorder(state: State<'_, AppState>, ids: Vec<String>) -> Result<(), AppError> {
    if ids
        .iter()
        .any(|id| crate::skills::builtin::is_builtin_skill_id(id))
    {
        return Err(AppError::Config("内置 Skill 不参与手动排序".into()));
    }
    let path = SkillStore::default_file(&state.config_dir);
    {
        let mut store = state.skill_store.write().await;
        let mut candidate = store.clone();
        let changed = candidate.apply_user_order(&ids);
        if !changed.is_empty() {
            candidate.save_to_path(&path)?;
            *store = candidate;
        }
    }

    Ok(())
}
