//! `bash` — run an arbitrary shell command on the remote server.
//!
//! Security:
//! - The [`RiskAssessor`] is consulted before execution and rejects destructive
//!   patterns regardless of agent mode.
//! - Higher-level confirmation/approval flow is implemented in
//!   `commands/agent.rs`, which wraps this tool with mode-aware policy.
//!
//! Sudo auto-fill:
//! - When a command starts with `sudo` and a password is available in the keychain,
//!   the command is rewritten to pipe the password via stdin (`sudo -S`).
//!
//! Multi-host:
//! - Optional `host` param (only meaningful when multi-host control is enabled)
//!   resolves to a target machine's session and executes there; all execution
//!   still goes through the unified `command_exec` manager. When the target is
//!   the current session no fork happens; when it differs, a forked
//!   [`ToolContext`] (same event channel / task id / policy) is used.

use async_trait::async_trait;
use serde_json::json;
use std::time::Duration;
use zeroize::Zeroize;

use crate::agent::risk::{Disposition, RiskAssessor};
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::config::keychain;
use crate::error::AppError;

/// Maximum bytes of combined stdout+stderr returned to the LLM.
const MAX_OUTPUT_BYTES: usize = 8_000;

pub struct BashTool;

impl BashTool {
    pub fn new() -> Self {
        Self
    }

    /// 执行主体（无 host 的直接路径与有 host 的换机路径共用）。
    ///
    /// `ctx` 决定目标会话（换机时由 [`AgentTool::execute`] 传入 fork 后的
    /// 上下文）；`target_label` = 多机换机时的目标机器可读名（None = 当前
    /// 会话），附加到结果 metadata 供前端卡片展示归属。
    async fn execute_inner(
        params: serde_json::Value,
        ctx: &ToolContext,
        target_label: Option<String>,
    ) -> Result<ToolOutput, AppError> {
        // 必填参数（`command` + `description`）。正常情况下 dispatcher 的预检已经在
        // 弹审批之前拦下了，走到这里说明工具被别的路径直接调起来（多机换机、测试等）
        // ——兜底要给出和预检**同一句话**（判据只有 `missing_required_argument` 一处，
        // 它已经保证 command 是非空白字符串与空命令的情形）。
        if let Some(message) = missing_required_argument(&params) {
            return Err(AppError::Agent(message));
        }

        let command = params
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent(missing_command_message()))?
            .trim();

        let run_in_background = params
            .get("run_in_background")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let description = params
            .get("description")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .trim()
            .to_string();

        let timeout_ms = params.get("timeout_ms").and_then(|v| v.as_u64());

        // 多机归属：target_label 非空时附加到结果 metadata（前端卡片 badge）。
        let attach_target = |meta: serde_json::Value| -> serde_json::Value {
            match &target_label {
                Some(label) => {
                    let mut m = meta.as_object().cloned().unwrap_or_default();
                    m.insert("targetHostLabel".to_string(), json!(label));
                    serde_json::Value::Object(m)
                }
                None => meta,
            }
        };

        // 执行前的风险评估 —— **兜底的那一道**。
        //
        // 权威判定在 `tool_dispatcher::decide_command`：它拿着同一个策略、调同一个
        // `assess_command`，所以两边不可能得出不同结论，正常情况下这里根本不会命中。
        // 保留它是因为 dispatcher 依赖 `ToolSemantics` 声明去取命令文本 —— 万一哪天
        // 声明丢了、或者工具被别的路径直接调起来，这里也得拦住。安全闸门要往
        // 「不放行」的方向倒。
        let assessor = RiskAssessor::from_optional(ctx.policy.as_deref());
        let assessment = assessor.assess_command(command);
        if assessment.disposition == Disposition::Deny {
            let reason = assessment
                .reason
                .clone()
                .unwrap_or_else(|| "判定为灾难性操作".to_string());
            return Ok(ToolOutput::fail(
                format!("$ {}", command),
                format!(
                    "BLOCKED: 命令未执行 —— {}。\n请改用更精确的目标路径重试。",
                    reason
                ),
            )
            .with_metadata(attach_target(json!({
                "blocked": true,
                "reason": reason,
            }))));
        }

