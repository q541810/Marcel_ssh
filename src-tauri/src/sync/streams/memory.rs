//! 记忆库接入同步（三期 T4）：把 `memory.db` 的表清单登记进「对话与记忆」流。
//!
//! 「对话与记忆」是同一条流（`devices/<id>/conv/`），但数据落在两个独立的 SQLite 文件里
//! （`conversations.db` 与 `memory.db`），而 `rows::apply` 只能在一个库的一个事务里跑。
//! 所以 T2 的驱动按「库」组合：这里只提供一个 [`ConvDatabase`] 与它的 [`ConvDbHandle`]，
//! **驱动代码一行都不用改**。
//!
//! 哪些表同步、哪些不同步（契约第 11 节）：
//!
//! | 表 | 同步 | 说明 |
//! |---|---|---|
//! | `memories` | 是 | `is_new` / `version` 是每台设备自己的（Local） |
//! | `memory_rejections` | 是 | 用户拒绝过的记忆，别的设备也别再提 |
//! | `reflection_progress` | 是，**特殊合并** | 取 `anchor_created_at` 更晚的，不是后写者赢 |
//! | `reflection_notes` | 是 | 跟着会话走 |
//! | `memory_ops` / `memory_snapshots` / `scope_versions` / `meta` | 否 | 本机派生 / 缓存 |
//!
//! `scope_versions` 不同步，但**落地后要重算**：它决定记忆注入的快照要不要重渲染。
//! 别的设备改了记忆、本机不 bump 的话，下一次 Agent 请求还会用旧快照——这是「同步了但用不上」。

use std::collections::BTreeSet;
use std::sync::Arc;

use super::super::core::HlcClock;
use super::super::rows::{
    apply, capture, export_all, pending_count, AliasMap, CaptureOptions, CapturedRows, ColumnScope,
    RowApplied, RowColumn, RowMerge, RowTable,
};
use super::conv::{ConvDatabase, ConvDbHandle};
use crate::error::AppError;
use crate::memory::store::MemoryStore;

/// `memory.db` 在段 JSON 里的库名。
pub const MEMORY_DB_NAME: &str = "memory";

const fn shared(name: &'static str) -> RowColumn {
    RowColumn {
        name,
        scope: ColumnScope::Shared,
    }
}

const fn local(name: &'static str) -> RowColumn {
    RowColumn {
        name,
        scope: ColumnScope::Local,
    }
}

/// `memory.db` 的同步表清单。
///
/// `memory_rejections` 的自增 id 不能跨设备用，所以迁移时加了 `uid` 并以它为主键
/// （见 `memory/store.rs` 的 `uid` 迁移）。
pub static MEMORY_TABLES: &[RowTable] = &[
    RowTable {
        name: "memories",
        pk: "id",
        columns: &[
            shared("id"),
            shared("scope"),
            shared("scope_key"),
            shared("kind"),
            shared("title"),
            shared("content"),
            shared("pinned"),
            shared("source"),
            shared("source_conversation_id"),
            shared("source_message_id"),
            shared("created_at"),
            shared("updated_at"),
            // `version` 是本机的乐观并发计数：两台设备各自 +1 会互相打架，
            // 顺序由 HLC 保证，所以不同步。
            local("version"),
            // 「新」标记是每台设备各自的未读状态：手机上没看过的记忆不该因为在
            // 电脑上看过就变成已读。
            local("is_new"),
        ],
        parent: None,
        // 主机作用域的 `scope_key` 是连接 id：加入同步时连接去重会换名。
        alias: super::super::rows::AliasColumn::ScopeKey,
        // 一轮删掉 50 条以上记忆先扣住：一次误删一整个作用域的记忆很难恢复。
        mass_delete_limit: 50,
        merge: RowMerge::Lww,
    },
    RowTable {
        name: "memory_rejections",
        pk: "uid",
        columns: &[
            // 自增 id 是每台设备自己的（同步以 `uid` 为身份），登记成 Local 让守护测试闭嘴、
            // 也让落地时不覆盖本机值。
            local("id"),
            shared("uid"),
            shared("scope"),
            shared("scope_key"),
            shared("title"),
            shared("content"),
            shared("created_at"),
        ],
        parent: None,
        alias: super::super::rows::AliasColumn::None,
        mass_delete_limit: 0,
        merge: RowMerge::Lww,
    },
    RowTable {
        name: "reflection_progress",
        pk: "conversation_id",
        columns: &[
            shared("conversation_id"),
            shared("anchor_message_id"),
            shared("anchor_created_at"),
            shared("updated_at"),
        ],
        parent: None,
        alias: super::super::rows::AliasColumn::None,
        mass_delete_limit: 0,
        // **不是后写者赢**：复盘进度必须「谁看得更远听谁的」，否则两台设备会把同一段
        // 对话各复盘一遍，产出重复记忆。
        merge: RowMerge::LatestBy("anchor_created_at"),
    },
    RowTable {
        name: "reflection_notes",
        pk: "id",
        columns: &[
            shared("id"),
            shared("conversation_id"),
            shared("anchor_message_id"),
            shared("batch_id"),
            shared("intro"),
            shared("created_at"),
        ],
        parent: None,
        alias: super::super::rows::AliasColumn::None,
        mass_delete_limit: 0,
        merge: RowMerge::Lww,
    },
];

