// Stdio Transport 实现
//
// 通过 stdin/stdout 与外部 MCP client 通信（JSON-RPC over newline-delimited JSON）
//
// 协议细节（与 MCP 规范 2024-11-05 对齐）：
// - 每条消息一行 JSON，`\n` 分隔
// - stderr 只用于日志，不参与协议
// - notification（无 id）不需要响应

use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use super::protocol::{McpError, McpResponse, McpServerMessage};
use super::McpServer;
use crate::error::AppError;

/// 单行请求上限（8 MiB）。
///
/// stdin 是本进程的父进程，属于本地信任域；但这不能当作无上限的理由——
/// 一次超长行就足以把进程 OOM，之后什么信任都谈不上。
const MAX_STDIO_LINE_BYTES: u64 = 8 * 1024 * 1024;

/// `read_line_limited` 的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LineRead {
    /// 读到 EOF（没有新数据）。
    Eof,
    /// 读到一行（EOF 前的最后一行可能没有换行）。
    Line,
    /// 在换行前就撞到上限。调用方应停止解析：剩余字节还在管道里，继续读会把
    /// 半截 JSON 当成一条新消息。
    TooLong,
}

/// 有限长度读一行：最多读 `max_bytes + 1` 字节，读满上限且没有换行即判定超限。
///
/// 不把整个 stdin 读进内存，超长行也不会被静默截断后继续解析。
async fn read_line_limited<R>(
    reader: &mut R,
    max_bytes: u64,
    line: &mut String,
) -> Result<LineRead, AppError>
where
    R: AsyncBufRead + Unpin,
{
    line.clear();
    // 多读 1 字节：读满 max_bytes + 1 且末尾没有换行，说明这一行超限。
    let n = {
        let mut limited = (&mut *reader).take(max_bytes + 1);
        limited.read_line(line).await.map_err(AppError::Io)?
    };

    if n == 0 {
        return Ok(LineRead::Eof);
    }
    if line.len() as u64 > max_bytes && !line.ends_with('\n') {
        return Ok(LineRead::TooLong);
    }

    Ok(LineRead::Line)
}

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
        match read_line_limited(&mut reader, MAX_STDIO_LINE_BYTES, &mut line).await? {
            LineRead::Eof => {
                // EOF
                log::info!("[MCP Stdio] Client closed connection (EOF)");
                break;
            }
            LineRead::TooLong => {
                // 不静默截断继续解析：剩余字节仍在管道里，继续读会把半截
                // JSON 当成新消息。明确报错后停止服务。
                log::error!(
                    "[MCP Stdio] 单行请求超过 {} 字节上限，停止服务",
                    MAX_STDIO_LINE_BYTES
                );
                let error_resp = McpResponse::error(
                    serde_json::Value::Null,
                    McpError::parse_error(format!("请求行超过 {} 字节上限", MAX_STDIO_LINE_BYTES)),
                );
                write_response(&mut stdout, &error_resp).await?;
                break;
            }
            LineRead::Line => {}
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        // 审计日志：**只记方法名，绝不记请求体**。
        //
        // 这里曾经打整条 `line`，于是 `create_connection` 的明文 password /
        // passphrase 直接落进 stderr——而文档还推荐排查时开 `RUST_LOG=debug`，
        // 等于教用户把密码写进日志。`remote_subagent` 的 task 正文同理。
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

    stdout.write_all(b"\n").await.map_err(|e| AppError::Io(e))?;

    stdout.flush().await.map_err(|e| AppError::Io(e))?;

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
            crate::data::JsonStore::new(&dir, ConnectionStore::new(), None),
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
            crate::data::JsonStore::new(&std::env::temp_dir(), ConnectionStore::new(), None),
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

    /// 超长单行不会被静默截断后继续解析：用小上限构造，不真的分配 8 MiB。
    #[tokio::test]
    async fn oversized_single_line_is_rejected() {
        let mut reader = BufReader::new(&b"0123456789abcdef-oversized\n"[..]);
        let mut line = String::new();

        let outcome = read_line_limited(&mut reader, 16, &mut line).await.unwrap();
        assert_eq!(outcome, LineRead::TooLong);
    }

    #[tokio::test]
    async fn normal_line_is_read() {
        let mut reader = BufReader::new(&b"{\"jsonrpc\":\"2.0\"}\n"[..]);
        let mut line = String::new();

        let outcome = read_line_limited(&mut reader, 1024, &mut line)
            .await
            .unwrap();
        assert_eq!(outcome, LineRead::Line);
        assert_eq!(line, "{\"jsonrpc\":\"2.0\"}\n");
    }

    /// 恰好等于上限（不含换行）的行仍然合法。
    #[tokio::test]
    async fn line_at_limit_with_newline_is_allowed() {
        let mut reader = BufReader::new(&b"0123456789abcdef\n"[..]);
        let mut line = String::new();

        let outcome = read_line_limited(&mut reader, 16, &mut line).await.unwrap();
        assert_eq!(outcome, LineRead::Line);
    }

    #[tokio::test]
    async fn eof_is_reported() {
        let mut reader = BufReader::new(&b""[..]);
        let mut line = String::new();

        let outcome = read_line_limited(&mut reader, 1024, &mut line)
            .await
            .unwrap();
        assert_eq!(outcome, LineRead::Eof);
    }
}
