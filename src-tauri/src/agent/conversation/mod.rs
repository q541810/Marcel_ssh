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
// - `fork.rs`          会话分叉（把某个回合边界之前的历史整份复制成独立会话）
// - `recall.rs`        跨会话回忆（长期记忆：按机器检索历史会话、列最近活跃会话）
//
// 对外路径保持不变：全部 pub 类型在这里 re-export，`agent::conversation::X` 照旧。

mod compaction;
mod conversations;
mod fork;
mod history;
mod llm_history;
mod messages;
mod model;
mod plans;
mod recall;
mod usage;

pub use conversations::SubDispatch;
pub use fork::{AnchorRef, ForkError, ForkOutcome};
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
pub use recall::{RecallHit, RootConversationBrief};
pub use usage::{ConversationUsage, LastContext};

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;

use rusqlite::Connection;

pub struct ConversationDb {
    conn: Mutex<Connection>,
    /// `has_readable_history` 的按会话缓存。这个问题每轮 LLM 请求前都要问一次
    /// （`tools_for_round` 的状态门控），不值得每次全行 LIKE 扫描。判据只在三个
    /// 写路径上翻转——压缩提交（单调翻真）、派发子对话（翻真）、删子对话（可回落）
    /// ——缓存也只在这三处维护（见 `history.rs` 的 mark/invalidate）。
    readable_history_cache: std::sync::Mutex<HashMap<String, bool>>,
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
        tune_connection(&conn, &path_str);

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
                usage_json TEXT,
                forked_from_id TEXT,
                archived_at TEXT,
                sub_dispatch_json TEXT
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
            -- 归档翻页（load_earlier_messages）：锚点 (created_at,rowid) 向前取页
            -- 必须走索引序而不是全表排序。rowid 隐含在索引项末尾，等值 created_at
            -- 的 rowid 决胜与 DESC 反向扫描都不需要 TEMP B-TREE。
            -- 这条同时覆盖所有只按 conversation_id 的等值查询（最左前缀），
            -- 所以**不再**单独建 messages(conversation_id)：旧版本建过，见下方迁移。
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

        // Migration: 删掉冗余索引 idx_messages_conversation(conversation_id)。
        // 它是 idx_messages_conv_time(conversation_id, created_at) 的最左前缀，
        // 查询计划用后者照样走索引；留着只会让每条消息的 INSERT/DELETE 多维护一棵
        // B-tree。IF EXISTS：新库本来就没有。
        conn.execute("DROP INDEX IF EXISTS idx_messages_conversation", [])
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

        // 跨设备同步（T3 图片懒加载）用的列：消息引用的图片在**对端**叫什么（blob 名 / 来源设备），
        // 本机的 `image_paths_json` 是本地桶路径、只属于这台设备。本任务只建列、值恒 NULL，
        // 真正写它的是 T3。必须加在 `MESSAGES_COLUMNS` 末尾，否则按位读会错位。
        if !column_exists(&conn, "messages", "synced_images_json") {
            log::info!("Migrating conversation database: adding synced_images_json column");
            conn.execute(
                "ALTER TABLE messages ADD COLUMN synced_images_json TEXT",
                [],
            )
            .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: synced_images_json column added");
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

        // Migration: add forked_from_id —— 分叉来源（见 `Conversation::forked_from_id`）。
        // 旧库 ALTER 加列；缺省 NULL = 不是分叉出来的会话。
        if !column_exists(&conn, "conversations", "forked_from_id") {
            log::info!("Migrating conversation database: adding forked_from_id column");
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN forked_from_id TEXT",
                [],
            )
            .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: forked_from_id column added");
        }

