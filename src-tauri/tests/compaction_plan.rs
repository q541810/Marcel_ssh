//! 压缩方案（id 指针定位 + 重启重建）的 Rust 侧算法证明。
//!
//! 自包含、零依赖（仅 std），不链接 crate 内部实现：把方案要求的数学与
//! 不变量独立建模验证（实施时以此为 spec）。忠实镜像：
//! - `pairing.rs::cut_balance`（open-call 计数；tool 结果无匹配调用 → corrupt）
//! - `region.rs::select_compactable_range`（head-anchored + retain 尾部 + 回退平衡切点）
//! - `context/mod.rs::shrink_to_known_tail`（收缩区间末条到"最近有 db_id 的
//!   平衡切点"，保证 `tail_db_id` 指针有值——取代位置数数与指纹验证）
//!
//! 证明目标：
//! 1. 区间永远从第一条非 system 消息开始（head-anchored 前缀）。
//! 2. 区间两端切点平衡 → 区间内工具配对闭合（不拆散任何 call/result 对）。
//! 3. `shrink_to_known_tail` 收缩后：末条必有 id 锚点、两端仍平衡、区间配对闭合；
//!    整区间无锚点时返回 None（跳过压缩）。

/// 简化消息：System（提示词/plan 注入）、User、Asst(n)（携带 n 个 tool_calls）、
/// Tool、UserUnanchored（无 db_id——运行中未回填的极端窗口）、
/// UserBackend（有 db_id 但前端 store 未知——save 回填的运行中消息）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Item {
    System,
    User,
    Asst(usize),
    Tool,
    UserUnanchored,
    UserBackend,
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

/// 消息是否缺少 db_id 锚点（`UserUnanchored` = 无 id 的极端窗口）。
fn is_unanchored(it: Item) -> bool {
    matches!(it, Item::UserUnanchored)
}

/// 消息是否对前端 store 可见（pressure known_only 的锚点条件）：
/// `User`（历史 load）可见；`UserBackend`（save 回填）前端不知 id，不可见。
fn is_frontend_known(it: Item) -> bool {
    !matches!(it, Item::UserUnanchored | Item::UserBackend)
}