        // Auto-inject password for sudo commands when running as non-root
        let mut sudo_password: Option<String> = None;
        let final_command = if is_sudo_command(command) {
            match lookup_password(ctx).await {
                Some(password) => {
                    let rewritten = rewrite_sudo(command, &password);
                    log::info!("bash: sudo auto-fill enabled for cmd='{}'", command);
                    sudo_password = Some(password);
                    rewritten
                }
                None => {
                    log::debug!(
                        "bash: no password found for sudo auto-fill (session={})",
                        ctx.session_id
                    );
                    command.to_string()
                }
            }
        } else {
            command.to_string()
        };

        log::info!(
            "bash: disposition={:?} cmd={} bg={} final={}",
            assessment.disposition,
            command,
            run_in_background,
            if final_command != command {
                "(auto-fill)"
            } else {
                "(original)"
            }
        );

        if run_in_background {
            // 后台作业走统一命令执行体系：立即返回 job_id，输出沉淀进
            // 作业缓冲（环形 + 溢出文件），经 job_output / job_kill /
            // job_list 消费。取消注册 / 断连级联 / 执行记录与前台共用。
            let mut ticket = crate::command_exec::CommandTicket::new(
                &ctx.session_id,
                &final_command,
                crate::command_exec::CommandSource::Agent,
            )
            .display_as(command);
            if let Some(task_id) = &ctx.task_id {
                ticket = ticket.cancellable(task_id, "Agent 命令已取消");
            }
            // 归属对话：作业台账与访问围栏的键，跨应用重启仍然有效
            // （子 agent 派发的作业记在派它的父对话名下）。
            if let Some(owner) = &ctx.owner_conversation_id {
                ticket = ticket.owned_by(owner);
            }
            let job_info = ctx.submit_background(ticket, Some(description.clone())).await?;

            // Zeroize password and rewritten command immediately
            if let Some(ref mut p) = sudo_password {
                p.zeroize();
            }
            let mut cmd = final_command;
            cmd.zeroize();

            let summary = format!("$ {} (Job ID: {})", command, job_info.job_id);
            let output = format!(
                "Command started in background.\nJob ID: {}\nStatus: {}\nUse `job_output(job_id=\"{}\", wait=true)` to check output or wait for completion, and `job_kill(job_id=\"{}\")` to stop.",
                job_info.job_id, job_info.status, job_info.job_id, job_info.job_id
            );

            return Ok(
                ToolOutput::ok(summary, output).with_metadata(attach_target(json!({
                    "job_id": job_info.job_id,
                    "status": job_info.status.to_string(),
                    "description": job_info.description,
                    "run_in_background": true,
                }))),
            );
        }

        let timeout_secs = timeout_ms.map(|ms| (ms / 1000).max(1)).unwrap_or_else(|| {
            ctx.policy
                .as_ref()
                .map(|p| p.command_timeout_secs)
                .unwrap_or(180)
        });
        let timeout = Duration::from_secs(timeout_secs);

        let mut ticket = crate::command_exec::CommandTicket::new(
            &ctx.session_id,
            &final_command,
            crate::command_exec::CommandSource::Agent,
        )
        .display_as(command)
        .timeout(timeout);
        if let Some(task_id) = &ctx.task_id {
            ticket = ticket.cancellable(task_id, "Agent 命令已取消");
        }
        if let (Some(tool_call_id), Some(event_name)) = (&ctx.tool_call_id, &ctx.event_name) {
            ticket = ticket.streaming(event_name, tool_call_id);
        }
        let exec_result = ctx.exec_ticket(ticket).await;

        // Zeroize password and rewritten command immediately after execution
        if let Some(ref mut p) = sudo_password {
            p.zeroize();
        }
        let mut cmd = final_command;
        cmd.zeroize();

