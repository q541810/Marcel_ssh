use chrono::Utc;

use crate::agent::conversation::ConversationDb;
use crate::llm::provider::{LlmMessage, LlmRole};

pub(crate) struct ConversationPersister {
    pub conv_db: std::sync::Arc<ConversationDb>,
    pub conversation_id: String,
}

impl ConversationPersister {
    pub fn new(conv_db: std::sync::Arc<ConversationDb>, conversation_id: String) -> Self {
        Self {
            conv_db,
            conversation_id,
        }
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
    }
}
