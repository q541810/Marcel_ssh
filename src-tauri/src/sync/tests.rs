//! 跨设备同步运行时的多设备集成测试。
//!
//! 每台模拟设备有自己的临时配置目录、自己的一套 `JsonStore` / known_hosts、自己的内存密钥链和
//! 自己的引擎；它们共用同一个 `MemoryStorage`（= 同一个云端）和一个共享的假墙钟（每次取时间
//! 前进一秒，保证「后做的修改」确定地比「先做的」新）。**没有任何测试碰真实的系统密钥链。**
//!
//! 覆盖：开启 → 加入（重复连接去重、本机独有保留、引用改写）、双向修改、同一字段冲突、删除与复活、
//! 防抖窗口内的本机改动不被吞、大量删除闸（放行 / 撤销）、FormatTooNew、配置损坏恢复、版本升级、
//! known_hosts 指纹冲突、同步记录与撤销、压缩、停止同步、机密不落盘、actor 触发。

use std::collections::HashSet;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{json, Value};
use tempfile::TempDir;
use zeroize::Zeroizing;

use super::backends::MemoryBackends;
use super::core::crypto::{self, FileKind};
use super::core::format::{self, DEVICES_DIR, META_FILE};
use super::core::Platform;
use super::engine::{JoinSpec, RoundKind, SharedView, SyncDeps, SyncEngine, SyncEvents};
use super::history::HistoryStore;
use super::manager::{SyncManager, Timing};
use super::secrets::{MemorySecrets, SyncSecretStore};
use super::sources::{build_adapters, SourceStores};
use super::storage::{MemoryStorage, StorageConfig, SyncStorage};
use super::store::LedgerFiles;
use super::types::{HistoryKind, SyncState, SyncStatus};
use crate::config::connections::{ConnectionStore, SavedConnection};
use crate::config::keychain::SecretSlot;
use crate::config::persist::JsonPersistable;
use crate::config::quick_commands::{QuickCommandInput, QuickCommandScope, QuickCommandStore};
use crate::config::settings::AppSettings;
use crate::data::{DataChangeBus, DataSourceId, JsonStore};
use crate::mcp::manager::McpManager;
use crate::mcp::store::McpServerStore;
use crate::skills::store::{Skill, SkillStore};
use crate::ssh::known_hosts::{KnownHostEntry, KnownHostsStore};

const PASSWORD: &str = "pw-very-secret-123";

fn webdav() -> StorageConfig {
    StorageConfig::WebDav {
        url: "https://dav.example.com/dav/".into(),
        username: "me@example.com".into(),
        root: "marcel-sync".into(),
    }
}

#[derive(Default)]
struct TestEvents {
    applied: Mutex<Vec<String>>,
    statuses: Mutex<Vec<SyncStatus>>,
}

impl SyncEvents for TestEvents {
    fn status(&self, status: &SyncStatus) {
        self.statuses.lock().push(status.clone());
    }
    fn data_applied(&self, source: &str) {
        self.applied.lock().push(source.to_string());
    }
}

struct Dev {
    name: &'static str,
    dir: TempDir,
    bus: DataChangeBus,
    settings: JsonStore<AppSettings>,
    connections: JsonStore<ConnectionStore>,
    quick: JsonStore<QuickCommandStore>,
    skills: JsonStore<SkillStore>,
    mcp: JsonStore<McpServerStore>,
    known_hosts: Arc<KnownHostsStore>,
    secrets: Arc<MemorySecrets>,
    events: Arc<TestEvents>,
    cloud: MemoryStorage,
    clock: Arc<AtomicU64>,
    platform: Platform,
    view: Arc<SharedView>,
    engine: SyncEngine,
}

fn new_clock() -> Arc<AtomicU64> {
    Arc::new(AtomicU64::new(1_760_000_000_000))
}

impl Dev {
    async fn new(
        name: &'static str,
        cloud: &MemoryStorage,
        clock: &Arc<AtomicU64>,
        platform: Platform,
    ) -> Dev {
        let dir = tempfile::Builder::new()
            .prefix(&format!("marcel-sync-{name}-"))
            .tempdir()
            .unwrap();
        let bus = DataChangeBus::new();
        let mut skill_store = SkillStore::new();
        crate::skills::builtin::ensure_builtin_skills(&mut skill_store);
        let known_hosts = KnownHostsStore::load_in_config_dir(dir.path(), Some(bus.clone()))
            .await
            .unwrap();
        let mut dev = Dev {
            name,
            settings: JsonStore::new(dir.path(), AppSettings::default(), Some(bus.clone())),
            connections: JsonStore::new(dir.path(), ConnectionStore::new(), Some(bus.clone())),
            quick: JsonStore::new(dir.path(), QuickCommandStore::new(), Some(bus.clone())),
            skills: JsonStore::new(dir.path(), skill_store, Some(bus.clone())),
            mcp: JsonStore::new(dir.path(), McpServerStore::new(), Some(bus.clone())),
            known_hosts,
            secrets: Arc::new(MemorySecrets::new()),
            events: Arc::new(TestEvents::default()),
            cloud: cloud.clone(),
            clock: clock.clone(),
            platform,
            view: Arc::new(SharedView::new(HistoryStore::empty(
                LedgerFiles::new(dir.path()).history_file(),
            ))),
            // 占位：下面立刻换成真引擎
            engine: placeholder_engine(),
            bus,
            dir,
        };
        dev.rebuild_engine("1.12.0", Vec::new());
        dev
    }

    fn deps(&self, version: &str, failures: Vec<DataSourceId>) -> Arc<SyncDeps> {
        self.deps_with(version, failures, false)
    }

    /// 带机密流驱动的依赖（三期集成测试用）。
    fn deps_with_secrets(&self, version: &str, failures: Vec<DataSourceId>) -> Arc<SyncDeps> {
        self.deps_with(version, failures, true)
    }

    fn deps_with(
        &self,
        version: &str,
        failures: Vec<DataSourceId>,
        with_secrets_driver: bool,
    ) -> Arc<SyncDeps> {
        let stores = SourceStores {
            settings: self.settings.clone(),
            connections: self.connections.clone(),
            quick_commands: self.quick.clone(),
            skills: self.skills.clone(),
            mcp_servers: self.mcp.clone(),
            known_hosts: self.known_hosts.clone(),
            mcp_manager: Arc::new(McpManager::new()),
        };
        let secrets: Arc<dyn SyncSecretStore> = self.secrets.clone();
        let clock = self.clock.clone();
        Arc::new(SyncDeps {
            config_dir: self.dir.path().to_path_buf(),
            adapters: build_adapters(&stores, secrets.clone()),
            settings: self.settings.clone(),
            connections: self.connections.clone(),
            known_hosts: self.known_hosts.clone(),
            secrets,
            backends: Arc::new(MemoryBackends {
                storage: self.cloud.clone(),
            }),
            events: self.events.clone(),
            now_ms: Arc::new(move || clock.fetch_add(1000, Ordering::SeqCst)),
            app_version: version.to_string(),
            platform: self.platform,
            default_device_name: format!("设备{}", self.name),
            load_failures: failures,
            stream_drivers: if with_secrets_driver {
                vec![self.secret_factory()]
            } else {
                Vec::new()
            },
        })
    }

    /// 机密流工厂：catalog 从本机 store 现取，设备 id 用测试设备的 id。
    fn secret_factory(&self) -> Arc<dyn crate::sync::streams::StreamDriverFactory> {
        let connections = self.connections.clone();
        let settings = self.settings.clone();
        let mcp = self.mcp.clone();
        let device = self.engine.ledger.st.device_id.clone();
        Arc::new(crate::sync::streams::sec::SecretStreamFactory::new(
            crate::sync::streams::sec::SecretFactoryDeps {
                config_dir: self.dir.path().to_path_buf(),
                secrets: self.secrets.clone(),
                catalog: Arc::new(move || crate::config::keychain::SecretSlotCatalog {
                    connection_ids: futures::executor::block_on(async {
                        connections
                            .read()
                            .await
                            .connections
                            .iter()
                            .map(|c| c.id.clone())
                            .collect()
                    }),
                    channel_ids: futures::executor::block_on(async {
                        settings
                            .read()
                            .await
                            .llm_registry
                            .channels
                            .iter()
                            .map(|c| c.id.clone())
                            .collect()
                    }),
                    mcp_ids: futures::executor::block_on(async {
                        mcp.read()
                            .await
                            .servers
                            .iter()
                            .map(|s| s.id.clone())
                            .collect()
                    }),
                }),
                device: Arc::new(move || device.clone()),
                pending: Arc::new(|| 0),
            },
        ))
    }

    /// 「重启应用」：同一个配置目录上重新构造引擎（账本从磁盘读回来）。
    fn rebuild_engine(&mut self, version: &str, failures: Vec<DataSourceId>) {
        let files = LedgerFiles::new(self.dir.path());
        self.view = Arc::new(SharedView::new(HistoryStore::load(files.history_file())));
        self.engine = SyncEngine::new(self.deps(version, failures), self.view.clone());
    }

    async fn create(&mut self) -> (String, String) {
        let r = self
            .engine
            .create(webdav(), Some(Zeroizing::new(PASSWORD.to_string())))
            .await
            .expect("create");
        (r.recovery_key.clone(), r.sync_code.clone())
    }

