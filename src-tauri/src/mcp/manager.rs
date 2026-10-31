use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::future::{BoxFuture, FutureExt, Shared};
use parking_lot::Mutex;
use serde::Serialize;
use tokio::sync::RwLock;

use crate::error::AppError;
use crate::mcp::client::{McpClient, McpClientLike};
use crate::mcp::protocol::McpToolInfo;
use crate::mcp::store::{McpServerConfig, McpServerStore};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerRuntimeStatus {
    pub server_id: String,
    pub tools: Vec<McpToolInfo>,
    pub error: Option<String>,
    /// Whether this server has been discovered/refreshed at least once
    /// (i.e. an entry exists in the tools cache). Distinguishes "never probed"
    /// / "cache cleared" from "probed and found zero tools".
    pub discovered: bool,
}

/// 一次进行中的工具发现。多个等待者共享同一个结果；`epoch` 记下它是针对哪一版
/// 配置发起的（见 [`McpManager::clear_cache`]）。
type SharedRefresh = Shared<BoxFuture<'static, Result<Vec<McpToolInfo>, String>>>;

struct InFlight {
    epoch: u64,
    fut: SharedRefresh,
}

/// 任务启动时某个 MCP 服务器的工具拿到了什么。
#[derive(Debug, Clone)]
pub enum StartupTools {
    /// 用的是上次发现的缓存（后台已在刷新，不等）。
    Cached(Vec<McpToolInfo>),
    /// 从没发现过，等到了这次刷新的结果。
    Fresh(Vec<McpToolInfo>),
    /// 本次拿不到：上次发现失败，或首次发现在等待时限内没回。刷新仍在后台继续，
    /// 结果会写进缓存供下一个任务使用。
    Unavailable(String),
}

impl StartupTools {
    pub fn into_tools(self) -> Vec<McpToolInfo> {
        match self {
            Self::Cached(tools) | Self::Fresh(tools) => tools,
            Self::Unavailable(_) => Vec::new(),
        }
    }
}

pub struct McpManager {
    cache: RwLock<HashMap<String, (Vec<McpToolInfo>, Option<String>)>>,
    client: Box<dyn McpClientLike>,
    initialized: RwLock<HashSet<String>>,
    /// 每个服务器的配置版本号，`clear_cache`（改地址 / 请求头 / 删除）时 +1。
    /// 进行中的发现带着发起时的版本号，回来时版本变了就丢弃结果——否则针对旧地址
    /// 的慢请求会把错误或旧工具写进新配置的缓存。
    epochs: Mutex<HashMap<String, u64>>,
    inflight: Mutex<HashMap<String, InFlight>>,
}

impl McpManager {
    pub fn new() -> Self {
        Self::with_boxed_client(Box::new(McpClient::new()))
    }

    #[cfg(test)]
    pub(crate) fn with_client(client: Box<dyn McpClientLike>) -> Self {
        Self::with_boxed_client(client)
    }

    fn with_boxed_client(client: Box<dyn McpClientLike>) -> Self {
        Self {
            cache: RwLock::new(HashMap::new()),
            client,
            initialized: RwLock::new(HashSet::new()),
            epochs: Mutex::new(HashMap::new()),
            inflight: Mutex::new(HashMap::new()),
        }
    }

    fn epoch_of(&self, server_id: &str) -> u64 {
        self.epochs.lock().get(server_id).copied().unwrap_or(0)
    }

    /// 向服务器发现工具并写缓存。成功与失败（含握手失败）都会留下缓存条目，
    /// 失败条目带错误文案——设置页据此显示原因，任务启动据此知道"这台刚失败过，
    /// 别等它"。配置在途中被改了（版本号变化）则结果作废，不写缓存。
    pub async fn refresh_tools(
        &self,
        server: &McpServerConfig,
    ) -> Result<Vec<McpToolInfo>, AppError> {
        let epoch = self.epoch_of(&server.id);
        let result = self.discover(server, epoch).await;
        let entry = match &result {
            Ok(tools) => (tools.clone(), None),
            Err(err) => (Vec::new(), Some(err.to_string())),
        };
        // 版本检查与写入同在缓存写锁内：`clear_cache` 先递增版本再删条目，
        // 两种交错下都不会留下旧配置的结果。
        let mut cache = self.cache.write().await;
        if self.epoch_of(&server.id) == epoch {
            cache.insert(server.id.clone(), entry);
        }
        result
    }

