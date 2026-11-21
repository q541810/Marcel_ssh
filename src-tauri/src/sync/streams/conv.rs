//! 对话与记忆流（conv）的驱动。
//!
//! 这条流和配置流有两点根本不同：
//!
//! 1. **按行后写者赢**（见 [`crate::sync::rows`]），不是 JSON 叶子镜像。触发器把本机改动记进
//!    `sync_changelog`，`capture` 读当前值发 HLC，`apply` 比每行时钟后落地。
//! 2. **横跨两个 SQLite 库**：对话在 `conversations.db`，记忆在 `memory.db`，而 `rows::apply`
//!    只能在一个库的一个事务里执行。所以驱动本身不认识「对话」或「记忆」，只认识一组
//!    [`ConvDatabase`]（库名 + 表清单 + 取连接的句柄）：段 JSON 里的 `"db"` 字段决定这段
//!    落到哪个库。T4 只需要再登记一个 `ConvDatabase`，驱动代码一行都不用改。
//!
//! ## 延迟落地（正在跑的会话）
//!
//! 本机某段对话有任务在跑（或在压缩）时，远端对它的改动不能立刻写进业务表：任务收尾时
//! 会按它读到的历史写消息 / 压缩卡，落地插进来的行会和它打架。规则是**更精确的那一档**：
//! - 运行中的会话里，`messages` 的**新插入**照常落地（任务不会因为有新消息而算错账，
//!   前端也能实时看到对方刚发来的内容）；
//! - 其它一切（会话行本身、消息的改写 / 删除、计划与计划快照）先摘出来挂起，等任务结束。
//!
//! 挂起的 op 必须**落盘**（`sync/conv_pending.json`）：驱动每轮都重建，只放在字段里下一轮就
//! 没了，那些改动会永远停在半路。文件同时保存本流的 HLC 时钟与每库的 ack 水位——前者丢了
//! 会让墙钟被回拨的设备发出比旧 op 还小的时间戳，后者丢了只会重发（幂等），前者是正确性问题。
//!
//! ## 大量删除闸
//!
//! `conversations.mass_delete_limit = 20`：一轮里删掉 20 段以上对话先扣住，等用户在同步面板
//! 确认。删除一整段对话只发**一个会话墓碑**（发送侧 `ConversationDb::delete_conversation*`
//! 用 `rows::with_capture_suppressed` 把子表的 DELETE 包住），接收侧由 `rows::apply` 级联删
//! 子行，驱动再补一次图片桶清理与子表兜底清理。
//!
//! ## 分包快照
//!
//! 新设备加入时先拉 `conv/snap-<seq>/index.msync`，再按「会话最近活跃」从新到旧逐包拉
//! `part-NNNN.msync`，每落一包立刻 `land()` 一次让前端实时可见。每包约 4 MB，按会话聚合
//! （一个会话的所有行永远在同一包里，绝不拆散父子关系）；单个会话超过 4 MB 时独占一包。

use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use futures::{StreamExt, TryStreamExt};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::super::core::crypto::DataKey;
use super::super::core::format::{self, RemoteStream};
use super::super::core::hlc::{Hlc, HlcClock};
use super::super::rows::{
    self, AliasMap, CaptureOptions, CapturedRows, ColumnScope, HeldRow, RowApplied, RowColumn,
    RowMerge, RowOp, RowTable, SegmentMeta, DEFAULT_MAX_SEGMENT_BYTES,
};
use super::super::store::StreamState;
use super::super::types::HeldSummary;
use super::{
    SnapshotApplied, SnapshotManifest, SnapshotManifestPart, SnapshotPublication, StreamApplied,
    StreamDriver, StreamDriverContext, StreamDriverFactory, StreamFileKind, StreamName,
    StreamProgress, StreamRemote, StreamSnapshot, StreamSnapshotLayout,
};
use crate::agent::image_store;
use crate::config::persist::{atomic_write, atomic_write_bytes};
use crate::data::DataSourceId;
use crate::error::AppError;

/// 写进段头的流名（契约第 6 节）。
pub const CONV_STREAM: &str = "conv";

/// 分包快照里一个包的目标大小。单个会话超过它时允许独占一包。
pub const PART_TARGET_BYTES: usize = 4 * 1024 * 1024;

/// 挂起 op / HLC / 水位的落盘文件名（在 `sync/` 目录下，属 `SyncState`）。
const PENDING_FILE: &str = "conv_pending.json";

// ---------------------------------------------------------------------------
// 表清单（契约第 11 节）
// ---------------------------------------------------------------------------

/// 对话库参与同步的表。
///
/// **列的顺序必须与建表 / 迁移跑完后的真实 schema 一致**——`sync/conv_scope_guard.rs` 钉着
/// 这一点。加列时这里和 `ConversationDb::new` 的迁移要一起改，否则快照测试变红。
pub static CONV_TABLES: &[RowTable] = &[
    RowTable {
        name: "conversations",
        pk: "id",
        columns: &[
            RowColumn {
                name: "id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "connection_id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "title",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "created_at",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "updated_at",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "parent_conversation_id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "model_id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "efforts_json",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "pinned",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "usage_json",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "forked_from_id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "archived_at",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "sub_dispatch_json",
                scope: ColumnScope::Shared,
            },
        ],
        parent: None,
        // 连接 id 在加入同步时会被去重换名，上传 / 落地两个方向都要过别名表。
        alias: rows::AliasColumn::ConnectionId,
        // 一轮删掉 20 段以上对话先扣住：误删一整批会话的代价太大，先问一句。
        mass_delete_limit: 20,
        merge: RowMerge::Lww,
    },
    RowTable {
        name: "messages",
        pk: "id",
        columns: &[
            RowColumn {
                name: "id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "conversation_id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "role",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "content",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "timestamp",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "created_at",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "tool_calls_json",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "reasoning_content",
                scope: ColumnScope::Shared,
            },
            // 本机图片桶里的相对路径（`images/<会话>/...`）：别的设备上没有这个文件，
            // 传过去只会指向一个不存在的路径。图片本身走 blob 流（T3）。
            RowColumn {
                name: "image_paths_json",
                scope: ColumnScope::Local,
            },
            RowColumn {
                name: "turn_state",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "user_input_json",
                scope: ColumnScope::Shared,
            },
            // 对端图片的 blob 引用（T3 写）。同步它，本机读图时才知道去哪个设备的 blob 拉。
            RowColumn {
                name: "synced_images_json",
                scope: ColumnScope::Shared,
            },
        ],
        parent: Some(("conversation_id", "conversations")),
        alias: rows::AliasColumn::None,
        mass_delete_limit: 0,
        merge: RowMerge::Lww,
    },
    RowTable {
        name: "plans",
        pk: "task_id",
        columns: &[
            RowColumn {
                name: "task_id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "conversation_id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "plan_json",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "updated_at",
                scope: ColumnScope::Shared,
            },
        ],
        parent: Some(("conversation_id", "conversations")),
        alias: rows::AliasColumn::None,
        mass_delete_limit: 0,
        merge: RowMerge::Lww,
    },
    RowTable {
        name: "plan_snapshots",
        // 自增 `id` 跨设备没有意义，用迁移补出来的 `uid` 当同步主键。
        pk: "uid",
        columns: &[
            // 自增 id 是**本机**的物理行号：上传它没有意义，落地时写它还会和本机已有的
            // 行主键冲突（整批事务回滚，同步卡死）。所以它是 Local。
            // 列序与真实 schema 一致（`uid` 是后加的，永远在末尾）。
            RowColumn {
                name: "id",
                scope: ColumnScope::Local,
            },
            RowColumn {
                name: "conversation_id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "task_id",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "plan_json",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "created_at",
                scope: ColumnScope::Shared,
            },
            RowColumn {
                name: "uid",
                scope: ColumnScope::Shared,
            },
        ],
        parent: Some(("conversation_id", "conversations")),
        alias: rows::AliasColumn::None,
        mass_delete_limit: 0,
        merge: RowMerge::Lww,
    },
];

