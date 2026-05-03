use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::agent::conversation::Conversation;
use crate::agent::runtime::{AgentMode, AgentStatus, AgentTask};
use crate::agent::sandbox::{assess_risk, RiskLevel, Sandbox};
use crate::agent::tools::{ToolContext, ToolOutput, ToolRegistry};
use crate::config::settings::{CommandListMode, AgentModeSettings};
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ProviderType, ToolCall, ToolDefinition};
use crate::llm::streaming::StreamEvent;
use crate::ssh::connection::SshManagerClone;
use crate::AppState;

/// Maximum number of consecutive LLM ↔ tool-execution round-trips per task.
/// Prevents runaway loops.
const MAX_TOOL_ROUNDS: usize = 50;

/// Approval timeout for any tool call requiring user confirmation.
const APPROVAL_TIMEOUT_SECS: u64 = 60;

// ──────────────────────── Tauri Commands ────────────────────────

/// Start a new agent task.
///
/// This is the **core** of Marcel SSH's Agent system. It:
///   1. Builds a conversation from history + system prompt
///   2. Calls the LLM (streaming)
///   3. If the LLM returns tool_calls → evaluates policy → executes via the
///      [`ToolRegistry`] → feeds results back → loops until the LLM gives a
///      final text answer
///   4. All progress is pushed as `agent://stream/{taskId}` events
#[tauri::command]
pub async fn agent_start_task(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    prompt: String,
    mode: AgentMode,
    history: Vec<LlmMessage>,
    conversation_id: String,
) -> Result<String, AppError> {
    let task_id = Uuid::new_v4().to_string();

    let task = AgentTask {
        id: task_id.clone(),
        session_id: session_id.clone(),
        prompt: prompt.clone(),
        mode: mode.clone(),
        status: AgentStatus::Planning,
        created_at: Utc::now(),
    };
    state.agent_tasks.write().insert(task_id.clone(), task);

    // Snapshot config
    let (llm_config, agent_settings, sandbox) = {
        let settings = state.settings.read().await;
        (
            settings.llm_config.clone(),
            settings.agent_mode_settings.clone(),
            Sandbox::default(),
        )
    };

    let Some(llm_config) = llm_config else {
        return Err(AppError::Llm("尚未配置 LLM，请前往设置填写".into()));
    };
    if llm_config.provider_type != ProviderType::OpenAI {
        return Err(AppError::Llm("当前仅支持 OpenAI 兼容 Provider".into()));
    }

    let provider = OpenAiProvider::new(llm_config)?;

    // Build initial messages
    let system_prompt = build_system_prompt(&mode, &session_id, &agent_settings, &sandbox);
    let mut messages: Vec<LlmMessage> = Vec::with_capacity(history.len() + 2);
    messages.push(LlmMessage::system(system_prompt));
    for msg in &history {
        if msg.role == LlmRole::System {
            continue;
        }
        messages.push(msg.clone());
    }
    if !messages.last().map_or(false, |m| m.role == LlmRole::User && m.content == prompt) {
        messages.push(LlmMessage::user(prompt.clone()));
    }

    // Build the registry once and reuse it for both tool advertisement
    // and dispatch. This keeps definitions and execution in sync.
    let registry = std::sync::Arc::new(ToolRegistry::with_builtins());

    // Choose which tools to expose based on mode
    let tools: Vec<ToolDefinition> = match mode {
        AgentMode::Chat => vec![], // No tools in chat mode
        AgentMode::Agent | AgentMode::Auto => registry
            .definitions()
            .into_iter()
            .map(|d| ToolDefinition {
                name: d.name,
                description: d.description,
                parameters: d.parameters,
            })
            .collect(),
    };

    // Clone what the spawned task needs
    let ssh = state.ssh_manager.clone_inner();
    let task_id_spawn = task_id.clone();
    let mode_spawn = mode.clone();
    let app_spawn = app.clone();
    let state_spawn = state.inner().clone();
    let registry_spawn = registry.clone();
    let conversation_id_spawn = conversation_id.clone();
    let conv_db_spawn = state.conversation_db.clone();

    tokio::spawn(async move {
        run_agent_loop(
            task_id_spawn,
            provider,
            messages,
            tools,
            mode_spawn,
            agent_settings,
            ssh,
            session_id,
            app_spawn,
            state_spawn,
            registry_spawn,
            conversation_id_spawn,
            conv_db_spawn,
        )
        .await;
    });

    log::info!("Agent task started: {} ({:?})", task_id, mode);
    Ok(task_id)
}

