// 会话与历史落库（ConversationDb，SQLite）。
//
// [`ConversationDb`] 用一把 `Mutex<Connection>` 承担会话相关职责，拆在同目录的子模块里
// —— 每个文件是同一个 `impl ConversationDb` 的一份切片，共享同一把锁：
//
// - `model.rs`         数据形状（Conversation / 错误 / 跨设备同步快照等）
// - `conversations.rs` 会话表 CRUD（列表、改名、置顶、模型与档位记忆、级联删除、全文搜索）
// - `messages.rs`      消息行存取（列清单唯一来源、归档翻页、回合收尾状态）
// - `history.rs`       历史回读（agent 只读入口：窗口、概览、检索、锚点）
// - `llm_history.rs`   请求历史投影（实时快照 / 落库引用、压缩边界、工具协议闭合）
// - `compaction.rs`    压缩落库（插卡、吸收旧卡、定位）
// - `usage.rs`         token 用量（累计 + 最近一次请求快照 + 「含子对话」口径）
// - `plans.rs`         plan 与快照存取
//
// 对外路径保持不变：全部 pub 类型在这里 re-export，`agent::conversation::X` 照旧。

mod compaction;
mod conversations;
mod history;
mod llm_history;
mod messages;
mod model;
mod plans;
mod usage;

pub use history::{
    CardBrief, HistoryError, HistoryHit, HistoryOverview, HistoryRead, HistoryWindow, MsgBrief,
    WindowStart,
};
pub use llm_history::HistorySnapshot;
pub use messages::{ActiveMessagesResult, EarlierMessagesResult, StoredMessage};
pub use model::{
    Conversation, ConversationError, ConversationSearchResult, ConversationWithMessages,
    SubConversationInfo,
};
pub use usage::{ConversationUsage, LastContext};

