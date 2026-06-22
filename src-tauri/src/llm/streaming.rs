use serde::{Deserialize, Serialize};

/// Events emitted while streaming an LLM response. Tagged so the frontend
/// can use a discriminated union for type-safe handling.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    /// Incremental text delta from the assistant.
    TextDelta { text: String },
    /// Incremental thinking/reasoning content from the model.
    ThinkingDelta { text: String },
    /// A new tool call has begun streaming.
    ToolCallStart { id: String, name: String },
    /// Incremental arguments fragment for an in-flight tool call.
    ToolCallDelta { id: String, arguments_delta: String },
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
}
