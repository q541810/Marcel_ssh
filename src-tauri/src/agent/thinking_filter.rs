//! Thinking tag filtering for LLM output.
//!
//! Provides both streaming (chunk-aware) and complete-text filtering.

/// Thinking tag markers used by many LLMs
pub(crate) const THINKING_START_TAGS: &[&str] = &["<thinking>", "<Thought>", "<think>"];
pub(crate) const THINKING_END_TAGS: &[&str] = &["</thinking>", "</Thought>", "</think>"];

/// 流式过滤器的跨片状态。
///
/// 为什么状态不只是一个布尔：**标签字面量自己也会被分片切开**（`<thin` +
/// `king>`）。只看单片的 `find` 找不到完整标签，于是第一片被当普通正文上屏、
/// 第二片因为没了开标签而连整段思维正文一起上屏。
///
/// `pending` 里只可能是标签**字面量**的前缀（绝不含思维正文）：不在思维块内
/// 时是开标签前缀（下一片凑成完整标签就进思维块，凑不成就是正文），在思维块
/// 内时是可补全的闭标签前缀（属于隐藏区域，凑不成就丢弃）。
#[derive(Debug, Default, Clone)]
pub(crate) struct ThinkingFilterState {
    in_thinking: bool,
    pending: String,
}

impl ThinkingFilterState {
    /// 流结束时取走仍待定的尾巴。
    ///
    /// 不在思维块内时它可能是开标签的半截、也可能就是正文（例如整条流以 `<`
    /// 结尾）：补发出去，宁可让用户看到半个标签字面量，也不静默吞掉模型实际
    /// 输出过的可见字符。在思维块内时那半截是闭标签前缀，属于隐藏区域，丢弃。
    pub(crate) fn take_pending(&mut self) -> String {
        if self.in_thinking {
            self.pending.clear();
            return String::new();
        }
        std::mem::take(&mut self.pending)
    }
}

/// 最早出现的完整标签：返回（起点, 标签结束后的位置）。
fn earliest_tag(input: &str, tags: &[&str]) -> Option<(usize, usize)> {
    let mut earliest: Option<(usize, usize)> = None;
    for tag in tags {
        if let Some(pos) = input.find(tag) {
            if earliest.map_or(true, |(_, epos)| pos < epos) {
                earliest = Some((pos, pos + tag.len()));
            }
        }
    }
    earliest
}

/// 结尾处「可能是某个标签前缀」的**最长**尾巴的起始位置。
///
/// 逐个长度试探是必要的：`<thi` 是 `<think>` 的前缀，但 `thi` 不是——只看
/// 少一个字符的尾巴会漏。取最长（起点最小）是为了回退最少。
fn trailing_tag_prefix_start(input: &str, tags: &[&str]) -> Option<usize> {
    let mut best: Option<usize> = None;
    for tag in tags {
        // 完整标签由 `earliest_tag` 处理，这里只看真前缀。
        let max_len = tag.len().saturating_sub(1).min(input.len());
        for len in 1..=max_len {
            // 标签全是 ASCII：`ends_with` 命中即说明切在字符边界上。
            if input.ends_with(&tag[..len]) {
                let start = input.len() - len;
                best = Some(best.map_or(start, |b: usize| b.min(start)));
            }
        }
    }
    best
}

/// 流式过滤：返回本片**可上屏**的正文（思维内容与「待定的标签前缀」都不返回），
/// 并把跨片状态写回 `state`。调用方为每条流建一个 [`ThinkingFilterState`]，
/// 流结束后用 [`ThinkingFilterState::take_pending`] 补发尾巴。
pub(crate) fn filter_thinking_tags(input: &str, state: &mut ThinkingFilterState) -> String {
    // 上一片留下的疑似前缀与这一片接起来判——分片切在标签字面量中间时，
    // 单独看任何一片都找不到完整标签。
    let combined = if state.pending.is_empty() {
        std::borrow::Cow::Borrowed(input)
    } else {
        let mut s = std::mem::take(&mut state.pending);
        s.push_str(input);
        std::borrow::Cow::Owned(s)
    };
    let (visible, in_thinking, pending) = filter_inner(&combined, state.in_thinking);
    state.in_thinking = in_thinking;
    state.pending = pending;
    visible
}

