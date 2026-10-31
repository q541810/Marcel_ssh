//! 行同步的单元测试与随机收敛测试。
//!
//! 覆盖任务书列的全部场景：
//! - 插入 / 更新 / 删除的捕获；
//! - 落地不触发捕获；
//! - 新旧时钟比较；
//! - 未知列往返保留、未知表只存不用；
//! - 父墓碑压过旧的子行；
//! - 触发器版本升级；
//! - 崩溃（事务回滚）不丢 changelog；
//! - 大量删除闸（含 ack 水位）；
//! - 别名换算（上传 / 落地两个方向）；
//! - `export_all` 分包；
//! - 三台设备随机收敛。

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde_json::{json, Value};

use super::super::core::hlc::{Hlc, HlcClock};
use super::*;

const DEFAULT_STREAM: &str = "conv";

/// 固定种子的 xorshift64*（同 `core::e2e_tests` 的口径；`core::test_util` 是私有模块，
/// 本模块不能借，复制一份十几行的实现比放开它的可见性更干净）。
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        let mut s = seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) ^ 0xD1B5_4A32_D192_ED03;
        if s == 0 {
            s = 0x1234_5678_9ABC_DEF1;
        }
        let mut r = Rng(s);
        for _ in 0..4 {
            r.next_u64();
        }
        r
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.next_u64() % 100 < percent
    }

    fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len())]
    }

    fn shuffle<T>(&mut self, v: &mut [T]) {
        for i in (1..v.len()).rev() {
            let j = self.below(i + 1);
            v.swap(i, j);
        }
    }
}

// ---------------------------------------------------------------------------
// 测试夹具
// ---------------------------------------------------------------------------

fn conn() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        "
        CREATE TABLE conversations (
            id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL,
            title TEXT NOT NULL,
            local_path TEXT
        );
        CREATE TABLE messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            image_paths_json TEXT,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id)
        );
        CREATE TABLE memories (
            id TEXT PRIMARY KEY,
            scope TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            title TEXT NOT NULL,
            is_new INTEGER NOT NULL DEFAULT 0,
            source_conversation_id TEXT
        );
        CREATE TABLE reflection_progress (
            conversation_id TEXT PRIMARY KEY,
            anchor_message_id TEXT NOT NULL,
            anchor_created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        ",
    )
    .unwrap();
    c
}

static CONV_COLUMNS: &[RowColumn] = &[
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
        name: "local_path",
        scope: ColumnScope::Local,
    },
];

static MESSAGE_COLUMNS: &[RowColumn] = &[
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
        name: "image_paths_json",
        scope: ColumnScope::Local,
    },
];

static MEMORY_COLUMNS: &[RowColumn] = &[
    RowColumn {
        name: "id",
        scope: ColumnScope::Shared,
    },
    RowColumn {
        name: "scope",
        scope: ColumnScope::Shared,
    },
    RowColumn {
        name: "scope_key",
        scope: ColumnScope::Shared,
    },
    RowColumn {
        name: "title",
        scope: ColumnScope::Shared,
    },
    RowColumn {
        name: "is_new",
        scope: ColumnScope::Local,
    },
    RowColumn {
        name: "source_conversation_id",
        scope: ColumnScope::Shared,
    },
];

static PROGRESS_COLUMNS: &[RowColumn] = &[
    RowColumn {
        name: "conversation_id",
        scope: ColumnScope::Shared,
    },
    RowColumn {
        name: "anchor_message_id",
        scope: ColumnScope::Shared,
    },
    RowColumn {
        name: "anchor_created_at",
        scope: ColumnScope::Shared,
    },
    RowColumn {
        name: "updated_at",
        scope: ColumnScope::Shared,
    },
];

static CONVERSATIONS: RowTable = RowTable {
    name: "conversations",
    pk: "id",
    columns: CONV_COLUMNS,
    parent: None,
    alias: AliasColumn::ConnectionId,
    mass_delete_limit: 20,
    merge: RowMerge::Lww,
};

static MESSAGES: RowTable = RowTable {
    name: "messages",
    pk: "id",
    columns: MESSAGE_COLUMNS,
    parent: Some(("conversation_id", "conversations")),
    alias: AliasColumn::None,
    mass_delete_limit: 0,
    merge: RowMerge::Lww,
};

static MEMORIES: RowTable = RowTable {
    name: "memories",
    pk: "id",
    columns: MEMORY_COLUMNS,
    parent: None,
    alias: AliasColumn::ScopeKey,
    mass_delete_limit: 50,
    merge: RowMerge::Lww,
};

static PROGRESS: RowTable = RowTable {
    name: "reflection_progress",
    pk: "conversation_id",
    columns: PROGRESS_COLUMNS,
    parent: None,
    alias: AliasColumn::None,
    mass_delete_limit: 0,
    merge: RowMerge::LatestBy("anchor_created_at"),
};

static TABLES: &[RowTable] = &[CONVERSATIONS, MESSAGES, MEMORIES, PROGRESS];

/// 不带大量删除闸（阈值设成 0）的表清单：方便在不触发闸的情况下测删除。
static NO_GATE_TABLES: &[RowTable] = &[
    RowTable {
        mass_delete_limit: 0,
        ..CONVERSATIONS
    },
    MESSAGES,
    RowTable {
        mass_delete_limit: 0,
        ..MEMORIES
    },
    PROGRESS,
];

fn installed() -> Connection {
    let c = conn();
    install(&c, TABLES).unwrap();
    c
}

fn meta() -> SegmentMeta {
    SegmentMeta::new(DEFAULT_STREAM)
}

fn no_aliases() -> AliasMap {
    AliasMap::default()
}

fn insert_conv(c: &Connection, id: &str, conn_id: &str, title: &str) {
    c.execute(
        "INSERT INTO conversations(id, connection_id, title, local_path) VALUES (?1, ?2, ?3, NULL)",
        rusqlite::params![id, conn_id, title],
    )
    .unwrap();
}

fn capture_ops(c: &Connection, clock: &mut HlcClock, wall: u64, aliases: &AliasMap) -> Vec<RowOp> {
    capture_ops_with(c, TABLES, clock, wall, aliases)
}

fn capture_ops_with(
    c: &Connection,
    tables: &'static [RowTable],
    clock: &mut HlcClock,
    wall: u64,
    aliases: &AliasMap,
) -> Vec<RowOp> {
    let got = capture(c, tables, clock, "A", wall, aliases, DEFAULT_STREAM).unwrap();
    ops_of(&got)
}

fn ops_of(got: &CapturedRows) -> Vec<RowOp> {
    got.segments
        .iter()
        .flat_map(|s| parse_segment(s).unwrap().ops)
        .collect()
}

fn apply_ops(c: &Connection, ops: &[RowOp], aliases: &AliasMap) -> RowApplied {
    let plain = encode_segment(meta(), "B", ops).unwrap();
    apply(c, TABLES, &plain, aliases).unwrap()
}

fn apply_ops_on(c: &Connection, tables: &'static [RowTable], ops: &[RowOp]) -> RowApplied {
    let plain = encode_segment(meta(), "B", ops).unwrap();
    apply(c, tables, &plain, &no_aliases()).unwrap()
}

fn title_of(c: &Connection, id: &str) -> Option<String> {
    c.query_row("SELECT title FROM conversations WHERE id = ?1", [id], |r| {
        r.get(0)
    })
    .ok()
}

fn row_op(table: &str, id: &str, ms: u64, cols: BTreeMap<String, Value>) -> RowOp {
    RowOp {
        table: table.into(),
        id: id.into(),
        hlc: Hlc {
            ms,
            counter: 0,
            device: "B".into(),
        },
        cols: Some(cols),
        extra: None,
        del: false,
    }
}

fn tombstone(table: &str, id: &str, ms: u64) -> RowOp {
    RowOp {
        table: table.into(),
        id: id.into(),
        hlc: Hlc {
            ms,
            counter: 0,
            device: "B".into(),
        },
        cols: None,
        extra: None,
        del: true,
    }
}

// ---------------------------------------------------------------------------
// install / 触发器
// ---------------------------------------------------------------------------

