// 外部调用执行器
//
// 为外部 MCP client 提供的独立执行路径。
//
// 架构边界：
// - 直接使用 `SshManager` 的无头连接（`connect_headless`）+ `command_exec`
// - 不经过 agent 工具层（那是给内置 agent 用的）
// - **不经过命令风险评估**：外部 agent 被视为可信（用户显式把它接进来的），
//   命令安全由调用方自负其责。这一条是产品决策，不是遗漏——见
//   `CommandSource::ExternalMcp` 与 `docs/mcp-server.md` 的安全说明。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as TokioMutex;
use tokio::sync::RwLock as TokioRwLock;

use crate::command_exec::{CommandExecutionManager, CommandSource, CommandTicket, SubmitOutcome};
use crate::config::connections::{ConnectionStore, SavedConnection};
use crate::error::AppError;
use crate::mcp_server::sftp_ops::{FileInfo, SftpExecutor, TransferResult};
use crate::ssh::auth::AuthMethod;
use crate::ssh::connection::ConnectionConfig;
use crate::SshManager;

/// 「连接不存在」错误的前缀。
///
/// **唯一权威来源**：`external_executor` 按它造错误，`tools::map_app_error`
/// 按它判 1001 错误码。两边各写一份字面量迟早会漂移——漂移的后果是错误码
/// 悄悄退化成 -32603（内部错误），调用方再也分不清「id 打错了」和「服务炸了」。
pub const CONNECTION_NOT_FOUND_PREFIX: &str = "Connection not found: ";

/// 构造「连接不存在」错误。
pub fn connection_not_found_err(connection_id: &str) -> AppError {
    AppError::Config(format!("{}{}", CONNECTION_NOT_FOUND_PREFIX, connection_id))
}

/// 这个错误是不是「会话本身没了」。
///
/// 判据来自 `command_exec::executor::run_raw` 与 `SshManager` 的文案：
/// 会话查不到、开 exec 通道失败、通道以 None 结束（会话死亡）。
/// 只有这几类才值得丢掉缓存重建——命令自身报错（非零退出、命令超时）
/// 重试是没意义的，反而会重复副作用。
fn is_dead_session_error(err: &AppError) -> bool {
    let msg = err.to_string();
    msg.contains("会话不存在")
        || msg.contains("打开 exec 通道失败")
        || msg.contains("SSH 连接已断开")
}

/// 外部调用执行器
pub struct ExternalExecutor {
    /// 连接表。用 **tokio 的 RwLock** 而不是 parking_lot：GUI 内启动 MCP 服务时
    /// 要直接复用 `AppState.connection_store` 那一份（AppState 用的是 tokio 锁），
    /// 共用同一个实例才能让「GUI 里新增的连接」立刻对 MCP 调用可见。
    /// 若各持一份快照，用户在界面上加完连接、外部 agent 却看不到，是极难查的坑。
    connection_store: Arc<TokioRwLock<ConnectionStore>>,
    command_exec: Arc<CommandExecutionManager>,
    ssh_manager: Arc<SshManager>,
    sftp_executor: SftpExecutor,
    /// `connection_id → session_id`：无头会话复用。
    ///
    /// 每次调用都重连一遍会让「执行 10 条命令」变成 10 次完整握手；缓存后
    /// 一个连接只握手一次。会话死了（get_connection 查不到）就重建。
    sessions: TokioMutex<HashMap<String, String>>,
    /// 临时连接（`create_connection` 建的）的凭据，**只在内存**。
    ///
    /// 刻意不写系统密钥链：临时连接的语义就是「随进程生灭」，
    /// 落盘反而制造出没人清理的凭据残留。
    temp_auth: RwLock<HashMap<String, AuthMethod>>,
}

/// 连接信息（不含敏感数据）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionInfo {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 是否是本进程内临时创建、未落盘的连接
    pub temporary: bool,
}

/// 命令执行结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

/// 连接测试结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestConnectionResult {
    pub status: String,
    pub latency_ms: u64,
    pub server_version: Option<String>,
    pub error: Option<String>,
}

