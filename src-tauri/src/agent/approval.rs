use tauri::AppHandle;

use crate::agent::interaction::{AgentInteractionManager, ApprovalAnswer};
use crate::agent::risk::Disposition;

/// Manages user approval flow for tool execution.
///
/// 审批请求**只**经统一交互队列（`AgentInteractionManager`）发给前端 ——
/// 那条路的事件是 `agent://interaction-active`，前端由 `interactionStore` 消费。
/// 这里原先还有一个 `ApprovalRequestEvent`（走 `agent://stream/{taskId}` 的老路），
/// 自交互队列接管后就不再被构造，已删除。
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
    ///
    /// 取消 / 通道丢弃都按"拒绝但不带理由"处理（见 `ApprovalAnswer::rejected`）。
    pub async fn request_approval(
        &self,
        task_id: String,
        session_id: String,
        conversation_id: String,
        tool_call_id: String,
        tool_name: &str,
        arguments: serde_json::Value,
        risk: Disposition,
        model_reasons: Option<&[String]>,
        metadata: Option<serde_json::Value>,
    ) -> ApprovalAnswer {
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