#[test]
fn install_creates_three_triggers_per_table_all_with_the_guard() {
    let c = installed();
    let sql: String = c
        .query_row(
            "SELECT group_concat(sql, char(10)) FROM sqlite_temp_master WHERE type='trigger'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(sql.matches("sync_trg_v1_").count(), TABLES.len() * 3);
    assert_eq!(
        sql.matches("WHEN NOT EXISTS (SELECT 1 FROM temp.\"sync_applying\")")
            .count(),
        TABLES.len() * 3,
        "每个触发器都必须带落地抑制"
    );
    // row_id 必须取稳定 id 列，不能是 rowid
    assert!(sql.contains("NEW.\"id\"") || sql.contains("NEW.id"));
    assert!(!sql.contains("NEW.rowid"));
    // 抑制表在 temp 库；主库里不该有它（否则会跨进程生效）
    let main_tables: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='sync_applying'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(main_tables, 0);
}

#[test]
fn install_generates_unique_trigger_names() {
    let c = installed();
    let names: Vec<String> = {
        let mut stmt = c
            .prepare("SELECT name FROM sqlite_temp_master WHERE type='trigger' ORDER BY name")
            .unwrap();
        let rows = stmt.query_map([], |r| r.get(0)).unwrap();
        rows.collect::<rusqlite::Result<_>>().unwrap()
    };
    let unique: std::collections::BTreeSet<_> = names.iter().collect();
    assert_eq!(unique.len(), names.len());
    assert!(names.contains(&"sync_trg_v1_conversations_ins".to_string()));
    assert!(names.contains(&"sync_trg_v1_messages_del".to_string()));
}

// ---------------------------------------------------------------------------
// 捕获
// ---------------------------------------------------------------------------

#[test]
fn capture_insert_update_delete() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    let aliases = no_aliases();
    let _ = &NO_GATE_TABLES;

    insert_conv(&c, "c1", "srv1", "first");
    let ops = capture_ops(&c, &mut clock, 1000, &aliases);
    assert_eq!(ops.len(), 1);
    assert_eq!(ops[0].table, "conversations");
    assert_eq!(ops[0].id, "c1");
    assert!(!ops[0].del);
    assert_eq!(
        ops[0].cols.as_ref().unwrap().get("title"),
        Some(&json!("first"))
    );
    assert_eq!(ops[0].hlc.ms, 1000);

    c.execute(
        "UPDATE conversations SET title = 'second' WHERE id = 'c1'",
        [],
    )
    .unwrap();
    let ops = capture_ops(&c, &mut clock, 2000, &aliases);
    assert_eq!(ops.len(), 1, "更新只产出一条 op");
    assert_eq!(
        ops[0].cols.as_ref().unwrap().get("title"),
        Some(&json!("second"))
    );
    assert!(ops[0].hlc > Hlc::zero_for("A"));

    c.execute("DELETE FROM conversations WHERE id = 'c1'", [])
        .unwrap();
    let ops = capture_ops(&c, &mut clock, 3000, &aliases);
    assert_eq!(ops.len(), 1);
    assert!(ops[0].del, "删除必须是墓碑");
    assert!(ops[0].cols.is_none());
}

#[test]
fn capture_merges_repeated_changes_to_one_row() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "v1");
    for i in 2..10 {
        c.execute(
            "UPDATE conversations SET title = ?1 WHERE id = 'c1'",
            [format!("v{i}")],
        )
        .unwrap();
    }
    let ops = capture_ops(&c, &mut clock, 1000, &no_aliases());
    assert_eq!(ops.len(), 1, "同一行合并成一条");
    assert_eq!(
        ops[0].cols.as_ref().unwrap().get("title"),
        Some(&json!("v9")),
        "取当前值，不是中间值"
    );
}

#[test]
fn capture_of_insert_then_delete_in_one_batch_is_one_tombstone() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "x");
    c.execute("DELETE FROM conversations WHERE id = 'c1'", [])
        .unwrap();
    let ops = capture_ops(&c, &mut clock, 1000, &no_aliases());
    assert_eq!(ops.len(), 1);
    assert!(
        ops[0].del,
        "最终行不在了就是墓碑，不该发一条已经过时的 upsert"
    );
}

#[test]
fn capture_skips_local_columns() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    c.execute(
        "INSERT INTO conversations(id, connection_id, title, local_path) VALUES ('c1','srv1','t','/local')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO messages(id, conversation_id, role, content, image_paths_json)
         VALUES ('m1','c1','user','hi','[\"/img/a.png\"]')",
        [],
    )
    .unwrap();
    let ops = capture_ops(&c, &mut clock, 1000, &no_aliases());
    let conv = ops.iter().find(|o| o.table == "conversations").unwrap();
    assert!(!conv.cols.as_ref().unwrap().contains_key("local_path"));
    let msg = ops.iter().find(|o| o.table == "messages").unwrap();
    assert!(!msg.cols.as_ref().unwrap().contains_key("image_paths_json"));
    assert_eq!(
        msg.cols.as_ref().unwrap().get("content"),
        Some(&json!("hi"))
    );
}

#[test]
fn capture_advances_row_clock_and_does_not_delete_changelog() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "x");
    let got = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        1000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert_eq!(got.watermark, 1);
    assert_eq!(
        pending_count(&c, TABLES).unwrap(),
        1,
        "capture 不删 changelog"
    );

    let stored: String = c
        .query_row(
            "SELECT hlc FROM sync_row_clock WHERE tbl='conversations' AND row_id='c1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Hlc>(&stored).unwrap().ms, 1000);

    // 没 ack 就再捕获一次：同一条改动会重发（崩溃时宁可重发，不能丢），
    // 这是刻意的语义——上传成功、账本落盘之后调用方才会 ack。
    let again = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        2000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert_eq!(again.segments.len(), 1, "未 ack 的改动必须能重发");
    assert_eq!(again.watermark, 1);

    // ack 之后再捕获：没有新改动
    ack(&c, 1).unwrap();
    let quiet = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        3000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert!(quiet.segments.is_empty());
    assert_eq!(quiet.watermark, 0, "没有待处理改动时水位为 0");
}

#[test]
fn ack_clears_processed_changelog() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "x");
    insert_conv(&c, "c2", "srv1", "y");
    let got = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        1000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert_eq!(got.watermark, 2);
    ack(&c, got.watermark).unwrap();
    assert_eq!(pending_count(&c, TABLES).unwrap(), 0);
    let next = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        2000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert!(next.segments.is_empty());
}

#[test]
fn pending_count_counts_rows_not_log_entries() {
    let c = installed();
    assert_eq!(pending_count(&c, TABLES).unwrap(), 0);
    insert_conv(&c, "c1", "srv1", "x");
    c.execute("UPDATE conversations SET title='y' WHERE id='c1'", [])
        .unwrap();
    // 两行业务写入同一行；capture 只会产出 1 条 op，界面也应该显示 1
    assert_eq!(pending_count(&c, TABLES).unwrap(), 1);
    insert_conv(&c, "c2", "srv1", "z");
    assert_eq!(pending_count(&c, TABLES).unwrap(), 2);
}

#[test]
fn capture_segment_header_has_stream_and_no_seq() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "x");
    let got = capture_with(
        &c,
        TABLES,
        &mut clock,
        "A",
        1000,
        &no_aliases(),
        CaptureOptions::new("conv").with_db("conversations"),
    )
    .unwrap();
    let v: Value = serde_json::from_slice(&got.segments[0]).unwrap();
    assert_eq!(v["stream"], json!("conv"));
    assert_eq!(v["kind"], json!("rows"));
    assert_eq!(v["db"], json!("conversations"));
    assert_eq!(v["format"], json!(1));
    assert!(
        v.get("seq").is_none(),
        "序号由引擎封包时分配，段内不许抄一份"
    );
}

#[test]
fn capture_without_db_omits_the_field() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "x");
    let got = capture(&c, TABLES, &mut clock, "A", 1000, &no_aliases(), "conv").unwrap();
    let v: Value = serde_json::from_slice(&got.segments[0]).unwrap();
    assert!(v.get("db").is_none(), "没有库名时不要写空字段");
}

// ---------------------------------------------------------------------------
// 落地
// ---------------------------------------------------------------------------

#[test]
fn apply_does_not_trigger_capture() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "local");
    let ops = capture_ops(&c, &mut clock, 1000, &no_aliases());
    // 模拟「捕获后已 ack」：把本机日志清干净
    c.execute("DELETE FROM sync_changelog", []).unwrap();

    // 让远端时钟更晚、内容也确实不同（`ops[0]` 是本机当前值，原样发回来什么都不改，
    // 那证明不了「改了东西之后也没触发捕获」）
    let mut remote_op = RowOp {
        hlc: Hlc {
            ms: 9000,
            counter: 0,
            device: "B".into(),
        },
        ..ops[0].clone()
    };
    remote_op
        .cols
        .as_mut()
        .expect("捕获出来的 upsert 一定带 cols")
        .insert("title".to_string(), serde_json::json!("from-B"));
    let applied = apply_ops(&c, &[remote_op], &no_aliases());
    assert!(applied.changed);
    assert_eq!(title_of(&c, "c1").as_deref(), Some("from-B"));

    let leaked: i64 = c
        .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
        .unwrap();
    assert_eq!(leaked, 0, "落地期间必须抑制捕获，否则会回弹给对方");
}

