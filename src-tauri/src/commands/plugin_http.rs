use std::collections::HashMap;
use std::time::Duration;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

const TIMEOUT_SECS: u64 = 20;
const MAX_RESPONSE_SIZE: usize = 256 * 1024;

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpRequest {
    pub url: String,
    #[serde(default = "default_method")]
    pub method: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
}

fn default_method() -> String {
    "GET".to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginHttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub url: String,
}

#[tauri::command]
pub async fn plugin_http_request(
    request: Option<PluginHttpRequest>,
    url: Option<String>,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
    pluginId: Option<String>,
) -> Result<PluginHttpResponse, AppError> {
    let _ = pluginId; // 兼容前端通用透传的 pluginId，不参与鉴权（鉴权已在 pluginIpc 层完成）
    let req = if let Some(r) = request {
        r
    } else if let Some(u) = url {
        PluginHttpRequest {
            url: u,
            method: method.unwrap_or_else(default_method),
            headers: headers.unwrap_or_default(),
            body,
        }
    } else {
        return Err(AppError::Other("missing required key request or url".into()));
    };
    plugin_http_request_inner(&req).await
}

pub(crate) async fn plugin_http_request_inner(
    request: &PluginHttpRequest,
) -> Result<PluginHttpResponse, AppError> {
    if !request.url.starts_with("http://") && !request.url.starts_with("https://") {
        return Err(AppError::Other(
            "invalid URL: must start with http:// or https://".into(),
        ));
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(TIMEOUT_SECS))
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|e| AppError::Other(format!("failed to create HTTP client: {}", e)))?;

    let mut req_builder = match request.method.to_uppercase().as_str() {
        "POST" => client.post(&request.url),
        "PUT" => client.put(&request.url),
        "DELETE" => client.delete(&request.url),
        "PATCH" => client.patch(&request.url),
        "HEAD" => client.head(&request.url),
        _ => client.get(&request.url),
    };

    for (key, value) in &request.headers {
        req_builder = req_builder.header(key.as_str(), value.as_str());
    }

    if let Some(body) = &request.body {
        req_builder = req_builder.body(body.clone());
    }

    let resp = req_builder
        .send()
        .await
        .map_err(|e| AppError::Other(format!("HTTP request failed: {}", e)))?;

    let final_url = resp.url().to_string();
    let status = resp.status().as_u16();

    let mut response_headers = HashMap::new();
    for (key, value) in resp.headers() {
        if let Ok(v) = value.to_str() {
            response_headers.insert(key.to_string(), v.to_string());
        }
    }

    let body_bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Other(format!("failed to read response body: {}", e)))?;

    let body = if body_bytes.len() > MAX_RESPONSE_SIZE {
        let truncated = &body_bytes[..MAX_RESPONSE_SIZE];
        String::from_utf8_lossy(truncated).to_string() + "\n[truncated]"
    } else {
        String::from_utf8_lossy(&body_bytes).to_string()
    };

    Ok(PluginHttpResponse {
        status,
        headers: response_headers,
        body,
        url: final_url,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_method_is_get() {
        assert_eq!(default_method(), "GET");
    }

    #[test]
    fn request_deserializes_with_defaults() {
        let json = r#"{"url": "https://example.com"}"#;
        let req: PluginHttpRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.url, "https://example.com");
        assert_eq!(req.method, "GET");
        assert!(req.headers.is_empty());
        assert!(req.body.is_none());
    }

    #[test]
    fn request_deserializes_with_all_fields() {
        let json = r#"{
            "url": "https://example.com/api",
            "method": "POST",
            "headers": {"Content-Type": "application/json"},
            "body": "{\"key\": \"value\"}"
        }"#;
        let req: PluginHttpRequest = serde_json::from_str(json).unwrap();
        assert_eq!(req.method, "POST");
        assert_eq!(req.headers.get("Content-Type").unwrap(), "application/json");
        assert!(req.body.is_some());
    }
}
