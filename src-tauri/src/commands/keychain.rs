use crate::config::keychain::{self, SecretSlot};
use crate::error::AppError;

/// Save a password for a connection into the OS keychain.
#[tauri::command]
pub async fn config_save_password(connection_id: String, password: String) -> Result<(), AppError> {
    keychain::set(&SecretSlot::SshPassword(connection_id), &password)
}

/// Check whether a password has been saved for a connection.
/// Does NOT return the password itself — only a boolean.
/// 安全：不将密码返回给前端，只返回是否已保存。
#[tauri::command]
pub async fn config_has_password(connection_id: String) -> Result<bool, AppError> {
    keychain::has(&SecretSlot::SshPassword(connection_id))
}

/// Remove a stored password from the keychain without deleting the connection.
#[tauri::command]
pub async fn config_delete_password(connection_id: String) -> Result<(), AppError> {
    keychain::delete(&SecretSlot::SshPassword(connection_id))
}

/// Save a private-key passphrase for a connection into the OS keychain.
/// 存储 account 为 "pk:{connection_id}"，与主密码条目分开。
#[tauri::command]
pub async fn config_save_passphrase(
    connection_id: String,
    passphrase: String,
) -> Result<(), AppError> {
    keychain::set(&SecretSlot::SshKeyPassphrase(connection_id), &passphrase)
}

/// Check whether a private-key passphrase has been saved for a connection.
/// 安全：不将 passphrase 返回给前端，只返回是否已保存。
#[tauri::command]
pub async fn config_has_passphrase(connection_id: String) -> Result<bool, AppError> {
    keychain::has(&SecretSlot::SshKeyPassphrase(connection_id))
}

/// Remove a stored private-key passphrase from the keychain.
#[tauri::command]
pub async fn config_delete_passphrase(connection_id: String) -> Result<(), AppError> {
    keychain::delete(&SecretSlot::SshKeyPassphrase(connection_id))
}

/// Check whether a sudo password has been saved for a connection.
/// 安全：只回布尔，绝不把密码或目标三元组回给前端。
#[tauri::command]
pub async fn config_has_sudo_password(connection_id: String) -> Result<bool, AppError> {
    keychain::has(&SecretSlot::SudoPassword(connection_id))
}

/// Remove a saved sudo password from the keychain.
///
/// 值是带目标三元组的 JSON；这里整条删掉，不需要知道它属于哪台机器。
#[tauri::command]
pub async fn config_delete_sudo_password(connection_id: String) -> Result<(), AppError> {
    keychain::delete(&SecretSlot::SudoPassword(connection_id))
}

/// Save jump-host password (`jump:{connection_id}`).
#[tauri::command]
pub async fn config_save_jump_password(
    connection_id: String,
    password: String,
) -> Result<(), AppError> {
    keychain::set(&SecretSlot::JumpPassword(connection_id), &password)
}

/// Check whether a jump-host password is stored.
#[tauri::command]
pub async fn config_has_jump_password(connection_id: String) -> Result<bool, AppError> {
    keychain::has(&SecretSlot::JumpPassword(connection_id))
}

/// Remove jump-host password from keychain.
#[tauri::command]
pub async fn config_delete_jump_password(connection_id: String) -> Result<(), AppError> {
    keychain::delete(&SecretSlot::JumpPassword(connection_id))
}

/// Save jump-host private-key passphrase (`jump:pk:{connection_id}`).
#[tauri::command]
pub async fn config_save_jump_passphrase(
    connection_id: String,
    passphrase: String,
) -> Result<(), AppError> {
    keychain::set(&SecretSlot::JumpKeyPassphrase(connection_id), &passphrase)
}

/// Check whether a jump-host passphrase is stored.
#[tauri::command]
pub async fn config_has_jump_passphrase(connection_id: String) -> Result<bool, AppError> {
    keychain::has(&SecretSlot::JumpKeyPassphrase(connection_id))
}

/// Remove jump-host passphrase from keychain.
#[tauri::command]
pub async fn config_delete_jump_passphrase(connection_id: String) -> Result<(), AppError> {
    keychain::delete(&SecretSlot::JumpKeyPassphrase(connection_id))
}

/// Save a per-channel LLM API key to the system keychain.
/// 多渠道模型服务：每个渠道独立密钥，account = `llm_channel_{channel_id}`。
#[tauri::command]
pub async fn config_save_llm_channel_api_key(
    channel_id: String,
    api_key: String,
) -> Result<(), AppError> {
    keychain::set(&SecretSlot::LlmChannel(channel_id), &api_key)?;
    Ok(())
}

// config_get_llm_api_key 已移除。前端通过 SettingsResponse.channelKeyStatus
// （每渠道 has_key 布尔）判断是否有 API Key，避免将原始 API Key 返回给 WebView。

/// Remove a per-channel LLM API key from the system keychain.
#[tauri::command]
pub async fn config_delete_llm_channel_api_key(channel_id: String) -> Result<(), AppError> {
    keychain::delete(&SecretSlot::LlmChannel(channel_id))?;
    Ok(())
}