/// Stop (cancel) a running agent task.
#[tauri::command]
pub async fn agent_stop_task(
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), AppError> {
    let mut tasks = state.agent_tasks.write();
    match tasks.get_mut(&task_id) {
        Some(task) => {
            task.status = AgentStatus::Cancelled;
            Ok(())
        }
        None => Err(AppError::Agent(format!("Task not found: {}", task_id))),
    }
}

/// Approve a pending agent operation.
#[tauri::command]
pub async fn agent_approve_operation(
    state: State<'_, AppState>,
    _task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    log::info!("Operation approved: op={}", operation_id);
    let sender = state.pending_approvals.write().remove(&operation_id);
    if let Some(tx) = sender {
        let _ = tx.send(true);
    }
    Ok(())
}

/// Reject a pending agent operation.
#[tauri::command]
pub async fn agent_reject_operation(
    state: State<'_, AppState>,
    _task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    log::info!("Operation rejected: op={}", operation_id);
    let sender = state.pending_approvals.write().remove(&operation_id);
    if let Some(tx) = sender {
        let _ = tx.send(false);
    }

    Ok(())
}

/// Create a new AI conversation for the given SSH session.
#[tauri::command]
pub async fn agent_create_conversation(
    state: State<'_, AppState>,
    session_id: String,
    title: Option<String>,
) -> Result<String, AppError> {
    let connection_id = state
        .ssh_manager
        .get_connection_id(&session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    let title = title.unwrap_or_else(|| "新会话".to_string());
    let conversation = state
        .conversation_db
        .create_conversation(&connection_id, &title)
        .map_err(|e| AppError::Agent(format!("Failed to create conversation: {}", e)))?;
    log::info!("Created conversation: {} (connection={})", conversation.id, connection_id);
    Ok(conversation.id)
}

/// List all conversations for a given SSH session.
#[tauri::command]
pub async fn agent_list_conversations(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Conversation>, AppError> {
    let connection_id = state
        .ssh_manager
        .get_connection_id(&session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    let conversations = state
        .conversation_db
        .list_conversations(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to list conversations: {}", e)))?;
    Ok(conversations)
}

/// Load all messages for a conversation.
#[tauri::command]
pub async fn agent_load_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<crate::agent::conversation::StoredMessage>, AppError> {
    let messages = state
        .conversation_db
        .load_messages(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to load messages: {}", e)))?;
    Ok(messages)
}

/// Delete a single conversation.
#[tauri::command]
pub async fn agent_delete_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), AppError> {
    state
        .conversation_db
        .delete_conversation(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to delete conversation: {}", e)))?;
    log::info!("Deleted conversation: {}", conversation_id);
    Ok(())
}

/// List all conversations for a given connection config ID (persistent, works without active session).
#[tauri::command]
pub async fn agent_list_conversations_by_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<Conversation>, AppError> {
    let conversations = state
        .conversation_db
        .list_conversations(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to list conversations: {}", e)))?;
    Ok(conversations)
}

/// Delete all conversations for a given SSH session.
#[tauri::command]
pub async fn agent_delete_conversations_by_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    let connection_id = state
        .ssh_manager
        .get_connection_id(&session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    state
        .conversation_db
        .delete_conversations_by_connection(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to delete conversations by session: {}", e)))?;
    log::info!("Deleted all conversations for session: {} (connection={})", session_id, connection_id);
    Ok(())
}

/// Result of evaluating a command against the current AGENT-mode policy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCheckResult {
    pub allowed: bool,
    pub requires_confirmation: bool,
    pub risk_level: RiskLevel,
    pub reason: String,
}

/// Evaluate a command against the current agent-mode settings.
#[tauri::command]
pub async fn agent_check_command(
    state: State<'_, AppState>,
    command: String,
    mode: AgentMode,
) -> Result<CommandCheckResult, AppError> {
    let trimmed = command.trim();
    let risk = assess_risk(trimmed);

    match mode {
        AgentMode::Chat => Ok(CommandCheckResult {
            allowed: false,
            requires_confirmation: false,
            risk_level: risk,
            reason: "CHAT 模式不执行任何命令".into(),
        }),
        AgentMode::Auto => Ok(CommandCheckResult {
            allowed: true,
            requires_confirmation: false,
            risk_level: risk,
            reason: "AUTO 模式自动同意所有命令".into(),
        }),
        AgentMode::Agent => {
            let settings = state.settings.read().await;
            let policy = &settings.agent_mode_settings;
            let base = trimmed
                .split_whitespace()
                .next()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("");
            let in_list = policy.command_list.iter().any(|c| c == base);

            match policy.list_mode {
                CommandListMode::Allowlist => {
                    if in_list {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: policy.confirm_each_command,
                            risk_level: risk,
                            reason: format!("'{}' 在白名单中", base),
                        })
                    } else {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: true,
                            risk_level: risk,
                            reason: format!("'{}' 不在白名单中，需要用户确认", base),
                        })
                    }
                }
                CommandListMode::Denylist => {
                    if in_list {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: true,
                            risk_level: risk,
                            reason: format!("'{}' 在黑名单中，需要用户确认", base),
                        })
                    } else {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: policy.confirm_each_command,
                            risk_level: risk,
                            reason: format!("'{}' 不在黑名单中", base),
                        })
                    }
                }
            }
        }
    }
}

