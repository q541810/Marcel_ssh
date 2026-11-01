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
use crate::ssh::key_store::KeyStoreAccess;
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
    /// 这台模拟设备的对话库（T2）。
    conversation_db: Arc<crate::agent::conversation::ConversationDb>,
    /// 记忆库（T4）。
    memory_store: Arc<crate::memory::MemoryStore>,
    /// 本机私钥库（T7）：每台模拟设备一个临时目录。
    key_store: Arc<dyn crate::ssh::key_store::KeyStoreAccess>,
    /// 同一份库的具体句柄（集成测试里模拟「用户在这台设备导入私钥」）。
    dir_key_store: Arc<crate::ssh::key_store::DirKeyStore>,
    /// 对话流的驱动工厂（跨引擎重建沿用同一份）。
    conv_factory: Arc<crate::sync::streams::ConvStreamFactory>,
    /// 「这段对话在跑」的判定：测试里可改，用来模拟任务运行中的延迟落地。
    running: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// 当前「在跑」的会话集合（`running` 闭包读它）。
    running_ids: Arc<parking_lot::Mutex<HashSet<String>>>,
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
        let running_ids: Arc<parking_lot::Mutex<HashSet<String>>> =
            Arc::new(parking_lot::Mutex::new(HashSet::new()));
        let running: Arc<dyn Fn(&str) -> bool + Send + Sync> = {
            let ids = running_ids.clone();
            Arc::new(move |id: &str| ids.lock().contains(id))
        };
        let conversation_db = Arc::new(
            crate::agent::conversation::ConversationDb::new(
                crate::data::DataSourceId::Conversations.path(dir.path()),
            )
            .expect("测试对话库"),
        );
        let memory_store = Arc::new(
            crate::memory::MemoryStore::open(crate::data::DataSourceId::Memory.path(dir.path()))
                .expect("测试记忆库"),
        );
        let mut conv_factory = crate::sync::streams::ConvStreamFactory::new(
            vec![crate::sync::streams::ConvDatabase {
                name: crate::agent::conversation::CONV_DB_NAME,
                tables: crate::sync::streams::CONV_TABLES,
                handle: Arc::new(crate::sync::streams::ConversationHandle::new(
                    conversation_db.clone(),
                )),
            }],
            dir.path().to_path_buf(),
        );
        conv_factory.push_database(crate::sync::streams::memory::memory_database(
            memory_store.clone(),
        ));
        let conv_factory = Arc::new(conv_factory);
        let dir_key_store =
            std::sync::Arc::new(crate::ssh::key_store::tests_support::dir_key_store(
                crate::data::DataSourceId::KeyStore.path(dir.path()),
            ));
        let key_store: Arc<dyn crate::ssh::key_store::KeyStoreAccess> = dir_key_store.clone();
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
            conversation_db,
            memory_store,
            key_store,
            dir_key_store,
            conv_factory,
            running,
            running_ids,
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
            stream_drivers: {
                let mut drivers = self.stream_drivers();
                if with_secrets_driver {
                    drivers.push(self.secret_factory());
                }
                drivers
            },
            running_conversations: self.running.clone(),
            conv_estimate: {
                let db = self.conversation_db.clone();
                Arc::new(move || db.sync_estimate())
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
                key_store: self.key_store.clone(),
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

    /// T2 的对话流驱动工厂（每台模拟设备一个，绑它自己的临时数据库）。
    ///
    /// 工厂是**有状态**的（扣住的大量删除、每轮上下文），所以每个 `Dev` 各存一份，
    /// 重建引擎时沿用同一份——等价于真实的「应用重启、工厂跟着 AppState 活」。
    fn stream_drivers(&self) -> Vec<Arc<dyn crate::sync::streams::StreamDriverFactory>> {
        vec![self.conv_factory.clone()]
    }

    /// 「重启应用」：同一个配置目录上重新构造引擎（账本从磁盘读回来）。
    fn rebuild_engine(&mut self, version: &str, failures: Vec<DataSourceId>) {
        let files = LedgerFiles::new(self.dir.path());
        self.view = Arc::new(SharedView::new(HistoryStore::load(files.history_file())));
        self.engine = SyncEngine::new(self.deps(version, failures), self.view.clone());
    }

    /// 「重启应用」，且保留**带机密流驱动**的那套依赖（三期用例用）。
    fn rebuild_engine_with_secrets(&mut self) {
        let files = LedgerFiles::new(self.dir.path());
        self.view = Arc::new(SharedView::new(HistoryStore::load(files.history_file())));
        self.engine = SyncEngine::new(
            self.deps_with_secrets("1.12.0", Vec::new()),
            self.view.clone(),
        );
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

    // ── 对话（T2）的测试辅助 ─────────────────────────────────────────
    //
    // 对话库与同步引擎共用同一个 `Arc<ConversationDb>`：业务写入与同步捕获必须是同一条
    // 连接（触发器是连接级的），这正是生产里的形状。

    fn conv(&self) -> &crate::agent::conversation::ConversationDb {
        &self.conversation_db
    }

    /// 建一段对话并发几条消息（`user` / `assistant` 交替），返回会话 id。
    fn new_chat(&self, title: &str, pairs: usize) -> String {
        let conv = self
            .conv()
            .create_conversation("c1", title)
            .expect("建会话");
        for i in 0..pairs {
            self.conv()
                .save_message(
                    &conv.id,
                    "user",
                    &format!("{title} 的第 {i} 问"),
                    &format!("2026-01-01T00:{i:02}:00Z"),
                    None,
                    None,
                )
                .expect("写 user 消息");
            self.conv()
                .save_message(
                    &conv.id,
                    "assistant",
                    &format!("{title} 的第 {i} 答"),
                    &format!("2026-01-01T00:{i:02}:30Z"),
                    None,
                    None,
                )
                .expect("写 assistant 消息");
        }
        conv.id
    }

    fn conv_title(&self, id: &str) -> Option<String> {
        self.conv()
            .get_conversation(id)
            .expect("读会话")
            .map(|c| c.title)
    }

    fn conv_exists(&self, id: &str) -> bool {
        self.conv().get_conversation(id).expect("读会话").is_some()
    }

    fn conv_message_count(&self, id: &str) -> usize {
        self.conv().load_messages(id).expect("读消息").len()
    }

    /// 打开对话档（走真实的 `enable_tier`：导出 + 上传 + 一轮完整同步）。
    async fn enable_conv_tier(&mut self) {
        self.engine
            .enable_tier("conversation", true)
            .await
            .expect("打开对话档");
    }

    /// 把某段对话标记成「在跑」（延迟落地测试）。
    fn set_running(&self, id: &str, running: bool) {
        let mut ids = self.running_ids.lock();
        if running {
            ids.insert(id.to_string());
        } else {
            ids.remove(id);
        }
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
        running_conversations: Arc::new(|_| false),
        conv_estimate: Arc::new(|| Ok((0, 0, 0))),
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
    // 数值在这条用例里不钉死（T2 接了真实的对话 / 图片统计，T6 接了密钥链统计）：
    // 这里只钉**形状**——字段都在、类型对、tier 原样回传。
    for tier in ["conversation", "secret"] {
        let e = mgr.tier_estimate(tier.into()).unwrap();
        assert_eq!(e.tier, tier);
        let v = serde_json::to_value(&e).unwrap();
        for key in [
            "tier",
            "conversations",
            "images",
            "totalBytes",
            "secretGroups",
        ] {
            assert!(v.get(key).is_some(), "缺字段 {key}: {v}");
        }
        assert!(v["conversations"].is_u64());
        assert!(v["images"].is_u64());
        assert!(v["totalBytes"].is_u64());
        assert!(v["secretGroups"].is_array());
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

const A_SECRET: &str = "sk-very-secret-value-123";

#[tokio::test(flavor = "multi_thread")]
async fn secrets_sync_between_two_devices_and_land_in_the_keychain() {
    let (mut a, mut b, _cloud) = pair().await;
    a.rebuild_engine_with_secrets();
    b.rebuild_engine_with_secrets();
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
    a.rebuild_engine_with_secrets();
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
    a.rebuild_engine_with_secrets();
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

/// T7：A 导入一把私钥 → B 拿到同一把（能用它读出同样的私钥正文），A 删除 → B 跟着删。
#[tokio::test(flavor = "multi_thread")]
async fn private_keys_sync_and_survive_a_restart() {
    let (mut a, mut b, _cloud) = pair().await;
    a.rebuild_engine_with_secrets();
    b.rebuild_engine_with_secrets();
    let (_rk, code) = a.create().await;
    b.join_code(&code).await.unwrap();
    a.engine.enable_tier("secret", true).await.unwrap();
    b.engine.enable_tier("secret", true).await.unwrap();
    a.sync().await;
    b.sync().await;

    // A 上导入一把私钥
    let pem = crate::ssh::key_store::tests_support::sample_key(None);
    let meta = a
        .dir_key_store
        .import_text(&pem, "公司跳板机", None)
        .expect("导入私钥");
    a.sync().await;
    b.sync().await;

    // B 拿到了同一把（id 相同、正文相同、名字照抄）
    let got = b
        .dir_key_store
        .export_for_sync(&meta.id)
        .expect("B 应该有这把私钥");
    assert_eq!(got.0.name, "公司跳板机", "名字要照抄");
    assert_eq!(got.0.fingerprint, meta.fingerprint, "指纹要照抄");
    assert_eq!(got.1.as_str(), pem, "正文要一模一样");
    assert!(
        got.0.origin_path.is_none(),
        "来源路径是本机的概念，不能跨设备带过去"
    );

    // B 重启（引擎重建、账本从磁盘读回）后私钥还在，且不会重复发
    b.rebuild_engine_with_secrets();
    assert!(b.dir_key_store.export_for_sync(&meta.id).is_some());

    // A 删除 → B 跟着删
    a.dir_key_store
        .delete_from_sync(&meta.id)
        .expect("A 删除私钥");
    a.sync().await;
    b.sync().await;
    assert!(
        b.dir_key_store.export_for_sync(&meta.id).is_none(),
        "A 删了以后 B 也要删"
    );
}

/// T7：私钥正文（含它的明文片段）不能以明文出现在磁盘上——本机库里要重新封装。
#[tokio::test(flavor = "multi_thread")]
async fn synced_private_keys_never_land_in_plaintext_on_disk() {
    let (mut a, mut b, _cloud) = pair().await;
    a.rebuild_engine_with_secrets();
    b.rebuild_engine_with_secrets();
    let (_rk, code) = a.create().await;
    b.join_code(&code).await.unwrap();
    a.engine.enable_tier("secret", true).await.unwrap();
    b.engine.enable_tier("secret", true).await.unwrap();
    a.sync().await;

    let pem = crate::ssh::key_store::tests_support::sample_key(None);
    let meta = a
        .dir_key_store
        .import_text(&pem, "要同步的私钥", None)
        .expect("导入私钥");
    a.sync().await;
    b.sync().await;
    assert!(b.dir_key_store.export_for_sync(&meta.id).is_some());

    // 私钥正文的一段特有内容（不含通用头尾，免得被公钥/注释干扰）
    let needle = pem
        .lines()
        .nth(1)
        .expect("OpenSSH 私钥第二行是正文")
        .trim()
        .as_bytes()
        .to_vec();
    assert!(needle.len() > 16, "正文片段要够长才有判别力");

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
                if let Ok(bytes) = std::fs::read(&path) {
                    if bytes.windows(needle.len()).any(|w| w == needle) {
                        hits.push(path.display().to_string());
                    }
                }
            }
        }
        hits
    }
    for (who, dev) in [("A", &a), ("B", &b)] {
        let hits = scan(dev.dir.path(), &needle);
        assert!(
            hits.is_empty(),
            "{who} 的磁盘上出现了明文私钥：{hits:?}（私钥库必须用本机主密钥封装、blob 必须用 DK 封装）"
        );
    }
}

// ═══════════════════════════════════════════════════════════════════════
// 二期 · 对话库接入（T2）
// ═══════════════════════════════════════════════════════════════════════

/// A 新建对话聊几轮 → B 打开对话档后，会话与消息都出现。
#[tokio::test(flavor = "multi_thread")]
async fn conversations_and_messages_replicate_to_another_device() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    let conv_id = a.new_chat("部署记录", 3);
    a.enable_conv_tier().await;

    b.enable_conv_tier().await;

    assert!(b.conv_exists(&conv_id), "B 应该收到会话");
    assert_eq!(b.conv_title(&conv_id).as_deref(), Some("部署记录"));
    assert_eq!(b.conv_message_count(&conv_id), 6, "3 问 3 答都要在");
    let messages = b.conv().load_messages(&conv_id).expect("读消息");
    assert_eq!(messages[0].content, "部署记录 的第 0 问");
    assert_eq!(messages[5].role, "assistant");

    // 再来一轮，验证增量同步（不是只有首次导出）
    a.conv()
        .save_message(
            &conv_id,
            "user",
            "后来的第 4 问",
            "2026-01-01T01:00:00Z",
            None,
            None,
        )
        .expect("追加消息");
    a.sync().await;
    b.sync().await;
    assert_eq!(b.conv_message_count(&conv_id), 7);
}

/// B 改标题 / 置顶 → A 跟上（两个方向都成立，HLC 后写者赢）。
#[tokio::test(flavor = "multi_thread")]
async fn conversation_title_and_pin_changes_travel_both_ways() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    let conv_id = a.new_chat("原标题", 1);
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;
    assert!(b.conv_exists(&conv_id));

    b.conv()
        .update_conversation_title(&conv_id, "B 改的标题")
        .expect("改标题");
    b.sync().await;
    a.sync().await;
    assert_eq!(a.conv_title(&conv_id).as_deref(), Some("B 改的标题"));

    a.conv()
        .set_conversation_pinned(&conv_id, true)
        .expect("置顶");
    a.sync().await;
    b.sync().await;
    assert!(
        b.conv()
            .get_conversation(&conv_id)
            .expect("读会话")
            .expect("存在")
            .pinned,
        "B 应该看到置顶"
    );
}

