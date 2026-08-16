//! 工具调用/结果配对平衡（对齐 DSH `compaction/tool-pairing.ts`）。
//!
//! 压缩切点绝不能落在 assistant 的 tool_calls 与其 tool 结果之间，否则会
//! 生成 provider 拒绝的悬挂 transcript。这里在 `Vec<LlmMessage>` 上增量
//! 计算每个切点的平衡状态，并检测 corrupt 消息流（tool 结果无匹配调用）。

use crate::llm::provider::{LlmMessage, LlmRole};

/// 计算每个切点的平衡状态。
///
/// 返回 `cuts`：`cuts.len() == msgs.len() + 1`，`cuts[i]` 表示 `msgs[i]`
/// **之前**的切点（`cuts[0]` 恒为 `true`，即空 surface 首切平衡），
/// `cuts[len]` 表示全部消息之后。
///
/// 检测到 tool 结果没有匹配的进行中调用（corrupt surface）时返回 `Err`。
pub fn cut_balance(msgs: &[LlmMessage]) -> Result<Vec<bool>, String> {
    let mut in_progress = 0usize;
    let mut cuts = Vec::with_capacity(msgs.len() + 1);
    cuts.push(true);

    for m in msgs {
        match m.role {
            LlmRole::Assistant => {
                in_progress += m.tool_calls.as_ref().map(|t| t.len()).unwrap_or(0);
            }
            LlmRole::Tool if m.tool_call_id.is_some() => {
                if in_progress == 0 {
                    return Err(
                        "tool/result has no matching tool-call (corrupt message stream)".into(),
                    );
                }
                in_progress -= 1;
            }
            _ => {}
        }
        cuts.push(in_progress == 0);
    }

    Ok(cuts)
}

/// `msgs[idx]` 之前的切点是否平衡（`idx == 0` 恒平衡）。
pub fn balanced_before(cuts: &[bool], idx: usize) -> bool {
    cuts.get(idx).copied().unwrap_or(false)
}

/// `msgs[idx]` 之后的切点是否平衡（`idx == len-1` 即尾部切点）。
pub fn balanced_after(cuts: &[bool], idx: usize) -> bool {
    cuts.get(idx + 1).copied().unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::provider::{LlmMessage, ToolCall};

    fn tool_call(id: &str) -> ToolCall {
        ToolCall {
            id: id.into(),
            name: "read_file".into(),
            arguments: serde_json::json!({}),
        }
    }

    fn tool_result(call_id: &str) -> LlmMessage {
        let mut m = LlmMessage::assistant("");
        m.role = LlmRole::Tool;
        m.tool_call_id = Some(call_id.into());
        m
    }

    fn assistant_with_calls(ids: &[&str]) -> LlmMessage {
        let mut m = LlmMessage::assistant("checking");
        m.tool_calls = Some(ids.iter().map(|id| tool_call(id)).collect());
        m
    }

    #[test]
    fn empty_stream_is_balanced() {
        let cuts = cut_balance(&[]).unwrap();
        assert_eq!(cuts, vec![true]);
    }

    #[test]
    fn plain_messages_are_always_balanced() {
        let msgs = vec![
            LlmMessage::user("hi"),
            LlmMessage::assistant("hello"),
            LlmMessage::user("again"),
        ];
        let cuts = cut_balance(&msgs).unwrap();
        assert!(cuts.iter().all(|b| *b));
    }

    #[test]
    fn cut_inside_pair_is_unbalanced() {
        let msgs = vec![
            LlmMessage::user("go"),
            assistant_with_calls(&["c1"]),
            // 切点在这里（tool 结果之前）→ 不平衡
            tool_result("c1"),
            LlmMessage::assistant("done"),
        ];
        let cuts = cut_balance(&msgs).unwrap();
        assert!(cuts[0]); // 最前
        assert!(cuts[1]); // user 之后
        assert!(!cuts[2]); // assistant(tool_calls) 之后 → 未闭合
        assert!(cuts[3]); // tool 结果之后 → 闭合
        assert!(cuts[4]); // 尾部
    }

    #[test]
    fn parallel_calls_pair_all_results() {
        let msgs = vec![
            assistant_with_calls(&["a", "b", "c"]),
            tool_result("a"),
            tool_result("b"),
            tool_result("c"),
        ];
        let cuts = cut_balance(&msgs).unwrap();
        assert_eq!(cuts, vec![true, false, false, false, true]);
    }

    #[test]
    fn orphan_tool_result_is_corrupt() {
        let msgs = vec![tool_result("ghost")];
        assert!(cut_balance(&msgs).is_err());
    }

    #[test]
    fn balanced_before_after_helpers() {
        let msgs = vec![
            LlmMessage::user("u"),
            assistant_with_calls(&["x"]),
            tool_result("x"),
        ];
        let cuts = cut_balance(&msgs).unwrap();
        assert!(balanced_before(&cuts, 0));
        assert!(!balanced_before(&cuts, 2)); // assistant 之前（its 前 cut 是 cuts[2]）
        assert!(balanced_after(&cuts, 2)); // tool 结果之后
    }
}