#[test]
fn apply_older_op_is_discarded_newer_applied() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "v1");
    let ops = capture_ops(&c, &mut clock, 5000, &no_aliases());
    c.execute("DELETE FROM sync_changelog", []).unwrap();

    let base = ops[0].clone();
    let older = RowOp {
        hlc: Hlc {
            ms: 4000,
            counter: 0,
            device: "B".into(),
        },
        cols: Some(BTreeMap::from([("title".to_string(), json!("old"))])),
        ..base.clone()
    };
    let applied = apply_ops(&c, &[older], &no_aliases());
    assert!(!applied.changed);
    assert_eq!(applied.skipped, 1);
    assert_eq!(title_of(&c, "c1").as_deref(), Some("v1"), "旧 op 必须丢弃");

    let newer = RowOp {
        hlc: Hlc {
            ms: 6000,
            counter: 0,
            device: "B".into(),
        },
        cols: Some(BTreeMap::from([("title".to_string(), json!("new"))])),
        ..base
    };
    let applied = apply_ops(&c, &[newer], &no_aliases());
    assert!(applied.changed);
    assert_eq!(title_of(&c, "c1").as_deref(), Some("new"));
}

#[test]
fn apply_local_column_is_never_overwritten() {
    let c = installed();
    c.execute(
        "INSERT INTO conversations(id, connection_id, title, local_path) VALUES ('c1','srv1','old','/keep')",
        [],
    )
    .unwrap();
    let op = row_op(
        "conversations",
        "c1",
        9000,
        BTreeMap::from([
            ("title".to_string(), json!("from-B")),
            ("local_path".to_string(), json!("/overwritten")),
        ]),
    );
    apply_ops(&c, &[op], &no_aliases());
    let path: String = c
        .query_row(
            "SELECT local_path FROM conversations WHERE id='c1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(path, "/keep");
    assert_eq!(title_of(&c, "c1").as_deref(), Some("from-B"));
}

#[test]
fn apply_inserts_row_that_does_not_exist_yet() {
    let c = installed();
    let op = row_op(
        "conversations",
        "c9",
        100,
        BTreeMap::from([
            ("connection_id".to_string(), json!("srv1")),
            ("title".to_string(), json!("from remote")),
        ]),
    );
    let applied = apply_ops(&c, &[op], &no_aliases());
    assert!(applied.changed);
    assert_eq!(title_of(&c, "c9").as_deref(), Some("from remote"));
    assert!(applied.changed_tables.contains("conversations"));
    assert_eq!(applied.conversation_ids, vec!["c9".to_string()]);
}

#[test]
fn apply_delete_removes_row_and_reports_conversation() {
    let c = installed();
    insert_conv(&c, "c1", "srv1", "x");
    c.execute(
        "INSERT INTO messages(id, conversation_id, role, content) VALUES ('m1','c1','user','hi')",
        [],
    )
    .unwrap();
    let applied = apply_ops(&c, &[tombstone("messages", "m1", 100)], &no_aliases());
    assert!(applied.changed);
    assert_eq!(applied.conversation_ids, vec!["c1".to_string()]);
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn apply_delete_of_missing_row_advances_clock_but_is_not_a_change() {
    let c = installed();
    let op = tombstone("conversations", "ghost", 100);
    let applied = apply_ops(&c, std::slice::from_ref(&op), &no_aliases());
    assert!(!applied.changed);
    assert_eq!(applied.conversation_ids.len(), 0);

    // 同一个墓碑再来一次（乱序 / 重发）必须被时钟挡掉
    let again = apply_ops(&c, std::slice::from_ref(&op), &no_aliases());
    assert_eq!(again.skipped, 1);
}

#[test]
fn apply_clears_the_suppression_marker_after_success() {
    let c = installed();
    let op = row_op(
        "conversations",
        "c1",
        1,
        BTreeMap::from([
            ("connection_id".to_string(), json!("srv1")),
            ("title".to_string(), json!("t")),
        ]),
    );
    apply_ops(&c, &[op], &no_aliases());
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM temp.sync_applying", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn suppress_capture_helper_blocks_then_restores() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "x");
    c.execute("DELETE FROM sync_changelog", []).unwrap();

    with_capture_suppressed(&c, || {
        c.execute("UPDATE conversations SET title='quiet' WHERE id='c1'", [])
            .unwrap();
        Ok(())
    })
    .unwrap();
    assert_eq!(
        pending_count(&c, TABLES).unwrap(),
        0,
        "抑制期间的写入不能被捕获（T2 删会话靠它只发父行墓碑）"
    );

    // 作用域结束后恢复捕获
    c.execute("UPDATE conversations SET title='loud' WHERE id='c1'", [])
        .unwrap();
    assert_eq!(pending_count(&c, TABLES).unwrap(), 1);

    // 出错也要收回标记
    let err =
        with_capture_suppressed::<()>(&c, || Err(crate::error::AppError::Other("boom".into())));
    assert!(err.is_err());
    c.execute(
        "UPDATE conversations SET title='after-error' WHERE id='c1'",
        [],
    )
    .unwrap();
    // `pending_count` 数的是「(表, 行) 去重后有几种」，不是总条数：这三条改动
    // 都是 `conversations/c1` 这一行，所以一直是 1。要验证「又记了一条」，得看行数。
    assert_eq!(pending_count(&c, TABLES).unwrap(), 1);
    let rows: i64 = c
        .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
        .unwrap();
    assert_eq!(
        rows, 2,
        "抑制期间 0 条 + 抑制后 1 条 + 出错后再 1 条；去重计数看不出这个"
    );
    let _ = &mut clock;
}

// ---------------------------------------------------------------------------
// 未知列 / 未知表
// ---------------------------------------------------------------------------

static NEW_CONV_COLUMNS: &[RowColumn] = &[
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
        name: "local_path",
        scope: ColumnScope::Local,
    },
    RowColumn {
        name: "mood",
        scope: ColumnScope::Shared,
    },
];

static NEW_CONVERSATIONS: RowTable = RowTable {
    name: "conversations",
    pk: "id",
    columns: NEW_CONV_COLUMNS,
    parent: None,
    alias: AliasColumn::ConnectionId,
    mass_delete_limit: 20,
    merge: RowMerge::Lww,
};

static NEW_TABLES: &[RowTable] = &[NEW_CONVERSATIONS, MESSAGES, MEMORIES, PROGRESS];

fn new_device() -> Connection {
    let c = conn();
    c.execute_batch("ALTER TABLE conversations ADD COLUMN mood TEXT")
        .unwrap();
    install(&c, NEW_TABLES).unwrap();
    c
}

#[test]
fn unknown_columns_round_trip_and_are_not_deleted_by_old_devices() {
    let newc = new_device();
    // 新设备写一行带 mood
    let mut clock = HlcClock::new("NEW");
    insert_conv(&newc, "c1", "srv1", "v1");
    newc.execute("UPDATE conversations SET mood='happy' WHERE id='c1'", [])
        .unwrap();
    let ops = capture_ops_with(&newc, NEW_TABLES, &mut clock, 1000, &no_aliases());
    assert_eq!(
        ops[0].cols.as_ref().unwrap().get("mood"),
        Some(&json!("happy"))
    );

    // 老设备（不认识 mood）：落地后 mood 进 extra_json
    let old = installed();
    let applied = apply_ops_on(&old, TABLES, &ops);
    assert!(applied.changed);
    let extra: String = old
        .query_row(
            "SELECT extra_json FROM sync_row_clock WHERE tbl='conversations' AND row_id='c1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert!(extra.contains("mood"), "未知列必须留在 extra_json: {extra}");

    // 老设备改已知列 → 发出 op 时要把 mood 原样带上
    let mut old_clock = HlcClock::new("OLD");
    old.execute("UPDATE conversations SET title='v2' WHERE id='c1'", [])
        .unwrap();
    let old_ops = capture_ops_with(&old, TABLES, &mut old_clock, 2000, &no_aliases());
    let op = &old_ops[0];
    assert_eq!(
        op.extra.as_ref().and_then(|e| e.get("mood")),
        Some(&json!("happy")),
        "老设备上传时必须把不认识的列原样带回，否则新设备的那一列会被删"
    );

    // 新设备收到老设备这条 op：mood 不能被删
    let applied = {
        let plain = encode_segment(meta(), "OLD", &old_ops).unwrap();
        apply(&newc, NEW_TABLES, &plain, &no_aliases()).unwrap()
    };
    assert!(applied.changed);
    let mood: String = newc
        .query_row("SELECT mood FROM conversations WHERE id='c1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(mood, "happy", "新设备的那一列必须活着");
    assert_eq!(title_of(&newc, "c1").as_deref(), Some("v2"));
}

#[test]
fn unknown_table_is_stored_and_replayed_after_upgrade() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "x");
    let ops = capture_ops(&c, &mut clock, 1000, &no_aliases());
    assert_eq!(ops.len(), 1);
    c.execute("DELETE FROM sync_changelog", []).unwrap();

    // 模拟对方多一张本机不认识的表 `future_things`
    let future_op = row_op(
        "future_things",
        "f1",
        100,
        BTreeMap::from([("name".to_string(), json!("hello"))]),
    );
    let applied = apply_ops(&c, &[future_op], &no_aliases());
    assert_eq!(applied.stored_unknown, 1);
    assert!(!applied.changed);
    let stored: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sync_row_clock WHERE tbl='future_things' AND row_id='f1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stored, 1, "未知表必须整条存下来");

    // 升级：现在认识它了。replay_unknown 应该把整条 op 补落地
    c.execute_batch("CREATE TABLE future_things(id TEXT PRIMARY KEY, name TEXT)")
        .unwrap();
    static FUTURE_COLS: &[RowColumn] = &[
        RowColumn {
            name: "id",
            scope: ColumnScope::Shared,
        },
        RowColumn {
            name: "name",
            scope: ColumnScope::Shared,
        },
    ];
    static FUTURE: RowTable = RowTable {
        name: "future_things",
        pk: "id",
        columns: FUTURE_COLS,
        parent: None,
        alias: AliasColumn::None,
        mass_delete_limit: 0,
        merge: RowMerge::Lww,
    };
    static UPGRADED: &[RowTable] = &[CONVERSATIONS, MESSAGES, MEMORIES, PROGRESS, FUTURE];
    install(&c, UPGRADED).unwrap();
    let replayed = replay_unknown(&c, UPGRADED, &no_aliases()).unwrap();
    assert!(replayed.changed, "升级后必须把存储的 op 补落地");
    let name: String = c
        .query_row("SELECT name FROM future_things WHERE id='f1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(name, "hello");

    // 重放成功之后占位记录要消失（换成正常的行时钟）
    let still_stored: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sync_row_clock WHERE tbl='future_things' AND extra_json LIKE '%__rowop%'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(still_stored, 0);
}

// ---------------------------------------------------------------------------
// 父墓碑
// ---------------------------------------------------------------------------

#[test]
fn parent_tombstone_masks_child_ops_in_the_same_batch() {
    let c = installed();
    insert_conv(&c, "c1", "srv1", "x");
    insert_conv(&c, "c2", "srv1", "keep");
    c.execute(
        "INSERT INTO messages(id, conversation_id, role, content) VALUES ('m1','c1','user','hi')",
        [],
    )
    .unwrap();
    c.execute("DELETE FROM sync_changelog", []).unwrap();

    let parent_del = tombstone("conversations", "c1", 900);
    // 子行 op 先到（排在父墓碑前面也不行）
    let child_update = row_op(
        "messages",
        "m1",
        999,
        BTreeMap::from([("content".to_string(), json!("edited"))]),
    );
    let other_child = row_op(
        "messages",
        "m2",
        999,
        BTreeMap::from([
            ("conversation_id".to_string(), json!("c2")),
            ("role".to_string(), json!("user")),
            ("content".to_string(), json!("other")),
        ]),
    );
    let applied = apply_ops(&c, &[child_update, parent_del, other_child], &no_aliases());
    assert_eq!(applied.skipped, 1, "c1 的子行被父墓碑压掉");
    assert_eq!(
        applied.conversation_ids,
        vec!["c1".to_string(), "c2".to_string()]
    );

    // 父行墓碑落地时会级联删掉它的子行（发送方只发一个会话墓碑，见任务书第一节第 5 条）
    let child_rows: i64 = c
        .query_row("SELECT COUNT(*) FROM messages WHERE id='m1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(child_rows, 0, "父行删了，子行必须跟着走");
    assert_eq!(title_of(&c, "c1"), None);
    // c2 的行照常落地
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM messages WHERE id='m2'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(n, 1);
    // 级联删除要如实汇报被改动的子表，前端才知道该刷新什么
    assert!(applied.changed_tables.contains("messages"));
}

#[test]
fn child_ops_apply_normally_when_parent_is_not_deleted() {
    let c = installed();
    insert_conv(&c, "c1", "srv1", "x");
    c.execute("DELETE FROM sync_changelog", []).unwrap();
    let child = row_op(
        "messages",
        "m1",
        900,
        BTreeMap::from([
            ("conversation_id".to_string(), json!("c1")),
            ("role".to_string(), json!("user")),
            ("content".to_string(), json!("new")),
        ]),
    );
    let applied = apply_ops(&c, &[child], &no_aliases());
    assert!(applied.changed);
    assert_eq!(applied.skipped, 0);
}

#[test]
fn child_op_before_parent_is_deferred_then_replayed() {
    // 多设备乱序：B 先读到对 A 新建会话里一条消息的修改。不能直接写（外键会拒绝），
    // 先暂存，等父行到了自动重放。
    let c = installed();
    let child = row_op(
        "messages",
        "m1",
        900,
        BTreeMap::from([
            ("conversation_id".to_string(), json!("c1")),
            ("role".to_string(), json!("user")),
            ("content".to_string(), json!("early")),
        ]),
    );
    let first = apply_ops(&c, &[child], &no_aliases());
    assert_eq!(first.deferred, 1);
    assert!(!first.changed);
    // 暂存的行**并没有落地**：它是「等父行到了再写」的状态，前端那里还没有这条消息，
    // 所以这次不该告诉它「c1 变了」（真正变了是在下面父行到达、重放成功的那一次）。
    assert!(
        first.conversation_ids.is_empty(),
        "只是暂存、还没落地的行不能通知前端刷新：{:?}",
        first.conversation_ids
    );

    let parent = row_op(
        "conversations",
        "c1",
        800,
        BTreeMap::from([
            ("connection_id".to_string(), json!("srv1")),
            ("title".to_string(), json!("parent")),
        ]),
    );
    let second = apply_ops(&c, &[parent], &no_aliases());
    assert!(second.changed);
    let content: String = c
        .query_row("SELECT content FROM messages WHERE id='m1'", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(content, "early", "父行到了必须把暂存的子行补落地");
    assert_eq!(second.conversation_ids, vec!["c1".to_string()]);
}

#[test]
fn child_of_deleted_parent_is_orphan() {
    let c = installed();
    // 父行已墓碑：子行 op 永远没有归属
    apply_ops_on(&c, TABLES, &[tombstone("conversations", "c1", 500)]);
    let child = row_op(
        "messages",
        "m1",
        900,
        BTreeMap::from([
            ("conversation_id".to_string(), json!("c1")),
            ("role".to_string(), json!("user")),
            ("content".to_string(), json!("ghost")),
        ]),
    );
    let applied = apply_ops(&c, &[child], &no_aliases());
    assert_eq!(applied.skipped, 1);
    let n: i64 = c
        .query_row("SELECT COUNT(*) FROM messages", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0);
}

// ---------------------------------------------------------------------------
// 触发器版本升级
// ---------------------------------------------------------------------------

#[test]
fn install_rebuilds_triggers_when_version_changes() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "x");
    assert_eq!(capture_ops(&c, &mut clock, 1000, &no_aliases()).len(), 1);

    // 模拟升级：清单加了一张表（版本 +1 的动机），重新 install
    c.execute_batch("CREATE TABLE extra_things(id TEXT PRIMARY KEY, v TEXT)")
        .unwrap();
    static EXTRA_COLS: &[RowColumn] = &[
        RowColumn {
            name: "id",
            scope: ColumnScope::Shared,
        },
        RowColumn {
            name: "v",
            scope: ColumnScope::Shared,
        },
    ];
    static EXTRA: RowTable = RowTable {
        name: "extra_things",
        pk: "id",
        columns: EXTRA_COLS,
        parent: None,
        alias: AliasColumn::None,
        mass_delete_limit: 0,
        merge: RowMerge::Lww,
    };
    static V2: &[RowTable] = &[CONVERSATIONS, MESSAGES, MEMORIES, PROGRESS, EXTRA];
    install(&c, V2).unwrap();

    // 只该有当前版本的一组触发器
    let stale: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sqlite_temp_master WHERE type='trigger'
             AND name LIKE 'sync_trg_v%' AND name NOT LIKE ?1",
            [format!("sync_trg_v{ROW_TABLE_VERSION}_%")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(stale, 0, "旧版本触发器必须被 drop 掉");

    // 捕获照常（新表也记上了）
    c.execute("INSERT INTO extra_things(id, v) VALUES ('e1','x')", [])
        .unwrap();
    let ops = capture_ops_with(&c, V2, &mut clock, 2000, &no_aliases());
    let e = ops.iter().find(|o| o.table == "extra_things").unwrap();
    assert_eq!(e.cols.as_ref().unwrap().get("v"), Some(&json!("x")));
}

// ---------------------------------------------------------------------------
// 崩溃 / 事务回滚
// ---------------------------------------------------------------------------

#[test]
fn failed_apply_rolls_back_everything_and_leaves_changelog_clean() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "v1");
    c.execute("DELETE FROM sync_changelog", []).unwrap();

    // 第一条合法，第二条往 NOT NULL 列写 NULL → 整批回滚，第一条也不能留
    let good = row_op(
        "conversations",
        "c1",
        5000,
        BTreeMap::from([("title".to_string(), json!("from-B"))]),
    );
    let bad = row_op(
        "conversations",
        "c2",
        5000,
        BTreeMap::from([
            ("connection_id".to_string(), json!("srv1")),
            // title 是 NOT NULL：这条会失败
            ("title".to_string(), Value::Null),
        ]),
    );
    let plain = encode_segment(meta(), "B", &[good, bad]).unwrap();
    let err = apply(&c, TABLES, &plain, &no_aliases());
    assert!(err.is_err(), "写 NOT NULL 列必须失败");

    assert_eq!(title_of(&c, "c1").as_deref(), Some("v1"), "整批回滚");
    let c2_rows: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM conversations WHERE id='c2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(c2_rows, 0);
    // 时钟也没被写进去
    let clocks: i64 = c
        .query_row("SELECT COUNT(*) FROM sync_row_clock", [], |r| r.get(0))
        .unwrap();
    assert_eq!(clocks, 0);

    // 抑制标记必须收回去，否则之后本机的写入永远捕获不到
    let pending_after: i64 = c
        .query_row("SELECT COUNT(*) FROM temp.sync_applying", [], |r| r.get(0))
        .unwrap();
    assert_eq!(pending_after, 0, "失败路径也必须清掉抑制标记");
    c.execute(
        "UPDATE conversations SET title='after-failure' WHERE id='c1'",
        [],
    )
    .unwrap();
    assert_eq!(pending_count(&c, TABLES).unwrap(), 1);
    assert!(capture_ops(&c, &mut clock, 2000, &no_aliases()).len() >= 1);
}

#[test]
fn apply_is_atomic_across_tables() {
    // 一条合法 + 一条违反 NOT NULL：两张表都不能留下半批数据
    let c = installed();
    let good = row_op(
        "memories",
        "m1",
        10,
        BTreeMap::from([
            ("scope".to_string(), json!("global")),
            ("scope_key".to_string(), json!("")),
            ("title".to_string(), json!("ok")),
        ]),
    );
    let bad = row_op(
        "conversations",
        "c2",
        10,
        BTreeMap::from([
            ("connection_id".to_string(), json!("srv1")),
            ("title".to_string(), Value::Null), // NOT NULL
        ]),
    );
    let plain = encode_segment(meta(), "B", &[good, bad]).unwrap();
    assert!(apply(&c, TABLES, &plain, &no_aliases()).is_err());
    let mem: i64 = c
        .query_row("SELECT COUNT(*) FROM memories", [], |r| r.get(0))
        .unwrap();
    assert_eq!(mem, 0, "整批回滚，不能留下半批");
}

#[test]
fn rollback_does_not_lose_pending_changelog() {
    // 「崩溃」= apply 失败回滚。本机尚未 ack 的 changelog 必须原样还在，下一轮还能上传。
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c_local", "srv1", "mine");
    let before: i64 = c
        .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
        .unwrap();

    let bad = row_op(
        "conversations",
        "c_remote",
        10,
        BTreeMap::from([
            ("connection_id".to_string(), json!("srv1")),
            ("title".to_string(), Value::Null),
        ]),
    );
    let plain = encode_segment(meta(), "B", &[bad]).unwrap();
    assert!(apply(&c, TABLES, &plain, &no_aliases()).is_err());

    let after: i64 = c
        .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
        .unwrap();
    assert_eq!(before, after, "回滚不能吃掉本机待上传的 changelog");
    let ops = capture_ops(&c, &mut clock, 1000, &no_aliases());
    assert_eq!(ops.len(), 1);
}

// ---------------------------------------------------------------------------
// 大量删除闸
// ---------------------------------------------------------------------------

fn seed_conversations(c: &Connection, n: usize) {
    for i in 0..n {
        insert_conv(c, &format!("c{i}"), "srv1", "t");
    }
}

#[test]
fn mass_delete_gate_holds_tombstones_and_stops_the_watermark() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    seed_conversations(&c, 25); // limit = 20
    let first = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        1000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert_eq!(first.held.len(), 0);
    ack(&c, first.watermark).unwrap();

    // 一次删 20 行（>= 20），全部扣下
    for i in 0..20 {
        c.execute("DELETE FROM conversations WHERE id = ?1", [format!("c{i}")])
            .unwrap();
    }
    let batch_seq_start: i64 = c
        .query_row("SELECT MIN(seq) FROM sync_changelog", [], |r| r.get(0))
        .unwrap();
    let got = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        2000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert_eq!(got.held.len(), 20, "超过阈值的墓碑全部扣下");
    assert!(got.segments.is_empty(), "扣下的墓碑不能进段");
    assert_eq!(
        got.watermark,
        batch_seq_start - 1,
        "水位必须停在第一个被扣下的 seq 之前"
    );
    // 这 20 行的时钟不能被推进成墓碑（否则放行时墓碑会比改动还旧）
    let deleted: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sync_row_clock WHERE tbl='conversations' AND deleted = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(deleted, 0, "扣下的墓碑不能推进时钟");

    // 调用方只 ack 到水位；扣下的那些 changelog 必须还在
    ack(&c, got.watermark).unwrap();
    assert_eq!(pending_count(&c, TABLES).unwrap(), 20);

    // 用户确认后「放行」：带 release_held 再捕获一轮，墓碑正常发出
    let released = capture_with(
        &c,
        TABLES,
        &mut clock,
        "A",
        3000,
        &no_aliases(),
        CaptureOptions {
            release_held: true,
            ..CaptureOptions::new(DEFAULT_STREAM)
        },
    )
    .unwrap();
    assert_eq!(released.held.len(), 0);
    assert_eq!(ops_of(&released).len(), 20);
    assert!(ops_of(&released).iter().all(|o| o.del));
    let deleted: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sync_row_clock WHERE tbl='conversations' AND deleted = 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(deleted, 20, "放行后时钟才推进成墓碑");
}

