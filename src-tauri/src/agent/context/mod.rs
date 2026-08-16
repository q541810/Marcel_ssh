//! 运行时上下文治理（移植 DSH compaction 完整语义）。
//!
//! 双阶段：先 model-free 工具结果修剪（`pruner`），再 LLM 摘要替换（`summarizer`）。
//! 双触发：pressure（估算 token 超窗口阈值，需配置 `context_window`）与
//! context-overflow（provider 报告上下文超限后强制一次缩减并重试）。
//!
//! 与 DSH 的关键差异（msl 架构下的等价替代）：
//! - 无事件溯源/surface：压缩直接作用于运行中 `messages: Vec<LlmMessage>`；
//!   DB 保留原始完整内容（日志留史），前端 store 由调用方按 Done 事件携带的
//!   **`tail_db_id` 指针**定位插卡（被压区间末条的 DB row id，统一 id 域，
//!   取代一切位置数数与指纹验证）；重启经 load_messages 按卡片行序重建同一视图。
//! - 无 durable 锁：单任务单循环天然互斥；手动压缩有 busy 守卫（运行中拒绝）。
//! - 可见性：生命周期事件（开始/进度/完成/跳过）经 `on_event` 回调**实时**
//!   回报，由调用方负责发前端事件与落库；同时收集进 `CompactionRun.events`
//!   供日志。本模块自身无副作用（除 LLM 摘要调用与 messages 变更）。
//! - 定位：`tail_db_id` = 被压区间末条消息的 `db_id`（历史来自前端
//!   `buildLlmHistory` 携带、运行中消息由 `save_msg` 回填）。区间收缩保证
//!   末条必有 id；前端/后端按 id 精确插卡，**无指纹、无数数**。
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
use crate::llm::provider::{LlmMessage, ToolDefinition};

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
    /// 被压区间末条消息的 DB row id（统一 id 指针）：前端按 `dbId` 定位插卡、
    /// 后端按 id 查行取 created_at。区间收缩保证必有值（除非无 id 锚点而跳过）。
    pub tail_db_id: Option<String>,
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