/// 过滤内核（一次判定）：返回（可上屏正文、是否仍在思维块内、待定尾巴）。
fn filter_inner(input: &str, in_thinking: bool) -> (String, bool, String) {
    if in_thinking {
        // 思维块内：只找闭标签；找不到就丢弃整片。闭标签被切碎时同样要暂存
        // 尾巴——否则下一片的残留（`king>`）再也凑不成闭标签，思维块永远退不
        // 出来，其后的正文会被一直吞掉。
        match earliest_tag(input, THINKING_END_TAGS) {
            Some((_pos, end_of_tag)) => filter_inner(&input[end_of_tag..], false),
            None => match trailing_tag_prefix_start(input, THINKING_END_TAGS) {
                Some(start) => (String::new(), true, input[start..].to_string()),
                None => (String::new(), true, String::new()),
            },
        }
    } else {
        match earliest_tag(input, THINKING_START_TAGS) {
            Some((start_pos, end_of_tag)) => {
                let before = &input[..start_pos];
                // 同一片里闭标签也出现 → 跳过思维段，继续判闭标签之后的正文
                match earliest_tag(&input[end_of_tag..], THINKING_END_TAGS) {
                    Some((_pos, end_of_end_tag)) => {
                        let (rest_visible, still, pending) =
                            filter_inner(&input[end_of_tag + end_of_end_tag..], false);
                        let mut visible = String::from(before);
                        visible.push_str(&rest_visible);
                        (visible, still, pending)
                    }
                    // 闭标签不在这一片：开标签之后的都是思维内容；但结尾可能是
                    // 闭标签的半截（`</thin`），必须留给下一片——丢了它下一片的
                    // 残留（`king>`）永远凑不成闭标签，思维块退不出来，后面的正文
                    // 会被一直吞掉。
                    None => {
                        let rest = &input[end_of_tag..];
                        match trailing_tag_prefix_start(rest, THINKING_END_TAGS) {
                            Some(start) => (before.to_string(), true, rest[start..].to_string()),
                            None => (before.to_string(), true, String::new()),
                        }
                    }
                }
            }
            None => match trailing_tag_prefix_start(input, THINKING_START_TAGS) {
                Some(start) => (
                    input[..start].to_string(),
                    false,
                    input[start..].to_string(),
                ),
                None => (input.to_string(), false, String::new()),
            },
        }
    }
}