#[test]
fn mass_delete_gate_below_threshold_lets_tombstones_through() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    seed_conversations(&c, 10);
    let first = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        1000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    ack(&c, first.watermark).unwrap();

    c.execute("DELETE FROM conversations WHERE id = 'c0'", [])
        .unwrap();
    let got = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        2000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert!(got.held.is_empty());
    let ops = ops_of(&got);
    assert_eq!(ops.len(), 1);
    assert!(ops[0].del);
}

#[test]
fn mass_delete_gate_holds_even_when_mixed_with_normal_updates() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    seed_conversations(&c, 30);
    let first = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        1000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    ack(&c, first.watermark).unwrap();

    // 先改一行（seq 更小），再删 22 行（seq 更大）：改动在第一个墓碑之前，应照常放行
    c.execute("UPDATE conversations SET title='kept' WHERE id='c25'", [])
        .unwrap();
    for i in 0..22 {
        c.execute("DELETE FROM conversations WHERE id = ?1", [format!("c{i}")])
            .unwrap();
    }
    let got = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        2000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert_eq!(got.held.len(), 22);
    let ops = ops_of(&got);
    assert_eq!(ops.len(), 1, "非墓碑的改动照常放行");
    assert_eq!(ops[0].id, "c25");
}

// ---------------------------------------------------------------------------
// 别名换算
// ---------------------------------------------------------------------------

