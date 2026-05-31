use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Msg};
use russh::keys::PrivateKeyWithHashAlg;
use russh::{Channel, ChannelMsg};
use serde::Deserialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex as TokioMutex, RwLock};
use uuid::Uuid;

use crate::error::AppError;
use crate::ssh::auth::AuthMethod;
use crate::ssh::known_hosts::{KnownHostEntry, KnownHostsStore, VerifyOutcome};

/// Configuration for establishing an SSH connection.
///
/// Note: Only `Deserialize` is implemented to avoid sending passwords back to
/// the frontend via IPC. This type is only ever constructed from frontend input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    /// Optional connection ID from the saved config, used by Agent tools
    /// to look up the stored password for sudo auto-fill.
    #[serde(default)]
    pub connection_id: Option<String>,
    /// User has explicitly opted to trust a new (mismatching) host key. When
    /// true and the presented key differs from the stored one, the stored
    /// fingerprint is replaced rather than the connection being rejected.
    #[serde(default)]
    pub trust_new_host_key: bool,
}

/// russh client handler enforcing TOFU host-key verification.
struct Client {
    host: String,
    port: u16,
    store: Arc<KnownHostsStore>,
    trust_new: bool,
    /// Filled in by `check_server_key` so `connect()` can return a structured
    /// `HostKeyMismatch` error after the handshake fails.
    verdict: Arc<TokioMutex<Option<VerifyOutcome>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let outcome = self.store.verify(&self.host, self.port, server_public_key).await;
        let (algo, fp) = KnownHostsStore::fingerprint(server_public_key);
        let now = chrono::Utc::now().to_rfc3339();
        let entry = KnownHostEntry {
            algorithm: algo,
            fingerprint_sha256: fp,
            first_seen: now.clone(),
            last_seen: now,
        };

        let accept = match &outcome {
            VerifyOutcome::TrustOnFirstUse => {
                if let Err(e) = self.store.record(&self.host, self.port, entry).await {
                    log::warn!("记录 known_host 失败: {}", e);
                }
                true
            }
            VerifyOutcome::Match(_) => true,
            VerifyOutcome::Mismatch { .. } => {
                if self.trust_new {
                    if let Err(e) = self.store.replace(&self.host, self.port, entry).await {
                        log::warn!("替换 known_host 失败: {}", e);
                    }
                    true
                } else {
                    false
                }
            }
        };

        *self.verdict.lock().await = Some(outcome);
        Ok(accept)
    }
}

/// Commands sent to the per-session driver task.
enum SessionCommand {
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
    /// Sender to the per-session driver task (for the interactive shell).
    cmd_tx: mpsc::UnboundedSender<SessionCommand>,
    /// Shared russh Handle — used to open additional exec channels for
    /// Agent tool calls (separate from the interactive PTY channel).
    handle: Arc<tokio::sync::Mutex<client::Handle<Client>>>,
}

/// Manages multiple SSH connections indexed by session ID.
#[derive(Clone)]
pub struct SshManager {
    connections: Arc<RwLock<HashMap<String, Arc<SshConnection>>>>,
    known_hosts: Arc<KnownHostsStore>,
}

