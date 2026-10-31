//! 建表与触发器：`sync_changelog`、`sync_row_clock`、落地抑制表，以及每张业务表的三个触发器。
//!
//! **为什么触发器是 `CREATE TEMP TRIGGER`**：SQLite 不允许持久触发器引用 `temp` 库的对象
//! （`trigger … cannot reference objects in database temp`），而落地抑制标记必须放在
//! `temp.sync_applying`（连接级）——放主库的话，一台设备落地期间会把这行标记写进共享的
//! 库文件，别的进程/别的连接就再也捕获不到自己的改动了。所以「抑制标记」和「触发器」只能
//! 一起活在 temp 库里。
//!
//! 代价（使用方必须知道）：**只有调过 [`install`] 的那条连接上的写入才会被捕获**。
//! T2 / T4 的业务写入本来就都走 `ConversationDb` / `MemoryStore` 那一条被 `Mutex` 保护的
//! 连接，所以没有额外要求；但如果以后有人为同一个库另开一条连接去写业务表，那些写入不会被
//! 同步捕获（也不会被抑制，不会引发回弹）。
//!
//! **为什么触发器要带版本号**：表清单是编译期常量，升级版本后可能加表 / 加列 / 改主键。
//! 连接上躺着的还是旧触发器，它们记的 `row_id` 可能是别的列——留着只会让同步悄悄错位。
//! `install` 每次先把所有 `sync_trg_v%` drop 掉再按当前版本重建，所以升级只需要把
//! [`ROW_TABLE_VERSION`] +1，用户下次启动（重新打开连接）就换上了。

use rusqlite::Connection;

use super::shared::{quote_ident, quote_literal};
use super::RowTable;

/// 触发器定义的版本。**表清单变了就 +1**（加表、删表、换主键）。
///
/// 加列可以不升：触发器只记「哪一行变了」，不记列。但为了少一类「为什么线上库还是旧行为」
/// 的问题，加列也建议顺手 +1（重建是幂等的、几乎零成本）。
pub const ROW_TABLE_VERSION: u32 = 1;

/// 落地抑制表的名字（建在 `temp` 库里，连接私有）。
pub(super) const APPLYING_TABLE: &str = "sync_applying";

