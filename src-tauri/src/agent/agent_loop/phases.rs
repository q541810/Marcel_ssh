//! `run_agent_loop` 的各阶段函数（纯提取，自原 `agent_loop.rs` 的回合体搬出，
//! 除引用适配外逐字符一致）：
//! - `prepare_turn`：回合准备；
//! - `resolve_summarizer_manager`：压缩模型解析；
//! - `request_round_reply`：单轮 LLM 请求（取消检查 → plan 注入 → 工具门控 →
//!   压力压缩 → 流式请求 → 用量记账 → 错误/溢出处置）；
//! - `finish_text_reply`：无工具调用回复的处置与自然结束守卫；
//! - `persist_assistant_tool_calls`：工具轮 assistant 持久化；
//! - `report_max_rounds_exceeded`：最大轮数收尾。
//!
//! `RoundOutcome` / `TextReplyOutcome` 只是原内联 `continue` / `return` 的
//! 控制流载体，调用方（`mod.rs` 的 `run_agent_loop`）一一映射回
//! `continue 'round` / `return`。

use tauri::AppHandle;
use tokio::sync::mpsc;

use super::{
    build_job_settlement_notice, classify_text_reply, forward_compaction_event, is_task_cancelled,
    round_context_snapshot, PersistedAssistantToolCall, TextReply, EMPTY_REPLY_MAX_RETRIES,
    EMPTY_REPLY_NUDGE,
};
use crate::agent::conversation::ConversationDb;
use crate::agent::conversation_persister::{ConversationPersister, PromptOrigin, ROLE_NOTICE};
use crate::agent::plan_handler::{
    build_plan_context, emit_final_plan_normalized, is_plan_context_message, plan_finish_reminder,
};
use crate::agent::thinking_filter::{filter_thinking_tags, ThinkingFilterState};
use crate::config::settings::AgentModeSettings;
use crate::emit_event;
use crate::error::AppError;
use crate::llm::manager::LlmManager;
use crate::llm::provider::{LlmMessage, ToolCall, ToolDefinition};
use crate::llm::streaming::StreamEvent;
use crate::notification::{send_notification, NotificationKind};
use crate::AppState;

/// 回合准备：唤醒轮标记、persister 构建、`db_id_known` 回填、标题更新与
/// 回合锚点落库（原 `run_agent_loop` 开头段，原样搬出）。
pub(super) fn prepare_turn(
    conv_db: std::sync::Arc<ConversationDb>,
    conversation_id: &str,
    prompt_origin: PromptOrigin,
    user_input: Option<serde_json::Value>,
    messages: &mut Vec<LlmMessage>,
    state: &AppState,
    task_id: &str,
) -> (ConversationPersister, bool) {
    // 唤醒轮：prompt 是系统替后台作业写的结算告知，不是用户打的字。
    let is_notice_turn = !prompt_origin.is_user_input();
    let persister = ConversationPersister::new(conv_db, conversation_id.to_string())
        .with_prompt_origin(prompt_origin)
        .with_user_input(user_input);

    // history 由后端从有序快照投影：携带 dbId 的消息对前端 store 可见
    // （db_id_known=true，自动 pressure 压缩据此收缩到前端能找到的区间末条）；
    // 运行中 save 回填的消息保持 false（前端不知 id）。
    for m in &mut *messages {
        if m.db_id.is_some() {
            m.db_id_known = true;
        }
    }

    persister.update_title_from_first_user_msg(messages);
    // 回合锚点：落库 user 消息并把这一行标成 running（崩溃时它就是「没收尾」
    // 的持久证据）。行 id 记到任务上——收尾在 `manager::finalize_task` 里，
    // 那里只能从任务记录拿锚点。写失败/无 user 行 → None，本回合不记录状态。
    if let Some(anchor_id) = persister.begin_turn(messages) {
        if let Some(task) = state.agent_tasks.write().get_mut(task_id) {
            task.turn_anchor_id = Some(anchor_id);
        }
    }

    (persister, is_notice_turn)
}

