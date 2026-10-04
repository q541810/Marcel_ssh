// 会话表的 CRUD：创建（含子对话）、列表、全文搜索、改名、touch、置顶、
// 会话级模型/档位记忆、级联删除与跨设备同步的 upsert。
use chrono::Utc;
use rusqlite::Result as RusqliteResult;
use uuid::Uuid;

use super::model::{Conversation, ConversationSearchResult, ConversationWithMessages};
use super::usage::ConversationUsage;
use super::{escape_like, make_match_snippet};

use super::ConversationDb;

impl ConversationDb {
    pub fn create_conversation(
        &self,
        connection_id: &str,
        title: &str,
    ) -> RusqliteResult<Conversation> {
        self.insert_conversation(connection_id, title, None)
    }

    /// 创建子agent对话（subagent 工具派发的子 agent 专属）。
    /// parent_conversation_id 记录主对话 id：会话列表据此隐藏子对话，
    /// 子对话内提供"返回主对话"，删除主对话时级联删除子对话。
    pub fn create_sub_conversation(
        &self,
        connection_id: &str,
        title: &str,
        parent_conversation_id: &str,
    ) -> RusqliteResult<Conversation> {
        self.insert_conversation(connection_id, title, Some(parent_conversation_id))
    }

    fn insert_conversation(
        &self,
        connection_id: &str,
        title: &str,
        parent_conversation_id: Option<&str>,
    ) -> RusqliteResult<Conversation> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        let now_str = now.to_rfc3339();
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO conversations (id, connection_id, title, created_at, updated_at, parent_conversation_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            (
                &id,
                connection_id,
                title,
                &now_str,
                &now_str,
                parent_conversation_id,
            ),
        )?;

