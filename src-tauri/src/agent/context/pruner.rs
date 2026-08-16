//! Model-free 工具结果修剪（对齐 DSH `compaction-tool-result-pruner`）：
//! 按 Unicode code point（非字节/UTF-16 单元）做头中尾裁剪，中段插入标记。
//! 只改写 `role == Tool` 消息的 content 文本，不触碰消息结构/协议字段。

use crate::llm::provider::{LlmMessage, LlmRole};

/// 替换被删除中段的标记。
pub const PRUNE_MARKER: &str = "\n\n[... tool result middle pruned ...]\n\n";

/// 修剪预算（默认对齐 DSH DEFAULTS）。
#[derive(Debug, Clone)]
pub struct PruneConfig {
    /// 超过此 code-point 数才修剪。
    pub threshold_chars: usize,
    /// 保留的头部 code points。
    pub head_chars: usize,
    /// 保留的尾部 code points。
    pub tail_chars: usize,
}

impl Default for PruneConfig {
    fn default() -> Self {
        Self {
            threshold_chars: 8192,
            head_chars: 4096,
            tail_chars: 1024,
        }
    }
}

/// 单条 tool content 修剪。超预算且修剪后有收益时返回新文本，否则 `None`。
/// 按 Unicode code point 切分，绝不劈开字符（含 surrogate pair）。
pub fn prune_content(content: &str, cfg: &PruneConfig) -> Option<String> {
    let points: Vec<char> = content.chars().collect();
    let total = points.len();
    if total <= cfg.threshold_chars {
        return None;
    }
    let marker_len = PRUNE_MARKER.chars().count();
    // 无收益（结果不会更小）则不压
    if cfg.head_chars + marker_len + cfg.tail_chars >= total {
        return None;
    }
    let head: String = points[..cfg.head_chars].iter().collect();
    let tail_start = total - cfg.tail_chars;
    let tail: String = points[tail_start..].iter().collect();
    Some(format!("{}{}{}", head, PRUNE_MARKER, tail))
}

/// 修剪 `messages` 中所有超预算的 tool 消息。返回被压条数。
pub fn prune_messages(msgs: &mut [LlmMessage], cfg: &PruneConfig) -> usize {
    let mut pruned = 0usize;
    for m in msgs.iter_mut() {
        if m.role != LlmRole::Tool {
            continue;
        }
        if let Some(new_content) = prune_content(&m.content, cfg) {
            m.content = new_content;
            pruned += 1;
        }
    }
    pruned
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> PruneConfig {
        PruneConfig {
            threshold_chars: 100,
            head_chars: 10,
            tail_chars: 5,
        }
    }

    #[test]
    fn within_threshold_unchanged() {
        let content = "x".repeat(100);
        assert_eq!(prune_content(&content, &cfg()), None);
    }

    #[test]
    fn over_threshold_keeps_head_and_tail() {
        let content = "A".repeat(200);
        let pruned = prune_content(&content, &cfg()).unwrap();
        assert!(pruned.starts_with(&"A".repeat(10)));
        assert!(pruned.ends_with(&"A".repeat(5)));
        assert!(pruned.contains(PRUNE_MARKER));
        assert!(pruned.len() < content.len());
    }

    #[test]
    fn no_benefit_when_budget_consumes_everything() {
        // head + marker + tail >= total → 不压
        let cfg_small = PruneConfig {
            threshold_chars: 100,
            head_chars: 90,
            tail_chars: 90,
        };
        let content = "x".repeat(200);
        assert_eq!(prune_content(&content, &cfg_small), None);
    }

    #[test]
    fn multibyte_safe() {
        let content = "中".repeat(300);
        let pruned = prune_content(&content, &cfg()).unwrap();
        assert!(pruned.starts_with(&"中".repeat(10)));
        assert!(pruned.ends_with(&"中".repeat(5)));
        assert!(pruned.contains(PRUNE_MARKER));
    }

    #[test]
    fn empty_and_short_content_untouched() {
        assert_eq!(prune_content("", &cfg()), None);
        assert_eq!(prune_content("short", &cfg()), None);
    }

    #[test]
    fn prune_messages_only_touches_tool_role() {
        use crate::llm::provider::LlmMessage;
        let mut msgs = vec![
            LlmMessage::user("user keeps full text"),
            LlmMessage::assistant("assistant keeps full text"),
            {
                let mut t = LlmMessage::assistant("");
                t.role = LlmRole::Tool;
                t.tool_call_id = Some("c1".into());
                t.content = "A".repeat(200);
                t
            },
        ];
        let before_user = msgs[0].content.clone();
        let before_assistant = msgs[1].content.clone();
        let pruned = prune_messages(&mut msgs, &cfg());
        assert_eq!(pruned, 1);
        assert_eq!(msgs[0].content, before_user);
        assert_eq!(msgs[1].content, before_assistant);
        assert!(msgs[2].content.contains(PRUNE_MARKER));
    }
}
