//! Agent 阻塞式人机交互统一队列管理器（AgentInteractionManager）。
//!
//! 职责：
//! 1. **统一队列管理**：所有 Agent 的危险操作审批（Approval）与用户提问（Question）
//!    统一进入串行队列，全局同一时刻最多只向前端展示 **1** 个待处理弹窗/面板。
//! 2. **上下文丰富**：向前端发出的交互请求包含关联的 SSH 会话名称、Agent 会话标题，
//!    以及是否是当前聚焦的上下文，方便用户在后台 Agent 请求审批时直接识别或一键跳转。
//! 3. **生命周期与级联取消**：
//!    - 当某个任务被取消或停止时，自动清理其在队列中的所有 pending 项并解除等待通道。
//!    - 当 SSH 会话断开时，自动清理该会话下全部 pending 交互。
//!    - 队头项完成后，自动顺延激活队列中的下一项并通知前端。

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::question::QuestionItem;
use crate::emit_event;
use crate::notification::{send_notification, NotificationKind};

/// 全局交互事件名称
pub const AGENT_INTERACTION_EVENT: &str = "agent://interaction-active";
pub const AGENT_INTERACTION_CLEARED_EVENT: &str = "agent://interaction-cleared";

/// 交互类型：审批 或 提问
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InteractionKind {
    Approval,
    Question,
}

