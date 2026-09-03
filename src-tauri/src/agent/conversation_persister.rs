use chrono::Utc;

use crate::agent::context::CompactionOutcome;
use crate::agent::conversation::ConversationDb;
use crate::llm::provider::{LlmMessage, LlmRole};

/// 压缩卡片内容前缀（与前端 `parseCompactionSummary` 同源；改任一侧需同步）。
pub const COMPACTION_CARD_PREFIX: &str = "【上下文已压缩】";

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

    /// Auto-update conversation title from the first user message if title is still default or empty.
    pub fn update_title_from_first_user_msg(&self, messages: &[LlmMessage]) {
        // 先检查当前会话标题，如果不是默认名（如 "新会话" 或空），说明已经被设置过或用户自定义过，不覆盖
        if let Ok(Some(conv)) = self.conv_db.get_conversation(&self.conversation_id) {
            let trimmed = conv.title.trim();
            if !trimmed.is_empty() && trimmed != "新会话" {
                return;
            }
        }

        if let Some(msg) = messages
            .iter()
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

    /// Persist the last user message；成功时把 DB row id 回填到该消息的 `db_id`
    /// （压缩的 `tail_db_id` 指针依赖它——用户消息必须能作为卡片定位锚点）。
    pub fn save_last_user_msg(&self, messages: &mut [LlmMessage]) {
        if let Some(idx) = messages.iter().rposition(|m| m.role == LlmRole::User) {
            let has_images = messages[idx]
                .image_paths
                .as_ref()
                .map(|p| !p.is_empty())
                .unwrap_or(false);
            if messages[idx].content.is_empty() && !has_images {
                return;
            }
            let image_paths_json = messages[idx].image_paths.as_ref().and_then(|paths| {
                if paths.is_empty() {
                    None
                } else {
                    serde_json::to_string(paths).ok()
                }
            });
            let saved = self
                .conv_db
                .save_message_with_images(
                    &self.conversation_id,
                    "user",
                    &messages[idx].content,
                    &Utc::now().to_rfc3339(),
                    None,
                    None,
                    image_paths_json.as_deref(),
                )
                .ok();
            if let Some(stored) = saved {
                messages[idx].db_id = Some(stored.id);
            }
        }
    }

    /// 持久化一条消息；返回 DB row id（`messages.id`，压缩定位锚点）。
    /// 调用方负责把它回填到对应 `LlmMessage.db_id`。
    pub fn save_msg(
        &self,
        role: &str,
        content: &str,
        tool_result_json: Option<&str>,
        reasoning: Option<&str>,
    ) -> Option<String> {
        let saved = self
            .conv_db
            .save_message(
                &self.conversation_id,
                role,
                content,
                &Utc::now().to_rfc3339(),
                tool_result_json,
                reasoning,
            )
            .ok()?;
        Some(saved.id)
    }

    /// 提交一次上下文压缩到会话库（压缩由 LLM 完成后、splice 之外的结构化落库）。
    ///
    /// 算法（统一 id 指针 / 手动队尾，取代位置数数与指纹验证）：
    /// 1. 定位：
    ///    - `outcome.tail_db_id` 有值（自动压缩）→ 被压区间末条消息的 DB row id，
    ///      在 `load_messages` 行序中直接按 id 查行；
    ///    - `None`（**手动压缩 = 队尾语义**，本会话消息可能没有 db_id）→ 取
    ///      **最后一行**（卡片 = 对话末尾，与前端队尾追加位置严格一致）；
    /// 2. 吸收：定位行**之前最近一张**压缩卡（恒单卡——旧卡已被吸收）删除；
    /// 3. 提交：插入新卡片，`created_at` / `timestamp` 取**定位行**的值 →
    ///    `load_messages` 行序 = 原文 + 卡片紧贴被压区间末尾（保留尾部之前 /
    ///    手动为对话末尾），前端按"最后一张卡之前"屏蔽请求。
    ///
    /// 返回是否真正提交（false = 行不存在 / 库为空 / 失败；**不落任何卡片**，
    /// 原文完整保留）。
    pub fn persist_compaction(&self, outcome: &CompactionOutcome) -> bool {
        let rows = match self.conv_db.load_messages(&self.conversation_id) {
            Ok(r) => r,
            Err(e) => {
                log::warn!(
                    "persist_compaction: load failed for {}: {}",
                    self.conversation_id,
                    e
                );
                return false;
            }
        };
        // 定位：自动按 id 查行；手动（None）取最后一行（队尾）
        let tail_idx = match &outcome.tail_db_id {
            Some(tail_id) => match rows.iter().position(|r| r.id == *tail_id) {
                Some(i) => i,
                None => {
                    log::warn!(
                        "persist_compaction: tail row {} not found for {}; skipping persist",
                        tail_id,
                        self.conversation_id
                    );
                    return false;
                }
            },
            None => match rows.len().checked_sub(1) {
                Some(i) => i,
                None => {
                    log::warn!(
                        "persist_compaction: no rows to anchor manual tail for {}; skipping persist",
                        self.conversation_id
                    );
                    return false;
                }
            },
        };

        let card_content = format!(
            "{COMPACTION_CARD_PREFIX}已整理 {} 条历史消息（约 {} tokens）\n\n{}",
            outcome.shadowed_messages, outcome.shadowed_tokens, outcome.summary
        );
        // 吸收：定位行之前最近一张旧压缩卡（恒单卡——只留最新一张）
        let mut remove_card_ids: Vec<String> = Vec::new();
        for row in rows[..tail_idx].iter().rev() {
            if row.role == "system" && row.content.starts_with(COMPACTION_CARD_PREFIX) {
                remove_card_ids.push(row.id.clone());
                break;
            }
        }
        let span_end = &rows[tail_idx];
        let created_at = span_end.created_at.to_rfc3339();
        let timestamp = span_end.timestamp.clone();

        if let Err(e) = self.conv_db.commit_compaction(
            &self.conversation_id,
            &remove_card_ids,
            &card_content,
            &created_at,
            &timestamp,
        ) {
            log::warn!(
                "persist_compaction: commit failed for {}: {}",
                self.conversation_id,
                e
            );
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::context::CompactionOutcome;
    use crate::agent::conversation::StoredMessage;

    /// 构造 outcome：`tail_db_id` 指向 DB 中最后保存的（第 `shadowed_messages` 条）
    /// 消息行 id——模拟压缩"被压区间末条"。
    fn outcome_with_tail(shadowed_messages: usize, rows: &[StoredMessage]) -> CompactionOutcome {
        CompactionOutcome {
            shadowed_messages,
            shadowed_tokens: 100,
            tail_db_id: Some(rows[shadowed_messages - 1].id.clone()),
            summary: "## Primary Request\n- s".into(),
        }
    }

    fn tool_result_json(id: &str) -> Option<String> {
        Some(
            serde_json::json!({
                "id": id, "name": "cmd", "arguments": {},
                "risk_level": "LowRisk", "summary": "s", "success": true, "blocked": false
            })
            .to_string(),
        )
    }

    #[test]
    fn persist_compaction_locates_by_tail_id_and_keeps_originals() {
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(
            &conv.id,
            "assistant",
            "a1",
            "2026-01-01T00:00:01Z",
            None,
            None,
        )
        .expect("m2");
        db.save_message(
            &conv.id,
            "tool",
            "out",
            "2026-01-01T00:00:02Z",
            tool_result_json("X1").as_deref(),
            None,
        )
        .expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");

        let rows = db.load_messages(&conv.id).expect("load");
        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        let ok = persister.persist_compaction(&outcome_with_tail(3, &rows));
        assert!(ok, "id 指针命中 → 应提交");

        // 原文全保留；卡片紧贴被压区间末条（第 3 条）之后、保留尾部之前
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 5);
        assert_eq!(after[0].content, "u1");
        assert_eq!(after[1].content, "a1");
        assert_eq!(after[2].content, "out");
        assert!(after[3].content.starts_with(COMPACTION_CARD_PREFIX));
        assert_eq!(after[3].content.contains("3 条历史消息"), true);
        assert_eq!(after[4].content, "u2");
    }

    #[test]
    fn persist_compaction_manual_tail_none_anchors_to_last_row() {
        // 手动压缩（tail_db_id = None）→ 队尾语义：卡片插在最后一行之后；
        // 全新会话（本会话消息无 db_id）也能落库。
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(
            &conv.id,
            "assistant",
            "a1",
            "2026-01-01T00:00:01Z",
            None,
            None,
        )
        .expect("m2");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");

        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        let outcome = CompactionOutcome {
            shadowed_messages: 3,
            shadowed_tokens: 100,
            tail_db_id: None, // 手动队尾
            summary: "## Primary Request\n- s".into(),
        };
        let ok = persister.persist_compaction(&outcome);
        assert!(ok, "手动队尾 → 应提交");

        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 4);
        assert_eq!(after[0].content, "u1");
        assert_eq!(after[1].content, "a1");
        assert_eq!(after[2].content, "u2");
        assert!(
            after[3].content.starts_with(COMPACTION_CARD_PREFIX),
            "卡片在队尾"
        );
    }

    #[test]
    fn persist_compaction_manual_tail_absorbs_previous_card() {
        // 手动二次压缩：吸收最后一行之前最近一张旧卡（恒单卡）
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(
            &conv.id,
            "assistant",
            "a1",
            "2026-01-01T00:00:01Z",
            None,
            None,
        )
        .expect("m2");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");

        // 第一次手动压缩 → [u1, a1, u2, 卡]
        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        let first = CompactionOutcome {
            shadowed_messages: 3,
            shadowed_tokens: 100,
            tail_db_id: None,
            summary: "s1".into(),
        };
        assert!(persister.persist_compaction(&first));
        let mid = db.load_messages(&conv.id).expect("load");
        assert_eq!(mid.len(), 4);
        let first_card_id = mid[3].id.clone();

        // 第二次手动压缩（又有新消息）→ [u1, a1, u2, 新卡]（旧卡被吸收）
        db.save_message(&conv.id, "user", "u3", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");
        let second = CompactionOutcome {
            shadowed_messages: 4,
            shadowed_tokens: 200,
            tail_db_id: None,
            summary: "s2".into(),
        };
        assert!(persister.persist_compaction(&second));
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 5); // 原文 4 + 新卡
        assert!(!after.iter().any(|r| r.id == first_card_id), "旧卡被吸收");
        assert!(after[4].content.starts_with(COMPACTION_CARD_PREFIX));
        assert!(after[4].content.contains("4 条历史消息"));
    }

    #[test]
    fn persist_compaction_empty_db_manual_tail_skips() {
        // 防御：库为空时手动队尾无锚点 → 跳过落库
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");

        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        let outcome = CompactionOutcome {
            shadowed_messages: 1,
            shadowed_tokens: 100,
            tail_db_id: None,
            summary: "s".into(),
        };
        let ok = persister.persist_compaction(&outcome);
        assert!(!ok);
        assert!(db.load_messages(&conv.id).expect("load").is_empty());
    }

    #[test]
    fn persist_compaction_unknown_tail_id_skips() {
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");

        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        // tail id 指向不存在的行（如被回滚删除）→ 跳过落库，原文保留
        let outcome = CompactionOutcome {
            shadowed_messages: 1,
            shadowed_tokens: 100,
            tail_db_id: Some("ghost-row".into()),
            summary: "s".into(),
        };
        let ok = persister.persist_compaction(&outcome);
        assert!(!ok);
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].content, "u1");
    }

    #[test]
    fn persist_compaction_absorbs_previous_card() {
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(
            &conv.id,
            "assistant",
            "a1",
            "2026-01-01T00:00:01Z",
            None,
            None,
        )
        .expect("m2");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");
        db.save_message(
            &conv.id,
            "assistant",
            "a2",
            "2026-01-01T00:00:03Z",
            None,
            None,
        )
        .expect("m4");

        // 第一次压缩：压 2 条（u1, a1），卡片插在 a1 后
        let rows = db.load_messages(&conv.id).expect("load");
        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        assert!(persister.persist_compaction(&outcome_with_tail(2, &rows)));
        let mid = db.load_messages(&conv.id).expect("load");
        assert_eq!(mid.len(), 5); // u1 a1 卡 u2 a2
        let card_id = mid[2].id.clone();

        // 第二次压缩：压到 a2（含旧卡）→ 旧卡被吸收，新卡在 a2 后
        let rows2 = db.load_messages(&conv.id).expect("load");
        let ok = persister.persist_compaction(&outcome_with_tail(5, &rows2));
        assert!(ok);
        let after = db.load_messages(&conv.id).expect("load");
        // u1 a1 u2 a2 卡（旧卡被删除）
        assert_eq!(after.len(), 5);
        assert!(after[4].content.starts_with(COMPACTION_CARD_PREFIX));
        assert!(!after.iter().any(|r| r.id == card_id), "旧卡应被吸收删除");
    }

    #[test]
    fn persist_compaction_row_shortage_no_longer_needed() {
        // 回归锚点：旧 count-walk 的"行数不足"防御已由 tail_db_id 定位取代——
        // 只要 id 指向存在的行，即使 shadowed_messages 描述与实际行数不一致也照常落库。
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:01Z", None, None)
            .expect("m2");

        let rows = db.load_messages(&conv.id).expect("load");
        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        let ok = persister.persist_compaction(&outcome_with_tail(2, &rows));
        assert!(ok);
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 3);
        assert!(after[2].content.starts_with(COMPACTION_CARD_PREFIX));
    }

    #[test]
    fn update_title_from_first_user_msg_only_updates_when_default() {
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "新会话").expect("create");
        let persister = ConversationPersister::new(db.clone(), conv.id.clone());

        let messages = vec![
            LlmMessage::user("第一句话，应该作为会话名"),
            LlmMessage::assistant("回复"),
            LlmMessage::user("第二句话，不应该覆盖会话名"),
        ];

        persister.update_title_from_first_user_msg(&messages);
        let loaded = db.get_conversation(&conv.id).unwrap().unwrap();
        assert_eq!(loaded.title, "第一句话，应该作为会话名");

        // 再次触发（包含更多用户消息），标题保持第一句，不会被最后一句覆盖
        persister.update_title_from_first_user_msg(&messages);
        let loaded2 = db.get_conversation(&conv.id).unwrap().unwrap();
        assert_eq!(loaded2.title, "第一句话，应该作为会话名");
    }
}