/// `context/mod.rs::shrink_to_known_tail` 的忠实模型：从 end 向前找最近一条
/// "切点平衡（cuts[e+1]）且有 id 锚点"的消息作为新区间末条；找不到返回 None。
/// `known_only`：pressure 传 true（末条必须前端可见），overflow 传 false
/// （只要 DB 有行——`UserBackend` 可作锚点，超长任务恢复）。
fn shrink_to_known_tail(
    items: &[Item],
    cuts: &[bool],
    start: usize,
    end: usize,
    known_only: bool,
) -> Option<(usize, usize)> {
    let mut e = end;
    loop {
        let anchored = !is_unanchored(items[e]) && (!known_only || is_frontend_known(items[e]));
        if cuts[e + 1] && anchored {
            return Some((start, e));
        }
        if e == start {
            return None;
        }
        e -= 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        for retain in 0..items.len() {
            if let Some((s, e)) = select_compactable_range(&items, &weights, retain) {
                assert_eq!(s, 1, "起点恒为第一条非 system");
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

    #[test]
    fn manual_extension_to_last_message_stays_balanced() {
        // 手动压缩 = 全力压缩：区间延伸到最后一条（含）。平衡性由两端切点保证：
        // cuts[0] 恒 true（空首切）；cuts[len]（尾部切点）恒 true（合法流所有
        // 调用已闭合，否则 cut_balance 直接 Err）。
        let items = [
            Item::User,
            Item::Asst(2),
            Item::Tool,
            Item::Tool,
            Item::User,
            Item::Asst(1),
            Item::Tool,
        ];
        let cuts = cut_balance(&items).unwrap();
        assert!(cuts[0], "首切恒平衡");
        assert!(cuts[items.len()], "尾切恒平衡（合法流）→ 延伸 [start, len-1] 合法");
        // 延伸区间 = [0, len-1] 覆盖全部消息，配对闭合
        assert!(range_pairing_closed(&items, &cuts, 0, items.len() - 1));
    }

    // ── shrink_to_known_tail：tail_db_id 指针恒有值 ──

    #[test]
    fn shrink_keeps_end_when_anchored() {
        let items = [Item::User, Item::User, Item::User];
        let cuts = cut_balance(&items).unwrap();
        assert_eq!(shrink_to_known_tail(&items, &cuts, 0, 2, true), Some((0, 2)));
        assert_eq!(shrink_to_known_tail(&items, &cuts, 0, 2, false), Some((0, 2)));
    }

    #[test]
    fn shrink_rolls_back_to_nearest_anchor() {
        // 末两条无 id → 收缩到第一条有 id 的平衡末条
        let items = [
            Item::User,          // 0 有 id
            Item::UserUnanchored, // 1 无 id
            Item::UserUnanchored, // 2 无 id
        ];
        let cuts = cut_balance(&items).unwrap();
        assert_eq!(shrink_to_known_tail(&items, &cuts, 0, 2, true), Some((0, 0)));
        assert_eq!(shrink_to_known_tail(&items, &cuts, 0, 2, false), Some((0, 0)));
    }

    #[test]
    fn shrink_known_only_rejects_backend_filled_ids() {
        // 历史（User）→ 前端可见；save 回填（UserBackend）→ 前端不知 id
        let items = [
            Item::User,        // 0 前端已知
            Item::UserBackend, // 1 运行中 save 回填
            Item::UserBackend, // 2 运行中 save 回填
        ];
        let cuts = cut_balance(&items).unwrap();
        // pressure（known_only）：收缩到前端已知的 m0 → 前端必能找到，live 不降级
        assert_eq!(shrink_to_known_tail(&items, &cuts, 0, 2, true), Some((0, 0)));
        // overflow：只要求 DB 有行 → 末条 m2 可作锚点（超长任务恢复）
        assert_eq!(shrink_to_known_tail(&items, &cuts, 0, 2, false), Some((0, 2)));
    }

    #[test]
    fn shrink_none_when_span_fully_unanchored() {
        let items = [Item::UserUnanchored, Item::UserUnanchored];
        let cuts = cut_balance(&items).unwrap();
        assert_eq!(shrink_to_known_tail(&items, &cuts, 0, 1, true), None);
        assert_eq!(shrink_to_known_tail(&items, &cuts, 0, 1, false), None);
    }

    #[test]
    fn shrink_never_splits_a_tool_pair() {
        // user, assistant(call), tool(result), user(无 id)
        // 收缩必须停在配对完整处：不能停在 assistant 之后（cuts[2] 不平衡）
        let items = [
            Item::User,      // 0 有 id
            Item::Asst(1),   // 1 call c1
            Item::Tool,      // 2 result c1
            Item::UserUnanchored, // 3 无 id
        ];
        let cuts = cut_balance(&items).unwrap();
        assert!(!cuts[2], "assistant(tool_calls) 之后切点不平衡");
        // 从 end=3 收缩：3 无 id → 2 处 cuts[3] 平衡且 Tool 有 id（非 unanchored）→ 停
        assert_eq!(shrink_to_known_tail(&items, &cuts, 0, 3, true), Some((0, 2)));
    }

    #[test]
    fn shrink_result_stays_pairing_closed_and_balanced() {
        // 任意区间收缩后：两端平衡、配对闭合（与 select 相同的不变量）
        let items = [
            Item::User,          // 0
            Item::Asst(1),       // 1
            Item::Tool,          // 2
            Item::User,          // 3
            Item::Asst(2),       // 4
            Item::Tool,          // 5
            Item::Tool,          // 6
            Item::UserUnanchored, // 7 无 id
            Item::User,          // 8
        ];
        let cuts = cut_balance(&items).unwrap();
        let (s, e) = shrink_to_known_tail(&items, &cuts, 0, 8, true).unwrap();
        assert!(
            range_pairing_closed(&items, &cuts, s, e),
            "收缩后区间 [{s},{e}] 必须配对闭合"
        );
        assert!(cuts[s] && cuts[e + 1], "收缩后两端切点必须平衡");
        assert!(is_frontend_known(items[e]), "收缩后末条必对前端可见（known_only）");
    }
}