/// Strip thinking tags from complete text (defense-in-depth).
pub(crate) fn strip_thinking_tags(content: &str) -> String {
    let mut result = String::new();
    let mut remaining = content;

    loop {
        // Find the earliest start tag
        let mut earliest_start: Option<(usize, usize)> = None;
        for tag in THINKING_START_TAGS {
            if let Some(pos) = remaining.find(tag) {
                if earliest_start.map_or(true, |(_, epos)| pos < epos) {
                    earliest_start = Some((pos, pos + tag.len()));
                }
            }
        }

        match earliest_start {
            Some((start_pos, end_of_tag)) => {
                // Append everything before the start tag
                result.push_str(&remaining[..start_pos]);
                // Find the corresponding end tag after the start position
                let after_start = &remaining[end_of_tag..];
                let mut earliest_end = None;
                for tag in THINKING_END_TAGS {
                    if let Some(pos) = after_start.find(tag) {
                        if earliest_end.map_or(true, |(_, epos)| pos < epos) {
                            earliest_end = Some((pos, pos + tag.len()));
                        }
                    }
                }
                match earliest_end {
                    Some((_end_pos, end_of_end_tag)) => {
                        // Skip content between start and end tags, continue AFTER the end tag
                        remaining = &after_start[end_of_end_tag..];
                    }
                    None => {
                        // No end tag found — discard the rest
                        return result;
                    }
                }
            }
            None => {
                // No more start tags, append remaining content
                result.push_str(remaining);
                return result;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ──────────── filter_thinking_tags (streaming) ────────────

    /// 单片一次过（等价于「一条流只有一个 chunk」）。
    fn filter_once(input: &str) -> (String, bool) {
        let mut state = ThinkingFilterState::default();
        let out = filter_thinking_tags(input, &mut state);
        (out, state.in_thinking)
    }

    #[test]
    fn filter_no_tags_returns_input() {
        let (out, still) = filter_once("hello world");
        assert_eq!(out, "hello world");
        assert!(!still);
    }

    #[test]
    fn filter_start_tag_enters_thinking() {
        let (out, still) = filter_once("text <thinking> secret");
        assert_eq!(out, "text ");
        assert!(still);
    }

    #[test]
    fn filter_end_tag_exits_thinking() {
        let mut state = ThinkingFilterState::default();
        assert_eq!(filter_thinking_tags("<thinking> secret", &mut state), "");
        assert!(state.in_thinking);
        let out = filter_thinking_tags(" more secret </thinking> visible", &mut state);
        assert_eq!(out, " visible");
        assert!(!state.in_thinking);
    }

    #[test]
    fn filter_start_and_end_in_same_chunk() {
        let (out, still) = filter_once("<thinking>secret</thinking> visible");
        assert_eq!(out, " visible");
        assert!(!still);
    }

    #[test]
    fn filter_multiple_tags_in_chunk() {
        let (out, still) = filter_once("a <thinking>x</thinking> b <thinking>");
        assert_eq!(out, "a  b ");
        assert!(still);
    }

    #[test]
    fn filter_thought_tag_variant() {
        let (out, still) = filter_once("pre <Thought> inner </Thought> post");
        assert_eq!(out, "pre  post");
        assert!(!still);
    }

    #[test]
    fn filter_think_tag_variant() {
        let (out, still) = filter_once("<think> inner </think>");
        assert_eq!(out, "");
        assert!(!still);
    }

    #[test]
    fn filter_cross_chunk_start_to_end() {
        let mut state = ThinkingFilterState::default();
        let out1 = filter_thinking_tags("before <thinking> mid", &mut state);
        assert_eq!(out1, "before ");
        assert!(state.in_thinking);

        let out2 = filter_thinking_tags("dle </thinking> after", &mut state);
        assert_eq!(out2, " after");
        assert!(!state.in_thinking);
    }

    /// 开标签**字面量**被切碎（`<thin` + `king>`）：这是真实泄漏路径——
    /// 旧实现里第一片原样上屏、第二片因为找不到完整开标签而把整段思维正文
    /// 当正文上屏。
    #[test]
    fn split_start_tag_does_not_leak_thinking_text() {
        let mut state = ThinkingFilterState::default();
        let out1 = filter_thinking_tags("<thin", &mut state);
        assert_eq!(out1, "", "半截标签不能上屏");
        let out2 = filter_thinking_tags("king>思维原文不外泄</thinking>可见文本", &mut state);
        assert_eq!(
            out2, "可见文本",
            "思维正文不得泄漏，闭标签之后的可见文本必须照常上屏"
        );
        assert!(!state.in_thinking);
        assert_eq!(state.pending, "", "两片合上后不该再有待定尾巴");
        assert_eq!(state.take_pending(), "");
    }

    /// 闭标签被切碎：不能因此永远留在思维块里（那样后面的正文会被吞掉）。
    #[test]
    fn split_end_tag_still_exits_thinking() {
        let mut state = ThinkingFilterState::default();
        assert_eq!(filter_thinking_tags("<thinking>思维</thin", &mut state), "");
        assert!(state.in_thinking);
        let out = filter_thinking_tags("king>可见", &mut state);
        assert_eq!(out, "可见");
        assert!(!state.in_thinking);
    }

    /// 暴力检查：把整段文本在每个字符边界切开，逐片过滤 + 收尾补发，
    /// 结果必须**逐字等于**去掉思维段后的可见文本——既不泄漏也不吞字。
    #[test]
    fn every_split_boundary_yields_exactly_the_visible_text() {
        let full = "前 <thinking>机密</thinking>后";
        for split in 1..full.len() {
            if !full.is_char_boundary(split) {
                continue;
            }
            let mut state = ThinkingFilterState::default();
            let mut out = filter_thinking_tags(&full[..split], &mut state);
            out.push_str(&filter_thinking_tags(&full[split..], &mut state));
            out.push_str(&state.take_pending());
            assert_eq!(out, "前 后", "切在第 {split} 字节时输出不对");
            assert!(!state.in_thinking, "切在第 {split} 字节时没收尾");
        }

        // 逐字符喂入（最碎的分片）同样成立
        let mut state = ThinkingFilterState::default();
        let mut out = String::new();
        for ch in full.chars() {
            out.push_str(&filter_thinking_tags(&ch.to_string(), &mut state));
        }
        out.push_str(&state.take_pending());
        assert_eq!(out, "前 后");
    }

    /// 流结束时仍待定的尾巴要能补发（模型输出恰好在 `<` 处断了），
    /// 而思维块内的半截闭标签属于隐藏区域，补发为空。
    #[test]
    fn take_pending_flushes_outside_thinking_only() {
        let mut state = ThinkingFilterState::default();
        assert_eq!(filter_thinking_tags("5 <", &mut state), "5 ");
        assert_eq!(state.take_pending(), "<");
        assert_eq!(state.take_pending(), "", "取走即清空");

        let mut state = ThinkingFilterState::default();
        assert_eq!(filter_thinking_tags("<thinking>原文</thin", &mut state), "");
        assert!(state.in_thinking);
        assert_eq!(state.take_pending(), "", "思维块内的半截闭标签不上屏");
    }

    #[test]
    fn filter_empty_input() {
        let (out, still) = filter_once("");
        assert_eq!(out, "");
        assert!(!still);

        let mut state = ThinkingFilterState::default();
        assert_eq!(filter_thinking_tags("<thinking>", &mut state), "");
        assert_eq!(filter_thinking_tags("", &mut state), "");
        assert!(state.in_thinking);
    }

    #[test]
    fn filter_still_in_thinking_discards_all() {
        let mut state = ThinkingFilterState::default();
        assert_eq!(filter_thinking_tags("<thinking>", &mut state), "");
        assert_eq!(filter_thinking_tags("more secret stuff", &mut state), "");
        assert!(state.in_thinking);
    }

    // ──────────── strip_thinking_tags (complete text) ────────────

    #[test]
    fn strip_no_tags_returns_original() {
        assert_eq!(strip_thinking_tags("hello world"), "hello world");
    }

    #[test]
    fn strip_single_tag_pair() {
        assert_eq!(strip_thinking_tags("a <thinking>b</thinking> c"), "a  c");
    }

    #[test]
    fn strip_multiple_tag_pairs() {
        assert_eq!(
            strip_thinking_tags("<thinking>a</thinking> x <thinking>b</thinking>"),
            " x "
        );
    }

    #[test]
    fn strip_unclosed_tag_discards_rest() {
        assert_eq!(strip_thinking_tags("visible <thinking> secret"), "visible ");
    }

    #[test]
    fn strip_thought_variant() {
        assert_eq!(strip_thinking_tags("<Thought>inner</Thought>"), "");
    }

    #[test]
    fn strip_empty_input() {
        assert_eq!(strip_thinking_tags(""), "");
    }
}
