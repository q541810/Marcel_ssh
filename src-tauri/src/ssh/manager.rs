use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::PrivateKeyWithHashAlg;
use russh::MethodKind;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::sync::{mpsc, Mutex as TokioMutex, RwLock};
use uuid::Uuid;

use crate::emit_event;
use crate::error::{AppError, KeyAuthCode};
use crate::ssh::auth::AuthMethod;
use crate::ssh::key_material;
use crate::ssh::key_store;
use crate::ssh::known_hosts::{KnownHostsStore, VerifyOutcome};

use super::client::Client;
use super::session::{self, SessionCommand, SshConnection};
use super::sftp_shared::{failed_before_send, session_unusable, Reap, SharedSlot, IDLE_EVICTION};

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
    /// 断连观察者：会话真正断开（driver cleanup 的 dominated 分支）时回调，
    /// 参数为 session_id。command_exec 管理器用它实现级联取消。
    disconnect_observers: Arc<RwLock<Vec<Arc<dyn Fn(&str) + Send + Sync>>>>,
    /// 会话激活顺序（新激活在队尾）。用于「同一 SavedConnection 多开时，
    /// 取最近激活的在线 session」——多机操控的目标解析需要。清理在
    /// [`Self::latest_active_session_for_connection`] 读取时惰性进行
    /// （不在线/已断开的条目留在队里但会被跳过，条目数受连接数上界约束）。
    activation_order: Arc<RwLock<std::collections::VecDeque<String>>>,
}

impl SshManager {
    /// Construct a manager with an explicit known-hosts store. This is the
    /// preferred constructor; the application wires it up at startup.
    pub fn with_known_hosts(known_hosts: Arc<KnownHostsStore>) -> Self {
        Self {
            connections: Arc::new(RwLock::new(HashMap::new())),
            generations: Arc::new(RwLock::new(HashMap::new())),
            known_hosts,
            disconnect_observers: Arc::new(RwLock::new(Vec::new())),
            activation_order: Arc::new(RwLock::new(std::collections::VecDeque::new())),
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
        self.connect_inner(session_id.clone(), config, Some(app), false)
            .await?;
        Ok(session_id)
    }

    /// 建立**无头** SSH 连接：供 MCP 等外部入口使用。
    ///
    /// 与 [`Self::connect`] 的差别只有「没有界面」这一件事：
    /// - **不分配 PTY、不起终端驱动**——外部调用只需要 exec 通道与 SFTP，
    ///   不需要交互式 shell；
    /// - **不发 UI 事件**（状态、TOFU 告警）——没有窗口可收。
    ///
    /// **安全语义完全不变**：主机密钥照样校验（未知/不匹配都会拒绝），
    /// 认证走同一条 `authenticate`，跳板机走同一条隧道逻辑。
    /// 区别仅在「提醒谁」，不在「放不放行」。
    pub async fn connect_headless(&self, config: ConnectionConfig) -> Result<String, AppError> {
        let session_id = Uuid::new_v4().to_string();
        self.connect_inner(session_id.clone(), config, None, true)
            .await?;
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
        self.connect_inner(session_id, config, Some(app), false)
            .await
    }

    /// Shared connection logic for both fresh connects and reconnects.
    ///
    /// Validates the config, performs TCP+SSH handshake, authenticates, opens
    /// a shell channel with a PTY, inserts the connection into the manager
    /// (overwriting any stale entry for the same id), emits `Connected`, and
    /// spawns the driver task.
    ///
    /// `headless = true` 时跳过 PTY 与终端驱动（见 [`Self::connect_headless`]），
    /// 连接仍然登记进 `connections`，因此 exec 通道与 SFTP 照常可用。
    async fn connect_inner(
        &self,
        session_id: String,
        config: ConnectionConfig,
        app: Option<AppHandle>,
        headless: bool,
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
            config
                .jump
                .as_ref()
                .map(|j| format!("{}@{}:{}", j.username, j.host, j.port)),
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
                        app.as_ref(),
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
                    .map_err(|e| match e {
                        AppError::KeyAuth { .. } => e.for_jump(),
                        other => AppError::Ssh(format!(
                            "跳板机 {} 连接失败：{}",
                            jump.host,
                            strip_ssh_prefix(&other.to_string())
                        )),
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
                .channel_open_direct_tcpip(host.as_str(), port as u32, "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    AppError::Ssh(format!("跳板机隧道到 {}:{} 失败：{}", host, port, e))
                })?;
            drop(jump_guard);

            let stream = channel.into_stream();
            self.ssh_handshake_stream(
                client_config,
                stream,
                &host,
                port,
                config.trust_new_host_key,
                app.as_ref(),
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
                app.as_ref(),
                "target",
            )
            .await
            .map_err(|e| map_target_err(e, &host, false))?
        };

        Self::authenticate(&mut handle, &username, &config.auth_method)
            .await
            .map_err(|e| map_target_err(e, &host, via_jump))?;

        // 交互式终端通道。无头模式（MCP 等外部入口）**不需要**：外部调用只用
        // exec 通道与 SFTP 子系统，不分配 PTY 也就不必维持一个 shell 会话。
        // `handle` 在两种情况都留用——exec / SFTP 正是挂在它上面的。
        let channel = if headless {
            None
        } else {
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

            Some(channel)
        };

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
            headless,
            generation,
            cmd_tx,
            handle: shared_handle.clone(),
            jump_handle,
            sftp_meta: SharedSlot::new(),
        });

        self.connections
            .write()
            .await
            .insert(session_id.clone(), connection);

        // 记录激活顺序（队尾 = 最近激活）。多机目标解析「取最近激活在线会话」
        // 依赖它；重复激活同一会话不重复入队（保持队内唯一）。
        {
            let mut order = self.activation_order.write().await;
            order.retain(|sid| sid != &session_id);
            order.push_back(session_id.clone());
        }

        if let Some(app) = app.as_ref() {
            emit_event(
                app,
                &format!("ssh://status/{}", session_id),
                SshStatus::Connected,
            );
        }

        // 终端驱动：只有交互式连接才起。无头连接没有 PTY 通道可驱动，
        // 它的生命周期由调用方掌握（会话登记在 `connections` 里，
        // exec / SFTP 照常按 session_id 取用）。
        let Some(channel) = channel else {
            log::info!(
                "[无头] SSH 会话 {} 已建立（{}@{}:{}），未分配 PTY",
                session_id,
                username,
                host,
                port
            );
            return Ok(());
        };

        // 走到这里必然是有头连接（无头在上面已 return），因此 AppHandle 存在。
        // 终端驱动的每个输出 chunk 都要发事件，没有界面就没有驱动的意义。
        let Some(app_handle) = app else {
            log::warn!(
                "SSH 会话 {} 有 PTY 通道却没有 AppHandle，跳过终端驱动",
                session_id
            );
            return Ok(());
        };

