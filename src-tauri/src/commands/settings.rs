use serde::Serialize;
use tauri::State;

use crate::config::keychain;
use crate::config::persist::JsonPersistable;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::llm::openai::{validate_retry_conditions, ModelInfo, OpenAiProvider};
use crate::llm::provider::{LlmConfig, ProviderType};
use crate::AppState;

/// Response type for `config_get_settings`.
/// Separates settings from keychain status to avoid serializing secrets.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    /// Application settings (api_key is excluded from serialization).
    pub settings: AppSettings,
    /// True if a key is currently stored in the keychain.
    pub has_api_key: bool,
    /// True if a web search API key is stored in the keychain.
    #[serde(default)]
    pub has_web_search_api_key: bool,
    /// Non-fatal warning surfaced to the user (e.g. settings.json was backed
    /// up because it could not be deserialised). `None` on a clean load.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}


/// Check if the given API key looks like a masked placeholder.
/// Front-end displays "sk-******" when a key exists in the keychain but
/// is not sent to the frontend (for security).
fn is_masked_key(key: &str) -> bool {
    key == "sk-******" || key.contains("******") || key.chars().all(|c| c == '*') || key == "sk-"
}

/// Get the current application settings.
#[tauri::command]
pub async fn config_get_settings(state: State<'_, AppState>) -> Result<SettingsResponse, AppError> {
    let settings = state.settings.read().await.clone();
    let has_api_key = keychain::get_llm_api_key().ok().flatten().is_some();
    let has_web_search_api_key = keychain::get_web_search_api_key().ok().flatten().is_some();
    // Take the warning so the user only sees it once (after a single load).
    let warning = state.settings_warning.write().take();
    Ok(SettingsResponse {
        settings,
        has_api_key,
        has_web_search_api_key,
        warning,
    })
}

/// Save updated application settings. Persists to disk.
///
/// Note: The LLM API key is stored in the system keychain for security.
/// The in-memory settings keep the key for the current session (the key is
/// excluded from disk serialization via `skip_serializing` in LlmConfig).
#[tauri::command]
pub async fn config_save_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), AppError> {
    // Validate retry settings
    if let Some(ref llm) = settings.llm_config {
        if let Err(err) = validate_retry_conditions(&llm.retry_http_statuses) {
            return Err(AppError::Config(format!("重试条件格式错误: {}", err)));
        }
        if llm.max_retries > 10 {
            return Err(AppError::Config("最大重试次数须为 0-10 的整数".into()));
        }
        if !llm.retry_delay_secs.is_finite()
            || llm.retry_delay_secs < 1.0
            || llm.retry_delay_secs > 60.0
        {
            return Err(AppError::Config("重试间隔须为 1-60 的有限数字".into()));
        }
    }

    // Only update keychain if the frontend explicitly provides a real API key.
    // `LlmConfig.api_key` is excluded from serialization, so an empty or masked
    // value means "leave the key as-is". Use `config_delete_llm_api_key` to
    // explicitly remove the key.
    if let Some(ref new_llm) = settings.llm_config {
        if !new_llm.api_key.is_empty() && !is_masked_key(&new_llm.api_key) {
            keychain::save_llm_api_key(&new_llm.api_key)?;
            log::info!("已将 LLM API Key 保存到密钥链");
        }
    }

    let snapshot = {
        let mut current = state.settings.write().await;
        // Preserve the in-memory API key when the frontend sends an empty or masked value.
        // The key is not serialized (skip_serializing), so the frontend always sees ""
        // or "sk-******". Overwriting the entire settings object would lose the real key
        // from memory, causing it to be gone on the next restart.
        if let Some(ref new_llm) = settings.llm_config {
            if new_llm.api_key.is_empty() || is_masked_key(&new_llm.api_key) {
                if let Some(ref old_llm) = current.llm_config {
                    let mut final_settings = settings;
                    if let Some(ref mut llm) = final_settings.llm_config {
                        llm.api_key = old_llm.api_key.clone();
                    }
                    *current = final_settings;
                } else {
                    *current = settings;
                }
            } else {
                *current = settings;
            }
        } else {
            *current = settings;
        }
        current.clone()
    };
    // Write lock released — perform disk I/O without blocking readers.
    let path = AppSettings::default_file(&state.config_dir);
    tokio::task::block_in_place(|| snapshot.save_to_path(&path))?;

    // 触发跨设备同步：settings 字段级 diff，对变更字段逐个 record_local_change
    if let Some(ref scheduler) = state.sync_scheduler {
        if let Some(ref engine) = state.sync_engine {
            let new_json = serde_json::to_value(&snapshot).unwrap_or(serde_json::Value::Null);
            // 对每个字段路径 diff，变更的 bump 版本
            for field_path in crate::sync::settings_field::all_field_paths() {
                let sync_key = format!("settings.{}", field_path);
                let new_field = crate::sync::settings_field::get_field(&new_json, field_path);
                let new_field_str = new_field
                    .as_ref()
                    .and_then(|v| serde_json::to_string(v).ok())
                    .unwrap_or_default();
                // record_local_change 内部会与 last_synced_values 比对，相同则不 bump
                let _ = engine.record_local_change(&sync_key, &new_field_str);
            }
            scheduler.schedule_push();
        }
    }

    // Settings changes (enable/disable plugin, authorized capabilities) may
    // affect the plugin registry. Reload and emit so the frontend can
    // diff-refresh webviews/injections without a nuke-and-rebuild.
    let config_dir = state.config_dir.clone();
    let diff = {
        let mut reg = state.plugin_registry.write().await;
        reg.reload(&config_dir, &snapshot).await
    };
    use tauri::Emitter;
    let _ = app.emit("plugin-registry-changed", &diff);

    Ok(())
}

