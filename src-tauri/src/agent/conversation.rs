use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{Connection, Result as RusqliteResult};
use serde::Serialize;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum ConversationError {
    #[error("Failed to open database at '{path}': {source}")]
    OpenError {
        path: String,
        source: rusqlite::Error,
    },
    #[error("Failed to initialize database schema: {source}")]
    SchemaError { source: rusqlite::Error },
    #[error("Database operation failed: {message}")]
    OperationError {
        message: String,
        source: rusqlite::Error,
    },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub connection_id: String,
    pub title: String,
    pub created_at: chrono::DateTime<Utc>,
    pub updated_at: chrono::DateTime<Utc>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub created_at: chrono::DateTime<Utc>,
    /// JSON-serialized tool_calls metadata (for assistant messages with tool invocations).
    pub tool_calls_json: Option<String>,
    /// Reasoning/thinking content from the model (DeepSeek thinking mode).
    /// Must be passed back to the API unchanged in subsequent requests.
    pub reasoning_content: Option<String>,
    /// JSON array of relative image paths under `images/` (user messages).
    pub image_paths_json: Option<String>,
}

/// 聊天历史全文搜索的单条会话聚合结果。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSearchResult {
    pub conversation_id: String,
    pub title: String,
    pub connection_id: String,
    pub matched_snippet: String,
    pub match_count: i64,
    /// 匹配消息 id，按时间升序，最多 200 条
    pub matched_message_ids: Vec<String>,
    pub updated_at: chrono::DateTime<Utc>,
}

pub struct ConversationDb {
    conn: Mutex<Connection>,
}

