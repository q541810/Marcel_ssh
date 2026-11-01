//! 数据层守护测试：登记表自检 + 落盘位置普查。
//! （`JsonStore` 的行为测试在 `json_store.rs` 里，紧贴实现。）

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::{BaseDir, DataSourceId, SourceKind, SyncTier};
use crate::config::persist::JsonPersistable;

// ── 1. 登记表自检 ─────────────────────────────────────────────────────────

#[test]
fn registry_entries_are_unique_and_described() {
    let mut seen = HashSet::new();
    for id in DataSourceId::ALL {
        let rel = id.rel_path();
        assert!(!rel.is_empty(), "{id:?} 的 rel_path 不能为空");
        assert!(
            !rel.contains('/') && !rel.contains('\\'),
            "{id:?} 的 rel_path 只能是单层文件 / 目录名: {rel}"
        );
        assert!(
            seen.insert(rel),
            "rel_path 重复: {rel}（两份数据不能落到同一个位置）"
        );
        assert!(!id.describe().trim().is_empty(), "{id:?} 缺少中文说明");
    }
}

/// 私钥密文用本机主密钥加密，换设备解不开——所以三期起走**机密**流：
/// 同步的是「用 SK 重新封装的私钥正文」，落地时用对方自己的主密钥再加密一遍。
/// 主密钥本身（`SecretSlot::KeyStoreMaster`）仍是 Local，永不外传。
#[test]
fn key_store_is_secret_tier_not_config() {
    assert_eq!(DataSourceId::KeyStore.tier(), SyncTier::Secret);
}

/// 虚拟源没有磁盘位置，也不会被当成配置档的同步源。
#[test]
fn virtual_sources_have_no_path_and_no_sync_key() {
    assert_eq!(DataSourceId::Secrets.kind(), SourceKind::Virtual);
    assert_eq!(DataSourceId::Secrets.tier(), SyncTier::Secret);
    assert_eq!(DataSourceId::Secrets.sync_key(), None);
    assert!(DataSourceId::Secrets.sync_trigger(), "密钥链变了要触发同步");
    assert!(!DataSourceId::SyncState.sync_trigger());
    for id in DataSourceId::ALL {
        if id.kind() == SourceKind::Virtual {
            assert!(id.sync_key().is_none(), "{id:?} 虚拟源不该有同步源 key");
        }
    }
}

/// 把每一项的相对路径与分档钉成快照。
///
/// 这张表就是「老用户磁盘上的数据在哪」：改 rel_path = 老用户的数据凭空消失；
/// 改分档 = 以后同步行为变了。所以任何改动都必须在这里**显式**改一次，
/// 新增变体没补这张表时 `ALL.len()` 对不上，测试也会红。
#[test]
fn registry_snapshot_pins_paths_and_tiers() {
    use DataSourceId::*;
    use SourceKind::{Dir, File, Virtual};
    use SyncTier::{Config, Conversation, Local, Secret};
    let table: &[(DataSourceId, &str, SourceKind, SyncTier, BaseDir)] = &[
        (Settings, "settings.json", File, Config, BaseDir::Config),
        (
            Connections,
            "connections.json",
            File,
            Config,
            BaseDir::Config,
        ),
        (
            QuickCommands,
            "quick_commands.json",
            File,
            Config,
            BaseDir::Config,
        ),
        (Skills, "skills.json", File, Config, BaseDir::Config),
        (
            McpServers,
            "mcp_servers.json",
            File,
            Config,
            BaseDir::Config,
        ),
        (
            KnownHosts,
            "known_hosts.json",
            File,
            Config,
            BaseDir::Config,
        ),
        (KeyStore, "keys", Dir, Secret, BaseDir::Config),
        (
            Conversations,
            "conversations.db",
            File,
            Conversation,
            BaseDir::Config,
        ),
        (Images, "images", Dir, Conversation, BaseDir::Config),
        (Memory, "memory.db", File, Conversation, BaseDir::Config),
        (JobLedger, "jobs.json", File, Local, BaseDir::Config),
        (JobsTemp, "jobs_temp", Dir, Local, BaseDir::Config),
        (LocalCommand, "local_command", Dir, Local, BaseDir::Config),
        (Plugins, "plugins", Dir, Local, BaseDir::Config),
        (Previews, "marcel-previews", Dir, Local, BaseDir::AppData),
        (SysopenTemp, "marcel-sysopen", Dir, Local, BaseDir::AppData),
        (UpdateCache, "update", Dir, Local, BaseDir::AppCache),
        (SyncState, "sync", Dir, Local, BaseDir::Config),
        (Secrets, "secrets", Virtual, Secret, BaseDir::Config),
    ];
    assert_eq!(
        table.len(),
        DataSourceId::ALL.len(),
        "登记表有变体没进快照（或快照多了）：请显式补上路径与分档"
    );
    for (id, rel, kind, tier, base) in table {
        assert_eq!(id.rel_path(), *rel, "{id:?} 的相对路径变了");
        assert_eq!(id.kind(), *kind, "{id:?} 的文件 / 目录类型变了");
        assert_eq!(id.tier(), *tier, "{id:?} 的同步分档变了");
        assert_eq!(id.base(), *base, "{id:?} 的基准目录变了");
    }
}