// ---------------------------------------------------------------------------
// 多库组合
// ---------------------------------------------------------------------------

/// 一条流里的一个 SQLite 库：库名（进段 JSON 的 `db` 字段）+ 表清单 + 取连接的句柄。
///
/// T4 只需要 `databases.push(ConvDatabase { name: "memory", tables: MEMORY_TABLES, handle })`。
#[derive(Clone)]
pub struct ConvDatabase {
    /// `"conversations"` / `"memory"`。段 JSON 的 `db` 字段取值。
    pub name: &'static str,
    pub tables: &'static [RowTable],
    /// 由 lib.rs 注入：`ConversationDb` 的封装。驱动不另开 `Connection`——业务写入与同步
    /// 捕获必须共用同一条连接（触发器是连接级的，见 `rows` 模块文档）。
    pub handle: Arc<dyn ConvDbHandle>,
}

/// 一个库的同步入口。实现方负责用**自己的连接锁**调 `rows::*`。
///
/// 除 `capture` / `ack` / `apply` / `export_all` / `pending_count`（任务书钉住的五个）外，
/// 驱动还需要几个只读探针来完成延迟落地与墓碑兜底清理；它们都有默认实现，T4 的句柄
/// 不实现也能跑（记忆表不参与「运行中会话」的判定）。
pub trait ConvDbHandle: Send + Sync {
    fn capture(
        &self,
        clock: &mut HlcClock,
        device: &str,
        wall_ms: u64,
        aliases: &AliasMap,
        options: CaptureOptions,
    ) -> Result<CapturedRows, AppError>;
    fn ack(&self, watermark: i64) -> Result<(), AppError>;
    fn apply(&self, ops: &[u8], aliases: &AliasMap) -> Result<RowApplied, AppError>;
    fn apply_ops(&self, ops: &[RowOp], aliases: &AliasMap) -> Result<RowApplied, AppError>;
    fn export_all(&self, device: &str, aliases: &AliasMap) -> Result<Vec<Vec<u8>>, AppError>;
    /// 检查点直接逐行打包，普通首次加入保持零时钟存活行语义。
    fn for_each_checkpoint_op(
        &self,
        device: &str,
        aliases: &AliasMap,
        sink: &mut dyn FnMut(RowOp) -> Result<(), AppError>,
    ) -> Result<(), AppError>;
    fn pending_count(&self) -> Result<usize, AppError>;

    /// 还没登记图片 blob 的消息：`(message_id, [本地相对路径])`。
    ///
    /// 只有带 `messages` 表的库有意义；记忆库默认空。
    fn pending_synced_images(&self) -> Result<Vec<(String, Vec<String>)>, AppError> {
        Ok(Vec::new())
    }

    /// 把一条消息的图片 blob 引用写进 `synced_images_json`。
    fn set_synced_images(&self, _message_id: &str, _json: &str) -> Result<(), AppError> {
        Ok(())
    }

    /// 一轮落地结束后由驱动调用（各库做自己的善后）。
    ///
    /// 记忆库用它 bump `scope_versions`：那个表不同步（本机派生），但别的设备改了记忆之后
    /// 不 bump 的话，下一轮 Agent 还会用旧的注入快照——数据同步了却「用不上」。
    /// 对话库不需要，默认空实现。
    fn after_land(&self, _applied: &RowApplied) -> Result<(), AppError> {
        Ok(())
    }

    /// 本机某张表里这一行的 `conversation_id`。`None` = 行不存在 / 这张表与会话无关。
    /// 延迟落地要判断一条「只有墓碑、没有内容」的 op 属于哪段会话，只能问本机。
    fn row_conversation(&self, table: &str, row_id: &str) -> Option<String> {
        let _ = (table, row_id);
        None
    }

    /// 本机是否有这一行（判断 `messages` 的 op 是不是「新插入」）。
    fn row_exists(&self, table: &str, row_id: &str) -> bool {
        let _ = (table, row_id);
        false
    }

    /// 直接删掉 `sync_changelog` 里这几行的待上传记录（用户拒绝大量删除时用：本机已经
    /// 删掉的会话不再同步出去，也不该一直卡着后面的改动）。
    fn ack_rows(&self, rows: &[(String, String)]) -> Result<(), AppError> {
        let _ = rows;
        Ok(())
    }

