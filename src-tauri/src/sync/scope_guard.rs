//! 新字段守护：**每个配置字段到底是跨设备同步、还是只留在本机**，必须有人在加字段时当场表态。
//!
//! 做法是把六个同步源「当前的字段清单 + 它们各自的作用域」钉成快照
//! （`src-tauri/src/sync/scope_snapshot.txt`，提交进仓库）。任何新增字段或作用域改动都会让
//! 下面几个测试变红，逼着开发者回答那个问题——而不是让新字段悄悄默认跨设备同步（把本机路径、
//! 窗口尺寸推到别的设备上），或者悄悄不同步（用户以为改了会跟着走）。
//!
//! 更新快照：
//! ```text
//! UPDATE_SYNC_SNAPSHOT=1 cargo test --lib sync::scope_guard
//! ```
//! 更新之后**必须看一眼 diff**：那是这次新增/改动的字段清单，逐条确认作用域是不是想要的。
//!
//! 为什么用「填满所有字段的样例」而不是读线上数据：线上数据里可选字段通常是空的
//! （`Option::None`、空 `Vec`），只看真实数据会漏掉所有可选字段——而它们恰恰是最容易
//! 藏着本机路径（`keyPath`）和窗口尺寸的那一类。

use std::collections::BTreeSet;

use serde_json::Value;

use super::core::flatten::flatten_with;
use super::core::{IdMapRegistry, Platform, Scope, ScopeRules, Seg};
use super::scopes;
use crate::config::connections::{ConnectionStore, SavedConnection};
use crate::config::quick_commands::{QuickCommandInput, QuickCommandScope, QuickCommandStore};
use crate::config::settings::AppSettings;
use crate::data::DataSourceId;
use crate::mcp::store::{McpServerConfig, McpServerInput, McpServerStore};
use crate::skills::builtin::VISUALIZE_SKILL_ID;
use crate::skills::store::{Skill, SkillResource, SkillStore};

/// 快照文件（相对 `src-tauri/`）。
const SNAPSHOT_REL_PATH: &str = "src/sync/scope_snapshot.txt";

// ---------------------------------------------------------------------------
// 「每个可选字段都填上」的样例
// ---------------------------------------------------------------------------

/// 设置：`Default` 序列化已经覆盖了所有「必填 + Option」字段（`null` 也算这个字段存在——
/// 快照记的是**路径**，不看值）。这里补的是那些默认是空集合、又带 `skip_serializing_if`
/// 而根本不会出现在默认序列化结果里的结构；不塞进去，它们的子字段就永远不受守护。
fn settings_sample() -> Value {
    let mut v = serde_json::to_value(AppSettings::default()).expect("设置默认值可序列化");
    let obj = v.as_object_mut().expect("设置是对象");

    obj.insert(
        "uiTheme".into(),
        serde_json::json!({
            "zones": {"bg": "#000000", "fg": "#ffffff"},
            "fontScale": 1.0,
            "cornerRadius": 8,
        }),
    );
    obj.insert(
        "llmRegistry".into(),
        serde_json::json!({
            "version": 1,
            "channels": [{
                "id": "ch-1",
                "name": "渠道",
                "kind": "openai",
                "baseUrl": "https://example.com",
                "models": [{
                    "id": "m-1",
                    "name": "模型",
                    "modelName": "gpt",
                    "contextWindow": 128000,
                    "maxOutputTokens": 4096,
                }],
                "enabled": true,
            }],
        }),
    );
    obj.insert(
        "agentModeSettings".into(),
        serde_json::json!({
            "maxToolRounds": 500,
            "autoApprove": false,
            "systemPromptAppend": "",
        }),
    );
    obj.insert(
        "experimentalSettings".into(),
        serde_json::json!({
            "multiHostConnectionIds": ["c-1"],
            "enabledTools": ["shell"],
            "disabledTools": [],
        }),
    );
    obj.insert("customProtectedPaths".into(), serde_json::json!(["/etc"]));
    obj.insert("disabledPlugins".into(), serde_json::json!(["p1"]));
    obj.insert(
        "authorizedCapabilities".into(),
        serde_json::json!(["ssh.list"]),
    );
    obj.insert(
        "workspaceLayout".into(),
        serde_json::json!({"sizes": [1, 2], "activeTab": "files"}),
    );
    obj.insert("fileManagerPaths".into(), serde_json::json!(["/home"]));
    obj.insert(
        "fileManagerTreeUserHidden".into(),
        serde_json::json!(["node_modules"]),
    );
    obj.insert(
        "notificationSettings".into(),
        serde_json::json!({"enabled": true, "notificationVolume": 70, "sound": "default"}),
    );
    obj.insert(
        "mobileNotificationSettings".into(),
        serde_json::json!({"enabled": true, "agentTaskDone": true, "agentError": true}),
    );
    obj.insert(
        "mobileBackgroundSettings".into(),
        serde_json::json!({"keepAlive": false, "keepAliveMinutes": 30}),
    );
    obj.insert(
        "customRiskRules".into(),
        serde_json::json!([{
            "id": "r-1",
            "name": "规则",
            "command": "rm",
            "argContains": "-rf",
            "level": "ask",
            "enabled": true,
            "message": "",
        }]),
    );
    obj.insert(
        "riskRuleOverrides".into(),
        serde_json::json!({"shell.rm": "deny"}),
    );
    v
}

