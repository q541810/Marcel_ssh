use parking_lot::RwLock as PlRwLock;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

use crate::agent::sandbox::RiskLevel;
use crate::emit_event;
use crate::notification::{send_notification, NotificationKind};

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
}

/// Manages user approval flow for tool execution.
pub(crate) struct ApprovalManager {
    app: AppHandle,
    pending: Arc<PlRwLock<HashMap<(String, String), oneshot::Sender<bool>>>>,
}

impl ApprovalManager {
    pub fn new(
        app: AppHandle,
        pending: Arc<PlRwLock<HashMap<(String, String), oneshot::Sender<bool>>>>,
    ) -> Self {
        Self { app, pending }
    }

    /// Ask user for approval and wait up to 60 seconds.
    /// Returns `true` if approved, `false` if rejected or timed out.
    ///
    /// `model_reasons` — optional reasons from the model approval step, shown
    /// to the user in the approval dialog when the model routed to human.
    pub async fn request_approval(
        &self,
        event_name: &str,
        task_id: String,
        tool_call_id: String,
        tool_name: &str,
        arguments: serde_json::Value,
        risk: RiskLevel,
        model_reasons: Option<&[String]>,
    ) -> bool {
        let approval_id = tool_call_id.clone();
        emit_event(
            &self.app,
            event_name,
            ApprovalRequestEvent {
                event_type: "approvalRequest".to_string(),
                tool_call_id: approval_id.clone(),
                tool_name: tool_name.to_string(),
                arguments,
                risk_level: risk,
                reasons: model_reasons.map(|r| r.to_vec()),
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
            tool_name, risk_label
        );

        {
            let state = self.app.state::<crate::AppState>();
            let ns = state.settings.read().await.notification_settings.clone();
            send_notification(
                &self.app,
                NotificationKind::AgentApproval,
                &ns,
                "Agent 需要您的批准",
                &notification_body,
            );
        }

        let (tx, rx) = oneshot::channel();
        let key = (task_id.clone(), approval_id.clone());
        self.pending.write().insert(key.clone(), tx);

        match rx.await {
            Ok(v) => v,
            Err(_) => false,
        }
    }
}