/// 收缩区间末条到"最近一条满足锚点条件的平衡切点"。
///
/// 统一 id 指针（`tail_db_id`）要求被压区间末条消息在 DB 里有行可定位；运行中
/// 新增且尚未回填 id 的消息（极端窗口）不能作为锚点，向前收缩到最近有 id 的
/// 平衡切点（`cuts[end+1]` 为真 = 不破坏工具配对）。返回 `None` = 整区间无
/// 可定位锚点，调用方跳过本次压缩。
///
/// `known_only`：pressure（预防式）压缩传 `true`——末条必须是**前端 store
/// 也有 dbId 的消息**（`db_id_known`），前端按 id 必能找到插入点，live 降级
/// 路径实际不再触发；overflow（强制恢复）传 `false`——只要 DB 有行即可
/// （运行中消息可压，超长任务仍能恢复）。
fn shrink_to_known_tail(
    msgs: &[LlmMessage],
    cuts: &[bool],
    range: &region::RangeSelection,
    known_only: bool,
) -> Option<region::RangeSelection> {
    let mut end = range.end;
    loop {
        let anchored = msgs[end].db_id.is_some() && (!known_only || msgs[end].db_id_known);
        if cuts.get(end + 1).copied().unwrap_or(false) && anchored {
            return Some(region::RangeSelection {
                start: range.start,
                end,
            });
        }
        if end == range.start {
            return None;
        }
        end -= 1;
    }
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
            let Some(mut range) = region::select_compactable_range(msgs, &cuts, 0) else {
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
            // 手动 = 全力压缩：区间延伸到最后一条消息（含）。平衡性保证：
            // `cut_balance` 对合法消息流恒有 `cuts[len] == true`（所有调用已闭合，
            // 否则直接 Err），延伸不破坏配对。
            if trigger == CompactionTrigger::Manual {
                range.end = msgs.len() - 1;
            }
            // 手动 = 队尾语义：**不收缩**（本会话产生、尚未回填 db_id 的消息
            // 也一并压掉；`tail_db_id` 恒为 None，persist 按最后一行定位队尾）。
            // 自动（Overflow，known_only=false）收缩到有 DB 行的平衡末条：
            // 运行中消息也可压（超长任务恢复）；无锚点则跳过。
            let range = if trigger == CompactionTrigger::Manual {
                range
            } else {
                match shrink_to_known_tail(msgs, &cuts, &range, false) {
                    Some(r) => r,
                    None => {
                        record_event(
                            &mut events,
                            on_event,
                            CompactionEvent::Skipped {
                                reason: "没有可定位的压缩区间（消息缺少数据库 id）".into(),
                                attempted: false,
                            },
                        );
                        return CompactionRun {
                            outcome: None,
                            events,
                        };
                    }
                }
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
                // 收缩到"前端已知 id"的平衡末条（known_only=true）：区间末条
                // 必是前端 store 有 dbId 的消息 → 前端按 id 必能找到插入点，
                // live 降级路径实际不再触发。运行中消息留在尾部保留。
                let Some(range) = shrink_to_known_tail(msgs, &cuts, &range, true) else {
                    if result.is_none() {
                        record_event(
                            &mut events,
                            on_event,
                            CompactionEvent::Skipped {
                                reason: "没有可定位的压缩区间（消息缺少数据库 id）".into(),
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
    // 统一 id 指针：被压区间末条的 DB row id（自动路径调用方已收缩保证有值，
    // 前端按 dbId 定位插卡、后端按 id 查行取 created_at）。
    // **手动 = 队尾语义**：恒 `None`（本会话消息可能没有 db_id），后端按
    // 最后一行定位队尾、前端队尾追加——前后端位置严格一致，不依赖 id。
    let tail_db_id = if trigger == "manual" {
        None
    } else {
        msgs[range.end].db_id.clone()
    };
    msgs.splice(range.start..=range.end, [framed_msg]);

    Ok(CompactionOutcome {
        shadowed_messages,
        shadowed_tokens,
        tail_db_id,
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
    fn shrink_keeps_known_tail_id_when_end_has_one() {
        let mut m0 = LlmMessage::user("u0");
        m0.db_id = Some("row-0".into());
        m0.db_id_known = true;
        let mut m1 = LlmMessage::user("u1");
        m1.db_id = Some("row-1".into());
        m1.db_id_known = true;
        let msgs = vec![m0, m1];
        let cuts = pairing::cut_balance(&msgs).unwrap();
        let range = region::RangeSelection { start: 0, end: 1 };
        // 末条已有 id 且前端已知 → 原样返回（pressure 与 overflow 一致）
        assert_eq!(
            shrink_to_known_tail(&msgs, &cuts, &range, true),
            Some(region::RangeSelection { start: 0, end: 1 })
        );
        assert_eq!(
            shrink_to_known_tail(&msgs, &cuts, &range, false),
            Some(region::RangeSelection { start: 0, end: 1 })
        );
    }

    #[test]
    fn shrink_rolls_back_to_nearest_known_id() {
        let mut m0 = LlmMessage::user("u0");
        m0.db_id = Some("row-0".into());
        m0.db_id_known = true;
        let m1 = LlmMessage::user("u1"); // 无 id（运行中未回填）
        let m2 = LlmMessage::user("u2"); // 无 id
        let msgs = vec![m0, m1, m2];
        let cuts = pairing::cut_balance(&msgs).unwrap();
        let range = region::RangeSelection { start: 0, end: 2 };
        // 收缩到最近有 id 的平衡末条 = u0
        assert_eq!(
            shrink_to_known_tail(&msgs, &cuts, &range, true),
            Some(region::RangeSelection { start: 0, end: 0 })
        );
        assert_eq!(
            shrink_to_known_tail(&msgs, &cuts, &range, false),
            Some(region::RangeSelection { start: 0, end: 0 })
        );
    }

    #[test]
    fn shrink_known_only_rejects_backend_filled_ids() {
        // pressure（known_only）：运行中 save 回填的 db_id（known=false）
        // 不被接受为锚点 → 收缩到前端已知的消息 → 前端必能找到，live 不降级
        let mut m0 = LlmMessage::user("u0");
        m0.db_id = Some("row-0".into());
        m0.db_id_known = true; // 历史（前端 load）
        let mut m1 = LlmMessage::user("u1");
        m1.db_id = Some("row-1".into());
        m1.db_id_known = false; // 运行中 save 回填（前端不知 id）
        let mut m2 = LlmMessage::user("u2");
        m2.db_id = Some("row-2".into());
        m2.db_id_known = false;
        let msgs = vec![m0, m1, m2];
        let cuts = pairing::cut_balance(&msgs).unwrap();
        let range = region::RangeSelection { start: 0, end: 2 };
        // pressure：收缩到前端已知的 m0（运行中消息留在尾部保留）
        assert_eq!(
            shrink_to_known_tail(&msgs, &cuts, &range, true),
            Some(region::RangeSelection { start: 0, end: 0 })
        );
        // overflow：只要求 DB 有行 → 末条 m2 可作锚点（超长任务恢复）
        assert_eq!(
            shrink_to_known_tail(&msgs, &cuts, &range, false),
            Some(region::RangeSelection { start: 0, end: 2 })
        );
    }

    #[test]
    fn shrink_none_when_no_known_id_in_span() {
        let msgs = vec![LlmMessage::user("u1"), LlmMessage::user("u2")];
        let cuts = pairing::cut_balance(&msgs).unwrap();
        let range = region::RangeSelection { start: 0, end: 1 };
        assert_eq!(shrink_to_known_tail(&msgs, &cuts, &range, true), None);
        assert_eq!(shrink_to_known_tail(&msgs, &cuts, &range, false), None);
    }

    #[test]
    fn shrink_respects_balanced_cut() {
        use crate::llm::provider::{LlmRole, ToolCall};
        // user, assistant(call), tool(result), user —— 收缩不能停在配对中间
        let mut m0 = LlmMessage::user("go");
        m0.db_id = Some("row-0".into());
        m0.db_id_known = true;
        let mut asst = LlmMessage::assistant("run");
        asst.db_id = Some("row-1".into());
        asst.db_id_known = true;
        asst.tool_calls = Some(vec![ToolCall {
            id: "c1".into(),
            name: "cmd".into(),
            arguments: serde_json::json!({}),
        }]);
        let mut t = LlmMessage::assistant("");
        t.role = LlmRole::Tool;
        t.tool_call_id = Some("c1".into());
        t.content = "output".into();
        let mut m3 = LlmMessage::user("next");
        m3.db_id = Some("row-3".into());
        m3.db_id_known = true;
        let msgs = vec![m0, asst, t, m3];
        let cuts = pairing::cut_balance(&msgs).unwrap();
        // 区间 [0,3]：末条有 id → 不收缩（cuts[4] 平衡）
        let range = region::RangeSelection { start: 0, end: 3 };
        assert_eq!(
            shrink_to_known_tail(&msgs, &cuts, &range, true),
            Some(region::RangeSelection { start: 0, end: 3 })
        );
        // 若末条无 id：收缩时不得停在 tool 结果之前（cuts[3] 不平衡）→ 到 m0
        let mut msgs2 = msgs.clone();
        msgs2[3].db_id = None;
        let cuts2 = pairing::cut_balance(&msgs2).unwrap();
        let range2 = region::RangeSelection { start: 0, end: 3 };
        assert_eq!(
            shrink_to_known_tail(&msgs2, &cuts2, &range2, true),
            Some(region::RangeSelection { start: 0, end: 0 })
        );
    }
}
