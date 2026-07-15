use std::sync::Arc;

use russh::client;
use russh::{Channel, ChannelMsg};
use tauri::AppHandle;
use tokio::sync::mpsc;

use super::client::Client;
use crate::emit_event;

/// Commands sent to the per-session driver task.
pub(crate) enum SessionCommand {
    Input(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Disconnect,
}

/// An active SSH session. The session is owned by a single driver task that
/// services both incoming channel data and outgoing user commands. The manager
/// communicates with the driver task via an mpsc channel — this avoids any
/// locking on the russh `Channel`, which cannot be used concurrently for both
/// reads and writes.
pub struct SshConnection {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub connection_id: Option<String>,
    /// Monotonic generation counter — incremented each time a new connection
    /// is created for the same session_id (reconnect). Used by cleanup to
    /// prevent a stale driver task from removing a newer connection.
    pub generation: u64,
    /// Sender to the per-session driver task (for the interactive shell).
    pub(crate) cmd_tx: mpsc::UnboundedSender<SessionCommand>,
    /// Shared russh Handle — used to open additional exec channels for
    /// Agent tool calls (separate from the interactive PTY channel).
    pub(crate) handle: Arc<tokio::sync::Mutex<client::Handle<Client>>>,
}

/// Drive a single SSH session: multiplex incoming channel messages
/// and outgoing user commands on the same task. This guarantees there is
/// exactly one owner of the channel and avoids any locking deadlocks.
///
/// Returns a user-facing disconnect reason for the status event.
pub(crate) async fn drive_session(
    session_id: String,
    mut channel: Channel<russh::client::Msg>,
    handle: Arc<tokio::sync::Mutex<client::Handle<Client>>>,
    mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
    app: AppHandle,
) -> String {
    let event_name = format!("ssh://output/{}", session_id);
    let reason = loop {
        tokio::select! {
            // Incoming data from the SSH server
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let text = match std::str::from_utf8(&data) {
                            Ok(s) => s.to_owned(),
                            Err(_) => String::from_utf8_lossy(&data).into_owned(),
                        };
                        emit_event(&app, &event_name, text);
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        // stderr — forward to same stream
                        let text = match std::str::from_utf8(&data) {
                            Ok(s) => s.to_owned(),
                            Err(_) => String::from_utf8_lossy(&data).into_owned(),
                        };
                        emit_event(&app, &event_name, text);
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                        log::info!("SSH session {} closed by remote", session_id);
                        break "远程关闭了连接".to_string();
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        log::info!(
                            "SSH session {} shell exited with status {}",
                            session_id,
                            exit_status
                        );
                    }
                    Some(_) => { /* ignore other messages */ }
                    None => {
                        // Channel ended
                        break "连接已关闭".to_string();
                    }
                }
            }

            // Outgoing commands from the user
            cmd = cmd_rx.recv() => {
                match cmd {
                    Some(SessionCommand::Input(data)) => {
                        if let Err(e) = channel.data(&data[..]).await {
                            log::warn!("写入 SSH 通道失败: {:?}", e);
                            break format_io_reason(&e);
                        }
                    }
                    Some(SessionCommand::Resize { cols, rows }) => {
                        if let Err(e) = channel.window_change(cols, rows, 0, 0).await {
                            log::warn!("调整窗口大小失败: {:?}", e);
                        }
                    }
                    Some(SessionCommand::Disconnect) => {
                        log::info!("SSH session {} disconnect requested", session_id);
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        break "已主动断开连接".to_string();
                    }
                    None => {
                        // All senders dropped — connection was force-removed
                        log::info!("SSH session {} command channel closed", session_id);
                        break "已主动断开连接".to_string();
                    }
                }
            }
        }
    };
    // Best-effort: close the underlying SSH session
    let _ = handle
        .lock()
        .await
        .disconnect(russh::Disconnect::ByApplication, "client disconnect", "")
        .await;
    reason
}

fn format_io_reason(err: &impl std::fmt::Display) -> String {
    let msg = err.to_string();
    let lower = msg.to_lowercase();
    if lower.contains("connection reset")
        || lower.contains("broken pipe")
        || lower.contains("forcibly closed")
        || lower.contains("connection aborted")
    {
        "网络连接已中断".to_string()
    } else if lower.contains("timed out") || lower.contains("timeout") {
        "连接超时".to_string()
    } else if lower.contains("not connected") || lower.contains("disconnected") {
        "连接已断开".to_string()
    } else if msg.chars().count() > 120 {
        format!("{}…", msg.chars().take(120).collect::<String>())
    } else {
        msg
    }
}
