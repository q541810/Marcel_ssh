//! 机密基线：**不存明文**地记住「本机上次同步出去的每个 Key 是什么样」。
//!
//! 密钥链没有变更通知，所以「本机哪个 Key 变了」只能靠比对。比对需要一份基线，而基线本身
//! 不能是明文——否则同步功能反而在磁盘上多存了一份密码。这里存的是
//! `HMAC-SHA256(本机随机盐, 值)`：
//!
//! ```text
//! sync/secret_baseline.json
//! {"salt":"<base64 32 字节>","entries":{"llm_channel_c1":"<hex>", …}}
//! ```
//!
//! - 盐是**本机**随机生成的，只用于「这台设备认不认得自己上次写出去的那个值」；
//! - HMAC 不可逆，也不与别的设备可比（每台设备的盐不同），拿到这个文件推不出任何 Key；
//! - 比较用常量时间，避免把「前几位猜对了」暴露成时间差。
//!
//! 什么时候用：
//! - `capture` 全量比对：密钥链里的值与基线摘要不同 → 发一条 `set op`；
//! - `land` 落地成功后把新值写进基线（否则下一轮会把它当成「本机改动」再发一遍）。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::config::persist::atomic_write;
use crate::data::DataSourceId;
use crate::error::AppError;

/// 基线文件名（在 `sync/` 目录下，属 `DataSourceId::SyncState`）。
const BASELINE_FILE: &str = "secret_baseline.json";
/// 盐长度（字节）。
const SALT_LEN: usize = 32;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct BaselineFile {
    /// base64 的本机随机盐。文件不存在时生成。
    salt: String,
    /// `account` → HMAC-SHA256 hex。
    entries: BTreeMap<String, String>,
}

/// 机密基线（内存形态）。
pub struct SecretBaseline {
    path: PathBuf,
    /// 盐（base64）。`Zeroizing`：它虽然不算「机密本身」，但泄漏它能让弱口令的摘要被离线爆破，
    /// 成本为零，就别留。
    salt: Zeroizing<String>,
    entries: BTreeMap<String, String>,
}

impl SecretBaseline {
    /// 从 `<config_dir>/sync/secret_baseline.json` 读；不存在 / 损坏都按空基线处理
    /// （空基线只会让第一次捕获把现有 Key 全发一遍，是多花一点流量，不是数据错误）。
    pub fn load(config_dir: &Path) -> Result<Self, AppError> {
        let path = DataSourceId::SyncState.path(config_dir).join(BASELINE_FILE);
        let file = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<BaselineFile>(&text).ok())
            .unwrap_or_default();
        let salt = if file.salt.is_empty() {
            Zeroizing::new(random_salt()?)
        } else {
            Zeroizing::new(file.salt)
        };
        Ok(Self {
            path,
            salt,
            entries: file.entries,
        })
    }

    fn digest_inner(&self, value: &str) -> String {
        let mut mac =
            HmacSha256::new_from_slice(self.salt.as_bytes()).expect("HMAC 接受任意长度的密钥");
        mac.update(value.as_bytes());
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }

    pub fn digest(&self, value: &str) -> String {
        self.digest_inner(value)
    }

    /// 基线里记的摘要与「这个值的摘要」是不是同一个。
    /// 常量时间比较：先用等长填充再逐字节异或，长度不同也不提前返回。
    pub fn matches(&self, account: &str, value: &str) -> bool {
        let Some(recorded) = self.entries.get(account) else {
            return false;
        };
        constant_time_eq(recorded.as_bytes(), self.digest_inner(value).as_bytes())
    }

    pub fn knows(&self, account: &str) -> bool {
        self.entries.contains_key(account)
    }

    pub fn upsert(&mut self, account: &str, value: &str) {
        self.entries
            .insert(account.to_string(), self.digest_inner(value));
    }

    pub fn remove(&mut self, account: &str) {
        self.entries.remove(account);
    }

    /// 基线里有哪些 account（「上次同步过什么」的清单）。
    pub fn accounts(&self) -> Vec<String> {
        self.entries.keys().cloned().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn save(&self) -> Result<(), AppError> {
        let file = BaselineFile {
            salt: self.salt.as_str().to_string(),
            entries: self.entries.clone(),
        };
        let text = serde_json::to_string_pretty(&file)
            .map_err(|e| AppError::Config(format!("序列化机密基线失败：{e}")))?;
        atomic_write(&self.path, &text)
            .map_err(|e| AppError::Config(format!("写入机密基线失败：{e}")))
    }
}

fn random_salt() -> Result<String, AppError> {
    use aes_gcm::aead::rand_core::RngCore;
    let mut buf = Zeroizing::new([0u8; SALT_LEN]);
    aes_gcm::aead::OsRng
        .try_fill_bytes(&mut buf[..])
        .map_err(|_| AppError::Config("系统随机数不可用，无法生成机密基线盐".into()))?;
    Ok(B64.encode(&buf[..]))
}

