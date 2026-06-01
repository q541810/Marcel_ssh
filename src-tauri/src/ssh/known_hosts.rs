//! TOFU (Trust-On-First-Use) host key store.
//!
//! Persists SHA-256 fingerprints of seen SSH server host keys to a JSON file
//! under the application's config directory. Subsequent connections compare
//! the presented key against the stored fingerprint and reject mismatches
//! unless the user explicitly elects to trust the new key.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use chrono::Utc;
use russh::keys::ssh_key::{HashAlg, PublicKey};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KnownHostEntry {
    pub algorithm: String,
    pub fingerprint_sha256: String,
    pub first_seen: String,
    pub last_seen: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KnownHostsFile {
    version: u32,
    entries: HashMap<String, KnownHostEntry>,
}

impl Default for KnownHostsFile {
    fn default() -> Self {
        Self { version: 1, entries: HashMap::new() }
    }
}

#[derive(Debug, Clone)]
pub enum VerifyOutcome {
    /// First time seeing this host. Caller should record on success.
    TrustOnFirstUse,
    /// Presented fingerprint matches the stored one.
    Match(KnownHostEntry),
    /// Presented fingerprint differs from the stored one. MUST reject
    /// unless the user explicitly trusts the new key.
    Mismatch {
        stored: KnownHostEntry,
        presented: KnownHostEntry,
    },
}

pub struct KnownHostsStore {
    path: PathBuf,
    inner: RwLock<KnownHostsFile>,
}

impl KnownHostsStore {
    /// Load store from disk. Missing file is treated as empty. Corrupt JSON
    /// is renamed aside (`.corrupt.<ts>.bak`) so that the user is forced to
    /// re-confirm host identities rather than silently re-TOFU on next start.
    pub async fn load(path: PathBuf) -> Result<Arc<Self>, AppError> {
        let inner = if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) if content.trim().is_empty() => KnownHostsFile::default(),
                Ok(content) => match serde_json::from_str::<KnownHostsFile>(&content) {
                    Ok(file) => file,
                    Err(e) => {
                        log::error!(
                            "known_hosts.json 解析失败: {}; 隔离原文件并以空 store 启动",
                            e
                        );
                        let ts = chrono::Utc::now().timestamp();
                        // Append a `.corrupt.<ts>.bak` suffix WITHOUT replacing
                        // the existing extension. `Path::with_extension` would
                        // overwrite e.g. `.json` and silently drop the original
                        // filename, so we build the new filename by hand.
                        let mut new_name = path
                            .file_name()
                            .map(|n| n.to_os_string())
                            .unwrap_or_else(|| std::ffi::OsString::from("known_hosts"));
                        new_name.push(format!(".corrupt.{}.bak", ts));
                        let bak = path.with_file_name(new_name);
                        let _ = fs::rename(&path, &bak);
                        KnownHostsFile::default()
                    }
                },
                Err(e) => {
                    return Err(AppError::Config(format!("读取 known_hosts 失败: {}", e)));
                }
            }
        } else {
            KnownHostsFile::default()
        };

        Ok(Arc::new(Self {
            path,
            inner: RwLock::new(inner),
        }))
    }

    /// Compute (algorithm, fingerprint) of a server public key.
    /// Fingerprint is SHA-256 in OpenSSH form, e.g. "SHA256:abcd...".
    pub fn fingerprint(key: &PublicKey) -> (String, String) {
        let algo = key.algorithm().as_str().to_string();
        let fp = key.fingerprint(HashAlg::Sha256).to_string();
        (algo, fp)
    }

    fn key_of(host: &str, port: u16) -> String {
        format!("{}:{}", host.to_lowercase(), port)
    }

    /// Verify a presented public key against the store. Does not mutate.
    pub async fn verify(&self, host: &str, port: u16, key: &PublicKey) -> VerifyOutcome {
        let (algo, fp) = Self::fingerprint(key);
        let now = Utc::now().to_rfc3339();
        let presented = KnownHostEntry {
            algorithm: algo,
            fingerprint_sha256: fp,
            first_seen: now.clone(),
            last_seen: now,
        };
        let id = Self::key_of(host, port);
        let guard = self.inner.read().await;
        match guard.entries.get(&id) {
            None => VerifyOutcome::TrustOnFirstUse,
            Some(stored) => {
                if stored.fingerprint_sha256 == presented.fingerprint_sha256 {
                    VerifyOutcome::Match(stored.clone())
                } else {
                    VerifyOutcome::Mismatch {
                        stored: stored.clone(),
                        presented,
                    }
                }
            }
        }
    }

    /// Record a new entry (first-time TOFU). If an entry already exists, only
    /// `last_seen` is refreshed; this method must NOT silently overwrite a
    /// differing fingerprint �?call [`replace`] for that.
    pub async fn record(
        &self,
        host: &str,
        port: u16,
        entry: KnownHostEntry,
    ) -> Result<(), AppError> {
        let id = Self::key_of(host, port);
        let mut guard = self.inner.write().await;
        match guard.entries.get_mut(&id) {
            Some(existing) if existing.fingerprint_sha256 == entry.fingerprint_sha256 => {
                existing.last_seen = entry.last_seen;
            }
            Some(_) => {
                // Differing fingerprint: refuse silent overwrite.
                return Err(AppError::Other(format!(
                    "refusing to overwrite known host entry for {} (use replace())",
                    id
                )));
            }
            None => {
                guard.entries.insert(id, entry);
            }
        }
        Self::persist_locked(&self.path, &*guard)
    }

    /// Replace an existing entry with a new fingerprint after explicit user
    /// confirmation.
    pub async fn replace(
        &self,
        host: &str,
        port: u16,
        entry: KnownHostEntry,
    ) -> Result<(), AppError> {
        let id = Self::key_of(host, port);
        let mut guard = self.inner.write().await;
        guard.entries.insert(id, entry);
        Self::persist_locked(&self.path, &*guard)
    }

    pub async fn forget(&self, host: &str, port: u16) -> Result<(), AppError> {
        let id = Self::key_of(host, port);
        let mut guard = self.inner.write().await;
        guard.entries.remove(&id);
        Self::persist_locked(&self.path, &*guard)
    }

    pub async fn list(&self) -> Vec<(String, KnownHostEntry)> {
        self.inner
            .read()
            .await
            .entries
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Atomic write: tmp + fsync + rename.
    fn persist_locked(path: &Path, file: &KnownHostsFile) -> Result<(), AppError> {
        let json = serde_json::to_string_pretty(file)
            .map_err(|e| AppError::Config(format!("serialize known_hosts: {}", e)))?;
        crate::config::persist::atomic_write(path, &json)
            .map_err(|e| AppError::Config(format!("write known_hosts: {}", e)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::ssh_key::PublicKey;
    use std::str::FromStr;
    use tempfile::TempDir;

    // Two distinct hard-coded ed25519 public keys (OpenSSH format) used to
    // exercise TOFU logic without needing an RNG that satisfies the
    // ssh-key/signature CryptoRng bound (which differs across rand versions).
    const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBHWGOIRJ4XqkiQGFm1B/LFRfWOQbW6q0RQGJ8U/+RsR a@example";
    const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK4qVQ4uH2GgYHN5pGM5OoH7e3Ckj1iaC0bKqnKvX9XK b@example";

    fn key_a() -> PublicKey {
        PublicKey::from_str(KEY_A).expect("parse KEY_A")
    }
    fn key_b() -> PublicKey {
        PublicKey::from_str(KEY_B).expect("parse KEY_B")
    }

    #[tokio::test]
    async fn fingerprint_is_sha256_format() {
        let k = key_a();
        let (_algo, fp) = KnownHostsStore::fingerprint(&k);
        assert!(fp.starts_with("SHA256:"), "got: {}", fp);
    }

    #[tokio::test]
    async fn verify_first_time_then_match() {
        let dir = TempDir::new().unwrap();
        let store = KnownHostsStore::load(dir.path().join("known.json"))
            .await
            .unwrap();
        let k = key_a();
        let outcome = store.verify("example.com", 22, &k).await;
        assert!(matches!(outcome, VerifyOutcome::TrustOnFirstUse));
        let (algo, fp) = KnownHostsStore::fingerprint(&k);
        let now = Utc::now().to_rfc3339();
        store
            .record(
                "example.com",
                22,
                KnownHostEntry {
                    algorithm: algo,
                    fingerprint_sha256: fp,
                    first_seen: now.clone(),
                    last_seen: now,
                },
            )
            .await
            .unwrap();
        let outcome = store.verify("example.com", 22, &k).await;
        assert!(matches!(outcome, VerifyOutcome::Match(_)));
    }

    #[tokio::test]
    async fn mismatch_is_detected() {
        let dir = TempDir::new().unwrap();
        let store = KnownHostsStore::load(dir.path().join("k.json"))
            .await
            .unwrap();
        let k1 = key_a();
        let k2 = key_b();
        let (algo, fp) = KnownHostsStore::fingerprint(&k1);
        let now = Utc::now().to_rfc3339();
        store
            .record(
                "h",
                22,
                KnownHostEntry {
                    algorithm: algo,
                    fingerprint_sha256: fp,
                    first_seen: now.clone(),
                    last_seen: now,
                },
            )
            .await
            .unwrap();
        let outcome = store.verify("h", 22, &k2).await;
        assert!(matches!(outcome, VerifyOutcome::Mismatch { .. }));
    }

    #[tokio::test]
    async fn host_key_normalized_lowercase_and_port_separated() {
        let dir = TempDir::new().unwrap();
        let store = KnownHostsStore::load(dir.path().join("k.json"))
            .await
            .unwrap();
        let k = key_a();
        let (algo, fp) = KnownHostsStore::fingerprint(&k);
        let now = Utc::now().to_rfc3339();
        store
            .record(
                "Example.COM",
                22,
                KnownHostEntry {
                    algorithm: algo,
                    fingerprint_sha256: fp,
                    first_seen: now.clone(),
                    last_seen: now,
                },
            )
            .await
            .unwrap();
        assert!(matches!(
            store.verify("example.com", 22, &k).await,
            VerifyOutcome::Match(_)
        ));
        assert!(matches!(
            store.verify("example.com", 2222, &k).await,
            VerifyOutcome::TrustOnFirstUse
        ));
    }

    #[tokio::test]
    async fn persist_and_reload() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("k.json");
        let store = KnownHostsStore::load(path.clone()).await.unwrap();
        let k = key_a();
        let (algo, fp) = KnownHostsStore::fingerprint(&k);
        let now = Utc::now().to_rfc3339();
        store
            .record(
                "h",
                22,
                KnownHostEntry {
                    algorithm: algo,
                    fingerprint_sha256: fp,
                    first_seen: now.clone(),
                    last_seen: now,
                },
            )
            .await
            .unwrap();
        drop(store);
        let store2 = KnownHostsStore::load(path).await.unwrap();
        assert!(matches!(
            store2.verify("h", 22, &k).await,
            VerifyOutcome::Match(_)
        ));
    }
}