        match exec_result {
            Ok(shaped) => {
                let mut truncated = truncate_output(shaped.output, MAX_OUTPUT_BYTES);
                // 退出事实紧跟在输出后面：模型必须能直接看出命令成功
                // 没有（`grep -q`、`test -f` 成功时本来就没有输出）。
                // 成功（退出码 0）不贴标记，省 token 也不制造噪音。
                if shaped.exit.is_known() && !shaped.exit.is_success() {
                    if !truncated.is_empty() && !truncated.ends_with('\n') {
                        truncated.push('\n');
                    }
                    truncated.push_str(&format!("[{}]", shaped.exit.describe()));
                }
                if shaped.was_timeout {
                    truncated.push_str(&format!(
                        "\n\n[命令超时（{} 秒）：已停止等待输出并关闭 SSH 通道，但远端进程不保证已终止——只有它之后还往 stdout/stderr 写东西时，才可能因管道断开（SIGPIPE）退出；静默运行、重定向了输出、被 nohup/setsid/& 脱离的命令会继续在服务器上运行。必要时用 ps/pgrep 确认并按需 kill 清理。]",
                        timeout_secs
                    ));
                }
                Ok(
                    ToolOutput::ok(format!("$ {}", command), truncated).with_metadata(
                        attach_target(json!({
                            "disposition": assessment.disposition.label(),
                            "was_timeout": shaped.was_timeout,
                            "exit_code": shaped.exit.code,
                            "exit_signal": shaped.exit.signal,
                        })),
                    ),
                )
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("$ {}", command),
                format!("execution failed: {}", e),
            )
            .with_metadata(attach_target(json!({ "failed": true })))),
        }
    }
}

impl Default for BashTool {
    fn default() -> Self {
        Self::new()
    }
}

/// 「缺 `command`」时给模型的话。
///
/// 单独提出来的理由与 [`missing_required_argument`] 相同：预检与 `execute_inner`
/// 的兜底必须是同一句话，不能各写一份。
fn missing_command_message() -> String {
    "缺少必填参数 \"command\"：要执行的那条 shell 命令。补上后重新调用 bash。".to_string()
}

/// bash 的必填参数检查（`command` 与 `description`）。
///
/// 提成一个函数，是为了让「弹审批之前」的预检（[`AgentTool::validate_arguments`]）与
/// `execute_inner` 说的是同一句话 —— 两处各写一份，改了这处忘那处，用户看到的提示
/// 就会对不上。
///
/// `command` 也必须在这里判：schema 声明的 required 是 `command` + `description`，
/// 而它过去只在 `execute_inner` 里兜底 —— 于是「缺 command」的调用会被预检放行、
/// 照样弹一次审批，用户点完批准才看到参数错，正是预检要消除的那次往返。
///
/// `description` 为什么必填：审批弹窗要把它显示在命令上方，让用户不用读 shell 语法
/// 就能判断这条命令在干什么。缺了它，那道审批就只剩一串命令本身。
fn missing_required_argument(params: &serde_json::Value) -> Option<String> {
    match params.get("command").and_then(|v| v.as_str()) {
        Some(text) if !text.trim().is_empty() => {}
        _ => return Some(missing_command_message()),
    }
    match params.get("description").and_then(|v| v.as_str()) {
        Some(text) if !text.trim().is_empty() => None,
        // 区分"没给"和"给了空白"对模型没用，提示里一并说清就行
        _ => Some(
            "缺少必填参数 \"description\"：用一句话说清这条命令在做什么、为什么（5-10 字，\
             例如「重启 nginx 以加载新配置」）。它会显示在用户看到的审批弹窗上，\
             是用户判断这条命令的依据。补上后重新调用 bash。"
                .to_string(),
        ),
    }
}

#[async_trait]
impl AgentTool for BashTool {
    fn name(&self) -> &str {
        "bash"
    }