    async fn discover(
        &self,
        server: &McpServerConfig,
        epoch: u64,
    ) -> Result<Vec<McpToolInfo>, AppError> {
        // 鉴权头在密钥链里（三期起不再明文躺在配置里）：一次发现只读一次。
        let headers = McpServerStore::effective_headers(server);
        if !self.initialized.read().await.contains(&server.id) {
            self.client.initialize(&server.url, &headers).await?;
            let mut initialized = self.initialized.write().await;
            if self.epoch_of(&server.id) == epoch {
                initialized.insert(server.id.clone());
            }
        }
        self.client.list_tools(&server.url, &headers).await
    }

    /// 发起（或加入）一次后台发现。同一服务器、同一版本配置同时只跑一次：任务
    /// 连续启动、或启动预热还没回来时，不会堆出一串对着慢服务器的请求。
    ///
    /// 发现由独立任务驱动到结束，调用方丢弃返回的句柄（比如等待超时）不会中断它。
    pub fn ensure_refresh(self: &Arc<Self>, server: &McpServerConfig) -> SharedRefresh {
        let epoch = self.epoch_of(&server.id);
        let mut inflight = self.inflight.lock();
        if let Some(existing) = inflight.get(&server.id) {
            if existing.epoch == epoch {
                return existing.fut.clone();
            }
        }
        let mgr = Arc::clone(self);
        let target = server.clone();
        let fut: SharedRefresh = async move {
            mgr.refresh_tools(&target)
                .await
                .map_err(|err| err.to_string())
        }
        .boxed()
        .shared();
        inflight.insert(
            server.id.clone(),
            InFlight {
                epoch,
                fut: fut.clone(),
            },
        );
        drop(inflight);

        let driver = fut.clone();
        let mgr = Arc::clone(self);
        let id = server.id.clone();
        tokio::spawn(async move {
            let _ = driver.await;
            let mut inflight = mgr.inflight.lock();
            if inflight.get(&id).is_some_and(|e| e.epoch == epoch) {
                inflight.remove(&id);
            }
        });
        fut
    }

    /// 任务启动时取某个服务器的工具：**不为慢服务器拖住任务**。
    ///
    /// - 有成功的缓存 → 直接用，同时后台刷新一次（下个任务用上新的）；
    /// - 上次失败 → 不等，后台重试一次；
    /// - 从没发现过（比如应用刚启动、预热还没回来）→ 最多等 `wait`，等不到就放
    ///   手，发现继续在后台跑。
    pub async fn tools_for_startup(
        self: &Arc<Self>,
        server: &McpServerConfig,
        wait: Duration,
    ) -> StartupTools {
        let cached = self.cache.read().await.get(&server.id).cloned();
        match cached {
            Some((tools, None)) => {
                drop(self.ensure_refresh(server));
                StartupTools::Cached(tools)
            }
            Some((_, Some(err))) => {
                drop(self.ensure_refresh(server));
                StartupTools::Unavailable(err)
            }
            None => match tokio::time::timeout(wait, self.ensure_refresh(server)).await {
                Ok(Ok(tools)) => StartupTools::Fresh(tools),
                Ok(Err(err)) => StartupTools::Unavailable(err),
                Err(_) => StartupTools::Unavailable(format!(
                    "{} 秒内未响应，已在后台继续发现",
                    wait.as_secs_f32()
                )),
            },
        }
    }

