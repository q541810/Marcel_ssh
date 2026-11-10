//! sudo askpass bridge. A separate SSH channel carries requests and each reply
//! has its own stdin channel. The original script runs once; its stdin is intact.

use std::{collections::HashSet, sync::Arc, time::Duration};

use russh::{Channel, ChannelMsg};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
use zeroize::Zeroizing;

use super::{
    executor::{self, ExecOutcome, OutputSink},
    ticket::{CancelReason, CommandTicket},
};
use crate::{
    agent::interaction::CredentialDetail,
    config::keychain::{self, SecretSlot},
    error::AppError,
    ssh::connection::{SshConnection, SshManager},
    utf8_carry::Utf8Carry,
};

type SshChannel = Channel<russh::client::Msg>;

/// Dropping a russh Channel does not send EOF. Cancellation must release cat's
/// stdin even when it interrupts the password request future between awaits.
struct ReplyChannel(Option<SshChannel>);

impl Drop for ReplyChannel {
    fn drop(&mut self) {
        if let Some(channel) = self.0.take() {
            tokio::spawn(async move {
                let _ = tokio::time::timeout(Duration::from_secs(2), async {
                    let _ = channel.eof().await;
                    let _ = channel.close().await;
                })
                .await;
            });
        }
    }
}

pub(crate) fn needed(ticket: &CommandTicket) -> bool {
    super::sudo_script::prepare(&ticket.command, None).0
}

fn remote_error(error: impl std::fmt::Display) -> AppError {
    AppError::Ssh(format!("sudo 密码通道失败：{error}"))
}

async fn open(conn: &SshConnection, command: &str) -> Result<SshChannel, AppError> {
    let channel = conn
        .handle
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(remote_error)?;
    channel
        .exec(true, command.as_bytes())
        .await
        .map_err(remote_error)?;
    Ok(channel)
}

fn wrapped_command(command: &str, dir: &str) -> String {
    let (_, command) = super::sudo_script::prepare(command, Some(dir));
    let script = format!(
        "PATH={dir}:\"$PATH\"; SUDO_ASKPASS={askpass}; export PATH SUDO_ASKPASS; exec \"${{SHELL:-/bin/sh}}\" -c {command}",
        dir = shell_words::quote(dir), askpass = shell_words::quote(&format!("{dir}/askpass")),
        command = shell_words::quote(&command),
    );
    format!("sh -c {}", shell_words::quote(&script))
}

pub(crate) async fn run<O: OutputSink>(
    ssh: &SshManager,
    ticket: &CommandTicket,
    app: Option<&AppHandle>,
    output: O,
    cancel: Option<&watch::Receiver<CancelReason>>,
) -> Result<ExecOutcome<O::Output>, AppError> {
    let conn = ssh
        .get_connection(&ticket.session_id)
        .await
        .ok_or_else(|| AppError::Ssh("SSH 连接已断开".into()))?;
    if let (Some(app), Some(id)) = (app, &conn.connection_id) {
        let state = app.state::<crate::AppState>();
        let is_windows = state
            .connection_store
            .read()
            .await
            .get_by_id(id)
            .is_some_and(|c| {
                c.remote_platform == Some(crate::config::connections::RemotePlatform::Windows)
            });
        if is_windows {
            let streaming = ticket
                .streaming
                .as_ref()
                .map(|s| (app, s.event_name.as_str(), s.stream_id.as_str()));
            return executor::run_raw(
                ssh,
                &ticket.session_id,
                &ticket.command,
                ticket.timeout,
                streaming,
                output,
                cancel,
            )
            .await;
        }
    }
    let dir = format!("/tmp/marcel-sudo-{}", uuid::Uuid::new_v4().simple());
    let bridge = include_str!("sudo_bridge.sh").replace("\r\n", "\n");
    let bootstrap = format!(
        "sh -c {} marcel {}",
        shell_words::quote(&bridge),
        shell_words::quote(&dir)
    );
    let mut control = open(&conn, &bootstrap).await?;
    let ready = tokio::select! {
        biased;
        _ = async { match cancel { Some(rx) => { let _ = rx.clone().changed().await; }, None => std::future::pending().await } } => {
            executor::graceful_close(&mut control).await;
            return Ok(ExecOutcome::Cancelled { reason: cancel.map(|rx| *rx.borrow()).unwrap_or(CancelReason::User) });
        }
        ready = tokio::time::timeout(Duration::from_secs(15), read_ready(&mut control)) => ready,
    };
    let dir = match ready {
        Ok(Ok(dir)) => dir,
        other => {
            let _ = control.eof().await;
            let _ = control.close().await;
            return Err(match other {
                Ok(Err(error)) => error,
                _ => remote_error("初始化超时，原命令尚未执行"),
            });
        }
    };
    let command = wrapped_command(&ticket.command, &dir);
    let mut channel = match open(&conn, &command).await {
        Ok(channel) => channel,
        Err(error) => {
            let _ = control.eof().await;
            let _ = control.close().await;
            return Err(error);
        }
    };
    let (stop_tx, stop_rx) = watch::channel(false);
    let worker = {
        let conn = conn.clone();
        let ssh = ssh.clone();
        let ticket = ticket.clone();
        let app = app.cloned();
        tokio::spawn(async move {
            let mut stopped = stop_rx.clone();
            let result = tokio::select! {
                biased;
                _ = stopped.changed() => Ok(()),
                result = serve(&ssh, &conn, &ticket, app.as_ref(), &dir, &mut control, stop_rx) => result,
            };
            ticket.auth_wait.set(false);
            let _ = control.eof().await;
            let _ = control.close().await;
            result
        })
    };
    let mut worker = worker;
    let streaming = ticket
        .streaming
        .as_ref()
        .and_then(|s| app.map(|app| (app, s.event_name.as_str(), s.stream_id.as_str())));
    let result = tokio::select! {
        biased;
        result = &mut worker => {
            executor::graceful_close(&mut channel).await;
            if matches!(result, Ok(Err(AppError::Cancelled(_)))) {
                return Ok(ExecOutcome::Cancelled { reason: CancelReason::User });
            }
            return Err(match result {
                Ok(Err(error)) => error,
                _ => remote_error("密码通道已关闭；命令可能已部分执行，请勿整段重试"),
            });
        },
        result = executor::read_channel_paused(&mut channel, ticket.timeout, streaming, output, cancel, &ticket.auth_wait) => result,
    };
    stop_tx.send_replace(true);
    let _ = worker.await;
    result
}

