use std::error::Error as StdError;
use std::time::Duration;

use async_trait::async_trait;
use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use crate::agent::thinking_filter::filter_thinking_tags;
use crate::error::AppError;
use crate::llm::provider::{
    LlmConfig, LlmMessage, LlmProvider, LlmRole, ToolCall, ToolDefinition,
};
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

    /// Stream a chat completion. Decoded SSE events are pushed to `event_tx`.
    /// Returns the assembled final assistant message after the stream completes.
    pub async fn chat_stream(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
        event_tx: mpsc::UnboundedSender<StreamEvent>,
    ) -> Result<LlmMessage, AppError> {
        let url = format!("{}/chat/completions", self.base_url().trim_end_matches('/'));

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
            return Err(AppError::Llm(format!(
                "LLM 返回错误 {}: {}",
                status, body
            )));
        }

        let mut accumulated_text = String::new();
        let mut tool_calls: Vec<PartialToolCall> = Vec::new();
        let mut buffer = String::new();
        let mut stream = response.bytes_stream();
        let mut in_thinking = false;

        while let Some(chunk) = stream.next().await {
            let chunk = chunk
                .map_err(|e| AppError::Llm(format!("读取流式响应失败: {}", e)))?;
            let text = String::from_utf8_lossy(&chunk);
            buffer.push_str(&text);

            // SSE: parse complete lines (terminated by \n)
            while let Some(idx) = buffer.find('\n') {
                let line = buffer[..idx].trim_end_matches('\r').to_string();
                buffer.drain(..=idx);

                let payload = match line.strip_prefix("data:") {
                    Some(rest) => rest.trim(),
                    None => continue, // skip non-data lines (event:, id:, retry:, blank)
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
                        for choice in chunk.choices {
                            if let Some(delta) = choice.delta {
                                if let Some(text) = delta.content {
                                    if !text.is_empty() {
                                        let (filtered, new_in_thinking) =
                                            filter_thinking_tags(&text, in_thinking);
                                        in_thinking = new_in_thinking;
                                        if !filtered.is_empty() && !in_thinking {
                                            accumulated_text.push_str(&filtered);
                                            let _ = event_tx
                                                .send(StreamEvent::TextDelta { text: filtered });
                                        }
                                    }
                                }
                                if let Some(tcs) = delta.tool_calls {
                                    for delta_tc in tcs {
                                        let idx = delta_tc.index.unwrap_or(0) as usize;
                                        while tool_calls.len() <= idx {
                                            tool_calls.push(PartialToolCall::default());
                                        }
                                        let entry = &mut tool_calls[idx];
                                        if let Some(id) = delta_tc.id {
                                            if entry.id.is_empty() {
                                                entry.id = id.clone();
                                                let name =
                                                    delta_tc.function.as_ref()
                                                        .and_then(|f| f.name.clone())
                                                        .unwrap_or_default();
                                                let _ = event_tx.send(
                                                    StreamEvent::ToolCallStart {
                                                        id,
                                                        name,
                                                    },
                                                );
                                            }
                                        }
                                        if let Some(func) = delta_tc.function {
                                            if let Some(name) = func.name {
                                                if entry.name.is_empty() {
                                                    entry.name = name;
                                                }
                                            }
                                            if let Some(args_delta) = func.arguments {
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
                    Err(e) => {
                        log::warn!("无法解析 SSE 数据: {} | 原文: {}", e, payload);
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
                    .filter(|tc| !tc.id.is_empty())
                    .map(|tc| {
                        let arguments = serde_json::from_str(&tc.arguments_buf)
                            .unwrap_or_else(|_| {
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

        Ok(LlmMessage {
            role: LlmRole::Assistant,
            content: accumulated_text,
            tool_calls: final_tool_calls,
            tool_call_id: None,
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
        tokio::spawn(async move {
            while rx.recv().await.is_some() {}
        });
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

/* ----------------- Internal request/response types ----------------- */

#[derive(Default)]
struct PartialToolCall {
    id: String,
    name: String,
    arguments_buf: String,
}

fn build_request_body(
    config: &LlmConfig,
    messages: &[LlmMessage],
    tools: &[ToolDefinition],
    stream: bool,
) -> serde_json::Value {
    let messages_json: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            let mut obj = serde_json::Map::new();
            let role_str = match m.role {
                LlmRole::System => "system",
                LlmRole::User => "user",
                LlmRole::Assistant => "assistant",
                LlmRole::Tool => "tool",
            };
            obj.insert("role".into(), serde_json::Value::String(role_str.into()));
            obj.insert(
                "content".into(),
                serde_json::Value::String(m.content.clone()),
            );
            if let Some(tcs) = &m.tool_calls {
                // OpenAI API requires tool_calls in a specific format:
                //   { id, type: "function", function: { name, arguments: "<json-string>" } }
                // Our ToolCall stores `arguments` as serde_json::Value, so we
                // need to re-serialize it to a JSON *string*.
                let formatted: Vec<serde_json::Value> = tcs
                    .iter()
                    .map(|tc| {
                        serde_json::json!({
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.name,
                                "arguments": serde_json::to_string(&tc.arguments)
                                    .unwrap_or_else(|_| "{}".into()),
                            }
                        })
                    })
                    .collect();
                obj.insert("tool_calls".into(), serde_json::Value::Array(formatted));
            }
            if let Some(tcid) = &m.tool_call_id {
                obj.insert(
                    "tool_call_id".into(),
                    serde_json::Value::String(tcid.clone()),
                );
            }
            serde_json::Value::Object(obj)
        })
        .collect();

    let mut body = serde_json::json!({
        "model": config.model,
        "messages": messages_json,
        "temperature": config.temperature,
        "stream": stream,
    });

    if !tools.is_empty() {
        let tools_json: Vec<serde_json::Value> = tools
            .iter()
            .map(|t| {
                serde_json::json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    }
                })
            })
            .collect();
        body["tools"] = serde_json::Value::Array(tools_json);
    }

    body
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
}

#[derive(Debug, Deserialize, Serialize)]
struct DeltaToolCall {
    #[serde(default)]
    index: Option<u32>,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    function: Option<DeltaFunction>,
}

#[derive(Debug, Deserialize, Serialize)]
struct DeltaFunction {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    arguments: Option<String>,
}
