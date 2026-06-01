use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::RwLock as PlRwLock;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

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
    pub async fn request_approval(
        &self,
        event_name: &str,
        task_id: String,
        tool_call_id: String,
        tool_name: &str,
        arguments: serde_json::Value,
        risk: RiskLevel,
    ) -> bool {
        let approval_id = tool_call_id.clone();
        let _ = self.app.emit(
            event_name,
            ApprovalRequestEvent {
                event_type: "approvalRequest".to_string(),
                tool_call_id: approval_id.clone(),
                tool_name: tool_name.to_string(),
                arguments,
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
            tool_name, risk_label
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
        let key = (task_id.clone(), approval_id.clone());
        self.pending.write().insert(key.clone(), tx);

        match timeout(Duration::from_secs(60), rx).await {
            Ok(Ok(v)) => v,
            Ok(Err(_)) => false,
            Err(_) => {
                self.pending.write().remove(&key);
                false
            }
        }
    }
}
