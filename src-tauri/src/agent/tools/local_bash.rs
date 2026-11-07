//! `local_bash` — 在**用户自己的电脑**（运行 Marcel SSH 的这台机器）上执行 shell 命令。
//!
//! 与 [`super::bash`] 的关系：执行链路是同一条 —— 风险评估（dispatcher 按命令文本
//! 现算）→ `CommandTicket` → `ToolContext` 上挂的命令执行管理器。差别只有三处：
//!
//! 1. **目标机器**：本工具的 ctx 挂的是 `AppState.local_command_exec`
//!    （`command_exec::LocalExecTransport`，本机子进程），`bash` 挂的是当前 SSH
//!    会话的管理器。所以这里不解析 `host`、不做 sudo 密码回填 —— 本机命令就是
//!    在这台电脑上起一个子进程（Windows PowerShell **5.1**：
//!    `powershell -NoProfile -NonInteractive -Command`；
//!    macOS / Linux `bash -lc` 登录 shell），没有任何远端语义。
//! 2. **措辞**：描述与超时文案说「本机 / 这台电脑」，指路本机的进程收尾手段。
//! 3. **兜底**：`ctx.local_side` 不是 `true` 一律失败（见
//!    [`LocalBashTool::execute`] 的第一道检查）—— 本机工具被错误的 ctx 拿到时，
//!    `ctx.exec_ticket` 会顺着 SSH 把命令打到服务器上，正是这个工具要避免的事。
//!
//! 本工具只在**本机子 agent** 的 registry 里出现（声明表 `ToolRoles::LocalSubOnly`）：
//! 外层主 agent 与远端子 agent 都拿不到它，本机能力只经本机子 agent 暴露给模型。
//!
//! 超时 / 取消的收尾语义与远端一字不差（见 `command_exec::local_transport` 顶部
//! 模块注释）：**只停止等待、关闭我们这侧的读端，绝不杀进程**。文案因此绝不能
//! 写成「已终止进程」——静默运行 / 重定向输出 / 被 detach 的命令会继续跑。

use async_trait::async_trait;
use serde_json::json;
use std::time::Duration;

use crate::agent::risk::{Disposition, RiskAssessor};
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

/// Maximum bytes of combined stdout+stderr returned to the LLM（与 `bash` 同值，
/// 两个工具的输出预算不该有差异）。
const MAX_OUTPUT_BYTES: usize = 8_000;

pub struct LocalBashTool;

impl LocalBashTool {
    pub fn new() -> Self {
        Self
    }