/// 读取某渠道的自定义请求头（键 → 值）。没有任何自定义头时返回空 map。
///
/// **返回映射而不是原文**，前端按 key 逐行渲染。值不做掩码：用户需要能改
/// `x-opencode-session` 这类非机密指纹头。真正机密的东西（API Key）不走这里。
#[tauri::command]
pub async fn config_get_llm_channel_headers(
    channel_id: String,
) -> Result<std::collections::BTreeMap<String, String>, AppError> {
    let Some(json) = keychain::get(&SecretSlot::LlmChannelHeaders(channel_id.clone()))? else {
        return Ok(Default::default());
    };
    match serde_json::from_str(&json) {
        Ok(map) => Ok(map),
        Err(e) => {
            // 坏数据不该让设置页打不开：记一条 warn，当成「没有自定义头」。
            log::warn!("渠道 {} 的自定义请求头无法解析，按空处理: {}", channel_id, e);
            Ok(Default::default())
        }
    }
}

/// 保存某渠道的自定义请求头。传空 map 等于清空（删掉密钥链条目）。
#[tauri::command]
pub async fn config_save_llm_channel_headers(
    channel_id: String,
    headers: std::collections::BTreeMap<String, String>,
) -> Result<(), AppError> {
    if headers.is_empty() {
        keychain::delete(&SecretSlot::LlmChannelHeaders(channel_id))?;
        return Ok(());
    }
    let json = serde_json::to_string(&headers)
        .map_err(|e| AppError::Config(format!("序列化自定义请求头失败：{}", e)))?;
    keychain::set(&SecretSlot::LlmChannelHeaders(channel_id), &json)
}

/// Save the web search API key to the system keychain.
#[tauri::command]
pub async fn config_save_web_search_api_key(api_key: String) -> Result<(), AppError> {
    keychain::set(&SecretSlot::WebSearchApiKey, &api_key)?;
    Ok(())
}

/// Remove the web search API key from the system keychain.
#[tauri::command]
pub async fn config_delete_web_search_api_key() -> Result<(), AppError> {
    keychain::delete(&SecretSlot::WebSearchApiKey)?;
    Ok(())
}

/// Save the custom search API key to the system keychain. 原始 Key 永不回传 WebView。
#[tauri::command]
pub async fn config_save_custom_search_api_key(api_key: String) -> Result<(), AppError> {
    keychain::set(&SecretSlot::CustomSearchApiKey, &api_key)?;
    Ok(())
}

/// Remove the custom search API key from the system keychain.
#[tauri::command]
pub async fn config_delete_custom_search_api_key() -> Result<(), AppError> {
    keychain::delete(&SecretSlot::CustomSearchApiKey)?;
    Ok(())
}

/// Save the custom page-fetch service key (optional) to the system keychain.
/// 原始 Key 永不回传 WebView，前端只通过 `hasCustomFetchApiKey` 知道配没配。
#[tauri::command]
pub async fn config_save_custom_fetch_api_key(api_key: String) -> Result<(), AppError> {
    keychain::set(&SecretSlot::CustomFetchApiKey, &api_key)?;
    Ok(())
}

/// Remove the custom page-fetch service key from the system keychain.
#[tauri::command]
pub async fn config_delete_custom_fetch_api_key() -> Result<(), AppError> {
    keychain::delete(&SecretSlot::CustomFetchApiKey)?;
    Ok(())
}

/// Save the Tavily page-fetch key to the system keychain.
/// 原始 Key 永不回传 WebView，前端只通过 `hasTavilyFetchApiKey` 知道配没配。
#[tauri::command]
pub async fn config_save_tavily_fetch_api_key(api_key: String) -> Result<(), AppError> {
    keychain::set(&SecretSlot::TavilyFetchApiKey, &api_key)?;
    Ok(())
}

/// Remove the Tavily page-fetch key from the system keychain.
#[tauri::command]
pub async fn config_delete_tavily_fetch_api_key() -> Result<(), AppError> {
    keychain::delete(&SecretSlot::TavilyFetchApiKey)?;
    Ok(())
}

/// Save the DeepSeek tools API key (web search + web fetch) to the system keychain.
/// 原始 Key 永不回传 WebView，前端只通过 `hasDeepseekToolsApiKey` 知道配没配。
#[tauri::command]
pub async fn config_save_deepseek_tools_api_key(api_key: String) -> Result<(), AppError> {
    keychain::set(&SecretSlot::DeepseekToolsApiKey, &api_key)?;
    Ok(())
}

/// Remove the DeepSeek tools API key from the system keychain.
#[tauri::command]
pub async fn config_delete_deepseek_tools_api_key() -> Result<(), AppError> {
    keychain::delete(&SecretSlot::DeepseekToolsApiKey)?;
    Ok(())
}

/// Save the TypeSafe (Jev) API key to the system keychain.
///
/// 供「命令审批引擎 = Jev」使用。与渠道密钥一样，原始 Key 永不回传 WebView——
/// 前端只能通过 `SettingsResponse.hasJevApiKey` 知道配没配。
#[tauri::command]
pub async fn config_save_jev_api_key(api_key: String) -> Result<(), AppError> {
    keychain::set(&SecretSlot::JevApiKey, &api_key)?;
    Ok(())
}

/// Remove the TypeSafe (Jev) API key from the system keychain.
#[tauri::command]
pub async fn config_delete_jev_api_key() -> Result<(), AppError> {
    keychain::delete(&SecretSlot::JevApiKey)?;
    Ok(())
}