        let sid = session_id.clone();
        let app_clone = app_handle.clone();
        let manager_connections = self.connections.clone();
        let manager_observers = self.disconnect_observers.clone();
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
                emit_event(
                    &app_clone,
                    &format!("ssh://status/{}", sid),
                    SshStatus::Disconnected { reason },
                );
                log::info!("SSH session {} cleaned up", sid);
                // 通知断连观察者（如 command_exec 管理器的级联取消）。
                // stale driver 不会走到这里，不会误触发。
                let observers = manager_observers.read().await.clone();
                for cb in observers {
                    cb(&sid);
                }
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

    /// 关闭一个无头会话（`connect_headless` 建的那些）。
    ///
    /// 有头会话的清理挂在终端驱动上（驱动退出即摘表）；无头会话没有驱动，
    /// 所以要在进程收尾时显式摘掉，避免 `connections` 里留着已经用不上的条目。
    /// 不存在的 id 视为已清理（幂等）。
    pub async fn disconnect_headless(&self, session_id: &str) {
        let removed = self.connections.write().await.remove(session_id);
        if let Some(conn) = removed {
            let _ = conn.cmd_tx.send(SessionCommand::Disconnect);
            {
                let mut order = self.activation_order.write().await;
                order.retain(|sid| sid != session_id);
            }
            log::info!("[无头] SSH 会话 {} 已关闭", session_id);
        }
    }

