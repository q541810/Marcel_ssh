//! HTTP 客户端，与服务端通信（业务数据 E2E 密文）。
//!
//! 复用现有 reqwest 模式（参考 llm/openai.rs / commands/update.rs）。
//! WebSocket 变更通知见 `ws_client` + `scheduler::ws_loop`（仅信号，不传密文）。

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::error::AppError;

/// 默认 HTTP 超时（轻量请求：summary/devices/quota/join/setup 等）
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// 大载荷请求超时（pull 全量 / push 全量：6MB 级响应/请求在官方服务器
/// 序列化 + 传输下可能 30~120 秒，30s 会触发超时循环）
const LONG_TIMEOUT: Duration = Duration::from_secs(180);

/// 连接超时（独立于总超时：服务器不可达时快速失败，不占满总超时）
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// 同步服务端 API 客户端
///
/// `base_url` 可在配对后热更新（启动时可能是占位 `http://localhost:0`，
/// 用户 pair 后写入真实地址，scheduler 复用同一 `Arc<SyncClient>`）。
pub struct SyncClient {
    base_url: RwLock<String>,
    http: reqwest::Client,
}

/// 设备 API Key 认证 header
fn auth_header(api_key: &str) -> reqwest::header::HeaderMap {
    let mut headers = reqwest::header::HeaderMap::new();
    let value = format!("Bearer {}", api_key);
    if let Ok(hv) = reqwest::header::HeaderValue::from_str(&value) {
        headers.insert(reqwest::header::AUTHORIZATION, hv);
    }
    headers
}

// ── 请求/响应结构（与服务端 models.py 对齐，字段 snake_case）──────────