        // Migration: add archived_at —— 会话归档（见 Conversation::archived_at）。
        // 旧库 ALTER 加列；缺省 NULL = 未归档（旧数据的列表与行为完全不变）。
        if !column_exists(&conn, "conversations", "archived_at") {
            log::info!("Migrating conversation database: adding archived_at column");
            conn.execute("ALTER TABLE conversations ADD COLUMN archived_at TEXT", [])
                .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: archived_at column added");
        }
        // Migration: add sub_dispatch_json —— 子 agent 对话的派发参数（执行侧 / 模式 / 目标机器），
        // 供 `continue_id` 续派时还原（见 `SubDispatch`）。旧库 ALTER 加列；NULL = 不是子 agent
        // 对话，或是引入该列之前派发的（这类对话不可续派）。
        if !column_exists(&conn, "conversations", "sub_dispatch_json") {
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN sub_dispatch_json TEXT",
                [],
            )
            .map_err(|e| ConversationError::SchemaError { source: e })?;
        }
        // 归档列表按「连接 + 归档时间」取，顺带覆盖按连接等值查未归档项的最左前缀。
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_conversations_archived ON conversations(connection_id, archived_at)",
            [],
        )
        .map_err(|e| ConversationError::SchemaError { source: e })?;

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

        // Migration: plan_snapshots.uid —— 跨设备同步的稳定主键。
        //
        // 自增 `id` 不能跨设备用（两台设备各自的 1、2、3 指向不同的行，同步等于把 A 的第 3 条
        // 覆盖成 B 的第 3 条）。给它一列 UUID：旧行在迁移时一次补全，新行由插入语句直接生成
        // （见 `plans.rs` 的 `insert_plan_snapshot`）——**别只在迁移里补**，否则新行 uid 为 NULL，
        // 而 SQLite 的 UNIQUE 允许任意多条 NULL，同步时这些行永远捕获不到。
        if !column_exists(&conn, "plan_snapshots", "uid") {
            log::info!("Migrating conversation database: adding plan_snapshots.uid column");
            // **带默认值**：`plan_snapshots` 有几处 INSERT 不写 uid（分叉复制、老代码），
            // 而同步触发器取 `NEW.uid` 作 row_id、`sync_changelog.row_id` 是 NOT NULL——
            // 没有默认值时任何一次「不带 uid 的插入」都会让整条业务写事务失败。
            // SQLite 只允许 ALTER 加常量默认值，所以用空串，再由下面的 UPDATE 补真 uuid。
            conn.execute(
                "ALTER TABLE plan_snapshots ADD COLUMN uid TEXT NOT NULL DEFAULT ''",
                [],
            )
            .map_err(|e| ConversationError::SchemaError { source: e })?;
            log::info!("Migration complete: plan_snapshots.uid column added");
        }
        // 无条件补 NULL：迁移中途崩溃（ALTER 成功、UPDATE 没跑完）的库下次启动能自愈；
        // 正常情况下这条语句一行都匹配不到，代价可以忽略。
        conn.execute(
            "UPDATE plan_snapshots SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL OR uid = ''",
            [],
        )
        .map_err(|e| ConversationError::SchemaError { source: e })?;
        // 索引在迁移之后无条件建：新库建表语句不在这一块里带 uid（老库的 CREATE TABLE IF NOT
        // EXISTS 什么也不做），漏建索引不会报错，只会让重复检查失效。
        conn.execute(
            // **部分索引**：只约束非空 uid。`ALTER ... ADD COLUMN` 只允许常量默认值，
            // 所以列上留了 `DEFAULT ''`；如果对空串也做唯一约束，任何两行「还没补 uid」
            // 的记录都会撞索引，直接让分叉 / 老代码的 INSERT 失败。
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_snapshots_uid ON plan_snapshots(uid) WHERE uid IS NOT NULL AND uid != ''",
            [],
        )
        .map_err(|e| ConversationError::SchemaError { source: e })?;

        log::info!("Conversation database initialized at: {}", path_str);

        // 行同步的表清单（T1 的 `rows::install`）：建 changelog / 时钟表 + 连接级触发器。
        //
        // **失败只记日志**：同步本身不是应用启动的前提，但触发器装不上意味着这台设备的
        // 对话改动永远无法同步出去——必须留一条显眼的日志，让「同步没反应」有据可查。
        // 每次打开连接都要装：触发器是 TEMP 的（要引用 temp.sync_applying），随连接消失。
        if let Err(e) = crate::sync::rows::install(&conn, crate::sync::streams::CONV_TABLES) {
            log::error!("对话库安装同步触发器失败（本机的对话改动将无法同步出去）: {e}");
        }

        Ok(Self {
            conn: Mutex::new(conn),
            readable_history_cache: std::sync::Mutex::new(HashMap::new()),
        })
    }

    /// Create an in-memory database for testing or as a fallback.
    pub fn in_memory() -> Result<Self, ConversationError> {
        Self::new(":memory:")
    }
}

