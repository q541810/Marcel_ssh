use serde::Serialize;
use tauri::State;

use crate::config::keychain;
use crate::config::persist::JsonPersistable;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::llm::manager::LlmManager;
use crate::llm::openai::ModelInfo;
use crate::llm::registry::migrate_legacy_settings;
use crate::llm::provider::LlmConfig;
use crate::AppState;

/// 单个渠道的密钥链状态（仅布尔，绝不回传密钥本身）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelKeyStatus {
    pub channel_id: String,
    pub has_key: bool,
}

/// Response type for `config_get_settings`.
/// Separates settings from keychain status to avoid serializing secrets.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    /// Application settings (api keys are excluded from serialization).
    pub settings: AppSettings,
    /// True if the legacy single API key is still stored in the keychain.
    /// 兼容旧字段：新版本以 `channelKeyStatus` 为准。
    #[serde(default)]
    pub has_api_key: bool,
    /// True if a web search API key is stored in the keychain.
    #[serde(default)]
    pub has_web_search_api_key: bool,
    /// 每个渠道的密钥是否存在（多渠道模型服务）。
    #[serde(default)]
    pub channel_key_status: Vec<ChannelKeyStatus>,
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

/// 计算每个渠道的密钥状态（内存优先，缺失时读 keychain）。
pub fn compute_channel_key_status(settings: &AppSettings) -> Vec<ChannelKeyStatus> {
    settings
        .llm_registry
        .channels
        .iter()
        .map(|c| {
            let has_key = !c.api_key.is_empty()
                || keychain::get_llm_channel_key(&c.id)
                    .ok()
                    .flatten()
                    .is_some();
            ChannelKeyStatus {
                channel_id: c.id.clone(),
                has_key,
            }
        })
        .collect()
}

/// Get the current application settings.
#[tauri::command]
pub async fn config_get_settings(state: State<'_, AppState>) -> Result<SettingsResponse, AppError> {
    let settings = state.settings.read().await.clone();
    let has_api_key = keychain::get_llm_api_key().ok().flatten().is_some();
    let has_web_search_api_key = keychain::get_web_search_api_key().ok().flatten().is_some();
    let channel_key_status = compute_channel_key_status(&settings);
    // Take the warning so the user only sees it once (after a single load).
    let warning = state.settings_warning.write().take();
    Ok(SettingsResponse {
        settings,
        has_api_key,
        has_web_search_api_key,
        channel_key_status,
        warning,
    })
}