    /// 兜底清理：会话墓碑落地后，把子表里可能残留的行删掉（`rows::apply` 已经按父表声明
    /// 级联删过一遍；它被时钟判掉 / 上次崩溃留下孤儿时，这里补一刀）。必须抑制捕获，
    /// 否则会为每条消息各生成一个墓碑。
    fn purge_conversation(&self, conversation_id: &str) -> Result<(), AppError> {
        let _ = conversation_id;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// 对话库的句柄实现
// ---------------------------------------------------------------------------

/// 把 [`crate::agent::conversation::ConversationDb`] 包成 [`ConvDbHandle`]。
///
/// 单独一个包装类型而不是直接 `impl ConvDbHandle for ConversationDb`：`agent` 层不该依赖
/// `sync::streams`（反过来才对），接线放在这一层；T4 也可以照这个形状给自己的
/// `MemoryStore` 写一个同样薄的包装。
pub struct ConversationHandle {
    db: Arc<crate::agent::conversation::ConversationDb>,
}

impl ConversationHandle {
    pub fn new(db: Arc<crate::agent::conversation::ConversationDb>) -> Self {
        Self { db }
    }
}

impl ConvDbHandle for ConversationHandle {
    fn capture(
        &self,
        clock: &mut HlcClock,
        device: &str,
        wall_ms: u64,
        aliases: &AliasMap,
        options: CaptureOptions,
    ) -> Result<CapturedRows, AppError> {
        self.db
            .sync_capture_with_options(clock, device, wall_ms, aliases, options)
    }

    fn ack(&self, watermark: i64) -> Result<(), AppError> {
        self.db.sync_ack(watermark)
    }

    fn apply(&self, ops: &[u8], aliases: &AliasMap) -> Result<RowApplied, AppError> {
        self.db.sync_apply(ops, aliases)
    }

    fn apply_ops(&self, ops: &[RowOp], aliases: &AliasMap) -> Result<RowApplied, AppError> {
        self.db.sync_apply_checkpoint(ops, aliases)
    }

    fn export_all(&self, device: &str, aliases: &AliasMap) -> Result<Vec<Vec<u8>>, AppError> {
        self.db
            .sync_export_all(device, aliases, DEFAULT_MAX_SEGMENT_BYTES)
    }

    fn pending_count(&self) -> Result<usize, AppError> {
        self.db.sync_pending_count()
    }

    fn for_each_checkpoint_op(
        &self,
        device: &str,
        aliases: &AliasMap,
        sink: &mut dyn FnMut(RowOp) -> Result<(), AppError>,
    ) -> Result<(), AppError> {
        self.db.sync_for_each_checkpoint_op(device, aliases, sink)
    }

    fn row_conversation(&self, table: &str, row_id: &str) -> Option<String> {
        self.db.sync_row_conversation(table, row_id)
    }

    fn row_exists(&self, table: &str, row_id: &str) -> bool {
        self.db.sync_row_exists(table, row_id)
    }

    fn ack_rows(&self, rows: &[(String, String)]) -> Result<(), AppError> {
        self.db.sync_ack_rows(rows)
    }

    fn pending_synced_images(&self) -> Result<Vec<(String, Vec<String>)>, AppError> {
        self.db.sync_pending_images()
    }

    fn set_synced_images(&self, message_id: &str, json: &str) -> Result<(), AppError> {
        self.db.sync_set_images(message_id, json)
    }

    fn purge_conversation(&self, conversation_id: &str) -> Result<(), AppError> {
        self.db.sync_purge_conversation(conversation_id)
    }
}

// ---------------------------------------------------------------------------
// 工厂
// ---------------------------------------------------------------------------

/// 工厂与驱动共享的「界面能看到的状态」。
#[derive(Default)]
struct ConvUiState {
    /// 被大量删除闸扣住、等用户确认的会话数。
    gated: usize,
}

/// 注册到 `SyncDeps::stream_drivers` 的工厂。
///
/// 引擎每轮构造一个驱动：`set_context` 先把本机身份（设备 id / 连接别名 / 在跑判定 / 墙钟）
/// 交进来，`create` 再按账本里的流状态造驱动。工厂本身跨轮存活，因此扣住的删除数这类
/// 「面板要显示、又不属于某一次驱动」的东西放在这里。
pub struct ConvStreamFactory {
    databases: Vec<ConvDatabase>,
    config_dir: PathBuf,
    /// 存储后端（上传图片 blob 用）。引擎第一轮之后才有；没有就先跳过 blob。
    backend: RwLock<Option<Arc<dyn crate::sync::backends::Backend>>>,
    context: RwLock<Option<StreamDriverContext>>,
    ui: Arc<RwLock<ConvUiState>>,
}

impl ConvStreamFactory {
    /// 追加一个库（T4 加记忆库用：驱动代码不用改）。
    pub fn push_database(&mut self, db: ConvDatabase) {
        self.databases.push(db);
    }

    pub fn new(databases: Vec<ConvDatabase>, config_dir: PathBuf) -> Self {
        Self {
            databases,
            config_dir,
            backend: RwLock::new(None),
            context: RwLock::new(None),
            ui: Arc::new(RwLock::new(ConvUiState::default())),
        }
    }

    fn pending_path(&self) -> PathBuf {
        DataSourceId::SyncState
            .path(&self.config_dir)
            .join(PENDING_FILE)
    }
}

impl StreamDriverFactory for ConvStreamFactory {
    fn name(&self) -> StreamName {
        StreamName::Conv
    }

    fn set_context(&self, ctx: &StreamDriverContext) {
        *self.context.write() = Some(ctx.clone());
    }

    fn set_backend(&self, backend: Arc<dyn crate::sync::backends::Backend>) {
        *self.backend.write() = Some(backend);
    }

    fn create(
        &self,
        state: StreamState,
        dk: Option<DataKey>,
    ) -> Result<Box<dyn StreamDriver>, AppError> {
        let ctx = self.context.read().clone().ok_or_else(|| {
            AppError::Other("同步：对话流缺少本机上下文（引擎还没初始化）".into())
        })?;
        Ok(Box::new(
            ConvStreamDriver::new(
                self.databases.clone(),
                state,
                ctx,
                self.pending_path(),
                self.ui.clone(),
            )
            .with_blobs(dk.clone(), self.backend.read().clone()),
        ))
    }

    /// 待上传条数：各库 changelog 里不同的行数之和（界面 `streams[].pending`）。
    fn pending(&self) -> usize {
        self.databases
            .iter()
            .filter_map(|db| db.handle.pending_count().ok())
            .sum()
    }

    /// 扣住等确认的删除。`SyncStatus.held` 与配置流共用一块展示。
    fn held(&self) -> Vec<HeldSummary> {
        let n = self.ui.read().gated;
        if n == 0 {
            Vec::new()
        } else {
            vec![HeldSummary {
                source: "conversations".to_string(),
                count: n,
            }]
        }
    }

    /// 用户点了「放行 / 撤销」。写进落盘状态，下一轮驱动构造时读到。
    ///
    /// 撤销的含义与配置流不同：会话行已经在本机删掉了，没有镜像可以写回。所以「撤销」
    /// 只表示**不把这次删除同步出去**（本机已删、别的设备保留）。
    fn confirm_held(&self, accept: bool) {
        let path = self.pending_path();
        let mut state = load_pending(&path);
        state.release_gated = accept;
        state.drop_gated = !accept;
        if let Err(e) = save_pending(&path, &state) {
            log::warn!("同步：记录「大量删除」的处理结果失败: {e}");
        }
        self.ui.write().gated = 0;
    }
}

// ---------------------------------------------------------------------------
// 落盘状态
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize, Deserialize)]
struct DeferredOp {
    db: String,
    op: RowOp,
}

/// 被大量删除闸扣住的墓碑。为什么不直接存 `rows::HeldRow`：那是 T1 的类型，刻意不带
/// serde（它只活在一轮捕获里）；落盘形状归这条流自己管，加一个薄壳比改别人的类型干净。
#[derive(Clone, Debug, Serialize, Deserialize)]
struct GatedRow {
    table: String,
    row_id: String,
}