    async fn join_code(&mut self, code: &str) -> Result<(), crate::error::AppError> {
        self.engine
            .join(JoinSpec::Code(Zeroizing::new(code.to_string())))
            .await
    }

    async fn sync(&mut self) {
        self.engine
            .run_round(RoundKind::Full)
            .await
            .unwrap_or_else(|e| panic!("{} 同步失败: {e}", self.name));
    }

    async fn sync_err(&mut self) -> String {
        match self.engine.run_round(RoundKind::Full).await {
            Ok(()) => panic!("{} 本应同步失败", self.name),
            Err(e) => super::engine::plain_error(&e),
        }
    }

    fn adapter_doc(&self, key: &str) -> Value {
        let adapters = self.engine_deps_adapters();
        let a = adapters.iter().find(|a| a.key() == key).unwrap().clone();
        futures::executor::block_on(a.read_json()).unwrap()
    }

    fn engine_deps_adapters(&self) -> Vec<Arc<dyn super::sources::SourceAdapter>> {
        let stores = SourceStores {
            settings: self.settings.clone(),
            connections: self.connections.clone(),
            quick_commands: self.quick.clone(),
            skills: self.skills.clone(),
            mcp_servers: self.mcp.clone(),
            known_hosts: self.known_hosts.clone(),
            mcp_manager: Arc::new(McpManager::new()),
        };
        build_adapters(&stores, self.secrets.clone())
    }

    async fn conn_ids(&self) -> Vec<String> {
        self.connections
            .read()
            .await
            .connections
            .iter()
            .map(|c| c.id.clone())
            .collect()
    }

    async fn conn(&self, id: &str) -> Option<SavedConnection> {
        self.connections.read().await.get_by_id(id).cloned()
    }