async fn read_ready(control: &mut SshChannel) -> Result<String, AppError> {
    let mut decoder = Utf8Carry::default();
    let mut message = String::new();
    loop {
        match control.wait().await {
            Some(ChannelMsg::Data { data }) => {
                message.push_str(&decoder.decode(&data));
                if let Some(path) = message
                    .strip_prefix("READY ")
                    .and_then(|value| value.strip_suffix('\n'))
                    .and_then(decode_hex)
                {
                    if path.starts_with('/') {
                        return Ok(path);
                    }
                }
                if message.contains('\n') {
                    return Err(remote_error("服务器无法启用 sudo 密码输入，原命令尚未执行"));
                }
                if message.len() > 16384 {
                    return Err(remote_error("无效的初始化响应"));
                }
            }
            Some(ChannelMsg::Close | ChannelMsg::Eof) | None => {
                return Err(remote_error(
                    "服务器需要可用的 sudo、sh 和可执行的临时目录，原命令尚未执行",
                ))
            }
            _ => {}
        }
    }
}

#[derive(Debug, PartialEq)]
struct Request {
    pid: u32,
    call: u32,
    username: String,
}

fn parse_request(line: &str) -> Option<Request> {
    let mut parts = line.split_whitespace();
    let pid = parts.next()?.parse::<u32>().ok()?;
    let call = parts.next()?.parse::<u32>().ok()?;
    let hex = parts.next()?;
    if pid == 0 || call == 0 || parts.next().is_some() || hex.len() % 2 != 0 {
        return None;
    }
    let username = decode_hex(hex)?;
    Some(Request {
        pid,
        call,
        username,
    })
}

fn decode_hex(hex: &str) -> Option<String> {
    if hex.len() % 2 != 0 {
        return None;
    }
    let bytes: Option<Vec<u8>> = hex
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            let digit = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
            Some(digit(pair[0])? * 16 + digit(pair[1])?)
        })
        .collect();
    String::from_utf8(bytes?).ok()
}

async fn serve(
    ssh: &SshManager,
    conn: &Arc<SshConnection>,
    ticket: &CommandTicket,
    app: Option<&AppHandle>,
    dir: &str,
    control: &mut SshChannel,
    mut stop: watch::Receiver<bool>,
) -> Result<(), AppError> {
    let mut decoder = Utf8Carry::default();
    let mut pending = String::new();
    let mut tried = HashSet::new();
    loop {
        let msg = tokio::select! {
            biased;
            _ = stop.changed() => return Ok(()),
            msg = control.wait() => msg,
        };
        match msg {
            Some(ChannelMsg::Data { data }) => {
                pending.push_str(&decoder.decode(&data));
                while let Some(end) = pending.find('\n') {
                    let line: String = pending.drain(..=end).collect();
                    let request =
                        parse_request(&line).ok_or_else(|| remote_error("无效的密码请求"))?;
                    ticket.auth_wait.set(true);
                    let rejected = !tried.insert((request.call, request.username.clone()));
                    let result =
                        answer(ssh, conn, ticket, app, dir, &request, rejected, &mut stop).await;
                    ticket.auth_wait.set(false);
                    result?;
                }
                if pending.len() > 65536 {
                    return Err(remote_error("无效的密码请求"));
                }
            }
            Some(ChannelMsg::Close | ChannelMsg::Eof) | None => {
                return Err(remote_error("密码通道已断开"))
            }
            _ => {}
        }
    }
}

