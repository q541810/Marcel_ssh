use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self};
use russh::keys::PrivateKeyWithHashAlg;
use russh::ChannelMsg;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, Mutex as TokioMutex, RwLock};
use uuid::Uuid;

use crate::emit_event;
use crate::error::AppError;
use crate::ssh::auth::AuthMethod;
use crate::ssh::known_hosts::{KnownHostsStore, VerifyOutcome};

use super::client::Client;
use super::session::{self, SessionCommand, SshConnection};

/// Configuration for establishing an SSH connection.
///
/// Note: Only `Deserialize` is implemented to avoid sending passwords back to
/// the frontend via IPC. This type is only ever constructed from frontend input.
#[derive(Clone, Deserialize)]
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
    /// Optional ProxyJump hop. When set, connect jump first, open
    /// direct-tcpip to the target, then handshake SSH over that stream.
    #[serde(default)]
    pub jump: Option<crate::ssh::auth::JumpConfig>,
}

impl fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ConnectionConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth_method", &self.auth_method)
            .field("connection_id", &self.connection_id)
            .field("trust_new_host_key", &self.trust_new_host_key)
            .field("jump", &self.jump)
            .finish()
    }
}

/// Manages multiple SSH connections indexed by session ID.
#[derive(Clone)]
pub struct SshManager {
    connections: Arc<RwLock<HashMap<String, Arc<SshConnection>>>>,
    /// Per-session generation counter. Incremented each time a new connection
    /// replaces an existing one for the same session_id (reconnect). The driver
    /// task captures its generation at spawn time; during cleanup it only
    /// removes the entry if the generation still matches, preventing a stale
    /// driver from deleting a newer connection.
    generations: Arc<RwLock<HashMap<String, u64>>>,
    known_hosts: Arc<KnownHostsStore>,
}