// ---------------------------------------------------------------------------
// 跨设备同步（T2）的入口
// ---------------------------------------------------------------------------
//
// 全部方法都走 `self.conn.lock()`——**绝不另开连接**：行同步的触发器是连接级的
// （`CREATE TEMP TRIGGER`，要引用 `temp.sync_applying`），只有调过 `install` 的那条连接上
// 的写入才会被捕获（见 `sync/rows` 模块文档）。业务写入本来就都在这把锁下，所以同步捕获
// 与业务写入天然共用一条连接。
//
// 这一层只做三件事：拿锁、把参数原样交给 `rows::*`、转换错误。任何「同步策略」（延迟落地、
// 分包、大量删除闸）都在 `sync/streams/conv.rs` —— 这样 T4 的记忆库只要照着实现同样的几个
// 方法，就自动获得同一套策略。

/// 本机对话库在段头 `db` 字段里的名字（T4 的记忆库是 `"memory"`）。
pub const CONV_DB_NAME: &str = "conversations";

impl ConversationDb {
    /// 捕获本机改动（段头带 `db: "conversations"`）。
    pub fn sync_capture(
        &self,
        clock: &mut crate::sync::core::hlc::HlcClock,
        device: &str,
        wall_ms: u64,
        aliases: &crate::sync::rows::AliasMap,
        release_held: bool,
    ) -> Result<crate::sync::rows::CapturedRows, crate::error::AppError> {
        self.sync_capture_with_options(
            clock,
            device,
            wall_ms,
            aliases,
            crate::sync::rows::CaptureOptions {
                stream: crate::sync::streams::conv::CONV_STREAM,
                db: Some(CONV_DB_NAME),
                max_segment_bytes: crate::sync::rows::DEFAULT_MAX_SEGMENT_BYTES,
                release_held,
            },
        )
    }

