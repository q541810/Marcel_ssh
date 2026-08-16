//! 压缩方案（原位替换 + 重启回放）的 Rust 侧算法证明。
//!
//! 自包含、零依赖（仅 std），不链接 crate 内部实现：把方案要求的数学与
//! 不变量独立建模验证（实施时以此为 spec）。忠实镜像：
//! - `pairing.rs::cut_balance`（open-call 计数；tool 结果无匹配调用 → corrupt）
//! - `region.rs::select_compactable_range`（head-anchored + retain 尾部 + 回退平衡切点）
//!
//! 证明目标：
//! 1. `shadowed_start_non_system = range.start - 前导 system 数`（loop 前导=1，
//!    手动 history 前导=0）——前端据此定位 store 中被压区间。
//! 2. 区间永远从第一条非 system 消息开始 → 投影起点恒为 0 → 卡片永远插在
//!    原位（头部），与 store 投影对齐。
//! 3. 区间两端切点平衡 → 区间内工具配对闭合（不拆散任何 call/result 对）。

/// 简化消息：System（提示词/plan 注入）、User、Asst(n)（携带 n 个 tool_calls）、Tool。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Item {
    System,
    User,
    Asst(usize),
    Tool,
}

/// `pairing.rs::cut_balance` 的忠实模型：
/// `cuts.len() == items.len() + 1`，`cuts[i]` = 第 i 条消息**之前**的切点；
/// `cuts[0]` 恒 true；tool 结果无进行中调用 → `Err`（corrupt）。
fn cut_balance(items: &[Item]) -> Result<Vec<bool>, String> {
    let mut in_progress = 0usize;
    let mut cuts = Vec::with_capacity(items.len() + 1);
    cuts.push(true);
    for it in items {
        match it {
            Item::Asst(n) => in_progress += n,
            Item::Tool => {
                if in_progress == 0 {
                    return Err("tool/result has no matching tool-call".into());
                }
                in_progress -= 1;
            }
            _ => {}
        }
        cuts.push(in_progress == 0);
    }
    Ok(cuts)
}

/// 前导 system 消息数（loop 缓冲 = [system 提示词] + history；手动命令 history 无 system）。
fn leading_system_count(items: &[Item]) -> usize {
    items.iter().take_while(|it| **it == Item::System).count()
}

/// 方案要求：Done 事件携带的 shadowedStartNonSystem = range.start - 前导 system 数。
fn shadowed_start_non_system(items: &[Item], range_start: usize) -> usize {
    range_start - leading_system_count(items)
}

/// `region.rs::select_compactable_range` 的忠实模型：
/// 起点 = 第一条非 System；从尾部累计 token 到 retain 预算得到首个保留索引；
/// 向前回退到平衡切点；区间 = [start, keep_from-1]。返回 `(start, end)`（含端点）。
fn select_compactable_range(
    items: &[Item],
    weights: &[usize],
    retain_tokens: usize,
) -> Option<(usize, usize)> {
    let cuts = cut_balance(items).ok()?;
    if !cuts.last().copied().unwrap_or(true) {
        return None; // 尾部不平衡（悬挂调用）→ 拒绝整个消息流
    }
    let start = items
        .iter()
        .position(|it| *it != Item::System)
        .unwrap_or(items.len());
    if start >= items.len() {
        return None;
    }
    let mut accumulated = 0usize;
    let mut keep_from = items.len();
    for i in (start..items.len()).rev() {
        accumulated += weights[i];
        keep_from = i;
        if accumulated >= retain_tokens {
            break;
        }
    }
    if keep_from <= start {
        return None;
    }
    while keep_from > start && !cuts[keep_from] {
        keep_from -= 1;
    }
    if keep_from <= start {
        return None;
    }
    Some((start, keep_from - 1))
}

