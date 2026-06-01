use std::sync::Arc;

use chrono::Utc;
use russh::client;
use tokio::sync::Mutex as TokioMutex;

use super::known_hosts::{KnownHostEntry, KnownHostsStore, VerifyOutcome};

/// russh client handler enforcing TOFU host-key verification.
pub(crate) struct Client {
    pub(crate) host: String,
    pub(crate) port: u16,
    pub(crate) store: Arc<KnownHostsStore>,
    pub(crate) trust_new: bool,
    /// Filled in by `check_server_key` so `connect()` can return a structured
    /// `HostKeyMismatch` error after the handshake fails.
    pub(crate) verdict: Arc<TokioMutex<Option<VerifyOutcome>>>,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let outcome = self.store.verify(&self.host, self.port, server_public_key).await;
        let (algo, fp) = KnownHostsStore::fingerprint(server_public_key);
        let now = Utc::now().to_rfc3339();
        let entry = KnownHostEntry {
            algorithm: algo,
            fingerprint_sha256: fp,
            first_seen: now.clone(),
            last_seen: now,
        };

        let accept = match &outcome {
            VerifyOutcome::TrustOnFirstUse => {
                if let Err(e) = self.store.record(&self.host, self.port, entry).await {
                    log::warn!("记录 known_host 失败: {}", e);
                }
                true
            }
            VerifyOutcome::Match(_) => true,
            VerifyOutcome::Mismatch { .. } => {
                if self.trust_new {
                    if let Err(e) = self.store.replace(&self.host, self.port, entry).await {
                        log::warn!("替换 known_host 失败: {}", e);
                    }
                    true
                } else {
                    false
                }
            }
        };

        *self.verdict.lock().await = Some(outcome);
        Ok(accept)
    }
}