impl SshManager {
    /// Construct a manager with an explicit known-hosts store. This is the
    /// preferred constructor; the application wires it up at startup.
    pub fn with_known_hosts(known_hosts: Arc<KnownHostsStore>) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            generations: Arc::new(RwLock::new(HashMap::new())),
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
        let session_id = Uuid::new_v4().to_string();
        self.connect_inner(session_id.clone(), config, app).await?;
        Ok(session_id)
    }

    /// Re-establish an SSH connection on an existing session id (used after a
    /// remote-side disconnect so the frontend can keep the same session id,
    /// terminal instance, and event listeners).
    pub async fn reconnect(
        &self,
        session_id: String,
        config: ConnectionConfig,
        app: AppHandle,
    ) -> Result<(), AppError> {
        self.connect_inner(session_id, config, app).await
    }

    /// Shared connection logic for both fresh connects and reconnects.
    ///
    /// Validates the config, performs TCP+SSH handshake, authenticates, opens
    /// a shell channel with a PTY, inserts the connection into the manager
    /// (overwriting any stale entry for the same id), emits `Connected`, and
    /// spawns the driver task.
    async fn connect_inner(
        &self,
        session_id: String,
        config: ConnectionConfig,
        app: AppHandle,
    ) -> Result<(), AppError> {
        if config.host.is_empty() {
            return Err(AppError::Ssh("主机地址不能为空".into()));
        }
        if config.username.is_empty() {
            return Err(AppError::Ssh("用户名不能为空".into()));
        }
        if config.port == 0 {
            return Err(AppError::Ssh("端口不能为 0".into()));
        }
        if let Some(ref jump) = config.jump {
            if jump.host.is_empty() {
                return Err(AppError::Ssh("跳板机地址不能为空".into()));
            }
            if jump.username.is_empty() {
                return Err(AppError::Ssh("跳板机用户名不能为空".into()));
            }
            if jump.port == 0 {
                return Err(AppError::Ssh("跳板机端口不能为 0".into()));
            }
        }

        let host = config.host.clone();
        let port = config.port;
        let username = config.username.clone();
        let connection_id = config.connection_id.clone();

        log::info!(
            "SSH connecting to {}@{}:{} jump={:?} (session={})",
            username,
            host,
            port,
            config.jump.as_ref().map(|j| format!("{}@{}:{}", j.username, j.host, j.port)),
            session_id
        );

        let client_config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(600)),
            keepalive_interval: Some(Duration::from_secs(30)),
            nodelay: true,
            ..Default::default()
        });

        // ── Jump hop (optional) ──────────────────────────────────────────
        // Keep jump_handle alive for the whole target session so the
        // direct-tcpip tunnel stream does not die when the jump Handle drops.
        let jump_handle: Option<Arc<TokioMutex<client::Handle<Client>>>> =
            if let Some(jump) = config.jump.clone() {
                let mut jh = self
                    .ssh_handshake(
                        client_config.clone(),
                        &jump.host,
                        jump.port,
                        config.trust_new_host_key,
                        &app,
                        "jump",
                    )
                    .await
                    .map_err(|e| match e {
                        AppError::HostKeyMismatch { .. } => e,
                        other => AppError::Ssh(format!(
                            "跳板机 {} 连接失败：{}",
                            jump.host,
                            strip_ssh_prefix(&other.to_string())
                        )),
                    })?;

                Self::authenticate(&mut jh, &jump.username, &jump.auth_method)
                    .await
                    .map_err(|e| {
                        AppError::Ssh(format!(
                            "跳板机 {} 连接失败：{}",
                            jump.host,
                            strip_ssh_prefix(&e.to_string())
                        ))
                    })?;

                Some(Arc::new(TokioMutex::new(jh)))
            } else {
                None
            };

        // ── Target hop ───────────────────────────────────────────────────
        let via_jump = jump_handle.is_some();
        let mut handle = if let Some(ref jh) = jump_handle {
            let jump_guard = jh.lock().await;
            let channel = jump_guard
                .channel_open_direct_tcpip(
                    host.as_str(),
                    port as u32,
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| {
                    AppError::Ssh(format!(
                        "跳板机隧道到 {}:{} 失败：{}",
                        host, port, e
                    ))
                })?;
            drop(jump_guard);

            let stream = channel.into_stream();
            self.ssh_handshake_stream(
                client_config,
                stream,
                &host,
                port,
                config.trust_new_host_key,
                &app,
                "target",
            )
            .await
            .map_err(|e| map_target_err(e, &host, true))?
        } else {
            self.ssh_handshake(
                client_config,
                &host,
                port,
                config.trust_new_host_key,
                &app,
                "target",
            )
            .await
            .map_err(|e| map_target_err(e, &host, false))?
        };

        Self::authenticate(&mut handle, &username, &config.auth_method)
            .await
            .map_err(|e| map_target_err(e, &host, via_jump))?;

        // Open session channel
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Ssh(format!("打开会话通道失败: {}", e)))?;

        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .map_err(|e| AppError::Ssh(format!("分配 PTY 失败: {}", e)))?;

        channel
            .request_shell(false)
            .await
            .map_err(|e| AppError::Ssh(format!("启动 shell 失败: {}", e)))?;

        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<SessionCommand>();
        let shared_handle = Arc::new(TokioMutex::new(handle));

        let generation = {
            let mut gens = self.generations.write().await;
            let g = gens.get(&session_id).copied().unwrap_or(0) + 1;
            gens.insert(session_id.clone(), g);
            g
        };

        let connection = Arc::new(SshConnection {
            id: session_id.clone(),
            host: host.clone(),
            port,
            username: username.clone(),
            connection_id,
            generation,
            cmd_tx,
            handle: shared_handle.clone(),
            jump_handle,
        });

        self.connections
            .write()
            .await
            .insert(session_id.clone(), connection);

        emit_event(
            &app,
            &format!("ssh://status/{}", session_id),
            SshStatus::Connected,
        );

        let sid = session_id.clone();
        let app_clone = app.clone();
        let manager_connections = self.connections.clone();
        tokio::spawn(async move {
            let reason = session::drive_session(
                sid.clone(),
                channel,
                shared_handle.clone(),
                cmd_rx,
                app_clone.clone(),
            )
            .await;
            let mut guard = manager_connections.write().await;
            let dominated = guard.get(&sid).map_or(true, |c| c.generation == generation);
            if dominated {
                guard.remove(&sid);
                drop(guard);
                let _ = app_clone.emit(
                    &format!("ssh://status/{}", sid),
                    SshStatus::Disconnected { reason },
                );
                log::info!("SSH session {} cleaned up", sid);
            } else {
                log::info!(
                    "SSH session {} stale driver exited (gen {} vs current), skipping cleanup",
                    sid,
                    generation
                );
            }
        });

        Ok(())
    }

    /// TCP connect + SSH handshake to `host:port` with host-key verification.
    async fn ssh_handshake(
        &self,
        client_config: Arc<client::Config>,
        host: &str,
        port: u16,
        trust_new: bool,
        app: &AppHandle,
        role: &str,
    ) -> Result<client::Handle<Client>, AppError> {
        let verdict = Arc::new(TokioMutex::new(None));
        let tofu_record_error = Arc::new(TokioMutex::new(None));
        let client = Client {
            host: host.to_string(),
            port,
            store: self.known_hosts.clone(),
            trust_new,
            verdict: verdict.clone(),
            tofu_record_error: tofu_record_error.clone(),
        };
        let handle = match client::connect(client_config, (host, port), client).await {
            Ok(h) => h,
            Err(e) => {
                let v = verdict.lock().await.take();
                if let Some(VerifyOutcome::Mismatch { stored, presented }) = v {
                    return Err(AppError::HostKeyMismatch {
                        host: host.to_string(),
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
        Self::emit_tofu_warning(app, host, port, tofu_record_error, role).await;
        Ok(handle)
    }

    /// SSH handshake over an existing stream (e.g. jump tunnel).
    async fn ssh_handshake_stream<R>(
        &self,
        client_config: Arc<client::Config>,
        stream: R,
        host: &str,
        port: u16,
        trust_new: bool,
        app: &AppHandle,
        role: &str,
    ) -> Result<client::Handle<Client>, AppError>
    where
        R: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let verdict = Arc::new(TokioMutex::new(None));
        let tofu_record_error = Arc::new(TokioMutex::new(None));
        let client = Client {
            host: host.to_string(),
            port,
            store: self.known_hosts.clone(),
            trust_new,
            verdict: verdict.clone(),
            tofu_record_error: tofu_record_error.clone(),
        };
        let handle = match client::connect_stream(client_config, stream, client).await {
            Ok(h) => h,
            Err(e) => {
                let v = verdict.lock().await.take();
                if let Some(VerifyOutcome::Mismatch { stored, presented }) = v {
                    return Err(AppError::HostKeyMismatch {
                        host: host.to_string(),
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
        Self::emit_tofu_warning(app, host, port, tofu_record_error, role).await;
        Ok(handle)
    }

    async fn emit_tofu_warning(
        app: &AppHandle,
        host: &str,
        port: u16,
        tofu_record_error: Arc<TokioMutex<Option<String>>>,
        _role: &str,
    ) {
        if let Some(err_msg) = tofu_record_error.lock().await.take() {
            log::warn!("主机密钥未持久化 {}: {} — {}", host, port, err_msg);
            emit_event(
                app,
                "hostKeyWarning",
                serde_json::json!({
                    "host": host,
                    "port": port,
                    "reason": err_msg,
                    "message": "主机密钥未能持久化，本次连接安全但不保证未来能检测密钥变更，请检查配置目录可写性"
                }),
            );
        }
    }

    async fn authenticate(
        handle: &mut client::Handle<Client>,
        username: &str,
        auth_method: &AuthMethod,
    ) -> Result<(), AppError> {
        let auth_success = match auth_method {
            AuthMethod::Password { password } => handle
                .authenticate_password(username, password)
                .await
                .map_err(|e| AppError::Ssh(format!("密码认证错误: {}", e)))?,
            AuthMethod::PrivateKey {
                key_path,
                passphrase,
            } => {
                let key = russh::keys::load_secret_key(key_path, passphrase.as_deref())
                    .map_err(|e| AppError::Ssh(format!("加载私钥失败: {}", e)))?;
                handle
                    .authenticate_publickey(
                        username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), None),
                    )
                    .await
                    .map_err(|e| AppError::Ssh(format!("密钥认证错误: {}", e)))?
            }
        };
        if !auth_success.success() {
            return Err(AppError::Ssh("认证失败：用户名或密码/密钥错误".into()));
        }
        Ok(())
    }

    /// Send input data to the session's shell channel.
    pub async fn send_input(&self, session_id: &str, data: &[u8]) -> Result<(), AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;
        conn.cmd_tx
            .send(SessionCommand::Input(data.to_vec()))
            .map_err(|_| AppError::Ssh("会话已断开".into()))?;
        Ok(())
    }

    /// Resize the PTY associated with a session.
    pub async fn resize(&self, session_id: &str, cols: u32, rows: u32) -> Result<(), AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;
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

    /// Get all session metadata in a single lock acquisition. Used by agent
    /// tools and template rendering to avoid multiple round-trips through
    /// the connections map.
    pub async fn get_session_info(&self, session_id: &str) -> Option<SessionInfo> {
        let guard = self.connections.read().await;
        guard.get(session_id).map(|c| SessionInfo {
            host: c.host.clone(),
            port: c.port,
            username: c.username.clone(),
            connection_id: c.connection_id.clone(),
        })
    }

    /// Execute a command on a separate exec channel (not the interactive PTY).
    /// Opens a new channel, runs the command, waits for output, and closes.
    /// This is used by Agent tool calls.
    ///
    /// Delegates to [`exec_command_timed`] with a 120-second default timeout
    /// to prevent infinite blocking when remote commands never exit.
    pub async fn exec_command(&self, session_id: &str, command: &str) -> Result<String, AppError> {
        let (output, was_timeout) = self
            .exec_command_timed(session_id, command, Duration::from_secs(120))
            .await?;
        if was_timeout {
            let preview = if command.len() > 80 {
                &command[..80]
            } else {
                command
            };
            return Err(AppError::Ssh(format!("命令在 120 秒后超时: {}", preview)));
        }
        Ok(output)
    }

    /// Execute a command with a timeout and stream output to the frontend.
    /// Emits `toolOutput` events on the given event channel per data chunk.
    pub async fn exec_command_streamed(
        &self,
        session_id: &str,
        command: &str,
        timeout: Duration,
        app: &AppHandle,
        event_name: &str,
        tool_call_id: &str,
    ) -> Result<(String, bool), AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

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

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let chunk = String::from_utf8_lossy(&data).to_string();
                            output.push_str(&chunk);
                            emit_event(
                                app,
                                &event_name,
                                &serde_json::json!({
                                    "type": "toolOutput",
                                    "toolCallId": tool_call_id,
                                    "chunk": chunk,
                                }),
                            );
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let chunk = String::from_utf8_lossy(&data).to_string();
                            output.push_str(&chunk);
                            emit_event(
                                app,
                                &event_name,
                                &serde_json::json!({
                                    "type": "toolOutput",
                                    "toolCallId": tool_call_id,
                                    "chunk": chunk,
                                }),
                            );
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                            break;
                        }
                        Some(ChannelMsg::ExitStatus { .. }) => {}
                        Some(_) => {}
                        None => break,
                    }
                }
                _ = &mut deadline => {
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
        Ok((output, false))
    }

    /// Execute a command with a timeout. Returns (output, was_timeout).
    /// If the timeout fires, the channel is closed and partial output is returned.
    pub async fn exec_command_timed(
        &self,
        session_id: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<(String, bool), AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

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

        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            output.push_str(&String::from_utf8_lossy(&data));
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            output.push_str(&String::from_utf8_lossy(&data));
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) => {
                            break;
                        }
                        Some(ChannelMsg::ExitStatus { .. }) => {}
                        Some(_) => {}
                        None => break,
                    }
                }
                _ = &mut deadline => {
                    // Best-effort channel shutdown. This stops waiting for the
                    // exec channel, but does not guarantee the remote process is killed.
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
        Ok((output, false))
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
        let conn = conn.ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

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
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SshStatus {
    Connected,
    Disconnected { reason: String },
    Error(String),
}

/// Snapshot of an SSH session's connection metadata. Returned by
/// [`SshManager::get_session_info`] for tools and template rendering that
/// need host/port/username in a single lookup.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub connection_id: Option<String>,
}

fn strip_ssh_prefix(msg: &str) -> String {
    const PREFIXES: &[&str] = &["SSH error: ", "SSH 错误: "];
    for p in PREFIXES {
        if let Some(rest) = msg.strip_prefix(p) {
            return rest.to_string();
        }
    }
    msg.to_string()
}

/// Map target-hop errors: preserve HostKeyMismatch; with jump, prefix
/// `目标服务器 {host}`；direct keeps legacy wording for compatibility.
fn map_target_err(e: AppError, host: &str, via_jump: bool) -> AppError {
    match e {
        AppError::HostKeyMismatch { .. } => e,
        other if via_jump => AppError::Ssh(format!(
            "目标服务器 {} 连接失败：{}",
            host,
            strip_ssh_prefix(&other.to_string())
        )),
        other => other,
    }
}
