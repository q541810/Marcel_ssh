use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, watch};

use crate::error::AppError;
use crate::llm::error::{parse_retry_conditions, RetryCondition};
use crate::llm::openai::{ModelInfo, OpenAiProvider, TextSink};
use crate::llm::provider::{LlmConfig, LlmMessage, ToolDefinition};
use crate::llm::streaming::StreamEvent;

/// 判断一次 LLM 响应是否「有效正文为空」——即模型"哑火"：
/// 没有输出可见正文（content 为空或纯空白），也没有调用任何工具。
///
/// - 思维链（`reasoning_content`）**不算正文**：模型只输出思考、在正文开始前
///   就结束流，按业务视为一次失败的响应（需要自动重试）。
/// - 有工具调用（tool_calls 非空）**不算空响应**：那是正常的工具回合。
/// - 内容被过滤（finish_reason == "content_filter"）**不算可重试的哑火**：这是
///   确定性结果，重试同样会被过滤，白烧预算；交由上层按空响应收尾。
///
/// 截断（finish_reason == "length"）不在此列——它由上层按截断语义处理。
pub fn is_effectively_empty_response(msg: &LlmMessage) -> bool {
    if msg.finish_reason.as_deref() == Some("content_filter") {
        return false;
    }
    msg.tool_calls.as_ref().map_or(true, |tcs| tcs.is_empty()) && msg.content.trim().is_empty()
}

/// LLM Manager — 负责整个应用的 LLM 请求生命周期、连接池复用、统一取消信号控制、流状态管理与错误重试调度。
#[derive(Clone)]
pub struct LlmManager {
    config: LlmConfig,
    provider: Arc<OpenAiProvider>,
    retry_conditions: Vec<RetryCondition>,
}

impl LlmManager {
    /// 基于给定的 `LlmConfig` 构造 Manager 实例
    pub fn new(config: LlmConfig) -> Result<Self, AppError> {
        let retry_conditions = parse_retry_conditions(&config.retry_http_statuses);
        let provider = Arc::new(OpenAiProvider::new(config.clone())?);
        Ok(Self {
            config,
            provider,
            retry_conditions,
        })
    }

    pub fn config(&self) -> &LlmConfig {
        &self.config
    }

    pub fn provider(&self) -> Arc<OpenAiProvider> {
        self.provider.clone()
    }

    /// 执行流式调用，并在请求首包前发生可重试瞬态错误时按配置固定秒数重试。
    /// 支持传入 `cancel_rx`，在重试等待 sleep 和请求流式过程中实时响应取消信号。
    pub async fn stream_chat(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<StreamEvent>,
        cancel_rx: Option<&mut watch::Receiver<bool>>,
    ) -> Result<LlmMessage, AppError> {
        self.stream_chat_internal(messages, tools, event_tx, None, None, cancel_rx)
            .await
    }

    /// `stream_chat` 的扩展变体：支持 `sink` 实时回调与输出上限 `max_tokens`（主要供 Summarizer 使用）。
    /// 重试发起新一轮请求前，会自动调用 `sink.reset()` 清空前序尝试残留内容。
    pub async fn stream_chat_with_sink(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<StreamEvent>,
        sink: Option<TextSink<'_>>,
        max_tokens: Option<u32>,
        cancel_rx: Option<&mut watch::Receiver<bool>>,
    ) -> Result<LlmMessage, AppError> {
        self.stream_chat_internal(messages, tools, event_tx, sink, max_tokens, cancel_rx)
            .await
    }

    /// 非流式直接调用（如命令审核 ModelApproval 等）。
    pub async fn send_message(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
        cancel_rx: Option<&mut watch::Receiver<bool>>,
    ) -> Result<LlmMessage, AppError> {
        let (tx, mut rx) = mpsc::unbounded_channel();
        // 丢弃流式事件（非流式调用方只需最终组装结果）
        tokio::spawn(async move { while rx.recv().await.is_some() {} });
        self.stream_chat_internal(messages, tools, &tx, None, None, cancel_rx)
            .await
    }

    /// 拉取模型列表（单次交互，不走自动重试）
    pub async fn list_models(&self) -> Result<Vec<ModelInfo>, AppError> {
        self.provider
            .list_models()
            .await
            .map_err(|e| AppError::from(e))
    }

