//! 记忆库（`{config_dir}/memory.db`，SQLite）。
//!
//! 一把 `Mutex<Connection>` 承担全部读写；记忆是低频数据（一段对话写几条），
//! 不需要连接池。表：
//!
//! - `memories`            条目本体
//! - `memory_ops`          操作日志（改之前 / 改之后各一份完整快照）——撤销与整批撤销靠它
//! - `memory_rejections`   用户撤销过的条目（后台复盘据此不再记回来）
//! - `reflection_progress` 每个会话复盘到了哪条消息（每条消息只复盘一次）
//! - `reflection_notes`    对话里那一行「记住 N 条」
//! - `memory_snapshots`    每个会话冻结的注入内容（见 `inject.rs`）
//! - `scope_versions`      每个作用域的「用户改动序号」——冻结快照据此判断要不要重渲染
//! - `meta`                杂项（记忆库建立时间、首次复盘说明卡是否已出过）
//!
//! **所有写入都经 [`MemoryStore::apply`]**（或基于它的撤销 / 删作用域 / 分组改名），
//! 在一个事务里落条目 + 落操作日志 + （用户发起时）推进作用域序号。没有第二条写路径，
//! 所以「改了却没日志、撤销不了」「用户删了快照却没刷新」这两类问题从结构上不存在。

use std::collections::{BTreeSet, HashMap};
use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};

use super::model::{
    dedup_key, normalize_text, validate_scope, BatchContext, Kind, MemoryItem, MemoryOpRecord,
    MemoryPatch, NewMemory, OpKind, ReflectionNote, Scope, ScopeRef, Source, WriteOp,
};

/// 每个作用域保留的「用户撤销过」条数上限（只留最近的；复盘提示词带它们，不能无限长）。
const REJECTIONS_PER_SCOPE: usize = 30;

/// 写入失败的原因。`Display` 是给模型 / 用户看的中文。
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("{0}")]
    Invalid(String),
    #[error("找不到记忆 {0}（可能已被删除）")]
    NotFound(String),
    #[error(
        "记忆 {id} 刚被改过（你拿到的是第 {expected} 版，现在是第 {actual} 版），请重新读取后再改"
    )]
    Conflict {
        id: String,
        expected: i64,
        actual: i64,
    },
    #[error("同一作用域里已有一条相同标题的记忆 {}「{}」：{}。要修改它请用 update（id={}），不要再新增一条", .existing.id, .existing.title, .existing.content, .existing.id)]
    Duplicate { existing: Box<MemoryItem> },
    #[error("这一步已经撤销过了")]
    AlreadyReverted,
    #[error("这条记忆在之后又被改过，不能单独撤销这一步；请直接编辑它")]
    ChangedSince,
    #[error("记忆库读写失败：{0}")]
    Db(#[from] rusqlite::Error),
}

pub type StoreResult<T> = Result<T, StoreError>;

/// 冻结的注入快照。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub fingerprint: String,
    pub content: String,
    pub item_ids: Vec<String>,
    pub created_at: String,
    /// 最近一次被某个回合用到的时间。用来判断提示词前缀缓存还热不热：冷了就没有
    /// 「冻结」的理由了（见 `inject::snapshot_usable`）。
    pub touched_at: String,
}

/// 管理页的作用域概览：每个作用域有几条、其中几条是新的。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSummary {
    pub scope: Scope,
    pub key: String,
    pub count: usize,
    pub new_count: usize,
}

/// 复盘进度：本会话已复盘到哪条消息（含）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReflectionProgress {
    pub anchor_message_id: String,
    pub anchor_created_at: String,
}

/// 用户撤销过的一条（复盘提示词里的「别再记」清单）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rejection {
    pub scope: Scope,
    pub key: String,
    pub title: String,
    pub content: String,
}

pub struct MemoryStore {
    conn: Mutex<Connection>,
}

pub(crate) fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// 短 id：`m` + 6 位 base36。模型要在工具参数里抄它，越短越不容易抄错。
fn new_memory_id() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let mut id = String::with_capacity(7);
    id.push('m');
    for b in bytes.iter().take(6) {
        id.push(ALPHABET[(*b as usize) % ALPHABET.len()] as char);
    }
    id
}

const MEMORY_COLUMNS: &str = "id, scope, scope_key, kind, title, content, pinned, source, \
     source_conversation_id, source_message_id, created_at, updated_at, version, is_new";

fn row_to_item(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryItem> {
    let scope: String = row.get(1)?;
    let kind: String = row.get(3)?;
    let source: String = row.get(7)?;
    Ok(MemoryItem {
        id: row.get(0)?,
        scope: Scope::parse(&scope).unwrap_or(Scope::User),
        scope_key: row.get(2)?,
        kind: Kind::parse(&kind).unwrap_or(Kind::Fact),
        title: row.get(4)?,
        content: row.get(5)?,
        pinned: row.get::<_, i64>(6)? != 0,
        source: Source::parse(&source).unwrap_or(Source::User),
        source_conversation_id: row.get(8)?,
        source_message_id: row.get(9)?,
        created_at: row.get(10)?,
        updated_at: row.get(11)?,
        version: row.get(12)?,
        is_new: row.get::<_, i64>(13)? != 0,
    })
}

fn get_item(conn: &Connection, id: &str) -> rusqlite::Result<Option<MemoryItem>> {
    conn.query_row(
        &format!("SELECT {MEMORY_COLUMNS} FROM memories WHERE id = ?1"),
        [id],
        row_to_item,
    )
    .optional()
}

fn items_in_scope(conn: &Connection, scope: &ScopeRef) -> rusqlite::Result<Vec<MemoryItem>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {MEMORY_COLUMNS} FROM memories WHERE scope = ?1 AND scope_key = ?2"
    ))?;
    let rows = stmt.query_map(params![scope.scope.as_str(), scope.key], row_to_item)?;
    rows.collect()
}

fn insert_item(conn: &Connection, item: &MemoryItem) -> rusqlite::Result<()> {
    conn.execute(
        &format!("INSERT INTO memories ({MEMORY_COLUMNS}) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)"),
        params![
            item.id,
            item.scope.as_str(),
            item.scope_key,
            item.kind.as_str(),
            item.title,
            item.content,
            item.pinned as i64,
            item.source.as_str(),
            item.source_conversation_id,
            item.source_message_id,
            item.created_at,
            item.updated_at,
            item.version,
            item.is_new as i64,
        ],
    )?;
    Ok(())
}

fn write_item(conn: &Connection, item: &MemoryItem) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE memories SET scope=?2, scope_key=?3, kind=?4, title=?5, content=?6, pinned=?7, \
         source=?8, updated_at=?9, version=?10, is_new=?11 WHERE id=?1",
        params![
            item.id,
            item.scope.as_str(),
            item.scope_key,
            item.kind.as_str(),
            item.title,
            item.content,
            item.pinned as i64,
            item.source.as_str(),
            item.updated_at,
            item.version,
            item.is_new as i64,
        ],
    )?;
    Ok(())
}

fn find_duplicate(
    conn: &Connection,
    scope: &ScopeRef,
    title: &str,
    except_id: Option<&str>,
) -> rusqlite::Result<Option<MemoryItem>> {
    let key = dedup_key(title);
    Ok(items_in_scope(conn, scope)?
        .into_iter()
        .find(|m| Some(m.id.as_str()) != except_id && dedup_key(&m.title) == key))
}