#[test]
fn alias_is_applied_on_capture_and_on_apply() {
    let a = installed();
    let mut clock = HlcClock::new("A");
    let aliases = AliasMap::from(&BTreeMap::from([(
        "old-conn".to_string(),
        "cloud-conn".to_string(),
    )]));

    insert_conv(&a, "c1", "old-conn", "x");
    let ops = capture_ops(&a, &mut clock, 1000, &aliases);
    assert_eq!(
        ops[0].cols.as_ref().unwrap().get("connection_id"),
        Some(&json!("cloud-conn")),
        "上传前必须把旧连接 id 换成云端 id"
    );

    // 落地侧：对方发来的还是旧 id，本机也得换算
    let b = installed();
    let remote = row_op(
        "conversations",
        "c2",
        100,
        BTreeMap::from([
            ("connection_id".to_string(), json!("old-conn")),
            ("title".to_string(), json!("t")),
        ]),
    );
    let plain = encode_segment(meta(), "B", &[remote]).unwrap();
    apply(&b, TABLES, &plain, &aliases).unwrap();
    let got: String = b
        .query_row(
            "SELECT connection_id FROM conversations WHERE id='c2'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(got, "cloud-conn");
}

#[test]
fn scope_key_alias_is_applied_too() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    let aliases = AliasMap::from(&BTreeMap::from([(
        "old-conn".to_string(),
        "cloud-conn".to_string(),
    )]));
    c.execute(
        "INSERT INTO memories(id, scope, scope_key, title) VALUES ('m1','host','old-conn','t')",
        [],
    )
    .unwrap();
    let ops = capture_ops(&c, &mut clock, 1000, &aliases);
    assert_eq!(
        ops[0].cols.as_ref().unwrap().get("scope_key"),
        Some(&json!("cloud-conn"))
    );
}

