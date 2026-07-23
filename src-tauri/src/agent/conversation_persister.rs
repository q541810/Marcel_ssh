use chrono::Utc;

use crate::agent::conversation::ConversationDb;
use crate::llm::provider::{LlmMessage, LlmRole};
use crate::sync::engine::SyncEngine;
use crate::sync::scheduler::SyncScheduler;

pub(crate) struct ConversationPersister {
    pub conv_db: std::sync::Arc<ConversationDb>,
    pub conversation_id: String,
    /// 同步引擎（可选，未配置同步时为 None）
    sync_engine: Option<std::sync::Arc<SyncEngine>>,
    /// 同步调度器（可选，未配置同步时为 None）
    sync_scheduler: Option<std::sync::Arc<SyncScheduler>>,
}

impl ConversationPersister {
    pub fn new(conv_db: std::sync::Arc<ConversationDb>, conversation_id: String) -> Self {
        Self {
            conv_db,
            conversation_id,
            sync_engine: None,
            sync_scheduler: None,
        }
    }

    /// 注入同步组件（由 agent_loop 创建 persister 后调用）。
    pub fn with_sync(
        mut self,
        engine: Option<std::sync::Arc<SyncEngine>>,
        scheduler: Option<std::sync::Arc<SyncScheduler>>,
    ) -> Self {
        self.sync_engine = engine;
        self.sync_scheduler = scheduler;
        self
    }

    /// Auto-update conversation title from the last user message.
    pub fn update_title_from_last_user_msg(&self, messages: &[LlmMessage]) {
        if let Some(msg) = messages
            .iter()
            .rev()
            .find(|m| m.role == LlmRole::User && (!m.content.is_empty() || m.image_paths.is_some()))
        {
            let title = if msg.content.is_empty() {
                "[image]".to_string()
            } else {
                msg.content.chars().take(30).collect::<String>()
            };
            let _ = self
                .conv_db
                .update_conversation_title(&self.conversation_id, &title);
        }
    }

    /// Persist the last user message.
    pub fn save_last_user_msg(&self, messages: &[LlmMessage]) {
        if let Some(msg) = messages.iter().rev().find(|m| m.role == LlmRole::User) {
            let has_images = msg
                .image_paths
                .as_ref()
                .map(|p| !p.is_empty())
                .unwrap_or(false);
            if msg.content.is_empty() && !has_images {
                return;
            }
            let image_paths_json = msg.image_paths.as_ref().and_then(|paths| {
                if paths.is_empty() {
                    None
                } else {
                    serde_json::to_string(paths).ok()
                }
            });
            let _ = self.conv_db.save_message_with_images(
                &self.conversation_id,
                "user",
                &msg.content,
                &Utc::now().to_rfc3339(),
                None,
                None,
                image_paths_json.as_deref(),
            );
            self.trigger_sync();
        }
    }

    pub fn save_msg(
        &self,
        role: &str,
        content: &str,
        tool_result_json: Option<&str>,
        reasoning: Option<&str>,
    ) {
        let _ = self.conv_db.save_message(
            &self.conversation_id,
            role,
            content,
            &Utc::now().to_rfc3339(),
            tool_result_json,
            reasoning,
        );
        self.trigger_sync();
    }

    /// 触发跨设备同步：记录本地变更 + 调度 push（防抖 700ms）。
    /// 未配置同步时静默跳过。
    fn trigger_sync(&self) {
        if let (Some(ref engine), Some(ref scheduler)) = (&self.sync_engine, &self.sync_scheduler)
        {
            // 会话作为整体版本单元 push（含 conversation 元数据 + 所有 messages）
            let key = format!("conversations.{}", self.conversation_id);
            // record_local_change 的 value 参数用于 diff 比对（避免无变更 bump 版本）。
            // 会话内容每次 save_msg 都会变化，传时间戳确保每次都 bump。
            // push 时 accessor.read_value 会读取真实值进行加密。
            let marker = chrono::Utc::now().to_rfc3339();
            let _ = engine.record_local_change(&key, &marker);
            scheduler.schedule_push();
        }
    }
}