fn log_op(
    conn: &Connection,
    ctx: &BatchContext,
    memory_id: &str,
    op: OpKind,
    before: Option<&MemoryItem>,
    after: Option<&MemoryItem>,
    now: &str,
) -> rusqlite::Result<MemoryOpRecord> {
    let before_json = before.map(|b| serde_json::to_string(b).unwrap_or_default());
    let after_json = after.map(|a| serde_json::to_string(a).unwrap_or_default());
    conn.execute(
        "INSERT INTO memory_ops (batch_id, memory_id, op, before_json, after_json, source, \
         conversation_id, created_at, reverted) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0)",
        params![
            ctx.batch_id,
            memory_id,
            op.as_str(),
            before_json,
            after_json,
            ctx.source.as_str(),
            ctx.conversation_id,
            now,
        ],
    )?;
    Ok(MemoryOpRecord {
        id: conn.last_insert_rowid(),
        batch_id: ctx.batch_id.clone(),
        memory_id: memory_id.to_string(),
        op,
        before: before.cloned(),
        after: after.cloned(),
        source: ctx.source,
        conversation_id: ctx.conversation_id.clone(),
        created_at: now.to_string(),
        reverted: false,
    })
}

fn row_to_op(row: &rusqlite::Row<'_>) -> rusqlite::Result<MemoryOpRecord> {
    let op: String = row.get(3)?;
    let before: Option<String> = row.get(4)?;
    let after: Option<String> = row.get(5)?;
    let source: String = row.get(6)?;
    Ok(MemoryOpRecord {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        memory_id: row.get(2)?,
        op: OpKind::parse(&op).unwrap_or(OpKind::Update),
        before: before.and_then(|s| serde_json::from_str(&s).ok()),
        after: after.and_then(|s| serde_json::from_str(&s).ok()),
        source: Source::parse(&source).unwrap_or(Source::User),
        conversation_id: row.get(7)?,
        created_at: row.get(8)?,
        reverted: row.get::<_, i64>(9)? != 0,
    })
}

const OP_COLUMNS: &str =
    "id, batch_id, memory_id, op, before_json, after_json, source, conversation_id, created_at, reverted";

fn bump_scope_versions(conn: &Connection, scopes: &BTreeSet<ScopeRef>) -> rusqlite::Result<()> {
    for s in scopes {
        conn.execute(
            "INSERT INTO scope_versions (scope, scope_key, version) VALUES (?1, ?2, 1) \
             ON CONFLICT(scope, scope_key) DO UPDATE SET version = version + 1",
            params![s.scope.as_str(), s.key],
        )?;
    }
    Ok(())
}

fn add_rejection(conn: &Connection, item: &MemoryItem, now: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO memory_rejections (scope, scope_key, title, content, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            item.scope.as_str(),
            item.scope_key,
            item.title,
            item.content,
            now
        ],
    )?;
    // 只留最近的若干条。
    conn.execute(
        "DELETE FROM memory_rejections WHERE scope = ?1 AND scope_key = ?2 AND id NOT IN \
         (SELECT id FROM memory_rejections WHERE scope = ?1 AND scope_key = ?2 \
          ORDER BY id DESC LIMIT ?3)",
        params![
            item.scope.as_str(),
            item.scope_key,
            REJECTIONS_PER_SCOPE as i64
        ],
    )?;
    Ok(())
}

/// 单个操作落库（事务内）。返回操作日志行，以及它碰到的作用域（改作用域时是两个）。
fn apply_one(
    tx: &Transaction<'_>,
    ctx: &BatchContext,
    op: &WriteOp,
    now: &str,
    touched: &mut BTreeSet<ScopeRef>,
) -> StoreResult<MemoryOpRecord> {
    // agent 与复盘写的条目在管理页标「新」；用户自己写的不标。
    let mark_new = !ctx.source.user_initiated();
    match op {
        WriteOp::Add { memory } => {
            let NewMemory {
                scope,
                scope_key,
                kind,
                title,
                content,
                pinned,
                source_conversation_id,
                source_message_id,
            } = memory;
            validate_scope(*scope, scope_key).map_err(StoreError::Invalid)?;
            let (title, content) = normalize_text(title, content).map_err(StoreError::Invalid)?;
            let scope_ref = ScopeRef {
                scope: *scope,
                key: scope_key.clone(),
            };
            if let Some(existing) = find_duplicate(tx, &scope_ref, &title, None)? {
                return Err(StoreError::Duplicate {
                    existing: Box::new(existing),
                });
            }
            let mut id = new_memory_id();
            while get_item(tx, &id)?.is_some() {
                id = new_memory_id();
            }
            let item = MemoryItem {
                id: id.clone(),
                scope: *scope,
                scope_key: scope_key.clone(),
                kind: *kind,
                title,
                content,
                pinned: *pinned,
                source: ctx.source,
                source_conversation_id: source_conversation_id
                    .clone()
                    .or_else(|| ctx.conversation_id.clone()),
                source_message_id: source_message_id.clone(),
                created_at: now.to_string(),
                updated_at: now.to_string(),
                version: 1,
                is_new: mark_new,
            };
            insert_item(tx, &item)?;
            touched.insert(scope_ref);
            Ok(log_op(tx, ctx, &id, OpKind::Add, None, Some(&item), now)?)
        }
        WriteOp::Update {
            id,
            expected_version,
            patch,
        } => {
            let before = get_item(tx, id)?.ok_or_else(|| StoreError::NotFound(id.clone()))?;
            if let Some(expected) = expected_version {
                if *expected != before.version {
                    return Err(StoreError::Conflict {
                        id: id.clone(),
                        expected: *expected,
                        actual: before.version,
                    });
                }
            }
            if patch.is_empty() {
                return Err(StoreError::Invalid(format!(
                    "对 {id} 的修改没有给出任何字段"
                )));
            }
            let mut after = apply_patch(&before, patch)?;
            if after.scope_ref() != before.scope_ref()
                || dedup_key(&after.title) != dedup_key(&before.title)
            {
                if let Some(existing) =
                    find_duplicate(tx, &after.scope_ref(), &after.title, Some(id))?
                {
                    return Err(StoreError::Duplicate {
                        existing: Box::new(existing),
                    });
                }
            }
            after.updated_at = now.to_string();
            after.version = before.version + 1;
            after.source = ctx.source;
            after.is_new = mark_new;
            write_item(tx, &after)?;
            touched.insert(before.scope_ref());
            touched.insert(after.scope_ref());
            Ok(log_op(
                tx,
                ctx,
                id,
                OpKind::Update,
                Some(&before),
                Some(&after),
                now,
            )?)
        }
        WriteOp::Delete {
            id,
            expected_version,
        } => {
            let before = get_item(tx, id)?.ok_or_else(|| StoreError::NotFound(id.clone()))?;
            if let Some(expected) = expected_version {
                if *expected != before.version {
                    return Err(StoreError::Conflict {
                        id: id.clone(),
                        expected: *expected,
                        actual: before.version,
                    });
                }
            }
            tx.execute("DELETE FROM memories WHERE id = ?1", [id])?;
            touched.insert(before.scope_ref());
            Ok(log_op(
                tx,
                ctx,
                id,
                OpKind::Delete,
                Some(&before),
                None,
                now,
            )?)
        }
    }
}

