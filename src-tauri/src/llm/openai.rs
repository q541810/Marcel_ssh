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
            // 客户端与请求上都不设 reqwest 总超时——它从建连覆盖到 body 读完，
            // 会把超过时限的流式生成中途掐死（表现为「读取流式响应失败: …
            // operation timed out」）。等待响应头由 send_llm_request 用首字超时兜底，
            // 流式数据由 execute_stream 的逐块看门狗兜底。
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
        apply_extra_headers(&mut headers, &self.config.extra_headers);
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
        // 请求体一次序列化为字节直接发送（extra_body 缺省时连中间 Value 树都
        // 不建；旧路径 to_value + reqwest `.json()` 再序列化是双份的）。
        let body_bytes = match build_request_body_bytes_with_max_tokens(
            &self.config,
            messages,
            tools,
            true,
            max_tokens,
        ) {
            Ok(bytes) => bytes,
            Err(e) => {
                return (
                    Err(LlmError::ParseError(format!("序列化请求体失败: {}", e))),
                    RequestPhase::Probing,
                )
            }
        };

        let first_byte_timeout =
            Duration::from_secs(self.config.first_byte_timeout_secs.clamp(20, 250));

        let response = match self
            .send_llm_request(&url, body_bytes, messages.len(), first_byte_timeout)
            .await
        {
            Ok(resp) => resp,
            Err(err) => return (Err(err), RequestPhase::Probing),
        };

        let mut accumulated_text = String::new();
        let mut accumulated_reasoning = String::new();
        let mut tool_calls: Vec<PartialToolCall> = Vec::new();
        let mut finish_reason: Option<String> = None;
        let mut buffer = Vec::<u8>::new();
        let mut consecutive_parse_errors: u32 = 0;
        let mut stream = response.bytes_stream();
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
            // 字节级缓冲：chunk 边界可能切开多字节 UTF-8（中文等），
            // 禁止 from_utf8_lossy 逐 chunk 解码（会把半截字符打成 U+FFFD）。
            let lines = take_sse_lines(&mut buffer, &chunk);
            for line in lines {
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
        body_bytes: Vec<u8>,
        messages_len: usize,
        first_byte_timeout: Duration,
    ) -> Result<reqwest::Response, LlmError> {
        // Content-Type 只由 build_headers() 放一次。**不要**在这里再 .header() 一次：
        // reqwest 的 .header() 是 append 语义，叠加后会真的发出两条
        // `content-type: application/json`。宽松的服务端（OpenAI 官方）忍了，
        // 严格解析的（DeepSeek 官方）直接回 415
        // `Expected request with Content-Type: application/json`。
        log::info!(
            "LLM 请求: {} model={} messages={}",
            url,
            self.config.model,
            messages_len
        );

        // 只包「等响应头」这一段——reqwest 的逐请求 .timeout() 会连 body 一起覆盖，
        // 这里必须用 tokio timeout 把 .send() 单独圈住，流式 body 不受限。
        let sent = tokio::time::timeout(
            first_byte_timeout,
            self.client
                .post(url)
                .headers(self.build_headers()?)
                .body(body_bytes)
                .send(),
        )
        .await;

        let response = match sent {
            Ok(r) => r.map_err(|e| {
                let detail = format_reqwest_error(&e);
                log::error!("LLM 请求发送失败: {}", detail);
                LlmError::Network(detail)
            })?,
            Err(_) => {
                return Err(LlmError::Timeout {
                    detail: format!(
                        "首字超时（{}s 内未收到模型响应）",
                        self.config.first_byte_timeout_secs
                    ),
                });
            }
        };

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
            // 非流式短请求：逐请求设总超时（覆盖 body 读取），口径同 JEV。
            .timeout(Duration::from_secs(
                self.config.first_byte_timeout_secs.clamp(20, 250),
            ))
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

fn apply_extra_headers(headers: &mut HeaderMap, extra: &std::collections::BTreeMap<String, String>) {
    use reqwest::header::HeaderName;

    /// 不允许用户自定义覆盖的头（小写，HeaderName 已规范化）。
    const RESERVED: &[&str] = &["content-type", "content-length", "authorization"];

    for (raw_name, raw_value) in extra {
        let name = raw_name.trim();
        if name.is_empty() {
            continue;
        }
        let name = match HeaderName::from_bytes(name.to_ascii_lowercase().as_bytes()) {
            Ok(n) => n,
            Err(e) => {
                log::warn!("自定义请求头名非法，已跳过: {:?} ({})", raw_name, e);
                continue;
            }
        };
        if RESERVED.contains(&name.as_str()) {
            log::warn!(
                "自定义请求头 {:?} 会破坏请求协议，已跳过（该头由程序管理）",
                raw_name
            );
            continue;
        }
        match HeaderValue::from_str(raw_value) {
            Ok(value) => {
                // insert：同名覆盖上一次的值，不会多出一条。
                headers.insert(name, value);
            }
            Err(e) => {
                log::warn!("自定义请求头 {:?} 的值非法，已跳过: {}", raw_name, e);
            }
        }
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

/// 把流式原始字节追加进缓冲，取出所有**完整** SSE 行（不含行尾 `\r?\n`）。
///
/// chunk 边界可能落在多字节 UTF-8 字符中间；这里按字节找 `\n`
/// （UTF-8 多字节序列的续字节均 ≥ 0x80，不可能含 `0x0A`），
/// 只对完整行做解码，尾部半截字符留到下一 chunk。
fn take_sse_lines(buffer: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    buffer.extend_from_slice(chunk);
    let mut lines = Vec::new();
    while let Some(idx) = buffer.iter().position(|&b| b == b'\n') {
        let mut line_bytes: Vec<u8> = buffer.drain(..=idx).collect();
        line_bytes.pop(); // 去掉 \n
        if line_bytes.last() == Some(&b'\r') {
            line_bytes.pop();
        }
        // 完整行在 `\n` 处闭合，不可能切开多字节字符；lossy 仅作异常兜底
        lines.push(String::from_utf8_lossy(&line_bytes).into_owned());
    }
    lines
}

#[cfg(test)]
mod sse_line_buffer_tests {
    use super::take_sse_lines;

    #[test]
    fn holds_partial_utf8_until_next_chunk() {
        // 「帮」= E5 B8 AE；在 0xB8 后切开
        let full = "data: {\"content\":\"我来帮你处理\"}\n".as_bytes();
        let split_at = full.iter().position(|&b| b == 0xB8).unwrap() + 1;
        let (a, b) = full.split_at(split_at);

        let mut buf = Vec::new();
        let lines1 = take_sse_lines(&mut buf, a);
        assert!(lines1.is_empty(), "半截 UTF-8 不得产出半截行");
        assert!(!buf.is_empty(), "半截字节应留在缓冲");

        let lines2 = take_sse_lines(&mut buf, b);
        assert_eq!(lines2.len(), 1);
        assert_eq!(lines2[0], "data: {\"content\":\"我来帮你处理\"}");
        assert!(buf.is_empty());
    }

    #[test]
    fn strips_crlf_and_yields_multiple_lines() {
        let mut buf = Vec::new();
        let lines = take_sse_lines(&mut buf, b"data: a\r\ndata: b\n");
        assert_eq!(lines, vec!["data: a".to_string(), "data: b".to_string()]);
        assert!(buf.is_empty());
    }

    #[test]
    fn keeps_incomplete_line_without_newline() {
        let mut buf = Vec::new();
        let lines = take_sse_lines(&mut buf, b"data: partial");
        assert!(lines.is_empty());
        assert_eq!(buf, b"data: partial");
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
            // 思考字段兼容两种命名：OpenAI/DeepSeek 官方 `reasoning_content`，
            // 部分网关（neopig 等）用 `reasoning`。两者不会同帧出现，优先官方名。
            let reasoning_delta = delta
                .reasoning_content
                .as_ref()
                .or(delta.reasoning.as_ref());
            if let Some(reasoning) = reasoning_delta {
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

/// 降格的非首位系统消息在内容前加的声明：这条文本虽以 user 身份到达，
/// 但来自系统，不是用户发言（见 `LlmConfig.demote_non_leading_system`）。
pub(crate) const DEMOTED_SYSTEM_NOTICE: &str = "【系统消息，非用户发言】\n";

/// 给降格系统消息的内容加声明前缀。系统消息不携带图片（正常只会是纯文本）；
/// 异常形态（数组内容）时把声明插为首段文本。
fn prefix_demoted_system_notice(content: RequestContent) -> RequestContent {
    match content {
        RequestContent::Text(text) => {
            RequestContent::Text(format!("{DEMOTED_SYSTEM_NOTICE}{text}"))
        }
        RequestContent::Parts(mut parts) => {
            parts.insert(
                0,
                RequestContentPart {
                    part_type: "text",
                    text: Some(DEMOTED_SYSTEM_NOTICE.to_string()),
                    image_url: None,
                },
            );
            RequestContent::Parts(parts)
        }
    }
}

/// `build_request_body` 的内嵌调用变体：可显式设 `max_tokens`（摘要截断保护）。
fn build_request_body_with_max_tokens(
    config: &LlmConfig,
    messages: &[LlmMessage],
    tools: &[ToolDefinition],
    stream: bool,
    max_tokens: Option<u32>,
) -> serde_json::Value {
    let messages = build_request_messages(config, messages);

    let tools = build_request_tools(tools);

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

/// 消息 → 请求消息映射（Value 版与字节版共用同一份）。
fn build_request_messages(config: &LlmConfig, messages: &[LlmMessage]) -> Vec<RequestMessage> {
    messages
        .iter()
        .enumerate()
        .map(|(idx, m)| {
            // 「非首位系统消息转为普通消息」（`demote_non_leading_system`）：
            // 严格 chat template（如 Qwen 系）要求 system 必须位于 messages[0]，
            // 其余位置的 system 会被直接 400。开启后只改**发出去的形状**——
            // 降格为 user 并在内容前声明身份；内存消息、落库、前端展示均不动。
            let demoted = config.demote_non_leading_system && idx > 0 && m.role == LlmRole::System;
            RequestMessage {
                role: if demoted { "user" } else { m.role.to_string() },
                content: if demoted {
                    prefix_demoted_system_notice(build_request_content(m, config.vision))
                } else {
                    build_request_content(m, config.vision)
                },
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
            }
        })
        .collect()
}

/// 工具清单 → 请求工具映射（Value 版与字节版共用同一份）。
fn build_request_tools(tools: &[ToolDefinition]) -> Option<Vec<RequestTool>> {
    if tools.is_empty() {
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
    }
}

/// [`build_request_body`] 的**字节版**：extra_body 缺省（或空对象）时跳过中间
/// `Value` 树、对 typed 结构一次 `to_vec` 直接得到请求体（serde_json 启用
/// preserve_order，字段序与经 `Value` 的路径逐字节一致，有 wire 测试钉住）；
/// 有 extra_body 时仍走 `Value` 合并。省掉的是无自定义 body 场景下的第二次
/// 整体序列化与 `Value` 树分配。
fn build_request_body_bytes_with_max_tokens(
    config: &LlmConfig,
    messages: &[LlmMessage],
    tools: &[ToolDefinition],
    stream: bool,
    max_tokens: Option<u32>,
) -> Result<Vec<u8>, serde_json::Error> {
    // 与 build_request_body_with_max_tokens 同构（消息/工具映射逻辑一致）；
    // 保持两份实现同源的代价由 wire 字节测试兜底（两条路径产物逐字节比对）。
    let request_messages = build_request_messages(config, messages);
    let request_tools = build_request_tools(tools);
    let typed = ChatCompletionRequest {
        model: config.model.clone(),
        messages: request_messages,
        temperature: config.temperature,
        stream,
        tools: request_tools,
        stream_options: if stream {
            Some(StreamOptions {
                include_usage: true,
            })
        } else {
            None
        },
        max_tokens,
    };
    let extra_is_empty = config
        .extra_body
        .as_ref()
        .is_none_or(|e| e.as_object().is_none_or(|m| m.is_empty()));
    if extra_is_empty {
        return serde_json::to_vec(&typed);
    }
    let mut body = serde_json::to_value(&typed)?;
    if let (serde_json::Value::Object(body_map), Some(serde_json::Value::Object(extra_map))) =
        (&mut body, &config.extra_body)
    {
        for (k, v) in extra_map {
            body_map.insert(k.clone(), v.clone());
        }
    }
    serde_json::to_vec(&body)
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
        match crate::agent::image_store::read_image_data_url_cached(rel) {
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
    /// DeepSeek 官方字段：本次输入里命中缓存的 token 数（`prompt_tokens` 含它，
    /// 与 `prompt_cache_miss_tokens` 之和等于 `prompt_tokens`）。不认它，缓存命中率
    /// 在 DeepSeek 渠道上永远是「渠道没报」。
    #[serde(default)]
    prompt_cache_hit_tokens: Option<u32>,
    /// Moonshot（Kimi）等把缓存命中数直接放在 usage 顶层。
    #[serde(default)]
    cached_tokens: Option<u32>,
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
        // 三种写法都是「`prompt_tokens` 里命中缓存的那部分」。同一份 usage 里可能
        // 有人同时发两种（兼容网关常见 `details.cached_tokens: 0` 外加真实的
        // `prompt_cache_hit_tokens`），取最大值：全是 0/缺失才算没命中，而不是
        // 让排在前面的那个 0 盖掉真值。三个都缺 = 渠道没报，保持 `None`。
        let cached_read_tokens = [
            u.prompt_tokens_details.and_then(|d| d.cached_tokens),
            u.prompt_cache_hit_tokens,
            u.cached_tokens,
        ]
        .into_iter()
        .flatten()
        .max();
        Self {
            prompt_tokens: u.prompt_tokens,
            completion_tokens: u.completion_tokens,
            total_tokens: u.total_tokens,
            reasoning_tokens: u.completion_tokens_details.and_then(|d| d.reasoning_tokens),
            cached_read_tokens,
        }
    }
}

#[cfg(test)]
mod usage_cache_tests {
    use super::*;

    fn parse(json: &str) -> TokenUsage {
        serde_json::from_str::<ChunkUsage>(json)
            .expect("usage 应能解析")
            .into()
    }

    #[test]
    fn openai_style_details_are_read() {
        let u = parse(
            r#"{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,
                "prompt_tokens_details":{"cached_tokens":64}}"#,
        );
        assert_eq!(u.cached_read_tokens, Some(64));
    }

    #[test]
    fn deepseek_style_hit_tokens_are_read() {
        let u = parse(
            r#"{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,
                "prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}"#,
        );
        assert_eq!(u.cached_read_tokens, Some(80));
    }

    #[test]
    fn moonshot_style_top_level_cached_tokens_are_read() {
        let u = parse(
            r#"{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,"cached_tokens":30}"#,
        );
        assert_eq!(u.cached_read_tokens, Some(30));
    }

    #[test]
    fn a_zero_in_one_field_does_not_mask_the_real_value_in_another() {
        let u = parse(
            r#"{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105,
                "prompt_tokens_details":{"cached_tokens":0},"prompt_cache_hit_tokens":80}"#,
        );
        assert_eq!(u.cached_read_tokens, Some(80));
    }

    #[test]
    fn channel_that_reports_nothing_stays_none_not_zero() {
        let u = parse(r#"{"prompt_tokens":100,"completion_tokens":5,"total_tokens":105}"#);
        assert_eq!(u.cached_read_tokens, None);
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
    /// OpenAI / DeepSeek 官方流式思考字段名（`delta.reasoning_content`）。
    reasoning_content: Option<String>,
    /// 部分 OpenAI 兼容网关/转发（如 neopig → deepseek）把思考字段命名为
    /// `delta.reasoning`（非流式响应里对应 `message.reasoning`）。serde 默认
    /// 丢弃未知字段，不兼容会导致「模型实际在思考（usage 计费含
    /// reasoning_tokens）但思考内容全部丢失、UI 永不显示」。
    reasoning: Option<String>,
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
            demote_non_leading_system: false,
            extra_headers: Default::default(),
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

    /// 流式思考字段兼容：官方 `delta.reasoning_content` 仍是主解析字段。
    #[test]
    fn process_chunk_reads_official_reasoning_content() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut tool_calls: Vec<PartialToolCall> = Vec::new();
        let mut finish: Option<String> = None;
        let (_tx, _rx) = mpsc::unbounded_channel();
        let chunk: ChatChunk = serde_json::from_str(
            r#"{"choices":[{"delta":{"content":"hi","reasoning_content":"官方思考"}}]}"#,
        )
        .expect("parse official");
        process_chunk(
            &chunk,
            &mut text,
            &mut reasoning,
            &mut tool_calls,
            &mut finish,
            &_tx,
        );
        assert_eq!(text, "hi");
        assert_eq!(reasoning, "官方思考");
    }

    /// 流式思考字段兼容：部分网关（neopig → deepseek）发 `delta.reasoning`，
    /// 没有官方 `reasoning_content`——思考也必须被解析（否则 usage 计费了
    /// thinking tokens 但 UI 永不显示，表现为「有时思考有时不思考」）。
    #[test]
    fn process_chunk_reads_alias_reasoning_field() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut tool_calls: Vec<PartialToolCall> = Vec::new();
        let mut finish: Option<String> = None;
        let (_tx, _rx) = mpsc::unbounded_channel();
        let chunk: ChatChunk = serde_json::from_str(
            r#"{"choices":[{"delta":{"content":"hello","reasoning":"need answer step by step"}}]}"#,
        )
        .expect("parse alias");
        process_chunk(
            &chunk,
            &mut text,
            &mut reasoning,
            &mut tool_calls,
            &mut finish,
            &_tx,
        );
        assert_eq!(text, "hello");
        assert_eq!(reasoning, "need answer step by step");
    }

    /// 官方字段优先：同帧出现 `reasoning_content` 与 `reasoning` 时用官方名
    /// （正常 provider 不会同发，防御性取官方名避免重复拼接）。
    #[test]
    fn process_chunk_prefers_official_over_alias() {
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut tool_calls: Vec<PartialToolCall> = Vec::new();
        let mut finish: Option<String> = None;
        let (_tx, _rx) = mpsc::unbounded_channel();
        let chunk: ChatChunk = serde_json::from_str(
            r#"{"choices":[{"delta":{"content":"x","reasoning_content":"official","reasoning":"alias"}}]}"#,
        )
        .expect("parse both");
        process_chunk(
            &chunk,
            &mut text,
            &mut reasoning,
            &mut tool_calls,
            &mut finish,
            &_tx,
        );
        assert_eq!(reasoning, "official");
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

    /// 摘要调用不设输出上限：`max_tokens` 为 `None` 时请求体里**不出现**该键，
    /// 由 provider / 模型自己的默认上限决定。写死一个值会把"被压区间很大、
    /// 摘要中等长度"这类合法压缩误判成截断失败（真正有原则的闸门是 shrink 校验）。
    #[test]
    fn omitted_max_tokens_leaves_key_absent() {
        let cfg = base_config();
        let msgs = [LlmMessage::user("hi")];
        let body = build_request_body_with_max_tokens(&cfg, &msgs, &[], true, None);
        assert!(
            body.get("max_tokens").is_none(),
            "不设上限时请求体不应出现 max_tokens"
        );
        // 配对用例：显式传值的调用（如审批）照旧落到请求体
        let body = build_request_body_with_max_tokens(&cfg, &msgs, &[], true, Some(4096));
        assert_eq!(body.get("max_tokens").and_then(|v| v.as_u64()), Some(4096));
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

    /// 开关默认关：非首位 system 原样保留（与历史行为逐字节一致）。
    #[test]
    fn demote_off_keeps_non_leading_system() {
        let cfg = base_config();
        assert!(!cfg.demote_non_leading_system);
        let msgs = vec![
            LlmMessage::system("你是助手。"),
            LlmMessage::user("说一个字"),
            LlmMessage::system("当前计划:\n[▶] 1. 干活"),
        ];
        let body = build_request_body(&cfg, &msgs, &[], true);
        let messages = body
            .get("messages")
            .and_then(|v| v.as_array())
            .expect("messages");
        assert_eq!(
            messages[2].get("role").and_then(|v| v.as_str()),
            Some("system")
        );
        assert_eq!(
            messages[2].get("content").and_then(|v| v.as_str()),
            Some("当前计划:\n[▶] 1. 干活")
        );
    }

    /// 开关开：非首位 system 降格为 user 并在内容前带声明；首位 system 不动。
    #[test]
    fn demote_on_converts_non_leading_system_to_declared_user() {
        let mut cfg = base_config();
        cfg.demote_non_leading_system = true;
        let msgs = vec![
            LlmMessage::system("你是助手。"),
            LlmMessage::user("说一个字"),
            LlmMessage::system("当前计划:\n[▶] 1. 干活"),
        ];
        let body = build_request_body(&cfg, &msgs, &[], true);
        let messages = body
            .get("messages")
            .and_then(|v| v.as_array())
            .expect("messages");
        // 首位 system 原样
        assert_eq!(
            messages[0].get("role").and_then(|v| v.as_str()),
            Some("system")
        );
        assert_eq!(
            messages[0].get("content").and_then(|v| v.as_str()),
            Some("你是助手。")
        );
        // 非首位 system → user + 声明前缀
        assert_eq!(
            messages[2].get("role").and_then(|v| v.as_str()),
            Some("user")
        );
        assert_eq!(
            messages[2].get("content").and_then(|v| v.as_str()),
            Some(format!("{}当前计划:\n[▶] 1. 干活", DEMOTED_SYSTEM_NOTICE).as_str())
        );
    }

    /// 开关开但没有非首位 system：请求与关着时完全一致。
    #[test]
    fn demote_on_without_non_leading_system_is_noop() {
        let mut on = base_config();
        on.demote_non_leading_system = true;
        let off = base_config();
        let msgs = vec![LlmMessage::system("你是助手。"), LlmMessage::user("hi")];
        assert_eq!(
            build_request_body(&on, &msgs, &[], true),
            build_request_body(&off, &msgs, &[], true),
            "无非首位 system 时开关应为 no-op"
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
            demote_non_leading_system: false,
            extra_headers: Default::default(),
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

#[cfg(test)]
mod extra_headers_tests {
    use super::*;
    use std::collections::BTreeMap;

    fn map(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    fn base() -> HeaderMap {
        let mut h = HeaderMap::new();
        h.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        h.insert(AUTHORIZATION, HeaderValue::from_static("Bearer k"));
        h
    }

    #[test]
    fn adds_custom_headers() {
        let mut h = base();
        apply_extra_headers(&mut h, &map(&[("user-agent", "Marcel/1.0"), ("x-opencode-session", "abc")]));
        assert_eq!(h.get("user-agent").unwrap(), "Marcel/1.0");
        assert_eq!(h.get("x-opencode-session").unwrap(), "abc");
        // 头名大小写不敏感
        assert_eq!(h.get("User-Agent").unwrap(), "Marcel/1.0");
    }

    /// **回归护栏**：千万不能用 append。同一个头出现两次会让严格解析的服务端
    /// （DeepSeek 官方）回 415 —— 这正是 v1.11.0 里 Content-Type 踩过的坑。
    #[test]
    fn never_duplicates_a_header_name() {
        let mut h = base();
        apply_extra_headers(&mut h, &map(&[("x-a", "1")]));
        apply_extra_headers(&mut h, &map(&[("x-a", "2")]));
        let all: Vec<_> = h.get_all("x-a").iter().collect();
        assert_eq!(all.len(), 1, "同名头必须只有一个值: {all:?}");
        assert_eq!(all[0], "2", "后写的覆盖先写的");
    }

    /// 受保护的协议头与鉴权头一律不许用户覆盖，程序自己管。
    #[test]
    fn skips_reserved_headers() {
        let mut h = base();
        apply_extra_headers(
            &mut h,
            &map(&[
                ("content-type", "text/plain"),
                ("content-length", "999"),
                ("authorization", "Bearer stolen"),
                ("x-keep", "yes"),
            ]),
        );
        assert_eq!(
            h.get(CONTENT_TYPE).unwrap(),
            "application/json",
            "content-type 不许被改"
        );
        assert!(h.get("content-length").is_none(), "content-length 不许被设");
        assert_eq!(
            h.get(AUTHORIZATION).unwrap(),
            "Bearer k",
            "authorization 不许被改"
        );
        assert_eq!(h.get("x-keep").unwrap(), "yes", "普通头照常生效");
    }

    /// 值里带换行等控制字符 → 跳过该头，但不能炸掉整个请求。
    #[test]
    fn skips_invalid_values_without_failing() {
        let mut h = base();
        apply_extra_headers(
            &mut h,
            &map(&[("x-bad", "a\r\nInjected: 1"), ("x-good", "ok")]),
        );
        assert!(h.get("x-bad").is_none(), "非法值必须被跳过");
        assert_eq!(h.get("x-good").unwrap(), "ok", "其余头不受影响");
    }

    /// 空名字跳过；名字两端空白被裁掉。
    #[test]
    fn handles_blank_and_padded_names() {
        let mut h = base();
        apply_extra_headers(&mut h, &map(&[("", "v"), ("  x-pad  ", "ok")]));
        assert_eq!(h.get("x-pad").unwrap(), "ok");
        assert_eq!(h.len(), 3, "只有 content-type/authorization/x-pad: {h:?}");
    }

    /// 没有自定义头时，发出的头与修复前逐字节相同（不许凭空多出东西）。
    #[test]
    fn empty_extra_headers_changes_nothing() {
        let mut h = base();
        let before = h.clone();
        apply_extra_headers(&mut h, &Default::default());
        assert_eq!(h, before);
    }
}

#[cfg(test)]
mod wire_bytes_tests {
    use super::*;
    use crate::llm::provider::{LlmConfig, LlmMessage, ProviderType, ToolDefinition};
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn config_with(base_url: String, extra_body: Option<serde_json::Value>) -> LlmConfig {
        LlmConfig {
            provider_type: ProviderType::OpenAI,
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            base_url: Some(base_url),
            temperature: 0.1,
            max_retries: 0,
            retry_delay_secs: 0.0,
            retry_http_statuses: String::new(),
            first_byte_timeout_secs: 20,
            retry_on_timeout: false,
            vision: false,
            extra_body,
            demote_non_leading_system: false,
            extra_headers: Default::default(),
        }
    }

    /// 发送侧改「一次 to_vec 直接发字节」后，线上字节必须与构建产物逐字节一致、
    /// Content-Type 仍是 application/json（旧 `.json()` 的行为）。覆盖带工具与
    /// extra_body 合并的完整路径。
    #[tokio::test]
    async fn wire_bytes_equal_built_body_with_json_content_type() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("测试端点绑定失败");
        let addr = listener.local_addr().expect("读取测试端口失败");
        let captured: Arc<Mutex<Option<Vec<u8>>>> = Arc::default();
        let sink = captured.clone();
        tokio::spawn(async move {
            // 双分支各发一次请求：循环 accept，直到监听被丢弃（测试结束）。
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 8192];
                let mut declared: Option<usize> = None;
                loop {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if declared.is_none() {
                                let boundary = b"\r\n\r\n";
                                let Some(pos) = buf.windows(4).position(|w| w == boundary) else {
                                    continue;
                                };
                                let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                                declared = Some(
                                    head.lines()
                                        .find_map(|l| {
                                            l.strip_prefix("content-length:")
                                                .and_then(|v| v.trim().parse().ok())
                                        })
                                        .unwrap_or(0)
                                        + pos
                                        + 4,
                                );
                            }
                            if buf.len() >= declared.unwrap_or(usize::MAX) {
                                break;
                            }
                        }
                    }
                }
                *sink.lock().unwrap() = Some(buf);
                // 回个最小 200 让客户端收尾；内容不是合法 SSE，结果被忽略。
                let _ = stream
                .write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}",
                )
                .await;
            }
        });

        // 两条构建路径都钉：有 extra_body（走 Value 合并）与无 extra_body
        // （跳过中间 Value 直接 to_vec）。线上字节必须与「Value 版构建产物再
        // 序列化」逐字节一致（serde_json 启用 preserve_order，字段序一致）。
        for extra in [Some(serde_json::json!({ "top_p": 0.9 })), None] {
            let has_extra = extra.is_some();
            let cfg = config_with(format!("http://{addr}/v1"), extra);
            let messages = vec![LlmMessage::user("hi")];
            let tools = vec![ToolDefinition {
                name: "bash".to_string(),
                description: "d".to_string(),
                parameters: serde_json::json!({ "type": "object" }),
            }];
            let expected = build_request_body(&cfg, &messages, &tools, true);
            let expected_bytes = serde_json::to_vec(&expected).expect("expected bytes");

            let provider = OpenAiProvider::new(cfg).expect("构造");
            let (event_tx, _rx) = mpsc::unbounded_channel();
            let _ = provider
                .execute_stream(&messages, &tools, &event_tx, None, None)
                .await;

            let raw = captured.lock().unwrap().take().expect("服务端应收到请求");
            if has_extra {
                // 合并路径与「Value 版构建产物再序列化」逐字节一致。
                assert_wire_bytes(&raw, &expected_bytes);
            } else {
                // 直发路径的已知形态（黄金快照）。与经 Value 的旧形态唯一差别是
                // f32 字段的打印：旧路径 f32→f64 放大成 0.100000001490116…，
                // 直发印最短 f32 形式 0.1——数值同一，provider 解析等价。
                assert_wire_bytes(
                    &raw,
                    br#"{"model":"test-model","messages":[{"role":"user","content":"hi"}],"temperature":0.1,"stream":true,"tools":[{"type":"function","function":{"name":"bash","description":"d","parameters":{"type":"object"}}}],"stream_options":{"include_usage":true}}"#,
                );
            }
        }
    }

    /// 服务端捕获到的原始请求（头 + 体）必须长这样：路径、Content-Type 与
    /// 逐字节的请求体。
    fn assert_wire_bytes(raw: &[u8], expected_bytes: &[u8]) {
        let header_end = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("请求头边界");
        let head = String::from_utf8_lossy(&raw[..header_end]).to_lowercase();
        assert!(
            head.starts_with("post /v1/chat/completions"),
            "请求行不符: {head}"
        );
        // **必须恰好一条**。reqwest 的 `.header()` 是 append 语义，重复写会真的发出
        // 两条 `content-type`；宽松的服务端（OpenAI）照单全收，严格解析的
        // （DeepSeek 官方）回 415 `Expected request with Content-Type: application/json`。
        // 只断言「含 application/json」挡不住这个回归——两条也满足。
        let ct_lines: Vec<&str> = head
            .lines()
            .filter(|l| l.starts_with("content-type:"))
            .collect();
        assert_eq!(
            ct_lines.len(),
            1,
            "Content-Type 必须恰好一条，实际 {} 条: {head}",
            ct_lines.len()
        );
        assert!(
            ct_lines[0].contains("application/json"),
            "Content-Type 必须是 application/json: {head}"
        );
        assert_eq!(
            &raw[header_end + 4..],
            expected_bytes,
            "线上请求体必须与构建产物逐字节一致"
        );
    }

    #[tokio::test]
    async fn custom_headers_reach_the_wire_exactly_once() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("测试端点绑定失败");
        let addr = listener.local_addr().expect("读取测试端口失败");
        let captured: Arc<Mutex<Option<Vec<u8>>>> = Arc::default();
        let sink = captured.clone();
        tokio::spawn(async move {
            while let Ok((mut stream, _)) = listener.accept().await {
                let mut buf: Vec<u8> = Vec::new();
                let mut chunk = [0u8; 8192];
                let mut declared: Option<usize> = None;
                loop {
                    match stream.read(&mut chunk).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if declared.is_none() {
                                let boundary = b"\r\n\r\n";
                                let Some(pos) = buf.windows(4).position(|w| w == boundary) else {
                                    continue;
                                };
                                let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                                declared = Some(
                                    head.lines()
                                        .find_map(|l| {
                                            l.strip_prefix("content-length:")
                                                .and_then(|v| v.trim().parse().ok())
                                        })
                                        .unwrap_or(0)
                                        + pos
                                        + 4,
                                );
                            }
                            if buf.len() >= declared.unwrap_or(usize::MAX) {
                                break;
                            }
                        }
                    }
                }
                *sink.lock().unwrap() = Some(buf);
                let _ = stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\n\r\n{}",
                    )
                    .await;
            }
        });

        let mut cfg = config_with(format!("http://{addr}/v1"), None);
        cfg.extra_headers = [
            ("user-agent".to_string(), "Marcel-Test/9.9".to_string()),
            ("x-opencode-session".to_string(), "uuid-abc".to_string()),
            // 受保护的头：不该上网（仍然只有程序自己那一份）
            ("content-type".to_string(), "text/plain".to_string()),
        ]
        .into_iter()
        .collect();

        let provider = OpenAiProvider::new(cfg).expect("构造");
        let (event_tx, _rx) = mpsc::unbounded_channel();
        let _ = provider
            .execute_stream(&[LlmMessage::user("hi")], &[], &event_tx, None, None)
            .await;

        let raw = captured.lock().unwrap().take().expect("服务端应收到请求");
        let header_end = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .expect("请求头边界");
        let head = String::from_utf8_lossy(&raw[..header_end]).to_lowercase();

        let lines = |name: &str| -> Vec<String> {
            head.lines()
                .filter(|l| l.starts_with(&format!("{name}:")))
                .map(|l| l.to_string())
                .collect()
        };

        let ua = lines("user-agent");
        assert_eq!(ua.len(), 1, "user-agent 必须只有一条: {head}");
        assert!(ua[0].contains("marcel-test/9.9"), "user-agent 值不对: {ua:?}");

        let sess = lines("x-opencode-session");
        assert_eq!(sess.len(), 1, "x-opencode-session 必须只有一条: {head}");
        assert!(sess[0].contains("uuid-abc"));

        // 用户试图改 content-type 不生效：仍然是程序设置的那一个值。
        let ct = lines("content-type");
        assert_eq!(ct.len(), 1, "content-type 必须恰好一条: {head}");
        assert!(
            ct[0].contains("application/json"),
            "content-type 不许被用户覆盖: {ct:?}"
        );
    }
}

