use std::error::Error as StdError;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::llm::provider::{LlmConfig, LlmMessage, LlmProvider, LlmRole, TokenUsage, ToolCall, ToolDefinition};
use crate::llm::streaming::StreamEvent;

/// OpenAI / OpenAI-compatible LLM provider with streaming support.
pub struct OpenAiProvider {
    config: LlmConfig,
    client: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(config: LlmConfig) -> Result<Self, AppError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| AppError::Llm(format!("HTTP 客户端初始化失败: {}", e)))?;

        Ok(Self { config, client })
    }

    pub fn config(&self) -> &LlmConfig {
        &self.config
    }

    fn base_url(&self) -> &str {
        self.config
            .base_url
            .as_deref()
            .unwrap_or("https://api.openai.com/v1")
    }

    fn build_headers(&self) -> Result<HeaderMap, AppError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let auth = format!("Bearer {}", self.config.api_key);
        let auth_header = HeaderValue::from_str(&auth)
            .map_err(|e| AppError::Llm(format!("API key 含非法字符: {}", e)))?;
        headers.insert(AUTHORIZATION, auth_header);
        Ok(headers)
    }

    /// Stream a chat completion with automatic retry on transient errors.
    /// Decoded SSE events are pushed to `event_tx`.
    /// Returns the assembled final assistant message after the stream completes.
    pub async fn chat_stream(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
        event_tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<LlmMessage, AppError> {
        let max_retries = self.config.max_retries;
        let retry_conditions = parse_retry_conditions(&self.config.retry_http_statuses);
        let delay = Duration::from_secs_f32(self.config.retry_delay_secs);

        let mut attempt: u32 = 0;
        loop {
            attempt += 1;
            match self.chat_stream_inner(messages, tools, &event_tx).await {
                Ok(msg) => return Ok(msg),
                Err(e) => {
                    let max_attempts = max_retries + 1;
                    if attempt >= max_attempts || !is_retryable(&e, &retry_conditions) {
                        return Err(e);
                    }
                    let err_msg = format!("{}", e);
                    log::warn!(
                        "LLM 请求失败 (尝试 {}/{}): {}，{}s 后重试",
                        attempt,
                        max_attempts,
                        err_msg,
                        delay.as_secs_f32(),
                    );
                    let _ = event_tx.send(StreamEvent::Retrying {
                        attempt,
                        max_attempts,
                        delay_secs: delay.as_secs_f32(),
                        last_error: err_msg,
                    });
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }

    /// Inner implementation: single HTTP request + SSE parsing, no retry.
    async fn chat_stream_inner(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<LlmMessage, AppError> {
        let url = format!("{}/chat/completions", self.base_url().trim_end_matches('/'));
        let req_body = build_request_body(&self.config, messages, tools, true);

        let response = self
            .send_llm_request(&url, &req_body, messages.len())
            .await?;

        let mut accumulated_text = String::new();
        let mut accumulated_reasoning = String::new();
        let mut tool_calls: Vec<PartialToolCall> = Vec::new();
        let mut buffer = String::new();
        let mut consecutive_parse_errors: u32 = 0;
        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| AppError::Llm(format!("读取流式响应失败: {}", e)))?;
            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            while let Some(idx) = buffer.find('\n') {
                let line = buffer[..idx].trim_end_matches('\r').to_owned();
                buffer.drain(..=idx);

                let payload = match line.strip_prefix("data:") {
                    Some(rest) => rest.trim(),
                    None => continue,
                };

                if payload == "[DONE]" {
                    break;
                }
                if payload.is_empty() {
                    continue;
                }

                match serde_json::from_str::<ChatChunk>(payload) {
                    Ok(chunk) => {
                        consecutive_parse_errors = 0;
                        process_chunk(
                            &chunk,
                            &mut accumulated_text,
                            &mut accumulated_reasoning,
                            &mut tool_calls,
                            event_tx,
                        );
                        if let Some(usage) = chunk.usage {
                            let _ = event_tx.send(StreamEvent::Usage {
                                usage: TokenUsage::from(usage),
                            });
                        }
                    }
                    Err(e) => {
                        consecutive_parse_errors += 1;
                        log::warn!("无法解析 SSE 数据: {} | 原文: {}", e, payload);
                        if consecutive_parse_errors >= 3 {
                            let _ = event_tx.send(StreamEvent::Error {
                                message: format!(
                                    "LLM 流式响应连续解析失败 ({} 次)，请重试",
                                    consecutive_parse_errors
                                ),
                            });
                            return Err(AppError::Llm(format!(
                                "LLM 流式响应连续解析失败 ({} 次): 最近错误: {}",
                                consecutive_parse_errors, e
                            )));
                        }
                    }
                }
            }
        }

        Ok(assemble_final_message(
            accumulated_text,
            accumulated_reasoning,
            tool_calls,
        ))
    }

    async fn send_llm_request(
        &self,
        url: &str,
        req_body: &serde_json::Value,
        messages_len: usize,
    ) -> Result<reqwest::Response, AppError> {
        log::info!(
            "LLM 请求: {} model={} messages={}",
            url,
            self.config.model,
            messages_len
        );

        let response = self
            .client
            .post(url)
            .headers(self.build_headers()?)
            .json(req_body)
            .send()
            .await
            .map_err(|e| {
                let detail = format_reqwest_error(&e);
                log::error!("LLM 请求发送失败: {}", detail);
                AppError::Llm(format!("LLM 请求失败: {}", detail))
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = read_error_body(response).await;
            return Err(AppError::Llm(format!("LLM 返回错误 {}: {}", status, body)));
        }

        Ok(response)
    }

    /// Fetch the list of available models from the provider's `/models` endpoint.
    /// Used by the settings UI to let users pick a model id from what the
    /// provider actually serves. No retry — the user clicks the button on demand.
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, AppError> {
        let url = format!("{}/models", self.base_url().trim_end_matches('/'));
        log::info!("LLM 列出模型请求: {}", url);

        let response = self
            .client
            .get(&url)
            .headers(self.build_headers()?)
            .send()
            .await
            .map_err(|e| {
                let detail = format_reqwest_error(&e);
                log::error!("LLM 列出模型请求失败: {}", detail);
                AppError::Llm(format!("获取模型列表失败: {}", detail))
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = read_error_body(response).await;
            return Err(AppError::Llm(format!(
                "获取模型列表失败 (HTTP {}): {}",
                status, body
            )));
        }

        let resp: ModelsResponse = response
            .json()
            .await
            .map_err(|e| AppError::Llm(format!("解析模型列表响应失败: {}", e)))?;

        let models: Vec<ModelInfo> = resp
            .data
            .into_iter()
            .map(|entry| ModelInfo {
                id: entry.id,
                owned_by: entry.owned_by,
                created: entry.created,
            })
            .collect();

        log::info!("LLM 列出模型: 获取到 {} 个模型", models.len());
        Ok(models)
    }
}

#[async_trait]
impl LlmProvider for OpenAiProvider {
    /// Non-streaming entrypoint: same code path as streaming but discards the deltas.
    async fn send_message(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
    ) -> Result<LlmMessage, AppError> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        // Drain the receiver in a background task to avoid blocking
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        self.chat_stream(messages, tools, tx).await
    }
}

/// Walk a reqwest::Error's source chain and return a single string that
/// includes the underlying cause (TLS handshake failure, DNS failure, refused
/// connection, etc.). reqwest by itself often shows only the high-level
/// "error sending request for url" without the actual reason.
fn format_reqwest_error(err: &reqwest::Error) -> String {
    let mut parts: Vec<String> = vec![err.to_string()];
    let mut src: Option<&dyn StdError> = err.source();
    while let Some(e) = src {
        parts.push(format!("由: {}", e));
        src = e.source();
    }
    // Annotate common causes for clearer UX
    let category = if err.is_timeout() {
        Some("超时（网络不可达或服务器无响应）")
    } else if err.is_connect() {
        Some("连接失败（服务器拒绝/不存在/端口不通）")
    } else if err.is_request() {
        Some("请求构造失败")
    } else {
        None
    };
    if let Some(c) = category {
        parts.insert(0, format!("[{}]", c));
    }
    parts.join(" | ")
}

/// A single entry in the retry conditions list: either a single status code or a range.
#[derive(Debug, Clone)]
enum RetryCondition {
    Code(u16),
    Range(u16, u16),
}

/// Parse a comma-separated list of HTTP status codes/ranges.
/// Examples: "429" → [Code(429)], "500-599" → [Range(500,599)], "408, 429, 500-599" → mixed.
/// Whitespace is ignored. Invalid entries are skipped with a warning. Reversed ranges (e.g. "599-500") are auto-corrected.
fn parse_retry_conditions(input: &str) -> Vec<RetryCondition> {
    let mut conditions = Vec::new();
    for entry in input.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if let Some((lo, hi)) = entry.split_once('-') {
            match (lo.trim().parse::<u16>(), hi.trim().parse::<u16>()) {
                (Ok(lo), Ok(hi)) => {
                    let (lo, hi) = if lo <= hi { (lo, hi) } else { (hi, lo) };
                    conditions.push(RetryCondition::Range(lo, hi));
                }
                _ => log::warn!("忽略无效的重试范围配置: \"{}\"", entry),
            }
        } else if let Ok(code) = entry.parse::<u16>() {
            conditions.push(RetryCondition::Code(code));
        } else {
            log::warn!("忽略无效的重试状态码配置: \"{}\"", entry);
        }
    }
    conditions
}

/// Validate the retry conditions string. Returns an error message on invalid format.
pub(crate) fn validate_retry_conditions(input: &str) -> Result<(), String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Ok(());
    }
    for entry in trimmed.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if entry.contains('-') {
            let parts: Vec<&str> = entry.splitn(2, '-').collect();
            if parts.len() != 2 {
                return Err(format!("无效范围: \"{}\"（使用格式 lo-hi）", entry));
            }
            let lo: u16 = parts[0]
                .trim()
                .parse()
                .map_err(|_| format!("无法解析范围: \"{}\"", entry))?;
            let hi: u16 = parts[1]
                .trim()
                .parse()
                .map_err(|_| format!("无法解析范围: \"{}\"", entry))?;
            if lo < 100 || lo > 599 || hi < 100 || hi > 599 {
                return Err(format!("状态码超出范围 (100-599): \"{}\"", entry));
            }
            if hi < lo {
                return Err(format!("范围需从小到大: \"{}\"", entry));
            }
        } else {
            let code: u16 = entry
                .parse()
                .map_err(|_| format!("无效状态码: \"{}\"", entry))?;
            if code < 100 || code > 599 {
                return Err(format!("状态码超出范围 (100-599): \"{}\"", entry));
            }
        }
    }
    Ok(())
}

