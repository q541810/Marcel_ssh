// Stdio Transport 实现
//
// 通过 stdin/stdout 与外部 MCP client 通信（JSON-RPC over newline-delimited JSON）
//
// 协议细节（与 MCP 规范 2024-11-05 对齐）：
// - 每条消息一行 JSON，`\n` 分隔
// - stderr 只用于日志，不参与协议
// - notification（无 id）不需要响应

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

use super::protocol::{McpError, McpResponse, McpServerMessage};
use super::McpServer;
use crate::error::AppError;

/// 运行 Stdio MCP Server
///
/// 从 stdin 读取 JSON-RPC 请求（每行一个），处理后将响应写入 stdout。
/// stderr 用于日志输出，不参与协议通信。
pub async fn run_stdio_server(server: &McpServer) -> Result<(), AppError> {
    log::info!(
        "[MCP Stdio] Starting server: {} v{}",
        server.config.name,
        server.config.version
    );

    // 工具注册表（与 HTTP transport 共用同一条构造路径）
    let registry = server.build_registry()?;

    // Tokio 异步 stdin/stdout
    let stdin = tokio::io::stdin();
    let mut reader = BufReader::new(stdin);
    let mut stdout = tokio::io::stdout();

    let mut line = String::new();
    loop {
        line.clear();
        let n = reader
            .read_line(&mut line)
            .await
            .map_err(|e| AppError::Io(e))?;

        if n == 0 {
            // EOF
            log::info!("[MCP Stdio] Client closed connection (EOF)");
            break;
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // 审计日志：**只记方法名，绝不记请求体**。
        //
        // 这里曾经打整条 `line`，于是 `create_connection` 的明文 password /
        // passphrase 直接落进 stderr——而文档还推荐排查时开 `RUST_LOG=debug`，
        // 等于教用户把密码写进日志。`agent_task` 的 task 正文同理。
        // 「外部调用」这条审计线索靠方法名就够，参数里的凭据一律不入日志。
        let message: McpServerMessage = match serde_json::from_str(line) {
            Ok(msg) => msg,
            Err(e) => {
                // 解析失败的原文同样可能含凭据（用户把 JSON 写坏了），
                // 所以这里也只记错误位置，不记原文。
                log::warn!("[MCP Stdio] 收到无法解析的消息: {}", e);
                let error_resp = McpResponse::error(
                    serde_json::Value::Null,
                    McpError::parse_error(format!("Invalid JSON: {}", e)),
                );
                write_response(&mut stdout, &error_resp).await?;
                continue;
            }
        };

        if server.config.log_external_calls {
            let method = match &message {
                McpServerMessage::Request(r) => r.method.clone(),
                McpServerMessage::Notification(n) => n.method.clone(),
            };
            log::debug!("[MCP Stdio] 收到方法 {}（参数不入日志）", method);
        }

        // 处理消息
        match message {
            McpServerMessage::Request(req) => {
                let response = server.handle_request(&registry, req).await;
                write_response(&mut stdout, &response).await?;
            }
            McpServerMessage::Notification(notif) => {
                server.handle_notification(&notif);
                // Notification 不需要响应
            }
        }
    }

    log::info!("[MCP Stdio] Server stopped");

    // 收尾：关掉本次服务期间建立的无头会话。进程随后就退出，但显式关闭
    // 让「会话随服务生灭」这件事成立，也为将来进程内复用留好边界。
    registry.executor().shutdown().await;

    Ok(())
}

/// 写响应到 stdout
async fn write_response(
    stdout: &mut tokio::io::Stdout,
    response: &McpResponse,
) -> Result<(), AppError> {
    let json = serde_json::to_string(response)
        .map_err(|e| AppError::Config(format!("Failed to serialize response: {}", e)))?;

    stdout
        .write_all(json.as_bytes())
        .await
        .map_err(|e| AppError::Io(e))?;

    stdout
        .write_all(b"\n")
        .await
        .map_err(|e| AppError::Io(e))?;

    stdout
        .flush()
        .await
        .map_err(|e| AppError::Io(e))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    // 显式导入：`use super::*` 只带进父模块*当前*导入的名字，
    // 生产代码用不到 Arc/McpRequest/ToolRegistry 之后它们就不在父模块里了。
    use crate::command_exec::CommandExecutionManager;
    use crate::config::connections::ConnectionStore;
    use crate::mcp_server::protocol::McpRequest;
    use crate::mcp_server::McpServerConfig;
    use crate::SshManager;
    use std::sync::Arc;

    /// 构造一个可用的测试 server（临时目录的 manager + 空连接表）。
    async fn test_server() -> McpServer {
        let ssh_mgr = SshManager::new();
        let dir = std::env::temp_dir().join(format!("marcel-mcp-stdio-{}", uuid::Uuid::new_v4()));
        let command_exec = Arc::new(
            CommandExecutionManager::new(
                ssh_mgr.clone(),
                dir.join("jobs_temp"),
                dir.join("ledger.jsonl"),
            )
            .await,
        );

        let mut server = McpServer::new(
            McpServerConfig::default(),
            Arc::new(ssh_mgr),
            Arc::new(tokio::sync::RwLock::new(ConnectionStore::new())),
        );
        server.command_exec = Some(command_exec);
        server
    }

    #[tokio::test]
    async fn initialize_returns_protocol_and_server_info() {
        let server = test_server().await;
        let registry = server.build_registry().unwrap();

        let req = McpRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(1),
            method: "initialize".into(),
            params: Some(serde_json::json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "test", "version": "1.0"}
            })),
        };

        let resp = server.handle_request(&registry, req).await;
        assert!(resp.error.is_none());
        let result = resp.result.expect("initialize 必须返回 result");
        assert_eq!(result["protocolVersion"], "2024-11-05");
        assert_eq!(result["serverInfo"]["name"], "Marcel SSH MCP Server");
        assert!(result["capabilities"]["tools"].is_object());
    }

    #[tokio::test]
    async fn tools_list_returns_nine_tools() {
        let server = test_server().await;
        let registry = server.build_registry().unwrap();

        let req = McpRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(2),
            method: "tools/list".into(),
            params: None,
        };

        let resp = server.handle_request(&registry, req).await;
        let result = resp.result.expect("tools/list 必须返回 result");
        let tools = result["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 9);
        // 顺序稳定：list_connections 恒在首位
        assert_eq!(tools[0]["name"], "list_connections");
    }

    #[tokio::test]
    async fn unknown_method_returns_method_not_found() {
        let server = test_server().await;
        let registry = server.build_registry().unwrap();

        let req = McpRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(3),
            method: "unknown/method".into(),
            params: None,
        };

        let resp = server.handle_request(&registry, req).await;
        let err = resp.error.expect("未知方法必须报错");
        assert_eq!(err.code, -32601);
        assert!(err.message.contains("unknown/method"));
    }

    #[tokio::test]
    async fn tools_call_without_name_is_invalid_params() {
        let server = test_server().await;
        let registry = server.build_registry().unwrap();

        let req = McpRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(4),
            method: "tools/call".into(),
            params: Some(serde_json::json!({ "arguments": {} })),
        };

        let resp = server.handle_request(&registry, req).await;
        let err = resp.error.expect("缺 name 必须报错");
        assert_eq!(err.code, -32602);
        assert!(err.message.contains("name"));
    }

    #[tokio::test]
    async fn tools_call_without_params_is_invalid_params() {
        let server = test_server().await;
        let registry = server.build_registry().unwrap();

        let req = McpRequest {
            jsonrpc: "2.0".into(),
            id: serde_json::json!(5),
            method: "tools/call".into(),
            params: None,
        };

        let resp = server.handle_request(&registry, req).await;
        let err = resp.error.expect("缺 params 必须报错");
        assert_eq!(err.code, -32602);
    }

    #[tokio::test]
    async fn registry_requires_command_exec() {
        // 未注入 command_exec 时必须如实报错，而不是给个跑不了命令的空注册表
        let server = McpServer::new(
            McpServerConfig::default(),
            Arc::new(SshManager::new()),
            Arc::new(tokio::sync::RwLock::new(ConnectionStore::new())),
        );
        assert!(server.build_registry().is_err());
    }

    #[tokio::test]
    async fn notification_is_recognized_without_response() {
        // notification 无 id，解析层必须能识别（不能被当成请求去要 id）
        let msg: McpServerMessage =
            serde_json::from_str(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
                .expect("notification 必须可解析");
        match msg {
            McpServerMessage::Notification(n) => {
                assert_eq!(n.method, "notifications/initialized");
            }
            McpServerMessage::Request(_) => panic!("无 id 的消息不应被当成请求"),
        }
    }

    #[tokio::test]
    async fn malformed_json_is_rejected_at_parse_layer() {
        let bad = r#"{"jsonrpc":"2.0","id":1,"method":"#;
        assert!(serde_json::from_str::<McpServerMessage>(bad).is_err());
    }
}
