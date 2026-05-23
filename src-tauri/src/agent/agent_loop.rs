use std::collections::HashMap;
use chrono::Utc;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::agent::conversation::ConversationDb;
use crate::agent::runtime::{AgentMode, AgentStatus};
use crate::agent::thinking_filter::strip_thinking_tags;
use crate::agent::tools::{ToolContext, ToolRegistry};
use crate::agent::plan_handler::{build_plan_context, handle_plan_tool_output};
use crate::agent::tool_dispatcher::{ToolDispatcher, ToolResultEvent};
use crate::config::settings::AgentModeSettings;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ToolDefinition};
use crate::llm::streaming::StreamEvent;
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
}

/// Maximum number of consecutive LLM ↔ tool-execution round-trips per task.
const MAX_TOOL_ROUNDS: usize = 50;

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
    } = ctx;

    // Auto-update conversation title from the current prompt (last user message).
    if let Some(msg) = messages.iter().rev().find(|m| m.role == LlmRole::User && !m.content.is_empty()) {
        let title = msg.content.chars().take(30).collect::<String>();
        let _ = conv_db.update_conversation_title(&conversation_id, &title);
    }

    // Persist only the current prompt (the last user message).
    if let Some(msg) = messages.iter().rev().find(|m| m.role == LlmRole::User) {
        if !msg.content.is_empty() {
            let _ = conv_db.save_message(&conversation_id, "user", &msg.content, &Utc::now().to_rfc3339(), None, None);
        }
    }

    // Create the dispatcher once and reuse it.
    let dispatcher = ToolDispatcher::new(
        mode.clone(),
        agent_settings,
        app.clone(),
        state.clone(),
        registry.clone(),
    );

    for round in 0..MAX_TOOL_ROUNDS {
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

        // 1. Call LLM (streaming)
        let (tx, mut rx) = mpsc::unbounded_channel::<StreamEvent>();
        let app_fwd = app.clone();
        let evn = event_name.clone();
        let forwarder = tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                let _ = app_fwd.emit(&evn, ev);
            }
        });

        let result = provider.chat_stream(&messages, &tools, tx).await;
        let _ = forwarder.await;

        let assistant_msg = match result {
            Ok(msg) => msg,
            Err(e) => {
                let _ = app.emit(
                    &event_name,
                    StreamEvent::Error { message: e.to_string() },
                );
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
            messages.push(cleaned_msg.clone());
            let _ = conv_db.save_message(&conversation_id, "assistant", &cleaned_msg.content, &Utc::now().to_rfc3339(), None, cleaned_msg.reasoning_content.as_deref());
            let _ = app.emit(&event_name, StreamEvent::Done);
            return;
        }

        // 3. Add assistant message (with tool_calls) to history
        let risk_map: HashMap<String, crate::agent::sandbox::RiskLevel> = tool_calls
            .iter()
            .map(|tc| {
                let risk = match tc.name.as_str() {
                    "execute_command" => tc
                        .arguments
                        .get("command")
                        .and_then(|v| v.as_str())
                        .map(crate::agent::sandbox::assess_risk)
                        .unwrap_or_else(|| {
                            registry.get(&tc.name)
                                .map(|t| t.risk_level())
                                .unwrap_or(crate::agent::sandbox::RiskLevel::Moderate)
                        }),
                    _ => registry
                        .get(&tc.name)
                        .map(|t| t.risk_level())
                        .unwrap_or(crate::agent::sandbox::RiskLevel::Moderate),
                };
                (tc.id.clone(), risk)
            })
            .collect();

        let _ = conv_db.save_message(&conversation_id, "assistant", &assistant_msg.content, &Utc::now().to_rfc3339(), None, assistant_msg.reasoning_content.as_deref());
        messages.push(assistant_msg);

        // 4. Execute each tool call via the dispatcher
        let tool_ctx = ToolContext::new(ssh.clone(), session_id.clone(), app.clone());
        for tc in &tool_calls {
            if is_task_cancelled(&state, &task_id) {
                log::info!("Agent task {} cancelled before tool execution, stopping", task_id);
                let _ = app.emit(&event_name, StreamEvent::Done);
                return;
            }

            let exec = dispatcher.dispatch(tc, &tool_ctx, &event_name).await;

            if is_task_cancelled(&state, &task_id) {
                log::info!("Agent task {} cancelled after tool execution, stopping", task_id);
                let _ = app.emit(&event_name, StreamEvent::Done);
                return;
            }

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
                },
            );

            // 5. Add tool result as a message for the next LLM round
            messages.push(LlmMessage {
                role: LlmRole::Tool,
                content: exec.output.clone(),
                tool_calls: None,
                tool_call_id: Some(tc.id.clone()),
                reasoning_content: None,
            });

            // 6. Handle plan-related tool outputs
            if let Some(meta) = exec.metadata {
                handle_plan_tool_output(
                    &tc.name,
                    &tc.id,
                    &task_id,
                    &meta,
                    &app,
                    &state,
                )
                .await;
            }

            // 7. Persist tool result to DB for conversation history
            let effective_risk = risk_map.get(&tc.id)
                .copied()
                .unwrap_or_else(|| {
                    registry.get(&tc.name)
                        .map(|t| t.risk_level())
                        .unwrap_or(crate::agent::sandbox::RiskLevel::Moderate)
                });
            let tool_result_json = serde_json::to_string(&PersistedToolResult {
                id: tc.id.clone(),
                name: tc.name.clone(),
                arguments: tc.arguments.clone(),
                risk_level: effective_risk,
                summary: exec.summary.clone(),
                success: exec.success,
                blocked: exec.blocked,
            }).ok();
            let _ = conv_db.save_message(
                &conversation_id,
                "tool",
                &exec.output,
                &Utc::now().to_rfc3339(),
                tool_result_json.as_deref(),
                None,
            );
        }
    }

    // Exceeded max rounds
    let _ = app.emit(
        &event_name,
        StreamEvent::Error {
            message: format!("Agent 达到最大执行轮数 ({MAX_TOOL_ROUNDS})，已停止"),
        },
    );
}
