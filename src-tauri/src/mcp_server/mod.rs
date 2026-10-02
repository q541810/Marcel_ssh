// MCP Server 模块入口
//
// Marcel SSH 作为 MCP Server 对外暴露 SSH/SFTP 能力（桌面专属，移动端不做）。
//
// 两种 transport，请求分发共用一份（见 `McpServer::handle_request`）：
//   - stdio（`stdio_transport.rs`）：客户端启动本进程，走管道。主流接法。
//   - HTTP（`http_transport.rs`）：常驻端口 + 强制 Bearer 令牌，见该文件的安全说明。

pub mod agent_task;
pub mod cli;
pub mod external_executor;
#[cfg(desktop)]
pub mod http_transport;
pub mod protocol;
#[cfg(desktop)]
pub mod runtime;
pub mod sftp_ops;
pub mod stdio_transport;
pub mod tools;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::RwLock;

use crate::command_exec::CommandExecutionManager;
use crate::config::connections::ConnectionStore;
use crate::error::AppError;
use crate::SshManager;

/// MCP Server 配置
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    /// Server 名称（返回给 client）
    pub name: String,
    /// Server 版本
    pub version: String,
    /// 是否记录所有外部调用到日志
    pub log_external_calls: bool,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            name: "Marcel SSH MCP Server".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            log_external_calls: true,
        }
    }
}

/// MCP Server 实例
///
/// `connection_store` 持**共享的 RwLock**而不是快照：`create_connection`
/// 动态创建的临时连接要能被同一进程内的 `list_connections` 看见，
/// 也要能被后续 `ssh_execute` 解析到。快照会让临时连接当场失联。
///
/// 字段全是 `Arc` / `Option<Arc>`，所以 `Clone` 是廉价的浅拷贝——
/// HTTP transport 需要把 server 放进每请求共享的 state 里。
#[derive(Clone)]
pub struct McpServer {
    config: McpServerConfig,
    ssh_manager: Arc<SshManager>,
    connection_store: Arc<RwLock<ConnectionStore>>,
    pub command_exec: Option<Arc<CommandExecutionManager>>,
    /// 配置目录：无头 agent 任务要从这里读 `settings.json` 并解析模型
    /// （见 [`agent_task::build_headless_llm`]）。缺了它就没有 `agent_task` 能力。
    pub config_dir: Option<PathBuf>,
}

impl McpServer {
    pub fn new(
        config: McpServerConfig,
        ssh_manager: Arc<SshManager>,
        connection_store: Arc<RwLock<ConnectionStore>>,
    ) -> Self {
        Self {
            config,
            ssh_manager,
            connection_store,
            command_exec: None,
            config_dir: None,
        }
    }

    /// 从 GUI 的运行时状态组装（**进程内**启动服务用）。
    ///
    /// 与 CLI 的 [`Self::new`] 差别只在数据来源：这里直接复用 GUI 已经在用的
    /// `ssh_manager` / `connection_store` / `command_exec` 实例，而不是另读一份
    /// 配置文件。所以「用户在界面上新增一条连接」会立刻对 MCP 调用生效，
    /// 不需要重启服务。`connection_store` 必须是**同一个 Arc**（锁类型也已统一
    /// 为 tokio 的，见 `ExternalExecutor` 的字段注释）。
    pub fn from_app_state(
        ssh_manager: Arc<SshManager>,
        connection_store: Arc<RwLock<ConnectionStore>>,
        command_exec: Arc<CommandExecutionManager>,
        config_dir: std::path::PathBuf,
    ) -> Self {
        Self {
            config: McpServerConfig::default(),
            ssh_manager,
            connection_store,
            command_exec: Some(command_exec),
            config_dir: Some(config_dir),
        }
    }

    /// 获取服务器信息（用于 initialize 响应）
    pub fn server_info(&self) -> serde_json::Value {
        serde_json::json!({
            "name": self.config.name,
            "version": self.config.version
        })
    }

