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
    /// The agent loop stopped because it was **cancelled** (user stop /
    /// reject-and-stop / session-level cascade), not because the model finished.
    ///
    /// 与 `Done` 分开是语义要求，不是措辞洁癖：前端对 `Done` 的动作是「模型自然
    /// 结束」——把还在执行的工具卡片按「没跑完的调用」删掉、把回合收尾状态写成
    /// `completed`。取消时这两件事都是错的：卡片是用户刚刚盯着看的那张（后端已
    /// 为它落了「已中断」的 tool 行），`completed` 还会让回合折叠成立即把过程收成
    /// 一行控制条（过程卡片从界面上消失，而模型侧其实仍看得到）。
    Cancelled,
    /// 子 agent 调用了 `ask_parent`：这一轮**干净地停在提问上**，等主 agent 回答
    /// （不是自然结束、不是取消、不是失败）。
    ///
    /// 与 `Done` 分开：`Done` 会让前端把没有结果的工具卡片当「没跑完的调用」删掉，并把
    /// 回合写成 `completed`；这里恰恰相反——`ask_parent` 那张卡片要留着（它是「在等回答」
    /// 的唯一可见痕迹），回合状态是 `awaiting_parent`（不折叠）。
    /// 回答到达时（`continue_id` 续派），前端从 `subTaskStart.answersAsk` 得知并补上结果。
    AwaitingParent {
        tool_call_id: String,
        question: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        context: Option<String>,
    },
    /// Stream terminated with an error.
    Error { message: String },
    /// 一条消息已落库 —— 把 DB row id 广播给前端，回填 live 消息的 `dbId`。
    ///
    /// live 消息的前端 id 是临时 UUID、与库内 id 不同域；不回填的话，「拿 live
    /// 消息定位」的功能（如分叉锚点）在会话重载前永远解析不到。`role` 为落库
    /// 行角色（user / notice / assistant / tool）；`tool_call_id` 仅 tool 行携带
    /// （前端按工具卡片的 toolCallId 定位）。`conversation_id` 供前端过滤：
    /// 子 agent 的流不该写进父会话的 live store。
    MessageSaved {
        conversation_id: String,
        role: String,
        db_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_call_id: Option<String>,
    },
    /// LLM call is being retried after a transient error.
    Retrying {
        attempt: u32,
        max_attempts: u32,
        delay_secs: f32,
        last_error: String,
        /// 失败发生在流式输出途中（首包之后）：这一轮已经上屏的正文 / 思考 /
        /// 工具卡是半截，前端要撤掉，重试会从头重新输出整轮。
        #[serde(default)]
        discard_partial: bool,
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
    /// 本会话的 token 用量快照 —— 每轮 LLM 请求结束后发**一次**，带的是
    /// **写库之后**的数字（由 agent loop 发出，不是 provider 直接发的）。
    ///
    /// 与 [`StreamEvent::Usage`] 不是同一件事，别混：
    /// - `Usage`：provider 这一轮报了什么 —— **单轮原始值**，未落库；
    /// - `ContextUsage`：本会话**累计**（前十项，已落库）+ 这一轮请求的
    ///   上下文快照（`context_window` 起）。前端对它**只覆盖、不累加** ——
    ///   重启后从会话数据读出来的是同一个数字，累加会把同一轮算两遍。
    ///
    /// 累计**不含子 agent**：子 agent 有它自己的会话行，各自记各自的
    /// （界面上的「含子 agent」由前端把父会话与各子会话相加）。
    ContextUsage {
        prompt_tokens: u64,
        completion_tokens: u64,
        total_tokens: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        reasoning_tokens: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cached_read_tokens: Option<u64>,
        /// 生效的上下文窗口（0 = 未配置：前端不画占用弧，只显示已用值）
        context_window: u64,
        /// 这一轮请求的 prompt 总量（provider 精确值优先）
        used_tokens: u64,
        /// `used_tokens` 与三段构成是否为本地估算（provider 没报用量）。
        /// 前端据此加 `~` 前缀，别把估算值讲成精确值。
        estimated: bool,
        /// 请求构成的估算拆分（对齐 DSH 的三分段），仅用于展示。
        system_tokens: u64,
        tools_tokens: u64,
        message_tokens: u64,
    },
}

#[cfg(test)]
mod tests {
    use super::StreamEvent;

    /// 终态事件的线上形状：前端按 `type` 分流，`Done` = 模型自然结束、
    /// `Cancelled` = 取消终止——**两者不能长得一样**，否则前端会把取消当自然
    /// 结束处理（删掉在飞的工具卡片、把回合收尾状态写成 completed）。
    #[test]
    fn terminal_events_are_distinguishable_on_the_wire() {
        assert_eq!(
            serde_json::to_value(StreamEvent::Done).unwrap()["type"],
            "done"
        );
        assert_eq!(
            serde_json::to_value(StreamEvent::Cancelled).unwrap()["type"],
            "cancelled"
        );
    }

    /// 用量快照的线上形状：前端按 `contextWindow` / `usedTokens` 读，
    /// 字段改名或漏了 `skip_serializing_if`（可选字段会变成 `null`，
    /// 前端分不清「没报过」与「报了 null」）这里会红。
    #[test]
    fn context_usage_wire_shape() {
        let v = serde_json::to_value(StreamEvent::ContextUsage {
            prompt_tokens: 1200,
            completion_tokens: 30,
            total_tokens: 1230,
            reasoning_tokens: Some(10),
            cached_read_tokens: None,
            context_window: 200_000,
            used_tokens: 84_213,
            estimated: false,
            system_tokens: 3100,
            tools_tokens: 12_400,
            message_tokens: 68_713,
        })
        .unwrap();
        assert_eq!(v["type"], "contextUsage");
        assert_eq!(v["promptTokens"], 1200);
        assert_eq!(v["contextWindow"], 200_000);
        assert_eq!(v["usedTokens"], 84_213);
        assert_eq!(v["estimated"], false);
        assert_eq!(v["systemTokens"], 3100);
        assert!(
            v.get("cachedReadTokens").is_none(),
            "没报过的可选字段不该出现在线上"
        );
    }

    /// 落库广播的线上形状：前端按 `conversationId` 过滤（子 agent 的流不进
    /// 父会话）、按 `dbId` 回填、tool 行再按 `toolCallId` 定位卡片。字段改名
    /// 或可选字段漏了 `skip_serializing_if`（变 `null`）这里会红。
    #[test]
    fn message_saved_wire_shape() {
        let v = serde_json::to_value(StreamEvent::MessageSaved {
            conversation_id: "conv_1".into(),
            role: "tool".into(),
            db_id: "row_9".into(),
            tool_call_id: Some("call_7".into()),
        })
        .unwrap();
        assert_eq!(v["type"], "messageSaved");
        assert_eq!(v["conversationId"], "conv_1");
        assert_eq!(v["role"], "tool");
        assert_eq!(v["dbId"], "row_9");
        assert_eq!(v["toolCallId"], "call_7");

        let v = serde_json::to_value(StreamEvent::MessageSaved {
            conversation_id: "conv_1".into(),
            role: "assistant".into(),
            db_id: "row_3".into(),
            tool_call_id: None,
        })
        .unwrap();
        assert!(v.get("toolCallId").is_none(), "非 tool 行不携带 toolCallId");
    }
}
