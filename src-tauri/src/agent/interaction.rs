//! Agent 阻塞式人机交互统一队列管理器（AgentInteractionManager）。
//!
//! 职责：
//! 1. **统一队列管理**：危险操作审批（Approval）、用户提问（Question）与密码输入（Credential）
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

use crate::agent::risk::Disposition;
use crate::agent::tools::question::QuestionItem;
use crate::emit_event;
use crate::notification::{send_notification, NotificationKind};

/// 全局交互事件名称
pub const AGENT_INTERACTION_EVENT: &str = "agent://interaction-active";
pub const AGENT_INTERACTION_CLEARED_EVENT: &str = "agent://interaction-cleared";

/// 交互类型。Credential 的回答只交给执行器，不进入模型对话。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum InteractionKind {
    Approval,
    Question,
    Credential,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialDetail {
    pub username: String,
    pub command: String,
    pub rejected: bool,
}

/// 审批请求详情
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalDetail {
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub disposition: Disposition,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasons: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
    /// 这次调用命中的风险规则 id（规则表或自定义规则）；没有命中为空。
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub rule_ids: Vec<String>,
}

/// 提问请求详情
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionDetail {
    pub question_id: String,
    pub questions: Vec<QuestionItem>,
    /// 这次提问是在替某个子 agent 向用户转问（子 agent 经 `ask_parent` 暂停，主 agent
    /// 拿不准、用 `ask_user(source_subagent=…)` 转问用户）。前端据此标明「这是子 agent
    /// 的问题」并给出跳转。普通提问不写这个键。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_subagent: Option<SourceSubagent>,
}

/// 转问的来源子 agent（见 [`QuestionDetail::source_subagent`]）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSubagent {
    /// 子对话 id（即 `continue_id`）。
    pub conversation_id: String,
    /// 子对话标题（界面上子 agent 卡片 / 会话列表里显示的那个名字）。
    pub title: String,
    /// 子 agent 那次 `ask_parent` 调用的 id。
    pub ask_tool_call_id: String,
}

/// 交互所在 SSH 会话的目标机器。
///
/// 以**结构化字段**下发而不是拼好的 `user@host:port` 字符串：隐私模式只脱敏屏幕
/// 显示，开关在前端、可随时切换，所以由前端用 `formatConnLabel` 按当前开关渲染
/// （切换时已弹出的面板也跟着变）。后端别再把地址拼进任何下发给前端的文案里。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTarget {
    pub username: String,
    pub host: String,
    pub port: u16,
}

impl SessionTarget {
    /// 给系统通知用的一行标签（通知不经前端渲染，得在这里按隐私开关定稿）。
    /// 脱敏口径与前端 `lib/privacy.ts` 的 `formatConnLabel` 一致：用户名保留，
    /// 主机 `***`、端口 `****`。
    fn label(&self, privacy_mode: bool) -> String {
        if privacy_mode {
            format!("{}@***:****", self.username)
        } else {
            format!("{}@{}:{}", self.username, self.host, self.port)
        }
    }
}

/// 系统通知里的会话标签；没有 SSH 会话信息（本机交互等）时用兜底名。
fn notification_session_label(target: Option<&SessionTarget>, privacy_mode: bool) -> String {
    target
        .map(|t| t.label(privacy_mode))
        .unwrap_or_else(|| "SSH 会话".to_string())
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
    /// 没有 SSH 会话信息（本机交互、会话已断开）时缺省，前端显示「SSH 会话」。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_target: Option<SessionTarget>,
    pub conversation_title: String,
    pub queue_length: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approval: Option<ApprovalDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub question: Option<QuestionDetail>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<CredentialDetail>,
}

/// 用户对一次审批的回答。
///
/// `reason` 是拒绝理由（可空），会**原样转达给模型**。
///
/// 为什么要有这个字段：以前这条通道只传一个 `bool`，模型收到的全部信息就是
/// 「用户拒绝」。它不知道自己哪里不对，于是换个写法再提一次，用户被迫反复拒绝 ——
/// 而用户心里其实是有理由的，只是没地方说。
#[derive(Debug, Clone, Default)]
pub struct ApprovalAnswer {
    pub approved: bool,
    /// 拒绝理由。空字符串视为没填。
    pub reason: Option<String>,
}

impl ApprovalAnswer {
    pub fn approved() -> Self {
        Self {
            approved: true,
            reason: None,
        }
    }

    /// 拒绝。理由在入口处 trim 掉首尾空白，空白串归一成 `None` —— 这段文字会
    /// 原样进模型提示词，一串空格和没有是同一回事。
    pub fn rejected(reason: Option<String>) -> Self {
        let reason = reason
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty());
        Self {
            approved: false,
            reason,
        }
    }
}