impl ExternalExecutor {
    pub fn new(
        connection_store: Arc<TokioRwLock<ConnectionStore>>,
        command_exec: Arc<CommandExecutionManager>,
        ssh_manager: Arc<SshManager>,
    ) -> Self {
        let sftp_executor = SftpExecutor::new(ssh_manager.clone());
        Self {
            connection_store,
            command_exec,
            ssh_manager,
            sftp_executor,
            sessions: TokioMutex::new(HashMap::new()),
            temp_auth: RwLock::new(HashMap::new()),
        }
    }

    /// 列出所有连接（不含敏感信息）
    pub async fn list_connections(&self) -> Result<Vec<ConnectionInfo>, AppError> {
        let temp_ids: Vec<String> = self.temp_auth.read().keys().cloned().collect();
        let store = self.connection_store.read().await;
        Ok(store
            .get_all()
            .iter()
            .map(|conn| ConnectionInfo {
                id: conn.id.clone(),
                name: conn.name.clone(),
                host: conn.host.clone(),
                port: conn.port,
                user: conn.username.clone(),
                temporary: temp_ids.contains(&conn.id),
            })
            .collect())
    }

    /// 该连接是否在册（已保存的 + 本进程创建的临时连接）。
    ///
    /// 给 `agent_task` 做前置校验用：连接 id 写错时当场拒绝，比让模型
    /// 烧掉两轮工具调用才发现要便宜得多。
    pub async fn connection_exists(&self, connection_id: &str) -> bool {
        self.connection_store
            .read()
            .await
            .get_by_id(connection_id)
            .is_some()
    }

    /// 取已保存的连接（克隆一份，避免持锁跨 await）。
    async fn saved_connection(&self, connection_id: &str) -> Result<SavedConnection, AppError> {
        let store = self.connection_store.read().await;
        store
            .get_by_id(connection_id)
            .cloned()
            .ok_or_else(|| connection_not_found_err(connection_id))
    }

    /// 取得（必要时建立）该连接的无头会话，返回 `session_id`。
    ///
    /// 复用规则：缓存里有、且 `SshManager` 里那一代会话仍在 → 直接用；
    /// 否则重新握手。会话死亡不需要调用方感知，这里透明重建。
    async fn ensure_session(&self, connection_id: &str) -> Result<String, AppError> {
        {
            let sessions = self.sessions.lock().await;
            if let Some(session_id) = sessions.get(connection_id) {
                if self.ssh_manager.get_connection(session_id).await.is_some() {
                    return Ok(session_id.clone());
                }
            }
        }

        let config = self.build_connection_config(connection_id).await?;
        let session_id = self.ssh_manager.connect_headless(config).await?;

        log::info!(
            "[MCP External] 无头会话建立: connection={} → session={}",
            connection_id,
            session_id
        );

        self.sessions
            .lock()
            .await
            .insert(connection_id.to_string(), session_id.clone());

        Ok(session_id)
    }

    /// 装配连接配置：临时连接用内存里的凭据，已保存的连接走共享的
    /// 「密钥链 → 配置」装配（与 `ssh_reconnect` 同一处，见
    /// [`crate::commands::ssh::build_saved_connection_config`]）。
    async fn build_connection_config(
        &self,
        connection_id: &str,
    ) -> Result<ConnectionConfig, AppError> {
        let saved = self.saved_connection(connection_id).await?;

        let temp = self.temp_auth.read().get(connection_id).cloned();
        let Some(auth_method) = temp else {
            return crate::commands::ssh::build_saved_connection_config(&saved, connection_id, false);
        };

        Ok(ConnectionConfig {
            host: saved.host,
            port: saved.port,
            username: saved.username,
            auth_method,
            connection_id: Some(connection_id.to_string()),
            trust_new_host_key: false,
            // 临时连接不支持跳板机（外部调用没有配置跳板机的入口）
            jump: None,
        })
    }