    fn description(&self) -> &str {
        "Execute a shell command on the remote server via the user's login shell \
         (usually bash). Returns combined stdout+stderr. Long output is truncated. \
         A failed command appends a machine-readable marker (`[exit code: N]`, \
         `[signal: KILL]`); exit code 0 adds nothing — when output is empty and no \
         marker appears, the command succeeded. \
         The command is statically analyzed by a risk assessment before execution: \
         catastrophic patterns (e.g. `rm -rf /`, mkfs/dd/wipefs onto a real block \
         device, or forms the analyzer cannot parse such as `$( )`/backticks) are \
         rejected outright; system-level writes and protected-path writes instead \
         require the user's approval (including in Auto mode). Timeout is configured \
         by the user (default 120s).\n\
         Set `run_in_background: true` for long-running commands (compilations, \
         large downloads, servers/daemons, ongoing tasks) to receive a `job_id` \
         immediately and manage it via `job_output`, `job_kill`, and `job_list`.\n\
         Multi-host: you may pass an optional `host` (the current machine or a \
         machine from the selected set, by its readable name) to run the command \
         on that machine instead of the current one. Desktop only."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command line to execute (run via the user's login shell)."
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). Defaults to false."
                },
                "description": {
                    "type": "string",
                    "description": "REQUIRED. What this command does and why, 5-10 words, in the user's language — the same language you write replies in (Chinese-speaking user: 「重启 nginx 以加载新配置」; English-speaking user: 'Restart nginx to pick up the new config'). Do not default to English just because this value lives in a tool call. The user judges the command from it on the approval dialog without reading shell syntax, so make both the action and its purpose concrete. When run_in_background is true it also becomes the job's description."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Optional timeout in milliseconds for foreground execution. Ignored when run_in_background is true."
                },
                "host": {
                    "type": "string",
                    "description": format!("Optional. Target machine's readable name: the current machine or one from the multi-host selected set (e.g. 'web-prod-01'). When omitted, runs on the current session's machine. Desktop only; on mobile passing host returns an error. {}", super::HOST_MATCH_RULE)
                }
            },
            "required": ["command", "description"]
        })
    }

    fn validate_arguments(&self, params: &serde_json::Value) -> Result<(), String> {
        match missing_required_argument(params) {
            Some(message) => Err(message),
            None => Ok(()),
        }
    }

    fn disposition(&self) -> Disposition {
        // 命令类工具的真实档位由命令文本决定（dispatcher 按文本现算，再与这里取严）。
        // 所以这条声明是**下限**，不是"现算会覆盖它"的占位：命令文本拿不到时（语义
        // 声明丢了、或工具被别的路径直接调起来）至少还得有人点头 —— 兜底要往
        // 「不放行」的方向倒。详见 `tool_dispatcher::resolve_disposition`。
        Disposition::Approval
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        // ── 多机操控：host 参数 → 目标机器会话 ──
        // 门控语义：host 非空 → 解析目标（集合内或当前机，见 multi_host 模块）；
        // 解析失败/不在集合 → 明确错误，绝不落回当前会话执行（防止模型以为
        // 在 A 却打在 B）。
        if let Some(host) = crate::multi_host::optional_host(&params) {
            // 当前 ctx 的 session_id 由任务绑定，换机需要 task_id 记账。
            let task_id = ctx.task_id.clone().unwrap_or_default();
            if task_id.is_empty() {
                return Ok(ToolOutput::fail(
                    "bash",
                    "多机执行需要任务上下文（缺少 task_id）",
                ));
            }
            let resolved = crate::multi_host::resolve_target(
                &ctx.app_handle,
                &host,
                &task_id,
                &ctx.session_id,
            )
            .await?;
            let target_label = Some(resolved.host_label.clone());
            if resolved.session_id == ctx.session_id {
                // 目标就是当前会话：无需 fork，直接执行（host_label 附到结果）。
                return Self::execute_inner(params, ctx, target_label).await;
            }
            let target_ctx = ctx.fork_for(&resolved.session_id);
            return Self::execute_inner(params, &target_ctx, target_label).await;
        }
        Self::execute_inner(params, ctx, None).await
    }
}

/// Check if a command starts with `sudo` (possibly preceded by env-var
/// assignments such as `FOO=bar sudo ...`). Recognises `sudo`, `sudo `
/// and `sudo\t`. Never panics.
fn is_sudo_command(command: &str) -> bool {
    let mut remaining = command.trim();
    loop {
        if remaining == "sudo" || remaining.starts_with("sudo ") || remaining.starts_with("sudo\t")
        {
            return true;
        }
        // Try to peel off a leading `NAME=value` (value may be quoted).
        let eq_pos = match remaining.find('=') {
            Some(p) => p,
            None => return false,
        };
        let name = &remaining[..eq_pos];
        if name.is_empty()
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || name.chars().next().map_or(true, |c| c.is_ascii_digit())
        {
            return false;
        }
        let after_eq = &remaining[eq_pos + 1..];
        let advanced = match after_eq.chars().next() {
            Some('"') | Some('\'') => {
                let quote = after_eq.chars().next().unwrap();
                match after_eq[1..].find(quote) {
                    Some(end) => &after_eq[1 + end + 1..],
                    None => return false,
                }
            }
            _ => match after_eq.find(|c: char| c == ' ' || c == '\t') {
                Some(p) => &after_eq[p..],
                None => return false,
            },
        };
        let next = advanced.trim_start_matches(|c: char| c == ' ' || c == '\t');
        if next.len() == remaining.len() {
            return false;
        }
        remaining = next;
    }
}

