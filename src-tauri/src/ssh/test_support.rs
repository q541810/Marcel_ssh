//! 测试专用：进程内的 SSH 回环（客户端 ⇄ 最小 russh 服务端，走内存管道）。
//!
//! 给「要读真实 `Channel<Msg>`」的测试用——命令通道读取循环（`command_exec/
//! executor.rs`）和终端驱动（`session.rs`）都靠它得到一对真实的通道，服务端那一
//! 半（`Channel<server::Msg>`）由测试自己按字节喂数据，所以能精确控制「数据包
//! 在哪里被切开」。

use std::sync::Arc;

use russh::{Channel, ChannelId};
use tokio::sync::Mutex as TokioMutex;

use super::client::Client;
use super::known_hosts::KnownHostsStore;

pub(crate) struct TestPeer {
    channels: tokio::sync::mpsc::UnboundedSender<Channel<russh::server::Msg>>,
    exec_commands: Option<tokio::sync::mpsc::UnboundedSender<(ChannelId, Vec<u8>)>>,
}

impl russh::server::Handler for TestPeer {
    type Error = russh::Error;

    async fn auth_none(&mut self, _: &str) -> Result<russh::server::Auth, Self::Error> {
        Ok(russh::server::Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<russh::server::Msg>,
        _: &mut russh::server::Session,
    ) -> Result<bool, Self::Error> {
        self.channels.send(channel).unwrap();
        Ok(true)
    }

    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut russh::server::Session,
    ) -> Result<(), Self::Error> {
        if let Some(commands) = &self.exec_commands {
            commands
                .send((channel, data.to_vec()))
                .expect("exec test receiver must stay alive");
        }
        session.channel_success(channel)?;
        Ok(())
    }
}

pub(crate) struct TestClient;

impl russh::client::Handler for TestClient {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _: &russh::keys::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// 建立已认证的回环客户端；服务端每次打开通道、收到 exec 请求都会送进队列。
pub(crate) async fn test_connection() -> (
    russh::client::Handle<Client>,
    tokio::sync::mpsc::UnboundedReceiver<Channel<russh::server::Msg>>,
    tokio::sync::mpsc::UnboundedReceiver<(ChannelId, Vec<u8>)>,
) {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (channel_tx, channel_rx) = tokio::sync::mpsc::unbounded_channel();
    let (exec_tx, exec_rx) = tokio::sync::mpsc::unbounded_channel();
    let key = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[7; 32]);
    let config = russh::server::Config {
        keys: vec![key.into()],
        ..Default::default()
    };
    #[allow(clippy::async_yields_async)]
    let server = tokio::spawn(async move {
        russh::server::run_stream(
            Arc::new(config),
            server_io,
            TestPeer {
                channels: channel_tx,
                exec_commands: Some(exec_tx),
            },
        )
        .await
        .unwrap()
    });
    let mut client = russh::client::connect_stream(
        Arc::new(russh::client::Config::default()),
        client_io,
        Client {
            host: "127.0.0.1".into(),
            port: 22,
            store: KnownHostsStore::in_memory(),
            trust_new: true,
            verdict: Arc::new(TokioMutex::new(None)),
            tofu_record_error: Arc::new(TokioMutex::new(None)),
        },
    )
    .await
    .unwrap();
    let _session = server.await.unwrap();
    assert!(client
        .authenticate_none("synthetic-test")
        .await
        .unwrap()
        .success());
    (client, channel_rx, exec_rx)
}

/// 建立一条回环连接并开一条 session 通道，返回 `(客户端句柄, 客户端通道, 服务端通道)`。
pub(crate) async fn test_channels() -> (
    russh::client::Handle<TestClient>,
    Channel<russh::client::Msg>,
    Channel<russh::server::Msg>,
) {
    let (client_io, server_io) = tokio::io::duplex(64 * 1024);
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
    let key = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[7; 32]);
    let config = russh::server::Config {
        keys: vec![key.into()],
        ..Default::default()
    };
    // `run_stream(..).await.unwrap()` 得到的 `RunningSession` 本身还可以 await；这里让 spawn 的
    // 任务把它原样交出来，由下面的 `_session` 持有到函数结束，所以不是漏了一次 `.await`。
    #[allow(clippy::async_yields_async)]
    let server = tokio::spawn(async move {
        russh::server::run_stream(
            Arc::new(config),
            server_io,
            TestPeer {
                channels: tx,
                exec_commands: None,
            },
        )
        .await
        .unwrap()
    });
    let mut client = russh::client::connect_stream(
        Arc::new(russh::client::Config::default()),
        client_io,
        TestClient,
    )
    .await
    .unwrap();
    let _session = server.await.unwrap();
    assert!(client
        .authenticate_none("synthetic-test")
        .await
        .unwrap()
        .success());
    let channel = client.channel_open_session().await.unwrap();
    let peer = rx.recv().await.unwrap();
    (client, channel, peer)
}