fn connections_sample() -> Value {
    let mut store = ConnectionStore::new();
    store.add(SavedConnection {
        id: "c-1".into(),
        name: "服务器".into(),
        host: "example.com".into(),
        port: 22,
        username: "root".into(),
        auth_method: "PrivateKey".into(),
        key_path: Some("/home/u/.ssh/id_ed25519".into()),
        key_id: Some("key-1".into()),
        group: Some("生产".into()),
        last_connected: Some(chrono::Utc::now()),
        use_jump: true,
        jump_host: Some("jump.example.com".into()),
        jump_port: Some(2222),
        jump_username: Some("jumpuser".into()),
        jump_auth_method: Some("Password".into()),
        jump_key_path: Some("/home/u/.ssh/jump".into()),
        jump_key_id: Some("key-2".into()),
        remote_platform: None,
    });
    serde_json::to_value(&store).expect("连接可序列化")
}

fn quick_commands_sample() -> Value {
    let mut store = QuickCommandStore::new();
    store
        .add(
            "q-1".into(),
            QuickCommandInput {
                scope: QuickCommandScope::Session,
                session_key: Some("c-1".into()),
                name: "重启 nginx".into(),
                commands: vec!["systemctl restart nginx".into()],
                interval_ms: 1000,
                insert_only: true,
            },
        )
        .expect("快捷指令样例合法");
    serde_json::to_value(&store).expect("快捷指令可序列化")
}

fn skills_sample() -> Value {
    let mut store = SkillStore::new();
    let mut user = Skill::new("部署", "把服务部署上去", "步骤……");
    user.id = "skill-user".into();
    user.resources = vec![SkillResource {
        path: "notes.md".into(),
        content: "备注".into(),
    }];
    user.position = 1.5;
    store.add(user);
    // 内置 skill 走 item_filter（只同步 enabled）：它也必须出现在快照里，
    // 否则「内置 skill 的内容不该跨设备覆盖」这条规则失效了也没人发现。
    let mut builtin = Skill::new("可视化", "", "");
    builtin.id = VISUALIZE_SKILL_ID.to_string();
    store.add(builtin);
    serde_json::to_value(&store).expect("技能可序列化")
}

