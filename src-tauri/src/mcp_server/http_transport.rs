// MCP over HTTP（桌面专属）
//
// ─────────────────────────── 安全前提（先读这段）───────────────────────────
//
// stdio 之所以可以在**不审批**的前提下把命令放出去，靠的是一条隐含前提：
// 「客户端必须能启动这个进程」——那已经意味着它拿到了本机执行权限，而且
// 通道是父子进程之间的私有管道，机器上别的东西碰不到。
//
// HTTP **把这条前提整个拆掉**：监听端口之后，本机上任何进程（乃至经由
// DNS rebinding 的浏览器）都能访问，而这里暴露的是「在你所有服务器上执行
// 无审批命令」。所以本模块不是「把 stdio 换个壳」，它必须自带边界：
//
//   1. **默认只绑 127.0.0.1**。要暴露到局域网得用户显式传 `--mcp-bind`。
//   2. **强制 Bearer token**，没有 token 直接拒绝启动。token 用 SHA-256
//      摘要后按位比较，避免用逐字节提前返回的方式泄漏长度与前缀。
//   3. **限流**，防止本地进程把它当成高频执行通道刷。
//
// 三条都是「不给配置项就安全」的方向：默认值即安全值，放宽必须显式为之。

use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::{
    extract::State,
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
    Json, Router,
};
use parking_lot::Mutex;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use super::protocol::{McpError, McpResponse, McpServerMessage};
use super::tools::ToolRegistry;
use super::McpServer;
use crate::error::AppError;

/// 默认端口。刻意避开 3000 / 8080 这类常被占用的开发端口。
pub const DEFAULT_HTTP_PORT: u16 = 8765;

/// 默认绑定地址：仅本机回环。
///
/// 想局域网访问必须显式改——这是刻意的：默认值必须是安全值。
pub const DEFAULT_BIND: &str = "127.0.0.1";

/// 每秒允许的请求数上限。
const RATE_LIMIT_PER_SEC: u32 = 60;

/// HTTP transport 配置（由 `cli.rs` 解析命令行后构造）。
#[derive(Debug, Clone)]
pub struct HttpConfig {
    pub bind: IpAddr,
    pub port: u16,
    /// 访问令牌。空串会在启动时被拒绝——见模块注释第 2 条。
    pub token: String,
}

impl HttpConfig {
    pub fn socket_addr(&self) -> SocketAddr {
        SocketAddr::new(self.bind, self.port)
    }

    /// 是否绑定在回环地址上（用于决定日志里要不要打风险警告）。
    pub fn is_loopback(&self) -> bool {
        self.bind.is_loopback()
    }
}

/// 生成一个随机访问令牌（两个 UUIDv4 ≈ 244 位随机性）。
pub fn generate_token() -> String {
    format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// 定长窗口限流器。
///
/// 粗略但够用：它挡的是「本机某个进程把这里当命令执行通道狂刷」，
/// 不是精确的流量整形。
struct RateLimiter {
    window_start: Mutex<Instant>,
    count: AtomicU32,
}

impl RateLimiter {
    fn new() -> Self {
        Self {
            window_start: Mutex::new(Instant::now()),
            count: AtomicU32::new(0),
        }
    }

    /// 记一次请求；返回 `false` 表示超限。
    fn allow(&self) -> bool {
        let mut start = self.window_start.lock();
        if start.elapsed() >= Duration::from_secs(1) {
            *start = Instant::now();
            self.count.store(0, Ordering::Relaxed);
        }
        let n = self.count.fetch_add(1, Ordering::Relaxed);
        n < RATE_LIMIT_PER_SEC
    }
}

/// 令牌比较：先各自摘要再逐位比较。
///
/// 不直接比字符串是因为 naive 比较会在第一个不同字节处提前返回，
/// 攻击者可据此逐字节猜出 token。摘要后长度恒定，且不泄漏原串长度。
fn token_matches(provided: &str, expected: &str) -> bool {
    let a = Sha256::digest(provided.as_bytes());
    let b = Sha256::digest(expected.as_bytes());
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

/// 从 `Authorization: Bearer <token>` 取令牌。
fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
        .map(str::trim)
}

#[derive(Clone)]
struct HttpState {
    server: Arc<McpServer>,
    registry: Arc<ToolRegistry>,
    token: Arc<String>,
    rate: Arc<RateLimiter>,
}

/// 运行 HTTP transport（阻塞直到进程收尾）。
/// 运行中服务的只读快照（给前端显示用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRuntimeInfo {
    pub bind: String,
    pub port: u16,
    /// 访问令牌。**会返回给前端**：用户需要把它填进客户端配置里。
    /// 这不是泄漏——前端本身就是用户自己的界面，令牌本来就要展示给他看。
    pub token: String,
    pub url: String,
}

/// 一个运行中的 HTTP MCP 服务。
///
/// 持有它 = 服务在跑；`stop()` 之后服务停止。GUI 用它实现「启用/禁用」开关。
pub struct HttpServerHandle {
    info: HttpRuntimeInfo,
    /// `take()` 过就说明已经发过停止信号（`stop` 只能生效一次）
    shutdown: Option<oneshot::Sender<()>>,
    join: tokio::task::JoinHandle<()>,
}

