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
    SchemaError {
        source: rusqlite::Error,
    },
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
            ",
        ).map_err(|e| ConversationError::SchemaError { source: e })?;

        // Migration: rename session_id → connection_id if old schema exists
        let needs_migration = {
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(conversations)")
                .map(|mut stmt| {
                    stmt.query_map([], |r| r.get::<_, String>(1))
                        .expect("query_map failed")
                        .filter_map(|r| r.ok())
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            cols.iter().any(|c| c == "session_id") && !cols.iter().any(|c| c == "connection_id")
        };
        if needs_migration {
            log::info!("Migrating conversation database: renaming session_id → connection_id");
            conn.execute("ALTER TABLE conversations RENAME COLUMN session_id TO connection_id", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete");
        }

        // Migration: add tool_calls_json column if it doesn't exist yet
        let needs_tool_calls_column = {
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(messages)")
                .map(|mut stmt| {
                    stmt.query_map([], |r| r.get::<_, String>(1))
                        .expect("query_map failed")
                        .filter_map(|r| r.ok())
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            !cols.iter().any(|c| c == "tool_calls_json")
        };
        if needs_tool_calls_column {
            log::info!("Migrating conversation database: adding tool_calls_json column");
            conn.execute("ALTER TABLE messages ADD COLUMN tool_calls_json TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: tool_calls_json column added");
        }

        // Migration: add reasoning_content column if it doesn't exist yet
        let needs_reasoning_column = {
            let cols: Vec<String> = conn
                .prepare("PRAGMA table_info(messages)")
                .map(|mut stmt| {
                    stmt.query_map([], |r| r.get::<_, String>(1))
                        .expect("query_map failed")
                        .filter_map(|r| r.ok())
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            !cols.iter().any(|c| c == "reasoning_content")
        };
        if needs_reasoning_column {
            log::info!("Migrating conversation database: adding reasoning_content column");
            conn.execute("ALTER TABLE messages ADD COLUMN reasoning_content TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: reasoning_content column added");
        }

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

    pub fn load_messages(&self, conversation_id: &str) -> RusqliteResult<Vec<StoredMessage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content
             FROM messages
             WHERE conversation_id = ?1",
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
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        let now_str = now.to_rfc3339();
        let conn = self.conn.lock().unwrap();

        conn.execute(
            "INSERT INTO messages (id, conversation_id, role, content, timestamp, created_at, tool_calls_json, reasoning_content)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (&id, conversation_id, role, content, timestamp, &now_str, tool_calls_json, reasoning_content),
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
        })
    }

    pub fn delete_conversation(&self, conversation_id: &str) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        conn.execute(
            "DELETE FROM conversations WHERE id = ?1",
            [conversation_id],
        )?;
        Ok(())
    }

    pub fn delete_conversations_by_connection(&self, connection_id: &str) -> RusqliteResult<()> {
        let ids: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT id FROM conversations WHERE connection_id = ?1")?;
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

    /// Create an in-memory database for testing or as a fallback.
    pub fn in_memory() -> Result<Self, ConversationError> {
        Self::new(":memory:")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_test_db() -> ConversationDb {
        ConversationDb::in_memory().expect("Failed to create in-memory database")
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
            .save_message(&conversation.id, "user", "Hello", "2024-01-01T00:00:00Z", None, None)
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

        db.save_message(&conversation.id, "user", "Hello", "2024-01-01T00:00:00Z", None, None)
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

        let remaining = db
            .list_conversations("conn_1")
            .expect("Failed to list");
        assert!(remaining.is_empty());

        let conn2 = db
            .list_conversations("conn_2")
            .expect("Failed to list");
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

        let conversations = db
            .list_conversations("conn_1")
            .expect("Failed to list");
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

        let conversations = db
            .list_conversations("conn_1")
            .expect("Failed to list");
        assert!(conversations[0].updated_at > original_updated_at);
    }
}
