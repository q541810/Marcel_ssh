use tauri::AppHandle;
use tokio::sync::mpsc;

use crate::agent::conversation::ConversationDb;
use crate::agent::conversation_persister::ConversationPersister;
use crate::agent::plan_handler::{
    build_plan_context, emit_final_plan_normalized, handle_plan_tool_output, PLAN_CONTEXT_PREFIX,
};
use crate::agent::task::{AgentMode, AgentStatus};
use crate::agent::thinking_filter::{filter_thinking_tags, strip_thinking_tags};
use crate::agent::tool_dispatcher::{ToolDispatcher, ToolResultEvent};
use crate::agent::tools::{ToolContext, ToolRegistry};
use crate::config::settings::AgentModeSettings;
use crate::emit_event;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ToolDefinition};
use crate::llm::streaming::StreamEvent;
use crate::notification::{send_notification, NotificationKind};
use crate::ssh::connection::SshManager;
use crate::AppState;

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
        crate::agent::context::CompactionEvent::Skipped {
            reason,
            attempted,
        } => {
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
    provider: OpenAiProvider,
    mut messages: Vec<LlmMessage>,
    tools: Vec<ToolDefinition>,
    mode: AgentMode,
    agent_settings: AgentModeSettings,
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

    persister.update_title_from_last_user_msg(&messages);
    persister.save_last_user_msg(&mut messages);

    let max_rounds = agent_settings.max_tool_rounds.max(10);
    // 上下文超限恢复预算：每成功一轮重置（对齐 DSH maxOverflowRetries 语义）
    let mut overflow_retries = 0usize;

    // Wrap the provider in Arc so the dispatcher's command approver can share
    // it without cloning the underlying HTTP client / config.
    let provider = std::sync::Arc::new(provider);

    // Create the dispatcher once and reuse it.
    let dispatcher = ToolDispatcher::new(
        mode.clone(),
        agent_settings.clone(),
        task_id.clone(),
        app.clone(),
        state.clone(),
        registry.clone(),
        provider.clone(),
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
            &provider,
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

        let result = tokio::select! {
            r = provider.chat_stream(&messages, &tools, tx) => r,
            _ = cancel_rx.changed() => {
                // Cancelled during LLM call
                log::info!("Agent task {} cancelled during LLM call", task_id);
                let _ = forwarder.await;
                emit_final_plan_normalized(&app, &state, &task_id);
                emit_event(&app, &event_name, StreamEvent::Done);
                return None;
            }
        };
        let _ = forwarder.await;

        let mut assistant_msg = match result {
            Ok(msg) => {
                // 一轮成功响应重置溢出恢复预算（对齐 DSH：assistant/message 重置）
                overflow_retries = 0;
                msg
            }
            Err(e) => {
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
                        &provider,
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
                            crate::agent::context::CompactionEvent::Skipped {
                                reason, ..
                            } => Some(reason.clone()),
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

        // 4. Execute each tool call via the dispatcher.
        //    The security policy is built fresh from current settings (including
        //    user-defined custom_protected_paths and command_timeout_secs) and attached to the context.
        for tc in tool_calls {
            let tool_ctx = {
                let settings = state.settings.read().await;
                let policy =
                    std::sync::Arc::new(crate::agent::sandbox::SecurityPolicy::from_user_settings(
                        &settings.custom_protected_paths,
                        settings.command_timeout_secs,
                    ));
                ToolContext::new(ssh.clone(), session_id.clone(), app.clone())
                    .with_policy(policy)
                    .with_task_id(&task_id)
                    .with_tool_call_id(&tc.id)
                    .with_event_name(&event_name)
                    .with_config_dir(config_dir.clone())
                    .with_local_handlers(registry.local_handlers_arc())
                    .with_pending_questions(state.pending_questions.clone())
            };
            if is_task_cancelled(&state, &task_id) {
                log::info!(
                    "Agent task {} cancelled before tool execution, stopping",
                    task_id
                );
                emit_final_plan_normalized(&app, &state, &task_id);
                emit_event(&app, &event_name, StreamEvent::Done);
                return None;
            }

            let mut exec = dispatcher
                .dispatch(&tc, &tool_ctx, &event_name, &messages)
                .await;

            if is_task_cancelled(&state, &task_id) {
                log::info!(
                    "Agent task {} cancelled after tool execution, stopping",
                    task_id
                );
                // Mark the tool as manually aborted. The tool has already finished
                // executing (exec_streamed does not watch cancel), so exec.output
                // holds the actual result. We keep it and append an interruption note
                // so the LLM understands: the tool ran, but the user chose to stop
                // waiting rather than abort the action itself.
                exec.was_aborted = true;
                // Distinguish streaming (execute_command) versus non-streaming tools:
                // streaming emits partial output incrementally to the frontend, so the
                // user has seen progress; non-streaming tools are invisible to the user
                // until completion, so phrasing reflects that.
                if tc.name == "execute_command" {
                    if !exec.output.is_empty() {
                        exec.output.push_str(
                            "\n\n[用户手动触发中断，系统未停止进程，但已停止等待输出。这不代表进程已经停止，远端进程可能仍在运行。]",
                        );
                    } else {
                        exec.output = String::from(
                            "[用户手动触发中断，系统未停止进程，但已停止等待输出。这不代表进程已经停止，远端进程可能仍在运行。]",
                        );
                    }
                } else {
                    if !exec.output.is_empty() {
                        exec.output
                            .push_str("\n\n[用户手动中断，已停止等待结果；工具可能已执行完成]");
                    } else {
                        exec.output =
                            String::from("[用户手动中断，已停止等待结果；工具可能已执行完成]");
                    }
                }
                exec.success = false;
                exec.summary = format!("{} (aborted)", tc.name);

                // Persist + push a tool message so the conversation history (and any
                // future continuation) sees a complete assistant(tool_calls) → tool(result)
                // chain. We intentionally do NOT emit a toolResult event here: the
                // frontend has already been notified synchronously by markAbortedToolFlags
                // (see taskStore.stopTask) and unlistens before this point.
                let tool_result_json = serde_json::to_string(&PersistedToolResult {
                    id: tc.id.clone(),
                    name: tc.name.clone(),
                    arguments: tc.arguments.clone(),
                    risk_level: exec.risk_level,
                    summary: exec.summary.clone(),
                    success: exec.success,
                    blocked: exec.blocked,
                    was_timeout: exec.was_timeout,
                    was_aborted: exec.was_aborted,
                    metadata: exec.metadata.clone(),
                })
                .ok();

                let mut tool_msg = LlmMessage {
                    role: LlmRole::Tool,
                    content: exec.output,
                    tool_calls: None,
                    tool_call_id: Some(tc.id),
                    reasoning_content: None,
                    image_paths: None,
                    finish_reason: None,
                    db_id: None,
                };
                if let Some(db_id) = persister.save_msg(
                    "tool",
                    &tool_msg.content,
                    tool_result_json.as_deref(),
                    None,
                ) {
                    tool_msg.db_id = Some(db_id);
                }
                messages.push(tool_msg);

                emit_final_plan_normalized(&app, &state, &task_id);
                emit_event(&app, &event_name, StreamEvent::Done);
                return None;
            }

            // Handle plan-related tool outputs (borrows tc fields).
            // 返回 Option<String>：反思提醒或错误提示文本。若返回 Some，需要覆盖
            // tool output（丢弃 tool 层返回的误导性文本），让前端 tool 卡片和 LLM
            // 都只看到实际状态。必须在 emit ToolResultEvent 之前执行，否则前端
            // tool 卡片会显示被覆盖前的内容。
            let plan_override = if let Some(ref meta) = exec.metadata {
                handle_plan_tool_output(&tc.name, &tc.id, &task_id, meta, &app, &state).await
            } else {
                None
            };
            if let Some(override_text) = plan_override {
                exec.output = override_text;
                exec.summary = "plan 处理提示".to_string();
            }

            // Emit result to frontend (requires owned strings for serialization).
            emit_event(
                &app,
                &event_name,
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

            // Persist tool result — move remaining tc fields to avoid redundant clones.
            let tool_result_json = serde_json::to_string(&PersistedToolResult {
                id: tc.id.clone(),
                name: tc.name,
                arguments: tc.arguments,
                risk_level: exec.risk_level,
                summary: exec.summary,
                success: exec.success,
                blocked: exec.blocked,
                was_timeout: exec.was_timeout,
                was_aborted: exec.was_aborted,
                metadata: exec.metadata,
            })
            .ok();

            // Build tool message — move exec.output into content.
            let mut tool_msg = LlmMessage {
                role: LlmRole::Tool,
                content: exec.output,
                tool_calls: None,
                tool_call_id: Some(tc.id),
                reasoning_content: None,
                image_paths: None,
                finish_reason: None,
                db_id: None,
            };

            // Save to conversation DB (borrows tool_msg.content, no extra clone).
            // 回填 DB row id：压缩的 tail_db_id 指针依赖它。
            if let Some(db_id) =
                persister.save_msg("tool", &tool_msg.content, tool_result_json.as_deref(), None)
            {
                tool_msg.db_id = Some(db_id);
            }

            messages.push(tool_msg);
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

#[cfg(test)]
mod tests {
    use super::{PersistedAssistantToolCall, PersistedToolResult};

    #[test]
    fn persisted_tool_result_defaults_missing_timeout_to_false() {
        let raw = r#"{
            "id": "call-1",
            "name": "execute_command",
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
            "name": "execute_command",
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
                name: "execute_command".into(),
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
