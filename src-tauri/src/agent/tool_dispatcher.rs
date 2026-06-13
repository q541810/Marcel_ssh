use serde::Serialize;

use crate::agent::approval::ApprovalManager;
use crate::agent::sandbox::{assess_risk, RiskLevel};
use crate::agent::task::AgentMode;
use crate::agent::tools::{ToolContext, ToolOutput, ToolRegistry};
use crate::config::settings::{AgentModeSettings, CommandListMode};
use crate::llm::provider::ToolCall;
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
            summary: format!("unknown tool: {}", name),
            output: format!("Unknown tool: {}", name),
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
}

impl ToolDispatcher {
    pub fn new(
        mode: AgentMode,
        agent_settings: AgentModeSettings,
        task_id: String,
        app: tauri::AppHandle,
        state: AppState,
        registry: std::sync::Arc<ToolRegistry>,
    ) -> Self {
        Self {
            mode,
            agent_settings,
            task_id,
            approval: ApprovalManager::new(app, state.pending_approvals.clone()),
            registry,
        }
    }

    pub async fn dispatch(
        &self,
        tc: &ToolCall,
        ctx: &ToolContext,
        event_name: &str,
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
            _ => tool.risk_level(),
        };
        let requires_default_approval = tool.requires_approval_by_default();

        match &self.mode {
            AgentMode::Chat => {
                return DispatchResult::blocked(
                    format!("{}", tc.name),
                    "CHAT 模式禁止工具调用".to_string(),
                    effective_risk,
                );
            }
            AgentMode::Auto => {
                if requires_default_approval
                    && !self
                        .approval
                        .request_approval(
                            event_name,
                            self.task_id.clone(),
                            tc.id.clone(),
                            &tc.name,
                            tc.arguments.clone(),
                            effective_risk,
                        )
                        .await
                {
                    return DispatchResult::blocked(
                        tc.name.clone(),
                        "用户拒绝或确认超时",
                        effective_risk,
                    );
                }
            }
            AgentMode::Agent => {
                if tc.name == "execute_command" {
                    let cmd = tc
                        .arguments
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let needs_confirm = command_list_requires_confirm(cmd, &self.agent_settings);
                    if needs_confirm
                        && !self
                            .approval
                            .request_approval(
                                event_name,
                                self.task_id.clone(),
                                tc.id.clone(),
                                &tc.name,
                                tc.arguments.clone(),
                                effective_risk,
                            )
                            .await
                    {
                        return DispatchResult::blocked(
                            format!("$ {}", cmd),
                            "用户拒绝或确认超时",
                            effective_risk,
                        );
                    }
                } else {
                    let needs_confirm = requires_default_approval
                        || match effective_risk {
                            RiskLevel::ReadOnly => false,
                            RiskLevel::LowRisk => self.agent_settings.confirm_each_command,
                            RiskLevel::Moderate => self.agent_settings.confirm_each_command,
                            RiskLevel::HighRisk | RiskLevel::Destructive => true,
                        };
                    if needs_confirm
                        && !self
                            .approval
                            .request_approval(
                                event_name,
                                self.task_id.clone(),
                                tc.id.clone(),
                                &tc.name,
                                tc.arguments.clone(),
                                effective_risk,
                            )
                            .await
                    {
                        return DispatchResult::blocked(
                            tc.name.clone(),
                            "用户拒绝或确认超时",
                            effective_risk,
                        );
                    }
                }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn default_settings() -> AgentModeSettings {
        AgentModeSettings {
            list_mode: CommandListMode::Denylist,
            command_list: vec!["rm".into(), "mkfs".into(), "dd".into()],
            confirm_each_command: false,
            system_prompt: String::new(),
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
            system_prompt: String::new(),
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
            system_prompt: String::new(),
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
            system_prompt: String::new(),
        };
        assert!(command_list_requires_confirm("echo hello", &s));
        assert!(command_list_requires_confirm("git status", &s));
    }
}