    async fn execute_inner(
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        // 必填参数（`command` + `description`）。正常情况下 dispatcher 的预检已经在
        // 弹审批之前拦下了，走到这里说明工具被别的路径直接调起来（测试等）——兜底要
        // 给出与预检**同一句话**（两处共用 `missing_required_argument`）。
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

        // 执行前的风险评估 —— **兜底的那一道**。
        //
        // 权威判定在 `tool_dispatcher::decide_command`（它拿着同一个策略、调同一个
        // `assess_command`），本工具声明了 `ToolSemantics::command("command")`，正常
        // 情况下这里根本不会命中。保留它是因为这里打的是**用户自己的电脑**：声明丢了
        // 或工具被别的路径直接调起来时，安全闸门要往「不放行」的方向倒。
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
                    "BLOCKED: 命令未执行 —— {}。\n请改用更精确的目标路径重试，不要原样重发。",
                    reason
                ),
            )
            .with_metadata(json!({
                "blocked": true,
                "reason": reason,
            })));
        }

        if run_in_background {
            // 后台作业走统一命令执行体系：立即返回 job_id，输出沉淀进作业缓冲，
            // 经 job_output / job_kill / job_list 消费（本机 ctx 上挂的就是本机
            // 管理器，所以这三个工具天然管到本机作业）。取消注册 / 断连级联 /
            // 执行记录与前台共用。
            let mut ticket = crate::command_exec::CommandTicket::new(
                &ctx.session_id,
                command,
                crate::command_exec::CommandSource::Agent,
            )
            .display_as(command);
            if let Some(task_id) = &ctx.task_id {
                ticket = ticket.cancellable(task_id, "本机命令已取消");
            }
            // 归属对话：作业台账与访问围栏的键（子 agent 派发的作业记在派它的
            // 父对话名下）。
            if let Some(owner) = &ctx.owner_conversation_id {
                ticket = ticket.owned_by(owner);
            }
            let job_info = ctx
                .submit_background(ticket, Some(description.clone()))
                .await?;

            let summary = format!("$ {} (Job ID: {})", command, job_info.job_id);
            let output = format!(
                "Command started in background.\nJob ID: {}\nStatus: {}\nUse `job_output(job_id=\"{}\", wait=true)` to check output or wait for completion, and `job_kill(job_id=\"{}\")` to stop.",
                job_info.job_id, job_info.status, job_info.job_id, job_info.job_id
            );

            return Ok(ToolOutput::ok(summary, output).with_metadata(json!({
                "job_id": job_info.job_id,
                "status": job_info.status.to_string(),
                "description": job_info.description,
                "run_in_background": true,
            })));
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
            command,
            crate::command_exec::CommandSource::Agent,
        )
        .display_as(command)
        .timeout(timeout);
        if let Some(task_id) = &ctx.task_id {
            ticket = ticket.cancellable(task_id, "本机命令已取消");
        }
        // 归属对话：命令超时转成后台作业时，作业台账与访问围栏要靠它认主。
        if let Some(owner) = &ctx.owner_conversation_id {
            ticket = ticket.owned_by(owner);
        }
        if let (Some(tool_call_id), Some(event_name)) = (&ctx.tool_call_id, &ctx.event_name) {
            ticket = ticket.streaming(event_name, tool_call_id);
        }
        // 超时不掐断：到点还没结束就把同一个进程原地转成后台作业（见 `exec_ticket`）。
        let exec_result = ctx.exec_ticket(ticket, Some(description.clone())).await;

        match exec_result {
            Ok(shaped) => {
                let mut truncated = truncate_output(shaped.output, MAX_OUTPUT_BYTES);
                // 退出事实紧跟在输出后面：模型必须能直接看出命令成功没有
                // （`grep -q`、`test -f` 成功时本来就没有输出）。成功不贴标记。
                if shaped.exit.is_known() && !shaped.exit.is_success() {
                    if !truncated.is_empty() && !truncated.ends_with('\n') {
                        truncated.push('\n');
                    }
                    truncated.push_str(&format!("[{}]", shaped.exit.describe()));
                }
                // 软超时到点还在跑：进程没被掐断，原地转成了后台作业。与远端 `bash`
                // 共用同一份实现（含 metadata），别各写一份。
                if let Some(job) = &shaped.detached {
                    return Ok(super::detached_job_output(
                        job,
                        format!("$ {}", command),
                        truncated,
                        timeout_secs,
                        json!({
                            "disposition": assessment.disposition.label(),
                            "was_timeout": false,
                        }),
                    ));
                }
                if shaped.was_timeout {
                    truncated.push_str(&timeout_message(timeout_secs));
                }
                Ok(
                    ToolOutput::ok(format!("$ {}", command), truncated).with_metadata(json!({
                        "disposition": assessment.disposition.label(),
                        "was_timeout": shaped.was_timeout,
                        "exit_code": shaped.exit.code,
                        "exit_signal": shaped.exit.signal,
                    })),
                )
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("$ {}", command),
                format!("execution failed: {}", e),
            )
            .with_metadata(json!({ "failed": true }))),
        }
    }
}

impl Default for LocalBashTool {
    fn default() -> Self {
        Self::new()
    }
}

/// 超时补充文案（本机版）。
///
/// 单独提出来是为了可测：措辞是纪律 —— **只说「停止等待、关闭我们这侧的读端」，
/// 绝不能说「已终止进程」**（见 `command_exec::local_transport` 的收尾语义），
/// 并且必须指路本机的收尾手段（`Get-Process` / `Stop-Process -Id`；
/// `ps` / `pgrep` + `kill <pid>`），因为本机没有 sshd 替用户回收进程。
fn timeout_message(timeout_secs: u64) -> String {
    format!(
        "\n\n[命令超时（{} 秒）：已停止等待输出并关闭我们这侧的读端，但本机进程不保证已结束——只有它之后还往 stdout/stderr 写东西时，才可能因管道断开而退出；静默运行、重定向了输出、被 Start-Process / nohup / & 脱离的命令会继续在这台电脑上运行。要收尾就自己查了再结束：Windows 用 `Get-Process` 找到它、`Stop-Process -Id <pid>` 结束；macOS/Linux 用 `ps` / `pgrep` 找到它、`kill <pid>` 结束。]",
        timeout_secs
    )
}

/// 「缺 `command`」时给模型的话（本机版）。
///
/// 与 [`missing_required_argument`] 同一个理由：预检与 execute 兜底必须是同一句话。
fn missing_command_message() -> String {
    "缺少必填参数 \"command\"：要在这台电脑（运行 Marcel SSH 的本机）上执行的那条命令。补上后重新调用 local_bash。"
        .to_string()
}