    /// 同 [`Self::sync_capture`]，段参数由调用方给（驱动按自己这条流的口径传）。
    pub fn sync_capture_with_options(
        &self,
        clock: &mut crate::sync::core::hlc::HlcClock,
        device: &str,
        wall_ms: u64,
        aliases: &crate::sync::rows::AliasMap,
        options: crate::sync::rows::CaptureOptions,
    ) -> Result<crate::sync::rows::CapturedRows, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::capture_with(
            &conn,
            crate::sync::streams::CONV_TABLES,
            clock,
            device,
            wall_ms,
            aliases,
            options,
        )
    }

    /// 段上传成功、账本落盘之后删掉 changelog。
    pub fn sync_ack(&self, watermark: i64) -> Result<(), crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::ack(&conn, watermark)
            .map_err(|e| crate::error::AppError::Other(format!("对话库同步操作失败：{e}")))
    }

    /// 落地一段行 op（事务内直写业务表）。
    pub fn sync_apply(
        &self,
        ops_json: &[u8],
        aliases: &crate::sync::rows::AliasMap,
    ) -> Result<crate::sync::rows::RowApplied, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::apply(&conn, crate::sync::streams::CONV_TABLES, ops_json, aliases)
    }

    /// 全量导出（首次开启对话档 / 启动时补齐）。
    pub fn sync_export_all(
        &self,
        device: &str,
        aliases: &crate::sync::rows::AliasMap,
        batch_bytes: usize,
    ) -> Result<Vec<Vec<u8>>, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::export_all_with(
            &conn,
            crate::sync::streams::CONV_TABLES,
            device,
            aliases,
            crate::sync::rows::ExportOptions::new(
                crate::sync::streams::conv::CONV_STREAM,
                batch_bytes,
            )
            .with_db(CONV_DB_NAME),
        )
    }

    /// 还没登记图片 blob 的消息：`(message_id, [本机相对路径])`。
    ///
    /// 判据：`synced_images_json` 为 NULL 且有非空的 `image_paths_json`。
    pub fn sync_pending_images(
        &self,
    ) -> Result<Vec<(String, Vec<String>)>, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id, image_paths_json FROM messages                  WHERE synced_images_json IS NULL                    AND image_paths_json IS NOT NULL                    AND image_paths_json != '[]'",
            )
            .map_err(|e| crate::error::AppError::Other(format!("读待同步图片失败：{e}")))?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .map_err(|e| crate::error::AppError::Other(format!("读待同步图片失败：{e}")))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows
            .into_iter()
            .filter_map(|(id, json)| {
                let rels: Vec<String> = serde_json::from_str(&json).ok()?;
                (!rels.is_empty()).then_some((id, rels))
            })
            .collect())
    }

    /// 把一条消息的图片 blob 引用写进 `synced_images_json`。
    pub fn sync_set_images(
        &self,
        message_id: &str,
        json: &str,
    ) -> Result<(), crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "UPDATE messages SET synced_images_json = ?1 WHERE id = ?2",
            (json, message_id),
        )
        .map_err(|e| crate::error::AppError::Other(format!("写图片引用失败：{e}")))?;
        Ok(())
    }

    /// 找一张同步来的图片的 `(来源设备, blob 名)`。
    ///
    /// `synced_images_json` 的形状是 `[{"rel": "...", "blob": "<64hex>", "device": "..."}]`；
    /// 按 `rel` 精确匹配（同一张图可以在多条消息里出现，取任意一条即可）。
    pub fn sync_blob_ref_for(
        &self,
        rel: &str,
    ) -> Result<Option<(String, String)>, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT synced_images_json FROM messages                  WHERE synced_images_json IS NOT NULL",
            )
            .map_err(|e| crate::error::AppError::Other(format!("查图片同步信息失败：{e}")))?;
        let rows: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| crate::error::AppError::Other(format!("查图片同步信息失败：{e}")))?
            .filter_map(|r| r.ok())
            .collect();
        for json in rows {
            let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(&json) else {
                continue;
            };
            for e in entries {
                if e.get("rel").and_then(|v| v.as_str()) == Some(rel) {
                    let blob = e.get("blob").and_then(|v| v.as_str()).unwrap_or("");
                    let device = e.get("device").and_then(|v| v.as_str()).unwrap_or("");
                    if !blob.is_empty() && !device.is_empty() {
                        return Ok(Some((device.to_string(), blob.to_string())));
                    }
                }
            }
        }
        Ok(None)
    }

    /// 待上传条数（按行去重）。
    pub fn sync_pending_count(&self) -> Result<usize, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::pending_count(&conn, crate::sync::streams::CONV_TABLES)
    }

    /// 本机某张表里这一行的 `conversation_id`（延迟落地判断墓碑属于哪段会话）。
    pub fn sync_row_conversation(&self, table: &str, row_id: &str) -> Option<String> {
        let field = match table {
            "conversations" => return Some(row_id.to_string()),
            "messages" | "plans" | "plan_snapshots" => "conversation_id",
            _ => return None,
        };
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!(
                "SELECT {field} FROM {table} WHERE {} = ?1",
                sync_pk_of(table)
            ),
            [row_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    }

    /// 本机是否有这一行（判断消息 op 是不是「新插入」）。
    pub fn sync_row_exists(&self, table: &str, row_id: &str) -> bool {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            &format!("SELECT 1 FROM {table} WHERE {} = ?1", sync_pk_of(table)),
            [row_id],
            |_| Ok(()),
        )
        .is_ok()
    }

    /// 把这几行的待上传记录从 changelog 里摘掉（用户拒绝大量删除时用）。
    pub fn sync_ack_rows(&self, rows: &[(String, String)]) -> Result<(), crate::error::AppError> {
        if rows.is_empty() {
            return Ok(());
        }
        let conn = self.conn.lock().unwrap();
        for (table, row_id) in rows {
            conn.execute(
                "DELETE FROM sync_changelog WHERE tbl = ?1 AND row_id = ?2",
                (table, row_id),
            )
            .map_err(|e| crate::error::AppError::Other(format!("清理对话同步记录失败：{e}")))?;
        }
        Ok(())
    }

    /// 兜底清理：会话墓碑落地后，把子表里残留的行删掉。
    ///
    /// `rows::apply` 已经按 `RowTable::parent` 级联删过；这条路覆盖的是它不处理的两种
    /// 残留：墓碑因为时钟更旧被判掉，以及上次崩溃留下的孤儿行。整个清理在**捕获抑制**
    /// 里做：否则会为每条消息各生成一个墓碑（任务书第一节第 5 条）。
    pub fn sync_purge_conversation(
        &self,
        conversation_id: &str,
    ) -> Result<(), crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::with_capture_suppressed(&conn, || {
            for table in ["messages", "plan_snapshots", "plans"] {
                conn.execute(
                    &format!("DELETE FROM {table} WHERE conversation_id = ?1"),
                    [conversation_id],
                )
                .map_err(|e| {
                    crate::error::AppError::Other(format!("清理已删会话的残留失败：{e}"))
                })?;
            }
            Ok(())
        })
    }

    /// 对话档的规模估算（`sync_tier_estimate`）：会话数、图片数、库文件的大致字节数。
    ///
    /// 图片数按消息里记录的本机图片路径**条目数**算（不复用 `image_store` 的目录遍历：
    /// 那是全局单例、要初始化，而这里只是给用户一个量级）。字节数用 SQLite 的
    /// `page_count * page_size`：不需要知道库文件路径，也不受 WAL 未检查点影响太大。
    pub fn sync_estimate(&self) -> Result<(usize, usize, u64), crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        let conversations: i64 = conn
            .query_row("SELECT COUNT(*) FROM conversations", [], |r| r.get(0))
            .map_err(|e| crate::error::AppError::Other(format!("统计会话数失败：{e}")))?;
        let mut images = 0usize;
        {
            let mut stmt = conn
                .prepare(
                    "SELECT image_paths_json FROM messages
                     WHERE image_paths_json IS NOT NULL AND image_paths_json <> '[]'",
                )
                .map_err(|e| crate::error::AppError::Other(format!("统计图片数失败：{e}")))?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| crate::error::AppError::Other(format!("统计图片数失败：{e}")))?;
            for row in rows.flatten() {
                if let Ok(paths) = serde_json::from_str::<Vec<String>>(&row) {
                    images += paths.len();
                }
            }
        }
        let pages: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(0);
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .unwrap_or(0);
        Ok((
            conversations.max(0) as usize,
            images,
            (pages.max(0) as u64).saturating_mul(page_size.max(0) as u64),
        ))
    }
}