    async fn add_conn(&self, id: &str, name: &str, host: &str, user: &str) {
        let c = conn(id, name, host, user);
        self.connections
            .mutate(move |s| {
                s.add(c);
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn edit_conn(&self, id: &str, f: impl FnOnce(&mut SavedConnection) + Send) {
        let id = id.to_string();
        self.connections
            .mutate(move |s| {
                if let Some(c) = s.connections.iter_mut().find(|c| c.id == id) {
                    f(c);
                }
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn remove_conn(&self, id: &str) {
        let id = id.to_string();
        self.connections
            .mutate(move |s| {
                s.remove(&id);
                Ok(())
            })
            .await
            .unwrap();
    }

    async fn font_size(&self) -> u16 {
        self.settings.read().await.font_size
    }

    fn history(&self) -> Vec<super::types::SyncHistoryEntry> {
        self.view.history.lock().list(500)
    }

    fn status(&self) -> SyncStatus {
        self.engine.status()
    }
}

/// 一个永远不会被用到的引擎，只为让 `Dev` 能先构造出来。
fn placeholder_engine() -> SyncEngine {
    let dir = tempfile::tempdir().unwrap();
    let stores = SourceStores {
        settings: JsonStore::new(dir.path(), AppSettings::default(), None),
        connections: JsonStore::new(dir.path(), ConnectionStore::new(), None),
        quick_commands: JsonStore::new(dir.path(), QuickCommandStore::new(), None),
        skills: JsonStore::new(dir.path(), SkillStore::new(), None),
        mcp_servers: JsonStore::new(dir.path(), McpServerStore::new(), None),
        known_hosts: KnownHostsStore::in_memory(),
        mcp_manager: Arc::new(McpManager::new()),
    };
    let secrets: Arc<dyn SyncSecretStore> = Arc::new(MemorySecrets::new());
    let deps = Arc::new(SyncDeps {
        config_dir: dir.path().to_path_buf(),
        adapters: build_adapters(&stores, secrets.clone()),
        settings: stores.settings.clone(),
        connections: stores.connections.clone(),
        known_hosts: stores.known_hosts.clone(),
        secrets,
        backends: Arc::new(MemoryBackends {
            storage: MemoryStorage::new(),
        }),
        events: Arc::new(TestEvents::default()),
        now_ms: Arc::new(|| 0),
        app_version: "0".into(),
        platform: Platform::Desktop,
        default_device_name: "x".into(),
        load_failures: Vec::new(),
        stream_drivers: Vec::new(),
    });
    let view = Arc::new(SharedView::new(HistoryStore::empty(
        dir.path().join("h.json"),
    )));
    SyncEngine::new(deps, view)
}

fn conn(id: &str, name: &str, host: &str, user: &str) -> SavedConnection {
    SavedConnection {
        id: id.into(),
        name: name.into(),
        host: host.into(),
        port: 22,
        username: user.into(),
        auth_method: "Password".into(),
        key_path: None,
        key_id: None,
        group: None,
        last_connected: None,
        use_jump: false,
        jump_host: None,
        jump_port: None,
        jump_username: None,
        jump_auth_method: None,
        jump_key_path: None,
        jump_key_id: None,
        remote_platform: None,
    }
}

fn qc_input(name: &str, session_key: Option<&str>) -> QuickCommandInput {
    QuickCommandInput {
        scope: if session_key.is_some() {
            QuickCommandScope::Session
        } else {
            QuickCommandScope::Global
        },
        session_key: session_key.map(String::from),
        name: name.into(),
        commands: vec!["echo hi".into()],
        interval_ms: 0,
        insert_only: false,
    }
}

fn host_entry(fp: &str) -> KnownHostEntry {
    KnownHostEntry {
        algorithm: "ssh-ed25519".into(),
        fingerprint_sha256: fp.into(),
        first_seen: "2026-01-01T00:00:00Z".into(),
        last_seen: "2026-01-01T00:00:00Z".into(),
    }
}

async fn pair() -> (Dev, Dev, MemoryStorage) {
    let cloud = MemoryStorage::new();
    let clock = new_clock();
    let a = Dev::new("A", &cloud, &clock, Platform::Desktop).await;
    let b = Dev::new("B", &cloud, &clock, Platform::Desktop).await;
    (a, b, cloud)
}

/// A 开启同步，B 用同步码加入；双方已经对齐。
async fn paired_and_synced() -> (Dev, Dev, MemoryStorage) {
    let (mut a, mut b, cloud) = pair().await;
    a.add_conn("c1", "生产服务器", "1.1.1.1", "root").await;
    a.add_conn("c2", "测试机", "2.2.2.2", "deploy").await;
    let (_rk, code) = a.create().await;
    b.join_code(&code).await.unwrap();
    a.sync().await;
    (a, b, cloud)
}

// ═══════════════════════════════════════════════════════════════════════
// 开启 → 加入
// ═══════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn create_writes_meta_snapshot_and_keeps_secrets_off_the_cloud() {
    let (mut a, _b, cloud) = pair().await;
    a.add_conn("c1", "生产服务器", "1.1.1.1", "root").await;
    a.settings
        .mutate(|s| {
            s.font_size = 20;
            Ok(())
        })
        .await
        .unwrap();

    let (rk, code) = a.create().await;

    assert!(a.status().enabled);
    assert_eq!(a.status().state, SyncState::Idle);
    assert!(rk.contains('-'), "恢复密钥分组显示: {rk}");
    assert!(code.starts_with("MSYNC1-"));
    let paths = cloud.paths();
    assert!(paths.contains(&META_FILE.to_string()), "{paths:?}");
    let device = a.status().device_id.unwrap();
    assert!(
        paths.contains(&format::file_path(&device, FileKind::Snapshot, 1)),
        "{paths:?}"
    );
    // 本机存了密钥，云端只有密文
    assert!(a.secrets.get(&SecretSlot::SyncDataKey).unwrap().is_some());
    assert!(a
        .secrets
        .get(&SecretSlot::SyncRecoveryKey)
        .unwrap()
        .is_some());
    assert_eq!(
        a.secrets
            .get(&SecretSlot::SyncStoragePassword)
            .unwrap()
            .as_deref(),
        Some(PASSWORD)
    );
    for p in &paths {
        let bytes = cloud.peek(p).unwrap();
        let text = String::from_utf8_lossy(&bytes);
        assert!(
            !text.contains("生产服务器") || p == META_FILE,
            "{p} 里不该有明文配置"
        );
        assert!(!text.contains(PASSWORD), "{p}");
        assert!(!text.contains(&rk.replace('-', "")), "{p}");
    }
    // 重复开启 / 已有同步数据的位置：拒绝
    let again = a.engine.create(webdav(), None).await.unwrap_err();
    assert!(super::engine::plain_error(&again).contains("已经开启"));
    let mut other = Dev::new("O", &cloud, &new_clock(), Platform::Desktop).await;
    let err = other.engine.create(webdav(), None).await.unwrap_err();
    assert!(
        super::engine::plain_error(&err).contains("已有同步数据"),
        "{err}"
    );
    assert!(!other.status().enabled, "拒绝后本机不受影响");
}

#[tokio::test(flavor = "multi_thread")]
async fn join_merges_cloud_wins_dedupes_the_same_server_and_keeps_local_only_items() {
    let (mut a, mut b, _cloud) = pair().await;
    // A：两条连接 + 设置 + 快捷指令 + 用户 skill
    a.add_conn("c1", "生产服务器", "1.1.1.1", "root").await;
    a.add_conn("c2", "测试机", "2.2.2.2", "deploy").await;
    a.settings
        .mutate(|s| {
            s.font_size = 20;
            s.hide_thinking_display = true;
            s.panel_height = 111; // Local
            s.default_agent_mode = "plan".into();
            Ok(())
        })
        .await
        .unwrap();
    a.quick
        .mutate(|s| {
            s.add("q-a".into(), qc_input("重启 nginx", None))
                .map(|_| ())
        })
        .await
        .unwrap();
    a.skills
        .mutate(|s| {
            let mut sk = Skill::new("部署", "d", "p");
            sk.id = "skill-a".into();
            s.add(sk);
            Ok(())
        })
        .await
        .unwrap();
    let (_rk, code) = a.create().await;

    // B：先手动加过同一台服务器（id 不同）、一台独有的，还有指向重复连接的会话级快捷指令
    b.add_conn("b1", "我手动加的", "1.1.1.1", "root").await;
    b.add_conn("b2", "本机独有", "9.9.9.9", "me").await;
    b.secrets
        .set(&SecretSlot::SshPassword("b1".into()), "b1-password")
        .unwrap();
    b.quick
        .mutate(|s| {
            s.add("q-b".into(), qc_input("看日志", Some("b1")))
                .map(|_| ())
        })
        .await
        .unwrap();
    b.settings
        .mutate(|s| {
            s.font_size = 11; // Platform：桌面一份；与 A 同为桌面 → 云端赢
            s.hide_thinking_display = false;
            s.panel_height = 222; // Local：保留
            s.experimental_settings.multi_host_connection_ids = vec!["b1".into()];
            Ok(())
        })
        .await
        .unwrap();

    b.join_code(&code).await.unwrap();

    // 连接：云端两条 + 本机独有一条；重复的那条被去掉
    let mut ids = b.conn_ids().await;
    ids.sort();
    assert_eq!(ids, ["b2", "c1", "c2"], "b1 与云端 c1 是同一台服务器");
    assert_eq!(b.conn("c1").await.unwrap().name, "生产服务器", "云端赢");
    // 密码跟着搬到云端那条名下，本机旧 id 清理干净
    assert_eq!(
        b.secrets
            .get(&SecretSlot::SshPassword("c1".into()))
            .unwrap()
            .as_deref(),
        Some("b1-password")
    );
    assert!(b
        .secrets
        .get(&SecretSlot::SshPassword("b1".into()))
        .unwrap()
        .is_none());
    // 引用改写
    let qcs = b.adapter_doc("quickCommands");
    let session_keys: Vec<&str> = qcs["commands"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["sessionKey"].as_str())
        .collect();
    assert_eq!(session_keys, ["c1"], "指向被去重连接的引用改写成云端 id");
    assert_eq!(
        b.settings
            .read()
            .await
            .experimental_settings
            .multi_host_connection_ids,
        vec!["c1".to_string()]
    );
    // 设置：Shared 冲突云端赢；Local 保留；云端有的快捷指令 / skill 都来了
    let s = b.settings.snapshot().await;
    assert_eq!(s.font_size, 20, "桌面 Platform 字段：云端赢");
    assert!(s.hide_thinking_display, "Shared：云端赢");
    assert_eq!(s.default_agent_mode, "plan");
    assert_eq!(s.panel_height, 222, "Local：各自保留");
    assert_eq!(b.quick.read().await.commands.len(), 2, "云端的 + 本机的");
    assert!(b.skills.read().await.get("skill-a").is_some());

    // B 加入时的状态
    assert!(b.status().enabled);
    assert_eq!(b.status().pending_count, b.engine.ledger.outbox.len());
    assert!(
        b.engine.ledger.outbox.len() > 0,
        "本机独有的数据排队等待上传"
    );
    assert!(
        b.events.applied.lock().contains(&"connections".to_string()),
        "落地后通知前端刷新"
    );

    // 本机独有的 b2 传给 A；A 收到后不重复
    b.sync().await;
    a.sync().await;
    let mut a_ids = a.conn_ids().await;
    a_ids.sort();
    assert_eq!(a_ids, ["b2", "c1", "c2"]);
    assert_eq!(
        a.settings.read().await.panel_height,
        111,
        "A 的 Local 不被 B 影响"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn join_with_wrong_recovery_key_fails_cleanly_without_leaking_it() {
    let (mut a, mut b, _cloud) = pair().await;
    let (_rk, _code) = a.create().await;
    b.add_conn("b1", "本机", "3.3.3.3", "me").await;

    let wrong = "abcd-efgh-jkmn-pqrs-tuvw-xyz2-3456-789a";
    let err = b
        .engine
        .join(JoinSpec::Manual {
            storage: webdav(),
            secret: Some(Zeroizing::new(PASSWORD.into())),
            recovery_key: Zeroizing::new(wrong.into()),
        })
        .await
        .unwrap_err();
    let text = super::engine::plain_error(&err);
    assert!(text.contains("恢复密钥不对"), "{text}");
    assert!(!text.contains("abcdefgh"), "错误文案不回显恢复密钥");
    assert!(!b.status().enabled);
    assert_eq!(b.conn_ids().await, ["b1"], "失败不动本机数据");
    assert!(b.secrets.is_empty(), "失败不留任何密钥");
    assert!(!LedgerFiles::new(b.dir.path()).dir().exists());

    // 格式不对 / 位置上没有同步数据
    let junk = b
        .engine
        .join(JoinSpec::Manual {
            storage: webdav(),
            secret: None,
            recovery_key: Zeroizing::new("太短".into()),
        })
        .await
        .unwrap_err();
    assert!(super::engine::plain_error(&junk).contains("恢复密钥格式不对"));
    let mut lonely = Dev::new("L", &MemoryStorage::new(), &new_clock(), Platform::Desktop).await;
    let none = lonely.join_code("MSYNC1-bm90LWpzb24").await.unwrap_err();
    assert!(!super::engine::plain_error(&none).is_empty());
}

// ═══════════════════════════════════════════════════════════════════════
// 日常同步
// ═══════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn both_sides_edit_different_things_and_converge() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    assert_eq!(b.conn_ids().await.len(), 2);

    a.edit_conn("c1", |c| c.name = "生产-新名字".into()).await;
    b.add_conn("c3", "B 新加的", "3.3.3.3", "ops").await;
    b.settings
        .mutate(|s| {
            s.font_size = 17;
            Ok(())
        })
        .await
        .unwrap();
    a.sync().await;
    b.sync().await;
    a.sync().await;

    for dev in [&a, &b] {
        assert_eq!(dev.conn("c1").await.unwrap().name, "生产-新名字");
        assert_eq!(dev.conn_ids().await.len(), 3);
        assert_eq!(dev.font_size().await, 17);
    }
    // 落地通知了前端
    assert!(a.events.applied.lock().contains(&"settings".to_string()));
    // B 的同步记录里有人话说明
    let labels: Vec<String> = b.history().iter().map(|h| h.label.clone()).collect();
    assert!(
        labels.iter().any(|l| l == "连接『生产-新名字』的名称"),
        "{labels:?}"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_edits_to_the_same_field_later_write_wins_everywhere() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;

    a.edit_conn("c1", |c| c.host = "10.0.0.1".into()).await;
    a.engine.run_round(RoundKind::Local).await.unwrap(); // A 先改并上传
    b.edit_conn("c1", |c| c.host = "10.0.0.2".into()).await; // B 后改
    b.engine.run_round(RoundKind::Local).await.unwrap();

    a.sync().await;
    b.sync().await;
    a.sync().await;

    assert_eq!(a.conn("c1").await.unwrap().host, "10.0.0.2");
    assert_eq!(b.conn("c1").await.unwrap().host, "10.0.0.2");
}

#[tokio::test(flavor = "multi_thread")]
async fn delete_propagates_and_a_later_edit_resurrects_the_whole_element() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;

    // A 删除 c2，B 同时（尚未同步）改了 c2 的名字——B 的改动更晚 → c2 整个复活
    a.remove_conn("c2").await;
    a.engine.run_round(RoundKind::Local).await.unwrap();
    b.edit_conn("c2", |c| c.name = "还有人在用".into()).await;
    b.sync().await;
    a.sync().await;
    b.sync().await;

    for dev in [&a, &b] {
        let c2 = dev.conn("c2").await.expect("c2 应当复活");
        assert_eq!(c2.name, "还有人在用");
        assert_eq!(c2.host, "2.2.2.2", "整个元素复活，不是只剩被改的字段");
        assert_eq!(c2.username, "deploy");
    }

    // 纯删除（没有人改过）：两边都消失
    a.remove_conn("c1").await;
    a.sync().await;
    b.sync().await;
    assert!(b.conn("c1").await.is_none());
    assert_eq!(b.conn_ids().await, ["c2"]);
}

#[tokio::test(flavor = "multi_thread")]
async fn local_changes_inside_the_debounce_window_are_not_swallowed_by_a_remote_apply() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;

    // A 改了 c1.host 和设置并上传
    a.edit_conn("c1", |c| c.host = "7.7.7.7".into()).await;
    a.settings
        .mutate(|s| {
            s.hide_thinking_display = true;
            Ok(())
        })
        .await
        .unwrap();
    a.sync().await;

    // B 在「防抖窗口」里改了同一个连接的另一个字段 + 另一个设置，还没来得及捕获，远端落地就来了
    b.edit_conn("c1", |c| c.username = "newuser".into()).await;
    b.settings
        .mutate(|s| {
            s.font_size = 33;
            Ok(())
        })
        .await
        .unwrap();
    let errors = b.engine.test_pull_and_apply_without_capture().await;
    assert!(errors.is_empty(), "{errors:?}");

    // 远端的改动落了，本机刚做的修改一个都没丢
    let c1 = b.conn("c1").await.unwrap();
    assert_eq!(c1.host, "7.7.7.7", "A 的改动落地了");
    assert_eq!(c1.username, "newuser", "B 防抖窗口里的改动没被吞");
    assert_eq!(b.font_size().await, 33);
    assert!(b.settings.read().await.hide_thinking_display);

    // 并且之后能传给 A
    b.sync().await;
    a.sync().await;
    assert_eq!(a.conn("c1").await.unwrap().username, "newuser");
    assert_eq!(a.font_size().await, 33);
}

#[tokio::test(flavor = "multi_thread")]
async fn platform_fields_stay_per_platform_and_local_fields_never_travel() {
    let cloud = MemoryStorage::new();
    let clock = new_clock();
    let mut desktop = Dev::new("D", &cloud, &clock, Platform::Desktop).await;
    let mut phone = Dev::new("P", &cloud, &clock, Platform::Android).await;
    desktop
        .settings
        .mutate(|s| {
            s.font_size = 20;
            s.notification_settings.notification_volume = 10;
            s.panel_height = 999;
            s.privacy_mode = true;
            Ok(())
        })
        .await
        .unwrap();
    let (_rk, code) = desktop.create().await;
    phone.join_code(&code).await.unwrap();
    phone
        .settings
        .mutate(|s| {
            s.font_size = 9;
            s.mobile_notification_settings.agent_task_done = false;
            Ok(())
        })
        .await
        .unwrap();
    phone.sync().await;
    desktop.sync().await;

    let d = desktop.settings.snapshot().await;
    let p = phone.settings.snapshot().await;
    assert!(d.privacy_mode && p.privacy_mode, "Shared 两端一致");
    assert_eq!(d.font_size, 20, "手机的字号不影响桌面");
    assert_eq!(
        p.font_size, 9,
        "各平台各存一份字号：桌面改 20 不覆盖手机自己的 9"
    );
    assert_eq!(
        p.notification_settings.notification_volume, 70,
        "桌面通知不进手机"
    );
    assert!(
        d.mobile_notification_settings.agent_task_done,
        "手机通知不进桌面"
    );
    assert_eq!(p.panel_height, 256, "Local 不同步");
    assert_eq!(d.panel_height, 999);
}

#[tokio::test(flavor = "multi_thread")]
async fn a_device_never_reads_its_own_files_and_idle_rounds_do_no_writes() {
    let (mut a, mut b, cloud) = paired_and_synced().await;
    a.sync().await;
    b.sync().await;
    let before = cloud.paths();
    a.sync().await;
    b.sync().await;
    assert_eq!(cloud.paths(), before, "没有改动时不产生新文件");
    // 没有改动时 Local 轮不碰网络
    cloud.clear_calls();
    a.engine.run_round(RoundKind::Local).await.unwrap();
    assert!(cloud.calls().is_empty(), "{:?}", cloud.calls());
}

// ═══════════════════════════════════════════════════════════════════════
// 大量删除闸
// ═══════════════════════════════════════════════════════════════════════

async fn six_of_eight_deleted() -> (Dev, Dev, MemoryStorage) {
    let (mut a, mut b, cloud) = pair().await;
    for i in 0..8 {
        a.add_conn(
            &format!("c{i}"),
            &format!("机器{i}"),
            &format!("10.0.0.{i}"),
            "root",
        )
        .await;
    }
    let (_rk, code) = a.create().await;
    b.join_code(&code).await.unwrap();
    a.sync().await;
    assert_eq!(b.conn_ids().await.len(), 8);

    for i in 0..6 {
        a.remove_conn(&format!("c{i}")).await;
    }
    a.sync().await;
    (a, b, cloud)
}

#[tokio::test(flavor = "multi_thread")]
async fn mass_delete_is_held_until_confirmed_and_released_on_accept() {
    let (mut a, mut b, _cloud) = six_of_eight_deleted().await;

    let status = a.status();
    assert_eq!(status.state, SyncState::NeedsConfirm);
    assert_eq!(status.held.as_ref().unwrap()[0].source, "connections");
    assert_eq!(status.held.as_ref().unwrap()[0].count, 6);
    // 没上传：B 还有 8 条，A 本机只剩 2 条
    b.sync().await;
    assert_eq!(b.conn_ids().await.len(), 8, "确认之前不会传出去");
    assert_eq!(a.conn_ids().await.len(), 2);
    // 后续轮次也不会把它放出去
    a.sync().await;
    b.sync().await;
    assert_eq!(b.conn_ids().await.len(), 8);
    assert_eq!(a.status().state, SyncState::NeedsConfirm);

    a.engine.confirm_held(true).await.unwrap();
    assert_eq!(a.status().state, SyncState::Idle);
    assert!(a.status().held.is_none());
    b.sync().await;
    assert_eq!(b.conn_ids().await.len(), 2, "放行后同步删除");
}

#[tokio::test(flavor = "multi_thread")]
async fn mass_delete_rejected_restores_the_connections_locally_and_never_leaves_the_device() {
    let (mut a, mut b, _cloud) = six_of_eight_deleted().await;
    assert_eq!(a.status().state, SyncState::NeedsConfirm);

    a.engine.confirm_held(false).await.unwrap();

    assert_eq!(a.status().state, SyncState::Idle);
    assert_eq!(a.conn_ids().await.len(), 8, "撤销删除：被删的连接写回来了");
    let mut names: Vec<String> = a
        .connections
        .read()
        .await
        .connections
        .iter()
        .map(|c| c.name.clone())
        .collect();
    names.sort();
    assert_eq!(names[0], "机器0", "内容完整地回来");
    b.sync().await;
    a.sync().await;
    assert_eq!(b.conn_ids().await.len(), 8);
    assert_eq!(a.conn_ids().await.len(), 8);
}

#[tokio::test(flavor = "multi_thread")]
async fn remote_changes_do_not_resurrect_elements_while_the_delete_is_held() {
    let (mut a, mut b, _cloud) = six_of_eight_deleted().await;

    // 挂着待确认的时候 B 改了别的东西，A 拉取落地：被扣下的删除不能被「落地」冲掉
    b.edit_conn("c7", |c| c.name = "B 改的".into()).await;
    b.sync().await;
    a.sync().await;
    assert_eq!(
        a.conn_ids().await.len(),
        2,
        "挂起期间被删的元素不会被写回来"
    );
    assert_eq!(
        a.conn("c7").await.unwrap().name,
        "B 改的",
        "其它改动照常落地"
    );
    assert_eq!(a.status().state, SyncState::NeedsConfirm);
}

#[tokio::test(flavor = "multi_thread")]
async fn small_deletes_pass_straight_through() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    a.add_conn("c3", "x", "3.3.3.3", "r").await;
    a.sync().await;
    b.sync().await;
    a.remove_conn("c3").await;
    a.sync().await;
    assert_eq!(a.status().state, SyncState::Idle);
    b.sync().await;
    assert!(b.conn("c3").await.is_none());
}

// ═══════════════════════════════════════════════════════════════════════
// 版本 / 损坏 / 升级
// ═══════════════════════════════════════════════════════════════════════

fn write_foreign_segment(
    cloud: &MemoryStorage,
    secrets: &MemorySecrets,
    device: &str,
    seq: u64,
    format_version: u32,
    ops: Value,
) {
    let dk = crypto::DataKey::from_b64(&secrets.get(&SecretSlot::SyncDataKey).unwrap().unwrap())
        .unwrap();
    let plain = json!({
        "format": format_version,
        "device": {"id": device, "name": "新版本设备", "platform": "desktop", "appVersion": "9.9.9"},
        "seq": seq,
        "ops": ops,
    });
    let bytes = crypto::seal(
        &dk,
        FileKind::Segment.as_str(),
        device,
        seq,
        &serde_json::to_vec(&plain).unwrap(),
    )
    .unwrap();
    cloud.insert(&format::file_path(device, FileKind::Segment, seq), &bytes);
}

#[tokio::test(flavor = "multi_thread")]
async fn newer_format_data_pauses_that_device_with_needs_upgrade_and_resumes_after() {
    let (mut a, mut b, cloud) = paired_and_synced().await;
    let foreign = "ffffffffffffffffffffffffffffffff";
    write_foreign_segment(&cloud, &b.secrets, foreign, 1, 2, json!([]));

    b.sync().await; // 不是错误
    assert_eq!(b.status().state, SyncState::NeedsUpgrade);
    assert!(b.status().last_error.is_none());
    assert!(
        b.engine.ledger.st.cursors.get(foreign).is_none(),
        "读不懂的设备不推进游标"
    );
    // 其它设备的同步不受影响
    a.edit_conn("c1", |c| c.name = "照常同步".into()).await;
    a.sync().await;
    b.sync().await;
    assert_eq!(b.conn("c1").await.unwrap().name, "照常同步");
    assert_eq!(b.status().state, SyncState::NeedsUpgrade);

    // 「升级」之后：那个设备的文件本版本读得懂了（换成合法格式）→ 恢复，并且补读到
    let sets = json!([{
        "source": "settings",
        "path": ["@desktop", "fontSize"],
        "kind": {"t": "set", "v": 31},
        "hlc": {"ms": 4_000_000_000_000u64, "counter": 0, "device": foreign}
    }]);
    write_foreign_segment(&cloud, &b.secrets, foreign, 1, 1, sets);
    b.sync().await;
    assert_eq!(b.status().state, SyncState::Idle);
    assert_eq!(b.font_size().await, 31, "升级后补读到之前读不懂的数据");
    assert_eq!(b.engine.ledger.cursor(foreign).seg, 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn corrupt_config_is_restored_from_the_mirror_instead_of_pushing_defaults() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    a.settings
        .mutate(|s| {
            s.font_size = 22;
            s.hide_thinking_display = true;
            Ok(())
        })
        .await
        .unwrap();
    a.sync().await;
    b.sync().await;
    assert_eq!(b.font_size().await, 22);
    b.engine.run_round(RoundKind::Full).await.unwrap();

    // B「重启」：settings.json 读失败，应用被迫用默认值，并把这个事实告诉同步引擎
    b.settings.replace(AppSettings::default()).await.unwrap();
    b.rebuild_engine("1.12.0", vec![DataSourceId::Settings]);
    assert_eq!(b.font_size().await, 14, "此刻本机是默认值");

    b.sync().await;

    assert_eq!(b.font_size().await, 22, "从镜像恢复了");
    assert!(b.settings.read().await.hide_thinking_display);
    // A 那边没有被「全变成默认值」冲掉
    a.sync().await;
    assert_eq!(a.font_size().await, 22);
    assert!(a.settings.read().await.hide_thinking_display);
    // 恢复标记用掉了
    assert!(!b.engine.ledger.is_restoring("settings"));
}

#[tokio::test(flavor = "multi_thread")]
async fn upgrade_does_not_report_fields_the_new_version_dropped() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    // 两边都有主题分区 "legacy"（Shared 的 map 叶子）
    a.settings
        .mutate(|s| {
            s.ui_theme.zones.insert("legacy".into(), "#123456".into());
            s.ui_theme.zones.insert("bg".into(), "#000000".into());
            Ok(())
        })
        .await
        .unwrap();
    a.sync().await;
    b.sync().await;
    assert_eq!(b.settings.read().await.ui_theme.zones.len(), 2);

    // B 升级到新版本：新版本的迁移把 "legacy" 分区从配置里去掉了（用户没动过）
    b.settings
        .mutate(|s| {
            s.ui_theme.zones.remove("legacy");
            Ok(())
        })
        .await
        .unwrap();
    b.rebuild_engine("1.13.0", Vec::new());
    b.sync().await; // 升级后第一次捕获：不发 Remove
    a.sync().await;
    assert!(
        a.settings
            .read()
            .await
            .ui_theme
            .zones
            .contains_key("legacy"),
        "还在用旧字段的旧版本设备不该被新版本的迁移带着删"
    );

    // 之后用户自己删（第二次捕获）照常传播
    b.settings
        .mutate(|s| {
            s.ui_theme.zones.remove("bg");
            Ok(())
        })
        .await
        .unwrap();
    b.sync().await;
    a.sync().await;
    assert!(!a.settings.read().await.ui_theme.zones.contains_key("bg"));
}

// ═══════════════════════════════════════════════════════════════════════
// known_hosts
// ═══════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn known_host_with_a_different_fingerprint_is_never_overwritten_and_warns() {
    let (mut a, mut b, _cloud) = pair().await;
    a.known_hosts
        .record("same.example.com", 22, host_entry("SHA256:same"))
        .await
        .unwrap();
    a.known_hosts
        .record("clash.example.com", 22, host_entry("SHA256:from-a"))
        .await
        .unwrap();
    let (_rk, code) = a.create().await;
    b.known_hosts
        .record("clash.example.com", 22, host_entry("SHA256:local-b"))
        .await
        .unwrap();
    b.known_hosts
        .record("b-only.example.com", 22, host_entry("SHA256:b-only"))
        .await
        .unwrap();
    b.join_code(&code).await.unwrap();

    let fp = |dev: &Dev, host: &str| {
        let list = futures::executor::block_on(dev.known_hosts.list());
        list.into_iter()
            .find(|(k, _)| k == &format!("{host}:22"))
            .map(|(_, e)| e.fingerprint_sha256)
    };
    // 冲突的条目：本机指纹原样保留（安全边界）；A 的新增条目照常到了
    assert_eq!(
        fp(&b, "clash.example.com").as_deref(),
        Some("SHA256:local-b")
    );
    assert_eq!(fp(&b, "same.example.com").as_deref(), Some("SHA256:same"));
    assert_eq!(
        fp(&b, "b-only.example.com").as_deref(),
        Some("SHA256:b-only")
    );
    let warnings: Vec<_> = b
        .history()
        .into_iter()
        .filter(|h| h.kind == HistoryKind::Warning)
        .collect();
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(warnings[0].label.contains("clash.example.com:22"));
    assert!(warnings[0].label.contains("与本机不同"));
    assert!(warnings[0].label.contains("SHA256:from-a"));

    // 再同步几轮：不重复记警告、也不改指纹；B 独有的传给了 A，A 的指纹不被 B 冲掉
    b.sync().await;
    a.sync().await;
    b.sync().await;
    assert_eq!(
        fp(&b, "clash.example.com").as_deref(),
        Some("SHA256:local-b")
    );
    assert_eq!(
        fp(&a, "clash.example.com").as_deref(),
        Some("SHA256:from-a")
    );
    assert_eq!(
        fp(&a, "b-only.example.com").as_deref(),
        Some("SHA256:b-only")
    );
    let warnings = b
        .history()
        .into_iter()
        .filter(|h| h.kind == HistoryKind::Warning)
        .count();
    assert_eq!(warnings, 1, "同一条警告只记一次");

    // 删除条目照常应用
    a.known_hosts.forget("same.example.com", 22).await.unwrap();
    a.sync().await;
    b.sync().await;
    assert!(fp(&b, "same.example.com").is_none());
}

// ═══════════════════════════════════════════════════════════════════════
// 同步记录与撤销
// ═══════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn history_names_the_device_and_undo_goes_through_a_normal_local_write() {
    let (mut a, b, _cloud) = paired_and_synced().await;
    let mut b = b;
    a.engine.set_device_name("客厅电脑").unwrap();
    a.settings
        .mutate(|s| {
            s.hide_thinking_display = true;
            Ok(())
        })
        .await
        .unwrap();
    a.edit_conn("c1", |c| c.host = "8.8.8.8".into()).await;
    a.sync().await;
    b.sync().await;

    let entries = b.history();
    let host = entries
        .iter()
        .find(|h| h.label == "连接『生产服务器』的主机地址")
        .expect("有人话说明的记录");
    assert_eq!(host.device_name, "客厅电脑");
    assert_eq!(host.old_value.as_deref(), Some("1.1.1.1"));
    assert_eq!(host.new_value.as_deref(), Some("8.8.8.8"));
    assert!(!host.undone);

    // 撤销：B 本机的值改回旧值，并作为新的本机改动同步给 A
    let manager = manager_over(&mut b);
    manager.undo(&host.id).await.unwrap();
    assert_eq!(b.conn("c1").await.unwrap().host, "1.1.1.1");
    assert!(b.history().iter().find(|h| h.id == host.id).unwrap().undone);
    assert!(manager.undo(&host.id).await.is_err(), "不能撤销两次");
    b.sync().await;
    a.sync().await;
    assert_eq!(
        a.conn("c1").await.unwrap().host,
        "1.1.1.1",
        "撤销本身被同步出去了"
    );
}

/// 在设备现有的引擎旁边搭一个只用于「读视图 + undo + 同步码」的 manager（不起 actor），
/// 与设备共用同一份共享视图（同步记录是同一份）。
fn manager_over(dev: &mut Dev) -> SyncManager {
    SyncManager::with_deps_and_view(
        dev.deps("1.12.0", Vec::new()),
        dev.bus.clone(),
        None,
        dev.view.clone(),
    )
}

// ═══════════════════════════════════════════════════════════════════════
// 压缩、停止、机密
// ═══════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn compaction_writes_a_snapshot_prunes_own_segments_and_new_devices_can_still_join() {
    let (mut a, mut b, cloud) = paired_and_synced().await;
    let a_dir = format::device_dir(&a.status().device_id.unwrap());
    for i in 0..(super::engine::COMPACT_AFTER_SEGS + 2) {
        a.edit_conn("c1", |c| c.name = format!("第{i}次")).await;
        a.sync().await;
    }
    let files: Vec<String> = cloud
        .paths()
        .into_iter()
        .filter(|p| p.starts_with(&a_dir))
        .collect();
    let segs = files.iter().filter(|p| p.contains("/seg-")).count();
    let snaps = files.iter().filter(|p| p.contains("/snap-")).count();
    assert!(snaps >= 2 && snaps <= 2, "快照最多留两个: {files:?}");
    assert!(segs < 10, "压缩后旧增量段被清掉了: {files:?}");

    // B 很久没同步：靠快照追上
    b.sync().await;
    assert!(b.conn("c1").await.unwrap().name.starts_with("第"));
    assert_eq!(
        b.conn("c1").await.unwrap().name,
        a.conn("c1").await.unwrap().name
    );

    // 压缩之后新来的设备也能完整加入
    let mut c = Dev::new("C", &cloud, &new_clock(), Platform::Desktop).await;
    let code = {
        let m = manager_over(&mut a);
        m.get_sync_code().await.unwrap()
    };
    c.join_code(&code).await.unwrap();
    assert_eq!(
        c.conn("c1").await.unwrap().name,
        a.conn("c1").await.unwrap().name
    );
    assert_eq!(c.conn_ids().await.len(), 2);
}

#[tokio::test(flavor = "multi_thread")]
async fn disable_removes_local_state_and_optionally_the_remote_files_but_never_the_configs() {
    let (mut a, mut b, cloud) = paired_and_synced().await;
    a.sync().await;
    b.sync().await;
    let device = b.status().device_id.unwrap();

    // 不删云端
    b.engine.disable(false).await.unwrap();
    assert!(!b.status().enabled);
    assert_eq!(b.status().state, SyncState::Off);
    assert!(
        !LedgerFiles::new(b.dir.path()).dir().exists(),
        "本机同步状态目录没了"
    );
    assert!(b.secrets.is_empty(), "同步的密钥链条目清掉了");
    assert_eq!(b.conn_ids().await.len(), 2, "本机配置数据不动");
    assert!(cloud
        .paths()
        .iter()
        .any(|p| p.starts_with(&format::device_dir(&device))));
    assert!(cloud.peek(META_FILE).is_some());
    // 停止后改动不再上传
    b.add_conn("c9", "x", "9.9.9.9", "r").await;
    b.sync().await;
    a.sync().await;
    assert!(a.conn("c9").await.is_none());

    // 同时删云端
    a.engine.disable(true).await.unwrap();
    assert!(cloud.peek(META_FILE).is_none());
    assert!(
        cloud.paths().iter().all(|p| !p.starts_with(DEVICES_DIR)),
        "{:?}",
        cloud.paths()
    );
    assert_eq!(a.conn_ids().await.len(), 2);

    // 云端删除失败：不停止，用户可以重试
    let (mut x, _y, cloud2) = paired_and_synced().await;
    cloud2.fail_next_n(super::storage::StorageError::Network("断网".into()), 5);
    assert!(x.engine.disable(true).await.is_err());
    assert!(x.status().enabled, "云端没删成功就不要把本机状态也清了");
    cloud2.clear_failures();
    x.engine.disable(true).await.unwrap();
    assert!(!x.status().enabled);
}

#[tokio::test(flavor = "multi_thread")]
async fn no_secret_ever_lands_in_the_ledger_history_status_or_errors() {
    let (mut a, mut b, cloud) = pair().await;
    a.add_conn("c1", "生产服务器", "1.1.1.1", "root").await;
    let (rk, code) = a.create().await;
    b.join_code(&code).await.unwrap();
    a.edit_conn("c1", |c| c.host = "2.2.2.2".into()).await;
    a.sync().await;
    b.sync().await;

    let rk_plain = rk.replace('-', "");
    let dk = b.secrets.get(&SecretSlot::SyncDataKey).unwrap().unwrap();
    let needles = [PASSWORD, rk_plain.as_str(), dk.as_str(), code.as_str()];

    // 本机账本目录里所有文件
    fn walk(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            if p.is_dir() {
                walk(&p, out);
            } else {
                out.push(p);
            }
        }
    }
    for dev in [&a, &b] {
        let mut files = Vec::new();
        walk(LedgerFiles::new(dev.dir.path()).dir(), &mut files);
        assert!(!files.is_empty());
        for f in files {
            let text = std::fs::read_to_string(&f).unwrap_or_default();
            for n in needles {
                assert!(!text.contains(n), "{} 里出现了机密", f.display());
            }
        }
        let status = serde_json::to_string(&dev.status()).unwrap();
        let history = serde_json::to_string(&dev.history()).unwrap();
        for n in needles {
            assert!(!status.contains(n) && !history.contains(n));
        }
    }
    // 云端：全是密文（除了 meta 的盐与被包起来的密钥）
    for p in cloud.paths() {
        let text = String::from_utf8_lossy(&cloud.peek(&p).unwrap()).to_string();
        for n in needles {
            assert!(!text.contains(n), "云端 {p} 里出现了机密");
        }
    }
    // 存储出错时的错误文案不带密码
    cloud.fail_next(super::storage::StorageError::Auth(
        "用户名或密码不正确".into(),
    ));
    let err = a.sync_err().await;
    assert!(!err.contains(PASSWORD));
}