#[derive(Debug, Serialize)]
pub struct AccountSetupRequest {
    pub config_code_hash: String,
    pub encrypted_sync_key: String,
    pub device_id: String,
    pub platform: String,
    pub sync_profile: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct AccountSetupResponse {
    pub account_id: String,
    pub device_id: String,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct AccountJoinRequest {
    pub config_code_hash: String,
    pub device_id: String,
    pub platform: String,
    pub sync_profile: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct AccountJoinResponse {
    pub account_id: String,
    pub encrypted_sync_key: String,
    pub device_id: String,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct AccountDeleteRequest {
    pub config_code_hash: String,
}

#[derive(Debug, Serialize)]
pub struct DeviceRegisterRequest {
    pub device_id: String,
    pub platform: String,
    pub sync_profile: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct DeviceRegisterResponse {
    pub device_id: String,
    pub api_key: String,
}

#[derive(Debug, Serialize)]
pub struct SyncProfileUpdateRequest {
    pub device_id: String,
    pub sync_profile: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfoResponse {
    pub device_id: String,
    pub platform: String,
    pub sync_profile: serde_json::Value,
    pub last_seen_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncItem {
    pub key: String,
    pub version: i64,
    pub encrypted_value: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PushRequest {
    pub changes: Vec<SyncItem>,
}

#[derive(Debug, Deserialize)]
pub struct PushAcceptedItem {
    pub key: String,
    pub version: i64,
}

#[derive(Debug, Deserialize)]
pub struct PushRejectedItem {
    pub key: String,
    pub version: i64,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct PushResponse {
    pub accepted: Vec<PushAcceptedItem>,
    pub rejected: Vec<PushRejectedItem>,
}

#[derive(Debug, Serialize)]
pub struct PullRequest {
    pub last_sync_versions: std::collections::HashMap<String, i64>,
}

#[derive(Debug, Deserialize)]
pub struct PullResponse {
    pub items: Vec<SyncItem>,
    pub latest_versions: std::collections::HashMap<String, i64>,
}

#[derive(Debug, Deserialize)]
pub struct SnapshotResponse {
    pub items: Vec<SyncItem>,
    pub total_size: i64,
}

/// 账户配额使用情况（GET /api/account/quota）
#[derive(Debug, Clone, Deserialize)]
pub struct AccountQuotaResponse {
    /// 已用字节数（snapshots + sync_profiles）
    pub quota_used_bytes: i64,
    /// 配额上限字节数；0 = 无限制
    pub quota_limit_bytes: i64,
    /// "hosted" / "self-hosted"
    pub mode: String,
}

/// push 超配额（413）时服务端返回的结构化 detail
#[derive(Debug, Deserialize)]
struct QuotaExceededDetail {
    error: String,
    #[allow(dead_code)]
    current: i64,
    #[allow(dead_code)]
    push_size: i64,
    quota: i64,
}

// ── 客户端实现 ────────────────────────────────────────

impl SyncClient {
    /// 创建客户端。base_url 应形如 `https://ssh.neopig.top` 或 `http://192.168.1.100:8787`。
    pub fn new(base_url: &str) -> Result<Self, AppError> {
        let http = reqwest::Client::builder()
            .timeout(DEFAULT_TIMEOUT)
            .connect_timeout(CONNECT_TIMEOUT)
            .build()
            .map_err(|e| AppError::Config(format!("HTTP 客户端初始化失败：{}", e)))?;

        Ok(Self {
            base_url: RwLock::new(base_url.trim_end_matches('/').to_string()),
            http,
        })
    }

    /// 更新 base_url（配对 / 换服务器后调用）。去掉尾部 `/`。
    pub fn set_base_url(&self, base_url: &str) {
        *self.base_url.write() = base_url.trim_end_matches('/').to_string();
    }

    /// 当前 base_url（测试 / 调试用）。
    pub fn base_url(&self) -> String {
        self.base_url.read().clone()
    }

    fn url(&self, path: &str) -> String {
        format!("{}{}", self.base_url.read(), path)
    }

    /// 健康检查
    pub async fn health(&self) -> Result<serde_json::Value, AppError> {
        let url = self.url("/health");
        self.http
            .get(&url)
            .send()
            .await
            .map_err(|e| AppError::Network(format!("健康检查失败：{}", e)))?
            .json()
            .await
            .map_err(|e| AppError::Network(format!("解析健康检查响应失败：{}", e)))
    }

    /// 第一台设备注册账户
    pub async fn setup_account(
        &self,
        request: AccountSetupRequest,
    ) -> Result<AccountSetupResponse, AppError> {
        let url = self.url("/api/account/setup");
        let resp = self.http.post(&url).json(&request).send().await.map_err(map_network_err)?;
        handle_response(resp, "setup").await
    }

    /// 后续设备加入账户
    pub async fn join_account(
        &self,
        request: AccountJoinRequest,
    ) -> Result<AccountJoinResponse, AppError> {
        let url = self.url("/api/account/join");
        let resp = self.http.post(&url).json(&request).send().await.map_err(map_network_err)?;
        handle_response(resp, "join").await
    }

    /// 账户重置（删除账户及所有数据）
    ///
    /// 安全：服务端要求双重验证 ——
    /// - API Key（证明是账户内设备）
    /// - config_code_hash（证明知道配置码根信任锚）
    pub async fn delete_account(
        &self,
        api_key: &str,
        config_code_hash: &str,
    ) -> Result<(), AppError> {
        let url = self.url("/api/account");
        let request = AccountDeleteRequest {
            config_code_hash: config_code_hash.to_string(),
        };
        let resp = self.http
            .request(reqwest::Method::DELETE, &url)
            .headers(auth_header(api_key))
            .json(&request)
            .send()
            .await
            .map_err(map_network_err)?;
        handle_response_no_body(resp).await
    }

    /// 注册新设备（join 之后调用）
    pub async fn register_device(
        &self,
        api_key: &str,
        request: DeviceRegisterRequest,
    ) -> Result<DeviceRegisterResponse, AppError> {
        let url = self.url("/api/device/register");
        let resp = self.http
            .post(&url)
            .headers(auth_header(api_key))
            .json(&request)
            .send()
            .await
            .map_err(map_network_err)?;
        handle_response(resp, "register").await
    }

    /// 更新 sync_profile
    pub async fn update_sync_profile(
        &self,
        api_key: &str,
        request: SyncProfileUpdateRequest,
    ) -> Result<(), AppError> {
        let url = self.url("/api/device/sync_profile");
        let resp = self.http
            .put(&url)
            .headers(auth_header(api_key))
            .json(&request)
            .send()
            .await
            .map_err(map_network_err)?;
        handle_response_no_body(resp).await
    }

    /// 列出账户下所有设备
    pub async fn list_devices(
        &self,
        api_key: &str,
    ) -> Result<Vec<DeviceInfoResponse>, AppError> {
        let url = self.url("/api/devices");
        let resp = self.http
            .get(&url)
            .headers(auth_header(api_key))
            .send()
            .await
            .map_err(map_network_err)?;
        handle_response(resp, "devices").await
    }

    /// 删除（撤销）某设备
    pub async fn delete_device(&self, api_key: &str, device_id: &str) -> Result<(), AppError> {
        let url = self.url(&format!("/api/device/{}", device_id));
        let resp = self
            .http
            .delete(&url)
            .headers(auth_header(api_key))
            .send()
            .await
            .map_err(map_network_err)?;
        handle_response_no_body(resp).await
    }

    /// 推送变更
    pub async fn push(
        &self,
        api_key: &str,
        request: PushRequest,
    ) -> Result<PushResponse, AppError> {
        let url = self.url("/api/sync/push");
        let resp = self.http
            .post(&url)
            .headers(auth_header(api_key))
            .json(&request)
            .timeout(LONG_TIMEOUT)
            .send()
            .await
            .map_err(map_network_err)?;
        if resp.status() == reqwest::StatusCode::PAYLOAD_TOO_LARGE {
            return Err(parse_quota_exceeded(resp).await);
        }
        handle_response(resp, "push").await
    }

    /// 查询账户配额使用情况（托管模式返回实际用量；自部署 quota=0 表示无限制）
    pub async fn get_account_quota(
        &self,
        api_key: &str,
    ) -> Result<AccountQuotaResponse, AppError> {
        let url = self.url("/api/account/quota");
        let resp = self.http
            .get(&url)
            .headers(auth_header(api_key))
            .send()
            .await
            .map_err(map_network_err)?;
        handle_response(resp, "quota").await
    }

    /// 增量拉取
    pub async fn pull(
        &self,
        api_key: &str,
        request: PullRequest,
    ) -> Result<PullResponse, AppError> {
        let url = self.url("/api/sync/pull");
        let resp = self.http
            .post(&url)
            .headers(auth_header(api_key))
            .json(&request)
            .timeout(LONG_TIMEOUT)
            .send()
            .await
            .map_err(map_network_err)?;
        handle_response(resp, "pull").await
    }

    /// 全量快照拉取（新设备首次同步；当前未被调用，防御性保留长超时）
    pub async fn snapshot(&self, api_key: &str) -> Result<SnapshotResponse, AppError> {
        let url = self.url("/api/sync/snapshot");
        let resp = self.http
            .get(&url)
            .headers(auth_header(api_key))
            .timeout(LONG_TIMEOUT)
            .send()
            .await
            .map_err(map_network_err)?;
        handle_response(resp, "snapshot").await
    }
}

/// 网络错误映射
fn map_network_err(e: reqwest::Error) -> AppError {
    if e.is_timeout() {
        AppError::Network(format!("请求超时：{}", e))
    } else if e.is_connect() {
        AppError::Network(format!("连接失败：{}", e))
    } else {
        AppError::Network(format!("网络错误：{}", e))
    }
}

/// 处理响应：成功解析 JSON（移出异步工作线程，避免大响应阻塞事件循环），
/// 失败提取错误信息。`label` 用于日志（如 "pull"），便于定位响应字节数。
async fn handle_response<T>(
    resp: reqwest::Response,
    label: &str,
) -> Result<T, AppError>
where
    T: serde::de::DeserializeOwned + Send + 'static,
{
    let status = resp.status();
    if status.is_success() {
        let bytes = resp.bytes().await.map_err(|e| {
            AppError::Network(format!("读取响应失败 ({}): {}", label, e))
        })?;
        log::info!("[sync] {} 响应 {} 字节", label, bytes.len());
        tokio::task::spawn_blocking(move || serde_json::from_slice::<T>(&bytes))
            .await
            .map_err(|e| {
                AppError::Network(format!("解析任务失败 ({}): {}", label, e))
            })?
            .map_err(|e| {
                AppError::Network(format!("解析响应失败 ({}): {}", label, e))
            })
    } else {
        let text = resp.text().await.unwrap_or_default();
        Err(AppError::Network(format!(
            "服务端错误 ({}): {}",
            status.as_u16(),
            text
        )))
    }
}

/// 处理无 body 响应
async fn handle_response_no_body(resp: reqwest::Response) -> Result<(), AppError> {
    let status = resp.status();
    if status.is_success() {
        Ok(())
    } else {
        let text = resp.text().await.unwrap_or_default();
        Err(AppError::Network(format!(
            "服务端错误 ({}): {}",
            status.as_u16(),
            text
        )))
    }
}

/// 解析 413 配额超限响应为友好文案。
///
/// 新版服务端返回结构化 detail `{ error, current, push_size, quota }`；
/// 旧版服务端返回字符串 detail（`{"detail": "配额超限：…"}`），解析失败时回退原始文本。
async fn parse_quota_exceeded(resp: reqwest::Response) -> AppError {
    let text = resp.text().await.unwrap_or_default();
    parse_quota_exceeded_text(&text)
}

/// 纯函数版 413 解析（便于单测）。
fn parse_quota_exceeded_text(text: &str) -> AppError {
    let fallback = || AppError::Network(format!("服务端错误 (413): {}", text));

    // 新版服务端：{"detail": {"error": "quota_exceeded", "current": .., "push_size": .., "quota": ..}}
    let detail: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return fallback(),
    };
    let detail = match detail.get("detail") {
        Some(d) => d,
        None => return fallback(),
    };
    let detail: QuotaExceededDetail = match serde_json::from_value(detail.clone()) {
        Ok(d) => d,
        Err(_) => return fallback(),
    };
    if detail.error != "quota_exceeded" {
        return fallback();
    }

    AppError::Network(format!(
        "同步配额已满：已用 {}，配额 {}，本次需 {}",
        format_quota_bytes(detail.current),
        format_quota_bytes(detail.quota),
        format_quota_bytes(detail.push_size),
    ))
}

/// 字节数 → 人类可读（≤1024 用 B，否则 KB/MB/GB）
fn format_quota_bytes(bytes: i64) -> String {
    const KB: f64 = 1024.0;
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1} GB", b / GB)
    } else if b >= MB {
        format!("{:.1} MB", b / MB)
    } else if b >= KB {
        format!("{:.1} KB", b / KB)
    } else {
        format!("{} B", bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_client_creation() {
        let client = SyncClient::new("http://127.0.0.1:8787").unwrap();
        assert_eq!(client.base_url(), "http://127.0.0.1:8787");

        // 尾部斜杠应被去除
        let client2 = SyncClient::new("http://127.0.0.1:8787/").unwrap();
        assert_eq!(client2.base_url(), "http://127.0.0.1:8787");
    }

    #[test]
    fn test_set_base_url() {
        let client = SyncClient::new("http://localhost:0").unwrap();
        assert_eq!(client.base_url(), "http://localhost:0");
        client.set_base_url("https://ssh.neopig.top/");
        assert_eq!(client.base_url(), "https://ssh.neopig.top");
    }

    #[test]
    fn test_auth_header() {
        let headers = auth_header("test_api_key");
        let auth = headers.get(reqwest::header::AUTHORIZATION).unwrap();
        assert_eq!(auth.to_str().unwrap(), "Bearer test_api_key");
    }

    #[test]
    fn test_parse_quota_exceeded_structured() {
        let body = r#"{"detail":{"error":"quota_exceeded","current":1048576,"push_size":204800,"quota":5242880}}"#;
        let err = parse_quota_exceeded_text(body);
        assert!(err.to_string().contains("1.0 MB"));
        assert!(err.to_string().contains("5.0 MB"));
        assert!(err.to_string().contains("200.0 KB"));
    }

    #[test]
    fn test_parse_quota_exceeded_old_server_falls_back() {
        // 旧版服务端：detail 是字符串，解析失败应回退原始文本
        let body = r#"{"detail":"配额超限：当前 1048576 字节 + 推送 204800 字节 > 配额 5242880 字节"}"#;
        let err = parse_quota_exceeded_text(body);
        assert!(err.to_string().contains("配额超限"));
        assert!(err.to_string().contains("413"));
    }

    #[test]
    fn test_parse_quota_exceeded_non_json_falls_back() {
        let err = parse_quota_exceeded_text("server error: nginx 413");
        assert!(err.to_string().contains("server error"));
    }

    #[test]
    fn test_parse_quota_exceeded_other_error_type_falls_back() {
        // 413 但 error 类型不是 quota_exceeded（异常数据），回退
        let body = r#"{"detail":{"error":"something_else","current":1,"push_size":2,"quota":3}}"#;
        let err = parse_quota_exceeded_text(body);
        assert!(err.to_string().contains("413"));
    }

    #[test]
    fn test_format_quota_bytes() {
        assert_eq!(format_quota_bytes(0), "0 B");
        assert_eq!(format_quota_bytes(512), "512 B");
        assert_eq!(format_quota_bytes(1024), "1.0 KB");
        assert_eq!(format_quota_bytes(5 * 1024 * 1024), "5.0 MB");
        assert_eq!(format_quota_bytes(2 * 1024 * 1024 * 1024), "2.0 GB");
    }
}