/// Check if a given HTTP status code matches any retry condition.
fn status_matches_conditions(status: u16, conditions: &[RetryCondition]) -> bool {
    conditions.iter().any(|c| match c {
        RetryCondition::Code(c) => status == *c,
        RetryCondition::Range(lo, hi) => status >= *lo && status <= *hi,
    })
}

/// Determine whether an LLM error is retryable based on the configured conditions.
/// - Network/timeout errors: always retryable.
/// - HTTP errors: retryable if the status code matches the configured conditions.
/// - Other errors (parse failures, etc.): not retryable.
fn is_retryable(err: &AppError, conditions: &[RetryCondition]) -> bool {
    match err {
        AppError::Llm(msg) => {
            // Extract HTTP status from error messages like "LLM 返回错误 429: ..."
            // or "LLM HTTP 429: ..."
            if let Some(status) = extract_http_status(msg) {
                status_matches_conditions(status, conditions)
            } else {
                // Connection/timeout errors contain keywords like "超时" or "连接失败"
                msg.contains("超时") || msg.contains("连接失败") || msg.contains("网络不可达")
            }
        }
        _ => false,
    }
}

/// Try to extract an HTTP status code from an error message.
/// Looks for patterns like "429" or "500" following "error" or "HTTP".
/// 读取错误响应体，最多取前 128KB，并保留读取失败的原始错误信息。
async fn read_error_body(response: reqwest::Response) -> String {
    let max_bytes = 128 * 1024;
    match response.text().await {
        Ok(body) => {
            if body.len() > max_bytes {
                format!(
                    "{}...（已截断，原始大小 {} 字节）",
                    &body[..max_bytes],
                    body.len()
                )
            } else {
                body
            }
        }
        Err(e) => format!("<无法读取响应体: {}>", e),
    }
}