// ──────────────────────── Agent Loop ────────────────────────

/// The main agentic loop:
///   LLM call → tool_calls? → execute → feed result → repeat
#[allow(clippy::too_many_arguments)]
async fn run_agent_loop(
    task_id: String,
    provider: OpenAiProvider,
    mut messages: Vec<LlmMessage>,
    tools: Vec<ToolDefinition>,
    mode: AgentMode,
    agent_settings: crate::config::settings::AgentModeSettings,
    ssh: SshManagerClone,
    session_id: String,
    app: AppHandle,
    state: AppState,
    registry: std::sync::Arc<ToolRegistry>,
    conversation_id: String,
    conv_db: std::sync::Arc<crate::agent::conversation::ConversationDb>,
) {
    let event_name = format!("agent://stream/{}", task_id);

    // Auto-update conversation title if it's still the default "新会话"
    for msg in &messages {
        if msg.role == LlmRole::User && !msg.content.is_empty() {
            let title = msg.content.chars().take(30).collect::<String>();
            let _ = conv_db.update_conversation_title(&conversation_id, &title);
            break;
        }
    }

    // Persist user messages from history that are not yet saved
    for msg in &messages {
        if msg.role == LlmRole::User && !msg.content.is_empty() {
            let _ = conv_db.save_message(&conversation_id, "user", &msg.content, &Utc::now().to_rfc3339());
        }
    }

    for round in 0..MAX_TOOL_ROUNDS {
        log::info!("Agent {} round {}", task_id, round);

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
            messages.push(assistant_msg.clone());
            // Persist assistant message to DB
            let _ = conv_db.save_message(&conversation_id, "assistant", &assistant_msg.content, &Utc::now().to_rfc3339());
            let _ = app.emit(&event_name, StreamEvent::Done);
            return;
        }

        // 3. Add assistant message (with tool_calls) to history
        // Persist assistant message content (without tool_calls JSON) to DB
        let assistant_text = if assistant_msg.content.is_empty() {
            format!("[调用工具: {}]", tool_calls.iter().map(|t| t.name.as_str()).collect::<Vec<_>>().join(", "))
        } else {
            assistant_msg.content.clone()
        };
        let _ = conv_db.save_message(&conversation_id, "assistant", &assistant_text, &Utc::now().to_rfc3339());
        messages.push(assistant_msg);

        // 4. Execute each tool call via the registry
        let ctx = ToolContext::new(ssh.clone(), session_id.clone(), app.clone());
        for tc in &tool_calls {
            let exec = dispatch_tool_call(
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

            // Emit structured tool result to frontend (for tool call cards)
            let _ = app.emit(
                &event_name,
                ToolResultEvent {
                    tool_call_id: tc.id.clone(),
                    tool_name: tc.name.clone(),
                    summary: exec.summary.clone(),
                    result: exec.output.clone(),
                    success: exec.success,
                    blocked: exec.blocked,
                },
            );

            // 5. Add tool result as a message for the next LLM round
            messages.push(LlmMessage {
                role: LlmRole::Tool,
                content: exec.output,
                tool_calls: None,
                tool_call_id: Some(tc.id.clone()),
            });
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

/// Result of executing a single tool call (UI/event view).
struct DispatchResult {
    /// Short summary for the UI card.
    summary: String,
    /// Full output to feed back to the LLM.
    output: String,
    success: bool,
    blocked: bool,
}

impl DispatchResult {
    fn from_tool_output(o: ToolOutput) -> Self {
        Self {
            summary: o.summary,
            output: o.output,
            success: o.success,
            blocked: false,
        }
    }
    fn blocked(summary: impl Into<String>, reason: impl Into<String>) -> Self {
        Self {
            summary: summary.into(),
            output: format!("BLOCKED: {}", reason.into()),
            success: false,
            blocked: true,
        }
    }
    fn unknown(name: &str) -> Self {
        Self {
            summary: format!("unknown tool: {}", name),
            output: format!("Unknown tool: {}", name),
            success: false,
            blocked: false,
        }
    }
}

/// Dispatch a single tool call through the registry, applying mode-aware
/// security policy and (when needed) waiting for user approval.
#[allow(clippy::too_many_arguments)]
async fn dispatch_tool_call(
    tc: &ToolCall,
    mode: &AgentMode,
    agent_settings: &crate::config::settings::AgentModeSettings,
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
        },
    }
}

/// Return whether `execute_command` needs user approval based on the
/// allowlist/denylist configuration.
fn command_list_requires_confirm(
    cmd: &str,
    settings: &crate::config::settings::AgentModeSettings,
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

// ──────────────────────── System prompt ────────────────────────

fn build_system_prompt(
    mode: &AgentMode,
    session_id: &str,
    agent_settings: &AgentModeSettings,
    sandbox: &Sandbox,
) -> String {
    let base = "关于 Marcel SSH (玛瑟尔 SSH)\n\
你是一个 AI 原生的交互式 SSH 工具，内置自主 Agent 系统，帮助用户在远程服务器上完成各种任务。使用下方的说明和可用的工具来协助用户。\n\n\
思考方式\n\
简洁直接 Concise - 直接、简洁地回答，避免不必要的话。以简洁为重点。\n\n\
语言\n\
中文 Chinese - 回答时优先使用中文，始终使用中文作为默认语言。\n\n\
输出格式\n\
直接回答问题。不要使用 markdown 代码块格式（如 json ），除非用户明确要求。\n\n\
重要：你必须用少于 4 行文本（不包括工具使用或代码生成）来回答，除非用户要求详细说明。回答要简洁，避免序言、后记或解释。除非用户询问，否则不要解释你在做什么。\n\n\
主动性\n\
你允许主动行动，但只在用户要求时才能这样做。你应该努力在以下两点之间取得平衡：\n\
- 按要求做正确的事情，包括采取行动和后续行动\n\
- 不要在未经询问的情况下让用户感到意外的行动\n\
例如，如果用户询问如何处理某事，你应该先尽力回答他们的问题，而不是立即跳到采取行动。\n\n\
可用工具\n\
你拥有以下内置工具来协助用户完成任务：\n\
- read_file - 读取远程文件内容\n\
- write_file - 写入/创建远程文件\n\
- edit_file - 编辑远程文件（diff patch）\n\
- list_directory - 列出目录内容\n\
- execute_command - 在远程 shell 执行命令\n\
- upload_file - 上传本地文件到远程\n\
- download_file - 下载远程文件到本地\n\
- search_files - 远程内容搜索\n\
- process_management - 查看/管理远程进程\n\
- system_info - 系统信息查询\n\
- web_search - 联网搜索（返回标题+摘要+链接）\n\
- http_get - 获取网页完整内容\n\n\
工具的风险等级和安全策略由系统自动评估，部分操作可能需要用户确认后才能执行。\n\n";

    let policy = sandbox.policy();
    let blocked_patterns = if policy.blocked_patterns.is_empty() {
        "无".to_string()
    } else {
        policy.blocked_patterns.join("、")
    };
    let blocked_base_commands = if policy.blocked_base_commands.is_empty() {
        "无".to_string()
    } else {
        policy.blocked_base_commands.join("、")
    };
    let protected_paths = if policy.protected_paths.is_empty() {
        "无".to_string()
    } else {
        policy.protected_paths.join("、")
    };

    let mode_str = match mode {
        AgentMode::Chat => "CHAT - 仅对话，不调用工具",
        AgentMode::Agent => "AGENT - 可调用工具，中高风险需确认",
        AgentMode::Auto => "AUTO - 全自主执行，无需确认",
    };

    let list_mode_str = match agent_settings.list_mode {
        CommandListMode::Allowlist => "白名单（仅列表中的命令允许）",
        CommandListMode::Denylist => "黑名单（列表中的命令拦截）",
    };

    let command_list = if agent_settings.command_list.is_empty() {
        "无".to_string()
    } else {
        agent_settings.command_list.join("、")
    };

    let confirm_label = if agent_settings.confirm_each_command { "是" } else { "否" };

    let policy_section = format!(
        "安全策略\n\
当前安全策略由系统配置自动生成：\n\
- 当前模式：{}\n\
- 命令列表模式：{}\n\
- 命令列表内容：{}\n\
- 每次命令是否确认：{}\n\
- 每任务最大命令数：{}\n\
- 命令超时：{}s\n\
- 任务超时：{}s\n\
- 拦截的命令模式：{}\n\
- 拦截的基础命令：{}\n\
- 保护路径：{}\n\n",
        mode_str,
        list_mode_str,
        command_list,
        confirm_label,
        policy.max_commands_per_task,
        policy.command_timeout_secs,
        policy.task_timeout_secs,
        blocked_patterns,
        blocked_base_commands,
        protected_paths,
    );

    let conventions = "遵循惯例\n\
在对文件进行更改时，首先理解文件的代码惯例。模仿代码风格，使用现有的库和工具，并遵循现有的模式。\n\
永远不要假设某个给定的库是可用的，即使它很知名。每当编写使用库或框架的代码时，首先检查这个代码库是否已经使用了该库。\n\
当创建新组件时，首先查看现有组件是如何编写的；然后考虑框架选择、命名约定、类型和其他惯例。\n\
当编辑一段代码时，首先查看代码的周围上下文（特别是它的导入），以了解代码对框架和库的选择。\n\
始终遵循安全最佳实践。永远不要引入暴露或记录密钥的代码。永远不要将密钥提交到仓库。\n\n\
语气和风格\n\
你应该简洁、直接、切中要点。当你运行非平凡的 bash 命令时，你应该解释这个命令在做什么以及为什么要运行它。\n\
记住你的输出将显示在命令行界面上。你的响应不可以使用 markdown。\n\
重要：你应该最小化输出 tokens，同时保持帮助性、质量和准确性。\n\
重要：你不应该用不必要的序言或后记来回答，除非用户要求。\n\
重要：保持你的回复简短，因为它们将显示在命令行界面上。你必须用少于 4 行文字回答（不包括工具使用或代码生成），除非用户要求详细说明。\n\n";

    format!("{}\n{}当前会话：SSH session id={}\n\n{}", base, policy_section, session_id, conventions)
}

/// Serialized event for tool execution results.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolResultEvent {
    tool_call_id: String,
    tool_name: String,
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
