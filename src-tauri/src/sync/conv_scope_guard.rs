//! 对话库同步作用域守护：**每一列到底跨不跨设备同步**，必须有人在加列时当场表态。
//!
//! 做法和一期 [`super::scope_guard`] 同一套：把 `CONV_TABLES` 里每张表的每一列（含 `Local`
//! 列）按「表 <TAB> 列 <TAB> 作用域」钉成快照。任何列的新增 / 删除 / 改名 / 作用域改动都会让
//! 下面这条测试变红，逼着开发者回答那个问题——而不是让本机路径（图片桶路径）悄悄跨设备同步，
//! 或者让一个该同步的字段悄悄留在本机。
//!
//! 更新快照：
//! ```text
//! UPDATE_SYNC_SNAPSHOT=1 cargo test --lib sync::conv_scope_guard
//! ```
//! 更新之后**必须看一眼 diff**，逐条确认作用域是不是想要的。
//!
//! 两条互补的守护：
//! 1. 本文件：清单里的列与作用域（**开发者的声明**）；
//! 2. `agent::conversation` 的 `messages_columns_const_matches_the_live_schema` 等：清单与
//!    真实 schema（**数据库的事实**）。
//!
//! 只有两条都绿，才说明「清单完整且作用域是有意选的」。为此这里还会真的开一个内存对话库，
//! 把 `PRAGMA table_info` 与清单逐列对比：少登记一列 = 那一列永远不同步（或落地时缺列）。

use std::collections::BTreeSet;

use super::rows::ColumnScope;
use super::streams::CONV_TABLES;

/// 快照文件（相对 `src-tauri/`）。
const SNAPSHOT_REL_PATH: &str = "src/sync/conv_scope_snapshot.txt";

fn scope_name(scope: ColumnScope) -> &'static str {
    match scope {
        ColumnScope::Shared => "shared",
        ColumnScope::Local => "local",
    }
}

/// 生成完整快照文本（表 → 列，按清单声明顺序；每行一条）。
fn render() -> String {
    let mut out = String::from(
        "# 对话库（conversations.db）跨设备同步：表 / 列作用域快照（自动生成，别手改）。\n\
         #\n\
         # 列：表 <TAB> 列 <TAB> 作用域（shared / local），末尾附主键与父表。\n\
         #\n\
         # 更新：UPDATE_SYNC_SNAPSHOT=1 cargo test --lib sync::conv_scope_guard\n\
         # 更新之后看一眼 diff：那是新增 / 改动的列清单，逐条确认作用域是不是想要的。\n",
    );
    for table in CONV_TABLES {
        for column in table.columns {
            out.push_str(&format!(
                "{}\t{}\t{}\n",
                table.name,
                column.name,
                scope_name(column.scope)
            ));
        }
        let parent = match table.parent {
            Some((fk, parent)) => format!("{fk} → {parent}"),
            None => "-".to_string(),
        };
        out.push_str(&format!(
            "#\t{}\tpk={} alias={:?} mass_delete={} parent={parent}\n",
            table.name, table.pk, table.alias, table.mass_delete_limit
        ));
    }
    out
}

fn snapshot_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SNAPSHOT_REL_PATH)
}

fn diff_summary(expected: &str, actual: &str) -> String {
    let body = |s: &str| -> BTreeSet<String> {
        s.lines()
            .filter(|l| !l.starts_with('#') && !l.trim().is_empty())
            .map(str::to_string)
            .collect()
    };
    let (e, a) = (body(expected), body(actual));
    let mut out = String::new();
    for line in a.difference(&e) {
        out.push_str(&format!("  + {line}\n"));
    }
    for line in e.difference(&a) {
        out.push_str(&format!("  - {line}\n"));
    }
    out
}

#[test]
fn conv_tables_declare_every_column_scope() {
    let expected = render();
    let path = snapshot_path();
    if std::env::var("UPDATE_SYNC_SNAPSHOT").is_ok() {
        crate::config::persist::atomic_write(&path, &expected).expect("写快照");
        return;
    }
    // 快照是 LF 文本；Windows 上 core.autocrlf 签出时可能变成 CRLF，统一成 LF 再比。
    let actual = std::fs::read_to_string(&path)
        .map(|s| s.replace("\r\n", "\n"))
        .unwrap_or_else(|e| {
            panic!(
                "读不到对话库作用域快照 {}: {e}\n\
                 第一次生成请运行：UPDATE_SYNC_SNAPSHOT=1 cargo test --lib sync::conv_scope_guard",
                path.display()
            )
        });
    assert!(
        expected == actual,
        "对话库的同步列 / 作用域和快照对不上：\n{}\n\
         出现新的列：默认别加进清单就完事——先想清楚它跨不跨设备同步。\n\
         本机路径（图片桶）、本机自增 id 一类标 Local；其余标 Shared。\n\
         然后运行 UPDATE_SYNC_SNAPSHOT=1 cargo test --lib sync::conv_scope_guard\n\
         更新快照（更新完看一眼 diff，确认每一条都是有意为之）。",
        diff_summary(&expected, &actual)
    );
}

/// 清单必须覆盖**真实 schema 的每一列**（少一列 = 那一列永远不参与同步；落地时插入新行
/// 还会因为缺列（NOT NULL 无默认值）整批回滚）。
#[test]
fn conv_table_columns_match_the_live_schema() {
    let db = crate::agent::conversation::ConversationDb::in_memory().expect("内存对话库");
    let live = db.live_columns_for_sync_test();
    for table in CONV_TABLES {
        let columns = live
            .get(table.name)
            .unwrap_or_else(|| panic!("真实 schema 里没有表 {}", table.name));
        let declared: Vec<&str> = table.columns.iter().map(|c| c.name).collect();
        assert_eq!(
            declared.as_slice(),
            columns.as_slice(),
            "{} 的同步清单与真实 schema 不一致（加列时两边都要改）",
            table.name
        );
    }
}

/// 反向守护：这几列一旦被标成 Shared 就是事故。
#[test]
fn the_known_machine_local_columns_stay_local() {
    let messages = CONV_TABLES
        .iter()
        .find(|t| t.name == "messages")
        .expect("messages 在清单里");
    let image_paths = messages
        .column("image_paths_json")
        .expect("image_paths_json 在清单里");
    assert_eq!(
        image_paths.scope,
        ColumnScope::Local,
        "本机图片桶路径不能跨设备（别的设备上没有那些文件，图片本身走 blob 流）"
    );
    let plan_snapshots = CONV_TABLES
        .iter()
        .find(|t| t.name == "plan_snapshots")
        .expect("plan_snapshots 在清单里");
    assert_eq!(
        plan_snapshots.column("id").map(|c| c.scope),
        Some(ColumnScope::Local),
        "自增 id 是本机物理行号，跨设备没有意义、写进对端还会与已有主键冲突"
    );
    // 稳定 id 必须是同步主键，否则整张表根本没法按行同步。
    assert_eq!(plan_snapshots.pk, "uid");
    let conversations = CONV_TABLES
        .iter()
        .find(|t| t.name == "conversations")
        .expect("conversations 在清单里");
    assert_eq!(conversations.mass_delete_limit, 20, "大量删除闸的默认阈值");
    assert_eq!(
        conversations.alias,
        super::rows::AliasColumn::ConnectionId,
        "connection_id 必须过别名换算"
    );
}