/// 建表并（重）建触发器。**幂等**，每次打开数据库都调；失败返回 `rusqlite::Error`。
///
/// 三步：
/// 1. 主库里建 `sync_changelog` / `sync_row_clock`（数据，必须落盘）；
/// 2. `temp` 库里建 `sync_applying`（每次打开都要建——临时表不随库文件保留）；
/// 3. drop 掉这条连接上所有本模块的旧触发器，再按当前清单重建。
pub fn install(conn: &Connection, tables: &'static [RowTable]) -> Result<(), rusqlite::Error> {
    conn.execute_batch(&format!(
        "
        -- 本机改动的队列：和业务写入在同一个事务里，崩溃也不会丢。
        CREATE TABLE IF NOT EXISTS sync_changelog (
            seq INTEGER PRIMARY KEY AUTOINCREMENT,
            tbl TEXT NOT NULL,
            row_id TEXT NOT NULL,
            op TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sync_changelog_row ON sync_changelog(tbl, row_id);

        -- 每行的时钟 + 本机不认识的列。删除也占一行（deleted = 1），否则墓碑比不过
        -- 「删除之后重建」的那次写入。
        CREATE TABLE IF NOT EXISTS sync_row_clock (
            tbl TEXT NOT NULL,
            row_id TEXT NOT NULL,
            hlc TEXT NOT NULL,
            deleted INTEGER NOT NULL DEFAULT 0,
            extra_json TEXT,
            PRIMARY KEY (tbl, row_id)
        );

        -- 落地抑制标记：连接级临时表，见模块文档「为什么触发器是 TEMP TRIGGER」。
        CREATE TEMP TABLE IF NOT EXISTS {applying} (dummy INTEGER);
        ",
        applying = quote_ident(APPLYING_TABLE),
    ))?;

    // 上次进程崩在 apply 中间时这里可能还留着一行；不清掉的话本机之后所有写入都不会被捕获。
    // （temp 表本来随进程消失，但同进程里换连接池 / install 重入时仍可能残留。）
    conn.execute(
        &format!("DELETE FROM temp.{}", quote_ident(APPLYING_TABLE)),
        [],
    )?;

    drop_stale_triggers(conn)?;

    for table in tables {
        for (suffix, event) in [("ins", "INSERT"), ("upd", "UPDATE"), ("del", "DELETE")] {
            // 用 CREATE TRIGGER（不是 IF NOT EXISTS）：上面刚 drop 过，这里重复说明清单里有重名表，
            // 早点报错比默默只留一个触发器好。
            conn.execute_batch(&trigger_sql(table, suffix, event))?;
        }
    }
    Ok(())
}

/// drop 掉本模块建过的所有触发器（含旧版本号、以及历史上可能留在主库里的持久触发器）。
///
/// 两处都扫：现在建的是 temp 触发器，但老库里可能躺着更早版本建的主库触发器；留着会让
/// 每一次业务写入记两条日志（重复上传），所以一并清掉。
fn drop_stale_triggers(conn: &Connection) -> Result<(), rusqlite::Error> {
    let mut names: Vec<(bool, String)> = Vec::new();
    for (temp, sql) in [
        (false, "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'sync_trg_v%'"),
        (
            true,
            "SELECT name FROM sqlite_temp_master WHERE type = 'trigger' AND name LIKE 'sync_trg_v%'",
        ),
    ] {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for name in rows {
            names.push((temp, name?));
        }
    }
    for (temp, name) in names {
        // 名字来自 sqlite_master，理论上可以是任意字符串：转义后再拼。
        let schema = if temp { "temp." } else { "" };
        conn.execute_batch(&format!(
            "DROP TRIGGER IF EXISTS {schema}{}",
            quote_ident(&name)
        ))?;
    }
    Ok(())
}

/// 一张表的三个触发器。
///
/// 三个要点：
/// - `row_id` 取 `NEW.<pk>` / `OLD.<pk>`（稳定 id），**不能**用 `rowid`：自增 rowid 跨设备
///   没有任何意义，两边会把不同的行当成同一行。
/// - 动作里只写「哪张表、哪一行、什么操作」：内容由 `capture` 上传时再读当前值，
///   一次事务里改十次也只留十条很小的记录。
/// - `WHEN NOT EXISTS (SELECT 1 FROM temp.sync_applying)`：落地期间不记录，否则每台设备都会
///   把别人的改动再捕获一遍，两边来回弹。
fn trigger_sql(table: &RowTable, suffix: &str, event: &str) -> String {
    let (row_id, op) = match event {
        "INSERT" => (format!("NEW.{}", quote_ident(table.pk)), "i"),
        "UPDATE" => (format!("NEW.{}", quote_ident(table.pk)), "u"),
        _ => (format!("OLD.{}", quote_ident(table.pk)), "d"),
    };
    // 稳定主键可能还是空串（`plan_snapshots.uid` 的 ALTER 只允许常量默认值）：这种行
    // 同步身份还没定下来，**整行跳过**——`sync_changelog.row_id` 是 NOT NULL，
    // 记成空串又会让 `sync_row_clock` 把一堆不同的行当成同一行。
    let skip_when_empty = format!(
        " AND length({row_id}) > 0 AND {row_id} IS NOT NULL",
        row_id = row_id
    );

    format!(
        "
        CREATE TEMP TRIGGER {name} AFTER {event} ON {table}
        WHEN NOT EXISTS (SELECT 1 FROM temp.{applying}){skip_when_empty}
        BEGIN
            INSERT INTO sync_changelog(tbl, row_id, op)
            VALUES ({table_lit}, {row_id}, '{op}');
        END;
        ",
        name = quote_ident(&format!(
            "sync_trg_v{ROW_TABLE_VERSION}_{}_{}",
            table.name, suffix
        )),
        event = event,
        table = quote_ident(table.name),
        applying = quote_ident(APPLYING_TABLE),
        skip_when_empty = skip_when_empty,
        table_lit = quote_literal(table.name),
        row_id = row_id,
        op = op,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::rows::RowColumn;

    fn conn() -> Connection {
        Connection::open_in_memory().unwrap()
    }

    static COLS: &[RowColumn] = &[RowColumn {
        name: "id",
        scope: super::super::ColumnScope::Shared,
    }];

    static TABLE: RowTable = RowTable {
        name: "demo",
        pk: "id",
        columns: COLS,
        parent: None,
        alias: super::super::AliasColumn::None,
        mass_delete_limit: 0,
        merge: super::super::RowMerge::Lww,
    };

    static TABLES: &[RowTable] = &[TABLE];

    #[test]
    fn creates_tables_and_three_triggers() {
        let c = conn();
        c.execute_batch("CREATE TABLE demo(id TEXT PRIMARY KEY, v TEXT)")
            .unwrap();
        install(&c, TABLES).unwrap();

        let count: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_temp_master WHERE type='trigger' AND tbl_name='demo'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            count, 3,
            "触发器必须建在 temp 库里（要引用 temp.sync_applying）"
        );
    }

    #[test]
    fn install_is_idempotent_and_rebuilds_triggers() {
        let c = conn();
        c.execute_batch("CREATE TABLE demo(id TEXT PRIMARY KEY, v TEXT)")
            .unwrap();
        install(&c, TABLES).unwrap();
        c.execute("INSERT INTO demo(id, v) VALUES ('a', '1')", [])
            .unwrap();
        let before: i64 = c
            .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
            .unwrap();
        install(&c, TABLES).unwrap();
        // 重装不清 changelog（那是已捕获的队列），但也不重复计数
        let after: i64 = c
            .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
            .unwrap();
        assert_eq!(before, after);
        c.execute("INSERT INTO demo(id, v) VALUES ('b', '2')", [])
            .unwrap();
        let total: i64 = c
            .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
            .unwrap();
        assert_eq!(total, before + 1);
    }

    #[test]
    fn drops_triggers_from_older_versions() {
        let c = conn();
        c.execute_batch("CREATE TABLE demo(id TEXT PRIMARY KEY, v TEXT)")
            .unwrap();
        c.execute_batch(
            "CREATE TABLE sync_changelog (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL);",
        )
        .unwrap();
        // 伪造一个旧版本触发器，install 必须把它 drop 掉，否则两套触发器会重复记账
        c.execute_batch(
            "CREATE TEMP TRIGGER sync_trg_v0_demo_ins AFTER INSERT ON demo
             BEGIN INSERT INTO sync_changelog(tbl,row_id,op) VALUES('demo', NEW.id, 'i'); END;",
        )
        .unwrap();
        install(&c, TABLES).unwrap();
        let old: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_temp_master WHERE name = 'sync_trg_v0_demo_ins'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(old, 0);
    }

    #[test]
    fn drops_persistent_triggers_left_by_older_builds() {
        let c = conn();
        c.execute_batch("CREATE TABLE demo(id TEXT PRIMARY KEY, v TEXT)")
            .unwrap();
        c.execute_batch(
            "CREATE TABLE sync_changelog (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT NOT NULL, row_id TEXT NOT NULL, op TEXT NOT NULL);
             CREATE TRIGGER sync_trg_v1_demo_ins AFTER INSERT ON demo
             BEGIN INSERT INTO sync_changelog(tbl,row_id,op) VALUES('demo', NEW.id, 'i'); END;",
        )
        .unwrap();
        install(&c, TABLES).unwrap();
        let persistent: i64 = c
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name LIKE 'sync_trg_v%'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            persistent, 0,
            "主库里的旧触发器也要清掉，否则每条写入记两份"
        );
        // 只剩 temp 里的一组
        c.execute("INSERT INTO demo(id, v) VALUES ('a','1')", [])
            .unwrap();
        let logs: i64 = c
            .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
            .unwrap();
        assert_eq!(logs, 1);
    }

    #[test]
    fn install_clears_stale_applying_marker() {
        let c = conn();
        c.execute_batch("CREATE TABLE demo(id TEXT PRIMARY KEY, v TEXT)")
            .unwrap();
        install(&c, TABLES).unwrap();
        // 模拟上次崩溃留下的标记
        c.execute("INSERT INTO temp.sync_applying(dummy) VALUES (1)", [])
            .unwrap();
        install(&c, TABLES).unwrap();
        c.execute("INSERT INTO demo(id, v) VALUES ('a', '1')", [])
            .unwrap();
        let n: i64 = c
            .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1, "打开连接时必须清掉上次崩溃留下的抑制标记");
    }

    #[test]
    fn triggers_are_connection_local() {
        // temp 触发器的语义：另一条连接上的写入不会被这条连接捕获。这是刻意的取舍（见模块文档），
        // 钉住它免得以后有人以为「install 一次就全局生效」。
        let dir = std::env::temp_dir().join(format!(
            "marcel-rows-trigger-scope-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("scope.db");
        let a = Connection::open(&path).unwrap();
        a.execute_batch("CREATE TABLE demo(id TEXT PRIMARY KEY, v TEXT)")
            .unwrap();
        install(&a, TABLES).unwrap();
        {
            let b = Connection::open(&path).unwrap();
            b.execute("INSERT INTO demo(id, v) VALUES ('x', '1')", [])
                .unwrap();
        }
        let n: i64 = a
            .query_row("SELECT COUNT(*) FROM sync_changelog", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 0, "别的连接上的写入不归这条连接的触发器管");
        drop(a);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
