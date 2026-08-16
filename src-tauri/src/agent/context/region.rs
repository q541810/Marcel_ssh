//! Surface 区间选择（对齐 DSH `compaction-basic/region.ts: selectCompactableRange`）。
//!
//! head-anchored：永远从最旧（第一条非 System 消息）压起；尾部保留
//! `retain_tokens` 预算逐字不动；切点必须工具配对平衡。无可用区间返回 `None`。

use crate::llm::provider::{LlmMessage, LlmRole};

use super::meter::estimate_message;

/// 一个含端点的消息索引区间（`Vec::splice(range.start..=range.end, …)` 可直接使用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RangeSelection {
    pub start: usize,
    pub end: usize,
}

/// 第一条非 System 消息的索引。`messages[0]` 通常是系统提示词（不参与压缩）。
fn first_content_index(msgs: &[LlmMessage]) -> usize {
    msgs.iter()
        .position(|m| m.role != LlmRole::System)
        .unwrap_or(msgs.len())
}

/// 选择可压缩区间：
/// - 起点 = 第一条非 System 消息（System 提示词永不压缩）
/// - 从尾部向前累计 token 到 `retain_tokens`，得到首个保留索引 `keep_from`
/// - `keep_from` 向前回退到配对平衡切点（`cuts[keep_from]` 为真）
/// - 区间 = `[start, keep_from - 1]`
///
/// `cuts` 必须与 `msgs` 一致（由 `super::pairing::cut_balance` 计算）。
pub fn select_compactable_range(
    msgs: &[LlmMessage],
    cuts: &[bool],
    retain_tokens: usize,
) -> Option<RangeSelection> {
    // 防御：输入消息流尾部必须配对平衡（悬挂 tool-call 的损坏输入不参与压缩，
    // 压缩无法修复悬挂，还可能把仅有的内容换掉）。
    if !cuts.last().copied().unwrap_or(true) {
        return None;
    }

    let start = first_content_index(msgs);
    if start >= msgs.len() {
        return None; // 没有可压缩内容（全是 system）
    }

    let mut accumulated = 0usize;
    let mut keep_from = msgs.len();
    for i in (start..msgs.len()).rev() {
        accumulated += estimate_message(&msgs[i]);
        keep_from = i;
        if accumulated >= retain_tokens {
            break;
        }
    }
    if keep_from <= start {
        return None;
    }

    // 向前回退到配对平衡切点
    while keep_from > start && !cuts.get(keep_from).copied().unwrap_or(false) {
        keep_from -= 1;
    }
    if keep_from <= start {
        return None;
    }

    Some(RangeSelection {
        start,
        end: keep_from - 1,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::provider::LlmMessage;

    fn user(content: &str) -> LlmMessage {
        LlmMessage::user(content)
    }

    #[test]
    fn empty_messages_none() {
        assert_eq!(select_compactable_range(&[], &[true], 0), None);
    }

    #[test]
    fn system_only_none() {
        let msgs = vec![LlmMessage::system("you are an agent")];
        assert_eq!(select_compactable_range(&msgs, &[true, true], 0), None);
    }

    #[test]
    fn retains_tail_budget() {
        // 10 条 user 消息；retain 3 → 压前 7 条，留后 3 条
        let msgs: Vec<LlmMessage> = (0..10).map(|i| user(&format!("msg {i}"))).collect();
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        // 每条 user 消息 token 固定；retain 3 条 ≈ 3 * est
        let per_msg = estimate_message(&msgs[0]);
        let range = select_compactable_range(&msgs, &cuts, per_msg * 3).unwrap();
        assert_eq!(range, RangeSelection { start: 0, end: 6 });
    }

    #[test]
    fn retain_zero_presses_almost_everything() {
        let msgs = vec![user("a"), user("b"), user("c")];
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        // retain=0 → keep_from 落到最后一条 → 压 [0, len-2]
        let range = select_compactable_range(&msgs, &cuts, 0).unwrap();
        assert_eq!(range, RangeSelection { start: 0, end: 1 });
    }

    #[test]
    fn skips_leading_system_message() {
        let msgs = vec![
            LlmMessage::system("system prompt"),
            user("u1"),
            user("u2"),
            user("u3"),
        ];
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        let per_msg = estimate_message(&msgs[1]);
        let range = select_compactable_range(&msgs, &cuts, per_msg * 1).unwrap();
        // 起点是索引 1（跳过 system）；retain 1 条 → 压 [1, 2]
        assert_eq!(range, RangeSelection { start: 1, end: 2 });
    }

    #[test]
    fn backs_off_to_balanced_cut() {
        use crate::llm::provider::{LlmRole, ToolCall};
        // user, assistant(call), tool(result), user —— 压到 tool 结果之前会切在配对中间，
        // 必须回退到 assistant 之前的平衡切点
        let mut asst = LlmMessage::assistant("run");
        asst.tool_calls = Some(vec![ToolCall {
            id: "c1".into(),
            name: "cmd".into(),
            arguments: serde_json::json!({}),
        }]);
        let mut t = LlmMessage::assistant("");
        t.role = LlmRole::Tool;
        t.tool_call_id = Some("c1".into());
        t.content = "output".into();

        let msgs = vec![user("go"), asst, t, user("next")];
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        let range = select_compactable_range(&msgs, &cuts, 0).unwrap();
        // keep_from 最初 = 3（最后一条 user），cut 3 前平衡（tool 结果已闭合）→ 区间 [0,2]
        assert_eq!(range, RangeSelection { start: 0, end: 2 });
    }

    #[test]
    fn unbalanced_stream_rejects_whole_range() {
        use crate::llm::provider::{LlmRole, ToolCall};
        let mut asst = LlmMessage::assistant("run");
        asst.tool_calls = Some(vec![ToolCall {
            id: "c1".into(),
            name: "cmd".into(),
            arguments: serde_json::json!({}),
        }]);
        // assistant(tool_calls) 之后无 tool 结果 → 消息流尾部不平衡（损坏输入）
        let msgs = vec![user("go"), asst];
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        // 尾部不平衡 → 拒绝压缩整个消息流（压缩无法修复悬挂）
        assert_eq!(select_compactable_range(&msgs, &cuts, 0), None);
    }

    #[test]
    fn unbalanced_tail_is_rejected_even_with_large_retain() {
        use crate::llm::provider::{LlmRole, ToolCall};
        let mut asst = LlmMessage::assistant("run");
        asst.tool_calls = Some(vec![ToolCall {
            id: "c1".into(),
            name: "cmd".into(),
            arguments: serde_json::json!({}),
        }]);
        let msgs = vec![user("go"), asst, user("tail")];
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        assert_eq!(select_compactable_range(&msgs, &cuts, usize::MAX), None);
    }
}
