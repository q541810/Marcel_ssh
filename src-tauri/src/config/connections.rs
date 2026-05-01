use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::error::AppError;

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

    /// Serialize the store to a JSON file at the given path.
    /// Creates parent directories as needed.
    pub fn save_to_path(&self, path: &Path) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Config(format!("创建配置目录失败: {}", e))
            })?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::Config(format!("序列化连接配置失败: {}", e)))?;
        std::fs::write(path, json)
            .map_err(|e| AppError::Config(format!("写入连接配置文件失败: {}", e)))?;
        Ok(())
    }

    /// Load the store from a JSON file. Returns an empty store if the file does not exist.
    pub fn load_from_path(path: &Path) -> Result<Self, AppError> {
        if !path.exists() {
            return Ok(Self::new());
        }
        let content = std::fs::read_to_string(path)
            .map_err(|e| AppError::Config(format!("读取连接配置文件失败: {}", e)))?;
        if content.trim().is_empty() {
            return Ok(Self::new());
        }
        serde_json::from_str(&content)
            .map_err(|e| AppError::Config(format!("解析连接配置失败: {}", e)))
    }

    /// Convenience: build the default connections.json path inside the app config dir.
    pub fn default_file(config_dir: &Path) -> PathBuf {
        config_dir.join("connections.json")
    }
}

impl Default for ConnectionStore {
    fn default() -> Self {
        Self::new()
    }
}
