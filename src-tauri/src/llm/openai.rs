use std::time::Duration;

use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::llm::error::{format_reqwest_error, LlmError, RequestPhase};
use crate::llm::provider::{
    LlmConfig, LlmMessage, LlmRole, TokenUsage, ToolCall, ToolDefinition, IMAGE_PLACEHOLDER,
};
use crate::llm::streaming::StreamEvent;

/// OpenAI / OpenAI-compatible LLM provider with streaming support (Single-request transport layer).
pub struct OpenAiProvider {
    config: LlmConfig,
    client: reqwest::Client,
}

/// 流式文本回调（用于压缩摘要等内嵌 LLM 调用）。
/// - `reset`：新一轮流开始前调用（重试会重新发起请求），调用方应清空已展示的进度文本。
/// - `delta`：每次收到内容增量时调用。
#[derive(Clone, Copy)]
pub struct TextSink<'a> {
    pub reset: &'a (dyn Fn() + Send + Sync),
    pub delta: &'a (dyn Fn(&str) + Send + Sync),
}

impl OpenAiProvider {
    pub fn new(config: LlmConfig) -> Result<Self, LlmError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(180))
            .pool_idle_timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| LlmError::Config(format!("HTTP 客户端初始化失败: {}", e)))?;

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

    fn build_headers(&self) -> Result<HeaderMap, LlmError> {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        let auth = format!("Bearer {}", self.config.api_key);
        let auth_header = HeaderValue::from_str(&auth)
            .map_err(|e| LlmError::Config(format!("API key 含非法字符: {}", e)))?;
        headers.insert(AUTHORIZATION, auth_header);
        Ok(headers)
    }

    /// 执行单次流式聊天补全请求（无内部重试循环，阶段错误结构化返回）。
    /// 返回 `(Result<LlmMessage, LlmError>, RequestPhase)`，表明请求结束时的阶段。
    pub async fn execute_stream(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<StreamEvent>,
        sink: Option<TextSink<'_>>,
        max_tokens: Option<u32>,
    ) -> (Result<LlmMessage, LlmError>, RequestPhase) {
        let url = format!("{}/chat/completions", self.base_url().trim_end_matches('/'));
        let req_body =
            build_request_body_with_max_tokens(&self.config, messages, tools, true, max_tokens);

        let response = match self.send_llm_request(&url, &req_body, messages.len()).await {
            Ok(resp) => resp,
            Err(err) => return (Err(err), RequestPhase::Probing),
        };

        let mut accumulated_text = String::new();
        let mut accumulated_reasoning = String::new();
        let mut tool_calls: Vec<PartialToolCall> = Vec::new();
        let mut finish_reason: Option<String> = None;
        let mut buffer = String::new();
        let mut consecutive_parse_errors: u32 = 0;
        let mut stream = response.bytes_stream();
        let first_byte_timeout =
            Duration::from_secs(self.config.first_byte_timeout_secs.clamp(20, 250));
        let mut phase = RequestPhase::Probing;
        let mut saw_done = false;

        loop {
            let next = tokio::time::timeout(first_byte_timeout, stream.next()).await;
            let chunk_opt = match next {
                Ok(v) => v,
                Err(_) => {
                    let detail = if phase == RequestPhase::Probing {
                        format!(
                            "首字超时（{}s 内未收到模型响应）",
                            self.config.first_byte_timeout_secs
                        )
                    } else {
                        format!(
                            "读取流式响应超时（{}s 内无数据）",
                            self.config.first_byte_timeout_secs
                        )
                    };
                    return (Err(LlmError::Timeout { detail }), phase);
                }
            };

            let chunk = match chunk_opt {
                Some(Ok(c)) => c,
                Some(Err(e)) => {
                    return (
                        Err(LlmError::Network(format!(
                            "读取流式响应失败: {}",
                            format_reqwest_error(&e)
                        ))),
                        phase,
                    );
                }
                None => break,
            };

            // 收到首个流数据分块后，正式转入 Streaming 阶段
            phase = RequestPhase::Streaming;
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
                    saw_done = true;
                    break;
                }
                if payload.is_empty() {
                    continue;
                }

                match serde_json::from_str::<ChatChunk>(payload) {
                    Ok(chunk) => {
                        consecutive_parse_errors = 0;
                        let text_before = accumulated_text.len();
                        process_chunk(
                            &chunk,
                            &mut accumulated_text,
                            &mut accumulated_reasoning,
                            &mut tool_calls,
                            &mut finish_reason,
                            event_tx,
                        );
                        if let Some(s) = sink {
                            let delta = &accumulated_text[text_before..];
                            if !delta.is_empty() {
                                (s.delta)(delta);
                            }
                        }
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
                            let msg = format!(
                                "LLM 流式响应连续解析失败 ({} 次): 最近错误: {}",
                                consecutive_parse_errors, e
                            );
                            let _ = event_tx.send(StreamEvent::Error {
                                message: msg.clone(),
                            });
                            return (Err(LlmError::ParseError(msg)), phase);
                        }
                    }
                }
            }
            if saw_done {
                break;
            }
        }

        (
            Ok(assemble_final_message(
                accumulated_text,
                accumulated_reasoning,
                tool_calls,
                finish_reason,
            )),
            phase,
        )
    }

    async fn send_llm_request(
        &self,
        url: &str,
        req_body: &serde_json::Value,
        messages_len: usize,
    ) -> Result<reqwest::Response, LlmError> {
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
                LlmError::Network(detail)
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = read_error_body(response).await;
            return Err(LlmError::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }

        Ok(response)
    }

    /// Fetch the list of available models from the provider's `/models` endpoint.
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, LlmError> {
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
                LlmError::Network(detail)
            })?;

        let status = response.status();
        if !status.is_success() {
            let body = read_error_body(response).await;
            return Err(LlmError::HttpStatus {
                status: status.as_u16(),
                body,
            });
        }

        let resp: ModelsResponse = response
            .json()
            .await
            .map_err(|e| LlmError::ParseError(format!("解析模型列表响应失败: {}", e)))?;

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

