use serde::Serialize;
use tauri::Emitter;

use crate::agent::approval::ApprovalManager;
use crate::agent::model_approval::{CommandApprover, ModelApprovalDecision, ModelApprover};
use crate::agent::sandbox::{assess_risk, split_command_chain, RiskLevel};
use crate::agent::task::AgentMode;
use crate::agent::tools::{ToolContext, ToolOutput, ToolRegistry};
use crate::config::settings::{AgentModeSettings, CommandListMode};
use crate::emit_event;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, ToolCall};
use crate::AppState;

/// Event containing a tool call result, sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolResultEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub summary: String,
    pub result: String,
    pub success: bool,
    pub blocked: bool,
    pub was_timeout: bool,
    #[serde(default)]
    pub was_aborted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Event emitted when model-based approval check starts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelApprovalStartEvent {
    #[serde(rename = "type")]
    event_type: String,
    tool_call_id: String,
}

/// Event emitted when model-based approval check completes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelApprovalDoneEvent {
    #[serde(rename = "type")]
    event_type: String,
    tool_call_id: String,
    /// "approve" | "route_to_human" | "block" | "error"
    decision: String,
    reasons: Vec<String>,
}

/// Result of executing a single tool call (UI/event view).
pub(crate) struct DispatchResult {
    pub summary: String,
    pub output: String,
    pub success: bool,
    pub blocked: bool,
    pub was_timeout: bool,
    pub was_aborted: bool,
    pub metadata: Option<serde_json::Value>,
    pub risk_level: RiskLevel,
}

