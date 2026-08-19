use tauri::{AppHandle, State};

use crate::command_exec::{CancelReason, CommandSource, CommandTicket, SubmitOutcome};
use crate::config::connections::SavedConnection;
use crate::config::keychain;
use crate::emit_event;
use crate::error::AppError;
use crate::ssh::auth::{AuthMethod, JumpConfig};
use crate::ssh::connection::ConnectionConfig;
use crate::AppState;
use serde_json::json;
use std::time::Duration;

/// Keychain account for jump host password: `jump:{connection_id}`
fn jump_password_account(connection_id: &str) -> String {
    format!("jump:{}", connection_id)
}

/// Keychain account for jump host private-key passphrase: `jump:pk:{connection_id}`
fn jump_passphrase_account(connection_id: &str) -> String {
    format!("jump:pk:{}", connection_id)
}

/// Build runtime jump config from a saved connection + keychain secrets.
/// Returns `Ok(None)` when jump is not enabled.
fn build_jump_config(
    saved: &SavedConnection,
    connection_id: &str,
    target_auth: &AuthMethod,
) -> Result<Option<JumpConfig>, AppError> {
    if !saved.use_jump {
        return Ok(None);
    }
    let host = saved
        .jump_host
        .as_deref()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::Config("已启用跳板机但未配置主机".into()))?
        .to_string();
    let port = saved.jump_port.unwrap_or(22);
    let username = saved
        .jump_username
        .as_deref()
        .filter(|u| !u.is_empty())
        .ok_or_else(|| AppError::Config("已启用跳板机但未配置用户名".into()))?
        .to_string();

    let method = saved.jump_auth_method.as_deref().unwrap_or("withTarget");
    let auth_method = match method {
        "withTarget" => clone_auth_method(target_auth),
        "Password" => {
            let password = keychain::get_password(&jump_password_account(connection_id))?
                .ok_or_else(|| AppError::Config("未找到已保存的跳板机密码".into()))?;
            AuthMethod::Password { password }
        }
        "PrivateKey" => {
            let key_path = saved
                .jump_key_path
                .clone()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| AppError::Config("未配置跳板机私钥路径".into()))?;
            let passphrase = keychain::get_password(&jump_passphrase_account(connection_id))?;
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            }
        }
        other => {
            return Err(AppError::Config(format!(
                "不支持的跳板机认证方式: {}",
                other
            )));
        }
    };

    Ok(Some(JumpConfig {
        host,
        port,
        username,
        auth_method,
    }))
}

fn clone_auth_method(auth: &AuthMethod) -> AuthMethod {
    match auth {
        AuthMethod::Password { password } => AuthMethod::Password {
            password: password.clone(),
        },
        AuthMethod::PrivateKey {
            key_path,
            passphrase,
        } => AuthMethod::PrivateKey {
            key_path: key_path.clone(),
            passphrase: passphrase.clone(),
        },
    }
}

/// Establish a new SSH connection. Returns the session ID.
///
/// On success, the backend spawns a background task that emits
/// `ssh://output/{session_id}` events with terminal data and
/// `ssh://status/{session_id}` events with connection lifecycle updates.
///
/// If `config.jump` is absent but `connection_id` points to a saved connection
/// with `useJump`, jump credentials are loaded from the keychain here so the
/// frontend never needs to handle jump secrets.
#[tauri::command]
pub async fn ssh_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    mut config: ConnectionConfig,
) -> Result<String, AppError> {
    if config.jump.is_none() {
        if let Some(ref connection_id) = config.connection_id {
            let saved = {
                let store = state.connection_store.read().await;
                store.get_by_id(connection_id).cloned()
            };
            if let Some(saved) = saved {
                config.jump = build_jump_config(&saved, connection_id, &config.auth_method)?;
            }
        }
    }
    state.ssh_manager.connect(config, app).await
}

