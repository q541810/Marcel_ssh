use chrono::Utc;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, oneshot};
use uuid::Uuid;

use crate::agent::runtime::{AgentMode, AgentStatus, AgentTask};
use crate::agent::sandbox::{assess_risk, RiskLevel, Sandbox};
use crate::config::settings::CommandListMode;
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ProviderType, ToolCall, ToolDefinition};
use crate::llm::streaming::StreamEvent;
use crate::ssh::connection::SshManagerClone;
use crate::AppState;

/// Maximum number of consecutive LLM ↔ tool-execution round-trips per task.
/// Prevents runaway loops.
const MAX_TOOL_ROUNDS: usize = 30;

// ──────────────────────── Tauri Commands ────────────────────────

/// Start a new agent task.
///
/// This is the **core** of Marcel SSH's Agent system. It:
///   1. Builds a conversation from history + system prompt
///   2. Calls the LLM (streaming)
///   3. If the LLM returns tool_calls → evaluates policy → executes via SSH
///      → feeds results back → loops until the LLM gives a final text answer
///   4. All progress is pushed as `agent://stream/{taskId}` events
#[tauri::command]
pub async fn agent_start_task(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    prompt: String,
    mode: AgentMode,
    history: Vec<LlmMessage>,
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
    let (llm_config, agent_settings) = {
        let settings = state.settings.read().await;
        (
            settings.llm_config.clone(),
            settings.agent_mode_settings.clone(),
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
    let system_prompt = build_system_prompt(&mode, &session_id);
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

    // Choose which tools to expose based on mode
    let tools: Vec<ToolDefinition> = match mode {
        AgentMode::Chat => vec![], // No tools in chat mode
        AgentMode::Agent | AgentMode::Auto => build_tool_definitions(),
    };

    // Clone what the spawned task needs
    let ssh = state.ssh_manager.clone_inner();
    let task_id_spawn = task_id.clone();
    let mode_spawn = mode.clone();
    let app_spawn = app.clone();
    let state_spawn = state.inner().clone();

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
    
    // Find and trigger the pending approval
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
    
    // Find and trigger the pending approval
    let sender = state.pending_approvals.write().remove(&operation_id);
    if let Some(tx) = sender {
        let _ = tx.send(false);
    }
    
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
) {
    let event_name = format!("agent://stream/{}", task_id);

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
            messages.push(assistant_msg);
            let _ = app.emit(&event_name, StreamEvent::Done);
            return;
        }

        // 3. Add assistant message (with tool_calls) to history
        messages.push(assistant_msg);

        // 4. Execute each tool call
        for tc in &tool_calls {
            let exec = execute_tool_call(
                tc,
                &mode,
                &agent_settings,
                &ssh,
                &session_id,
                &app,
                &event_name,
                &state,
            )
            .await;

            // Emit structured tool result to frontend (for tool call cards)
            let _ = app.emit(
                &event_name,
                ToolResultEvent {
                    tool_call_id: tc.id.clone(),
                    tool_name: tc.name.clone(),
                    summary: exec.summary,
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

/// Result of executing a single tool call.
struct ToolExecResult {
    /// Short summary for the card (e.g. "$ ls -la /tmp")
    summary: String,
    /// Full output to feed back to the LLM
    output: String,
    success: bool,
    blocked: bool,
}

/// Execute a single tool call.
async fn execute_tool_call(
    tc: &ToolCall,
    mode: &AgentMode,
    agent_settings: &crate::config::settings::AgentModeSettings,
    ssh: &SshManagerClone,
    session_id: &str,
    app: &AppHandle,
    event_name: &str,
    state: &AppState,
) -> ToolExecResult {
    match tc.name.as_str() {
        "execute_command" => {
            let cmd = tc
                .arguments
                .get("command")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            if cmd.is_empty() {
                return ToolExecResult {
                    summary: "execute_command (empty)".into(),
                    output: "Error: missing 'command' argument".into(),
                    success: false,
                    blocked: false,
                };
            }

            // ── Security policy check (AGENT mode only) ──
            if *mode == AgentMode::Agent {
                let base = cmd
                    .trim()
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .rsplit('/')
                    .next()
                    .unwrap_or("");
                let in_list = agent_settings.command_list.iter().any(|c| c == base);

                // Sandbox always applies
                let sandbox = Sandbox::default();
                if let Err(e) = sandbox.check_command(cmd) {
                    return ToolExecResult {
                        summary: format!("$ {}", cmd),
                        output: format!("BLOCKED: 安全沙箱阻止: {}", e),
                        success: false,
                        blocked: true,
                    };
                }

                // Determine whether this command needs user confirmation
                let needs_confirm = match agent_settings.list_mode {
                    // Allowlist: in list → direct execute; not in list → ask user
                    CommandListMode::Allowlist => {
                        if in_list { agent_settings.confirm_each_command } else { true }
                    }
                    // Denylist: in list → ask user; not in list → direct execute
                    CommandListMode::Denylist => {
                        if in_list { true } else { agent_settings.confirm_each_command }
                    }
                };

                if needs_confirm {
                    let risk = assess_risk(cmd);

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

                    let approved = match tokio::time::timeout(
                        std::time::Duration::from_secs(60),
                        rx,
                    )
                    .await
                    {
                        Ok(Ok(v)) => v,
                        Ok(Err(_)) => false,
                        Err(_) => {
                            state.pending_approvals.write().remove(&approval_id);
                            return ToolExecResult {
                                summary: format!("$ {}", cmd),
                                output: "BLOCKED: 等待用户确认超时".into(),
                                success: false,
                                blocked: true,
                            };
                        }
                    };

                    if !approved {
                        return ToolExecResult {
                            summary: format!("$ {}", cmd),
                            output: "BLOCKED: 用户拒绝执行".into(),
                            success: false,
                            blocked: true,
                        };
                    }
                }
            }

            // Execute the command
            match ssh.exec_command(session_id, cmd).await {
                Ok(output) => {
                    let truncated = if output.len() > 8000 {
                        format!("{}...\n[输出过长，已截断至 8000 字节，原始 {} 字节]", &output[..8000], output.len())
                    } else {
                        output
                    };
                    ToolExecResult {
                        summary: format!("$ {}", cmd),
                        output: truncated,
                        success: true,
                        blocked: false,
                    }
                }
                Err(e) => ToolExecResult {
                    summary: format!("$ {}", cmd),
                    output: format!("执行失败: {}", e),
                    success: false,
                    blocked: false,
                },
            }
        }

        "read_file" => {
            let path = tc.arguments.get("path").and_then(|v| v.as_str()).unwrap_or("");
            if path.is_empty() {
                return ToolExecResult {
                    summary: "read_file (no path)".into(),
                    output: "Error: missing 'path' argument".into(),
                    success: false,
                    blocked: false,
                };
            }
            let cmd = format!("cat {}", shell_escape(path));
            match ssh.exec_command(session_id, &cmd).await {
                Ok(content) => {
                    let truncated = if content.len() > 16000 {
                        format!("{}...\n[已截断]", &content[..16000])
                    } else {
                        content
                    };
                    ToolExecResult {
                        summary: format!("读取 {}", path),
                        output: truncated,
                        success: true,
                        blocked: false,
                    }
                }
                Err(e) => ToolExecResult {
                    summary: format!("读取 {}", path),
                    output: format!("读取失败: {}", e),
                    success: false,
                    blocked: false,
                },
            }
        }

        "write_file" => {
            let path = tc.arguments.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let content = tc.arguments.get("content").and_then(|v| v.as_str()).unwrap_or("");
            if path.is_empty() {
                return ToolExecResult {
                    summary: "write_file (no path)".into(),
                    output: "Error: missing 'path' argument".into(),
                    success: false,
                    blocked: false,
                };
            }
            let lines = content.lines().count();
            let cmd = format!(
                "cat > {} << 'MARCEL_EOF'\n{}\nMARCEL_EOF",
                shell_escape(path), content
            );
            match ssh.exec_command(session_id, &cmd).await {
                Ok(_) => ToolExecResult {
                    summary: format!("写入 {} (+{} 行)", path, lines),
                    output: format!("成功写入 {} 字节到 {}", content.len(), path),
                    success: true,
                    blocked: false,
                },
                Err(e) => ToolExecResult {
                    summary: format!("写入 {}", path),
                    output: format!("写入失败: {}", e),
                    success: false,
                    blocked: false,
                },
            }
        }

        "list_directory" => {
            let path = tc.arguments.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let cmd = format!("ls -la {}", shell_escape(path));
            match ssh.exec_command(session_id, &cmd).await {
                Ok(output) => ToolExecResult {
                    summary: format!("列出 {}", path),
                    output,
                    success: true,
                    blocked: false,
                },
                Err(e) => ToolExecResult {
                    summary: format!("列出 {}", path),
                    output: format!("失败: {}", e),
                    success: false,
                    blocked: false,
                },
            }
        }

        "search_files" => {
            let pattern = tc.arguments.get("pattern").and_then(|v| v.as_str()).unwrap_or("");
            let path = tc.arguments.get("path").and_then(|v| v.as_str()).unwrap_or(".");
            let cmd = format!("grep -rn --include='*' {} {}", shell_escape(pattern), shell_escape(path));
            match ssh.exec_command(session_id, &cmd).await {
                Ok(output) => {
                    let count = output.lines().count();
                    ToolExecResult {
                        summary: format!("搜索 '{}' ({} 处匹配)", pattern, count),
                        output,
                        success: true,
                        blocked: false,
                    }
                }
                Err(e) => ToolExecResult {
                    summary: format!("搜索 '{}'", pattern),
                    output: format!("搜索失败: {}", e),
                    success: false,
                    blocked: false,
                },
            }
        }

        "system_info" => {
            let cmd = "uname -a && echo '---' && uptime && echo '---' && free -h && echo '---' && df -h";
            match ssh.exec_command(session_id, cmd).await {
                Ok(output) => ToolExecResult {
                    summary: "系统信息".into(),
                    output,
                    success: true,
                    blocked: false,
                },
                Err(e) => ToolExecResult {
                    summary: "系统信息".into(),
                    output: format!("获取失败: {}", e),
                    success: false,
                    blocked: false,
                },
            }
        }

        other => ToolExecResult {
            summary: format!("未知工具: {}", other),
            output: format!("Unknown tool: {}", other),
            success: false,
            blocked: false,
        },
    }
}

/// Simple shell escaping: wrap in single quotes.
fn shell_escape(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

// ──────────────────────── Tool Definitions ────────────────────────

fn build_tool_definitions() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "execute_command".into(),
            description: "Execute a shell command on the remote server. Returns stdout+stderr.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The shell command to execute"
                    }
                },
                "required": ["command"]
            }),
        },
        ToolDefinition {
            name: "read_file".into(),
            description: "Read the contents of a file on the remote server.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file"
                    }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "write_file".into(),
            description: "Write content to a file on the remote server. Creates or overwrites.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the file"
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write"
                    }
                },
                "required": ["path", "content"]
            }),
        },
        ToolDefinition {
            name: "list_directory".into(),
            description: "List files and directories at a path.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute path to the directory (default: current directory)"
                    }
                },
                "required": ["path"]
            }),
        },
        ToolDefinition {
            name: "search_files".into(),
            description: "Search for a text pattern in files under a directory (grep).".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Text or regex pattern to search for"
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search in (default: current directory)"
                    }
                },
                "required": ["pattern"]
            }),
        },
        ToolDefinition {
            name: "system_info".into(),
            description: "Get system information: OS, uptime, memory, disk usage.".into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {},
                "required": []
            }),
        },
    ]
}

fn build_system_prompt(mode: &AgentMode, session_id: &str) -> String {
    let base = format!(
        "You are Marcel, an AI assistant embedded in an SSH terminal client. \
         The user is connected to SSH session (id={session_id}). \
         Respond in the same language as the user. Be concise."
    );
    match mode {
        AgentMode::Chat => format!(
            "{base}\n\nYou are in CHAT mode. Do NOT call any tools. Only answer questions."
        ),
        AgentMode::Agent => format!(
            "{base}\n\nYou are in AGENT mode. You have tools to execute commands, read/write files, \
             list directories, and get system info on the remote server. Use them when needed. \
             Some commands may be blocked by the user's security policy."
        ),
        AgentMode::Auto => format!(
            "{base}\n\nYou are in AUTO mode. Execute tools freely without asking for confirmation. \
             Be efficient but cautious with destructive operations."
        ),
    }
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
