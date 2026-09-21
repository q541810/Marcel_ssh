use std::path::Path;
use std::sync::Mutex;

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Result as RusqliteResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::agent::conversation_persister::COMPACTION_CARD_PREFIX;
use crate::agent::task::TurnState;

/// `messages` 表的**全部列**，顺序 = `map_stored_message` 里 `row.get(N)` 的顺序。
///
/// 这里是唯一的列清单：SELECT 列、INSERT 列与占位符、UPSERT 的 SET 子句都由它拼
/// 出来。此前这份清单在 SELECT 里抄了 4 遍、INSERT 里 3 遍、UPSERT SET 里 1 遍
/// —— 加一列要改约 10 处，而漏一处是**静默**的：
/// - 漏在某个 SELECT → 那条路径列数少一 → `row.get(N)` 返 `Err` → 被 `.ok()`
///   吞掉 → 字段静默变 `None`（例如图片附件在某条读取路径上消失）；
/// - 列插在**中间**而不是末尾 → 位置整体错位 → 静默读错字段，SQLite 不报错。
///
/// 注意：加列时除了这里，还要在建表语句或迁移块里 `ALTER TABLE ... ADD COLUMN`。
/// `messages_columns_const_matches_the_live_schema` 会盯着两边是否一致。
const MESSAGES_COLUMNS: &[&str] = &[
    "id",
    "conversation_id",
    "role",
    "content",
    "timestamp",
    "created_at",
    "tool_calls_json",
    "reasoning_content",
    "image_paths_json",
    "turn_state",
];

/// `SELECT <全部列> FROM messages` 用的列清单（拼一次复用，别每处各写一遍）。
fn messages_select_columns() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| MESSAGES_COLUMNS.join(", "))
}

/// `INSERT INTO messages <这一段>`：列清单 + `VALUES (?1 … ?N)` 占位符。
/// 占位符编号由列数生成，不会与列序错配。
fn messages_insert_clause() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let cols = MESSAGES_COLUMNS.join(", ");
        let placeholders = (1..=MESSAGES_COLUMNS.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("({cols}) VALUES ({placeholders})")
    })
}

/// UPSERT 的 `DO UPDATE SET` 子句：除主键 `id` 外的每一列都取 `excluded.*`。
/// 同样由列清单生成 —— 手写这份清单的下场是「加了列却忘了同步 SET，于是更新
/// 时那一列永远保留旧值」。
fn messages_upsert_set_clause() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        MESSAGES_COLUMNS
            .iter()
            .filter(|c| **c != "id")
            .map(|c| format!("{c} = excluded.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    })
}

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
    /// 子agent对话（subagent 工具创建）的父对话 id；主对话为 None。
    /// 用于：会话列表隐藏子对话、子对话内"返回主对话"、删除主对话级联删除。
    #[serde(default)]
    pub parent_conversation_id: Option<String>,
    /// 会话级模型选择：`llmRegistry` 中的模型条目 id。
    /// `None` = 跟随全局默认模型（未显式选择过 / 旧数据）。
    /// 启动任务时经 `agent_start_task` 的 `model_id` 传入，作为
    /// `AgentSpec.model_override` 解析；子 agent 继承父任务模型。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
    /// 会话级思考强度（`reasoning_effort` 档位字符串，**内存 overlay**，
    /// 落盘由 `conversations.efforts_json` 承载（(model→effort) 映射，
    /// 启动时装载回内存 `session_efforts`））：`None` = 未设置，跟随模型
    /// 自身默认。此字段只表达「当前生效模型的档位」，持久化的是整张映射。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    /// 用户置顶：置顶的对话在列表里浮到最上方（日期分组之前），不受
    /// `updated_at` 影响。切换置顶**不动 `updated_at`**，否则取消置顶会把
    /// 对话的日期分组顺序搅乱（见 `set_conversation_pinned`）。
    #[serde(default)]
    pub pinned: bool,
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
    /// 回合收尾状态（`agent::task::TurnState` 的落库字符串）。
    ///
    /// **只写在回合首条 user 消息行上**（其余行恒为 NULL）：一行代表整个回合。
    /// `None` = 没有记录 —— 旧数据、或本回合没锚定到 user 行；前端据此回落
    /// 「按消息形态判定」的既有行为（不清空、不重置任何东西）。
    /// 读到不认识的字符串同样回落 `None`（见 `TurnState::from_db_str`）。
    pub turn_state: Option<String>,
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

// ───────────────────── 历史回读（agent 侧只读入口） ─────────────────────
//
// 压缩从不删原文：它只把一段历史从**内存里**的 LLM 消息数组里 splice 掉、
// 换上一张 `【上下文已压缩】` 卡片行，并吸收掉上一张卡。原文照常躺在 `messages`
// 表里（用户往上滚就能看到），所以「读回被压掉的原文」只是给已有数据加一个只读
// 入口 —— 不新增表、不新增列、不迁移。
//
// 归档边界复用既有的那条规则：**最新一张压缩卡之前的行 = 归档原文，卡片及之后 =
// 当前上下文**。压缩恒从头部开始 ⇒ 新卡必然吸收旧卡 ⇒ 一个会话在任何时刻最多一张卡。
//
// 但别把"复用"读成"收敛"：这条规则在仓库里是**多处各写一遍**的等价实现 ——
//   · 共享的只有卡片前缀常量 `COMPACTION_CARD_PREFIX`（写卡与认卡一处定义）；
//   · 定位边界卡的 SQL 有两份：`load_active_messages` 与 `boundary_card`；
//   · `(created_at, rowid)` 行序比较在 SQL 片段里 6 处、Rust 里 2 处各写一遍；
//   · 前端还有自己的一份等价信号：`compaction?.status === 'done'`（从 DB 重载时
//     `parseCompactionSummary` 会把带前缀的行强制置成 done，两套信号因此等价，
//     由 `messageConversion.test.ts` 与 `conversationStore.test.ts` 钉住）。
// 改这条规则时这几处必须一起想，见各处交叉引用注释。

/// 行序游标：`messages` 的 `(created_at ASC, rowid ASC)` 位置。
/// 与 `load_earlier_messages` 用的是同一套比较语义。
#[derive(Debug, Clone, PartialEq, Eq)]
struct MsgPos {
    created_at: String,
    rowid: i64,
}

impl MsgPos {
    /// 是否严格早于另一位置（决定行序的完整比较）。
    fn before(&self, other: &MsgPos) -> bool {
        (self.created_at.as_str(), self.rowid) < (other.created_at.as_str(), other.rowid)
    }
}

/// 归档边界的那张压缩卡（带行序位置）。
#[derive(Debug, Clone)]
struct BoundaryCard {
    id: String,
    created_at: String,
    rowid: i64,
    timestamp: String,
    content: String,
}

/// 回读窗口的下界起点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowStart {
    /// 不限下界（从会话最早一条开始）。
    Earliest,
    /// 从该会话**读取那一刻**的最新压缩卡所在行开始（含卡片本身）。
    ///
    /// 子代理读父会话用这个：父会话之后再压缩只会让窗口变小 —— 那仍然只含
    /// 主 agent 当前上下文里有的部分，且**永远不会漏进归档原文**，也不会
    /// 因为旧卡被新卡吸收而锚点失效（下界是读时现算的，不是派发时冻结的）。
    LatestCard,
}

/// 回读窗口（**闭区间**）：`start` 是下界，`upto_message_id` 是上界（含该行）。
/// 两端都表达成"行序位置"，调用方不必懂 `(created_at, rowid)` 那套比较规则。
#[derive(Debug, Clone)]
pub struct HistoryWindow {
    pub start: WindowStart,
    /// 上界：这条消息所在行（含）。`None` = 不限（到会话最新一条）。
    /// 子代理读父会话时冻结在"派发那一刻"的最后一条已落库消息上。
    pub upto_message_id: Option<String>,
}

/// 已解析成行序位置的窗口。
#[derive(Debug, Clone, Default)]
struct ResolvedWindow {
    from: Option<MsgPos>,
    upto: Option<MsgPos>,
}

impl ResolvedWindow {
    /// 绑定用的四个值（None → SQL 里的 NULL → 该侧不限）。
    fn bindings(&self) -> (Option<&str>, Option<i64>, Option<&str>, Option<i64>) {
        (
            self.from.as_ref().map(|p| p.created_at.as_str()),
            self.from.as_ref().map(|p| p.rowid),
            self.upto.as_ref().map(|p| p.created_at.as_str()),
            self.upto.as_ref().map(|p| p.rowid),
        )
    }

    /// 位置是否落在窗口内（锚点越界要**明确报错**，不能静默返回空）。
    fn contains(&self, pos: &MsgPos) -> bool {
        if let Some(from) = &self.from {
            if pos.before(from) {
                return false;
            }
        }
        if let Some(upto) = &self.upto {
            if upto.before(pos) {
                return false;
            }
        }
        true
    }

    /// 窗口是不是**空区间**（两端都有位置、且上界排在下界之前）。
    ///
    /// 任一端为 `None` = 那一侧不限 ⇒ 永远不空。所以只有 `scope=parent` 能触发：
    /// 主 agent 在派发之后又压缩过，新卡排到了"派发那一刻"的冻结上界之后。
    /// 空区间在语义上是**正确**的（整段都落在最新卡之前 = 归档），错的只是报告方式 ——
    /// 检索会静默给"没有命中"、回读会报"这条不在窗口内"，都让 agent 误以为历史里没有。
    fn is_empty(&self) -> bool {
        match (&self.from, &self.upto) {
            (Some(from), Some(upto)) => upto.before(from),
            _ => false,
        }
    }
}

/// 窗口条件的 SQL 片段。`:win_*` 为 NULL 时对应侧短路为真。
/// 列名带 `messages.` 前缀：调用方可能把它拼进带 JOIN 的查询。
const HISTORY_WINDOW_SQL: &str = "
      AND (:win_from_created IS NULL
           OR messages.created_at > :win_from_created
           OR (messages.created_at = :win_from_created AND messages.rowid >= :win_from_rowid))
      AND (:win_upto_created IS NULL
           OR messages.created_at < :win_upto_created
           OR (messages.created_at = :win_upto_created AND messages.rowid <= :win_upto_rowid))";

/// 一条消息的轻量标识（回读概览与检索命中用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MsgBrief {
    pub id: String,
    pub role: String,
    pub timestamp: String,
}