#[test]
fn path_joins_onto_the_given_base() {
    let base = Path::new("base");
    assert_eq!(
        DataSourceId::Settings.path(base),
        Path::new("base").join("settings.json")
    );
    // 登记项可以相对另一份登记项取（本机执行器：local_command/ 里再放台账与溢出目录）
    let local = DataSourceId::LocalCommand.path(base);
    assert_eq!(
        DataSourceId::JobLedger.path(&local),
        Path::new("base").join("local_command").join("jobs.json")
    );
}

/// 同步源 key 是写进远端文件的字符串，改一个字等于和所有旧设备「断交」：钉死。
/// 并且只有普通配置档有 key（其余档不在一期同步范围里）。
#[test]
fn sync_keys_are_pinned_and_only_config_tier_has_one() {
    let expected: &[(DataSourceId, &str)] = &[
        (DataSourceId::Settings, "settings"),
        (DataSourceId::Connections, "connections"),
        (DataSourceId::QuickCommands, "quickCommands"),
        (DataSourceId::Skills, "skills"),
        (DataSourceId::McpServers, "mcpServers"),
        (DataSourceId::KnownHosts, "knownHosts"),
    ];
    for (id, key) in expected {
        assert_eq!(id.sync_key(), Some(*key), "{id:?} 的同步源 key 变了");
    }
    let mut seen = HashSet::new();
    for id in DataSourceId::ALL {
        match id.sync_key() {
            Some(key) => {
                assert_eq!(
                    id.tier(),
                    SyncTier::Config,
                    "{id:?} 有同步源 key 却不是 Config 档"
                );
                assert!(seen.insert(key), "同步源 key 重复: {key}");
            }
            None => assert_ne!(
                id.tier(),
                SyncTier::Config,
                "{id:?} 是 Config 档却没有同步源 key（会被同步引擎漏掉）"
            ),
        }
    }
    assert_eq!(seen.len(), expected.len());
}

/// 5 份 JSON 配置的 `SOURCE` 必须指向各自的登记项，且都是 Config 档。
#[test]
fn json_configs_are_registered_as_config_tier() {
    use crate::config::settings::AppSettings;
    use crate::config::{connections::ConnectionStore, quick_commands::QuickCommandStore};
    use crate::mcp::store::McpServerStore;
    use crate::skills::store::SkillStore;

    fn check<T: JsonPersistable>(expected: DataSourceId, file: &str) {
        assert_eq!(T::SOURCE, expected);
        assert_eq!(T::SOURCE.tier(), SyncTier::Config);
        assert_eq!(T::SOURCE.kind(), SourceKind::File);
        assert_eq!(T::default_filename(), file);
        assert_eq!(
            T::default_file(Path::new("cfg")),
            Path::new("cfg").join(file)
        );
    }
    check::<AppSettings>(DataSourceId::Settings, "settings.json");
    check::<ConnectionStore>(DataSourceId::Connections, "connections.json");
    check::<QuickCommandStore>(DataSourceId::QuickCommands, "quick_commands.json");
    check::<SkillStore>(DataSourceId::Skills, "skills.json");
    check::<McpServerStore>(DataSourceId::McpServers, "mcp_servers.json");
}

// ── 2. 落盘位置普查 ───────────────────────────────────────────────────────

/// 会被当成「自己拼落盘路径」的写法（比较前先去掉所有空白，所以 rustfmt 把链式调用
/// 拆成多行也抓得到）。覆盖应用配置目录、`app_data_dir`、`app_cache_dir` 三个基准目录。
const BASE_DIR_NAMES: &[&str] = &[
    "config_dir",
    "app_data_dir",
    "app_cache_dir",
    "app_data",
    "app_cache",
];