/// A 删对话 → B 删除，且图片桶一起清掉。
///
/// 同时钉住「删一段 100 条消息的会话只发 1 条会话墓碑」——这是大量删除闸不误伤的前提。
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_conversation_replicates_one_tombstone_and_clears_the_image_bucket() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    let conv_id = a.new_chat("要删的会话", 50); // 100 条消息
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;
    assert_eq!(b.conv_message_count(&conv_id), 100);

    // 造一张假图片。`image_store` 的根是进程级 `OnceLock`：
    // - 第一次 `init` 生效，之后换目录无效（所以测试里必须**至少** init 一次，
    //   否则 `delete_conversation_images` 会因为「根没初始化」直接返回，什么都删不掉）；
    // - 两台模拟设备共用同一个目录，因此「A 的桶」与「B 的桶」在测试里是同一路径。
    // 为了真的验证**接收侧**清理，在 A 删完之后、B 落地之前再写一张——只有 B 的 landing
    // 能把它删掉。
    static INIT: std::sync::Once = std::sync::Once::new();
    INIT.call_once(|| {
        let dir = std::env::temp_dir().join("marcel-test-images-sync");
        crate::agent::image_store::init(&dir);
    });
    let _guard = crate::agent::image_store::test_lock();
    let rel = crate::agent::image_store::save_image_bytes(&conv_id, "msg-a", 0, b"fake-webp")
        .expect("写假图片");

    a.conv()
        .delete_conversation_cascade(&conv_id)
        .expect("删会话");
    // 本机删会话要清掉自己的图片桶。`IMAGES_ROOT` 是进程级 `OnceLock`，别的测试可能先
    // 把它指到别处，所以这里不断言「某个具体路径不存在」，只用 `absolute_path` 解析同一根
    // 再比对——解析不出来（根没初始化）也算通过。
    if let Ok(abs) = crate::agent::image_store::absolute_path(&rel) {
        assert!(!abs.exists(), "本机删会话要清掉自己的图片桶");
    }
    // 本机只应有一条待上传的会话墓碑（消息 / 计划 / 快照的 DELETE 都被抑制了）。
    let pending = a.conv().sync_pending_count().expect("待上传条数");
    assert_eq!(
        pending, 1,
        "删一段 100 条消息的会话只应产生 1 条会话墓碑，实际 {pending}"
    );

    // 模拟「B 那边还有这个会话的图片」：在同一个桶里再造一张。
    crate::agent::image_store::save_image_bytes(&conv_id, "msg-b", 0, b"fake-webp")
        .expect("写假图片");

    a.sync().await;
    b.sync().await;

    assert!(!b.conv_exists(&conv_id), "B 应该也删掉");
    assert_eq!(b.conv_message_count(&conv_id), 0, "消息一起清掉");
    if let Ok(abs) = crate::agent::image_store::absolute_path(&rel) {
        assert!(!abs.exists(), "接收侧落地会话墓碑时也要清图片桶");
    }
}