    /// TCP connect + SSH handshake to `host:port` with host-key verification.
    ///
    /// `app` 为 `None` = 无头模式：跳过 TOFU 的 UI 告警（主机密钥校验照常）。
    async fn ssh_handshake(
        &self,
        client_config: Arc<client::Config>,
        host: &str,
        port: u16,
        trust_new: bool,
        app: Option<&AppHandle>,
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
    ///
    /// `app` 为 `None` = 无头模式（同 [`Self::ssh_handshake`]）。
    async fn ssh_handshake_stream<R>(
        &self,
        client_config: Arc<client::Config>,
        stream: R,
        host: &str,
        port: u16,
        trust_new: bool,
        app: Option<&AppHandle>,
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

    /// TOFU 警告：密钥没能落盘时提醒用户。
    ///
    /// `app` 为 `None` = 无头模式（MCP 等外部调用入口）：**日志照记**，
    /// 但不发 UI 事件——没有界面可提醒。这不影响安全性：主机密钥的**校验**
    /// 始终发生（见 [`Client`] 的 `verify`），这里只是「记不下来」的告警。
    async fn emit_tofu_warning(
        app: Option<&AppHandle>,
        host: &str,
        port: u16,
        tofu_record_error: Arc<TokioMutex<Option<String>>>,
        _role: &str,
    ) {
        if let Some(err_msg) = tofu_record_error.lock().await.take() {
            log::warn!("主机密钥未持久化 {}: {} — {}", host, port, err_msg);
            if let Some(app) = app {
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
    }

    async fn authenticate(
        handle: &mut client::Handle<Client>,
        username: &str,
        auth_method: &AuthMethod,
    ) -> Result<(), AppError> {
        let auth_success = match auth_method {
            AuthMethod::Password { password } => {
                let first = handle
                    .authenticate_password(username, password)
                    .await
                    .map_err(|e| AppError::Ssh(format!("密码认证错误: {}", e)))?;
                match first {
                    // 有些服务器（serv00 等 FreeBSD 主机）关掉了 `password` 方法，只认
                    // `keyboard-interactive`——OpenSSH 客户端两种都会试，所以命令行能连、
                    // 我们只发 `password` 就被拒。服务器在拒绝时会列出还能用的方法，
                    // 列了就照 OpenSSH 的做法再用同一份密码走一遍键盘交互。
                    AuthResult::Failure {
                        remaining_methods, ..
                    } if remaining_methods.contains(&MethodKind::KeyboardInteractive) => {
                        Self::authenticate_keyboard_interactive(handle, username, password).await?
                    }
                    other => other.success(),
                }
            }
            AuthMethod::PrivateKey {
                key_id,
                key_path,
                passphrase,
            } => {
                // 私钥正文只在 Rust 侧出现：从密钥库解密，或按路径读文件（支持 `~`）。
                // 解析成内存里的 PEM 再解码，而不是把路径交给 load_secret_key——
                // 密钥库里的密文不是它能读的格式，而 Android 上的 content:// 更不是。
                let pem = key_store::resolve_pem(key_id.as_deref(), key_path.as_deref())?;
                let key = key_material::decode_pem(&pem, passphrase.as_deref())?;
                let key = Arc::new(key);
                // RSA 的签名哈希必须按服务器接受的来选：`None` 在 russh 里是旧式
                // ssh-rsa（SHA-1），OpenSSH 8.8+ 默认已不收，会被笼统地拒成"密钥被拒"。
                // 其他类型的密钥忽略哈希参数，只试一次。
                let candidates: Vec<Option<russh::keys::HashAlg>> = if key.algorithm().is_rsa() {
                    rsa_hash_candidates(
                        handle
                            .best_supported_rsa_hash()
                            .await
                            .map_err(|e| AppError::Ssh(format!("密钥认证错误: {}", e)))?,
                    )
                } else {
                    vec![None]
                };
                let mut ok = false;
                for hash in candidates {
                    let result = handle
                        .authenticate_publickey(
                            username,
                            PrivateKeyWithHashAlg::new(key.clone(), hash),
                        )
                        .await
                        .map_err(|e| AppError::Ssh(format!("密钥认证错误: {}", e)))?;
                    if result.success() {
                        ok = true;
                        break;
                    }
                }
                ok
            }
        };
        if !auth_success {
            // 区分两次失败：密码被拒不等于密钥被拒，能照做的下一步完全不同。
            //
            // 两条都走**结构化原因码**（前端只认 `data.code`，中文字面量一律不作判据）：
            // `Rejected` 在私钥路径里是"这把密钥被拒"，在密码路径里是"这份密码被拒"——
            // 前端在各自流程里读同一个码、做各自该做的事：密码被拒要重新追问并覆盖密钥链
            // 里那份打错的（`src/lib/privateKey.ts` 的 `isPasswordRejected`）。压成字符串
            // 就等于把复问的机会丢掉，那份错密码会被永久重放。
            return Err(match auth_method {
                AuthMethod::Password { .. } => AppError::KeyAuth {
                    code: KeyAuthCode::Rejected,
                    message: "认证失败：用户名或密码错误".into(),
                },
                AuthMethod::PrivateKey { .. } => AppError::KeyAuth {
                    code: KeyAuthCode::Rejected,
                    message: "服务器拒绝了这把密钥。请确认它对应的公钥已加到服务器的 authorized_keys 里、用户名正确；如果你最近换过密钥文件，请在连接设置里重新导入——应用用的可能是导入时那份。"
                        .into(),
                },
            });
        }
        Ok(())
    }

    /// 用同一份密码走 keyboard-interactive：服务器每问一轮（`InfoRequest`），
    /// 就给每个提示填这份密码。轮数封顶，防止恶意/异常服务器无限追问。
    async fn authenticate_keyboard_interactive(
        handle: &mut client::Handle<Client>,
        username: &str,
        password: &str,
    ) -> Result<bool, AppError> {
        const MAX_ROUNDS: usize = 4;
        let to_err = |e: russh::Error| AppError::Ssh(format!("密码认证错误: {}", e));
        let mut response = handle
            .authenticate_keyboard_interactive_start(username, None)
            .await
            .map_err(to_err)?;
        for _ in 0..MAX_ROUNDS {
            match response {
                KeyboardInteractiveAuthResponse::Success => return Ok(true),
                KeyboardInteractiveAuthResponse::Failure { .. } => return Ok(false),
                KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                    let answers = prompts.iter().map(|_| password.to_string()).collect();
                    response = handle
                        .authenticate_keyboard_interactive_respond(answers)
                        .await
                        .map_err(to_err)?;
                }
            }
        }
        Ok(matches!(response, KeyboardInteractiveAuthResponse::Success))
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

    /// List active session IDs（用户可见的会话）。
    ///
    /// **不含无头会话**（MCP 无头连接、跨设备同步的 SFTP 连接）：这个列表是前端与插件 API
    /// 回答「现在开着哪些终端」用的，后台连接不该混进去。要看全部连接用 `get_connection`
    /// 按 id 查，或 `sessions_for_connection`。
    pub async fn list_sessions(&self) -> Vec<String> {
        self.connections
            .read()
            .await
            .iter()
            .filter(|(_, c)| !c.headless)
            .map(|(id, _)| id.clone())
            .collect()
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

    /// Get the live connection handle for a session (shared Arc).
    /// Used by the command_exec executor to open dedicated exec channels.
    pub async fn get_connection(&self, session_id: &str) -> Option<Arc<SshConnection>> {
        self.connections.read().await.get(session_id).cloned()
    }

    /// 列出某 SavedConnection（config_id）当前**在线**的全部 session id。
    /// 多机操控按机器定位目标会话用；同机多开时由
    /// [`Self::latest_active_session_for_connection`] 决定取哪一个。
    pub async fn sessions_for_connection(&self, connection_id: &str) -> Vec<String> {
        let guard = self.connections.read().await;
        let mut ids: Vec<String> = guard
            .iter()
            .filter(|(_, c)| c.connection_id.as_deref() == Some(connection_id))
            .map(|(sid, _)| sid.clone())
            .collect();
        drop(guard);
        // 稳定顺序：按激活先后（早激活在前）。
        let order = self.activation_order.read().await;
        ids.sort_by_key(|sid| order.iter().position(|s| s == sid).unwrap_or(usize::MAX));
        ids
    }

    /// 取某 SavedConnection 最近激活的**在线** session（队尾方向第一个在线）。
    /// 全部离线/不存在 → None。断开的条目（不在 connections 里）被跳过。
    pub async fn latest_active_session_for_connection(
        &self,
        connection_id: &str,
    ) -> Option<String> {
        let conns = self.connections.read().await;
        let order = self.activation_order.read().await;
        for sid in order.iter().rev() {
            if let Some(c) = conns.get(sid) {
                if c.connection_id.as_deref() == Some(connection_id) {
                    return Some(sid.clone());
                }
            }
        }
        None
    }

    /// Whether `session_id` currently has a connection of the given
    /// generation. Used by the executor to distinguish "channel ended
    /// normally" from "the connection itself died"（reconnect 会换代，
    /// 旧代连接的通道以 None 结束时据此判定断连）.
    pub async fn is_generation_active(&self, session_id: &str, generation: u64) -> bool {
        self.connections
            .read()
            .await
            .get(session_id)
            .map_or(false, |c| c.generation == generation)
    }

    /// 注册断连观察者：会话真正断开（driver cleanup 的 dominated 分支，
    /// 含主动 disconnect 与远端断开）时以 session_id 回调。观察者内不应
    /// 阻塞（需要异步工作时自行 spawn）。
    pub async fn register_disconnect_observer(&self, cb: Arc<dyn Fn(&str) + Send + Sync>) {
        self.disconnect_observers.write().await.push(cb);
    }

    /// Execute a command on a separate exec channel (not the interactive PTY).
    /// Opens a new channel, runs the command, waits for output, and closes.
    /// This is used by Agent tool calls.
    ///
    /// 兼容 shim：内部委托 [`crate::command_exec::executor::run_raw`]
    /// （不登记执行记录）。新代码请走
    /// [`crate::command_exec::CommandExecutionManager`]。
    pub async fn exec_command(&self, session_id: &str, command: &str) -> Result<String, AppError> {
        let (output, was_timeout) = self
            .exec_command_timed(session_id, command, Duration::from_secs(120))
            .await?;
        if was_timeout {
            let preview = crate::command_exec::executor::timeout_preview(command);
            return Err(AppError::Ssh(format!("命令在 120 秒后超时: {}", preview)));
        }
        Ok(output)
    }

    /// Execute a command with a timeout and stream output to the frontend.
    /// Emits `toolOutput` events on the given event channel per data chunk.
    ///
    /// 兼容 shim：内部委托 [`crate::command_exec::executor::run_raw`]。
    pub async fn exec_command_streamed(
        &self,
        session_id: &str,
        command: &str,
        timeout: Duration,
        app: &AppHandle,
        event_name: &str,
        tool_call_id: &str,
    ) -> Result<(String, bool), AppError> {
        let outcome = crate::command_exec::executor::run_raw(
            self,
            session_id,
            command,
            timeout,
            Some((app, event_name, tool_call_id)),
            String::new(),
            None,
        )
        .await?;
        Ok(match outcome {
            crate::command_exec::executor::ExecOutcome::Completed { output, .. } => (output, false),
            crate::command_exec::executor::ExecOutcome::TimedOut { output } => (output, true),
            // 兼容 shim 不接取消信号，Cancelled 不可达。
            crate::command_exec::executor::ExecOutcome::Cancelled { .. } => (String::new(), false),
        })
    }

    /// Execute a command with a timeout. Returns (output, was_timeout).
    /// If the timeout fires, the channel is closed and partial output is returned.
    ///
    /// 兼容 shim：内部委托 [`crate::command_exec::executor::run_raw`]。
    pub async fn exec_command_timed(
        &self,
        session_id: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<(String, bool), AppError> {
        let outcome = crate::command_exec::executor::run_raw(
            self,
            session_id,
            command,
            timeout,
            None,
            String::new(),
            None,
        )
        .await?;
        Ok(match outcome {
            crate::command_exec::executor::ExecOutcome::Completed { output, .. } => (output, false),
            crate::command_exec::executor::ExecOutcome::TimedOut { output } => (output, true),
            crate::command_exec::executor::ExecOutcome::Cancelled { .. } => (String::new(), false),
        })
    }

    /// Open an SFTP session on a dedicated subsystem channel.
    /// Returns a `SftpSession` that can be used for file operations.
    ///
    /// 独占一条通道：上传 / 下载 / 读写文件正文用它，互不挤占。短小的元数据操作
    /// （列目录、建目录、重命名、删除、取 mtime）走 [`Self::with_shared_sftp`]，
    /// 复用同一条连接上的一条会话。
    pub async fn open_sftp(
        &self,
        session_id: &str,
    ) -> Result<russh_sftp::client::SftpSession, AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;
        open_sftp_on(&conn.handle).await
    }

    /// 打开一条**独占通道**的裸 SFTP 会话（`RawSftpSession`），并完成协议
    /// 初始化与 `limits@openssh.com` 协商。下载预取用它按 offset 并发发 READ
    /// （高层 `fs::File` 的读是串行的，一个 RTT 一个块）；返回会话与协商出的
    /// 单请求读块上限（无 limits 扩展时按 `fs::File` 同口径退回
    /// `max_packet_len - 9`）。正文传输专用，不占元数据共享会话。
    pub async fn open_sftp_raw(
        &self,
        session_id: &str,
    ) -> Result<(russh_sftp::client::RawSftpSession, u32), AppError> {
        let conn = {
            let guard = self.connections.read().await;
            guard.get(session_id).cloned()
        };
        let conn = conn.ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;
        open_sftp_raw_on(&conn.handle).await
    }

    /// 在这条连接的**共享元数据 SFTP 会话**上执行一次短操作（见 `sftp_shared`）。
    ///
    /// - 外层 `Err` = 拿不到会话（连接不存在、开通道 / 握手失败）；
    /// - 内层 `Err` = 会话上的操作本身失败，由调用方按各自文案翻成 `AppError`。
    ///
    /// 会话在请求发出**之前**就已失效（对端关了子系统通道、空闲回收的竞态）时，丢弃
    /// 它并换新会话重试一次；请求发出之后的失败不重试（结果未知），但会丢掉缓存。
    /// `op` 可能被调用两次，所以要能重入：把需要的数据在闭包里 clone。
    pub async fn with_shared_sftp<T, F, Fut>(
        &self,
        session_id: &str,
        mut op: F,
    ) -> Result<Result<T, russh_sftp::client::error::Error>, AppError>
    where
        F: FnMut(Arc<russh_sftp::client::SftpSession>) -> Fut,
        Fut: std::future::Future<Output = Result<T, russh_sftp::client::error::Error>>,
    {
        let conn = self
            .get_connection(session_id)
            .await
            .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

        let mut retried = false;
        loop {
            let lease = conn
                .sftp_meta
                .get_or_create(|| open_sftp_on(&conn.handle))
                .await?;
            if lease.created {
                spawn_sftp_reaper(&conn, lease.epoch);
            }
            match op(lease.value.clone()).await {
                Ok(value) => return Ok(Ok(value)),
                Err(error) if failed_before_send(&error) && !retried => {
                    log::info!(
                        "会话 {} 的共享 SFTP 通道已失效，换新会话重试一次",
                        session_id
                    );
                    conn.sftp_meta.invalidate(lease.epoch).await;
                    retried = true;
                }
                Err(error) => {
                    if session_unusable(&error) {
                        log::info!(
                            "会话 {} 的共享 SFTP 会话不可用，已丢弃: {}",
                            session_id,
                            error
                        );
                        conn.sftp_meta.invalidate(lease.epoch).await;
                    }
                    return Ok(Err(error));
                }
            }
        }
    }
}

/// 在一条已建立的 SSH 连接上开一条 SFTP 子系统通道并完成协议握手
/// （开通道 → 请求子系统 → SFTP init，三个往返）。
async fn open_sftp_on(
    handle: &TokioMutex<client::Handle<Client>>,
) -> Result<russh_sftp::client::SftpSession, AppError> {
    let channel = handle
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("打开 SFTP 通道失败: {}", e)))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Ssh(format!("请求 SFTP 子系统失败: {}", e)))?;

    russh_sftp::client::SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| AppError::Ssh(format!("初始化 SFTP 会话失败: {}", e)))
}

/// 与 [`open_sftp_on`] 同一条路，但构建裸会话并单独协商读块上限
/// （`SftpSession::new_with_config` 的启动序列逐句对齐，见其源码）。
async fn open_sftp_raw_on(
    handle: &TokioMutex<client::Handle<Client>>,
) -> Result<(russh_sftp::client::RawSftpSession, u32), AppError> {
    let channel = handle
        .lock()
        .await
        .channel_open_session()
        .await
        .map_err(|e| AppError::Ssh(format!("打开 SFTP 通道失败: {}", e)))?;

    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| AppError::Ssh(format!("请求 SFTP 子系统失败: {}", e)))?;

