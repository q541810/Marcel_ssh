use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::port_forward::{ForwardInfo, PortForwardManager};
use crate::AppState;

/// 开一条本地端口转发（`ssh -L`）：本机 127.0.0.1 → 服务器上的 `remote_host:remote_port`。
/// `local_port` 省略 = 优先同号，被占用再自动换（返回值里是实际端口）。
#[tauri::command]
pub async fn port_forward_start(
    app: AppHandle,
    state: State<'_, AppState>,
    forwards: State<'_, PortForwardManager>,
    session_id: String,
    remote_host: String,
    remote_port: u16,
    local_port: Option<u16>,
) -> Result<ForwardInfo, AppError> {
    forwards
        .start(
            &app,
            &state.ssh_manager,
            &session_id,
            &remote_host,
            remote_port,
            local_port,
        )
        .await
}

#[tauri::command]
pub async fn port_forward_stop(
    app: AppHandle,
    forwards: State<'_, PortForwardManager>,
    forward_id: String,
) -> Result<(), AppError> {
    forwards.stop(&app, &forward_id);
    Ok(())
}

#[tauri::command]
pub async fn port_forward_list(
    state: State<'_, AppState>,
    forwards: State<'_, PortForwardManager>,
    session_id: String,
) -> Result<Vec<ForwardInfo>, AppError> {
    Ok(forwards.list(&state.ssh_manager, &session_id).await)
}