/// local_bash 的必填参数检查（`command` 与 `description`）。
///
/// 形状与 `bash::missing_required_argument` 逐项对应（两处各写一份是因为措辞要区分
/// 本机/远端，判据与结构保持一致）：
/// - `description` 必填：审批弹窗要把它显示在命令上方，用户不用读命令语法就能判断
///   这条命令在这台电脑上要干什么；
/// - 在这里判 `command`（而不是只在 execute 里兜底）：缺参的调用不该先弹一次审批、
///   用户点完批准才看到参数错。
fn missing_required_argument(params: &serde_json::Value) -> Option<String> {
    match params.get("command").and_then(|v| v.as_str()) {
        Some(text) if !text.trim().is_empty() => {}
        _ => return Some(missing_command_message()),
    }
    match params.get("description").and_then(|v| v.as_str()) {
        Some(text) if !text.trim().is_empty() => None,
        _ => Some(
            "缺少必填参数 \"description\"：用一句话说清这条命令在这台电脑上做什么、为什么\
             （5-10 字，例如「清理本机下载目录里的旧安装包」）。它会显示在用户看到的审批\
             弹窗上，是用户判断这条命令的依据。补上后重新调用 local_bash。"
                .to_string(),
        ),
    }
}

#[async_trait]
impl AgentTool for LocalBashTool {
    fn name(&self) -> &str {
        "local_bash"
    }

    fn command_host(&self) -> Option<super::CommandHost> {
        Some(super::CommandHost::Local)
    }