impl HttpServerHandle {
    pub fn info(&self) -> HttpRuntimeInfo {
        self.info.clone()
    }

    /// 停止服务并等它真正退出（包括关闭无头会话）。
    ///
    /// 等待很重要：立刻返回会让「已停止」与「端口还占着」出现一段窗口期，
    /// 用户马上重新启用就会撞上端口占用。
    pub async fn stop(mut self) {
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = self.join.await;
    }

    /// 等它自己结束（CLI 模式用：进程退出前一直服务）。
    pub async fn wait(self) {
        let _ = self.join.await;
    }
}

/// 启动 HTTP 服务并返回句柄（**不阻塞**）。
///
/// 与 [`run_http_server`] 的区别：这个立刻返回，调用方拿着句柄决定何时停。
/// GUI 内托管服务走这条；CLI 的 `--mcp-http` 走那个阻塞版本。
pub async fn start_http_server(
    server: &McpServer,
    cfg: HttpConfig,
) -> Result<HttpServerHandle, AppError> {
    if cfg.token.trim().is_empty() {
        return Err(AppError::Config(
            "HTTP 模式必须提供访问令牌；空令牌会把这个端口变成一个无需认证的远程命令执行接口。"
                .into(),
        ));
    }

    let registry = server.build_registry()?;
    let state = HttpState {
        server: Arc::new(server.clone()),
        registry,
        token: Arc::new(cfg.token.clone()),
        rate: Arc::new(RateLimiter::new()),
    };

    let app = Router::new()
        .route("/mcp", post(handle_mcp))
        .with_state(state.clone());

    let addr = cfg.socket_addr();
    let listener = bind_listener(addr, cfg.port).await?;

    log::info!("[MCP HTTP] 监听 http://{}/mcp", addr);
    if !cfg.is_loopback() {
        log::warn!(
            "[MCP HTTP] 绑定在非回环地址 {}：局域网内任何能访问该端口的进程，             都可以在已保存的服务器上执行**无审批**命令。仅在你清楚后果时这样做。",
            cfg.bind
        );
    }

    let (tx, rx) = oneshot::channel::<()>();
    let join = tokio::spawn(async move {
        let result = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                // 发送端被 drop（句柄被丢掉）也会走到这里，等价于停止
                let _ = rx.await;
            })
            .await;
        if let Err(e) = result {
            log::error!("[MCP HTTP] 服务异常退出: {}", e);
        }
        // 收尾与 stdio 对称：关掉本次服务期间建立的无头会话
        state.registry.executor().shutdown().await;
        log::info!("[MCP HTTP] 服务已停止");
    });

    Ok(HttpServerHandle {
        info: HttpRuntimeInfo {
            bind: cfg.bind.to_string(),
            port: cfg.port,
            token: cfg.token,
            url: format!("http://{}/mcp", addr),
        },
        shutdown: Some(tx),
        join,
    })
}

/// 绑定监听地址，把常见的失败翻译成人能看懂的话。
///
/// 端口占用是用户最常撞上的情况，抛一句 `os error 10048` 等于没说——
/// 用户需要知道的是「哪个端口被占了、去改哪个设置」。
async fn bind_listener(addr: SocketAddr, port: u16) -> Result<tokio::net::TcpListener, AppError> {
    tokio::net::TcpListener::bind(addr).await.map_err(|e| match e.kind() {
        std::io::ErrorKind::AddrInUse => AppError::Config(format!(
            "端口 {} 已被其他程序占用。换一个端口，或先关掉占用它的程序。",
            port
        )),
        std::io::ErrorKind::PermissionDenied => AppError::Config(format!(
            "没有权限监听 {}。1024 以下的端口通常需要管理员权限，请改用 1024 以上的端口。",
            addr
        )),
        std::io::ErrorKind::AddrNotAvailable => AppError::Config(format!(
            "本机没有 {} 这个地址，无法绑定。绑定地址一般保持 127.0.0.1。",
            addr.ip()
        )),
        _ => AppError::Network(format!("无法监听 {}：{}", addr, e)),
    })
}

/// 运行 HTTP transport 并**阻塞**到服务结束（CLI `--mcp-http` 用）。
pub async fn run_http_server(server: &McpServer, cfg: HttpConfig) -> Result<(), AppError> {
    let handle = start_http_server(server, cfg).await?;
    handle.wait().await;
    Ok(())
}