    let mut raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
    let version = raw
        .init()
        .await
        .map_err(|e| AppError::Ssh(format!("初始化 SFTP 会话失败: {}", e)))?;
    // fs::File 的读块口径：limits@openssh.com 的 read_len，否则 max_packet_len-9
    // （russh-sftp Config 默认 262144）。
    let mut max_read_len = 262144u64 - 9;
    if version
        .extensions
        .get("limits@openssh.com")
        .is_some_and(|v| v == "1")
    {
        match raw.limits().await {
            Ok(server_limits) => {
                if server_limits.max_read_len > 0 {
                    max_read_len = server_limits.max_read_len;
                }
                raw.set_limits(russh_sftp::client::rawsession::Limits::from(server_limits));
            }
            Err(e) => {
                // 协商失败只是拿不到服务器上限：按保守口径继续。
                log::warn!("SFTP limits 协商失败，读块按默认上限: {}", e);
            }
        }
    }
    Ok((raw, (max_read_len as u32).min(128 * 1024)))
}

/// 给刚创建的共享会话挂上空闲回收：闲置够久就释放服务器上的 `sftp-server` 进程
/// 与通道名额。每个世代恰好一个回收任务，世代被失效 / 回收后它自己结束；只持有
/// 连接的弱引用，不会让已断开的连接多活一刻。
fn spawn_sftp_reaper(conn: &Arc<SshConnection>, epoch: u64) {
    let weak = Arc::downgrade(conn);
    tokio::spawn(async move {
        let mut wait = IDLE_EVICTION;
        loop {
            tokio::time::sleep(wait).await;
            let Some(conn) = weak.upgrade() else { return };
            match conn.sftp_meta.reap(epoch, IDLE_EVICTION).await {
                Reap::Gone => return,
                Reap::Wait(next) => wait = next,
            }
        }
    });
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
///
/// 带跳板机时**必须**把 `KeyAuth` 的原因码原样带着走（只改写文案）：原因码是前端
/// 决定"要不要重新追问密码 / 私钥密码"的唯一依据，被压成 `AppError::Ssh` 字符串后
/// 保存的错凭据就再也不会被追问了。
fn map_target_err(e: AppError, host: &str, via_jump: bool) -> AppError {
    match e {
        AppError::HostKeyMismatch { .. } => e,
        AppError::KeyAuth { code, message } if via_jump => AppError::KeyAuth {
            code,
            message: format!("目标服务器 {} 认证失败：{}", host, message),
        },
        other if via_jump => AppError::Ssh(format!(
            "目标服务器 {} 连接失败：{}",
            host,
            strip_ssh_prefix(&other.to_string())
        )),
        other => other,
    }
}

/// RSA 私钥认证要依次尝试的签名哈希。
///
/// `best_supported_rsa_hash` 的三种返回：`Some(h)` = 服务器经 server-sig-algs（RFC 8308）
/// 声明了偏好，直接用；`None` = 服务器没发这个扩展（老服务器），按
/// rsa-sha2-512 → rsa-sha2-256 → ssh-rsa(SHA-1) 逐个试。声明了偏好但被拒时同样兜底到
/// 其余两种，避免扩展信息不准导致误拒。
fn rsa_hash_candidates(
    best: Option<Option<russh::keys::HashAlg>>,
) -> Vec<Option<russh::keys::HashAlg>> {
    use russh::keys::HashAlg;
    let mut list = Vec::with_capacity(3);
    if let Some(preferred) = best {
        list.push(preferred);
    }
    for h in [Some(HashAlg::Sha512), Some(HashAlg::Sha256), None] {
        if !list.contains(&h) {
            list.push(h);
        }
    }
    list
}

#[cfg(test)]
mod rsa_hash_tests {
    use super::rsa_hash_candidates;
    use russh::keys::HashAlg;

    #[test]
    fn 服务器声明偏好时优先用它() {
        let l = rsa_hash_candidates(Some(Some(HashAlg::Sha256)));
        assert_eq!(l, vec![Some(HashAlg::Sha256), Some(HashAlg::Sha512), None]);
    }

    #[test]
    fn 没有扩展时先试_sha2_最后才是_sha1() {
        let l = rsa_hash_candidates(None);
        assert_eq!(l, vec![Some(HashAlg::Sha512), Some(HashAlg::Sha256), None]);
    }

    #[test]
    fn 服务器只接受_sha1_时不重复() {
        let l = rsa_hash_candidates(Some(None));
        assert_eq!(l, vec![None, Some(HashAlg::Sha512), Some(HashAlg::Sha256)]);
    }
}

#[cfg(test)]
impl SshManager {
    /// 测试专用：把 `session_id` 登记成"已连接"。背后是一条内存回环到最小 sshd
    /// 的真实 russh 连接，让需要"会话在册"的上层流程（比如主任务的"出生即孤儿"
    /// 检查）不依赖网络也能跑通。连接上不开任何通道，也不会真的执行命令。
    pub(crate) async fn register_loopback_session(&self, session_id: &str) {
        self.register_loopback_session_as(session_id, false).await;
    }

    /// 同 [`Self::register_loopback_session`]，可指定是否登记成无头会话。
    pub(crate) async fn register_loopback_session_as(&self, session_id: &str, headless: bool) {
        struct MinimalSshd;
        impl russh::server::Handler for MinimalSshd {
            type Error = russh::Error;

            async fn auth_none(&mut self, _: &str) -> Result<russh::server::Auth, Self::Error> {
                Ok(russh::server::Auth::Accept)
            }
        }

        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let key = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[11; 32]);
        let config = russh::server::Config {
            keys: vec![key.into()],
            ..Default::default()
        };
        tokio::spawn(async move {
            if let Ok(session) =
                russh::server::run_stream(Arc::new(config), server_io, MinimalSshd).await
            {
                let _ = session.await;
            }
        });
        let client = Client {
            host: "127.0.0.1".into(),
            port: 22,
            store: KnownHostsStore::in_memory(),
            trust_new: true,
            verdict: Arc::new(TokioMutex::new(None)),
            tofu_record_error: Arc::new(TokioMutex::new(None)),
        };
        let mut handle =
            client::connect_stream(Arc::new(client::Config::default()), client_io, client)
                .await
                .expect("loopback sshd handshake");
        assert!(handle
            .authenticate_none("tester")
            .await
            .expect("loopback auth")
            .success());
        let (cmd_tx, _cmd_rx) = mpsc::unbounded_channel();
        self.connections.write().await.insert(
            session_id.to_string(),
            Arc::new(SshConnection {
                id: session_id.to_string(),
                host: "127.0.0.1".into(),
                port: 22,
                username: "tester".into(),
                connection_id: None,
                headless,
                generation: 1,
                cmd_tx,
                handle: Arc::new(TokioMutex::new(handle)),
                jump_handle: None,
                sftp_meta: SharedSlot::new(),
            }),
        );
    }

    /// 测试专用：登记一条**带 SFTP 子系统**的回环会话，每开一条 SFTP 通道就用 `make_fs()` 造一个
    /// 服务端文件系统处理器。跨设备同步的 SFTP 存储适配器用它对着一个内存文件系统跑端到端测试。
    ///
    /// `closers` 收集每条 SFTP 通道的关闭手柄：测试调 `handle.close(channel_id)` 就能模拟「对端把
    /// 通道关了」（连接本身还在册、但已不可用）。
    pub(crate) async fn register_loopback_sftp_session<H, F>(
        &self,
        session_id: &str,
        make_fs: F,
        closers: Arc<std::sync::Mutex<Vec<(russh::server::Handle, russh::ChannelId)>>>,
    ) where
        H: russh_sftp::server::Handler + Send + 'static,
        F: Fn() -> H + Send + Sync + 'static,
    {
        use russh::server::{Auth, Msg, Session as ServerSession};
        use russh::{Channel, ChannelId};

        struct Peer<H, F> {
            make_fs: Arc<F>,
            pending: HashMap<ChannelId, Channel<Msg>>,
            closers: Arc<std::sync::Mutex<Vec<(russh::server::Handle, ChannelId)>>>,
            _handler: std::marker::PhantomData<fn() -> H>,
        }

        impl<H, F> russh::server::Handler for Peer<H, F>
        where
            H: russh_sftp::server::Handler + Send + 'static,
            F: Fn() -> H + Send + Sync + 'static,
        {
            type Error = russh::Error;

            async fn auth_none(&mut self, _: &str) -> Result<Auth, Self::Error> {
                Ok(Auth::Accept)
            }

            async fn channel_open_session(
                &mut self,
                channel: Channel<Msg>,
                _: &mut ServerSession,
            ) -> Result<bool, Self::Error> {
                self.pending.insert(channel.id(), channel);
                Ok(true)
            }

            async fn subsystem_request(
                &mut self,
                channel_id: ChannelId,
                name: &str,
                session: &mut ServerSession,
            ) -> Result<(), Self::Error> {
                let Some(channel) = self.pending.remove(&channel_id).filter(|_| name == "sftp")
                else {
                    session.channel_failure(channel_id)?;
                    return Ok(());
                };
                session.channel_success(channel_id)?;
                self.closers
                    .lock()
                    .unwrap()
                    .push((session.handle(), channel_id));
                russh_sftp::server::run(channel.into_stream(), (self.make_fs)()).await;
                Ok(())
            }
        }

        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let key = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[13; 32]);
        let config = russh::server::Config {
            keys: vec![key.into()],
            ..Default::default()
        };
        let peer = Peer {
            make_fs: Arc::new(make_fs),
            pending: HashMap::new(),
            closers,
            _handler: std::marker::PhantomData,
        };
        tokio::spawn(async move {
            if let Ok(session) = russh::server::run_stream(Arc::new(config), server_io, peer).await
            {
                let _ = session.await;
            }
        });
        let client = Client {
            host: "127.0.0.1".into(),
            port: 22,
            store: KnownHostsStore::in_memory(),
            trust_new: true,
            verdict: Arc::new(TokioMutex::new(None)),
            tofu_record_error: Arc::new(TokioMutex::new(None)),
        };
        let mut handle =
            client::connect_stream(Arc::new(client::Config::default()), client_io, client)
                .await
                .expect("loopback sftp sshd handshake");
        assert!(handle
            .authenticate_none("tester")
            .await
            .expect("loopback auth")
            .success());
        let (cmd_tx, _cmd_rx) = mpsc::unbounded_channel();
        self.connections.write().await.insert(
            session_id.to_string(),
            Arc::new(SshConnection {
                id: session_id.to_string(),
                host: "127.0.0.1".into(),
                port: 22,
                username: "tester".into(),
                connection_id: None,
                headless: true,
                generation: 1,
                cmd_tx,
                handle: Arc::new(TokioMutex::new(handle)),
                jump_handle: None,
                sftp_meta: SharedSlot::new(),
            }),
        );
    }
}