// ═══════════════════════════════════════════════════════════════════════
// 状态机 / 退避 / actor
// ═══════════════════════════════════════════════════════════════════════

#[tokio::test(flavor = "multi_thread")]
async fn network_failure_sets_error_state_and_progress_survives() {
    let (mut a, mut b, cloud) = paired_and_synced().await;
    a.edit_conn("c1", |c| c.name = "断网前改的".into()).await;

    cloud.fail_next_n(super::storage::StorageError::Network("连不上".into()), 3);
    let err = a.sync_err().await;
    assert!(err.contains("连不上"));
    assert_eq!(a.status().state, SyncState::Error);
    assert_eq!(a.status().last_error.as_deref(), Some("连不上"));
    assert!(a.status().pending_count > 0, "改动还在待上传队列里");

    cloud.clear_failures();
    a.sync().await;
    assert_eq!(a.status().state, SyncState::Idle);
    assert_eq!(a.status().pending_count, 0);
    b.sync().await;
    assert_eq!(b.conn("c1").await.unwrap().name, "断网前改的");

    // 待上传队列重启不丢
    a.edit_conn("c1", |c| c.name = "重启前改的".into()).await;
    cloud.fail_next_n(super::storage::StorageError::Network("又断了".into()), 3);
    let _ = a.sync_err().await;
    cloud.clear_failures();
    a.rebuild_engine("1.12.0", Vec::new());
    assert!(a.status().pending_count > 0);
    a.sync().await;
    b.sync().await;
    assert_eq!(b.conn("c1").await.unwrap().name, "重启前改的");
}