fn extract_http_status(msg: &str) -> Option<u16> {
    // Pattern: "LLM 返回错误 429:" or "LLM HTTP 429:"
    for prefix in &["错误 ", "HTTP ", "错误"] {
        if let Some(pos) = msg.find(prefix) {
            let after = &msg[pos + prefix.len()..];
            let code_str: String = after.chars().take_while(|c| c.is_ascii_digit()).collect();
            if let Ok(code) = code_str.parse::<u16>() {
                if (100..=599).contains(&code) {
                    return Some(code);
                }
            }
        }
    }
    None
}

#[cfg(test)]
mod retry_tests {
    use super::*;

    #[test]
    fn parse_single_code() {
        let conditions = parse_retry_conditions("429");
        assert!(status_matches_conditions(429, &conditions));
        assert!(!status_matches_conditions(430, &conditions));
    }

    #[test]
    fn parse_range() {
        let conditions = parse_retry_conditions("500-599");
        assert!(status_matches_conditions(500, &conditions));
        assert!(status_matches_conditions(550, &conditions));
        assert!(status_matches_conditions(599, &conditions));
        assert!(!status_matches_conditions(499, &conditions));
        assert!(!status_matches_conditions(600, &conditions));
    }

    #[test]
    fn parse_mixed() {
        let conditions = parse_retry_conditions("408, 429, 500-599");
        assert!(status_matches_conditions(408, &conditions));
        assert!(status_matches_conditions(429, &conditions));
        assert!(status_matches_conditions(502, &conditions));
        assert!(!status_matches_conditions(400, &conditions));
        assert!(!status_matches_conditions(401, &conditions));
    }

