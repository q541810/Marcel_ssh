// MCP Server Protocol 定义
//
// 复用现有的 mcp::protocol，但这里添加 MCP Server 专用的请求/响应结构

use serde::{Deserialize, Serialize};

/// MCP Server 收到的请求（来自 client）
#[derive(Debug, Deserialize)]
#[serde(untagged)]
pub enum McpServerMessage {
    Request(McpRequest),
    Notification(McpNotification),
}

#[derive(Debug, Deserialize)]
pub struct McpRequest {
    pub jsonrpc: String,
    pub id: serde_json::Value, // 可以是数字或字符串
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct McpNotification {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<serde_json::Value>,
}

/// MCP Server 发送的响应（给 client）
#[derive(Debug, Serialize)]
pub struct McpResponse {
    pub jsonrpc: &'static str,
    pub id: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<McpError>,
}

impl McpResponse {
    pub fn success(id: serde_json::Value, result: serde_json::Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: serde_json::Value, error: McpError) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            result: None,
            error: Some(error),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct McpError {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
}

impl McpError {
    pub fn parse_error(msg: impl Into<String>) -> Self {
        Self {
            code: -32700,
            message: msg.into(),
            data: None,
        }
    }

    pub fn invalid_request(msg: impl Into<String>) -> Self {
        Self {
            code: -32600,
            message: msg.into(),
            data: None,
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: -32601,
            message: format!("Method not found: {}", method),
            data: None,
        }
    }

    pub fn invalid_params(msg: impl Into<String>) -> Self {
        Self {
            code: -32602,
            message: msg.into(),
            data: None,
        }
    }

    pub fn internal_error(msg: impl Into<String>) -> Self {
        Self {
            code: -32603,
            message: msg.into(),
            data: None,
        }
    }

    // Marcel SSH 自定义错误码
    pub fn connection_not_found(connection_id: &str) -> Self {
        Self {
            code: 1001,
            message: format!("Connection not found: {}", connection_id),
            data: None,
        }
    }

    pub fn connection_failed(msg: impl Into<String>) -> Self {
        Self {
            code: 1002,
            message: msg.into(),
            data: None,
        }
    }

    pub fn command_execution_failed(msg: impl Into<String>) -> Self {
        Self {
            code: 1003,
            message: msg.into(),
            data: None,
        }
    }

    pub fn file_operation_failed(msg: impl Into<String>) -> Self {
        Self {
            code: 1004,
            message: msg.into(),
            data: None,
        }
    }

    pub fn timeout(msg: impl Into<String>) -> Self {
        Self {
            code: 1005,
            message: msg.into(),
            data: None,
        }
    }

    pub fn cancelled() -> Self {
        Self {
            code: 1006,
            message: "Operation cancelled".into(),
            data: None,
        }
    }
}

/// MCP Tool 调用结果的标准格式
#[derive(Debug, Serialize)]
pub struct ToolCallResult {
    pub content: Vec<ContentItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_error: Option<bool>,
}

impl ToolCallResult {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentItem::Text {
                text: text.into(),
            }],
            is_error: None,
        }
    }

    pub fn error(text: impl Into<String>) -> Self {
        Self {
            content: vec![ContentItem::Text {
                text: text.into(),
            }],
            is_error: Some(true),
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ContentItem {
    Text { text: String },
    // 未来可以扩展 image、resource 等类型
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_request() {
        let json = r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#;
        let msg: McpServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            McpServerMessage::Request(req) => {
                assert_eq!(req.method, "tools/list");
                assert_eq!(req.id, serde_json::json!(1));
            }
            _ => panic!("Expected Request"),
        }
    }

    #[test]
    fn parse_notification() {
        let json = r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#;
        let msg: McpServerMessage = serde_json::from_str(json).unwrap();
        match msg {
            McpServerMessage::Notification(notif) => {
                assert_eq!(notif.method, "notifications/initialized");
            }
            _ => panic!("Expected Notification"),
        }
    }

    #[test]
    fn response_success() {
        let resp = McpResponse::success(serde_json::json!(1), serde_json::json!({"ok": true}));
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"result\""));
        assert!(!json.contains("\"error\""));
    }

    #[test]
    fn response_error() {
        let resp = McpResponse::error(
            serde_json::json!(1),
            McpError::method_not_found("foo"),
        );
        let json = serde_json::to_string(&resp).unwrap();
        assert!(json.contains("\"error\""));
        assert!(json.contains("-32601"));
        assert!(!json.contains("\"result\""));
    }

    #[test]
    fn tool_result_text() {
        let result = ToolCallResult::text("hello");
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["content"][0]["type"], "text");
        assert_eq!(json["content"][0]["text"], "hello");
        assert!(json.get("is_error").is_none());
    }

    #[test]
    fn tool_result_error() {
        let result = ToolCallResult::error("failed");
        let json = serde_json::to_value(&result).unwrap();
        assert_eq!(json["is_error"], true);
    }

    #[test]
    fn custom_error_codes() {
        let err = McpError::connection_not_found("conn-1");
        assert_eq!(err.code, 1001);
        assert!(err.message.contains("conn-1"));

        let err = McpError::timeout("op timed out");
        assert_eq!(err.code, 1005);
    }
}