    fn description(&self) -> &str {
        "Execute a shell command on the user's own computer (this computer, where Marcel SSH \
         runs) — not on the remote server. \
         On Windows the command runs in Windows PowerShell 5.1 (`powershell \
         -NoProfile -NonInteractive -Command`), so use PowerShell syntax \
         (`Get-ChildItem`, `Remove-Item`, `Select-String`, ...) — and note 5.1 has NO \
         `&&` / `||` chaining operators: use `;` or separate calls instead. \
         On macOS/Linux it runs in the user's bash login shell (`bash -lc`): PATH and \
         environment match an interactive login, so use bash/POSIX syntax. \
         Returns combined stdout+stderr. Long output is truncated. \
         A failed command appends a machine-readable marker (`[exit code: N]`, \
         `[signal: KILL]`); exit code 0 adds nothing — when output is empty and no \
         marker appears, the command succeeded. \
         The command is statically analyzed by a risk assessment before execution: \
         catastrophic patterns (e.g. `rm -rf /`, mkfs/dd/wipefs onto a real block \
         device, or forms the analyzer cannot parse such as `$( )`/backticks) are \
         rejected outright; system-level writes and protected-path writes instead \
         require the user's approval (including in Auto mode). The foreground time \
         limit is configured by the user (default 120s) and is NOT a kill switch: a \
         command still running when it expires keeps running as the same process, \
         converted into a background job (the result ends with its `job_id`; read more \
         with `job_output`, stop with `job_kill`; you are notified when it finishes). \
         So never retry a timed-out command — manage its job instead. \
         Set `run_in_background: true` for long-running commands (builds, large \
         downloads, servers/daemons, ongoing tasks) to receive a `job_id` immediately \
         and manage it via `job_output`, `job_kill`, and `job_list`. \
         Only the local sub-agent can call this tool; paths and commands address this \
         computer (e.g. `C:\\Users\\you\\project`, `/Users/you/project`), never the server."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command line to execute on this computer (Windows PowerShell 5.1 on Windows — no `&&`/`||`, use `;`; bash login shell on macOS/Linux)."
                },
                "run_in_background": {
                    "type": "boolean",
                    "description": "Run in the background and return a job id immediately (collect with job_output, stop with job_kill). Defaults to false."
                },
                "description": {
                    "type": "string",
                    "description": "REQUIRED. What this command does on this computer and why, 5-10 words, in the user's language — the same language you write replies in (Chinese-speaking user: 「清理本机下载目录里的旧安装包」; English-speaking user: 'Clean old installers from the local downloads folder'). Do not default to English just because this value lives in a tool call. The user judges the command from it on the approval dialog without reading shell syntax, so make both the action and its purpose concrete. When run_in_background is true it also becomes the job's description."
                },
                "timeout_ms": {
                    "type": "integer",
                    "description": "Optional foreground time limit in milliseconds (default: the user's setting). When it expires the still-running command is converted into a background job, not killed. Ignored when run_in_background is true."
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
        // ── 第一道：本机侧标记 ──
        // `ctx.exec_ticket` 在 `command_exec` 为 None 时回退到 SshManager，而在本机
        // subagent 之外构造出来的 ctx 挂的是**当前 SSH 会话**的管理器：那会把命令
        // 打到服务器上，而模型以为在操作本机。所以标记不对就当场失败，绝不执行。
        // 标记由本机子 agent 的 ctx 组装处置 true（见 `ToolContext::with_local_side`）。
        if !ctx.local_side {
            return Ok(ToolOutput::fail(
                "local_bash",
                "拒绝执行：当前工具上下文不是本机侧（local_bash 只能在用户这台电脑上跑，\
                 因为它不经过 SSH）。请改用 bash 在远端会话执行，或让本机子 agent 来做这件事。",
            ));
        }
        // 本机侧标记为真但没有本机执行器：宁可明确失败，也不要沿 SSH 打到服务器。
        if ctx.command_exec.is_none() {
            return Ok(ToolOutput::fail(
                "local_bash",
                "拒绝执行：本机命令执行器未配置（本机上下文缺少 local_command_exec）。\
                 此时执行会回退到 SSH，命令将落到错误的机器上。",
            ));
        }
        Self::execute_inner(params, ctx).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_declares_command_and_description_as_required() {
        let schema = LocalBashTool::new().parameters_schema();
        let required = schema["required"].as_array().expect("required 必须是数组");
        let required: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(required.contains(&"command"));
        assert!(
            required.contains(&"description"),
            "description 必须是必填：审批弹窗要靠它给用户一条判断依据"
        );
        assert!(schema["properties"]["description"].is_object());
        assert!(
            schema["properties"].get("host").is_none(),
            "本机只有一个目标机器，没有 host 语义"
        );
    }

    #[test]
    fn validate_arguments_rejects_missing_command_or_description() {
        let tool = LocalBashTool::new();
        for args in [
            serde_json::json!({"description": "看一眼本机磁盘"}),
            serde_json::json!({"command": "", "description": "看一眼本机磁盘"}),
            serde_json::json!({"command": "   ", "description": "看一眼本机磁盘"}),
            serde_json::json!({"command": 42, "description": "看一眼本机磁盘"}),
            serde_json::json!({"command": "ls"}),
            serde_json::json!({"command": "ls", "description": "   "}),
            serde_json::json!({"command": "ls", "description": 42}),
        ] {
            assert!(tool.validate_arguments(&args).is_err(), "{args} 应被拦下");
        }
        assert!(tool
            .validate_arguments(&serde_json::json!({
                "command": "Get-Process | Select-Object -First 5",
                "description": "看一眼本机跑着的进程",
            }))
            .is_ok());
    }

    /// 预检（弹审批之前）与 execute 兜底必须说同一句话：两处各写一份，改了这处
    /// 忘那处，用户看到的提示就会对不上。
    #[test]
    fn preflight_and_execute_agree_on_the_missing_argument_message() {
        let params = serde_json::json!({"command": "ls"});
        let from_preflight = LocalBashTool::new()
            .validate_arguments(&params)
            .unwrap_err();
        let from_helper = missing_required_argument(&params).expect("应当判定为缺失");
        assert_eq!(from_preflight, from_helper);

        let params = serde_json::json!({"description": "看一眼磁盘"});
        assert_eq!(
            LocalBashTool::new()
                .validate_arguments(&params)
                .unwrap_err(),
            missing_command_message()
        );
    }

    /// 描述必须点明作用侧与 shell 形态：模型要能一眼看出这条命令跑在
    /// Windows PowerShell 5.1 还是 bash 登录 shell 上，以及 5.1 没有 `&&`。
    #[test]
    fn description_states_the_local_side_and_shell_semantics() {
        let desc = LocalBashTool::new().description().to_lowercase();
        assert!(
            desc.contains("user's own computer") || desc.contains("this computer"),
            "描述必须写明是本机"
        );
        assert!(
            desc.contains("windows powershell 5.1"),
            "Windows 侧要写明是 Windows PowerShell 5.1（产品决定只用 5.1）"
        );
        assert!(
            desc.contains("&&") && desc.contains("chaining"),
            "必须提醒 5.1 没有 && 链式操作符、让模型改用 ; 或分步"
        );
        assert!(
            desc.contains("bash -lc"),
            "macOS/Linux 侧要写明 bash 登录 shell"
        );
    }

    /// 超时文案只说「停止等待」，不许写成「已终止进程」；并指路本机收尾手段。
    #[test]
    fn timeout_message_never_claims_the_process_was_killed() {
        let msg = timeout_message(30);
        assert!(msg.contains("已停止等待输出并关闭我们这侧的读端"));
        assert!(msg.contains("不保证已结束"));
        assert!(msg.contains("Get-Process") && msg.contains("Stop-Process -Id"));
        assert!(msg.contains("pgrep") && msg.contains("kill <pid>"));
        assert!(
            !msg.contains("已终止进程") && !msg.contains("已杀掉"),
            "超时/取消不得声称进程已结束：{msg}"
        );
    }
}
