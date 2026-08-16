//! 运行时上下文治理（移植 DSH compaction 完整语义）。
//!
//! 双阶段：先 model-free 工具结果修剪（`pruner`），再 LLM 摘要替换（`summarizer`）。
//! 双触发：pressure（估算 token 超窗口阈值，需配置 `context_window`）与
//! context-overflow（provider 报告上下文超限后强制一次缩减并重试）。
//!
//! 与 DSH 的关键差异（msl 架构下的等价替代）：
//! - 无事件溯源/surface：压缩直接作用于运行中 `messages: Vec<LlmMessage>`；
//!   DB 保留原始完整内容（日志留史），前端 store 由调用方按 Done 事件携带的
//!   投影区间**原位替换**（删被压消息、卡片插回原位，重启经回放重建同一视图）。
//! - 无 durable 锁：单任务单循环天然互斥；手动压缩有 busy 守卫（运行中拒绝）。
//! - 可见性：生命周期事件（开始/进度/完成/跳过）经 `on_event` 回调**实时**
//!   回报，由调用方负责发前端事件与落库；同时收集进 `CompactionRun.events`
//!   供日志。本模块自身无副作用（除 LLM 摘要调用与 messages 变更）。
//! - 原位替换安全校验：Done 事件携带被压区间角色序列 + tool 调用 id 序列，
//!   前端逐项比对 store 投影，任何不匹配都拒绝删除（降级为尾部追加），
//!   保证投影漂移（旧数据 legacy tool 等）下绝不误删。
//!
//! 正确性不变量（全部经测试保证）：
//! - 只改写旧 Tool 消息 content 或 splice 替换完整平衡区间；协议配对不破坏。
//! - 摘要失败/取消/shrink 校验不过 → messages 零改动，主循环继续。
//! - 最新用户指令（retain 尾部）永不被压。

pub mod meter;
pub mod pairing;
pub mod pruner;
pub mod region;
pub mod summarizer;

use tokio::sync::watch;

use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ToolDefinition};

use meter::estimate_total;
use summarizer::{CHECKPOINT_PREAMBLE, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG};

/// 压力触发阈值比例（对齐 DSH `DEFAULT_THRESHOLD_RATIO`）。
pub const DEFAULT_THRESHOLD_RATIO: f64 = 0.8;
/// 尾部逐字保留比例（对齐 DSH `DEFAULT_RETAIN_RATIO`）。
pub const DEFAULT_RETAIN_RATIO: f64 = 0.16;
/// pressure 触发下最多尝试的压缩轮数（对齐 DSH `compactionRetries`）。
pub const DEFAULT_COMPACTION_RETRIES: usize = 1;
/// context-overflow 恢复预算（对齐 DSH `maxOverflowRetries`）。
pub const DEFAULT_MAX_OVERFLOW_RETRIES: usize = 1;
/// 最小压缩收益门槛（msl 对 DSH 的补充防御）：
/// 被压区间必须 ≥ 此 token 数才值得压。framing（CHECKPOINT_PREAMBLE +
/// 标签）固定开销约 90+ tokens（chars/4）、摘要正文至少 ~200 tokens，
/// 压一个 100 tokens 的小区间时摘要物理上不可能比原文小，shrink 必然失败
/// （小窗口下实测踩中）。区间不足此门槛 → 未开始就跳过，不留痕。
pub const MIN_COMPACTABLE_TOKENS: usize = 512;

/// 压缩触发来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompactionTrigger {
    /// 估算 token 超窗口阈值（预防式，需要配置 context_window）。
    Pressure,
    /// provider 确认上下文超限（强制一次有用缩减，跳过阈值）。
    ContextOverflow,
    /// 用户手动触发（命令面板「压缩上下文」）：与 ContextOverflow 同一条
    /// 强制缩减管线，仅触发名不同——前端据此区分文案：手动压缩没有
    /// "压缩后重试该轮请求"的行为，不能显示"上下文超限，自动重试"。
    Manual,
}

