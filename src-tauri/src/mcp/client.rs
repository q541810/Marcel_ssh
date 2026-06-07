use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use async_trait::async_trait;

use crate::error::AppError;
use crate::mcp::protocol::{
    flatten_tool_call_result, parse_tools_list, JsonRpcNotification, JsonRpcRequest,
    JsonRpcResponse, McpToolInfo,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

#[async_trait]
pub trait McpClientLike: Send + Sync {
    async fn initialize(&self, url: &str, headers: &HashMap<String, String>) -> Result<(), AppError>;
    async fn list_tools(&self, url: &str, headers: &HashMap<String, String>) -> Result<Vec<McpToolInfo>, AppError>;
    async fn call_tool(
        &self,
        url: &str,
        headers: &HashMap<String, String>,
        name: &str,
        arguments: serde_json::Value,
    ) -> Result<String, AppError>;
}

pub struct McpClient {
    http: reqwest::Client,
    next_id: AtomicU64,
}

impl McpClient {
    pub fn new() -> Self {
        Self {
            http: reqwest::Client::builder().timeout(REQUEST_TIMEOUT).build().expect("reqwest"),
            next_id: AtomicU64::new(1),
        }
    }

    async fn post_rpc(&self, url: &str, headers: &HashMap<String, String>, req: &JsonRpcRequest) -> Result<JsonRpcResponse, AppError> {
        let resp = self
            .http
            .post(url)
            .headers(build_headers(headers))
            .json(req)
            .send()
            .await
            .map_err(|e| AppError::Config(format!("MCP HTTP 失败: {}", e)))?;
        let status = resp.status();
        let body: serde_json::Value = resp
            .json()
            .await
            .map_err(|e| {
                log::warn!("MCP 响应非 JSON [{}] (状态 {})", url, status);
                AppError::Config(format!("MCP 响应解析失败: {}", e))
            })?;
        if !status.is_success() {
            log::warn!("MCP HTTP {} [{}] ← body: {}", status.as_u16(), url, body);
            return Err(AppError::Config(format!("MCP HTTP {}: {}", status.as_u16(), body)));
        }
        serde_json::from_value(body)
            .map_err(|e| AppError::Config(format!("JSON-RPC 解析失败: {}", e)))
    }

    async fn post_notification(&self, url: &str, headers: &HashMap<String, String>, notif: &JsonRpcNotification) -> Result<(), AppError> {
        let _ = self.http.post(url).headers(build_headers(headers)).json(notif).send().await;
        Ok(())
    }
}

#[async_trait]
impl McpClientLike for McpClient {
    async fn initialize(&self, url: &str, headers: &HashMap<String, String>) -> Result<(), AppError> {
        let req = JsonRpcRequest::new(0, "initialize", Some(serde_json::json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "Marcel SSH", "version": env!("CARGO_PKG_VERSION") }
        })));
        let resp = self.post_rpc(url, headers, &req).await?;
        if let Some(err) = resp.error {
            return Err(AppError::Config(format!("MCP init error {}: {}", err.code, err.message)));
        }
        let notif = JsonRpcNotification::new("notifications/initialized", None);
        let _ = self.post_notification(url, headers, &notif).await;
        Ok(())
    }

    async fn list_tools(&self, url: &str, headers: &HashMap<String, String>) -> Result<Vec<McpToolInfo>, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = JsonRpcRequest::new(id, "tools/list", None);
        let resp = self.post_rpc(url, headers, &req).await?;
        if let Some(err) = resp.error {
            return Err(AppError::Config(format!("tools/list error {}: {}", err.code, err.message)));
        }
        parse_tools_list(resp.result.ok_or_else(|| AppError::Config("tools/list no result".into()))?)
    }

    async fn call_tool(
        &self,
        url: &str,
        headers: &HashMap<String, String>,
        name: &str,
        arguments: serde_json::Value,
    ) -> Result<String, AppError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = JsonRpcRequest::new(id, "tools/call", Some(serde_json::json!({
            "name": name,
            "arguments": arguments,
        })));
        let resp = self.post_rpc(url, headers, &req).await?;
        if let Some(err) = resp.error {
            return Err(AppError::Config(format!("tools/call error {}: {}", err.code, err.message)));
        }
        Ok(flatten_tool_call_result(resp.result.ok_or_else(|| AppError::Config("tools/call no result".into()))?))
    }
}

fn build_headers(headers: &HashMap<String, String>) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    for (k, v) in headers {
        if let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_str(v),
        ) {
            map.insert(name, value);
        }
    }
    map
}

#[cfg(test)]
#[derive(Clone)]
pub struct SpyClient {
    pub init_calls: std::sync::Arc<tokio::sync::Mutex<Vec<String>>>,
    pub list_calls: std::sync::Arc<tokio::sync::Mutex<Vec<String>>>,
    pub tools_to_return: std::sync::Arc<tokio::sync::Mutex<Vec<McpToolInfo>>>,
    pub init_error: std::sync::Arc<tokio::sync::Mutex<Option<String>>>,
    pub list_error: std::sync::Arc<tokio::sync::Mutex<Option<String>>>,
}

#[cfg(test)]
impl SpyClient {
    pub fn new() -> Self {
        Self {
            init_calls: std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new())),
            list_calls: std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new())),
            tools_to_return: std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new())),
            init_error: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
            list_error: std::sync::Arc::new(tokio::sync::Mutex::new(None)),
        }
    }
}

#[cfg(test)]
#[async_trait]
impl McpClientLike for SpyClient {
    async fn initialize(&self, url: &str, _headers: &HashMap<String, String>) -> Result<(), AppError> {
        self.init_calls.lock().await.push(url.to_string());
        if let Some(ref msg) = *self.init_error.lock().await {
            return Err(AppError::Config(msg.clone()));
        }
        Ok(())
    }

    async fn list_tools(&self, url: &str, _headers: &HashMap<String, String>) -> Result<Vec<McpToolInfo>, AppError> {
        self.list_calls.lock().await.push(url.to_string());
        if let Some(ref msg) = *self.list_error.lock().await {
            return Err(AppError::Config(msg.clone()));
        }
        Ok(self.tools_to_return.lock().await.clone())
    }

    async fn call_tool(
        &self,
        _url: &str,
        _headers: &HashMap<String, String>,
        _name: &str,
        _arguments: serde_json::Value,
    ) -> Result<String, AppError> {
        Ok("mocked call result".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_headers_valid() {
        let mut h = HashMap::new();
        h.insert("Authorization".into(), "Bearer token".into());
        h.insert("X-Custom".into(), "value".into());
        let headers = build_headers(&h);
        assert_eq!(headers.get("Authorization").unwrap(), "Bearer token");
        assert_eq!(headers.get("X-Custom").unwrap(), "value");
    }

    #[test]
    fn build_headers_empty() {
        let headers = build_headers(&HashMap::new());
        assert!(headers.is_empty());
    }

    #[test]
    fn build_headers_skips_invalid_name() {
        let mut h = HashMap::new();
        h.insert("Bad Header".into(), "val".into());
        let headers = build_headers(&h);
        assert!(headers.get("Bad Header").is_none());
    }

    #[test]
    fn build_headers_skips_invalid_value() {
        let mut h = HashMap::new();
        h.insert("X-Custom".into(), "invisible \0 char".into());
        let headers = build_headers(&h);
        assert!(headers.get("X-Custom").is_none());
    }
}
