use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{oneshot};

use crate::agent::runtime::AgentMode;
use crate::agent::sandbox::{assess_risk, RiskLevel, Sandbox};
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
}

/// Event requesting user approval for a tool call.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApprovalRequestEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub risk_level: RiskLevel,
}

/// Result of executing a single tool call (UI/event view).
pub(crate) struct DispatchResult {
    pub summary: String,
    pub output: String,
    pub success: bool,
    pub blocked: bool,
    pub metadata: Option<serde_json::Value>,
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

/// Dispatches tool calls through the registry with mode-aware security policy.
pub(crate) struct ToolDispatcher {
    mode: AgentMode,
    agent_settings: AgentModeSettings,
    app: AppHandle,
    state: AppState,
    registry: std::sync::Arc<ToolRegistry>,
}

impl ToolDispatcher {
    pub fn new(
        mode: AgentMode,
        agent_settings: AgentModeSettings,
        app: AppHandle,
        state: AppState,
        registry: std::sync::Arc<ToolRegistry>,
    ) -> Self {
        Self {
            mode,
            agent_settings,
            app,
            state,
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

        match &self.mode {
            AgentMode::Chat => {
                return DispatchResult::blocked(
                    format!("{}", tc.name),
                    "CHAT 模式禁止工具调用".to_string(),
                );
            }
            AgentMode::Auto => {
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
                if tc.name == "execute_command" {
                    let cmd = tc.arguments.get("command").and_then(|v| v.as_str()).unwrap_or("");
                    let sb = Sandbox::default();
                    if let Err(e) = sb.check_command(cmd) {
                        return DispatchResult::blocked(format!("$ {}", cmd), e.to_string());
                    }
                    let needs_confirm = command_list_requires_confirm(cmd, &self.agent_settings);
                    if needs_confirm
                        && !self.await_user_approval(tc, effective_risk, event_name).await
                    {
                        return DispatchResult::blocked(
                            format!("$ {}", cmd),
                            "用户拒绝或确认超时",
                        );
                    }
                } else {
                    let needs_confirm = match effective_risk {
                        RiskLevel::ReadOnly => false,
                        RiskLevel::LowRisk => self.agent_settings.confirm_each_command,
                        RiskLevel::Moderate => self.agent_settings.confirm_each_command,
                        RiskLevel::HighRisk | RiskLevel::Destructive => true,
                    };
                    if needs_confirm
                        && !self.await_user_approval(tc, effective_risk, event_name).await
                    {
                        return DispatchResult::blocked(
                            tc.name.clone(),
                            "用户拒绝或确认超时",
                        );
                    }
                }
            }
        }

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

    async fn await_user_approval(
        &self,
        tc: &ToolCall,
        risk: RiskLevel,
        event_name: &str,
    ) -> bool {
        let approval_id = tc.id.clone();
        let _ = self.app.emit(
            event_name,
            ApprovalRequestEvent {
                event_type: "approvalRequest".to_string(),
                tool_call_id: approval_id.clone(),
                tool_name: tc.name.clone(),
                arguments: tc.arguments.clone(),
                risk_level: risk,
            },
        );

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

        if let Err(e) = self.app.notification()
            .builder()
            .title("Agent 需要您的批准")
            .body(&notification_body)
            .show()
        {
            log::warn!("发送通知失败: {}", e);
        }

        let (tx, rx) = oneshot::channel();
        self.state.pending_approvals.write().insert(approval_id.clone(), tx);

        match tokio::time::timeout(
            std::time::Duration::from_secs(60),
            rx,
        )
        .await
        {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => false,
            Err(_) => {
                self.state.pending_approvals.write().remove(&approval_id);
                false
            }
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