#[test]
fn alias_resolution_is_chained_capped_and_cycle_safe() {
    let mut map = BTreeMap::new();
    map.insert("a".to_string(), "b".to_string());
    map.insert("b".to_string(), "c".to_string());
    let m = AliasMap::from(&map);
    assert_eq!(m.resolve("a"), "c");
    assert_eq!(m.resolve("b"), "c");
    assert_eq!(m.resolve("c"), "c");
    assert_eq!(m.resolve("unknown"), "unknown");

    map.insert("x".to_string(), "x".to_string());
    let m = AliasMap::from(&map);
    assert_eq!(m.resolve("x"), "x", "自环不能死循环");

    map.insert("p".to_string(), "q".to_string());
    map.insert("q".to_string(), "p".to_string());
    let m = AliasMap::from(&map);
    let got = m.resolve("p");
    assert!(got == "p" || got == "q");

    // 长链只跟 8 跳
    let long: BTreeMap<String, String> = (0..12)
        .map(|i| (format!("n{i}"), format!("n{}", i + 1)))
        .collect();
    assert_eq!(AliasMap::from(&long).resolve("n0"), "n8");
}

// ---------------------------------------------------------------------------
// LatestBy
// ---------------------------------------------------------------------------

#[test]
fn latest_by_compares_column_value_not_hlc() {
    let c = installed();
    c.execute(
        "INSERT INTO reflection_progress(conversation_id, anchor_message_id, anchor_created_at, updated_at)
         VALUES ('c1','m9','2026-01-02T00:00:00Z','2026-01-02T00:00:00Z')",
        [],
    )
    .unwrap();

    // 先捕获一次，让这一行有本机时钟（否则「没有可比的东西」会被直接接受）
    let mut clock = HlcClock::new("A");
    let _ = capture_ops(&c, &mut clock, 1000, &no_aliases());
    c.execute("DELETE FROM sync_changelog", []).unwrap();

    // 时钟更新、但 anchor 更早：不该落地
    let older_anchor = row_op(
        "reflection_progress",
        "c1",
        999_999,
        BTreeMap::from([
            ("conversation_id".to_string(), json!("c1")),
            ("anchor_message_id".to_string(), json!("m1")),
            (
                "anchor_created_at".to_string(),
                json!("2026-01-01T00:00:00Z"),
            ),
            ("updated_at".to_string(), json!("2026-02-01T00:00:00Z")),
        ]),
    );
    let applied = apply_ops(&c, &[older_anchor], &no_aliases());
    assert!(!applied.changed);
    let anchor: String = c
        .query_row(
            "SELECT anchor_created_at FROM reflection_progress WHERE conversation_id='c1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(anchor, "2026-01-02T00:00:00Z");

    // 时钟更旧、但 anchor 更晚：要落地，而且时钟要更新成远端的
    let newer_anchor = row_op(
        "reflection_progress",
        "c1",
        10,
        BTreeMap::from([
            ("conversation_id".to_string(), json!("c1")),
            ("anchor_message_id".to_string(), json!("m99")),
            (
                "anchor_created_at".to_string(),
                json!("2026-03-01T00:00:00Z"),
            ),
            ("updated_at".to_string(), json!("2026-03-01T00:00:00Z")),
        ]),
    );
    let applied = apply_ops(&c, &[newer_anchor], &no_aliases());
    assert!(applied.changed);
    let (anchor, msg): (String, String) = c
        .query_row(
            "SELECT anchor_created_at, anchor_message_id FROM reflection_progress WHERE conversation_id='c1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(anchor, "2026-03-01T00:00:00Z");
    assert_eq!(msg, "m99");
    let clock: String = c
        .query_row(
            "SELECT hlc FROM sync_row_clock WHERE tbl='reflection_progress' AND row_id='c1'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(serde_json::from_str::<Hlc>(&clock).unwrap().ms, 10);
}

// ---------------------------------------------------------------------------
// export_all
// ---------------------------------------------------------------------------

#[test]
fn export_all_splits_into_bounded_segments() {
    let c = installed();
    insert_conv(&c, "c1", "srv1", "holder");
    // 3MB 左右：1500 条 × 2KB
    let filler = "x".repeat(2000);
    c.execute_batch("BEGIN").unwrap();
    for i in 0..1500 {
        c.execute(
            "INSERT INTO messages(id, conversation_id, role, content) VALUES (?1,'c1','user',?2)",
            rusqlite::params![format!("m{i:05}"), filler],
        )
        .unwrap();
    }
    c.execute_batch("COMMIT").unwrap();
    c.execute("DELETE FROM sync_changelog", []).unwrap();

    let limit = 200_000;
    let segs = export_all(&c, TABLES, "A", &no_aliases(), limit, DEFAULT_STREAM).unwrap();
    assert!(
        segs.len() >= 10,
        "3MB / 200KB 应该切成多段，实际 {}",
        segs.len()
    );
    for s in &segs {
        assert!(s.len() <= limit, "段大小 {} 超过上限 {}", s.len(), limit);
    }
    // 所有行都要出现在某一段里（1500 条消息 + 1 条会话）
    let total: usize = segs
        .iter()
        .map(|s| parse_segment(s).unwrap().ops.len())
        .sum();
    assert_eq!(total, 1501);
    // 段头没有 seq（序号由引擎封包时分配）
    for s in &segs {
        let v: Value = serde_json::from_slice(s).unwrap();
        assert!(v.get("seq").is_none());
        assert_eq!(v["stream"], json!("conv"));
    }
}

#[test]
fn export_all_uses_zero_clock_for_rows_never_captured() {
    let c = installed();
    insert_conv(&c, "c1", "srv1", "x");
    let segs = export_all(&c, TABLES, "A", &no_aliases(), 0, DEFAULT_STREAM).unwrap();
    let ops: Vec<RowOp> = segs
        .iter()
        .flat_map(|s| parse_segment(s).unwrap().ops)
        .collect();
    let conv = ops.iter().find(|o| o.table == "conversations").unwrap();
    assert_eq!(
        conv.hlc,
        Hlc::zero_for("A"),
        "加入同步时本机已有数据用零时钟"
    );
}

#[test]
fn export_all_keeps_the_real_clock_for_captured_rows() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "x");
    let _ = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        4242,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    ack(&c, 999).unwrap();
    let segs = export_all(&c, TABLES, "A", &no_aliases(), 0, DEFAULT_STREAM).unwrap();
    let ops: Vec<RowOp> = segs
        .iter()
        .flat_map(|s| parse_segment(s).unwrap().ops)
        .collect();
    assert_eq!(ops[0].hlc.ms, 4242, "已经捕获过的行要带自己的时钟");
}

#[test]
fn export_all_skips_local_columns() {
    let c = installed();
    c.execute(
        "INSERT INTO conversations(id, connection_id, title, local_path) VALUES ('c1','srv1','t','/x')",
        [],
    )
    .unwrap();
    let segs = export_all(&c, TABLES, "A", &no_aliases(), 0, DEFAULT_STREAM).unwrap();
    let ops: Vec<RowOp> = segs
        .iter()
        .flat_map(|s| parse_segment(s).unwrap().ops)
        .collect();
    assert!(!ops[0].cols.as_ref().unwrap().contains_key("local_path"));
}

#[test]
fn export_all_carries_unknown_columns_and_db_header() {
    let c = installed();
    // 让某行带上「本机不认识的列」（模拟老设备落地过新版本的字段）
    apply_ops(
        &c,
        &[row_op(
            "conversations",
            "c1",
            100,
            BTreeMap::from([
                ("connection_id".to_string(), json!("srv1")),
                ("title".to_string(), json!("t")),
                ("future_field".to_string(), json!("keep-me")),
            ]),
        )],
        &no_aliases(),
    );
    let segs = export_all_with(
        &c,
        TABLES,
        "A",
        &no_aliases(),
        ExportOptions::new(DEFAULT_STREAM, 0).with_db("conversations"),
    )
    .unwrap();
    let v: Value = serde_json::from_slice(&segs[0]).unwrap();
    assert_eq!(v["db"], json!("conversations"));
    let ops: Vec<RowOp> = segs
        .iter()
        .flat_map(|s| parse_segment(s).unwrap().ops)
        .collect();
    assert_eq!(
        ops[0].extra.as_ref().and_then(|e| e.get("future_field")),
        Some(&json!("keep-me")),
        "全量导出不能把不认识的列丢掉"
    );
}

// ---------------------------------------------------------------------------
// 段格式
// ---------------------------------------------------------------------------

#[test]
fn segment_json_matches_the_contract_shape() {
    let c = installed();
    let mut clock = HlcClock::new("A");
    insert_conv(&c, "c1", "srv1", "hello");
    let got = capture(
        &c,
        TABLES,
        &mut clock,
        "A",
        1234,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert_eq!(got.segments.len(), 1);
    let v: Value = serde_json::from_slice(&got.segments[0]).unwrap();
    assert_eq!(v["format"], json!(1));
    assert_eq!(v["stream"], json!("conv"));
    assert_eq!(v["kind"], json!("rows"));
    assert_eq!(v["device"], json!("A"));
    assert!(v.get("seq").is_none(), "契约：段里不写 seq");
    let op = &v["ops"][0];
    assert_eq!(op["t"], json!("conversations"));
    assert_eq!(op["id"], json!("c1"));
    assert_eq!(op["hlc"]["device"], json!("A"));
    assert_eq!(op["cols"]["title"], json!("hello"));
    assert!(op.get("del").is_none(), "upsert 不写 del");
    assert!(op.get("extra").is_none(), "没有扩展列时不写 extra");
}

#[test]
fn parsed_segment_defaults_db_to_conversations() {
    let plain = br#"{"format":1,"stream":"conv","kind":"rows","device":"B","ops":[]}"#;
    let seg = parse_segment(plain).unwrap();
    assert_eq!(seg.db_or_default(), "conversations");
    assert_eq!(seg.stream.as_deref(), Some("conv"));
}

#[test]
fn too_new_format_is_rejected_before_parsing() {
    let c = installed();
    let v = json!({"format": 99, "stream": "conv", "kind": "rows", "device": "B", "ops": []});
    let bytes = serde_json::to_vec(&v).unwrap();
    let err = apply(&c, TABLES, &bytes, &no_aliases()).unwrap_err();
    assert!(err.to_string().contains("请升级应用"), "{err}");
}

#[test]
fn wrong_kind_is_rejected() {
    let c = installed();
    let v = json!({"format": 1, "stream": "sec", "kind": "secret-ops", "device": "B", "ops": []});
    let bytes = serde_json::to_vec(&v).unwrap();
    let err = apply(&c, TABLES, &bytes, &no_aliases()).unwrap_err();
    assert!(err.to_string().contains("类型不对"), "{err}");
}

// ---------------------------------------------------------------------------
// 补充：跨库搬运（capture A → apply B 的完整闭环）
// ---------------------------------------------------------------------------

#[test]
fn capture_on_one_db_applies_to_another_end_to_end() {
    let a = installed();
    let b = installed();
    let mut clock = HlcClock::new("A");

    insert_conv(&a, "c1", "srv1", "from A");
    a.execute(
        "INSERT INTO messages(id, conversation_id, role, content) VALUES ('m1','c1','user','hi')",
        [],
    )
    .unwrap();
    let got = capture(
        &a,
        TABLES,
        &mut clock,
        "A",
        1000,
        &no_aliases(),
        DEFAULT_STREAM,
    )
    .unwrap();
    assert_eq!(got.segments.len(), 1);

    let applied = apply(&b, TABLES, &got.segments[0], &no_aliases()).unwrap();
    assert!(applied.changed);
    assert_eq!(title_of(&b, "c1").as_deref(), Some("from A"));
    assert_eq!(
        applied.conversation_ids,
        vec!["c1".to_string()],
        "同一批里会话与消息都应归到 c1（去重）"
    );

    // 再次应用同一条段：幂等，不算变化
    let again = apply(&b, TABLES, &got.segments[0], &no_aliases()).unwrap();
    assert!(!again.changed);
    assert_eq!(again.skipped, 2);

    ack(&a, got.watermark).unwrap();
    assert_eq!(pending_count(&a, TABLES).unwrap(), 0);
}

// ---------------------------------------------------------------------------
// 三台设备随机收敛
// ---------------------------------------------------------------------------

/// 三台模拟设备：各自一份内存库，随机改，op 乱序投给另外两台，最终行内容一致。
///
/// 只比较 `Shared` 列（`Local` 列是各设备自己的），比较时用 SQL 结果排序后逐行比。
struct Sim {
    name: &'static str,
    conn: Connection,
    clock: HlcClock,
    wall: u64,
}

impl Sim {
    fn new(name: &'static str) -> Sim {
        Sim {
            name,
            conn: installed(),
            clock: HlcClock::new(name),
            wall: 1_000,
        }
    }

    fn capture(&mut self) -> Vec<RowOp> {
        let got = capture(
            &self.conn,
            TABLES,
            &mut self.clock,
            self.name,
            self.wall,
            &no_aliases(),
            DEFAULT_STREAM,
        )
        .unwrap();
        let n = got.watermark;
        if n > 0 {
            ack(&self.conn, n).unwrap();
        }
        assert!(
            got.held.is_empty(),
            "随机测试不该触发大量删除闸（阈值 20/50）"
        );
        ops_of(&got)
    }

    fn apply(&mut self, ops: &[RowOp]) {
        if ops.is_empty() {
            return;
        }
        let plain = encode_segment(meta(), "remote", ops).unwrap();
        apply(&self.conn, TABLES, &plain, &no_aliases()).unwrap();
    }

    /// 只比 `Shared` 列：`local_path` 是每台设备自己的，本来就不该一致。
    fn view(&self) -> Vec<(String, String, String)> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, connection_id, title FROM conversations ORDER BY id")
            .unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)));
        rows.unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    fn message_view(&self) -> Vec<(String, String, String, String)> {
        let mut stmt = self
            .conn
            .prepare("SELECT id, conversation_id, role, content FROM messages ORDER BY id")
            .unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)));
        rows.unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    fn memory_view(&self) -> Vec<(String, String, String, String, Option<String>)> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, scope, scope_key, title, source_conversation_id FROM memories ORDER BY id",
            )
            .unwrap();
        let rows = stmt.query_map([], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
        });
        rows.unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }

    fn progress_view(&self) -> Vec<(String, String, String)> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT conversation_id, anchor_message_id, anchor_created_at
                 FROM reflection_progress ORDER BY conversation_id",
            )
            .unwrap();
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)));
        rows.unwrap().collect::<rusqlite::Result<_>>().unwrap()
    }
}

