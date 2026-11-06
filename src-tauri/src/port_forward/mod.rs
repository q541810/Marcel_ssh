//! SSH 本地端口转发（manager）：在本机 `127.0.0.1` 开一个入口，把连进来的流量经已建立的
//! SSH 连接送到服务器上的 `host:port`（等价于 `ssh -L`）。
//!
//! 设计要点：
//! - 转发绑在 **session_id** 上，而不是某条具体连接。会话掉线后重连沿用同一个 session_id
//!   （见 `SshManager::reconnect`），所以监听端口一直留着，重连成功后新来的连接自动恢复，
//!   用户不用重新开。
//! - 每来一个本机连接，才现取当前连接开一条 direct-tcpip 通道；不持有 `Handle`，
//!   所以不会拖住旧连接。
//! - 只绑 `127.0.0.1`：这是给用户自己用的入口，不对局域网/公网开放。
//! - 会话被用户主动关闭（`ssh_disconnect`）时由命令层调 [`PortForwardManager::stop_session`]
//!   统一释放；远端掉线不释放（等重连）。

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::AppHandle;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::watch;
use uuid::Uuid;

use crate::emit_event;
use crate::error::AppError;
use crate::ssh::connection::SshManager;

/// 转发列表变化事件名；payload 为 session_id。前端据此刷新面板。
pub const CHANGED_EVENT: &str = "port-forward://changed";

struct Entry {
    id: String,
    session_id: String,
    remote_host: String,
    remote_port: u16,
    local_port: u16,
    active_connections: AtomicU32,
    total_connections: AtomicU64,
    last_error: Mutex<Option<String>>,
    stop_tx: watch::Sender<bool>,
}

/// 给前端看的转发快照。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForwardInfo {
    pub id: String,
    pub session_id: String,
    pub remote_host: String,
    pub remote_port: u16,
    pub local_port: u16,
    /// 会话当前是否在线；离线时入口还在，重连后自动恢复。
    pub session_online: bool,
    pub active_connections: u32,
    pub total_connections: u64,
    /// 最近一次建立通道失败的原因；成功一次就清掉。
    pub last_error: Option<String>,
}

#[derive(Clone, Default)]
pub struct PortForwardManager {
    entries: Arc<Mutex<HashMap<String, Arc<Entry>>>>,
}