    /// 执行 SSH 命令（不经过风险评估）
    pub async fn execute_command(
        &self,
        connection_id: &str,
        command: &str,
        timeout_ms: Option<u64>,
    ) -> Result<CommandOutput, AppError> {
        log::info!(
            "[MCP External] execute_command: connection={}, timeout={:?}ms",
            connection_id,
            timeout_ms
        );

        let session_id = self.ensure_session(connection_id).await?;

        match self.submit_on(&session_id, command, timeout_ms).await {
            Ok(out) => Ok(out),
            Err(e) if is_dead_session_error(&e) => {
                // 会话可能在两次调用之间死掉（网络抖动、服务端超时踢人）。
                // 缓存里的那一代此时已经没用了：丢掉、重建、重试一次。
                //
                // 这正是不必每次调用都探活的原因——代价只在真的坏掉时付一次，
                // 而不是每次都多开一条通道去问「你还活着吗」。
                log::info!(
                    "[MCP External] 会话 {} 已失效（{}），重建后重试一次",
                    session_id,
                    e
                );
                self.sessions.lock().await.remove(connection_id);
                let fresh = self.ensure_session(connection_id).await?;
                self.submit_on(&fresh, command, timeout_ms).await
            }
            Err(e) => Err(e),
        }
    }

    /// 在指定会话上跑一条命令并归一化结果。
    async fn submit_on(
        &self,
        session_id: &str,
        command: &str,
        timeout_ms: Option<u64>,
    ) -> Result<CommandOutput, AppError> {
        let ticket = CommandTicket::new(session_id, command, CommandSource::ExternalMcp).timeout(
            timeout_ms
                .map(Duration::from_millis)
                .unwrap_or(Duration::from_secs(30)),
        );

        // 无 AppHandle：无头路径没有流式事件可言，`submit_opt` 正是为此准备的。
        match self.command_exec.submit_opt(None, ticket).await {
            SubmitOutcome::Completed { output, exit } => Ok(CommandOutput {
                stdout: output,
                stderr: String::new(), // exec 通道 stdout/stderr 合流，见 executor 模块注释
                exit_code: exit.code.unwrap_or(1) as i32,
            }),
            SubmitOutcome::TimedOut { output } => Err(AppError::Agent(format!(
                "Command timed out。已收到的部分输出：{}",
                output
            ))),
            SubmitOutcome::Cancelled { reason } => {
                Err(AppError::Agent(format!("Command cancelled: {:?}", reason)))
            }
            SubmitOutcome::Failed { error } => Err(error),
        }
    }

    /// 获取会话的当前工作目录（用于相对路径解析）
    pub async fn get_working_directory(&self, connection_id: &str) -> Result<String, AppError> {
        let result = self.execute_command(connection_id, "pwd", Some(10_000)).await?;

        if result.exit_code != 0 {
            return Err(AppError::Agent(format!(
                "获取工作目录失败: {}",
                result.stdout
            )));
        }

        Ok(result.stdout.trim().to_string())
    }

    /// 动态创建临时连接（不保存到配置文件）
    ///
    /// 凭据只留在本进程内存里，进程结束即消失。返回的 connection_id
    /// 可立即用于 `ssh_execute` / `sftp_*`。
    pub async fn create_connection(
        &self,
        name: &str,
        host: &str,
        port: u16,
        username: &str,
        auth_method: &str,
        password: Option<&str>,
        private_key_path: Option<&str>,
        passphrase: Option<&str>,
    ) -> Result<String, AppError> {
        // 外部契约是小写（见工具 schema 的 enum），内部 SavedConnection 用
        // 首字母大写——在边界处转换，两边各自保持自己的约定。
        let (auth, stored_auth_method) = match auth_method {
            "password" => {
                let password = password.ok_or_else(|| {
                    AppError::Config("auth_method=password 需要 password".into())
                })?;
                (
                    AuthMethod::Password {
                        password: password.to_string(),
                    },
                    "Password",
                )
            }
            "private_key" => {
                let key_path = private_key_path.ok_or_else(|| {
                    AppError::Config("auth_method=private_key 需要 private_key_path".into())
                })?;
                (
                    AuthMethod::PrivateKey {
                        key_id: None,
                        key_path: Some(key_path.to_string()),
                        passphrase: passphrase.map(str::to_string),
                    },
                    "PrivateKey",
                )
            }
            other => {
                return Err(AppError::Config(format!(
                    "不支持的认证方式: {}（应为 password 或 private_key）",
                    other
                )))
            }
        };

        let connection_id = format!("mcp-temp-{}", uuid::Uuid::new_v4());

        {
            let mut store = self.connection_store.write().await;
            store.add(SavedConnection {
                id: connection_id.clone(),
                name: name.to_string(),
                host: host.to_string(),
                port,
                username: username.to_string(),
                auth_method: stored_auth_method.to_string(),
                key_path: private_key_path.map(str::to_string),
                key_id: None,
                group: None,
                last_connected: None,
                use_jump: false,
                jump_host: None,
                jump_port: None,
                jump_username: None,
                jump_auth_method: None,
                jump_key_path: None,
                jump_key_id: None,
            });
        }

        self.temp_auth.write().insert(connection_id.clone(), auth);

        log::info!(
            "[MCP External] 临时连接已创建: {} ({}@{}:{})",
            connection_id,
            username,
            host,
            port
        );

        Ok(connection_id)
    }

