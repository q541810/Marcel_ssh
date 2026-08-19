//! 命令执行的「执行适配层」。
//!
//! 对应分层架构中的 Executor 层（终末地 VoicePlayer 的角色）：对调用方
//! 隐藏 exec channel 的全部运行细节——开通道、执行、读输出、超时宽限
//! 关闭、断连检测、流式事件发射。调用方（上层 manager 或兼容 shim）
//! 只需要给它一张 [`CommandTicket`]（或等价的参数组）。
//!
//! 本模块的执行循环与旧 `SshManager::exec_command_timed` /
//! `exec_command_streamed` 逐行对齐（同一份实现统一了两者的差异：
//! 是否流式 emit 由 `streaming` 参数决定），因此行为保持不变。
//! 新增的唯一语义：channel 以 `None` 结束（无 Eof/Close）且该会话的
//! 当前代连接已不存在时，返回明确的断连错误，而不是把部分输出
//! 伪装成正常完成。

use std::time::Duration;

use async_trait::async_trait;
use russh::ChannelMsg;
use tauri::AppHandle;

use crate::emit_event;
use crate::error::AppError;
use crate::ssh::connection::SshManager;

use super::ticket::CommandTicket;

/// 执行传输层抽象：manager 通过它执行命令，测试时可替换为 mock。
///
/// 返回值与旧 `exec_command_timed` 一致：`(合并输出, 是否超时)`。
/// 命令非零退出码不算 Err（与旧语义一致，调用方从输出内容判断）。
#[async_trait]
pub trait ExecTransport: Send + Sync {
    async fn exec(
        &self,
        ticket: &CommandTicket,
        app: Option<&AppHandle>,
    ) -> Result<(String, bool), AppError>;
}

/// 生产传输层：经 [`SshManager`] 在独立 exec channel 上执行。
pub struct SshExecTransport {
    pub ssh: SshManager,
}

#[async_trait]
impl ExecTransport for SshExecTransport {
    async fn exec(
        &self,
        ticket: &CommandTicket,
        app: Option<&AppHandle>,
    ) -> Result<(String, bool), AppError> {
        let streaming = ticket.streaming.as_ref().and_then(|s| {
            app.map(|app| (app, s.event_name.as_str(), s.stream_id.as_str()))
        });
        run_raw(
            &self.ssh,
            &ticket.session_id,
            &ticket.command,
            ticket.timeout,
            streaming,
        )
        .await
    }
}

/// 统一执行核心。
///
/// - `streaming = Some((app, event_name, stream_id))` 时，每个输出 chunk 以
///   `{type:"toolOutput", toolCallId, chunk}` payload 发射（与旧
///   `exec_command_streamed` 协议逐字节一致）。
/// - 超时后宽限 2 秒关闭通道，返回 `(部分输出, true)`。
/// - channel 以 `None` 结束且会话当前代连接已消失时，返回
///   `Err("SSH 连接已断开")`（见模块文档；旧实现此处返回部分输出）。
pub(crate) async fn run_raw(
    ssh: &SshManager,
    session_id: &str,
    command: &str,
    timeout: Duration,
    streaming: Option<(&AppHandle, &str, &str)>,
) -> Result<(String, bool), AppError> {
    let conn = ssh
        .get_connection(session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);

    let mut channel = conn
        .handle
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("打开 exec 通道失败: {}", e)))?;

    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(|e| AppError::Ssh(format!("执行命令失败: {}", e)))?;

    let mut output = String::new();
    let mut ended_without_close = false;

    loop {
        tokio::select! {
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let chunk = String::from_utf8_lossy(&data).to_string();
                        output.push_str(&chunk);
                        if let Some((app, event_name, stream_id)) = streaming {
                            emit_event(
                                app,
                                event_name,
                                &serde_json::json!({
                                    "type": "toolOutput",
                                    "toolCallId": stream_id,
                                    "chunk": chunk,
                                }),
                            );
                        }
                    }
                    Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let chunk = String::from_utf8_lossy(&data).to_string();
                        output.push_str(&chunk);
                        if let Some((app, event_name, stream_id)) = streaming {
                            emit_event(
                                app,
                                event_name,
                                &serde_json::json!({
                                    "type": "toolOutput",
                                    "toolCallId": stream_id,
                                    "chunk": chunk,
                                }),
                            );
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                        break;
                    }
                    Some(ChannelMsg::ExitStatus { .. }) => {}
                    Some(_) => {}
                    None => {
                        ended_without_close = true;
                        break;
                    }
                }
            }
            _ = &mut deadline => {
                // Best-effort channel shutdown. This stops waiting for the
                // exec channel, but does not guarantee the remote process is
                // killed.（与旧实现一致）
                let close_timeout = tokio::time::sleep(Duration::from_secs(2));
                tokio::pin!(close_timeout);
                tokio::select! {
                    _ = async {
                        let _ = channel.eof().await;
                        let _ = channel.close().await;
                        loop {
                            match channel.wait().await {
                                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                                Some(_) => {}
                            }
                        }
                    } => {}
                    _ = &mut close_timeout => {}
                }
                return Ok((output, true));
            }
        }
    }

    if ended_without_close {
        let still_active = ssh.is_generation_active(session_id, conn.generation).await;
        if !still_active {
            return Err(AppError::Ssh("SSH 连接已断开".into()));
        }
    }

    Ok((output, false))
}

/// 旧 `SshManager::exec_command` 系列的超时预览文案（前 80 字符）。
/// 旧实现按字节切片会在多字节字符边界 panic，这里改为按字符截断；
/// ASCII 命令的输出与旧文案完全一致。
pub(crate) fn timeout_preview(command: &str) -> String {
    command.chars().take(80).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeout_preview_truncates_by_chars() {
        assert_eq!(timeout_preview("ls"), "ls");
        let long = "a".repeat(200);
        assert_eq!(timeout_preview(&long).chars().count(), 80);
        // CJK 不 panic 且按字符计数
        let cjk = "测".repeat(100);
        assert_eq!(timeout_preview(&cjk).chars().count(), 80);
    }
}
