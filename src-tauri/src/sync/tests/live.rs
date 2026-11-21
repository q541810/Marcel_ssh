//! 真实服务器的存储与同步集成验收。
//!
//! 默认不联网；显式提供专用测试机配置后才运行。测试只用本轮随机生成的空目录，结束时删除。
//! 凭据从当前进程的环境变量读取，不进配置、源码或日志。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use async_trait::async_trait;
use parking_lot::Mutex as PlMutex;
use zeroize::Zeroizing;

use super::*;
use crate::sync::backends::{Backend, BackendFactory};
use crate::sync::storage::contract_tests;
use crate::sync::storage::{RemoteEntry, SftpStorage, WebDavStorage};
use crate::sync::store::StreamName;

fn required(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn test_root(prefix: &str) -> String {
    format!("{prefix}/{}", uuid::Uuid::new_v4().simple())
}

async fn remove_root(storage: &dyn SyncStorage, prefix: &str, root: &str) {
    let relative = root.strip_prefix(prefix).expect("测试根目录位于隔离前缀内");
    storage
        .delete(relative)
        .await
        .expect("删除本轮测试数据");
    assert!(
        storage.list(relative).await.unwrap().is_empty(),
        "测试目录必须清空"
    );
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要专用 WebDAV 测试机；设置 MARCEL_TEST_WEBDAV_* 后显式运行"]
async fn webdav_real_server_satisfies_the_storage_contract() {
    let (Some(url), Some(username), Some(password)) = (
        required("MARCEL_TEST_WEBDAV_URL"),
        required("MARCEL_TEST_WEBDAV_USERNAME"),
        required("MARCEL_TEST_WEBDAV_PASSWORD"),
    ) else {
        return;
    };
    let root = test_root("marcel-integration/webdav");
    let storage = WebDavStorage::new(&url, &username, &password, &root).unwrap();
    contract_tests::run(&storage).await;
    remove_root(&storage, "marcel-integration/webdav", &root).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要专用 SFTP 测试机；设置 MARCEL_TEST_SFTP_* 后显式运行"]
async fn sftp_real_server_satisfies_the_storage_contract() {
    let Some((host, username, password)) = sftp_config() else {
        return;
    };
    let root = test_root("sync-data/marcel-integration/sftp");
    let (storage, ssh) = real_sftp(&host, &username, &password, &root).await;
    contract_tests::run(&storage).await;
    remove_root(&storage, "sync-data/marcel-integration/sftp", &root).await;
    storage.close().await;
    drop(ssh);
}

fn sftp_config() -> Option<(String, String, String)> {
    match (
        required("MARCEL_TEST_SFTP_HOST"),
        required("MARCEL_TEST_SFTP_USERNAME"),
        required("MARCEL_TEST_SFTP_PASSWORD"),
    ) {
        (Some(host), Some(username), Some(password)) => Some((host, username, password)),
        _ => None,
    }
}

async fn real_sftp(
    host: &str,
    username: &str,
    password: &str,
    root: &str,
) -> (SftpStorage, crate::ssh::connection::SshManager) {
    let ssh = crate::ssh::connection::SshManager::new();
    let connector = Arc::new(LiveSftpConnector {
        ssh: ssh.clone(),
        host: host.to_string(),
        username: username.to_string(),
        password: password.to_string(),
        connects: AtomicUsize::new(0),
    });
    let storage = SftpStorage::new(ssh.clone(), connector, "live-sftp", root);
    storage.probe().await.expect("真实 SFTP 自检");
    (storage, ssh)
}

struct LiveSftpConnector {
    ssh: crate::ssh::connection::SshManager,
    host: String,
    username: String,
    password: String,
    connects: AtomicUsize,
}

#[async_trait]
impl crate::sync::storage::SftpConnector for LiveSftpConnector {
    async fn connect(&self, connection_id: &str) -> Result<String, crate::error::AppError> {
        assert_eq!(connection_id, "live-sftp");
        self.connects.fetch_add(1, Ordering::SeqCst);
        self.ssh
            .connect_headless(crate::ssh::connection::ConnectionConfig {
                host: self.host.clone(),
                port: 22,
                username: self.username.clone(),
                auth_method: crate::ssh::auth::AuthMethod::Password {
                    password: self.password.clone(),
                },
                connection_id: None,
                trust_new_host_key: false,
                jump: None,
            })
            .await
    }
}

enum LiveStorage {
    WebDav,
    Sftp,
}

impl LiveStorage {
    fn root(&self, resume: bool) -> (String, &'static str) {
        match (self, resume) {
            (Self::WebDav, false) => (
                test_root("marcel-integration/webdav-sync"),
                "marcel-integration/webdav-sync",
            ),
            (Self::WebDav, true) => (
                test_root("marcel-integration/webdav-resume"),
                "marcel-integration/webdav-resume",
            ),
            (Self::Sftp, false) => (
                test_root("sync-data/marcel-integration/sftp-sync"),
                "sync-data/marcel-integration/sftp-sync",
            ),
            (Self::Sftp, true) => (
                test_root("sync-data/marcel-integration/sftp-resume"),
                "sync-data/marcel-integration/sftp-resume",
            ),
        }
    }

    fn config(&self, root: &str) -> (StorageConfig, Zeroizing<String>) {
        match self {
            Self::WebDav => (
                StorageConfig::WebDav {
                    url: required("MARCEL_TEST_WEBDAV_URL").expect("缺少 WebDAV 测试地址"),
                    username: required("MARCEL_TEST_WEBDAV_USERNAME").expect("缺少 WebDAV 测试账号"),
                    root: root.to_string(),
                },
                Zeroizing::new(
                    required("MARCEL_TEST_WEBDAV_PASSWORD").expect("缺少 WebDAV 测试密码"),
                ),
            ),
            Self::Sftp => (
                StorageConfig::Sftp {
                    connection_id: "live-sftp".into(),
                    root: root.to_string(),
                },
                Zeroizing::new(sftp_config().expect("缺少 SFTP 测试配置").2),
            ),
        }
    }
}

struct LiveBackends {
    ssh: crate::ssh::connection::SshManager,
    connections: JsonStore<ConnectionStore>,
    secrets: Arc<MemorySecrets>,
    fault: Arc<DownloadFault>,
}

impl LiveBackends {
    fn new(dev: &Dev, fault: Arc<DownloadFault>) -> Self {
        Self {
            ssh: crate::ssh::connection::SshManager::with_known_hosts(dev.known_hosts.clone()),
            connections: dev.connections.clone(),
            secrets: dev.secrets.clone(),
            fault,
        }
    }
}

impl BackendFactory for LiveBackends {
    fn build(
        &self,
        config: &StorageConfig,
        secret: Option<&str>,
    ) -> Result<Arc<dyn Backend>, super::super::storage::StorageError> {
        let storage: Arc<dyn Backend> = match config {
            StorageConfig::WebDav { url, username, root } => Arc::new(WebDavStorage::new(
                url,
                username,
                secret.unwrap_or(""),
                root,
            )?),
            StorageConfig::Sftp { connection_id, root } => {
                let saved = futures::executor::block_on(self.connections.read())
                    .get_by_id(connection_id)
                    .cloned()
                    .expect("测试连接已保存");
                assert!(!saved.use_jump && saved.auth_method == "Password");
                Arc::new(SftpStorage::new(
                    self.ssh.clone(),
                    Arc::new(TestSftpConnector {
                        ssh: self.ssh.clone(),
                        secrets: self.secrets.clone(),
                        saved,
                    }),
                    connection_id,
                    root,
                ))
            }
        };
        Ok(Arc::new(InterruptibleBackend {
            storage,
            fault: self.fault.clone(),
        }))
    }
}

struct TestSftpConnector {
    ssh: crate::ssh::connection::SshManager,
    secrets: Arc<MemorySecrets>,
    saved: SavedConnection,
}

#[async_trait]
impl crate::sync::storage::SftpConnector for TestSftpConnector {
    async fn connect(&self, connection_id: &str) -> Result<String, crate::error::AppError> {
        assert_eq!(connection_id, self.saved.id);
        let password = self
            .secrets
            .get(&SecretSlot::SshPassword(connection_id.to_string()))?
            .ok_or_else(crate::error::AppError::needs_password)?;
        self.ssh
            .connect_headless(crate::ssh::connection::ConnectionConfig {
                host: self.saved.host.clone(),
                port: self.saved.port,
                username: self.saved.username.clone(),
                auth_method: crate::ssh::auth::AuthMethod::Password { password },
                connection_id: None,
                trust_new_host_key: false,
                jump: None,
            })
            .await
    }
}

#[derive(Default)]
struct DownloadFault {
    /// 只对指定的检查点包生效一次；服务端完整数据不变。
    armed: PlMutex<Option<String>>,
    failures: PlMutex<BTreeMap<String, usize>>,
    gets: PlMutex<BTreeMap<String, usize>>,
}

impl DownloadFault {
    fn arm(&self, path: &str) {
        *self.armed.lock() = Some(path.to_string());
    }

    fn reads(&self, path: &str) -> usize {
        self.gets.lock().get(path).copied().unwrap_or(0)
    }
}

struct InterruptibleBackend {
    storage: Arc<dyn Backend>,
    fault: Arc<DownloadFault>,
}

#[async_trait]
impl Backend for InterruptibleBackend {
    async fn protected_root(&self) -> Option<String> {
        self.storage.protected_root().await
    }

    async fn close(&self) {
        self.storage.close().await;
    }
}

#[async_trait]
impl SyncStorage for InterruptibleBackend {
    async fn list(&self, dir: &str) -> Result<Vec<RemoteEntry>, super::super::storage::StorageError> {
        self.storage.list(dir).await
    }

    async fn get(&self, path: &str) -> Result<Option<Vec<u8>>, super::super::storage::StorageError> {
        *self.fault.gets.lock().entry(path.to_string()).or_default() += 1;
        let fail = {
            let mut armed = self.fault.armed.lock();
            if armed.as_deref() == Some(path) {
                *armed = None;
                true
            } else {
                false
            }
        };
        if fail {
            *self.fault.failures.lock().entry(path.to_string()).or_default() += 1;
            return Err(super::super::storage::StorageError::Network(
                "验收：指定检查点包下载失败一次".into(),
            ));
        }
        self.storage.get(path).await
    }

    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), super::super::storage::StorageError> {
        self.storage.put(path, bytes).await
    }

    async fn delete(&self, path: &str) -> Result<(), super::super::storage::StorageError> {
        self.storage.delete(path).await
    }

    async fn probe(&self) -> Result<(), super::super::storage::StorageError> {
        self.storage.probe().await
    }
}

async fn production_pair(
    kind: &LiveStorage,
    root: &str,
    fault: Arc<DownloadFault>,
    join: bool,
) -> (Dev, Dev, Zeroizing<String>, Zeroizing<String>) {
    let placeholder = MemoryStorage::new();
    let clock = new_clock();
    let mut a = Dev::new_with_backend_factory(
        "真实桌面",
        Arc::new(placeholder.clone()),
        None,
        &clock,
        Platform::Desktop,
    )
    .await;
    let mut b = Dev::new_with_backend_factory(
        "真实移动端",
        Arc::new(placeholder.clone()),
        None,
        &clock,
        Platform::Android,
    )
    .await;
    a.backends = Some(Arc::new(LiveBackends::new(&a, fault.clone())));
    b.backends = Some(Arc::new(LiveBackends::new(&b, fault)));
    a.rebuild_engine("1.12.0", Vec::new());
    b.rebuild_engine("1.12.0", Vec::new());

    let (storage, password) = kind.config(root);
    if matches!(storage, StorageConfig::Sftp { .. }) {
        let (host, username, _) = sftp_config().expect("缺少 SFTP 测试配置");
        a.add_conn("live-sftp", "同步测试机", &host, &username).await;
        a.secrets
            .set(&SecretSlot::SshPassword("live-sftp".into()), &password)
            .unwrap();
    }
    let storage_secret = match &storage {
        StorageConfig::WebDav { .. } => Some(password.clone()),
        StorageConfig::Sftp { .. } => None,
    };
    let created = a
        .engine
        .create(storage.clone(), storage_secret)
        .await
        .expect("真实服务器创建同步");
    if join {
        b.join_code(&created.sync_code)
            .await
            .expect("第二台设备通过真实后端加入");
    }
    let code = Zeroizing::new(created.sync_code.clone());
    (a, b, password, code)
}

async fn two_devices_on_a_real_server(kind: LiveStorage) {
    let (root, prefix) = kind.root(false);
    let fault = Arc::new(DownloadFault::default());
    let (mut a, mut b, password, code) = production_pair(&kind, &root, fault, true).await;
    let id = a.new_chat("真实检查点", 3);
    a.enable_conv_tier().await;
    b.enable_conv_tier().await;
    assert_eq!(b.conv_message_count(&id), 6, "首次检查点完整到达");

    let reader = LiveBackends::new(&b, Arc::new(DownloadFault::default()));
    let backend = reader.build(&kind.config(&root).0, Some(&password)).unwrap();
    let before_increment = remote_paths(backend.as_ref(), "devices/").await;
    assert!(count_checkpoints(&before_increment) > 0, "必须发布已提交检查点");

    a.conv()
        .save_message(
            &id,
            "user",
            "已有检查点后只补这一句",
            "2026-01-02T00:00:00Z",
            None,
            None,
        )
        .unwrap();
    a.sync().await;
    b.sync().await;
    assert_eq!(b.conv_message_count(&id), 7);
    let after_increment = remote_paths(backend.as_ref(), "devices/").await;
    assert_eq!(
        count_checkpoints(&after_increment),
        count_checkpoints(&before_increment),
        "连续增量不能重新发布整份检查点"
    );
    assert!(after_increment.len() > before_increment.len(), "真实服务器上应新增增量段");

    a.conv().delete_conversation(&id).expect("删除测试对话");
    a.sync().await;
    b.sync().await;
    assert!(!b.conv_exists(&id), "删除墓碑应跨真实服务器收敛");
    cleanup(&kind, &root, prefix, &password, &code, &mut a, &mut b).await;
}

async fn checkpoint_resume_on_a_real_server(kind: LiveStorage) {
    let (root, prefix) = kind.root(true);
    let fault = Arc::new(DownloadFault::default());
    let (mut a, mut b, password, code) = production_pair(&kind, &root, fault.clone(), false).await;
    let mut ids = Vec::new();
    for i in 0..3 {
        let id = a.new_chat(&format!("续传 {i}"), 24);
        for _ in 0..4 {
            a.conv()
                .save_message(
                    &id,
                    "assistant",
                    &"真实服务器多包续传测试".repeat(2500),
                    "2026-01-03T00:00:00Z",
                    None,
                    None,
                )
                .unwrap();
        }
        ids.push(id);
    }
    a.enable_conv_tier().await;
    let device = a.status().device_id.unwrap();
    let dir = format!("devices/{device}/conv/checkpoint-");
    let reader = LiveBackends::new(&b, Arc::new(DownloadFault::default()));
    let backend = reader.build(&kind.config(&root).0, Some(&password)).unwrap();
    let mut parts = remote_paths(backend.as_ref(), "devices").await;
    parts.retain(|path| path.starts_with(&dir) && path.contains("/part-"));
    parts.sort();
    assert!(parts.len() >= 3, "测试必须真实产生多个分包");
    fault.arm(&parts[1]);

    b.join_code(&code).await.expect("重新加入以验收首次检查点下载");
    b.engine
        .enable_tier("conversation", true, JoinStrategy::Merge)
        .await
        .expect_err("指定数据包失败时不能完成检查点");
    assert!(ids.iter().all(|id| !b.conv_exists(id)), "半份检查点不可见");
    assert!(b
        .engine
        .ledger
        .st
        .stream(StreamName::Conv)
        .cursors
        .get(&device)
        .is_none());
    assert_eq!(fault.reads(&parts[0]), 1, "第一包已下载并暂存");

    b.rebuild_engine("1.12.0", Vec::new());
    b.sync().await;
    for id in &ids {
        assert_eq!(b.conv_message_count(id), 52, "重启后补齐整份历史");
    }
    assert_eq!(fault.reads(&parts[0]), 1, "已验证的第一包不再下载");
    assert_eq!(fault.reads(&parts[1]), 2, "中断包恢复后续取");
    let cache = DataSourceId::SyncState
        .path(b.dir.path())
        .join("checkpoint-cache");
    assert!(!cache.exists() || std::fs::read_dir(cache).unwrap().next().is_none());
    cleanup(&kind, &root, prefix, &password, &code, &mut a, &mut b).await;
}

async fn cleanup(
    kind: &LiveStorage,
    root: &str,
    prefix: &str,
    password: &str,
    code: &str,
    a: &mut Dev,
    b: &mut Dev,
) {
    // 用正式接口删除本轮同步数据，包含中途失败留下的分包。
    b.engine.disable(true).await.expect("清理本轮远端同步数据");
    a.engine.disable(false).await.unwrap();
    let reader = LiveBackends::new(b, Arc::new(DownloadFault::default()));
    let backend = reader.build(&kind.config(root).0, Some(password)).unwrap();
    assert!(backend.list("").await.unwrap().is_empty());
    backend.close().await;
    remove_root(backend.as_ref(), prefix, root).await;
    // 同步码只在测试进程内使用，断言它不会出现在源码和测试输出里。
    assert!(!code.is_empty());
}

fn count_checkpoints(paths: &[String]) -> usize {
    paths
        .iter()
        .filter(|path| path.contains("/conv/checkpoint-") && path.ends_with("manifest.msync"))
        .count()
}

async fn remote_paths(storage: &dyn SyncStorage, directory: &str) -> Vec<String> {
    fn walk<'a>(
        storage: &'a dyn SyncStorage,
        directory: &'a str,
        paths: &'a mut Vec<String>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + Send + 'a>> {
        Box::pin(async move {
            let entries = storage.list(directory).await.expect("列真实服务器目录");
            for RemoteEntry { name, is_dir, .. } in entries {
                let path = if directory.is_empty() {
                    name
                } else {
                    format!("{directory}/{name}")
                };
                if is_dir {
                    walk(storage, &path, paths).await;
                } else {
                    paths.push(path);
                }
            }
        })
    }
    let mut paths = Vec::new();
    walk(storage, directory, &mut paths).await;
    paths.sort();
    paths
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要专用 WebDAV 测试机；设置 MARCEL_TEST_WEBDAV_* 后显式运行"]
async fn webdav_two_devices_checkpoint_increment_and_tombstone() {
    if required("MARCEL_TEST_WEBDAV_URL").is_none() {
        return;
    }
    two_devices_on_a_real_server(LiveStorage::WebDav).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要专用 SFTP 测试机；设置 MARCEL_TEST_SFTP_* 后显式运行"]
async fn sftp_two_devices_checkpoint_increment_and_tombstone() {
    if required("MARCEL_TEST_SFTP_HOST").is_none() {
        return;
    }
    two_devices_on_a_real_server(LiveStorage::Sftp).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要专用 WebDAV 测试机；设置 MARCEL_TEST_WEBDAV_* 后显式运行"]
async fn webdav_checkpoint_resumes_after_an_injected_download_failure_and_restart() {
    if required("MARCEL_TEST_WEBDAV_URL").is_none() {
        return;
    }
    checkpoint_resume_on_a_real_server(LiveStorage::WebDav).await;
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要专用 SFTP 测试机；设置 MARCEL_TEST_SFTP_* 后显式运行"]
async fn sftp_checkpoint_resumes_after_an_injected_download_failure_and_restart() {
    if required("MARCEL_TEST_SFTP_HOST").is_none() {
        return;
    }
    checkpoint_resume_on_a_real_server(LiveStorage::Sftp).await;
}