    /// 获取协议版本
    pub fn protocol_version(&self) -> &'static str {
        "2024-11-05"
    }

    /// 获取服务器能力
    pub fn capabilities(&self) -> serde_json::Value {
        serde_json::json!({
            "tools": {}
        })
    }

    /// 构造工具注册表。
    ///
    /// **所有 transport 共用这一条构造路径**（stdio / HTTP）：
    /// 执行器需要 `command_exec`，而它由进程启动时注入（见 `cli.rs`）——
    /// 缺了它就没法执行任何命令，所以这里如实报错而不是静默给个空注册表。
    ///
    /// 有 `config_dir` 时一并接上无头 agent 任务（`agent_task` 工具）；
    /// 没有则只有 9 个基础工具——工具清单与实际能力保持一致，
    /// 不会给客户端一个必然失败的入口。
    pub fn build_registry(&self) -> Result<Arc<tools::ToolRegistry>, AppError> {
        let command_exec = self.command_exec.clone().ok_or_else(|| {
            AppError::Agent("MCP Server 未注入 command_exec，无法执行命令".into())
        })?;

        let executor = Arc::new(external_executor::ExternalExecutor::new(
            self.connection_store.clone(),
            command_exec,
            self.ssh_manager.clone(),
        ));

        Ok(match &self.config_dir {
            Some(dir) => tools::ToolRegistry::new_with_agent_tasks(executor, dir.clone()),
            None => Arc::new(tools::ToolRegistry::new(executor)),
        })
    }

    /// 运行 Stdio transport server
    #[cfg(desktop)]
    pub async fn run_stdio(&self) -> Result<(), AppError> {
        stdio_transport::run_stdio_server(self).await
    }

    /// 运行 HTTP transport server（桌面专属，见 `http_transport`）。
    ///
    /// 与 stdio 的**唯一**差别是传输层；请求分发走同一个
    /// [`Self::handle_request`]，所以两种接入方式的工具语义、错误码、
    /// 返回结构逐字一致，不会出现「stdio 能用、HTTP 上行为不同」。
    #[cfg(desktop)]
    pub async fn run_http(&self, cfg: http_transport::HttpConfig) -> Result<(), AppError> {
        http_transport::run_http_server(self, cfg).await
    }

    // ─────────────────────────── 请求分发 ───────────────────────────
    //
    // 所有 transport 共用这一份实现：JSON-RPC 的方法路由、参数校验、
    // 错误码映射只此一处。分发出第二份就等于埋下「两条接入路径行为漂移」
    // 的隐患——而这类漂移在安全相关的调用上是要命的。

    /// 处理一条 JSON-RPC 请求。
    pub async fn handle_request(
        &self,
        registry: &Arc<tools::ToolRegistry>,
        req: protocol::McpRequest,
    ) -> protocol::McpResponse {
        use protocol::{McpError, McpResponse};

        match req.method.as_str() {
            "initialize" => {
                log::info!("[MCP] 客户端初始化: {:?}", req.params);
                let result = serde_json::json!({
                    "protocolVersion": self.protocol_version(),
                    "capabilities": self.capabilities(),
                    "serverInfo": self.server_info()
                });
                McpResponse::success(req.id, result)
            }

            "tools/list" => McpResponse::success(
                req.id,
                serde_json::json!({ "tools": registry.list_tools() }),
            ),

            "tools/call" => {
                let Some(params) = req.params else {
                    return McpResponse::error(
                        req.id,
                        McpError::invalid_params("Missing params for tools/call"),
                    );
                };
                let Some(name) = params.get("name").and_then(|v| v.as_str()) else {
                    return McpResponse::error(
                        req.id,
                        McpError::invalid_params("Missing 'name' in params"),
                    );
                };
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or(serde_json::json!({}));

                match registry.call_tool(name, arguments).await {
                    Ok(result) => McpResponse::success(req.id, serde_json::to_value(&result).unwrap()),
                    Err(err) => McpResponse::error(req.id, err),
                }
            }

            _ => McpResponse::error(req.id, McpError::method_not_found(&req.method)),
        }
    }

    /// 处理一条通知（notification：无 id，不需要响应）。
    pub fn handle_notification(&self, notif: &protocol::McpNotification) {
        match notif.method.as_str() {
            "notifications/initialized" => log::info!("[MCP] 客户端已确认初始化"),
            other => log::debug!("[MCP] 未知通知: {}", other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_config() {
        let cfg = McpServerConfig::default();
        assert_eq!(cfg.name, "Marcel SSH MCP Server");
        assert!(cfg.log_external_calls);
    }

    #[test]
    fn server_info_format() {
        let cfg = McpServerConfig::default();
        let ssh_mgr = Arc::new(SshManager::new());
        let conn_store = Arc::new(RwLock::new(ConnectionStore::new()));
        let server = McpServer::new(cfg, ssh_mgr, conn_store);

        let info = server.server_info();
        assert_eq!(info["name"], "Marcel SSH MCP Server");
        assert!(info["version"].is_string());
    }

    #[test]
    fn protocol_version_stable() {
        let cfg = McpServerConfig::default();
        let ssh_mgr = Arc::new(SshManager::new());
        let conn_store = Arc::new(RwLock::new(ConnectionStore::new()));
        let server = McpServer::new(cfg, ssh_mgr, conn_store);

        assert_eq!(server.protocol_version(), "2024-11-05");
    }
}