/// Validate a candidate list of user-defined protected paths.
/// Returns the first error message, or Ok(()) if all entries are well-formed.
#[tauri::command]
pub async fn config_validate_custom_protected_paths(paths: Vec<String>) -> Result<(), String> {
    for raw in &paths {
        let path = raw.trim();
        if path.is_empty() {
            return Err("路径不能为空".into());
        }
        if !path.starts_with('/') {
            return Err(format!("路径必须以 / 开头：{}", path));
        }
        if path.contains('\0') {
            return Err(format!("路径不能包含 NUL 字节：{}", path));
        }
        if path.split('/').any(|c| c == "..") {
            return Err(format!("路径不能包含 .. 段：{}", path));
        }
    }
    Ok(())
}

/// Fetch the list of available models from the configured OpenAI-compatible
/// provider. The frontend passes the current draft `baseUrl` / `apiKey` so the
/// request reflects what the user sees, not what was last persisted. When the
/// API key is empty or masked (the frontend never receives the real key back),
/// we fall back to the keychain — this covers the common case where the key was
/// already saved and the user is just re-opening settings.
#[tauri::command]
pub async fn llm_list_models(
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, AppError> {
    let resolved_key = match api_key {
        Some(k) if !k.is_empty() && !is_masked_key(&k) => k,
        _ => match keychain::get_llm_api_key()? {
            Some(k) => k,
            None => {
                return Err(AppError::Llm(
                    "未配置 API Key，请先在设置中输入 API Key".into(),
                ))
            }
        },
    };

    // Minimal config: model/temperature/retry fields are unused by list_models,
    // but LlmConfig requires them. Empty/zero values are harmless here.
    let config = LlmConfig {
        provider_type: ProviderType::OpenAI,
        api_key: resolved_key,
        model: String::new(),
        base_url: base_url.filter(|s| !s.is_empty()),
        temperature: 0.0,
        max_retries: 0,
        retry_delay_secs: 0.0,
        retry_http_statuses: String::new(),
        vision: false,
    };

    let provider = OpenAiProvider::new(config)?;
    provider.list_models().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::runtime::Runtime;

    fn validate(paths: Vec<String>) -> Result<(), String> {
        Runtime::new()
            .unwrap()
            .block_on(config_validate_custom_protected_paths(paths))
    }

    #[test]
    fn rejects_empty_path() {
        assert!(validate(vec!["/etc".into(), "".into()]).is_err());
    }

    #[test]
    fn rejects_relative_path() {
        assert!(validate(vec!["etc".into()]).is_err());
        assert!(validate(vec!["./etc".into()]).is_err());
    }

    #[test]
    fn rejects_nul_byte() {
        assert!(validate(vec!["/etc\0".into()]).is_err());
    }

    #[test]
    fn rejects_dotdot_component() {
        assert!(validate(vec!["/etc/../shadow".into()]).is_err());
        assert!(validate(vec!["/etc/foo/..".into()]).is_err());
    }

    #[test]
    fn accepts_valid_paths() {
        assert!(validate(vec!["/etc".into(), "/home/user/.ssh".into()]).is_ok());
        assert!(validate(vec!["/var/log".into()]).is_ok());
    }

    #[test]
    fn accepts_empty_list() {
        assert!(validate(vec![]).is_ok());
    }
}
