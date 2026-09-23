//! 命令执行的「执行适配层」。
//!
//! 对应分层架构中的 Executor 层（终末地 VoicePlayer 的角色）：对调用方
//! 隐藏 exec channel 的全部运行细节——开通道、执行、读输出、超时宽限
//! 关闭、**取消宽限关闭**、断连检测、流式事件发射。调用方（上层 manager
//! 或兼容 shim）只需要给它一张 [`CommandTicket`]（或等价的参数组）。
//!
//! 通道生命周期（超时关闭、取消关闭）全部在本层闭环：超时与取消都会
//! 向远端显式发送 `eof` + `close`（宽限 2 秒等待回程 Close）。
//!
//! **关闭通道 ≠ 杀掉远端进程**，别把它写成「已终止」：
//! - 本层从不向远端发信号，而且我们的会话通道**没有申请 pty**，sshd 在
//!   「子进程仍活着」时收到通道关闭只会回收会话本身（OpenSSH
//!   `session_close_by_channel` 对无 tty 会话直接 return；能给远端进程发信号
//!   的只有 `signal` 通道请求 → `session_signal_req` → `killpg`，本层没有用）。
//!   带 pty 的交互式终端是另一条通道（`ssh/manager.rs`），那边 pty master
//!   关闭时内核 SIGHUP 前台进程组，与 agent 命令无关。
//! - 真实后果是：关闭后子进程的 stdout/stderr 变成无人读取的管道，它**之后
//!   还往这儿写**才可能因 SIGPIPE 退出；静默运行、重定向了输出、被
//!   nohup / setsid / `&` 脱离的进程会继续在远端跑完。
//! - 因此超时 / 取消 / `job_kill` 的对外文案必须按这个事实写（见
//!   `bash.rs`、`job_ops.rs`、`agent_loop.rs`）：要说「我们停止等待并关闭了
//!   通道」，不说「命令已终止」。
//! - 真要做「终止远端进程」，抓手是关闭**之前**发 `signal` 请求
//!   （russh：`Channel::signal`）——sshd 据此 `killpg` 整个进程组，正好覆盖
//!   `sh -c` 下 fork 出来的那棵树；局限是只对仍在原进程组里的进程有效
//!   （自己 setsid 脱离的收不到），且 forced-command / subsystem 会话会被拒绝。
//!
//! 新增语义：channel 以 `None` 结束（无 Eof/Close）**就是断连**——russh 会把
//! 服务端关闭通道显式转成 `ChannelMsg::Close`（见 [`silent_channel_end_error`]），
//! 所以 `None` 只可能来自会话死亡。此时返回明确的断连错误，既不能把部分输出
//! 伪装成正常完成，也不许去问连接表（那只会把断连判成正常结束）。

use std::time::Duration;

use async_trait::async_trait;
use russh::{Channel, ChannelId, ChannelMsg};
use tauri::AppHandle;
use tokio::sync::watch;

use crate::emit_event;
use crate::error::AppError;
use crate::ssh::connection::SshManager;

use super::ticket::{CancelReason, CommandTicket};

/// 命令结束的退出事实（退出码 / 终止信号）。
///
/// 「非零退出码不算执行失败」这条语义不变——失败指基础设施失败（开通道
/// 失败、断连），非零退出是命令的正常结果。但**退出事实必须如实上报**：
/// 调用方（尤其是模型）不能靠读输出猜命令成功没有，因为 `grep -q`、
/// `test -f`、`make -q` 这类命令恰恰是「没有任何输出但没有成功」。
/// 同理，被信号打死的命令（OOM、外部 kill）与正常退出必须能区分开。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecExit {
    /// 远端回报的退出码；sshd 未回报时为 None（旧路径 / 通道被提前关闭）。
    pub code: Option<u32>,
    /// 被信号终止时的信号名（如 `KILL`、`TERM`）。
    pub signal: Option<String>,
}

impl ExecExit {
    /// 机器可读的状态片段：`exit code: 3` / `signal: KILL`；都未知时为空串。
    pub fn describe(&self) -> String {
        if let Some(signal) = &self.signal {
            return format!("signal: {}", signal);
        }
        match self.code {
            Some(code) => format!("exit code: {}", code),
            None => String::new(),
        }
    }

    /// 退出事实是否已知（远端明确回报过）。
    pub fn is_known(&self) -> bool {
        self.code.is_some() || self.signal.is_some()
    }

    /// 已知且成功（退出码 0、没有被信号终止）。未知不算成功。
    pub fn is_success(&self) -> bool {
        self.code == Some(0) && self.signal.is_none()
    }
}