/// 常量时间比较：长度不同也要走完整段循环。
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    let len = a.len().max(b.len());
    let mut diff = (a.len() ^ b.len()) as u8;
    for i in 0..len {
        let x = *a.get(i).unwrap_or(&0);
        let y = *b.get(i).unwrap_or(&0);
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &str = "sk-very-secret-value-123";

    fn baseline_at(dir: &Path) -> SecretBaseline {
        SecretBaseline::load(dir).unwrap()
    }

    #[test]
    fn digest_is_stable_and_value_sensitive() {
        let tmp = tempfile::tempdir().unwrap();
        let b = baseline_at(tmp.path());
        let d1 = b.digest(SECRET);
        let d2 = b.digest(SECRET);
        let d3 = b.digest("sk-very-secret-value-124");
        assert_eq!(d1, d2, "同一个值摘要必须稳定");
        assert_ne!(d1, d3, "不同值不能撞摘要");
        assert_eq!(d1.len(), 64, "hex 编码的 SHA-256");
    }

    #[test]
    fn different_salts_produce_different_digests() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let ba = baseline_at(a.path());
        let bb = baseline_at(b.path());
        assert_ne!(
            ba.digest(SECRET),
            bb.digest(SECRET),
            "每台设备的盐不同：两台设备的基线不可比对（也推不出对方存了什么）"
        );
    }

    #[test]
    fn upsert_and_matches_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let mut b = baseline_at(tmp.path());
        assert!(!b.matches("llm_channel_c1", SECRET), "没记过就不匹配");
        b.upsert("llm_channel_c1", SECRET);
        assert!(b.matches("llm_channel_c1", SECRET));
        assert!(!b.matches("llm_channel_c1", "other"));
        assert!(!b.matches("llm_channel_c2", SECRET), "按 account 隔离");

        b.remove("llm_channel_c1");
        assert!(!b.matches("llm_channel_c1", SECRET));
        assert!(b.accounts().is_empty());
    }

    #[test]
    fn save_and_load_preserve_salt_and_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let mut b = baseline_at(tmp.path());
        b.upsert("a", SECRET);
        b.save().unwrap();

        let again = baseline_at(tmp.path());
        assert!(
            again.matches("a", SECRET),
            "盐必须跟着文件走，否则重启后所有条目都不匹配、会把所有 Key 重发一遍"
        );
        assert_eq!(again.digest(SECRET), b.digest(SECRET));
    }

    /// 这是本模块存在的理由：**磁盘上不能有明文**。
    /// 扫描整个 `sync/` 目录的所有文件字节（不只是基线文件），断言连值的片段都不出现。
    #[test]
    fn nothing_on_disk_contains_the_plaintext_or_its_fragments() {
        let tmp = tempfile::tempdir().unwrap();
        let mut b = baseline_at(tmp.path());
        b.upsert("llm_channel_c1", SECRET);
        b.upsert("c1", "hunter2-password");
        b.save().unwrap();

        let sync_dir = DataSourceId::SyncState.path(tmp.path());
        let mut scanned = 0usize;
        let mut stack = vec![sync_dir.clone()];
        while let Some(dir) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let bytes = std::fs::read(&path).unwrap();
                scanned += 1;
                for needle in [
                    SECRET,
                    "sk-very-secret",
                    "very-secret-value",
                    "hunter2",
                    "hunter2-password",
                ] {
                    assert!(
                        !contains(&bytes, needle.as_bytes()),
                        "{} 里出现了明文片段「{needle}」",
                        path.display()
                    );
                }
                // base64 形式也不该出现（有人可能「顺手」存一份编码后的）
                let b64 = B64.encode(needle_bytes(SECRET));
                assert!(
                    !contains(&bytes, b64.as_bytes()),
                    "出现了 base64 形式的明文"
                );
            }
        }
        assert!(scanned >= 1, "至少要扫到基线文件");
    }

    fn needle_bytes(s: &str) -> &[u8] {
        s.as_bytes()
    }

    fn contains(haystack: &[u8], needle: &[u8]) -> bool {
        haystack.windows(needle.len()).any(|w| w == needle)
    }

    #[test]
    fn constant_time_eq_is_correct() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
        assert!(!constant_time_eq(b"", b"a"));
        assert!(constant_time_eq(b"", b""));
    }

    #[test]
    fn corrupt_or_missing_file_degrades_to_empty_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        let b = baseline_at(tmp.path());
        assert!(b.is_empty(), "文件不存在 = 空基线");

        let dir = DataSourceId::SyncState.path(tmp.path());
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(BASELINE_FILE), "{ broken").unwrap();
        let b = baseline_at(tmp.path());
        assert!(b.is_empty(), "损坏按空处理：多传一遍，不丢数据");
    }
}