impl ConversationDb {
    pub fn new(db_path: impl AsRef<Path>) -> Result<Self, ConversationError> {
        let path_str = db_path.as_ref().to_string_lossy().to_string();

        if let Some(parent) = db_path.as_ref().parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent).map_err(|e| ConversationError::OpenError {
                    path: path_str.clone(),
                    source: rusqlite::Error::InvalidParameterName(format!(
                        "Failed to create directory: {}",
                        e
                    )),
                })?;
            }
        }

        let conn = Connection::open(&db_path).map_err(|e| ConversationError::OpenError {
            path: path_str.clone(),
            source: e,
        })?;

        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                connection_id TEXT NOT NULL,
                title TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                timestamp TEXT NOT NULL,
                created_at TEXT NOT NULL,
                tool_calls_json TEXT,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );

            CREATE INDEX IF NOT EXISTS idx_conversations_connection ON conversations(connection_id);
            CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

            CREATE TABLE IF NOT EXISTS plans (
                task_id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );
            CREATE INDEX IF NOT EXISTS idx_plans_conversation ON plans(conversation_id);

            CREATE TABLE IF NOT EXISTS plan_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );
            CREATE INDEX IF NOT EXISTS idx_plan_snapshots_conv_time
                ON plan_snapshots(conversation_id, created_at);
            ",
        )
        .map_err(|e| ConversationError::SchemaError { source: e })?;

        // Migration: rename session_id → connection_id if old schema exists
        if column_exists(&conn, "conversations", "session_id")
            && !column_exists(&conn, "conversations", "connection_id")
        {
            log::info!("Migrating conversation database: renaming session_id → connection_id");
            conn.execute(
                "ALTER TABLE conversations RENAME COLUMN session_id TO connection_id",
                [],
            )
            .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete");
        }

        // Migration: add tool_calls_json column if it doesn't exist yet
        if !column_exists(&conn, "messages", "tool_calls_json") {
            log::info!("Migrating conversation database: adding tool_calls_json column");
            conn.execute("ALTER TABLE messages ADD COLUMN tool_calls_json TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: tool_calls_json column added");
        }

        // Migration: add reasoning_content column if it doesn't exist yet
        if !column_exists(&conn, "messages", "reasoning_content") {
            log::info!("Migrating conversation database: adding reasoning_content column");
            conn.execute("ALTER TABLE messages ADD COLUMN reasoning_content TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: reasoning_content column added");
        }

        // Migration: add image_paths_json for vision attachments
        if !column_exists(&conn, "messages", "image_paths_json") {
            log::info!("Migrating conversation database: adding image_paths_json column");
            conn.execute("ALTER TABLE messages ADD COLUMN image_paths_json TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: image_paths_json column added");
        }

        // Migration: plan_snapshots for older DBs that already had plans table only
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS plan_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id TEXT NOT NULL,
                task_id TEXT NOT NULL,
                plan_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id)
            );
            CREATE INDEX IF NOT EXISTS idx_plan_snapshots_conv_time
                ON plan_snapshots(conversation_id, created_at);
            ",
        )
        .map_err(|e| ConversationError::SchemaError { source: e })?;

        log::info!("Conversation database initialized at: {}", path_str);

        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn create_conversation(
        &self,
        connection_id: &str,
        title: &str,
    ) -> RusqliteResult<Conversation> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        let now_str = now.to_rfc3339();
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO conversations (id, connection_id, title, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            (&id, connection_id, title, &now_str, &now_str),
        )?;

        Ok(Conversation {
            id,
            connection_id: connection_id.to_string(),
            title: title.to_string(),
            created_at: now,
            updated_at: now,
        })
    }

    pub fn list_conversations(&self, connection_id: &str) -> RusqliteResult<Vec<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, title, created_at, updated_at
             FROM conversations
             WHERE connection_id = ?1
             ORDER BY updated_at DESC",
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
             ORDER BY c.updated_at DESC, m.created_at ASC, m.rowid ASC"
        } else {
            "SELECT m.id, m.content, m.created_at,
                    c.id, c.title, c.connection_id, c.updated_at
             FROM messages m
             INNER JOIN conversations c ON c.id = m.conversation_id
             WHERE m.content LIKE ?1 ESCAPE '\\' COLLATE NOCASE
             ORDER BY c.updated_at DESC, m.created_at ASC, m.rowid ASC"
        };

        let mut stmt = conn.prepare(sql)?;

        type RowTuple = (
            String,
            String,
            String,
            String,
            String,
            String,
            String,
        );

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

    pub fn load_messages(&self, conversation_id: &str) -> RusqliteResult<Vec<StoredMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content, image_paths_json
             FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at ASC, rowid ASC",
        )?;

        let messages = stmt
            .query_map([conversation_id], |row| {
                Ok(StoredMessage {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    timestamp: row.get(4)?,
                    created_at: row
                        .get::<_, String>(5)?
                        .parse()
                        .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC),
                    tool_calls_json: row.get(6).ok(),
                    reasoning_content: row.get(7).ok(),
                    image_paths_json: row.get(8).ok(),
                })
            })?
            .collect::<RusqliteResult<Vec<_>>>()?;

        Ok(messages)
    }

    pub fn save_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        timestamp: &str,
        tool_calls_json: Option<&str>,
        reasoning_content: Option<&str>,
    ) -> RusqliteResult<StoredMessage> {
        self.save_message_with_images(
            conversation_id,
            role,
            content,
            timestamp,
            tool_calls_json,
            reasoning_content,
            None,
        )
    }

    pub fn save_message_with_images(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        timestamp: &str,
        tool_calls_json: Option<&str>,
        reasoning_content: Option<&str>,
        image_paths_json: Option<&str>,
    ) -> RusqliteResult<StoredMessage> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        let now_str = now.to_rfc3339();
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content, image_paths_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            (
                &id,
                conversation_id,
                role,
                content,
                timestamp,
                &now_str,
                tool_calls_json,
                reasoning_content,
                image_paths_json,
            ),
        )?;
        drop(conn);

        self.touch_conversation(conversation_id)?;

        Ok(StoredMessage {
            id,
            conversation_id: conversation_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            timestamp: timestamp.to_string(),
            created_at: now,
            tool_calls_json: tool_calls_json.map(String::from),
            reasoning_content: reasoning_content.map(String::from),
            image_paths_json: image_paths_json.map(String::from),
        })
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

    pub fn delete_messages_from_timestamp(
        &self,
        conversation_id: &str,
        from_timestamp: &str,
    ) -> RusqliteResult<usize> {
        let deleted = {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "DELETE FROM messages WHERE conversation_id = ?1 AND timestamp >= ?2",
                (conversation_id, from_timestamp),
            )?
        };

        self.touch_conversation(conversation_id)?;
        Ok(deleted)
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

    /// 保存或更新 plan（按 task_id upsert）。
    /// plan_json 是 AgentTaskPlan 序列化后的 JSON 字符串。
    pub fn save_plan(
        &self,
        task_id: &str,
        conversation_id: &str,
        plan_json: &str,
    ) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        // 先清理同 conversation 下旧 task_id 的 stale 行（重启后新 task 恢复了
        // 旧 plan 并继续更新，旧 task_id 的行不再需要）。
        conn.execute(
            "DELETE FROM plans WHERE conversation_id = ?1 AND task_id != ?2",
            (conversation_id, task_id),
        )?;
        conn.execute(
            "INSERT INTO plans (task_id, conversation_id, plan_json, updated_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(task_id) DO UPDATE SET \
             conversation_id = excluded.conversation_id, \
             plan_json = excluded.plan_json, \
             updated_at = excluded.updated_at",
            (task_id, conversation_id, plan_json, Utc::now().to_rfc3339()),
        )?;
        Ok(())
    }

    /// 加载某对话下所有 plan（按 updated_at 倒序），返回 (task_id, plan_json, updated_at) 列表。
    pub fn load_plans_by_conversation(
        &self,
        conversation_id: &str,
    ) -> RusqliteResult<Vec<(String, String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT task_id, plan_json, updated_at FROM plans WHERE conversation_id = ?1 \
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map([conversation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 加载某对话下最近一条 plan（按 updated_at 倒序取第一条），返回 plan_json。
    /// 用于新 task 启动时恢复旧 plan 到后端内存，避免 LLM 重复 create_plan。
    pub fn load_latest_plan_by_conversation(
        &self,
        conversation_id: &str,
    ) -> RusqliteResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT plan_json FROM plans WHERE conversation_id = ?1 \
             ORDER BY updated_at DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map([conversation_id], |row| row.get::<_, String>(0))?;
        match rows.next() {
            Some(Ok(plan_json)) => Ok(Some(plan_json)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// 删除单个 plan（按 task_id）。
    pub fn delete_plan(&self, task_id: &str) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM plans WHERE task_id = ?1", [task_id])?;
        Ok(())
    }

    /// 删除某对话下全部 plan 行。
    pub fn delete_plans_by_conversation(&self, conversation_id: &str) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM plans WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        Ok(())
    }

    /// 列出某对话下 plans 表中的 task_id（用于清理内存）。
    pub fn list_plan_task_ids(&self, conversation_id: &str) -> RusqliteResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt =
            conn.prepare("SELECT task_id FROM plans WHERE conversation_id = ?1")?;
        let rows = stmt
            .query_map([conversation_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 每次 plan 持久化后追加快照，供撤回消息时按时间点恢复。
    /// 单 conversation 最多保留 200 条，超出按 created_at 删最旧的。
    pub fn insert_plan_snapshot(
        &self,
        conversation_id: &str,
        task_id: &str,
        plan_json: &str,
    ) -> RusqliteResult<()> {
        const MAX_SNAPSHOTS_PER_CONV: i64 = 200;
        let created_at = Utc::now().to_rfc3339();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO plan_snapshots (conversation_id, task_id, plan_json, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            (conversation_id, task_id, plan_json, &created_at),
        )?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM plan_snapshots WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0),
        )?;
        if count > MAX_SNAPSHOTS_PER_CONV {
            let to_delete = count - MAX_SNAPSHOTS_PER_CONV;
            conn.execute(
                "DELETE FROM plan_snapshots WHERE id IN ( \
                    SELECT id FROM plan_snapshots WHERE conversation_id = ?1 \
                    ORDER BY created_at ASC LIMIT ?2 \
                 )",
                rusqlite::params![conversation_id, to_delete],
            )?;
        }
        Ok(())
    }

    /// 取截断点之前最近一条 plan 快照：`created_at < from_timestamp`。
    /// 返回 (task_id, plan_json)。
    pub fn load_plan_snapshot_before(
        &self,
        conversation_id: &str,
        from_timestamp: &str,
    ) -> RusqliteResult<Option<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT task_id, plan_json FROM plan_snapshots \
             WHERE conversation_id = ?1 AND created_at < ?2 \
             ORDER BY created_at DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map((conversation_id, from_timestamp), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        match rows.next() {
            Some(Ok(pair)) => Ok(Some(pair)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// 该对话是否存在任意 plan 快照（用于区分「旧数据无快照」与「有快照但均在截断点之后」）。
    pub fn has_any_plan_snapshot(&self, conversation_id: &str) -> RusqliteResult<bool> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM plan_snapshots WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// 删除截断点及之后产生的 plan 快照（撤回后未来进度的快照不应再参与恢复）。
    pub fn delete_plan_snapshots_from(
        &self,
        conversation_id: &str,
        from_timestamp: &str,
    ) -> RusqliteResult<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM plan_snapshots WHERE conversation_id = ?1 AND created_at >= ?2",
            (conversation_id, from_timestamp),
        )?;
        Ok(n)
    }

    /// Create an in-memory database for testing or as a fallback.
    pub fn in_memory() -> Result<Self, ConversationError> {
        Self::new(":memory:")
    }
}

fn escape_like(s: &str) -> String {
    s.replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// 在匹配处前后约 50 字符截取摘要；按 Unicode 字符计。
fn make_match_snippet(content: &str, keyword: &str) -> String {
    const RADIUS: usize = 50;
    let chars: Vec<char> = content.chars().collect();
    if chars.is_empty() {
        return String::new();
    }

    let key_lower: Vec<char> = keyword.chars().flat_map(|c| c.to_lowercase()).collect();
    let hay_lower: Vec<char> = chars.iter().flat_map(|c| c.to_lowercase()).collect();

    let mut match_start = 0usize;
    let mut match_len = key_lower.len().max(1);
    let mut found = false;
    if !key_lower.is_empty() && hay_lower.len() >= key_lower.len() {
        for i in 0..=(hay_lower.len() - key_lower.len()) {
            if hay_lower[i..i + key_lower.len()] == key_lower[..] {
                match_start = i;
                match_len = key_lower.len();
                found = true;
                break;
            }
        }
    }
    if !found {
        // 回退：取开头
        match_start = 0;
        match_len = 0;
    }

    // hay_lower 与 chars 长度在多数语言一致；大小写扩展极少见，按 chars 下标钳制
    let start = match_start.saturating_sub(RADIUS).min(chars.len());
    let end = (match_start + match_len + RADIUS).min(chars.len());
    let mut snippet: String = chars[start..end].iter().collect();
    if start > 0 {
        snippet = format!("…{}", snippet);
    }
    if end < chars.len() {
        snippet = format!("{}…", snippet);
    }
    snippet
}

fn column_exists(conn: &rusqlite::Connection, table: &str, column: &str) -> bool {
    conn.prepare(&format!("PRAGMA table_info({})", table))
        .and_then(|mut stmt| {
            let rows: Vec<String> = stmt
                .query_map([], |row| row.get(1))
                .map_err(|e| e)?
                .filter_map(|r| r.ok())
                .collect();
            Ok(rows)
        })
        .map(|rows| rows.iter().any(|c| c == column))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_db() -> ConversationDb {
        ConversationDb::in_memory().expect("Failed to create in-memory database")
    }

    #[test]
    fn test_search_conversations() {
        let db = create_test_db();
        let c1 = db
            .create_conversation("conn_1", "Alpha")
            .expect("create c1");
        let c2 = db
            .create_conversation("conn_2", "Beta")
            .expect("create c2");

        db.save_message(&c1.id, "user", "hello world", "2026-01-01T00:00:00Z", None, None)
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
    fn test_save_and_load_messages() {
        let db = create_test_db();

        let conversation = db
            .create_conversation("conn_1", "Test")
            .expect("Failed to create conversation");

        let msg = db
            .save_message(
                &conversation.id,
                "user",
                "Hello",
                "2024-01-01T00:00:00Z",
                None,
                None,
            )
            .expect("Failed to save message");
        assert!(!msg.id.is_empty());
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "Hello");
        assert!(msg.tool_calls_json.is_none());

        let messages = db
            .load_messages(&conversation.id)
            .expect("Failed to load messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Hello");
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
    fn test_delete_messages_from_timestamp() {
        let db = create_test_db();

        let conversation = db
            .create_conversation("conn_1", "Rollback")
            .expect("Failed to create conversation");

        db.save_message(
            &conversation.id,
            "user",
            "keep",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("Failed to save message");
        db.save_message(
            &conversation.id,
            "user",
            "rewrite",
            "2026-01-01T00:01:00Z",
            None,
            None,
        )
        .expect("Failed to save message");
        db.save_message(
            &conversation.id,
            "assistant",
            "answer",
            "2026-01-01T00:02:00Z",
            None,
            None,
        )
        .expect("Failed to save message");
        db.save_message(
            &conversation.id,
            "tool",
            "tool output",
            "2026-01-01T00:03:00Z",
            None,
            None,
        )
        .expect("Failed to save message");

        let deleted = db
            .delete_messages_from_timestamp(&conversation.id, "2026-01-01T00:01:00Z")
            .expect("Failed to delete messages");

        assert_eq!(deleted, 3);
        let messages = db
            .load_messages(&conversation.id)
            .expect("Failed to load messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "keep");
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
    fn test_plan_snapshot_before_and_clear() {
        let db = create_test_db();
        let conversation = db
            .create_conversation("conn_1", "Plan Snap")
            .expect("Failed to create");

        let plan_a = r#"{"taskId":"t1","items":[{"id":"1","title":"a","status":"pending"}],"currentIndex":0,"nextItemSeq":2,"reflectionReminded":false}"#;
        let plan_b = r#"{"taskId":"t1","items":[{"id":"1","title":"a","status":"completed"}],"currentIndex":1,"nextItemSeq":2,"reflectionReminded":false}"#;

        db.save_plan("t1", &conversation.id, plan_a)
            .expect("save plan a");
        db.insert_plan_snapshot(&conversation.id, "t1", plan_a)
            .expect("snap a");

        // Ensure later snapshot has later created_at
        std::thread::sleep(std::time::Duration::from_millis(15));

        db.save_plan("t1", &conversation.id, plan_b)
            .expect("save plan b");
        db.insert_plan_snapshot(&conversation.id, "t1", plan_b)
            .expect("snap b");

        let t_user = Utc::now().to_rfc3339();
        // snapshot after t_user should not be selected; insert one more after
        std::thread::sleep(std::time::Duration::from_millis(15));
        let plan_c = r#"{"taskId":"t1","items":[{"id":"1","title":"a","status":"completed"},{"id":"2","title":"b","status":"pending"}],"currentIndex":1,"nextItemSeq":3,"reflectionReminded":false}"#;
        db.insert_plan_snapshot(&conversation.id, "t1", plan_c)
            .expect("snap c");

        let before = db
            .load_plan_snapshot_before(&conversation.id, &t_user)
            .expect("load before")
            .expect("should have snapshot before user ts");
        assert_eq!(before.0, "t1");
        assert!(before.1.contains("\"status\":\"completed\""));
        assert!(!before.1.contains("\"title\":\"b\""));

        let none = db
            .load_plan_snapshot_before(&conversation.id, "2000-01-01T00:00:00Z")
            .expect("load early");
        assert!(none.is_none());

        db.delete_plans_by_conversation(&conversation.id)
            .expect("delete plans");
        let remaining = db
            .load_plans_by_conversation(&conversation.id)
            .expect("list");
        assert!(remaining.is_empty());
    }

    #[test]
    fn test_delete_conversation_clears_snapshots() {
        let db = create_test_db();
        let conversation = db
            .create_conversation("conn_1", "Del")
            .expect("create");
        let plan = r#"{"taskId":"t9","items":[],"currentIndex":0,"nextItemSeq":1,"reflectionReminded":false}"#;
        db.insert_plan_snapshot(&conversation.id, "t9", plan)
            .expect("snap");
        db.delete_conversation(&conversation.id).expect("delete");
        let snap = db
            .load_plan_snapshot_before(&conversation.id, "9999-01-01T00:00:00Z")
            .expect("query");
        assert!(snap.is_none());
    }
}