/// 把 [`MemoryStore`] 包成 [`ConvDbHandle`]。
///
/// `MemoryStore` 自己持有一把 `Mutex<Connection>`，这里直接转发给它——同步的读写和业务
/// 读写共用同一把锁，不另开连接（T1 的规矩：只有调过 `install` 的那条连接上的写入才会被捕获）。
pub struct MemoryHandle {
    store: Arc<MemoryStore>,
}

impl MemoryHandle {
    pub fn new(store: Arc<MemoryStore>) -> Self {
        Self { store }
    }
}

impl ConvDbHandle for MemoryHandle {
    fn capture(
        &self,
        clock: &mut HlcClock,
        device: &str,
        wall_ms: u64,
        aliases: &AliasMap,
        options: CaptureOptions,
    ) -> Result<CapturedRows, AppError> {
        self.store
            .sync_capture(clock, device, wall_ms, aliases, MEMORY_TABLES, options)
    }

    fn ack(&self, watermark: i64) -> Result<(), AppError> {
        self.store.sync_ack(watermark)
    }

    fn apply(&self, ops: &[u8], aliases: &AliasMap) -> Result<RowApplied, AppError> {
        self.store.sync_apply(ops, aliases, MEMORY_TABLES)
    }

    fn export_all(&self, device: &str, aliases: &AliasMap) -> Result<Vec<Vec<u8>>, AppError> {
        self.store
            .sync_export_all(device, aliases, MEMORY_TABLES, MEMORY_DB_NAME)
    }

    fn pending_count(&self) -> Result<usize, AppError> {
        self.store.sync_pending_count(MEMORY_TABLES)
    }

    fn after_land(&self, applied: &RowApplied) -> Result<(), AppError> {
        // 记忆库特有的善后：`scope_versions` 不同步，但落地后必须 bump，
        // 否则 `inject` 的冻结快照指纹不变，下一轮 Agent 用的还是旧记忆。
        let scopes = touched_scopes_after_apply(&self.store, applied)?;
        if !scopes.is_empty() {
            self.store.bump_scope_versions_for(&scopes)?;
        }
        Ok(())
    }
}

/// 造一个可以直接 `push` 进 `ConvStreamFactory::databases` 的登记项。
pub fn memory_database(store: Arc<MemoryStore>) -> ConvDatabase {
    ConvDatabase {
        name: MEMORY_DB_NAME,
        tables: MEMORY_TABLES,
        handle: Arc::new(MemoryHandle::new(store)),
    }
}

/// 落地之后要 bump 的作用域。
///
/// 行同步层只回报「哪些表变了」，不逐行给 `(scope, scope_key)`（那是记忆库自己的知识）。
/// 所以这里直接问库：记忆库这几轮落地后所有**用户可见行**的作用域都 bump 一遍。
/// 少量多余 bump 的代价只是「注入快照重渲染一次」，比「新记忆用不上」便宜得多。
pub fn touched_scopes_after_apply(
    store: &MemoryStore,
    applied: &RowApplied,
) -> Result<Vec<(String, String)>, AppError> {
    if !applied
        .changed_tables
        .iter()
        .any(|t| t == "memories" || t == "memory_rejections")
    {
        return Ok(Vec::new());
    }
    store.list_all_scopes_for_sync()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 表清单的守护：列有增减或作用域改动就变红（照 T1 的 `scope_guard` 思路）。
    ///
    /// 更新快照：`UPDATE_SYNC_SNAPSHOT=1 cargo test --lib sync::streams::memory`
    #[test]
    fn memory_tables_declare_every_column_of_every_synced_table() {
        let store = MemoryStore::in_memory();
        let live = store.table_columns_for_sync().expect("读表结构");
        let mut declared: BTreeSet<(String, String)> = BTreeSet::new();
        for table in MEMORY_TABLES {
            for col in table.columns {
                declared.insert((table.name.to_string(), col.name.to_string()));
            }
        }
        let mut actual: BTreeSet<(String, String)> = BTreeSet::new();
        for table in MEMORY_TABLES {
            let cols = live
                .get(table.name)
                .unwrap_or_else(|| panic!("同步表清单里的 {} 在库里不存在", table.name));
            for c in cols {
                actual.insert((table.name.to_string(), c.clone()));
            }
        }
        assert_eq!(
            declared, actual,
            "记忆库的这些表里有列没进同步清单（或多登记了不存在的列）：加列时必须在 \
             `MEMORY_TABLES` 里表态它是 Shared 还是 Local"
        );
    }

    /// 不该同步的表一列都不该出现在清单里（它们是本机派生 / 缓存）。
    #[test]
    fn derived_tables_are_not_in_the_sync_list() {
        for name in ["memory_ops", "memory_snapshots", "scope_versions", "meta"] {
            assert!(
                !MEMORY_TABLES.iter().any(|t| t.name == name),
                "{name} 是本机派生的，不该同步"
            );
        }
    }
}