    pub async fn call_tool(
        &self,
        server: &McpServerConfig,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<String, AppError> {
        let headers = McpServerStore::effective_headers(server);
        if !self.initialized.read().await.contains(&server.id) {
            self.client.initialize(&server.url, &headers).await?;
            self.initialized.write().await.insert(server.id.clone());
        }
        self.client
            .call_tool(&server.url, &headers, tool_name, arguments)
            .await
    }

    pub async fn clear_cache(&self, server_id: &str) {
        // 先递增版本、摘掉进行中的发现，再删条目：此后回来的旧发现会发现版本
        // 不符而作废，新的发现也不会错加入针对旧配置的那次。
        *self.epochs.lock().entry(server_id.to_string()).or_insert(0) += 1;
        self.inflight.lock().remove(server_id);
        self.cache.write().await.remove(server_id);
        self.initialized.write().await.remove(server_id);
    }

    pub async fn statuses(&self, servers: &[McpServerConfig]) -> Vec<McpServerRuntimeStatus> {
        let cache = self.cache.read().await;
        servers
            .iter()
            .map(|server| match cache.get(&server.id) {
                Some((tools, error)) => McpServerRuntimeStatus {
                    server_id: server.id.clone(),
                    tools: tools.clone(),
                    error: error.clone(),
                    discovered: true,
                },
                None => McpServerRuntimeStatus {
                    server_id: server.id.clone(),
                    tools: Vec::new(),
                    error: None,
                    discovered: false,
                },
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
        McpToolInfo {
            name: name.into(),
            description: format!("Tool {}", name),
            input_schema: serde_json::json!({}),
        }
    }

    // ── refresh_tools ──────────────────────────────────────────────

    #[tokio::test]
    async fn refresh_tools_calls_initialize_and_returns_tools() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("read"));
        let mgr = McpManager::with_client(Box::new(spy.clone()));
        let server = make_server("s1");

        let tools = mgr.refresh_tools(&server).await.unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "read");
        assert_eq!(spy.init_calls.lock().await.len(), 1);
    }

