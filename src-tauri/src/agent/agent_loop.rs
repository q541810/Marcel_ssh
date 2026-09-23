use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::agent::conversation::ConversationDb;
use crate::agent::conversation_persister::{ConversationPersister, PromptOrigin, ROLE_NOTICE};
use crate::agent::plan_handler::{
    build_plan_context, emit_final_plan_normalized, handle_plan_tool_output,
    is_plan_context_message, plan_finish_reminder,
};
use crate::agent::risk::Disposition;
use crate::agent::task::AgentMode;
use crate::agent::thinking_filter::{
    filter_thinking_tags, strip_thinking_tags, ThinkingFilterState,
};
use crate::agent::tool_dispatcher::{ToolDispatcher, ToolResultEvent};
use crate::agent::tools::{ToolContext, ToolRegistry};
use crate::config::settings::AgentModeSettings;
use crate::emit_event;
use crate::error::AppError;
use crate::llm::jev::JevConfig;
use crate::llm::manager::LlmManager;
use crate::llm::provider::{LlmConfig, LlmMessage, LlmRole, ToolCall, ToolDefinition};
use crate::llm::streaming::StreamEvent;
use crate::notification::{send_notification, NotificationKind};
use crate::ssh::connection::SshManager;
use crate::AppState;

/// 最大并发执行的 tool 调用数量（超出则排队等待 permit 释放）。
/// 移动端收紧：单 WebView + 电池/内存约束下，10 路并发 tool（含多机
/// subagent 各自拉起 SSH + LLM 流）容易导致 UI 卡顿与系统杀进程。
#[cfg(desktop)]
const MAX_CONCURRENT_TOOL_EXECUTIONS: usize = 10;
#[cfg(not(desktop))]
const MAX_CONCURRENT_TOOL_EXECUTIONS: usize = 2;

/// 持久化的工具执行结果元数据（存入 role=tool 的 tool_calls_json）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct PersistedToolResult {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    /// 历史行里这个键叫 `risk_level`、值是五档严重度（`LowRisk` 之类）。
    /// 这里的别名加上 `Disposition` 自带的变体别名一起把它们读进来，
    /// 老会话照常打开、不需要数据迁移。
    #[serde(alias = "risk_level")]
    pub disposition: crate::agent::risk::Disposition,
    pub summary: String,
    pub success: bool,
    pub blocked: bool,
    #[serde(default)]
    pub was_timeout: bool,
    #[serde(default)]
    pub was_aborted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// 持久化的 assistant tool_calls 列表（存入 role=assistant 的 tool_calls_json）。
/// 与 PersistedToolResult 区分：assistant 侧是完整并行 tool call 列表，
/// 用于跨 task 重建 LLM history，避免被拆成多条假 assistant。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct PersistedAssistantToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Checks if a task has been cancelled by the user.
///
/// 问的是「因取消而终止」而不是「已终态」—— 失败的任务不该让循环表现为被取消
/// （谓词语义见 `AgentStatus::is_cancelled`）。
fn is_task_cancelled(state: &AppState, task_id: &str) -> bool {
    state
        .agent_tasks
        .read()
        .get(task_id)
        .is_some_and(|t| t.status.is_cancelled())
}

/// 把一批已结算的后台作业渲染成一条给模型的 user 通知。
/// 格式对齐 DSH completion notice：列出 job_id、描述与终态，
/// 并指示用 `job_output` 读取输出。多条合并为一条（一次决策）。
///
/// **两个调用方共用这一份文本**：本轮内注入（模型还在跑，见本文件的自然
/// 结束守卫）与跨轮唤醒（前端经 `job_pending_notice` 取走，开新一轮交给
/// 模型）。两处各写一份必然分叉。
pub(crate) fn build_job_settlement_notice(jobs: &[crate::command_exec::JobInfo]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for j in jobs {
        let status = match j.status {
            crate::command_exec::JobStatus::Completed => "已完成",
            crate::command_exec::JobStatus::Killed => "已被终止",
            crate::command_exec::JobStatus::Failed => "执行失败",
            // 恢复出来的历史作业本不该走到这里（它们的结算发生在
            // 上一次运行）；穷尽列出，真出现时如实说。
            crate::command_exec::JobStatus::Interrupted => "随应用退出中断",
            crate::command_exec::JobStatus::Running => "仍在运行", // 理论不可达
        };
        let desc = if j.description.is_empty() {
            j.command.clone()
        } else {
            j.description.clone()
        };
        lines.push(format!("后台作业 {}（{}）{}", j.job_id, desc, status));
    }
    lines.push(
        "用 job_output(job_id=...) 读取其输出并纳入结论；\
         若作业已不再需要，可用 job_kill 终止。"
            .to_string(),
    );
    lines.join("\n")
}

/// 一轮请求结束后的上下文快照（占用环那几个数）。
///
/// provider 报了用量 → 用它的 prompt 总量（**精确值**）；没报 → 退回本地估算
/// 并置 `estimated`（界面加 `~`，不能把估算讲成精确值）。三段构成**始终是估算**
/// —— provider 不给这个拆分，这也是为什么前端分段条只有长度可信。
fn round_context_snapshot(
    round: Option<&crate::llm::provider::TokenUsage>,
    breakdown: crate::agent::context::meter::ContextBreakdown,
) -> crate::agent::conversation::LastContext {
    let estimated_total = (breakdown.system + breakdown.tools + breakdown.messages) as u64;
    crate::agent::conversation::LastContext {
        used_tokens: round
            .map(|u| u.prompt_tokens as u64)
            .unwrap_or(estimated_total),
        estimated: round.is_none(),
        system_tokens: breakdown.system as u64,
        tools_tokens: breakdown.tools as u64,
        message_tokens: breakdown.messages as u64,
    }
}