/// 交互响应内部通道枚举
enum InteractionResponder {
    Approval(oneshot::Sender<ApprovalAnswer>),
    Question(oneshot::Sender<Vec<serde_json::Value>>),
    Credential(oneshot::Sender<Option<zeroize::Zeroizing<String>>>),
}

/// 队列中的单个交互实体
struct QueuedInteraction {
    interaction_id: String,
    kind: InteractionKind,
    task_id: String,
    session_id: String,
    conversation_id: String,
    session_target: Option<SessionTarget>,
    conversation_title: String,
    approval: Option<ApprovalDetail>,
    question: Option<QuestionDetail>,
    credential: Option<CredentialDetail>,
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
            session_target: self.session_target.clone(),
            conversation_title: self.conversation_title.clone(),
            queue_length,
            approval: self.approval.clone(),
            question: self.question.clone(),
            credential: self.credential.clone(),
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

    /// 辅助方法：解析会话目标机器与对话标题
    async fn resolve_context_names(
        app: &AppHandle,
        session_id: &str,
        conversation_id: &str,
    ) -> (Option<SessionTarget>, String) {
        let state = app.state::<crate::AppState>();
        let session_target = state
            .ssh_manager
            .get_session_info(session_id)
            .await
            .map(|info| SessionTarget {
                username: info.username,
                host: info.host,
                port: info.port,
            });

        let conversation_title = state
            .conversation_db
            .get_conversation(conversation_id)
            .ok()
            .flatten()
            .map(|c| c.title)
            .unwrap_or_else(|| "Agent 会话".to_string());

        (session_target, conversation_title)
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
        risk: Disposition,
        model_reasons: Option<&[String]>,
        metadata: Option<serde_json::Value>,
        rule_ids: Vec<String>,
    ) -> ApprovalAnswer {
        let interaction_id = format!("approval:{}:{}", task_id, tool_call_id);
        let (session_target, conversation_title) =
            Self::resolve_context_names(app, &session_id, &conversation_id).await;

        let (tx, rx) = oneshot::channel();
        let approval_detail = ApprovalDetail {
            tool_call_id: tool_call_id.clone(),
            tool_name: tool_name.to_string(),
            arguments,
            disposition: risk,
            reasons: model_reasons.map(|r| r.to_vec()),
            metadata,
            rule_ids,
        };

        let is_head = {
            let mut inner = self.inner.write();
            let queued = QueuedInteraction {
                interaction_id: interaction_id.clone(),
                kind: InteractionKind::Approval,
                task_id: task_id.clone(),
                session_id: session_id.clone(),
                conversation_id: conversation_id.clone(),
                session_target: session_target.clone(),
                conversation_title: conversation_title.clone(),
                approval: Some(approval_detail),
                question: None,
                credential: None,
                responder: Some(InteractionResponder::Approval(tx)),
            };
            inner.queue.push_back(queued);
            inner.by_id.insert(interaction_id.clone(), task_id.clone());
            inner.queue.len() == 1
        };

        // 发送系统通知
        {
            let state = app.state::<crate::AppState>();
            let (ns, privacy_mode) = {
                let settings = state.settings.read().await;
                (
                    settings.notification_settings.clone(),
                    settings.privacy_mode,
                )
            };
            let disposition_label = risk.label();
            let body = format!(
                "[{}] 工具: {}\n处置: {}\n点击查看详情",
                notification_session_label(session_target.as_ref(), privacy_mode),
                tool_name,
                disposition_label
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
        let answer = match rx.await {
            Ok(v) => v,
            // 通道被丢弃（任务/会话取消）按"拒绝但不带理由"处理。
            Err(_) => ApprovalAnswer::rejected(None),
        };

        // 出队并激活下一个
        self.remove_and_advance(app, &task_id, &interaction_id);
        answer
    }

    /// 请求提问并等待用户回答
    #[allow(clippy::too_many_arguments)]
    pub async fn request_question(
        &self,
        app: &AppHandle,
        task_id: String,
        session_id: String,
        conversation_id: String,
        question_id: String,
        questions: Vec<QuestionItem>,
        source_subagent: Option<SourceSubagent>,
    ) -> Option<Vec<serde_json::Value>> {
        let interaction_id = format!("question:{}:{}", task_id, question_id);
        let (session_target, conversation_title) =
            Self::resolve_context_names(app, &session_id, &conversation_id).await;

        let (tx, rx) = oneshot::channel();
        let question_detail = QuestionDetail {
            question_id: question_id.clone(),
            questions: questions.clone(),
            source_subagent,
        };

        let is_head = {
            let mut inner = self.inner.write();
            let queued = QueuedInteraction {
                interaction_id: interaction_id.clone(),
                kind: InteractionKind::Question,
                task_id: task_id.clone(),
                session_id: session_id.clone(),
                conversation_id: conversation_id.clone(),
                session_target: session_target.clone(),
                conversation_title: conversation_title.clone(),
                approval: None,
                question: Some(question_detail),
                credential: None,
                responder: Some(InteractionResponder::Question(tx)),
            };
            inner.queue.push_back(queued);
            inner.by_id.insert(interaction_id.clone(), task_id.clone());
            inner.queue.len() == 1
        };

        // 发送系统通知
        {
            let state = app.state::<crate::AppState>();
            let (ns, privacy_mode) = {
                let settings = state.settings.read().await;
                (
                    settings.notification_settings.clone(),
                    settings.privacy_mode,
                )
            };
            let title = format!("Agent 向您提问 ({} 题)", questions.len());
            let first_q = &questions[0];
            let body = format!(
                "[{}] {}: {}",
                notification_session_label(session_target.as_ref(), privacy_mode),
                first_q.header,
                first_q.question
            );
            send_notification(app, NotificationKind::AgentQuestion, &ns, &title, &body);
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

    /// 密码单独经过 oneshot 交给执行器，不进入 Question 的模型回答路径。
    pub async fn request_credential(
        &self,
        app: &AppHandle,
        task_id: String,
        session_id: String,
        conversation_id: String,
        detail: CredentialDetail,
    ) -> Option<zeroize::Zeroizing<String>> {
        let interaction_id = format!("credential:{}", uuid::Uuid::new_v4());
        let (session_target, conversation_title) =
            Self::resolve_context_names(app, &session_id, &conversation_id).await;
        let (tx, rx) = oneshot::channel();
        let is_head = {
            let mut inner = self.inner.write();
            inner.queue.push_back(QueuedInteraction {
                interaction_id: interaction_id.clone(),
                kind: InteractionKind::Credential,
                task_id: task_id.clone(),
                session_id,
                conversation_id,
                session_target: session_target.clone(),
                conversation_title,
                approval: None,
                question: None,
                credential: Some(detail),
                responder: Some(InteractionResponder::Credential(tx)),
            });
            inner.by_id.insert(interaction_id.clone(), task_id.clone());
            inner.queue.len() == 1
        };
        // 执行器取消/断线会 drop 等待 future，仍必须从队列移除密码框。
        let _guard = CredentialGuard {
            manager: self.clone(),
            app: app.clone(),
            task_id,
            interaction_id,
        };
        {
            let state = app.state::<crate::AppState>();
            let settings = state.settings.read().await;
            let body = format!(
                "[{}] 等待输入 sudo 账户密码",
                notification_session_label(session_target.as_ref(), settings.privacy_mode)
            );
            send_notification(
                app,
                NotificationKind::AgentQuestion,
                &settings.notification_settings,
                "需要 sudo 密码",
                &body,
            );
        }
        if is_head {
            self.notify_active_head(app);
        }
        rx.await.ok().flatten()
    }

    pub fn respond_credential(
        &self,
        id: &str,
        password: Option<zeroize::Zeroizing<String>>,
    ) -> bool {
        let mut inner = self.inner.write();
        let Some(item) = inner
            .queue
            .iter_mut()
            .find(|i| i.interaction_id == id && i.kind == InteractionKind::Credential)
        else {
            return false;
        };
        let Some(InteractionResponder::Credential(tx)) = item.responder.take() else {
            return false;
        };
        tx.send(password).is_ok()
    }

    /// 用户响应审批
    pub fn respond_approval(
        &self,
        _app: &AppHandle,
        task_id: &str,
        tool_call_id: &str,
        approved: bool,
        reason: Option<String>,
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
            let answer = if approved {
                ApprovalAnswer::approved()
            } else {
                ApprovalAnswer::rejected(reason)
            };
            let _ = tx.send(answer);
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
                            let _ = tx.send(ApprovalAnswer::rejected(None));
                        }
                        InteractionResponder::Question(tx) => {
                            let _ = tx.send(Vec::new());
                        }
                        InteractionResponder::Credential(tx) => {
                            let _ = tx.send(None);
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
                            let _ = tx.send(ApprovalAnswer::rejected(None));
                        }
                        InteractionResponder::Question(tx) => {
                            let _ = tx.send(Vec::new());
                        }
                        InteractionResponder::Credential(tx) => {
                            let _ = tx.send(None);
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

struct CredentialGuard {
    manager: AgentInteractionManager,
    app: AppHandle,
    task_id: String,
    interaction_id: String,
}

impl Drop for CredentialGuard {
    fn drop(&mut self) {
        self.manager
            .remove_and_advance(&self.app, &self.task_id, &self.interaction_id);
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

    fn target() -> SessionTarget {
        SessionTarget {
            username: "root".into(),
            host: "203.0.113.7".into(),
            port: 2222,
        }
    }

    #[test]
    fn notification_label_masks_address_in_privacy_mode() {
        let t = target();
        assert_eq!(
            notification_session_label(Some(&t), false),
            "root@203.0.113.7:2222"
        );
        let masked = notification_session_label(Some(&t), true);
        assert_eq!(masked, "root@***:****");
        assert!(!masked.contains("203.0.113.7") && !masked.contains("2222"));
    }

    #[test]
    fn notification_label_falls_back_without_session() {
        assert_eq!(notification_session_label(None, true), "SSH 会话");
        assert_eq!(notification_session_label(None, false), "SSH 会话");
    }

    /// 下发给前端的 payload 里不许出现拼好的地址字符串：地址只以结构化字段出现，
    /// 由前端按隐私开关渲染。
    #[test]
    fn payload_carries_structured_target_not_a_joined_label() {
        let q = QueuedInteraction {
            interaction_id: "i".into(),
            kind: InteractionKind::Question,
            task_id: "t".into(),
            session_id: "s".into(),
            conversation_id: "c".into(),
            session_target: Some(target()),
            conversation_title: "title".into(),
            approval: None,
            question: None,
            credential: None,
            responder: None,
        };
        let json = serde_json::to_value(q.to_payload(1)).unwrap();
        assert!(json.get("sessionName").is_none());
        assert_eq!(json["sessionTarget"]["host"], "203.0.113.7");
        assert_eq!(json["sessionTarget"]["port"], 2222);
        assert!(!json.to_string().contains("root@203.0.113.7"));
    }

    #[tokio::test]
    async fn credential_response_is_one_shot_and_never_in_payload() {
        let manager = AgentInteractionManager::new();
        let (tx, rx) = oneshot::channel();
        let item = QueuedInteraction {
            interaction_id: "credential:one".into(),
            kind: InteractionKind::Credential,
            task_id: "task".into(),
            session_id: "session".into(),
            conversation_id: "conv".into(),
            session_target: Some(target()),
            conversation_title: "title".into(),
            approval: None,
            question: None,
            credential: Some(CredentialDetail {
                username: "root".into(),
                command: "sudo id".into(),
                rejected: false,
            }),
            responder: Some(InteractionResponder::Credential(tx)),
        };
        let before = serde_json::to_value(item.to_payload(1)).unwrap();
        manager.inner.write().queue.push_back(item);
        assert!(!manager.respond_credential(
            "credential:stale",
            Some(zeroize::Zeroizing::new("not-sent".into()))
        ));
        assert!(manager.respond_credential(
            "credential:one",
            Some(zeroize::Zeroizing::new("actual-secret".into()))
        ));
        assert_eq!(rx.await.unwrap().unwrap().as_str(), "actual-secret");
        assert!(!manager.respond_credential("credential:one", None));
        let after = serde_json::to_value(manager.inner.read().queue.front().unwrap().to_payload(1))
            .unwrap();
        assert_eq!(before, after);
        assert!(!after.to_string().contains("actual-secret"));
        assert!(after.get("question").is_none());
    }
}

#[cfg(test)]
mod approval_answer_tests {
    use super::ApprovalAnswer;

    #[test]
    fn rejected_normalizes_blank_reason_to_none() {
        assert_eq!(ApprovalAnswer::rejected(Some("   ".into())).reason, None);
        assert_eq!(ApprovalAnswer::rejected(Some(String::new())).reason, None);
        assert_eq!(ApprovalAnswer::rejected(None).reason, None);
        assert!(!ApprovalAnswer::rejected(None).approved);
    }

    #[test]
    fn rejected_keeps_a_real_reason() {
        let a = ApprovalAnswer::rejected(Some(" 有风险 ".into()));
        assert_eq!(a.reason.as_deref(), Some("有风险"));
        assert!(!a.approved);
    }

    #[test]
    fn approved_never_carries_a_reason() {
        let a = ApprovalAnswer::approved();
        assert!(a.approved);
        assert!(a.reason.is_none());
    }
}
