use crate::llm::provider::TokenUsage;
use serde::{Deserialize, Serialize};

/// Events emitted while streaming an LLM response. Tagged so the frontend
/// can use a discriminated union for type-safe handling.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StreamEvent {
    /// Incremental text delta from the assistant.
    TextDelta { text: String },
    /// Incremental thinking/reasoning content from the model.
    ThinkingDelta { text: String },
    /// A new tool call has begun streaming.
    ToolCallStart { id: String, name: String },
    /// Incremental arguments fragment for an in-flight tool call.
    ToolCallDelta { id: String, arguments_delta: String },
    /// Token usage info from the LLM provider's API response.
    Usage { usage: TokenUsage },
    /// Stream finished cleanly.
    Done,
    /// Stream terminated with an error.
    Error { message: String },
    /// LLM call is being retried after a transient error.
    Retrying {
        attempt: u32,
        max_attempts: u32,
        delay_secs: f32,
        last_error: String,
    },
    /// Context compaction started — LLM summarization of old history is in
    /// progress (can take tens of seconds; frontend must not look stalled).
    CompactionStart { trigger: String },
    /// Live progress during compaction — the summary text generated so far
    /// (cumulative), streamed incrementally so the UI can show real progress
    /// instead of a static spinner that reads as stalled.
    CompactionProgress { text: String },
    /// Context compaction completed successfully.
    CompactionDone {
        summary: String,
        shadowed_messages: usize,
        shadowed_tokens: usize,
        /// 被压区间末条消息的 DB row id（统一 id 指针）：前端按 `dbId`
        /// 定位插卡，取代位置数数与指纹验证。
        tail_db_id: Option<String>,
    },
    /// Context compaction was skipped. `attempted` 标记是否已进入摘要阶段：
    /// `false` = 未开始就跳过（无区间/结构异常，前端不留痕）；
    /// `true` = 摘要调用已跑但失败（截断/未遵循指令/校验不过，前端应低调交代）。
    CompactionSkipped { reason: String, attempted: bool },
}