/// 把单个压缩生命周期事件实时转发为前端 stream 事件（压缩可感知/可监视）。
/// 压缩期间摘要文本增量也会经 `Progress` 事件实时推送，前端据此显示进度。
pub(crate) fn forward_compaction_event(
    app: &AppHandle,
    event_name: &str,
    ev: crate::agent::context::CompactionEvent,
) {
    match ev {
        crate::agent::context::CompactionEvent::SummarizingStart { trigger } => {
            emit_event(
                app,
                event_name,
                StreamEvent::CompactionStart {
                    trigger: trigger.to_string(),
                },
            );
        }
        crate::agent::context::CompactionEvent::Progress { text } => {
            emit_event(app, event_name, StreamEvent::CompactionProgress { text });
        }
        crate::agent::context::CompactionEvent::Done { outcome } => {
            emit_event(
                app,
                event_name,
                StreamEvent::CompactionDone {
                    summary: outcome.summary.clone(),
                    shadowed_messages: outcome.shadowed_messages,
                    shadowed_tokens: outcome.shadowed_tokens,
                    tail_db_id: outcome.tail_db_id.clone(),
                },
            );
        }
        crate::agent::context::CompactionEvent::Skipped { reason, attempted } => {
            emit_event(
                app,
                event_name,
                StreamEvent::CompactionSkipped {
                    reason: reason.clone(),
                    attempted,
                },
            );
        }
    }
}

/// 非截断「哑火」（无可见正文、也无工具调用）之后允许的补问次数。
///
/// 哑火与截断不是一回事：截断是「模型没说完」（下一轮补完是合理的），哑火是
/// 模型这一轮什么都没说——再 `continue` 很可能下一轮还是空。所以哑火用**有界**
/// 补问把它拉回来：补问一次仍哑火就按失败收场（既不能落一条空 assistant 行，
/// 也不能把「什么都没说」记成 Completed 并通知用户「任务已成功完成」）。
const EMPTY_REPLY_MAX_RETRIES: usize = 1;

/// 哑火补问文本（落库 + 进消息链，与作业结算通知同一条生命周期）。
const EMPTY_REPLY_NUDGE: &str =
    "你上一条回复没有任何可见正文：内容为空，或整段都包在思维标签里——思维内容用户看不到。\
     请用正文直接给出你的回答或结论，不要只写在思维标签里。";

/// 无工具调用的 assistant 回复的处置方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextReply {
    /// 有可见正文：照常落库、进消息链。
    Visible,
    /// 截断（`finish_reason == "length"`）且无可见正文：本片不落库、不进消息链，
    /// 直接下一轮让模型补完（截断是「没说完」，不是「什么都没说」）。
    TruncatedEmpty,
    /// 非截断且无可见正文：模型哑火。不落库（空 assistant 行会与 live store
    /// 漂移），也**不能**当自然结束。
    Empty,
}

/// 判定一次「无工具调用」的回复该怎么处置，并给出清理后的正文。
///
/// 判据必须落在**清理后**的正文上：整段内容都在思维标签里（或纯空白）的回复
/// 会被 `strip_thinking_tags` 清成空串，而 `finish_reason` 正常是 `stop` ——
/// 只看「截断且为空」会把这种哑火放进自然结束路径。
fn classify_text_reply(raw_content: &str, truncated: bool) -> (TextReply, String) {
    let cleaned = strip_thinking_tags(raw_content);
    if cleaned.trim().is_empty() {
        return (
            if truncated {
                TextReply::TruncatedEmpty
            } else {
                TextReply::Empty
            },
            cleaned,
        );
    }
    (TextReply::Visible, cleaned)
}

/// Groups all parameters needed by the agent loop into a single context struct.
pub(crate) struct LoopContext {
    pub ssh: SshManager,
    pub session_id: String,
    pub app: AppHandle,
    pub state: AppState,
    pub registry: std::sync::Arc<ToolRegistry>,
    pub conversation_id: String,
    pub conv_db: std::sync::Arc<ConversationDb>,
    /// Watch channel receiver for cancellation signals.
    /// When the value changes to `true`, the LLM call in progress should be aborted.
    pub cancel_rx: tokio::sync::watch::Receiver<bool>,
    /// Application config dir. Passed to `ToolContext` so plugin local handlers
    /// (fs.read/fs.write/fs.append) can resolve plugin-relative paths.
    pub config_dir: std::path::PathBuf,
    /// 子agent（subagent 工具派发的调研任务）标记：跳过系统通知，
    /// 避免子agent完成/失败与主任务的通知叠加打扰用户。
    pub is_subtask: bool,
    /// 本轮 prompt 的来源（用户输入 / 作业结算告知）。决定它落库的身份，
    /// 以及这一轮是不是「唤醒轮」（唤醒轮不触发计划收尾提醒——那个标记按
    /// 任务算，唤醒一次就重来一遍，会把模型念烦）。
    pub prompt_origin: PromptOrigin,
}

