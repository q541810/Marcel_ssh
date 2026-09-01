use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Result as RusqliteResult};
use serde::{Deserialize, Serialize};
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

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Conversation {
    pub id: String,
    pub connection_id: String,
    pub title: String,
    pub created_at: chrono::DateTime<Utc>,
    pub updated_at: chrono::DateTime<Utc>,
    /// 子agent对话（task 工具创建）的父对话 id；主对话为 None。
    /// 用于：会话列表隐藏子对话、子对话内"返回主对话"、删除主对话级联删除。
    #[serde(default)]
    pub parent_conversation_id: Option<String>,
    /// 会话级模型选择：`llmRegistry` 中的模型条目 id。
    /// `None` = 跟随全局默认模型（未显式选择过 / 旧数据）。
    /// 启动任务时经 `agent_start_task` 的 `model_id` 传入，作为
    /// `AgentSpec.model_override` 解析；子 agent 继承父任务模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

/// 活跃消息段加载结果（用于首次加载会话时从最新 Compaction Checkpoint 开始切片）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveMessagesResult {
    /// 活跃消息列表（包含最新的 Checkpoint 卡片及之后的消息，若无卡片则为全量）
    pub messages: Vec<StoredMessage>,
    /// 在该活跃切片之前是否还有更早的归档历史消息
    pub has_earlier: bool,
    /// 截断锚点的 Checkpoint 消息 ID（若无压缩卡片则为 None）
    pub checkpoint_id: Option<String>,
}

