use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::mcp::client::McpClient;
use crate::mcp::protocol::McpToolInfo;
use crate::mcp::store::McpServerConfig;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRuntimeStatus {
    pub server_id: String,
    pub tools: Vec<McpToolInfo>,
    pub error: Option<String>,
}

pub struct McpManager {
    cache: RwLock<HashMap<String, (Vec<McpToolInfo>, Option<String>)>>,
    client: McpClient,
    initialized: RwLock<HashSet<String>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            client: McpClient::new(),
            initialized: RwLock::new(HashSet::new()),
        }
    }

    pub async fn refresh_tools(&self, server: &McpServerConfig) -> Result<Vec<McpToolInfo>, AppError> {
        self.client.initialize(&server.url, &server.headers).await?;
        self.initialized.write().await.insert(server.id.clone());
        match self.client.list_tools(&server.url, &server.headers).await {
            Ok(tools) => {
                self.cache.write().await.insert(server.id.clone(), (tools.clone(), None));
                Ok(tools)
            }
            Err(err) => {
                let msg = err.to_string();
                self.cache.write().await.insert(server.id.clone(), (Vec::new(), Some(msg)));
                Err(err)
            }
        }
    }

    pub async fn call_tool(
        &self,
        server: &McpServerConfig,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<String, AppError> {
        if !self.initialized.read().await.contains(&server.id) {
            self.client.initialize(&server.url, &server.headers).await?;
            self.initialized.write().await.insert(server.id.clone());
        }
        self.client.call_tool(&server.url, &server.headers, tool_name, arguments).await
    }

    pub async fn clear_cache(&self, server_id: &str) {
        self.cache.write().await.remove(server_id);
        self.initialized.write().await.remove(server_id);
    }

    pub async fn statuses(&self, servers: &[McpServerConfig]) -> Vec<McpServerRuntimeStatus> {
        let cache = self.cache.read().await;
        servers
            .iter()
            .map(|server| {
                let (tools, error) = cache.get(&server.id).cloned().unwrap_or_default();
                McpServerRuntimeStatus { server_id: server.id.clone(), tools, error }
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_server(id: &str) -> McpServerConfig {
        McpServerConfig {
            id: id.into(),
            name: format!("server-{}", id),
            url: "https://example.com".into(),
            headers: HashMap::new(),
            enabled: true,
            trusted: false,
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-01T00:00:00Z".into(),
        }
    }

    #[tokio::test]
    async fn statuses_returns_empty_for_unknown_server() {
        let mgr = McpManager::new();
        let servers = vec![make_server("s1")];
        let statuses = mgr.statuses(&servers).await;
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].server_id, "s1");
        assert!(statuses[0].tools.is_empty());
        assert!(statuses[0].error.is_none());
    }

    #[tokio::test]
    async fn statuses_returns_cached_data() {
        let mgr = McpManager::new();
        let tool = McpToolInfo {
            name: "read".into(),
            description: "Read".into(),
            input_schema: serde_json::json!({}),
        };
        mgr.cache.write().await.insert("s1".into(), (vec![tool], None));
        let servers = vec![make_server("s1")];
        let statuses = mgr.statuses(&servers).await;
        assert_eq!(statuses[0].tools.len(), 1);
        assert_eq!(statuses[0].tools[0].name, "read");
    }

    #[tokio::test]
    async fn statuses_returns_error_string() {
        let mgr = McpManager::new();
        mgr.cache.write().await.insert("s1".into(), (vec![], Some("fail".into())));
        let servers = vec![make_server("s1")];
        let statuses = mgr.statuses(&servers).await;
        assert_eq!(statuses[0].error.as_deref(), Some("fail"));
    }

    #[tokio::test]
    async fn clear_cache_removes_entry_and_initialized() {
        let mgr = McpManager::new();
        mgr.cache.write().await.insert("s1".into(), (vec![], None));
        mgr.initialized.write().await.insert("s1".into());
        mgr.clear_cache("s1").await;
        assert!(mgr.cache.read().await.get("s1").is_none());
        assert!(!mgr.initialized.read().await.contains("s1"));
    }

    #[tokio::test]
    async fn clear_cache_nonexistent_does_not_panic() {
        let mgr = McpManager::new();
        mgr.clear_cache("does-not-exist").await;
    }
}