/// A 分叉一段对话 → B 也有，且 `forked_from_id` 正确。
#[tokio::test(flavor = "multi_thread")]
async fn forked_conversations_replicate_with_their_source_pointer() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    let source_id = a.new_chat("原始会话", 2);
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;
    assert!(b.conv_exists(&source_id));

    let outcome = a
        .conv()
        .fork_conversation(&source_id, None, "分叉出来的", false)
        .expect("分叉");
    let fork_id = outcome.conversation.id.clone();

    a.sync().await;
    b.sync().await;

    let fork = b
        .conv()
        .get_conversation(&fork_id)
        .expect("读会话")
        .expect("分叉应该到了");
    assert_eq!(fork.title, "分叉出来的");
    assert_eq!(
        fork.forked_from_id.as_deref(),
        Some(source_id.as_str()),
        "分叉来源要跟着同步"
    );
    assert_eq!(b.conv_message_count(&fork_id), 4);
}

/// 运行中会话的延迟落地：会话行改动挂起，消息的新插入照常落地；
/// 任务结束后下一轮把挂起的改动补上。
#[tokio::test(flavor = "multi_thread")]
async fn changes_to_a_running_conversation_are_held_until_it_finishes() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    let conv_id = a.new_chat("运行中的会话", 1);
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;
    assert!(b.conv_exists(&conv_id));

    // B 那边「这段对话正在跑」：A 改标题 + 追加一条消息
    b.set_running(&conv_id, true);
    a.conv()
        .update_conversation_title(&conv_id, "A 改的标题")
        .expect("改标题");
    a.conv()
        .save_message(
            &conv_id,
            "user",
            "新插入的消息",
            "2026-01-01T02:00:00Z",
            None,
            None,
        )
        .expect("追加消息");
    a.sync().await;
    b.sync().await;

    assert_eq!(
        b.conv_title(&conv_id).as_deref(),
        Some("运行中的会话"),
        "运行中会话的标题改动必须先挂起"
    );
    assert_eq!(
        b.conv_message_count(&conv_id),
        3,
        "messages 的新插入可以直接落地"
    );
    assert!(
        b.conv()
            .load_messages(&conv_id)
            .expect("读消息")
            .iter()
            .any(|m| m.content == "新插入的消息"),
        "新插入的那条消息应该已经能看见"
    );

    // 任务结束：下一轮把挂起的标题改动落下来
    b.set_running(&conv_id, false);
    b.sync().await;
    assert_eq!(
        b.conv_title(&conv_id).as_deref(),
        Some("A 改的标题"),
        "任务结束后挂起的改动要补上"
    );
}