/// 一次成功压缩的结果（供日志、前端事件与调用方统计）。
#[derive(Debug, Clone)]
pub struct CompactionOutcome {
    /// 被压掉/替换的消息条数。
    pub shadowed_messages: usize,
    /// 被压内容的估算 token 数。
    pub shadowed_tokens: usize,
    /// 被压区间在"非 system 消息投影"中的起点（前端据此定位 store 中被压消息）。
    pub shadowed_start_non_system: usize,
    /// 被压区间的角色序列（"user"/"assistant"/"tool"，done 卡对应 loop 的
    /// framed checkpoint 归一为 user）。前端据此校验 store 投影与 loop 缓冲一致。
    pub shadowed_roles: Vec<&'static str>,
    /// 被压区间内 tool 消息的 tool_call_id 序列（保序，仅 tool 消息）。
    /// 与角色序列共同构成校验指纹：任一不匹配 → 前端降级不删，绝不误删。
    pub shadowed_tool_call_ids: Vec<String>,
    /// LLM 摘要文本（不含 framing/标签，供展示与落库）。
    pub summary: String,
}

/// 压缩生命周期事件（由调用方负责发前端事件/落库）。
#[derive(Debug, Clone)]
pub enum CompactionEvent {
    /// LLM 摘要调用开始（可能耗时数十秒，前端应显示进行中状态）。
    SummarizingStart {
        trigger: &'static str,
    },
    /// 摘要实时文本（累计，随流增量推送；仅通过 `on_event` 实时回调，
    /// 不收集进 `CompactionRun.events`，避免占用内存）。
    Progress {
        text: String,
    },
    /// 压缩成功完成。
    Done {
        outcome: CompactionOutcome,
    },
    /// 压缩被跳过（失败 / 取消 / 无可压区间）。
    /// `attempted`：是否已进入摘要阶段（发过 `SummarizingStart`）。
    /// `false` = 未开始就跳过（无区间/结构异常，前端不留痕）；
    /// `true` = 摘要已跑但失败（前端应低调交代"压缩未完成"）。
    Skipped {
        reason: String,
        attempted: bool,
    },
}

/// 一次 `compact_if_needed` 的结果：压缩是否发生 + 全过程事件。
#[derive(Debug, Clone)]
pub struct CompactionRun {
    /// 压缩结果（`None` = 未压缩 / 全部跳过）。
    pub outcome: Option<CompactionOutcome>,
    /// 生命周期事件（开始/完成/跳过），按发生顺序排列。
    /// 注：`Progress` 文本流只经 `on_event` 实时回调，不收集在此列表。
    pub events: Vec<CompactionEvent>,
}

/// 判断一条 LLM 错误消息是否属于"上下文超限"（各 provider 措辞不同，启发式匹配）。
/// 只用于 provider 返回的错误文本，不触碰命令输出。
pub fn is_context_overflow_error(msg: &str) -> bool {
    let lower = msg.to_ascii_lowercase();
    [
        "maximum context length",
        "context window",
        "context length",
        "too many tokens",
        "token limit",
        "context_length_exceeded",
        "input is too long",
        "maximum_token",
        "prompt is too long",
        "context_limit",
    ]
    .iter()
    .any(|p| lower.contains(p))
}

/// pressure 触发资格：窗口已配置（>0）、估算 token 超阈值、retain 预算合法。
/// 返回 `(threshold_tokens, retain_tokens)`；任一条件不满足返回 `None`。
pub fn pressure_eligible(context_window: u64, measurement: usize) -> Option<(usize, usize)> {
    if context_window == 0 {
        return None;
    }
    let threshold = ((context_window as f64) * DEFAULT_THRESHOLD_RATIO) as usize;
    let retain_tokens = ((context_window as f64) * DEFAULT_RETAIN_RATIO) as usize;
    if retain_tokens >= threshold {
        return None;
    }
    if measurement < threshold {
        return None;
    }
    Some((threshold, retain_tokens))
}

/// 同时入列（供返回）并实时回调（供前端）。
fn record_event(
    events: &mut Vec<CompactionEvent>,
    on_event: &(dyn Fn(CompactionEvent) + Sync),
    ev: CompactionEvent,
) {
    on_event(ev.clone());
    events.push(ev);
}