/// `POST /mcp`：单端点 JSON-RPC。
///
/// MCP 的 HTTP 传输把 initialize / tools/list / tools/call 都收敛到
/// 同一个端点上，请求体就是一条 JSON-RPC 消息。
async fn handle_mcp(
    State(state): State<HttpState>,
    headers: HeaderMap,
    body: String,
) -> Response {
    // ── 认证 ──
    //
    // 注意：`body: String` 由 axum 的提取器在进入本函数**之前**就已读进内存
    // （默认上限 2MB），所以这里不是「未授权就什么都不消耗」——那句话说大了。
    // 认证挡住的是「未授权不会执行任何工具」，这是真正要挡的东西。
    let authorized = bearer_token(&headers)
        .map(|t| token_matches(t, &state.token))
        .unwrap_or(false);
    if !authorized {
        log::warn!("[MCP HTTP] 拒绝未授权请求");
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({
                "error": "unauthorized",
                "message": "缺少或错误的 Bearer 令牌"
            })),
        )
            .into_response();
    }

    // ── 限流 ──
    if !state.rate.allow() {
        log::warn!("[MCP HTTP] 触发限流");
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({
                "error": "rate_limited",
                "message": format!("超过 {} 次/秒 的上限", RATE_LIMIT_PER_SEC)
            })),
        )
            .into_response();
    }

    // ── 解析 ──
    let message: McpServerMessage = match serde_json::from_str(&body) {
        Ok(m) => m,
        Err(e) => {
            let resp = McpResponse::error(
                serde_json::Value::Null,
                McpError::parse_error(format!("Invalid JSON: {}", e)),
            );
            // JSON-RPC 的解析错误仍然用 200 返回（错误在 body 里），
            // 这是 JSON-RPC over HTTP 的惯例，客户端按 body 判错。
            return Json(resp).into_response();
        }
    };

    match message {
        McpServerMessage::Request(req) => {
            let resp = state.server.handle_request(&state.registry, req).await;
            Json(resp).into_response()
        }
        McpServerMessage::Notification(n) => {
            // 通知不需要响应体；202 表示已受理
            state.server.handle_notification(&n);
            StatusCode::ACCEPTED.into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_bind_is_loopback() {
        // 默认值必须是安全值：改 DEFAULT_BIND 成 0.0.0.0 会让这条测试挂掉，
        // 从而拦住「不小心把服务暴露到局域网」
        assert_eq!(DEFAULT_BIND, "127.0.0.1");
        let cfg = HttpConfig {
            bind: DEFAULT_BIND.parse().unwrap(),
            port: DEFAULT_HTTP_PORT,
            token: "t".into(),
        };
        assert!(cfg.is_loopback());
    }

    #[test]
    fn token_matches_only_on_exact() {
        let t = "abc123";
        assert!(token_matches(t, t));
        assert!(!token_matches("abc124", t));
        assert!(!token_matches("abc", t)); // 前缀不算
        assert!(!token_matches("", t));
        assert!(!token_matches("abc123 ", t)); // 尾随空格不算
    }

    #[test]
    fn generated_tokens_are_long_and_unique() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b, "两次生成的令牌不应相同");
        assert_eq!(a.len(), 64, "两个 UUID simple 拼接应为 64 个 hex 字符");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn bearer_token_extraction() {
        let mut h = HeaderMap::new();
        h.insert(header::AUTHORIZATION, "Bearer secret".parse().unwrap());
        assert_eq!(bearer_token(&h), Some("secret"));

        let mut h2 = HeaderMap::new();
        h2.insert(header::AUTHORIZATION, "Basic abc".parse().unwrap());
        assert_eq!(bearer_token(&h2), None, "非 Bearer 方案应被拒");

        assert_eq!(bearer_token(&HeaderMap::new()), None, "缺头应被拒");
    }

    #[test]
    fn rate_limiter_blocks_after_limit() {
        let rl = RateLimiter::new();
        for i in 0..RATE_LIMIT_PER_SEC {
            assert!(rl.allow(), "第 {} 次请求不该被拦", i + 1);
        }
        assert!(!rl.allow(), "超限后必须拒绝");
    }

    #[tokio::test]
    async fn port_in_use_gives_a_readable_error() {
        // 先占住一个端口，再让服务去绑同一个端口
        let squatter = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = squatter.local_addr().unwrap().port();
        let addr: SocketAddr = format!("127.0.0.1:{}", port).parse().unwrap();

        let err = bind_listener(addr, port)
            .await
            .expect_err("端口被占用时应当失败");

        let msg = err.to_string();
        // 关键：要说人话。抛一句 "os error 10048" 等于没说——
        // 用户需要知道的是「哪个端口被占了、该去改什么」
        assert!(msg.contains(&port.to_string()), "应指出是哪个端口: {}", msg);
        assert!(
            msg.contains("占用"),
            "应说明是端口占用而不是别的失败: {}",
            msg
        );
    }

    #[tokio::test]
    async fn empty_token_is_refused() {
        // 没有令牌就不许起——这条是模块注释里第 2 条安全边界的守卫
        let server = McpServer::new(
            super::super::McpServerConfig::default(),
            Arc::new(crate::SshManager::new()),
            Arc::new(tokio::sync::RwLock::new(
                crate::config::connections::ConnectionStore::new(),
            )),
        );
        let cfg = HttpConfig {
            bind: DEFAULT_BIND.parse().unwrap(),
            port: DEFAULT_HTTP_PORT,
            token: "   ".into(),
        };
        let err = run_http_server(&server, cfg)
            .await
            .expect_err("空令牌必须拒绝启动");
        assert!(err.to_string().contains("令牌"));
    }
}
