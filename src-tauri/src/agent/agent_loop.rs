use std::collections::HashMap;
use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, oneshot};

use crate::agent::conversation::ConversationDb;
use crate::agent::runtime::{AgentMode, AgentStatus};
use crate::agent::sandbox::{assess_risk, RiskLevel, Sandbox};
use crate::agent::thinking_filter::strip_thinking_tags;
use crate::agent::tools::{ToolContext, ToolOutput, ToolRegistry};
use crate::agent::plan_handler::{build_plan_context, handle_plan_tool_output};
use crate::config::settings::{AgentModeSettings, CommandListMode};
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ToolCall, ToolDefinition};
use crate::llm::streaming::StreamEvent;
use crate::ssh::connection::SshManagerClone;
use crate::AppState;

/// 持久化的工具调用元数据，包含工具调用详情和计算的风险等级。
///
/// **废弃**：assistant 消息不再保存 tool_calls_json。此结构体仅保留
/// 用于解析旧历史数据。新消息通过 `PersistedToolResult`（role=tool）
/// 保存工具调用完整信息。
#[allow(dead_code)]
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedToolCall {
    /// 原始工具调用数据（id、name、arguments），序列化时展开为扁平字段。
    #[serde(flatten)]
    pub tool_call: ToolCall,
    /// 该工具调用在保存时计算的实际风险等级（由 sandbox 评估）。
    pub risk_level: RiskLevel,
}

/// 持久化的工具执行结果元数据（存入 role=tool 的 tool_calls_json）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
struct PersistedToolResult {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    pub risk_level: RiskLevel,
    pub summary: String,
    pub success: bool,
    pub blocked: bool,
}

/// Maximum number of consecutive LLM ↔ tool-execution round-trips per task.
/// Prevents runaway loops.
const MAX_TOOL_ROUNDS: usize = 50;

/// Approval timeout for any tool call requiring user confirmation.
const APPROVAL_TIMEOUT_SECS: u64 = 60;

/// Event containing a tool call result, sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolResultEvent {
    #[serde(rename = "type")]
    event_type: String,
    tool_call_id: String,
    tool_name: String,
    /// Tool call arguments, for display in the tool card.
    arguments: serde_json::Value,
    /// Short human-readable summary for the card header.
    summary: String,
    /// Full output returned to the LLM (may be long).
    result: String,
    /// Whether the tool execution succeeded.
    success: bool,
    /// Whether the command was blocked by policy.
    blocked: bool,
}

/// Event requesting user approval for a tool call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApprovalRequestEvent {
    #[serde(rename = "type")]
    event_type: String,
    tool_call_id: String,
    tool_name: String,
    arguments: serde_json::Value,
    risk_level: RiskLevel,
}

// ──────────────────────── Agent Loop ────────────────────────

/// 检查任务是否已被用户取消。
fn is_task_cancelled(state: &AppState, task_id: &str) -> bool {
    state
        .agent_tasks
        .read()
        .get(task_id)
        .map_or(false, |t| t.status == AgentStatus::Cancelled)
}

