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
}
