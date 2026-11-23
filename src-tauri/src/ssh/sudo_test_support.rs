//! 仅供测试的 sudo 控制通道模拟器。
//!
//! 真正被测的是 `command_exec::sudo`、统一执行管理器与 MCP 分发；这里只代替
//! 远端 `sudo_bridge.sh` 发协议消息，不启动进程、不连接网络、不读系统密钥链。

use russh::server::Msg;
use russh::{Channel, ChannelId, ChannelMsg};
use tokio::sync::mpsc;

pub(crate) type Channels = mpsc::UnboundedReceiver<Channel<Msg>>;
pub(crate) type Commands = mpsc::UnboundedReceiver<(ChannelId, Vec<u8>)>;

async fn next_exec(channels: &mut Channels, commands: &mut Commands) -> (Channel<Msg>, String) {
    let channel = channels.recv().await.expect("server channel");
    let (id, command) = commands.recv().await.expect("exec request");
    assert_eq!(channel.id(), id);
    (channel, String::from_utf8(command).expect("UTF-8 command"))
}

fn hex(value: &str) -> String {
    value
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

async fn request(control: &mut Channel<Msg>, username: &str) {
    control
        .data(format!("41 7 {}\n", hex(username)).as_bytes())
        .await
        .unwrap();
}

async fn next_reply(channels: &mut Channels, commands: &mut Commands) -> Channel<Msg> {
    let (reply, command) = next_exec(channels, commands).await;
    assert!(
        command
            .strip_prefix("cat > /tmp/sudo-test/reply-")
            .is_some_and(|pid| pid.chars().all(|ch| ch.is_ascii_digit())),
        "密码只能走独立 reply 通道，实际命令：{command}"
    );
    reply
}

/// 和远端 cat 一样：先收正文与客户端 EOF，再回自己的 EOF/close。
async fn read_reply(mut reply: Channel<Msg>) -> Vec<u8> {
    let mut received = Vec::new();
    while let Some(message) = reply.wait().await {
        match message {
            ChannelMsg::Data { data } => received.extend_from_slice(&data),
            ChannelMsg::Eof | ChannelMsg::Close => break,
            _ => {}
        }
    }
    reply.eof().await.unwrap();
    reply.close().await.unwrap();
    received
}

/// 模拟一次 sudo 密码请求，返回客户端实际发送的密码；成功后结束原命令。
pub(crate) async fn auto_fill_once(
    channels: &mut Channels,
    commands: &mut Commands,
    username: &str,
    expected_wrapped_command: &str,
) -> String {
    let (mut control, _) = next_exec(channels, commands).await;
    control
        .data(format!("READY {}\n", hex("/tmp/sudo-test")).as_bytes())
        .await
        .unwrap();
    let (command, wrapped) = next_exec(channels, commands).await;
    assert!(
        wrapped.contains(expected_wrapped_command),
        "原始 sudo 命令应进入桥接"
    );
    request(&mut control, username).await;
    let received = read_reply(next_reply(channels, commands).await).await;
    finish_command(command).await;
    finish_control(control).await;
    String::from_utf8(received).expect("UTF-8 password")
}

/// 没有可用凭据时必须关闭回复而不发任何密码。
pub(crate) async fn expect_no_credential(
    channels: &mut Channels,
    commands: &mut Commands,
    username: &str,
) {
    let (mut control, _) = next_exec(channels, commands).await;
    control
        .data(format!("READY {}\n", hex("/tmp/sudo-test")).as_bytes())
        .await
        .unwrap();
    let (_command, _) = next_exec(channels, commands).await;
    request(&mut control, username).await;
    let received = read_reply(next_reply(channels, commands).await).await;
    assert!(received.is_empty(), "不应发送任何密码或私钥口令");
    finish_control(control).await;
}

async fn finish_command(channel: Channel<Msg>) {
    channel.data(&b"sudo ok\n"[..]).await.unwrap();
    channel.exit_status(0).await.unwrap();
    channel.eof().await.unwrap();
    channel.close().await.unwrap();
}

async fn finish_control(mut control: Channel<Msg>) {
    while let Some(message) = control.wait().await {
        if matches!(message, ChannelMsg::Eof | ChannelMsg::Close) {
            break;
        }
    }
    control.eof().await.unwrap();
    control.close().await.unwrap();
}
