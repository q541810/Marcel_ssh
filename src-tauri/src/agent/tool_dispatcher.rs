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
            let approval_provider = if !agent_settings.model_approval_model.is_empty() {
                let mut cfg = provider.config().clone();
                cfg.model = agent_settings.model_approval_model.clone();
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
                provider.clone()
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
                    Some(
                        requires_default_approval
                            || match effective_risk {
                                RiskLevel::ReadOnly => false,
                                RiskLevel::LowRisk => self.agent_settings.confirm_each_command,
                                RiskLevel::Moderate => self.agent_settings.confirm_each_command,
                                RiskLevel::HighRisk | RiskLevel::Destructive => true,
                            },
                    )
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
            Ok(out) => DispatchResult::from_tool_output(out, effective_risk),
            Err(e) => DispatchResult {
                summary: format!("{} (error)", tc.name),
                output: format!("tool error: {}", e),
                success: false,
                blocked: false,
                was_timeout: false,
                metadata: None,
                risk_level: effective_risk,
            },
        }
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
}