impl DispatchResult {
    fn from_tool_output(o: ToolOutput, risk_level: RiskLevel) -> Self {
        let was_timeout = o
            .metadata
            .as_ref()
            .and_then(|m| m.get("was_timeout"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        Self {
            summary: o.summary,
            output: o.output,
            success: o.success,
            blocked: false,
            was_timeout,
            was_aborted: false,
            metadata: o.metadata,
            risk_level,
        }
    }
    fn blocked(
        summary: impl Into<String>,
        reason: impl Into<String>,
        risk_level: RiskLevel,
    ) -> Self {
        Self {
            summary: summary.into(),
            output: format!("BLOCKED: {}", reason.into()),
            success: false,
            blocked: true,
            was_timeout: false,
            was_aborted: false,
            metadata: None,
            risk_level,
        }
    }
    fn unknown(name: &str) -> Self {
        Self {
            summary: format!("{} (not found)", name),
            output: format!("没有这个tool: {}", name),
            success: false,
            blocked: false,
            was_timeout: false,
            was_aborted: false,
            metadata: None,
            risk_level: RiskLevel::Moderate,
        }
    }
}

/// Dispatches tool calls through the registry with mode-aware security policy.
pub(crate) struct ToolDispatcher {
    mode: AgentMode,
    agent_settings: AgentModeSettings,
    task_id: String,
    approval: ApprovalManager,
    registry: std::sync::Arc<ToolRegistry>,
    /// LLM-backed command approver. `None` when the feature is disabled by
    /// settings or the tool is not `execute_command`. Inserted after the
    /// sandbox risk assessment and before the human-approval trigger.
    approver: Option<std::sync::Arc<dyn CommandApprover>>,
    /// 本任务内已观察过的路径（`read_file` / `write_file` / `edit_file` 成功
    /// 后按 `normalize_path` 归一化记账）。`edit_file` 的目标必须已读取，
    /// `write_file` 覆盖已存在文件也必须已读取，否则工具直接失败并提示先读取。
    read_files: parking_lot::RwLock<std::collections::HashSet<String>>,
}

impl ToolDispatcher {
    pub fn new(
        mode: AgentMode,
        agent_settings: AgentModeSettings,
        task_id: String,
        app: tauri::AppHandle,
        state: AppState,
        registry: std::sync::Arc<ToolRegistry>,
        provider: std::sync::Arc<OpenAiProvider>,
    ) -> Self {
        let enable = agent_settings.enable_model_command_approval;
        let approver: Option<std::sync::Arc<dyn CommandApprover>> = if enable {
            // Always strip extra_body for the approval provider: the user-configured
            // free-form params (thinking, top_p, etc.) target the main chat model
            // and would otherwise skew the approval decision. The approval call
            // uses the user's typed config (provider, base_url, api_key, model,
            // temperature) but not the free-form extras.
            let approval_provider = if !agent_settings.model_approval_model.is_empty() {
                let mut cfg = provider.config().clone();
                cfg.model = agent_settings.model_approval_model.clone();
                cfg.extra_body = None;
                match OpenAiProvider::new(cfg) {
                    Ok(p) => {
                        log::info!(
                            "模型审批使用独立模型: {}",
                            agent_settings.model_approval_model
                        );
                        std::sync::Arc::new(p)
                    }
                    Err(e) => {
                        log::warn!("模型审批专用模型创建失败，回退主模型: {}", e);
                        provider.clone()
                    }
                }
            } else {
                let mut cfg = provider.config().clone();
                cfg.extra_body = None;
                match OpenAiProvider::new(cfg) {
                    Ok(p) => std::sync::Arc::new(p),
                    Err(e) => {
                        log::warn!("模型审批 provider 创建失败，回退主 provider: {}", e);
                        provider.clone()
                    }
                }
            };
            Some(std::sync::Arc::new(ModelApprover::new(
                approval_provider,
                agent_settings.model_approval_prompt.clone(),
                matches!(mode, AgentMode::Plan),
            )))
        } else {
            None
        };
        Self {
            mode,
            agent_settings,
            task_id,
            approval: ApprovalManager::new(app, state.pending_approvals.clone()),
            registry,
            approver,
            read_files: parking_lot::RwLock::new(std::collections::HashSet::new()),
        }
    }

    pub async fn dispatch(
        &self,
        tc: &ToolCall,
        ctx: &ToolContext,
        event_name: &str,
        recent_messages: &[LlmMessage],
    ) -> DispatchResult {
        let Some(tool) = self.registry.get(&tc.name) else {
            return DispatchResult::unknown(&tc.name);
        };

        let effective_risk = match tc.name.as_str() {
            "execute_command" => tc
                .arguments
                .get("command")
                .and_then(|v| v.as_str())
                .map(assess_risk)
                .unwrap_or_else(|| tool.risk_level()),
            "write_file" | "edit_file" => {
                let base_risk = tool.risk_level();
                let path_hits_protected = tc
                    .arguments
                    .get("path")
                    .and_then(|v| v.as_str())
                    .map(|path| {
                        ctx.policy
                            .as_ref()
                            .map(|p| p.is_protected_path(path))
                            .unwrap_or(false)
                    })
                    .unwrap_or(false);
                if path_hits_protected {
                    RiskLevel::HighRisk
                } else {
                    base_risk
                }
            }
            _ => tool.risk_level(),
        };
        let requires_default_approval = tool.requires_approval_by_default();

        // 0.5 编辑前必须已读取（read-before-edit）：
        //     edit_file 的目标文件必须在本任务内先经 read_file 成功读取过
        //     （路径按 normalize_path 归一化比较），否则直接失败并提示先读取，
        //     不进入审批流程（注定失败的编辑不需要用户审批）。
        if tc.name == "edit_file" {
            if let Some(path) = tc.arguments.get("path").and_then(|v| v.as_str()) {
                if !path_was_read(&self.read_files.read(), path) {
                    return DispatchResult::from_tool_output(
                        ToolOutput::fail(format!("edit {}", path), read_before_edit_error(path)),
                        effective_risk,
                    );
                }
            }
        }

        // 0.6 覆盖已有文件前必须已读取（read-before-overwrite）：
        //     write_file 的目标已存在（覆盖）且本任务未读过 → 拦截提示先读取；
        //     目标不存在（新建）→ 放行。已读过的路径跳过 stat，省一次往返。
        if tc.name == "write_file" {
            if let Some(path) = tc.arguments.get("path").and_then(|v| v.as_str()) {
                if !path_was_read(&self.read_files.read(), path)
                    && remote_file_exists(&ctx.ssh, &ctx.session_id, path).await
                {
                    return DispatchResult::from_tool_output(
                        ToolOutput::fail(format!("write {}", path), read_before_write_error(path)),
                        effective_risk,
                    );
                }
            }
        }

        // 1. Compute sandbox/mode-level need for human confirmation.
        let sandbox_needs_confirm: Option<bool> = match &self.mode {
            AgentMode::Plan | AgentMode::Agent => {
                if tc.name == "execute_command" {
                    let cmd = tc
                        .arguments
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    Some(command_list_requires_confirm(cmd, &self.agent_settings))
                } else {
                    let mut needs_confirm = requires_default_approval
                        || match effective_risk {
                            RiskLevel::ReadOnly => false,
                            RiskLevel::LowRisk => self.agent_settings.confirm_each_command,
                            RiskLevel::Moderate => self.agent_settings.confirm_each_command,
                            RiskLevel::HighRisk | RiskLevel::Destructive => true,
                        };
                    if tc.name == "edit_file" && self.agent_settings.confirm_edit_file {
                        needs_confirm = true;
                    }
                    Some(needs_confirm)
                }
            }
            AgentMode::Auto => Some(requires_default_approval),
        };

        let sandbox_needs_confirm = match sandbox_needs_confirm {
            None => {
                return DispatchResult::blocked(
                    tc.name.clone(),
                    "当前模式禁止工具调用".to_string(),
                    effective_risk,
                );
            }
            Some(v) => v,
        };

        // 2. Model-based approval — runs for execute_command when an approver
        //    is configured, regardless of whether the sandbox requires human
        //    approval. The model can only judge; it cannot rewrite the command.
        //    Reuses the agent's normal model + retry path; failure after retries
        //    is surfaced as a blocked tool result.
        let mut final_needs_confirm = sandbox_needs_confirm;
        let mut model_reasons: Option<Vec<String>> = None;

        if tc.name == "execute_command" {
            if let Some(ref approver) = self.approver {
                let cmd = tc
                    .arguments
                    .get("command")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                // Signal the frontend that model approval is in progress.
                emit_event(
                    &ctx.app_handle,
                    event_name,
                    ModelApprovalStartEvent {
                        event_type: "modelApprovalStart".to_string(),
                        tool_call_id: tc.id.clone(),
                    },
                );

                let eval_result = approver.evaluate(cmd, recent_messages).await;

                match eval_result {
                    Ok(ModelApprovalDecision::Block(rs)) => {
                        emit_event(
                            &ctx.app_handle,
                            event_name,
                            ModelApprovalDoneEvent {
                                event_type: "modelApprovalDone".to_string(),
                                tool_call_id: tc.id.clone(),
                                decision: "block".to_string(),
                                reasons: rs.clone(),
                            },
                        );
                        let reason = if rs.is_empty() {
                            "模型审批阻止".to_string()
                        } else {
                            format!("模型审批阻止: {}", rs.join("; "))
                        };
                        let hint = "\n如果你认为这个命令是被冤枉阻止的，请先解释你的理由，然后重新尝试执行。";
                        return DispatchResult::blocked(
                            format!("$ {}", cmd),
                            format!("{}{}", reason, hint),
                            effective_risk,
                        );
                    }
                    Ok(ModelApprovalDecision::RouteToHuman(rs)) => {
                        emit_event(
                            &ctx.app_handle,
                            event_name,
                            ModelApprovalDoneEvent {
                                event_type: "modelApprovalDone".to_string(),
                                tool_call_id: tc.id.clone(),
                                decision: "route_to_human".to_string(),
                                reasons: rs.clone(),
                            },
                        );
                        // Auto 模式下跳过人审，直接执行；Agent 模式弹窗
                        if self.mode != AgentMode::Auto {
                            final_needs_confirm = true;
                            model_reasons = if rs.is_empty() { None } else { Some(rs) };
                        }
                    }
                    Ok(ModelApprovalDecision::Approve) => {
                        emit_event(
                            &ctx.app_handle,
                            event_name,
                            ModelApprovalDoneEvent {
                                event_type: "modelApprovalDone".to_string(),
                                tool_call_id: tc.id.clone(),
                                decision: "approve".to_string(),
                                reasons: vec![],
                            },
                        );
                    }
                    Err(e) => {
                        let err_msg = e.to_string();
                        emit_event(
                            &ctx.app_handle,
                            event_name,
                            ModelApprovalDoneEvent {
                                event_type: "modelApprovalDone".to_string(),
                                tool_call_id: tc.id.clone(),
                                decision: "error".to_string(),
                                reasons: vec![err_msg.clone()],
                            },
                        );
                        return DispatchResult::blocked(
                            format!("$ {}", cmd),
                            format!("模型审批失败: {}", err_msg),
                            effective_risk,
                        );
                    }
                }
            }
        }

        // 3. Human approval (if the sandbox or the model requires it).
        if final_needs_confirm {
            let mut approval_metadata: Option<serde_json::Value> = None;

            // edit_file: pre-read + validate before asking the user. Failures
            // that would make execute() fail must not open the approval dialog.
            if tc.name == "edit_file" {
                match crate::agent::tools::file_ops::preview_edit_for_approval(
                    &ctx.ssh,
                    &ctx.session_id,
                    &tc.arguments,
                )
                .await
                {
                    Ok(meta) => approval_metadata = Some(meta),
                    Err(e) => {
                        return DispatchResult {
                            summary: e.summary,
                            output: e.message,
                            success: false,
                            blocked: false,
                            was_timeout: false,
                            was_aborted: false,
                            metadata: None,
                            risk_level: effective_risk,
                        };
                    }
                }
            }

            let approved = self
                .approval
                .request_approval(
                    event_name,
                    self.task_id.clone(),
                    tc.id.clone(),
                    &tc.name,
                    tc.arguments.clone(),
                    effective_risk,
                    model_reasons.as_deref(),
                    approval_metadata,
                )
                .await;
            if !approved {
                let summary = if tc.name == "execute_command" {
                    let cmd = tc
                        .arguments
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    format!("$ {}", cmd)
                } else {
                    tc.name.clone()
                };
                return DispatchResult::blocked(summary, "用户拒绝", effective_risk);
            }
        }

        match tool.execute(tc.arguments.clone(), ctx).await {
            Ok(out) => {
                // read_file / write_file / edit_file 成功即记账：模型刚读过，
                // 或刚写入/改过的文件内容都在其上下文中，等价于"已观察"。
                // 后续 edit_file 与 write_file 覆盖的预读检查以此集合为准。
                if matches!(tc.name.as_str(), "read_file" | "write_file" | "edit_file")
                    && out.success
                {
                    if let Some(path) = tc.arguments.get("path").and_then(|v| v.as_str()) {
                        self.read_files
                            .write()
                            .insert(crate::agent::sandbox::normalize_path(path));
                    }
                }
                DispatchResult::from_tool_output(out, effective_risk)
            }
            Err(e) => DispatchResult {
                summary: format!("{} (error)", tc.name),
                output: format!("tool error: {}", e),
                success: false,
                blocked: false,
                was_timeout: false,
                was_aborted: false,
                metadata: None,
                risk_level: effective_risk,
            },
        }
    }
}

/// read-before-edit：目标路径是否已被本任务成功读取（归一化比较）。
/// 复用 sandbox 的 `normalize_path`（折叠 `//`、`.`、`..`、尾斜杠）。
fn path_was_read(read_files: &std::collections::HashSet<String>, path: &str) -> bool {
    read_files.contains(&crate::agent::sandbox::normalize_path(path))
}

/// read-before-edit 拦截时的固定错误文案（xxx 为本次 edit 传入的 path）。
fn read_before_edit_error(path: &str) -> String {
    format!(
        "错误：编辑操作需要先读取\"{}\" —— 请先读取该文件，然后再重试。",
        path
    )
}

/// read-before-overwrite 拦截时的固定错误文案（xxx 为本次 write 传入的 path）。
fn read_before_write_error(path: &str) -> String {
    format!(
        "错误：覆盖已有文件需要先读取\"{}\" —— 请先读取该文件，然后再重试。",
        path
    )
}

/// 远程目标是否存在（SFTP stat）。stat 失败按"不存在"处理：
/// 连接问题会由 write 自己报 SFTP 错误，这里不双重误拦新建。
async fn remote_file_exists(
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    path: &str,
) -> bool {
    match ssh.open_sftp(session_id).await {
        Ok(sftp) => sftp.metadata(path).await.is_ok(),
        Err(_) => false,
    }
}

fn command_list_requires_confirm(cmd: &str, settings: &AgentModeSettings) -> bool {
    let segments = match split_command_chain(cmd) {
        Ok(segs) => segs,
        Err(_) => return true, // conservative: if we can't parse, require confirm
    };
    for seg in &segments {
        let base = seg
            .trim()
            .split_whitespace()
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("");
        let in_list = settings.command_list.iter().any(|c| c == base);
        let needs_confirm = match settings.list_mode {
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
        };
        if needs_confirm {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_settings() -> AgentModeSettings {
        AgentModeSettings {
            list_mode: CommandListMode::Denylist,
            command_list: vec!["rm".into(), "mkfs".into(), "dd".into()],
            confirm_each_command: false,
            enable_model_command_approval: false,
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            system_prompt: String::new(),
            max_tool_rounds: 80,
            context_window: 0,
            confirm_edit_file: false,
        }
    }

    #[test]
    fn denylist_in_list_always_confirms() {
        let s = default_settings();
        assert!(command_list_requires_confirm("rm -rf /tmp", &s));
        assert!(command_list_requires_confirm("mkfs /dev/sda", &s));
        assert!(command_list_requires_confirm("dd if=/dev/zero of=img", &s));
    }

    #[test]
    fn denylist_not_in_list_respects_confirm_flag() {
        let s = default_settings();
        assert!(!command_list_requires_confirm("ls -la", &s));

        let mut s2 = default_settings();
        s2.confirm_each_command = true;
        assert!(command_list_requires_confirm("ls -la", &s2));
    }

    #[test]
    fn allowlist_in_list_respects_confirm_flag() {
        let s = AgentModeSettings {
            list_mode: CommandListMode::Allowlist,
            command_list: vec!["ls".into(), "cat".into()],
            confirm_each_command: false,
            enable_model_command_approval: false,
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            system_prompt: String::new(),
            max_tool_rounds: 80,
            context_window: 0,
            confirm_edit_file: false,
        };
        assert!(!command_list_requires_confirm("ls -la", &s));

        let mut s2 = s.clone();
        s2.confirm_each_command = true;
        assert!(command_list_requires_confirm("ls -la", &s2));
    }

    #[test]
    fn allowlist_not_in_list_always_confirms() {
        let s = AgentModeSettings {
            list_mode: CommandListMode::Allowlist,
            command_list: vec!["ls".into()],
            confirm_each_command: false,
            enable_model_command_approval: false,
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            system_prompt: String::new(),
            max_tool_rounds: 80,
            context_window: 0,
            confirm_edit_file: false,
        };
        assert!(command_list_requires_confirm("rm -rf /tmp", &s));
    }

    #[test]
    fn strips_path_prefix_from_base_command() {
        let s = default_settings();
        assert!(command_list_requires_confirm("/bin/rm -rf /tmp", &s));
        assert!(command_list_requires_confirm("/usr/bin/mkfs -t ext4", &s));
    }

    #[test]
    fn handles_empty_and_whitespace() {
        let s = default_settings();
        assert!(!command_list_requires_confirm("", &s));
        assert!(!command_list_requires_confirm("   ", &s));
    }

    #[test]
    fn confirm_each_command_true_overrides() {
        let s = AgentModeSettings {
            list_mode: CommandListMode::Denylist,
            command_list: vec![],
            confirm_each_command: true,
            enable_model_command_approval: false,
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            system_prompt: String::new(),
            max_tool_rounds: 80,
            context_window: 0,
            confirm_edit_file: false,
        };
        assert!(command_list_requires_confirm("echo hello", &s));
        assert!(command_list_requires_confirm("git status", &s));
    }

    #[test]
    fn detects_denylisted_cmd_after_newline() {
        let s = default_settings();
        // "ls\nrm -rf /etc" — rm is hidden behind a newline, must be caught
        assert!(command_list_requires_confirm("ls\nrm -rf /etc", &s));
        // CRLF variant
        assert!(command_list_requires_confirm("ls\r\nrm -rf /etc", &s));
        // Multiple segments, denylisted cmd is the last one
        assert!(command_list_requires_confirm(
            "ls\necho hi\nmkfs /dev/sda",
            &s
        ));
        // Denylisted cmd after semicolon (already worked, regression test)
        assert!(command_list_requires_confirm("ls; rm -rf /", &s));
    }

    #[test]
    fn conservative_on_unparseable_input() {
        let s = default_settings();
        // Subshell detected → conservative: require confirm
        assert!(command_list_requires_confirm("ls $(rm -rf /)", &s));
        // Backtick subshell
        assert!(command_list_requires_confirm("ls `rm -rf /`", &s));
    }

    // ── read-before-edit ──

    #[test]
    fn read_before_edit_error_message_format() {
        let msg = read_before_edit_error("/var/www/app.js");
        assert_eq!(
            msg,
            "错误：编辑操作需要先读取\"/var/www/app.js\" —— 请先读取该文件，然后再重试。"
        );
    }

    #[test]
    fn read_before_write_error_message_format() {
        let msg = read_before_write_error("/var/www/app.js");
        assert_eq!(
            msg,
            "错误：覆盖已有文件需要先读取\"/var/www/app.js\" —— 请先读取该文件，然后再重试。"
        );
    }

    #[test]
    fn path_was_read_matches_after_normalization() {
        let mut read = std::collections::HashSet::new();
        // 读取时带了冗余路径成分，编辑时用干净路径 → 归一化后应匹配
        read.insert(crate::agent::sandbox::normalize_path("/var//www/./app.js"));
        assert!(path_was_read(&read, "/var/www/app.js"));
        // 尾斜杠差异也应匹配
        assert!(path_was_read(&read, "/var/www/app.js/"));
        // 未读过的路径不匹配
        assert!(!path_was_read(&read, "/var/www/other.js"));
        // 空集合不匹配任何路径
        let empty = std::collections::HashSet::new();
        assert!(!path_was_read(&empty, "/var/www/app.js"));
    }
}