/// ── 上下文压缩（摘要）模型 ──
/// 显式「上下文压缩模型」槽位存在 → 压缩调用用该模型（用户选定优先）；
/// 否则压缩**复用主模型 manager**——主模型即本会话 agent 正在用的模型
/// （会话级记忆 > 全局最近使用），自动压缩天然「跟随会话模型」。
/// （原 `run_agent_loop` 内联块，原样搬出。）
pub(super) async fn resolve_summarizer_manager(
    state: &AppState,
    conversation_id: &str,
) -> Option<std::sync::Arc<LlmManager>> {
    let reg = state.settings.read().await.llm_registry.clone();
    if reg.slots.summarizer_model_id.is_empty() {
        None
    } else {
        match reg.resolve_model(&reg.slots.summarizer_model_id) {
            Ok(r) => match LlmManager::new(r.config) {
                Ok(m) => {
                    log::info!(
                        "上下文压缩使用独立模型: {}（会话 {}）",
                        m.config().model,
                        conversation_id
                    );
                    Some(std::sync::Arc::new(m))
                }
                Err(e) => {
                    log::warn!("上下文压缩独立模型创建失败，回落主模型: {}", e);
                    None
                }
            },
            Err(e) => {
                log::warn!("上下文压缩独立模型解析失败，回落主模型: {}", e);
                None
            }
        }
    }
}

/// `request_round_reply` 的回合控制结果：原回合内 `continue` / `return None`
/// 的控制流载体（纯提取）。
pub(super) enum RoundOutcome {
    /// 拿到本轮 assistant 回复，继续处理。
    Reply(LlmMessage),
    /// 对应原回合内的 `continue`：跳过本轮余下步骤，进入下一轮。
    Continue,
    /// 对应原回合内的 `return None`：任务终止（取消 / 失败）。
    Stop,
}