/// 同步用的主键列（与 `CONV_TABLES` 一致；`plan_snapshots` 是 `uid`）。
fn sync_pk_of(table: &str) -> &'static str {
    match table {
        "conversations" | "messages" => "id",
        "plans" => "task_id",
        "plan_snapshots" => "uid",
        _ => "id",
    }
}

#[cfg(test)]
impl ConversationDb {
    /// 真实 schema 的列清单（`sync::conv_scope_guard` 用它比对 `CONV_TABLES`）。
    pub(crate) fn live_columns_for_sync_test(
        &self,
    ) -> std::collections::BTreeMap<String, Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut out = std::collections::BTreeMap::new();
        for table in ["conversations", "messages", "plans", "plan_snapshots"] {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info({table})"))
                .expect("prepare table_info");
            let columns: Vec<String> = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .expect("query table_info")
                .filter_map(|r| r.ok())
                .collect();
            out.insert(table.to_string(), columns);
        }
        out
    }
}

/// 连接级调优：WAL + `synchronous=NORMAL`。
///
/// 默认的回滚日志 + `synchronous=FULL` 下，每次**自动提交**都要两三次 fsync，
/// 实测（Windows，本机）每条消息落库（插入 + 顶会话）≈ 12 ms，且全程占着
/// tokio worker 与那把全局 `Mutex<Connection>`；WAL + NORMAL 下提交只追加 WAL
/// 文件、不 fsync，≈ 0.04 ms，fsync 摊到检查点（默认每 ~4MB WAL 一次）。
///
/// **持久性取舍（产品已确认接受）**：NORMAL 下应用崩溃不丢数据；断电 / 系统崩溃
/// 可能丢掉最后几次已提交事务（库不会损坏，只是回到上一个检查点之后的某个一致
/// 状态）。会话历史可以接受这个代价。
///
/// 只有 WAL 真的生效才降到 NORMAL —— 回滚日志模式下 NORMAL 抵御不了断电损坏。
/// WAL 不可用的环境（只读介质、个别网络盘、另一实例占着库、`:memory:`）静默
/// 保持默认的 FULL，只记一条日志，**绝不让调优失败挡住打开库**。
///
/// WAL 是库文件级的持久设置（写进文件头），首次打开旧库时就地转换，此后每次
/// 打开都已是 WAL。注意库目录里会多出 `-wal` / `-shm` 两个伴生文件：任何
/// 「只拷贝 conversations.db」的备份都会丢掉尚未检查点的数据（当前代码里没有这
/// 种备份；以后加的话要先 `PRAGMA wal_checkpoint(TRUNCATE)`）。
fn tune_connection(conn: &Connection, path: &str) {
    if path == ":memory:" {
        return;
    }
    match conn.query_row("PRAGMA journal_mode = WAL", [], |row| {
        row.get::<_, String>(0)
    }) {
        Ok(mode) if mode.eq_ignore_ascii_case("wal") => {
            if let Err(e) = conn.execute_batch("PRAGMA synchronous = NORMAL;") {
                log::warn!(
                    "会话库已启用 WAL，但设置 synchronous=NORMAL 失败（保持默认）: {}",
                    e
                );
            }
        }
        Ok(mode) => {
            log::warn!(
                "会话库未能切到 WAL（当前 journal_mode={}），保持默认持久性设置",
                mode
            );
        }
        Err(e) => {
            log::warn!("会话库切换 WAL 失败（保持默认持久性设置）: {}", e);
        }
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

        // 旧库迁移后 archived_at 列可用：缺省 = 未归档（列表与行为不变），
        // 归档/恢复都能落库
        assert!(convs[0].archived_at.is_none());
        assert!(db.archive_conversation("conv-old").expect("archive"));
        assert!(db
            .get_conversation("conv-old")
            .expect("get")
            .expect("exists")
            .archived_at
            .is_some());
        assert!(db.unarchive_conversation("conv-old").expect("unarchive"));
        assert!(db
            .get_conversation("conv-old")
            .expect("get")
            .expect("exists")
            .archived_at
            .is_none());

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

    fn pragma_text(db: &ConversationDb, pragma: &str) -> String {
        db.conn
            .lock()
            .unwrap()
            .query_row(&format!("PRAGMA {pragma}"), [], |r| r.get::<_, String>(0))
            .unwrap()
    }

    fn pragma_int(db: &ConversationDb, pragma: &str) -> i64 {
        db.conn
            .lock()
            .unwrap()
            .query_row(&format!("PRAGMA {pragma}"), [], |r| r.get::<_, i64>(0))
            .unwrap()
    }

    fn index_names(db: &ConversationDb) -> Vec<String> {
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'",
            )
            .unwrap();
        stmt.query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    }

    /// 文件库必须跑在 WAL + NORMAL（每条消息落库 ≈12ms → ≈0.04ms 的来源）；
    /// 两项是一起生效的，掉了任何一项都说明调优被悄悄绕开了。
    #[test]
    fn file_db_runs_in_wal_with_normal_sync() {
        let dir = tempfile::tempdir().unwrap();
        let db = ConversationDb::new(dir.path().join("conversations.db")).unwrap();
        assert_eq!(pragma_text(&db, "journal_mode").to_lowercase(), "wal");
        assert_eq!(
            pragma_int(&db, "synchronous"),
            1,
            "1 = NORMAL（2 才是 FULL）"
        );
    }

    /// 内存库没有 WAL 可言：调优必须直接跳过，不能报错也不能改它的行为。
    #[test]
    fn in_memory_db_skips_tuning() {
        let db = ConversationDb::in_memory().unwrap();
        assert_eq!(pragma_text(&db, "journal_mode").to_lowercase(), "memory");
        assert_eq!(pragma_int(&db, "synchronous"), 2, "未调优 = 默认 FULL");
    }

    /// 存量用户的库是回滚日志模式、且带冗余索引：打开后必须就地转成 WAL、
    /// 删掉冗余索引，数据与最左前缀索引原样保留。
    #[test]
    fn legacy_rollback_journal_db_converts_to_wal_and_drops_redundant_index() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("conversations.db");
        {
            let seed = ConversationDb::new(&path).unwrap();
            let conv = seed.create_conversation("conn-1", "legacy").unwrap();
            seed.save_message(
                &conv.id,
                "user",
                "hello",
                "2026-01-01T00:00:00Z",
                None,
                None,
            )
            .unwrap();
        }
        // 把它还原成「旧版本留下的样子」：回滚日志 + 冗余索引。
        {
            let raw = rusqlite::Connection::open(&path).unwrap();
            let mode: String = raw
                .query_row("PRAGMA journal_mode = DELETE", [], |r| r.get(0))
                .unwrap();
            assert_eq!(mode, "delete");
            raw.execute_batch(
                "CREATE INDEX idx_messages_conversation ON messages(conversation_id);",
            )
            .unwrap();
        }

        let db = ConversationDb::new(&path).unwrap();
        assert_eq!(pragma_text(&db, "journal_mode").to_lowercase(), "wal");
        let indexes = index_names(&db);
        assert!(
            !indexes.iter().any(|n| n == "idx_messages_conversation"),
            "冗余索引应被迁移删除：{indexes:?}"
        );
        assert!(
            indexes.iter().any(|n| n == "idx_messages_conv_time"),
            "最左前缀覆盖它的 idx_messages_conv_time 必须保留：{indexes:?}"
        );
        let conv = &db.list_conversations("conn-1").unwrap()[0];
        let msgs = db.load_messages(&conv.id).unwrap();
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "hello");
    }

    #[test]
    fn fresh_db_has_no_redundant_index() {
        let db = ConversationDb::in_memory().unwrap();
        assert!(!index_names(&db)
            .iter()
            .any(|n| n == "idx_messages_conversation"));
    }

    /// 砍掉冗余索引后，按会话取消息仍必须走索引（而不是退化成全表扫描）。
    #[test]
    fn conversation_lookup_still_uses_an_index() {
        let db = ConversationDb::in_memory().unwrap();
        let conn = db.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE conversation_id = ?1")
            .unwrap();
        let plan: Vec<String> = stmt
            .query_map(["c"], |r| r.get::<_, String>(3))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        assert!(
            plan.iter()
                .any(|d| d.contains("USING") && d.contains("idx_messages_conv_time")),
            "plan: {plan:?}"
        );
    }

    /// 让「顶会话」那条 UPDATE 必然失败：用来证明它和前一步写入同事务。
    fn make_touch_fail(db: &ConversationDb) {
        db.conn
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fail_touch BEFORE UPDATE OF updated_at ON conversations
                 BEGIN SELECT RAISE(ABORT, 'injected touch failure'); END;",
            )
            .unwrap();
    }

    /// 写消息 + 顶会话是一个事务：顶会话失败时消息不得留下（旧实现是两次自动
    /// 提交，调用方拿到 Err 但消息行已落库）。
    #[test]
    fn save_message_is_atomic_with_touching_the_conversation() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "atomic").unwrap();
        make_touch_fail(&db);

        let err = db.save_message(&conv.id, "user", "x", "2026-01-01T00:00:00Z", None, None);
        assert!(err.is_err(), "顶会话失败必须让整次写入失败");
        assert!(
            db.load_messages(&conv.id).unwrap().is_empty(),
            "失败的写入不得留下半成品消息行"
        );
    }

    /// 撤回（截断）同理：顶会话失败 → 删除回滚，行与磁盘图都还在。
    #[test]
    fn truncate_is_atomic_with_touching_the_conversation() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "atomic").unwrap();
        db.save_message(
            &conv.id,
            "user",
            "keep me",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .unwrap();
        make_touch_fail(&db);

        let err = db.delete_messages_from_timestamp(&conv.id, "2026-01-01T00:00:00Z");
        assert!(err.is_err());
        assert_eq!(db.load_messages(&conv.id).unwrap().len(), 1, "删除必须回滚");
    }

    /// 压缩提交同理：插卡失败/顶会话失败，旧卡不得被吸收掉。
    #[test]
    fn commit_compaction_is_atomic_with_touching_the_conversation() {
        let db = create_test_db();
        let (conv_id, _archived, card_id, _active) =
            crate::agent::conversation::test_support::seed_compacted_conversation(&db);
        let before = db.load_messages(&conv_id).unwrap();
        make_touch_fail(&db);

        let err = db.commit_compaction(
            &conv_id,
            &[card_id.clone()],
            "【上下文已压缩】新卡",
            "2026-01-01T00:30:00Z",
            "2026-01-01T00:30:00Z",
        );
        assert!(err.is_err());
        let after = db.load_messages(&conv_id).unwrap();
        assert_eq!(after.len(), before.len(), "不得多出新卡，也不得少了旧卡");
        assert!(
            after.iter().any(|m| m.id == card_id),
            "被吸收的旧卡必须还在"
        );
    }
}
