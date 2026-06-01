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
            .find(|m| m.role == LlmRole::User && !m.content.is_empty())
        {
            let title = msg.content.chars().take(30).collect::<String>();
            let _ = self
                .conv_db
                .update_conversation_title(&self.conversation_id, &title);
        }
    }

    /// Persist the last user message.
    pub fn save_last_user_msg(&self, messages: &[LlmMessage]) {
        if let Some(msg) = messages.iter().rev().find(|m| m.role == LlmRole::User) {
            if !msg.content.is_empty() {
                let _ = self.conv_db.save_message(
                    &self.conversation_id,
                    "user",
                    &msg.content,
                    &Utc::now().to_rfc3339(),
                    None,
                    None,
                );
            }
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