    /// 内部核心请求生命周期与重试调度状态机
    async fn stream_chat_internal(
        &self,
        messages: &[LlmMessage],
        tools: &[ToolDefinition],
        event_tx: &mpsc::UnboundedSender<StreamEvent>,
        sink: Option<TextSink<'_>>,
        max_tokens: Option<u32>,
        mut cancel_rx: Option<&mut watch::Receiver<bool>>,
    ) -> Result<LlmMessage, AppError> {
        let max_retries = self.config.max_retries;
        let delay = Duration::from_secs_f32(self.config.retry_delay_secs.max(0.0));
        let retry_on_timeout = self.config.retry_on_timeout;
        // 总尝试次数上限 = 重试次数 + 首次（错误重试与空正文重试共用预算）
        let max_attempts = max_retries + 1;

        let mut attempt: u32 = 0;
        loop {
            // 每次尝试前检查取消状态
            if let Some(ref rx) = cancel_rx {
                if *rx.borrow() {
                    return Err(AppError::Cancelled("LLM 请求已取消".into()));
                }
            }

            attempt += 1;
            if let Some(s) = sink {
                (s.reset)();
            }

            // 1. 发起单次请求
            let request_fut = self
                .provider
                .execute_stream(messages, tools, event_tx, sink, max_tokens);

            let (result, phase) = if let Some(ref mut rx) = cancel_rx {
                tokio::select! {
                    res = request_fut => res,
                    _ = rx.changed() => {
                        return Err(AppError::Cancelled("LLM 请求已取消".into()));
                    }
                }
            } else {
                request_fut.await
            };

            // 2. 判定执行结果与重试决策
            match result {
                Ok(msg) => {
                    // 2a. 「有效正文为空」哑火（无正文且无工具调用）：视为一次
                    //     可重试的瞬态失败（思维链不算正文）。消费同一重试预算，
                    //     通过后按空响应返回，由上层决定如何收尾（不静默丢消息）。
                    if attempt < max_attempts && is_effectively_empty_response(&msg) {
                        let err_msg =
                            "模型未输出正文（仅有思考过程或无内容），将自动重试".to_string();
                        log::warn!(
                            "LLM 响应正文为空 (尝试 {}/{}): {}，{}s 后重试",
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
                        // sink（摘要等内嵌调用）：重试新一轮前清空已展示进度，
                        // 与错误重试路径一致，避免残留"上一尝试"的进度文本。
                        if let Some(s) = sink {
                            (s.reset)();
                        }
                        // 重试等待（支持毫秒级打断取消）
                        if let Some(ref mut rx) = cancel_rx {
                            tokio::select! {
                                _ = tokio::time::sleep(delay) => {},
                                _ = rx.changed() => {
                                    return Err(AppError::Cancelled("LLM 请求已取消".into()));
                                }
                            }
                        } else {
                            tokio::time::sleep(delay).await;
                        }
                        continue;
                    }
                    return Ok(msg);
                }
                Err(err) => {
                    let is_retryable =
                        err.is_retryable(phase, &self.retry_conditions, retry_on_timeout);

                    if attempt >= max_attempts || !is_retryable {
                        return Err(AppError::from(err));
                    }

                    let err_msg = err.to_string();
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

                    // 3. 重试等待（支持毫秒级打断取消）
                    if let Some(ref mut rx) = cancel_rx {
                        tokio::select! {
                            _ = tokio::time::sleep(delay) => {},
                            _ = rx.changed() => {
                                return Err(AppError::Cancelled("LLM 请求已取消".into()));
                            }
                        }
                    } else {
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use tokio::sync::{mpsc, watch};

    #[test]
    fn manager_creation_valid() {
        let config = LlmConfig::default();
        let manager = LlmManager::new(config);
        assert!(manager.is_ok());
    }

    #[test]
    fn empty_response_detection_rules() {
        use crate::llm::provider::ToolCall;
        // 无正文、无工具 = 空响应（纯思维链也算空：reasoning 不算正文）
        let mut m = LlmMessage::assistant("");
        m.reasoning_content = Some("思考了很久".into());
        assert!(is_effectively_empty_response(&m));
        // 有正文 = 非空
        assert!(!is_effectively_empty_response(&LlmMessage::assistant(
            "  你好  "
        )));
        // 有工具调用 = 非空（正常工具回合，正文可为空）
        let mut t = LlmMessage::assistant("");
        t.tool_calls = Some(vec![ToolCall {
            id: "c1".into(),
            name: "bash".into(),
            arguments: serde_json::json!({}),
        }]);
        assert!(!is_effectively_empty_response(&t));
        // content_filter 是确定性内容拦截：空正文 + content_filter 不算可重试哑火
        let mut f = LlmMessage::assistant("");
        f.finish_reason = Some("content_filter".into());
        assert!(!is_effectively_empty_response(&f));
        // 对照：普通 finish_reason（如 stop）下的空正文仍是可重试哑火
        let mut s = LlmMessage::assistant("");
        s.finish_reason = Some("stop".into());
        assert!(is_effectively_empty_response(&s));
    }

    #[tokio::test]
    async fn manager_cancel_during_pre_check() {
        let config = LlmConfig::default();
        let manager = LlmManager::new(config).unwrap();
        let (_cancel_tx, mut cancel_rx) = watch::channel(true);
        let (tx, _rx) = mpsc::unbounded_channel();

        let res = manager
            .stream_chat(&[], &[], &tx, Some(&mut cancel_rx))
            .await;
        assert!(matches!(res, Err(AppError::Cancelled(_))));
    }

    #[tokio::test]
    async fn manager_retries_on_retryable_error() {
        let mut config = LlmConfig::default();
        config.max_retries = 2;
        config.retry_delay_secs = 0.01;
        config.retry_http_statuses = "429, 500-599".into();
        config.retry_on_timeout = true;

        let manager = LlmManager::new(config).unwrap();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (_cancel_tx, mut cancel_rx) = watch::channel(false);

        // Given invalid base_url/port, it will fail with network error and trigger retries
        let mut cfg = manager.config().clone();
        cfg.base_url = Some("http://127.0.0.1:1".into()); // Invalid port/connection refused
        let bad_manager = LlmManager::new(cfg).unwrap();

        let retrying_events = Arc::new(AtomicU32::new(0));
        let retrying_events_clone = retrying_events.clone();
        let drain_handle = tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                if let StreamEvent::Retrying { .. } = ev {
                    retrying_events_clone.fetch_add(1, Ordering::SeqCst);
                }
            }
        });

        let res = bad_manager
            .stream_chat(&[], &[], &tx, Some(&mut cancel_rx))
            .await;

        drop(tx);
        let _ = drain_handle.await;

        assert!(res.is_err());
        // Max retries is 2, so it should have emitted 2 retrying events
        assert_eq!(retrying_events.load(Ordering::SeqCst), 2);
    }
}