impl From<HeldRow> for GatedRow {
    fn from(row: HeldRow) -> Self {
        Self {
            table: row.table,
            row_id: row.row_id,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct PersistedConvState {
    format: u32,
    /// 本流 HLC 的最后状态（重启后恢复，防墙钟回拨）。
    clock: Option<Hlc>,
    /// 每个库上一轮捕获的水位：上传成功后据此 ack。
    watermarks: BTreeMap<String, i64>,
    /// 因为会话在跑而挂起的 op。
    deferred: Vec<DeferredOp>,
    /// 被大量删除闸扣住的会话墓碑。
    gated: Vec<GatedRow>,
    /// 用户点了「放行」：下一轮绕过闸门，把这些墓碑发出去。
    release_gated: bool,
    /// 用户点了「撤销」：这些墓碑只留在本机，不再同步。
    drop_gated: bool,
    /// 正在接收的完整快照。包暂存在 SyncState 下，完整后才改业务库。
    resume: BTreeMap<String, SnapshotResume>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct SnapshotResume {
    peer: String,
    seq: u64,
    manifest_sha256: String,
    manifest: SnapshotManifest,
    ready_parts: BTreeSet<u32>,
}

impl Default for PersistedConvState {
    fn default() -> Self {
        Self {
            format: 1,
            clock: None,
            watermarks: BTreeMap::new(),
            deferred: Vec::new(),
            gated: Vec::new(),
            release_gated: false,
            drop_gated: false,
            resume: BTreeMap::new(),
        }
    }
}

fn load_pending(path: &std::path::Path) -> PersistedConvState {
    // 损坏不应让同步整条停摆：当作「没有挂起的东西」继续。最坏是丢掉几条延迟落地的远端
    // 改动（下一轮对方会重发——段是按游标读的，这里丢的只是已经读过的段里的 op，
    // 所以更准确的代价是那几行要等下一次全量快照才能补上）。
    match std::fs::read_to_string(path) {
        Ok(text) if !text.trim().is_empty() => match serde_json::from_str(&text) {
            Ok(state) => state,
            Err(e) => {
                log::error!("同步：{} 无法解析，按空状态继续: {e}", path.display());
                PersistedConvState::default()
            }
        },
        _ => PersistedConvState::default(),
    }
}

fn save_pending(path: &std::path::Path, state: &PersistedConvState) -> Result<(), AppError> {
    let text = serde_json::to_string(state)
        .map_err(|e| AppError::Other(format!("序列化对话同步状态失败：{e}")))?;
    if std::fs::read_to_string(path).ok().as_deref() == Some(text.as_str()) {
        return Ok(());
    }
    atomic_write(path, &text).map_err(|e| AppError::Other(format!("写入对话同步状态失败：{e}")))
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

/// 一轮里已经落地的东西（`land()` 时报给引擎）。
#[derive(Default)]
struct Landing {
    changed: bool,
    conversation_ids: Vec<String>,
    /// 累积的原始结果（`changed_tables` 等），落地善后要用。
    raw: RowApplied,
}

impl Landing {
    fn merge(&mut self, applied: &RowApplied) {
        self.changed |= applied.changed;
        self.raw.merge(applied.clone());
        for id in &applied.conversation_ids {
            if !self.conversation_ids.contains(id) {
                self.conversation_ids.push(id.clone());
            }
        }
    }

    fn take(&mut self) -> StreamApplied {
        StreamApplied {
            changed: std::mem::take(&mut self.changed),
            conversation_ids: std::mem::take(&mut self.conversation_ids),
            progress: None,
        }
    }
}

pub struct ConvStreamDriver {
    databases: Vec<ConvDatabase>,
    state: StreamState,
    device: String,
    aliases: AliasMap,
    running: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    now_ms: Arc<dyn Fn() -> u64 + Send + Sync>,
    path: PathBuf,
    persisted: PersistedConvState,
    clock: HlcClock,
    /// 本 batch 里被墓碑删掉的会话：`land()` 用它们清图片桶 + 兜底清子表。
    deleted: BTreeSet<String>,
    landing: Landing,
    /// 本轮刚跑完一次分包快照：让 `land()` 报 `changed = true`，好让引擎把「正在同步
    /// 对话 N / N」的进度收掉。
    snapshot_finished: bool,
    /// 最近一次快照落地的进度（测试与排查用）。
    progress: Option<StreamProgress>,
    /// 配置目录（blob 登记表落在 `sync/` 下）。
    config_dir: PathBuf,
    /// 数据密钥（上传图片 blob 用；捕获阶段可能还没有，那时跳过 blob 上传，下一轮补）。
    dk: Option<DataKey>,
    /// 存储后端（上传 blob 用）。
    backend: Option<Arc<dyn crate::sync::backends::Backend>>,
    /// 长操作中途报告进度的出口（引擎经 `StreamDriverContext::progress` 注入）。
    /// 一轮同步可能跑几分钟，界面上的「正在同步对话 N / M」靠它中途刷新。
    progress_reporter: Option<Arc<dyn Fn(StreamName, StreamProgress) + Send + Sync>>,
    ui: Arc<RwLock<ConvUiState>>,
}

impl ConvStreamDriver {
    pub fn new(
        databases: Vec<ConvDatabase>,
        state: StreamState,
        ctx: StreamDriverContext,
        path: PathBuf,
        ui: Arc<RwLock<ConvUiState>>,
    ) -> Self {
        let persisted = load_pending(&path);
        let config_dir = config_dir_for(&path);
        // 设备 id 变了（重新加入同步）就从零开始：沿用旧 id 的时间戳会让别的设备看到
        // 「这台设备」的时间线倒流。
        let clock = match &persisted.clock {
            Some(last) if last.device == ctx.device => HlcClock::from_last(last.clone()),
            _ => HlcClock::new(ctx.device.clone()),
        };
        Self {
            databases,
            state,
            device: ctx.device,
            aliases: ctx.aliases,
            running: ctx.running,
            now_ms: ctx.now_ms,
            path,
            persisted,
            clock,
            deleted: BTreeSet::new(),
            landing: Landing::default(),
            snapshot_finished: false,
            progress: None,
            progress_reporter: ctx.progress.clone(),
            config_dir,
            dk: None,
            backend: None,
            ui,
        }
    }

    fn wall(&self) -> u64 {
        (self.now_ms)()
    }

    fn database(&self, name: &str) -> Result<&ConvDatabase, AppError> {
        self.databases
            .iter()
            .find(|db| db.name == name)
            .ok_or_else(|| {
                AppError::Other(format!(
                    "收到一条本版本还不认识的同步数据（库「{name}」）。升级应用后会自动补上。"
                ))
            })
    }

    fn save_state(&mut self) -> Result<(), AppError> {
        self.persisted.clock = Some(self.clock.last().clone());
        save_pending(&self.path, &self.persisted)
    }

    /// 一条 op 属于哪段会话。`None` = 与会话无关（或本机查不到，按无关处理）。
    fn conversation_of(&self, db: &ConvDatabase, op: &RowOp) -> Option<String> {
        if op.table == "conversations" {
            return Some(op.id.clone());
        }
        let field = conversation_field(&op.table)?;
        for map in [&op.cols, &op.extra].into_iter().flatten() {
            if let Some(Value::String(v)) = map.get(field) {
                if !v.is_empty() {
                    return Some(v.clone());
                }
            }
        }
        db.handle.row_conversation(&op.table, &op.id)
    }

    fn is_running(&self, conversation_id: &str) -> bool {
        (self.running)(conversation_id)
    }

    /// 远端 op 里最大的 HLC：本机时钟要跟上，否则本机下一次写入的 HLC 可能比刚看到的
    /// 远端改动还旧，别的设备会拒收。
    fn observe_ops(&mut self, ops: &[RowOp]) {
        let wall = self.wall();
        let mut max: Option<Hlc> = None;
        for op in ops {
            if max.as_ref().map_or(true, |m| op.hlc > *m) {
                max = Some(op.hlc.clone());
            }
        }
        if let Some(hlc) = max {
            self.clock.observe(&hlc, wall);
        }
    }

    /// 把一段明文 row 段吸收进业务库。返回实际落地的结果。
    ///
    /// 这里是延迟落地唯一的入口：**先把「在跑」会话的 op 摘出来**，剩下的才交给
    /// `rows::apply`（它是直接写业务表的事务，写进去就收不回来了）。
    fn absorb_segment(&mut self, plain: &[u8]) -> Result<RowApplied, AppError> {
        let parsed = rows::parse_segment(plain)?;
        let db_name = parsed.db_or_default().to_string();
        let db = self.database(&db_name)?.clone();
        self.observe_ops(&parsed.ops);

        let mut pass: Vec<RowOp> = Vec::new();
        let mut deferred: Vec<RowOp> = Vec::new();
        for op in parsed.ops {
            let Some(conversation) = self.conversation_of(&db, &op) else {
                pass.push(op);
                continue;
            };
            if !self.is_running(&conversation) {
                pass.push(op);
                continue;
            }
            // 运行中的会话：只放行 messages 的新插入（本机没有这一行）。
            let is_new_message =
                op.table == "messages" && !op.del && !db.handle.row_exists("messages", &op.id);
            if is_new_message {
                pass.push(op);
            } else {
                deferred.push(op);
            }
        }

        if !deferred.is_empty() {
            log::debug!(
                "同步：{} 条改动落在正在运行的会话上，先挂起等任务结束",
                deferred.len()
            );
            for op in deferred {
                self.persisted.deferred.push(DeferredOp {
                    db: db_name.clone(),
                    op,
                });
            }
        }

        let mut applied = RowApplied::default();
        if !pass.is_empty() {
            // 收集墓碑：`rows::apply` 之后会话行就没了，图片桶要在 `land()` 里清。
            for op in &pass {
                if op.del && op.table == "conversations" {
                    self.deleted.insert(op.id.clone());
                }
            }
            let bytes = encode_ops(&self.device, db.name, &pass)?;
            applied = db.handle.apply(&bytes, &self.aliases)?;
        }
        self.save_state()?;
        Ok(applied)
    }

    /// 重放挂起的 op：会话已经不在跑了就现在落地。返回一次落地结果。
    fn replay_deferred(&mut self) -> Result<RowApplied, AppError> {
        if self.persisted.deferred.is_empty() {
            return Ok(RowApplied::default());
        }
        let mut remaining: Vec<DeferredOp> = Vec::new();
        let mut groups: BTreeMap<String, Vec<RowOp>> = BTreeMap::new();
        for item in std::mem::take(&mut self.persisted.deferred) {
            let conversation = self
                .database(&item.db)
                .ok()
                .and_then(|db| self.conversation_of(db, &item.op));
            let still_running = conversation.map(|id| self.is_running(&id)).unwrap_or(false);
            if still_running {
                remaining.push(item);
            } else {
                groups.entry(item.db).or_default().push(item.op);
            }
        }
        let mut applied = RowApplied::default();
        for (db_name, ops) in groups {
            let db = self.database(&db_name)?.clone();
            for op in &ops {
                if op.del && op.table == "conversations" {
                    self.deleted.insert(op.id.clone());
                }
            }
            let bytes = encode_ops(&self.device, db.name, &ops)?;
            applied.merge(db.handle.apply(&bytes, &self.aliases)?);
        }
        self.persisted.deferred = remaining;
        self.save_state()?;
        Ok(applied)
    }

    /// 用户拒绝了大量删除：把这些墓碑从 changelog 里摘掉（本机已删、不再同步出去）。
    fn drop_gated_rows(&mut self) -> Result<(), AppError> {
        if !self.persisted.drop_gated {
            return Ok(());
        }
        let gated = std::mem::take(&mut self.persisted.gated);
        let mut per_db: BTreeMap<String, Vec<(String, String)>> = BTreeMap::new();
        // 扣住的墓碑只可能来自 conversations 表（只有它设了 mass_delete_limit），
        // 但表名照 `HeldRow` 走，以后别的表开闸不用改这里。
        for row in gated {
            for db in &self.databases {
                if db.tables.iter().any(|t| t.name == row.table) {
                    per_db
                        .entry(db.name.to_string())
                        .or_default()
                        .push((row.table.clone(), row.row_id.clone()));
                    break;
                }
            }
        }
        for (db_name, rows) in per_db {
            self.database(&db_name)?.handle.ack_rows(&rows)?;
        }
        self.persisted.drop_gated = false;
        self.save_state()?;
        Ok(())
    }

    fn land_inner(&mut self) -> Result<StreamApplied, AppError> {
        let replayed = self.replay_deferred()?;
        self.landing.merge(&replayed);

        // 会话墓碑：图片桶在库外，`rows::apply` 管不到；子表兜底清理防的是
        // 「墓碑因时钟被判掉 / 上次崩溃留下孤儿」这两条 `rows::apply` 不覆盖的路径。
        let deleted: Vec<String> = self.deleted.iter().cloned().collect();
        self.deleted.clear();
        for id in deleted {
            if let Err(e) = self.purge_conversation(&id) {
                log::warn!("同步：清理已删除会话的残留失败（不影响其它数据）: {e}");
            }
            image_store::delete_conversation_images(&id);
        }

        // 各库自己的善后（记忆库 bump 作用域版本，见 `ConvDbHandle::after_land`）。
        let pending_take = self.landing.raw.clone();
        for db in &self.databases {
            if let Err(e) = db.handle.after_land(&pending_take) {
                log::warn!("同步：{} 落地善后失败（不影响数据）: {e}", db.name);
            }
        }

        let mut out = self.landing.take();
        if self.snapshot_finished {
            // 让引擎收掉「正在同步对话 N / N」的进度条。
            out.changed = true;
            self.snapshot_finished = false;
        }
        Ok(out)
    }

    fn purge_conversation(&self, id: &str) -> Result<(), AppError> {
        for db in &self.databases {
            if db.tables.iter().any(|t| t.name == "conversations") {
                db.handle.purge_conversation(id)?;
            }
        }
        Ok(())
    }

    /// 对话在「会话行」上的 `updated_at`。快照按它从新到旧排；没有会话行的库
    /// （记忆）退回用组内最大的时间戳列。
    fn unit_marker(ops: &[RowOp]) -> Option<(String, String)> {
        let mut conversation_updated: Option<String> = None;
        let mut fallback: Option<String> = None;
        for op in ops {
            let Some(cols) = &op.cols else { continue };
            if op.table == "conversations" {
                if let Some(Value::String(v)) = cols.get("updated_at") {
                    conversation_updated = Some(v.clone());
                }
                continue;
            }
            for key in ["updated_at", "created_at"] {
                if let Some(Value::String(v)) = cols.get(key) {
                    if fallback.as_ref().map_or(true, |f| v > f) {
                        fallback = Some(v.clone());
                    }
                }
            }
        }
        let updated = conversation_updated.or(fallback).unwrap_or_default();
        let marker = updated.clone();
        Some((marker, updated))
    }
}

fn conversation_field(table: &str) -> Option<&'static str> {
    match table {
        // `conversations` 的行 id 就是会话 id（在 `conversation_of` 里特判）。
        "messages" | "plans" | "plan_snapshots" | "reflection_notes" => Some("conversation_id"),
        "memories" | "memory_rejections" => Some("source_conversation_id"),
        _ => None,
    }
}

fn encode_ops(device: &str, db: &'static str, ops: &[RowOp]) -> Result<Vec<u8>, AppError> {
    rows::encode_segment(SegmentMeta::new(CONV_STREAM).with_db(db), device, ops)
}

// ---------------------------------------------------------------------------
// 分包快照
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConvSnapshotIndex {
    pub format: u32,
    pub kind: String,
    pub device: String,
    #[serde(default)]
    pub seq: u64,
    pub conversations: Vec<ConvIndexEntry>,
    pub parts: Vec<ConvPartEntry>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConvIndexEntry {
    pub id: String,
    pub updated_at: String,
    pub parts: Vec<u32>,
    pub bytes: u64,
    /// 这条会话属于哪个库（T2 只有 "conversations"）。
    pub db: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConvPartEntry {
    pub index: u32,
    pub bytes: u64,
    pub db: String,
}

/// 一个待打包的会话单位。
struct SnapshotUnit {
    db: &'static str,
    conversation: String,
    updated_at: String,
    ops: Vec<RowOp>,
    bytes: usize,
}

impl ConvStreamDriver {
    fn snapshot_conversation_of(op: &RowOp) -> Option<String> {
        if op.table == "conversations" {
            return Some(op.id.clone());
        }
        let field = conversation_field(&op.table)?;
        for map in [&op.cols, &op.extra].into_iter().flatten() {
            if let Some(Value::String(value)) = map.get(field) {
                if !value.is_empty() {
                    return Some(value.clone());
                }
            }
        }
        None
    }

    /// 按会话聚合出全部分包（内部实现）。
    fn build_snapshot(&self) -> Result<Option<StreamSnapshot>, AppError> {
        let mut units: BTreeMap<(String, String), SnapshotUnit> = BTreeMap::new();
        for db in &self.databases {
            let mut collect = |op: RowOp| {
                // 检查点导出持有业务连接锁，不能在回调里再次回查同一连接。
                // 没有显式会话字段的墓碑 / 未知表使用稳定的行单位分组即可。
                let conversation = Self::snapshot_conversation_of(&op)
                    .unwrap_or_else(|| format!("__rows:{}:{}", op.table, op.id));
                let bytes = serde_json::to_vec(&op)
                    .map_err(|e| AppError::Other(format!("序列化快照行失败：{e}")))?
                    .len()
                    + 1;
                let entry = units
                    .entry((db.name.to_string(), conversation.clone()))
                    .or_insert_with(|| SnapshotUnit {
                        db: db.name,
                        conversation,
                        updated_at: String::new(),
                        ops: Vec::new(),
                        bytes: 0,
                    });
                entry.bytes += bytes;
                entry.ops.push(op);
                Ok(())
            };
            db.handle
                .for_each_checkpoint_op(&self.device, &self.aliases, &mut collect)?;
        }
        if units.is_empty() {
            return Ok(None);
        }
        let mut units: Vec<SnapshotUnit> = units.into_values().collect();
        for unit in &mut units {
            unit.updated_at = Self::unit_marker(&unit.ops)
                .map(|(_, updated)| updated)
                .unwrap_or_default();
        }
        units.sort_by(|a, b| {
            a.db.cmp(b.db)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.conversation.cmp(&b.conversation))
        });
        struct PartBuild {
            db: &'static str,
            units: Vec<usize>,
            bytes: usize,
        }
        let mut parts: Vec<PartBuild> = Vec::new();
        for (i, unit) in units.iter().enumerate() {
            let need_new = match parts.last() {
                None => true,
                Some(part) => {
                    part.db != unit.db
                        || part.bytes > 0
                            && (part.bytes + unit.bytes > PART_TARGET_BYTES
                                || cfg!(test) && part.bytes + unit.bytes > 128 * 1024)
                }
            };
            if need_new {
                parts.push(PartBuild {
                    db: unit.db,
                    units: Vec::new(),
                    bytes: 0,
                });
            }
            let part = parts.last_mut().expect("上面刚保证有一个");
            part.units.push(i);
            part.bytes += unit.bytes;
        }
        let mut files = BTreeMap::new();
        let mut manifest_parts = Vec::new();
        for (index, part) in parts.iter().enumerate() {
            let index = index as u32;
            let ops = part
                .units
                .iter()
                .flat_map(|i| units[*i].ops.iter().cloned())
                .collect::<Vec<_>>();
            let plain = encode_ops(&self.device, part.db, &ops)?;
            manifest_parts.push(SnapshotManifestPart {
                index,
                bytes: plain.len() as u64,
                sealed_bytes: 0,
                plain_sha256: super::sha256_hex(&plain),
                sealed_sha256: String::new(),
            });
            files.insert(format!("part-{index:04}.msync"), plain);
        }
        let manifest = SnapshotManifest {
            format: 1,
            kind: "conv-checkpoint".to_string(),
            device: self.device.clone(),
            seq: self.state.seq,
            parts: manifest_parts,
        };
        files.insert(
            "manifest.msync".to_string(),
            serde_json::to_vec(&manifest)
                .map_err(|e| AppError::Other(format!("序列化对话检查点清单失败：{e}")))?,
        );
        Ok(Some(StreamSnapshot {
            files,
            total_items: units.len(),
            publication: SnapshotPublication::CommittedManifest,
        }))
    }
}

/// 单个检查点的密文暂存上限。日常增量不受它影响；超大库仍可沿增量链加入。
const MAX_STAGED_SNAPSHOT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 同时预取的网络请求数。合并始终按清单顺序，预取不改变父子行与墓碑语义。
const SNAPSHOT_PREFETCH: usize = 2;

fn staging_dir(base: &std::path::Path, manifest_sha256: &str) -> PathBuf {
    base.join("checkpoint-cache").join(&manifest_sha256[..16])
}

fn cached_part_path(
    base: &std::path::Path,
    manifest_sha256: &str,
    part: u32,
) -> PathBuf {
    staging_dir(base, manifest_sha256).join(format!("part-{part:04}.msync"))
}

fn remove_staging(base: &std::path::Path, manifest_sha256: &str) {
    if manifest_sha256.len() >= 16 && manifest_sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
        let path = staging_dir(base, manifest_sha256);
        if let Err(e) = std::fs::remove_dir_all(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("同步：清理检查点暂存失败: {e}");
            }
        }
    }
}

fn decode_cached_part(
    remote: &dyn StreamRemote,
    seq: u64,
    part: &SnapshotManifestPart,
    sealed: &[u8],
) -> Result<Vec<u8>, AppError> {
    if sealed.len() as u64 != part.sealed_bytes
        || super::sha256_hex(sealed) != part.sealed_sha256
    {
        return Err(AppError::Other(format!(
            "对话检查点第 {} 包的密文摘要不匹配。",
            part.index
        )));
    }
    let plain = remote.open(StreamFileKind::SnapshotPart, seq, Some(part.index), sealed)?;
    if plain.len() as u64 != part.bytes || super::sha256_hex(&plain) != part.plain_sha256 {
        return Err(AppError::Other(format!(
            "对话检查点第 {} 包的内容摘要不匹配。",
            part.index
        )));
    }
    let parsed = rows::parse_segment(&plain)?;
    if parsed.device.as_deref() != Some(remote.peer()) || parsed.stream.as_deref() != Some(CONV_STREAM)
    {
        return Err(AppError::Other("对话检查点的分包身份与清单不一致。".into()));
    }
    Ok(plain)
}

impl ConvStreamDriver {
    fn snapshot_cache_root(&self) -> Option<PathBuf> {
        self.path.parent().map(std::path::Path::to_path_buf)
    }

    /// 新快照先暂存密文，完整校验后按库、按清单顺序合并。
    async fn apply_committed_snapshot(
        &mut self,
        remote: &dyn StreamRemote,
        seq: u64,
    ) -> Result<SnapshotApplied, AppError> {
        let root = self
            .snapshot_cache_root()
            .ok_or_else(|| AppError::Other("同步状态目录不可用，无法暂存检查点".into()))?;
        let dir = format::committed_snapshot_dir(remote.peer(), seq);
        let Some(sealed_manifest) = remote.get(&format!("{dir}/manifest.msync")).await? else {
            // 包正在上传时不存在提交清单：既不是损坏，也绝不是应用成功。
            return Ok(SnapshotApplied::Incomplete);
        };
        let manifest_plain = remote.open(
            StreamFileKind::SnapshotIndex,
            seq,
            None,
            &sealed_manifest,
        )?;
        let manifest_sha256 = super::sha256_hex(&manifest_plain);
        let manifest: SnapshotManifest = serde_json::from_slice(&manifest_plain)
            .map_err(|e| AppError::Other(format!("对话检查点清单无法解析：{e}")))?;
        super::validate_snapshot_manifest(&manifest, remote.peer(), seq)?;
        let staged_bytes = manifest.parts.iter().map(|p| p.sealed_bytes).sum::<u64>();
        if staged_bytes > MAX_STAGED_SNAPSHOT_BYTES {
            return Err(AppError::Other(
                "这份检查点超过了本机暂存上限；请先沿增量段同步，或腾出足够空间后重试。".into(),
            ));
        }
        if self
            .persisted
            .resume
            .get(remote.peer())
            .is_some_and(|r| r.seq != seq || r.manifest_sha256 != manifest_sha256)
        {
            if let Some(old) = self.persisted.resume.remove(remote.peer()) {
                remove_staging(&root, &old.manifest_sha256);
                self.save_state()?;
            }
        }
        if !self.persisted.resume.contains_key(remote.peer()) {
            self.persisted.resume.insert(
                remote.peer().to_string(),
                SnapshotResume {
                    peer: remote.peer().to_string(),
                    seq,
                    manifest_sha256: manifest_sha256.clone(),
                    manifest: manifest.clone(),
                    ready_parts: BTreeSet::new(),
                },
            );
            self.save_state()?;
        }
        let total = manifest.parts.len();
        self.report_progress(StreamProgress::parts(
            0,
            total,
            "正在校验对话快照",
            Some((0, staged_bytes)),
        ));

        // 重启后先复核磁盘中的包。即使上次写完密文、尚未来得及写 readyParts，也能安全复用。
        let mut verified = BTreeSet::new();
        for part in &manifest.parts {
            let path = cached_part_path(&root, &manifest_sha256, part.index);
            if let Ok(sealed) = std::fs::read(&path) {
                if decode_cached_part(remote, seq, part, &sealed).is_ok() {
                    verified.insert(part.index);
                } else {
                    let _ = std::fs::remove_file(path);
                }
            }
        }
        if let Some(resume) = self.persisted.resume.get_mut(remote.peer()) {
            resume.ready_parts = verified.clone();
        }
        self.save_state()?;

        let missing = manifest
            .parts
            .iter()
            .filter(|p| !verified.contains(&p.index))
            .cloned()
            .collect::<Vec<_>>();
        if !missing.is_empty() {
            let received = manifest
                .parts
                .iter()
                .filter(|part| verified.contains(&part.index))
                .map(|part| part.sealed_bytes)
                .sum();
            self.report_progress(StreamProgress::parts(
                total - missing.len(),
                total,
                "正在下载对话快照",
                Some((received, staged_bytes)),
            ));
        }
        let dir = dir.clone();
        let downloads = futures::stream::iter(missing.into_iter().map(|part| {
            let dir = dir.clone();
            async move {
                let path = format!("{dir}/part-{:04}.msync", part.index);
                let Some(sealed) = remote.get(&path).await? else {
                    return Err(AppError::Other(format!(
                        "对话检查点缺少第 {} 个分包。",
                        part.index
                    )));
                };
                // 在落盘前先验密文与明文身份，坏包不能进入已验证集合。
                let plain = decode_cached_part(remote, seq, &part, &sealed)?;
                let _ = plain;
                Ok::<_, AppError>((part, sealed))
            }
        }))
        .buffered(SNAPSHOT_PREFETCH);
        futures::pin_mut!(downloads);
        while let Some((part, sealed)) = downloads.try_next().await? {
            let path = cached_part_path(&root, &manifest_sha256, part.index);
            atomic_write_bytes(&path, &sealed)
                .map_err(|e| AppError::Other(format!("保存检查点暂存包失败：{e}")))?;
            if let Some(resume) = self.persisted.resume.get_mut(remote.peer()) {
                resume.ready_parts.insert(part.index);
            }
            self.save_state()?;
            let done = self
                .persisted
                .resume
                .get(remote.peer())
                .map(|r| r.ready_parts.len())
                .unwrap_or(0);
            let received = self
                .persisted
                .resume
                .get(remote.peer())
                .map(|resume| {
                    manifest
                        .parts
                        .iter()
                        .filter(|part| resume.ready_parts.contains(&part.index))
                        .map(|part| part.sealed_bytes)
                        .sum()
                })
                .unwrap_or(0);
            self.report_progress(StreamProgress::parts(
                done,
                total,
                "正在下载对话快照",
                Some((received, staged_bytes)),
            ));
        }

        self.report_progress(StreamProgress::parts(
            0,
            total,
            "正在校验并写入对话",
            Some((staged_bytes, staged_bytes)),
        ));
        let mut grouped: BTreeMap<String, Vec<RowOp>> = BTreeMap::new();
        for part in &manifest.parts {
            let path = cached_part_path(&root, &manifest_sha256, part.index);
            let sealed = std::fs::read(&path)
                .map_err(|e| AppError::Other(format!("读取检查点暂存包失败：{e}")))?;
            let plain = decode_cached_part(remote, seq, part, &sealed)?;
            let parsed = rows::parse_segment(&plain)?;
            self.observe_ops(&parsed.ops);
            grouped
                .entry(parsed.db_or_default().to_string())
                .or_default()
                .extend(parsed.ops);
        }
        let mut changed_ids = Vec::new();
        for (db_name, ops) in grouped {
            let db = self.database(&db_name)?.clone();
            let mut pass = Vec::new();
            for op in ops {
                if op.del && op.table == "conversations" {
                    self.deleted.insert(op.id.clone());
                }
                let running = self
                    .conversation_of(&db, &op)
                    .is_some_and(|id| self.is_running(&id));
                if running {
                    self.persisted.deferred.push(DeferredOp {
                        db: db_name.clone(),
                        op,
                    });
                } else {
                    pass.push(op);
                }
            }
            let applied = db.handle.apply_ops(&pass, &self.aliases)?;
            self.landing.merge(&applied);
            for id in applied.conversation_ids {
                if !changed_ids.contains(&id) {
                    changed_ids.push(id);
                }
            }
        }
        // resume 保留到引擎把正式游标刷入账本；ack_snapshot 才清暂存。
        self.save_state()?;
        self.snapshot_finished = true;
        let progress = StreamProgress::parts(
            total,
            total,
            "对话快照已校验并写入",
            Some((staged_bytes, staged_bytes)),
        );
        self.progress = Some(progress.clone());
        self.report_progress(progress.clone());
        Ok(SnapshotApplied::Complete(StreamApplied {
            changed: !changed_ids.is_empty(),
            conversation_ids: changed_ids,
            progress: Some(progress),
        }))
    }
}



#[async_trait]
impl StreamDriver for ConvStreamDriver {
    fn name(&self) -> StreamName {
        StreamName::Conv
    }

    fn state(&self) -> StreamState {
        self.state.clone()
    }

    fn set_state(&mut self, state: StreamState) {
        self.state = state;
    }

    fn set_data_key(&mut self, dk: &DataKey) {
        self.dk = Some(dk.clone());
    }

    fn set_backend(&mut self, backend: Arc<dyn crate::sync::backends::Backend>) {
        self.backend = Some(backend);
    }

    fn snapshot_layout(&self) -> StreamSnapshotLayout {
        StreamSnapshotLayout::Directory
    }

    async fn capture(&mut self) -> Result<Vec<Vec<u8>>, AppError> {
        // 图片 blob：本机新消息引用的图片先传上去（懒加载的另一半在这里）。
        // 失败只记日志：图片传不上去不该拦住消息本身同步（消息里有 `rel` 但没有 blob 时，
        // 对端会显示「在另一台设备上，暂时取不到」，下一轮还会补传）。
        if let (Some(dk), Some(backend)) = (self.dk.clone(), self.backend.clone()) {
            if let Err(e) = self.upload_pending_images(&backend, &dk).await {
                log::warn!("同步：上传对话图片失败（下一轮再试）: {e}");
            }
        }
        // 先重放挂起的 op：任务结束后要尽快让别人看到它的改动，而不是等下一轮。
        let replayed = self.replay_deferred()?;
        self.landing.merge(&replayed);
        // 用户拒绝了大量删除：把那些墓碑从 changelog 里摘掉，别一直卡着后面的改动。
        self.drop_gated_rows()?;

        let wall = self.wall();
        let release = self.persisted.release_gated;
        let mut segments = Vec::new();
        let mut watermarks = BTreeMap::new();
        let mut gated: Vec<HeldRow> = Vec::new();
        for db in &self.databases {
            let mut options = CaptureOptions::new(CONV_STREAM).with_db(db.name);
            options.release_held = release;
            options.max_segment_bytes = DEFAULT_MAX_SEGMENT_BYTES;
            let captured =
                db.handle
                    .capture(&mut self.clock, &self.device, wall, &self.aliases, options)?;
            segments.extend(captured.segments);
            watermarks.insert(db.name.to_string(), captured.watermark);
            gated.extend(captured.held);
        }
        self.persisted.watermarks = watermarks;
        if release {
            // 放行后这一批墓碑会随下面上传的段发出去，ack 之后闸门才算真正清空。
            self.persisted.gated.clear();
            self.persisted.release_gated = false;
        } else {
            self.persisted.gated = gated.into_iter().map(GatedRow::from).collect();
        }
        self.ui.write().gated = self.persisted.gated.len();
        self.save_state()?;
        Ok(segments)
    }

    async fn ack_capture(&mut self) -> Result<(), AppError> {
        let watermarks = std::mem::take(&mut self.persisted.watermarks);
        let mut failed = BTreeMap::new();
        let mut last_error: Option<AppError> = None;
        for (db_name, watermark) in watermarks {
            match self.database(&db_name) {
                Ok(db) => match db.handle.ack(watermark) {
                    Ok(()) => {}
                    Err(e) => {
                        failed.insert(db_name, watermark);
                        last_error = Some(e);
                    }
                },
                Err(e) => {
                    failed.insert(db_name, watermark);
                    last_error = Some(e);
                }
            }
        }
        self.persisted.watermarks = failed;
        self.save_state()?;
        match last_error {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }

    async fn export_full(&mut self) -> Result<Vec<Vec<u8>>, AppError> {
        let mut segments = Vec::new();
        for db in &self.databases {
            segments.extend(db.handle.export_all(&self.device, &self.aliases)?);
        }
        Ok(segments)
    }

    async fn apply_segment(&mut self, plain: &[u8]) -> Result<StreamApplied, AppError> {
        let applied = self.absorb_segment(plain)?;
        self.landing.merge(&applied);
        // 真正的落地结果由 `land()` 统一报给引擎（这一层不能假设引擎随后一定会调
        // `land()`，所以只在这里攒着）。
        Ok(StreamApplied::default())
    }

    async fn land(&mut self) -> Result<StreamApplied, AppError> {
        self.land_inner()
    }

    async fn make_snapshot(&mut self) -> Result<Option<StreamSnapshot>, AppError> {
        self.build_snapshot()
    }

    async fn ack_snapshot(&mut self, peer: &str, seq: u64) -> Result<(), AppError> {
        if self
            .persisted
            .resume
            .get(peer)
            .is_some_and(|r| r.seq == seq)
        {
            let resume = self.persisted.resume.remove(peer).expect("刚检查过");
            if let Some(root) = self.snapshot_cache_root() {
                remove_staging(&root, &resume.manifest_sha256);
            }
            self.save_state()?;
        }
        Ok(())
    }

    async fn apply_snapshot(
        &mut self,
        remote: &dyn StreamRemote,
        index_seq: u64,
    ) -> Result<SnapshotApplied, AppError> {
        let checkpoint = format!(
            "{}/manifest.msync",
            format::committed_snapshot_dir(remote.peer(), index_seq)
        );
        if remote.get(&checkpoint).await?.is_some() {
            return self.apply_committed_snapshot(remote, index_seq).await;
        }
        let dir = format::snapshot_dir(remote.peer(), RemoteStream::Conv, index_seq);
        let index_path = format!("{dir}/index.msync");
        let Some(bytes) = remote.get(&index_path).await? else {
            // 列出来又读不到：这不是一份已完成的快照。
            return Ok(SnapshotApplied::Incomplete);
        };
        let plain = remote.open(StreamFileKind::SnapshotIndex, index_seq, None, &bytes)?;
        let index: ConvSnapshotIndex = serde_json::from_slice(&plain)
            .map_err(|e| AppError::Other(format!("对话快照索引无法解析：{e}")))?;
        if !index.conversations.is_empty() && index.parts.is_empty() {
            return Err(AppError::Other(
                "对话快照索引里没有分包，无法落地。请让另一台设备重新同步一次。".into(),
            ));
        }

        // 从新到旧：新会话先可见，用户切到最近聊过的对话时它已经在本地了。
        let mut order: Vec<&ConvIndexEntry> = index.conversations.iter().collect();
        order.sort_by(|a, b| {
            b.updated_at
                .cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });

        let mut part_order: Vec<u32> = Vec::new();
        for entry in &order {
            for part in &entry.parts {
                if !part_order.contains(part) {
                    part_order.push(*part);
                }
            }
        }
        let total = index.conversations.len();

        let mut landed_parts: BTreeSet<u32> = BTreeSet::new();
        let mut changed_ids: Vec<String> = Vec::new();
        for part in part_order {
            let path = format!("{dir}/part-{part:04}.msync");
            let Some(bytes) = remote.get(&path).await? else {
                return Err(AppError::Other(format!(
                    "对话快照缺少第 {part} 个分包，请让另一台设备重新同步一次。"
                )));
            };
            let plain = remote.open(StreamFileKind::SnapshotPart, index_seq, Some(part), &bytes)?;
            let applied = self.absorb_segment(&plain)?;
            self.landing.merge(&applied);
            // 每落一包立刻落地一次：前端能看到「对话正在一个个出现」，而不是等全部
            // 下载完才出现；也避免一个坏包把前面已经下好的全部回滚。
            let landed = self.land_inner()?;
            for id in landed.conversation_ids {
                if !changed_ids.contains(&id) {
                    changed_ids.push(id);
                }
            }
            landed_parts.insert(part);
            let done = order
                .iter()
                .filter(|e| e.parts.iter().all(|p| landed_parts.contains(p)))
                .count();
            let progress = StreamProgress {
                done,
                total,
                label: "正在同步对话".to_string(),
                bytes_done: None,
                bytes_total: None,
            };
            self.progress = Some(progress.clone());
            // 立刻推给引擎：前端要看到「正在同步对话 3 / 12」在涨。
            self.report_progress(progress);
        }

        self.snapshot_finished = true;
        Ok(SnapshotApplied::Complete(StreamApplied {
            changed: !changed_ids.is_empty(),
            conversation_ids: changed_ids,
            progress: self.progress.clone(),
        }))
    }
}

/// 从「待落地队列」文件路径反推配置目录（`<config>/sync/conv_pending.json` → `<config>`）。
fn config_dir_for(pending_path: &std::path::Path) -> PathBuf {
    pending_path
        .parent() // sync/
        .and_then(|p| p.parent()) // <config>/
        .map(|p| p.to_path_buf())
        .unwrap_or_default()
}

impl ConvStreamDriver {
    /// 引擎在拿到 DK / 后端之后注入（图片 blob 上传要用）。
    pub fn with_blobs(
        mut self,
        dk: Option<DataKey>,
        backend: Option<Arc<dyn crate::sync::backends::Backend>>,
    ) -> Self {
        self.dk = dk;
        self.backend = backend;
        self
    }

    /// 把本机新消息引用的图片传成 blob，并把 `(rel, blob, device)` 记进 `synced_images_json`。
    ///
    /// 「新」的判据：`synced_images_json` 还是 NULL 且有 `image_paths_json` 的消息。
    /// 已经登记过的跳过（同一条消息的图片只传一次）。
    async fn upload_pending_images(
        &mut self,
        backend: &Arc<dyn crate::sync::backends::Backend>,
        dk: &DataKey,
    ) -> Result<(), AppError> {
        use crate::agent::image_store;
        use crate::sync::blob::{upload_blob, BlobLedger};

        // 只有带消息表的那个库有图片。
        let Some(db) = self
            .databases
            .iter()
            .find(|d| d.tables.iter().any(|t| t.name == "messages"))
        else {
            return Ok(());
        };
        let rows = db.handle.pending_synced_images()?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut ledger = BlobLedger::load(&self.config_dir);
        for (message_id, rels) in rows {
            let mut entries: Vec<serde_json::Value> = Vec::new();
            for rel in rels {
                let bytes = match image_store::read_image_bytes(&rel) {
                    Ok(b) => b,
                    Err(_) => continue, // 本机也没这张图了（被删）：跳过
                };
                let (name, _) = upload_blob(backend, &mut ledger, dk, &self.device, &bytes).await?;
                entries.push(serde_json::json!({
                    "rel": rel,
                    "blob": name,
                    "device": self.device,
                }));
            }
            if !entries.is_empty() {
                let json = serde_json::to_string(&entries)
                    .map_err(|e| AppError::Config(format!("序列化图片引用失败：{e}")))?;
                db.handle.set_synced_images(&message_id, &json)?;
            }
        }
        Ok(())
    }

    /// 中途报告进度（没有注入回调时什么都不做：测试里不需要）。
    fn report_progress(&self, progress: StreamProgress) {
        if let Some(report) = &self.progress_reporter {
            report(StreamName::Conv, progress);
        }
    }
}

#[cfg(test)]
impl ConvStreamDriver {
    /// 测试用：当前快照进度（`apply_snapshot` 内部每落一包更新一次）。
    pub(crate) fn test_progress(&self) -> Option<StreamProgress> {
        self.progress.clone()
    }
}