fn mcp_servers_sample() -> Value {
    let mut store = McpServerStore::new();
    store.add(
        McpServerConfig::new(McpServerInput {
            name: "服务".into(),
            url: "https://mcp.example.com/sse".into(),
            headers: [("Authorization".to_string(), "Bearer x".to_string())]
                .into_iter()
                .collect(),
            enabled: true,
            trusted: true,
        })
        .expect("MCP 样例合法"),
    );
    serde_json::to_value(&store).expect("MCP 可序列化")
}

fn known_hosts_sample() -> Value {
    serde_json::json!({
        "version": 1,
        "entries": {
            "example.com:22": {
                "algorithm": "ssh-ed25519",
                "fingerprint_sha256": "SHA256:abc",
                "first_seen": "2026-01-01T00:00:00Z",
                "last_seen": "2026-01-01T00:00:00Z",
            }
        }
    })
}

/// 下游样例的顺序与适配器一致：设置、连接、快捷指令、技能、MCP、known_hosts。
fn all_samples() -> Vec<(&'static str, &'static ScopeRules, Value)> {
    vec![
        ("settings", &scopes::SETTINGS_RULES, settings_sample()),
        (
            "connections",
            &scopes::CONNECTIONS_RULES,
            connections_sample(),
        ),
        (
            "quickCommands",
            &scopes::QUICK_COMMANDS_RULES,
            quick_commands_sample(),
        ),
        ("skills", &scopes::SKILLS_RULES, skills_sample()),
        (
            "mcpServers",
            &scopes::MCP_SERVERS_RULES,
            mcp_servers_sample(),
        ),
        (
            "knownHosts",
            &scopes::KNOWN_HOSTS_RULES,
            known_hosts_sample(),
        ),
    ]
}

// ---------------------------------------------------------------------------
// 快照生成
// ---------------------------------------------------------------------------

/// 作用域模式的实际生效结果（叶子路径 → 作用域）。**这是快照的全部内容**。
///
/// 用 `rules = None` 展开（**不过滤** Local），再逐个路径问 `scope_of`：这样 `local` / `platform`
/// 的条目才会出现在快照里。若用 `flatten_scoped`，Local 叶子会被直接丢掉，快照只剩 shared——
/// 那正好失去了守护作用域的意义（作用域改错了也看不出来）。
///
/// id 段记作 `\*`：快照记的是「这类字段在哪、管不管」，不是具体条目。
fn scope_lines(key: &str, rules: &ScopeRules, sample: &Value) -> Vec<String> {
    let mut reg = IdMapRegistry::new();
    crate::sync::core::learn_id_maps(sample, &mut reg);
    let flat = flatten_with(sample, &reg, None, Platform::Desktop);
    flat.keys()
        .map(|path| {
            let joined = path
                .iter()
                .enumerate()
                .map(|(i, seg)| pattern_seg(key, path, i, seg))
                .collect::<Vec<_>>()
                .join(" / ");
            format!("{key}\t{joined}\t{}", scope_name(rules.scope_of(path)))
        })
        .collect()
}

/// 路径里「随具体数据变化」的那一段在快照里一律记成 `*`：
/// - id 映射的元素段（`connections/<uuid>/…`）；
/// - known_hosts 的 `entries/<host:port>`（主机名不该污染快照，否则换台机器跑就红）；
/// - MCP 的 `servers/<id>/headers/<任意请求头名>`（头的名字是用户随便填的）。
fn pattern_seg(key: &str, path: &[Seg], index: usize, seg: &Seg) -> String {
    match seg {
        Seg::Id { .. } => "*".to_string(),
        // 顺序叶子本身不携带字段信息，但它的存在是设计的一部分（重排要能同步），保留
        Seg::Order { .. } => "(顺序)".to_string(),
        Seg::Key(k) => {
            let parent = index
                .checked_sub(1)
                .and_then(|i| path.get(i))
                .and_then(|s| match s {
                    Seg::Key(p) => Some(p.as_str()),
                    _ => None,
                });
            let variable_slot = (key == "knownHosts" && index == 1 && parent == Some("entries"))
                || (key == "mcpServers" && index == 3 && parent == Some("headers"));
            if variable_slot {
                "*".to_string()
            } else {
                k.clone()
            }
        }
    }
}