fn live_conversations(s: &Sim) -> Vec<String> {
    let mut stmt = s
        .conn
        .prepare("SELECT id FROM conversations ORDER BY id")
        .unwrap();
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).unwrap();
    rows.collect::<rusqlite::Result<Vec<_>>>().unwrap()
}

/// 一条待投递的 op 批次（模拟对方设备的一个段）。
struct Flight {
    from: usize,
    ops: Vec<RowOp>,
}

/// 一台设备从日志里拉一批：下标打乱后再落地（模拟网络乱序），游标照样前进。
fn pull(
    sims: &mut [Sim],
    cursors: &mut [usize],
    log: &[Flight],
    target: usize,
    max: usize,
    rng: &mut Rng,
) {
    let start = cursors[target];
    let end = start.saturating_add(max).min(log.len());
    if start >= end {
        return;
    }
    let mut idx: Vec<usize> = (start..end).collect();
    rng.shuffle(&mut idx);
    for i in idx {
        if log[i].from == target {
            continue;
        }
        let ops = log[i].ops.clone();
        sims[target].apply(&ops);
    }
    cursors[target] = end;
}

#[test]
fn three_devices_converge_under_random_writes_and_reordering() {
    let mut rng = Rng::new(0xC0FFEE);
    let mut sims = vec![Sim::new("A"), Sim::new("B"), Sim::new("C")];
    let mut log: Vec<Flight> = Vec::new();
    let mut cursors = [0usize; 3];
    let mut mem_ids: Vec<String> = Vec::new();

    for step in 0..700 {
        let who = rng.below(3);
        let kind = rng.below(100);
        sims[who].wall += 1 + rng.below(3) as u64;
        // 每次操作前以本设备的库为准刷新 id 列表：别的设备刚建 / 刚删的会话这台可能还没收到
        let conv_ids = live_conversations(&sims[who]);

        if kind < 25 || conv_ids.is_empty() {
            // 插入一段会话
            let id = format!("c{step}");
            sims[who]
                .conn
                .execute(
                    "INSERT INTO conversations(id, connection_id, title, local_path)
                     VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![
                        id,
                        "srv1",
                        format!("t{step}"),
                        format!("/local/{}", sims[who].name)
                    ],
                )
                .unwrap();
        } else if kind < 55 {
            // 改标题
            let id = rng.pick(&conv_ids).clone();
            let title = format!("title-{step}");
            sims[who]
                .conn
                .execute(
                    "UPDATE conversations SET title = ?1 WHERE id = ?2",
                    rusqlite::params![title, id],
                )
                .unwrap();
        } else if kind < 62 && conv_ids.len() > 6 {
            // 删会话（同时删子行，模拟使用方的级联删除）；一次删一条，不触发大量删除闸
            let id = rng.pick(&conv_ids).clone();
            sims[who]
                .conn
                .execute("DELETE FROM messages WHERE conversation_id = ?1", [&id])
                .unwrap();
            sims[who]
                .conn
                .execute("DELETE FROM conversations WHERE id = ?1", [&id])
                .unwrap();
        } else if kind < 85 {
            // 插入一条消息（挂在一段存在的会话上；外键是 NOT NULL，不能挂空）
            if let Some(conv) = conv_ids.first() {
                let conv = rng.pick(&conv_ids);
                let id = format!("m{step}");
                let _ = conv;
                sims[who]
                    .conn
                    .execute(
                        "INSERT INTO messages(id, conversation_id, role, content, image_paths_json)
                         VALUES (?1, ?2, 'user', ?3, ?4)",
                        rusqlite::params![
                            id,
                            conv,
                            format!("body-{step}"),
                            format!("/img/{}", sims[who].name)
                        ],
                    )
                    .unwrap();
            }
        } else if kind < 93 {
            // 改记忆（insert 或 update）
            if rng.chance(40) || mem_ids.is_empty() {
                let id = format!("mem{step}");
                sims[who]
                    .conn
                    .execute(
                        "INSERT INTO memories(id, scope, scope_key, title, is_new, source_conversation_id)
                         VALUES (?1, 'host', 'srv1', ?2, 1, NULL)",
                        rusqlite::params![id, format!("mem-{step}")],
                    )
                    .unwrap();
                mem_ids.push(id);
            } else {
                let id = rng.pick(&mem_ids).clone();
                sims[who]
                    .conn
                    .execute(
                        "UPDATE memories SET title = ?1 WHERE id = ?2",
                        rusqlite::params![format!("mem-upd-{step}"), id],
                    )
                    .unwrap();
            }
        } else {
            // 复盘进度（LatestBy）。真实业务只把 anchor 往前推（`MemoryStore::progress` 只在
            // 更晚时才写），所以随机测试也只能往前：否则本机的「业务写入」会直接写回一个更早的
            // anchor，LatestBy 只管远端 op，本地永远赢，两边就会分叉——那不是同步层的 bug。
            if let Some(conv) = conv_ids.first() {
                let conv = rng.pick(&conv_ids).clone();
                let current: Option<String> = sims[who]
                    .conn
                    .query_row(
                        "SELECT anchor_created_at FROM reflection_progress WHERE conversation_id = ?1",
                        [&conv],
                        |r| r.get(0),
                    )
                    .ok();
                let day = 1 + rng.below(28);
                let candidate = format!("2026-01-{day:02}T00:00:00Z");
                let anchor = match current {
                    Some(cur) if cur >= candidate => cur,
                    _ => candidate,
                };
                let anchor_msg = format!("a{step}");
                sims[who]
                    .conn
                    .execute(
                        "INSERT INTO reflection_progress(conversation_id, anchor_message_id, anchor_created_at, updated_at)
                         VALUES (?1, ?2, ?3, ?3)
                         ON CONFLICT(conversation_id) DO UPDATE SET
                             anchor_message_id = excluded.anchor_message_id,
                             anchor_created_at = excluded.anchor_created_at,
                             updated_at = excluded.updated_at",
                        rusqlite::params![conv, anchor_msg, anchor],
                    )
                    .unwrap();
            }
        }

        // 捕获本机改动 → 变成日志里的一段（相当于上传成功）
        let ops = sims[who].capture();
        if !ops.is_empty() {
            log.push(Flight { from: who, ops });
        }

        // 随机让某台设备拉若干段：窗口内的段顺序被打乱，游标照常前进
        if rng.chance(75) {
            let target = rng.below(3);
            let max = 1 + rng.below(4);
            pull(&mut sims, &mut cursors, &log, target, max, &mut rng);
        }
    }

    // 一切静默：每台设备按自己的随机顺序把剩余日志全拉完，再多来两轮「捕获 → 投递」
    for _ in 0..2 {
        for target in 0..3 {
            pull(&mut sims, &mut cursors, &log, target, usize::MAX, &mut rng);
        }
        for i in 0..3 {
            let ops = sims[i].capture();
            if !ops.is_empty() {
                log.push(Flight { from: i, ops });
            }
        }
    }

    // 收敛断言（只打印不一致的那几行，别把几千行倒出来）
    fn diff<T: PartialEq + std::fmt::Debug + Clone>(a: &[T], b: &[T]) -> String {
        let only_a: Vec<&T> = a.iter().filter(|x| !b.contains(x)).take(5).collect();
        let only_b: Vec<&T> = b.iter().filter(|x| !a.contains(x)).take(5).collect();
        format!("只在左边: {only_a:?}\n只在右边: {only_b:?}")
    }
    let view_a = sims[0].view();
    for s in &sims[1..] {
        assert_eq!(
            view_a,
            s.view(),
            "{} 与 {} 的会话内容不一致\n{}",
            sims[0].name,
            s.name,
            diff(&view_a, &s.view())
        );
        assert_eq!(
            sims[0].message_view(),
            s.message_view(),
            "{} 与 {} 的消息不一致\n{}",
            sims[0].name,
            s.name,
            diff(&sims[0].message_view(), &s.message_view())
        );
        assert_eq!(
            sims[0].memory_view(),
            s.memory_view(),
            "{} 与 {} 的记忆不一致\n{}",
            sims[0].name,
            s.name,
            diff(&sims[0].memory_view(), &s.memory_view())
        );
        assert_eq!(
            sims[0].progress_view(),
            s.progress_view(),
            "{} 与 {} 的复盘进度不一致\n{}",
            sims[0].name,
            s.name,
            diff(&sims[0].progress_view(), &s.progress_view())
        );
    }

    // Local 列各自保留
    for (i, s) in sims.iter().enumerate() {
        let paths: Vec<Option<String>> = {
            let mut stmt = s
                .conn
                .prepare("SELECT local_path FROM conversations")
                .unwrap();
            let rows = stmt.query_map([], |r| r.get(0)).unwrap();
            rows.collect::<rusqlite::Result<_>>().unwrap()
        };
        for p in paths {
            if let Some(p) = p {
                assert_eq!(
                    p,
                    format!("/local/{}", ["A", "B", "C"][i]),
                    "Local 列不能被别的设备覆盖"
                );
            }
        }
    }
}