/// 被压区间的估算 token 数。
fn region_shadowed_tokens(msgs: &[LlmMessage], range: &region::RangeSelection) -> usize {
    msgs[range.start..=range.end]
        .iter()
        .map(meter::estimate_message)
        .sum()
}

/// 前导 system 消息数（loop 缓冲 = [system 提示词] + history；手动命令传入的
/// history 无 system 前导）。
fn leading_system_count(msgs: &[LlmMessage]) -> usize {
    msgs.iter()
        .take_while(|m| m.role == LlmRole::System)
        .count()
}

/// 被压区间在"非 system 消息投影"里的起点：`range.start` 减去前导 system 数。
/// 前端据此在 store 的 history-relevant 投影中定位被压区间（投影不含 system 通知/
/// 运行中卡，done 卡归一化为 user 与 loop 的 framed checkpoint 一一对应）。
fn shadowed_start_non_system(msgs: &[LlmMessage], range_start: usize) -> usize {
    range_start - leading_system_count(msgs)
}

/// 被压区间校验指纹：(角色序列, tool 消息 tool_call_id 序列)。
/// 前端用同样的投影规则重建 store 侧序列并逐项比对，任何不匹配都拒绝替换
/// （旧数据 legacy tool、孤儿 tool 等投影漂移场景下绝不误删）。
fn shadowed_span_fingerprint(
    msgs: &[LlmMessage],
    range: &region::RangeSelection,
) -> (Vec<&'static str>, Vec<String>) {
    let mut roles = Vec::with_capacity(range.end - range.start + 1);
    let mut tool_ids = Vec::new();
    for m in &msgs[range.start..=range.end] {
        match m.role {
            LlmRole::User => roles.push("user"),
            LlmRole::Assistant => roles.push("assistant"),
            LlmRole::Tool => {
                roles.push("tool");
                tool_ids.push(m.tool_call_id.clone().unwrap_or_default());
            }
            LlmRole::System => roles.push("user"), // 防御：区间内不应出现 system
        }
    }
    (roles, tool_ids)
}