    #[test]
    fn parse_empty_string() {
        let conditions = parse_retry_conditions("");
        assert!(conditions.is_empty());
    }

    #[test]
    fn parse_whitespace_only() {
        let conditions = parse_retry_conditions("  ,  ,  ");
        assert!(conditions.is_empty());
    }

    #[test]
    fn parse_invalid_entries_ignored() {
        let conditions = parse_retry_conditions("429, abc, 500-599");
        assert_eq!(conditions.len(), 2);
        assert!(status_matches_conditions(429, &conditions));
        assert!(status_matches_conditions(500, &conditions));
    }

    #[test]
    fn is_retryable_http_status_match() {
        let conditions = parse_retry_conditions("429, 500-599");
        let err = AppError::Llm("LLM 返回错误 429: rate limited".into());
        assert!(is_retryable(&err, &conditions));
    }

    #[test]
    fn is_retryable_http_status_no_match() {
        let conditions = parse_retry_conditions("429, 500-599");
        let err = AppError::Llm("LLM 返回错误 401: unauthorized".into());
        assert!(!is_retryable(&err, &conditions));
    }

    #[test]
    fn is_retryable_timeout_always() {
        let conditions = parse_retry_conditions("");
        let err = AppError::Llm("LLM 请求失败: [超时]".into());
        assert!(is_retryable(&err, &conditions));
    }

    #[test]
    fn is_retryable_connection_failed() {
        let conditions = parse_retry_conditions("");
        let err = AppError::Llm("LLM 请求失败: [连接失败]".into());
        assert!(is_retryable(&err, &conditions));
    }

    #[test]
    fn extract_status_from_various_formats() {
        assert_eq!(
            extract_http_status("LLM 返回错误 429: rate limit"),
            Some(429)
        );
        assert_eq!(extract_http_status("LLM HTTP 502: bad gateway"), Some(502));
        assert_eq!(extract_http_status("some error without status"), None);
    }

    // ── validate_retry_conditions tests ──

    #[test]
    fn validate_empty_ok() {
        assert!(validate_retry_conditions("").is_ok());
        assert!(validate_retry_conditions("   ").is_ok());
    }

    #[test]
    fn validate_single_code() {
        assert!(validate_retry_conditions("429").is_ok());
        assert!(validate_retry_conditions("500").is_ok());
    }

    #[test]
    fn validate_range() {
        assert!(validate_retry_conditions("500-599").is_ok());
    }

    #[test]
    fn validate_mixed() {
        assert!(validate_retry_conditions("408, 429, 500-599").is_ok());
    }

    #[test]
    fn validate_rejects_non_numeric() {
        assert!(validate_retry_conditions("abc").is_err());
    }

    #[test]
    fn validate_rejects_code_below_100() {
        assert!(validate_retry_conditions("99").is_err());
    }

    #[test]
    fn validate_rejects_code_above_599() {
        assert!(validate_retry_conditions("600").is_err());
    }

    #[test]
    fn validate_rejects_hi_less_than_lo() {
        assert!(validate_retry_conditions("500-400").is_err());
    }

    #[test]
    fn validate_rejects_range_hi_above_599() {
        assert!(validate_retry_conditions("500-600").is_err());
    }

    #[test]
    fn validate_rejects_range_lo_below_100() {
        assert!(validate_retry_conditions("99-500").is_err());
    }

    #[test]
    fn validate_rejects_malformed_range() {
        assert!(validate_retry_conditions("500--599").is_err());
    }

    #[test]
    fn validate_mixed_valid_and_invalid_rejects() {
        assert!(validate_retry_conditions("429, abc").is_err());
    }
}

fn process_chunk(
    chunk: &ChatChunk,
    accumulated_text: &mut String,
    accumulated_reasoning: &mut String,
    tool_calls: &mut Vec<PartialToolCall>,
    event_tx: &mpsc::UnboundedSender<StreamEvent>,
) {
    for choice in &chunk.choices {
        if let Some(ref delta) = choice.delta {
            if let Some(ref reasoning) = delta.reasoning_content {
                if !reasoning.is_empty() {
                    accumulated_reasoning.push_str(reasoning);
                    let _ = event_tx.send(StreamEvent::ThinkingDelta {
                        text: reasoning.clone(),
                    });
                }
            }
            if let Some(ref text) = delta.content {
                if !text.is_empty() {
                    accumulated_text.push_str(text);
                    let _ = event_tx.send(StreamEvent::TextDelta { text: text.clone() });
                }
            }
            if let Some(ref tcs) = delta.tool_calls {
                for delta_tc in tcs {
                    let idx = delta_tc.index.unwrap_or(0) as usize;
                    while tool_calls.len() <= idx {
                        tool_calls.push(PartialToolCall::default());
                    }
                    tool_calls[idx].apply_delta(delta_tc, event_tx);
                }
            }
        }
    }
}

