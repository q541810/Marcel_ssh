// MCP Tools 注册与分发
//
// 定义所有 MCP 工具的 schema 和执行逻辑

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tokio::sync::watch;

use super::agent_task::AgentTaskRunner;
use super::external_executor::{ExternalExecutor, CONNECTION_NOT_FOUND_PREFIX};
use super::protocol::{McpError, ToolCallResult};
use super::tasks::{TaskKind, TaskSnapshot};
use crate::error::AppError;

/// 无头子 agent 工具名。Agent 任务循环给模型的工具清单里会**剔除**它
/// （见 `agent_task::base_tool_definitions`），不让模型自己再派一层 agent。
pub const AGENT_TASK_TOOL: &str = "remote_subagent";

/// 是否提供读写本机文件的工具（`sftp_upload` / `sftp_download`）。
///
/// Android 上不提供：`local_path` 指的是手机上的路径，而手机上最典型的两类客户端
/// （Termux 里的 agent、局域网里的电脑）给出的路径要么在别的沙箱、要么在别的机器上，
/// 这两个工具几乎必然失败。清单与实际能力保持一致，不给客户端一个必然失败的入口；
/// 调用时同样按「没有这个工具」处理，列表与分发不会各说各话。
const LOCAL_FILE_TOOLS: bool = cfg!(not(target_os = "android"));

/// 工具注册表
pub struct ToolRegistry {
    executor: Arc<ExternalExecutor>,
    /// 无头 agent 任务执行器。
    ///
    /// 有它才会对外暴露 `remote_subagent`：`ToolRegistry::new` 建的注册表
    /// （单测、以及不接 LLM 的场景）没有这个能力，此时列出 `remote_subagent`
    /// 等于给客户端一个必然失败的入口，所以列出的清单与是否具备保持一致。
    agent_task: Option<Arc<AgentTaskRunner>>,
}

impl ToolRegistry {
    /// 只有 SSH/SFTP 工具（无 `remote_subagent`）。
    pub fn new(executor: Arc<ExternalExecutor>) -> Self {
        Self {
            executor,
            agent_task: None,
        }
    }

    /// 带上无头 agent 任务能力（生产路径用它）。
    ///
    /// 用 `Arc::new_cyclic` 建立双向关系：注册表持有执行器，执行器需要回调
    /// 注册表来分发基础工具。回调那一侧用 `Weak` 断掉引用环，`new_cyclic`
    /// 让这个环在构造期就能建起来。
    pub fn new_with_agent_tasks(executor: Arc<ExternalExecutor>, config_dir: PathBuf) -> Arc<Self> {
        Arc::new_cyclic(|weak| {
            let runner = Arc::new(AgentTaskRunner::new(
                executor.clone(),
                config_dir,
                weak.clone(),
            ));
            Self {
                executor,
                agent_task: Some(runner),
            }
        })
    }

    /// 执行器句柄：transport 层在收尾时用它关闭无头会话（见
    /// [`super::stdio_transport::run_stdio_server`]）。
    pub fn executor(&self) -> &Arc<ExternalExecutor> {
        &self.executor
    }

    /// agent 任务执行器句柄（无则 `None`）。
    ///
    /// **只给测试用**：`agent_task.rs` 的循环测试靠它拿到 runner 直接驱动，
    /// 从而不必联网就能验证收尾分支。生产路径不经过它，所以标 `cfg(test)`
    /// 免得在正式构建里留下一个"没人用"的方法。
    #[cfg(test)]
    pub(crate) fn agent_task_runner(&self) -> Option<&Arc<AgentTaskRunner>> {
        self.agent_task.as_ref()
    }

    /// 获取所有工具的 schema 列表
    pub fn list_tools(&self) -> Vec<serde_json::Value> {
        let mut tools = Self::base_schemas(LOCAL_FILE_TOOLS);
        if self.agent_task.is_some() {
            tools.push(Self::agent_task_schema());
        }
        tools
    }