/// 归档边界的压缩卡。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardBrief {
    pub id: String,
    pub timestamp: String,
    /// 卡片正文（含 `已整理 N 条历史消息（约 M tokens）` 与摘要全文）。
    pub content: String,
}

/// 本会话历史概览（需求：agent 得先知道"前面还有什么"）。
///
/// 所有计数与 id 都限定在**本次可读窗口内**：`scope=parent` 时窗口之外的东西
/// 一律不出现，免得给 agent 一串拿去做 `action=read` 必然失败的死 id。
/// 窗口外还有多少不告诉它不行 —— 那会让它以为"会话就这么多" —— 所以有
/// [`Self::hidden_before_window`]。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryOverview {
    /// 窗口内的总条数
    pub total: i64,
    /// 窗口内、边界卡之前的条数（= 归档段）；窗口内无卡 = 0
    pub archived: i64,
    /// 窗口内剩下的部分 = total - archived
    pub active: i64,
    pub oldest: Option<MsgBrief>,
    pub newest: Option<MsgBrief>,
    /// 归档段最后一条（配合 `oldest` 给出归档段的时间范围）
    pub archived_newest: Option<MsgBrief>,
    /// 归档边界 = 最新一张压缩卡，**且它落在窗口内**；无卡 / 卡在窗口外 = None
    pub boundary_card: Option<CardBrief>,
    /// 严格早于窗口下界的行数（"你看不到的那部分"）。非窗口路径恒为 0；
    /// `scope=parent` 下 > 0 表示有归档原文不在这个子代理的可读范围里。
    pub hidden_before_window: i64,
}

/// 检索命中（需求：返回可挑选的短清单，不是把历史倒出来）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHit {
    pub id: String,
    pub role: String,
    pub timestamp: String,
    /// 命中处前后约 50 字的片段
    pub snippet: String,
}

/// 一次定向回读的结果。
#[derive(Debug, Clone)]
pub struct HistoryRead {
    /// 按时间升序（锚点前若干条 + 锚点 + 锚点后若干条）
    pub messages: Vec<StoredMessage>,
    /// 锚点之前（窗口内）是否还有更多
    pub has_more_before: bool,
    /// 锚点之后（窗口内）是否还有更多
    pub has_more_after: bool,
}

/// 子对话条目（主 agent 核对子代理过程时先看这个）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubConversationInfo {
    pub id: String,
    pub title: String,
    pub created_at: chrono::DateTime<Utc>,
    pub message_count: i64,
}

/// 历史回读的错误。**必须与「查不到」区分开**：静默返回空会让 agent 以为
/// "历史里没有这段内容"，从而做出错误判断。
#[derive(Debug)]
pub enum HistoryError {
    Db(rusqlite::Error),
    /// 引用的行不存在：已被撤回删除，或旧压缩卡已被新卡吸收
    Missing(String),
    /// 引用的行存在，但不在本次可读窗口内（例如子代理去读被压缩掉的归档原文）
    OutOfWindow(String),
    /// 整个可读窗口是**空区间**：范围里一条都没有。
    ///
    /// 与 `OutOfWindow` 分开是因为"这条路走不通"与"锅里本来就没有"是两件事：
    /// 前者让 agent 换个锚点，后者要它换一条路（找主 agent 或直接问用户）。
    /// 无载荷 —— 它不是某条消息的问题，是整个范围的问题。
    EmptyWindow,
}

impl std::fmt::Display for HistoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "history read db error: {e}"),
            Self::Missing(id) => write!(f, "message not found: {id}"),
            Self::OutOfWindow(id) => write!(f, "message out of readable window: {id}"),
            Self::EmptyWindow => write!(f, "readable window is empty"),
        }
    }
}