/// 单轮 LLM 请求（原 `run_agent_loop` 回合体前半段，原样搬出）：
/// 取消检查 → plan 上下文注入 → 工具门控 → 压力压缩 → 上下文构成估算 →
/// 流式请求（含前端转发任务）→ 用量记账 → 响应处置（取消 / 溢出重试 / 失败）。
#[allow(clippy::too_many_arguments)]
pub(super) async fn request_round_reply(
    state: &AppState,
    app: &AppHandle,
    event_name: &str,
    task_id: &str,
    conversation_id: &str,
    messages: &mut Vec<LlmMessage>,
    base_tools: &[ToolDefinition],
    compact_manager: &LlmManager,
    persister: &ConversationPersister,
    llm_manager: &std::sync::Arc<LlmManager>,
    mut cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    overflow_retries: &mut usize,
    is_subtask: bool,
    agent_settings: &AgentModeSettings,
) -> RoundOutcome {
    if is_task_cancelled(state, task_id) {
        log::info!("Agent task {} cancelled, stopping loop", task_id);
        emit_final_plan_normalized(app, state, task_id);
        emit_event(app, event_name, StreamEvent::Cancelled);
        return RoundOutcome::Stop;
    }

    // 0. 注入 plan 上下文：用临时 system 消息（不是 user），避免模型当成用户新发言。
    //    按前缀清掉上一轮注入；同时清掉旧版本可能残留的 User 角色 plan 消息
    //    （判据来自 `plan_handler`：压缩选保留尾部用的是同一个）。
    messages.retain(|m| !is_plan_context_message(m));
    if let Some(plan_context) = build_plan_context(state, task_id) {
        messages.push(LlmMessage::system(plan_context));
    }

    // 本轮该下发的工具清单：注册表是任务启动时全量构建、整任务共用的，而
    // "这个会话有没有读不到的东西"会随压缩在任务中途翻转（见
    // `tools::STATE_GATED_TOOLS`），所以每轮按当前状态过一遍门控。
    // 判据算不出来时按"宁可早给"给全量——少给一次工具会让模型失去一个它
    // 需要的能力，比多付一份说明严重得多。
    let current_tools = || {
        crate::agent::manager::tools_for_round(
            base_tools,
            is_subtask,
            &persister.conv_db,
            conversation_id,
        )
    };
    let mut tools = current_tools();

    // 0.5 运行时上下文治理（pressure 触发，对齐 DSH compaction）：
    //     估算 token 超窗口阈值（context_window × 0.8）时，先修剪旧工具结果，
    //     再对旧轮次做 LLM 摘要替换。压缩全过程经 on_event 实时发前端事件
    //     （开始即显示进行中卡片，摘要文本增量实时推送，可感知/可监视）。
    //     成功后由前端落库压缩卡片（含被压消息 id 列表，重启回放重建视图）；
    //     本处不再落库，避免与前端重复。失败只记日志，不阻断任务。
    let on_event = |ev: crate::agent::context::CompactionEvent| {
        forward_compaction_event(app, event_name, ev);
    };
    let run = crate::agent::context::compact_if_needed(
        messages,
        compact_manager,
        &tools,
        agent_settings.context_window,
        crate::agent::context::CompactionTrigger::Pressure,
        cancel_rx,
        &on_event,
    )
    .await;
    if let Some(outcome) = &run.outcome {
        let persisted = persister.persist_compaction(outcome);
        log::info!(
            "Agent {} compacted: {} messages, ~{} tokens (persisted={})",
            task_id,
            outcome.shadowed_messages,
            outcome.shadowed_tokens,
            persisted
        );
    }

    // 这次压缩刚给本会话造出归档段：同一次请求就该带上 read_history，不拖到
    // 下一轮——模型越早知道能回读原文，越不会去重跑已经不可复现的现场。
    if run.outcome.is_some() {
        tools = current_tools();
    }

    // 这一轮请求的上下文构成估算（system / 工具 schema / 对话消息）。
    // 只用于界面展示「上下文都花在哪了」，不参与任何压缩判定；取在发请求
    // **之前**，与真正发出去的 messages/tools 同一份。
    let breakdown = crate::agent::context::meter::context_breakdown(messages, &tools);

    // 1. Call LLM (streaming) — with cancellation support
    let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
    let app_fwd = app.clone();
    let evn = event_name.to_string();
    // 本轮 provider 是否报了用量（以及报了什么）：流结束时据此决定
    // 「精确值」还是「本地估算」，见下面的 ContextUsage。
    let round_usage: std::sync::Arc<std::sync::Mutex<Option<crate::llm::provider::TokenUsage>>> =
        std::sync::Arc::new(std::sync::Mutex::new(None));
    let round_usage_fwd = round_usage.clone();
    let forwarder = tokio::spawn(async move {
        // 跨片状态必须活到整条流结束（标签字面量会被分片切开，见
        // `thinking_filter`）。`filtered` 已经是「可上屏正文」——
        // 思维内容与待定的标签前缀都不会出现在里面。
        let mut thinking_filter = ThinkingFilterState::default();
        while let Some(ev) = rx.recv().await {
            match ev {
                StreamEvent::TextDelta { ref text } => {
                    let filtered = filter_thinking_tags(text, &mut thinking_filter);
                    if !filtered.is_empty() {
                        emit_event(&app_fwd, &evn, StreamEvent::TextDelta { text: filtered });
                    }
                }
                StreamEvent::Usage { ref usage } => {
                    // `Usage` 照原样透传（插件的单轮原始数据），同时留一份给
                    // ContextUsage 用。
                    *round_usage_fwd.lock().unwrap() = Some(usage.clone());
                    emit_event(&app_fwd, &evn, ev);
                }
                other => {
                    emit_event(&app_fwd, &evn, other);
                }
            }
        }
        // 流收尾：补发仍待定的尾巴（只可能是标签字面量的半截，例如整条流
        // 以 `<` 结尾）。吞掉它就等于悄悄改了模型的可见输出。
        let tail = thinking_filter.take_pending();
        if !tail.is_empty() {
            emit_event(&app_fwd, &evn, StreamEvent::TextDelta { text: tail });
        }
    });

    let result = llm_manager
        .stream_chat(messages, &tools, &tx, Some(&mut cancel_rx))
        .await;
    drop(tx);
    let _ = forwarder.await;

    // 1.5 用量记账（放在这里 = 成功/报错/重试/取消四条路都会记上）：
    //     provider 这一轮报了用量就用精确值，没报就退回本地估算并置
    //     `estimated`（界面加 `~`，别把估算讲成精确值）。先写库再发事件，
    //     事件带的就是库里的数字——前端只覆盖不累加，重启后读到的同一个。
    {
        let round = round_usage.lock().unwrap().clone();
        let last = round_context_snapshot(round.as_ref(), breakdown);
        match persister
            .conv_db
            .record_usage(conversation_id, round.as_ref(), last)
        {
            Ok(Some(usage)) => emit_event(
                app,
                event_name,
                StreamEvent::ContextUsage {
                    prompt_tokens: usage.prompt_tokens,
                    completion_tokens: usage.completion_tokens,
                    total_tokens: usage.total_tokens,
                    reasoning_tokens: usage.reasoning_tokens,
                    cached_read_tokens: usage.cached_read_tokens,
                    context_window: agent_settings.context_window,
                    used_tokens: last.used_tokens,
                    estimated: last.estimated,
                    system_tokens: last.system_tokens,
                    tools_tokens: last.tools_tokens,
                    message_tokens: last.message_tokens,
                },
            ),
            // 会话行没了（用户把会话删了）：不新建行、也不发数字
            Ok(None) => {}
            Err(e) => log::warn!("记录 token 用量失败（会话 {}）: {}", conversation_id, e),
        }
    }

    match result {
        Ok(msg) => {
            // 一轮成功响应重置溢出恢复预算（对齐 DSH：assistant/message 重置）
            *overflow_retries = 0;
            RoundOutcome::Reply(msg)
        }
        Err(e) => {
            if let AppError::Cancelled(_) = e {
                log::info!("Agent task {} cancelled during LLM call", task_id);
                emit_final_plan_normalized(app, state, task_id);
                emit_event(app, event_name, StreamEvent::Cancelled);
                return RoundOutcome::Stop;
            }
            let err_msg = e.to_string();
            // 上下文超限恢复（对齐 DSH request-error 恢复）：压缩一次后重试该轮
            if crate::agent::context::is_context_overflow_error(&err_msg)
                && *overflow_retries < crate::agent::context::DEFAULT_MAX_OVERFLOW_RETRIES
            {
                let on_event = |ev: crate::agent::context::CompactionEvent| {
                    forward_compaction_event(app, event_name, ev);
                };
                let run = crate::agent::context::compact_if_needed(
                    messages,
                    compact_manager,
                    &tools,
                    agent_settings.context_window,
                    crate::agent::context::CompactionTrigger::ContextOverflow,
                    cancel_rx,
                    &on_event,
                )
                .await;
                if let Some(outcome) = &run.outcome {
                    let persisted = persister.persist_compaction(outcome);
                    *overflow_retries += 1;
                    log::info!(
                        "Agent {} context overflow: compacted {} messages, retrying round (persisted={})",
                        task_id,
                        outcome.shadowed_messages,
                        persisted
                    );
                    return RoundOutcome::Continue;
                }
                let reasons = run
                    .events
                    .iter()
                    .filter_map(|ev| match ev {
                        crate::agent::context::CompactionEvent::Skipped { reason, .. } => {
                            Some(reason.clone())
                        }
                        _ => None,
                    })
                    .collect::<Vec<_>>()
                    .join("; ");
                log::warn!(
                    "Agent {} context overflow recovery failed: {}",
                    task_id,
                    if reasons.is_empty() {
                        "no compactable range"
                    } else {
                        &reasons
                    }
                );
                // 压缩期间用户取消 → 走取消路径而非错误路径
                if is_task_cancelled(state, task_id) {
                    emit_final_plan_normalized(app, state, task_id);
                    emit_event(app, event_name, StreamEvent::Cancelled);
                    return RoundOutcome::Stop;
                }
            }
            emit_final_plan_normalized(app, state, task_id);
            emit_event(
                app,
                event_name,
                StreamEvent::Error {
                    message: err_msg.clone(),
                },
            );
            if !is_subtask {
                let ns = state.settings.read().await.notification_settings.clone();
                let body = format!("错误信息: {}", err_msg.lines().next().unwrap_or(&err_msg));
                send_notification(
                    app,
                    NotificationKind::AgentTaskFailed,
                    &ns,
                    "Agent 任务失败",
                    &body,
                );
            }
            RoundOutcome::Stop
        }
    }
}