/// `with_shared_sftp` 的端到端测试：回环 sshd（支持 `sftp` 子系统）+ 真实的
/// `SshManager` / `SshConnection`，数服务器上实际开了几条 SFTP 通道。
#[cfg(test)]
mod shared_sftp_tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use russh::server::{self, Auth, Msg, Session};
    use russh::{Channel, ChannelId};
    use russh_sftp::protocol::{Attrs, File, FileAttributes, Handle, Name, Status, StatusCode};

    use super::*;

    #[derive(Default)]
    struct Sshd {
        /// 服务器上累计开过的 SFTP 子系统通道数。
        sftp_channels: AtomicUsize,
        /// 每条 SFTP 通道的关闭手柄（测试用来模拟对端把通道关掉）。
        closers: std::sync::Mutex<Vec<(server::Handle, ChannelId)>>,
    }

    struct Peer {
        sshd: Arc<Sshd>,
        pending: HashMap<ChannelId, Channel<Msg>>,
    }

    impl server::Handler for Peer {
        type Error = russh::Error;

        async fn auth_none(&mut self, _: &str) -> Result<Auth, Self::Error> {
            Ok(Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            channel: Channel<Msg>,
            _: &mut Session,
        ) -> Result<bool, Self::Error> {
            self.pending.insert(channel.id(), channel);
            Ok(true)
        }

        async fn subsystem_request(
            &mut self,
            channel_id: ChannelId,
            name: &str,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            let Some(channel) = self.pending.remove(&channel_id).filter(|_| name == "sftp") else {
                session.channel_failure(channel_id)?;
                return Ok(());
            };
            session.channel_success(channel_id)?;
            self.sshd.sftp_channels.fetch_add(1, Ordering::SeqCst);
            self.sshd
                .closers
                .lock()
                .unwrap()
                .push((session.handle(), channel_id));
            russh_sftp::server::run(channel.into_stream(), Fs::default()).await;
            Ok(())
        }
    }

    /// 只会列目录的最小 SFTP 文件系统：`/` 下有 a.txt 和 sub，其它路径不存在。
    #[derive(Default)]
    struct Fs {
        next_handle: u32,
        drained: std::collections::HashSet<String>,
    }

    fn ok_status(id: u32) -> Status {
        Status {
            id,
            status_code: StatusCode::Ok,
            error_message: "Ok".into(),
            language_tag: "en-US".into(),
        }
    }

    impl russh_sftp::server::Handler for Fs {
        type Error = StatusCode;

        fn unimplemented(&self) -> Self::Error {
            StatusCode::OpUnsupported
        }

        async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
            if path != "/" {
                return Err(StatusCode::NoSuchFile);
            }
            // 每次 opendir 一个新句柄：同一目录可以反复列。
            self.next_handle += 1;
            Ok(Handle {
                id,
                handle: format!("dir-{}", self.next_handle),
            })
        }

        async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
            if !self.drained.insert(handle) {
                return Err(StatusCode::Eof);
            }
            Ok(Name {
                id,
                files: vec![File::dummy("a.txt"), File::dummy("sub")],
            })
        }

        async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
            Ok(ok_status(id))
        }

        async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
            if path == "/" {
                Ok(Attrs {
                    id,
                    attrs: FileAttributes::default(),
                })
            } else {
                Err(StatusCode::NoSuchFile)
            }
        }
    }

    /// 起回环 sshd，连上它，并把连接按 `s1` 登记进一个真实的 `SshManager`。
    async fn manager_with_sshd() -> (SshManager, Arc<Sshd>) {
        let sshd = Arc::new(Sshd::default());
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let key = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[9; 32]);
        let config = server::Config {
            keys: vec![key.into()],
            ..Default::default()
        };
        let peer = Peer {
            sshd: sshd.clone(),
            pending: HashMap::new(),
        };
        let server = tokio::spawn(async move {
            // 服务端会话要一直活着，测试结束随运行时一起收掉。
            let session = server::run_stream(Arc::new(config), server_io, peer)
                .await
                .unwrap();
            let _ = session.await;
        });
        let store = KnownHostsStore::in_memory();
        let client = Client {
            host: "127.0.0.1".into(),
            port: 22,
            store: store.clone(),
            trust_new: true,
            verdict: Arc::new(TokioMutex::new(None)),
            tofu_record_error: Arc::new(TokioMutex::new(None)),
        };
        let mut handle =
            client::connect_stream(Arc::new(client::Config::default()), client_io, client)
                .await
                .unwrap();
        assert!(handle.authenticate_none("tester").await.unwrap().success());
        drop(server);

        let manager = SshManager::with_known_hosts(store);
        register_connection(&manager, handle).await;
        (manager, sshd)
    }

    /// 把一条已认证的连接按 `s1` 登记进管理器。
    async fn register_connection(manager: &SshManager, handle: client::Handle<Client>) {
        let (cmd_tx, _cmd_rx) = mpsc::unbounded_channel();
        manager.connections.write().await.insert(
            "s1".into(),
            Arc::new(SshConnection {
                id: "s1".into(),
                host: "127.0.0.1".into(),
                port: 22,
                username: "tester".into(),
                connection_id: None,
                headless: false,
                generation: 1,
                cmd_tx,
                handle: Arc::new(TokioMutex::new(handle)),
                jump_handle: None,
                sftp_meta: SharedSlot::new(),
            }),
        );
    }

    /// 对外的会话列表（前端 / 插件 API 用）不含无头会话：跨设备同步的 SFTP 连接、MCP 无头连接
    /// 都是后台连接，混进「现在开着哪些终端」只会误导插件的 `session.active`。
    /// 无头会话本身仍然在册，按 id 取连接照常可用（同步的 SFTP 读写靠它）。
    #[tokio::test]
    async fn list_sessions_hides_headless_sessions_but_keeps_them_registered() {
        let manager = SshManager::with_known_hosts(KnownHostsStore::in_memory());
        manager.register_loopback_session_as("term", false).await;
        manager.register_loopback_session_as("bg", true).await;

        assert_eq!(manager.list_sessions().await, vec!["term".to_string()]);
        assert!(manager.is_connected("bg").await, "无头会话仍然在册");
        assert!(manager.get_connection("bg").await.is_some());
    }

    async fn list_root(
        manager: &SshManager,
    ) -> Result<Vec<String>, russh_sftp::client::error::Error> {
        manager
            .with_shared_sftp("s1", |sftp| async move {
                let dir = sftp.read_dir("/").await?;
                Ok(dir.map(|entry| entry.file_name()).collect())
            })
            .await
            .expect("拿得到会话")
    }

    #[tokio::test]
    async fn consecutive_operations_share_one_sftp_channel() {
        let (manager, sshd) = manager_with_sshd().await;
        for _ in 0..3 {
            assert_eq!(list_root(&manager).await.unwrap(), ["a.txt", "sub"]);
        }
        // 并发的几次也只用同一条。
        let (a, b, c) = tokio::join!(
            list_root(&manager),
            list_root(&manager),
            list_root(&manager)
        );
        assert!(a.is_ok() && b.is_ok() && c.is_ok());
        assert_eq!(
            sshd.sftp_channels.load(Ordering::SeqCst),
            1,
            "元数据操作应当复用同一条 SFTP 通道，而不是每次现开"
        );

        // 传输走独占通道：每次 open_sftp 仍然是新的一条。
        let dedicated = manager.open_sftp("s1").await.unwrap();
        assert_eq!(sshd.sftp_channels.load(Ordering::SeqCst), 2);
        drop(dedicated);
        assert!(list_root(&manager).await.is_ok());
        assert_eq!(
            sshd.sftp_channels.load(Ordering::SeqCst),
            2,
            "独占通道不影响共享会话"
        );
    }

    #[tokio::test]
    async fn a_channel_closed_by_the_server_is_replaced_transparently() {
        let (manager, sshd) = manager_with_sshd().await;
        assert!(list_root(&manager).await.is_ok());
        assert_eq!(sshd.sftp_channels.load(Ordering::SeqCst), 1);

        // 对端把共享通道关了（用户看不见的事），然后用户点了下一个目录。
        let (handle, channel_id) = sshd.closers.lock().unwrap()[0].clone();
        handle.close(channel_id).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;

        assert_eq!(
            list_root(&manager)
                .await
                .expect("请求发出前就失效：应当透明换新会话重试"),
            ["a.txt", "sub"]
        );
        assert_eq!(sshd.sftp_channels.load(Ordering::SeqCst), 2);
        // 换上的新会话继续被复用。
        assert!(list_root(&manager).await.is_ok());
        assert_eq!(sshd.sftp_channels.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_server_refusal_is_reported_and_keeps_the_session() {
        let (manager, sshd) = manager_with_sshd().await;
        let refused = manager
            .with_shared_sftp("s1", |sftp| async move { sftp.metadata("/missing").await })
            .await
            .expect("拿得到会话");
        assert!(matches!(
            refused,
            Err(russh_sftp::client::error::Error::Status(_))
        ));
        assert!(list_root(&manager).await.is_ok());
        assert_eq!(
            sshd.sftp_channels.load(Ordering::SeqCst),
            1,
            "服务器的正常拒绝（不存在 / 无权限）不该让缓存的会话作废"
        );
    }

    #[tokio::test]
    async fn an_unknown_session_is_reported_not_created() {
        let (manager, sshd) = manager_with_sshd().await;
        let result = manager
            .with_shared_sftp("nope", |sftp| async move { sftp.metadata("/").await })
            .await;
        assert!(matches!(result, Err(AppError::Ssh(message)) if message.contains("会话不存在")));
        assert_eq!(sshd.sftp_channels.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn an_idle_shared_session_is_released_and_rebuilt_on_demand() {
        let (manager, sshd) = manager_with_sshd().await;
        assert!(list_root(&manager).await.is_ok());
        assert_eq!(sshd.sftp_channels.load(Ordering::SeqCst), 1);

        // 闲置超过回收时间：回收任务释放共享会话（让出服务器上的通道名额）。
        tokio::time::advance(IDLE_EVICTION + Duration::from_secs(1)).await;
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }

        // 下一次使用时按需重建。
        assert!(list_root(&manager).await.is_ok());
        assert_eq!(sshd.sftp_channels.load(Ordering::SeqCst), 2);
    }

    /// 真机对照（默认不跑）：同一目录，「每次现开通道」对「复用共享会话」的单次耗时。
    ///
    /// ```text
    /// MARCEL_BENCH_HOST=<主机> MARCEL_BENCH_USER=<用户> MARCEL_BENCH_PASSWORD=<口令>     ///   cargo test --lib real_server_sftp_roundtrips -- --ignored --nocapture
    /// ```
    ///
    /// 可选：`MARCEL_BENCH_PORT`（默认 22）、`MARCEL_BENCH_DIR`（默认 `/`）、
    /// `MARCEL_BENCH_ROUNDS`（默认 30）。口令只从环境变量读，不打印、不落盘；只做
    /// 只读的列目录。两种做法交替执行，避免网络抖动偏向某一边。
    #[tokio::test]
    #[ignore = "需要真实服务器，见文档注释里的环境变量"]
    async fn real_server_sftp_roundtrips() {
        fn env(name: &str) -> Option<String> {
            std::env::var(name).ok().filter(|v| !v.is_empty())
        }
        let (Some(host), Some(user), Some(password)) = (
            env("MARCEL_BENCH_HOST"),
            env("MARCEL_BENCH_USER"),
            env("MARCEL_BENCH_PASSWORD"),
        ) else {
            panic!("需要设置 MARCEL_BENCH_HOST / MARCEL_BENCH_USER / MARCEL_BENCH_PASSWORD");
        };
        let port: u16 = env("MARCEL_BENCH_PORT")
            .and_then(|v| v.parse().ok())
            .unwrap_or(22);
        let dir = env("MARCEL_BENCH_DIR").unwrap_or_else(|| "/".into());
        let rounds: usize = env("MARCEL_BENCH_ROUNDS")
            .and_then(|v| v.parse().ok())
            .unwrap_or(30);

        let store = KnownHostsStore::in_memory();
        let client = Client {
            host: host.clone(),
            port,
            store: store.clone(),
            trust_new: true,
            verdict: Arc::new(TokioMutex::new(None)),
            tofu_record_error: Arc::new(TokioMutex::new(None)),
        };
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            (host.as_str(), port),
            client,
        )
        .await
        .expect("连接服务器");
        assert!(
            handle
                .authenticate_password(&user, &password)
                .await
                .expect("认证请求")
                .success(),
            "口令认证失败"
        );
        let manager = SshManager::with_known_hosts(store);
        register_connection(&manager, handle).await;

        let list = |manager: &SshManager, dir: String| {
            let manager = manager.clone();
            async move {
                manager
                    .with_shared_sftp("s1", |sftp| {
                        let dir = dir.clone();
                        async move {
                            let entries = sftp.read_dir(dir).await?;
                            Ok(entries.map(|e| e.file_name()).collect::<Vec<_>>())
                        }
                    })
                    .await
                    .expect("拿得到会话")
                    .expect("列目录")
            }
        };

        // 冷启动：第一次共享调用要付一次建会话的三个往返。
        let started = std::time::Instant::now();
        let shared_names = list(&manager, dir.clone()).await;
        let cold = started.elapsed();

        let mut dedicated_ms = Vec::new();
        let mut shared_ms = Vec::new();
        for _ in 0..rounds {
            let started = std::time::Instant::now();
            let sftp = manager.open_sftp("s1").await.expect("独占会话");
            let dedicated_names: Vec<String> = sftp
                .read_dir(dir.clone())
                .await
                .expect("列目录")
                .map(|e| e.file_name())
                .collect();
            dedicated_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            drop(sftp);
            assert_eq!(dedicated_names, shared_names, "两种做法列出的内容必须一致");

            let started = std::time::Instant::now();
            let names = list(&manager, dir.clone()).await;
            shared_ms.push(started.elapsed().as_secs_f64() * 1000.0);
            assert_eq!(names, shared_names);
        }

        // 一个往返的参照：共享会话上的一次 stat。
        let mut rtt_ms = Vec::new();
        for _ in 0..rounds {
            let started = std::time::Instant::now();
            let _ = manager
                .with_shared_sftp("s1", |sftp| async move { sftp.metadata("/").await })
                .await
                .expect("拿得到会话");
            rtt_ms.push(started.elapsed().as_secs_f64() * 1000.0);
        }

        fn stats(samples: &mut [f64]) -> (f64, f64, f64) {
            samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
            let at = |q: f64| samples[((samples.len() - 1) as f64 * q).round() as usize];
            (samples[0], at(0.5), at(0.95))
        }
        let (d_min, d_med, d_p95) = stats(&mut dedicated_ms);
        let (s_min, s_med, s_p95) = stats(&mut shared_ms);
        let (r_min, r_med, _) = stats(&mut rtt_ms);
        eprintln!(
            "目录 {dir}（{} 项），每种 {rounds} 次，单位 ms",
            shared_names.len()
        );
        eprintln!("  每次现开通道 : min {d_min:.1}  中位 {d_med:.1}  p95 {d_p95:.1}");
        eprintln!("  复用共享会话 : min {s_min:.1}  中位 {s_med:.1}  p95 {s_p95:.1}");
        eprintln!(
            "  共享会话首次（含建会话）: {:.1}",
            cold.as_secs_f64() * 1000.0
        );
        eprintln!("  单个往返参照（共享会话上的 stat）: min {r_min:.1}  中位 {r_med:.1}");
        eprintln!(
            "  中位数节省 {:.1} ms（{:.0}%）",
            d_med - s_med,
            (d_med - s_med) / d_med * 100.0
        );
    }
}

/// 只开 keyboard-interactive、关掉 `password` 方法的服务器（serv00 等 FreeBSD 主机的做法）：
/// 只发 `password` 会被拒，必须回退到键盘交互用同一份密码重试。
#[cfg(test)]
mod keyboard_interactive_tests {
    use std::borrow::Cow;

    use russh::server::{self, Auth, Response};
    use russh::MethodSet;

    use super::*;

    const PROMPTS: &[(Cow<'static, str>, bool)] = &[(Cow::Borrowed("Password: "), false)];

    struct KbdOnly;

    impl server::Handler for KbdOnly {
        type Error = russh::Error;

        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            _user: &str,
            _submethods: &str,
            response: Option<Response<'a>>,
        ) -> Result<Auth, Self::Error> {
            match response {
                None => Ok(Auth::Partial {
                    name: Cow::Borrowed(""),
                    instructions: Cow::Borrowed(""),
                    prompts: Cow::Borrowed(PROMPTS),
                }),
                Some(mut answers) => {
                    let ok = answers.next().is_some_and(|a| &a[..] == b"secret");
                    Ok(if ok { Auth::Accept } else { Auth::reject() })
                }
            }
        }
    }

    async fn connect() -> client::Handle<Client> {
        let (client_io, server_io) = tokio::io::duplex(64 * 1024);
        let key = russh::keys::ssh_key::private::Ed25519Keypair::from_seed(&[7; 32]);
        let config = server::Config {
            keys: vec![key.into()],
            methods: MethodSet::from(&[MethodKind::KeyboardInteractive][..]),
            ..Default::default()
        };
        tokio::spawn(async move {
            let session = server::run_stream(Arc::new(config), server_io, KbdOnly)
                .await
                .unwrap();
            let _ = session.await;
        });
        let client = Client {
            host: "127.0.0.1".into(),
            port: 22,
            store: KnownHostsStore::in_memory(),
            trust_new: true,
            verdict: Arc::new(TokioMutex::new(None)),
            tofu_record_error: Arc::new(TokioMutex::new(None)),
        };
        client::connect_stream(Arc::new(client::Config::default()), client_io, client)
            .await
            .unwrap()
    }

    fn password(p: &str) -> AuthMethod {
        AuthMethod::Password {
            password: p.to_string(),
        }
    }

    #[tokio::test]
    async fn password_falls_back_to_keyboard_interactive() {
        let mut handle = connect().await;
        SshManager::authenticate(&mut handle, "tester", &password("secret"))
            .await
            .expect("password 方法被关掉时应回退到 keyboard-interactive 并成功");
    }

    #[tokio::test]
    async fn wrong_password_is_still_reported_as_rejected() {
        let mut handle = connect().await;
        let err = SshManager::authenticate(&mut handle, "tester", &password("nope"))
            .await
            .expect_err("错误密码必须失败");
        assert!(
            matches!(
                err,
                AppError::KeyAuth {
                    code: KeyAuthCode::Rejected,
                    ..
                }
            ),
            "回退失败后仍要给出结构化的『密码被拒』，前端据此重新追问：{err:?}"
        );
    }
}
