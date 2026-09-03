use serde::Serialize;
use tauri::State;

use crate::config::connections::SavedConnection;
use crate::config::keychain;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::skills::store::Skill;
use crate::AppState;

/// 聚合启动快照数据包：在前端启动首帧一次性下发，消除多路 IPC 往返瀑布流。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBootstrapData {
    /// 应用全局设置（LLM api_key 已按安全规则排除序列化）
    pub settings: AppSettings,
    /// 密钥链中是否已存储 LLM API Key（多渠道下 = 任一渠道有 key）
    pub has_api_key: bool,
    /// 密钥链中是否已存储 Web Search API Key
    pub has_web_search_api_key: bool,
    /// 各渠道密钥是否存在（多渠道模型服务）
    #[serde(default)]
    pub channel_key_status: Vec<crate::commands::settings::ChannelKeyStatus>,
    /// 设置加载时的非致命告警（如旧配置损坏备份）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_warning: Option<String>,
    /// 保存的 SSH 连接列表
    pub connections: Vec<SavedConnection>,
    /// 用户与内置 Skill 列表
    pub skills: Vec<Skill>,
}

/// 获取聚合启动快照。
#[tauri::command]
pub async fn app_get_bootstrap(state: State<'_, AppState>) -> Result<AppBootstrapData, AppError> {
    let settings = state.settings.read().await.clone();
    let has_api_key = settings.llm_registry.channels.iter().any(|c| !c.api_key.is_empty())
        || settings
            .llm_registry
            .channels
            .iter()
            .any(|c| keychain::get_llm_channel_key(&c.id).ok().flatten().is_some())
        || keychain::get_llm_api_key().ok().flatten().is_some();
    let has_web_search_api_key = keychain::get_web_search_api_key().ok().flatten().is_some();
    let channel_key_status = crate::commands::settings::compute_channel_key_status(&settings);
    let settings_warning = state.settings_warning.write().take();

    let connections = state.connection_store.read().await.get_all().to_vec();
    let skills = state.skill_store.read().await.list().to_vec();

    Ok(AppBootstrapData {
        settings,
        has_api_key,
        has_web_search_api_key,
        channel_key_status,
        settings_warning,
        connections,
        skills,
    })
}
