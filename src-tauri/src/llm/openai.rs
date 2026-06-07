use std::collections::HashSet;
use std::error::Error as StdError;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::error::AppError;
use crate::llm::provider::{LlmConfig, LlmMessage, LlmProvider, LlmRole, ToolCall, ToolDefinition};
use crate::llm::streaming::StreamEvent;

/// OpenAI / OpenAI-compatible LLM provider with streaming support.
pub struct OpenAiProvider {
    config: LlmConfig,
    client: reqwest::Client,
}

impl OpenAiProvider {
    pub fn new(config: LlmConfig) -> Result<Self, AppError> {
        let mut builder = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .pool_idle_timeout(Duration::from_secs(60));

        if config.allow_invalid_certs {
            // Required for self-hosted endpoints with self-signed certs.
            // Tradeoff: this trusts the network path; documented in Settings UI.
            builder = builder.danger_accept_invalid_certs(true);
        }

        let client = builder
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

        let allowed_tool_names: HashSet<&str> = tools.iter().map(|t| t.name.as_str()).collect();
        let tool_calling_enabled = !allowed_tool_names.is_empty();
        let req_body = build_request_body(&self.config, messages, tools, true);

        log::info!(
            "LLM 请求: {} model={} messages={}",
            url,
            self.config.model,
            messages.len()
        );

        let response = self
            .client
            .post(&url)
            .headers(self.build_headers()?)
            .json(&req_body)
            .send()
            .await
            .map_err(|e| {
                let detail = format_reqwest_error(&e);
                log::error!("LLM 请求发送失败: {}", detail);
                AppError::Llm(format!("LLM 请求失败: {}", detail))
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = response
                .text()
                .await
                .unwrap_or_else(|_| "<无法读取响应体>".into());
            return Err(AppError::Llm(format!("LLM 返回错误 {}: {}", status, body)));
        }

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

            // SSE: parse complete lines (terminated by \n)
            while let Some(idx) = buffer.find('\n') {
                let line = buffer[..idx].trim_end_matches('\r').to_owned();
                buffer.drain(..=idx);

                let payload = match line.strip_prefix("data:") {
                    Some(rest) => rest.trim(),
                    None => continue,
                };

                if payload == "[DONE]" {
                    // Do NOT send StreamEvent::Done here. The caller
                    // (agent loop) controls the final Done to avoid
                    // prematurely closing the frontend listener when
                    // tool calls still need to be executed.
                    break;
                }
                if payload.is_empty() {
                    continue;
                }

                match serde_json::from_str::<ChatChunk>(payload) {
                    Ok(chunk) => {
                        consecutive_parse_errors = 0;
                        for choice in chunk.choices {
                            if let Some(delta) = choice.delta {
                                if let Some(ref reasoning) = delta.reasoning_content {
                                    if !reasoning.is_empty() {
                                        accumulated_reasoning.push_str(reasoning);
                                        let _ = event_tx.send(StreamEvent::ThinkingDelta {
                                            text: reasoning.clone(),
                                        });
                                    }
                                }
                                if let Some(text) = delta.content {
                                    if !text.is_empty() {
                                        accumulated_text.push_str(&text);
                                        let _ = event_tx.send(StreamEvent::TextDelta { text });
                                    }
                                }
                                if tool_calling_enabled {
                                    if let Some(tcs) = delta.tool_calls {
                                        for delta_tc in tcs {
                                            let idx = delta_tc.index.unwrap_or(0) as usize;
                                            while tool_calls.len() <= idx {
                                                tool_calls.push(PartialToolCall::default());
                                            }
                                            let entry = &mut tool_calls[idx];
                                            if let Some(id) = delta_tc.id {
                                                if entry.id.is_empty() {
                                                    entry.id = id;
                                                    if entry.allowed == Some(true)
                                                        && !entry.name.is_empty()
                                                        && !entry.start_emitted
                                                    {
                                                        let _ = event_tx.send(
                                                            StreamEvent::ToolCallStart {
                                                                id: entry.id.clone(),
                                                                name: entry.name.clone(),
                                                            },
                                                        );
                                                        entry.start_emitted = true;
                                                    }
                                                }
                                            }
                                            if let Some(func) = delta_tc.function {
                                                if let Some(name) = func.name {
                                                    if entry.name.is_empty() {
                                                        entry.allowed = Some(
                                                            allowed_tool_names
                                                                .contains(name.as_str()),
                                                        );
                                                        if entry.allowed == Some(true) {
                                                            entry.name = name.clone();
                                                            if !entry.id.is_empty()
                                                                && !entry.start_emitted
                                                            {
                                                                let _ = event_tx.send(
                                                                    StreamEvent::ToolCallStart {
                                                                        id: entry.id.clone(),
                                                                        name,
                                                                    },
                                                                );
                                                                entry.start_emitted = true;
                                                            }
                                                        }
                                                    }
                                                }
                                                if let Some(args_delta) = func.arguments {
                                                    if entry.allowed == Some(true) {
                                                        entry.arguments_buf.push_str(&args_delta);
                                                        let _ = event_tx.send(
                                                            StreamEvent::ToolCallDelta {
                                                                id: entry.id.clone(),
                                                                arguments_delta: args_delta,
                                                            },
                                                        );
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
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

        // Note: we do NOT send StreamEvent::Done here. The agent loop is
        // responsible for sending Done after all tool-call rounds complete.

        // Assemble the final message
        let final_tool_calls: Option<Vec<ToolCall>> = if tool_calls.is_empty() {
            None
        } else {
            Some(
                tool_calls
                    .into_iter()
                    .filter(|tc| !tc.id.is_empty() && tc.allowed == Some(true))
                    .map(|tc| {
                        let arguments =
                            serde_json::from_str(&tc.arguments_buf).unwrap_or_else(|_| {
                                serde_json::Value::String(tc.arguments_buf.clone())
                            });
                        ToolCall {
                            id: tc.id,
                            name: tc.name,
                            arguments,
                        }
                    })
                    .collect(),
            )
        };

        let reasoning = if accumulated_reasoning.is_empty() {
            None
        } else {
            Some(accumulated_reasoning)
        };

        Ok(LlmMessage {
            role: LlmRole::Assistant,
            content: accumulated_text,
            tool_calls: final_tool_calls,
            tool_call_id: None,
            reasoning_content: reasoning,
        })
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
/// Whitespace is ignored. Invalid entries are silently skipped.
fn parse_retry_conditions(input: &str) -> Vec<RetryCondition> {
    let mut conditions = Vec::new();
    for entry in input.split(',') {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if let Some((lo, hi)) = entry.split_once('-') {
            if let (Ok(lo), Ok(hi)) = (lo.trim().parse::<u16>(), hi.trim().parse::<u16>()) {
                conditions.push(RetryCondition::Range(lo, hi));
            }
        } else if let Ok(code) = entry.parse::<u16>() {
            conditions.push(RetryCondition::Code(code));
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

#[derive(Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments_buf: String,
    allowed: Option<bool>,
    start_emitted: bool,
}

/* ---- Typed request structs — serialize once, zero intermediate Values ---- */

#[derive(Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<RequestMessage>,
    temperature: f32,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    tools: Option<Vec<RequestTool>>,
}

#[derive(Serialize)]
struct RequestMessage {
    role: &'static str,
    content: String,
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
) -> ChatCompletionRequest {
    let messages = messages
        .iter()
        .map(|m| RequestMessage {
            role: m.role.to_string(),
            content: m.content.clone(),
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

    ChatCompletionRequest {
        model: config.model.clone(),
        messages,
        temperature: config.temperature,
        stream,
        tools,
    }
}

#[derive(Debug, Deserialize)]
struct ChatChunk {
    choices: Vec<ChatChoice>,
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
