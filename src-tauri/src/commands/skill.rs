use std::io::Read;

use base64::Engine;
use tauri::State;
use zip::ZipArchive;

use crate::error::AppError;
use crate::skills::store::{Skill, SkillStore};
use crate::AppState;

/// Result of parsing a skill file package.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedSkill {
    pub name: String,
    pub description: String,
    pub prompt: String,
}

fn parse_yaml_frontmatter(content: &str) -> Result<ParsedSkill, String> {
    let content = content.trim();

    // Strip UTF-8 BOM if present
    let content = content.strip_prefix('\u{feff}').unwrap_or(content);

    if !content.starts_with("---") {
        return Err("SKILL.md must start with --- YAML frontmatter delimiter".into());
    }

    let rest = &content[3..];
    let end = rest
        .find("---")
        .ok_or("Missing closing --- after YAML frontmatter")?;

    let yaml_block = &rest[..end].trim();
    let markdown_body = rest[end + 3..].trim();

    // Parse YAML
    let data: serde_yaml::Value = serde_yaml::from_str(yaml_block)
        .map_err(|e| format!("YAML 解析失败: {}", e))?;

    let name = data
        .get("name")
        .and_then(|v| v.as_str())
        .ok_or("YAML frontmatter 缺少 name 字段")?
        .trim()
        .to_string();

    if name.is_empty() {
        return Err("name 字段不能为空".into());
    }

    let description = data
        .get("description")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .unwrap_or_default();

    // The rest of the markdown body becomes the prompt
    let prompt = if markdown_body.is_empty() {
        return Err("SKILL.md frontmatter 后缺少 prompt 内容".into());
    } else {
        markdown_body.to_string()
    };

    Ok(ParsedSkill {
        name,
        description,
        prompt,
    })
}

/// Parse a single .md file directly.
fn process_md(content: &str, file_name: &str) -> Result<ParsedSkill, String> {
    let skill_name = file_name.trim_end_matches(".md").trim_end_matches(".MD");
    parse_yaml_frontmatter(content).map(|mut p| {
        if p.name.is_empty() {
            p.name = skill_name.to_string();
        }
        p
    })
}

/// Unzip and find the .md file inside.
fn process_zip(data: &[u8]) -> Result<ParsedSkill, String> {
    let reader = std::io::Cursor::new(data);
    let mut archive = ZipArchive::new(reader).map_err(|e| format!("zip 解析失败: {}", e))?;

    // Collect all .md files at any nesting level
    let md_files: Vec<(String, Vec<u8>)> = {
        let mut files = Vec::new();
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).map_err(|e| format!("读取 zip 内文件失败: {}", e))?;
            let name = file.name().to_string();
            // Skip directories and hidden files
            if name.ends_with('/') || name.starts_with('.') || name.contains("/.") {
                continue;
            }
            if name.to_lowercase().ends_with(".md") {
                let mut buf = Vec::new();
                file.read_to_end(&mut buf).map_err(|e| format!("读取 zip 内文件失败: {}", e))?;
                files.push((name, buf));
            }
        }
        files
    };

    if md_files.is_empty() {
        return Err("压缩包内未找到 .md 文件".into());
    }

    if md_files.len() > 1 {
        let names: Vec<_> = md_files.iter().map(|(n, _)| n.clone()).collect();
        return Err(format!(
            "压缩包内包含 {} 个 .md 文件，请只保留一个：{}",
            md_files.len(),
            names.join(", ")
        ));
    }

    let (name, bytes) = md_files.into_iter().next().unwrap();
    let content = String::from_utf8(bytes)
        .map_err(|e| format!("{} 不是有效的 UTF-8 文本: {}", name, e))?;

    process_md(&content, &name)
}

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

    Err(AppError::Config(
        "仅支持 .md / .zip / .skill 文件".into(),
    ))
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
        return Err(AppError::Config("skill name cannot be empty".into()));
    }
    if prompt.trim().is_empty() {
        return Err(AppError::Config("skill prompt cannot be empty".into()));
    }
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