impl SshManager {
    /// Construct a manager with an explicit known-hosts store. This is the
    /// preferred constructor; the application wires it up at startup.
    pub fn with_known_hosts(known_hosts: Arc<KnownHostsStore>) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            known_hosts,
        }
    }

    /// Convenience constructor used by tests/fallbacks. Creates an in-memory
    /// (non-persisted) known-hosts store at a temp path that will not survive
    /// process restarts. **Production code should use `with_known_hosts`.**
    pub fn new() -> Self {
        // Best-effort: a path under the system temp dir keyed by PID so
        // concurrent tests don't collide. If anything fails we fall back to
        // an in-memory empty store rooted at a path that is unlikely to be
        // useful — which is fine for the test/fallback case.
        let path = std::env::temp_dir().join(format!(
            "marcel-ssh-known-hosts-{}-{}.json",
            std::process::id(),
            Uuid::new_v4()
        ));
        let store = futures::executor::block_on(KnownHostsStore::load(path))
            .expect("failed to init in-memory known_hosts store");
        Self::with_known_hosts(store)
    }

    /// Establish a new SSH connection, open a shell channel with a PTY,
    /// and spawn a single driver task that handles both reading and writing.
    pub async fn connect(
        &self,
        config: ConnectionConfig,
        app: AppHandle,
    ) -> Result<String, AppError> {
        if config.host.is_empty() {
            return Err(AppError::Ssh("主机地址不能为空".into()));
        }
        if config.username.is_empty() {
            return Err(AppError::Ssh("用户名不能为空".into()));
        }
        if config.port == 0 {
            return Err(AppError::Ssh("端口不能为 0".into()));
        }

        let session_id = Uuid::new_v4().to_string();
        let host = config.host.clone();
        let port = config.port;
        let username = config.username.clone();
        let connection_id = config.connection_id.clone();

        log::info!(
            "SSH connecting to {}@{}:{} (session={})",
            username,
            host,
            port,
            session_id
        );

        // Build client config
        let client_config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            keepalive_interval: Some(Duration::from_secs(30)),
            ..Default::default()
        });

        // Connect TCP + SSH handshake
        let verdict = Arc::new(TokioMutex::new(None));
        let client = Client {
            host: host.clone(),
            port,
            store: self.known_hosts.clone(),
            trust_new: config.trust_new_host_key,
            verdict: verdict.clone(),
        };
        let mut handle = match client::connect(client_config, (host.as_str(), port), client).await {
            Ok(h) => h,
            Err(e) => {
                // If the handshake failed because of a host-key mismatch,
                // report a structured error so the frontend can prompt the
                // user. Otherwise return the generic SSH error.
                let v = verdict.lock().await.take();
                if let Some(VerifyOutcome::Mismatch { stored, presented }) = v {
                    return Err(AppError::HostKeyMismatch {
                        host: host.clone(),
                        port,
                        stored_algorithm: stored.algorithm,
                        stored_fingerprint: stored.fingerprint_sha256,
                        presented_algorithm: presented.algorithm,
                        presented_fingerprint: presented.fingerprint_sha256,
                    });
                }
                return Err(AppError::Ssh(format!("连接失败: {}", e)));
            }
        };

        // Authenticate
        let auth_success = match &config.auth_method {
            AuthMethod::Password { password } => handle
                .authenticate_password(&username, password)
                .await
                .map_err(|e| AppError::Ssh(format!("密码认证错误: {}", e)))?,
            AuthMethod::PrivateKey { key_path, passphrase } => {
                let key = russh::keys::load_secret_key(key_path, passphrase.as_deref())
                    .map_err(|e| AppError::Ssh(format!("加载私钥失败: {}", e)))?;
                handle
                    .authenticate_publickey(
                        &username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map_err(|e| AppError::Ssh(format!("密钥认证错误: {}", e)))?
            }
        };

        if !auth_success.success() {
            return Err(AppError::Ssh("认证失败：用户名或密码/密钥错误".into()));
        }

        // Open session channel
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("打开会话通道失败: {}", e)))?;

        // Request a PTY so interactive apps work correctly
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .map_err(|e| AppError::Ssh(format!("分配 PTY 失败: {}", e)))?;

        // Request a shell
        channel
            .request_shell(false)
            .await
            .map_err(|e| AppError::Ssh(format!("启动 shell 失败: {}", e)))?;

        // Set up the command channel (frontend -> driver task)
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();

        // We need the handle both for the interactive driver task and for
        // opening exec channels (agent tool calls). Wrap in Arc<Mutex> so
        // both can use it without move conflicts.
        let shared_handle = Arc::new(tokio::sync::Mutex::new(handle));

        let connection = Arc::new(SshConnection {
            id: session_id.clone(),
            host: host.clone(),
            port,
            username: username.clone(),
            connection_id,
            cmd_tx,
            handle: shared_handle.clone(),
        });

        self.connections
            .write()
            .await
            .insert(session_id.clone(), connection);

        // Notify frontend that the session is ready
        let _ = app.emit(
            &format!("ssh://status/{}", session_id),
            SshStatus::Connected,
        );

        // Spawn the driver task: owns the channel and the session handle
        let sid = session_id.clone();
        let app_clone = app.clone();
        let manager_connections = self.connections.clone();
        tokio::spawn(async move {
            Self::drive_session(sid.clone(), channel, shared_handle.clone(), cmd_rx, app_clone.clone()).await;
            // Cleanup
            manager_connections.write().await.remove(&sid);
            let _ = app_clone.emit(
                &format!("ssh://status/{}", sid),
                SshStatus::Disconnected,
            );
            log::info!("SSH session {} cleaned up", sid);
        });

        Ok(session_id)
    }

    /// Drive a single SSH session: multiplex incoming channel messages
    /// and outgoing user commands on the same task. This guarantees there is
    /// exactly one owner of the channel and avoids any locking deadlocks.
    async fn drive_session(
        session_id: String,
        mut channel: Channel<Msg>,
        handle: Arc<tokio::sync::Mutex<client::Handle<Client>>>,
        mut cmd_rx: mpsc::UnboundedReceiver<SessionCommand>,
        app: AppHandle,
    ) {
        let event_name = format!("ssh://output/{}", session_id);
        loop {
            tokio::select! {
                // Incoming data from the SSH server
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let text = match std::str::from_utf8(&data) {
                                Ok(s) => s.to_owned(),
                                Err(_) => String::from_utf8_lossy(&data).into_owned(),
                            };
                            let _ = app.emit(&event_name, text);
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            // stderr — forward to same stream
                            let text = match std::str::from_utf8(&data) {
                                Ok(s) => s.to_owned(),
                                Err(_) => String::from_utf8_lossy(&data).into_owned(),
                            };
                            let _ = app.emit(&event_name, text);
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                            log::info!("SSH session {} closed by remote", session_id);
                            break;
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
                            break;
                        }
                    }
                }

                // Outgoing commands from the user
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Input(data)) => {
                            if let Err(e) = channel.data(&data[..]).await {
                                log::warn!("写入 SSH 通道失败: {:?}", e);
                                break;
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
                            break;
                        }
                        None => {
                            // All senders dropped — connection was force-removed
                            log::info!("SSH session {} command channel closed", session_id);
                            break;
                        }
                    }
                }
            }
        }
        // Best-effort: close the underlying SSH session
        let _ = handle.lock().await
            .disconnect(russh::Disconnect::ByApplication, "client disconnect", "")
            .await;
    }

    /// Send input data to the session's shell channel.
    pub async fn send_input(
        &self,
        session_id: &str,
        data: &[u8],
    ) -> Result<(), AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| {
            AppError::Ssh(format!("会话不存在: {}", session_id))
        })?;
        conn.cmd_tx
            .send(SessionCommand::Input(data.to_vec()))
            .map_err(|_| AppError::Ssh("会话已断开".into()))?;
        Ok(())
    }

    /// Resize the PTY associated with a session.
    pub async fn resize(
        &self,
        session_id: &str,
        cols: u32,
        rows: u32,
    ) -> Result<(), AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| {
            AppError::Ssh(format!("会话不存在: {}", session_id))
        })?;
        conn.cmd_tx
            .send(SessionCommand::Resize { cols, rows })
            .map_err(|_| AppError::Ssh("会话已断开".into()))?;
        Ok(())
    }

    /// Disconnect an active SSH session.
    pub async fn disconnect(&self, session_id: &str) -> Result<(), AppError> {
        let conn = {
            let mut guard = self.connections.write().await;
            guard.remove(session_id)
        };
        match conn {
            Some(conn) => {
                // Best-effort: tell the driver task to close. Even if the send
                // fails (driver already gone), the connection is removed.
                let _ = conn.cmd_tx.send(SessionCommand::Disconnect);
                Ok(())
            }
            None => Err(AppError::Ssh(format!("会话不存在: {}", session_id))),
        }
    }

    /// Check if a session exists.
    pub async fn is_connected(&self, session_id: &str) -> bool {
        self.connections.read().await.contains_key(session_id)
    }

    /// List active session IDs.
    pub async fn list_sessions(&self) -> Vec<String> {
        self.connections.read().await.keys().cloned().collect()
    }

    /// Get the connection_id associated with a session, if available.
    pub async fn get_connection_id(&self, session_id: &str) -> Option<String> {
        let guard = self.connections.read().await;
        guard.get(session_id).and_then(|c| c.connection_id.clone())
    }

    /// Get the host and port for a session.
    pub async fn get_connection_info(&self, session_id: &str) -> Option<(String, u16)> {
        let guard = self.connections.read().await;
        guard.get(session_id).map(|c| (c.host.clone(), c.port))
    }

    /// Execute a command on a separate exec channel (not the interactive PTY).
    /// Opens a new channel, runs the command, waits for output, and closes.
    /// This is used by Agent tool calls.
    pub async fn exec_command(
        &self,
        session_id: &str,
        command: &str,
    ) -> Result<String, AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| {
            AppError::Ssh(format!("会话不存在: {}", session_id))
        })?;

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
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => {
                    output.push_str(&String::from_utf8_lossy(&data));
                }
                Some(ChannelMsg::ExtendedData { data, .. }) => {
                    output.push_str(&String::from_utf8_lossy(&data));
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => break,
                Some(ChannelMsg::ExitStatus { .. }) => {}
                Some(_) => {}
                None => break,
            }
        }
        Ok(output)
    }

    /// Open an SFTP session on a dedicated subsystem channel.
    /// Returns a `SftpSession` that can be used for file operations.
    pub async fn open_sftp(
        &self,
        session_id: &str,
    ) -> Result<russh_sftp::client::SftpSession, AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| {
            AppError::Ssh(format!("会话不存在: {}", session_id))
        })?;

        let channel = conn
            .handle
            .lock()
            .await
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("打开 SFTP 通道失败: {}", e)))?;

        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| AppError::Ssh(format!("请求 SFTP 子系统失败: {}", e)))?;

        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| AppError::Ssh(format!("初始化 SFTP 会话失败: {}", e)))?;

        Ok(sftp)
    }

}

impl Default for SshManager {
    fn default() -> Self {
        Self::new()
    }
}

/// Status updates sent via `ssh://status/{session_id}` event.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SshStatus {
    Connected,
    Disconnected,
    Error(String),
}
