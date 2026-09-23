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
///
/// `transient[i] == true` 的消息（调用方每轮重新生成的临时注入，见
/// `super::is_transient_injection`）**不参与尾部预算与边界判定**：它既不该吃
/// `retain_tokens`，也不该成为保留区的边界——`retain_tokens = 0`（上下文超限
/// 恢复）时尾循环第一个碰到的就是最后一条消息，若那条恰好是瞬态注入，保留位会
/// 落在它身上，**最新用户指令整条落进被压区间**（与本模块「最新用户指令永不被
/// 压」的不变量直接矛盾）。下标越界一律按 `false` 处理。
pub fn select_compactable_range(
    msgs: &[LlmMessage],
    cuts: &[bool],
    retain_tokens: usize,
    transient: &[bool],
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

    let is_transient = |i: usize| transient.get(i).copied().unwrap_or(false);
    let mut accumulated = 0usize;
    let mut keep_from: Option<usize> = None;
    for i in (start..msgs.len()).rev() {
        if is_transient(i) {
            continue;
        }
        accumulated += estimate_message(&msgs[i]);
        keep_from = Some(i);
        if accumulated >= retain_tokens {
            break;
        }
    }
    // 区间内一条真实消息都没有（全是瞬态注入）→ 没有可压的东西。
    let Some(mut keep_from) = keep_from else {
        return None;
    };
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
        assert_eq!(select_compactable_range(&[], &[true], 0, &[]), None);
    }

    #[test]
    fn system_only_none() {
        let msgs = vec![LlmMessage::system("you are an agent")];
        assert_eq!(select_compactable_range(&msgs, &[true, true], 0, &[]), None);
    }

    #[test]
    fn retains_tail_budget() {
        // 10 条 user 消息；retain 3 → 压前 7 条，留后 3 条
        let msgs: Vec<LlmMessage> = (0..10).map(|i| user(&format!("msg {i}"))).collect();
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        // 每条 user 消息 token 固定；retain 3 条 ≈ 3 * est
        let per_msg = estimate_message(&msgs[0]);
        let range = select_compactable_range(&msgs, &cuts, per_msg * 3, &[]).unwrap();
        assert_eq!(range, RangeSelection { start: 0, end: 6 });
    }

    #[test]
    fn retain_zero_presses_almost_everything() {
        let msgs = vec![user("a"), user("b"), user("c")];
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        // retain=0 → keep_from 落到最后一条 → 压 [0, len-2]
        let range = select_compactable_range(&msgs, &cuts, 0, &[]).unwrap();
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
        let range = select_compactable_range(&msgs, &cuts, per_msg * 1, &[]).unwrap();
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
        let range = select_compactable_range(&msgs, &cuts, 0, &[]).unwrap();
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
        assert_eq!(select_compactable_range(&msgs, &cuts, 0, &[]), None);
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
        assert_eq!(
            select_compactable_range(&msgs, &cuts, usize::MAX, &[]),
            None
        );
    }

    /// 瞬态注入（每轮重新生成的 plan 上下文，插在队尾）不占保留位。
    ///
    /// 这正是 `retain = 0`（上下文超限恢复）的真实形状：没有这条排除，尾循环
    /// 第一个碰到的就是那条注入，保留位落在它身上——**最新用户指令**整条落进
    /// 被压区间，与本模块「最新用户指令永不被压」的不变量直接矛盾。
    #[test]
    fn transient_tail_does_not_take_the_retained_slot() {
        let plan_inject = LlmMessage::system(&format!(
            "{}{}",
            crate::agent::plan_handler::PLAN_CONTEXT_PREFIX,
            "x".repeat(200)
        ));
        let msgs = vec![
            LlmMessage::system("system prompt"),
            user("u1"),
            user("u2"),
            plan_inject,
        ];
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        let transient = vec![false, false, false, true];

        let range = select_compactable_range(&msgs, &cuts, 0, &transient).unwrap();
        assert_eq!(
            range,
            RangeSelection { start: 1, end: 1 },
            "保留位必须留给最新用户消息 u2，否则它的逐字文本会被压掉"
        );

        // 不看瞬态标记（改动前的行为）：保留位被注入占住，u2 落入被压区间
        let without_mask = select_compactable_range(&msgs, &cuts, 0, &[]).unwrap();
        assert_eq!(without_mask, RangeSelection { start: 1, end: 2 });
    }

    /// 带预算时同理：瞬态注入不参与累计，保留尾部仍是最近的非瞬态消息。
    #[test]
    fn transient_tail_is_not_counted_in_the_retain_budget() {
        let msgs = vec![
            LlmMessage::system("system prompt"),
            user("u1"),
            user("u2"),
            user("u3"),
            LlmMessage::system(&format!(
                "{}{}",
                crate::agent::plan_handler::PLAN_CONTEXT_PREFIX,
                "x".repeat(200)
            )),
        ];
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        let transient = vec![false, false, false, false, true];
        let per_msg = estimate_message(&msgs[1]);

        // 预算 = 2 条真实消息 → 保留 u2/u3（注入不吃预算）
        let range = select_compactable_range(&msgs, &cuts, per_msg * 2, &transient).unwrap();
        assert_eq!(range, RangeSelection { start: 1, end: 1 });

        // 不看瞬态标记（改动前的行为）：预算被注入吃掉，只留下 u3
        let without_mask = select_compactable_range(&msgs, &cuts, per_msg * 2, &[]).unwrap();
        assert_eq!(without_mask, RangeSelection { start: 1, end: 3 });
    }

    /// 防御：区间里一条真实消息都没有（全是瞬态注入）时不给出区间，
    /// 不能让压缩把一条注入当历史压成摘要。
    #[test]
    fn all_transient_span_has_no_compactable_range() {
        let msgs = vec![
            LlmMessage::system("system prompt"),
            LlmMessage::system(&format!(
                "{}1. 步骤",
                crate::agent::plan_handler::PLAN_CONTEXT_PREFIX
            )),
        ];
        let cuts = super::super::pairing::cut_balance(&msgs).unwrap();
        assert_eq!(
            select_compactable_range(&msgs, &cuts, 0, &[false, true]),
            None
        );
    }
}