use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

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
                model_id TEXT,
                efforts_json TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                usage_json TEXT
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
            -- 归档翻页（load_earlier_messages）：锚点 (created_at,rowid) 向前取页
            -- 必须走索引序而不是全表排序。rowid 隐含在索引项末尾，等值 created_at
            -- 的 rowid 决胜与 DESC 反向扫描都不需要 TEMP B-TREE。
            CREATE INDEX IF NOT EXISTS idx_messages_conv_time
                ON messages(conversation_id, created_at);
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

        // Migration: add turn_state —— 回合收尾状态（写在回合首条 user 消息行上，
        // 见 `agent::task::TurnState`）。旧库 ALTER 加列；旧数据的 NULL = 「没有
        // 记录」，前端按消息形态判定（与加这一列之前完全一致）。
        //
        // 提交记录提醒（留着免得以后二分/回滚踩坑）：这条迁移与下面那条
        // `conversations.pinned` 是**和 read_history 无关**的两个特性，却一起混进了
        // 提交 82fa074（提交信息讲的是 read_history）—— 用 `git log -S turn_state`
        // 或对这两列做二分时，落在那个提交上并不代表问题出在回读功能里。
        if !column_exists(&conn, "messages", "turn_state") {
            log::info!("Migrating conversation database: adding turn_state column");
            conn.execute("ALTER TABLE messages ADD COLUMN turn_state TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: turn_state column added");
        }

        // 用户输入展示快照：旧行保持 NULL，正文仍是完整模型输入，不猜测或改写历史。
        if !column_exists(&conn, "messages", "user_input_json") {
            conn.execute("ALTER TABLE messages ADD COLUMN user_input_json TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
        }

        // Migration: add parent_conversation_id for subagent (subagent tool) conversations.
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

        // Migration: add efforts_json for per-conversation (model → reasoning
        // effort) persisted map. 旧库 ALTER 加列；新库建表已带列。缺省 NULL =
        // 无档位记忆（跟随模型默认，兼容旧数据）。
        if !column_exists(&conn, "conversations", "efforts_json") {
            log::info!("Migrating conversation database: adding efforts_json column");
            conn.execute("ALTER TABLE conversations ADD COLUMN efforts_json TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: efforts_json column added");
        }

        // Migration: add pinned for user-pinned conversations.
        // 旧库 ALTER 加列；新库建表已带列。缺省 0 = 未置顶（旧数据的列表顺序保持原样）。
        if !column_exists(&conn, "conversations", "pinned") {
            log::info!("Migrating conversation database: adding pinned column");
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: pinned column added");
        }

        // Migration: add usage_json for per-conversation token usage
        // （累计 + 最近一次请求的上下文快照，见 `ConversationUsage`）。
        // 旧库 ALTER 加列；新库建表已带列。缺省 NULL = 从未记过用量 ——
        // 前端显示 `—` 而不是 0（`ConversationUsage::from_json_column` 负责容错）。
        if !column_exists(&conn, "conversations", "usage_json") {
            log::info!("Migrating conversation database: adding usage_json column");
            conn.execute("ALTER TABLE conversations ADD COLUMN usage_json TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: usage_json column added");
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
mod test_support;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::create_test_db;
    use crate::agent::task::TurnState;

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

        let old_messages = db.load_messages("conv-old").expect("load old messages");
        assert_eq!(old_messages[0].content, "hello");
        assert!(old_messages[0].user_input_json.is_none());
        let metadata = r#"{"version":1,"text":"新消息","textAttachments":[]}"#;
        let added = db
            .save_message_with_user_input(
                "conv-old",
                "user",
                "新消息",
                "2026-01-02T00:00:00Z",
                None,
                None,
                None,
                Some(metadata),
            )
            .expect("write migrated column");
        assert_eq!(added.user_input_json.as_deref(), Some(metadata));

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
        let updated = db
            .get_conversation("conv-old")
            .expect("get")
            .expect("exists");
        assert_eq!(updated.model_id.as_deref(), Some("model-abc"));
        // 清空选择（回落全局默认）
        db.set_conversation_model_id("conv-old", None)
            .expect("clear model");
        let cleared = db
            .get_conversation("conv-old")
            .expect("get")
            .expect("exists");
        assert!(cleared.model_id.is_none());

        // 旧库迁移后 efforts_json 列可用（思考档位持久化）
        db.save_conversation_efforts("conv-old", Some(r#"{"m1":"high"}"#))
            .expect("save efforts");
        let rows = db.load_all_conversation_efforts().unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "conv-old");

        // 旧库迁移后 pinned 列可用且缺省为 false（未置顶，列表顺序保持原样）
        assert!(!convs[0].pinned);
        assert!(db.set_conversation_pinned("conv-old", true).expect("pin"));
        let pinned = db
            .get_conversation("conv-old")
            .expect("get")
            .expect("exists");
        assert!(pinned.pinned);
        assert!(db
            .set_conversation_pinned("conv-old", false)
            .expect("unpin"));
        assert!(
            !db.get_conversation("conv-old")
                .expect("get")
                .expect("exists")
                .pinned
        );

        // 旧库迁移后 usage_json 列可用：旧数据缺省 = 整块为空（前端显示 `—`，
        // 不是 0），记一轮之后能读回累计值
        assert!(convs[0].usage.is_empty());
        let recorded = db
            .record_usage(
                "conv-old",
                Some(&crate::llm::provider::TokenUsage {
                    prompt_tokens: 100,
                    completion_tokens: 20,
                    total_tokens: 120,
                    ..Default::default()
                }),
                LastContext {
                    used_tokens: 100,
                    estimated: false,
                    system_tokens: 10,
                    tools_tokens: 20,
                    message_tokens: 70,
                },
            )
            .expect("record usage")
            .expect("conv-old 存在");
        assert_eq!(recorded.prompt_tokens, 100);
        assert_eq!(recorded.total_tokens, 120);
        assert!(
            recorded.reasoning_tokens.is_none(),
            "未报过的可选字段保持 None"
        );
        let reloaded = db
            .get_conversation("conv-old")
            .expect("get")
            .expect("exists");
        assert_eq!(reloaded.usage.prompt_tokens, 100);
        assert_eq!(
            reloaded.usage.last_context.map(|c| c.used_tokens),
            Some(100)
        );
        // 历史消息保留
        let msgs = db.load_messages("conv-old").expect("load");
        assert_eq!(msgs.len(), 2, "旧消息保留，新增附件快照列可写");
        assert_eq!(msgs[0].content, "hello");
        assert!(msgs[0].user_input_json.is_none());
        assert_eq!(msgs[1].user_input_json.as_deref(), Some(metadata));
        // 旧库迁移后 turn_state 列可用：旧数据缺省为空（= 「没有记录」，
        // 前端回落按消息形态判定 —— 不动既有会话的折叠表现）
        assert!(msgs[0].turn_state.is_none());
        db.begin_turn_state("conv-old", "msg-old")
            .expect("begin turn");
        db.set_message_turn_state("msg-old", TurnState::Completed)
            .expect("end turn");
        assert_eq!(
            db.load_messages("conv-old").expect("load")[0]
                .turn_state
                .as_deref(),
            Some("completed")
        );
    }
}