fn assemble_final_message(
    accumulated_text: String,
    accumulated_reasoning: String,
    tool_calls: Vec<PartialToolCall>,
) -> LlmMessage {
    let final_tool_calls: Option<Vec<ToolCall>> = if tool_calls.is_empty() {
        None
    } else {
        Some(
            tool_calls
                .into_iter()
                .filter(|tc| !tc.id.is_empty())
                .map(|tc| {
                    let arguments = serde_json::from_str(&tc.arguments_buf)
                        .unwrap_or_else(|_| serde_json::Value::String(tc.arguments_buf.clone()));
                    ToolCall {
                        id: tc.id,
                        name: tc.name,
                        arguments,
                    }
                })
                .collect(),
        )
    };

    LlmMessage {
        role: LlmRole::Assistant,
        content: accumulated_text,
        tool_calls: final_tool_calls,
        tool_call_id: None,
        reasoning_content: if accumulated_reasoning.is_empty() {
            None
        } else {
            Some(accumulated_reasoning)
        },
        image_paths: None,
    }
}

#[derive(Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments_buf: String,
    start_emitted: bool,
}

impl PartialToolCall {
    fn apply_delta(
        &mut self,
        delta_tc: &DeltaToolCall,
        event_tx: &mpsc::UnboundedSender<StreamEvent>,
    ) {
        if let Some(ref id) = delta_tc.id {
            if self.id.is_empty() {
                self.id = id.clone();
            }
        }
        if let Some(ref func) = delta_tc.function {
            if let Some(ref name) = func.name {
                if self.name.is_empty() {
                    self.name = name.clone();
                    self.maybe_emit_start(event_tx);
                }
            }
            if let Some(ref args_delta) = func.arguments {
                self.arguments_buf.push_str(args_delta);
                let _ = event_tx.send(StreamEvent::ToolCallDelta {
                    id: self.id.clone(),
                    arguments_delta: args_delta.clone(),
                });
            }
        }
    }

    fn maybe_emit_start(&mut self, event_tx: &mpsc::UnboundedSender<StreamEvent>) {
        if !self.id.is_empty() && !self.name.is_empty() && !self.start_emitted {
            let _ = event_tx.send(StreamEvent::ToolCallStart {
                id: self.id.clone(),
                name: self.name.clone(),
            });
            self.start_emitted = true;
        }
    }
}
/* ---- Typed request structs — built once, then `to_value` + extra_body merge ---- */

#[derive(Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<RequestMessage>,
    temperature: f32,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<RequestTool>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream_options: Option<StreamOptions>,
}

#[derive(Serialize)]
struct StreamOptions {
    include_usage: bool,
}

#[derive(Serialize)]
#[serde(untagged)]
enum RequestContent {
    Text(String),
    Parts(Vec<RequestContentPart>),
}

#[derive(Serialize)]
struct RequestContentPart {
    #[serde(rename = "type")]
    part_type: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<RequestImageUrl>,
}

#[derive(Serialize)]
struct RequestImageUrl {
    url: String,
}

#[derive(Serialize)]
struct RequestMessage {
    role: &'static str,
    content: RequestContent,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<Vec<RequestToolCall>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning_content: Option<String>,
}

#[derive(Serialize)]
struct RequestToolCall {
    id: String,
    #[serde(rename = "type")]
    call_type: &'static str,
    function: RequestToolCallFunction,
}

#[derive(Serialize)]
struct RequestToolCallFunction {
    name: String,
    arguments: String,
}

#[derive(Serialize)]
struct RequestTool {
    #[serde(rename = "type")]
    tool_type: &'static str,
    function: RequestToolDef,
}

#[derive(Serialize)]
struct RequestToolDef {
    name: String,
    description: String,
    parameters: serde_json::Value,
}

