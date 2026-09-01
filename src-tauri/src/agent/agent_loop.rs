use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::agent::conversation::ConversationDb;
use crate::agent::conversation_persister::ConversationPersister;
use crate::agent::plan_handler::{
    build_plan_context, emit_final_plan_normalized, handle_plan_tool_output, PLAN_CONTEXT_PREFIX,
};
use crate::agent::sandbox::RiskLevel;
use crate::agent::task::{AgentMode, AgentStatus};
use crate::agent::thinking_filter::{filter_thinking_tags, strip_thinking_tags};
use crate::agent::tool_dispatcher::{ToolDispatcher, ToolResultEvent};
use crate::agent::tools::{ToolContext, ToolRegistry};
use crate::config::settings::AgentModeSettings;
use crate::emit_event;
use crate::error::AppError;
use crate::llm::manager::LlmManager;
use crate::llm::provider::{LlmConfig, LlmMessage, LlmRole, ToolCall, ToolDefinition};
use crate::llm::streaming::StreamEvent;
use crate::notification::{send_notification, NotificationKind};
use crate::ssh::connection::SshManager;
use crate::AppState;

/// 最大并发执行的 tool 调用数量（超出则排队等待 permit 释放）。
const MAX_CONCURRENT_TOOL_EXECUTIONS: usize = 10;

/// 持久化的工具执行结果元数据（存入 role=tool 的 tool_calls_json）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct PersistedToolResult {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    pub risk_level: crate::agent::sandbox::RiskLevel,
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
fn is_task_cancelled(state: &AppState, task_id: &str) -> bool {
    state
        .agent_tasks
        .read()
        .get(task_id)
        .map_or(false, |t| t.status == AgentStatus::Cancelled)
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
    /// 子agent（task 工具派发的调研任务）标记：跳过系统通知，
    /// 避免子agent完成/失败与主任务的通知叠加打扰用户。
    pub is_subtask: bool,
}