/// Disconnect an active SSH session.
#[tauri::command]
pub async fn ssh_disconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    crate::commands::sftp::cleanup_session_sysopen(&app, &state, &session_id).await;
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
///
/// 经 command_exec 统一管理器执行（120s 超时，行为与旧实现一致）。
#[tauri::command]
pub async fn ssh_exec(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<String, AppError> {
    let ticket = CommandTicket::new(&session_id, &command, CommandSource::User);
    match state.command_exec.submit(&app, ticket).await {
        SubmitOutcome::Completed { output } => Ok(output),
        SubmitOutcome::TimedOut { .. } => Err(AppError::Ssh(format!(
            "命令在 120 秒后超时: {}",
            crate::command_exec::executor::timeout_preview(&command)
        ))),
        // ssh_exec 的 ticket 无 task_id，只有断连级联会取消
        SubmitOutcome::Cancelled { .. } => Err(AppError::Ssh("命令已取消（会话断开）".into())),
        SubmitOutcome::Failed { error } => Err(error),
    }
}

/// 执行长时间运行的 SSH 命令，支持取消和流式输出。
///
/// 与 `ssh_exec` 的区别：
/// - 默认 30 分钟超时（`ssh_exec` 是 120 秒）
/// - 通过 `task_id` 支持取消（前端调 `ssh_exec_long_cancel`）
/// - 实时 emit `ssh-long-output` 事件（含 chunk）
/// - 完成/取消/超时分别 emit `ssh-long-done` / `ssh-long-cancelled` / `ssh-long-error`
///
/// 安全：与 `ssh_exec` 同级，不走沙箱。调用方（如压缩功能）负责命令构造和路径校验。
///
/// 返回值：命令完整输出（合并 stdout+stderr）。命令本身非零退出不算 Err——
/// 调用方需通过输出内容（如 OK/FAILED 标记）判断业务成功与否。
///
/// 执行与取消注册由 command_exec 统一管理器闭环；本函数只负责把
/// 管理器的结果映射回旧的事件协议（前端零变化）。
#[tauri::command]
pub async fn ssh_exec_long(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    task_id: String,
    timeout_secs: Option<u64>,
) -> Result<String, AppError> {
    let ticket = CommandTicket::new(&session_id, &command, CommandSource::User)
        .timeout(Duration::from_secs(timeout_secs.unwrap_or(1800))) // 默认 30 分钟
        .cancellable(task_id.clone(), "命令已取消")
        .streaming("ssh-long-output", task_id.clone());

    match state.command_exec.submit(&app, ticket).await {
        SubmitOutcome::Completed { output } => {
            emit_event(&app, "ssh-long-done", &json!({ "taskId": &task_id }));
            Ok(output)
        }
        SubmitOutcome::TimedOut { .. } => {
            emit_event(
                &app,
                "ssh-long-error",
                &json!({ "taskId": &task_id, "message": "命令超时" }),
            );
            Err(AppError::Ssh("命令在超时后未完成".into()))
        }
        SubmitOutcome::Cancelled { reason } => match reason {
            CancelReason::User => {
                emit_event(
                    &app,
                    "ssh-long-cancelled",
                    &json!({ "taskId": &task_id }),
                );
                Err(AppError::Ssh("命令已取消".into()))
            }
            CancelReason::Disconnected => {
                emit_event(
                    &app,
                    "ssh-long-error",
                    &json!({ "taskId": &task_id, "message": "SSH 连接已断开" }),
                );
                Err(AppError::Ssh("SSH 连接已断开，命令已中止".into()))
            }
        },
        SubmitOutcome::Failed { error } => {
            emit_event(
                &app,
                "ssh-long-error",
                &json!({ "taskId": &task_id, "message": error.to_string() }),
            );
            Err(error)
        }
    }
}

/// 取消正在运行的 `ssh_exec_long` 任务。
#[tauri::command]
pub async fn ssh_exec_long_cancel(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), AppError> {
    // 未命中（任务不存在或已结束）也返回 Ok，与旧行为一致
    let _ = state.command_exec.cancel(&task_id).await;
    Ok(())
}

/// 使用已保存的密码连接 SSH。密码在 Rust 侧从系统密钥链读取，不经过前端。
/// 安全：密码永远不会暴露给 WebView。
///
/// `trust_new_host_key` 默认 false；仅当用户在 HostKeyMismatch 弹窗里
/// 明确选择「信任新密钥」后才传 true，触发后端 `KnownHostsStore::replace`
/// 覆盖已记录的指纹而不是拒绝握手。
#[tauri::command]
pub async fn ssh_connect_with_saved_password(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    trust_new_host_key: Option<bool>,
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

    let auth_method = AuthMethod::Password { password };
    let jump = build_jump_config(&saved, &connection_id, &auth_method)?;

    let config = ConnectionConfig {
        host: saved.host,
        port: saved.port,
        username: saved.username,
        auth_method,
        connection_id: Some(connection_id),
        trust_new_host_key: trust_new_host_key.unwrap_or(false),
        jump,
    };

    state.ssh_manager.connect(config, app).await
}

/// 使用已保存的私钥 passphrase 连接 SSH。passphrase 在 Rust 侧从系统密钥链读取
/// （account = "pk:{connection_id}"），不经过前端。
/// 安全：passphrase 永远不会暴露给 WebView。
///
/// `trust_new_host_key` 默认 false；仅当用户在 HostKeyMismatch 弹窗里
/// 明确选择「信任新密钥」后才传 true。
#[tauri::command]
pub async fn ssh_connect_with_saved_passphrase(
    app: AppHandle,
    state: State<'_, AppState>,
    connection_id: String,
    trust_new_host_key: Option<bool>,
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
        .clone()
        .ok_or_else(|| AppError::Config("未配置私钥路径".into()))?;

    let passphrase = keychain::get_password(&format!("pk:{}", connection_id))?;

    let auth_method = AuthMethod::PrivateKey {
        key_path,
        passphrase,
    };
    let jump = build_jump_config(&saved, &connection_id, &auth_method)?;

    let config = ConnectionConfig {
        host: saved.host,
        port: saved.port,
        username: saved.username,
        auth_method,
        connection_id: Some(connection_id),
        trust_new_host_key: trust_new_host_key.unwrap_or(false),
        jump,
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
///
/// `trust_new_host_key` 默认 false；仅当用户在 HostKeyMismatch 弹窗里
/// 明确选择「信任新密钥」后才传 true。
#[tauri::command]
pub async fn ssh_reconnect(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    connection_id: String,
    trust_new_host_key: Option<bool>,
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
                .clone()
                .ok_or_else(|| AppError::Config("未配置私钥路径".into()))?;
            let passphrase = keychain::get_password(&format!("pk:{}", connection_id))?;
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            }
        }
        other => return Err(AppError::Config(format!("不支持的认证方式: {}", other))),
    };

    let jump = build_jump_config(&saved, &connection_id, &auth_method)?;

    let config = ConnectionConfig {
        host: saved.host,
        port: saved.port,
        username: saved.username,
        auth_method,
        connection_id: Some(connection_id),
        trust_new_host_key: trust_new_host_key.unwrap_or(false),
        jump,
    };

    state.ssh_manager.reconnect(session_id, config, app).await
}
