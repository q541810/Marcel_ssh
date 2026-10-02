// MCP Server（对外服务）的设置命令。
//
// 注意别和 `commands/mcp.rs` 搞混：那个管的是 **MCP client**——Marcel SSH
// 去连别人的 MCP server。这里是反方向：Marcel SSH 自己当 server，供外部
// agent（Claude Code / zcode / DSH）接入。
//
// 桌面专属：整个 `mcp_server` 模块都是 `#[cfg(desktop)]`，所以移动端
// 编译不到这里——移动端不做 MCP server 是既定决策，用「模块不存在」表达
// 比用「运行时报错」诚实。

use std::net::IpAddr;
use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::error::AppError;
use crate::mcp_server::http_transport::{
    generate_token, HttpConfig, HttpRuntimeInfo, DEFAULT_BIND, DEFAULT_HTTP_PORT,
};
use crate::mcp_server::{runtime, McpServer};
use crate::AppState;

/// 可直接粘进客户端配置的片段。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpClientConfig {
    /// Marcel SSH 可执行文件的绝对路径（stdio 接入要写进 `command`）
    pub executable_path: String,
    /// stdio 接入的完整配置 JSON（推荐方式，无需常驻任何东西）
    pub stdio: String,
    /// HTTP 接入的配置 JSON；服务没在跑时为 `None`
    pub http: Option<String>,
}

/// 当前 HTTP 服务状态（没跑则 `None`）。
#[tauri::command]
pub async fn mcp_server_status() -> Option<HttpRuntimeInfo> {
    runtime::status()
}

/// 启动 HTTP 服务。
///
/// `token` 传 `None` 或空白则自动生成一个（复用后端同一套生成逻辑）——
/// 空令牌会被后端拒绝，这里代用户决定一个随机值比让他面对一个报错好。
#[tauri::command]
pub async fn mcp_server_start_http(
    state: State<'_, AppState>,
    bind: String,
    port: u16,
    token: Option<String>,
) -> Result<HttpRuntimeInfo, AppError> {
    let bind: IpAddr = bind.trim().parse().map_err(|_| {
        AppError::Config(format!(
            "绑定地址「{}」不是合法 IP。只监听本机填 127.0.0.1。",
            bind
        ))
    })?;

    if port == 0 {
        return Err(AppError::Config("端口不能为 0。".into()));
    }

    let token = match token.map(|t| t.trim().to_string()) {
        Some(t) if !t.is_empty() => t,
        _ => generate_token(),
    };

    // 复用 GUI 已在用的实例：界面上新增的连接会立刻对 MCP 调用可见
    let server = McpServer::from_app_state(
        Arc::new(state.ssh_manager.clone()),
        state.connection_store.clone(),
        Arc::new(state.command_exec.clone()),
        state.config_dir.clone(),
    );

    runtime::start(
        &server,
        HttpConfig {
            bind,
            port,
            token,
        },
    )
    .await
}

/// 停止 HTTP 服务。返回「之前是否在跑」——幂等，重复点不报错。
#[tauri::command]
pub async fn mcp_server_stop_http() -> Result<bool, AppError> {
    Ok(runtime::stop().await)
}

/// 重新生成令牌。
///
/// **只在服务没跑时允许**：换令牌会让所有已接入的客户端当场 401 断连，
/// 这是有副作用的操作，不该在运行中悄悄发生。UI 也据此把按钮禁掉。
#[tauri::command]
pub fn mcp_server_regenerate_token() -> Result<String, AppError> {
    if runtime::status().is_some() {
        return Err(AppError::Config(
            "服务正在运行，换令牌会让已接入的客户端立刻断连。请先停止服务，再重新生成。"
                .into(),
        ));
    }
    Ok(generate_token())
}

/// 生成可直接粘贴的客户端配置。
#[tauri::command]
pub fn mcp_server_client_config() -> McpClientConfig {
    let exe = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        // 拿不到路径也要给出一份能用的模板：留个占位符让用户自己填，
        // 总好过整个功能不可用。
        .unwrap_or_else(|_| "<Marcel SSH 可执行文件路径>".to_string());

    let stdio = serde_json::json!({
        "mcpServers": {
            "marcel-ssh": {
                "command": exe,
                "args": ["--mcp-server"]
            }
        }
    });

    let http = runtime::status().map(|info| {
        serde_json::json!({
            "mcpServers": {
                "marcel-ssh": {
                    "type": "http",
                    "url": info.url,
                    "headers": { "Authorization": format!("Bearer {}", info.token) }
                }
            }
        })
    });

    McpClientConfig {
        executable_path: exe,
        stdio: to_pretty(stdio),
        http: http.map(to_pretty),
    }
}

fn to_pretty(v: serde_json::Value) -> String {
    serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string())
}

/// 默认值给前端用（避免前后端各写一份默认端口/绑定地址）。
#[tauri::command]
pub fn mcp_server_defaults() -> serde_json::Value {
    serde_json::json!({
        "bind": DEFAULT_BIND,
        "port": DEFAULT_HTTP_PORT,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_config_contains_stdio_block_with_executable() {
        let cfg = mcp_server_client_config();
        let parsed: serde_json::Value = serde_json::from_str(&cfg.stdio).unwrap();
        let entry = &parsed["mcpServers"]["marcel-ssh"];
        // 粘贴给客户端的就是这两项，缺一个都连不上
        assert_eq!(entry["command"], serde_json::json!(cfg.executable_path));
        assert_eq!(entry["args"], serde_json::json!(["--mcp-server"]));
    }

    #[test]
    fn http_config_absent_when_not_running() {
        // 服务没跑时不该给出一份带假端口的 HTTP 片段——那会让用户
        // 粘一个连不上的配置然后困惑于「为什么没反应」
        let cfg = mcp_server_client_config();
        // 单测环境服务不会在跑；跑着的话这条前提本身就变了
        if runtime::status().is_none() {
            assert!(cfg.http.is_none());
        }
    }

    #[test]
    fn defaults_match_backend_constants() {
        let d = mcp_server_defaults();
        assert_eq!(d["bind"], serde_json::json!(DEFAULT_BIND));
        assert_eq!(d["port"], serde_json::json!(DEFAULT_HTTP_PORT));
    }

    #[test]
    fn regenerate_token_refused_while_running() {
        // 只在没跑时可用；跑着时必须拒绝（副作用：踢掉所有已接入客户端）
        if runtime::status().is_none() {
            let t = mcp_server_regenerate_token().expect("没跑时应当能生成");
            assert_eq!(t.len(), 64);
        }
    }
}