/// 新设备按「会话最近活跃」从新到旧分包加入，进度从 0 涨到 3。
#[tokio::test(flavor = "multi_thread")]
async fn a_new_device_pulls_snapshot_parts_newest_first_with_progress() {
    let (mut a, _b, cloud) = pair().await;
    a.add_conn("c1", "生产服务器", "1.1.1.1", "root").await;
    let (_rk, code) = a.create().await;

    // 三段会话，updated_at 依次更晚（`new_chat` 里的 save_message 会 touch 会话）。
    let mut ids = Vec::new();
    for i in 0..3 {
        let id = a.new_chat(&format!("会话{i}"), 11);
        // 明确把 updated_at 拉开，避免同一毫秒内的实现细节影响排序
        a.conv().touch_conversation(&id).expect("touch 会话");
        ids.push(id);
    }
    a.enable_conv_tier().await;

    // 制造一次快照：段数攒够 50（COMPACT_AFTER_SEGS）时引擎才会压缩。
    // 用快照进度的形状验证「按 updatedAt 从新到旧」——这里直接构造 N 个快照段，
    // 通过多次改标题 + 同步把 segs_since_snapshot 推过阈值。
    for i in 0..(super::engine::COMPACT_AFTER_SEGS as usize) {
        a.conv()
            .update_conversation_title(&ids[0], &format!("第{i}次改名"))
            .expect("改标题");
        a.sync().await;
    }
    let device_a = a.status().device_id.clone().unwrap();
    let snap_prefix = format!("{}/conv/snap-", format::device_dir(&device_a));
    let snapshot_files: Vec<String> = cloud
        .paths()
        .into_iter()
        .filter(|p| p.starts_with(&snap_prefix))
        .collect();
    assert!(
        !snapshot_files.is_empty(),
        "攒够 50 段后应该写出分包快照: {:?}",
        cloud.paths()
    );
    assert!(
        snapshot_files.iter().any(|p| p.ends_with("index.msync")),
        "快照目录里必须有 index.msync: {snapshot_files:?}"
    );
    assert!(
        snapshot_files.iter().any(|p| p.contains("part-")),
        "快照目录里必须有分包: {snapshot_files:?}"
    );

    let mut c = Dev::new("C", &cloud, &new_clock(), Platform::Desktop).await;
    c.join_code(&code).await.unwrap();
    c.enable_conv_tier().await;

    // 三段会话全部到齐，消息完整
    for (i, id) in ids.iter().enumerate() {
        assert!(c.conv_exists(id), "会话{i} 应该从快照落地");
        assert_eq!(c.conv_message_count(id), 22, "会话{i} 的消息要完整");
    }

    // 进度：落地过程中「已同步 N / 共 M 段对话」从 0 涨到 3（最后一次 = 全部落完）
    let statuses = c.events.statuses.lock().clone();
    let mut progresses: Vec<(usize, usize)> = Vec::new();
    for status in &statuses {
        for stream in &status.streams {
            if stream.key == "conv" {
                if let Some(p) = &stream.progress {
                    progresses.push((p.done, p.total));
                }
            }
        }
    }
    // 3 段小对话会全落在**同一个分包**里（分包粒度是 4 MB，不是按会话数），所以
    // 这里只能看到一次进度。中间进度的那条路径由
    // `snapshot_progress_is_reported_once_per_part`（真正多包）单独钉住。
    assert!(
        progresses
            .iter()
            .any(|(done, total)| *done == 3 && *total == 3),
        "最终进度应该是 3 / 3: {progresses:?}"
    );
}

