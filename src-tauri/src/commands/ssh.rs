use tauri::{AppHandle, State};

use crate::config::keychain;
use crate::error::AppError;
use crate::ssh::auth::AuthMethod;
use crate::ssh::connection::ConnectionConfig;
use crate::AppState;

/// Establish a new SSH connection. Returns the session ID.
///
/// On success, the backend spawns a background task that emits
/// `ssh://output/{session_id}` events with terminal data and
/// `ssh://status/{session_id}` events with connection lifecycle updates.
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    config: ConnectionConfig,
) -> Result<String, AppError> {
    state.ssh_manager.connect(config, app).await
}

/// Disconnect an active SSH session.
#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    state.ssh_manager.disconnect(&session_id).await
}

/// Send input data to an SSH session's shell channel.
#[tauri::command]
pub async fn ssh_send_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), AppError> {
    state
        .ssh_manager
        .send_input(&session_id, data.as_bytes())
        .await
}

/// Resize the PTY associated with an SSH session.
#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), AppError> {
    state.ssh_manager.resize(&session_id, cols, rows).await
}

/// List currently active SSH session IDs.
#[tauri::command]
pub async fn ssh_list_sessions(state: State<'_, AppState>) -> Result<Vec<String>, AppError> {
    Ok(state.ssh_manager.list_sessions().await)
}

/// 在远程 SSH 会话上执行命令并返回输出。
///
/// 这是**用户主动触发**的命令（由 ProcessPanel 调用，用于进程管理），无需沙箱检查，原因：
///   - 沙箱是为面向 LLM 的 Agent 命令（`execute_command` tool）设计的，LLM 输出不可信。
///   - `ssh_exec` 由用户通过终端 UI 组件调用——该用户本身已通过 `ssh_send_input`
///     拥有完整的交互式 shell。如果 WebView 被攻破，`ssh_send_input` 同样危险。
///   - 在此加沙箱会导致用户自定义的黑名单（如屏蔽 `kill`）悄悄破坏 ProcessPanel 功能。
///   - 面向 LLM 的真正沙箱入口：`agent/tools/execute_cmd.rs` → `Sandbox::check_command()`。
#[tauri::command]
pub async fn ssh_exec(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<String, AppError> {
    state.ssh_manager.exec_command(&session_id, &command).await
}

/// 使用已保存的密码连接 SSH。密码在 Rust 侧从系统密钥链读取，不经过前端。
/// 安全：密码永远不会暴露给 WebView。
#[tauri::command]
pub async fn ssh_connect_with_saved_password(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<String, AppError> {
    let saved = {
        let store = state.connection_store.read().await;
        store
            .get_by_id(&connection_id)
            .ok_or_else(|| AppError::Config(format!("未找到连接: {}", connection_id)))?
            .clone()
    };

    let password = keychain::get_password(&connection_id)?
        .ok_or_else(|| AppError::Config("未找到已保存的密码".into()))?;

    let config = ConnectionConfig {
        host: saved.host,
        port: saved.port,
        username: saved.username,
        auth_method: AuthMethod::Password { password },
        connection_id: Some(connection_id),
        trust_new_host_key: false,
    };

    state.ssh_manager.connect(config, app).await
}

/// 使用已保存的私钥 passphrase 连接 SSH。passphrase 在 Rust 侧从系统密钥链读取
/// （account = "pk:{connection_id}"），不经过前端。
/// 安全：passphrase 永远不会暴露给 WebView。
#[tauri::command]
pub async fn ssh_connect_with_saved_passphrase(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<String, AppError> {
    let saved = {
        let store = state.connection_store.read().await;
        store
            .get_by_id(&connection_id)
            .ok_or_else(|| AppError::Config(format!("未找到连接: {}", connection_id)))?
            .clone()
    };

    let key_path = saved
        .key_path
        .ok_or_else(|| AppError::Config("未配置私钥路径".into()))?;

    let passphrase = keychain::get_password(&format!("pk:{}", connection_id))?;

    let config = ConnectionConfig {
        host: saved.host,
        port: saved.port,
        username: saved.username,
        auth_method: AuthMethod::PrivateKey {
            key_path,
            passphrase,
        },
        connection_id: Some(connection_id),
        trust_new_host_key: false,
    };

    state.ssh_manager.connect(config, app).await
}
///
/// 根据 saved connection 的 auth_method 从 keychain 取凭证：
/// - Password：从 keychain 取密码（account = connection_id）
/// - PrivateKey：从 keychain 取 passphrase（account = "pk:{connection_id}"），无 passphrase 则用 None（未加密私钥）
///
/// 凭证缺失时返回 `AppError::Config`，前端据 `kind === "Config"` 弹窗让用户输入。
/// 安全：密码/passphrase 都在 Rust 侧从 keychain 读取，不经过前端。
#[tauri::command]
pub async fn ssh_reconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    connection_id: String,
) -> Result<(), AppError> {
    let saved = {
        let store = state.connection_store.read().await;
        store
            .get_by_id(&connection_id)
            .ok_or_else(|| AppError::Config(format!("未找到连接: {}", connection_id)))?
            .clone()
    };

    let auth_method = match saved.auth_method.as_str() {
        "Password" => {
            let password = keychain::get_password(&connection_id)?
                .ok_or_else(|| AppError::Config("重连需要密码，请重新输入".into()))?;
            AuthMethod::Password { password }
        }
        "PrivateKey" => {
            let key_path = saved
                .key_path
                .ok_or_else(|| AppError::Config("未配置私钥路径".into()))?;
            let passphrase = keychain::get_password(&format!("pk:{}", connection_id))?;
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            }
        }
        other => {
            return Err(AppError::Config(format!(
                "不支持的认证方式: {}",
                other
            )))
        }
    };

    let config = ConnectionConfig {
        host: saved.host,
        port: saved.port,
        username: saved.username,
        auth_method,
        connection_id: Some(connection_id),
        trust_new_host_key: false,
    };

    state.ssh_manager.reconnect(session_id, config, app).await
}
