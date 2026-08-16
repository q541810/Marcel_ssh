//! 固定密度启发式 token 估算（对齐 DSH `token-meter/estimate.ts`）：
//! 统一密度 `chars/4` + 每文本块 4 token 结构开销 + 每消息 4 token 角色开销。
//! `content`/`reasoning_content`/tool 参数一视同仁。
//! 只用于压缩触发判断与定价，不参与任何持久化/事件。

use crate::llm::provider::{LlmMessage, ToolDefinition};

/// 统一文本密度：每 4 字符约 1 token（对齐 DSH）。
pub const CHARS_PER_TOKEN: usize = 4;
/// 单个内容块的结构开销（JSON 框架 / 类型标签）。
pub const BLOCK_OVERHEAD: usize = 4;
/// 每条消息的角色字段开销。
pub const ROLE_OVERHEAD: usize = 4;

#[inline]
fn ceil_div(n: usize, d: usize) -> usize {
    (n + d - 1) / d
}

/// 文本 token 估算（统一密度，不区分语言）。
#[inline]
fn text_tokens(s: &str) -> usize {
    ceil_div(s.chars().count(), CHARS_PER_TOKEN)
}

/// 估算一条消息的 token 数（content + reasoning_content + tool_calls + 角色开销）。
pub fn estimate_message(msg: &LlmMessage) -> usize {
    let mut tokens = 0usize;

    if !msg.content.is_empty() {
        tokens += text_tokens(&msg.content) + BLOCK_OVERHEAD;
    }
    if let Some(rs) = msg.reasoning_content.as_ref() {
        if !rs.is_empty() {
            tokens += text_tokens(rs) + BLOCK_OVERHEAD;
        }
    }
    if let Some(calls) = msg.tool_calls.as_ref() {
        for tc in calls {
            tokens += text_tokens(&tc.name);
            tokens += text_tokens(&tc.arguments.to_string());
            tokens += BLOCK_OVERHEAD;
        }
    }

    tokens + ROLE_OVERHEAD
}

/// 估算一段消息的总 token 数。
pub fn estimate_messages(msgs: &[LlmMessage]) -> usize {
    msgs.iter().map(estimate_message).sum()
}

/// 估算请求 header（对齐 DSH `estimateHeader`）：system 提示 + 工具 schema。
/// DSH 的 pressure 判断把这两块固定开销计入 `totalTokens`；msl 之前只算
/// messages，低估了每个请求的真实占用。
pub fn estimate_header(system: Option<&str>, tools: &[ToolDefinition]) -> usize {
    let system_tokens = system
        .filter(|s| !s.is_empty())
        .map(|s| text_tokens(s) + ROLE_OVERHEAD)
        .unwrap_or(0);
    let tools_tokens = if tools.is_empty() {
        0
    } else {
        text_tokens(&serde_json::to_string(tools).unwrap_or_default()) + BLOCK_OVERHEAD
    };
    system_tokens + tools_tokens
}

/// 完整请求压力估算（对齐 DSH `measure().totalTokens`）：header + 消息。
/// 注意：**system 提示已在 messages 里**（msl 的 `messages[0]` 就是 system），
/// 这里只追加 tools schema 的 header，避免 system 双重计数
/// （DSH 的 system 只在 request header、surface 无 system，只计一次）。
pub fn estimate_total(msgs: &[LlmMessage], tools: &[ToolDefinition]) -> usize {
    estimate_header(None, tools) + estimate_messages(msgs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::provider::{LlmMessage, ToolCall, ToolDefinition};

    #[test]
    fn empty_message_costs_role_overhead() {
        let m = LlmMessage::user("");
        assert_eq!(estimate_message(&m), ROLE_OVERHEAD);
    }

    #[test]
    fn text_scales_with_chars_per_token() {
        // "abcd" = 1 token + block overhead + role overhead
        let m = LlmMessage::user("abcd");
        assert_eq!(estimate_message(&m), 1 + BLOCK_OVERHEAD + ROLE_OVERHEAD);
    }

    #[test]
    fn multibyte_chars_count_as_single_units() {
        // 中文按字符数计（非字节）："中文" = ceil(2/4) = 1 token
        let m = LlmMessage::user("中文");
        assert_eq!(
            estimate_message(&m),
            1 + BLOCK_OVERHEAD + ROLE_OVERHEAD
        );
    }

    #[test]
    fn reasoning_content_is_priced() {
        let mut m = LlmMessage::assistant("visible");
        m.reasoning_content = Some("hidden reasoning".into());
        let without = estimate_message(&LlmMessage::assistant("visible"));
        assert!(estimate_message(&m) > without);
    }

    #[test]
    fn tool_calls_are_priced() {
        let mut m = LlmMessage::assistant("");
        m.tool_calls = Some(vec![ToolCall {
            id: "call-1".into(),
            name: "read_file".into(),
            arguments: serde_json::json!({"path": "/etc/hosts"}),
        }]);
        let no_calls = estimate_message(&LlmMessage::assistant(""));
        assert!(estimate_message(&m) > no_calls);
    }

    #[test]
    fn estimate_header_counts_system_and_tools() {
        let tools = vec![ToolDefinition {
            name: "read_file".into(),
            description: "read a file".into(),
            parameters: serde_json::json!({}),
        }];
        let none = estimate_header(None, &[]);
        assert_eq!(none, 0);
        let with_system = estimate_header(Some("you are an agent"), &[]);
        assert!(with_system > none);
        let with_tools = estimate_header(None, &tools);
        assert!(with_tools > none);
    }

    #[test]
    fn estimate_total_counts_messages_and_tools_header_only() {
        // system 已含在 messages[0]，estimate_total 只追加 tools header（不双重计数）
        let tools = vec![ToolDefinition {
            name: "read_file".into(),
            description: "read a file".into(),
            parameters: serde_json::json!({}),
        }];
        let mut msgs = vec![LlmMessage::system("you are an agent"), LlmMessage::user("abc")];
        let total = estimate_total(&msgs, &tools);
        assert_eq!(total, estimate_header(None, &tools) + estimate_messages(&msgs));
        // system 只计一次（作为消息），header 不再加 system
        assert!(total < estimate_header(Some("you are an agent"), &tools) + estimate_messages(&msgs));
        msgs.clear();
        assert_eq!(estimate_total(&msgs, &[]), 0);
    }

    #[test]
    fn estimate_messages_sums() {
        let msgs = vec![LlmMessage::user("a"), LlmMessage::assistant("b")];
        assert_eq!(
            estimate_messages(&msgs),
            estimate_message(&msgs[0]) + estimate_message(&msgs[1])
        );
    }
}