fn apply_patch(before: &MemoryItem, patch: &MemoryPatch) -> StoreResult<MemoryItem> {
    let mut after = before.clone();
    if let Some(scope) = &patch.scope {
        validate_scope(scope.scope, &scope.key).map_err(StoreError::Invalid)?;
        after.scope = scope.scope;
        after.scope_key = scope.key.clone();
    }
    if let Some(kind) = patch.kind {
        after.kind = kind;
    }
    if let Some(pinned) = patch.pinned {
        after.pinned = pinned;
    }
    let title = patch.title.as_deref().unwrap_or(&before.title);
    let content = patch.content.as_deref().unwrap_or(&before.content);
    let (title, content) = normalize_text(title, content).map_err(StoreError::Invalid)?;
    after.title = title;
    after.content = content;
    Ok(after)
}

impl MemoryStore {
    pub fn open(path: impl AsRef<Path>) -> StoreResult<Self> {
        if let Some(parent) = path.as_ref().parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(path.as_ref())?;
        if let Ok(mode) = conn.query_row("PRAGMA journal_mode = WAL", [], |r| r.get::<_, String>(0))
        {
            if mode.eq_ignore_ascii_case("wal") {
                let _ = conn.execute_batch("PRAGMA synchronous = NORMAL;");
            }
        }
        Self::init(conn)
    }

    pub fn in_memory() -> Self {
        Self::init(Connection::open_in_memory().expect("in-memory sqlite"))
            .expect("init in-memory memory store")
    }