/// 审批请求详情
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDetail {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub risk_level: RiskLevel,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasons: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// 提问请求详情
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionDetail {
    pub question_id: String,
    pub questions: Vec<QuestionItem>,
}

/// 发送给前端的全局活动交互 Payload
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveInteractionPayload {
    #[serde(rename = "type")]
    pub event_type: String,
    pub interaction_id: String,
    pub kind: InteractionKind,
    pub task_id: String,
    pub session_id: String,
    pub conversation_id: String,
    pub session_name: String,
    pub conversation_title: String,
    pub queue_length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<ApprovalDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<QuestionDetail>,
}

/// 交互响应内部通道枚举
enum InteractionResponder {
    Approval(oneshot::Sender<bool>),
    Question(oneshot::Sender<Vec<serde_json::Value>>),
}

/// 队列中的单个交互实体
struct QueuedInteraction {
    interaction_id: String,
    kind: InteractionKind,
    task_id: String,
    session_id: String,
    conversation_id: String,
    session_name: String,
    conversation_title: String,
    approval: Option<ApprovalDetail>,
    question: Option<QuestionDetail>,
    responder: Option<InteractionResponder>,
}

impl QueuedInteraction {
    fn to_payload(&self, queue_length: usize) -> ActiveInteractionPayload {
        ActiveInteractionPayload {
            event_type: "interactionActive".to_string(),
            interaction_id: self.interaction_id.clone(),
            kind: self.kind.clone(),
            task_id: self.task_id.clone(),
            session_id: self.session_id.clone(),
            conversation_id: self.conversation_id.clone(),
            session_name: self.session_name.clone(),
            conversation_title: self.conversation_title.clone(),
            queue_length,
            approval: self.approval.clone(),
            question: self.question.clone(),
        }
    }
}

struct ManagerInner {
    queue: VecDeque<QueuedInteraction>,
    /// interaction_id -> index in queue (快速索引，虽然队列通常很短)
    by_id: HashMap<String, String>,
}

/// 统一交互队列管理器
#[derive(Clone)]
pub struct AgentInteractionManager {
    inner: Arc<RwLock<ManagerInner>>,
}

impl AgentInteractionManager {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(ManagerInner {
                queue: VecDeque::new(),
                by_id: HashMap::new(),
            })),
        }
    }

    /// 辅助方法：解析会话显示名与对话标题
    async fn resolve_context_names(
        app: &AppHandle,
        session_id: &str,
        conversation_id: &str,
    ) -> (String, String) {
        let state = app.state::<crate::AppState>();
        let session_name = state
            .ssh_manager
            .get_session_info(session_id)
            .await
            .map(|info| format!("{}@{}:{}", info.username, info.host, info.port))
            .unwrap_or_else(|| "SSH 会话".to_string());

        let conversation_title = state
            .conversation_db
            .get_conversation(conversation_id)
            .ok()
            .flatten()
            .map(|c| c.title)
            .unwrap_or_else(|| "Agent 会话".to_string());

        (session_name, conversation_title)
    }

    /// 内部：通知前端当前队头（若有）
    fn notify_active_head(&self, app: &AppHandle) {
        let inner = self.inner.read();
        if let Some(head) = inner.queue.front() {
            let payload = head.to_payload(inner.queue.len());
            emit_event(app, AGENT_INTERACTION_EVENT, payload);
        } else {
            emit_event(
                app,
                AGENT_INTERACTION_CLEARED_EVENT,
                serde_json::json!({ "type": "interactionCleared" }),
            );
        }
    }

    /// 请求审批并等待用户确认（无超时限制，永久阻塞直到用户响应或取消）
    pub async fn request_approval(
        &self,
        app: &AppHandle,
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
        let interaction_id = format!("approval:{}:{}", task_id, tool_call_id);
        let (session_name, conversation_title) =
            Self::resolve_context_names(app, &session_id, &conversation_id).await;

        let (tx, rx) = oneshot::channel();
        let approval_detail = ApprovalDetail {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.to_string(),
            arguments,
            risk_level: risk,
            reasons: model_reasons.map(|r| r.to_vec()),
            metadata,
        };

        let is_head = {
            let mut inner = self.inner.write();
            let queued = QueuedInteraction {
                interaction_id: interaction_id.clone(),
                kind: InteractionKind::Approval,
                task_id: task_id.clone(),
                session_id: session_id.clone(),
                conversation_id: conversation_id.clone(),
                session_name: session_name.clone(),
                conversation_title: conversation_title.clone(),
                approval: Some(approval_detail),
                question: None,
                responder: Some(InteractionResponder::Approval(tx)),
            };
            inner.queue.push_back(queued);
            inner.by_id.insert(interaction_id.clone(), task_id.clone());
            inner.queue.len() == 1
        };

        // 发送系统通知
        {
            let state = app.state::<crate::AppState>();
            let ns = state.settings.read().await.notification_settings.clone();
            let risk_label = match risk {
                RiskLevel::ReadOnly => "只读",
                RiskLevel::LowRisk => "低风险",
                RiskLevel::Moderate => "中风险",
                RiskLevel::HighRisk => "高风险",
                RiskLevel::Destructive => "破坏性",
            };
            let body = format!(
                "[{}] 工具: {}\n风险等级: {}\n点击查看详情",
                session_name, tool_name, risk_label
            );
            send_notification(
                app,
                NotificationKind::AgentApproval,
                &ns,
                "Agent 需要您的批准",
                &body,
            );
        }

        if is_head {
            self.notify_active_head(app);
        }

        // 无限制等待用户响应或通道关闭（取消/断连）
        let approved = match rx.await {
            Ok(v) => v,
            Err(_) => false,
        };

        // 出队并激活下一个
        self.remove_and_advance(app, &task_id, &interaction_id);
        approved
    }

    /// 请求提问并等待用户回答
    pub async fn request_question(
        &self,
        app: &AppHandle,
        task_id: String,
        session_id: String,
        conversation_id: String,
        question_id: String,
        questions: Vec<QuestionItem>,
    ) -> Option<Vec<serde_json::Value>> {
        let interaction_id = format!("question:{}:{}", task_id, question_id);
        let (session_name, conversation_title) =
            Self::resolve_context_names(app, &session_id, &conversation_id).await;

        let (tx, rx) = oneshot::channel();
        let question_detail = QuestionDetail {
            question_id: question_id.clone(),
            questions: questions.clone(),
        };

        let is_head = {
            let mut inner = self.inner.write();
            let queued = QueuedInteraction {
                interaction_id: interaction_id.clone(),
                kind: InteractionKind::Question,
                task_id: task_id.clone(),
                session_id: session_id.clone(),
                conversation_id: conversation_id.clone(),
                session_name: session_name.clone(),
                conversation_title: conversation_title.clone(),
                approval: None,
                question: Some(question_detail),
                responder: Some(InteractionResponder::Question(tx)),
            };
            inner.queue.push_back(queued);
            inner.by_id.insert(interaction_id.clone(), task_id.clone());
            inner.queue.len() == 1
        };

        // 发送系统通知
        {
            let state = app.state::<crate::AppState>();
            let ns = state.settings.read().await.notification_settings.clone();
            let title = format!("Agent 向您提问 ({} 题)", questions.len());
            let first_q = &questions[0];
            let body = format!("[{}] {}: {}", session_name, first_q.header, first_q.question);
            send_notification(
                app,
                NotificationKind::AgentQuestion,
                &ns,
                &title,
                &body,
            );
        }

        if is_head {
            self.notify_active_head(app);
        }

        let answers = match rx.await {
            Ok(a) => Some(a),
            Err(_) => None,
        };

        self.remove_and_advance(app, &task_id, &interaction_id);
        answers
    }

    /// 用户响应审批
    pub fn respond_approval(
        &self,
        _app: &AppHandle,
        task_id: &str,
        tool_call_id: &str,
        approved: bool,
    ) -> bool {
        let interaction_id = format!("approval:{}:{}", task_id, tool_call_id);
        let sender = {
            let mut inner = self.inner.write();
            if let Some(item) = inner
                .queue
                .iter_mut()
                .find(|i| i.interaction_id == interaction_id && i.task_id == task_id)
            {
                if let Some(InteractionResponder::Approval(tx)) = item.responder.take() {
                    Some(tx)
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(tx) = sender {
            let _ = tx.send(approved);
            true
        } else {
            false
        }
    }

    /// 用户响应提问
    pub fn respond_question(
        &self,
        _app: &AppHandle,
        task_id: &str,
        question_id: &str,
        answers: Vec<serde_json::Value>,
    ) -> bool {
        let interaction_id = format!("question:{}:{}", task_id, question_id);
        let sender = {
            let mut inner = self.inner.write();
            if let Some(item) = inner
                .queue
                .iter_mut()
                .find(|i| i.interaction_id == interaction_id && i.task_id == task_id)
            {
                if let Some(InteractionResponder::Question(tx)) = item.responder.take() {
                    Some(tx)
                } else {
                    None
                }
            } else {
                None
            }
        };

        if let Some(tx) = sender {
            let _ = tx.send(answers);
            true
        } else {
            false
        }
    }

    /// 移除某个 interaction 并推动队列
    fn remove_and_advance(&self, app: &AppHandle, task_id: &str, interaction_id: &str) {
        let mut inner = self.inner.write();
        if let Some(idx) = inner
            .queue
            .iter()
            .position(|i| i.interaction_id == interaction_id && i.task_id == task_id)
        {
            inner.queue.remove(idx);
            inner.by_id.remove(interaction_id);
        }
        drop(inner);
        self.notify_active_head(app);
    }

    /// 取消某个 task_id 的全部交互
    pub fn cancel_task_interactions(&self, app: &AppHandle, task_id: &str) -> usize {
        let mut inner = self.inner.write();
        let mut cancelled = 0;
        let mut i = 0;
        let mut head_changed = false;
        while i < inner.queue.len() {
            if inner.queue[i].task_id == task_id {
                let mut item = inner.queue.remove(i).unwrap();
                inner.by_id.remove(&item.interaction_id);
                // 丢弃/拒绝等待者
                if let Some(responder) = item.responder.take() {
                    match responder {
                        InteractionResponder::Approval(tx) => {
                            let _ = tx.send(false);
                        }
                        InteractionResponder::Question(tx) => {
                            let _ = tx.send(Vec::new());
                        }
                    }
                }
                if i == 0 {
                    head_changed = true;
                }
                cancelled += 1;
            } else {
                i += 1;
            }
        }
        drop(inner);
        if head_changed || cancelled > 0 {
            self.notify_active_head(app);
        }
        cancelled
    }

    /// 取消某个 session_id 的全部交互（断连级联）
    pub fn cancel_session_interactions(&self, app: &AppHandle, session_id: &str) -> usize {
        let mut inner = self.inner.write();
        let mut cancelled = 0;
        let mut i = 0;
        let mut head_changed = false;
        while i < inner.queue.len() {
            if inner.queue[i].session_id == session_id {
                let mut item = inner.queue.remove(i).unwrap();
                inner.by_id.remove(&item.interaction_id);
                if let Some(responder) = item.responder.take() {
                    match responder {
                        InteractionResponder::Approval(tx) => {
                            let _ = tx.send(false);
                        }
                        InteractionResponder::Question(tx) => {
                            let _ = tx.send(Vec::new());
                        }
                    }
                }
                if i == 0 {
                    head_changed = true;
                }
                cancelled += 1;
            } else {
                i += 1;
            }
        }
        drop(inner);
        if head_changed || cancelled > 0 {
            self.notify_active_head(app);
        }
        cancelled
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_initializes_empty() {
        let mgr = AgentInteractionManager::new();
        assert_eq!(mgr.inner.read().queue.len(), 0);
    }
}