        Ok(Conversation {
            id,
            connection_id: connection_id.to_string(),
            title: title.to_string(),
            created_at: now,
            updated_at: now,
            parent_conversation_id: parent_conversation_id.map(String::from),
            model_id: None,
            reasoning_effort: None,
            pinned: false,
            usage: ConversationUsage::default(),
            context_window: None,
        })
    }

    pub fn list_conversations(&self, connection_id: &str) -> RusqliteResult<Vec<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, title, created_at, updated_at, parent_conversation_id, model_id, pinned, usage_json
             FROM conversations
             WHERE connection_id = ?1
             ORDER BY pinned DESC, updated_at DESC",
        )?;

        let conversations = stmt
            .query_map([connection_id], |row| {
                Ok(Conversation {
                    id: row.get(0)?,
                    connection_id: row.get(1)?,
                    title: row.get(2)?,
                    created_at: row
                        .get::<_, String>(3)?
                        .parse()
                        .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC),
                    updated_at: row
                        .get::<_, String>(4)?
                        .parse()
                        .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC),
                    parent_conversation_id: row.get(5).ok(),
                    model_id: row.get(6).ok(),
                    reasoning_effort: None,
                    pinned: row.get(7)?,
                    usage: ConversationUsage::from_json_column(row.get(8).ok()),
                    context_window: None,
                })
            })?
            .collect::<RusqliteResult<Vec<_>>>()?;

        Ok(conversations)
    }

    /// 全文搜索消息内容，按会话聚合。
    /// - keyword 为空返回空列表
    /// - 每会话最多 200 条匹配 message id（按消息时间升序）
    /// - 最多返回 100 个会话，按 conversations.updated_at 倒序
    pub fn search_conversations(
        &self,
        keyword: &str,
        connection_id: Option<&str>,
    ) -> RusqliteResult<Vec<ConversationSearchResult>> {
        const MAX_MESSAGE_IDS: usize = 200;
        const MAX_CONVERSATIONS: usize = 100;

        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(vec![]);
        }

        let pattern = format!("%{}%", escape_like(keyword));
        let conn = self.conn.lock().unwrap();

        // 先按会话 updated_at 倒序、消息 created_at 升序取出匹配行，再在内存聚合
        let sql = if connection_id.is_some() {
            "SELECT m.id, m.content, m.created_at,
                    c.id, c.title, c.connection_id, c.updated_at
             FROM messages m
             INNER JOIN conversations c ON c.id = m.conversation_id
             WHERE m.content LIKE ?1 ESCAPE '\\' COLLATE NOCASE
               AND c.connection_id = ?2
               AND c.parent_conversation_id IS NULL
             ORDER BY c.updated_at DESC, m.created_at ASC, m.rowid ASC"
        } else {
            "SELECT m.id, m.content, m.created_at,
                    c.id, c.title, c.connection_id, c.updated_at
             FROM messages m
             INNER JOIN conversations c ON c.id = m.conversation_id
             WHERE m.content LIKE ?1 ESCAPE '\\' COLLATE NOCASE
               AND c.parent_conversation_id IS NULL
             ORDER BY c.updated_at DESC, m.created_at ASC, m.rowid ASC"
        };

        let mut stmt = conn.prepare(sql)?;

        type RowTuple = (String, String, String, String, String, String, String);

        let rows: Vec<RowTuple> = if let Some(cid) = connection_id {
            stmt.query_map(rusqlite::params![pattern, cid], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })?
            .collect::<RusqliteResult<Vec<_>>>()?
        } else {
            stmt.query_map([&pattern], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })?
            .collect::<RusqliteResult<Vec<_>>>()?
        };

        let mut results: Vec<ConversationSearchResult> = Vec::new();
        let mut index_by_conv: std::collections::HashMap<String, usize> =
            std::collections::HashMap::new();

        for (msg_id, content, _msg_created, conv_id, title, conn_id, updated_at) in rows {
            if let Some(&idx) = index_by_conv.get(&conv_id) {
                let item = &mut results[idx];
                item.match_count += 1;
                if item.matched_message_ids.len() < MAX_MESSAGE_IDS {
                    item.matched_message_ids.push(msg_id);
                }
            } else {
                if results.len() >= MAX_CONVERSATIONS {
                    // 相同 updated_at 时可能交错，跳过未入选会话即可
                    continue;
                }
                let snippet = make_match_snippet(&content, keyword);
                let updated = updated_at
                    .parse()
                    .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC);
                index_by_conv.insert(conv_id.clone(), results.len());
                results.push(ConversationSearchResult {
                    conversation_id: conv_id,
                    title,
                    connection_id: conn_id,
                    matched_snippet: snippet,
                    match_count: 1,
                    matched_message_ids: vec![msg_id],
                    updated_at: updated,
                });
            }
        }

        // 结果已按首次出现顺序（即 updated_at DESC）构建
        Ok(results)
    }

    pub fn delete_conversation(&self, conversation_id: &str) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        conn.execute(
            "DELETE FROM plan_snapshots WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        conn.execute(
            "DELETE FROM plans WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        conn.execute("DELETE FROM conversations WHERE id = ?1", [conversation_id])?;
        drop(conn);
        crate::agent::image_store::delete_conversation_images(conversation_id);
        Ok(())
    }

    /// 级联删除：删除该对话及其全部子agent对话（subagent 工具创建）。
    /// 返回被删除的对话 id 列表（含自身）。
    /// 子agent不能再派发子agent（plan 工具集无 subagent 工具 + 工具内嵌套防御），
    /// 这里用 BFS 遍历防御任何残留的多层结构。
    pub fn delete_conversation_cascade(
        &self,
        conversation_id: &str,
    ) -> RusqliteResult<Vec<String>> {
        let mut to_delete: Vec<String> = vec![conversation_id.to_string()];
        let mut idx = 0;
        while idx < to_delete.len() {
            let parent = to_delete[idx].clone();
            let children: Vec<String> = {
                let conn = self.conn.lock().unwrap();
                let mut stmt =
                    conn.prepare("SELECT id FROM conversations WHERE parent_conversation_id = ?1")?;
                let rows: Vec<String> = stmt
                    .query_map([&parent], |row| row.get(0))?
                    .filter_map(|r| r.ok())
                    .collect();
                rows
            };
            for child in children {
                if !to_delete.contains(&child) {
                    to_delete.push(child);
                }
            }
            idx += 1;
        }
        // 先删子对话再删自身（顺序无硬性要求，逐个走完整清理逻辑）
        for id in to_delete.iter().rev() {
            self.delete_conversation(id)?;
        }
        Ok(to_delete)
    }

    pub fn delete_conversations_by_connection(&self, connection_id: &str) -> RusqliteResult<()> {
        let ids: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT id FROM conversations WHERE connection_id = ?1")?;
            let rows: Vec<String> = stmt
                .query_map([connection_id], |row| row.get(0))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };

        for id in ids {
            self.delete_conversation(&id)?;
        }

        Ok(())
    }

    pub fn update_conversation_title(
        &self,
        conversation_id: &str,
        title: &str,
    ) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET title = ?1, updated_at = ?2 WHERE id = ?3",
            (title, Utc::now().to_rfc3339(), conversation_id),
        )?;
        Ok(())
    }

    pub fn touch_conversation(&self, conversation_id: &str) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            (Utc::now().to_rfc3339(), conversation_id),
        )?;
        Ok(())
    }

    /// 读取单个会话的元数据（不含消息）。
    pub fn get_conversation(&self, conversation_id: &str) -> RusqliteResult<Option<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, title, created_at, updated_at, parent_conversation_id, model_id, pinned, usage_json
             FROM conversations
             WHERE id = ?1",
        )?;
        let mut rows = stmt.query_map([conversation_id], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                connection_id: row.get(1)?,
                title: row.get(2)?,
                created_at: row
                    .get::<_, String>(3)?
                    .parse()
                    .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC),
                updated_at: row
                    .get::<_, String>(4)?
                    .parse()
                    .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC),
                parent_conversation_id: row.get(5).ok(),
                model_id: row.get(6).ok(),
                reasoning_effort: None,
                pinned: row.get(7)?,
                usage: ConversationUsage::from_json_column(row.get(8).ok()),
                context_window: None,
            })
        })?;
        match rows.next() {
            Some(Ok(c)) => Ok(Some(c)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// 设置会话级模型选择（`llmRegistry` 模型条目 id）。
    /// `model_id` 为空串/None = 清除选择，回落全局默认模型。
    /// 返回是否真的有会话被更新。
    pub fn set_conversation_model_id(
        &self,
        conversation_id: &str,
        model_id: Option<&str>,
    ) -> RusqliteResult<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE conversations SET model_id = ?1 WHERE id = ?2",
            (model_id, conversation_id),
        )?;
        Ok(rows > 0)
    }

    /// 设置/取消会话置顶。返回是否真的有会话被更新。
    ///
    /// 刻意**不更新 `updated_at`**：置顶是列表视图的元数据，不是内容变更。
    /// 若顺手 touch，取消置顶会把对话打到日期分组最前面，用户的时间序就乱了
    /// （同 `skills::store::apply_user_order` 的口径）。
    pub fn set_conversation_pinned(
        &self,
        conversation_id: &str,
        pinned: bool,
    ) -> RusqliteResult<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE conversations SET pinned = ?1 WHERE id = ?2",
            (pinned as i64, conversation_id),
        )?;
        Ok(rows > 0)
    }

    /// 读取会话完整快照（元数据 + 全部消息），用于跨设备同步 push。
    pub fn get_conversation_with_messages(
        &self,
        conversation_id: &str,
    ) -> RusqliteResult<Option<ConversationWithMessages>> {
        let conv = match self.get_conversation(conversation_id)? {
            Some(c) => c,
            None => return Ok(None),
        };
        let messages = self.load_messages(conversation_id)?;
        Ok(Some(ConversationWithMessages {
            conversation: conv,
            messages,
        }))
    }

    /// upsert 会话元数据（用于跨设备同步 pull 应用）。
    /// 注意：不修改 updated_at，保留传入的值（同步语义）。
    /// `model_id` 不再写入——会话级模型已收敛为内存映射（启动时迁移装载），
    /// DB 列仅作旧数据遗留；收到带 model_id 的旧端快照也不落库，避免重新
    /// 固定会话模型（由内存映射的 last-used 语义接管）。
    pub fn upsert_conversation(&self, conv: &Conversation) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO conversations (id, connection_id, title, created_at, updated_at, parent_conversation_id, pinned)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                connection_id = excluded.connection_id,
                title = excluded.title,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                parent_conversation_id = excluded.parent_conversation_id,
                pinned = excluded.pinned",
            (
                &conv.id,
                &conv.connection_id,
                &conv.title,
                conv.created_at.to_rfc3339(),
                conv.updated_at.to_rfc3339(),
                &conv.parent_conversation_id,
                conv.pinned as i64,
            ),
        )?;
        Ok(())
    }

    /// 一次性迁移：把旧版持久化的会话级模型选择读入内存映射，并清空 DB 列。
    ///
    /// 旧版 `conversations.model_id` 曾随每个会话落盘（"商鞅分裂"的来源）。
    /// 新架构把「会话 → 模型」收敛为**内存映射**：启动时把存量值搬到调用方
    /// 的内存 map，之后不再落盘。返回 `(conversation_id, model_id)` 列表。
    /// 幂等：列已清空后再调用返回空。
    pub fn take_persisted_model_ids(&self) -> RusqliteResult<Vec<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, model_id FROM conversations WHERE model_id IS NOT NULL AND model_id != ''",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<RusqliteResult<Vec<_>>>()?;
        if rows.is_empty() {
            return Ok(rows);
        }
        conn.execute(
            "UPDATE conversations SET model_id = NULL WHERE model_id IS NOT NULL AND model_id != ''",
            [],
        )?;
        Ok(rows)
    }

    /// 读出全部会话的思考档位映射（`efforts_json` 列），用于启动时装载进
    /// 内存 `session_efforts`。每行 `efforts_json` 为 `{"model_id":"effort"}`
    /// JSON 对象（可能为空对象/损坏——损坏行由调用方容忍跳过）。
    pub fn load_all_conversation_efforts(&self) -> RusqliteResult<Vec<(String, Option<String>)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, efforts_json FROM conversations WHERE efforts_json IS NOT NULL AND efforts_json != ''",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .collect::<RusqliteResult<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .map(|(id, json)| (id, Some(json)))
            .collect())
    }

    /// 写回某个会话的整张 (model → effort) 思考档位映射（JSON 对象串）。
    /// `None` = 清除该会话的档位记忆。会话不存在时静默无操作（返回 false）。
    pub fn save_conversation_efforts(
        &self,
        conversation_id: &str,
        efforts_json: Option<&str>,
    ) -> RusqliteResult<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE conversations SET efforts_json = ?1 WHERE id = ?2",
            (efforts_json, conversation_id),
        )?;
        Ok(rows > 0)
    }

    /// 列出所有会话 id（用于跨设备同步比对）。
    pub fn list_all_conversation_ids(&self) -> RusqliteResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id FROM conversations")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut ids = Vec::new();
        for r in rows {
            ids.push(r?);
        }
        Ok(ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::create_test_db;

    #[test]
    fn test_search_conversations() {
        let db = create_test_db();
        let c1 = db
            .create_conversation("conn_1", "Alpha")
            .expect("create c1");
        let c2 = db.create_conversation("conn_2", "Beta").expect("create c2");

        db.save_message(
            &c1.id,
            "user",
            "hello world",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("msg");
        db.save_message(
            &c1.id,
            "assistant",
            "reply about world peace",
            "2026-01-01T00:01:00Z",
            None,
            None,
        )
        .expect("msg");
        db.save_message(
            &c2.id,
            "user",
            "unrelated topic",
            "2026-01-01T00:02:00Z",
            None,
            None,
        )
        .expect("msg");
        db.save_message(
            &c2.id,
            "user",
            "another world mention",
            "2026-01-01T00:03:00Z",
            None,
            None,
        )
        .expect("msg");

        let empty = db.search_conversations("   ", None).expect("search empty");
        assert!(empty.is_empty());

        let all = db.search_conversations("world", None).expect("search");
        assert_eq!(all.len(), 2);
        // c2 was touched later via save_message → higher updated_at
        assert_eq!(all[0].conversation_id, c2.id);
        assert_eq!(all[0].match_count, 1);
        assert_eq!(all[0].matched_message_ids.len(), 1);
        assert!(all[0].matched_snippet.to_lowercase().contains("world"));

        assert_eq!(all[1].conversation_id, c1.id);
        assert_eq!(all[1].match_count, 2);
        assert_eq!(all[1].matched_message_ids.len(), 2);

        let only_c1 = db
            .search_conversations("world", Some("conn_1"))
            .expect("filter");
        assert_eq!(only_c1.len(), 1);
        assert_eq!(only_c1[0].conversation_id, c1.id);

        let none = db.search_conversations("zzzzz", None).expect("none");
        assert!(none.is_empty());
    }

    #[test]
    fn test_create_and_list_conversations() {
        let db = create_test_db();

        let c1 = db
            .create_conversation("conn_1", "Test Conversation 1")
            .expect("Failed to create conversation");
        assert!(!c1.id.is_empty());
        assert_eq!(c1.connection_id, "conn_1");
        assert_eq!(c1.title, "Test Conversation 1");

        let c2 = db
            .create_conversation("conn_1", "Test Conversation 2")
            .expect("Failed to create conversation");

        let conversations = db
            .list_conversations("conn_1")
            .expect("Failed to list conversations");
        assert_eq!(conversations.len(), 2);
        assert_eq!(conversations[0].id, c2.id);
        assert_eq!(conversations[1].id, c1.id);

        let empty = db
            .list_conversations("nonexistent")
            .expect("Failed to list conversations");
        assert!(empty.is_empty());
    }

    #[test]
    fn test_delete_conversation() {
        let db = create_test_db();

        let conversation = db
            .create_conversation("conn_1", "To Delete")
            .expect("Failed to create conversation");

        db.save_message(
            &conversation.id,
            "user",
            "Hello",
            "2024-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("Failed to save message");

        db.delete_conversation(&conversation.id)
            .expect("Failed to delete conversation");

        let messages = db
            .load_messages(&conversation.id)
            .expect("Failed to load messages");
        assert!(messages.is_empty());

        let conversations = db
            .list_conversations("conn_1")
            .expect("Failed to list conversations");
        assert!(conversations.is_empty());
    }

    #[test]
    fn test_delete_conversations_by_connection() {
        let db = create_test_db();

        db.create_conversation("conn_1", "Conv 1")
            .expect("Failed to create");
        db.create_conversation("conn_1", "Conv 2")
            .expect("Failed to create");
        db.create_conversation("conn_2", "Conv 3")
            .expect("Failed to create");

        db.delete_conversations_by_connection("conn_1")
            .expect("Failed to delete by connection");

        let remaining = db.list_conversations("conn_1").expect("Failed to list");
        assert!(remaining.is_empty());

        let conn2 = db.list_conversations("conn_2").expect("Failed to list");
        assert_eq!(conn2.len(), 1);
    }

    #[test]
    fn test_update_conversation_title() {
        let db = create_test_db();

        let conversation = db
            .create_conversation("conn_1", "Old Title")
            .expect("Failed to create");

        db.update_conversation_title(&conversation.id, "New Title")
            .expect("Failed to update title");

        let conversations = db.list_conversations("conn_1").expect("Failed to list");
        assert_eq!(conversations[0].title, "New Title");
    }

    /// 置顶：切换生效、不产生内容变更（updated_at 不动）、列表里浮到最前。
    #[test]
    fn test_set_conversation_pinned() {
        let db = create_test_db();

        let older = db.create_conversation("conn_1", "Older").expect("c1");
        std::thread::sleep(std::time::Duration::from_millis(10));
        let newer = db.create_conversation("conn_1", "Newer").expect("c2");

        // 默认列表按 updated_at 倒序：新的在前
        let listed = db.list_conversations("conn_1").expect("list");
        assert_eq!(listed[0].id, newer.id);
        assert!(!listed[0].pinned);

        // 置顶旧的那个 → 浮到最前，且 updated_at 保持原值（置顶不是内容变更）
        assert!(db.set_conversation_pinned(&older.id, true).expect("pin"));
        let listed = db.list_conversations("conn_1").expect("list");
        assert_eq!(listed[0].id, older.id);
        assert!(listed[0].pinned);
        assert_eq!(listed[0].updated_at, older.updated_at);
        assert_eq!(listed[1].id, newer.id);

        // 取消置顶 → 回到时间序
        assert!(db.set_conversation_pinned(&older.id, false).expect("unpin"));
        let listed = db.list_conversations("conn_1").expect("list");
        assert_eq!(listed[0].id, newer.id);
        assert!(!listed[0].pinned);

        // 不存在的会话：返回 false，不报错
        assert!(!db.set_conversation_pinned("ghost", true).expect("ghost"));
    }

    /// 置顶要落盘：重开库仍在（否则重启就白置顶了）。
    #[test]
    fn test_conversation_pinned_survives_db_reopen() {
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let db_path = dir.path().join("conversations.db");
        let id = {
            let db = ConversationDb::new(&db_path).expect("open");
            let conv = db.create_conversation("conn_1", "Pinned").expect("create");
            db.set_conversation_pinned(&conv.id, true).expect("pin");
            conv.id
        };

        let db = ConversationDb::new(&db_path).expect("reopen");
        let loaded = db.get_conversation(&id).expect("get").expect("exists");
        assert!(loaded.pinned);
        let listed = db.list_conversations("conn_1").expect("list");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].pinned);
    }

    #[test]
    fn test_touch_conversation() {
        let db = create_test_db();

        let conversation = db
            .create_conversation("conn_1", "Test")
            .expect("Failed to create");

        let original_updated_at = conversation.updated_at;

        std::thread::sleep(std::time::Duration::from_millis(10));

        db.touch_conversation(&conversation.id)
            .expect("Failed to touch");

        let conversations = db.list_conversations("conn_1").expect("Failed to list");
        assert!(conversations[0].updated_at > original_updated_at);
    }

    #[test]
    fn test_create_sub_conversation_sets_parent() {
        let db = create_test_db();
        let parent = db
            .create_conversation("conn_1", "Parent")
            .expect("create parent");
        let sub = db
            .create_sub_conversation("conn_1", "explore（子agent）", &parent.id)
            .expect("create sub");

        assert_eq!(
            sub.parent_conversation_id.as_deref(),
            Some(parent.id.as_str())
        );

        // 列表同时返回两者（DB 层不过滤，过滤在命令层）
        let all = db.list_conversations("conn_1").expect("list");
        assert_eq!(all.len(), 2);

        // get_conversation 读回 parent 字段
        let loaded = db.get_conversation(&sub.id).expect("get").expect("exists");
        assert_eq!(
            loaded.parent_conversation_id.as_deref(),
            Some(parent.id.as_str())
        );

        let parent_loaded = db
            .get_conversation(&parent.id)
            .expect("get")
            .expect("exists");
        assert!(parent_loaded.parent_conversation_id.is_none());
    }

    #[test]
    fn test_delete_conversation_cascade_deletes_sub_conversations() {
        let db = create_test_db();
        let parent = db
            .create_conversation("conn_1", "Parent")
            .expect("create parent");
        let sub1 = db
            .create_sub_conversation("conn_1", "Sub1（子agent）", &parent.id)
            .expect("create sub1");
        let sub2 = db
            .create_sub_conversation("conn_1", "Sub2（子agent）", &parent.id)
            .expect("create sub2");

        db.save_message(
            &sub1.id,
            "user",
            "hello",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("save msg");

        let deleted = db
            .delete_conversation_cascade(&parent.id)
            .expect("cascade delete");
        assert_eq!(deleted.len(), 3);
        assert!(deleted.contains(&parent.id));
        assert!(deleted.contains(&sub1.id));
        assert!(deleted.contains(&sub2.id));

        assert!(db.get_conversation(&parent.id).expect("q").is_none());
        assert!(db.get_conversation(&sub1.id).expect("q").is_none());
        assert!(db.get_conversation(&sub2.id).expect("q").is_none());
        // 子对话消息也清理
        assert!(db.load_messages(&sub1.id).expect("q").is_empty());
    }

    #[test]
    fn test_delete_conversation_cascade_keeps_unrelated_conversations() {
        let db = create_test_db();
        let parent = db
            .create_conversation("conn_1", "Parent")
            .expect("create parent");
        db.create_sub_conversation("conn_1", "Sub（子agent）", &parent.id)
            .expect("create sub");
        let other = db
            .create_conversation("conn_1", "Other")
            .expect("create other");

        db.delete_conversation_cascade(&parent.id).expect("cascade");

        assert!(db.get_conversation(&other.id).expect("q").is_some());
    }

    #[test]
    fn test_search_conversations_excludes_sub_conversations() {
        let db = create_test_db();
        let parent = db
            .create_conversation("conn_1", "Parent")
            .expect("create parent");
        let sub = db
            .create_sub_conversation("conn_1", "Sub（子agent）", &parent.id)
            .expect("create sub");

        db.save_message(
            &parent.id,
            "user",
            "needle in parent",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("msg parent");
        db.save_message(
            &sub.id,
            "user",
            "needle in sub",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("msg sub");

        let results = db.search_conversations("needle", None).expect("search");
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].conversation_id, parent.id);
    }

    #[test]
    fn test_take_persisted_model_ids_moves_and_clears() {
        let db = create_test_db();
        let c1 = db.create_conversation("conn_1", "C1").expect("c1");
        let c2 = db.create_conversation("conn_1", "C2").expect("c2");
        // 模拟旧版遗留的持久化会话级模型
        db.set_conversation_model_id(&c1.id, Some("model-a"))
            .unwrap();
        db.set_conversation_model_id(&c2.id, Some("model-b"))
            .unwrap();
        assert_eq!(
            db.get_conversation(&c1.id)
                .unwrap()
                .unwrap()
                .model_id
                .as_deref(),
            Some("model-a")
        );

        let taken = db.take_persisted_model_ids().expect("take");
        assert_eq!(taken.len(), 2);
        let map: std::collections::HashMap<String, String> = taken.into_iter().collect();
        assert_eq!(map.get(&c1.id).map(String::as_str), Some("model-a"));
        assert_eq!(map.get(&c2.id).map(String::as_str), Some("model-b"));

        // DB 列已清空（幂等：再取为空）
        assert!(db
            .get_conversation(&c1.id)
            .unwrap()
            .unwrap()
            .model_id
            .is_none());
        assert!(db.take_persisted_model_ids().unwrap().is_empty());
        // 新插入的会话不再写 model_id
        let c3 = db.create_conversation("conn_1", "C3").expect("c3");
        assert!(db
            .get_conversation(&c3.id)
            .unwrap()
            .unwrap()
            .model_id
            .is_none());
    }

    #[test]
    fn test_conversation_efforts_persist_roundtrip_and_clear() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "C1").expect("c1");

        // 初始无持久化档位
        assert!(db.load_all_conversation_efforts().unwrap().is_empty());

        // 写回整张映射
        db.save_conversation_efforts(&conv.id, Some(r#"{"model-x":"high","model-y":"low"}"#))
            .expect("save");
        let rows = db.load_all_conversation_efforts().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, conv.id);
        assert_eq!(
            rows[0].1.as_deref(),
            Some(r#"{"model-x":"high","model-y":"low"}"#)
        );

        // 清空（None → 列置 NULL，重新装载为空）
        db.save_conversation_efforts(&conv.id, None).expect("clear");
        assert!(db.load_all_conversation_efforts().unwrap().is_empty());

        // 删除会话 → 持久化档位随行删除（无悬挂）
        db.save_conversation_efforts(&conv.id, Some(r#"{"model-x":"high"}"#))
            .expect("save2");
        db.delete_conversation(&conv.id).expect("delete");
        assert!(db.load_all_conversation_efforts().unwrap().is_empty());
    }

    #[test]
    fn test_conversation_efforts_survive_db_reopen() {
        let dir = std::env::temp_dir().join(format!(
            "marcel-ssh-efforts-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("conversations.db");

        let conv_id = {
            let db = ConversationDb::new(&db_path).expect("open1");
            let conv = db.create_conversation("conn_1", "C1").expect("c1");
            db.save_conversation_efforts(&conv.id, Some(r#"{"model-x":"max"}"#))
                .expect("save");
            conv.id
        };

        // 模拟重启：重新打开同一 DB 文件
        let db2 = ConversationDb::new(&db_path).expect("open2");
        let rows = db2.load_all_conversation_efforts().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, conv_id);
        assert_eq!(rows[0].1.as_deref(), Some(r#"{"model-x":"max"}"#));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