/// 入口：按触发来源执行一次压缩管线，返回结果 + 生命周期事件。
///
/// `on_event` 在每个事件发生时**实时**回调（调用方负责发前端事件），
/// 与返回的 `events` 列表内容一致（除 `Progress` 文本流——它只走回调，
/// 不收集进列表）。这样前端能在摘要生成期间看到进行中状态与实时进度。
///
/// - `Pressure`：`context_window == 0` 时不动作（未配置预防式压缩）；
///   估算超 `0.8 × window` 才进入；先 prune 再摘要；最多
///   `DEFAULT_COMPACTION_RETRIES + 1` 次区间压缩，每次后重测。
/// - `ContextOverflow`：跳过阈值，直接 prune + 一次区间压缩（retain 0）。
///
/// 失败（摘要失败 / shrink 校验不过 / 取消）不返回 `Err`——转成
/// `CompactionEvent::Skipped` 事件并置 `outcome = None`。**任何失败路径
/// messages 都未被修改**（唯一修改点是 splice，其前所有校验通过后才执行，
/// 之后无失败路径）。
pub async fn compact_if_needed(
    msgs: &mut Vec<LlmMessage>,
    provider: &OpenAiProvider,
    tools: &[ToolDefinition],
    context_window: u64,
    trigger: CompactionTrigger,
    cancel_rx: &mut watch::Receiver<bool>,
    on_event: &(dyn Fn(CompactionEvent) + Sync),
) -> CompactionRun {
    let prune_cfg = pruner::PruneConfig::default();
    let trigger_name: &'static str = match trigger {
        CompactionTrigger::Pressure => "pressure",
        CompactionTrigger::ContextOverflow => "context-overflow",
        CompactionTrigger::Manual => "manual",
    };
    // 完整请求压力 = tools schema header + 消息（对齐 DSH measure）。
    // system 提示已含在 messages[0]，不重复计（避免双重计数）。
    let measure = |msgs: &Vec<LlmMessage>| estimate_total(msgs, tools);
    let mut events: Vec<CompactionEvent> = Vec::new();

    match trigger {
        CompactionTrigger::ContextOverflow | CompactionTrigger::Manual => {
            pruner::prune_messages(msgs, &prune_cfg);
            let cuts = match pairing::cut_balance(msgs) {
                Ok(c) => c,
                Err(e) => {
                    record_event(
                        &mut events,
                        on_event,
                        CompactionEvent::Skipped {
                            reason: e,
                            attempted: false,
                        },
                    );
                    return CompactionRun {
                        outcome: None,
                        events,
                    };
                }
            };
            let Some(range) = region::select_compactable_range(msgs, &cuts, 0) else {
                record_event(
                    &mut events,
                    on_event,
                    CompactionEvent::Skipped {
                        reason: "没有可压缩的早期历史区间".into(),
                        attempted: false,
                    },
                );
                return CompactionRun {
                    outcome: None,
                    events,
                };
            };
            // 最小收益门槛：区间太小则 framing 开销吞掉全部收益，shrink 必败
            let shadowed = region_shadowed_tokens(msgs, &range);
            if shadowed < MIN_COMPACTABLE_TOKENS {
                record_event(
                    &mut events,
                    on_event,
                    CompactionEvent::Skipped {
                        reason: format!("被压区间过小（约 {shadowed} tokens），压缩无收益"),
                        attempted: false,
                    },
                );
                return CompactionRun {
                    outcome: None,
                    events,
                };
            }
            match compact_region(msgs, provider, &range, cancel_rx, &mut events, on_event, trigger_name)
                .await
            {
                Ok(outcome) => {
                    record_event(
                        &mut events,
                        on_event,
                        CompactionEvent::Done {
                            outcome: outcome.clone(),
                        },
                    );
                    CompactionRun {
                        outcome: Some(outcome),
                        events,
                    }
                }
                Err(reason) => {
                    record_event(
                        &mut events,
                        on_event,
                        CompactionEvent::Skipped {
                            reason,
                            attempted: true,
                        },
                    );
                    CompactionRun {
                        outcome: None,
                        events,
                    }
                }
            }
        }
        CompactionTrigger::Pressure => {
            let mut measurement = measure(msgs);
            let Some((threshold, retain_tokens)) = pressure_eligible(context_window, measurement)
            else {
                return CompactionRun {
                    outcome: None,
                    events,
                };
            };
            // 第一阶段：model-free 修剪
            pruner::prune_messages(msgs, &prune_cfg);
            measurement = measure(msgs);
            if measurement < threshold {
                return CompactionRun {
                    outcome: None,
                    events,
                };
            }

            let mut result: Option<CompactionOutcome> = None;
            for _attempt in 0..=DEFAULT_COMPACTION_RETRIES {
                let cuts = match pairing::cut_balance(msgs) {
                    Ok(c) => c,
                    Err(e) => {
                        // 已有成功压缩时不再报"跳过"（卡片保持 done，避免误导）
                        if result.is_none() {
                            record_event(
                                &mut events,
                                on_event,
                                CompactionEvent::Skipped {
                                    reason: e,
                                    attempted: false,
                                },
                            );
                        }
                        break;
                    }
                };
                let Some(range) = region::select_compactable_range(msgs, &cuts, retain_tokens)
                else {
                    if result.is_none() {
                        record_event(
                            &mut events,
                            on_event,
                            CompactionEvent::Skipped {
                                reason: "没有可压缩的早期历史区间".into(),
                                attempted: false,
                            },
                        );
                    }
                    break;
                };
                // 最小收益门槛：区间太小则 framing 开销吞掉全部收益，shrink 必败
                let shadowed = region_shadowed_tokens(msgs, &range);
                if shadowed < MIN_COMPACTABLE_TOKENS {
                    if result.is_none() {
                        record_event(
                            &mut events,
                            on_event,
                            CompactionEvent::Skipped {
                                reason: format!("被压区间过小（约 {shadowed} tokens），压缩无收益"),
                                attempted: false,
                            },
                        );
                    }
                    break;
                }
                match compact_region(
                    msgs,
                    provider,
                    &range,
                    cancel_rx,
                    &mut events,
                    on_event,
                    trigger_name,
                )
                .await
                {
                    Ok(outcome) => {
                        record_event(
                            &mut events,
                            on_event,
                            CompactionEvent::Done {
                                outcome: outcome.clone(),
                            },
                        );
                        result = Some(outcome);
                        measurement = measure(msgs);
                        if measurement < threshold {
                            break;
                        }
                    }
                    Err(reason) => {
                        match &result {
                            // 后续重试失败但此前已成功压缩：重新确认最后一次成功，
                            // 卡片回到 done 而非误显示 skipped
                            Some(outcome) => {
                                record_event(
                                    &mut events,
                                    on_event,
                                    CompactionEvent::Done {
                                        outcome: outcome.clone(),
                                    },
                                );
                            }
                            None => {
                                record_event(
                                    &mut events,
                                    on_event,
                                    CompactionEvent::Skipped {
                                        reason,
                                        attempted: true,
                                    },
                                );
                            }
                        }
                        break;
                    }
                }
            }
            // 已尽力（重试次数内）仍超阈值：返回最后一次结果，调用方继续（overflow 兜底）。
            // 对齐 DSH：重试耗尽仍超阈值时显式告警（DSH 此处 throw，由上层记录后继续）。
            if measurement >= threshold {
                log::warn!(
                    "compaction still above threshold after {} attempts ({} estimated tokens >= {})",
                    DEFAULT_COMPACTION_RETRIES + 1,
                    measurement,
                    threshold
                );
            }
            CompactionRun {
                outcome: result,
                events,
            }
        }
    }
}