    /// 调用工具
    pub async fn call_tool(
        &self,
        name: &str,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResult, McpError> {
        self.call_tool_with_cancel(name, arguments, None).await
    }

    /// 调用工具，并把当前 MCP 请求的取消信号带到真实执行体。
    pub(crate) async fn call_tool_with_cancel(
        &self,
        name: &str,
        arguments: serde_json::Value,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<ToolCallResult, McpError> {
        if name == AGENT_TASK_TOOL {
            let Some(runner) = self.agent_task.as_ref() else {
                return Err(McpError::method_not_found(name));
            };
            let background = arguments
                .get("background")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            if !background {
                return runner.run_with_cancel(arguments, cancel).await;
            }
            let connection_id = arguments
                .get("connection_id")
                .and_then(|v| v.as_str())
                .unwrap_or("<missing>")
                .to_string();
            let task_id = super::tasks::TaskManager::allocate_id(TaskKind::Agent);
            let mut snapshot = TaskSnapshot::new_managed(
                task_id.clone(),
                TaskKind::Agent,
                connection_id,
                "running",
                super::tasks::now_millis(),
            );
            snapshot.description = arguments
                .get("task")
                .and_then(|v| v.as_str())
                .map(|s| s.chars().take(200).collect());
            let manager = self.executor.tasks();
            let (handle, registration) = manager.start_managed(snapshot).ok_or_else(|| {
                McpError::internal_error("任务 ID 冲突，未能登记 remote_subagent 任务")
            })?;
            let cancel_rx = registration.receiver();
            let runner = runner.clone();
            manager
                .track_worker(async move {
                    let _registration = registration;
                    let result = runner.run_with_cancel(arguments, Some(cancel_rx)).await;
                    match result {
                        Ok(tool_result) => {
                            let text = tool_result
                                .content
                                .iter()
                                .find_map(|item| match item {
                                    super::protocol::ContentItem::Text { text } => {
                                        Some(text.clone())
                                    }
                                })
                                .unwrap_or_default();
                            match serde_json::from_str::<super::agent_task::AgentTaskResult>(&text)
                            {
                                Ok(task_result) if task_result.status == "cancelled" => {
                                    handle.cancelled(task_result.error)
                                }
                                Ok(task_result) if task_result.status == "failed" => handle.fail(
                                    task_result
                                        .error
                                        .unwrap_or_else(|| "remote_subagent 失败".into()),
                                ),
                                _ => handle.complete(false, Some(text)),
                            }
                        }
                        Err(error) => handle.fail(error.message),
                    }
                })
                .await;
            return Ok(ToolCallResult::text(
                serde_json::json!({
                    "task_id": task_id,
                    "kind": "agent",
                    "status": "running",
                    "phase": "running",
                    "note": "用 task_status 查最终汇报，用 task_cancel 停止后续模型与工具调用。"
                })
                .to_string(),
            ));
        }
        self.dispatch_base_with_cancel(name, arguments, cancel)
            .await
    }

    /// 分发 SSH/SFTP 基础工具与统一任务工具。
    ///
    /// `pub(crate)`：无头 agent 任务循环也走这里（`agent_task.rs`）——
    /// 参数校验与错误码只有这一处实现，两条路径不会跑偏。
    pub(crate) async fn dispatch_base_with_cancel(
        &self,
        name: &str,
        arguments: serde_json::Value,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<ToolCallResult, McpError> {
        match name {
            "list_connections" => self.call_list_connections(arguments).await,
            "ssh_execute" => self.call_ssh_execute(arguments, cancel).await,
            "get_working_directory" => self.call_get_working_directory(arguments, cancel).await,
            "create_connection" => self.call_create_connection(arguments).await,
            "test_connection" => self.call_test_connection(arguments, cancel).await,
            "sftp_upload" if LOCAL_FILE_TOOLS => self.call_sftp_upload(arguments, cancel).await,
            "sftp_download" if LOCAL_FILE_TOOLS => self.call_sftp_download(arguments, cancel).await,
            "sftp_list" => self.call_sftp_list(arguments).await,
            "sftp_delete" => self.call_sftp_delete(arguments).await,
            "task_status" => self.call_task_status(arguments).await,
            "task_list" => self.call_task_list(arguments).await,
            "task_output" => self.call_task_output(arguments).await,
            "task_cancel" => self.call_task_cancel(arguments).await,
            #[cfg(test)]
            "__test_sleep" => self.call_test_sleep(arguments, cancel).await,
            _ => Err(McpError::method_not_found(name)),
        }
    }

    /// 仅测试：可被取消的慢工具，用来确定性地验证 stdio 并发与取消。
    #[cfg(test)]
    async fn call_test_sleep(
        &self,
        arguments: serde_json::Value,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<ToolCallResult, McpError> {
        let ms = arguments.get("ms").and_then(|v| v.as_u64()).unwrap_or(50);
        let mut cancel = cancel;
        tokio::select! {
            _ = tokio::time::sleep(std::time::Duration::from_millis(ms)) => {
                Ok(ToolCallResult::text("slept"))
            }
            _ = async {
                match cancel.as_mut() {
                    Some(rx) => { let _ = rx.changed().await; }
                    None => std::future::pending().await,
                }
            } => Err(McpError::cancelled()),
        }
    }

    /// 基础工具清单。`local_files` 为假时不含 `sftp_upload` / `sftp_download`。
    fn base_schemas(local_files: bool) -> Vec<serde_json::Value> {
        let mut tools = vec![
            Self::list_connections_schema(),
            Self::ssh_execute_schema(),
            Self::get_working_directory_schema(),
            Self::create_connection_schema(),
            Self::test_connection_schema(),
        ];
        if local_files {
            tools.push(Self::sftp_upload_schema());
            tools.push(Self::sftp_download_schema());
        }
        tools.push(Self::sftp_list_schema());
        tools.push(Self::sftp_delete_schema());
        tools.push(Self::task_status_schema());
        tools.push(Self::task_list_schema());
        tools.push(Self::task_output_schema());
        tools.push(Self::task_cancel_schema());
        tools
    }

    // ========== Tool Schemas ==========

    fn list_connections_schema() -> serde_json::Value {
        json!({
            "name": "list_connections",
            "description": "列出所有已保存的 SSH 连接。返回连接的 ID、名称、主机地址等基本信息，不包含密码或私钥。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "additionalProperties": false
            }
        })
    }

    fn ssh_execute_schema() -> serde_json::Value {
        json!({
            "name": "ssh_execute",
            "description": "在远程服务器上执行 SSH 命令。返回标准输出、标准错误和退出码。sudo 可自动使用已保存的 sudo 密码或当前连接的 SSH 登录密码，但不会弹密码框；没有可用凭据时会报错。注意：此工具绕过 Marcel SSH 的命令风险评估，调用方需自行确保命令安全。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": {
                        "type": "string",
                        "description": "SSH 连接 ID（从 list_connections 获取）"
                    },
                    "command": {
                        "type": "string",
                        "description": "要执行的 shell 命令"
                    },
                    "timeout_ms": {
                        "type": "integer",
                        "description": "命令总时限（毫秒）。不填时：10 秒内完成直接返回，超过 10 秒自动转后台任务并继续执行，不再有默认 30 秒杀进程。填了则到点结束（转后台后也按剩余时间生效）。",
                        "minimum": 1000,
                        "maximum": 86400000
                    },
                    "background": {
                        "type": "boolean",
                        "description": "三态：true=立即返回任务 ID；false=一直等命令结束；不填=最多等 10 秒，没结束就自动转后台任务。不要声明默认值，否则客户端会填 false 变成同步等待。"
                    }
                },
                "required": ["connection_id", "command"],
                "additionalProperties": false
            }
        })
    }

    fn sftp_upload_schema() -> serde_json::Value {
        json!({
            "name": "sftp_upload",
            "description": "通过 SFTP 上传本地文件到远程服务器，自动创建远程目录。默认立即返回任务 ID，用 task_status 查进度、task_cancel 取消；只有明确传 background=false 才等待传完。",
            "_meta": { "timeoutMs": 1800000 },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": {
                        "type": "string",
                        "description": "SSH 连接 ID"
                    },
                    "local_path": {
                        "type": "string",
                        "description": "本地文件路径（绝对路径或相对于调用者的工作目录）"
                    },
                    "remote_path": {
                        "type": "string",
                        "description": "远程文件路径（绝对路径）"
                    },
                    "background": {
                        "type": "boolean",
                        "description": "默认 true：立即返回任务 ID。false：同步等待传完（大文件可能触发客户端超时）。",
                        "default": true
                    }
                },
                "required": ["connection_id", "local_path", "remote_path"],
                "additionalProperties": false
            }
        })
    }

    fn sftp_download_schema() -> serde_json::Value {
        json!({
            "name": "sftp_download",
            "description": "通过 SFTP 从远程服务器下载文件到本地，自动创建本地目录。默认立即返回任务 ID，用 task_status 查进度、task_cancel 取消；只有明确传 background=false 才等待完成。",
            "_meta": { "timeoutMs": 1800000 },
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": {
                        "type": "string",
                        "description": "SSH 连接 ID"
                    },
                    "remote_path": {
                        "type": "string",
                        "description": "远程文件路径（绝对路径）"
                    },
                    "local_path": {
                        "type": "string",
                        "description": "本地保存路径（绝对路径或相对路径）"
                    },
                    "background": {
                        "type": "boolean",
                        "description": "默认 true：立即返回任务 ID。false：同步等待传完（大文件可能触发客户端超时）。",
                        "default": true
                    }
                },
                "required": ["connection_id", "remote_path", "local_path"],
                "additionalProperties": false
            }
        })
    }

    fn sftp_list_schema() -> serde_json::Value {
        json!({
            "name": "sftp_list",
            "description": "列出远程服务器上指定目录的文件和子目录。返回文件名、大小、修改时间、类型等信息。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": {
                        "type": "string",
                        "description": "SSH 连接 ID"
                    },
                    "remote_path": {
                        "type": "string",
                        "description": "远程目录路径。省略则用 \".\"——SFTP 会话的起始目录就是登录用户的家目录，所以 \".\" 等价于家目录。（不要传 \"~\"：SFTP 协议不做波浪号展开，那会被当成字面目录名）",
                        "default": "."
                    }
                },
                "required": ["connection_id"],
                "additionalProperties": false
            }
        })
    }

    fn sftp_delete_schema() -> serde_json::Value {
        json!({
            "name": "sftp_delete",
            "description": "删除远程服务器上的文件或目录。警告：此操作不可恢复。如果是目录，必须为空才能删除（除非 recursive=true）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": {
                        "type": "string",
                        "description": "SSH 连接 ID"
                    },
                    "remote_path": {
                        "type": "string",
                        "description": "要删除的远程文件或目录路径（绝对路径）"
                    },
                    "recursive": {
                        "type": "boolean",
                        "description": "是否递归删除目录（默认 false，目录必须为空）",
                        "default": false
                    }
                },
                "required": ["connection_id", "remote_path"],
                "additionalProperties": false
            }
        })
    }

    fn task_status_schema() -> serde_json::Value {
        json!({
            "name": "task_status",
            "description": "查询命令、上传、下载或 remote_subagent 任务的状态、进度和最终结果。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string", "description": "task_* 工具使用的任务 ID" }
                },
                "required": ["task_id"],
                "additionalProperties": false
            }
        })
    }

    fn task_list_schema() -> serde_json::Value {
        json!({
            "name": "task_list",
            "description": "列出当前 MCP 服务进程内的任务。默认包含运行中和最近结束的；active_only=true 只看运行中。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "active_only": { "type": "boolean", "default": false }
                },
                "additionalProperties": false
            }
        })
    }

    fn task_output_schema() -> serde_json::Value {
        json!({
            "name": "task_output",
            "description": "增量读取命令任务的 stdout/stderr。传回上次返回的 offset 即可继续读；非命令任务没有输出可读。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" },
                    "offset": { "type": "integer", "minimum": 0, "default": 0 },
                    "budget_bytes": { "type": "integer", "minimum": 4, "maximum": 32000, "default": 32000 }
                },
                "required": ["task_id"],
                "additionalProperties": false
            }
        })
    }

    fn task_cancel_schema() -> serde_json::Value {
        json!({
            "name": "task_cancel",
            "description": "取消任务。上传/下载会停止并清理临时文件；命令会停止等待并关闭通道，但远端进程不保证已被杀死（结果里会标记 remote_may_continue）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_id": { "type": "string" }
                },
                "required": ["task_id"],
                "additionalProperties": false
            }
        })
    }

    fn get_working_directory_schema() -> serde_json::Value {
        json!({
            "name": "get_working_directory",
            "description": "获取指定 SSH 连接当前的工作目录路径。用于解析相对路径或确认当前位置。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": {
                        "type": "string",
                        "description": "SSH 连接 ID"
                    }
                },
                "required": ["connection_id"],
                "additionalProperties": false
            }
        })
    }

    fn create_connection_schema() -> serde_json::Value {
        json!({
            "name": "create_connection",
            "description": "动态创建临时 SSH 连接（不保存到配置文件）。返回连接 ID，可用于后续的 SSH 操作。连接会在 MCP Server 进程结束时自动清理。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "连接名称（用于识别）"
                    },
                    "host": {
                        "type": "string",
                        "description": "SSH 服务器地址"
                    },
                    "port": {
                        "type": "integer",
                        "description": "SSH 端口，默认 22",
                        "default": 22,
                        "minimum": 1,
                        "maximum": 65535
                    },
                    "username": {
                        "type": "string",
                        "description": "SSH 用户名"
                    },
                    "auth_method": {
                        "type": "string",
                        "enum": ["password", "private_key"],
                        "description": "认证方式：password（密码）或 private_key（私钥）"
                    },
                    "password": {
                        "type": "string",
                        "description": "密码（auth_method=password 时必需）"
                    },
                    "private_key_path": {
                        "type": "string",
                        "description": "私钥文件路径（auth_method=private_key 时必需）"
                    },
                    "passphrase": {
                        "type": "string",
                        "description": "私钥密码短语（如果私钥有加密）"
                    }
                },
                "required": ["name", "host", "username", "auth_method"],
                "additionalProperties": false
            }
        })
    }

    fn test_connection_schema() -> serde_json::Value {
        json!({
            "name": "test_connection",
            "description": "测试 SSH 连接的可用性。返回连接状态、延迟、SSH 服务器版本等诊断信息。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": {
                        "type": "string",
                        "description": "SSH 连接 ID"
                    }
                },
                "required": ["connection_id"],
                "additionalProperties": false
            }
        })
    }

    fn agent_task_schema() -> serde_json::Value {
        json!({
            "name": AGENT_TASK_TOOL,
            "description": "在远程服务器上运行一个子 agent，把一个复杂的多步骤 SSH 任务交给它执行。\
        它会自己规划步骤、调用 ssh_execute / sftp_* 等工具把活干完，最后返回一段汇报。\
        适合：需要多步探查再动手的任务（部署、排障、批量操作）；单条命令请直接用 ssh_execute。\
        注意：任务执行期间无法向用户提问，所以任务描述要把目标和约束说清楚。\
        sudo 同样不会弹密码框：只能用已保存的 sudo 密码或当前连接的 SSH 登录密码，\
        没有可用凭据或被拒时会失败，不要指望在任务里临时问密码。\
        安全提示：此工具执行的命令不经过 Marcel SSH 的风险评估，也不会弹审批。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "connection_id": {
                        "type": "string",
                        "description": "SSH 连接 ID（从 list_connections 获取）；任务全程作用在这台机器上"
                    },
                    "task": {
                        "type": "string",
                        "description": "任务描述（自然语言）。说清楚目标、期望结果与约束条件——执行期间没有人能回答追问"
                    },
                    "timeout_seconds": {
                        "type": "integer",
                        "description": "任务总超时（秒），默认 300，范围 10–3600",
                        "default": 300,
                        "minimum": 10,
                        "maximum": 3600
                    },
                    "max_steps": {
                        "type": "integer",
                        "description": "工具调用步数上限，默认 25，范围 1–200。撞到上限会如实返回 max_steps 状态",
                        "default": 25,
                        "minimum": 1,
                        "maximum": 200
                    },
                    "background": {
                        "type": "boolean",
                        "description": "默认 true：立即返回任务 ID，用 task_status 查最终汇报。false：同步等待整个子 Agent 跑完。",
                        "default": true
                    }
                },
                "required": ["connection_id", "task"],
                "additionalProperties": false
            }
        })
    }

    // ========== Tool Implementations ==========

    async fn call_list_connections(
        &self,
        _arguments: serde_json::Value,
    ) -> Result<ToolCallResult, McpError> {
        let connections =
            self.executor.list_connections().await.map_err(|e| {
                McpError::internal_error(format!("Failed to list connections: {}", e))
            })?;

        let json = serde_json::to_string(&connections)
            .map_err(|e| McpError::internal_error(format!("JSON serialization failed: {}", e)))?;

        Ok(ToolCallResult::text(json))
    }

    async fn call_ssh_execute(
        &self,
        arguments: serde_json::Value,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<ToolCallResult, McpError> {
        let connection_id = arguments
            .get("connection_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'connection_id'"))?;

        let command = arguments
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'command'"))?;

        let timeout_ms = arguments.get("timeout_ms").and_then(|v| v.as_u64());
        let background = arguments.get("background").and_then(|v| v.as_bool());

        if background == Some(false) {
            let output = self
                .executor
                .execute_command_with_cancel(connection_id, command, timeout_ms, cancel)
                .await
                .map_err(map_app_error)?;
            return serde_json::to_string(&output)
                .map(ToolCallResult::text)
                .map_err(|e| {
                    McpError::internal_error(format!("JSON serialization failed: {}", e))
                });
        }

        let outcome = self
            .executor
            .execute_command_task(
                connection_id,
                command,
                timeout_ms,
                std::time::Duration::from_secs(10),
                background == Some(true),
                cancel,
            )
            .await
            .map_err(map_app_error)?;

        let json = match outcome {
            crate::mcp_server::external_executor::CommandExecutionOutcome::Finished(output) => {
                serde_json::to_string(&output)
            }
            crate::mcp_server::external_executor::CommandExecutionOutcome::Detached {
                job_id,
                ..
            } => {
                let snapshot = self.executor.tasks().task_status(&job_id).await.ok();
                serde_json::to_string(&serde_json::json!({
                    "task_id": job_id,
                    "kind": "command",
                    "status": "running",
                    "snapshot": snapshot,
                    "note": "命令仍在远端执行；用 task_status 查状态，用 task_output 读增量输出，用 task_cancel 停止等待。远端进程是否随取消结束不保证。"
                }))
            }
        }
        .map_err(|e| McpError::internal_error(format!("JSON serialization failed: {}", e)))?;

        Ok(ToolCallResult::text(json))
    }

    async fn call_sftp_upload(
        &self,
        arguments: serde_json::Value,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<ToolCallResult, McpError> {
        let connection_id = arguments
            .get("connection_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'connection_id'"))?;

        let local_path = arguments
            .get("local_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'local_path'"))?;

        let remote_path = arguments
            .get("remote_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'remote_path'"))?;
        let background = arguments
            .get("background")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        if background {
            let connection_id = connection_id.to_string();
            let local_path = local_path.to_string();
            let remote_path = remote_path.to_string();
            let task_id = super::tasks::TaskManager::allocate_id(TaskKind::Upload);
            let mut snapshot = TaskSnapshot::new_managed(
                task_id.clone(),
                TaskKind::Upload,
                connection_id.clone(),
                "connecting",
                super::tasks::now_millis(),
            );
            snapshot.local_path = Some(local_path.to_string());
            snapshot.remote_path = Some(remote_path.to_string());
            let manager = self.executor.tasks();
            let (handle, registration) = manager
                .start_managed(snapshot)
                .ok_or_else(|| McpError::internal_error("任务 ID 冲突，未能登记上传任务"))?;
            let cancel_rx = registration.receiver();
            let executor = self.executor.clone();
            let progress_handle = handle.clone();
            manager
                .track_worker(async move {
                    let _registration = registration;
                    let on_progress = move |written: u64, total: u64| {
                        progress_handle.progress(written, total);
                    };
                    let result = executor
                        .sftp_upload_with_cancel(
                            &connection_id,
                            &local_path,
                            &remote_path,
                            Some(cancel_rx),
                            Some(&on_progress),
                        )
                        .await;
                    match result {
                        Ok(_) => handle.complete(true, None),
                        Err(AppError::Cancelled(message)) => handle.cancelled(Some(message)),
                        Err(error) => handle.fail(error.to_string()),
                    }
                })
                .await;
            return Ok(ToolCallResult::text(
                serde_json::json!({
                    "task_id": task_id,
                    "kind": "upload",
                    "status": "running",
                    "phase": "connecting",
                    "note": "用 task_status 查进度，完成前不要假定目标文件已提交。"
                })
                .to_string(),
            ));
        }

        let result = self
            .executor
            .sftp_upload_with_cancel(connection_id, local_path, remote_path, cancel, None)
            .await
            .map_err(map_app_error)?;

        let json = serde_json::to_string(&result)
            .map_err(|e| McpError::internal_error(format!("JSON serialization failed: {}", e)))?;

        Ok(ToolCallResult::text(json))
    }

    async fn call_sftp_download(
        &self,
        arguments: serde_json::Value,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<ToolCallResult, McpError> {
        let connection_id = arguments
            .get("connection_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'connection_id'"))?;

        let remote_path = arguments
            .get("remote_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'remote_path'"))?;

        let local_path = arguments
            .get("local_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'local_path'"))?;
        let background = arguments
            .get("background")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        if background {
            let connection_id = connection_id.to_string();
            let remote_path = remote_path.to_string();
            let local_path = local_path.to_string();
            let task_id = super::tasks::TaskManager::allocate_id(TaskKind::Download);
            let mut snapshot = TaskSnapshot::new_managed(
                task_id.clone(),
                TaskKind::Download,
                connection_id.clone(),
                "connecting",
                super::tasks::now_millis(),
            );
            snapshot.local_path = Some(local_path.to_string());
            snapshot.remote_path = Some(remote_path.to_string());
            let manager = self.executor.tasks();
            let (handle, registration) = manager
                .start_managed(snapshot)
                .ok_or_else(|| McpError::internal_error("任务 ID 冲突，未能登记下载任务"))?;
            let cancel_rx = registration.receiver();
            let executor = self.executor.clone();
            let progress_handle = handle.clone();
            manager
                .track_worker(async move {
                    let _registration = registration;
                    let on_progress = move |written: u64, total: u64| {
                        progress_handle.progress(written, total);
                    };
                    let result = executor
                        .sftp_download_with_cancel(
                            &connection_id,
                            &remote_path,
                            &local_path,
                            Some(cancel_rx),
                            Some(&on_progress),
                        )
                        .await;
                    match result {
                        Ok(_) => handle.complete(true, None),
                        Err(AppError::Cancelled(message)) => handle.cancelled(Some(message)),
                        Err(error) => handle.fail(error.to_string()),
                    }
                })
                .await;
            return Ok(ToolCallResult::text(
                serde_json::json!({
                    "task_id": task_id,
                    "kind": "download",
                    "status": "running",
                    "phase": "connecting",
                    "note": "用 task_status 查进度；completed 前目标本地文件尚未原子替换。"
                })
                .to_string(),
            ));
        }

        let result = self
            .executor
            .sftp_download_with_cancel(connection_id, remote_path, local_path, cancel, None)
            .await
            .map_err(map_app_error)?;

        let json = serde_json::to_string(&result)
            .map_err(|e| McpError::internal_error(format!("JSON serialization failed: {}", e)))?;

        Ok(ToolCallResult::text(json))
    }

    async fn call_sftp_list(
        &self,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResult, McpError> {
        let connection_id = arguments
            .get("connection_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'connection_id'"))?;

        // 默认 "." 而不是 "~"：SFTP 协议不做波浪号展开，
        // 传 "~" 会变成字面目录名 "$HOME/~" 而报 ENOENT。
        // "." 由服务端按会话起始目录（= 登录用户家目录）解析。
        let remote_path = arguments
            .get("remote_path")
            .and_then(|v| v.as_str())
            .unwrap_or(".");

        let list = self
            .executor
            .sftp_list(connection_id, remote_path)
            .await
            .map_err(|e| map_app_error(e))?;

        let json = serde_json::to_string(&list)
            .map_err(|e| McpError::internal_error(format!("JSON serialization failed: {}", e)))?;

        Ok(ToolCallResult::text(json))
    }

    async fn call_sftp_delete(
        &self,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResult, McpError> {
        let connection_id = arguments
            .get("connection_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'connection_id'"))?;

        let remote_path = arguments
            .get("remote_path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'remote_path'"))?;

        let recursive = arguments
            .get("recursive")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let result = self
            .executor
            .sftp_delete(connection_id, remote_path, recursive)
            .await
            .map_err(|e| map_app_error(e))?;

        let json = serde_json::to_string(&result)
            .map_err(|e| McpError::internal_error(format!("JSON serialization failed: {}", e)))?;

        Ok(ToolCallResult::text(json))
    }

    async fn call_task_status(
        &self,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResult, McpError> {
        let task_id = arguments
            .get("task_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'task_id'"))?;
        let snapshot = self
            .executor
            .tasks()
            .task_status(task_id)
            .await
            .map_err(map_app_error)?;
        Ok(ToolCallResult::text(
            serde_json::to_string(&snapshot).map_err(|e| {
                McpError::internal_error(format!("JSON serialization failed: {}", e))
            })?,
        ))
    }

    async fn call_task_list(
        &self,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResult, McpError> {
        let active_only = arguments
            .get("active_only")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let tasks = self.executor.tasks().task_list(active_only).await;
        Ok(ToolCallResult::text(
            serde_json::to_string(&tasks).map_err(|e| {
                McpError::internal_error(format!("JSON serialization failed: {}", e))
            })?,
        ))
    }

    async fn call_task_output(
        &self,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResult, McpError> {
        let task_id = arguments
            .get("task_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'task_id'"))?;
        let offset = arguments
            .get("offset")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as usize;
        let budget = arguments
            .get("budget_bytes")
            .and_then(|v| v.as_u64())
            .unwrap_or(32_000) as usize;
        let output = self
            .executor
            .tasks()
            .task_output(task_id, offset, budget)
            .await
            .map_err(map_app_error)?;
        Ok(ToolCallResult::text(
            serde_json::to_string(&output).map_err(|e| {
                McpError::internal_error(format!("JSON serialization failed: {}", e))
            })?,
        ))
    }

    async fn call_task_cancel(
        &self,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResult, McpError> {
        let task_id = arguments
            .get("task_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'task_id'"))?;
        let snapshot = self
            .executor
            .tasks()
            .task_cancel(task_id)
            .await
            .map_err(map_app_error)?;
        Ok(ToolCallResult::text(
            serde_json::to_string(&snapshot).map_err(|e| {
                McpError::internal_error(format!("JSON serialization failed: {}", e))
            })?,
        ))
    }

    async fn call_get_working_directory(
        &self,
        arguments: serde_json::Value,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<ToolCallResult, McpError> {
        let connection_id = arguments
            .get("connection_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'connection_id'"))?;

        let cwd = self
            .executor
            .get_working_directory_with_cancel(connection_id, cancel)
            .await
            .map_err(|e| map_app_error(e))?;

        let response = json!({
            "connection_id": connection_id,
            "working_directory": cwd
        });

        let json = serde_json::to_string(&response)
            .map_err(|e| McpError::internal_error(format!("JSON serialization failed: {}", e)))?;

        Ok(ToolCallResult::text(json))
    }

    async fn call_create_connection(
        &self,
        arguments: serde_json::Value,
    ) -> Result<ToolCallResult, McpError> {
        let name = arguments
            .get("name")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'name'"))?;

        let host = arguments
            .get("host")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'host'"))?;

        // 端口必须显式校验范围：`as u16` 会把 70000 静默截断成 4464，
        // 于是连接跑到一个完全不相干的端口上——比直接报错难查得多。
        let port = match arguments.get("port").and_then(|v| v.as_u64()) {
            None => 22,
            Some(p) => u16::try_from(p).map_err(|_| {
                McpError::invalid_params(format!("port 超出范围（1-65535）：{}", p))
            })?,
        };
        if port == 0 {
            return Err(McpError::invalid_params("port 不能为 0"));
        }

        let username = arguments
            .get("username")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'username'"))?;

        let auth_method = arguments
            .get("auth_method")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'auth_method'"))?;

        let password = arguments.get("password").and_then(|v| v.as_str());
        let private_key_path = arguments.get("private_key_path").and_then(|v| v.as_str());
        let passphrase = arguments.get("passphrase").and_then(|v| v.as_str());

        // 验证认证参数
        match auth_method {
            "password" => {
                if password.is_none() {
                    return Err(McpError::invalid_params(
                        "auth_method=password requires 'password' field",
                    ));
                }
            }
            "private_key" => {
                if private_key_path.is_none() {
                    return Err(McpError::invalid_params(
                        "auth_method=private_key requires 'private_key_path' field",
                    ));
                }
            }
            _ => {
                return Err(McpError::invalid_params(
                    "auth_method must be 'password' or 'private_key'",
                ));
            }
        }

        let connection_id = self
            .executor
            .create_connection(
                name,
                host,
                port,
                username,
                auth_method,
                password,
                private_key_path,
                passphrase,
            )
            .await
            .map_err(|e| map_app_error(e))?;

        let response = json!({
            "connection_id": connection_id,
            "name": name,
            "host": host,
            "port": port,
            "username": username,
            "temporary": true
        });

        let json = serde_json::to_string(&response)
            .map_err(|e| McpError::internal_error(format!("JSON serialization failed: {}", e)))?;

        Ok(ToolCallResult::text(json))
    }

    async fn call_test_connection(
        &self,
        arguments: serde_json::Value,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<ToolCallResult, McpError> {
        let connection_id = arguments
            .get("connection_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| McpError::invalid_params("Missing 'connection_id'"))?;

        let test_result = self
            .executor
            .test_connection_with_cancel(connection_id, cancel)
            .await
            .map_err(|e| map_app_error(e))?;

        let json = serde_json::to_string(&test_result)
            .map_err(|e| McpError::internal_error(format!("JSON serialization failed: {}", e)))?;

        Ok(ToolCallResult::text(json))
    }
}

/// 将 AppError 映射到 McpError
///
/// 错误码语义见 [`McpError`] 的自定义档（1001–1006）：调用方要能区分
/// 「连接不存在」（换个 id 重试）与「连接失败」（网络/认证问题）。
fn map_app_error(err: AppError) -> McpError {
    match err {
        // 连接不存在：消息本身已经写好了（`Connection not found: <id>`），
        // 这里**原样透传**。再套一次 `connection_not_found()` 会变成
        // "Connection not found: Connection not found: <id>"——它在冒烟测试里
        // 真的发生过，所以判据收敛到共享前缀常量上，不再各写一份字面量。
        AppError::Config(msg) if msg.starts_with(CONNECTION_NOT_FOUND_PREFIX) => McpError {
            code: 1001,
            message: msg,
            data: None,
        },
        AppError::Cancelled(_) => McpError::cancelled(),
        AppError::Ssh(msg) => McpError::connection_failed(msg),
        AppError::Sftp { message, .. } => McpError::file_operation_failed(message),
        AppError::Io(e) => McpError::file_operation_failed(e.to_string()),
        _ => McpError::internal_error(err.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_exec::CommandExecutionManager;
    use crate::config::connections::ConnectionStore;
    use crate::SshManager;

    /// 构造一个不连真实服务器的注册表：执行器指向临时目录的 manager，
    /// 连接表为空。只用于校验 schema 与分发，不触发真实 SSH。
    async fn test_registry() -> (ToolRegistry, Arc<ExternalExecutor>, SshManager) {
        let ssh = SshManager::new();
        let dir = std::env::temp_dir().join(format!("marcel-mcp-test-{}", uuid::Uuid::new_v4()));
        let exec = Arc::new(
            CommandExecutionManager::new(
                ssh.clone(),
                dir.join("jobs_temp"),
                dir.join("ledger.jsonl"),
            )
            .await,
        );
        let store = crate::data::JsonStore::new(&dir, ConnectionStore::new(), None);
        let executor = Arc::new(ExternalExecutor::new(store, exec, Arc::new(ssh.clone())));
        (ToolRegistry::new(executor.clone()), executor, ssh)
    }

    #[tokio::test]
    async fn ssh_execute_auto_fills_sudo_through_the_public_tool_route() {
        let (registry, executor, ssh) = test_registry().await;
        let (_connection, mut channels, mut commands) = ssh
            .register_exec_loopback_session("mcp-loopback", Some("login-secret"))
            .await;
        let connection_id = executor
            .create_connection(
                "回环测试",
                "127.0.0.1",
                22,
                "tester",
                "password",
                Some("login-secret"),
                None,
                None,
            )
            .await
            .unwrap();
        executor
            .register_test_session(&connection_id, "mcp-loopback")
            .await;
        let server = tokio::spawn(async move {
            assert_eq!(
                crate::ssh::sudo_test_support::auto_fill_once(
                    &mut channels,
                    &mut commands,
                    "tester",
                    "sudo id",
                )
                .await,
                "login-secret\n"
            );
        });

        let result = registry
            .call_tool(
                "ssh_execute",
                json!({ "connection_id": connection_id, "command": "sudo id" }),
            )
            .await
            .expect("公共 MCP 入口应完成 sudo 自动填充");
        server.await.unwrap();
        let text = match &result.content[0] {
            crate::mcp_server::protocol::ContentItem::Text { text } => text,
        };
        assert!(text.contains("sudo ok"));
        assert!(text.contains("\"exit_code\":0"));
        assert!(!text.contains("login-secret"));
    }

    #[test]
    fn local_file_tools_can_be_left_out() {
        let names = |local| -> Vec<String> {
            ToolRegistry::base_schemas(local)
                .iter()
                .map(|t| t["name"].as_str().unwrap().to_string())
                .collect()
        };
        let with = names(true);
        let without = names(false);
        assert_eq!(with.len(), 13);
        assert_eq!(without.len(), 11);
        for n in ["sftp_upload", "sftp_download"] {
            assert!(with.iter().any(|x| x == n));
            assert!(!without.iter().any(|x| x == n), "{} 不该出现", n);
        }
        // 只去掉这两个；任务工具属于命令/SFTP 通用能力，两个平台都保留。
        for n in [
            "sftp_list",
            "sftp_delete",
            "task_status",
            "task_list",
            "task_output",
            "task_cancel",
        ] {
            assert!(without.iter().any(|x| x == n), "缺少 {}", n);
        }
    }

    #[tokio::test]
    async fn list_tools_returns_thirteen() {
        let (registry, _, _) = test_registry().await;
        let tools = registry.list_tools();
        assert_eq!(tools.len(), 13, "工具数量变化时同步更新 skill 文档");

        let names: Vec<&str> = tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .collect();
        for expected in [
            "list_connections",
            "ssh_execute",
            "get_working_directory",
            "create_connection",
            "test_connection",
            "sftp_upload",
            "sftp_download",
            "sftp_list",
            "sftp_delete",
            "task_status",
            "task_list",
            "task_output",
            "task_cancel",
        ] {
            assert!(names.contains(&expected), "缺少工具 {}", expected);
        }
    }

    #[test]
    fn transfer_tools_declare_client_timeout_and_background_defaults() {
        let upload = ToolRegistry::sftp_upload_schema();
        let download = ToolRegistry::sftp_download_schema();
        for tool in [&upload, &download] {
            assert_eq!(tool["_meta"]["timeoutMs"], 1_800_000);
            assert_eq!(
                tool["inputSchema"]["properties"]["background"]["default"],
                true
            );
        }
        // ssh_execute 的 background 是三态（true/false/不填），不填才会走 10 秒软超时。
        // 绝不能声明 default，否则按 schema 默认值填 false 的客户端会变成同步等待。
        assert!(
            ToolRegistry::ssh_execute_schema()["inputSchema"]["properties"]["background"]
                .get("default")
                .is_none(),
            "ssh_execute 的 background 三态不能声明 default"
        );
    }

    #[tokio::test]
    async fn every_tool_has_valid_schema() {
        let (registry, _, _) = test_registry().await;
        for tool in registry.list_tools() {
            let name = tool["name"].as_str().expect("工具必须有 name");
            assert!(
                !tool["description"].as_str().unwrap_or("").is_empty(),
                "{} 缺少 description",
                name
            );
            assert_eq!(
                tool["inputSchema"]["type"], "object",
                "{} 的 inputSchema 必须是 object",
                name
            );
            // required 里出现的字段必须真实存在于 properties（否则 client 无法构造合法调用）
            if let Some(required) = tool["inputSchema"]["required"].as_array() {
                let props = tool["inputSchema"]["properties"]
                    .as_object()
                    .expect("有 required 就必须有 properties");
                for field in required {
                    let field = field.as_str().expect("required 项必须是字符串");
                    assert!(
                        props.contains_key(field),
                        "{}: required 字段 {} 不在 properties 中",
                        name,
                        field
                    );
                }
            }
        }
    }

    #[tokio::test]
    async fn ssh_execute_schema_has_required_fields() {
        let schema = ToolRegistry::ssh_execute_schema();
        assert_eq!(schema["name"], "ssh_execute");
        let required = schema["inputSchema"]["required"].as_array().unwrap();
        assert!(required.contains(&json!("connection_id")));
        assert!(required.contains(&json!("command")));
    }

    #[tokio::test]
    async fn task_tools_are_routed_to_the_shared_manager() {
        let (registry, _, _) = test_registry().await;
        let listed = registry.call_tool("task_list", json!({})).await.unwrap();
        let text = match &listed.content[0] {
            crate::mcp_server::protocol::ContentItem::Text { text } => text,
        };
        assert_eq!(text, "[]");

        let err = registry
            .call_tool("task_status", json!({}))
            .await
            .expect_err("缺 task_id 必须报参数错误");
        assert_eq!(err.code, -32602);

        let err = registry
            .call_tool("task_status", json!({"task_id": "missing"}))
            .await
            .expect_err("未知任务必须报错");
        assert!(err.message.contains("没有任务"));
    }

    #[tokio::test]
    async fn sftp_delete_has_recursive_default() {
        let schema = ToolRegistry::sftp_delete_schema();
        assert_eq!(
            schema["inputSchema"]["properties"]["recursive"]["default"],
            false
        );
    }

    #[tokio::test]
    async fn unknown_tool_is_method_not_found() {
        let (registry, _, _) = test_registry().await;
        let err = registry
            .call_tool("no_such_tool", json!({}))
            .await
            .expect_err("未知工具必须报错");
        assert_eq!(err.code, -32601);
    }

    #[tokio::test]
    async fn missing_required_param_is_invalid_params() {
        let (registry, _, _) = test_registry().await;
        let err = registry
            .call_tool("ssh_execute", json!({ "connection_id": "x" }))
            .await
            .expect_err("缺 command 必须报错");
        assert_eq!(err.code, -32602);
    }

    #[tokio::test]
    async fn create_connection_rejects_incomplete_auth() {
        let (registry, _, _) = test_registry().await;

        // Password 档缺 password
        let err = registry
            .call_tool(
                "create_connection",
                json!({
                    "name": "t", "host": "example.com", "username": "u",
                    "auth_method": "password"
                }),
            )
            .await
            .expect_err("Password 档缺 password 必须报错");
        assert_eq!(err.code, -32602);

        // PrivateKey 档缺 private_key_path
        let err = registry
            .call_tool(
                "create_connection",
                json!({
                    "name": "t", "host": "example.com", "username": "u",
                    "auth_method": "private_key"
                }),
            )
            .await
            .expect_err("PrivateKey 档缺路径必须报错");
        assert_eq!(err.code, -32602);

        // 未知认证方式
        let err = registry
            .call_tool(
                "create_connection",
                json!({
                    "name": "t", "host": "example.com", "username": "u",
                    "auth_method": "Magic"
                }),
            )
            .await
            .expect_err("未知认证方式必须报错");
        assert_eq!(err.code, -32602);
    }

    #[tokio::test]
    async fn create_connection_registers_temp_connection() {
        let (registry, _, _) = test_registry().await;

        let created = registry
            .call_tool(
                "create_connection",
                json!({
                    "name": "临时机", "host": "temp.example.com", "port": 2222,
                    "username": "deploy", "auth_method": "password", "password": "secret"
                }),
            )
            .await
            .expect("创建临时连接应成功");

        // 返回体里应带 connection_id 且标记为临时
        let text = match &created.content[0] {
            crate::mcp_server::protocol::ContentItem::Text { text } => text.clone(),
        };
        let parsed: serde_json::Value = serde_json::from_str(&text).unwrap();
        let id = parsed["connection_id"]
            .as_str()
            .expect("必须有 connection_id");
        assert!(id.starts_with("mcp-temp-"), "临时连接 id 应有前缀: {}", id);
        assert_eq!(parsed["temporary"], true);

        // 关键：临时连接必须能被 list_connections 看见（共享 JsonStore，不是快照）
        let listed = registry
            .call_tool("list_connections", json!({}))
            .await
            .expect("list_connections 应成功");
        let text = match &listed.content[0] {
            crate::mcp_server::protocol::ContentItem::Text { text } => text.clone(),
        };
        let conns: Vec<serde_json::Value> = serde_json::from_str(&text).unwrap();
        assert!(
            conns.iter().any(|c| c["id"] == id),
            "临时连接必须出现在 list_connections 中"
        );
    }

    #[tokio::test]
    async fn list_connections_hides_credentials() {
        let (registry, _, _) = test_registry().await;
        let created = registry
            .call_tool(
                "create_connection",
                json!({
                    "name": "secret-host", "host": "h.example.com", "username": "u",
                    "auth_method": "password", "password": "hunter2"
                }),
            )
            .await
            .unwrap();
        assert!(created.is_error.is_none());

        let listed = registry
            .call_tool("list_connections", json!({}))
            .await
            .unwrap();
        let text = match &listed.content[0] {
            crate::mcp_server::protocol::ContentItem::Text { text } => text.clone(),
        };
        // 密码绝不能出现在对外返回里
        assert!(
            !text.contains("hunter2"),
            "list_connections 不得泄漏密码: {}",
            text
        );
        assert!(!text.to_lowercase().contains("password"));
        assert!(!text.to_lowercase().contains("key"));
    }

    /// 构造一个**带 remote_subagent** 的注册表（config_dir 指向临时目录）。
    async fn test_registry_with_agent_tasks() -> Arc<ToolRegistry> {
        let ssh = SshManager::new();
        let dir = std::env::temp_dir().join(format!("marcel-mcp-agent-{}", uuid::Uuid::new_v4()));
        let exec = Arc::new(
            CommandExecutionManager::new(
                ssh.clone(),
                dir.join("jobs_temp"),
                dir.join("ledger.jsonl"),
            )
            .await,
        );
        let store = crate::data::JsonStore::new(&dir, ConnectionStore::new(), None);
        let executor = Arc::new(ExternalExecutor::new(store, exec, Arc::new(ssh)));
        ToolRegistry::new_with_agent_tasks(executor, dir)
    }

    fn tool_names(tools: &[serde_json::Value]) -> Vec<String> {
        tools
            .iter()
            .filter_map(|t| t.get("name").and_then(|v| v.as_str()))
            .map(str::to_string)
            .collect()
    }

    #[tokio::test]
    async fn agent_task_listed_only_when_runner_exists() {
        // 无 runner：不列 remote_subagent——列了就是给客户端一个必然失败的入口
        let base = test_registry().await.0.list_tools();
        assert_eq!(base.len(), 13);
        assert!(!tool_names(&base).contains(&AGENT_TASK_TOOL.to_string()));

        // 有 runner：清单里必须出现，且 schema 合法
        let with_agent = test_registry_with_agent_tasks().await.list_tools();
        assert_eq!(with_agent.len(), 14, "接上 LLM 后应变成 14 个工具");
        assert!(tool_names(&with_agent).contains(&AGENT_TASK_TOOL.to_string()));

        let schema = with_agent
            .iter()
            .find(|t| t["name"] == AGENT_TASK_TOOL)
            .expect("remote_subagent 必须出现在清单里");
        let required = schema["inputSchema"]["required"].as_array().unwrap();
        assert!(required.contains(&json!("connection_id")));
        assert!(required.contains(&json!("task")));
    }

    #[tokio::test]
    async fn agent_task_call_without_runner_is_method_not_found() {
        // 没接 LLM 时调用 remote_subagent：如实报「没这个方法」，
        // 而不是内部错误——调用方据此知道换 tools/list 看看有什么
        let (registry, _, _) = test_registry().await;
        let err = registry
            .call_tool(AGENT_TASK_TOOL, json!({"connection_id": "x", "task": "y"}))
            .await
            .expect_err("未接 LLM 时 remote_subagent 应不可用");
        assert_eq!(err.code, -32601);
    }

    #[tokio::test]
    async fn connection_not_found_message_is_not_double_prefixed() {
        // 回归测试：这里曾经产出
        // "Connection not found: Connection not found: <id>"（冒烟测试抓到）
        let (registry, _, _) = test_registry().await;
        let err = registry
            .call_tool(
                "ssh_execute",
                json!({ "connection_id": "does-not-exist", "command": "ls" }),
            )
            .await
            .expect_err("不存在的连接必须报错");

        assert_eq!(err.code, 1001, "连接不存在应是 1001 而不是内部错误");
        assert_eq!(
            err.message, "Connection not found: does-not-exist",
            "前缀不得重复"
        );
        assert_eq!(
            err.message.matches(CONNECTION_NOT_FOUND_PREFIX).count(),
            1,
            "前缀只能出现一次"
        );
    }
}