/// 会话完整快照（元数据 + 全部消息），用于跨设备同步。
/// 序列化后的 JSON 是 `conversations.{id}` key 对应的明文值。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationWithMessages {
    pub conversation: Conversation,
    pub messages: Vec<StoredMessage>,
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
                updated_at TEXT NOT NULL,
                parent_conversation_id TEXT,
                model_id TEXT
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
            -- 注意：idx_conversations_parent 依赖 parent_conversation_id 列，
            -- 旧库（无该列）在此处建索引会报 no such column 导致整个 execute_batch
            -- 失败（进而 ConversationDb::new 失败、AppState fallback 到内存空库，
            -- 磁盘历史全部不可见）。该索引在下方迁移块中 ALTER 之后统一创建。

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

        // Migration: add parent_conversation_id for subagent (task tool) conversations.
        // 旧库先 ALTER 加列，再无条件建索引（新库建表已带列，这里补索引）。
        if !column_exists(&conn, "conversations", "parent_conversation_id") {
            log::info!("Migrating conversation database: adding parent_conversation_id column");
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT",
                [],
            )
            .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: parent_conversation_id column added");
        }
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id)",
            [],
        )
        .map_err(|e| ConversationError::SchemaError { source: e })?;

        // Migration: add model_id for conversation-level model selection.
        // 旧库 ALTER 加列；新库建表已带列。缺省 NULL = 跟随全局默认模型（兼容旧数据）。
        if !column_exists(&conn, "conversations", "model_id") {
            log::info!("Migrating conversation database: adding model_id column");
            conn.execute("ALTER TABLE conversations ADD COLUMN model_id TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: model_id column added");
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
        self.insert_conversation(connection_id, title, None)
    }

    /// 创建子agent对话（task 工具派发的子 agent 专属）。
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
            "INSERT INTO conversations (id, connection_id, title, created_at, updated_at, parent_conversation_id, model_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (
                &id,
                connection_id,
                title,
                &now_str,
                &now_str,
                parent_conversation_id,
                Option::<&str>::None, // 新会话默认跟随全局模型（会话级选择由 set_conversation_model_id 设置）
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
        })
    }

    pub fn list_conversations(&self, connection_id: &str) -> RusqliteResult<Vec<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, title, created_at, updated_at, parent_conversation_id, model_id
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
                    parent_conversation_id: row.get(5).ok(),
                    model_id: row.get(6).ok(),
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

    pub fn load_messages(&self, conversation_id: &str) -> RusqliteResult<Vec<StoredMessage>> {
        let conn = self.conn.lock().unwrap();
        Self::query_stored_messages(&conn, conversation_id, None)
    }

    /// 从最新的 Compaction Checkpoint（若存在）开始加载活跃消息段。
    /// - 若存在压缩卡片：返回该卡片及之后的所有消息，且 `has_earlier = true`（卡片前有更早消息）；
    /// - 若不存在压缩卡片：返回全量消息，`has_earlier = false`。
    pub fn load_active_messages(
        &self,
        conversation_id: &str,
    ) -> RusqliteResult<ActiveMessagesResult> {
        let conn = self.conn.lock().unwrap();

        // 1. 查询最新的 Compaction Checkpoint 消息 (role = 'system' 且以 '【上下文已压缩】' 开头)
        let mut check_stmt = conn.prepare(
            "SELECT id, created_at, rowid FROM messages 
             WHERE conversation_id = ?1 
               AND role = 'system' 
               AND content LIKE '【上下文已压缩】%'
             ORDER BY created_at DESC, rowid DESC 
             LIMIT 1",
        )?;

        let checkpoint = check_stmt
            .query_row([conversation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .optional()?;

        match checkpoint {
            Some((cp_id, cp_created_at, cp_rowid)) => {
                // 检查卡片前是否还有更早消息
                let mut count_stmt = conn.prepare(
                    "SELECT COUNT(*) FROM messages 
                     WHERE conversation_id = ?1 
                       AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))",
                )?;
                let earlier_count: i64 = count_stmt.query_row(
                    rusqlite::params![conversation_id, cp_created_at, cp_rowid],
                    |r| r.get(0),
                )?;

                // 查询从 Checkpoint 开始（含 Checkpoint 本身）到末尾的所有活跃消息
                let mut msg_stmt = conn.prepare(
                    "SELECT id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content, image_paths_json
                     FROM messages
                     WHERE conversation_id = ?1 
                       AND (created_at > ?2 OR (created_at = ?2 AND rowid >= ?3))
                     ORDER BY created_at ASC, rowid ASC",
                )?;
                let messages = msg_stmt
                    .query_map(
                        rusqlite::params![conversation_id, cp_created_at, cp_rowid],
                        Self::map_stored_message,
                    )?
                    .collect::<RusqliteResult<Vec<_>>>()?;

                Ok(ActiveMessagesResult {
                    messages,
                    has_earlier: earlier_count > 0,
                    checkpoint_id: Some(cp_id),
                })
            }
            None => {
                // 没有压缩卡片，直接加载全量
                let messages = Self::query_stored_messages(&conn, conversation_id, None)?;
                Ok(ActiveMessagesResult {
                    messages,
                    has_earlier: false,
                    checkpoint_id: None,
                })
            }
        }
    }

    /// 加载指定消息之前的更早归档历史消息（按需翻页加载）。
    pub fn load_earlier_messages(
        &self,
        conversation_id: &str,
        before_message_id: &str,
    ) -> RusqliteResult<Vec<StoredMessage>> {
        let conn = self.conn.lock().unwrap();

        // 获取 before_message 的 created_at 与 rowid 作为切分点
        let point: Option<(String, i64)> = conn
            .query_row(
                "SELECT created_at, rowid FROM messages WHERE conversation_id = ?1 AND id = ?2",
                [conversation_id, before_message_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let Some((created_at, rowid)) = point else {
            return Ok(vec![]);
        };

        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content, image_paths_json
             FROM messages
             WHERE conversation_id = ?1 
               AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
             ORDER BY created_at ASC, rowid ASC",
        )?;

        let messages = stmt
            .query_map(
                rusqlite::params![conversation_id, created_at, rowid],
                Self::map_stored_message,
            )?
            .collect::<RusqliteResult<Vec<_>>>()?;

        Ok(messages)
    }

    fn map_stored_message(row: &rusqlite::Row<'_>) -> RusqliteResult<StoredMessage> {
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
    }

    fn query_stored_messages(
        conn: &Connection,
        conversation_id: &str,
        limit: Option<usize>,
    ) -> RusqliteResult<Vec<StoredMessage>> {
        let sql = match limit {
            Some(_) => {
                "SELECT id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content, image_paths_json
                 FROM messages
                 WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC
                 LIMIT ?2"
            }
            None => {
                "SELECT id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content, image_paths_json
                 FROM messages
                 WHERE conversation_id = ?1
                 ORDER BY created_at ASC, rowid ASC"
            }
        };

        let mut stmt = conn.prepare(sql)?;
        let mut rows = match limit {
            Some(lim) => stmt.query(rusqlite::params![conversation_id, lim as i64])?,
            None => stmt.query(rusqlite::params![conversation_id])?,
        };

        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(Self::map_stored_message(row)?);
        }
        Ok(out)
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

    /// 提交一次上下文压缩（单事务，原文全保留、仅插卡片 + 吸收旧卡）：
    /// - `remove_card_ids`：被新卡吸收的旧压缩卡行（被压区间内的上一张卡，删除）；
    /// - 插入压缩摘要卡片行（role=system），`card_created_at` / `card_timestamp`
    ///   都取**被压末行**的值——created_at 定位行序（span 末尾、保留尾部之前），
    ///   timestamp 对齐 span 末行使撤回语义自然（目标在卡前 → 卡片被截断删除 =
    ///   解压；在卡后 → 卡片幸存 = 压缩保留）。
    pub fn commit_compaction(
        &self,
        conversation_id: &str,
        remove_card_ids: &[String],
        card_content: &str,
        card_created_at: &str,
        card_timestamp: &str,
    ) -> RusqliteResult<()> {
        let id = Uuid::new_v4().to_string();
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        // 吸收旧卡（按块执行，避免超过 SQLite 参数上限 ~999）
        for chunk in remove_card_ids.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "DELETE FROM messages
                 WHERE conversation_id = ?1 AND id IN ({placeholders})"
            );
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&conversation_id];
            params.extend(chunk.iter().map(|s| s as &dyn rusqlite::ToSql));
            tx.execute(&sql, rusqlite::params_from_iter(params))?;
        }

        tx.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content, image_paths_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            (
                &id,
                conversation_id,
                "system",
                card_content,
                card_timestamp,
                card_created_at,
                None::<&str>,
                None::<&str>,
                None::<&str>,
            ),
        )?;
        tx.commit()?;
        drop(conn);

        self.touch_conversation(conversation_id)?;
        Ok(())
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

    /// 级联删除：删除该对话及其全部子agent对话（task 工具创建）。
    /// 返回被删除的对话 id 列表（含自身）。
    /// 子agent不能再派发子agent（plan 工具集无 task 工具 + 工具内嵌套防御），
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

    pub fn delete_messages_from_timestamp(
        &self,
        conversation_id: &str,
        from_timestamp: &str,
    ) -> RusqliteResult<usize> {
        // 截断前收集磁盘图：保留「回撤目标」那条 user 的图（前端要恢复到输入框），
        // 其余被删消息的图全部回收，避免孤儿文件。
        let paths_to_delete: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT role, image_paths_json FROM messages
                 WHERE conversation_id = ?1 AND timestamp >= ?2
                 ORDER BY timestamp ASC, rowid ASC",
            )?;
            let rows: Vec<(String, Option<String>)> = stmt
                .query_map((conversation_id, from_timestamp), |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .filter_map(|r| r.ok())
                .collect();

            let mut keep_first_user_images = true;
            let mut to_delete = Vec::new();
            for (role, image_json) in rows {
                let is_rollback_target = keep_first_user_images && role == "user";
                if is_rollback_target {
                    keep_first_user_images = false;
                    continue;
                }
                if role == "user" {
                    keep_first_user_images = false;
                }
                if let Some(json) = image_json {
                    if let Ok(paths) = serde_json::from_str::<Vec<String>>(&json) {
                        to_delete.extend(paths);
                    }
                }
            }
            to_delete
        };

        let deleted = {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "DELETE FROM messages WHERE conversation_id = ?1 AND timestamp >= ?2",
                (conversation_id, from_timestamp),
            )?
        };

        // 撤回语义（原文全保留，无归档）：
        // 目标在压缩卡之前 → 卡片（timestamp = span 末行 ≥ 目标）被截断删除 = 解压；
        // 目标在卡后（保留尾部）→ 卡片幸存 = 压缩保留。无额外逻辑。

        for path in paths_to_delete {
            let _ = crate::agent::image_store::delete_image(&path);
        }

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

    /// 读取单个会话的元数据（不含消息）。
    pub fn get_conversation(&self, conversation_id: &str) -> RusqliteResult<Option<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, title, created_at, updated_at, parent_conversation_id, model_id
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
    pub fn upsert_conversation(&self, conv: &Conversation) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO conversations (id, connection_id, title, created_at, updated_at, parent_conversation_id, model_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET
                connection_id = excluded.connection_id,
                title = excluded.title,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                parent_conversation_id = excluded.parent_conversation_id,
                model_id = excluded.model_id",
            (
                &conv.id,
                &conv.connection_id,
                &conv.title,
                conv.created_at.to_rfc3339(),
                conv.updated_at.to_rfc3339(),
                &conv.parent_conversation_id,
                &conv.model_id,
            ),
        )?;
        Ok(())
    }

    /// 替换会话的全部消息（删除旧的 + 插入新的）。
    /// 用于跨设备同步 pull 时整体覆盖会话消息。
    pub fn replace_messages(
        &self,
        conversation_id: &str,
        messages: &[StoredMessage],
    ) -> RusqliteResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        for m in messages {
            tx.execute(
                "INSERT INTO messages (id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content, image_paths_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                    conversation_id = excluded.conversation_id,
                    role = excluded.role,
                    content = excluded.content,
                    timestamp = excluded.timestamp,
                    created_at = excluded.created_at,
                    tool_calls_json = excluded.tool_calls_json,
                    reasoning_content = excluded.reasoning_content,
                    image_paths_json = excluded.image_paths_json",
                (
                    &m.id,
                    &m.conversation_id,
                    &m.role,
                    &m.content,
                    &m.timestamp,
                    m.created_at.to_rfc3339(),
                    &m.tool_calls_json,
                    &m.reasoning_content,
                    &m.image_paths_json,
                ),
            )?;
        }
        tx.commit()?;
        Ok(())
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
        let mut stmt = conn.prepare("SELECT task_id FROM plans WHERE conversation_id = ?1")?;
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
    fn truncate_deletes_later_images_keeps_rollback_target() {
        use crate::agent::image_store;
        use tempfile::tempdir;

        // image_store 的 IMAGES_ROOT 是进程级全局（OnceLock），必须与其它
        // image 测试串行，否则 tempdir drop 竞态导致随机失败。
        let _guard = image_store::test_lock();
        let dir = tempdir().unwrap();
        image_store::init(dir.path());
        let db = create_test_db();
        let conversation = db
            .create_conversation("conn_1", "ImgRollback")
            .expect("create");

        let keep_path =
            image_store::save_image_bytes(&conversation.id, "m0", 0, b"keep-bytes").unwrap();
        let target_path =
            image_store::save_image_bytes(&conversation.id, "m1", 0, b"target-bytes").unwrap();
        let later_path =
            image_store::save_image_bytes(&conversation.id, "m2", 0, b"later-bytes").unwrap();

        db.save_message_with_images(
            &conversation.id,
            "user",
            "keep",
            "2026-01-01T00:00:00Z",
            None,
            None,
            Some(&format!(r#"["{}"]"#, keep_path)),
        )
        .expect("save keep");
        db.save_message_with_images(
            &conversation.id,
            "user",
            "rewrite",
            "2026-01-01T00:01:00Z",
            None,
            None,
            Some(&format!(r#"["{}"]"#, target_path)),
        )
        .expect("save target");
        db.save_message_with_images(
            &conversation.id,
            "user",
            "later",
            "2026-01-01T00:02:00Z",
            None,
            None,
            Some(&format!(r#"["{}"]"#, later_path)),
        )
        .expect("save later");

        let deleted = db
            .delete_messages_from_timestamp(&conversation.id, "2026-01-01T00:01:00Z")
            .expect("truncate");
        assert_eq!(deleted, 2);

        let exists = |rel: &str| {
            image_store::absolute_path(rel)
                .map(|p| p.exists())
                .unwrap_or(false)
        };
        // 回撤目标图保留（前端恢复预览），之后轮次图删除
        assert!(exists(&keep_path), "pre-truncate image should remain");
        assert!(exists(&target_path), "rollback target image should remain");
        assert!(!exists(&later_path), "later-turn image should be deleted");
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
        let conversation = db.create_conversation("conn_1", "Del").expect("create");
        let plan = r#"{"taskId":"t9","items":[],"currentIndex":0,"nextItemSeq":1,"reflectionReminded":false}"#;
        db.insert_plan_snapshot(&conversation.id, "t9", plan)
            .expect("snap");
        db.delete_conversation(&conversation.id).expect("delete");
        let snap = db
            .load_plan_snapshot_before(&conversation.id, "9999-01-01T00:00:00Z")
            .expect("query");
        assert!(snap.is_none());
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

    /// 回归测试：旧 schema（无 parent_conversation_id 列）的真实数据库文件
    /// 必须能正常打开并迁移——若迁移前在旧列上建索引，ConversationDb::new
    /// 会失败，AppState 将 fallback 到内存空库，用户全部历史会话不可见。
    #[test]
    fn test_old_schema_db_migrates_and_keeps_data() {
        use rusqlite::Connection;
        use tempfile::tempdir;

        let dir = tempdir().unwrap();
        let db_path = dir.path().join("old-conversations.db");
        // 手工构造旧版 schema（5 列，无 parent_conversation_id）+ 一条历史数据
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE conversations (
                    id TEXT PRIMARY KEY,
                    connection_id TEXT NOT NULL,
                    title TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE messages (
                    id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    tool_calls_json TEXT,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
                );
                CREATE TABLE plans (
                    task_id TEXT PRIMARY KEY,
                    conversation_id TEXT NOT NULL,
                    plan_json TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
                );
                CREATE INDEX idx_conversations_connection ON conversations(connection_id);
                CREATE INDEX idx_messages_conversation ON messages(conversation_id);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO conversations (id, connection_id, title, created_at, updated_at)
                 VALUES ('conv-old', 'conn-1', '历史会话', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO messages (id, conversation_id, role, content, timestamp, created_at)
                 VALUES ('msg-old', 'conv-old', 'user', 'hello', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }

        // 打开旧库：迁移必须成功、数据必须保留、新列必须可用
        let db = ConversationDb::new(&db_path).expect("old-schema db must open and migrate");

        let convs = db.list_conversations("conn-1").expect("list");
        assert_eq!(convs.len(), 1);
        assert_eq!(convs[0].id, "conv-old");
        assert!(convs[0].parent_conversation_id.is_none());
        // 旧库迁移后 model_id 列可用且缺省为 None（跟随全局默认）
        assert!(convs[0].model_id.is_none());

        // 新列真实可写可读（子对话创建 + 查询 + 会话级模型设置）
        let sub = db
            .create_sub_conversation("conn-1", "Sub（子agent）", "conv-old")
            .expect("create sub");
        let loaded = db.get_conversation(&sub.id).expect("get").expect("exists");
        assert_eq!(loaded.parent_conversation_id.as_deref(), Some("conv-old"));
        assert!(loaded.model_id.is_none());
        db.set_conversation_model_id("conv-old", Some("model-abc"))
            .expect("set model");
        let updated = db.get_conversation("conv-old").expect("get").expect("exists");
        assert_eq!(updated.model_id.as_deref(), Some("model-abc"));
        // 清空选择（回落全局默认）
        db.set_conversation_model_id("conv-old", None).expect("clear model");
        let cleared = db.get_conversation("conv-old").expect("get").expect("exists");
        assert!(cleared.model_id.is_none());

        // 历史消息保留
        let msgs = db.load_messages("conv-old").expect("load");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "hello");
    }

    #[test]
    fn test_commit_compaction_keeps_originals_and_positions_card_at_span_end() {
        let db = create_test_db();
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
        db.save_message(&conv.id, "tool", "out", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");

        let rows = db.load_messages(&conv.id).expect("load");
        let span_end = rows[2].clone();

        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 3 条历史消息（约 100 tokens）\n\nsummary",
            &span_end.created_at.to_rfc3339(),
            &span_end.timestamp,
        )
        .expect("commit");

        // 原文全保留；卡片位于 span 末尾（被压 3 条之后、保留尾部之前）
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 5);
        assert_eq!(after[0].content, "u1");
        assert_eq!(after[1].content, "a1");
        assert_eq!(after[2].content, "out");
        assert_eq!(after[3].role, "system");
        assert!(after[3].content.starts_with("【上下文已压缩】"));
        assert_eq!(
            after[3].created_at.to_rfc3339(),
            span_end.created_at.to_rfc3339()
        );
        assert_eq!(after[3].timestamp, span_end.timestamp);
        assert_eq!(after[4].content, "u2");
    }

    #[test]
    fn test_commit_compaction_removes_old_cards() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:01Z", None, None)
            .expect("m2");
        db.save_message(&conv.id, "user", "u3", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");

        // 第一次压缩：压 [u1]，卡片插在 u1 之后（无旧卡可吸收）
        let rows = db.load_messages(&conv.id).expect("load");
        let end1 = rows[0].clone();
        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 1 条历史消息（约 10 tokens）\n\ns1",
            &end1.created_at.to_rfc3339(),
            &end1.timestamp,
        )
        .expect("commit");
        let after1 = db.load_messages(&conv.id).expect("load");
        assert_eq!(after1.len(), 4);
        assert!(after1[1].content.starts_with("【上下文已压缩】"));

        // 第二次压缩：区间 [card1, u2]（head-anchored 含上一张卡）→ 只吸收旧卡 card1
        let rows2 = db.load_messages(&conv.id).expect("load");
        let card1_id = rows2[1].id.clone();
        let end2 = rows2[2].clone();
        db.commit_compaction(
            &conv.id,
            &[card1_id.clone()],
            "【上下文已压缩】已整理 2 条历史消息（约 20 tokens）\n\ns2",
            &end2.created_at.to_rfc3339(),
            &end2.timestamp,
        )
        .expect("commit");

        let after2 = db.load_messages(&conv.id).expect("load");
        // u1, u2, card2, u3 —— 旧卡 card1 行已删除，只留最新一张
        assert_eq!(after2.len(), 4);
        assert!(after2.iter().all(|m| m.id != card1_id));
        assert!(after2[2].content.starts_with("【上下文已压缩】"));
        assert_eq!(after2[3].content, "u3");
    }

    #[test]
    fn test_truncate_before_card_uncompacts() {
        let db = create_test_db();
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
        db.save_message(&conv.id, "tool", "out", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");
        db.save_message(
            &conv.id,
            "assistant",
            "a2",
            "2026-01-01T00:00:04Z",
            None,
            None,
        )
        .expect("m5");

        let rows = db.load_messages(&conv.id).expect("load");
        let end = rows[2].clone();
        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 3 条历史消息（约 100 tokens）\n\ns",
            &end.created_at.to_rfc3339(),
            &end.timestamp,
        )
        .expect("commit");
        // 压缩后：[u1, a1, out, card, u2, a2]
        assert_eq!(db.load_messages(&conv.id).expect("load").len(), 6);

        // 撤回目标 = u2（timestamp 00:03，卡后）→ 删除其后行；卡片 timestamp=00:02 < 目标 → 幸存
        db.delete_messages_from_timestamp(&conv.id, "2026-01-01T00:00:03Z")
            .expect("truncate");
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 4);
        assert_eq!(after[0].content, "u1");
        assert_eq!(after[1].content, "a1");
        assert_eq!(after[2].content, "out");
        assert!(after[3].content.starts_with("【上下文已压缩】"));
    }

    #[test]
    fn test_truncate_into_span_deletes_card() {
        let db = create_test_db();
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
        db.save_message(&conv.id, "tool", "out", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");
        let rows = db.load_messages(&conv.id).expect("load");
        let end = rows[2].clone();
        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 3 条历史消息（约 10 tokens）\n\ns",
            &end.created_at.to_rfc3339(),
            &end.timestamp,
        )
        .expect("commit");

        // 撤回目标在 span 中间（a1，timestamp 00:01 ≤ 卡片 timestamp 00:02）
        // → 卡片被截断删除（目标及其后行也删除）→ 解压，仅剩 u1
        db.delete_messages_from_timestamp(&conv.id, "2026-01-01T00:00:01Z")
            .expect("truncate");
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].content, "u1");
    }

    #[test]
    fn test_load_active_and_earlier_messages_with_compaction() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "Test").expect("create");

        // 1. 无压缩卡片时：load_active_messages 返回全量且 has_earlier 为 false
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

        let active1 = db.load_active_messages(&conv.id).expect("active1");
        assert_eq!(active1.messages.len(), 2);
        assert!(!active1.has_earlier);
        assert_eq!(active1.checkpoint_id, None);

        // 2. 增加消息并执行一次压缩
        db.save_message(&conv.id, "tool", "t1", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");
        let rows = db.load_messages(&conv.id).expect("load");
        let span_end = rows[2].clone(); // t1 作为压缩末尾

        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 3 条历史消息（约 100 tokens）\n\nsummary",
            &span_end.created_at.to_rfc3339(),
            &span_end.timestamp,
        )
        .expect("commit");

        db.save_message(
            &conv.id,
            "assistant",
            "a2",
            "2026-01-01T00:00:04Z",
            None,
            None,
        )
        .expect("m5");

        // 此时物理消息顺序：[u1, a1, t1, <card>, u2, a2]
        let active2 = db.load_active_messages(&conv.id).expect("active2");
        assert_eq!(active2.messages.len(), 3); // <card>, u2, a2
        assert!(active2.has_earlier);
        assert!(active2.messages[0].content.starts_with("【上下文已压缩】"));
        assert_eq!(active2.messages[1].content, "u2");
        assert_eq!(active2.messages[2].content, "a2");

        let cp_id = active2.checkpoint_id.expect("checkpoint_id exists");
        assert_eq!(cp_id, active2.messages[0].id);

        // 3. 测试 load_earlier_messages 从卡片开始向前拉取归档历史
        let earlier = db.load_earlier_messages(&conv.id, &cp_id).expect("earlier");
        assert_eq!(earlier.len(), 3); // u1, a1, t1
        assert_eq!(earlier[0].content, "u1");
        assert_eq!(earlier[1].content, "a1");
        assert_eq!(earlier[2].content, "t1");
    }
}