/// Look up the SSH password from keychain using the session's connection_id.
/// NEVER logs the actual password content.
async fn lookup_password(ctx: &ToolContext) -> Option<String> {
    let connection_id = ctx.ssh.get_connection_id(&ctx.session_id).await;
    log::info!(
        "bash: session={} connection_id={:?}",
        ctx.session_id,
        connection_id
    );

    match &connection_id {
        Some(id) => {
            let result = keychain::get_password(id);
            match &result {
                Ok(Some(_)) => {
                    log::info!("bash: password available for connection={}", id);
                }
                Ok(None) => {
                    log::info!("bash: no password stored for connection={}", id);
                }
                Err(e) => {
                    log::warn!("bash: keychain error for connection={}: {}", id, e);
                }
            }
            result.ok().flatten()
        }
        None => {
            log::debug!("bash: no connection_id for session, cannot look up password");
            None
        }
    }
}

/// Rewrite a sudo command to auto-fill password via stdin using `sudo -S`.
///
/// The password is passed as a `printf` **argument** (not embedded in the
/// format string), so characters like `%s` in the password stay literal.
/// Single quotes in the password are escaped for the surrounding shell.
fn rewrite_sudo(command: &str, password: &str) -> String {
    let escaped_password = password.replace('\'', "'\\''");

    // Extract everything after the leading `sudo` token. Works for
    // "sudo args...", "sudo\targs..." and bare "sudo".
    let trimmed = command.trim();
    let sudo_arg = trimmed
        .strip_prefix("sudo ")
        .or_else(|| trimmed.strip_prefix("sudo\t"))
        .unwrap_or("");

    format!(
        "printf '%s\\n' '{}' | sudo -S -p '' -- {}",
        escaped_password, sudo_arg
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_sudo_detects_plain_sudo() {
        assert!(is_sudo_command("sudo apt update"));
        assert!(is_sudo_command("sudo"));
    }

    #[test]
    fn is_sudo_detects_with_env_vars() {
        assert!(is_sudo_command("FOO=bar sudo apt update"));
        assert!(is_sudo_command("A=1 B=2 sudo ls"));
    }

    #[test]
    fn is_sudo_does_not_match() {
        assert!(!is_sudo_command("apt update"));
        assert!(!is_sudo_command("notsudo apt update"));
        assert!(!is_sudo_command("sudoedit file"));
    }

    #[test]
    fn rewrite_sudo_basic() {
        let result = rewrite_sudo("sudo apt update", "mypassword");
        assert_eq!(
            result,
            "printf '%s\\n' 'mypassword' | sudo -S -p '' -- apt update"
        );
    }

    #[test]
    fn rewrite_sudo_escapes_quotes() {
        let result = rewrite_sudo("sudo ls", "pass'word");
        assert!(
            result.contains("'pass'\\''word'"),
            "expected escaped password in output: {}",
            result
        );
    }

    #[test]
    fn rewrite_sudo_does_not_panic_on_bare_sudo() {
        let _ = rewrite_sudo("sudo", "pw");
        let _ = rewrite_sudo("  sudo  ", "pw");
    }

    #[test]
    fn rewrite_sudo_handles_tab_separator() {
        let result = rewrite_sudo("sudo\tls -l", "pw");
        assert!(result.contains("-- ls -l"), "got: {}", result);
    }

    #[test]
    fn agent_ticket_separates_sensitive_command_from_display_and_binds_task() {
        let original = "sudo ls";
        let rewritten = rewrite_sudo(original, "secret-password");
        let ticket = crate::command_exec::CommandTicket::new(
            "session-1",
            rewritten,
            crate::command_exec::CommandSource::Agent,
        )
        .display_as(original)
        .cancellable("agent-task-1", "Agent 命令已取消");

        assert!(ticket.command.contains("secret-password"));
        assert_eq!(ticket.display_command, original);
        assert!(!ticket.display_command.contains("secret-password"));
        assert_eq!(ticket.task_id.as_deref(), Some("agent-task-1"));
    }

    // ── 必填参数：命令说明（会被审批弹窗显示给用户） ──

    #[test]
    fn schema_declares_description_as_required() {
        let schema = BashTool::new().parameters_schema();
        let required = schema["required"].as_array().expect("required 必须是数组");
        let required: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(required.contains(&"command"));
        assert!(
            required.contains(&"description"),
            "description 必须是必填：审批弹窗要靠它给用户一条判断依据，缺了就没得看"
        );
        assert!(schema["properties"]["description"].is_object());
    }

    #[test]
    fn validate_arguments_rejects_missing_or_blank_description() {
        let tool = BashTool::new();
        for args in [
            serde_json::json!({"command": "ls"}),
            serde_json::json!({"command": "ls", "description": ""}),
            serde_json::json!({"command": "ls", "description": "   "}),
            serde_json::json!({"command": "ls", "description": 42}),
        ] {
            let err = tool
                .validate_arguments(&args)
                .expect_err("缺说明必须被拦下");
            assert!(err.contains("description"), "提示里要点名缺的是哪个参数：{err}");
        }
    }

    #[test]
    fn validate_arguments_rejects_missing_or_blank_command() {
        let tool = BashTool::new();
        for args in [
            serde_json::json!({"description": "看一眼磁盘"}),
            serde_json::json!({"command": "", "description": "看一眼磁盘"}),
            serde_json::json!({"command": "   ", "description": "看一眼磁盘"}),
            serde_json::json!({"command": 42, "description": "看一眼磁盘"}),
            // 数组/对象形状：`as_str` 取不到，与"没给"同一条路径
            serde_json::json!({"command": ["ls"], "description": "看一眼磁盘"}),
        ] {
            let err = tool
                .validate_arguments(&args)
                .expect_err("缺命令必须被拦下（否则会先弹审批、点完才报参数错）");
            assert!(err.contains("command"), "提示里要点名缺的是哪个参数：{err}");
        }
    }

    /// 预检与执行兜底必须是同一句话：两处各写一份的话，用户看到的提示会分叉。
    #[test]
    fn preflight_and_execute_agree_on_the_missing_command_message() {
        let args = serde_json::json!({"description": "看一眼磁盘"});
        let from_preflight = BashTool::new().validate_arguments(&args).unwrap_err();
        let from_helper = missing_required_argument(&args).expect("应当判定为缺失");
        assert_eq!(from_preflight, from_helper);
        assert_eq!(from_preflight, missing_command_message());
    }

    #[test]
    fn validate_arguments_accepts_a_real_description() {
        let tool = BashTool::new();
        assert!(tool
            .validate_arguments(&serde_json::json!({
                "command": "systemctl restart nginx",
                "description": "重启 nginx 以加载新配置",
            }))
            .is_ok());
    }

    #[test]
    fn preflight_and_execute_share_one_message() {
        // 预检（弹审批之前）与 execute 兜底必须说同一句话：两处各写一份，
        // 改了这处忘那处，用户看到的提示就会对不上。
        let params = serde_json::json!({"command": "ls"});
        let from_preflight = BashTool::new().validate_arguments(&params).unwrap_err();
        let from_execute = missing_required_argument(&params).expect("应当判定为缺失");
        assert_eq!(from_preflight, from_execute);
    }

    #[test]
    fn rewrite_sudo_password_with_format_specifier_is_literal() {
        let result = rewrite_sudo("sudo ls", "ab%scd");
        // Password must appear literally inside single quotes as a printf
        // argument, not in the format string.
        assert!(result.contains("'ab%scd'"), "got: {}", result);
        assert!(result.starts_with("printf '%s\\n' '"), "got: {}", result);
    }
}