    #[tokio::test]
    async fn refresh_tools_skips_initialize_when_already_set() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("a"));
        let mgr = McpManager::with_client(Box::new(spy.clone()));
        let server = make_server("s1");

        mgr.refresh_tools(&server).await.unwrap();
        spy.tools_to_return.lock().await.push(make_tool("b"));
        mgr.refresh_tools(&server).await.unwrap();

        assert_eq!(spy.init_calls.lock().await.len(), 1, "initialize only once");
    }

    #[tokio::test]
    async fn refresh_tools_updates_cache_on_success() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("t"));
        let mgr = McpManager::with_client(Box::new(spy));
        let server = make_server("s1");

        mgr.refresh_tools(&server).await.unwrap();
        let statuses = mgr.statuses(&[server]).await;
        assert!(statuses[0].discovered);
        assert_eq!(statuses[0].tools.len(), 1);
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
        // 握手失败也要留下带原因的缓存条目：设置页显示原因，任务启动据此不再
        // 把它当"从没发现过"而每次都等。
        let statuses = mgr.statuses(&[server]).await;
        assert!(statuses[0].discovered);
        assert!(statuses[0]
            .error
            .as_deref()
            .unwrap_or("")
            .contains("init failed"));
    }

    #[tokio::test]
    async fn refresh_tools_caches_error_on_list_tools_failure() {
        let spy = SpyClient::new();
        *spy.list_error.lock().await = Some("list failed".into());
        let mgr = McpManager::with_client(Box::new(spy));
        let server = make_server("s1");

        let result = mgr.refresh_tools(&server).await;
        assert!(result.is_err());
        let statuses = mgr.statuses(&[server]).await;
        assert!(statuses[0].discovered);
        assert!(statuses[0].error.is_some());
    }

    #[tokio::test]
    async fn refresh_tools_concurrent_different_servers_no_interference() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("a"));
        spy.tools_to_return.lock().await.push(make_tool("b"));
        let mgr1 = McpManager::with_client(Box::new(spy.clone()));
        let mgr2 = McpManager::with_client(Box::new(spy));
        let s1 = make_server("s1");
        let s2 = make_server("s2");

        let (r1, r2) = tokio::join!(mgr1.refresh_tools(&s1), mgr2.refresh_tools(&s2));
        assert!(r1.is_ok());
        assert!(r2.is_ok());
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
        spy.tools_to_return.lock().await.push(make_tool("x"));
        mgr.refresh_tools(&server).await.unwrap();

        assert_eq!(
            spy.init_calls.lock().await.len(),
            2,
            "initialize must be called again after clear"
        );
    }

    // ── statuses ───────────────────────────────────────────────────

    #[tokio::test]
    async fn statuses_returns_undiscovered_for_unknown_server() {
        let mgr = McpManager::new();
        let servers = vec![make_server("s1")];
        let statuses = mgr.statuses(&servers).await;
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses[0].server_id, "s1");
        assert!(statuses[0].tools.is_empty());
        assert!(statuses[0].error.is_none());
        assert!(!statuses[0].discovered);
    }

    #[tokio::test]
    async fn statuses_returns_cached_data_as_discovered() {
        let mgr = McpManager::new();
        let tool = make_tool("read");
        mgr.cache
            .write()
            .await
            .insert("s1".into(), (vec![tool], None));
        let servers = vec![make_server("s1")];
        let statuses = mgr.statuses(&servers).await;
        assert!(statuses[0].discovered);
        assert_eq!(statuses[0].tools.len(), 1);
        assert_eq!(statuses[0].tools[0].name, "read");
    }

    #[tokio::test]
    async fn statuses_returns_error_string() {
        let mgr = McpManager::new();
        mgr.cache
            .write()
            .await
            .insert("s1".into(), (vec![], Some("fail".into())));
        let servers = vec![make_server("s1")];
        let statuses = mgr.statuses(&servers).await;
        assert!(statuses[0].discovered);
        assert_eq!(statuses[0].error.as_deref(), Some("fail"));
    }

    #[tokio::test]
    async fn clear_cache_sets_discovered_false() {
        let mgr = McpManager::new();
        mgr.cache.write().await.insert("s1".into(), (vec![], None));
        mgr.initialized.write().await.insert("s1".into());
        let servers = vec![make_server("s1")];
        assert!(mgr.statuses(&servers).await[0].discovered);

        mgr.clear_cache("s1").await;
        assert!(mgr.cache.read().await.get("s1").is_none());
        assert!(!mgr.initialized.read().await.contains("s1"));
        assert!(!mgr.statuses(&servers).await[0].discovered);
    }

    #[tokio::test]
    async fn clear_cache_nonexistent_does_not_panic() {
        let mgr = McpManager::new();
        mgr.clear_cache("does-not-exist").await;
    }

    // ── 任务启动取工具（不为慢服务器拖住）──────────────────────────

    const WAIT: Duration = Duration::from_secs(3);
    const SLOW: Duration = Duration::from_secs(30);

    async fn settle() {
        // 让后台驱动任务跑完（暂停时钟下，睡眠会自动推进到所有任务空闲）。
        tokio::time::sleep(Duration::from_secs(120)).await;
    }

    #[tokio::test(start_paused = true)]
    async fn startup_uses_cache_without_waiting_for_a_slow_server() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("old"));
        let mgr = Arc::new(McpManager::with_client(Box::new(spy.clone())));
        let server = make_server("s1");
        mgr.refresh_tools(&server).await.unwrap();

        // 之后服务器变慢，并且工具换了
        *spy.list_delay.lock().await = Some(SLOW);
        *spy.tools_to_return.lock().await = vec![make_tool("new")];

        let started = tokio::time::Instant::now();
        let got = mgr.tools_for_startup(&server, WAIT).await;
        assert!(
            started.elapsed() < Duration::from_millis(10),
            "命中缓存不该等任何网络"
        );
        match got {
            StartupTools::Cached(tools) => assert_eq!(tools[0].name, "old"),
            other => panic!("应命中缓存，实际 {other:?}"),
        }

        // 后台刷新完成后，下一个任务拿到新工具
        settle().await;
        match mgr.tools_for_startup(&server, WAIT).await {
            StartupTools::Cached(tools) => assert_eq!(tools[0].name, "new"),
            other => panic!("应命中缓存，实际 {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn startup_waits_for_first_discovery_when_server_is_quick() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("a"));
        *spy.list_delay.lock().await = Some(Duration::from_millis(200));
        let mgr = Arc::new(McpManager::with_client(Box::new(spy)));

        match mgr.tools_for_startup(&make_server("s1"), WAIT).await {
            StartupTools::Fresh(tools) => assert_eq!(tools[0].name, "a"),
            other => panic!("首次发现应等到结果，实际 {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn startup_gives_up_on_first_discovery_after_the_wait_and_keeps_refreshing() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("late"));
        *spy.list_delay.lock().await = Some(SLOW);
        let mgr = Arc::new(McpManager::with_client(Box::new(spy)));
        let server = make_server("s1");

        let started = tokio::time::Instant::now();
        let got = mgr.tools_for_startup(&server, WAIT).await;
        assert!(matches!(got, StartupTools::Unavailable(_)), "实际 {got:?}");
        assert_eq!(started.elapsed(), WAIT, "只等约定的时限，不等满 30 秒");

        // 放手不等于取消：发现在后台跑完，结果写进缓存
        settle().await;
        let statuses = mgr.statuses(&[server.clone()]).await;
        assert!(statuses[0].discovered);
        assert_eq!(statuses[0].tools[0].name, "late");
        assert!(matches!(
            mgr.tools_for_startup(&server, WAIT).await,
            StartupTools::Cached(_)
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn startup_does_not_wait_for_a_server_that_just_failed() {
        let spy = SpyClient::new();
        *spy.list_error.lock().await = Some("connection refused".into());
        let mgr = Arc::new(McpManager::with_client(Box::new(spy.clone())));
        let server = make_server("s1");
        assert!(mgr.refresh_tools(&server).await.is_err());

        *spy.list_delay.lock().await = Some(SLOW);
        let started = tokio::time::Instant::now();
        let got = mgr.tools_for_startup(&server, WAIT).await;
        assert!(
            started.elapsed() < Duration::from_millis(10),
            "已知失败的服务器不该再拖住启动"
        );
        match got {
            StartupTools::Unavailable(reason) => assert!(reason.contains("connection refused")),
            other => panic!("应报不可用，实际 {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_recovered_server_is_picked_up_by_the_next_task() {
        let spy = SpyClient::new();
        *spy.list_error.lock().await = Some("down".into());
        let mgr = Arc::new(McpManager::with_client(Box::new(spy.clone())));
        let server = make_server("s1");
        assert!(mgr.refresh_tools(&server).await.is_err());

        // 服务器恢复。这个任务仍拿不到（不等），但会在后台重试
        *spy.list_error.lock().await = None;
        spy.tools_to_return.lock().await.push(make_tool("back"));
        assert!(matches!(
            mgr.tools_for_startup(&server, WAIT).await,
            StartupTools::Unavailable(_)
        ));
        settle().await;
        match mgr.tools_for_startup(&server, WAIT).await {
            StartupTools::Cached(tools) => assert_eq!(tools[0].name, "back"),
            other => panic!("下一个任务应拿到恢复后的工具，实际 {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_task_starts_share_one_discovery() {
        let spy = SpyClient::new();
        spy.tools_to_return.lock().await.push(make_tool("a"));
        *spy.list_delay.lock().await = Some(Duration::from_secs(1));
        let mgr = Arc::new(McpManager::with_client(Box::new(spy.clone())));
        let server = make_server("s1");

        let (a, b, c) = tokio::join!(
            mgr.tools_for_startup(&server, WAIT),
            mgr.tools_for_startup(&server, WAIT),
            mgr.tools_for_startup(&server, WAIT),
        );
        for got in [a, b, c] {
            assert!(matches!(got, StartupTools::Fresh(_)), "实际 {got:?}");
        }
        assert_eq!(
            spy.list_calls.lock().await.len(),
            1,
            "同一服务器同时只发一次发现"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_task_starts_against_a_hanging_server_do_not_pile_up_requests() {
        let spy = SpyClient::new();
        *spy.list_delay.lock().await = Some(SLOW);
        let mgr = Arc::new(McpManager::with_client(Box::new(spy.clone())));
        let server = make_server("s1");

        for _ in 0..5 {
            let _ = mgr.tools_for_startup(&server, WAIT).await;
        }
        assert_eq!(
            spy.list_calls.lock().await.len(),
            1,
            "上一次还没回来时，后续任务启动不该再对着它发请求"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn discovery_for_a_replaced_config_is_discarded() {
        let spy = SpyClient::new();
        spy.tools_to_return
            .lock()
            .await
            .push(make_tool("old-config"));
        *spy.list_delay.lock().await = Some(Duration::from_secs(10));
        let mgr = Arc::new(McpManager::with_client(Box::new(spy.clone())));
        let server = make_server("s1");

        let pending = mgr.ensure_refresh(&server);
        // 发现还在路上，用户改了这个服务器的配置
        tokio::time::sleep(Duration::from_secs(1)).await;
        mgr.clear_cache("s1").await;
        let _ = pending.await;
        settle().await;

        assert!(
            !mgr.statuses(&[server.clone()]).await[0].discovered,
            "针对旧配置的结果不能写进新配置的缓存"
        );
        assert!(!mgr.initialized.read().await.contains("s1"));

        // 改配置之后的新发现不会误加入旧的那次，而是重新发
        *spy.list_delay.lock().await = None;
        *spy.tools_to_return.lock().await = vec![make_tool("new-config")];
        let tools = mgr.ensure_refresh(&server).await.unwrap();
        assert_eq!(tools[0].name, "new-config");
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
        assert!(
            elapsed < std::time::Duration::from_millis(200),
            "should run in parallel (<200ms), took {:?}",
            elapsed
        );
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