fn build_request_body(
    config: &LlmConfig,
    messages: &[LlmMessage],
    tools: &[ToolDefinition],
    stream: bool,
) -> serde_json::Value {
    use crate::llm::provider::VISION_RECENT_USER_TURNS;

    let user_indices: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == LlmRole::User)
        .map(|(i, _)| i)
        .collect();
    let keep_from = if config.vision && user_indices.len() > VISION_RECENT_USER_TURNS {
        user_indices.len() - VISION_RECENT_USER_TURNS
    } else {
        0
    };
    let recent_user: std::collections::HashSet<usize> = if config.vision {
        user_indices
            .iter()
            .enumerate()
            .filter(|(rank, _)| *rank >= keep_from)
            .map(|(_, &idx)| idx)
            .collect()
    } else {
        std::collections::HashSet::new()
    };

    let messages = messages
        .iter()
        .enumerate()
        .map(|(idx, m)| RequestMessage {
            role: m.role.to_string(),
            content: build_request_content(m, config.vision && recent_user.contains(&idx)),
            tool_calls: m.tool_calls.as_ref().map(|tcs| {
                tcs.iter()
                    .map(|tc| RequestToolCall {
                        id: tc.id.clone(),
                        call_type: "function",
                        function: RequestToolCallFunction {
                            name: tc.name.clone(),
                            arguments: serde_json::to_string(&tc.arguments)
                                .unwrap_or_else(|_| "{}".into()),
                        },
                    })
                    .collect()
            }),
            tool_call_id: m.tool_call_id.clone(),
            // DeepSeek thinking 模式（默认开启）：带 tool_calls 的 assistant 消息
            // 的 reasoning_content 必须完整回传，否则 400。非 DeepSeek 提供商的
            // 响应没有 reasoning（messages 里为 None），保留逻辑与置 None 等价。
            reasoning_content: m.reasoning_content.clone(),
        })
        .collect();

    let tools = if tools.is_empty() {
        None
    } else {
        Some(
            tools
                .iter()
                .map(|t| RequestTool {
                    tool_type: "function",
                    function: RequestToolDef {
                        name: t.name.clone(),
                        description: t.description.clone(),
                        parameters: t.parameters.clone(),
                    },
                })
                .collect(),
        )
    };

    let typed = ChatCompletionRequest {
        model: config.model.clone(),
        messages,
        temperature: config.temperature,
        stream,
        tools,
        stream_options: if stream {
            Some(StreamOptions { include_usage: true })
        } else {
            None
        },
    };

    let mut body = serde_json::to_value(&typed).unwrap_or(serde_json::Value::Null);

    // Merge user-defined extra_body (free-form JSON) into the outgoing body.
    // Keys here override typed fields, letting users tweak any provider-specific
    // or otherwise-unexposed parameter (e.g. `thinking`, `top_p`, `seed`).
    if let Some(extra) = &config.extra_body {
        if let (serde_json::Value::Object(body_map), serde_json::Value::Object(extra_map)) =
            (&mut body, extra)
        {
            for (k, v) in extra_map {
                body_map.insert(k.clone(), v.clone());
            }
        } else if !extra.is_object() {
            log::warn!(
                "[llm] extra_body 必须是 JSON 对象（收到 {}），已忽略",
                value_type_name(extra)
            );
        }
    }

    body
}

fn value_type_name(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

/// `send_images`: true only for recent user turns when vision is enabled.
fn build_request_content(m: &LlmMessage, send_images: bool) -> RequestContent {
    use crate::llm::provider::IMAGE_PLACEHOLDER;

    let paths = m.image_paths.as_ref().filter(|p| !p.is_empty());
    let Some(paths) = paths else {
        return RequestContent::Text(m.content.clone());
    };

    if !send_images || m.role != LlmRole::User {
        let mut text = m.content.clone();
        let block = std::iter::repeat(IMAGE_PLACEHOLDER)
            .take(paths.len())
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            text = block;
        } else if !text.contains(IMAGE_PLACEHOLDER) {
            text.push('\n');
            text.push_str(&block);
        }
        return RequestContent::Text(text);
    }

    let mut parts: Vec<RequestContentPart> = Vec::new();
    if !m.content.is_empty() {
        parts.push(RequestContentPart {
            part_type: "text",
            text: Some(m.content.clone()),
            image_url: None,
        });
    }

    let mut loaded = 0usize;
    for rel in paths {
        match crate::agent::image_store::read_image_data_url(rel) {
            Ok(url) => {
                loaded += 1;
                parts.push(RequestContentPart {
                    part_type: "image_url",
                    text: None,
                    image_url: Some(RequestImageUrl { url }),
                });
            }
            Err(e) => {
                log::warn!("Failed to load image for LLM request ({}): {}", rel, e);
            }
        }
    }

    if loaded == 0 {
        // Missing files: degrade to placeholder text
        let mut text = m.content.clone();
        let block = std::iter::repeat(IMAGE_PLACEHOLDER)
            .take(paths.len())
            .collect::<Vec<_>>()
            .join(" ");
        if text.is_empty() {
            text = block;
        } else if !text.contains(IMAGE_PLACEHOLDER) {
            text.push('\n');
            text.push_str(&block);
        }
        return RequestContent::Text(text);
    }

    if parts.len() == 1 && parts[0].part_type == "text" {
        RequestContent::Text(m.content.clone())
    } else {
        RequestContent::Parts(parts)
    }
}

#[derive(Debug, Deserialize)]
struct ChatChunk {
    choices: Vec<ChatChoice>,
    #[serde(default)]
    usage: Option<ApiUsage>,
}

