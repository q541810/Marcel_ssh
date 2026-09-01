//! 命令执行的「执行适配层」。
//!
//! 对应分层架构中的 Executor 层（终末地 VoicePlayer 的角色）：对调用方
//! 隐藏 exec channel 的全部运行细节——开通道、执行、读输出、超时宽限
//! 关闭、**取消宽限关闭**、断连检测、流式事件发射。调用方（上层 manager
//! 或兼容 shim）只需要给它一张 [`CommandTicket`]（或等价的参数组）。
//!
//! 通道生命周期（超时关闭、取消关闭）全部在本层闭环：超时与取消都会
//! 向远端显式发送 `eof` + `close`（宽限 2 秒等待回程 Close）——这会触发
//! sshd 挂断会话、对子进程发 SIGHUP，普通命令随之终止；但创建后台 /
//! 守护进程（nohup、setsid、`&`）的命令仍可能在远端存活，SSH 协议没有
//! 更强的「杀进程」原语。
//!
//! 新增语义：channel 以 `None` 结束（无 Eof/Close）且该会话的当前代连接
//! 已不存在时，返回明确的断连错误，而不是把部分输出伪装成正常完成。

use std::time::Duration;

use async_trait::async_trait;
use russh::{Channel, ChannelId, ChannelMsg};
use tauri::AppHandle;
use tokio::sync::watch;

use crate::emit_event;
use crate::error::AppError;
use crate::ssh::connection::SshManager;

use super::ticket::{CancelReason, CommandTicket};

/// 一次命令执行的最终结果（executor 层视图）。命令非零退出码不算
/// 失败（与旧语义一致，调用方从输出内容判断）。
#[derive(Debug)]
pub enum ExecOutcome {
    /// 命令正常结束。
    Completed { output: String },
    /// 超时：已显式关闭通道，`output` 为已收到的部分输出。
    TimedOut { output: String },
    /// 被取消（用户取消或断连级联）：已显式关闭通道，尽力终止远端。
    Cancelled { reason: CancelReason },
}

/// 输出 chunk 回调：后台作业据此实时沉淀输出（环形缓冲 + 溢出文件）。
/// `Arc` 包装以脱离引用生命周期的纠缠（回调要跨 await 使用）。
pub type ChunkCallback = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

/// 执行传输层抽象：manager 通过它执行命令，测试时可替换为 mock。
#[async_trait]
pub trait ExecTransport: Send + Sync {
    async fn exec(
        &self,
        ticket: &CommandTicket,
        app: Option<&AppHandle>,
        cancel: Option<&watch::Receiver<CancelReason>>,
    ) -> Result<ExecOutcome, AppError>;

    /// 带输出 chunk 回调的执行变体（后台作业据此实时沉淀输出）。
    /// 默认实现：整体执行完后把输出一次性回调——对无流式能力的
    /// transport（mock / 兼容 shim）语义正确：作业仍能读到完整输出。
    async fn exec_observable(
        &self,
        ticket: &CommandTicket,
        app: Option<&AppHandle>,
        on_chunk: ChunkCallback,
        cancel: Option<&watch::Receiver<CancelReason>>,
    ) -> Result<ExecOutcome, AppError> {
        let outcome = self.exec(ticket, app, cancel).await?;
        match &outcome {
            ExecOutcome::Completed { output } | ExecOutcome::TimedOut { output } => {
                on_chunk(output);
            }
            ExecOutcome::Cancelled { .. } => {}
        }
        Ok(outcome)
    }
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
        cancel: Option<&watch::Receiver<CancelReason>>,
    ) -> Result<ExecOutcome, AppError> {
        let streaming = ticket
            .streaming
            .as_ref()
            .and_then(|s| app.map(|app| (app, s.event_name.as_str(), s.stream_id.as_str())));
        run_raw(
            &self.ssh,
            &ticket.session_id,
            &ticket.command,
            ticket.timeout,
            streaming,
            None,
            cancel,
        )
        .await
    }

    async fn exec_observable(
        &self,
        ticket: &CommandTicket,
        app: Option<&AppHandle>,
        on_chunk: ChunkCallback,
        cancel: Option<&watch::Receiver<CancelReason>>,
    ) -> Result<ExecOutcome, AppError> {
        let streaming = ticket
            .streaming
            .as_ref()
            .and_then(|s| app.map(|app| (app, s.event_name.as_str(), s.stream_id.as_str())));
        run_raw(
            &self.ssh,
            &ticket.session_id,
            &ticket.command,
            ticket.timeout,
            streaming,
            Some(&on_chunk),
            cancel,
        )
        .await
    }
}

/// 宽限关闭：eof + close + 等待远端回程 Close（最多 2 秒）。
/// 这会触发 sshd 挂断会话并向子进程发 SIGHUP——普通命令随之终止；
/// 后台化 / 守护进程不受影响（协议上限如此）。
async fn graceful_close<S>(channel: &mut Channel<S>)
where
    S: From<(ChannelId, ChannelMsg)> + Send + Sync + 'static,
{
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
}

/// 统一执行核心。
///
/// - `streaming = Some((app, event_name, stream_id))` 时，每个输出 chunk 以
///   `{type:"toolOutput", toolCallId, chunk}` payload 发射（与旧
///   `exec_command_streamed` 协议逐字节一致）。
/// - `on_chunk = Some(cb)` 时，每个输出 chunk 同步回调给调用方
///   （后台作业的输出沉淀由此接入；与 streaming 互不干扰，可同时启用）。
/// - `cancel = Some(rx)` 时，取消信号与数据、超时三者共同竞争（biased，
///   取消优先）；取消后宽限关闭通道并返回 `Cancelled`。
/// - 超时后宽限关闭通道，返回 `TimedOut`（含部分输出）。
/// - channel 以 `None` 结束且会话当前代连接已消失时，返回
///   `Err("SSH 连接已断开")`（见模块文档；旧实现此处返回部分输出）。
pub(crate) async fn run_raw(
    ssh: &SshManager,
    session_id: &str,
    command: &str,
    timeout: Duration,
    streaming: Option<(&AppHandle, &str, &str)>,
    on_chunk: Option<&ChunkCallback>,
    cancel: Option<&watch::Receiver<CancelReason>>,
) -> Result<ExecOutcome, AppError> {
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
            biased;
            // 取消优先：与超时同级处理，宽限关闭后再返回。
            _ = async {
                match cancel {
                    // watch::Receiver 可克隆：克隆体订阅同一通道，仅供本臂等待
                    Some(rx) => rx.clone().changed().await,
                    None => std::future::pending().await,
                }
            } => {
                let reason = cancel
                    .map(|rx| *rx.borrow())
                    .unwrap_or(CancelReason::User);
                graceful_close(&mut channel).await;
                return Ok(ExecOutcome::Cancelled { reason });
            }
            msg = channel.wait() => {
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        let chunk = String::from_utf8_lossy(&data).to_string();
                        output.push_str(&chunk);
                        if let Some(cb) = on_chunk {
                            cb(&chunk);
                        }
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
                        if let Some(cb) = on_chunk {
                            cb(&chunk);
                        }
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
                // Best-effort channel shutdown: 停止等待并显式关闭通道，
                // 不保证杀掉远端进程（后台化进程会存活）。（与旧实现一致）
                graceful_close(&mut channel).await;
                return Ok(ExecOutcome::TimedOut { output });
            }
        }
    }

    if ended_without_close {
        let still_active = ssh.is_generation_active(session_id, conn.generation).await;
        if !still_active {
            return Err(AppError::Ssh("SSH 连接已断开".into()));
        }
    }

    Ok(ExecOutcome::Completed { output })
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
