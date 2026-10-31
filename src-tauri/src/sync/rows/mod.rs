//! SQLite 按行同步通用模块（二期 / 三期公共底座）。
//!
//! 对话库（`conversations.db`）与记忆库（`memory.db`）都是 SQLite：几千条会话、几万条消息。
//! 沿用一期的「整份 JSON 扁平化 + diff」每轮都要序列化整个库，开销和数据量成正比；这一层
//! 改成**按行后写者赢**：
//!
//! ```text
//!   业务写入 ──触发器──▶ sync_changelog(seq, tbl, row_id, op)
//!                              │ capture：按行合并、读当前值、发 HLC
//!                              ▼
//!                      段明文 JSON（rows）── 引擎加密上传
//!                              │ apply：比每行时钟，事务内落地（触发器被 temp.sync_applying 抑制）
//!                              ▼
//!                        业务表 + sync_row_clock(tbl,row_id,hlc,deleted,extra_json)
//! ```
//!
//! 几条不能破的规矩（每个使用方都要遵守）：
//!
//! - **每次打开数据库都要调 [`install`]**。触发器是**连接级临时触发器**（`CREATE TEMP TRIGGER`）：
//!   SQLite 不允许持久触发器引用 `temp` 库的对象（`trigger … cannot reference objects in
//!   database temp`），而落地抑制标记必须是连接级的 `temp.sync_applying`（否则一台设备落地时
//!   会把标记写进共享的库文件，别的连接/别的进程就再也捕获不到自己的改动了）。代价是
//!   **只有调过 `install` 的那条连接上的写入才会被捕获**——使用方必须让业务写入与同步共用
//!   同一条连接（T2 / T4 的 `ConversationDb` / `MemoryStore` 本来就是一把锁一条连接）。
//! - **先 capture 再 apply**（同一把连接锁内，和一期「落地前先吸收本机未捕获的改动」同一条
//!   规矩）：否则远端 op 可能盖掉本机刚改、还没拿到 HLC 的那一版。
//! - **业务 id 必须跨设备稳定**。触发器记的是 `NEW.<pk>` / `OLD.<pk>`，自增 id 的表要先加一列
//!   UUID 再以它为主键同步（见任务书 T2/T4）。
//! - [`ColumnScope::Local`] 列既不上传、落地时也绝不覆盖。它们必须是可空或有默认值的列，
//!   否则 apply 插入新行时会因为缺列而失败（整条事务回滚，数据不丢，但同步卡住）。
//! - **向前兼容**：本机不认识的列存进 `sync_row_clock.extra_json`，下次本机改这一行时原样带上；
//!   这样老版本不会把新版本加的字段「删掉」，对应一期「和基线比、不和镜像比」那条根基。
//!
//! 本模块不碰任何业务表结构，也不认识具体业务：表清单由使用方（T2 / T4）声明。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::core::hlc::Hlc;

mod apply;
mod capture;
mod export;
mod install;
mod segment;
mod shared;
#[cfg(test)]
mod tests;

pub use apply::{
    apply, apply_ops, apply_ops_with_hook, apply_with_hook, parse_segment_ops, replay_unknown,
    NoHook, RowApplyHook,
};
pub use capture::{ack, capture, capture_with, pending_count, CaptureOptions};
pub use export::{export_all, export_all_with, ExportOptions};
pub use install::{install, ROW_TABLE_VERSION};
pub use segment::{encode_segment, parse_segment, ParsedSegment};
pub use shared::{suppress_capture, with_capture_suppressed, CaptureGuard};

/// 段 JSON 的 `kind`。段头里写死，读到别的 kind 说明这条流的数据被投错了地方。
pub const SEGMENT_KIND: &str = "rows";

/// 单个段的目标上限（序列化后的字节数）。契约给 900 KB：加密信封（deflate + AES-GCM + base64）
/// 之后仍能舒适地落在「单个文件不超过 1 MB」的范围内。
pub const DEFAULT_MAX_SEGMENT_BYTES: usize = 900_000;

// ---------------------------------------------------------------------------
// 表清单
// ---------------------------------------------------------------------------

/// 一列同不同步。`Local` 列既不进段，落地时也不覆盖本机值（本机路径、窗口尺寸这类）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColumnScope {
    Shared,
    Local,
}

/// 表里的一列。`name` 必须与 SQLite 里的列名逐字一致。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RowColumn {
    pub name: &'static str,
    pub scope: ColumnScope,
}

/// 需要连接 id 别名换算的列。
///
/// 变体本身就决定了列名：`ConnectionId` → `connection_id`，`ScopeKey` → `scope_key`。
/// 为什么不做成「列名 + 语义」两个字段：现在只有这两种列，一个表最多一个；真出现第二个时
/// 再加字段，比现在留一对没人填的可选参数清楚。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AliasColumn {
    None,
    ConnectionId,
    ScopeKey,
}