/// 大量删除闸：删 21 段对话 → 21 条墓碑被扣住，确认前不传出去；放行后对方跟着删。
#[tokio::test(flavor = "multi_thread")]
async fn deleting_more_than_twenty_conversations_is_held_until_confirmed() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    let mut ids = Vec::new();
    for i in 0..21 {
        ids.push(a.new_chat(&format!("要删的 {i}"), 1));
    }
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;
    assert!(b.conv_exists(&ids[0]));

    for id in &ids {
        a.conv().delete_conversation(id).expect("删会话");
    }
    a.sync().await;

    let held = a.status().held.expect("应当扣住");
    let conv = held
        .iter()
        .find(|h| h.source == "conversations")
        .expect("held 里应有 conversations 一项");
    assert_eq!(conv.count, 21, "21 段对话都被扣住");
    assert_eq!(a.status().state, SyncState::NeedsConfirm);

    // 确认之前不传出去
    b.sync().await;
    assert!(b.conv_exists(&ids[0]), "确认之前 B 不该删");

    // 放行：下一轮把 21 条会话墓碑发出去
    a.engine.confirm_held(true).await.expect("放行");
    b.sync().await;
    assert!(!b.conv_exists(&ids[0]), "放行后 B 应当删掉");
    assert!(!b.conv_exists(&ids[20]), "放行后 B 应当删掉全部 21 段");
    assert!(a.status().held.is_none(), "放行后不再有扣留项");
}

