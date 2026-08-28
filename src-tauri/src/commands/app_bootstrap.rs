use serde::Serialize;
use tauri::State;

use crate::commands::sync::SyncSummary;
use crate::config::connections::SavedConnection;
use crate::config::keychain;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::skills::store::Skill;
use crate::sync::profile::{Platform, SyncProfile};
use crate::sync::scheduler::SyncState;
use crate::AppState;

/// 聚合启动快照数据包：在前端启动首帧一次性下发，消除多路 IPC 往返瀑布流。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppBootstrapData {
    /// 应用全局设置（LLM api_key 已按安全规则排除序列化）
    pub settings: AppSettings,
    /// 密钥链中是否已存储 LLM API Key
    pub has_api_key: bool,
    /// 密钥链中是否已存储 Web Search API Key
    pub has_web_search_api_key: bool,
    /// 设置加载时的非致命告警（如旧配置损坏备份）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings_warning: Option<String>,
    /// 保存的 SSH 连接列表
    pub connections: Vec<SavedConnection>,
    /// 用户与内置 Skill 列表
    pub skills: Vec<Skill>,
    /// 跨设备同步状态摘要
    pub sync_summary: SyncSummary,
}

/// 获取聚合启动快照。
#[tauri::command]
pub async fn app_get_bootstrap(state: State<'_, AppState>) -> Result<AppBootstrapData, AppError> {
    let settings = state.settings.read().await.clone();
    let has_api_key = settings
        .llm_config
        .as_ref()
        .map_or(false, |c| !c.api_key.is_empty())
        || keychain::get_llm_api_key().ok().flatten().is_some();
    let has_web_search_api_key = keychain::get_web_search_api_key().ok().flatten().is_some();
    let settings_warning = state.settings_warning.write().take();

    let connections = state.connection_store.read().await.get_all().to_vec();
    let skills = state.skill_store.read().await.list().to_vec();

    // 组装同步摘要
    let server_url = crate::sync::keychain::get_server_url()?;
    let device_id = crate::sync::keychain::get_device_id()?;
    let sync_api_key = crate::sync::keychain::get_device_api_key()?;
    let configured = server_url.is_some() && device_id.is_some() && sync_api_key.is_some();

    let profile = state
        .sync_engine
        .as_ref()
        .map(|e| e.profile())
        .unwrap_or_else(SyncProfile::default);

    let (sync_state, last_error, progress) = match state.sync_scheduler.as_ref() {
        Some(scheduler) => (
            scheduler.state(),
            scheduler.last_error(),
            scheduler.last_progress(),
        ),
        None => (SyncState::NotConfigured, None, None),
    };

    let pending_count = state
        .sync_engine
        .as_ref()
        .map(|e| e.pending_count())
        .unwrap_or(0);

    let sync_summary = SyncSummary {
        configured,
        server_url,
        device_id,
        platform: Platform::current().as_str().to_string(),
        profile,
        state: sync_state,
        error: last_error,
        progress,
        pending_count,
    };

    Ok(AppBootstrapData {
        settings,
        has_api_key,
        has_web_search_api_key,
        settings_warning,
        connections,
        skills,
        sync_summary,
    })
}
