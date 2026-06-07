use std::collections::HashMap;

use chrono::Utc;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::config::persist::JsonPersistable;
use crate::error::AppError;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub trusted: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInput {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub trusted: bool,
}

impl McpServerInput {
    pub fn validate(&self) -> Result<(), AppError> {
        if self.name.trim().is_empty() {
            return Err(AppError::Config("名称不能为空".into()));
        }
        if self.url.trim().is_empty() {
            return Err(AppError::Config("URL 不能为空".into()));
        }
        Ok(())
    }
}

impl McpServerConfig {
    pub fn new(input: McpServerInput) -> Result<Self, AppError> {
        input.validate()?;
        let now = Utc::now().to_rfc3339();
        Ok(Self {
            id: Uuid::new_v4().to_string(),
            name: input.name.trim().to_string(),
            url: input.url.trim().to_string(),
            headers: input.headers,
            enabled: input.enabled,
            trusted: input.trusted,
            created_at: now.clone(),
            updated_at: now,
        })
    }

    pub fn apply(&mut self, input: McpServerInput) -> Result<(), AppError> {
        input.validate()?;
        self.name = input.name.trim().to_string();
        self.url = input.url.trim().to_string();
        self.headers = input.headers;
        self.enabled = input.enabled;
        self.trusted = input.trusted;
        self.updated_at = Utc::now().to_rfc3339();
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStore {
    pub servers: Vec<McpServerConfig>,
}

impl McpServerStore {
    pub fn new() -> Self {
        Self { servers: Vec::new() }
    }

    pub fn list(&self) -> &[McpServerConfig] {
        &self.servers
    }

    pub fn get(&self, id: &str) -> Option<&McpServerConfig> {
        self.servers.iter().find(|s| s.id == id)
    }

    pub fn add(&mut self, server: McpServerConfig) {
        self.servers.push(server);
    }

    pub fn update(&mut self, id: &str, input: McpServerInput) -> Result<(), AppError> {
        let Some(server) = self.servers.iter_mut().find(|s| s.id == id) else {
            return Err(AppError::Config(format!("MCP server not found: {}", id)));
        };
        server.apply(input)
    }

    pub fn toggle(&mut self, id: &str) -> Result<(), AppError> {
        let Some(server) = self.servers.iter_mut().find(|s| s.id == id) else {
            return Err(AppError::Config(format!("MCP server not found: {}", id)));
        };
        server.enabled = !server.enabled;
        server.updated_at = Utc::now().to_rfc3339();
        Ok(())
    }

    pub fn delete(&mut self, id: &str) -> Result<(), AppError> {
        let before = self.servers.len();
        self.servers.retain(|s| s.id != id);
        if self.servers.len() == before {
            return Err(AppError::Config(format!("MCP server not found: {}", id)));
        }
        Ok(())
    }
}

impl JsonPersistable for McpServerStore {
    fn default_filename() -> &'static str {
        "mcp_servers.json"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_roundtrips_json() {
        let server = McpServerConfig::new(McpServerInput {
            name: "modelscope".into(),
            url: "https://mcp.api-inference.modelscope.net/abc/mcp".into(),
            headers: Default::default(),
            enabled: true,
            trusted: false,
        }).unwrap();
        let store = McpServerStore { servers: vec![server] };
        let json = serde_json::to_string(&store).unwrap();
        let parsed: McpServerStore = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.servers.len(), 1);
        assert_eq!(parsed.servers[0].name, "modelscope");
    }

    #[test]
    fn url_required() {
        let err = McpServerConfig::new(McpServerInput {
            name: "x".into(),
            url: String::new(),
            headers: Default::default(),
            enabled: true,
            trusted: false,
        }).unwrap_err();
        assert!(err.to_string().contains("URL"));
    }
}
