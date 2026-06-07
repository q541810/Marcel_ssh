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