fn forbidden_patterns() -> Vec<String> {
    let mut out = Vec::new();
    for name in BASE_DIR_NAMES {
        out.push(format!("{name}.join("));
        out.push(format!("{name}().join("));
    }
    out
}

/// 返回 `source` 里所有违规写法所在的行号（从 1 起，已去重排序）。
fn find_violations(source: &str) -> Vec<usize> {
    // 去掉全部 ASCII 空白后再找：`config_dir\n    .join(` 这种被 rustfmt 拆开的链式调用
    // 也要抓到。同时记下每个保留字节原来在第几行，用来把命中位置映射回行号。
    let mut stripped: Vec<u8> = Vec::with_capacity(source.len());
    let mut line_of: Vec<usize> = Vec::with_capacity(source.len());
    for (i, line) in source.lines().enumerate() {
        for b in line.bytes() {
            if !b.is_ascii_whitespace() {
                stripped.push(b);
                line_of.push(i + 1);
            }
        }
    }
    // 只删了 ASCII 字节，多字节 UTF-8 序列整体保留，结果仍是合法 UTF-8。
    let stripped = String::from_utf8(stripped).expect("去掉 ASCII 空白后仍是合法 UTF-8");

    let mut hits: Vec<usize> = Vec::new();
    for pattern in forbidden_patterns() {
        for (offset, _) in stripped.match_indices(&pattern) {
            hits.push(line_of[offset]);
        }
    }
    hits.sort_unstable();
    hits.dedup();
    hits
}

fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("读取源码目录") {
        let path = entry.expect("读取目录项").path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// 落盘位置普查：`src/data/` 之外不得出现自己拼落盘路径的写法。
///
/// 不查这条，新功能很容易又在某处 `config_dir.join("xxx.json")` 悄悄落一份数据——
/// 登记表不知道它，同步引擎也就永远同步不到它。
#[test]
fn no_disk_location_is_assembled_outside_the_registry() {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let data_dir = src.join("data");
    let mut files = Vec::new();
    collect_rs_files(&src, &mut files);
    assert!(
        files.len() > 50,
        "普查只扫到 {} 个源文件，路径定位多半出了问题（{}）",
        files.len(),
        src.display()
    );

    let mut violations = Vec::new();
    for file in &files {
        if file.starts_with(&data_dir) {
            continue;
        }
        let text = std::fs::read_to_string(file).expect("读取源文件");
        for line in find_violations(&text) {
            let rel = file.strip_prefix(&src).unwrap_or(file);
            violations.push(format!("{}:{}", rel.display(), line));
        }
    }

    assert!(
        violations.is_empty(),
        "新的落盘位置必须先在 `data::DataSourceId` 登记（选好同步分档），\
         再用 `DataSourceId::X.path(config_dir)` 取路径。违规位置：\n  {}",
        violations.join("\n  ")
    );
}

/// 普查本身要抓得到：用合成片段验证每种写法都命中、正常写法不误报。
#[test]
fn census_detector_catches_the_usual_forms() {
    // 单行
    assert_eq!(
        find_violations(r#"let p = config_dir.join("x.json");"#),
        vec![1]
    );
    // 经 state / 别的前缀
    assert_eq!(
        find_violations("let a = 1;\nlet p = state.config_dir.join(\"plugins\");"),
        vec![2]
    );
    // 方法形态（`app_config_dir()` 里含 `config_dir()`）
    assert_eq!(
        find_violations(r#"app.path().app_config_dir().join("x")"#),
        vec![1]
    );
    // rustfmt 拆成多行的链式调用，报告的是 `config_dir` 所在的那一行
    assert_eq!(
        find_violations("let p = state\n    .config_dir\n    .join(\"x\");"),
        vec![2]
    );
    assert_eq!(
        find_violations("let p = config_dir()\n    .join(\"x\");"),
        vec![1]
    );
    // 另外两个基准目录
    assert_eq!(
        find_violations(r#"app_data.join("marcel-previews")"#),
        vec![1]
    );
    assert_eq!(
        find_violations(r#"app_cache_dir().join("update")"#),
        vec![1]
    );
    assert_eq!(
        find_violations(r#"let c = app_cache.join("update");"#),
        vec![1]
    );

    // 正常写法不误报：走登记表、临时目录、与落盘位置无关的 join
    assert!(find_violations("DataSourceId::Settings.path(&config_dir)").is_empty());
    assert!(find_violations("std::env::temp_dir().join(\"x\")").is_empty());
    assert!(find_violations("parts.join(\"\\n\")").is_empty());
    assert!(find_violations("let dir = config_dir.clone();").is_empty());
}
