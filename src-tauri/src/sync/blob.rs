//! 按内容寻址的大块内容（图片 / 私钥正文）：`devices/<id>/blob/<名字>.msync`。
//!
//! 为什么不把这些东西直接塞进段里：一张图 / 一把私钥是几 MB，塞进段会让「改一个标题」
//! 也要重传整段；而且同一张图在多条消息里复用、同一把私钥也能被多条连接共用，
//! 按内容寻址天然去重。
//!
//! **名字是 HMAC-SHA256(DK, 明文) 的十六进制**，不是裸 SHA-256：
//! 裸 hash 能被「我猜你传过这张图」比对出来（拿候选文件的 hash 去比对云端文件名），
//! HMAC 用的是他人不知道的 DK，没有 DK 就算不出名字。

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;

use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use super::backends::Backend;
use super::core::crypto::DataKey;
use super::core::format;
use crate::config::persist::atomic_write;
use crate::data::DataSourceId;
use crate::error::AppError;

type HmacSha256 = Hmac<Sha256>;

pub fn blob_dir(device: &str) -> String {
    format!("{}/blob", format::device_dir(device))
}

pub fn blob_path(device: &str, name: &str) -> String {
    format!("{}/{}.{}", blob_dir(device), name, format::FILE_EXT)
}

/// 名字是否合法：64 位小写十六进制。
pub fn is_valid_blob_name(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// `HMAC-SHA256(DK, 明文)` 的十六进制（小写）。**名字就是它**。
pub fn blob_name(dk: &DataKey, plaintext: &[u8]) -> String {
    let mut mac = HmacSha256::new_from_slice(dk.secret_bytes()).expect("HMAC 接受任意长度密钥");
    mac.update(plaintext);
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct UploadedIndex {
    names: BTreeSet<String>,
}

/// 本机已上传过的 blob 名字（`sync/blob_uploaded.json`，属 `DataSourceId::SyncState`）。
pub struct BlobLedger {
    path: PathBuf,
    index: UploadedIndex,
}

impl BlobLedger {
    fn path(config_dir: &std::path::Path) -> PathBuf {
        DataSourceId::SyncState
            .path(config_dir)
            .join("blob_uploaded.json")
    }

    pub fn load(config_dir: &std::path::Path) -> Self {
        let path = Self::path(config_dir);
        let index = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str::<UploadedIndex>(&t).ok())
            .unwrap_or_default();
        Self { path, index }
    }

    pub fn contains(&self, name: &str) -> bool {
        self.index.names.contains(name)
    }

    pub fn mark(&mut self, name: &str) -> Result<(), AppError> {
        if self.index.names.insert(name.to_string()) {
            self.save()?;
        }
        Ok(())
    }

    fn save(&self) -> Result<(), AppError> {
        let text = serde_json::to_string_pretty(&self.index)
            .map_err(|e| AppError::Config(format!("序列化 blob 登记失败：{e}")))?;
        atomic_write(&self.path, &text)
            .map_err(|e| AppError::Config(format!("写入 blob 登记失败：{e}")))
    }
}

/// 上传一块内容（已存在就跳过）。返回 `(blob 名字, 是否真的传了)`。
pub async fn upload_blob(
    backend: &Arc<dyn Backend>,
    ledger: &mut BlobLedger,
    dk: &DataKey,
    device: &str,
    plaintext: &[u8],
) -> Result<(String, bool), AppError> {
    let name = blob_name(dk, plaintext);
    if ledger.contains(&name) {
        return Ok((name, false));
    }
    let bytes = format::seal_blob(dk, device, &name, plaintext).map_err(AppError::from)?;
    backend
        .put(&blob_path(device, &name), &bytes)
        .await
        .map_err(AppError::from)?;
    ledger.mark(&name)?;
    Ok((name, true))
}

/// 从**某个对端设备**的 blob 目录拉一块内容并解密。
///
/// `Ok(None)` = 对方那边已经没有这个文件了——调用方要给用户一句人话
/// （「图片在另一台设备上，暂时取不到」），不要抛底层错误。
pub async fn download_blob(
    backend: &Arc<dyn Backend>,
    dk: &DataKey,
    device: &str,
    name: &str,
) -> Result<Option<Vec<u8>>, AppError> {
    if !is_valid_blob_name(name) {
        return Err(AppError::Other("同步来的图片引用不合法。".into()));
    }
    let Some(bytes) = backend
        .get(&blob_path(device, name))
        .await
        .map_err(AppError::from)?
    else {
        return Ok(None);
    };
    let plain = format::open_blob(dk, device, name, &bytes).map_err(AppError::from)?;
    Ok(Some(plain))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_name_is_hmac_not_plain_hash() {
        let dk = DataKey::generate().unwrap();
        let name = blob_name(&dk, b"hello world");
        assert_eq!(name.len(), 64);
        assert!(is_valid_blob_name(&name), "{name}");
        assert_eq!(name, blob_name(&dk, b"hello world"));
        let other = DataKey::generate().unwrap();
        assert_ne!(name, blob_name(&other, b"hello world"));
        use sha2::Digest;
        let sha: String = Sha256::digest(b"hello world")
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        assert_ne!(name, sha, "必须是 HMAC，不能是裸 hash");
    }

    #[test]
    fn blob_names_are_validated_before_becoming_paths() {
        for bad in [
            "",
            "../x",
            "abc",
            &"A".repeat(64),
            &"g".repeat(64),
            &"a".repeat(63),
            &"a".repeat(65),
        ] {
            assert!(!is_valid_blob_name(bad), "{bad:?}");
        }
        assert!(is_valid_blob_name(&"a".repeat(64)));
        assert!(is_valid_blob_name(&"0123456789abcdef".repeat(4)));
    }

    #[test]
    fn blob_path_is_under_the_own_device_dir() {
        assert_eq!(blob_dir("dev1"), "devices/dev1/blob");
        assert_eq!(
            blob_path("dev1", &"a".repeat(64)),
            format!("devices/dev1/blob/{}.msync", "a".repeat(64))
        );
    }

    #[test]
    fn ledger_round_trips_and_dedupes() {
        let tmp = tempfile::tempdir().unwrap();
        let mut ledger = BlobLedger::load(tmp.path());
        let name = "a".repeat(64);
        assert!(!ledger.contains(&name));
        ledger.mark(&name).unwrap();
        assert!(ledger.contains(&name));
        let again = BlobLedger::load(tmp.path());
        assert!(again.contains(&name), "登记要落盘");
    }
}