/// The main agentic loop:
///   LLM call → tool_calls? → execute → feed result → repeat
///
/// Returns the final assistant text when the loop ended with a natural
/// (no-tool-call) response; `None` when it stopped for any other reason
/// (cancelled, LLM error, max rounds). Main tasks ignore the return value;
/// the `task` tool uses it as the subagent's research result.
pub(crate) async fn run_agent_loop(
    task_id: String,
    llm_manager: LlmManager,
    mut messages: Vec<LlmMessage>,
    tools: Vec<ToolDefinition>,
    mode: AgentMode,
    agent_settings: AgentModeSettings,
    approval_cfg: Option<LlmConfig>,
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
    } = ctx;

    let persister = ConversationPersister::new(conv_db, conversation_id.clone())
        .with_sync(state.sync_engine.clone(), state.sync_scheduler.clone());

    // history 来自前端 buildLlmHistory：携带 dbId 的消息对前端 store 可见
    // （db_id_known=true，自动 pressure 压缩据此收缩到前端能找到的区间末条）；
    // 运行中 save 回填的消息保持 false（前端不知 id）。
    for m in &mut messages {
        if m.db_id.is_some() {
            m.db_id_known = true;
        }
    }

    persister.update_title_from_first_user_msg(&messages);
    persister.save_last_user_msg(&mut messages);

    let max_rounds = agent_settings.max_tool_rounds.max(10);
    // 上下文超限恢复预算：每成功一轮重置（对齐 DSH maxOverflowRetries 语义）
    let mut overflow_retries = 0usize;
    // 子 agent 作业未完成提醒计数（有界，最多 2 次）
    let mut job_nudges: u32 = 0;

    // Wrap the manager in Arc so the dispatcher's command approver can share
    // it without cloning the underlying HTTP client / config.
    let llm_manager = std::sync::Arc::new(llm_manager);

    // Create the dispatcher once and reuse it.
    let dispatcher = ToolDispatcher::new(
        mode.clone(),
        agent_settings.clone(),
        task_id.clone(),
        app.clone(),
        state.clone(),
        registry.clone(),
        llm_manager.clone(),
        approval_cfg,
    );

    for round in 0..max_rounds {
        log::info!("Agent {} round {}", task_id, round);

        if is_task_cancelled(&state, &task_id) {
            log::info!("Agent task {} cancelled, stopping loop", task_id);
            emit_final_plan_normalized(&app, &state, &task_id);
            emit_event(&app, &event_name, StreamEvent::Done);
            return None;
        }

        // 0. 注入 plan 上下文：用临时 system 消息（不是 user），避免模型当成用户新发言。
        //    按前缀清掉上一轮注入；同时清掉旧版本可能残留的 User 角色 plan 消息。
        messages.retain(|m| {
            let is_plan_inject = m.content.starts_with(PLAN_CONTEXT_PREFIX)
                && (m.role == LlmRole::System || m.role == LlmRole::User);
            !is_plan_inject
        });
        if let Some(plan_context) = build_plan_context(&state, &task_id) {
            messages.push(LlmMessage::system(plan_context));
        }

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
            &llm_manager,
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

        // 1. Call LLM (streaming) — with cancellation support
        let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
        let app_fwd = app.clone();
        let evn = event_name.clone();
        let forwarder = tokio::spawn(async move {
            let mut in_thinking = false;
            while let Some(ev) = rx.recv().await {
                match ev {
                    StreamEvent::TextDelta { ref text } => {
                        let (filtered, new_in_thinking) = filter_thinking_tags(text, in_thinking);
                        in_thinking = new_in_thinking;
                        if !filtered.is_empty() && !in_thinking {
                            emit_event(&app_fwd, &evn, StreamEvent::TextDelta { text: filtered });
                        }
                    }
                    other => {
                        emit_event(&app_fwd, &evn, other);
                    }
                }
            }
        });

        let result = llm_manager
            .stream_chat(&messages, &tools, &tx, Some(&mut cancel_rx))
            .await;
        drop(tx);
        let _ = forwarder.await;

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
                    emit_event(&app, &event_name, StreamEvent::Done);
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
                        &llm_manager,
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
                        emit_event(&app, &event_name, StreamEvent::Done);
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
            let cleaned_content = strip_thinking_tags(&assistant_msg.content);
            let mut cleaned_msg = LlmMessage {
                content: cleaned_content.clone(),
                ..assistant_msg
            };
            // 截断且无有效文本：不落库、不进消息链（对齐 DSH"空内容不进派生历史"），
            // 直接下一轮。save_msg 必须在此检查之后：否则空 content 会落库成一条空
            // assistant 行（save_message 无条件 INSERT），与 live store（前端收不到
            // 空文本）漂移——重启后出现空消息，压缩 count-walk 也与前端投影对不上。
            if truncated && cleaned_content.is_empty() {
                log::warn!(
                    "Agent {} truncated at token cap with empty text; skipping message and continuing",
                    task_id
                );
                continue;
            }
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
            // 子 agent 收尾守卫：名下仍有运行中的后台作业时，不允许带着
            // "孤儿作业" 结束——注入一条提醒让模型 job_output 收集或
            // job_kill 终止（有界，最多 2 次防止死循环）。
            if is_subtask && job_nudges < 2 {
                let running = state.command_exec.running_jobs_for_task(&task_id).await;
                if !running.is_empty() {
                    job_nudges += 1;
                    let list = running
                        .iter()
                        .map(|j| format!("- {}（{}）", j.job_id, j.description))
                        .collect::<Vec<_>>()
                        .join("\n");
                    let nudge = format!(
                        "你派发的后台作业尚未结束，不能直接完成调研：\n{}\n\
                         请先用 job_output(wait=true) 收集其输出直到作业结束；\
                         若作业对调研结论不再必要，用 job_kill 终止。\
                         处理完后再输出最终结论。",
                        list
                    );
                    // 循环瞬态消息，不落库（与对话内容无关，仅用于本轮调度）
                    messages.push(LlmMessage::user(nudge));
                    continue;
                }
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
            return Some(cleaned_content);
        }

        // 3. 将带 tool_calls 的 assistant 消息写入 history。
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
        //    Concurrent-safe tools (like `TaskTool`) are batched and run in parallel using
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
                    let evn = &event_name;
                    let a = &app;
                    let st = &state;
                    let cdir = &config_dir;
                    let reg = &registry;
                    let msgs = &messages;
                    futures.push(async move {
                        let _permit = sem.acquire().await.ok();
                        execute_single_tool(
                            idx, tc, disp, s_ssh, sid, tid, evn, a, st, cdir, reg, msgs,
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
            emit_event(&app, &event_name, StreamEvent::Done);
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

/// Executes a single tool call with context assembly, cancellation checks, plan override,
/// and frontend event emission.
async fn execute_single_tool(
    index: usize,
    tc: &ToolCall,
    dispatcher: &ToolDispatcher,
    ssh: &SshManager,
    session_id: &str,
    task_id: &str,
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
            std::sync::Arc::new(crate::agent::sandbox::SecurityPolicy::from_user_settings(
                &settings.custom_protected_paths,
                settings.command_timeout_secs,
            ));
        ToolContext::new(ssh.clone(), session_id.to_string(), app.clone())
            .with_policy(policy)
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
            risk_level: RiskLevel::ReadOnly,
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
                    "\n\n[用户中断：已停止等待输出并向远端发送 close 关闭通道；普通命令通常已随之终止，但创建后台/守护进程（nohup、setsid、&）的命令可能仍在远端运行。]",
                );
            } else {
                exec.output = String::from(
                    "[用户中断：已停止等待输出并向远端发送 close 关闭通道；普通命令通常已随之终止，但创建后台/守护进程（nohup、setsid、&）的命令可能仍在远端运行。]",
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
        risk_level: exec.risk_level,
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
        group_tool_calls_into_batches, PersistedAssistantToolCall, PersistedToolResult,
        MAX_CONCURRENT_TOOL_EXECUTIONS,
    };
    use crate::agent::sandbox::RiskLevel;
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
        fn risk_level(&self) -> RiskLevel {
            RiskLevel::ReadOnly
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
            name: "task".into(),
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
                name: "task".into(),
                arguments: json!({"prompt": "subtask 1"}),
            },
            ToolCall {
                id: "c2".into(),
                name: "task".into(),
                arguments: json!({"prompt": "subtask 2"}),
            },
            ToolCall {
                id: "c3".into(),
                name: "bash".into(),
                arguments: json!({"command": "ls"}),
            },
            ToolCall {
                id: "c4".into(),
                name: "task".into(),
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
            name: "task".into(),
            concurrent: true,
        }));

        let calls = vec![
            ToolCall {
                id: "c1".into(),
                name: "task".into(),
                arguments: json!({"prompt": "subtask 1"}),
            },
            ToolCall {
                id: "c2".into(),
                name: "task".into(),
                arguments: json!({"prompt": "subtask 2"}),
            },
            ToolCall {
                id: "c3".into(),
                name: "task".into(),
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

    #[test]
    fn persisted_tool_result_defaults_missing_timeout_to_false() {
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
}
