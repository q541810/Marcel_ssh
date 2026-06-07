use serde::{Deserialize, Serialize};

use crate::error::AppError;

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcRequest {
    pub jsonrpc: &'static str,
    pub id: u64,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl JsonRpcRequest {
    pub fn new(id: u64, method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        Self {
            jsonrpc: "2.0",
            id,
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcNotification {
    pub jsonrpc: &'static str,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl JsonRpcNotification {
    pub fn new(method: impl Into<String>, params: Option<serde_json::Value>) -> Self {
        Self {
            jsonrpc: "2.0",
            method: method.into(),
            params,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcResponse {
    pub id: Option<u64>,
    pub result: Option<serde_json::Value>,
    pub error: Option<JsonRpcError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcError {
    pub code: i64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub input_schema: serde_json::Value,
}

#[derive(Debug, Deserialize)]
struct ToolsListResult {
    #[serde(default)]
    tools: Vec<McpToolInfo>,
}

pub fn parse_tools_list(value: serde_json::Value) -> Result<Vec<McpToolInfo>, AppError> {
    let result: ToolsListResult = serde_json::from_value(value)?;
    Ok(result.tools)
}

pub fn flatten_tool_call_result(value: serde_json::Value) -> String {
    let Some(content) = value.get("content").and_then(|v| v.as_array()) else {
        return serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string());
    };
    let mut parts = Vec::new();
    for item in content {
        if let Some(text) = item.get("text").and_then(|v| v.as_str()) {
            parts.push(text.to_string());
        } else {
            parts.push(serde_json::to_string_pretty(item).unwrap_or_else(|_| item.to_string()));
        }
    }
    parts.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_tools_list() {
        let tools = parse_tools_list(serde_json::json!({
            "tools": [{ "name": "read", "description": "Read", "inputSchema": { "type": "object" } }]
        })).unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "read");
    }

    #[test]
    fn flattens_text_content() {
        let text = flatten_tool_call_result(serde_json::json!({
            "content": [{ "type": "text", "text": "hello" }, { "type": "text", "text": "world" }]
        }));
        assert_eq!(text, "hello\nworld");
    }

    #[test]
    fn request_serializes_correctly() {
        let req = JsonRpcRequest::new(1, "tools/list", None);
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["jsonrpc"], "2.0");
        assert_eq!(json["id"], 1);
        assert_eq!(json["method"], "tools/list");
        assert!(json.get("params").is_none());
    }

    #[test]
    fn request_serializes_with_params() {
        let req = JsonRpcRequest::new(2, "tools/call", Some(serde_json::json!({"name": "read"})));
        let json = serde_json::to_value(&req).unwrap();
        assert_eq!(json["params"]["name"], "read");
    }

    #[test]
    fn response_deserializes_success() {
        let resp: JsonRpcResponse = serde_json::from_value(serde_json::json!({
            "id": 1,
            "result": { "tools": [] }
        })).unwrap();
        assert_eq!(resp.id, Some(1));
        assert!(resp.result.is_some());
        assert!(resp.error.is_none());
    }

    #[test]
    fn response_deserializes_error() {
        let resp: JsonRpcResponse = serde_json::from_value(serde_json::json!({
            "id": null,
            "error": { "code": -32600, "message": "Invalid Request" }
        })).unwrap();
        assert!(resp.result.is_none());
        let err = resp.error.unwrap();
        assert_eq!(err.code, -32600);
        assert!(err.message.contains("Invalid"));
    }

    #[test]
    fn notification_serializes_without_id() {
        let notif = JsonRpcNotification::new("notifications/initialized", None);
        let json = serde_json::to_value(&notif).unwrap();
        assert_eq!(json["jsonrpc"], "2.0");
        assert!(json.get("id").is_none());
        assert_eq!(json["method"], "notifications/initialized");
    }

    #[test]
    fn tool_info_defaults() {
        let ti: McpToolInfo = serde_json::from_value(serde_json::json!({
            "name": "empty"
        })).unwrap();
        assert_eq!(ti.name, "empty");
        assert_eq!(ti.description, "");
        assert_eq!(ti.input_schema, serde_json::Value::Null);
    }

    #[test]
    fn parse_tools_list_empty() {
        let tools = parse_tools_list(serde_json::json!({ "tools": [] })).unwrap();
        assert!(tools.is_empty());
    }

    #[test]
    fn flatten_no_content_falls_back_to_string() {
        let text = flatten_tool_call_result(serde_json::json!({ "status": "ok" }));
        assert!(text.contains("ok"));
    }

    #[test]
    fn flatten_mixed_content_items() {
        let text = flatten_tool_call_result(serde_json::json!({
            "content": [
                { "type": "text", "text": "a" },
                { "type": "image", "data": "x" },
                { "type": "text", "text": "b" }
            ]
        }));
        assert!(text.contains("a"));
        assert!(text.contains("b"));
    }
}