fn scope_name(scope: Scope) -> &'static str {
    match scope {
        Scope::Shared => "shared",
        Scope::Local => "local",
        Scope::Platform => "platform",
    }
}

/// 生成完整快照文本（排序、每行一条）。
fn render() -> String {
    let mut lines: BTreeSet<String> = BTreeSet::new();
    for (key, rules, sample) in all_samples() {
        lines.extend(scope_lines(key, rules, &sample));
    }
    let mut out = String::from(
        "# 跨设备同步：每个配置字段的作用域快照（自动生成，别手改）。\n\
         #\n\
         # 列：同步源 <TAB> 字段路径（id 段记作 *）<TAB> 作用域（shared / local / platform）\n\
         #\n\
         # 更新：UPDATE_SYNC_SNAPSHOT=1 cargo test --lib sync::scope_guard\n\
         # 更新之后看一眼 diff：那是新增 / 改动的字段清单，逐条确认作用域是不是想要的。\n",
    );
    for line in lines {
        out.push_str(&line);
        out.push('\n');
    }
    out
}

fn snapshot_path() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(SNAPSHOT_REL_PATH)
}

/// 只列出「多了什么 / 少了什么」，逐行对应，方便定位。
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

/// 快照是纯文本，但 git 在 Windows 上可能把检出内容写成 CRLF（本机 `core.autocrlf=true`，
/// GitHub 的 windows 运行器默认也是 true）。`render()` 生成的一律是 LF，直接按字节比，
/// 换行风格就会把「内容完全一致」误报成「有字段没声明作用域」，还因为差异集合为空而看不出原因。
/// 所以两边都先归一化换行，再比较。
fn normalize_eol(text: &str) -> String {
    text.replace("\r\n", "\n")
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[test]
fn every_config_field_declares_its_sync_scope() {
    let expected = render();
    let path = snapshot_path();
    if std::env::var("UPDATE_SYNC_SNAPSHOT").is_ok() {
        crate::config::persist::atomic_write(&path, &expected).expect("写快照");
        return;
    }
    // 快照是 LF 文本；Windows 上 core.autocrlf 签出时可能变成 CRLF，统一成 LF 再比，
    // 否则只有行尾不同也会整份判红（diff_summary 按行去重看不出差异）。
    let actual = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "读不到作用域快照 {}: {e}\n\
             第一次生成请运行：UPDATE_SYNC_SNAPSHOT=1 cargo test --lib sync::scope_guard",
            path.display()
        )
    });
    let (expected, actual) = (normalize_eol(&expected), normalize_eol(&actual));
    assert!(
        expected == actual,
        "配置字段的作用域和快照对不上：\n{}\n\
         出现新的配置字段：默认会跨设备同步。如果它只该留在本机（窗口尺寸、本机路径、本机授权……），\n\
         在对应 `scopes::*_RULES` 里标 Local / Platform，然后运行\n\
         UPDATE_SYNC_SNAPSHOT=1 cargo test --lib sync::scope_guard\n\
         更新快照（更新完看一眼 diff，确认每一条都是有意为之）。",
        diff_summary(&expected, &actual)
    );
}