/// The main agentic loop:
///   LLM call → tool_calls? → execute → feed result → repeat
#[allow(clippy::too_many_arguments)]
pub(crate) async fn run_agent_loop(
    task_id: String,
    provider: OpenAiProvider,
    mut messages: Vec<LlmMessage>,
    tools: Vec<ToolDefinition>,
    mode: AgentMode,
    agent_settings: AgentModeSettings,
    ssh: SshManagerClone,
    session_id: String,
    app: AppHandle,
    state: AppState,
    registry: std::sync::Arc<ToolRegistry>,
    conversation_id: String,
    conv_db: std::sync::Arc<ConversationDb>,
) {
    let event_name = format!("agent://stream/{}", task_id);

    // Auto-update conversation title from the current prompt (last user message).
    if let Some(msg) = messages.iter().rev().find(|m| m.role == LlmRole::User && !m.content.is_empty()) {
        let title = msg.content.chars().take(30).collect::<String>();
        let _ = conv_db.update_conversation_title(&conversation_id, &title);
    }

    // Persist only the current prompt (the last user message).
    // History messages were already persisted in previous tasks.
    if let Some(msg) = messages.iter().rev().find(|m| m.role == LlmRole::User) {
        if !msg.content.is_empty() {
            let _ = conv_db.save_message(&conversation_id, "user", &msg.content, &Utc::now().to_rfc3339(), None);
        }
    }

    for round in 0..MAX_TOOL_ROUNDS {
        log::info!("Agent {} round {}", task_id, round);

        // Check if task has been cancelled by the user
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
            // No tool calls — final answer. We're done.
            let cleaned_content = strip_thinking_tags(&assistant_msg.content);
            let cleaned_msg = LlmMessage {
                content: cleaned_content,
                ..assistant_msg
            };
            messages.push(cleaned_msg.clone());
            // Persist assistant message to DB
            let _ = conv_db.save_message(&conversation_id, "assistant", &cleaned_msg.content, &Utc::now().to_rfc3339(), None);
            let _ = app.emit(&event_name, StreamEvent::Done);
            return;
        }

        // 3. Add assistant message (with tool_calls) to history
        // Build risk map once — reused when saving each tool result (step 7).
        let risk_map: HashMap<String, RiskLevel> = tool_calls
            .iter()
            .map(|tc| {
                let risk = match tc.name.as_str() {
                    "execute_command" => tc
                        .arguments
                        .get("command")
                        .and_then(|v| v.as_str())
                        .map(assess_risk)
                        .unwrap_or_else(|| {
                            registry.get(&tc.name)
                                .map(|t| t.risk_level())
                                .unwrap_or(RiskLevel::Moderate)
                        }),
                    _ => registry
                        .get(&tc.name)
                        .map(|t| t.risk_level())
                        .unwrap_or(RiskLevel::Moderate),
                };
                (tc.id.clone(), risk)
            })
            .collect();

        // Persist assistant message to DB (even if empty, to maintain conversation history order).
        // The tool result messages (role=tool) carry the complete tool call metadata
        // needed for rendering tool call cards in conversation history.
        let _ = conv_db.save_message(&conversation_id, "assistant", &assistant_msg.content, &Utc::now().to_rfc3339(), None);
        messages.push(assistant_msg);

        // 4. Execute each tool call via the registry
        let ctx = ToolContext::new(ssh.clone(), session_id.clone(), app.clone());
        for tc in &tool_calls {
            // Check cancellation before executing each tool call
            if is_task_cancelled(&state, &task_id) {
                log::info!("Agent task {} cancelled before tool execution, stopping", task_id);
                let _ = app.emit(&event_name, StreamEvent::Done);
                return;
            }

            let exec = dispatch_tool_call_with_meta(
                tc,
                &mode,
                &agent_settings,
                &ctx,
                &app,
                &event_name,
                &state,
                &registry,
            )
            .await;

            // Check cancellation after tool execution (for long-running tools)
            if is_task_cancelled(&state, &task_id) {
                log::info!("Agent task {} cancelled after tool execution, stopping", task_id);
                let _ = app.emit(&event_name, StreamEvent::Done);
                return;
            }

            // Emit structured tool result to frontend (for tool call cards)
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
            // Reuse pre-computed risk from step 3 — no need to recalculate.
            let effective_risk = risk_map.get(&tc.id)
                .copied()
                .unwrap_or_else(|| {
                    registry.get(&tc.name)
                        .map(|t| t.risk_level())
                        .unwrap_or(RiskLevel::Moderate)
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
            );
        }

        // Loop continues — the LLM will see the tool results and decide what to do next
    }

    // Exceeded max rounds
    let _ = app.emit(
        &event_name,
        StreamEvent::Error {
            message: format!("Agent 达到最大执行轮数 ({MAX_TOOL_ROUNDS})，已停止"),
        },
    );
}

// ──────────────────────── Tool Dispatch ────────────────────────

/// Result of executing a single tool call (UI/event view).
struct DispatchResult {
    /// Short summary for the UI card.
    summary: String,
    /// Full output to feed back to the LLM.
    output: String,
    success: bool,
    blocked: bool,
    metadata: Option<serde_json::Value>,
}

impl DispatchResult {
    fn from_tool_output(o: ToolOutput) -> Self {
        Self {
            summary: o.summary,
            output: o.output,
            success: o.success,
            blocked: false,
            metadata: o.metadata,
        }
    }
    fn blocked(summary: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            summary: summary.into(),
            output: format!("BLOCKED: {}", reason.into()),
            success: false,
            blocked: true,
            metadata: None,
        }
    }
    fn unknown(name: &str) -> Self {
        Self {
            summary: format!("unknown tool: {}", name),
            output: format!("Unknown tool: {}", name),
            success: false,
            blocked: false,
            metadata: None,
        }
    }
}