    /// 测试连接可用性
    ///
    /// 只读诊断：建会话 + 跑一条 `echo`，把「连不上」与「连上了但命令跑不动」
    /// 都如实报出来，而不是让调用方从后续操作的失败里去猜。
    pub async fn test_connection(
        &self,
        connection_id: &str,
    ) -> Result<TestConnectionResult, AppError> {
        let start = std::time::Instant::now();

        // 建会话本身失败（网络/认证/主机密钥）——直接如实上报
        let session_id = match self.ensure_session(connection_id).await {
            Ok(id) => id,
            Err(e) => {
                return Ok(TestConnectionResult {
                    status: "failed".to_string(),
                    latency_ms: start.elapsed().as_millis() as u64,
                    server_version: None,
                    error: Some(e.to_string()),
                })
            }
        };

        let probe = self
            .execute_command(connection_id, "echo OK", Some(10_000))
            .await;

        let latency_ms = start.elapsed().as_millis() as u64;

        match probe {
            Ok(out) if out.exit_code == 0 && out.stdout.trim() == "OK" => {
                // 会话既已建立，顺手取一次远端版本（失败不影响结论）
                let version = self
                    .execute_command(connection_id, "uname -sr", Some(5_000))
                    .await
                    .ok()
                    .map(|o| o.stdout.trim().to_string())
                    .filter(|s| !s.is_empty());

                let _ = session_id;
                Ok(TestConnectionResult {
                    status: "connected".to_string(),
                    latency_ms,
                    server_version: version,
                    error: None,
                })
            }
            Ok(out) => Ok(TestConnectionResult {
                status: "failed".to_string(),
                latency_ms,
                server_version: None,
                error: Some(format!(
                    "命令返回非预期结果：exit_code={}, stdout={}",
                    out.exit_code, out.stdout
                )),
            }),
            Err(e) => Ok(TestConnectionResult {
                status: "failed".to_string(),
                latency_ms,
                server_version: None,
                error: Some(e.to_string()),
            }),
        }
    }

    // ========== SFTP ==========

    pub async fn sftp_upload(
        &self,
        connection_id: &str,
        local_path: &str,
        remote_path: &str,
    ) -> Result<TransferResult, AppError> {
        let session_id = self.ensure_session(connection_id).await?;
        self.sftp_executor
            .upload(&session_id, local_path, remote_path)
            .await
    }

    pub async fn sftp_download(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &str,
    ) -> Result<TransferResult, AppError> {
        let session_id = self.ensure_session(connection_id).await?;
        self.sftp_executor
            .download(&session_id, remote_path, local_path)
            .await
    }

    pub async fn sftp_list(
        &self,
        connection_id: &str,
        remote_path: &str,
    ) -> Result<Vec<FileInfo>, AppError> {
        let session_id = self.ensure_session(connection_id).await?;
        self.sftp_executor.list(&session_id, remote_path).await
    }

    pub async fn sftp_delete(
        &self,
        connection_id: &str,
        remote_path: &str,
        recursive: bool,
    ) -> Result<(), AppError> {
        let session_id = self.ensure_session(connection_id).await?;
        self.sftp_executor
            .delete(&session_id, remote_path, recursive)
            .await
    }