#[test]
fn the_known_machine_local_fields_are_marked_local() {
    // 反向守护：这几种「绝对不能跨设备带过去」的东西一旦被改成 Shared，立刻失败。
    // 快照测试能发现「字段新增 / 作用域变化」，这条说清「哪几条是不能松口的底线」。
    let k = |s: &str| vec![Seg::key(s)];
    let cases: &[(&ScopeRules, &[Seg], &str)] = &[
        (
            &scopes::SETTINGS_RULES,
            &[Seg::key("panelHeight")],
            "panelHeight",
        ),
        (
            &scopes::SETTINGS_RULES,
            &[Seg::key("fileManagerPath")],
            "fileManagerPath",
        ),
        (
            &scopes::SETTINGS_RULES,
            &[Seg::key("hasCompletedOnboarding")],
            "hasCompletedOnboarding",
        ),
        (
            &scopes::CONNECTIONS_RULES,
            &[Seg::key("connections"), Seg::id("c1"), Seg::key("keyPath")],
            "connections/*/keyPath",
        ),
        (
            &scopes::CONNECTIONS_RULES,
            &[Seg::key("connections"), Seg::id("c1"), Seg::key("keyId")],
            "connections/*/keyId",
        ),
        (
            &scopes::CONNECTIONS_RULES,
            &[
                Seg::key("connections"),
                Seg::id("c1"),
                Seg::key("lastConnected"),
            ],
            "connections/*/lastConnected",
        ),
        (
            &scopes::MCP_SERVERS_RULES,
            &[Seg::key("servers"), Seg::id("s1"), Seg::key("headers")],
            "servers/*/headers",
        ),
        (
            &scopes::MCP_SERVERS_RULES,
            &[Seg::key("servers"), Seg::id("s1"), Seg::key("trusted")],
            "servers/*/trusted",
        ),
        (
            &scopes::KNOWN_HOSTS_RULES,
            &[Seg::key("entries"), Seg::key("h:22"), Seg::key("last_seen")],
            "entries/*/last_seen",
        ),
    ];
    for (rules, path, name) in cases {
        assert_eq!(
            rules.scope_of(path),
            Scope::Local,
            "{name} 必须只留在本机（本机路径 / 本机授权 / 每次都变的流水）"
        );
    }
    let _ = k;
    // 平台字段：两个平台各一份，互相不覆盖
    for name in [
        "fontSize",
        "notificationSettings",
        "mobileNotificationSettings",
    ] {
        assert_eq!(
            scopes::SETTINGS_RULES.scope_of(&[Seg::key(name)]),
            Scope::Platform,
            "{name} 应当桌面 / 手机各存一份"
        );
    }
    // 内置 skill 只同步 enabled；用户 skill 全同步
    let list = [Seg::key("skills")];
    let builtin = serde_json::json!({"id": VISUALIZE_SKILL_ID, "name": "内置", "enabled": true});
    assert_eq!(
        scopes::SKILLS_RULES.item_keep(&list, &builtin),
        super::core::ItemKeep::Only(&["enabled"])
    );
    let user = serde_json::json!({"id": "user-skill", "name": "我的"});
    assert_eq!(
        scopes::SKILLS_RULES.item_keep(&list, &user),
        super::core::ItemKeep::All
    );
    // mcp-temp- 临时连接整条 Local
    let conns = [Seg::key("connections")];
    let temp = serde_json::json!({"id": "mcp-temp-1", "host": "h"});
    assert_eq!(
        scopes::CONNECTIONS_RULES.item_keep(&conns, &temp),
        super::core::ItemKeep::Only(&[])
    );
}

#[test]
fn every_source_in_the_registry_has_a_sample_and_rules() {
    // 漏掉一个源 = 那个源的字段完全不受守护
    let sources: Vec<&str> = all_samples().iter().map(|(k, _, _)| *k).collect();
    let registry: BTreeSet<&str> = DataSourceId::ALL
        .iter()
        .filter_map(|id| id.sync_key())
        .collect();
    assert_eq!(
        sources.iter().copied().collect::<BTreeSet<_>>(),
        registry,
        "每个同步源都要有样例与规则，否则它的字段没有守护"
    );
    // 样例展开后不能是空的（写错的样例等于没有守护）
    for (key, rules, sample) in all_samples() {
        assert!(
            !scope_lines(key, rules, &sample).is_empty(),
            "{key} 的样例展开后一个叶子都没有"
        );
    }
}
