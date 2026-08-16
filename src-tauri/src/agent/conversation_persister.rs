use chrono::Utc;

use crate::agent::conversation::{ConversationDb, StoredMessage};
use crate::agent::context::CompactionOutcome;
use crate::llm::provider::{LlmMessage, LlmRole};
use crate::sync::engine::SyncEngine;
use crate::sync::scheduler::SyncScheduler;

/// 压缩卡片内容前缀（与前端 `parseCompactionSummary` 同源；改任一侧需同步）。
pub const COMPACTION_CARD_PREFIX: &str = "【上下文已压缩】";

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

    /// 提交一次上下文压缩到会话库（压缩由 LLM 完成后、splice 之外的结构化落库）。
    ///
    /// 算法（不依赖任何消息 id 对应关系——前端 store id 与 DB 行 id 是不同域）：
    /// 1. count-walk：按行序遍历未归档行，跳过 system 通知、卡片行计为
    ///    history-relevant（与前端投影同规则），取前 `shadowed_messages` 行；
    ///    （区间恒为 head-anchored 前缀 ⇒ 这 N 行就是被压区间。）
    /// 2. 指纹校验：walk 出的行提取 (role, tool 调用 id) 序列，与压缩区间的
    ///    `shadowed_roles` / `shadowed_tool_call_ids` 比对（tool 行的调用 id
    ///    取 `tool_calls_json.id`——与 loop 的 `tc.id` 同源）。不一致（旧数据
    ///    孤儿行等投影漂移）→ **不归档**、卡片落尾部（降级，绝不误删）。
    /// 3. 提交：被压行 `archived=1`（原文保留、加载/搜索隐藏）；卡片行
    ///    `created_at = 被压末行的 created_at`（行序上紧贴 span 末尾、尾首之前）
    ///    → `load_messages` 直接呈现压缩视图，前端零回放。
    ///
    /// 返回是否真正归档（false = 降级或失败；降级时卡片仍落库在尾部）。
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
        let count = outcome.shadowed_messages;

        // count-walk：跳过 system 通知，卡片行计为 history-relevant
        let mut span_rows: Vec<&StoredMessage> = Vec::new();
        for row in &rows {
            let is_card =
                row.role == "system" && row.content.starts_with(COMPACTION_CARD_PREFIX);
            if row.role == "system" && !is_card {
                continue;
            }
            span_rows.push(row);
            if span_rows.len() >= count {
                break;
            }
        }
        let ok = span_rows.len() == count
            && fingerprint_matches(
                &span_rows,
                &outcome.shadowed_roles,
                &outcome.shadowed_tool_call_ids,
            );

        let card_content = format!(
            "{COMPACTION_CARD_PREFIX}已整理 {} 条历史消息（约 {} tokens）\n\n{}",
            outcome.shadowed_messages, outcome.shadowed_tokens, outcome.summary
        );
        let created_at = if ok {
            span_rows.last().expect("ok ⇒ non-empty").created_at.to_rfc3339()
        } else {
            chrono::Utc::now().to_rfc3339()
        };
        let archive_ids: Vec<String> = if ok {
            span_rows.iter().map(|r| r.id.clone()).collect()
        } else {
            Vec::new()
        };

        if let Err(e) = self.conv_db.commit_compaction(
            &self.conversation_id,
            &archive_ids,
            &card_content,
            &created_at,
        ) {
            log::warn!(
                "persist_compaction: commit failed for {}: {}",
                self.conversation_id,
                e
            );
            return false;
        }
        self.trigger_sync();

        if !ok {
            log::warn!(
                "persist_compaction: span fingerprint mismatch for {} (rows={}, expected={}); degraded to append-only",
                self.conversation_id,
                span_rows.len(),
                count
            );
        }
        ok
    }
}