/// Dispatch a single tool call through the registry, applying mode-aware
/// security policy and (when needed) waiting for user approval.
/// Returns a `DispatchResult` that includes the tool output metadata.
#[allow(clippy::too_many_arguments)]
async fn dispatch_tool_call_with_meta(
    tc: &ToolCall,
    mode: &AgentMode,
    agent_settings: &AgentModeSettings,
    ctx: &ToolContext,
    app: &AppHandle,
    event_name: &str,
    state: &AppState,
    registry: &ToolRegistry,
) -> DispatchResult {
    // 0. Look up the tool
    let Some(tool) = registry.get(&tc.name) else {
        return DispatchResult::unknown(&tc.name);
    };

    // 1. Compute the effective risk level for this specific invocation.
    //    For `execute_command` we look at the command text; otherwise we
    //    use the tool's declared risk_level.
    let effective_risk = match tc.name.as_str() {
        "execute_command" => tc
            .arguments
            .get("command")
            .and_then(|v| v.as_str())
            .map(assess_risk)
            .unwrap_or_else(|| tool.risk_level()),
        _ => tool.risk_level(),
    };

    // 2. Mode-aware policy gate.
    //    - CHAT  : no tools allowed (defense-in-depth; the LLM also has no tools)
    //    - AUTO  : execute everything; only the sandbox can block
    //    - AGENT : full policy
    match mode {
        AgentMode::Chat => {
            return DispatchResult::blocked(
                format!("{}", tc.name),
                "CHAT 模式禁止工具调用".to_string(),
            );
        }
        AgentMode::Auto => {
            // Sandbox still applies to execute_command in Auto mode
            // (truly destructive patterns are always rejected).
            if tc.name == "execute_command" {
                if let Some(cmd) = tc.arguments.get("command").and_then(|v| v.as_str()) {
                    let sb = Sandbox::default();
                    if let Err(e) = sb.check_command(cmd) {
                        return DispatchResult::blocked(format!("$ {}", cmd), e.to_string());
                    }
                }
            }
        }
        AgentMode::Agent => {
            // Apply allow/deny list policy specifically for execute_command.
            if tc.name == "execute_command" {
                let cmd = tc.arguments.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let sb = Sandbox::default();
                if let Err(e) = sb.check_command(cmd) {
                    return DispatchResult::blocked(format!("$ {}", cmd), e.to_string());
                }
                let needs_confirm = command_list_requires_confirm(cmd, agent_settings);
                if needs_confirm
                    && !await_user_approval(
                        tc, effective_risk, app, event_name, state,
                    )
                    .await
                {
                    return DispatchResult::blocked(
                        format!("$ {}", cmd),
                        "用户拒绝或确认超时",
                    );
                }
            } else {
                // For non-shell tools: gate on declared risk level.
                // ReadOnly tools never require confirmation. Anything Moderate
                // or higher requires confirmation when `confirm_each_command`
                // is enabled (and always for HighRisk / Destructive).
                let needs_confirm = match effective_risk {
                    RiskLevel::ReadOnly => false,
                    RiskLevel::LowRisk => agent_settings.confirm_each_command,
                    RiskLevel::Moderate => agent_settings.confirm_each_command,
                    RiskLevel::HighRisk | RiskLevel::Destructive => true,
                };
                if needs_confirm
                    && !await_user_approval(
                        tc, effective_risk, app, event_name, state,
                    )
                    .await
                {
                    return DispatchResult::blocked(
                        tc.name.clone(),
                        "用户拒绝或确认超时",
                    );
                }
            }
        }
    }

    // 3. Execute the tool through the registry.
    match tool.execute(tc.arguments.clone(), ctx).await {
        Ok(out) => DispatchResult::from_tool_output(out),
        Err(e) => DispatchResult {
            summary: format!("{} (error)", tc.name),
            output: format!("tool error: {}", e),
            success: false,
            blocked: false,
            metadata: None,
        },
    }
}

/// Return whether `execute_command` needs user approval based on the
/// allowlist/denylist configuration.
fn command_list_requires_confirm(
    cmd: &str,
    settings: &AgentModeSettings,
) -> bool {
    let base = cmd
        .trim()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .rsplit('/')
        .next()
        .unwrap_or("");
    let in_list = settings.command_list.iter().any(|c| c == base);
    match settings.list_mode {
        CommandListMode::Allowlist => {
            if in_list {
                settings.confirm_each_command
            } else {
                true
            }
        }
        CommandListMode::Denylist => {
            if in_list {
                true
            } else {
                settings.confirm_each_command
            }
        }
    }
}

/// Send an approval-request event to the frontend and await the user's
/// decision (or timeout).
async fn await_user_approval(
    tc: &ToolCall,
    risk: RiskLevel,
    app: &AppHandle,
    event_name: &str,
    state: &AppState,
) -> bool {
    let approval_id = tc.id.clone();
    let _ = app.emit(
        event_name,
        ApprovalRequestEvent {
            event_type: "approvalRequest".to_string(),
            tool_call_id: approval_id.clone(),
            tool_name: tc.name.clone(),
            arguments: tc.arguments.clone(),
            risk_level: risk,
        },
    );

    // Send Windows Toast notification
    let risk_label = match risk {
        RiskLevel::ReadOnly => "只读",
        RiskLevel::LowRisk => "低风险",
        RiskLevel::Moderate => "中风险",
        RiskLevel::HighRisk => "高风险",
        RiskLevel::Destructive => "破坏性",
    };
    let notification_body = format!(
        "工具: {}\n风险等级: {}\n点击查看详情",
        tc.name, risk_label
    );

    if let Err(e) = app.notification()
        .builder()
        .title("Agent 需要您的批准")
        .body(&notification_body)
        .show()
    {
        log::warn!("发送通知失败: {}", e);
    }

    let (tx, rx) = oneshot::channel();
    state.pending_approvals.write().insert(approval_id.clone(), tx);

    match tokio::time::timeout(
        std::time::Duration::from_secs(APPROVAL_TIMEOUT_SECS),
        rx,
    )
    .await
    {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => false,
        Err(_) => {
            state.pending_approvals.write().remove(&approval_id);
            false
        }
    }
}