/// 一次命令执行的最终结果（executor 层视图）。命令非零退出码不算
/// 失败（与旧语义一致，但退出事实随 [`ExecExit`] 一起交给调用方，
/// 不再让调用方从输出内容猜）。
#[derive(Debug)]
pub enum ExecOutcome {
    /// 命令正常结束（非零退出码、被信号终止都算「正常结束」，
    /// 具体事实见 `exit`）。
    Completed { output: String, exit: ExecExit },
    /// 超时：已显式关闭通道，`output` 为已收到的部分输出。
    TimedOut { output: String },
    /// 被取消（用户取消或断连级联）：已显式关闭通道并停止等待；
    /// 远端进程不保证随之结束（见模块注释）。
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
            ExecOutcome::Completed { output, .. } | ExecOutcome::TimedOut { output } => {
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
/// 语义只是「我们不再等这条通道」——**不是杀远端进程**：无 pty 会话下 sshd
/// 不会给子进程发信号，静默运行 / 重定向了输出 / 已脱离会话的命令会在远端
/// 继续跑完（详见模块注释）。
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
/// - 正常结束返回 `Completed`，并带上远端回报的退出码 / 终止信号
///   （[`ExecExit`]）；远端没回报就是空的，绝不猜。
/// - channel 以 `None` 结束（`None ⟺ 会话死亡`）时一律返回
///   `Err("SSH 连接已断开")`，不当正常完成（见模块文档；旧实现此处返回
///   部分输出，后来那版又会把它误判成正常结束）。
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
    // 远端回报的退出事实。OpenSSH 在 EOF / close 之前先发 exit-status，
    // 所以我们在这条通道关掉之前就能拿到它（没拿到就是 None，如实上报）。
    let mut exit = ExecExit::default();

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
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        exit.code = Some(exit_status);
                    }
                    Some(ChannelMsg::ExitSignal { signal_name, .. }) => {
                        exit.signal = Some(format!("{:?}", signal_name));
                    }
                    Some(_) => {}
                    None => {
                        ended_without_close = true;
                        break;
                    }
                }
            }
            _ = &mut deadline => {
                // 停止等待并显式关闭通道：不杀远端进程（见模块注释），
                // 静默 / 重定向了输出 / 已脱离会话的命令会继续在远端跑。
                graceful_close(&mut channel).await;
                return Ok(ExecOutcome::TimedOut { output });
            }
        }
    }

    if let Some(err) = silent_channel_end_error(ended_without_close) {
        // 仅供诊断：注册表里这一代还在 = 清理任务还没跑完（`None` 与清理
        // 常被同一事件唤醒），不在 = 清理已完成。**不参与判定**。
        let still_registered = ssh.is_generation_active(session_id, conn.generation).await;
        log::warn!(
            "command_exec: 会话 {} 的 exec 通道未收到 Eof/Close 就结束了（第 {} 代连接仍在注册表: {}），按断连收尾",
            session_id,
            conn.generation,
            still_registered
        );
        return Err(err);
    }

    Ok(ExecOutcome::Completed { output, exit })
}

/// channel 以 `None` 结束（没有 Eof / Close）时的收尾判据：**一律断连**，
/// 不存在第二种输入。
///
/// `None ⟺ 会话死亡`：`Channel::wait()` 就是收包端 `receiver.recv().await`
/// （russh `channels/mod.rs`），而服务端关闭通道会被 russh 显式转发成
/// `ChannelMsg::Close`——`client/encrypted.rs` 把通道移出映射表之前先发一条
/// Close，原文注释写明是「让等 `Channel::wait()` 的消费者收到明确的 Close，
/// 而不是只看到 None」。收包端返回 `None` 只可能是发送端（会话的通道表）
/// 随连接一起消失。
///
/// 因此判据里**不得**掺「SshManager 里这一代连接还在不在」：那只回答
/// 「清理任务跑完没有」，而清理路径（`drive_session` 返回 → 断开 → 拿写锁
/// remove）比这里的一次读锁长，两条路被同一事件唤醒时这里先到，答案必然
/// 是「还在」，于是断连被当成正常结束（半截输出 + 无退出码）。
fn silent_channel_end_error(ended_without_close: bool) -> Option<AppError> {
    ended_without_close.then(|| AppError::Ssh("SSH 连接已断开".into()))
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

    #[test]
    fn silent_channel_end_is_always_a_disconnect() {
        // 回归护栏：channel 以 None 结束只可能是会话死亡（russh 把服务端关闭
        // 显式转成 ChannelMsg::Close），一律按断连收尾。判据函数只有这一个
        // 入参是刻意的——一旦有人再把它接到「这一代连接还在不在」上，就得改
        // 签名，这个测试会先编译不过（而不是悄悄把断连判成正常结束）。
        let err = silent_channel_end_error(true).expect("None 结束必须报断连");
        assert!(err.to_string().contains("已断开"), "{}", err);
        let normal_end = silent_channel_end_error(false);
        assert!(normal_end.is_none(), "正常结束不受影响");
    }

    #[test]
    fn exit_describe_names_code_or_signal() {
        assert_eq!(
            ExecExit {
                code: Some(0),
                signal: None
            }
            .describe(),
            "exit code: 0"
        );
        assert_eq!(
            ExecExit {
                code: Some(3),
                signal: None
            }
            .describe(),
            "exit code: 3"
        );
        // 信号优先：被信号打死时退出码没有意义
        assert_eq!(
            ExecExit {
                code: Some(137),
                signal: Some("KILL".into())
            }
            .describe(),
            "signal: KILL"
        );
        // 没回报过 → 空串（调用方据此不加任何标记）
        assert_eq!(ExecExit::default().describe(), "");
    }

    #[test]
    fn exit_success_requires_known_zero_code() {
        assert!(ExecExit {
            code: Some(0),
            signal: None
        }
        .is_success());
        assert!(!ExecExit {
            code: Some(1),
            signal: None
        }
        .is_success());
        assert!(!ExecExit {
            code: None,
            signal: None
        }
        .is_success());
        assert!(!ExecExit {
            code: Some(0),
            signal: Some("PIPE".into())
        }
        .is_success());
        assert!(!ExecExit::default().is_known());
        assert!(ExecExit {
            code: Some(0),
            signal: None
        }
        .is_known());
    }
}