#[cfg(test)]
mod header_wait_timeout_tests {
    use super::*;
    use crate::llm::provider::{LlmConfig, ProviderType};
    use std::time::Duration;
    use tokio::io::AsyncReadExt;

    fn config_with_base_url(base_url: String) -> LlmConfig {
        LlmConfig {
            provider_type: ProviderType::OpenAI,
            api_key: "test-key".to_string(),
            model: "test-model".to_string(),
            base_url: Some(base_url),
            temperature: 0.1,
            max_retries: 0,
            retry_delay_secs: 0.0,
            retry_http_statuses: String::new(),
            first_byte_timeout_secs: 20,
            retry_on_timeout: false,
            vision: false,
            extra_body: None,
            demote_non_leading_system: false,
            extra_headers: Default::default(),
        }
    }

    /// 服务端收完请求后永不应答：等待响应头必须由首字超时兜底返回
    /// `LlmError::Timeout`。旧实现里这段没有自己的超时，靠客户端 180s
    /// 总超时兜底；总超时删除后若有人把这段兜底弄丢，此测试会悬挂失败。
    /// `start_paused` 让 20s 超时即时触发，不用真实等待。
    #[tokio::test(start_paused = true)]
    async fn header_wait_never_responding_times_out_at_first_byte_deadline() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("测试端点绑定失败");
        let addr = listener.local_addr().expect("读取测试端口失败");
        tokio::spawn(async move {
            let Ok((mut stream, _)) = listener.accept().await else {
                return;
            };
            // 读掉完整请求（头 + Content-Length 声明的体）后保持连接、
            // 永不应答——模拟中转收下请求后无响应。
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 4096];
            let mut declared: Option<usize> = None;
            loop {
                match stream.read(&mut chunk).await {
                    Ok(0) | Err(_) => return,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        eprintln!(
                            "[wire-test] got {} bytes: {:?}",
                            n,
                            String::from_utf8_lossy(&buf[..n.min(120)])
                        );
                        if declared.is_none() {
                            let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") else {
                                continue;
                            };
                            let head = String::from_utf8_lossy(&buf[..pos]).to_lowercase();
                            eprintln!(
                                "[wire-test] head-end={} buf={} head-tail={:?}",
                                pos,
                                buf.len(),
                                &head[head.len() - 80.min(head.len())..]
                            );
                            declared = Some(
                                head.lines()
                                    .find_map(|l| {
                                        l.strip_prefix("content-length:")
                                            .and_then(|v| v.trim().parse().ok())
                                    })
                                    .unwrap_or(0)
                                    + pos
                                    + 4,
                            );
                        }
                        if buf.len() >= declared.unwrap_or(usize::MAX) {
                            // 收完即挂起；睡得比首字超时长，tokio 的时钟
                            // 自动推进只会先命中客户端的 20s 超时。
                            tokio::time::sleep(Duration::from_secs(3600)).await;
                        }
                    }
                }
            }
        });

        let provider =
            OpenAiProvider::new(config_with_base_url(format!("http://{addr}/v1"))).expect("构造");
        let (event_tx, _rx) = mpsc::unbounded_channel();
        let messages = [LlmMessage::user("hi")];

        let (result, phase) = provider
            .execute_stream(&messages, &[], &event_tx, None, None)
            .await;

        assert_eq!(phase, RequestPhase::Probing);
        match result {
            Err(LlmError::Timeout { detail }) => {
                assert!(detail.contains("首字超时"), "超时文案不符: {detail}");
            }
            other => panic!("应为首字超时，实际: {other:?}"),
        }
    }
}
