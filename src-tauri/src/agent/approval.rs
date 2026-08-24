use serde::Serialize;
use tauri::AppHandle;

use crate::agent::interaction::AgentInteractionManager;
use crate::agent::sandbox::RiskLevel;

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
    /// Reasons from the model approval step (when it decided to route to human).
    /// Surfaced in the approval dialog so the user sees why human review is needed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasons: Option<Vec<String>>,
    /// Optional preview metadata (e.g. edit_file file_content / line_position).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Manages user approval flow for tool execution.
pub(crate) struct ApprovalManager {
    app: AppHandle,
    interaction_mgr: AgentInteractionManager,
}

impl ApprovalManager {
    pub fn new(app: AppHandle, interaction_mgr: AgentInteractionManager) -> Self {
        Self {
            app,
            interaction_mgr,
        }
    }

    /// Ask user for approval via the unified interaction queue.
    /// Returns `true` if approved, `false` if rejected or timed out.
    pub async fn request_approval(
        &self,
        task_id: String,
        session_id: String,
        conversation_id: String,
        tool_call_id: String,
        tool_name: &str,
        arguments: serde_json::Value,
        risk: RiskLevel,
        model_reasons: Option<&[String]>,
        metadata: Option<serde_json::Value>,
    ) -> bool {
        self.interaction_mgr
            .request_approval(
                &self.app,
                task_id,
                session_id,
                conversation_id,
                tool_call_id,
                tool_name,
                arguments,
                risk,
                model_reasons,
                metadata,
            )
            .await
    }
}