/// `finish_text_reply` 的回合控制结果：原回合内 `continue` / `return None` /
/// `return Some(text)` 的控制流载体（纯提取）。
pub(super) enum TextReplyOutcome {
    /// 对应原回合内的 `continue 'round`：不自然结束，进入下一轮。
    Continue,
    /// 对应原回合内的 `return None`：任务终止（取消 / 失败）。
    Stop,
    /// 对应原回合内的 `return Some(final_text)`：自然结束。
    Done(String),
}

/// 无工具调用的回复处置与自然结束守卫（原 `run_agent_loop` 的
/// `if tool_calls.is_empty()` 分支，原样搬出）：截断丢弃 / 哑火补问 /
/// 有正文落库 → 作业结算告知注入 → 计划收尾提醒 → 取消兜底 / 完成收尾。
#[allow(clippy::too_many_arguments)]
pub(super) async fn finish_text_reply(
    state: &AppState,
    app: &AppHandle,
    event_name: &str,
    task_id: &str,
    messages: &mut Vec<LlmMessage>,
    persister: &ConversationPersister,
    empty_reply_retries: &mut usize,
    is_subtask: bool,
    is_notice_turn: bool,
    truncated: bool,
    assistant_msg: LlmMessage,
) -> TextReplyOutcome {
    let (reply, cleaned_content) = classify_text_reply(&assistant_msg.content, truncated);
    let mut cleaned_msg = LlmMessage {
        content: cleaned_content.clone(),
        ..assistant_msg
    };
    // 截断且无有效文本：不落库、不进消息链（对齐 DSH"空内容不进派生历史"），
    // 直接下一轮。save_msg 必须在此检查之后：否则空 content 会落库成一条空
    // assistant 行（save_message 无条件 INSERT），与 live store（前端收不到
    // 空文本）漂移——重启后出现空消息，压缩 count-walk 也与前端投影对不上。
    if reply == TextReply::TruncatedEmpty {
        log::warn!(
            "Agent {} truncated at token cap with empty text; skipping message and continuing",
            task_id
        );
        return TextReplyOutcome::Continue;
    }
    // 非截断的哑火（正文为空 / 纯空白 / 整段都在思维标签里）：同样不落库、
    // 不进消息链；但它也**不是自然结束**——顺着往下走会把「什么都没说」
    // 记成 Completed 并给用户发「任务已成功完成」。有界补问一次，仍哑火
    // 就按失败收场（Failed + 失败通知），绝不谎报完成。
    if reply == TextReply::Empty {
        *empty_reply_retries += 1;
        if *empty_reply_retries > EMPTY_REPLY_MAX_RETRIES {
            let msg = format!(
                "模型连续 {} 次没有返回任何可见正文（内容为空，或整段都包在思维标签里），任务终止",
                *empty_reply_retries
            );
            log::warn!("Agent {} {}", task_id, msg);
            emit_final_plan_normalized(app, state, task_id);
            emit_event(
                app,
                event_name,
                StreamEvent::Error {
                    message: msg.clone(),
                },
            );
            if !is_subtask {
                let ns = state.settings.read().await.notification_settings.clone();
                send_notification(
                    app,
                    NotificationKind::AgentTaskFailed,
                    &ns,
                    "Agent 任务失败",
                    &msg,
                );
            }
            return TextReplyOutcome::Stop;
        }
        log::warn!(
            "Agent {} empty visible reply ({}/{}); asking the model for a visible answer",
            task_id,
            *empty_reply_retries,
            EMPTY_REPLY_MAX_RETRIES
        );
        // 补问落库再进消息链：与作业结算通知同一条生命周期（重启后仍在，
        // 历史投影与前端一致）。
        if let Some(db_id) = persister.save_msg("user", EMPTY_REPLY_NUDGE, None, None) {
            let mut m = LlmMessage::user(EMPTY_REPLY_NUDGE);
            m.db_id = Some(db_id);
            messages.push(m);
        } else {
            messages.push(LlmMessage::user(EMPTY_REPLY_NUDGE));
        }
        return TextReplyOutcome::Continue;
    }
    // 有可见正文：哑火预算清零（一次正常回复说明模型回到了正轨）
    *empty_reply_retries = 0;
    // 保存并回填 DB row id：压缩的 tail_db_id 指针依赖它
    if let Some(db_id) = persister.save_msg(
        "assistant",
        &cleaned_msg.content,
        None,
        cleaned_msg.reasoning_content.as_deref(),
    ) {
        cleaned_msg.db_id = Some(db_id);
    }
    messages.push(cleaned_msg);
    // 截断但已产生文本：保存消息后继续下一轮，让模型补完（不视为自然结束）
    if truncated {
        log::info!(
            "Agent {} truncated at token cap; continuing to next round",
            task_id
        );
        return TextReplyOutcome::Continue;
    }
    // ── 自然结束守卫：模型已给出文本，但可能刚有作业结算（对齐 DSH）──
    // 1. 已有待通知的结算（作业在这场对话还活着的时候跑完）→ 注入一条
    //    「作业已完成」通知（落库，role=notice）并回 'round，让模型把
    //    结局读进来再给结论。这是 DSH 的 busy-owner 注入：只要模型还在
    //    跑，就当场把通知塞给它，不攒到下一轮。
    // 2. 名下仍有 running 作业 → **不持住回合**。DSH 的回合结束与作业
    //    毫无关系（作业结算走「唤醒」：空闲时开新一轮把通知交给模型）。
    //    这里持住过：任务停在 Executing、前端按钮一直是「停止」、用户
    //    在输入框按回车被静默吞掉，而且超过 600 秒后就无限挂起 —— 一条
    //    跑一小时的作业把整段对话锁一小时。现在正常收尾，作业的结局由
    //    `command_exec` 的待播报告知 + 前端自动继续
    //    （`src/stores/jobWake.ts`）投递。
    // 3. 计划还有非终态项 → 收尾提醒一次（有界——本任务只提醒一次，
    //    见 `plan_finish_reminder`；提醒过之后仍要结束就放行，绝不把
    //    任务卡死）。唤醒轮不提醒：那个「已提醒」标记按任务算，唤醒一次
    //    就重来一遍，模型会被反复念同一句话。
    let final_text = cleaned_content.clone();

    // (a) 已结算待通知的作业：注入为一条通知，然后 continue 'round——
    //     回 for round 下一轮，让模型看到 notice 并 job_output 收集
    //     （不能 break 走 Done，那会把结局丢掉）。
    //     本机作业与远端作业同构、同属这套「跑完再开一轮」的语义，所以
    //     两边的结算**并进同一个列表**（各自的 `take_...` 只在自己的
    //     在册表里置「已播报」，合起来不会重复告知同一条作业）；按启动
    //     时间重排一次，通知里的先后与实际发生顺序一致。
    let mut settled_jobs = state.command_exec.take_settled_jobs_for_task(task_id);
    settled_jobs.extend(state.local_command_exec.take_settled_jobs_for_task(task_id));
    settled_jobs.sort_by_key(|job| job.started_at_millis);
    if !settled_jobs.is_empty() {
        let notice = build_job_settlement_notice(&settled_jobs);
        log::info!(
            "Agent {} job settled notice: {}",
            task_id,
            notice.lines().next().unwrap_or_default()
        );
        // 落库 role=notice（不是 user）：它是系统写的告知，不是用户打的
        // 字 —— 回读时显示成「系统告知」，与跨轮唤醒那条同一个身份。
        if let Some(db_id) = persister.save_msg(ROLE_NOTICE, &notice, None, None) {
            let mut m = LlmMessage::user(notice);
            m.db_id = Some(db_id);
            messages.push(m);
        } else {
            messages.push(LlmMessage::user(notice));
        }
        return TextReplyOutcome::Continue;
    }

    // (b) 结束前再看一眼计划：还有非终态项就先把模型叫回来收尾。
    if !is_notice_turn {
        if let Some(reminder) = plan_finish_reminder(state, task_id) {
            log::info!(
                "Agent {} plan has unfinished items; asking the model to wrap up",
                task_id
            );
            // 落库再进消息链：与作业结算通知同一条生命周期。
            if let Some(db_id) = persister.save_msg("user", &reminder, None, None) {
                let mut m = LlmMessage::user(reminder);
                m.db_id = Some(db_id);
                messages.push(m);
            } else {
                messages.push(LlmMessage::user(reminder));
            }
            return TextReplyOutcome::Continue;
        }
    }

    // (c) 收尾兜底：取消的任务不得走 Done/Completed 路径。
    if is_task_cancelled(state, task_id) {
        log::info!("Agent {} cancelled at finish guard, exiting", task_id);
        emit_final_plan_normalized(app, state, task_id);
        emit_event(app, event_name, StreamEvent::Cancelled);
        return TextReplyOutcome::Stop;
    }
    emit_final_plan_normalized(app, state, task_id);
    emit_event(app, event_name, StreamEvent::Done);
    if !is_subtask {
        let ns = state.settings.read().await.notification_settings.clone();
        send_notification(
            app,
            NotificationKind::AgentTaskDone,
            &ns,
            "Agent 任务完成",
            "您的 Agent 任务已成功完成",
        );
    }
    TextReplyOutcome::Done(final_text)
}

