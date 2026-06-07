use std::collections::{HashMap, HashSet};

use serde::Serialize;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::mcp::client::{McpClient, McpClientLike};
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
    client: Box<dyn McpClientLike>,
    initialized: RwLock<HashSet<String>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            client: Box::new(McpClient::new()),
            initialized: RwLock::new(HashSet::new()),
        }
    }

    #[cfg(test)]
    pub(crate) fn with_client(client: Box<dyn McpClientLike>) -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            client,
            initialized: RwLock::new(HashSet::new()),
        }
    }

    pub async fn refresh_tools(&self, server: &McpServerConfig) -> Result<Vec<McpToolInfo>, AppError> {
        if !self.initialized.read().await.contains(&server.id) {
            self.client.initialize(&server.url, &server.headers).await?;
            self.initialized.write().await.insert(server.id.clone());
        }
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
    use crate::mcp::client::SpyClient;

    fn make_server(id: &str) -> McpServerConfig {
        McpServerConfig {
            id: id.into(),
            name: format!("server-{}", id),
            url: format!("https://{}.example.com/mcp", id),
            headers: HashMap::new(),
            enabled: true,
            trusted: false,
            created_at: "2025-01-01T00:00:00Z".into(),
            updated_at: "2025-01-01T00:00:00Z".into(),
        }
    }

    fn make_tool(name: &str) -> McpToolInfo {
        McpToolInfo { name: name.into(), description: format!("Tool {}", name), input_schema: serde_json::json!({}) }
    }

    // ── refresh_tools ──────────────────────────────────────────────

    #[tokio::test]
    async fn refresh_tools_calls_initialize_and_returns_tools() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.extend(vec![make_tool("a"), make_tool("b")]);
        let mgr = McpManager::with_client(Box::new(spy.clone()));
        let server = make_server("s1");

        let tools = mgr.refresh_tools(&server).await.unwrap();

        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "a");
        assert_eq!(tools[1].name, "b");
        assert_eq!(*spy.init_calls.lock().await, vec!["https://s1.example.com/mcp"]);
        assert_eq!(*spy.list_calls.lock().await, vec!["https://s1.example.com/mcp"]);
        assert!(mgr.initialized.read().await.contains("s1"));
    }

    #[tokio::test]
    async fn refresh_tools_skips_initialize_when_already_set() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("x"));
        let mgr = McpManager::with_client(Box::new(spy.clone()));
        let server = make_server("s1");

        mgr.initialized.write().await.insert("s1".into());
        mgr.refresh_tools(&server).await.unwrap();

        assert!(spy.init_calls.lock().await.is_empty(), "initialize should be skipped");
        assert_eq!(*spy.list_calls.lock().await, vec!["https://s1.example.com/mcp"]);
    }

    #[tokio::test]
    async fn refresh_tools_updates_cache_on_success() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("t1"));
        let mgr = McpManager::with_client(Box::new(spy));
        let server = make_server("s1");

        mgr.refresh_tools(&server).await.unwrap();

        let (tools, error) = mgr.cache.read().await.get("s1").cloned().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "t1");
        assert!(error.is_none());
    }

    #[tokio::test]
    async fn refresh_tools_propagates_initialize_error_and_does_not_mark_initialized() {
        let spy = SpyClient::new();
        *spy.init_error.lock().await = Some("init failed".into());
        let mgr = McpManager::with_client(Box::new(spy));
        let server = make_server("s1");

        let result = mgr.refresh_tools(&server).await;
        assert!(result.is_err());
        assert!(!mgr.initialized.read().await.contains("s1"));
    }

    #[tokio::test]
    async fn refresh_tools_caches_error_on_list_tools_failure() {
        let spy = SpyClient::new();
        *spy.list_error.lock().await = Some("list failed".into());
        let mgr = McpManager::with_client(Box::new(spy));
        let server = make_server("s1");

        let result = mgr.refresh_tools(&server).await;
        assert!(result.is_err());

        let (tools, error) = mgr.cache.read().await.get("s1").cloned().unwrap();
        assert!(tools.is_empty());
        assert_eq!(error.as_deref(), Some("Config error: list failed"));
        assert!(mgr.initialized.read().await.contains("s1"), "initialize succeeded so initialized should be set");
    }

    #[tokio::test]
    async fn refresh_tools_concurrent_different_servers_no_interference() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("a"));
        let spy = spy; // no clone needed — share across concurrent tasks
        let mgr = std::sync::Arc::new(McpManager::with_client(Box::new(spy.clone())));
        let s1 = make_server("s1");
        let s2 = make_server("s2");

        let mgr1 = mgr.clone();
        let mgr2 = mgr.clone();
        let (r1, r2) = tokio::join!(mgr1.refresh_tools(&s1), mgr2.refresh_tools(&s2));
        assert!(r1.is_ok());
        assert!(r2.is_ok());

        let init_urls: Vec<_> = spy.init_calls.lock().await.iter().cloned().collect();
        let list_urls: Vec<_> = spy.list_calls.lock().await.iter().cloned().collect();
        assert_eq!(init_urls.len(), 2, "both servers should call initialize");
        assert_eq!(list_urls.len(), 2, "both servers should call list_tools");
        assert!(init_urls.contains(&"https://s1.example.com/mcp".into()));
        assert!(init_urls.contains(&"https://s2.example.com/mcp".into()));
    }

    // ── call_tool ───────────────────────────────────────────────────

    #[tokio::test]
    async fn call_tool_skips_initialize_when_already_set() {
        let spy = SpyClient::new();
        let mgr = McpManager::with_client(Box::new(spy.clone()));
        let server = make_server("s1");

        mgr.initialized.write().await.insert("s1".into());
        mgr.call_tool(&server, "do_thing", serde_json::json!({})).await.unwrap();

        assert!(spy.init_calls.lock().await.is_empty(), "initialize must be skipped");
    }

    #[tokio::test]
    async fn call_tool_calls_initialize_when_not_set() {
        let spy = SpyClient::new();
        let mgr = McpManager::with_client(Box::new(spy.clone()));
        let server = make_server("s1");

        mgr.call_tool(&server, "do_thing", serde_json::json!({})).await.unwrap();

        assert_eq!(spy.init_calls.lock().await.len(), 1);
        assert!(mgr.initialized.read().await.contains("s1"));
    }

    #[tokio::test]
    async fn call_tool_propagates_initialize_error() {
        let spy = SpyClient::new();
        *spy.init_error.lock().await = Some("init fail".into());
        let mgr = McpManager::with_client(Box::new(spy));
        let server = make_server("s1");

        let result = mgr.call_tool(&server, "do_thing", serde_json::json!({})).await;
        assert!(result.is_err());
        assert!(!mgr.initialized.read().await.contains("s1"));
    }

    // ── clear_cache ────────────────────────────────────────────────

    #[tokio::test]
    async fn clear_cache_allows_reinitialize_on_next_refresh() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("x"));
        let mgr = McpManager::with_client(Box::new(spy.clone()));
        let server = make_server("s1");

        mgr.refresh_tools(&server).await.unwrap();
        assert_eq!(spy.init_calls.lock().await.len(), 1);

        mgr.clear_cache("s1").await;
        mgr.refresh_tools(&server).await.unwrap();

        assert_eq!(spy.init_calls.lock().await.len(), 2, "initialize must be called again after clear");
    }

    // ── statuses (existing tests) ───────────────────────────────────

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
        let tool = make_tool("read");
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

    // ── JoinSet 并发模式测试 ──────────────────────────────────────

    #[tokio::test]
    async fn joinset_runs_tasks_in_parallel() {
        let start = std::time::Instant::now();
        let mut set = tokio::task::JoinSet::new();
        for i in 0..3 {
            set.spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                i
            });
        }
        let mut results = Vec::new();
        while let Some(r) = set.join_next().await {
            results.push(r.unwrap());
        }
        let elapsed = start.elapsed();
        results.sort();
        assert_eq!(results, vec![0, 1, 2]);
        assert!(elapsed < std::time::Duration::from_millis(200), "should run in parallel (<200ms), took {:?}", elapsed);
    }

    #[tokio::test]
    async fn joinset_handles_task_panic_without_crashing() {
        let mut set = tokio::task::JoinSet::new();
        set.spawn(async { panic!("boom") });
        set.spawn(async { 42_u32 });
        let mut panics = 0;
        let mut values = Vec::new();
        while let Some(r) = set.join_next().await {
            match r {
                Ok(v) => values.push(v),
                Err(e) => {
                    assert!(e.is_panic());
                    panics += 1;
                }
            }
        }
        assert_eq!(panics, 1);
        assert_eq!(values, vec![42]);
    }

    #[tokio::test]
    async fn joinset_empty_returns_immediately() {
        let mut set: tokio::task::JoinSet<()> = tokio::task::JoinSet::new();
        assert!(set.join_next().await.is_none());
    }

    #[tokio::test]
    async fn joinset_collects_results_from_all_tasks() {
        let mut set = tokio::task::JoinSet::new();
        for i in 0..5 {
            set.spawn(async move { i * 2 });
        }
        let mut results = Vec::new();
        while let Some(r) = set.join_next().await {
            results.push(r.unwrap());
        }
        results.sort();
        assert_eq!(results, vec![0, 2, 4, 6, 8]);
    }
}