    fn init(conn: Connection) -> StoreResult<Self> {
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS memories (
                id TEXT PRIMARY KEY,
                scope TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                kind TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                source TEXT NOT NULL,
                source_conversation_id TEXT,
                source_message_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                is_new INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_memories_scope ON memories(scope, scope_key);

            CREATE TABLE IF NOT EXISTS memory_ops (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id TEXT NOT NULL,
                memory_id TEXT NOT NULL,
                op TEXT NOT NULL,
                before_json TEXT,
                after_json TEXT,
                source TEXT NOT NULL,
                conversation_id TEXT,
                created_at TEXT NOT NULL,
                reverted INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_memory_ops_batch ON memory_ops(batch_id);
            CREATE INDEX IF NOT EXISTS idx_memory_ops_memory ON memory_ops(memory_id);

            CREATE TABLE IF NOT EXISTS memory_rejections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                -- 跨设备同步的稳定 id：自增 id 换台设备就不是同一行了。
                -- 带默认值是因为这个表有几处 INSERT 还不写它（见下面的迁移说明）。
                uid TEXT NOT NULL DEFAULT '',
                scope TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memory_rejections_scope
                ON memory_rejections(scope, scope_key);

            CREATE TABLE IF NOT EXISTS reflection_progress (
                conversation_id TEXT PRIMARY KEY,
                anchor_message_id TEXT NOT NULL,
                anchor_created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reflection_notes (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                anchor_message_id TEXT NOT NULL,
                batch_id TEXT,
                intro INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_reflection_notes_conv
                ON reflection_notes(conversation_id);

            CREATE TABLE IF NOT EXISTS memory_snapshots (
                conversation_id TEXT PRIMARY KEY,
                fingerprint TEXT NOT NULL,
                content TEXT NOT NULL,
                item_ids_json TEXT NOT NULL,
                created_at TEXT NOT NULL,
                touched_at TEXT
            );

            CREATE TABLE IF NOT EXISTS scope_versions (
                scope TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                version INTEGER NOT NULL,
                PRIMARY KEY (scope, scope_key)
            );

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )?;
        // 旧库的快照表没有 touched_at：补列（已有则忽略报错）。
        let _ = conn.execute(
            "ALTER TABLE memory_snapshots ADD COLUMN touched_at TEXT",
            [],
        );
        // `memory_rejections.uid`：跨设备同步的稳定主键（自增 id 跨设备没意义）。
        // 老库补列 + 回填；**新库也要回填一次**（建表语句里的默认值是空串）。
        let _ = conn.execute(
            "ALTER TABLE memory_rejections ADD COLUMN uid TEXT NOT NULL DEFAULT ''",
            [],
        );
        let _ = conn.execute(
            "UPDATE memory_rejections SET uid = lower(hex(randomblob(16)))              WHERE uid IS NULL OR uid = ''",
            [],
        );
        let _ = conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_rejections_uid              ON memory_rejections(uid) WHERE uid IS NOT NULL AND uid != ''",
            [],
        );
        // 行同步：建 changelog / 时钟表 + 连接级触发器。失败只记日志，记忆库照常可用
        // （同步坏了不该让长期记忆整个用不了）。
        if let Err(e) =
            crate::sync::rows::install(&conn, crate::sync::streams::memory::MEMORY_TABLES)
        {
            log::warn!("记忆库安装同步触发器失败（同步会缺失，功能照常）: {e}");
        }
        // 记忆库建立时间：这之前的消息不做后台复盘（功能上线前的旧会话不自动补，
        // 想补的话用整理助手）。只在第一次建库时写。
        conn.execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES ('store_created_at', ?1)",
            [now_rfc3339()],
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    // ───────────────────────── 读 ─────────────────────────

    pub fn get(&self, id: &str) -> StoreResult<Option<MemoryItem>> {
        Ok(get_item(&self.lock(), id)?)
    }

    /// 若干作用域里的全部条目：置顶在前，其余按更新时间新→旧。
    pub fn list_scopes(&self, scopes: &[ScopeRef]) -> StoreResult<Vec<MemoryItem>> {
        let conn = self.lock();
        let mut all = Vec::new();
        for s in scopes {
            all.extend(items_in_scope(&conn, s)?);
        }
        sort_items(&mut all);
        Ok(all)
    }

    /// 全部条目（管理页「全部」视图）。
    pub fn list_all(&self) -> StoreResult<Vec<MemoryItem>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(&format!("SELECT {MEMORY_COLUMNS} FROM memories"))?;
        let mut items: Vec<MemoryItem> = stmt
            .query_map([], row_to_item)?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        sort_items(&mut items);
        Ok(items)
    }

    /// 关键词检索：空白分词，按命中词数排序（命中越多越前），一个词都不中的不要。
    ///
    /// 记忆是几百条的量级，在 Rust 里逐条比对比建全文索引简单，也天然支持中文。
    pub fn search(
        &self,
        scopes: &[ScopeRef],
        query: &str,
        limit: usize,
    ) -> StoreResult<Vec<MemoryItem>> {
        let terms: Vec<String> = query
            .split_whitespace()
            .map(|t| t.to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        let items = self.list_scopes(scopes)?;
        if terms.is_empty() {
            return Ok(items.into_iter().take(limit).collect());
        }
        let mut scored: Vec<(usize, MemoryItem)> = items
            .into_iter()
            .filter_map(|m| {
                let hay = format!("{}\n{}", m.title, m.content).to_lowercase();
                let score = terms.iter().filter(|t| hay.contains(t.as_str())).count();
                (score > 0).then_some((score, m))
            })
            .collect();
        // 稳定排序：同分保持 list_scopes 的「置顶 + 新→旧」次序。
        scored.sort_by_key(|b| std::cmp::Reverse(b.0));
        Ok(scored.into_iter().take(limit).map(|(_, m)| m).collect())
    }

    pub fn scope_summaries(&self) -> StoreResult<Vec<ScopeSummary>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT scope, scope_key, COUNT(*), SUM(is_new) FROM memories \
             GROUP BY scope, scope_key",
        )?;
        let rows = stmt.query_map([], |row| {
            let scope: String = row.get(0)?;
            Ok(ScopeSummary {
                scope: Scope::parse(&scope).unwrap_or(Scope::User),
                key: row.get(1)?,
                count: row.get::<_, i64>(2)? as usize,
                new_count: row.get::<_, Option<i64>>(3)?.unwrap_or(0) as usize,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn count_scope(&self, scope: &ScopeRef) -> StoreResult<usize> {
        let conn = self.lock();
        let n: i64 = conn.query_row(
            "SELECT COUNT(*) FROM memories WHERE scope = ?1 AND scope_key = ?2",
            params![scope.scope.as_str(), scope.key],
            |r| r.get(0),
        )?;
        Ok(n as usize)
    }

    // ───────────────────────── 写 ─────────────────────────

    /// 一批写入，**全有或全无**：任何一个操作失败整批回滚，返回那一个的原因。
    ///
    /// 用户发起的（[`Source::user_initiated`]）会推进碰到的作用域的序号，让进行中
    /// 对话的冻结快照在下一轮重渲染。
    pub fn apply(&self, ctx: &BatchContext, ops: &[WriteOp]) -> StoreResult<Vec<MemoryOpRecord>> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let now = now_rfc3339();
        let mut touched = BTreeSet::new();
        let mut records = Vec::with_capacity(ops.len());
        for op in ops {
            records.push(apply_one(&tx, ctx, op, &now, &mut touched)?);
        }
        if ctx.source.user_initiated() {
            bump_scope_versions(&tx, &touched)?;
        }
        tx.commit()?;
        Ok(records)
    }

    /// 尽力写入：逐个操作各自成败（复盘用——一条不合格不该连坐其它条）。
    /// 返回成功的日志行与失败的原因。
    pub fn apply_lenient(
        &self,
        ctx: &BatchContext,
        ops: &[WriteOp],
    ) -> StoreResult<(Vec<MemoryOpRecord>, Vec<String>)> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let now = now_rfc3339();
        let mut touched = BTreeSet::new();
        let mut records = Vec::new();
        let mut failures = Vec::new();
        for op in ops {
            tx.execute_batch("SAVEPOINT one_op")?;
            match apply_one(&tx, ctx, op, &now, &mut touched) {
                Ok(r) => {
                    tx.execute_batch("RELEASE one_op")?;
                    records.push(r);
                }
                Err(StoreError::Db(e)) => return Err(StoreError::Db(e)),
                Err(e) => {
                    tx.execute_batch("ROLLBACK TO one_op; RELEASE one_op")?;
                    failures.push(e.to_string());
                }
            }
        }
        if ctx.source.user_initiated() {
            bump_scope_versions(&tx, &touched)?;
        }
        tx.commit()?;
        Ok((records, failures))
    }

    pub fn op(&self, op_id: i64) -> StoreResult<Option<MemoryOpRecord>> {
        let conn = self.lock();
        Ok(conn
            .query_row(
                &format!("SELECT {OP_COLUMNS} FROM memory_ops WHERE id = ?1"),
                [op_id],
                row_to_op,
            )
            .optional()?)
    }

    pub fn ops_for_batch(&self, batch_id: &str) -> StoreResult<Vec<MemoryOpRecord>> {
        let conn = self.lock();
        ops_for_batch(&conn, batch_id)
    }

    /// 撤销一步（用户点「撤销」）：把那一步改动反过来做一遍，记为一次用户改动。
    ///
    /// 只在这条记忆**之后没再被改过**时允许单独撤销 —— 否则「撤销这一步」会把后面
    /// 的改动一起抹掉，那不是用户点的东西。被撤销的若是 agent / 复盘 / 整理助手写的
    /// 新增或修改，记进「别再记」清单。
    pub fn revert_op(&self, op_id: i64) -> StoreResult<MemoryOpRecord> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let rec = revert_one(&tx, op_id)?;
        tx.commit()?;
        Ok(rec)
    }

    /// 整批撤销（整理助手的「撤销这次」、复盘那一行的「全部撤销」）：倒序逐步撤销，
    /// 全有或全无。已经单独撤销过的步骤跳过。
    pub fn revert_batch(&self, batch_id: &str) -> StoreResult<Vec<MemoryOpRecord>> {
        let mut conn = self.lock();
        let tx = conn.transaction()?;
        let mut ops = ops_for_batch(&tx, batch_id)?;
        ops.reverse();
        let mut out = Vec::new();
        for op in ops.into_iter().filter(|o| !o.reverted) {
            out.push(revert_one(&tx, op.id)?);
        }
        tx.commit()?;
        Ok(out)
    }

    /// 清掉「新」标记（用户在管理页看过了）。
    pub fn mark_seen(&self, ids: &[String]) -> StoreResult<()> {
        let conn = self.lock();
        for id in ids {
            conn.execute("UPDATE memories SET is_new = 0 WHERE id = ?1", [id])?;
        }
        Ok(())
    }

    /// 删除一整个作用域（删连接时「同时删除这台机器的记忆」）。记为一批用户改动，可撤销。
    pub fn delete_scope(&self, scope: &ScopeRef) -> StoreResult<(String, usize)> {
        let ids: Vec<WriteOp> = self
            .list_scopes(std::slice::from_ref(scope))?
            .into_iter()
            .map(|m| WriteOp::Delete {
                id: m.id,
                expected_version: None,
            })
            .collect();
        let ctx = BatchContext::new(Source::User, None);
        let n = ids.len();
        if n > 0 {
            self.apply(&ctx, &ids)?;
        }
        Ok((ctx.batch_id, n))
    }

    /// 分组改名：把旧组的记忆整体挪到新组（记为一批用户改动）。
    ///
    /// 新组里已有同名条目时，这一条**保持不动**（留在旧组名下，管理页会把它列在
    /// 「已不存在的分组」里）——静默合并会丢掉其中一条的内容。
    pub fn rename_group(&self, from: &str, to: &str) -> StoreResult<usize> {
        if from == to || from.trim().is_empty() || to.trim().is_empty() {
            return Ok(0);
        }
        let items = self.list_scopes(&[ScopeRef::group(from)])?;
        if items.is_empty() {
            return Ok(0);
        }
        let ctx = BatchContext::new(Source::User, None);
        let ops: Vec<WriteOp> = items
            .into_iter()
            .map(|m| WriteOp::Update {
                id: m.id,
                expected_version: None,
                patch: MemoryPatch {
                    scope: Some(ScopeRef::group(to)),
                    ..Default::default()
                },
            })
            .collect();
        let (records, failures) = self.apply_lenient(&ctx, &ops)?;
        if !failures.is_empty() {
            log::warn!(
                "分组改名 {from} → {to}：{} 条因新组已有同名记忆而保留在原组名下",
                failures.len()
            );
        }
        Ok(records.len())
    }

    // ───────────────────────── 作用域序号 / 快照 ─────────────────────────

    /// 若干作用域的「用户改动序号」拼成的指纹。作用域集合变了（换了分组）指纹也变。
    pub fn fingerprint(&self, scopes: &[ScopeRef]) -> StoreResult<String> {
        let conn = self.lock();
        let mut parts = Vec::with_capacity(scopes.len());
        for s in scopes {
            let v: i64 = conn
                .query_row(
                    "SELECT version FROM scope_versions WHERE scope = ?1 AND scope_key = ?2",
                    params![s.scope.as_str(), s.key],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or(0);
            parts.push(format!("{}:{}:{}", s.scope.as_str(), s.key, v));
        }
        Ok(parts.join("|"))
    }

    pub fn snapshot(&self, conversation_id: &str) -> StoreResult<Option<Snapshot>> {
        let conn = self.lock();
        Ok(conn
            .query_row(
                "SELECT fingerprint, content, item_ids_json, created_at, \
                 COALESCE(touched_at, created_at) FROM memory_snapshots \
                 WHERE conversation_id = ?1",
                [conversation_id],
                |row| {
                    let ids: String = row.get(2)?;
                    Ok(Snapshot {
                        fingerprint: row.get(0)?,
                        content: row.get(1)?,
                        item_ids: serde_json::from_str(&ids).unwrap_or_default(),
                        created_at: row.get(3)?,
                        touched_at: row.get(4)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn put_snapshot(&self, conversation_id: &str, snap: &Snapshot) -> StoreResult<()> {
        let conn = self.lock();
        conn.execute(
            "INSERT INTO memory_snapshots \
             (conversation_id, fingerprint, content, item_ids_json, created_at, touched_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6) ON CONFLICT(conversation_id) DO UPDATE SET \
             fingerprint = excluded.fingerprint, content = excluded.content, \
             item_ids_json = excluded.item_ids_json, created_at = excluded.created_at, \
             touched_at = excluded.touched_at",
            params![
                conversation_id,
                snap.fingerprint,
                snap.content,
                serde_json::to_string(&snap.item_ids).unwrap_or_else(|_| "[]".into()),
                snap.created_at,
                snap.touched_at,
            ],
        )?;
        Ok(())
    }

    /// 这个会话的快照又被一个回合用了一次：刷新「最近使用」时间。
    pub fn touch_snapshot(&self, conversation_id: &str) -> StoreResult<()> {
        self.lock().execute(
            "UPDATE memory_snapshots SET touched_at = ?2 WHERE conversation_id = ?1",
            params![conversation_id, now_rfc3339()],
        )?;
        Ok(())
    }

    pub fn drop_snapshot(&self, conversation_id: &str) -> StoreResult<()> {
        self.lock().execute(
            "DELETE FROM memory_snapshots WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        Ok(())
    }

    // ───────────────────────── 复盘 ─────────────────────────

    pub fn progress(&self, conversation_id: &str) -> StoreResult<Option<ReflectionProgress>> {
        let conn = self.lock();
        Ok(conn
            .query_row(
                "SELECT anchor_message_id, anchor_created_at FROM reflection_progress \
                 WHERE conversation_id = ?1",
                [conversation_id],
                |row| {
                    Ok(ReflectionProgress {
                        anchor_message_id: row.get(0)?,
                        anchor_created_at: row.get(1)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn set_progress(&self, conversation_id: &str, p: &ReflectionProgress) -> StoreResult<()> {
        self.lock().execute(
            "INSERT INTO reflection_progress (conversation_id, anchor_message_id, anchor_created_at, updated_at) \
             VALUES (?1, ?2, ?3, ?4) ON CONFLICT(conversation_id) DO UPDATE SET \
             anchor_message_id = excluded.anchor_message_id, \
             anchor_created_at = excluded.anchor_created_at, updated_at = excluded.updated_at",
            params![conversation_id, p.anchor_message_id, p.anchor_created_at, now_rfc3339()],
        )?;
        Ok(())
    }

    pub fn add_note(
        &self,
        conversation_id: &str,
        anchor_message_id: &str,
        batch_id: Option<&str>,
        intro: bool,
    ) -> StoreResult<ReflectionNote> {
        let conn = self.lock();
        let id = format!("rn_{}", uuid::Uuid::new_v4().simple());
        let now = now_rfc3339();
        conn.execute(
            "INSERT INTO reflection_notes (id, conversation_id, anchor_message_id, batch_id, intro, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![id, conversation_id, anchor_message_id, batch_id, intro as i64, now],
        )?;
        let ops = match batch_id {
            Some(b) => ops_for_batch(&conn, b)?,
            None => Vec::new(),
        };
        Ok(ReflectionNote {
            id,
            conversation_id: conversation_id.to_string(),
            anchor_message_id: anchor_message_id.to_string(),
            batch_id: batch_id.map(String::from),
            intro,
            created_at: now,
            ops,
        })
    }

    pub fn notes_for_conversation(
        &self,
        conversation_id: &str,
    ) -> StoreResult<Vec<ReflectionNote>> {
        let conn = self.lock();
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, anchor_message_id, batch_id, intro, created_at \
             FROM reflection_notes WHERE conversation_id = ?1 ORDER BY created_at",
        )?;
        let mut notes: Vec<ReflectionNote> = stmt
            .query_map([conversation_id], |row| {
                Ok(ReflectionNote {
                    id: row.get(0)?,
                    conversation_id: row.get(1)?,
                    anchor_message_id: row.get(2)?,
                    batch_id: row.get(3)?,
                    intro: row.get::<_, i64>(4)? != 0,
                    created_at: row.get(5)?,
                    ops: Vec::new(),
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        for note in &mut notes {
            if let Some(b) = &note.batch_id {
                note.ops = ops_for_batch(&conn, b)?;
            }
        }
        Ok(notes)
    }

    pub fn rejections(&self, scopes: &[ScopeRef]) -> StoreResult<Vec<Rejection>> {
        let conn = self.lock();
        let mut out = Vec::new();
        for s in scopes {
            let mut stmt = conn.prepare(
                "SELECT title, content FROM memory_rejections WHERE scope = ?1 AND scope_key = ?2 \
                 ORDER BY id DESC",
            )?;
            let rows = stmt.query_map(params![s.scope.as_str(), s.key], |row| {
                Ok(Rejection {
                    scope: s.scope,
                    key: s.key.clone(),
                    title: row.get(0)?,
                    content: row.get(1)?,
                })
            })?;
            for r in rows {
                out.push(r?);
            }
        }
        Ok(out)
    }

    // ───────────────────────── 杂项 ─────────────────────────

    pub fn meta(&self, key: &str) -> StoreResult<Option<String>> {
        Ok(self
            .lock()
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn set_meta(&self, key: &str, value: &str) -> StoreResult<()> {
        self.lock().execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) \
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// 原子地「第一次就置位」：返回 true = 这次是第一次（调用方该出说明卡）。
    pub fn claim_once(&self, key: &str) -> StoreResult<bool> {
        let n = self.lock().execute(
            "INSERT OR IGNORE INTO meta (key, value) VALUES (?1, ?2)",
            params![key, now_rfc3339()],
        )?;
        Ok(n > 0)
    }

    /// 会话被分叉：把「只属于会话」的记忆附属数据带到分叉上（与 `forget_conversation`
    /// 管同一批表，加新的会话附属表时两处一起看）。
    ///
    /// - **注入快照**照搬：分叉与来源的系统提示词保持一致，行为不因分叉而漂移，
    ///   请求前缀也不变（来源的缓存对分叉的第一轮仍然有效）。
    /// - **复盘进度**接在复制过来的历史之后：这些消息来源里已经复盘过（或将由来源复盘），
    ///   分叉再复盘一遍只会重复产出同样的记忆。来源进度锚点落在被复制的范围内就映射到
    ///   分叉里对应的消息；落在范围外（来源复盘得更靠后）就直接记到最后一条被复制的消息。
    ///   来源从没复盘过则不记，分叉也一样从头开始。
    /// - 复盘提示行（`reflection_notes`）不带：它们是挂在来源某条消息下的 UI 记号，不是数据。
    pub fn fork_conversation(
        &self,
        source_id: &str,
        fork_id: &str,
        id_map: &std::collections::HashMap<String, String>,
        last_message: (&str, &str),
    ) -> StoreResult<()> {
        if let Some(snap) = self.snapshot(source_id)? {
            self.put_snapshot(fork_id, &snap)?;
        }
        if let Some(p) = self.progress(source_id)? {
            let carried = match id_map.get(&p.anchor_message_id) {
                Some(new_id) => ReflectionProgress {
                    anchor_message_id: new_id.clone(),
                    anchor_created_at: p.anchor_created_at,
                },
                None => ReflectionProgress {
                    anchor_message_id: last_message.0.to_string(),
                    anchor_created_at: last_message.1.to_string(),
                },
            };
            self.set_progress(fork_id, &carried)?;
        }
        Ok(())
    }

    /// 会话被删：清掉只属于它的快照、复盘进度、提示行。
    ///
    /// 记忆本身**不删**——记忆比会话活得久正是它的意义；来源链接失效由前端显示
    /// 「来源会话已删除」。
    pub fn forget_conversation(&self, conversation_id: &str) -> StoreResult<()> {
        let conn = self.lock();
        conn.execute(
            "DELETE FROM memory_snapshots WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        conn.execute(
            "DELETE FROM reflection_progress WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        conn.execute(
            "DELETE FROM reflection_notes WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        Ok(())
    }
}

fn sort_items(items: &mut [MemoryItem]) {
    items.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
}

fn ops_for_batch(conn: &Connection, batch_id: &str) -> StoreResult<Vec<MemoryOpRecord>> {
    let mut stmt = conn.prepare(&format!(
        "SELECT {OP_COLUMNS} FROM memory_ops WHERE batch_id = ?1 ORDER BY id"
    ))?;
    let rows = stmt.query_map([batch_id], row_to_op)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn revert_one(tx: &Transaction<'_>, op_id: i64) -> StoreResult<MemoryOpRecord> {
    let rec = tx
        .query_row(
            &format!("SELECT {OP_COLUMNS} FROM memory_ops WHERE id = ?1"),
            [op_id],
            row_to_op,
        )
        .optional()?
        .ok_or_else(|| StoreError::NotFound(format!("操作 #{op_id}")))?;
    if rec.reverted {
        return Err(StoreError::AlreadyReverted);
    }
    let current = get_item(tx, &rec.memory_id)?;
    // 「之后没再被改过」：现状必须正好是这一步的结果。
    let unchanged = match (&rec.after, &current) {
        (None, None) => true,
        (Some(after), Some(cur)) => after.version == cur.version,
        _ => false,
    };
    if !unchanged {
        return Err(StoreError::ChangedSince);
    }
    let now = now_rfc3339();
    let ctx = BatchContext::new(Source::User, rec.conversation_id.clone());
    let mut touched = BTreeSet::new();
    let inverse =
        match rec.op {
            OpKind::Add => {
                let cur = current.expect("checked above");
                tx.execute("DELETE FROM memories WHERE id = ?1", [&cur.id])?;
                touched.insert(cur.scope_ref());
                log_op(tx, &ctx, &cur.id, OpKind::Delete, Some(&cur), None, &now)?
            }
            OpKind::Update => {
                let cur = current.expect("checked above");
                let mut restored = rec.before.clone().ok_or_else(|| {
                    StoreError::Invalid("操作日志缺少修改前的内容，无法撤销".into())
                })?;
                restored.version = cur.version + 1;
                restored.updated_at = now.clone();
                restored.source = Source::User;
                restored.is_new = false;
                write_item(tx, &restored)?;
                touched.insert(cur.scope_ref());
                touched.insert(restored.scope_ref());
                log_op(
                    tx,
                    &ctx,
                    &cur.id,
                    OpKind::Update,
                    Some(&cur),
                    Some(&restored),
                    &now,
                )?
            }
            OpKind::Delete => {
                let mut restored = rec.before.clone().ok_or_else(|| {
                    StoreError::Invalid("操作日志缺少删除前的内容，无法恢复".into())
                })?;
                if get_item(tx, &restored.id)?.is_some() {
                    return Err(StoreError::ChangedSince);
                }
                restored.version += 1;
                restored.updated_at = now.clone();
                restored.is_new = false;
                insert_item(tx, &restored)?;
                touched.insert(restored.scope_ref());
                log_op(
                    tx,
                    &ctx,
                    &restored.id,
                    OpKind::Add,
                    None,
                    Some(&restored),
                    &now,
                )?
            }
        };
    tx.execute("UPDATE memory_ops SET reverted = 1 WHERE id = ?1", [op_id])?;
    if rec.source != Source::User && matches!(rec.op, OpKind::Add | OpKind::Update) {
        if let Some(after) = &rec.after {
            add_rejection(tx, after, &now)?;
        }
    }
    bump_scope_versions(tx, &touched)?;
    Ok(inverse)
}

/// 按作用域把条目分组（注入渲染用）。
pub fn group_by_scope(items: Vec<MemoryItem>) -> HashMap<ScopeRef, Vec<MemoryItem>> {
    let mut map: HashMap<ScopeRef, Vec<MemoryItem>> = HashMap::new();
    for m in items {
        map.entry(m.scope_ref()).or_default().push(m);
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add_op(scope: ScopeRef, title: &str, content: &str) -> WriteOp {
        WriteOp::Add {
            memory: NewMemory {
                scope: scope.scope,
                scope_key: scope.key,
                kind: Kind::Fact,
                title: title.into(),
                content: content.into(),
                pinned: false,
                source_conversation_id: None,
                source_message_id: None,
            },
        }
    }

    fn agent_ctx() -> BatchContext {
        BatchContext::new(Source::Agent, Some("c1".into()))
    }

    #[test]
    fn add_list_and_search() {
        let s = MemoryStore::in_memory();
        let host = ScopeRef::host("conn1");
        s.apply(
            &agent_ctx(),
            &[add_op(host.clone(), "nginx 配置位置", "在 /opt/nginx/conf")],
        )
        .unwrap();
        s.apply(
            &agent_ctx(),
            &[add_op(ScopeRef::user(), "回复语言", "用中文")],
        )
        .unwrap();
        let items = s.list_scopes(&[ScopeRef::user(), host.clone()]).unwrap();
        assert_eq!(items.len(), 2);
        assert!(items.iter().all(|m| m.is_new), "agent 写的标「新」");

        let hits = s
            .search(&[ScopeRef::user(), host.clone()], "NGINX conf", 10)
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].title, "nginx 配置位置");
        assert!(s.search(&[host], "postgres", 10).unwrap().is_empty());
    }

    #[test]
    fn duplicate_title_in_same_scope_is_rejected_with_existing_item() {
        let s = MemoryStore::in_memory();
        let host = ScopeRef::host("conn1");
        s.apply(&agent_ctx(), &[add_op(host.clone(), "Nginx 配置", "a")])
            .unwrap();
        let err = s
            .apply(&agent_ctx(), &[add_op(host.clone(), "nginx配置", "b")])
            .unwrap_err();
        assert!(matches!(err, StoreError::Duplicate { .. }));
        assert!(err.to_string().contains("update"));
        // 不同作用域同名可以
        s.apply(
            &agent_ctx(),
            &[add_op(ScopeRef::host("conn2"), "nginx配置", "b")],
        )
        .unwrap();
    }

    #[test]
    fn batch_is_all_or_nothing() {
        let s = MemoryStore::in_memory();
        let err = s.apply(
            &agent_ctx(),
            &[
                add_op(ScopeRef::user(), "a", "1"),
                WriteOp::Delete {
                    id: "nope".into(),
                    expected_version: None,
                },
            ],
        );
        assert!(matches!(err, Err(StoreError::NotFound(_))));
        assert!(s.list_all().unwrap().is_empty(), "整批回滚");
    }

    #[test]
    fn lenient_apply_keeps_the_good_ones() {
        let s = MemoryStore::in_memory();
        let ctx = BatchContext::new(Source::Reflection, Some("c1".into()));
        let (ok, failed) = s
            .apply_lenient(
                &ctx,
                &[
                    add_op(ScopeRef::user(), "a", "1"),
                    WriteOp::Delete {
                        id: "nope".into(),
                        expected_version: None,
                    },
                    add_op(ScopeRef::user(), "b", "2"),
                ],
            )
            .unwrap();
        assert_eq!(ok.len(), 2);
        assert_eq!(failed.len(), 1);
        assert_eq!(s.ops_for_batch(&ctx.batch_id).unwrap().len(), 2);
    }

    #[test]
    fn update_checks_version_and_logs_before_after() {
        let s = MemoryStore::in_memory();
        let rec = s
            .apply(&agent_ctx(), &[add_op(ScopeRef::user(), "a", "1")])
            .unwrap()
            .remove(0);
        let id = rec.memory_id;
        let conflict = s.apply(
            &agent_ctx(),
            &[WriteOp::Update {
                id: id.clone(),
                expected_version: Some(7),
                patch: MemoryPatch {
                    content: Some("2".into()),
                    ..Default::default()
                },
            }],
        );
        assert!(matches!(conflict, Err(StoreError::Conflict { .. })));
        let rec = s
            .apply(
                &agent_ctx(),
                &[WriteOp::Update {
                    id: id.clone(),
                    expected_version: Some(1),
                    patch: MemoryPatch {
                        content: Some("2".into()),
                        ..Default::default()
                    },
                }],
            )
            .unwrap()
            .remove(0);
        assert_eq!(rec.before.unwrap().content, "1");
        assert_eq!(rec.after.unwrap().content, "2");
        assert_eq!(s.get(&id).unwrap().unwrap().version, 2);
    }

    #[test]
    fn revert_add_deletes_and_records_rejection() {
        let s = MemoryStore::in_memory();
        let rec = s
            .apply(
                &agent_ctx(),
                &[add_op(ScopeRef::host("c"), "坑", "要加 --no-block")],
            )
            .unwrap()
            .remove(0);
        s.revert_op(rec.id).unwrap();
        assert!(s.get(&rec.memory_id).unwrap().is_none());
        let rej = s.rejections(&[ScopeRef::host("c")]).unwrap();
        assert_eq!(rej.len(), 1);
        assert_eq!(rej[0].title, "坑");
        assert!(matches!(
            s.revert_op(rec.id),
            Err(StoreError::AlreadyReverted)
        ));
    }

    #[test]
    fn revert_refuses_when_changed_since() {
        let s = MemoryStore::in_memory();
        let rec = s
            .apply(&agent_ctx(), &[add_op(ScopeRef::user(), "a", "1")])
            .unwrap()
            .remove(0);
        s.apply(
            &BatchContext::new(Source::User, None),
            &[WriteOp::Update {
                id: rec.memory_id.clone(),
                expected_version: None,
                patch: MemoryPatch {
                    content: Some("2".into()),
                    ..Default::default()
                },
            }],
        )
        .unwrap();
        assert!(matches!(s.revert_op(rec.id), Err(StoreError::ChangedSince)));
    }

    #[test]
    fn revert_update_and_delete_restore_previous_content() {
        let s = MemoryStore::in_memory();
        let add = s
            .apply(&agent_ctx(), &[add_op(ScopeRef::user(), "a", "1")])
            .unwrap()
            .remove(0);
        let id = add.memory_id;
        let upd = s
            .apply(
                &agent_ctx(),
                &[WriteOp::Update {
                    id: id.clone(),
                    expected_version: None,
                    patch: MemoryPatch {
                        content: Some("2".into()),
                        ..Default::default()
                    },
                }],
            )
            .unwrap()
            .remove(0);
        s.revert_op(upd.id).unwrap();
        assert_eq!(s.get(&id).unwrap().unwrap().content, "1");

        let del = s
            .apply(
                &agent_ctx(),
                &[WriteOp::Delete {
                    id: id.clone(),
                    expected_version: None,
                }],
            )
            .unwrap()
            .remove(0);
        assert!(s.get(&id).unwrap().is_none());
        s.revert_op(del.id).unwrap();
        assert_eq!(s.get(&id).unwrap().unwrap().content, "1");
    }

    #[test]
    fn revert_batch_undoes_everything_in_reverse() {
        let s = MemoryStore::in_memory();
        let base = s
            .apply(&agent_ctx(), &[add_op(ScopeRef::user(), "keep", "x")])
            .unwrap()
            .remove(0);
        let ctx = BatchContext::new(Source::Assistant, None);
        s.apply(
            &ctx,
            &[
                add_op(ScopeRef::user(), "new", "y"),
                WriteOp::Update {
                    id: base.memory_id.clone(),
                    expected_version: None,
                    patch: MemoryPatch {
                        title: Some("kept".into()),
                        ..Default::default()
                    },
                },
            ],
        )
        .unwrap();
        assert_eq!(s.list_all().unwrap().len(), 2);
        s.revert_batch(&ctx.batch_id).unwrap();
        let all = s.list_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].title, "keep");
    }

    #[test]
    fn only_user_initiated_writes_change_the_fingerprint() {
        let s = MemoryStore::in_memory();
        let scopes = vec![ScopeRef::user(), ScopeRef::host("c")];
        let f0 = s.fingerprint(&scopes).unwrap();
        s.apply(&agent_ctx(), &[add_op(ScopeRef::host("c"), "a", "1")])
            .unwrap();
        s.apply(
            &BatchContext::new(Source::Reflection, None),
            &[add_op(ScopeRef::host("c"), "b", "1")],
        )
        .unwrap();
        assert_eq!(
            s.fingerprint(&scopes).unwrap(),
            f0,
            "agent / 复盘不打穿快照"
        );
        s.apply(
            &BatchContext::new(Source::User, None),
            &[add_op(ScopeRef::host("c"), "c", "1")],
        )
        .unwrap();
        assert_ne!(s.fingerprint(&scopes).unwrap(), f0);
        // 别的机器的改动不影响本会话的指纹
        let f1 = s.fingerprint(&scopes).unwrap();
        s.apply(
            &BatchContext::new(Source::User, None),
            &[add_op(ScopeRef::host("other"), "d", "1")],
        )
        .unwrap();
        assert_eq!(s.fingerprint(&scopes).unwrap(), f1);
    }

    #[test]
    fn rename_group_moves_items_and_keeps_conflicting_ones() {
        let s = MemoryStore::in_memory();
        let user = BatchContext::new(Source::User, None);
        s.apply(&user, &[add_op(ScopeRef::group("old"), "a", "1")])
            .unwrap();
        s.apply(&user, &[add_op(ScopeRef::group("old"), "b", "1")])
            .unwrap();
        s.apply(&user, &[add_op(ScopeRef::group("new"), "b", "2")])
            .unwrap();
        assert_eq!(s.rename_group("old", "new").unwrap(), 1);
        assert_eq!(s.count_scope(&ScopeRef::group("new")).unwrap(), 2);
        assert_eq!(s.count_scope(&ScopeRef::group("old")).unwrap(), 1);
    }

    #[test]
    fn delete_scope_is_undoable() {
        let s = MemoryStore::in_memory();
        let user = BatchContext::new(Source::User, None);
        s.apply(&user, &[add_op(ScopeRef::host("c"), "a", "1")])
            .unwrap();
        s.apply(&user, &[add_op(ScopeRef::host("c"), "b", "1")])
            .unwrap();
        let (batch, n) = s.delete_scope(&ScopeRef::host("c")).unwrap();
        assert_eq!(n, 2);
        assert_eq!(s.count_scope(&ScopeRef::host("c")).unwrap(), 0);
        s.revert_batch(&batch).unwrap();
        assert_eq!(s.count_scope(&ScopeRef::host("c")).unwrap(), 2);
    }

    #[test]
    fn snapshots_progress_notes_and_forget() {
        let s = MemoryStore::in_memory();
        let snap = Snapshot {
            fingerprint: "f".into(),
            content: "c".into(),
            item_ids: vec!["m1".into()],
            created_at: now_rfc3339(),
            touched_at: now_rfc3339(),
        };
        s.put_snapshot("conv", &snap).unwrap();
        assert_eq!(s.snapshot("conv").unwrap().unwrap(), snap);
        s.set_progress(
            "conv",
            &ReflectionProgress {
                anchor_message_id: "msg1".into(),
                anchor_created_at: "t".into(),
            },
        )
        .unwrap();
        let ctx = BatchContext::new(Source::Reflection, Some("conv".into()));
        s.apply(&ctx, &[add_op(ScopeRef::user(), "a", "1")])
            .unwrap();
        let note = s
            .add_note("conv", "msg1", Some(&ctx.batch_id), true)
            .unwrap();
        assert_eq!(note.ops.len(), 1);
        assert_eq!(s.notes_for_conversation("conv").unwrap().len(), 1);

        s.forget_conversation("conv").unwrap();
        assert!(s.snapshot("conv").unwrap().is_none());
        assert!(s.progress("conv").unwrap().is_none());
        assert!(s.notes_for_conversation("conv").unwrap().is_empty());
        assert_eq!(s.list_all().unwrap().len(), 1, "记忆本身不随会话删除");
    }

    #[test]
    fn claim_once_is_true_only_the_first_time() {
        let s = MemoryStore::in_memory();
        assert!(s.claim_once("intro").unwrap());
        assert!(!s.claim_once("intro").unwrap());
        assert!(s.meta("store_created_at").unwrap().is_some());
    }

    #[test]
    fn rejections_are_capped_per_scope() {
        let s = MemoryStore::in_memory();
        for i in 0..(REJECTIONS_PER_SCOPE + 5) {
            let rec = s
                .apply(
                    &agent_ctx(),
                    &[add_op(ScopeRef::user(), &format!("t{i}"), "x")],
                )
                .unwrap()
                .remove(0);
            s.revert_op(rec.id).unwrap();
        }
        assert_eq!(
            s.rejections(&[ScopeRef::user()]).unwrap().len(),
            REJECTIONS_PER_SCOPE
        );
    }
}

// ── 跨设备同步（三期 T4）────────────────────────────────────────────────
//
// 同步读写必须走**同一条** `Mutex<Connection>`：只有调过 `rows::install` 的那条连接上的
// 写入才会被触发器捕获（见 `sync/rows/install.rs` 的模块文档）。所以这里加一组薄转发，
// 不另开连接。

impl MemoryStore {
    /// 捕获本机改动（段头 `db: "memory"`）。
    pub fn sync_capture(
        &self,
        clock: &mut crate::sync::core::hlc::HlcClock,
        device: &str,
        wall_ms: u64,
        aliases: &crate::sync::rows::AliasMap,
        tables: &'static [crate::sync::rows::RowTable],
        options: crate::sync::rows::CaptureOptions,
    ) -> Result<crate::sync::rows::CapturedRows, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::capture_with(&conn, tables, clock, device, wall_ms, aliases, options)
    }

    /// 段上传成功、账本落盘之后删掉 changelog。
    pub fn sync_ack(&self, watermark: i64) -> Result<(), crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::ack(&conn, watermark)
            .map_err(|e| crate::error::AppError::Other(format!("记忆库同步操作失败：{e}")))
    }

    /// 落地一段行 op。
    pub fn sync_apply(
        &self,
        ops_json: &[u8],
        aliases: &crate::sync::rows::AliasMap,
        tables: &'static [crate::sync::rows::RowTable],
    ) -> Result<crate::sync::rows::RowApplied, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::apply(&conn, tables, ops_json, aliases)
    }

    /// 全量导出（首次开启对话档时用）。
    pub fn sync_export_all(
        &self,
        device: &str,
        aliases: &crate::sync::rows::AliasMap,
        tables: &'static [crate::sync::rows::RowTable],
        db: &'static str,
    ) -> Result<Vec<Vec<u8>>, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::export_all_with(
            &conn,
            tables,
            device,
            aliases,
            crate::sync::rows::ExportOptions::new(
                crate::sync::streams::conv::CONV_STREAM,
                crate::sync::rows::DEFAULT_MAX_SEGMENT_BYTES,
            )
            .with_db(db),
        )
    }

    /// 待上传条数（按行去重）。
    pub fn sync_pending_count(
        &self,
        tables: &'static [crate::sync::rows::RowTable],
    ) -> Result<usize, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        crate::sync::rows::pending_count(&conn, tables)
    }

    /// 落地之后由同步层调用：把受影响的 `(scope, scope_key)` 的版本号 +1。
    ///
    /// 为什么必须 bump：`scope_versions` 不同步（本机派生），但记忆注入的「冻结快照」
    /// 用它判断要不要重渲染。别的设备改了记忆、本机不 bump 的话，下一轮 Agent 还会
    /// 用旧快照——数据是同步了，功能上却「用不上」。
    pub fn bump_scope_versions_for(
        &self,
        scopes: &[(String, String)],
    ) -> Result<usize, crate::error::AppError> {
        use super::model::Scope;
        let refs: BTreeSet<ScopeRef> = scopes
            .iter()
            .filter_map(|(scope, key)| {
                Scope::parse(scope).map(|s| ScopeRef {
                    scope: s,
                    key: key.clone(),
                })
            })
            .collect();
        if refs.is_empty() {
            return Ok(0);
        }
        let conn = self.conn.lock().unwrap();
        bump_scope_versions(&conn, &refs)
            .map_err(|e| crate::error::AppError::Other(format!("刷新记忆作用域版本失败：{e}")))?;
        Ok(refs.len())
    }

    /// 同步层用：库里所有记忆出现过的作用域（落地后 bump `scope_versions`）。
    ///
    /// 只读 `(scope, scope_key)` 两列，不碰正文。
    pub fn list_all_scopes_for_sync(
        &self,
    ) -> Result<Vec<(String, String)>, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT DISTINCT scope, scope_key FROM memories")
            .map_err(|e| crate::error::AppError::Other(format!("读记忆作用域失败：{e}")))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| crate::error::AppError::Other(format!("读记忆作用域失败：{e}")))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 同步层守护测试用：列出清单里这些表在**真实库**里的列名。
    pub fn table_columns_for_sync(
        &self,
    ) -> Result<HashMap<String, Vec<String>>, crate::error::AppError> {
        let conn = self.conn.lock().unwrap();
        let mut out = HashMap::new();
        for table in crate::sync::streams::memory::MEMORY_TABLES {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info({})", table.name))
                .map_err(|e| crate::error::AppError::Other(format!("读表结构失败：{e}")))?;
            let cols: Vec<String> = stmt
                .query_map([], |r| r.get::<_, String>(1))
                .map_err(|e| crate::error::AppError::Other(format!("读表结构失败：{e}")))?
                .filter_map(|r| r.ok())
                .collect();
            out.insert(table.name.to_string(), cols);
        }
        Ok(out)
    }
}