/// 将带 tool_calls 的 assistant 消息持久化并写入 history（原 `run_agent_loop`
/// 的工具轮持久化段，原样搬出）。
pub(super) fn persist_assistant_tool_calls(
    persister: &ConversationPersister,
    tool_calls: &[ToolCall],
    mut assistant_msg: LlmMessage,
    messages: &mut Vec<LlmMessage>,
    empty_reply_retries: &mut usize,
) {
    // 3. 将带 tool_calls 的 assistant 消息写入 history。
    //    工具调用轮是「模型在工作」的另一种证据：哑火预算清零。
    *empty_reply_retries = 0;
    //    完整持久化 tool_calls 列表，跨 task 重建 history 时才能把并行调用
    //    保留在同一条 assistant 上，避免被拆成多条假 assistant。
    //    reasoning_content 一并落库：DeepSeek thinking 模式要求带 tool_calls
    //    的 assistant 消息回传 reasoning_content，重载后缺失会 400。
    //    （前端 live 流里 handleToolCallStart 会清掉临时 thinking 的显示，
    //    落库保留不影响 UI；重载后 UI 由 toolCalls 条件控制不显示。）
    let tool_calls_json = serde_json::to_string(
        &tool_calls
            .iter()
            .map(|tc| PersistedAssistantToolCall {
                id: tc.id.clone(),
                name: tc.name.clone(),
                arguments: tc.arguments.clone(),
            })
            .collect::<Vec<_>>(),
    )
    .ok();
    // 保存并回填 DB row id：压缩的 tail_db_id 指针依赖它
    if let Some(db_id) = persister.save_msg(
        "assistant",
        &assistant_msg.content,
        tool_calls_json.as_deref(),
        assistant_msg.reasoning_content.as_deref(),
    ) {
        assistant_msg.db_id = Some(db_id);
    }
    messages.push(assistant_msg);
}

/// 超过最大执行轮数的收尾（原 `run_agent_loop` 循环后的收尾段，原样搬出）：
/// 归一化计划终态、发错误事件与非子任务的失败通知。
pub(super) async fn report_max_rounds_exceeded(
    state: &AppState,
    app: &AppHandle,
    event_name: &str,
    task_id: &str,
    is_subtask: bool,
    max_rounds: usize,
) {
    // Exceeded max rounds
    let msg = format!("Agent 达到最大执行轮数 ({max_rounds})，已停止");
    emit_final_plan_normalized(app, state, task_id);
    emit_event(
        app,
        event_name,
        StreamEvent::Error {
            message: msg.clone(),
        },
    );
    if !is_subtask {
        let ns = state.settings.read().await.notification_settings.clone();
        send_notification(
            app,
            NotificationKind::AgentTaskFailed,
            &ns,
            "Agent 任务失败",
            &msg,
        );
    }
}