impl From<rusqlite::Error> for HistoryError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e)
    }
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
                model_id TEXT,
                efforts_json TEXT,
                pinned INTEGER NOT NULL DEFAULT 0
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
        })
    }

    pub fn list_conversations(&self, connection_id: &str) -> RusqliteResult<Vec<Conversation>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT id, connection_id, title, created_at, updated_at, parent_conversation_id, model_id, pinned
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

        // 1. 查询最新的 Compaction Checkpoint 消息 (role = 'system' 且以压缩卡前缀开头)。
        //    前缀从 COMPACTION_CARD_PREFIX 来：写卡的地方与认卡的地方只能有一份字面量，
        //    否则改一处会静默失去归档边界（卡片被当成普通 system 消息）。
        //
        // ⚠️ 这段"定位边界卡"的 SQL 在本文件里还有一份等价实现：`boundary_card`
        // （回读用）。**改这里必须同时改那一处**，否则前端翻页与 agent 回读会对
        // 归档边界产生两种看法。前端另有一份等价判定，见文件头"归档边界"段落。
        let mut check_stmt = conn.prepare(
            "SELECT id, created_at, rowid FROM messages 
             WHERE conversation_id = ?1 
               AND role = 'system' 
               AND content LIKE ?2 ESCAPE '\\'
             ORDER BY created_at DESC, rowid DESC 
             LIMIT 1",
        )?;

        let checkpoint = check_stmt
            .query_row(
                rusqlite::params![conversation_id, format!("{COMPACTION_CARD_PREFIX}%")],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
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
                    &format!(
                        "SELECT {}
                        FROM messages
                        WHERE conversation_id = ?1 
                        AND (created_at > ?2 OR (created_at = ?2 AND rowid >= ?3))
                        ORDER BY created_at ASC, rowid ASC",
                        messages_select_columns()
                    ))?;
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
            &format!(
                "SELECT {}
                FROM messages
                WHERE conversation_id = ?1 
                AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
                ORDER BY created_at ASC, rowid ASC",
                messages_select_columns()
            ))?;

        let messages = stmt
            .query_map(
                rusqlite::params![conversation_id, created_at, rowid],
                Self::map_stored_message,
            )?
            .collect::<RusqliteResult<Vec<_>>>()?;

        Ok(messages)
    }

    // ───────────────────── 历史回读（只读，agent 侧入口） ─────────────────────
    //
    // 每个方法都是「一次持锁 + 一个事务」把「解析锚点/窗口」与「取行」做完：
    // 压缩只可能在整次回读之前或之后发生，不会出现锚点用旧卡、取行用新卡的
    // 半新半旧拼接。工具侧每个 action 只调一个方法，同理。

    /// 本会话历史概览：窗口内总数、归档段（边界卡之前）条数与时间范围、边界卡、
    /// 以及窗口之外还有多少条。
    ///
    /// `window = None` 与加这个参数之前**逐字节相同**（`HISTORY_WINDOW_SQL` 的四段
    /// 条件在两端为 NULL 时全部短路为真，且 `hidden_before_window` 恒为 0）。
    pub fn history_overview(
        &self,
        conversation_id: &str,
        window: Option<&HistoryWindow>,
    ) -> Result<HistoryOverview, HistoryError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let win = Self::resolve_history_window(&tx, conversation_id, window)?;
        let (fc, fr, uc, ur) = win.bindings();

        let total: i64 = tx.query_row(
            &format!(
                "SELECT COUNT(*) FROM messages
                 WHERE conversation_id = :conv {HISTORY_WINDOW_SQL}"
            ),
            rusqlite::named_params! {
                ":conv": conversation_id,
                ":win_from_created": fc,
                ":win_from_rowid": fr,
                ":win_upto_created": uc,
                ":win_upto_rowid": ur,
            },
            |r| r.get(0),
        )?;
        let oldest = Self::boundary_message(&tx, conversation_id, true, &win)?;
        let newest = Self::boundary_message(&tx, conversation_id, false, &win)?;
        // 边界卡只有在**落在窗口内**时才报：窗口为空时（父会话在派发后又压过）
        // 那张卡排在冻结上界之后，报出去就是一串读不到的 id —— 正是要修的缺陷类。
        let card = Self::boundary_card(&tx, conversation_id)?.filter(|c| {
            win.contains(&MsgPos {
                created_at: c.created_at.clone(),
                rowid: c.rowid,
            })
        });

        let (archived, archived_newest) = match &card {
            Some(card) => {
                let count: i64 = tx.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM messages
                         WHERE conversation_id = :conv
                           AND (messages.created_at < :card_created
                                OR (messages.created_at = :card_created
                                    AND messages.rowid < :card_rowid))
                           {HISTORY_WINDOW_SQL}"
                    ),
                    rusqlite::named_params! {
                        ":conv": conversation_id,
                        ":card_created": card.created_at,
                        ":card_rowid": card.rowid,
                        ":win_from_created": fc,
                        ":win_from_rowid": fr,
                        ":win_upto_created": uc,
                        ":win_upto_rowid": ur,
                    },
                    |r| r.get(0),
                )?;
                let last = tx
                    .query_row(
                        &format!(
                            "SELECT id, role, timestamp FROM messages
                             WHERE conversation_id = :conv
                               AND (messages.created_at < :card_created
                                    OR (messages.created_at = :card_created
                                        AND messages.rowid < :card_rowid))
                               {HISTORY_WINDOW_SQL}
                             ORDER BY created_at DESC, rowid DESC LIMIT 1"
                        ),
                        rusqlite::named_params! {
                            ":conv": conversation_id,
                            ":card_created": card.created_at,
                            ":card_rowid": card.rowid,
                            ":win_from_created": fc,
                            ":win_from_rowid": fr,
                            ":win_upto_created": uc,
                            ":win_upto_rowid": ur,
                        },
                        |r| {
                            Ok(MsgBrief {
                                id: r.get(0)?,
                                role: r.get(1)?,
                                timestamp: r.get(2)?,
                            })
                        },
                    )
                    .optional()?;
                (count, last)
            }
            None => (0, None),
        };

        // 窗口之外（更早）还有多少：不报的话 agent 会以为"会话就这么多"。
        let hidden_before_window: i64 = match win.from.as_ref() {
            Some(from) => tx.query_row(
                "SELECT COUNT(*) FROM messages
                 WHERE conversation_id = ?1
                   AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))",
                rusqlite::params![conversation_id, from.created_at, from.rowid],
                |r| r.get(0),
            )?,
            None => 0,
        };

        let overview = HistoryOverview {
            total,
            archived,
            active: total - archived,
            oldest,
            newest,
            archived_newest,
            boundary_card: card.as_ref().map(|c| CardBrief {
                id: c.id.clone(),
                timestamp: c.timestamp.clone(),
                content: c.content.clone(),
            }),
            hidden_before_window,
        };
        tx.finish()?;
        Ok(overview)
    }

    /// 在窗口内按关键词检索（大小写不敏感子串），返回按时间升序的命中清单。
    /// 空关键词返回空列表。
    pub fn search_history(
        &self,
        conversation_id: &str,
        keyword: &str,
        window: Option<&HistoryWindow>,
        limit: usize,
    ) -> Result<Vec<HistoryHit>, HistoryError> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let win = Self::resolve_history_window(&tx, conversation_id, window)?;
        // 空窗口放行到 SQL 会静默返回 0 行，工具渲染成"没有命中" —— agent 据此
        // 断定"历史里没有这段内容"，而事实是整个范围都读不到。必须明确报错。
        if win.is_empty() {
            return Err(HistoryError::EmptyWindow);
        }
        let (fc, fr, uc, ur) = win.bindings();
        let pattern = format!("%{}%", escape_like(keyword));
        let sql = format!(
            "SELECT id, role, content, timestamp FROM messages
             WHERE conversation_id = :conv
               AND content LIKE :pattern ESCAPE '\\' COLLATE NOCASE
               {HISTORY_WINDOW_SQL}
             ORDER BY created_at ASC, rowid ASC
             LIMIT :limit"
        );
        let hits = {
            let mut stmt = tx.prepare(&sql)?;
            let rows = stmt
                .query_map(
                    rusqlite::named_params! {
                        ":conv": conversation_id,
                        ":pattern": pattern,
                        ":limit": limit as i64,
                        ":win_from_created": fc,
                        ":win_from_rowid": fr,
                        ":win_upto_created": uc,
                        ":win_upto_rowid": ur,
                    },
                    |row| {
                        let content: String = row.get(2)?;
                        Ok(HistoryHit {
                            id: row.get(0)?,
                            role: row.get(1)?,
                            timestamp: row.get(3)?,
                            snippet: make_match_snippet(&content, keyword),
                        })
                    },
                )?
                .collect::<RusqliteResult<Vec<_>>>()?;
            rows
        };
        tx.finish()?;
        Ok(hits)
    }

    /// 以某条消息（或某张压缩卡）为锚点定向取原文：前 `before` 条 + 锚点本身 +
    /// 后 `after` 条，全部限定在窗口内。
    ///
    /// 锚点不在窗口内 → [`HistoryError::OutOfWindow`]；锚点不存在（已被撤回删除、
    /// 或旧卡被新卡吸收）→ [`HistoryError::Missing`]。两者都**不返回空列表**。
    pub fn read_history(
        &self,
        conversation_id: &str,
        window: Option<&HistoryWindow>,
        anchor_id: &str,
        before: usize,
        after: usize,
    ) -> Result<HistoryRead, HistoryError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let win = Self::resolve_history_window(&tx, conversation_id, window)?;
        // 空窗口的判断**必须早于锚点解析**：范围里一条都没有时，报"这条不在窗口内"
        // 或"这条不存在"都会把 agent 引去换锚点，而正确答案是"这个范围整个读不到"。
        // 有意保留的副作用：空窗口 + 不存在的锚点报 EmptyWindow 而不是 Missing ——
        // 空窗口是更上位的事实，两者都是明确报错，不会静默。
        if win.is_empty() {
            return Err(HistoryError::EmptyWindow);
        }
        let anchor = Self::msg_pos(&tx, conversation_id, anchor_id)?
            .ok_or_else(|| HistoryError::Missing(anchor_id.to_string()))?;
        if !win.contains(&anchor) {
            return Err(HistoryError::OutOfWindow(anchor_id.to_string()));
        }

        let (before_rows, has_more_before) =
            Self::fetch_side(&tx, conversation_id, &anchor, &win, false, before)?;
        let (after_rows, has_more_after) =
            Self::fetch_side(&tx, conversation_id, &anchor, &win, true, after)?;
        let anchor_row = Self::load_message_by_id(&tx, conversation_id, anchor_id)?
            .ok_or_else(|| HistoryError::Missing(anchor_id.to_string()))?;

        let mut messages = before_rows;
        messages.push(anchor_row);
        messages.extend(after_rows);
        tx.finish()?;
        Ok(HistoryRead {
            messages,
            has_more_before,
            has_more_after,
        })
    }

    /// 子代理可读父会话的**上界**：派发瞬间父会话最后一条已落库消息 id。
    ///
    /// 只冻结上界（"派发那一刻之前"）；下界（压缩卡）在读取时现取，
    /// 于是父会话之后再压缩只会让子代理的窗口变小 —— 那仍然只含主 agent
    /// 当前上下文里有的部分，且永远不会漏进归档原文，也不会因旧卡被吸收而失效。
    pub fn history_tail_anchor(&self, conversation_id: &str) -> RusqliteResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [conversation_id],
            |r| r.get(0),
        )
        .optional()
    }

    /// 本会话此刻是否已经存在"读不到的东西"：出现过压缩（有归档卡），或派发过子对话。
    /// 决定 `read_history` 是否进本次请求的工具清单（见 `tools::STATE_GATED_TOOLS`）。
    ///
    /// 单调性：边界卡只会被新卡吸收、不会消失，所以压缩这一侧只增不减；子对话被
    /// 删除后判据会回落，但那时这个工具本来也读不到任何东西。
    ///
    /// 与 `history_overview` 分开是因为这是每轮请求前都要问一次的问题，不该为它
    /// 跑一次六条语句的概览。
    pub fn has_readable_history(&self, conversation_id: &str) -> RusqliteResult<bool> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("{COMPACTION_CARD_PREFIX}%");
        conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM messages
                  WHERE conversation_id = ?1 AND role = 'system'
                    AND content LIKE ?2 ESCAPE '\\'
             ) OR EXISTS(
                 SELECT 1 FROM conversations WHERE parent_conversation_id = ?1
             )",
            rusqlite::params![conversation_id, pattern],
            |r| r.get(0),
        )
    }

    /// 本会话派发过的子对话（按创建时间升序）。
    pub fn list_sub_conversations(
        &self,
        parent_conversation_id: &str,
    ) -> RusqliteResult<Vec<SubConversationInfo>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.title, c.created_at, COUNT(m.id)
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE c.parent_conversation_id = ?1
             GROUP BY c.id, c.title, c.created_at
             ORDER BY c.created_at ASC",
        )?;
        let rows = stmt
            .query_map([parent_conversation_id], |row| {
                Ok(SubConversationInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row
                        .get::<_, String>(2)?
                        .parse()
                        .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC),
                    message_count: row.get(3)?,
                })
            })?
            .collect::<RusqliteResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// 消息 id → 行序位置；行不存在返回 None。
    fn msg_pos(
        conn: &Connection,
        conversation_id: &str,
        message_id: &str,
    ) -> RusqliteResult<Option<MsgPos>> {
        conn.query_row(
            "SELECT created_at, rowid FROM messages WHERE conversation_id = ?1 AND id = ?2",
            [conversation_id, message_id],
            |r| {
                Ok(MsgPos {
                    created_at: r.get(0)?,
                    rowid: r.get(1)?,
                })
            },
        )
        .optional()
    }

    /// 把窗口两端的 id 解析成行序位置；引用的行不存在 → 明确报错。
    fn resolve_history_window(
        conn: &Connection,
        conversation_id: &str,
        window: Option<&HistoryWindow>,
    ) -> Result<ResolvedWindow, HistoryError> {
        let Some(window) = window else {
            return Ok(ResolvedWindow::default());
        };
        let mut resolved = ResolvedWindow::default();
        if window.start == WindowStart::LatestCard {
            // 读时现算：没有卡片（从未压缩）⇒ 无下界，会话全部可读
            resolved.from = Self::boundary_card(conn, conversation_id)?
                .map(|c| MsgPos { created_at: c.created_at, rowid: c.rowid });
        }
        if let Some(id) = window.upto_message_id.as_deref() {
            resolved.upto = Some(
                Self::msg_pos(conn, conversation_id, id)?
                    .ok_or_else(|| HistoryError::Missing(id.to_string()))?,
            );
        }
        Ok(resolved)
    }

    /// 窗口内最早/最新的一条消息。
    fn boundary_message(
        conn: &Connection,
        conversation_id: &str,
        oldest: bool,
        win: &ResolvedWindow,
    ) -> RusqliteResult<Option<MsgBrief>> {
        let order = if oldest { "ASC" } else { "DESC" };
        let (fc, fr, uc, ur) = win.bindings();
        conn.query_row(
            &format!(
                "SELECT id, role, timestamp FROM messages
                 WHERE conversation_id = :conv
                 {HISTORY_WINDOW_SQL}
                 ORDER BY created_at {order}, rowid {order} LIMIT 1"
            ),
            rusqlite::named_params! {
                ":conv": conversation_id,
                ":win_from_created": fc,
                ":win_from_rowid": fr,
                ":win_upto_created": uc,
                ":win_upto_rowid": ur,
            },
            |r| {
                Ok(MsgBrief {
                    id: r.get(0)?,
                    role: r.get(1)?,
                    timestamp: r.get(2)?,
                })
            },
        )
        .optional()
    }

    /// 归档边界 = 最新一张压缩卡（带行序位置，供比较用）。无卡 → None。
    ///
    /// ⚠️ 本查询与 `load_active_messages` 里那段"定位 checkpoint"是**同一件事的两份
    /// 实现**（前端翻页用那份，agent 回读用这份）。**改一处必须同时改另一处**，
    /// 否则两边对归档边界会有两种看法。前端还有一份等价判定（`compaction.status
    /// === 'done'` + 卡片前缀），见文件头"归档边界"段落。
    fn boundary_card(
        conn: &Connection,
        conversation_id: &str,
    ) -> RusqliteResult<Option<BoundaryCard>> {
        let pattern = format!("{COMPACTION_CARD_PREFIX}%");
        conn.query_row(
            "SELECT id, created_at, rowid, timestamp, content FROM messages
             WHERE conversation_id = ?1
               AND role = 'system'
               AND content LIKE ?2 ESCAPE '\\'
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            rusqlite::params![conversation_id, pattern],
            |r| {
                Ok(BoundaryCard {
                    id: r.get(0)?,
                    created_at: r.get(1)?,
                    rowid: r.get(2)?,
                    timestamp: r.get(3)?,
                    content: r.get(4)?,
                })
            },
        )
        .optional()
    }

    /// 按 id 取一条消息（整行）。
    fn load_message_by_id(
        conn: &Connection,
        conversation_id: &str,
        message_id: &str,
    ) -> RusqliteResult<Option<StoredMessage>> {
        conn.query_row(
            &format!(
                "SELECT {} FROM messages WHERE conversation_id = ?1 AND id = ?2",
                messages_select_columns()
            ),
            [conversation_id, message_id],
            Self::map_stored_message,
        )
        .optional()
    }

    /// 从锚点向某一侧取 `rows` 条（多取一条当探针判断还有没有更多），
    /// 返回 (按时间升序的行, 是否还有更多)。
    fn fetch_side(
        conn: &Connection,
        conversation_id: &str,
        anchor: &MsgPos,
        win: &ResolvedWindow,
        forward: bool,
        rows: usize,
    ) -> RusqliteResult<(Vec<StoredMessage>, bool)> {
        let (order, cmp) = if forward { ("ASC", ">") } else { ("DESC", "<") };
        let sql = format!(
            "SELECT {}
             FROM messages
             WHERE conversation_id = :conv
               AND (created_at {cmp} :anchor_created
                    OR (created_at = :anchor_created AND rowid {cmp} :anchor_rowid))
               {HISTORY_WINDOW_SQL}
             ORDER BY created_at {order}, rowid {order}
             LIMIT :limit",
            messages_select_columns()
        );
        let (fc, fr, uc, ur) = win.bindings();
        let mut stmt = conn.prepare(&sql)?;
        let mut out = stmt
            .query_map(
                rusqlite::named_params! {
                    ":conv": conversation_id,
                    ":anchor_created": anchor.created_at.as_str(),
                    ":anchor_rowid": anchor.rowid,
                    ":limit": (rows + 1) as i64,
                    ":win_from_created": fc,
                    ":win_from_rowid": fr,
                    ":win_upto_created": uc,
                    ":win_upto_rowid": ur,
                },
                Self::map_stored_message,
            )?
            .collect::<RusqliteResult<Vec<_>>>()?;
        let has_more = out.len() > rows;
        out.truncate(rows);
        if !forward {
            out.reverse();
        }
        Ok((out, has_more))
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
            // 未知串 → None（降级运行读到未来版本写的值时不冒充正常结束）
            turn_state: row
                .get::<_, Option<String>>(9)
                .ok()
                .flatten()
                .filter(|raw| TurnState::from_db_str(raw).is_some()),
        })
    }

    fn query_stored_messages(
        conn: &Connection,
        conversation_id: &str,
        limit: Option<usize>,
    ) -> RusqliteResult<Vec<StoredMessage>> {
        let sql = match limit {
            Some(_) => {
                &format!(
                    "SELECT {}
                    FROM messages
                    WHERE conversation_id = ?1
                    ORDER BY created_at ASC, rowid ASC
                    LIMIT ?2",
                    messages_select_columns()
                )
            }
            None => {
                &format!(
                    "SELECT {}
                    FROM messages
                    WHERE conversation_id = ?1
                    ORDER BY created_at ASC, rowid ASC",
                    messages_select_columns()
                )
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
            &format!(
                "INSERT INTO messages {}",
                messages_insert_clause()
            ),
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
                // 回合收尾状态不在这里写：只有回合首条 user 行需要，由
                // `begin_turn_state` / `set_message_turn_state` 事后 UPDATE。
                None::<&str>,
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
            turn_state: None,
        })
    }

    /// 回合开始：把锚点行（回合首条 user 消息）标成 `running`。
    ///
    /// 为什么必须**在回合开始时**先写一笔：进程崩溃 / 被强杀时没有任何机会跑
    /// 收尾写入，行上留在 `running` 就是「这一轮没有正常收尾」的持久证据；
    /// 只在收尾时才写的话，崩溃与「旧版本留下的、压根没有记录的行」无法区分。
    ///
    /// 同一次调用顺手把本会话里**别的** `running` 行收敛成 `interrupted`：
    /// 这个会话既然还能开出新回合，那些行早已不属于任何在跑的任务 —— 只可能
    /// 是上次进程异常退出留下的。收敛放在这里而不是启动时全库扫一遍，是为了
    /// 不跟「另一个实例正在跑同一会话」互踩：作用域限定在本会话、本回合之外。
    pub fn begin_turn_state(&self, conversation_id: &str, message_id: &str) -> RusqliteResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE messages SET turn_state = ?1
             WHERE conversation_id = ?2 AND turn_state = ?3 AND id <> ?4",
            (
                TurnState::Interrupted.as_str(),
                conversation_id,
                TurnState::Running.as_str(),
                message_id,
            ),
        )?;
        tx.execute(
            "UPDATE messages SET turn_state = ?1 WHERE id = ?2",
            (TurnState::Running.as_str(), message_id),
        )?;
        tx.commit()
    }

    /// 回合收尾：把终态写到锚点行上。返回是否命中了行 —— 锚点可能已被回滚
    /// 删除（回合本身都没了），那就不写、也不报错。
    pub fn set_message_turn_state(
        &self,
        message_id: &str,
        state: TurnState,
    ) -> RusqliteResult<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE messages SET turn_state = ?1 WHERE id = ?2",
            (state.as_str(), message_id),
        )?;
        Ok(rows > 0)
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
            &format!(
                "INSERT INTO messages {}",
                messages_insert_clause()
            ),
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
            "SELECT id, connection_id, title, created_at, updated_at, parent_conversation_id, model_id, pinned
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
                &format!(
                    "INSERT INTO messages {} ON CONFLICT(id) DO UPDATE SET {}",
                    messages_insert_clause(),
                    messages_upsert_set_clause()
                ),
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
                    // 跨设备同步的回合收尾状态照搬（同一台设备上被判定过的
                    // 回合，同步到别处不能突然变成「可以折叠」）
                    &m.turn_state,
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
        assert!(db.set_conversation_pinned("conv-old", false).expect("unpin"));
        assert!(!db
            .get_conversation("conv-old")
            .expect("get")
            .expect("exists")
            .pinned);
        // 历史消息保留
        let msgs = db.load_messages("conv-old").expect("load");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0].content, "hello");
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

    /// `MESSAGES_COLUMNS` 必须与**实际 schema**（建表 + 迁移跑完后的表）逐列一致、且顺序相同。
    ///
    /// 这条守的是「加了列却忘了更新列清单」：`MESSAGES_COLUMNS` 是 SELECT/INSERT 的
    /// 唯一来源，它少一列 → 每条读取路径都少一列 → `row.get(N)` 返 `Err` → 被
    /// `.ok()` 吞掉 → 字段静默变 `None`。顺序也要管：`map_stored_message` 用的是
    /// 位置下标，顺序错了就是静默读错字段。
    #[test]
    fn messages_columns_const_matches_the_live_schema() {
        let db = create_test_db();
        let conn = db.conn.lock().unwrap();
        let live: Vec<String> = conn
            .prepare("PRAGMA table_info(messages)")
            .expect("prepare table_info")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info")
            .filter_map(|r| r.ok())
            .collect();

        let expected: Vec<String> = MESSAGES_COLUMNS.iter().map(|c| c.to_string()).collect();
        assert_eq!(
            live, expected,
            "messages 表列与 MESSAGES_COLUMNS 不一致（加列时两边都要改）"
        );
    }

    /// 同一条消息里的每个可选字段都用**互不相同**的值写进去，再把每条读取路径都读
    /// 一遍 —— 任一路径**漏了列**（列数少一 → `row.get(N)` 返 `Err` → 被 `.ok()`
    /// 吞掉 → 字段静默变 `None`），这里的断言就会失败。
    ///
    /// 注意它**拦不住列序错位**：读写共用同一份 `MESSAGES_COLUMNS`，顺序错了也是一致地
    /// 错（值被写进"错"的库列，读回来却对得上），两个错误互相抵消。顺序由
    /// `messages_columns_const_matches_the_live_schema` 与真实 schema 比对来守 ——
    /// 实测：把 `reasoning_content` 挪到 `tool_calls_json` 前面，只有那条会红。
    /// 一遍 —— 任一路径漏了列或列序错位，这里的断言就会失败。
    ///
    /// 覆盖的读取路径（4 处 SELECT 各一条）：
    /// - `query_stored_messages`（全量 / 带 limit 两个分支）
    /// - `load_active_messages`：有压缩卡片 → 只取卡片之后的消息（内联 SELECT）
    /// - `load_active_messages`：无卡片 → 回落到 `query_stored_messages`
    /// - `load_earlier_messages`：翻页取更早的消息（内联 SELECT）
    #[test]
    fn every_optional_message_field_survives_all_read_paths() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "roundtrip").expect("conv");
        let tools = r#"[{"id":"call_1","name":"bash"}]"#;
        let reasoning = "先看目录再看文件";
        let images = r#"["/tmp/one.png","/tmp/two.png"]"#;

        let early = db
            .save_message_with_images(
                &conv.id,
                "assistant",
                "早的消息",
                "2026-01-01T00:00:00Z",
                Some(tools),
                Some(reasoning),
                Some(images),
            )
            .expect("early");

        // 压缩卡片：触发 load_active_messages 的 checkpoint 分支
        db.save_message(
            &conv.id,
            "system",
            "【上下文已压缩】测试卡片",
            "2026-01-01T00:00:30Z",
            None,
            None,
        )
        .expect("checkpoint");

        let late = db
            .save_message_with_images(
                &conv.id,
                "assistant",
                "晚的消息",
                "2026-01-01T00:01:00Z",
                Some(tools),
                Some(reasoning),
                Some(images),
            )
            .expect("late");

        let assert_rich = |m: &StoredMessage, what: &str| {
            assert_eq!(m.tool_calls_json.as_deref(), Some(tools), "{what}: tool_calls");
            assert_eq!(
                m.reasoning_content.as_deref(),
                Some(reasoning),
                "{what}: reasoning"
            );
            assert_eq!(m.image_paths_json.as_deref(), Some(images), "{what}: images");
            assert!(
                m.content == "早的消息" || m.content == "晚的消息" || m.content == "唯一一条",
                "{what}: content 被别的列顶掉了（列序错位？）: {}",
                m.content
            );
        };

        // ① 全量（query_stored_messages 无 limit 分支）
        {
            let conn = db.conn.lock().unwrap();
            let all = ConversationDb::query_stored_messages(&conn, &conv.id, None).expect("all");
            assert_eq!(all.len(), 3);
            assert_rich(&all[0], "query_stored_messages(无 limit)");
            assert_rich(&all[2], "query_stored_messages(无 limit)");
        }
        // ② 带 limit（query_stored_messages 的另一个分支）
        {
            let conn = db.conn.lock().unwrap();
            let limited =
                ConversationDb::query_stored_messages(&conn, &conv.id, Some(1)).expect("limited");
            assert_eq!(limited.len(), 1, "limit 分支应只取最后一条");
            assert_rich(&limited[0], "query_stored_messages(limit)");
        }
        // ③ 压缩卡片之后（load_active_messages 的 checkpoint 内联 SELECT）
        {
            let active = db.load_active_messages(&conv.id).expect("active");
            // 该分支的 SQL 是 `rowid >= 卡片 rowid` —— 卡片本身也在返回集里
            assert_eq!(active.messages.len(), 2, "卡片 + 卡片之后的消息");
            assert_eq!(active.messages[1].id, late.id);
            assert_rich(active.messages.last().expect("last"), "load_active_messages(checkpoint)");
        }
        // ④ 翻页取更早（load_earlier_messages 的内联 SELECT）
        {
            let earlier = db
                .load_earlier_messages(&conv.id, &late.id)
                .expect("earlier");
            let first = earlier.first().expect("应取到更早的消息");
            assert_eq!(first.id, early.id);
            assert_rich(first, "load_earlier_messages");
        }
        // ⑤ 没有卡片时回落到全量路径
        {
            let plain = db.create_conversation("conn_2", "no-checkpoint").expect("conv2");
            db.save_message_with_images(
                &plain.id,
                "assistant",
                "唯一一条",
                "2026-01-01T00:00:00Z",
                Some(tools),
                Some(reasoning),
                Some(images),
            )
            .expect("plain msg");
            let active = db.load_active_messages(&plain.id).expect("active plain");
            assert_eq!(active.messages.len(), 1);
            assert_rich(&active.messages[0], "load_active_messages(无卡片)");
        }
    }

    /// 回合收尾状态：写进锚点行后，每条读取路径都要能读到（漏列 = 静默变 None
    /// —— 前端会把它当成「没有记录」而按形态折叠，正是本次要修的那个问题在
    /// 另一个层面的复现）。同时钉住两件默认行为：普通 INSERT 的行没有收尾状态、
    /// 未知字符串读回来是 None（不冒充「正常结束」）。
    #[test]
    fn turn_state_roundtrips_through_every_read_path() {
        let db = create_test_db();
        let conv = db
            .create_conversation("conn_1", "turn-state")
            .expect("conv");
        let anchor = db
            .save_message(
                &conv.id,
                "user",
                "跑一下",
                "2026-01-01T00:00:00Z",
                None,
                None,
            )
            .expect("anchor");
        // 普通 INSERT 的行没有回合收尾状态
        assert!(anchor.turn_state.is_none());
        let later = db
            .save_message(
                &conv.id,
                "assistant",
                "好的",
                "2026-01-01T00:00:01Z",
                None,
                None,
            )
            .expect("later");
        db.save_message(
            &conv.id,
            "system",
            "【上下文已压缩】测试卡片",
            "2026-01-01T00:00:02Z",
            None,
            None,
        )
        .expect("card");

        db.begin_turn_state(&conv.id, &anchor.id).expect("begin");
        db.set_message_turn_state(&anchor.id, TurnState::Cancelled)
            .expect("end");

        // ① 全量 + ② limit 分支 + ③ 卡片之后的切片 + ④ 翻页取更早
        let all = db.load_messages(&conv.id).expect("load");
        assert_eq!(all[0].turn_state.as_deref(), Some("cancelled"));
        assert!(all[1].turn_state.is_none(), "状态只写在锚点行上");
        let active = db.load_active_messages(&conv.id).expect("active");
        assert_eq!(
            active
                .messages
                .iter()
                .find(|m| m.id == anchor.id)
                .and_then(|m| m.turn_state.clone())
                .as_deref(),
            None,
            "锚点在压缩卡之前 → 该切片里本就不含锚点行"
        );
        let earlier = db
            .load_earlier_messages(&conv.id, &later.id)
            .expect("earlier");
        assert_eq!(
            earlier.first().and_then(|m| m.turn_state.as_deref()),
            Some("cancelled"),
            "翻页路径漏列会让这里变成 None"
        );

        // 未知字符串不冒充正常结束
        db.set_message_turn_state(&anchor.id, TurnState::Completed)
            .expect("set completed");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE messages SET turn_state = 'whatever' WHERE id = ?1",
                [&anchor.id],
            )
            .expect("inject unknown");
        }
        assert!(
            db.load_messages(&conv.id).expect("load")[0]
                .turn_state
                .is_none(),
            "不认识的收尾状态读回来必须是 None"
        );
        // 不存在的行：不写也不报错（锚点被回滚删除的情形）
        assert!(!db
            .set_message_turn_state("ghost-row", TurnState::Failed)
            .expect("ghost"));
    }

    /// 崩溃的持久证据：回合开始时行上写 `running`，收尾才被终态覆盖。
    /// 下一次在同一会话开新回合时，遗留的 `running` 收敛成 `interrupted`
    /// （崩溃没有机会自己来写），并且**只动本会话**。
    #[test]
    fn begin_turn_state_resolves_stale_running_within_the_conversation() {
        let db = create_test_db();
        let a = db.create_conversation("conn_1", "A").expect("conv a");
        let b = db.create_conversation("conn_1", "B").expect("conv b");
        let save = |conv: &str, text: &str| {
            db.save_message(conv, "user", text, "2026-01-01T00:00:00Z", None, None)
                .expect("msg")
                .id
        };
        let a1 = save(&a.id, "第一轮");
        let b1 = save(&b.id, "另一个会话");
        let state_of = |conv: &str, id: &str| {
            db.load_messages(conv)
                .expect("load")
                .into_iter()
                .find(|m| m.id == id)
                .and_then(|m| m.turn_state)
        };

        db.begin_turn_state(&a.id, &a1).expect("begin a1");
        db.begin_turn_state(&b.id, &b1).expect("begin b1");
        assert_eq!(state_of(&a.id, &a1).as_deref(), Some("running"));

        // A 会话里又开了一轮（上一轮的 running 是上次进程死掉留下的）
        let a2 = save(&a.id, "第二轮");
        db.begin_turn_state(&a.id, &a2).expect("begin a2");
        assert_eq!(
            state_of(&a.id, &a1).as_deref(),
            Some("interrupted"),
            "上一轮的 running 收敛成 interrupted"
        );
        assert_eq!(state_of(&a.id, &a2).as_deref(), Some("running"));
        assert_eq!(
            state_of(&b.id, &b1).as_deref(),
            Some("running"),
            "别的会话的在跑回合不受影响"
        );

        // 收尾覆盖掉 running
        db.set_message_turn_state(&a2, TurnState::Failed)
            .expect("end a2");
        assert_eq!(state_of(&a.id, &a2).as_deref(), Some("failed"));
    }

    /// 列清单不许再被**整份抄回** SQL 字面量里。
    ///
    /// `MESSAGES_COLUMNS` 的意义是「一份清单」：SELECT 列、INSERT 列与占位符、UPSERT
    /// 的 SET 子句都由它拼出来。有人把完整清单粘回某条语句，就等于又开了第二份 ——
    /// 它当下仍是对的，但下一次加列必然漏掉那一处，而且是静默的。
    ///
    /// 实现是**整份源码的裸子串检查**，不是逐行扫：本文件的 SQL 都是多行字面量
    /// （`SELECT` 的列清单与 `FROM messages` 不在同一行），逐行看会恰好漏掉它要拦的
    /// 那种写法 —— 上一版就是逐行的，探针实测全绿。要匹配的模式由 `MESSAGES_COLUMNS`
    /// **派生**（拼一份手写清单来对比，等于又在维护第二份）。
    ///
    /// **它拦不住什么**（别当万能）：手写的**子集**列清单不报 —— 那可能是合法的
    /// （本文件就有 `SELECT id, created_at, rowid FROM messages`），探针实测注入
    /// 前 6 列不会变红。「某条路径漏了列」由
    /// `every_optional_message_field_survives_all_read_paths` 守，不靠这条。
    #[test]
    fn no_literal_message_column_list_in_sql() {
        // 只看**生产代码**：测试里有一处 fixture 故意手建旧 schema 表、并插一条
        // 只有 7 列的旧版行（`test_...old_schema...`），那不是"抄清单"而是"造旧数据"，
        // 拿它当违规会把这条护栏变成误报机器。
        //
        // 切分点用 `#[cfg(test)]` + 紧跟的 `mod tests`（而不是光看 `#[cfg(test)]`）：
        // 后者在本文件出现 **3 次** —— 真属性、本函数的文档注释、以及下面这行 split
        // 自己。取首个匹配虽然碰巧是生产那个，但那是**巧合**（只要有人在文件更前面
        // 的注释里写到这个词，扫描就会被截断而静默失效）。
        // 换行归一化：`include_str!` 读的是**文件原始字节**，而 Windows 工作区
        // （`core.autocrlf=true`）检出的是 CRLF，下面这个用 LF 写的切分点就永远匹配
        // 不上 —— 后果不是"少切一段"，而是 production 变成整份文件、测试 fixture 里
        // 那行旧 schema INSERT 被当成违规，护栏固定报红（实测：LF 工作区通过、CRLF 失败）。
        let source = include_str!("conversation.rs").replace("\r\n", "\n");
        let production = source
            .split("
#[cfg(test)]
mod tests")
            .next()
            .expect("include_str 至少有一段");

        // 空白归一化后再比对：否则「把清单换行排版」就能绕过（实测放行过）。
        // 归一化不会误伤本文件的 const 定义 —— 那里每个列名带引号，归一化后是
        // `"id", "conversation_id"`，与不带引号的清单串不同。
        fn squeeze(text: &str) -> String {
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        }
        let haystack = squeeze(production);

        let literal_columns = MESSAGES_COLUMNS.join(", ");
        assert!(
            !haystack.contains(&squeeze(&literal_columns)),
            "源码里出现了 messages 列清单的字面量拷贝（应改用 messages_select_columns() \
             或 messages_insert_clause() 插值）：{literal_columns}"
        );

        let literal_placeholders = (1..=MESSAGES_COLUMNS.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        assert!(
            !haystack.contains(&squeeze(&format!("VALUES ({literal_placeholders})"))),
            "源码里出现了手写的占位符清单（应由 messages_insert_clause() 生成）"
        );

        // needle 在运行时拼出来：`include_str!` 会把**本测试自己**也扫进去，把字面量
        // 直接写在这条断言里，它就会命中自己。
        let insert_needle = format!("INSERT INTO messages ({}, conversation_id", MESSAGES_COLUMNS[0]);
        assert!(
            !haystack.contains(&squeeze(&insert_needle)),
            "源码里出现了手写的 INSERT 列清单（应由 messages_insert_clause() 生成）"
        );
    }

    // ───────────────────────── 历史回读（只读） ─────────────────────────

    /// 造一个"被压缩过一次"的会话，返回 (db, conversation_id, 归档原文 id 列表, 卡片 id, 活跃 id 列表)。
    ///
    /// 结构（行序）：u1 a1 t1 [卡片] u2 a2 —— 与 `load_active_messages` 的
    /// "卡片之前 = 归档、卡片及之后 = 当前上下文"完全对齐。
    fn seed_compacted_conversation(db: &ConversationDb) -> (String, Vec<String>, String, Vec<String>) {
        let conv = db.create_conversation("conn_1", "history").expect("conv");
        let mut archived = Vec::new();
        for (i, (role, content)) in [
            ("user", "部署前的原始需求：把 nginx 换成 caddy"),
            ("assistant", "明白，先做只读检查"),
            ("tool", "systemctl status nginx 的输出：inactive (dead)"),
        ]
        .iter()
        .enumerate()
        {
            let m = db
                .save_message(
                    &conv.id,
                    role,
                    content,
                    &format!("2026-01-01T00:0{i}:00Z"),
                    None,
                    None,
                )
                .expect("archived msg");
            archived.push(m.id);
        }

        // 走真实的压缩落库入口建卡。`card_created_at` 必须取**被压末行的
        // created_at**（persister 就是这么写的）：卡片靠它排在被压区间紧后面，
        // 行序乱了归档边界就跟着错。
        let rows = db.load_messages(&conv.id).expect("load before card");
        let tail = rows.last().expect("tail row");
        db.commit_compaction(
            &conv.id,
            &[],
            &format!(
                "{COMPACTION_CARD_PREFIX}已整理 3 条历史消息（约 120 tokens）\n\n原始需求是把 nginx 换成 caddy。"
            ),
            &tail.created_at.to_rfc3339(),
            &tail.timestamp,
        )
        .expect("commit card");
        let card_id = db
            .load_messages(&conv.id)
            .expect("load after card")
            .into_iter()
            .find(|m| m.content.starts_with(COMPACTION_CARD_PREFIX))
            .expect("card row")
            .id;

        let mut active = Vec::new();
        for (i, (role, content)) in [
            ("user", "现在看一下 caddy 的配置"),
            ("assistant", "配置如下……"),
        ]
        .iter()
        .enumerate()
        {
            let m = db
                .save_message(
                    &conv.id,
                    role,
                    content,
                    &format!("2026-01-01T00:1{i}:00Z"),
                    None,
                    None,
                )
                .expect("active msg");
            active.push(m.id);
        }

        (conv.id, archived, card_id, active)
    }

    /// 概览：总数 / 归档段（条数与时间范围）/ 当前上下文段 / 边界卡。
    #[test]
    fn history_overview_reports_archive_boundary() {
        let db = create_test_db();
        let (conv_id, archived, card_id, active) = seed_compacted_conversation(&db);

        let ov = db.history_overview(&conv_id, None).expect("overview");
        assert_eq!(ov.total, 6, "3 条归档 + 卡片 + 2 条当前上下文");
        assert_eq!(ov.archived, 3, "卡片之前的 3 条 = 归档");
        assert_eq!(ov.active, 3, "卡片及之后 = 当前上下文（卡片本身算上下文里有的）");
        assert_eq!(ov.oldest.as_ref().expect("oldest").id, archived[0]);
        assert_eq!(ov.newest.as_ref().expect("newest").id, active[1]);
        assert_eq!(
            ov.archived_newest.as_ref().expect("archived_newest").id,
            archived[2],
            "归档段最后一条 = 卡片紧邻的前一行（时间范围要用它）"
        );
        let card = ov.boundary_card.expect("boundary card");
        assert_eq!(card.id, card_id);
        assert!(card.content.starts_with(COMPACTION_CARD_PREFIX));
    }

    /// 没被压缩过的会话：归档段为 0，边界卡为 None —— 不报错、不编造。
    #[test]
    fn history_overview_without_compaction() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "plain").expect("conv");
        db.save_message(&conv.id, "user", "只有一条", "2026-01-01T00:00:00Z", None, None)
            .expect("msg");

        let ov = db.history_overview(&conv.id, None).expect("overview");
        assert_eq!(ov.total, 1);
        assert_eq!(ov.archived, 0);
        assert_eq!(ov.active, 1);
        assert!(ov.boundary_card.is_none());
        assert!(ov.archived_newest.is_none());

        // 空会话也不炸
        let empty = db.create_conversation("conn_1", "empty").expect("empty");
        let ov = db.history_overview(&empty.id, None).expect("overview empty");
        assert_eq!(ov.total, 0);
        assert!(ov.oldest.is_none() && ov.newest.is_none());
    }

    /// **验收：能检索到只出现在压缩前那一段的关键词**（该关键词在卡片与后续消息里都不存在）。
    #[test]
    fn search_history_finds_keyword_only_in_archive() {
        let db = create_test_db();
        let (conv_id, archived, _, _) = seed_compacted_conversation(&db);

        // 关键词只出现在归档原文（那条命令输出）里：卡片摘要与当前上下文都没有它
        let hits = db
            .search_history(&conv_id, "inactive (dead)", None, 20)
            .expect("search");
        assert_eq!(hits.len(), 1, "只有归档原文里出现过");
        assert_eq!(hits[0].id, archived[2]);
        assert!(hits[0].snippet.contains("inactive (dead)"));
        assert_eq!(hits[0].role, "tool");

        // 同一句话在归档原文与卡片摘要里各出现一次 ⇒ 两条命中，归档那条也在（不筛掉归档）
        let hits = db
            .search_history(&conv_id, "nginx 换成 caddy", None, 20)
            .expect("search card");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, archived[0], "先命中的是归档原文");
        assert_eq!(hits[1].role, "system", "后命中的是卡片摘要");

        // 空关键词：空列表（不是全量）
        assert!(db
            .search_history(&conv_id, "   ", None, 20)
            .expect("empty kw")
            .is_empty());

        // 搜不到的关键词：空列表 + 不报错
        assert!(db
            .search_history(&conv_id, "绝对不存在的词", None, 20)
            .expect("no hit")
            .is_empty());
    }

    /// **验收：检索能被窗口裁掉归档段**（子代理看到的父会话里搜不到归档内容）。
    #[test]
    fn search_history_respects_window() {
        let db = create_test_db();
        // 窗口下界改成"读时最新卡"之后，这里不再需要卡 id
        let (conv_id, _, _card_id, _) = seed_compacted_conversation(&db);
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: None,
        };

        let hits = db
            .search_history(&conv_id, "inactive (dead)", Some(&window), 20)
            .expect("search");
        assert!(hits.is_empty(), "归档段被窗口裁掉 ⇒ 搜不到");

        // 断言窗口不是把所有东西都裁掉了：搜上下文里的词仍然命中
        let hits = db
            .search_history(&conv_id, "caddy 的配置", Some(&window), 20)
            .expect("search 2");
        assert_eq!(hits.len(), 1);
    }

    /// **验收：压缩之后能拿回压缩前某条消息的完整原文**（逐字相等，不是摘要）。
    #[test]
    fn read_history_returns_verbatim_archived_original() {
        let db = create_test_db();
        let (conv_id, archived, _, _) = seed_compacted_conversation(&db);

        let read = db
            .read_history(&conv_id, None, &archived[2], 0, 0)
            .expect("read");
        assert_eq!(read.messages.len(), 1, "before/after 都为 0 ⇒ 只读这一条");
        assert_eq!(read.messages[0].id, archived[2]);
        assert_eq!(
            read.messages[0].content, "systemctl status nginx 的输出：inactive (dead)",
            "必须是当时真实内容，逐字相等"
        );
        // 标志位说的是"该侧窗口内还有没有更多行"（翻页用），不是"你请求的条数被截断了"：
        // 这条锚点前后都还有东西（前 2 条归档、后面是卡片与当前上下文）
        assert!(read.has_more_before && read.has_more_after);
    }

    /// 带上下文：前若干条 + 锚点 + 后若干条，按时间升序；还有更多时给标志位。
    #[test]
    fn read_history_around_anchor_reports_more_flags() {
        let db = create_test_db();
        let (conv_id, archived, _, active) = seed_compacted_conversation(&db);

        // 以归档第 2 条为锚点，前后各 1 条
        let read = db
            .read_history(&conv_id, None, &archived[1], 1, 1)
            .expect("read around");
        let ids: Vec<&str> = read.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(ids, vec![archived[0].as_str(), archived[1].as_str(), archived[2].as_str()]);
        assert!(!read.has_more_before, "已经到会话最早一条");
        assert!(read.has_more_after, "后面还有（含卡片与当前上下文）");

        // 往前取到会话开头之外：请求 10 条只给得到 1 条，且 has_more_before=false
        let read = db
            .read_history(&conv_id, None, &archived[1], 10, 0)
            .expect("read before all");
        assert_eq!(read.messages.len(), 2);
        assert!(!read.has_more_before);

        // 最新一条之后没有任何东西
        let read = db
            .read_history(&conv_id, None, &active[1], 0, 5)
            .expect("read after tail");
        assert_eq!(read.messages.len(), 1);
        assert!(!read.has_more_after);
    }

    /// **验收：子代理窗口取不到归档原文，也取不到窗口外的任何行**；
    /// 窗口本身包含边界卡（主 agent 上下文里有的东西，子代理应该看得到摘要）。
    #[test]
    fn read_history_window_excludes_archive_and_includes_card() {
        let db = create_test_db();
        let (conv_id, archived, card_id, active) = seed_compacted_conversation(&db);

        // 上界冻结在"派发那一刻"（这里取所有行，便于单独验证下界效果）
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: None,
        };

        // 归档原文：明确报错"不在可读范围"，而不是返回空
        let err = db
            .read_history(&conv_id, Some(&window), &archived[0], 0, 0)
            .expect_err("归档行必须被窗口挡住");
        assert!(matches!(err, HistoryError::OutOfWindow(_)), "{err:?}");

        // 边界卡本身可读（它代表主 agent 当前上下文里的历史摘要）
        let read = db
            .read_history(&conv_id, Some(&window), &card_id, 0, 0)
            .expect("card readable");
        assert_eq!(read.messages.len(), 1);
        assert!(read.messages[0].content.starts_with(COMPACTION_CARD_PREFIX));

        // 活跃段可读
        let read = db
            .read_history(&conv_id, Some(&window), &active[0], 0, 1)
            .expect("active readable");
        assert_eq!(read.messages.len(), 2);

        // 窗口里检索同样取不到归档
        let hits = db
            .search_history(&conv_id, "systemctl", Some(&window), 20)
            .expect("search window");
        assert!(hits.is_empty());
    }

    /// 窗口上界：冻结在派发那一刻 ⇒ 之后新增的消息读不到（需求 8 的"派发那一刻之前"）。
    #[test]
    fn read_history_window_stops_at_upto_anchor() {
        let db = create_test_db();
        let (conv_id, _, _card_id, active) = seed_compacted_conversation(&db);
        // 派发瞬间最后一条落库消息 = active[0]
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(active[0].clone()),
        };

        let read = db
            .read_history(&conv_id, Some(&window), &active[0], 0, 5)
            .expect("read bounded");
        assert_eq!(read.messages.len(), 1, "上界之后的消息不可见");
        assert!(!read.has_more_after);

        let err = db
            .read_history(&conv_id, Some(&window), &active[1], 0, 0)
            .expect_err("上界之后的消息应报错");
        assert!(matches!(err, HistoryError::OutOfWindow(_)), "{err:?}");
    }

    /// 造一个"窗口为空"的场景，返回 (会话 id, 派发锚 = 冻结上界, 之后压出来的卡 id)。
    ///
    /// 路径：落若干行 → 冻结"派发那一刻"= 当时最后一条 → 父会话**在派发之后**压缩。
    /// 手动压缩（`tail_db_id = None`）取**队尾行**当卡片时间 ⇒ 卡片排到队尾紧后面，
    /// 也就排到冻结上界之后 ⇒ 窗口 `[最新卡, 派发锚]` 成为空区间。
    fn seed_empty_window_conversation(db: &ConversationDb) -> (String, String, String) {
        let conv = db.create_conversation("conn_1", "empty-window").expect("conv");
        for (i, (role, content)) in [
            ("user", "把 nginx 换成 caddy"),
            ("assistant", "先做只读检查"),
            ("tool", "inactive (dead)"),
        ]
        .iter()
        .enumerate()
        {
            db.save_message(
                &conv.id,
                role,
                content,
                &format!("2026-01-01T00:0{i}:00Z"),
                None,
                None,
            )
            .expect("msg");
        }
        let dispatch_anchor = db
            .load_messages(&conv.id)
            .expect("load")
            .last()
            .expect("tail")
            .id
            .clone();

        let rows = db.load_messages(&conv.id).expect("load");
        let tail = rows.last().expect("tail row");
        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】派发之后又压了一次",
            &tail.created_at.to_rfc3339(),
            &tail.timestamp,
        )
        .expect("commit");
        let card_id = db
            .load_messages(&conv.id)
            .expect("load")
            .into_iter()
            .find(|m| m.content.starts_with(COMPACTION_CARD_PREFIX))
            .expect("card")
            .id;

        (conv.id, dispatch_anchor, card_id)
    }

    /// **空窗口是真实可达的**（不是理论构造）：父会话在派发之后压缩，卡片就排到
    /// 冻结上界之后，`[最新卡, 派发锚]` 成为空区间。这条同时是后两个测试的 fixture。
    ///
    /// 控制组在同一处断言：同样的上界换成"不限下界"就不是空区间 —— 排除
    /// `is_empty()` 恒为真的可能。
    #[test]
    fn empty_window_arises_when_parent_compacts_after_dispatch() {
        let db = create_test_db();
        let (conv_id, dispatch_anchor, card_id) = seed_empty_window_conversation(&db);

        let empty = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(dispatch_anchor.clone()),
        };
        let control = HistoryWindow {
            start: WindowStart::Earliest,
            upto_message_id: Some(dispatch_anchor),
        };
        {
            let conn = db.conn.lock().unwrap();
            let win = ConversationDb::resolve_history_window(&conn, &conv_id, Some(&empty))
                .expect("resolve");
            assert!(win.is_empty(), "派发之后压缩 ⇒ 窗口应为空区间");
            assert!(
                win.from.is_some() && win.upto.is_some(),
                "两端都应有位置（空是因为上界排在下界之前）"
            );
            let ctrl = ConversationDb::resolve_history_window(&conn, &conv_id, Some(&control))
                .expect("resolve control");
            assert!(!ctrl.is_empty(), "同样的上界、不限下界时不是空区间");
        }

        // 成因：那张新卡实体上排在派发锚**之后**
        let rows = db.load_messages(&conv_id).expect("load");
        let pos = |id: &str| rows.iter().position(|m| m.id == id).expect("row");
        assert!(
            pos(&card_id) > pos(&rows[2].id),
            "新卡必须排在派发锚之后，否则窗口不会为空"
        );
    }

    /// **验收：空窗口必须明确报错** —— 不是"没有命中"，也不是"这条不在窗口内"。
    #[test]
    fn empty_window_reports_explicit_error() {
        let db = create_test_db();
        let (conv_id, dispatch_anchor, card_id) = seed_empty_window_conversation(&db);
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(dispatch_anchor),
        };

        // 检索：Err(EmptyWindow)，**不是** Ok(空) —— 后者会被渲染成"没有命中"，
        // agent 据此断定历史里没这段内容，而事实是整个范围都读不到。
        let err = db
            .search_history(&conv_id, "inactive", Some(&window), 20)
            .expect_err("空窗口不能静默返回空");
        assert!(matches!(err, HistoryError::EmptyWindow), "{err:?}");

        // 回读：拿卡当锚、拿旧消息当锚、不管前后取多少条，都是同一个事实
        for anchor in [card_id.as_str(), "2026-01-01T00:00:00Z 那条旧消息"] {
            for (before, after) in [(0usize, 0usize), (5, 5)] {
                let err = db
                    .read_history(&conv_id, Some(&window), anchor, before, after)
                    .expect_err("空窗口下回读必须报错");
                assert!(
                    matches!(err, HistoryError::EmptyWindow),
                    "({before},{after}) 应为 EmptyWindow，实得 {err:?}"
                );
            }
        }
        // 有意保留的副作用：空窗口 + 不存在的锚点 → EmptyWindow（更上位的事实）而不是 Missing
        let err = db
            .read_history(&conv_id, Some(&window), "根本不存在的 id", 0, 0)
            .expect_err("空窗口优先于锚点存在性");
        assert!(matches!(err, HistoryError::EmptyWindow), "{err:?}");

        // 回归：这个修复只对空窗口生效 —— 无窗口 / 非空窗口照旧能读
        assert!(db.search_history(&conv_id, "inactive", None, 20).is_ok());
        assert!(db.read_history(&conv_id, None, &card_id, 0, 0).is_ok());
    }

    /// **验收：带窗口的概览不再给出死 id** —— 概览里出现的每一个 id 都必须能用
    /// `read_history` 读到。这条钉住"窗口算好了却没传进概览"的缺陷：修复前概览报的是
    /// 整会话的 id，子代理拿去读必然 `OutOfWindow`。
    #[test]
    fn windowed_overview_only_reports_readable_ids() {
        let db = create_test_db();
        let (conv_id, archived, card_id, active) = seed_compacted_conversation(&db);
        // 派发瞬间的最后一条 = 会话最后一行
        let upto = active.last().expect("last active").clone();
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(upto),
        };

        let ov = db
            .history_overview(&conv_id, Some(&window))
            .expect("overview");
        assert_eq!(ov.total, 3, "窗口 = 卡片 + 2 条当前上下文");
        assert_eq!(ov.archived, 0, "归档段整个落在窗口外");
        assert_eq!(ov.active, ov.total);
        assert_eq!(
            ov.oldest.as_ref().expect("oldest").id,
            card_id,
            "窗口内最早一条就是边界卡本身"
        );
        assert_eq!(
            ov.hidden_before_window, 3,
            "3 条归档原文要报成「你看不到的那部分」"
        );

        // 最强的一条：概览给出的每一个 id 都读得到
        let mut ids: Vec<String> = vec![ov.oldest.as_ref().expect("oldest").id.clone()];
        if let Some(m) = &ov.newest {
            ids.push(m.id.clone());
        }
        if let Some(m) = &ov.archived_newest {
            ids.push(m.id.clone());
        }
        let card = ov.boundary_card.as_ref().expect("窗口内应报边界卡");
        ids.push(card.id.clone());
        for id in &ids {
            let read = db
                .read_history(&conv_id, Some(&window), id, 0, 0)
                .unwrap_or_else(|e| panic!("概览给出的 id={id} 读不到：{e:?}"));
            assert_eq!(&read.messages[0].id, id);
        }
        assert!(
            !ids.iter().any(|id| archived.contains(id)),
            "归档原文的 id 不该出现在概览里：{ids:?}"
        );

        // 对照：不带窗口时归档段照旧（证明上面的 0 是窗口造成的，不是 fixture 变了）
        let full = db.history_overview(&conv_id, None).expect("overview full");
        assert_eq!(full.archived, 3);
        assert_eq!(full.hidden_before_window, 0, "无窗口 ⇒ 没有被藏起来的");
    }

    /// 空窗口下的概览：范围内 0 条、边界卡也不报（它排在冻结上界之后，可能含
    /// 派发之后才发生的事）。让工具能说清"整个范围为空"，而不是给一串读不到的 id。
    #[test]
    fn overview_on_empty_window_reports_nothing_readable() {
        let db = create_test_db();
        let (conv_id, dispatch_anchor, _card_id) = seed_empty_window_conversation(&db);
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(dispatch_anchor),
        };

        let ov = db
            .history_overview(&conv_id, Some(&window))
            .expect("overview");
        assert_eq!(ov.total, 0);
        assert_eq!(ov.archived, 0);
        assert_eq!(ov.active, 0);
        assert!(ov.oldest.is_none() && ov.newest.is_none());
        assert!(
            ov.boundary_card.is_none(),
            "窗口外的卡不报：它可能是派发之后新压的"
        );
        assert!(ov.hidden_before_window > 0, "要说明还有东西在范围外");
    }

    /// **验收：锚点=窗口下界那张卡 + `before > 0` 时不泄漏归档原文**
    /// （此前只有 `before = 0` 的用例，`before` 这条路径没人守）。
    #[test]
    fn read_history_from_card_anchor_with_before_never_leaks_archive() {
        let db = create_test_db();
        let (conv_id, archived, card_id, _) = seed_compacted_conversation(&db);
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: None,
        };

        let read = db
            .read_history(&conv_id, Some(&window), &card_id, 5, 0)
            .expect("read");
        assert_eq!(read.messages.len(), 1, "窗口下界就是这张卡，前面没有可读的行");
        assert_eq!(read.messages[0].id, card_id);
        assert!(!read.has_more_before, "窗口内前面没有更多");
        for m in &read.messages {
            assert!(!archived.contains(&m.id), "归档原文不许出现：{}", m.id);
        }

        // 反向：拿归档里的行当锚 → 明确报错（不是静默少给几条）
        let err = db
            .read_history(&conv_id, Some(&window), &archived[0], 5, 5)
            .expect_err("归档锚点必须被窗口挡住");
        assert!(matches!(err, HistoryError::OutOfWindow(_)), "{err:?}");
    }

    /// **失败必须明确**：不存在的行、被吸收的旧卡，都返回 Err，绝不静默给空。
    #[test]
    fn read_history_errors_are_explicit() {
        let db = create_test_db();
        let (conv_id, _, _, _) = seed_compacted_conversation(&db);

        let err = db
            .read_history(&conv_id, None, "不存在的消息 id", 0, 0)
            .expect_err("不存在的行");
        assert!(matches!(err, HistoryError::Missing(_)), "{err:?}");

        // 窗口上界引用了不存在的行（例如父会话把那条消息撤回了）→ Missing，而不是"没有历史"
        let window = HistoryWindow {
            start: WindowStart::Earliest,
            upto_message_id: Some("已被撤回的消息 id".into()),
        };
        let err = db
            .search_history(&conv_id, "nginx", Some(&window), 20)
            .expect_err("上界行已不存在");
        assert!(matches!(err, HistoryError::Missing(_)), "{err:?}");

        // 别的会话的 id 在本会话里找不到 → 也是 Missing（调用方负责给出"不在可读范围"的文案）
        let other = db.create_conversation("conn_1", "other").expect("other");
        let foreign = db
            .save_message(&other.id, "user", "别人的消息", "2026-01-01T00:00:00Z", None, None)
            .expect("foreign");
        let err = db
            .read_history(&conv_id, None, &foreign.id, 0, 0)
            .expect_err("跨会话 id");
        assert!(matches!(err, HistoryError::Missing(_)), "{err:?}");
    }

    /// 派发上界锚点：最后一条已落库消息；空会话 → None。
    #[test]
    fn history_tail_anchor_points_at_last_row() {
        let db = create_test_db();
        let (conv_id, _, _, active) = seed_compacted_conversation(&db);
        assert_eq!(
            db.history_tail_anchor(&conv_id).expect("anchor"),
            Some(active[1].clone())
        );

        let empty = db.create_conversation("conn_1", "empty").expect("empty");
        assert!(db.history_tail_anchor(&empty.id).expect("anchor empty").is_none());
    }

    /// 状态门控的判据：只有会话里真的存在"读不到的东西"（压缩过、或派发过子对话）
    /// 才为真。它是 `read_history` 能否进工具清单的唯一依据（见
    /// `tools::STATE_GATED_TOOLS`）——为此要治的正是"没压缩过却常驻占位"那种会话。
    #[test]
    fn has_readable_history_needs_an_archive_or_a_child() {
        let db = create_test_db();

        // 全新会话：历史全在上下文里，没有任何读不到的东西
        let fresh = db.create_conversation("conn_1", "fresh").expect("fresh");
        assert!(!db.has_readable_history(&fresh.id).expect("fresh"));

        // 有消息、但没压缩过也没派发过子对话 —— 仍然为假
        db.save_message(
            &fresh.id,
            "user",
            "帮我看看 nginx",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("save");
        assert!(!db.has_readable_history(&fresh.id).expect("fresh with msgs"));

        // 派发过子对话 → 真（主 agent 要能核对子代理的过程）
        let sub = db
            .create_sub_conversation("conn_1", "查磁盘", &fresh.id)
            .expect("sub");
        assert!(db.has_readable_history(&fresh.id).expect("has child"));

        // 子对话被删掉后判据回落（文档里写明的已知回落：那时这工具本来也读不到东西）
        db.delete_conversation(&sub.id).expect("delete sub");
        assert!(!db.has_readable_history(&fresh.id).expect("child gone"));

        // 压缩过 → 真，且**持续**为真：归档卡只会被新卡吸收，不会消失
        let (compacted, _, _, _) = seed_compacted_conversation(&db);
        assert!(db.has_readable_history(&compacted).expect("compacted"));
        db.save_message(
            &compacted,
            "user",
            "继续",
            "2026-01-02T00:00:00Z",
            None,
            None,
        )
        .expect("save after compaction");
        assert!(db.has_readable_history(&compacted).expect("still compacted"));
    }

    /// 子对话清单（主 agent 核对前先看有哪些）。
    #[test]
    fn list_sub_conversations_reports_children_only() {
        let db = create_test_db();
        let parent = db.create_conversation("conn_1", "main").expect("parent");
        let other = db.create_conversation("conn_1", "also main").expect("other");
        let sub1 = db
            .create_sub_conversation("conn_1", "查一下磁盘", &parent.id)
            .expect("sub1");
        let sub2 = db
            .create_sub_conversation("conn_1", "查一下端口", &parent.id)
            .expect("sub2");
        db.save_message(&sub1.id, "user", "任务", "2026-01-01T00:00:00Z", None, None)
            .expect("msg");
        db.create_sub_conversation("conn_1", "别人的子对话", &other.id)
            .expect("foreign sub");

        let subs = db.list_sub_conversations(&parent.id).expect("list");
        assert_eq!(subs.len(), 2, "只看本会话派发的子对话");
        assert_eq!(subs[0].id, sub1.id);
        assert_eq!(subs[0].title, "查一下磁盘");
        assert_eq!(subs[0].message_count, 1);
        assert_eq!(subs[1].id, sub2.id);
        assert_eq!(subs[1].message_count, 0);
    }

    /// 写-读并发的 **smoke test**（不是竞态证明 —— 请看下面那段）。
    ///
    /// 它守的是：写线程反复"插入新卡 + 吸收旧卡"（与 persister 同序）时，回读路径
    /// 不 panic、不死锁、不因为 fixture 腐烂而静默变成空断言。断言的内容是每次回读的
    /// 结果自洽（原文逐条完整有序、结果里最多一张卡）。
    ///
    /// **"不会有半新半旧的拼接"这个保证不来自本测试**，而是结构性的：两个线程共用
    /// 同一个 `Arc<ConversationDb>`（同一把 Mutex + 同一个 Connection），且
    /// `history_overview` / `search_history` / `read_history` 各自都是"一次持锁 +
    /// 一个事务"把解析锚点与取行做完 —— 交错在结构上就不可能发生，所以这个测试
    /// **无法失败**（它最多因为死锁或 `tx.finish()` 漏掉而失败）。
    /// 现状最坏的地方不是它弱，而是它一度看起来像"竞态已被证明"。
    #[test]
    fn concurrent_compaction_smoke_no_deadlock_or_half_written_state() {
        use std::sync::Arc;

        let db = Arc::new(create_test_db());
        let (conv_id, archived, card_id, _) = seed_compacted_conversation(&db);
        let oldest = archived[0].clone();
        // 参与回读的原文（不含卡）内容快照：压缩不碰原文
        let expected: Vec<String> = db
            .load_messages(&conv_id)
            .expect("load")
            .into_iter()
            .filter(|m| !m.content.starts_with(COMPACTION_CARD_PREFIX))
            .map(|m| m.content)
            .collect();

        let writer_db = Arc::clone(&db);
        let writer_conv = conv_id.clone();
        let mut prev_card = card_id.clone();
        let writer = std::thread::spawn(move || {
            for i in 0..40 {
                let card_content = format!("{COMPACTION_CARD_PREFIX}第 {i} 次压缩");
                // 手动压缩语义：卡片取**队尾行**的 created_at / timestamp，于是它排在
                // 队尾紧后面。此前这里写死一个与行序无关的时间戳，卡片实际排到了会话
                // 最前面 ⇒ `archived` 恒为 0，那条断言等于白写（注释还宣称"与被压区间
                // 末行对齐"，是假的）。
                let rows = writer_db.load_messages(&writer_conv).expect("reload");
                let tail = rows.last().expect("tail row");
                writer_db
                    .commit_compaction(
                        &writer_conv,
                        std::slice::from_ref(&prev_card),
                        &card_content,
                        &tail.created_at.to_rfc3339(),
                        &tail.timestamp,
                    )
                    .expect("commit");
                prev_card = writer_db
                    .load_messages(&writer_conv)
                    .expect("reload")
                    .into_iter()
                    .find(|m| m.content == card_content)
                    .expect("new card")
                    .id;
            }
        });

        let reader_db = Arc::clone(&db);
        let reader_conv = conv_id.clone();
        let reader = std::thread::spawn(move || {
            for _ in 0..40 {
                let ov = reader_db.history_overview(&reader_conv, None).expect("overview");
                assert_eq!(
                    ov.archived + ov.active,
                    ov.total,
                    "归档段 + 活跃段必须等于总数（半新半旧的标志）"
                );
                assert!(
                    ov.archived > 0,
                    "卡片按手动压缩语义排在队尾 ⇒ 归档段非空；为 0 说明 fixture 的时间戳又写死了，\
                     这条 smoke test 会退化成空断言"
                );

                let read = reader_db
                    .read_history(&reader_conv, None, &oldest, 0, 100)
                    .expect("read");
                let cards = read
                    .messages
                    .iter()
                    .filter(|m| m.content.starts_with(COMPACTION_CARD_PREFIX))
                    .count();
                assert!(cards <= 1, "一次回读里不该出现两张卡（新旧拼接）：{cards}");
                let bodies: Vec<String> = read
                    .messages
                    .iter()
                    .filter(|m| !m.content.starts_with(COMPACTION_CARD_PREFIX))
                    .map(|m| m.content.clone())
                    .collect();
                assert_eq!(bodies, expected, "原文必须逐条完整且顺序不变，不允许缺行或错位");
                assert!(
                    !read.has_more_after,
                    "只有 6 行、窗口开到 100，不该说还有更多"
                );
            }
        });

        writer.join().expect("writer");
        reader.join().expect("reader");
    }
}