impl PortForwardManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 开一条转发。同一会话对同一目标重复开是幂等的（返回已有那条）。
    ///
    /// `local_port`：`None` = 优先用与服务器相同的端口号（很多网页会把端口写死在跳转地址里），
    /// 被占用或没权限再让系统挑一个；`Some(p)` = 用户明确指定，绑不上就报错，不偷偷换。
    pub async fn start(
        &self,
        app: &AppHandle,
        ssh: &SshManager,
        session_id: &str,
        remote_host: &str,
        remote_port: u16,
        local_port: Option<u16>,
    ) -> Result<ForwardInfo, AppError> {
        let remote_host = remote_host.trim();
        if remote_host.is_empty() {
            return Err(AppError::Ssh("目标地址不能为空".into()));
        }
        if remote_port == 0 {
            return Err(AppError::Ssh("目标端口不能为 0".into()));
        }
        if !ssh.is_connected(session_id).await {
            return Err(AppError::Ssh("会话未连接，无法开启端口转发".into()));
        }

        if let Some(existing) = self.find(session_id, remote_host, remote_port) {
            return Ok(self.snapshot(ssh, &existing).await);
        }

        let listener = bind_local(local_port, remote_port).await?;
        let actual_port = listener.local_addr()?.port();

        let (stop_tx, stop_rx) = watch::channel(false);
        let entry = Arc::new(Entry {
            id: Uuid::new_v4().to_string(),
            session_id: session_id.to_string(),
            remote_host: remote_host.to_string(),
            remote_port,
            local_port: actual_port,
            active_connections: AtomicU32::new(0),
            total_connections: AtomicU64::new(0),
            last_error: Mutex::new(None),
            stop_tx,
        });
        self.entries.lock().insert(entry.id.clone(), entry.clone());

        tokio::spawn(accept_loop(
            entry.clone(),
            listener,
            ssh.clone(),
            app.clone(),
            stop_rx,
        ));
        // 开通后立刻探一次目标：服务器禁了转发、目标端口没服务，当场就能告诉用户，
        // 而不是等浏览器打不开了才一脸懵。探测不阻塞返回。
        tokio::spawn(probe(entry.clone(), ssh.clone(), app.clone()));

        emit_event(app, CHANGED_EVENT, session_id);
        log::info!(
            "端口转发已开启：127.0.0.1:{} → {}:{}（会话 {}）",
            actual_port,
            remote_host,
            remote_port,
            session_id
        );
        Ok(self.snapshot(ssh, &entry).await)
    }

    pub fn stop(&self, app: &AppHandle, id: &str) -> bool {
        let removed = self.entries.lock().remove(id);
        match removed {
            Some(entry) => {
                let _ = entry.stop_tx.send(true);
                emit_event(app, CHANGED_EVENT, entry.session_id.as_str());
                true
            }
            None => false,
        }
    }

    /// 会话被用户关闭：释放它名下全部转发。
    pub fn stop_session(&self, app: &AppHandle, session_id: &str) {
        let removed: Vec<Arc<Entry>> = {
            let mut guard = self.entries.lock();
            let ids: Vec<String> = guard
                .iter()
                .filter(|(_, e)| e.session_id == session_id)
                .map(|(id, _)| id.clone())
                .collect();
            ids.iter().filter_map(|id| guard.remove(id)).collect()
        };
        if removed.is_empty() {
            return;
        }
        for entry in &removed {
            let _ = entry.stop_tx.send(true);
        }
        emit_event(app, CHANGED_EVENT, session_id);
    }

    pub async fn list(&self, ssh: &SshManager, session_id: &str) -> Vec<ForwardInfo> {
        let mut entries: Vec<Arc<Entry>> = self
            .entries
            .lock()
            .values()
            .filter(|e| e.session_id == session_id)
            .cloned()
            .collect();
        entries.sort_by_key(|e| (e.remote_port, e.local_port));
        let online = ssh.is_connected(session_id).await;
        entries.iter().map(|e| info_of(e, online)).collect()
    }

    fn find(&self, session_id: &str, host: &str, port: u16) -> Option<Arc<Entry>> {
        self.entries
            .lock()
            .values()
            .find(|e| e.session_id == session_id && e.remote_host == host && e.remote_port == port)
            .cloned()
    }

    async fn snapshot(&self, ssh: &SshManager, entry: &Entry) -> ForwardInfo {
        info_of(entry, ssh.is_connected(&entry.session_id).await)
    }
}

fn info_of(entry: &Entry, online: bool) -> ForwardInfo {
    ForwardInfo {
        id: entry.id.clone(),
        session_id: entry.session_id.clone(),
        remote_host: entry.remote_host.clone(),
        remote_port: entry.remote_port,
        local_port: entry.local_port,
        session_online: online,
        active_connections: entry.active_connections.load(Ordering::Relaxed),
        total_connections: entry.total_connections.load(Ordering::Relaxed),
        last_error: entry.last_error.lock().clone(),
    }
}

async fn bind_local(requested: Option<u16>, remote_port: u16) -> Result<TcpListener, AppError> {
    let loopback = |port: u16| SocketAddr::from(([127, 0, 0, 1], port));
    match requested {
        Some(port) => TcpListener::bind(loopback(port)).await.map_err(|e| {
            AppError::Ssh(format!("本机端口 {} 无法使用：{}", port, e))
        }),
        None => match TcpListener::bind(loopback(remote_port)).await {
            Ok(l) => Ok(l),
            // 被占用 / 低位端口没权限：换一个系统分配的，界面上会如实显示换成了几号
            Err(_) => Ok(TcpListener::bind(loopback(0)).await?),
        },
    }
}

async fn accept_loop(
    entry: Arc<Entry>,
    listener: TcpListener,
    ssh: SshManager,
    app: AppHandle,
    mut stop_rx: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            _ = stop_rx.changed() => break,
            accepted = listener.accept() => match accepted {
                Ok((socket, peer)) => {
                    tokio::spawn(serve_connection(
                        entry.clone(), socket, peer, ssh.clone(), app.clone(), stop_rx.clone(),
                    ));
                }
                Err(e) => {
                    log::warn!("端口转发 accept 失败：{}", e);
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                }
            },
        }
    }
    // listener 随函数返回 drop，端口释放
}