async fn answer(
    ssh: &SshManager,
    conn: &SshConnection,
    ticket: &CommandTicket,
    app: Option<&AppHandle>,
    dir: &str,
    request: &Request,
    rejected: bool,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), AppError> {
    // Open the writer first so dropping/closing SSH also releases the remote askpass reader.
    let path = format!("{dir}/reply-{}", request.pid);
    let mut closing = ReplyChannel(Some(
        open(conn, &format!("cat > {}", shell_words::quote(&path))).await?,
    ));
    let reply = closing.0.as_mut().expect("reply channel is open");
    let outcome = async {
        if !ticket.interactive_sudo || app.is_none() {
            return Err(AppError::SudoAuthRequired);
        }
        let app = app.unwrap();
        let mut password = if rejected {
            conn.sudo_passwords.lock().remove(&request.username);
            None
        } else { conn.sudo_passwords.lock().get(&request.username).cloned() };
        if password.is_none() && !rejected && request.username == conn.username {
            if let Some(id) = &conn.connection_id {
                // A saved connection can be edited while its old session is still open.
                let state = app.state::<crate::AppState>();
                let same_target = state.connection_store.read().await.get_by_id(id)
                    .is_some_and(|c| c.host == conn.host && c.port == conn.port && c.username == conn.username);
                if same_target {
                    password = keychain::get(&SecretSlot::SshPassword(id.clone())).ok().flatten().map(Zeroizing::new);
                }
            }
        }
        if password.is_none() {
            let state = app.state::<crate::AppState>();
            password = tokio::select! {
                biased;
                _ = stop.changed() => None,
                password = state.agent_interaction.request_credential(app,
                    ticket.task_id.clone().unwrap_or_default(), ticket.session_id.clone(),
                    ticket.owner_conversation_id.clone().unwrap_or_default(),
                    CredentialDetail { username: request.username.clone(), command: ticket.display_command.clone(), rejected },
                ) => password,
            };
        }
        let Some(password) = password else { return Err(AppError::Cancelled("已取消 sudo 密码输入；命令不会自动重试".into())); };
        if *stop.borrow() || !ssh.is_generation_active(&ticket.session_id, conn.generation).await {
            return Err(AppError::Cancelled("SSH 连接已变化，未发送密码".into()));
        }
        let mut bytes = Zeroizing::new(password.as_bytes().to_vec());
        bytes.push(b'\n');
        reply.data(bytes.as_slice()).await.map_err(remote_error)?;
        conn.sudo_passwords.lock().insert(request.username.clone(), password);
        Ok(())
    }.await;
    let _ = reply.eof().await;
    // Let cat flush the pipe before closing the channel; never read password data back.
    // On cancellation there are no bytes to flush. Report it before sudo's
    // resulting EOF can be mistaken for an ordinary command completion.
    if outcome.is_ok() {
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            while let Some(message) = reply.wait().await {
                if matches!(message, ChannelMsg::Close | ChannelMsg::Eof) {
                    break;
                }
            }
        })
        .await;
    }
    let _ = reply.close().await;
    closing.0.take();
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn cancelled_password_future_closes_its_reply_channel() {
        let (_client, channel, mut peer) = crate::ssh::test_support::test_channels().await;
        drop(ReplyChannel(Some(channel)));
        tokio::time::timeout(Duration::from_secs(3), async {
            while let Some(message) = peer.wait().await {
                if matches!(message, ChannelMsg::Eof | ChannelMsg::Close) {
                    return;
                }
            }
            panic!("reply disappeared without EOF");
        })
        .await
        .expect("cancelled reply must close");
    }
    #[test]
    fn protocol_rejects_paths_and_preserves_account_identity() {
        assert_eq!(
            parse_request("10 9 726f6f74\n"),
            Some(Request {
                pid: 10,
                call: 9,
                username: "root".into()
            })
        );
        for malformed in ["../x 9 61", "0 9 61", "1 2 6", "1 2 zz", "1 2 61 extra"] {
            assert!(parse_request(malformed).is_none());
        }
    }
    #[test]
    fn command_keeps_original_script_as_one_shell_argument() {
        let original = "printf '%s' 'a b' | sudo -u root tee /tmp/x; echo done";
        let wrapped = wrapped_command(original, "/tmp/marcel-test");
        let outer = shell_words::split(&wrapped).unwrap();
        assert_eq!(outer[0..2], ["sh", "-c"]);
        let rewritten = original.replace("sudo -u", "/tmp/marcel-test/sudo -u");
        assert!(outer[2].ends_with(&format!("-c {}", shell_words::quote(&rewritten))));
        assert!(!wrapped.contains("sudo -S"));
    }

    #[test]
    fn only_sudo_invocations_enable_the_bridge() {
        use super::super::CommandSource;
        for command in [
            "echo sudo",
            "cat /etc/sudoers",
            "printf 'sudo ls'",
            "grep sudo log",
        ] {
            assert!(
                !needed(&CommandTicket::new("s", command, CommandSource::Agent)),
                "{command}"
            );
        }
        for command in [
            "sudo ls",
            "echo before; sudo ls",
            "A=1 sudo -u root ls",
            "printf x | sudo tee file",
            "sh -c 'sudo ls'",
            "/usr/bin/sudo ls",
        ] {
            assert!(
                needed(&CommandTicket::new("s", command, CommandSource::Agent)),
                "{command}"
            );
        }
    }
}
