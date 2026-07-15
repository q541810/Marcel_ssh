use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::persist::JsonPersistable;

/// A saved SSH connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub key_path: Option<String>,
    pub group: Option<String>,
    pub last_connected: Option<DateTime<Utc>>,
    /// Whether ProxyJump is enabled. Missing on old data = disabled.
    #[serde(default)]
    pub use_jump: bool,
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_username: Option<String>,
    /// `withTarget` | `Password` | `PrivateKey`
    #[serde(default)]
    pub jump_auth_method: Option<String>,
    #[serde(default)]
    pub jump_key_path: Option<String>,
}

/// Store for managing saved SSH connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStore {
    pub connections: Vec<SavedConnection>,
}

impl ConnectionStore {
    pub fn new() -> Self {
        Self {
            connections: Vec::new(),
        }
    }

    pub fn add(&mut self, connection: SavedConnection) {
        self.connections.push(connection);
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let len_before = self.connections.len();
        self.connections.retain(|c| c.id != id);
        self.connections.len() < len_before
    }

    pub fn get_all(&self) -> &[SavedConnection] {
        &self.connections
    }

    pub fn get_by_id(&self, id: &str) -> Option<&SavedConnection> {
        self.connections.iter().find(|c| c.id == id)
    }

    /// Update `last_connected` timestamp for a connection.
    pub fn mark_connected(&mut self, id: &str) {
        if let Some(c) = self.connections.iter_mut().find(|c| c.id == id) {
            c.last_connected = Some(Utc::now());
        }
    }
}

impl JsonPersistable for ConnectionStore {
    fn default_filename() -> &'static str {
        "connections.json"
    }
}

impl Default for ConnectionStore {
    fn default() -> Self {
        Self::new()
    }
}