#[derive(Debug, Deserialize)]
struct ApiUsage {
    prompt_tokens: u32,
    completion_tokens: u32,
    total_tokens: u32,
    #[serde(default)]
    completion_tokens_details: Option<CompletionTokensDetails>,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
}

#[derive(Debug, Deserialize)]
struct CompletionTokensDetails {
    #[serde(default)]
    reasoning_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: Option<u32>,
}

impl From<ApiUsage> for TokenUsage {
    fn from(u: ApiUsage) -> Self {
        TokenUsage {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            reasoning_tokens: u
                .completion_tokens_details
                .and_then(|d| d.reasoning_tokens),
            cached_read_tokens: u
                .prompt_tokens_details
                .and_then(|d| d.cached_tokens),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ChatChoice {
    delta: Option<ChatDelta>,
}

#[derive(Debug, Deserialize)]
struct ChatDelta {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    tool_calls: Option<Vec<DeltaToolCall>>,
    #[serde(default)]
    reasoning_content: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DeltaToolCall {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<DeltaFunction>,
}

#[derive(Debug, Deserialize)]
struct DeltaFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owned_by: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<i64>,
}

#[derive(Debug, Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Debug, Deserialize)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    owned_by: Option<String>,
    #[serde(default)]
    created: Option<i64>,
}

#[cfg(test)]
mod models_tests {
    use super::*;

    #[test]
    fn deserialize_openai_models_response() {
        let payload = r#"{
            "data": [
                {"id": "gpt-4", "object": "model", "created": 1687882411, "owned_by": "openai"},
                {"id": "claude-opus-4-7", "object": "model", "owned_by": "anthropic"}
            ]
        }"#;
        let resp: ModelsResponse = serde_json::from_str(payload).expect("parse");
        assert_eq!(resp.data.len(), 2);
        assert_eq!(resp.data[0].id, "gpt-4");
        assert_eq!(resp.data[0].owned_by.as_deref(), Some("openai"));
        assert_eq!(resp.data[0].created, Some(1687882411));
        // created is optional
        assert_eq!(resp.data[1].created, None);
    }

    #[test]
    fn deserialize_empty_models_response() {
        let payload = r#"{"data": []}"#;
        let resp: ModelsResponse = serde_json::from_str(payload).expect("parse");
        assert!(resp.data.is_empty());
    }

    #[test]
    fn model_info_serializes_camel_case() {
        let info = ModelInfo {
            id: "gpt-4".into(),
            owned_by: Some("openai".into()),
            created: Some(1687882411),
        };
        let json = serde_json::to_value(&info).expect("serialize");
        assert_eq!(json.get("id").and_then(|v| v.as_str()), Some("gpt-4"));
        assert_eq!(json.get("ownedBy").and_then(|v| v.as_str()), Some("openai"));
        assert_eq!(
            json.get("created").and_then(|v| v.as_i64()),
            Some(1687882411)
        );
        // snake_case must NOT appear
        assert!(json.get("owned_by").is_none());
    }

    #[test]
    fn model_info_skips_none_fields() {
        let info = ModelInfo {
            id: "foo".into(),
            owned_by: None,
            created: None,
        };
        let json = serde_json::to_string(&info).expect("serialize");
        assert!(json.contains("\"id\":\"foo\""));
        assert!(!json.contains("ownedBy"));
        assert!(!json.contains("created"));
    }
}

#[cfg(test)]
mod build_request_body_tests {
    use super::*;
    use crate::llm::provider::LlmConfig;
    use crate::llm::provider::LlmMessage;
    use crate::llm::provider::LlmRole;
    use crate::llm::provider::ProviderType;

    fn base_config() -> LlmConfig {
        LlmConfig {
            provider_type: ProviderType::OpenAI,
            api_key: String::new(),
            model: "gpt-4".to_string(),
            base_url: None,
            temperature: 0.1,
            max_retries: 0,
            retry_delay_secs: 0.0,
            retry_http_statuses: String::new(),
            vision: false,
            extra_body: None,
        }
    }

    #[test]
    fn tool_calls_assistant_keeps_reasoning_content() {
        // DeepSeek thinking 模式：带 tool_calls 的 assistant 必须回传
        // reasoning_content（build_request_body 不得再置 None）
        let cfg = base_config();
        let msg = LlmMessage {
            role: LlmRole::Assistant,
            content: "".to_string(),
            tool_calls: Some(vec![crate::llm::provider::ToolCall {
                id: "call-1".into(),
                name: "execute_command".into(),
                arguments: serde_json::json!({ "command": "ls" }),
            }]),
            tool_call_id: None,
            reasoning_content: Some("let me check the directory".to_string()),
            image_paths: None,
        };
        let body = build_request_body(&cfg, &[msg], &[], true);
        let messages = body
            .get("messages")
            .and_then(|v| v.as_array())
            .expect("messages");
        let assistant = &messages[0];
        // DeepSeek 协议字段为 snake_case reasoning_content
        assert_eq!(
            assistant
                .get("reasoning_content")
                .and_then(|v| v.as_str()),
            Some("let me check the directory")
        );
        assert!(assistant.get("tool_calls").is_some());
    }