#[tokio::test(flavor = "multi_thread")]
async fn status_events_are_published_and_never_repeat_an_unchanged_status() {
    let (mut a, _b, _cloud) = pair().await;
    a.create().await;
    a.sync().await;
    a.sync().await;
    let statuses = a.events.statuses.lock().clone();
    assert!(!statuses.is_empty());
    for pair in statuses.windows(2) {
        assert_ne!(pair[0], pair[1], "状态没变就不重复发");
    }
    assert!(statuses.iter().any(|s| s.state == SyncState::Syncing));
    assert_eq!(statuses.last().unwrap().state, SyncState::Idle);
}

#[tokio::test(flavor = "multi_thread")]
async fn device_list_shows_self_and_the_others_with_names() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    b.engine.set_device_name("手机").unwrap();
    b.edit_conn("c1", |c| c.name = "b 改的".into()).await;
    b.sync().await;
    a.sync().await;
    let devices = a.view.devices.read().clone();
    assert_eq!(devices.len(), 2);
    assert!(devices.iter().any(|d| d.is_self && d.name == "设备A"));
    let other = devices.iter().find(|d| !d.is_self).unwrap();
    assert_eq!(other.name, "手机");
    assert_eq!(other.platform, "desktop");
    assert_eq!(other.app_version, "1.12.0");
    assert!(!other.last_seen_at.is_empty());
    assert!(b.engine.set_device_name("   ").is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn legacy_sync_leftovers_are_cleaned_whether_or_not_sync_is_enabled() {
    let dir = tempfile::tempdir().unwrap();
    for f in crate::data::legacy::LEGACY_SYNC_FILES {
        std::fs::write(dir.path().join(f), "{}").unwrap();
    }
    std::fs::write(dir.path().join("session_snapshot.json"), "{}").unwrap();
    let secrets = MemorySecrets::new();
    for slot in SecretSlot::legacy_sync_slots() {
        secrets.set(&slot, "old").unwrap();
    }
    secrets.set(&SecretSlot::SyncDataKey, "keep").unwrap();

    super::manager::cleanup_legacy_sync(dir.path(), &secrets);

    for f in crate::data::legacy::LEGACY_SYNC_FILES {
        assert!(!dir.path().join(f).exists());
    }
    assert!(
        dir.path().join("session_snapshot.json").exists(),
        "来历不明的文件不碰"
    );
    for slot in SecretSlot::legacy_sync_slots() {
        assert!(secrets.get(&slot).unwrap().is_none());
    }
    assert!(
        secrets.get(&SecretSlot::SyncDataKey).unwrap().is_some(),
        "新版同步的密钥不受影响"
    );
}

/// actor：创建 → 本机改动经总线防抖后自动上传 → 另一台设备的 `sync_now` 把它拉下来。
#[tokio::test(flavor = "multi_thread")]
async fn actor_uploads_local_changes_after_the_debounce_and_syncs_on_demand() {
    let cloud = MemoryStorage::new();
    let clock = new_clock();
    let a = Dev::new("A", &cloud, &clock, Platform::Desktop).await;
    let b = Dev::new("B", &cloud, &clock, Platform::Desktop).await;

    let timing = Timing {
        gate: Duration::from_millis(300),
        debounce: Duration::from_millis(60),
        debounce_max: Duration::from_millis(400),
        periodic: Duration::from_millis(250),
        backoff_min: Duration::from_millis(50),
        backoff_max: Duration::from_millis(200),
    };
    let mgr_a = SyncManager::with_deps(a.deps("1.12.0", Vec::new()), a.bus.clone(), None);
    let mgr_b = SyncManager::with_deps(b.deps("1.12.0", Vec::new()), b.bus.clone(), None);
    tokio::spawn(mgr_a.take_actor(timing).unwrap());
    tokio::spawn(mgr_b.take_actor(timing).unwrap());

    // 没开同步：sync_now 是 no-op 而不是错误
    mgr_a.sync_now().await.unwrap();
    assert!(!mgr_a.status().enabled);

    let created = mgr_a
        .create(webdav(), Some(PASSWORD.to_string()))
        .await
        .unwrap();
    assert!(mgr_a.status().enabled);
    mgr_b.join_code(created.sync_code.clone()).await.unwrap();
    assert!(mgr_b.status().enabled);

    // A 改设置：不调用任何同步命令，防抖到期后自动捕获并上传
    a.settings
        .mutate(|s| {
            s.font_size = 19;
            Ok(())
        })
        .await
        .unwrap();
    wait_until("A 的改动被自动上传", || {
        mgr_a.status().pending_count == 0
            && cloud
                .paths()
                .iter()
                .any(|p| p.contains("/seg-") && p.contains(&mgr_a.status().device_id.unwrap()))
    })
    .await;

    // B 前台触发同步，改动落地
    mgr_b.sync_now().await.unwrap();
    assert_eq!(b.font_size().await, 19);
    assert!(b.events.applied.lock().contains(&"settings".to_string()));
    assert!(mgr_b
        .list_history(10)
        .iter()
        .any(|h| h.label.contains("终端字号")));
    assert_eq!(mgr_b.list_devices().len(), 2);

    // 机密命令：恢复密钥 / 同步码
    let rk = mgr_a.get_recovery_key().unwrap();
    assert_eq!(rk.len(), 32 + 7);
    assert!(mgr_a.get_sync_code().await.unwrap().starts_with("MSYNC1-"));
    mgr_a.set_device_name("主力机".into()).await.unwrap();
    assert_eq!(mgr_a.status().device_name.as_deref(), Some("主力机"));

    mgr_a.disable(false).await.unwrap();
    assert!(!mgr_a.status().enabled);
    assert!(mgr_a.get_recovery_key().is_err());
}

#[tokio::test(flavor = "multi_thread")]
async fn actor_gate_waits_for_the_frontend_then_a_fallback_runs_the_first_round() {
    let cloud = MemoryStorage::new();
    let clock = new_clock();
    let mut a = Dev::new("A", &cloud, &clock, Platform::Desktop).await;
    let mut b = Dev::new("B", &cloud, &clock, Platform::Desktop).await;
    a.add_conn("c1", "x", "1.1.1.1", "r").await;
    let (_rk, code) = a.create().await;
    b.join_code(&code).await.unwrap();
    a.edit_conn("c1", |c| c.name = "远端新名字".into()).await;
    a.sync().await;

    // B「重启」：已开启同步，启动后不得自己去落地（前端还没订阅好事件）
    b.rebuild_engine("1.12.0", Vec::new());
    let timing = Timing {
        gate: Duration::from_millis(500),
        debounce: Duration::from_millis(50),
        debounce_max: Duration::from_millis(200),
        periodic: Duration::from_millis(100),
        backoff_min: Duration::from_millis(50),
        backoff_max: Duration::from_millis(100),
    };
    let mgr = SyncManager::with_deps(b.deps("1.12.0", Vec::new()), b.bus.clone(), None);
    tokio::spawn(mgr.take_actor(timing).unwrap());

    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(
        b.conn("c1").await.unwrap().name,
        "x",
        "兜底计时到点之前，不做任何落地"
    );
    // 兜底到点后自己跑首轮
    wait_until("兜底首轮落地", || {
        futures::executor::block_on(async { b.conn("c1").await.unwrap().name == "远端新名字" })
    })
    .await;
}

async fn wait_until(what: &str, mut cond: impl FnMut() -> bool) {
    for _ in 0..200 {
        if cond() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    panic!("等待超时: {what}");
}

#[test]
fn every_adapter_covers_a_distinct_registered_source() {
    let dir = tempfile::tempdir().unwrap();
    let stores = SourceStores {
        settings: JsonStore::new(dir.path(), AppSettings::default(), None),
        connections: JsonStore::new(dir.path(), ConnectionStore::new(), None),
        quick_commands: JsonStore::new(dir.path(), QuickCommandStore::new(), None),
        skills: JsonStore::new(dir.path(), SkillStore::new(), None),
        mcp_servers: JsonStore::new(dir.path(), McpServerStore::new(), None),
        known_hosts: KnownHostsStore::in_memory(),
        mcp_manager: Arc::new(McpManager::new()),
    };
    let adapters = build_adapters(&stores, Arc::new(MemorySecrets::new()));
    let keys: HashSet<&str> = adapters.iter().map(|a| a.key()).collect();
    let registry: HashSet<&str> = DataSourceId::ALL
        .iter()
        .filter_map(|i| i.sync_key())
        .collect();
    assert_eq!(
        keys, registry,
        "适配器必须恰好覆盖登记表里所有 Config 档数据"
    );
    for a in &adapters {
        assert_eq!(a.data_source().sync_key(), Some(a.key()));
        assert_eq!(a.data_source().tier(), crate::data::SyncTier::Config);
    }
    let _ = (
        <AppSettings as JsonPersistable>::SOURCE,
        DataSourceId::Settings,
    );
}

// ═══════════════════════════════════════════════════════════════════════
// 二期 / 三期公共底座（T0）
// ═══════════════════════════════════════════════════════════════════════

/// 老版本客户端列到 `devices/<id>/` 下多了 `conv/`、`sec/`、`blob/` 子目录时：
/// 它们只是目录项，`parse_file_name` 对目录名返回 `None`，`pull_device` 只处理 `!is_dir`，
/// **不报错、不推进游标、也不影响配置流的同步**。
#[tokio::test(flavor = "multi_thread")]
async fn old_clients_quietly_skip_stream_subdirectories() {
    let (mut a, mut b, cloud) = paired_and_synced().await;
    let device_a = a.status().device_id.clone().unwrap();
    // 假装 A 还写过 conv / sec / blob 的文件（子目录于是「存在」）
    cloud.insert(
        &format::stream_segment_path(&device_a, format::RemoteStream::Conv, 1),
        b"not an envelope",
    );
    cloud.insert(
        &format::stream_segment_path(&device_a, format::RemoteStream::Sec, 1),
        b"not an envelope",
    );
    cloud.insert(&format::blob_path(&device_a, &"ab".repeat(32)), b"blob");

    // 子目录名本身不是文件名
    for dir in ["conv", "sec", "blob"] {
        assert_eq!(format::parse_file_name(dir), None, "{dir}");
    }
    // 设备目录里能列出这三个目录项
    let entries = cloud.list(&format::device_dir(&device_a)).await.unwrap();
    let dirs: Vec<&str> = entries
        .iter()
        .filter(|e| e.is_dir)
        .map(|e| e.name.as_str())
        .collect();
    for d in ["conv", "sec", "blob"] {
        assert!(dirs.contains(&d), "列不出子目录 {d}: {dirs:?}");
    }

    // 老客户端（= 只开配置档的新版本）拉取不报错，配置照常同步
    b.sync().await;
    assert_eq!(b.status().state, SyncState::Idle, "子目录不该让同步失败");
    a.edit_conn("c1", |c| c.name = "子目录后改的".into()).await;
    a.sync().await;
    b.sync().await;
    assert_eq!(b.conn("c1").await.unwrap().name, "子目录后改的");
    // 只开了配置档：本机从来不会去写 conv / sec / blob 的文件
    let own_b = b.status().device_id.clone().unwrap();
    let b_prefix = format!("{}/", format::device_dir(&own_b));
    let b_files: Vec<String> = cloud
        .paths()
        .into_iter()
        .filter(|p| p.starts_with(&b_prefix))
        .collect();
    for p in b_files {
        assert!(
            !p.contains("/conv/") && !p.contains("/sec/") && !p.contains("/blob/"),
            "只开配置档时不该写子目录: {p}"
        );
    }
}

/// 只开配置档的两台设备：远端只出现 `devices/<id>/seg-*` / `snap-*`，没有 conv / sec / blob。
#[tokio::test(flavor = "multi_thread")]
async fn config_only_devices_write_only_phase_one_files() {
    let (mut a, mut b, cloud) = paired_and_synced().await;
    a.edit_conn("c1", |c| c.name = "改一下".into()).await;
    a.sync().await;
    b.sync().await;
    b.edit_conn("c2", |c| c.name = "B 也改".into()).await;
    b.sync().await;
    a.sync().await;

    let mut saw_seg = false;
    for p in cloud.paths() {
        assert!(
            p == META_FILE || p.starts_with(&format!("{DEVICES_DIR}/")),
            "{p}"
        );
        if p == META_FILE {
            continue;
        }
        let rel = p.strip_prefix(&format!("{DEVICES_DIR}/")).unwrap();
        let (_device, rest) = rel.split_once('/').unwrap();
        assert!(
            rest.starts_with("seg-") || rest.starts_with("snap-"),
            "只开配置档时远端只能有配置流文件: {p}"
        );
        saw_seg |= rest.starts_with("seg-");
    }
    assert!(saw_seg, "至少写过增量段");
    assert_eq!(
        a.status().tiers,
        crate::sync::store::TierSwitches::default()
    );
    let statuses = a.events.statuses.lock().clone();
    let last = statuses.last().expect("至少发过状态");
    assert!(!last.tiers.conversation);
    assert!(!last.tiers.secret);
    assert!(
        last.streams.iter().any(|s| s.key == "config"),
        "状态里要带每条流: {:?}",
        last.streams
    );
}

/// 设备列表显示对方开了哪几档（从文件头读）。
#[tokio::test(flavor = "multi_thread")]
async fn device_list_reports_the_tiers_written_in_the_file_headers() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    a.sync().await;
    b.sync().await;
    let devices_b = b.view.devices.read().clone();
    let other = devices_b.iter().find(|d| !d.is_self).expect("对方设备");
    assert_eq!(other.tiers, crate::sync::store::TierSwitches::default());

    // A 打开对话档之后，它写的段里就带上了 tiers；B 读到后设备列表跟上
    a.engine.enable_tier("conversation", true).await.unwrap();
    a.edit_conn("c1", |c| c.name = "开了对话档之后".into())
        .await;
    a.sync().await;
    b.sync().await;
    let devices_b = b.view.devices.read().clone();
    let other = devices_b.iter().find(|d| !d.is_self).expect("对方设备");
    assert!(other.tiers.conversation, "对方开了对话档: {other:?}");
    assert!(!other.tiers.secret);
    // 自己那份反映本机开关
    assert!(a.status().tiers.conversation);
}

/// 打开 / 关闭某一档：关着时绝不写远端；关闭不删远端、不删本机数据。
#[tokio::test(flavor = "multi_thread")]
async fn tiers_can_be_switched_and_a_closed_tier_never_touches_the_network() {
    let (mut a, _b, cloud) = pair().await;
    a.add_conn("c1", "生产服务器", "1.1.1.1", "root").await;
    a.create().await;
    a.sync().await;

    // 未知档位 / 关配置档都拒绝
    assert!(a.engine.enable_tier("nope", true).await.is_err());
    assert!(a.engine.enable_tier("config", false).await.is_err());

    // 对话档：开 —— 没有驱动（T2 之前）时什么都不写，但开关状态与 applied 标记要对
    a.engine.enable_tier("conversation", true).await.unwrap();
    assert!(a.status().tiers.conversation);
    assert!(a.engine.tier_enabled(crate::data::SyncTier::Conversation));
    let before = cloud.paths();
    a.engine.run_round(RoundKind::Full).await.unwrap();
    assert_eq!(cloud.paths(), before, "没有驱动时不该产生任何远端写入");

    // 关 —— 不删远端、不删本机数据
    a.engine.enable_tier("conversation", false).await.unwrap();
    assert!(!a.status().tiers.conversation);
    assert_eq!(cloud.paths(), before);
    assert_eq!(a.conn_ids().await.len(), 1);

    // 关着的时候本机改动照常走配置流
    a.edit_conn("c1", |c| c.name = "关着对话档也能同步配置".into())
        .await;
    a.sync().await;
    assert!(cloud.paths().iter().any(|p| p.contains("/seg-")));
}

/// 某一档的规模估算只有结构（T0 阶段数量按 0、机密分组为空），但形状必须与前端契约一致。
#[tokio::test(flavor = "multi_thread")]
async fn tier_estimates_have_the_contract_shape() {
    let (mut a, _b, _cloud) = pair().await;
    let mgr = manager_over(&mut a);
    assert!(
        mgr.tier_estimate("conversation".into()).is_err(),
        "没开同步"
    );

    a.create().await;
    let mgr = manager_over(&mut a);
    for tier in ["conversation", "secret"] {
        let e = mgr.tier_estimate(tier.into()).unwrap();
        assert_eq!(e.tier, tier);
        assert_eq!(e.conversations, 0);
        assert_eq!(e.images, 0);
        assert_eq!(e.total_bytes, 0);
        assert!(e.secret_groups.is_empty());
        let v = serde_json::to_value(&e).unwrap();
        assert!(v.get("secretGroups").is_some() && v.get("totalBytes").is_some());
    }
    assert!(mgr.tier_estimate("nope".into()).is_err());
}

/// 连接别名换算：加入同步时被去重掉的本机连接，其 id 在账本里能换算到云端 id，
/// 并且落盘（重启后还在）。
#[tokio::test(flavor = "multi_thread")]
async fn connection_aliases_are_persisted_and_resolvable() {
    let (mut b, _a, _cloud) = pair().await;
    // 手工把一条别名写进账本（加入流程产生的别名由 join 单元测试覆盖）
    let mut st = b.engine.ledger.st.clone();
    st.connection_aliases
        .insert("local-1".into(), "cloud-1".into());
    st.connection_aliases
        .insert("cloud-1".into(), "cloud-2".into());
    b.engine.ledger.st = st;
    b.engine.ledger.dirty.state = true;
    b.engine
        .ledger
        .flush(&LedgerFiles::new(b.dir.path()))
        .unwrap();

    assert_eq!(b.engine.resolve_connection_id("local-1"), "cloud-2");
    b.rebuild_engine("1.12.0", Vec::new());
    assert_eq!(
        b.engine.resolve_connection_id("local-1"),
        "cloud-2",
        "别名要落盘"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// 三期：机密流
// ═══════════════════════════════════════════════════════════════════════

/// 把同步引擎换成「带机密流驱动」的那套（测试里用来打开机密档）。
fn rebuild_with_secrets(dev: &mut Dev) {
    let files = LedgerFiles::new(dev.dir.path());
    dev.view = Arc::new(SharedView::new(HistoryStore::load(files.history_file())));
    dev.engine = SyncEngine::new(
        dev.deps_with_secrets("1.12.0", Vec::new()),
        dev.view.clone(),
    );
}

const A_SECRET: &str = "sk-very-secret-value-123";

#[tokio::test(flavor = "multi_thread")]
async fn secrets_sync_between_two_devices_and_land_in_the_keychain() {
    let (mut a, mut b, _cloud) = pair().await;
    rebuild_with_secrets(&mut a);
    rebuild_with_secrets(&mut b);
    // 两边各有一条连接（槽位目录里要有它，否则 `from_account` 反查不到）
    a.add_conn("c1", "服务器", "1.1.1.1", "root").await;
    let (_rk, code) = a.create().await;
    b.join_code(&code).await.unwrap();
    a.sync().await;

    // 用固定槽位（两台设备都「认识」它）。带参数的槽位（渠道 / 连接）要先在对方的
    // 配置里存在才认——那是 `from_account` 的 catalog 决定的，单测里另有覆盖。
    // A 打开机密档并写一个 Key
    a.engine.enable_tier("secret", true).await.unwrap();
    a.secrets
        .set(&SecretSlot::WebSearchApiKey, A_SECRET)
        .unwrap();
    a.sync().await;

    // B 打开机密档并同步
    b.engine.enable_tier("secret", true).await.unwrap();
    b.sync().await;
    assert_eq!(
        b.secrets
            .get(&SecretSlot::WebSearchApiKey)
            .unwrap()
            .as_deref(),
        Some(A_SECRET),
        "B 应该拿到 A 的 Key"
    );

    // A 删掉 → B 跟着删
    a.secrets.delete(&SecretSlot::WebSearchApiKey).unwrap();
    a.sync().await;
    b.sync().await;
    assert!(
        b.secrets
            .get(&SecretSlot::WebSearchApiKey)
            .unwrap()
            .is_none(),
        "B 应该跟着删"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn secrets_never_land_in_plaintext_on_disk() {
    let (mut a, _b, _cloud) = pair().await;
    rebuild_with_secrets(&mut a);
    a.add_conn("c1", "服务器", "1.1.1.1", "root").await;
    a.create().await;
    a.engine.enable_tier("secret", true).await.unwrap();
    a.secrets
        .set(&SecretSlot::WebSearchApiKey, A_SECRET)
        .unwrap();
    a.sync().await;

    // 扫描整个配置目录（含 sync/ 下的账本、镜像、基线）
    fn scan(dir: &std::path::Path, needle: &[u8]) -> Vec<String> {
        let mut hits = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(d) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&d) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let Ok(bytes) = std::fs::read(&path) else {
                    continue;
                };
                if bytes.windows(needle.len()).any(|w| w == needle) {
                    hits.push(path.display().to_string());
                }
            }
        }
        hits
    }
    let hits = scan(a.dir.path(), A_SECRET.as_bytes());
    assert!(
        hits.is_empty(),
        "磁盘上出现了明文机密：{hits:?}（镜像必须用 DK 封装、基线只存 HMAC）"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn closing_the_secret_tier_stops_uploading() {
    let (mut a, _b, cloud) = pair().await;
    rebuild_with_secrets(&mut a);
    a.create().await;
    a.engine.enable_tier("secret", true).await.unwrap();
    a.secrets.set(&SecretSlot::WebSearchApiKey, "k1").unwrap();
    a.sync().await;

    let sec_dir = format!("devices/{}/sec", a.engine.ledger.st.device_id);
    let before = cloud.list(&sec_dir).await.unwrap().len();
    assert!(before > 0, "打开机密档并改 Key 之后应该已经传上去过");

    // 关掉机密档后再改 Key：不应该再产生 sec 段（段数必须保持不变）
    a.engine.enable_tier("secret", false).await.unwrap();
    a.secrets.set(&SecretSlot::WebSearchApiKey, "k2").unwrap();
    a.sync().await;
    a.sync().await;

    let after = cloud.list(&sec_dir).await.unwrap().len();
    assert_eq!(
        after, before,
        "关掉机密档后不该再上传新段（before={before}, after={after}）"
    );
}