fn process_chunk(
    chunk: &ChatChunk,
    accumulated_text: &mut String,
    accumulated_reasoning: &mut String,
    tool_calls: &mut Vec<PartialToolCall>,
    finish_reason: &mut Option<String>,
    event_tx: &mpsc::UnboundedSender<StreamEvent>,
) {
    for choice in &chunk.choices {
        if let Some(fr) = choice.finish_reason.as_deref() {
            if !fr.is_empty() {
                *finish_reason = Some(fr.to_string());
            }
        }
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
    content: String,
    reasoning: String,
    tool_calls: Vec<PartialToolCall>,
    finish_reason: Option<String>,
) -> LlmMessage {
    let finalized_tools: Vec<ToolCall> = tool_calls
        .into_iter()
        .filter_map(|tc| tc.into_tool_call())
        .collect();

    let mut msg = LlmMessage::assistant(content);
    if !reasoning.is_empty() {
        msg.reasoning_content = Some(reasoning);
    }
    if !finalized_tools.is_empty() {
        msg.tool_calls = Some(finalized_tools);
    }
    msg.finish_reason = finish_reason;
    msg
}

#[derive(Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments: String,
    announced: bool,
}

impl PartialToolCall {
    fn apply_delta(
        &mut self,
        delta: &DeltaToolCall,
        event_tx: &mpsc::UnboundedSender<StreamEvent>,
    ) {
        // id / name 均取首次到达值（first-write-wins），防异常 provider 重发覆盖。
        if let Some(ref id) = delta.id {
            if self.id.is_empty() {
                self.id = id.clone();
            }
        }
        if let Some(ref func) = delta.function {
            if let Some(ref name) = func.name {
                if self.name.is_empty() {
                    self.name = name.clone();
                }
            }
        }
        // start 必须先于本 delta 的 ToolCallDelta 发出（前端靠 start 按 id 注册路由）。
        // 广播要求 id 与 name 均已到达：主流 provider 首个 delta 同时携带两者；
        // name 先到、id 后到的异常分片在 id 到达的那次 delta 上补广播。
        self.maybe_emit_start(event_tx);
        if let Some(ref func) = delta.function {
            if let Some(ref args) = func.arguments {
                self.arguments.push_str(args);
                if !self.id.is_empty() {
                    let _ = event_tx.send(StreamEvent::ToolCallDelta {
                        id: self.id.clone(),
                        arguments_delta: args.clone(),
                    });
                }
            }
        }
    }

    fn maybe_emit_start(&mut self, event_tx: &mpsc::UnboundedSender<StreamEvent>) {
        if !self.announced && !self.id.is_empty() && !self.name.is_empty() {
            self.announced = true;
            let _ = event_tx.send(StreamEvent::ToolCallStart {
                id: self.id.clone(),
                name: self.name.clone(),
            });
        }
    }