    #[test]
    fn no_reasoning_assistant_omits_field() {
        let cfg = base_config();
        let msg = LlmMessage {
            role: LlmRole::Assistant,
            content: "plain reply".to_string(),
            tool_calls: None,
            tool_call_id: None,
            reasoning_content: None,
            image_paths: None,
        };
        let body = build_request_body(&cfg, &[msg], &[], true);
        let messages = body
            .get("messages")
            .and_then(|v| v.as_array())
            .expect("messages");
        assert!(messages[0].get("reasoning_content").is_none());
    }

    #[test]
    fn no_extra_body_emits_only_typed_fields() {
        let cfg = base_config();
        let body = build_request_body(&cfg, &[LlmMessage::user("hi")], &[], true);
        assert_eq!(body.get("model").and_then(|v| v.as_str()), Some("gpt-4"));
        // 0.1 f32 在 f64 下变成 0.10000000149011612，按 f32 精度比对
        let temp = body
            .get("temperature")
            .and_then(|v| v.as_f64())
            .expect("temperature");
        assert!((temp - 0.1f32 as f64).abs() < 1e-6, "temperature drift: {temp}");
        assert!(body.get("extraBody").is_none());
    }

    #[test]
    fn extra_body_overrides_typed_temperature() {
        let mut cfg = base_config();
        cfg.extra_body = Some(serde_json::json!({ "temperature": 0.9 }));
        let body = build_request_body(&cfg, &[LlmMessage::user("hi")], &[], true);
        // 用户 extra_body 应能覆盖类型化字段
        let temp = body
            .get("temperature")
            .and_then(|v| v.as_f64())
            .expect("temperature");
        assert!((temp - 0.9).abs() < 1e-6, "temperature drift: {temp}");
    }

    #[test]
    fn extra_body_adds_new_keys() {
        let mut cfg = base_config();
        cfg.extra_body = Some(serde_json::json!({
            "top_p": 0.95,
            "max_tokens": 4096,
            "thinking": { "type": "enabled", "budget_tokens": 2048 }
        }));
        let body = build_request_body(&cfg, &[LlmMessage::user("hi")], &[], true);
        assert_eq!(body.get("top_p").and_then(|v| v.as_f64()), Some(0.95));
        assert_eq!(
            body.get("max_tokens").and_then(|v| v.as_u64()),
            Some(4096)
        );
        assert_eq!(
            body.get("thinking")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str()),
            Some("enabled")
        );
        assert_eq!(
            body.get("thinking")
                .and_then(|v| v.get("budget_tokens"))
                .and_then(|v| v.as_u64()),
            Some(2048)
        );
    }

    #[test]
    fn extra_body_empty_object_is_noop() {
        let mut cfg = base_config();
        cfg.extra_body = Some(serde_json::json!({}));
        let body = build_request_body(&cfg, &[LlmMessage::user("hi")], &[], true);
        // 空对象不应污染输出（不应出现空 key）
        assert_eq!(body.get("model").and_then(|v| v.as_str()), Some("gpt-4"));
    }

    #[test]
    fn extra_body_non_object_is_ignored() {
        let mut cfg = base_config();
        cfg.extra_body = Some(serde_json::json!([1, 2, 3]));
        let body = build_request_body(&cfg, &[LlmMessage::user("hi")], &[], true);
        // 非对象应当被忽略，发出 warn 但不阻断
        assert_eq!(body.get("model").and_then(|v| v.as_str()), Some("gpt-4"));
        // 不应注入 "array"-like 字段
        assert!(!body.as_object().unwrap().contains_key("0"));
    }

    #[test]
    fn extra_body_does_not_clobber_typed_required_fields() {
        let mut cfg = base_config();
        cfg.extra_body = Some(serde_json::json!({ "model": "should-not-win" }));
        let body = build_request_body(&cfg, &[LlmMessage::user("hi")], &[], true);
        // 实际行为是 extra_body 覆盖——这正是用户期望的能力（force override）
        // 因此 model 应为 extra_body 的值。测试就是记录这个语义，避免后续误改。
        assert_eq!(
            body.get("model").and_then(|v| v.as_str()),
            Some("should-not-win"),
            "extra_body 故意覆盖类型化字段是设计行为（force override）"
        );
    }
}