impl AliasColumn {
    /// 需要换算的列名。`None` = 这张表没有别名列。
    ///
    /// 列名由变体本身决定：`ConnectionId` 永远是 `connection_id`（`conversations` 的列），
    /// `ScopeKey` 永远是 `scope_key`（`memories` 的列）。**别把它和 `messages.conversation_id`
    /// 搞混**：那是父表外键，指向的会话 id 本身不需要换算（会话行的 id 是稳定 UUID，
    /// 只有连接 id 会在加入同步时去重换名）。
    pub fn column(self) -> Option<&'static str> {
        match self {
            AliasColumn::None => None,
            AliasColumn::ConnectionId => Some("connection_id"),
            AliasColumn::ScopeKey => Some("scope_key"),
        }
    }
}

/// 同一行的两个版本怎么合并。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RowMerge {
    /// 后写者赢（比较每行 HLC）。绝大多数表。
    Lww,
    /// 比这一列的值（字符串按 RFC3339 字典序），更晚的才应用；落地时仍把时钟记成远端的 HLC。
    /// 只有 `reflection_progress` 用：复盘进度必须「谁看得更远听谁的」，否则两台设备会把同一段
    /// 对话复盘两遍、产出重复记忆。
    LatestBy(&'static str),
}

/// 一张参与同步的表。
#[derive(Clone, Copy, Debug)]
pub struct RowTable {
    /// SQLite 表名。
    pub name: &'static str,
    /// 主键列（必须是 TEXT 稳定 id）。
    pub pk: &'static str,
    /// 参与同步的列。没列进来的列既不上传也不会被覆盖（等价于 `Local`，但更危险：
    /// 落地时插入新行会缺列，所以请显式登记所有列）。
    pub columns: &'static [RowColumn],
    /// `(本表的外键列, 父表名)`。同一批里父行有墓碑时，子行 op 直接丢弃；父行墓碑落地时
    /// 本表里外键指向它的行也会被级联删除（发送方只发一个父墓碑，见任务书第一节第 5 条）。
    pub parent: Option<(&'static str, &'static str)>,
    /// 需要连接 id 别名换算的列。
    pub alias: AliasColumn,
    /// 一轮里本表的墓碑数达到这个值就先扣住、等用户确认。0 = 不设闸。
    pub mass_delete_limit: usize,
    /// 合并策略。
    pub merge: RowMerge,
}

impl RowTable {
    pub fn column(&self, name: &str) -> Option<&RowColumn> {
        self.columns.iter().find(|c| c.name == name)
    }

    /// 这张表要同步的列（`Shared`），按声明顺序。
    pub fn shared_columns(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.columns
            .iter()
            .filter(|c| c.scope == ColumnScope::Shared)
            .map(|c| c.name)
    }
}

// ---------------------------------------------------------------------------
// 别名换算
// ---------------------------------------------------------------------------

/// 连接 id 别名表（旧 id → 新 id）。由使用方从账本 `state.connection_aliases` 造出来，
/// 这里**刻意不依赖 `PersistedState`**：行同步是纯功能层，测试和以后别的调用方都能直接用。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AliasMap {
    map: BTreeMap<String, String>,
}

/// 别名最多跟多少跳。和 `sync::store` 的别名解析同口径：A→B→C 要跟到底，
/// 但 A→B→A 这类环必须在有限步内停下。
const ALIAS_MAX_HOPS: usize = 8;

impl AliasMap {
    pub fn new(map: BTreeMap<String, String>) -> Self {
        Self { map }
    }

    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    /// 换算一个 id：链式跟到底、最多 8 跳、自环直接停。不在表里 = 它自己。
    pub fn resolve(&self, id: &str) -> String {
        let mut cur = id;
        for _ in 0..ALIAS_MAX_HOPS {
            match self.map.get(cur) {
                Some(next) if next != cur => cur = next,
                _ => break,
            }
        }
        cur.to_string()
    }
}

impl From<&BTreeMap<String, String>> for AliasMap {
    fn from(map: &BTreeMap<String, String>) -> Self {
        Self::new(map.clone())
    }
}

impl From<BTreeMap<String, String>> for AliasMap {
    fn from(map: BTreeMap<String, String>) -> Self {
        Self::new(map)
    }
}

// ---------------------------------------------------------------------------
// 段
// ---------------------------------------------------------------------------