/// The main agentic loop:
///   LLM call → tool_calls? → execute → feed result → repeat
///
/// Returns the final assistant text when the loop ended with a natural
/// (no-tool-call) response; `None` when it stopped for any other reason
/// (cancelled, LLM error, max rounds). Main tasks ignore the return value;
/// the `subagent` tool uses it as the subagent's research result.
pub(crate) async fn run_agent_loop(
    task_id: String,
    llm_manager: LlmManager,
    mut messages: Vec<LlmMessage>,
    // 注册表全量构建出的工具清单（**未**过状态门控）。每轮发请求前再过一遍
    // `manager::apply_state_gate`——会话中途发生压缩时，`read_history` 从那一轮
    // 起才该出现（见 `tools::STATE_GATED_TOOLS`）。
    base_tools: Vec<ToolDefinition>,
    mode: AgentMode,
    approval_mode: Option<AgentMode>,
    agent_settings: AgentModeSettings,
    approval_cfg: Option<LlmConfig>,
    // Jev 引擎的客户端配置（API Key + 钉住的模型 ID + 全局 NetPolicy）。
    // `None` = 没配 Key；引擎选了 Jev 时审批者仍会构造，但每次调用明确报错，
    // 不静默回退到会话模型。
    jev_cfg: Option<JevConfig>,
    ctx: LoopContext,
) -> Option<String> {
    let event_name = format!("agent://stream/{}", task_id);
    let LoopContext {
        ssh,
        session_id,
        app,
        state,
        registry,
        conversation_id,
        conv_db,
        mut cancel_rx,
        config_dir,
        is_subtask,
        prompt_origin,
    } = ctx;

    // 唤醒轮：prompt 是系统替后台作业写的结算告知，不是用户打的字。
    let is_notice_turn = !prompt_origin.is_user_input();
    let persister = ConversationPersister::new(conv_db, conversation_id.clone())
        .with_prompt_origin(prompt_origin);

    // history 来自前端 buildLlmHistory：携带 dbId 的消息对前端 store 可见
    // （db_id_known=true，自动 pressure 压缩据此收缩到前端能找到的区间末条）；
    // 运行中 save 回填的消息保持 false（前端不知 id）。
    for m in &mut messages {
        if m.db_id.is_some() {
            m.db_id_known = true;
        }
    }

    persister.update_title_from_first_user_msg(&messages);
    // 回合锚点：落库 user 消息并把这一行标成 running（崩溃时它就是「没收尾」
    // 的持久证据）。行 id 记到任务上——收尾在 `manager::finalize_task` 里，
    // 那里只能从任务记录拿锚点。写失败/无 user 行 → None，本回合不记录状态。
    if let Some(anchor_id) = persister.begin_turn(&mut messages) {
        if let Some(task) = state.agent_tasks.write().get_mut(&task_id) {
            task.turn_anchor_id = Some(anchor_id);
        }
    }

    let max_rounds = agent_settings.max_tool_rounds.max(10);
    // 上下文超限恢复预算：每成功一轮重置（对齐 DSH maxOverflowRetries 语义）
    let mut overflow_retries = 0usize;
    // 连续哑火（无可见正文、无工具调用）计数：模型产出可见正文或工具调用即清零，
    // 上限见 `EMPTY_REPLY_MAX_RETRIES`。
    let mut empty_reply_retries = 0usize;

    // Wrap the manager in Arc so the dispatcher's command approver can share
    // it without cloning the underlying HTTP client / config.
    let llm_manager = std::sync::Arc::new(llm_manager);

    // ── 上下文压缩（摘要）模型 ──
    // 显式「上下文压缩模型」槽位存在 → 压缩调用用该模型（用户选定优先）；
    // 否则压缩**复用主模型 manager**——主模型即本会话 agent 正在用的模型
    // （会话级记忆 > 全局最近使用），自动压缩天然「跟随会话模型」。
    let summarizer_manager: Option<std::sync::Arc<LlmManager>> = {
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
    };
    // 压缩调用统一入口：显式槽位模型优先，否则主模型
    let compact_manager: &LlmManager = match &summarizer_manager {
        Some(m) => m,
        None => &llm_manager,
    };

    // Create the dispatcher once and reuse it.
    let dispatcher = ToolDispatcher::new(
        mode.clone(),
        approval_mode,
        agent_settings.clone(),
        task_id.clone(),
        app.clone(),
        state.clone(),
        registry.clone(),
        llm_manager.clone(),
        approval_cfg,
        jev_cfg,
    );

    'round: for round in 0..max_rounds {
        log::info!("Agent {} round {}", task_id, round);

        if is_task_cancelled(&state, &task_id) {
            log::info!("Agent task {} cancelled, stopping loop", task_id);
            emit_final_plan_normalized(&app, &state, &task_id);
            emit_event(&app, &event_name, StreamEvent::Cancelled);
            return None;
        }

        // 0. 注入 plan 上下文：用临时 system 消息（不是 user），避免模型当成用户新发言。
        //    按前缀清掉上一轮注入；同时清掉旧版本可能残留的 User 角色 plan 消息
        //    （判据来自 `plan_handler`：压缩选保留尾部用的是同一个）。
        messages.retain(|m| !is_plan_context_message(m));
        if let Some(plan_context) = build_plan_context(&state, &task_id) {
            messages.push(LlmMessage::system(plan_context));
        }

        // 本轮该下发的工具清单：注册表是任务启动时全量构建、整任务共用的，而
        // "这个会话有没有读不到的东西"会随压缩在任务中途翻转（见
        // `tools::STATE_GATED_TOOLS`），所以每轮按当前状态过一遍门控。
        // 判据算不出来时按"宁可早给"给全量——少给一次工具会让模型失去一个它
        // 需要的能力，比多付一份说明严重得多。
        let current_tools = || {
            crate::agent::manager::tools_for_round(
                &base_tools,
                is_subtask,
                &persister.conv_db,
                &conversation_id,
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
            forward_compaction_event(&app, &event_name, ev);
        };
        let run = crate::agent::context::compact_if_needed(
            &mut messages,
            compact_manager,
            &tools,
            agent_settings.context_window,
            crate::agent::context::CompactionTrigger::Pressure,
            &mut cancel_rx,
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
        let breakdown = crate::agent::context::meter::context_breakdown(&messages, &tools);

        // 1. Call LLM (streaming) — with cancellation support
        let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
        let app_fwd = app.clone();
        let evn = event_name.clone();
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
            .stream_chat(&messages, &tools, &tx, Some(&mut cancel_rx))
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
                .record_usage(&conversation_id, round.as_ref(), last)
            {
                Ok(Some(usage)) => emit_event(
                    &app,
                    &event_name,
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

        let assistant_msg = match result {
            Ok(msg) => {
                // 一轮成功响应重置溢出恢复预算（对齐 DSH：assistant/message 重置）
                overflow_retries = 0;
                msg
            }
            Err(e) => {
                if let AppError::Cancelled(_) = e {
                    log::info!("Agent task {} cancelled during LLM call", task_id);
                    emit_final_plan_normalized(&app, &state, &task_id);
                    emit_event(&app, &event_name, StreamEvent::Cancelled);
                    return None;
                }
                let err_msg = e.to_string();
                // 上下文超限恢复（对齐 DSH request-error 恢复）：压缩一次后重试该轮
                if crate::agent::context::is_context_overflow_error(&err_msg)
                    && overflow_retries < crate::agent::context::DEFAULT_MAX_OVERFLOW_RETRIES
                {
                    let on_event = |ev: crate::agent::context::CompactionEvent| {
                        forward_compaction_event(&app, &event_name, ev);
                    };
                    let run = crate::agent::context::compact_if_needed(
                        &mut messages,
                        compact_manager,
                        &tools,
                        agent_settings.context_window,
                        crate::agent::context::CompactionTrigger::ContextOverflow,
                        &mut cancel_rx,
                        &on_event,
                    )
                    .await;
                    if let Some(outcome) = &run.outcome {
                        let persisted = persister.persist_compaction(outcome);
                        overflow_retries += 1;
                        log::info!(
                            "Agent {} context overflow: compacted {} messages, retrying round (persisted={})",
                            task_id,
                            outcome.shadowed_messages,
                            persisted
                        );
                        continue;
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
                    if is_task_cancelled(&state, &task_id) {
                        emit_final_plan_normalized(&app, &state, &task_id);
                        emit_event(&app, &event_name, StreamEvent::Cancelled);
                        return None;
                    }
                }
                emit_final_plan_normalized(&app, &state, &task_id);
                emit_event(
                    &app,
                    &event_name,
                    StreamEvent::Error {
                        message: err_msg.clone(),
                    },
                );
                if !is_subtask {
                    let ns = state.settings.read().await.notification_settings.clone();
                    let body = format!("错误信息: {}", err_msg.lines().next().unwrap_or(&err_msg));
                    send_notification(
                        &app,
                        NotificationKind::AgentTaskFailed,
                        &ns,
                        "Agent 任务失败",
                        &body,
                    );
                }
                return None;
            }
        };

        // 2. max-tokens 截断处理（对齐 DSH BlockAssembler：丢弃未闭合的 tool-call block）。
        //    finish_reason == "length" 时，工具调用参数可能被截断不完整，执行会以残缺
        //    参数跑命令（安全相关）。整体丢弃 tool_calls（无法区分完整/残缺），
        //    并把本轮视为"未完成"：有文本则保存后继续下一轮补完，无文本则直接跳过。
        let truncated = assistant_msg.finish_reason.as_deref() == Some("length");
        let mut assistant_msg = assistant_msg;
        if truncated {
            if let Some(calls) = assistant_msg.tool_calls.take() {
                if !calls.is_empty() {
                    log::info!(
                        "Agent {} response truncated at token cap: dropped {} incomplete tool call(s)",
                        task_id,
                        calls.len()
                    );
                }
            }
        }

        // 3. Check if assistant returned tool calls
        let tool_calls = assistant_msg.tool_calls.clone().unwrap_or_default();
        if tool_calls.is_empty() {
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
                continue;
            }
            // 非截断的哑火（正文为空 / 纯空白 / 整段都在思维标签里）：同样不落库、
            // 不进消息链；但它也**不是自然结束**——顺着往下走会把「什么都没说」
            // 记成 Completed 并给用户发「任务已成功完成」。有界补问一次，仍哑火
            // 就按失败收场（Failed + 失败通知），绝不谎报完成。
            if reply == TextReply::Empty {
                empty_reply_retries += 1;
                if empty_reply_retries > EMPTY_REPLY_MAX_RETRIES {
                    let msg = format!(
                        "模型连续 {} 次没有返回任何可见正文（内容为空，或整段都包在思维标签里），任务终止",
                        empty_reply_retries
                    );
                    log::warn!("Agent {} {}", task_id, msg);
                    emit_final_plan_normalized(&app, &state, &task_id);
                    emit_event(
                        &app,
                        &event_name,
                        StreamEvent::Error {
                            message: msg.clone(),
                        },
                    );
                    if !is_subtask {
                        let ns = state.settings.read().await.notification_settings.clone();
                        send_notification(
                            &app,
                            NotificationKind::AgentTaskFailed,
                            &ns,
                            "Agent 任务失败",
                            &msg,
                        );
                    }
                    return None;
                }
                log::warn!(
                    "Agent {} empty visible reply ({}/{}); asking the model for a visible answer",
                    task_id,
                    empty_reply_retries,
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
                continue;
            }
            // 有可见正文：哑火预算清零（一次正常回复说明模型回到了正轨）
            empty_reply_retries = 0;
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
                continue;
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
            let settled_jobs = state.command_exec.take_settled_jobs_for_task(&task_id);
            if !settled_jobs.is_empty() {
                let notice = build_job_settlement_notice(&settled_jobs);
                log::info!(
                    "Agent {} job settled notice: {}",
                    task_id,
                    notice.lines().next().unwrap_or_default()
                );
                // 落库 role=notice（不是 user）：它是系统写的告知，不是用户打的
                // 字 —— 回读时显示成「系统告知」，与跨轮唤醒那条同一个身份。
                if let Some(db_id) =
                    persister.save_msg(ROLE_NOTICE, &notice, None, None)
                {
                    let mut m = LlmMessage::user(notice);
                    m.db_id = Some(db_id);
                    messages.push(m);
                } else {
                    messages.push(LlmMessage::user(notice));
                }
                continue 'round;
            }

            // (b) 结束前再看一眼计划：还有非终态项就先把模型叫回来收尾。
            if !is_notice_turn {
                if let Some(reminder) = plan_finish_reminder(&state, &task_id) {
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
                    continue 'round;
                }
            }

            // (c) 收尾兜底：取消的任务不得走 Done/Completed 路径。
            if is_task_cancelled(&state, &task_id) {
                log::info!("Agent {} cancelled at finish guard, exiting", task_id);
                emit_final_plan_normalized(&app, &state, &task_id);
                emit_event(&app, &event_name, StreamEvent::Cancelled);
                return None;
            }
            emit_final_plan_normalized(&app, &state, &task_id);
            emit_event(&app, &event_name, StreamEvent::Done);
            if !is_subtask {
                let ns = state.settings.read().await.notification_settings.clone();
                send_notification(
                    &app,
                    NotificationKind::AgentTaskDone,
                    &ns,
                    "Agent 任务完成",
                    "您的 Agent 任务已成功完成",
                );
            }
            return Some(final_text);
        }

        // 3. 将带 tool_calls 的 assistant 消息写入 history。
        //    工具调用轮是「模型在工作」的另一种证据：哑火预算清零。
        empty_reply_retries = 0;
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

        // 4. Execute tool calls via the dispatcher.
        //    Concurrent-safe tools (like `SubagentTool`) are batched and run in parallel using
        //    `futures::future::join_all`. Sequential tools are run one by one to preserve
        //    causal order, security policies (read-before-edit), and approval flows.
        let batches = group_tool_calls_into_batches(&tool_calls, &registry);
        let mut all_results: Vec<SingleToolExecution> = Vec::with_capacity(tool_calls.len());
        let mut task_was_cancelled = false;

        for batch in batches {
            if is_task_cancelled(&state, &task_id) {
                task_was_cancelled = true;
                break;
            }

            if batch.is_concurrent && batch.calls.len() > 1 {
                log::info!(
                    "Agent task {} executing batch of {} concurrent tools in parallel (max concurrency: {})",
                    task_id,
                    batch.calls.len(),
                    MAX_CONCURRENT_TOOL_EXECUTIONS
                );
                let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(
                    MAX_CONCURRENT_TOOL_EXECUTIONS,
                ));
                let mut futures = Vec::with_capacity(batch.calls.len());
                for (idx, tc) in batch.calls {
                    let sem = semaphore.clone();
                    let disp = &dispatcher;
                    let s_ssh = &ssh;
                    let sid = &session_id;
                    let tid = &task_id;
                    let cid = &conversation_id;
                    let evn = &event_name;
                    let a = &app;
                    let st = &state;
                    let cdir = &config_dir;
                    let reg = &registry;
                    let msgs = &messages;
                    futures.push(async move {
                        let _permit = sem.acquire().await.ok();
                        execute_single_tool(
                            idx, tc, disp, s_ssh, sid, tid, cid, evn, a, st, cdir, reg, msgs,
                        )
                        .await
                    });
                }
                let batch_results = futures::future::join_all(futures).await;
                for res in batch_results {
                    if res.was_cancelled_or_aborted {
                        task_was_cancelled = true;
                    }
                    all_results.push(res);
                }
            } else {
                for (idx, tc) in batch.calls {
                    let res = execute_single_tool(
                        idx,
                        tc,
                        &dispatcher,
                        &ssh,
                        &session_id,
                        &task_id,
                        &conversation_id,
                        &event_name,
                        &app,
                        &state,
                        &config_dir,
                        &registry,
                        &messages,
                    )
                    .await;
                    if res.was_cancelled_or_aborted {
                        task_was_cancelled = true;
                    }
                    all_results.push(res);
                    if task_was_cancelled {
                        break;
                    }
                }
            }

            if task_was_cancelled {
                break;
            }
        }

        // Sort results by original index to ensure strict order alignment with tool_calls
        all_results.sort_by_key(|r| r.index);

        for mut res in all_results {
            let tool_result_json = serde_json::to_string(&res.persisted).ok();
            if let Some(db_id) = persister.save_msg(
                "tool",
                &res.tool_msg.content,
                tool_result_json.as_deref(),
                None,
            ) {
                res.tool_msg.db_id = Some(db_id);
            }
            messages.push(res.tool_msg);
        }

        if task_was_cancelled || is_task_cancelled(&state, &task_id) {
            log::info!(
                "Agent task {} cancelled during tool batch execution, stopping",
                task_id
            );
            emit_final_plan_normalized(&app, &state, &task_id);
            emit_event(&app, &event_name, StreamEvent::Cancelled);
            return None;
        }
    }

    // Exceeded max rounds
    let msg = format!("Agent 达到最大执行轮数 ({max_rounds})，已停止");
    emit_final_plan_normalized(&app, &state, &task_id);
    emit_event(
        &app,
        &event_name,
        StreamEvent::Error {
            message: msg.clone(),
        },
    );
    if !is_subtask {
        let ns = state.settings.read().await.notification_settings.clone();
        send_notification(
            &app,
            NotificationKind::AgentTaskFailed,
            &ns,
            "Agent 任务失败",
            &msg,
        );
    }
    None
}

/// A batch of tool calls grouped for execution.
#[derive(Debug)]
struct ToolCallBatch<'a> {
    is_concurrent: bool,
    calls: Vec<(usize, &'a ToolCall)>,
}

/// Helper holding the execution result and metadata of a single tool call.
struct SingleToolExecution {
    index: usize,
    persisted: PersistedToolResult,
    tool_msg: LlmMessage,
    was_cancelled_or_aborted: bool,
}

/// Groups a slice of `ToolCall`s into contiguous batches based on `is_concurrent_safe`.
///
/// Adjacent tools where `is_concurrent_safe() == true` are merged into a single concurrent batch.
/// Tools where `is_concurrent_safe() == false` each form their own sequential batch.
fn group_tool_calls_into_batches<'a>(
    tool_calls: &'a [ToolCall],
    registry: &ToolRegistry,
) -> Vec<ToolCallBatch<'a>> {
    let mut batches: Vec<ToolCallBatch<'a>> = Vec::new();

    for (idx, tc) in tool_calls.iter().enumerate() {
        let is_concurrent = registry
            .get(&tc.name)
            .map(|tool| tool.is_concurrent_safe())
            .unwrap_or(false);

        if is_concurrent {
            if let Some(last_batch) = batches.last_mut() {
                if last_batch.is_concurrent {
                    last_batch.calls.push((idx, tc));
                    continue;
                }
            }
            batches.push(ToolCallBatch {
                is_concurrent: true,
                calls: vec![(idx, tc)],
            });
        } else {
            batches.push(ToolCallBatch {
                is_concurrent: false,
                calls: vec![(idx, tc)],
            });
        }
    }

    batches
}

/// 作业归属的**根对话**。
///
/// 主 agent 的作业算在自己的对话名下；子 agent（subagent 工具派发的调研/
/// 执行任务）的作业算在派它的那个用户对话名下——子 agent 有自己独立的
/// 对话记录，但作业是父对话那摊活的一部分：父对话要看得见、收得回，
/// 重启后也要靠这个键认回来。沿 `parent_task_id` 往上找，带深度上限
/// 防止任务表异常时打成死循环；查不到任务时退回本任务自己的对话。
fn owner_conversation_for(state: &AppState, task_id: &str, fallback: &str) -> String {
    const MAX_DEPTH: usize = 16;
    let mut current = task_id.to_string();
    for _ in 0..MAX_DEPTH {
        let parent = {
            let tasks = state.agent_tasks.read();
            match tasks.get(&current) {
                // 没有父任务 = 主任务：它的对话就是根对话。
                Some(task) => match task.parent_task_id.clone() {
                    Some(parent) => Some(parent),
                    None => return task.conversation_id.clone(),
                },
                None => None,
            }
        };
        match parent {
            Some(parent) => current = parent,
            None => break,
        }
    }
    fallback.to_string()
}

/// Executes a single tool call with context assembly, cancellation checks, plan override,
/// and frontend event emission.
async fn execute_single_tool(
    index: usize,
    tc: &ToolCall,
    dispatcher: &ToolDispatcher,
    ssh: &SshManager,
    session_id: &str,
    task_id: &str,
    conversation_id: &str,
    event_name: &str,
    app: &AppHandle,
    state: &AppState,
    config_dir: &std::path::Path,
    registry: &ToolRegistry,
    messages: &[LlmMessage],
) -> SingleToolExecution {
    let tool_ctx = {
        let settings = state.settings.read().await;
        let policy =
            std::sync::Arc::new(crate::agent::risk::SecurityPolicy::from_user_settings(
                &settings.custom_protected_paths,
                settings.command_timeout_secs,
            ));
        ToolContext::new(
            ssh.clone(),
            session_id.to_string(),
            conversation_id,
            app.clone(),
        )
            .with_policy(policy)
            .with_owner_conversation(owner_conversation_for(state, task_id, conversation_id))
            .with_task_id(task_id)
            .with_tool_call_id(&tc.id)
            .with_event_name(event_name)
            .with_config_dir(config_dir.to_path_buf())
            .with_local_handlers(registry.local_handlers_arc())
            .with_command_exec(state.command_exec.clone())
    };

    if is_task_cancelled(state, task_id) {
        log::info!(
            "Agent task {} cancelled before executing tool {}, aborting",
            task_id,
            tc.name
        );
        let persisted = PersistedToolResult {
            id: tc.id.clone(),
            name: tc.name.clone(),
            arguments: tc.arguments.clone(),
            disposition: Disposition::Allow,
            summary: format!("{} (cancelled)", tc.name),
            success: false,
            blocked: false,
            was_timeout: false,
            was_aborted: true,
            metadata: None,
        };
        let tool_msg = LlmMessage {
            role: LlmRole::Tool,
            content: "[用户手动中断，已取消执行]".to_string(),
            tool_calls: None,
            tool_call_id: Some(tc.id.clone()),
            reasoning_content: None,
            image_paths: None,
            finish_reason: None,
            db_id: None,
            db_id_known: false,
        };
        return SingleToolExecution {
            index,
            persisted,
            tool_msg,
            was_cancelled_or_aborted: true,
        };
    }

    let mut exec = dispatcher
        .dispatch(tc, &tool_ctx, event_name, messages)
        .await;

    let cancelled_after = is_task_cancelled(state, task_id);
    if cancelled_after {
        log::info!(
            "Agent task {} cancelled after executing tool {}, marking aborted",
            task_id,
            tc.name
        );
        exec.was_aborted = true;
        if tc.name == "bash" {
            if !exec.output.is_empty() {
                exec.output.push_str(
                    "\n\n[用户中断：已停止等待输出并关闭 SSH 通道，但远端进程不保证已终止——只有它之后还往 stdout/stderr 写东西时，才可能因管道断开（SIGPIPE）退出；静默运行、重定向了输出、被 nohup/setsid/& 脱离的命令会继续在服务器上运行。必要时用 ps/pgrep 确认并按需 kill 清理。]",
                );
            } else {
                exec.output = String::from(
                    "[用户中断：已停止等待输出并关闭 SSH 通道，但远端进程不保证已终止——只有它之后还往 stdout/stderr 写东西时，才可能因管道断开（SIGPIPE）退出；静默运行、重定向了输出、被 nohup/setsid/& 脱离的命令会继续在服务器上运行。必要时用 ps/pgrep 确认并按需 kill 清理。]",
                );
            }
        } else if !exec.output.is_empty() {
            exec.output
                .push_str("\n\n[用户手动中断，已停止等待结果；工具可能已执行完成]");
        } else {
            exec.output = String::from("[用户手动中断，已停止等待结果；工具可能已执行完成]");
        }
        exec.success = false;
        exec.summary = format!("{} (aborted)", tc.name);
    } else {
        // Handle plan-related tool outputs if not cancelled
        let plan_override = if let Some(ref meta) = exec.metadata {
            handle_plan_tool_output(&tc.name, &tc.id, task_id, meta, app, state).await
        } else {
            None
        };
        if let Some(override_text) = plan_override {
            exec.output = override_text;
            exec.summary = "plan 处理提示".to_string();
        }

        // Emit result to frontend
        emit_event(
            app,
            event_name,
            ToolResultEvent {
                event_type: "toolResult".into(),
                tool_call_id: tc.id.clone(),
                tool_name: tc.name.clone(),
                arguments: tc.arguments.clone(),
                summary: exec.summary.clone(),
                result: exec.output.clone(),
                success: exec.success,
                blocked: exec.blocked,
                was_timeout: exec.was_timeout,
                was_aborted: exec.was_aborted,
                metadata: exec.metadata.clone(),
            },
        );
    }

    let persisted = PersistedToolResult {
        id: tc.id.clone(),
        name: tc.name.clone(),
        arguments: tc.arguments.clone(),
        disposition: exec.disposition,
        summary: exec.summary,
        success: exec.success,
        blocked: exec.blocked,
        was_timeout: exec.was_timeout,
        was_aborted: exec.was_aborted,
        metadata: exec.metadata,
    };

    let tool_msg = LlmMessage {
        role: LlmRole::Tool,
        content: exec.output,
        tool_calls: None,
        tool_call_id: Some(tc.id.clone()),
        reasoning_content: None,
        image_paths: None,
        finish_reason: None,
        db_id: None,
        db_id_known: false,
    };

    SingleToolExecution {
        index,
        persisted,
        tool_msg,
        was_cancelled_or_aborted: cancelled_after,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_job_settlement_notice, classify_text_reply, group_tool_calls_into_batches,
        round_context_snapshot, PersistedAssistantToolCall, PersistedToolResult, TextReply,
        MAX_CONCURRENT_TOOL_EXECUTIONS,
    };
    use crate::agent::risk::Disposition;
    use crate::agent::tools::{AgentTool, ToolContext, ToolOutput, ToolRegistry};
    use crate::error::AppError;
    use crate::llm::provider::ToolCall;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Arc;

    struct DummyTool {
        name: String,
        concurrent: bool,
    }

    #[async_trait]
    impl AgentTool for DummyTool {
        fn name(&self) -> &str {
            &self.name
        }
        fn description(&self) -> &str {
            "dummy"
        }
        fn parameters_schema(&self) -> serde_json::Value {
            json!({})
        }
        fn disposition(&self) -> Disposition {
            Disposition::Allow
        }
        fn is_concurrent_safe(&self) -> bool {
            self.concurrent
        }
        async fn execute(
            &self,
            _params: serde_json::Value,
            _ctx: &ToolContext,
        ) -> Result<ToolOutput, AppError> {
            Ok(ToolOutput::ok("ok", "dummy"))
        }
    }

    #[test]
    fn group_tool_calls_batches_adjacent_concurrent_tools() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(DummyTool {
            name: "subagent".into(),
            concurrent: true,
        }));
        registry.register(Arc::new(DummyTool {
            name: "bash".into(),
            concurrent: false,
        }));
        registry.register(Arc::new(DummyTool {
            name: "read_file".into(),
            concurrent: false,
        }));

        let calls = vec![
            ToolCall {
                id: "c1".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 1"}),
            },
            ToolCall {
                id: "c2".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 2"}),
            },
            ToolCall {
                id: "c3".into(),
                name: "bash".into(),
                arguments: json!({"command": "ls"}),
            },
            ToolCall {
                id: "c4".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 3"}),
            },
            ToolCall {
                id: "c5".into(),
                name: "read_file".into(),
                arguments: json!({"path": "/tmp/a"}),
            },
        ];

        let batches = group_tool_calls_into_batches(&calls, &registry);
        assert_eq!(batches.len(), 4);

        // Batch 0: [c1, c2] concurrent
        assert!(batches[0].is_concurrent);
        assert_eq!(batches[0].calls.len(), 2);
        assert_eq!(batches[0].calls[0].0, 0);
        assert_eq!(batches[0].calls[0].1.id, "c1");
        assert_eq!(batches[0].calls[1].0, 1);
        assert_eq!(batches[0].calls[1].1.id, "c2");

        // Batch 1: [c3] sequential
        assert!(!batches[1].is_concurrent);
        assert_eq!(batches[1].calls.len(), 1);
        assert_eq!(batches[1].calls[0].0, 2);
        assert_eq!(batches[1].calls[0].1.id, "c3");

        // Batch 2: [c4] concurrent (single call in batch)
        assert!(batches[2].is_concurrent);
        assert_eq!(batches[2].calls.len(), 1);
        assert_eq!(batches[2].calls[0].0, 3);
        assert_eq!(batches[2].calls[0].1.id, "c4");

        // Batch 3: [c5] sequential
        assert!(!batches[3].is_concurrent);
        assert_eq!(batches[3].calls.len(), 1);
        assert_eq!(batches[3].calls[0].0, 4);
        assert_eq!(batches[3].calls[0].1.id, "c5");
    }

    #[test]
    fn group_tool_calls_all_concurrent() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(DummyTool {
            name: "subagent".into(),
            concurrent: true,
        }));

        let calls = vec![
            ToolCall {
                id: "c1".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 1"}),
            },
            ToolCall {
                id: "c2".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 2"}),
            },
            ToolCall {
                id: "c3".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 3"}),
            },
        ];

        let batches = group_tool_calls_into_batches(&calls, &registry);
        assert_eq!(batches.len(), 1);
        assert!(batches[0].is_concurrent);
        assert_eq!(batches[0].calls.len(), 3);
    }

    #[tokio::test]
    async fn concurrent_semaphore_limits_in_flight_tasks() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let active = Arc::new(AtomicUsize::new(0));
        let max_observed = Arc::new(AtomicUsize::new(0));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_TOOL_EXECUTIONS));

        let total_tasks = 25;
        let futures = (0..total_tasks).map(|idx| {
            let sem = semaphore.clone();
            let act = active.clone();
            let max_obs = max_observed.clone();
            async move {
                let _permit = sem.acquire().await.unwrap();
                let current = act.fetch_add(1, Ordering::SeqCst) + 1;
                max_obs.fetch_max(current, Ordering::SeqCst);
                // Simulate some work
                tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
                act.fetch_sub(1, Ordering::SeqCst);
                idx
            }
        });

        let results = futures::future::join_all(futures).await;
        assert_eq!(results.len(), total_tasks);
        for (i, &res) in results.iter().enumerate() {
            assert_eq!(res, i); // preserved original ordering
        }
        assert!(
            max_observed.load(Ordering::SeqCst) <= MAX_CONCURRENT_TOOL_EXECUTIONS,
            "Max concurrent in-flight was {}, expected <= {}",
            max_observed.load(Ordering::SeqCst),
            MAX_CONCURRENT_TOOL_EXECUTIONS
        );
    }

    /// 历史行里这个键叫 `risk_level`、值是五档严重度。老会话必须照样能打开 ——
    /// 这条测试盯的是「别名 + 变体别名」这条兼容链：去掉 `PersistedToolResult`
    /// 上的 `alias = "risk_level"`，或者去掉 `Disposition` 变体上的旧值别名，
    /// 这里都会解析失败。
    #[test]
    fn persisted_tool_result_reads_legacy_risk_level_key_and_values() {
        let raw = r#"{
            "id": "call-1",
            "name": "bash",
            "arguments": {"command": "ls"},
            "risk_level": "LowRisk",
            "summary": "$ ls",
            "success": true,
            "blocked": false
        }"#;

        let result: PersistedToolResult = serde_json::from_str(raw).unwrap();

        assert!(!result.was_timeout);
        assert!(!result.was_aborted);
        // 值也要映射对：LowRisk 属于四档里的 Allow，不是别的档。
        assert_eq!(result.disposition, crate::agent::risk::Disposition::Allow);
    }

    /// 新写入的行用新键名 `disposition`，读回来不能走别名那条路。
    #[test]
    fn persisted_tool_result_reads_current_disposition_key() {
        let raw = r#"{
            "id": "call-3",
            "name": "bash",
            "arguments": {"command": "reboot"},
            "disposition": "ForceApproval",
            "summary": "$ reboot",
            "success": true,
            "blocked": false
        }"#;

        let result: PersistedToolResult = serde_json::from_str(raw).unwrap();

        assert_eq!(
            result.disposition,
            crate::agent::risk::Disposition::ForceApproval
        );
    }

    #[test]
    fn persisted_tool_result_reads_was_aborted() {
        let raw = r#"{
            "id": "call-2",
            "name": "bash",
            "arguments": {"command": "ls"},
            "risk_level": "Moderate",
            "summary": "$ ls (aborted)",
            "success": false,
            "blocked": false,
            "was_timeout": false,
            "was_aborted": true
        }"#;

        let result: PersistedToolResult = serde_json::from_str(raw).unwrap();

        assert!(result.was_aborted);
        assert_eq!(
            result.disposition,
            crate::agent::risk::Disposition::Approval
        );
    }

    #[test]
    fn persisted_assistant_tool_calls_roundtrip() {
        let calls = vec![
            PersistedAssistantToolCall {
                id: "call-a".into(),
                name: "bash".into(),
                arguments: serde_json::json!({"command": "ls"}),
            },
            PersistedAssistantToolCall {
                id: "call-b".into(),
                name: "system_info".into(),
                arguments: serde_json::json!({"category": "os"}),
            },
        ];
        let json = serde_json::to_string(&calls).unwrap();
        let parsed: Vec<PersistedAssistantToolCall> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "call-a");
        assert_eq!(parsed[1].name, "system_info");
    }

    fn job_info(
        job_id: &str,
        description: &str,
        command: &str,
        status: crate::command_exec::JobStatus,
    ) -> crate::command_exec::JobInfo {
        crate::command_exec::JobInfo {
            job_id: job_id.into(),
            session_id: "s1".into(),
            task_id: Some("task-1".into()),
            owner_conversation_id: Some("conv-1".into()),
            description: description.into(),
            command: command.into(),
            status,
            detail: None,
            started_at_millis: 0,
            finished_at_millis: Some(1),
            total_output_bytes: 0,
        }
    }

    /// 「整段内容都是思维标签」是一条真实路径：上游的
    /// `is_effectively_empty_response` 看的是**原始** content（非空 → 不触发
    /// 自动重试），`strip_thinking_tags` 把它清成空串。旧守卫只认「截断且为空」，
    /// 于是这种哑火会落一条空 assistant 行、一路走到 Done（Completed）。
    #[test]
    fn text_reply_made_only_of_thinking_tags_is_empty() {
        for raw in [
            "<thinking>先看看磁盘再回答</thinking>",
            "<think>只有思维</think>",
            "<Thought>只有思维</Thought>",
            // 未闭合的思维标签同样清成空（后面的内容都是思维）
            "<thinking>没闭合的思维",
            "",
            "   \n\t ",
        ] {
            let (kind, cleaned) = classify_text_reply(raw, false);
            assert_eq!(kind, TextReply::Empty, "{raw:?} 应判为哑火");
            assert!(cleaned.trim().is_empty(), "{raw:?} 清理后应为空");
        }
        // 截断时同样一份输入走「跳过本片、下一轮补完」，而不是哑火补问
        let (kind, _) = classify_text_reply("<thinking>没说完", true);
        assert_eq!(kind, TextReply::TruncatedEmpty);
    }

    /// 有可见正文（哪怕被思维标签包着）必须照常落库/收尾——守卫不能过宽。
    #[test]
    fn text_reply_with_visible_text_stays_usable() {
        for (raw, expected) in [
            ("正文", "正文"),
            ("正文 <thinking>思维</thinking> 结尾", "正文  结尾"),
            ("<thinking>思维</thinking>正文", "正文"),
        ] {
            let (kind, cleaned) = classify_text_reply(raw, false);
            assert_eq!(kind, TextReply::Visible, "{raw:?}");
            assert_eq!(cleaned, expected);
        }
        // 截断但有正文：不是哑火
        let (kind, cleaned) = classify_text_reply("被截断的正文", true);
        assert_eq!(kind, TextReply::Visible);
        assert_eq!(cleaned, "被截断的正文");
    }

    #[test]
    fn job_settlement_notice_lists_completed_jobs_and_collection_hint() {
        let jobs = vec![
            job_info(
                "job_1",
                "编译 release",
                "cargo build --release",
                crate::command_exec::JobStatus::Completed,
            ),
            job_info(
                "job_2",
                "下载模型",
                "wget big.bin",
                crate::command_exec::JobStatus::Killed,
            ),
        ];
        let notice = build_job_settlement_notice(&jobs);
        assert!(notice.contains("job_1"));
        assert!(notice.contains("编译 release"));
        assert!(notice.contains("已完成"));
        assert!(notice.contains("job_2"));
        assert!(notice.contains("已被终止"));
        assert!(notice.contains("job_output"));
        // 单条 notice 覆盖全部作业（一次决策，不逐条打断）
        assert!(notice.contains("job_1") && notice.contains("job_2"));
    }

    #[test]
    fn job_settlement_notice_fallback_description_to_command() {
        let jobs = vec![job_info(
            "job_3",
            "",
            "cargo test",
            crate::command_exec::JobStatus::Failed,
        )];
        let notice = build_job_settlement_notice(&jobs);
        assert!(notice.contains("job_3"));
        assert!(notice.contains("cargo test"));
        assert!(notice.contains("执行失败"));
    }

    fn breakdown(system: usize, tools: usize, messages: usize) -> crate::agent::context::meter::ContextBreakdown {
        crate::agent::context::meter::ContextBreakdown {
            system,
            tools,
            messages,
        }
    }

    /// provider 报了用量：用它的 prompt 总量，**不许**标成估算。
    #[test]
    fn context_snapshot_prefers_provider_usage() {
        let round = crate::llm::provider::TokenUsage {
            prompt_tokens: 84_213,
            completion_tokens: 30,
            total_tokens: 84_243,
            ..Default::default()
        };
        let snap = round_context_snapshot(Some(&round), breakdown(3000, 12_000, 69_213));
        assert_eq!(snap.used_tokens, 84_213);
        assert!(!snap.estimated);
        // 构成始终是估算（provider 不给这个拆分）
        assert_eq!(snap.system_tokens, 3000);
        assert_eq!(snap.tools_tokens, 12_000);
        assert_eq!(snap.message_tokens, 69_213);
    }

    /// provider 没报用量（有些中转会忽略 `include_usage`）：退回本地估算并标
    /// `estimated` —— 环仍有数，但界面会加 `~`，不会把估算讲成精确值。
    #[test]
    fn context_snapshot_falls_back_to_estimate() {
        let snap = round_context_snapshot(None, breakdown(100, 200, 300));
        assert_eq!(snap.used_tokens, 600);
        assert!(snap.estimated);
    }
}