    fn into_tool_call(self) -> Option<ToolCall> {
        // 空 id 的调用没有可靠的回执路由（tool result 以 id 关联），丢弃；
        // 空 name 保留，交给 dispatcher 以 unknown-tool 错误反馈给模型。
        if self.id.is_empty() {
            return None;
        }
        let arguments = serde_json::from_str(&self.arguments)
            .unwrap_or_else(|_| serde_json::Value::String(self.arguments.clone()));
        Some(ToolCall {
            id: self.id,
            name: self.name,
            arguments,
        })
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
    /// 摘要等内嵌调用的输出上限；主循环不设（用 provider 默认）。
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
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
    build_request_body_with_max_tokens(config, messages, tools, stream, None)
}

/// `build_request_body` 的内嵌调用变体：可显式设 `max_tokens`（摘要截断保护）。
fn build_request_body_with_max_tokens(
    config: &LlmConfig,
    messages: &[LlmMessage],
    tools: &[ToolDefinition],
    stream: bool,
    max_tokens: Option<u32>,
) -> serde_json::Value {
    let messages = messages
        .iter()
        .map(|m| RequestMessage {
            role: m.role.to_string(),
            content: build_request_content(m, config.vision),
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
            Some(StreamOptions {
                include_usage: true,
            })
        } else {
            None
        },
        max_tokens,
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

/// `send_images`: true when vision is enabled (all image-bearing user turns keep images).
fn build_request_content(m: &LlmMessage, send_images: bool) -> RequestContent {
    let paths = m.image_paths.as_ref().filter(|p| !p.is_empty());
    let Some(paths) = paths else {
        return RequestContent::Text(m.content.clone());
    };

    if !send_images || m.role != LlmRole::User {
        let mut text = m.content.clone();
        append_image_placeholders(&mut text, paths.len());
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
        append_image_placeholders(&mut text, paths.len());
        return RequestContent::Text(text);
    }

    if parts.len() == 1 && parts[0].part_type == "text" {
        RequestContent::Text(m.content.clone())
    } else {
        RequestContent::Parts(parts)
    }
}

fn append_image_placeholders(content: &mut String, count: usize) {
    if count == 0 {
        return;
    }
    let block = std::iter::repeat(IMAGE_PLACEHOLDER)
        .take(count)
        .collect::<Vec<_>>()
        .join(" ");
    if content.is_empty() {
        *content = block;
    } else if !content.contains(IMAGE_PLACEHOLDER) {
        content.push('\n');
        content.push_str(&block);
    }
}

#[derive(Debug, Deserialize)]
struct ChatChunk {
    choices: Vec<ChunkChoice>,
    #[serde(default)]
    usage: Option<ChunkUsage>,
}

#[derive(Debug, Deserialize)]
struct ChunkUsage {
    #[serde(default)]
    prompt_tokens: u32,
    #[serde(default)]
    completion_tokens: u32,
    #[serde(default)]
    total_tokens: u32,
    #[serde(default)]
    prompt_tokens_details: Option<PromptTokensDetails>,
    #[serde(default)]
    completion_tokens_details: Option<CompletionTokensDetails>,
}

#[derive(Debug, Deserialize)]
struct PromptTokensDetails {
    #[serde(default)]
    cached_tokens: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct CompletionTokensDetails {
    #[serde(default)]
    reasoning_tokens: Option<u32>,
}

impl From<ChunkUsage> for TokenUsage {
    fn from(u: ChunkUsage) -> Self {
        Self {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            reasoning_tokens: u.completion_tokens_details.and_then(|d| d.reasoning_tokens),
            cached_read_tokens: u.prompt_tokens_details.and_then(|d| d.cached_tokens),
        }
    }
}

#[derive(Debug, Deserialize)]
struct ChunkChoice {
    delta: Option<ChunkDelta>,
    finish_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ChunkDelta {
    content: Option<String>,
    reasoning_content: Option<String>,
    tool_calls: Option<Vec<DeltaToolCall>>,
}

#[derive(Debug, Deserialize)]
struct DeltaToolCall {
    index: Option<u32>,
    id: Option<String>,
    function: Option<DeltaFunction>,
}

#[derive(Debug, Deserialize)]
struct DeltaFunction {
    name: Option<String>,
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
mod build_request_body_tests {
    use super::*;
    use crate::llm::provider::{LlmConfig, LlmMessage, ProviderType};

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
            first_byte_timeout_secs: 60,
            retry_on_timeout: true,
            vision: false,
            extra_body: None,
        }
    }

    #[test]
    fn tool_calls_assistant_keeps_reasoning_content() {
        // DeepSeek thinking 模式：带 tool_calls 的 assistant 必须回传
        // reasoning_content（build_request_body 不得再置 None）
        let cfg = base_config();
        let mut msg = LlmMessage::assistant("");
        msg.tool_calls = Some(vec![ToolCall {
            id: "call-1".into(),
            name: "bash".into(),
            arguments: serde_json::json!({ "command": "ls" }),
        }]);
        msg.reasoning_content = Some("let me check the directory".to_string());
        let body = build_request_body(&cfg, &[msg], &[], true);
        let messages = body
            .get("messages")
            .and_then(|v| v.as_array())
            .expect("messages");
        let assistant = &messages[0];
        // DeepSeek 协议字段为 snake_case reasoning_content
        assert_eq!(
            assistant.get("reasoning_content").and_then(|v| v.as_str()),
            Some("let me check the directory")
        );
        assert!(assistant.get("tool_calls").is_some());
    }

    #[test]
    fn no_reasoning_assistant_omits_field() {
        let cfg = base_config();
        let msg = LlmMessage::assistant("plain reply");
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
        assert!(
            (temp - 0.1f32 as f64).abs() < 1e-6,
            "temperature drift: {temp}"
        );
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
        assert_eq!(body.get("max_tokens").and_then(|v| v.as_u64()), Some(4096));
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

#[cfg(test)]
mod vision_request_tests {
    use super::*;
    use crate::llm::provider::{LlmConfig, LlmMessage, ProviderType};

    fn config_with_vision(vision: bool) -> LlmConfig {
        LlmConfig {
            provider_type: ProviderType::OpenAI,
            api_key: String::new(),
            model: "gpt-4".to_string(),
            base_url: None,
            temperature: 0.1,
            max_retries: 0,
            retry_delay_secs: 0.0,
            retry_http_statuses: String::new(),
            first_byte_timeout_secs: 60,
            retry_on_timeout: true,
            vision,
            extra_body: None,
        }
    }

    fn user_with_images(content: &str, paths: &[&str]) -> LlmMessage {
        let mut m = LlmMessage::user(content);
        m.image_paths = Some(paths.iter().map(|p| p.to_string()).collect());
        m
    }

    fn messages_of(body: &serde_json::Value) -> &Vec<serde_json::Value> {
        body.get("messages")
            .and_then(|v| v.as_array())
            .expect("messages")
    }

    /// 在测试专用临时目录初始化 image_store 根并写入一张真实小图，
    /// 返回相对路径。`IMAGES_ROOT` 是 OnceLock（进程内首个 init 胜出），
    /// 但保存与读取都走同一个根，因此无论谁先 init 结果一致。
    fn save_real_image(conversation: &str, message: &str, index: usize) -> String {
        let dir =
            std::env::temp_dir().join(format!("marcel_openai_vision_test_{}", std::process::id()));
        crate::agent::image_store::init(&dir);
        // 最小 GIF 头（6 字节），guess_mime 按扩展名兜底为 webp 也能解析
        let bytes: &[u8] = b"GIF89a";
        crate::agent::image_store::save_image_bytes(conversation, message, index, bytes)
            .expect("save test image")
    }

    #[test]
    fn vision_off_degrades_all_images_to_placeholders() {
        let cfg = config_with_vision(false);
        let msgs = vec![user_with_images("look", &["c/a.webp"])];
        let body = build_request_body(&cfg, &msgs, &[], true);
        let ms = messages_of(&body);
        let content = ms[0]
            .get("content")
            .and_then(|v| v.as_str())
            .expect("text content");
        assert!(
            content.contains("[image]"),
            "vision off must append placeholder: {content}"
        );
        assert!(content.contains("look"));
    }

    #[test]
    fn vision_on_all_image_turns_keep_images() {
        let cfg = config_with_vision(true);
        // 多个带图 user 轮 + 中间夹不带图的 user 轮：所有带图轮都保留真图，
        // 不带图的轮保持纯文本（不产生占位符）。
        let rel = save_real_image("c", "m2", 0);
        let msgs = vec![
            user_with_images("first", &["c/missing.webp"]),
            LlmMessage::assistant("ok"),
            LlmMessage::user("middle, no image"),
            user_with_images("second", &[&rel]),
        ];
        let body = build_request_body(&cfg, &msgs, &[], true);
        let ms = messages_of(&body);

        // 第一个带图轮的文件缺失（c/missing.webp）：整体降级为文本 + 占位符
        let first = ms[0]
            .get("content")
            .and_then(|v| v.as_str())
            .expect("missing-file turn must degrade to plain text");
        assert!(
            first.contains("[image]"),
            "first turn missing file must degrade to placeholder: {first}"
        );
        assert!(first.contains("first"));

        // 中间不带图的轮：纯文本，无 image parts、无占位符
        let middle = ms[2]
            .get("content")
            .and_then(|v| v.as_str())
            .expect("middle turn must be plain text");
        assert!(middle.contains("middle, no image"));
        assert!(!middle.contains("[image]"));

        // 最新带图轮：multimodal parts（text + image_url）
        let latest = &ms[3];
        let parts = latest
            .get("content")
            .and_then(|v| v.as_array())
            .expect("latest turn must be multimodal parts");
        let has_image = parts.iter().any(|p| {
            p.get("type").and_then(|v| v.as_str()) == Some("image_url")
                && p.get("image_url").is_some()
        });
        assert!(
            has_image,
            "latest image turn must carry image_url part: {parts:?}"
        );
    }

    #[test]
    fn vision_on_missing_files_degrade_to_placeholder() {
        let cfg = config_with_vision(true);
        let msgs = vec![user_with_images("look", &["c/gone.webp"])];
        let body = build_request_body(&cfg, &msgs, &[], true);
        let ms = messages_of(&body);
        // 文件已被清理（撤回/删会话）时必须降级为占位符，而不是静默只发文本
        let content = ms[0]
            .get("content")
            .and_then(|v| v.as_str())
            .expect("text content");
        assert!(
            content.contains("[image]"),
            "missing files must degrade: {content}"
        );
    }

    #[test]
    fn vision_on_partial_load_failure_sends_only_loaded_images() {
        let cfg = config_with_vision(true);
        let rel = save_real_image("c", "m_partial", 0);
        let msgs = vec![user_with_images("look", &[&rel, "c/missing.webp"])];
        let body = build_request_body(&cfg, &msgs, &[], true);
        let ms = messages_of(&body);
        let parts = ms[0]
            .get("content")
            .and_then(|v| v.as_array())
            .expect("parts");
        let images: Vec<&serde_json::Value> = parts
            .iter()
            .filter(|p| p.get("type").and_then(|v| v.as_str()) == Some("image_url"))
            .collect();
        assert_eq!(
            images.len(),
            1,
            "only the successfully loaded image is sent"
        );
        let text = parts
            .iter()
            .any(|p| p.get("type").and_then(|v| v.as_str()) == Some("text"));
        assert!(text, "text part must be preserved");
    }

    #[test]
    fn non_user_message_never_sends_real_images() {
        // 防御：image_paths 只应出现在 user 消息上；即使异常数据把它挂在
        // assistant 消息上，也只允许占位符降级，绝不能发真图。
        let cfg = config_with_vision(true);
        let rel = save_real_image("c", "m_asst", 0);
        let mut asst = LlmMessage::assistant("with image");
        asst.image_paths = Some(vec![rel]);
        let body = build_request_body(&cfg, &[asst], &[], true);
        let ms = messages_of(&body);
        let content = ms[0]
            .get("content")
            .and_then(|v| v.as_str())
            .expect("text content");
        assert!(
            content.contains("[image]"),
            "assistant images must degrade: {content}"
        );
    }
}

#[cfg(test)]
mod partial_tool_call_tests {
    use super::*;
    use crate::llm::streaming::StreamEvent;

    fn delta(id: Option<&str>, name: Option<&str>, args: Option<&str>) -> DeltaToolCall {
        DeltaToolCall {
            index: Some(0),
            id: id.map(|s| s.to_string()),
            function: (name.is_some() || args.is_some()).then(|| DeltaFunction {
                name: name.map(|s| s.to_string()),
                arguments: args.map(|s| s.to_string()),
            }),
        }
    }

    /// 依次 apply 一组 delta，收完事件后返回 (events, 最终 into_tool_call)。
    fn run(deltas: &[DeltaToolCall]) -> (Vec<StreamEvent>, Option<ToolCall>) {
        let mut tc = PartialToolCall::default();
        let (tx, mut rx) = mpsc::unbounded_channel();
        for d in deltas {
            tc.apply_delta(d, &tx);
        }
        drop(tx);
        let mut events = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            events.push(ev);
        }
        let call = tc.into_tool_call();
        (events, call)
    }

    fn start_of(events: &[StreamEvent]) -> Option<(&str, &str)> {
        events.iter().find_map(|ev| match ev {
            StreamEvent::ToolCallStart { id, name } => Some((id.as_str(), name.as_str())),
            _ => None,
        })
    }

    #[test]
    fn start_precedes_delta_when_id_and_name_arrive_together() {
        let (events, call) = run(&[delta(Some("c1"), Some("read_file"), Some("{\"p\""))]);
        // start 必须是第一个工具事件，且先于 arguments delta（前端靠 start 注册 id 路由）
        assert_eq!(start_of(&events), Some(("c1", "read_file")));
        assert!(matches!(
            events.first(),
            Some(StreamEvent::ToolCallStart { .. })
        ));
        assert!(events.len() == 2 && matches!(events[1], StreamEvent::ToolCallDelta { .. }));
        let call = call.expect("call");
        assert_eq!(call.id, "c1");
        // `{"p"` 是截断的非法 JSON → 回退为原始字符串
        assert_eq!(call.arguments, serde_json::Value::String("{\"p\"".into()));
    }

    #[test]
    fn start_emitted_when_id_arrives_after_name() {
        // 异常分片：name 先到（无 id），id 在后续 delta 到达——必须在 id 到达时补广播
        let (events, call) = run(&[
            delta(None, Some("read_file"), None),
            delta(Some("c1"), None, None),
            delta(None, None, Some("{}")),
        ]);
        assert_eq!(start_of(&events), Some(("c1", "read_file")));
        // delta 事件只允许在 start 之后出现
        let start_pos = events
            .iter()
            .position(|ev| matches!(ev, StreamEvent::ToolCallStart { .. }))
            .expect("start");
        assert!(events[start_pos + 1..]
            .iter()
            .all(|ev| matches!(ev, StreamEvent::ToolCallDelta { .. })));
        let call = call.expect("call");
        assert_eq!(call.name, "read_file");
        assert_eq!(call.arguments, serde_json::json!({}));
    }

    #[test]
    fn silent_when_id_never_arrives() {
        // 空 id 的调用不广播任何事件，最终被丢弃（无可靠回执路由）
        let (events, call) = run(&[delta(None, Some("read_file"), Some("{}"))]);
        assert!(events.is_empty(), "no events without id: {events:?}");
        assert!(call.is_none());
    }

    #[test]
    fn first_write_wins_for_id_and_name() {
        let (events, call) = run(&[
            delta(Some("c1"), Some("tool_a"), None),
            delta(Some("c2"), Some("tool_b"), Some("{}")),
        ]);
        // 只广播一次 start，且用的是首次到达的 id/name
        assert_eq!(start_of(&events), Some(("c1", "tool_a")));
        assert_eq!(events.len(), 2); // start + 一个 delta
        let call = call.expect("call");
        assert_eq!(call.id, "c1");
        assert_eq!(call.name, "tool_a");
    }

    #[test]
    fn into_tool_call_keeps_empty_name_for_unknown_tool_feedback() {
        let mut tc = PartialToolCall::default();
        tc.apply_delta(
            &delta(Some("c1"), None, Some("{}")),
            &mpsc::unbounded_channel().0,
        );
        let call = tc.into_tool_call().expect("empty name must be kept");
        assert_eq!(call.name, "");
    }

    #[test]
    fn into_tool_call_invalid_json_falls_back_to_string() {
        let (events, call) = run(&[delta(Some("c1"), Some("bash"), Some("ls -la"))]);
        assert_eq!(start_of(&events), Some(("c1", "bash")));
        let call = call.expect("call");
        // 旧语义：解析失败回退为原始字符串（而非 {"_raw": ...} 包装），
        // 工具层按缺参报错给模型自纠
        assert_eq!(call.arguments, serde_json::Value::String("ls -la".into()));
    }

    #[test]
    fn into_tool_call_valid_json_parses_object() {
        let (_, call) = run(&[delta(
            Some("c1"),
            Some("read_file"),
            Some(r#"{"path":"/a"}"#),
        )]);
        let call = call.expect("call");
        assert_eq!(call.arguments, serde_json::json!({ "path": "/a" }));
    }

    #[test]
    fn partial_args_accumulate_across_deltas() {
        let (_, call) = run(&[
            delta(Some("c1"), Some("write_file"), Some(r#"{"path":"x","#)),
            delta(None, None, Some(r#""content":"hi"}"#)),
        ]);
        let call = call.expect("call");
        assert_eq!(
            call.arguments,
            serde_json::json!({ "path": "x", "content": "hi" })
        );
    }
}