    /// 收尾：关掉本执行器建立的全部无头会话。
    ///
    /// 进程退出前调用，避免留下没人认领的会话条目。
    pub async fn shutdown(&self) {
        let session_ids: Vec<String> = self.sessions.lock().await.drain().map(|(_, v)| v).collect();
        for session_id in session_ids {
            self.ssh_manager.disconnect_headless(&session_id).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dead_session_errors_are_classified_for_retry() {
        // 只有「会话没了」才值得丢缓存重连。判据来自 command_exec 与
        // SshManager 的文案——文案改了这里必须跟着改，否则自愈会悄悄失效。
        assert!(is_dead_session_error(&AppError::Ssh(
            "会话不存在: abc".into()
        )));
        assert!(is_dead_session_error(&AppError::Ssh(
            "打开 exec 通道失败: 通道关闭".into()
        )));
        assert!(is_dead_session_error(&AppError::Ssh(
            "SSH 连接已断开".into()
        )));
    }

    #[test]
    fn command_errors_are_not_retried() {
        // 命令自身的失败重试没有意义，还可能有副作用（重复执行写操作）
        assert!(!is_dead_session_error(&AppError::Agent(
            "Command timed out".into()
        )));
        assert!(!is_dead_session_error(&AppError::Config(
            "Connection not found: x".into()
        )));
        assert!(!is_dead_session_error(&AppError::Ssh(
            "读取文件失败".into()
        )));
    }

    #[test]
    fn connection_not_found_error_carries_the_shared_prefix() {
        let err = connection_not_found_err("conn-7");
        assert!(err.to_string().contains(CONNECTION_NOT_FOUND_PREFIX));
        assert!(err.to_string().contains("conn-7"));
    }

    #[tokio::test]
    async fn connection_exists_reflects_the_store() {
        let ssh = crate::SshManager::new();
        let dir = std::env::temp_dir().join(format!("marcel-exec-test-{}", uuid::Uuid::new_v4()));
        let exec_mgr = Arc::new(
            CommandExecutionManager::new(
                ssh.clone(),
                dir.join("jobs_temp"),
                dir.join("ledger.jsonl"),
            )
            .await,
        );
        let store = Arc::new(TokioRwLock::new(ConnectionStore::new()));
        let executor = ExternalExecutor::new(store.clone(), exec_mgr, Arc::new(ssh));

        // 空表：查不到
        assert!(!executor.connection_exists("nope").await);

        // 建一条临时连接后：查得到（这是 agent_task 前置校验的依据）
        let id = executor
            .create_connection(
                "t", "example.com", 22, "u", "password", Some("pw"), None, None,
            )
            .await
            .expect("建临时连接应成功");
        assert!(executor.connection_exists(&id).await);

        // 关键：临时连接必须能被看见——store 是共享锁而不是快照
        let listed = executor.list_connections().await.unwrap();
        assert!(listed.iter().any(|c| c.id == id && c.temporary));
    }

    #[tokio::test]
    async fn create_connection_rejects_bad_auth_method() {
        let ssh = crate::SshManager::new();
        let dir = std::env::temp_dir().join(format!("marcel-exec-test-{}", uuid::Uuid::new_v4()));
        let exec_mgr = Arc::new(
            CommandExecutionManager::new(
                ssh.clone(),
                dir.join("jobs_temp"),
                dir.join("ledger.jsonl"),
            )
            .await,
        );
        let store = Arc::new(TokioRwLock::new(ConnectionStore::new()));
        let executor = ExternalExecutor::new(store, exec_mgr, Arc::new(ssh));

        // 大小写在边界处归一：内部存 "Password"，外部只认小写 "password"
        let id = executor
            .create_connection("t", "h.example.com", 22, "u", "password", Some("pw"), None, None)
            .await
            .unwrap();
        let saved = executor.saved_connection(&id).await.unwrap();
        assert_eq!(
            saved.auth_method, "Password",
            "内部 SavedConnection 用首字母大写，与 GUI 侧一致"
        );

        let err = executor
            .create_connection("t", "h.example.com", 22, "u", "PASSWORD", Some("pw"), None, None)
            .await
            .expect_err("大写不该被接受——外部契约是小写");
        assert!(err.to_string().contains("password"));
    }
}