/// 行序列指纹与压缩区间指纹比对（角色序列 + tool 调用 id 序列）。
fn fingerprint_matches(
    rows: &[&StoredMessage],
    expected_roles: &[&str],
    expected_tool_ids: &[String],
) -> bool {
    let mut roles: Vec<&str> = Vec::with_capacity(rows.len());
    let mut tool_ids: Vec<String> = Vec::new();
    for row in rows {
        if row.role == "system" {
            roles.push("user"); // 压缩卡片行 ↔ loop 的 framed checkpoint（user）
        } else {
            roles.push(match row.role.as_str() {
                "user" => "user",
                "assistant" => "assistant",
                "tool" => "tool",
                _ => "user",
            });
        }
        if row.role == "tool" {
            tool_ids.push(extract_tool_call_id(row).unwrap_or_default());
        }
    }
    roles.len() == expected_roles.len()
        && roles.iter().zip(expected_roles).all(|(a, b)| *a == *b)
        && tool_ids.len() == expected_tool_ids.len()
        && tool_ids
            .iter()
            .zip(expected_tool_ids)
            .all(|(a, b)| a == b)
}

/// 从 tool 行提取工具调用 id（tool_calls_json：PersistedToolResult{id} 或 legacy 数组首元素）。
fn extract_tool_call_id(row: &StoredMessage) -> Option<String> {
    let json = row.tool_calls_json.as_deref()?;
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    match &v {
        serde_json::Value::Object(map) => map
            .get("id")
            .and_then(|i| i.as_str())
            .map(String::from),
        serde_json::Value::Array(arr) => arr
            .first()
            .and_then(|f| f.get("id"))
            .and_then(|i| i.as_str())
            .map(String::from),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::context::CompactionOutcome;

    fn outcome(
        shadowed_messages: usize,
        roles: Vec<&'static str>,
        tool_ids: Vec<String>,
    ) -> CompactionOutcome {
        CompactionOutcome {
            shadowed_messages,
            shadowed_tokens: 100,
            shadowed_start_non_system: 0,
            shadowed_roles: roles,
            shadowed_tool_call_ids: tool_ids,
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
    fn persist_compaction_matches_and_archives() {
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None).expect("m1");
        db.save_message(&conv.id, "assistant", "a1", "2026-01-01T00:00:01Z", None, None).expect("m2");
        db.save_message(&conv.id, "tool", "out", "2026-01-01T00:00:02Z", tool_result_json("X1").as_deref(), None).expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None).expect("m4");

        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        let ok = persister.persist_compaction(&outcome(3, vec!["user", "assistant", "tool"], vec!["X1".into()]));
        assert!(ok, "指纹一致 → 应真正归档");

        // 加载即压缩视图：卡片在 span 末尾，被压 3 条隐藏
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 2);
        assert!(after[0].content.starts_with(COMPACTION_CARD_PREFIX));
        assert_eq!(after[0].content.contains("3 条历史消息"), true);
        assert_eq!(after[1].content, "u2");
    }

    #[test]
    fn persist_compaction_tool_id_mismatch_degrades() {
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None).expect("m1");
        db.save_message(&conv.id, "assistant", "a1", "2026-01-01T00:00:01Z", None, None).expect("m2");
        db.save_message(&conv.id, "tool", "out", "2026-01-01T00:00:02Z", tool_result_json("X1").as_deref(), None).expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None).expect("m4");

        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        // 期望 tool id 是别的值 → 指纹不一致 → 降级（不归档、卡片落尾部）
        let ok = persister.persist_compaction(&outcome(3, vec!["user", "assistant", "tool"], vec!["WRONG".into()]));
        assert!(!ok);

        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 5); // 原文 4 条全保留 + 卡片在尾部
        assert_eq!(after[0].content, "u1");
        assert_eq!(after[4].content.contains("3 条历史消息"), true);
    }

    #[test]
    fn persist_compaction_row_shortage_degrades() {
        let db = std::sync::Arc::new(ConversationDb::in_memory().expect("db"));
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None).expect("m1");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:01Z", None, None).expect("m2");

        let persister = ConversationPersister::new(db.clone(), conv.id.clone());
        // 期望 3 条但 DB 只有 2 条 → 降级
        let ok = persister.persist_compaction(&outcome(3, vec!["user", "user", "user"], vec![]));
        assert!(!ok);

        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 3); // 原文 2 条 + 卡片（尾部、未归档）
        assert_eq!(after[0].content, "u1");
        assert_eq!(after[1].content, "u2");
        assert!(after[2].content.starts_with(COMPACTION_CARD_PREFIX));
    }
}