/// 段头的身份信息。**段里不写 `seq`**：序号由引擎在封包时分配，并且已经进了文件名与 AAD，
/// 段内再抄一份只会制造「两份对不上」的隐患（同一轮里落地后还会再捕获一次，驱动拿到的
/// 起点序号会过期）。需要排查时看文件名即可。
///
/// `db` 是 conv 流专有字段（`"conversations"` / `"memory"`）：对话与记忆是同一条流，但落在
/// 两个独立的 SQLite 文件里。缺省不写（T2 先落地时保持格式兼容）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SegmentMeta {
    pub stream: &'static str,
    pub db: Option<&'static str>,
}

impl SegmentMeta {
    pub const fn new(stream: &'static str) -> Self {
        Self { stream, db: None }
    }

    pub const fn with_db(self, db: &'static str) -> Self {
        Self {
            stream: self.stream,
            db: Some(db),
        }
    }
}

/// `capture` 的结果。
#[derive(Debug, Default)]
pub struct CapturedRows {
    /// 已序列化的段明文（每段 ≤ `max_segment_bytes`，单行超大时允许单行成段）。
    pub segments: Vec<Vec<u8>>,
    /// 这批处理过的最大 changelog seq，上传成功、账本落盘后拿它调 [`ack`]。
    /// 有墓碑被扣下时会退到「第一个被扣下的 seq - 1」，那些行下一轮重新捕获。
    pub watermark: i64,
    /// 因为超过 `mass_delete_limit` 被扣下的墓碑。**这些行的时钟没有推进、changelog 也没有
    /// ack**：调用方把它们记进账本的 `held.json`，等用户确认后带 `release_held` 再捕获一轮，
    /// 或者直接按本机删会话流程处理掉。
    pub held: Vec<HeldRow>,
    /// 这一批实际产出的 op 数（不含被扣下的）。
    pub captured: usize,
}

/// 一个被大量删除闸扣下的墓碑。只带「哪张表哪一行」：HLC 要等真正放行时才发，
/// 否则扣住期间又改了同一行，会得到一个比改动还旧的墓碑。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HeldRow {
    pub table: String,
    pub row_id: String,
}

/// `apply` 的结果。
#[derive(Debug, Default)]
pub struct RowApplied {
    /// 是否有任何一行的**内容**真的变了（仅推进时钟、墓碑对不存在的行都不算）。
    pub changed: bool,
    /// 内容变了的表名（供日志 / 调试 / 对端事件）。
    pub changed_tables: BTreeSet<String>,
    /// 需要随 `sync-data-applied` 告诉前端的会话 id（去重、有序）。
    pub conversation_ids: Vec<String>,
    /// 实际落地了多少条 op（含内容没变、只推进时钟的）。
    pub applied: usize,
    /// 因为本机没有这张表，整条 op 存进 `sync_row_clock` 等升级后重放的条数。
    pub stored_unknown: usize,
    /// 父行还没到、先暂存起来等父行落地后重放的子行 op 条数（多设备乱序时的正常现象）。
    pub deferred: usize,
    /// 被丢弃了多少条 op（时钟更旧 / 父墓碑压子行 / 父行已删的孤儿）。
    pub skipped: usize,
}

impl RowApplied {
    /// 把另一批结果并进来（父行到达后重放子行、升级后重放未知表都用得上）。
    pub fn merge(&mut self, other: RowApplied) {
        self.changed |= other.changed;
        self.changed_tables.extend(other.changed_tables);
        for id in other.conversation_ids {
            if !self.conversation_ids.contains(&id) {
                self.conversation_ids.push(id);
            }
        }
        self.applied += other.applied;
        self.stored_unknown += other.stored_unknown;
        self.deferred += other.deferred;
        self.skipped += other.skipped;
    }
}

// ---------------------------------------------------------------------------
// 段内 op 的线上形状
// ---------------------------------------------------------------------------

/// 一条行 op。序列化形状与契约第 6 节逐字一致：
///
/// ```json
/// {"t":"messages","id":"...","hlc":{"ms":0,"counter":0,"device":"..."},
///  "cols":{"role":"user"},"extra":{}}
/// {"t":"messages","id":"...","hlc":{...},"del":true}
/// ```
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RowOp {
    #[serde(rename = "t")]
    pub table: String,
    pub id: String,
    pub hlc: Hlc,
    /// 本机认识的 `Shared` 列（`NULL` 也显式带成 `null`，这样「把字段清空」也能同步）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cols: Option<BTreeMap<String, Value>>,
    /// 本机不认识的列（从 `sync_row_clock.extra_json` 原样带回）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extra: Option<BTreeMap<String, Value>>,
    /// 墓碑：整行删除。
    #[serde(default, skip_serializing_if = "is_false")]
    pub del: bool,
}

fn is_false(b: &bool) -> bool {
    !*b
}