/// 区间内工具配对是否闭合：区间内所有 open-call 都在区间内闭合，
/// 且区间边界（两端）切点平衡。
fn range_pairing_closed(items: &[Item], cuts: &[bool], start: usize, end: usize) -> bool {
    if !cuts[start] || !cuts[end + 1] {
        return false; // 两端切点必须平衡
    }
    let mut in_progress = 0usize;
    for it in &items[start..=end] {
        match it {
            Item::Asst(n) => in_progress += n,
            Item::Tool => {
                if in_progress == 0 {
                    return false; // 区间内的 tool 结果引用了区间外的调用
                }
                in_progress -= 1;
            }
            _ => {}
        }
    }
    in_progress == 0 // 区间内所有调用都在区间内闭合
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn offset_with_leading_system_prompt() {
        let items = [Item::System, Item::User, Item::Asst(1), Item::Tool, Item::User];
        assert_eq!(shadowed_start_non_system(&items, 1), 0);
        assert_eq!(shadowed_start_non_system(&items, 3), 2);
    }

    #[test]
    fn offset_without_system_prompt_manual_history() {
        let items = [Item::User, Item::Asst(1), Item::Tool];
        assert_eq!(shadowed_start_non_system(&items, 0), 0);
    }

    #[test]
    fn span_always_starts_at_first_non_system_and_is_a_prefix() {
        // 带前导 system 的典型 loop 缓冲
        let items = [
            Item::System,
            Item::User,
            Item::Asst(1),
            Item::Tool,
            Item::User,
            Item::Asst(0),
            Item::User,
        ];
        let weights = vec![1usize; items.len()];
        let cuts = cut_balance(&items).unwrap();
        let non_system = items.iter().filter(|it| **it != Item::System).count();
        for retain in 0..items.len() {
            if let Some((s, e)) = select_compactable_range(&items, &weights, retain) {
                assert_eq!(s, 1, "起点恒为第一条非 system");
                assert_eq!(
                    shadowed_start_non_system(&items, s),
                    0,
                    "投影起点恒为 0 → 卡片永远插在 store 原位（头部）"
                );
                assert!(e - s + 1 <= non_system, "区间不超出非 system 序列");
                assert!(e < items.len() - 1, "尾部至少保留最后一条消息（最新指令守卫）");
                let tail_tokens: usize = weights[e + 1..].iter().sum();
                if retain > 0 {
                    assert!(tail_tokens >= retain, "尾部保留预算不被突破（回退只会增大尾部）");
                }
                assert!(range_pairing_closed(&items, &cuts, s, e), "区间配对闭合");
            }
        }
    }

    #[test]
    fn retain_tail_preserves_latest_instructions() {
        // 10 条 user 消息，retain 3 条 → 压前 7 条，尾部 3 条不动
        let items: Vec<Item> = (0..10).map(|_| Item::User).collect();
        let weights = vec![10usize; items.len()];
        let (s, e) = select_compactable_range(&items, &weights, 30).unwrap();
        assert_eq!(s, 0);
        assert_eq!(e, 6);
        assert_eq!(items.len() - 1 - e, 3, "尾部 3 条保留");
    }

    #[test]
    fn retain_zero_still_keeps_the_last_message() {
        let items = [Item::User, Item::User, Item::User];
        let weights = vec![1usize; 3];
        let (s, e) = select_compactable_range(&items, &weights, 0).unwrap();
        assert_eq!((s, e), (0, 1), "retain=0 也保留最后一条（最新指令守卫）");
    }

    #[test]
    fn selected_range_never_splits_a_tool_pair() {
        let items = [
            Item::User,      // 0
            Item::Asst(1),   // 1 call c1
            Item::Tool,      // 2 result c1
            Item::User,      // 3
            Item::Asst(2),   // 4 calls c2,c3
            Item::Tool,      // 5 result c2
            Item::Tool,      // 6 result c3
            Item::User,      // 7
        ];
        let weights = vec![1usize; items.len()];
        let cuts = cut_balance(&items).unwrap();
        for retain in 0..8 {
            if let Some((s, e)) = select_compactable_range(&items, &weights, retain) {
                assert!(
                    range_pairing_closed(&items, &cuts, s, e),
                    "区间 [{s},{e}] 必须配对闭合（retain={retain}）"
                );
                assert!(cuts[s] && cuts[e + 1], "两端切点必须平衡");
            }
        }
    }

    #[test]
    fn corrupt_stream_never_selects() {
        // tool 结果无匹配调用 → corrupt → 拒绝压缩
        let items = [Item::Tool, Item::User];
        let weights = vec![1usize; 2];
        assert!(select_compactable_range(&items, &weights, 0).is_none());
    }

    #[test]
    fn system_only_stream_never_selects() {
        let items = [Item::System, Item::System];
        let weights = vec![1usize; 2];
        assert!(select_compactable_range(&items, &weights, 0).is_none());
    }
}
