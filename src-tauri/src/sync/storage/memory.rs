//! 内存存储：测试用的 [`SyncStorage`] 替身。
//!
//! 同步引擎的多设备测试要「几台模拟设备共用同一个云端」——`Clone` 出来的实例共享同一张表，就是
//! 同一个云端。它还能**注入失败**（下一次调用返回指定错误），用来验证退避、`FormatTooNew` 之外
//! 的网络 / 认证错误路径。目录是隐式的：有文件落在某个前缀下，这个目录就存在，和对象存储一个意思。

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::Arc;

use async_trait::async_trait;
use parking_lot::Mutex;

use super::{is_hidden_name, random_suffix, rel_segments, RemoteEntry, StorageError, SyncStorage};

#[derive(Default)]
struct Shared {
    /// 完整相对路径 → 内容。路径已经过 `rel_segments` 规范化（不带首尾 `/`）。
    files: BTreeMap<String, Vec<u8>>,
    /// 待消费的注入失败，先进先出：每次 trait 调用先取一个，取到就直接返回它。
    failures: VecDeque<StorageError>,
    /// 指定路径的按需故障队列：用于精确打断一个快照分包。
    path_failures: BTreeMap<String, VecDeque<StorageError>>,
    /// 调用流水（`put devices/a/seg-1` 这样的短句），测试用来断言「没有多余的请求」。
    calls: Vec<String>,
}

/// 见模块文档。`Clone` 共享同一份数据。
#[derive(Clone, Default)]
pub struct MemoryStorage {
    shared: Arc<Mutex<Shared>>,
}

impl MemoryStorage {
    pub fn new() -> Self {
        Self::default()
    }

    /// 让**下一次**调用（任意方法）失败，返回 `err`。可连续调用来排多个。
    pub fn fail_next(&self, err: StorageError) {
        self.shared.lock().failures.push_back(err);
    }

    /// 让接下来的 `n` 次调用都失败。
    pub fn fail_next_n(&self, err: StorageError, n: usize) {
        let mut s = self.shared.lock();
        for _ in 0..n {
            s.failures.push_back(err.clone());
        }
    }

    /// 清掉还没消费的注入失败。
    pub fn clear_failures(&self) {
        self.shared.lock().failures.clear();
        self.shared.lock().path_failures.clear();
    }

    /// 直接塞一个文件（不走 trait：不计入调用流水、不消费注入失败）。给测试预置云端状态用。
    pub fn insert(&self, path: &str, bytes: &[u8]) {
        let key = rel_segments(path).expect("合法路径").join("/");
        self.shared.lock().files.insert(key, bytes.to_vec());
    }

    /// 直接删除一个文件（不计调用流水）：构造中断发布 / 缺包等故障现场。
    pub fn remove(&self, path: &str) {
        let key = rel_segments(path).expect("合法路径").join("/");
        self.shared.lock().files.remove(&key);
    }

    /// 让指定路径的读取失败，其它请求照常。用于快照中途断网而不是整轮都断。
    pub fn fail_path(&self, path: &str, err: StorageError) {
        let key = rel_segments(path).expect("合法路径").join("/");
        self.shared
            .lock()
            .path_failures
            .insert(key, std::collections::VecDeque::from([err]));
    }

    pub fn peek(&self, path: &str) -> Option<Vec<u8>> {
        let key = rel_segments(path).expect("合法路径").join("/");
        self.shared.lock().files.get(&key).cloned()
    }

    /// 当前所有文件路径（有序）。
    pub fn paths(&self) -> Vec<String> {
        self.shared.lock().files.keys().cloned().collect()
    }

    /// 调用流水的快照。
    pub fn calls(&self) -> Vec<String> {
        self.shared.lock().calls.clone()
    }

    /// 清空调用流水（通常在「预置完状态、开始断言」之前调用）。
    pub fn clear_calls(&self) {
        self.shared.lock().calls.clear();
    }