/// 单个区间压缩事务。
///
/// 顺序：实时发 `SummarizingStart`（摘要调用开始，前端立刻进入进行中状态）
/// → 影子定价 → 构建摘要输入（system + 区间消息）→ LLM 摘要（可取消，
/// 文本增量经 `Progress` 实时推送）→ framing + shrink 校验 → splice 替换。
/// 任何失败在 splice 之前返回 `Err`，messages 保持不变；splice 之后无失败路径。
async fn compact_region(
    msgs: &mut Vec<LlmMessage>,
    provider: &OpenAiProvider,
    range: &region::RangeSelection,
    cancel_rx: &mut watch::Receiver<bool>,
    events: &mut Vec<CompactionEvent>,
    on_event: &(dyn Fn(CompactionEvent) + Sync),
    trigger: &'static str,
) -> Result<CompactionOutcome, String> {
    record_event(
        events,
        on_event,
        CompactionEvent::SummarizingStart { trigger },
    );

    let shadowed_tokens: usize = msgs[range.start..=range.end]
        .iter()
        .map(meter::estimate_message)
        .sum();

    // 摘要调用**不**复用会话 system 提示：msl 的会话 system 是中文人格设定
    // （"你是玛瑟尔 SSH…中文优先"），与英文压缩指令冲突，会把摘要模型带偏成
    // 以助手身份闲聊/打招呼（DSH 的 system 是英文 coding-assistant 设定才安全）。
    // 不传 system 会让 KV 前缀缓存失效，但正确性优先，压缩频率低可接受。
    let input = summarizer::SummarizationInput {
        system: None,
        region: &msgs[range.start..=range.end],
    };

    // 摘要文本增量 → Progress 事件实时转发（前端实时显示生成中的摘要）。
    // 进度回调借用 on_event 引用，生命周期限定在本次压缩事务内。
    let progress = |text: &str| {
        on_event(CompactionEvent::Progress {
            text: text.to_string(),
        });
    };

    let summary_text = tokio::select! {
        r = summarizer::summarize_with_llm(provider, &input, Some(&progress)) => r.map_err(|e| e)?,
        _ = cancel_rx.changed() => {
            log::info!("compaction cancelled by user; messages unchanged");
            return Err("已取消".into());
        }
    };

    // framing + shrink 校验：摘要（含 framing）必须比被压内容小，否则拒绝
    let framed = format!(
        "{CHECKPOINT_PREAMBLE}\n\n{SUMMARY_OPEN_TAG}\n{summary_text}\n{SUMMARY_CLOSE_TAG}"
    );
    let framed_msg = LlmMessage::user(framed);
    let framed_tokens = meter::estimate_message(&framed_msg);
    if framed_tokens >= shadowed_tokens {
        return Err(format!(
            "生成的摘要未比原文更短（约 {framed_tokens} ≥ {shadowed_tokens} tokens），已放弃本次压缩"
        ));
    }

    let shadowed_messages = range.end - range.start + 1;
    let shadowed_start_non_system = shadowed_start_non_system(msgs, range.start);
    let (shadowed_roles, shadowed_tool_call_ids) = shadowed_span_fingerprint(msgs, range);
    msgs.splice(range.start..=range.end, [framed_msg]);

    Ok(CompactionOutcome {
        shadowed_messages,
        shadowed_tokens,
        shadowed_start_non_system,
        shadowed_roles,
        shadowed_tool_call_ids,
        summary: summary_text,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_error_classifier_matches_common_wording() {
        for text in [
            "This model's maximum context length is 8192 tokens",
            "Request too large for the context window",
            "context_length_exceeded",
            "you submitted too many tokens",
            "The prompt is too long",
        ] {
            assert!(is_context_overflow_error(text), "should match: {text}");
        }
    }

    #[test]
    fn overflow_error_classifier_ignores_unrelated_errors() {
        for text in [
            "Rate limit exceeded, retry after 30s",
            "Invalid API key",
            "Connection reset by peer",
            "max_tokens must be a positive integer",
        ] {
            assert!(!is_context_overflow_error(text), "should not match: {text}");
        }
    }

    #[test]
    fn pressure_eligible_requires_configured_window() {
        assert_eq!(pressure_eligible(0, 100_000), None);
    }

    #[test]
    fn pressure_eligible_requires_measurement_above_threshold() {
        // window=100_000 → threshold=80_000, retain=16_000
        assert_eq!(pressure_eligible(100_000, 80_000 - 1), None);
        assert_eq!(pressure_eligible(100_000, 80_000), Some((80_000, 16_000)));
    }

    #[test]
    fn pressure_eligible_scales_with_window() {
        // window=200_000 → threshold=160_000, retain=32_000
        let (threshold, retain) = pressure_eligible(200_000, 160_000).unwrap();
        assert_eq!((threshold, retain), (160_000, 32_000));
    }

    #[test]
    fn pressure_eligible_rejects_tiny_windows() {
        // window=1 → threshold=0（floor），retain=0；retain >= threshold 恒成立 → None
        assert_eq!(pressure_eligible(1, usize::MAX), None);
    }

    #[test]
    fn shadowed_start_offsets_leading_system_prompt() {
        // loop 缓冲：前导 system 提示词 → 投影起点 = range.start - 1
        let msgs = vec![
            LlmMessage::system("you are an agent"),
            LlmMessage::user("u1"),
            LlmMessage::user("u2"),
            LlmMessage::user("u3"),
        ];
        assert_eq!(shadowed_start_non_system(&msgs, 1), 0);
        assert_eq!(shadowed_start_non_system(&msgs, 2), 1);
    }

    #[test]
    fn shadowed_start_without_system_manual_history() {
        // 手动压缩命令传入的 history 无 system 前导 → 投影起点 = range.start
        let msgs = vec![LlmMessage::user("u1"), LlmMessage::user("u2")];
        assert_eq!(shadowed_start_non_system(&msgs, 0), 0);
        assert_eq!(shadowed_start_non_system(&msgs, 1), 1);
    }

    #[test]
    fn shadowed_start_system_only_never_used() {
        // 防御：纯 system 输入下 range_start 恒 >= 前导 system 数（不 panic）
        let msgs = vec![LlmMessage::system("s1"), LlmMessage::system("s2")];
        assert_eq!(shadowed_start_non_system(&msgs, 2), 0);
    }
}
