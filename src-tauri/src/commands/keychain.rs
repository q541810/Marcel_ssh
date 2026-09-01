use tauri::State;

use crate::config::keychain;
use crate::error::AppError;
use crate::AppState;

/// 通知同步引擎：secrets 变更（保存=record_local_change，删除=record_local_delete）。
/// record_local_change 内部按当前 profile + platform 过滤，未开启「API Key」分类时自动跳过。
fn notify_secret_sync(state: &State<'_, AppState>, key: &str, value: Option<&str>) {
    if let Some(ref scheduler) = state.sync_scheduler {
        if let Some(ref engine) = state.sync_engine {
            match value {
                Some(v) => {
                    let _ = engine.record_local_change(key, v);
                }
                None => {
                    let _ = engine.record_local_delete(key);
                }
            }
            scheduler.schedule_push();
        }
    }
}

/// Save a password for a connection into the OS keychain.
#[tauri::command]
pub async fn config_save_password(connection_id: String, password: String) -> Result<(), AppError> {
    keychain::save_password(&connection_id, &password)
}

/// Check whether a password has been saved for a connection.
/// Does NOT return the password itself — only a boolean.
/// 安全：不将密码返回给前端，只返回是否已保存。
#[tauri::command]
pub async fn config_has_password(connection_id: String) -> Result<bool, AppError> {
    match keychain::get_password(&connection_id) {
        Ok(Some(_)) => Ok(true),
        Ok(None) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Remove a stored password from the keychain without deleting the connection.
#[tauri::command]
pub async fn config_delete_password(connection_id: String) -> Result<(), AppError> {
    keychain::delete_password(&connection_id)
}

/// Save a private-key passphrase for a connection into the OS keychain.
/// 存储 account 为 "pk:{connection_id}"，与主密码条目分开。
#[tauri::command]
pub async fn config_save_passphrase(
    connection_id: String,
    passphrase: String,
) -> Result<(), AppError> {
    keychain::save_password(&format!("pk:{}", connection_id), &passphrase)
}

/// Check whether a private-key passphrase has been saved for a connection.
/// 安全：不将 passphrase 返回给前端，只返回是否已保存。
#[tauri::command]
pub async fn config_has_passphrase(connection_id: String) -> Result<bool, AppError> {
    match keychain::get_password(&format!("pk:{}", connection_id)) {
        Ok(Some(_)) => Ok(true),
        Ok(None) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Remove a stored private-key passphrase from the keychain.
#[tauri::command]
pub async fn config_delete_passphrase(connection_id: String) -> Result<(), AppError> {
    keychain::delete_password(&format!("pk:{}", connection_id))
}

/// Save jump-host password (`jump:{connection_id}`).
#[tauri::command]
pub async fn config_save_jump_password(
    connection_id: String,
    password: String,
) -> Result<(), AppError> {
    keychain::save_password(&format!("jump:{}", connection_id), &password)
}

/// Check whether a jump-host password is stored.
#[tauri::command]
pub async fn config_has_jump_password(connection_id: String) -> Result<bool, AppError> {
    match keychain::get_password(&format!("jump:{}", connection_id)) {
        Ok(Some(_)) => Ok(true),
        Ok(None) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Remove jump-host password from keychain.
#[tauri::command]
pub async fn config_delete_jump_password(connection_id: String) -> Result<(), AppError> {
    keychain::delete_password(&format!("jump:{}", connection_id))
}

/// Save jump-host private-key passphrase (`jump:pk:{connection_id}`).
#[tauri::command]
pub async fn config_save_jump_passphrase(
    connection_id: String,
    passphrase: String,
) -> Result<(), AppError> {
    keychain::save_password(&format!("jump:pk:{}", connection_id), &passphrase)
}

/// Check whether a jump-host passphrase is stored.
#[tauri::command]
pub async fn config_has_jump_passphrase(connection_id: String) -> Result<bool, AppError> {
    match keychain::get_password(&format!("jump:pk:{}", connection_id)) {
        Ok(Some(_)) => Ok(true),
        Ok(None) => Ok(false),
        Err(e) => Err(e),
    }
}

/// Remove jump-host passphrase from keychain.
#[tauri::command]
pub async fn config_delete_jump_passphrase(connection_id: String) -> Result<(), AppError> {
    keychain::delete_password(&format!("jump:pk:{}", connection_id))
}

/// Save a per-channel LLM API key to the system keychain.
/// 多渠道模型服务：每个渠道独立密钥，account = `llm_channel_{channel_id}`。
#[tauri::command]
pub async fn config_save_llm_channel_api_key(
    state: State<'_, AppState>,
    channel_id: String,
    api_key: String,
) -> Result<(), AppError> {
    keychain::save_llm_channel_key(&channel_id, &api_key)?;
    notify_secret_sync(
        &state,
        &format!("secrets.llmChannel.{}", channel_id),
        Some(&api_key),
    );
    Ok(())
}

// config_get_llm_api_key 已移除。前端通过 SettingsResponse.channelKeyStatus
// （每渠道 has_key 布尔）判断是否有 API Key，避免将原始 API Key 返回给 WebView。

/// Remove a per-channel LLM API key from the system keychain.
#[tauri::command]
pub async fn config_delete_llm_channel_api_key(
    state: State<'_, AppState>,
    channel_id: String,
) -> Result<(), AppError> {
    keychain::delete_llm_channel_key(&channel_id)?;
    notify_secret_sync(
        &state,
        &format!("secrets.llmChannel.{}", channel_id),
        None,
    );
    Ok(())
}

/// Save the web search API key to the system keychain.
#[tauri::command]
pub async fn config_save_web_search_api_key(
    state: State<'_, AppState>,
    api_key: String,
) -> Result<(), AppError> {
    keychain::save_web_search_api_key(&api_key)?;
    notify_secret_sync(&state, "secrets.webSearchApiKey", Some(&api_key));
    Ok(())
}

/// Remove the web search API key from the system keychain.
#[tauri::command]
pub async fn config_delete_web_search_api_key(state: State<'_, AppState>) -> Result<(), AppError> {
    keychain::delete_web_search_api_key()?;
    notify_secret_sync(&state, "secrets.webSearchApiKey", None);
    Ok(())
}
