use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::agent::conversation::ConversationDb;
use crate::agent::conversation_persister::ConversationPersister;
use crate::agent::plan_handler::{build_plan_context, handle_plan_tool_output};
use crate::agent::task::{AgentMode, AgentStatus};
use crate::agent::thinking_filter::{filter_thinking_tags, strip_thinking_tags};
use crate::agent::tool_dispatcher::{ToolDispatcher, ToolResultEvent};
use crate::agent::tools::{ToolContext, ToolRegistry};
use crate::config::settings::AgentModeSettings;
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
}

/// Checks if a task has been cancelled by the user.
fn is_task_cancelled(state: &AppState, task_id: &str) -> bool {
    state
        .agent_tasks
        .read()
        .get(task_id)
        .map_or(false, |t| t.status == AgentStatus::Cancelled)
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
}

/// The main agentic loop:
///   LLM call → tool_calls? → execute → feed result → repeat
pub(crate) async fn run_agent_loop(
    task_id: String,
    provider: OpenAiProvider,
    mut messages: Vec<LlmMessage>,
    tools: Vec<ToolDefinition>,
    mode: AgentMode,
    agent_settings: AgentModeSettings,
    ctx: LoopContext,
) {
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
    } = ctx;

    let persister = ConversationPersister::new(conv_db, conversation_id.clone());

    persister.update_title_from_last_user_msg(&messages);
    persister.save_last_user_msg(&messages);

    let max_rounds = agent_settings.max_tool_rounds.max(10);

    // Create the dispatcher once and reuse it.
    let dispatcher = ToolDispatcher::new(
        mode.clone(),
        agent_settings,
        task_id.clone(),
        app.clone(),
        state.clone(),
        registry.clone(),
    );

    for round in 0..max_rounds {
        log::info!("Agent {} round {}", task_id, round);

        if is_task_cancelled(&state, &task_id) {
            log::info!("Agent task {} cancelled, stopping loop", task_id);
            let _ = app.emit(&event_name, StreamEvent::Done);
            return;
        }

        // 0. Inject plan context before LLM call
        if let Some(plan_context) = build_plan_context(&state, &task_id) {
            messages.push(LlmMessage::user(plan_context));
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
                            let _ = app_fwd.emit(&evn, StreamEvent::TextDelta { text: filtered });
                        }
                    }
                    other => {
                        let _ = app_fwd.emit(&evn, other);
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
                let _ = app.emit(&event_name, StreamEvent::Done);
                return;
            }
        };
        let _ = forwarder.await;

        let assistant_msg = match result {
            Ok(msg) => msg,
            Err(e) => {
                let err_msg = e.to_string();
                let _ = app.emit(
                    &event_name,
                    StreamEvent::Error {
                        message: err_msg.clone(),
                    },
                );
                {
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
                return;
            }
        };

        // 2. Check if assistant returned tool calls
        let tool_calls = assistant_msg.tool_calls.clone().unwrap_or_default();
        if tool_calls.is_empty() {
            let cleaned_content = strip_thinking_tags(&assistant_msg.content);
            let cleaned_msg = LlmMessage {
                content: cleaned_content,
                ..assistant_msg
            };
            let _ = persister.save_msg(
                "assistant",
                &cleaned_msg.content,
                None,
                cleaned_msg.reasoning_content.as_deref(),
            );
            messages.push(cleaned_msg);
            let _ = app.emit(&event_name, StreamEvent::Done);
            {
                let ns = state.settings.read().await.notification_settings.clone();
                send_notification(
                    &app,
                    NotificationKind::AgentTaskDone,
                    &ns,
                    "Agent 任务完成",
                    "您的 Agent 任务已成功完成",
                );
            }
            return;
        }

        // 3. Add assistant message (with tool_calls) to history.
        //    Do NOT persist reasoning_content here — the thinking that preceded
        //    this tool call is ephemeral and should not survive a reload.
        //    (The live-streaming frontend clears it via handleToolCallStart;
        //    persisting None keeps the DB consistent with that behaviour.)
        let _ = persister.save_msg("assistant", &assistant_msg.content, None, None);
        messages.push(assistant_msg);

        // 4. Execute each tool call via the dispatcher.
        //    The security policy is built fresh from current settings (including
        //    user-defined custom_protected_paths) and attached to the context.
        for tc in tool_calls {
            let tool_ctx = {
                let settings = state.settings.read().await;
                let policy = std::sync::Arc::new(
                    crate::agent::sandbox::SecurityPolicy::from_user_settings(
                        &settings.custom_protected_paths,
                    ),
                );
                ToolContext::new(ssh.clone(), session_id.clone(), app.clone())
                    .with_policy(policy)
                    .with_tool_call_id(&tc.id)
                    .with_event_name(&event_name)
            };
            if is_task_cancelled(&state, &task_id) {
                log::info!(
                    "Agent task {} cancelled before tool execution, stopping",
                    task_id
                );
                let _ = app.emit(&event_name, StreamEvent::Done);
                return;
            }

            let exec = dispatcher.dispatch(&tc, &tool_ctx, &event_name).await;

            if is_task_cancelled(&state, &task_id) {
                log::info!(
                    "Agent task {} cancelled after tool execution, stopping",
                    task_id
                );
                let _ = app.emit(&event_name, StreamEvent::Done);
                return;
            }

            // Emit result to frontend (requires owned strings for serialization).
            let _ = app.emit(
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
                },
            );

            // Handle plan-related tool outputs (borrows tc fields).
            if let Some(meta) = exec.metadata {
                handle_plan_tool_output(&tc.name, &tc.id, &task_id, &meta, &app, &state).await;
            }

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
            })
            .ok();

            // Build tool message — move exec.output into content.
            let tool_msg = LlmMessage {
                role: LlmRole::Tool,
                content: exec.output,
                tool_calls: None,
                tool_call_id: Some(tc.id),
                reasoning_content: None,
            };

            // Save to conversation DB (borrows tool_msg.content, no extra clone).
            let _ =
                persister.save_msg("tool", &tool_msg.content, tool_result_json.as_deref(), None);

            messages.push(tool_msg);
        }
    }

    // Exceeded max rounds
    let msg = format!("Agent 达到最大执行轮数 ({max_rounds})，已停止");
    let _ = app.emit(
        &event_name,
        StreamEvent::Error {
            message: msg.clone(),
        },
    );
    {
        let ns = state.settings.read().await.notification_settings.clone();
        send_notification(
            &app,
            NotificationKind::AgentTaskFailed,
            &ns,
            "Agent 任务失败",
            &msg,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::PersistedToolResult;

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
    }
}