/// 经当前连接开一条到目标的通道。会话离线 / 服务器拒绝时返回给用户看的原因。
async fn open_channel(
    entry: &Entry,
    ssh: &SshManager,
    originator: SocketAddr,
) -> Result<russh::Channel<russh::client::Msg>, String> {
    let conn = ssh
        .get_connection(&entry.session_id)
        .await
        .ok_or_else(|| "会话已断开，重新连接后会自动恢复".to_string())?;
    let handle = conn.handle.lock().await;
    handle
        .channel_open_direct_tcpip(
            entry.remote_host.clone(),
            entry.remote_port as u32,
            originator.ip().to_string(),
            originator.port() as u32,
        )
        .await
        .map_err(|e| describe_open_error(&e, &entry.remote_host, entry.remote_port))
}

fn describe_open_error(err: &russh::Error, host: &str, port: u16) -> String {
    match err {
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::AdministrativelyProhibited) => {
            "服务器禁止了端口转发（sshd 的 AllowTcpForwarding 被关闭）".to_string()
        }
        russh::Error::ChannelOpenFailure(russh::ChannelOpenFailure::ConnectFailed) => {
            format!("服务器连不上 {}:{}，那里可能没有服务在运行", host, port)
        }
        other => format!("建立转发通道失败：{}", other),
    }
}

fn set_error(entry: &Entry, app: &AppHandle, error: Option<String>) {
    let mut guard = entry.last_error.lock();
    if *guard != error {
        *guard = error;
        drop(guard);
        emit_event(app, CHANGED_EVENT, entry.session_id.as_str());
    }
}

async fn probe(entry: Arc<Entry>, ssh: SshManager, app: AppHandle) {
    let originator = SocketAddr::from(([127, 0, 0, 1], 0));
    match open_channel(&entry, &ssh, originator).await {
        Ok(channel) => {
            let _ = channel.close().await;
            set_error(&entry, &app, None);
        }
        Err(msg) => set_error(&entry, &app, Some(msg)),
    }
}

async fn serve_connection(
    entry: Arc<Entry>,
    mut socket: TcpStream,
    peer: SocketAddr,
    ssh: SshManager,
    app: AppHandle,
    mut stop_rx: watch::Receiver<bool>,
) {
    let _ = socket.set_nodelay(true);
    let channel = match open_channel(&entry, &ssh, peer).await {
        Ok(c) => {
            set_error(&entry, &app, None);
            c
        }
        Err(msg) => {
            set_error(&entry, &app, Some(msg));
            return; // socket drop = 浏览器立刻看到连接被关闭
        }
    };
    entry.total_connections.fetch_add(1, Ordering::Relaxed);
    entry.active_connections.fetch_add(1, Ordering::Relaxed);
    let mut stream = channel.into_stream();
    tokio::select! {
        _ = tokio::io::copy_bidirectional(&mut socket, &mut stream) => {}
        _ = stop_rx.changed() => {}
    }
    entry.active_connections.fetch_sub(1, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn explicit_local_port_conflict_is_reported_not_silently_changed() {
        let taken = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = taken.local_addr().unwrap().port();
        let err = bind_local(Some(port), 8080).await.unwrap_err();
        assert!(err.to_string().contains(&port.to_string()));
    }

    #[tokio::test]
    async fn unspecified_local_port_falls_back_when_same_port_is_taken() {
        let taken = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let busy = taken.local_addr().unwrap().port();
        let listener = bind_local(None, busy).await.unwrap();
        assert_ne!(listener.local_addr().unwrap().port(), busy);
        assert!(listener.local_addr().unwrap().ip().is_loopback());
    }

    #[tokio::test]
    async fn unspecified_local_port_prefers_the_remote_port_number() {
        // 找一个当前空闲的端口号当“服务器端口”
        let probe = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let free = probe.local_addr().unwrap().port();
        drop(probe);
        let listener = bind_local(None, free).await.unwrap();
        assert_eq!(listener.local_addr().unwrap().port(), free);
    }
}