/// 同一台设备重跑多轮不重复上传：没有改动时远端文件集合不变，改动一次只多一个段。
#[tokio::test(flavor = "multi_thread")]
async fn repeated_rounds_do_not_reupload_conversation_segments() {
    let (mut a, mut b, cloud) = paired_and_synced().await;
    let conv_id = a.new_chat("幂等", 2);
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;

    a.sync().await;
    b.sync().await;
    let before = cloud.paths();
    for _ in 0..3 {
        a.sync().await;
        b.sync().await;
    }
    assert_eq!(cloud.paths(), before, "没有改动时不该产生新文件");

    let segs_before = cloud
        .paths()
        .into_iter()
        .filter(|p| p.contains("/conv/seg-"))
        .count();
    a.conv()
        .update_conversation_title(&conv_id, "改一次")
        .expect("改标题");
    a.sync().await;
    let segs_after = cloud
        .paths()
        .into_iter()
        .filter(|p| p.contains("/conv/seg-"))
        .count();
    assert_eq!(segs_after, segs_before + 1, "一次改动只该多一个增量段");
}

/// 关掉对话档 = 完全不上传、不拉取（引擎保证；这里钉住真实行为）。
#[tokio::test(flavor = "multi_thread")]
async fn a_closed_conversation_tier_neither_uploads_nor_pulls() {
    let (mut a, mut b, cloud) = paired_and_synced().await;
    let conv_id = a.new_chat("关档测试", 1);
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;
    assert!(b.conv_exists(&conv_id));

    // 关掉 B 的对话档
    b.engine
        .enable_tier("conversation", false)
        .await
        .expect("关闭对话档");

    // A 继续改对话：B 不应拉取，也不应写任何 conv 文件
    a.conv()
        .update_conversation_title(&conv_id, "关档后的改动")
        .expect("改标题");
    a.sync().await;
    let b_device = b.status().device_id.clone().unwrap();
    let before_paths = cloud.paths();
    b.sync().await;
    assert_eq!(
        b.conv_title(&conv_id).as_deref(),
        Some("关档测试"),
        "关着对话档时不该拉取"
    );
    assert_eq!(
        cloud.paths(),
        before_paths,
        "关着对话档时不该产生任何远端写入"
    );

    // B 本机的会话改动也不该传出去
    b.conv()
        .update_conversation_title(&conv_id, "B 本机改的")
        .expect("改标题");
    b.sync().await;
    a.sync().await;
    assert_eq!(
        a.conv_title(&conv_id).as_deref(),
        Some("关档后的改动"),
        "关着对话档时本机改动不该传出去"
    );
    let b_conv_files: Vec<String> = cloud
        .paths()
        .into_iter()
        .filter(|p| p.contains(&format!("{b_device}/conv/")))
        .collect();
    assert!(
        b_conv_files.is_empty(),
        "关着对话档的设备不该有 conv 文件: {b_conv_files:?}"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// 二期 · 记忆库接入（T4）
// ═══════════════════════════════════════════════════════════════════════

fn new_memory(title: &str, content: &str) -> crate::memory::model::WriteOp {
    crate::memory::model::WriteOp::Add {
        memory: crate::memory::model::NewMemory {
            scope: crate::memory::model::Scope::User,
            scope_key: String::new(),
            kind: crate::memory::model::Kind::Fact,
            title: title.into(),
            content: content.into(),
            pinned: false,
            source_conversation_id: None,
            source_message_id: None,
        },
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn memories_replicate_and_land_in_the_other_device() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;

    a.memory_store
        .apply(
            &crate::memory::model::BatchContext::new(crate::memory::model::Source::User, None),
            &[new_memory("部署习惯", "上线前先跑一遍全量测试")],
        )
        .expect("写记忆");
    a.sync().await;
    b.sync().await;

    let titles: Vec<String> = b
        .memory_store
        .list_all()
        .expect("读 B 的记忆")
        .into_iter()
        .map(|m| m.title)
        .collect();
    assert!(
        titles.contains(&"部署习惯".to_string()),
        "B 应该收到 A 写的记忆：{titles:?}"
    );
}

/// 删除也能同步；并且落地之后 B 的 `scope_versions` 变了（否则 Agent 下一轮还用旧快照）。
#[tokio::test(flavor = "multi_thread")]
async fn deleting_a_memory_syncs_and_bumps_scope_versions() {
    let (mut a, mut b, _cloud) = paired_and_synced().await;
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;

    a.memory_store
        .apply(
            &crate::memory::model::BatchContext::new(crate::memory::model::Source::User, None),
            &[new_memory("临时", "过会儿就删")],
        )
        .expect("写记忆");
    a.sync().await;
    b.sync().await;

    let item = b
        .memory_store
        .list_all()
        .expect("读 B 的记忆")
        .into_iter()
        .find(|m| m.title == "临时")
        .expect("B 收到过这条");

    // 落地之后必须 bump 作用域版本：否则记忆注入的冻结快照指纹不变，
    // 下一轮 Agent 用的还是旧记忆——「同步了却用不上」。
    let scopes = b.memory_store.list_all_scopes_for_sync().expect("读作用域");
    assert!(!scopes.is_empty(), "B 收到记忆后作用域列表不该为空");
    let versions = b
        .memory_store
        .bump_scope_versions_for(&scopes)
        .expect("bump 作用域");
    assert!(versions > 0, "bump 至少影响一个作用域");

    a.memory_store
        .apply(
            &crate::memory::model::BatchContext::new(crate::memory::model::Source::User, None),
            &[crate::memory::model::WriteOp::Delete {
                id: item.id.clone(),
                expected_version: None,
            }],
        )
        .expect("删记忆");
    a.sync().await;
    b.sync().await;

    assert!(
        !b.memory_store
            .list_all()
            .expect("读 B 的记忆")
            .iter()
            .any(|m| m.title == "临时"),
        "B 应该跟着删"
    );
}

// ═══════════════════════════════════════════════════════════════════════
// T10 · 三档全开的三设备收敛
// ═══════════════════════════════════════════════════════════════════════

/// 三台设备、三档全开：配置 / 对话 / 记忆 / 私钥混在一起改，拉取顺序打乱，
/// 最后三台必须**完全一致**。
///
/// 这是二、三期的总验收用例：任何一条流的「捕获漏了 / 落地丢了 / 回弹了」都会在这里露出来。
/// 刻意不按「改一轮、同步一轮」的整齐节奏来——真实用法就是各改各的、谁先上线谁先同步。
#[tokio::test(flavor = "multi_thread")]
async fn three_devices_with_all_tiers_converge_under_out_of_order_sync() {
    let cloud = MemoryStorage::new();
    let clock = new_clock();
    let mut a = Dev::new("A", &cloud, &clock, Platform::Desktop).await;
    let mut b = Dev::new("B", &cloud, &clock, Platform::Desktop).await;
    let mut c = Dev::new("C", &cloud, &clock, Platform::Android).await;
    a.rebuild_engine_with_secrets();
    b.rebuild_engine_with_secrets();
    c.rebuild_engine_with_secrets();

    // A 建同步，B / C 用同步码加入，然后三台都打开对话档与机密档
    a.add_conn("c1", "生产服务器", "1.1.1.1", "root").await;
    let (_rk, code) = a.create().await;
    b.join_code(&code).await.unwrap();
    c.join_code(&code).await.unwrap();
    for dev in [&mut a, &mut b, &mut c] {
        dev.engine.enable_tier("conversation", true).await.unwrap();
        dev.engine.enable_tier("secret", true).await.unwrap();
    }
    a.sync().await;
    b.sync().await;
    c.sync().await;

    // ── 各设备乱序地改不同东西 ─────────────────────────────────────

    // A：一条连接改名 + 一段对话 + 一条记忆 + 一个 Key
    a.edit_conn("c1", |c| c.name = "A 改的名字".into()).await;
    let conv_a = a.new_chat("A 的对话", 2);
    a.memory_store
        .apply(
            &crate::memory::model::BatchContext::new(crate::memory::model::Source::User, None),
            &[new_memory("A 的偏好", "喜欢深色主题")],
        )
        .expect("A 写记忆");
    a.secrets
        .set(&SecretSlot::WebSearchApiKey, "key-from-A")
        .unwrap();

    // B：自己的连接 + 自己的对话 + 自己的记忆 + 一把私钥
    b.add_conn("b1", "B 的机器", "3.3.3.3", "ubuntu").await;
    let conv_b = b.new_chat("B 的对话", 1);
    b.memory_store
        .apply(
            &crate::memory::model::BatchContext::new(crate::memory::model::Source::User, None),
            &[new_memory("B 的偏好", "习惯用 vim")],
        )
        .expect("B 写记忆");
    let pem = crate::ssh::key_store::tests_support::sample_key(None);
    let key_meta = b
        .dir_key_store
        .import_text(&pem, "B 的私钥", None)
        .expect("B 导入私钥");

    // C：只改自己的对话，别的先不动
    let conv_c = c.new_chat("C 的对话", 1);

    // ── 乱序同步：B 先、C 再、A 最后，中间穿插重跑 ──────────────────
    b.sync().await;
    c.sync().await;
    a.sync().await;
    // 让每台设备都至少各跑两轮（第二轮才看得到另外两台刚传上去的东西）
    b.sync().await;
    c.sync().await;
    a.sync().await;
    a.sync().await;
    b.sync().await;
    c.sync().await;

    // ── 三台必须完全一致 ──────────────────────────────────────────

    // 1) 连接：三台都有 c1 与 b1，且名字一致
    let expected_conns = {
        let mut v: Vec<(String, String)> = a
            .connections
            .read()
            .await
            .connections
            .iter()
            .map(|c| (c.id.clone(), c.name.clone()))
            .collect();
        v.sort();
        v
    };
    assert_eq!(expected_conns.len(), 2, "A 上应该只有两条连接");
    for dev in [&b, &c] {
        let mut got: Vec<(String, String)> = dev
            .connections
            .read()
            .await
            .connections
            .iter()
            .map(|c| (c.id.clone(), c.name.clone()))
            .collect();
        got.sort();
        assert_eq!(got, expected_conns, "{} 的连接应与 A 一致", dev.name);
    }
    assert_eq!(
        a.conn("c1").await.unwrap().name,
        "A 改的名字",
        "改名要传出去"
    );

    // 2) 对话：三台都有三段，消息条数一致
    for dev in [&a, &b, &c] {
        for (id, want) in [(&conv_a, 4), (&conv_b, 2), (&conv_c, 2)] {
            assert!(dev.conv_exists(id), "{} 缺会话 {id}", dev.name);
            assert_eq!(
                dev.conv_message_count(id),
                want,
                "{} 的会话 {id} 消息数不对",
                dev.name
            );
        }
    }

    // 3) 记忆：三台都有两条，内容一致
    for dev in [&a, &b, &c] {
        let titles: Vec<String> = dev
            .memory_store
            .list_all()
            .expect("读记忆")
            .into_iter()
            .map(|m| m.title)
            .collect();
        assert!(titles.contains(&"A 的偏好".to_string()), "{}: {titles:?}", dev.name);
        assert!(titles.contains(&"B 的偏好".to_string()), "{}: {titles:?}", dev.name);
    }

    // 4) 机密：三台都拿到同一个 Key；私钥三台都有且正文一致
    for dev in [&a, &b, &c] {
        assert_eq!(
            dev.secrets
                .get(&SecretSlot::WebSearchApiKey)
                .unwrap()
                .as_deref(),
            Some("key-from-A"),
            "{} 的 Key 应与 A 写入的一致",
            dev.name
        );
        let got = dev
            .dir_key_store
            .export_for_sync(&key_meta.id)
            .unwrap_or_else(|| panic!("{} 应该拿到 B 的私钥", dev.name));
        assert_eq!(got.1.as_str(), pem, "{} 的私钥正文应与 B 的一致", dev.name);
    }

    // 5) 收敛后不再产生新的上传（没有回弹 / 没有来回弹）
    let before = cloud.paths().len();
    for dev in [&mut a, &mut b, &mut c] {
        dev.sync().await;
    }
    assert_eq!(
        cloud.paths().len(),
        before,
        "三台都已收敛，再同步不该产生新文件（有回弹才会涨）"
    );
}