    /// 记一笔流水，并消费一个注入失败（有就返回）。
    fn enter(&self, what: String) -> Result<(), StorageError> {
        let mut s = self.shared.lock();
        s.calls.push(what);
        match s.failures.pop_front() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

#[async_trait]
impl SyncStorage for MemoryStorage {
    async fn list(&self, dir: &str) -> Result<Vec<RemoteEntry>, StorageError> {
        let segs = rel_segments(dir)?;
        self.enter(format!("list {}", segs.join("/")))?;
        let prefix = if segs.is_empty() {
            String::new()
        } else {
            format!("{}/", segs.join("/"))
        };
        let s = self.shared.lock();
        let mut dirs = BTreeSet::new();
        let mut out = Vec::new();
        for (path, bytes) in s.files.range(prefix.clone()..) {
            let Some(rest) = path.strip_prefix(&prefix) else {
                break; // BTreeMap 有序：离开这个前缀就不会再回来
            };
            match rest.split_once('/') {
                Some((child_dir, _)) => {
                    if !is_hidden_name(child_dir) && dirs.insert(child_dir.to_string()) {
                        out.push(RemoteEntry {
                            name: child_dir.to_string(),
                            is_dir: true,
                            size: 0,
                        });
                    }
                }
                None => {
                    if !is_hidden_name(rest) {
                        out.push(RemoteEntry {
                            name: rest.to_string(),
                            is_dir: false,
                            size: bytes.len() as u64,
                        });
                    }
                }
            }
        }
        Ok(out)
    }

    async fn get(&self, path: &str) -> Result<Option<Vec<u8>>, StorageError> {
        let key = rel_segments(path)?.join("/");
        self.enter(format!("get {key}"))?;
        if let Some(err) = self
            .shared
            .lock()
            .path_failures
            .get_mut(&key)
            .and_then(VecDeque::pop_front)
        {
            return Err(err);
        }
        Ok(self.shared.lock().files.get(&key).cloned())
    }

    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), StorageError> {
        let key = rel_segments(path)?.join("/");
        if key.is_empty() {
            return Err(StorageError::Other("同步路径不能为空".into()));
        }
        self.enter(format!("put {key}"))?;
        self.shared.lock().files.insert(key, bytes.to_vec());
        Ok(())
    }

    async fn delete(&self, path: &str) -> Result<(), StorageError> {
        let key = rel_segments(path)?.join("/");
        if key.is_empty() {
            return Err(StorageError::Other("不能删除同步根目录本身".into()));
        }
        self.enter(format!("delete {key}"))?;
        let mut s = self.shared.lock();
        s.files.remove(&key);
        // 目录：连同其下所有文件一起删
        let prefix = format!("{key}/");
        s.files.retain(|p, _| !p.starts_with(&prefix));
        Ok(())
    }

    async fn probe(&self) -> Result<(), StorageError> {
        self.enter("probe".into())?;
        // 内存里没有权限问题；仍走一遍写 / 读 / 删，让「探针不留痕迹」这条约定在替身上也成立。
        let name = format!("probe-{}.tmp", random_suffix());
        let mut s = self.shared.lock();
        s.files.insert(name.clone(), b"marcel".to_vec());
        s.files.remove(&name);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::storage::contract_tests;

    #[tokio::test]
    async fn satisfies_the_storage_contract() {
        contract_tests::run(&MemoryStorage::new()).await;
    }

    #[tokio::test]
    async fn clones_share_one_cloud() {
        let a = MemoryStorage::new();
        let b = a.clone();
        a.put("devices/a/seg-1.msync", b"x").await.unwrap();
        assert_eq!(
            b.get("devices/a/seg-1.msync").await.unwrap(),
            Some(b"x".to_vec())
        );
    }

    #[tokio::test]
    async fn injected_failures_fire_once_each_in_order() {
        let m = MemoryStorage::new();
        m.insert("a.txt", b"1");
        m.fail_next(StorageError::Network("断网".into()));
        m.fail_next(StorageError::Auth("密码错".into()));
        assert_eq!(
            m.get("a.txt").await,
            Err(StorageError::Network("断网".into()))
        );
        assert_eq!(m.list("").await, Err(StorageError::Auth("密码错".into())));
        // 用完恢复正常，数据没被失败的调用动过
        assert_eq!(m.get("a.txt").await.unwrap(), Some(b"1".to_vec()));
        m.fail_next_n(StorageError::Network("x".into()), 2);
        m.clear_failures();
        assert!(m.probe().await.is_ok());
    }

    #[tokio::test]
    async fn failed_put_writes_nothing_and_calls_are_logged() {
        let m = MemoryStorage::new();
        m.fail_next(StorageError::Permission("只读".into()));
        assert!(m.put("a/b.txt", b"x").await.is_err());
        assert!(m.paths().is_empty());
        m.put("a/b.txt", b"x").await.unwrap();
        assert_eq!(m.calls(), vec!["put a/b.txt", "put a/b.txt"]);
        m.clear_calls();
        assert!(m.calls().is_empty());
    }
}