/// Save updated application settings. Persists to disk.
///
/// 多渠道模型服务：
/// - 各渠道 API Key 独立存入系统密钥链（account = `llm_channel_{id}`），
///   `ChannelConfig.api_key` 不落盘（`skip_serializing`）；
/// - 前端回传掩码/空值时保留旧内存 key；
/// - 被删除渠道的密钥从 keychain 清理，避免孤儿条目。
#[tauri::command]
pub async fn config_save_settings(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    settings: AppSettings,
) -> Result<(), AppError> {
    // 兜底迁移（理论上前端不会再带旧字段，防御旧端/历史数据）
    let mut candidate = settings;
    migrate_legacy_settings(&mut candidate);

    // 自愈兜底：去重同 id 重复模型（历史「保存渠道」合并 bug 可能仍让前端
    // 内存里带重复条目；先去重再校验，避免合法保存被重复数据拦住）
    if candidate.llm_registry.dedupe_duplicate_models() {
        log::warn!("保存设置前检测到重复模型记录（同 id），已自动去重");
    }

    // 自愈兜底：归一化思考强度档位（trim + 丢空 + 去重）。旧数据可能携带
    // 首尾空格档位，会令任务注入（原始值全等比较）匹配失败而被静默忽略；
    // 归一后再校验，使「展示、持久化、注入」三处语义一致。
    if candidate.llm_registry.normalize_reasoning_efforts() {
        log::warn!("保存设置前检测到思考强度档位含空格/重复/空项，已自动归一化");
    }

    // 校验多渠道配置（含渠道重试参数、引用完整性与模型 ID 唯一性）
    candidate.llm_registry.validate()?;

    // 密钥链写入：每个渠道独立。掩码/空值 = 保留旧 key（不写）。
    {
        let store = state.settings.read().await;
        for channel in &mut candidate.llm_registry.channels {
            if !channel.api_key.is_empty() && !is_masked_key(&channel.api_key) {
                keychain::save_llm_channel_key(&channel.id, &channel.api_key)?;
                log::info!("已将渠道 [{}] 的 API Key 保存到密钥链", channel.name);
            } else if channel.api_key.is_empty() || is_masked_key(&channel.api_key) {
                // 保留内存旧 key（若存在）；api_key 不落盘，掩码值只在内存停留
                if let Some(old) = store
                    .llm_registry
                    .channels
                    .iter()
                    .find(|c| c.id == channel.id)
                {
                    if !old.api_key.is_empty() {
                        channel.api_key = old.api_key.clone();
                    }
                }
            }
        }
        // 清理被删除渠道的密钥链条目
        for old in &store.llm_registry.channels {
            if !candidate
                .llm_registry
                .channels
                .iter()
                .any(|c| c.id == old.id)
            {
                let _ = keychain::delete_llm_channel_key(&old.id);
            }
        }
    }

    // 先持久化候选快照，成功后才提交内存；写盘失败保持旧状态。
    let path = AppSettings::default_file(&state.config_dir);
    tokio::task::block_in_place(|| candidate.save_to_path(&path))?;
    let mut store = state.settings.write().await;
    *store = candidate.clone();
    let snapshot = candidate;
    drop(store);

    // Settings changes (enable/disable plugin, authorized capabilities) may
    // affect the plugin registry. Reload and emit so the frontend can
    // diff-refresh webviews/injections without a nuke-and-rebuild.
    let config_dir = state.config_dir.clone();
    let app_version = app.package_info().version.to_string();
    let diff = {
        let mut reg = state.plugin_registry.write().await;
        reg.reload(&config_dir, &snapshot, &app_version).await
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
/// provider. The frontend passes the current draft `channelId` / `baseUrl` /
/// `apiKey` so the request reflects what the user sees, not what was last
/// persisted. When the API key is empty or masked (the frontend never receives
/// the real key back), we fall back to that channel's keychain entry — this
/// covers the common case where the key was already saved and the user is just
/// re-opening settings.
///
/// Base URL 必填：空/空白直接拒绝（不回落 OpenAI 默认端点，避免连错服务）。
#[tauri::command]
pub async fn llm_list_models(
    channel_id: Option<String>,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<ModelInfo>, AppError> {
    let base_url = base_url.map(|s| s.trim().to_string()).unwrap_or_default();
    if base_url.is_empty() {
        return Err(AppError::Config(
            "请先填写 Base URL 再获取模型列表（空 URL 无法确定接入哪个服务）".into(),
        ));
    }
    if !(base_url.starts_with("http://") || base_url.starts_with("https://")) {
        return Err(AppError::Config(
            "Base URL 须以 http:// 或 https:// 开头".into(),
        ));
    }

    let resolved_key = match api_key {
        Some(k) if !k.is_empty() && !is_masked_key(&k) => k,
        _ => match channel_id
            .as_deref()
            .and_then(|id| keychain::get_llm_channel_key(id).ok().flatten())
        {
            Some(k) => k,
            None => match keychain::get_llm_api_key()? {
                Some(k) => k,
                None => {
                    return Err(AppError::Llm(
                        "未配置 API Key，请先在设置中输入 API Key".into(),
                    ))
                }
            },
        },
    };

    // Minimal config: model/temperature/retry fields are unused by list_models,
    // but LlmConfig requires them. Empty/zero values are harmless here.
    let config = LlmConfig {
        provider_type: crate::llm::provider::ProviderType::OpenAI,
        api_key: resolved_key,
        model: String::new(),
        base_url: Some(base_url),
        temperature: 0.0,
        max_retries: 0,
        retry_delay_secs: 0.0,
        retry_http_statuses: String::new(),
        first_byte_timeout_secs: 60,
        retry_on_timeout: true,
        vision: false,
        extra_body: None,
    };

    let llm_manager = LlmManager::new(config)?;
    llm_manager.list_models().await
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
