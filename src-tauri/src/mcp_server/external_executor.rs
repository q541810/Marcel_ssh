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
use tokio::sync::{watch, Mutex as TokioMutex};

use crate::command_exec::{
    CancelReason, CommandExecutionManager, CommandSource, CommandTicket, DetachableOutcome,
    JobStatus, SubmitOutcome,
};
use crate::config::connections::{ConnectionStore, SavedConnection};
use crate::data::JsonStore;
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
    /// 连接表。GUI 内启动 MCP 服务时要直接复用 `AppState.connection_store` 那一份
    /// （`JsonStore` 的 `Clone` 共享同一份数据），共用同一个实例才能让「GUI 里新增的
    /// 连接」立刻对 MCP 调用可见。若各持一份快照，用户在界面上加完连接、外部 agent
    /// 却看不到，是极难查的坑。
    connection_store: JsonStore<ConnectionStore>,
    command_exec: Arc<CommandExecutionManager>,
    ssh_manager: Arc<SshManager>,
    sftp_executor: SftpExecutor,
    /// MCP 统一任务台账：命令作业投影 + 自管上传/下载/agent 任务。
    tasks: super::tasks::TaskManager,
    /// `connection_id → session_id`：无头会话复用。
    ///
    /// 每次调用都重连一遍会让「执行 10 条命令」变成 10 次完整握手；缓存后
    /// 一个连接只握手一次。会话死了（get_connection 查不到）就重建。
    sessions: TokioMutex<HashMap<String, String>>,
    /// 每 connection_id 一把建连锁。并发请求不能在同一个连接上各握手一次：
    /// 后写覆盖先写会让前一条会话从缓存里消失，收尾时漏关。
    session_locks: TokioMutex<HashMap<String, Arc<TokioMutex<()>>>>,
    /// 同目标传输锁：同一远端文件/同一本地落点不许并发提交，避免临时文件
    /// 清理与 rename/回滚互相破坏。不同目标仍可并行。
    target_locks: TokioMutex<HashMap<String, Arc<TokioMutex<()>>>>,
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
    /// 兼容字段。只有 `exit_code_known=true` 时才是远端真实退出码。
    pub exit_code: i32,
    /// 远端是否真的发了 exit-status。为 false 时 `exit_code` 是占位值 1，
    /// 调用方不得据此判断命令失败。
    pub exit_code_known: bool,
}

/// `ssh_execute` 的两种返回：真正跑完，或已转为后台任务。
pub enum CommandExecutionOutcome {
    Finished(CommandOutput),
    Detached { job_id: String, output: String },
}

fn command_output(outcome: SubmitOutcome) -> Result<CommandOutput, AppError> {
    match outcome {
        SubmitOutcome::Completed { output, exit } => Ok(CommandOutput {
            stdout: output,
            stderr: String::new(),
            exit_code: exit.code.unwrap_or(1) as i32,
            exit_code_known: exit.code.is_some(),
        }),
        SubmitOutcome::TimedOut { output } => Err(AppError::Agent(format!(
            "Command timed out。已收到的部分输出：{}",
            output
        ))),
        SubmitOutcome::Cancelled { reason } => {
            Err(AppError::Cancelled(format!("命令已取消（{:?}）", reason)))
        }
        SubmitOutcome::Failed { error } => Err(error),
    }
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
        connection_store: JsonStore<ConnectionStore>,
        command_exec: Arc<CommandExecutionManager>,
        ssh_manager: Arc<SshManager>,
    ) -> Self {
        let sftp_executor = SftpExecutor::new(ssh_manager.clone());
        let tasks = super::tasks::TaskManager::new(command_exec.clone());
        Self {
            connection_store,
            command_exec,
            ssh_manager,
            sftp_executor,
            tasks,
            sessions: TokioMutex::new(HashMap::new()),
            session_locks: TokioMutex::new(HashMap::new()),
            target_locks: TokioMutex::new(HashMap::new()),
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

    #[cfg(test)]
    pub(crate) async fn register_test_session(&self, connection_id: &str, session_id: &str) {
        self.sessions
            .lock()
            .await
            .insert(connection_id.to_string(), session_id.to_string());
    }

    /// 取得（必要时建立）该连接的无头会话，返回 `session_id`。
    ///
    /// 复用规则：缓存里有、且 `SshManager` 里那一代会话仍在 → 直接用；
    /// 否则重新握手。会话死亡不需要调用方感知，这里透明重建。
    async fn ensure_session(&self, connection_id: &str) -> Result<String, AppError> {
        let connect_lock = {
            self.session_locks
                .lock()
                .await
                .entry(connection_id.to_string())
                .or_insert_with(|| Arc::new(TokioMutex::new(())))
                .clone()
        };
        let _connect_guard = connect_lock.lock().await;

        // 拿到本连接的锁后二次检查：另一路并发请求可能刚建好。
        {
            let sessions = self.sessions.lock().await;
            if let Some(session_id) = sessions.get(connection_id) {
                if self.ssh_manager.get_connection(session_id).await.is_some() {
                    self.tasks.remember_session(connection_id, session_id);
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
        self.tasks.remember_session(connection_id, &session_id);

        Ok(session_id)
    }

    async fn target_guard(&self, key: String) -> tokio::sync::OwnedMutexGuard<()> {
        let lock = {
            self.target_locks
                .lock()
                .await
                .entry(key)
                .or_insert_with(|| Arc::new(TokioMutex::new(())))
                .clone()
        };
        lock.lock_owned().await
    }

    /// 只失效「仍然是刚才失败那一代」的缓存。两个请求同时发现旧会话死亡时，
    /// 先重建成功的那一代不能被后到者无条件删掉。
    async fn invalidate_session_if_matches(&self, connection_id: &str, failed_session_id: &str) {
        let mut sessions = self.sessions.lock().await;
        if sessions.get(connection_id).map(String::as_str) == Some(failed_session_id) {
            sessions.remove(connection_id);
        }
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
            return crate::commands::ssh::build_saved_connection_config(
                &saved,
                connection_id,
                false,
            );
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
        self.execute_command_with_cancel(connection_id, command, timeout_ms, None)
            .await
    }

    pub async fn execute_command_with_cancel(
        &self,
        connection_id: &str,
        command: &str,
        timeout_ms: Option<u64>,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<CommandOutput, AppError> {
        log::info!(
            "[MCP External] execute_command: connection={}, timeout={:?}ms",
            connection_id,
            timeout_ms
        );

        self.run_with_dead_session_retry(connection_id, cancel.clone(), |session_id| {
            let cancel = cancel.clone();
            async move {
                self.submit_on(&session_id, command, timeout_ms, cancel)
                    .await
            }
        })
        .await
    }

    /// 执行一次依赖无头会话的操作；遇到「会话已死」且当前请求尚未取消时，
    /// 失效匹配缓存、重建会话并重试一次。
    async fn run_with_dead_session_retry<T, F, Fut>(
        &self,
        connection_id: &str,
        cancel: Option<watch::Receiver<bool>>,
        op: F,
    ) -> Result<T, AppError>
    where
        F: Fn(String) -> Fut,
        Fut: std::future::Future<Output = Result<T, AppError>>,
    {
        if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
            return Err(AppError::Cancelled("请求已取消".into()));
        }
        let session_id = self.ensure_session(connection_id).await?;
        if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
            return Err(AppError::Cancelled("请求已取消".into()));
        }

        match op(session_id.clone()).await {
            Ok(out) => Ok(out),
            Err(e)
                if is_dead_session_error(&e)
                    && !cancel.as_ref().is_some_and(|rx| *rx.borrow()) =>
            {
                // 会话可能在两次调用之间死掉（网络抖动、服务端超时踢人）。
                // 缓存里的那一代此时已经没用了：丢掉、重建、重试一次。
                // 只删「仍等于失败那一代」的缓存，避免踩掉另一请求刚建好的新会话。
                log::info!(
                    "[MCP External] 会话 {} 已失效（{}），重建后重试一次",
                    session_id,
                    e
                );
                self.invalidate_session_if_matches(connection_id, &session_id)
                    .await;
                let fresh = self.ensure_session(connection_id).await?;
                if cancel.as_ref().is_some_and(|rx| *rx.borrow()) {
                    return Err(AppError::Cancelled("请求已取消".into()));
                }
                op(fresh).await
            }
            Err(e) => Err(e),
        }
    }

    /// 执行命令；超过 `soft_timeout` 未结束时原地转后台任务。
    ///
    /// - `force_background=true`：立即交给后台作业，不等软超时；
    /// - 显式 `timeout_ms`：作为命令总时限，转后台后按**剩余时间**终止；
    /// - 未显式给时限：转后台后沿用后台作业的长周期保险丝。
    pub async fn execute_command_task(
        &self,
        connection_id: &str,
        command: &str,
        timeout_ms: Option<u64>,
        soft_timeout: Duration,
        force_background: bool,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<CommandExecutionOutcome, AppError> {
        self.run_with_dead_session_retry(connection_id, cancel.clone(), |session_id| {
            let cancel = cancel.clone();
            async move {
                self.execute_command_task_on(
                    &session_id,
                    command,
                    timeout_ms,
                    soft_timeout,
                    force_background,
                    cancel,
                )
                .await
            }
        })
        .await
    }

    async fn execute_command_task_on(
        &self,
        session_id: &str,
        command: &str,
        timeout_ms: Option<u64>,
        soft_timeout: Duration,
        force_background: bool,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<CommandExecutionOutcome, AppError> {
        let task_tag = format!("mcp-task:{}", uuid::Uuid::new_v4());
        let base_ticket = CommandTicket::new(session_id, command, CommandSource::ExternalMcp)
            .cancellable(&task_tag, "MCP 请求已取消");

        if force_background {
            let job = self
                .command_exec
                .submit_background(None, base_ticket, None)
                .await?;
            self.schedule_hard_timeout(&job.job_id, timeout_ms.map(Duration::from_millis));
            return Ok(CommandExecutionOutcome::Detached {
                job_id: job.job_id,
                output: String::new(),
            });
        }

        // 显式时限不超过软超时时直接在时限处结束，不制造一个马上要被杀的作业。
        if let Some(ms) = timeout_ms.filter(|&ms| Duration::from_millis(ms) <= soft_timeout) {
            let ticket = base_ticket.timeout(Duration::from_millis(ms));
            return command_output(
                self.command_exec
                    .submit_opt_with_cancel(None, ticket, cancel)
                    .await,
            )
            .map(CommandExecutionOutcome::Finished);
        }

        // `submit_detachable_with_cancel` 把 `ticket.timeout` 当作转后台前的软超时，
        // 绝不能把更大的 `timeout_ms` 塞进去——否则会等到 `timeout_ms` 才转后台，再睡一次总时限。
        let started = std::time::Instant::now();
        let ticket = base_ticket.timeout(soft_timeout);
        match self
            .command_exec
            .submit_detachable_with_cancel(None, ticket, None, cancel)
            .await
        {
            DetachableOutcome::Finished(outcome) => {
                command_output(outcome).map(CommandExecutionOutcome::Finished)
            }
            DetachableOutcome::Detached { job, output } => {
                let remaining = timeout_ms
                    .map(|ms| Duration::from_millis(ms).saturating_sub(started.elapsed()));
                self.schedule_hard_timeout(&job.job_id, remaining);
                Ok(CommandExecutionOutcome::Detached {
                    job_id: job.job_id,
                    output,
                })
            }
        }
    }

    /// 转后台后，显式总时限仍然有效。只在这个进程内计时；进程退出则
    /// 通道随进程消失，作业台账会把未收尾项恢复为 interrupted。
    fn schedule_hard_timeout(&self, job_id: &str, remaining: Option<Duration>) {
        let Some(remaining) = remaining else {
            return;
        };
        let command_exec = self.command_exec.clone();
        let job_id = job_id.to_string();
        tokio::spawn(async move {
            if !remaining.is_zero() {
                tokio::time::sleep(remaining).await;
            }
            if matches!(
                command_exec.job_status(&job_id).await,
                Ok(JobStatus::Running)
            ) {
                let _ = command_exec
                    .kill_job(
                        &job_id,
                        CancelReason::User,
                        crate::command_exec::JobCaller::Unscoped,
                    )
                    .await;
            }
        });
    }

    /// 在指定会话上跑一条命令并归一化结果。
    async fn submit_on(
        &self,
        session_id: &str,
        command: &str,
        timeout_ms: Option<u64>,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<CommandOutput, AppError> {
        // `background=false` 且不传 `timeout_ms` 时应一直等命令结束（仅保留 24h 长周期保险丝，
        // 不再用旧版 30 秒默认值半途掐断）。
        let ticket = CommandTicket::new(session_id, command, CommandSource::ExternalMcp).timeout(
            timeout_ms
                .map(Duration::from_millis)
                .unwrap_or(crate::command_exec::BACKGROUND_JOB_TIMEOUT),
        );

        // 无 AppHandle：无头路径没有流式事件可言，`submit_opt` 正是为此准备的。
        command_output(
            self.command_exec
                .submit_opt_with_cancel(None, ticket, cancel)
                .await,
        )
    }

    /// 获取会话的当前工作目录（用于相对路径解析）
    pub async fn get_working_directory(&self, connection_id: &str) -> Result<String, AppError> {
        self.get_working_directory_with_cancel(connection_id, None)
            .await
    }

    pub async fn get_working_directory_with_cancel(
        &self,
        connection_id: &str,
        cancel: Option<watch::Receiver<bool>>,
    ) -> Result<String, AppError> {
        let result = self
            .execute_command_with_cancel(connection_id, "pwd", Some(10_000), cancel)
            .await?;

        if result.exit_code_known && result.exit_code != 0 {
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
                let password = password
                    .ok_or_else(|| AppError::Config("auth_method=password 需要 password".into()))?;
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

        // 临时连接**只改内存、不落盘、不广播**（随进程生灭，刻意不进 connections.json）：
        // 这是 `mutate_transient` 唯一的合法用途。
        self.connection_store
            .mutate_transient(|store| {
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
                    remote_platform: None,
                });
            })
            .await;

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
        self.test_connection_with_cancel(connection_id, None).await
    }

    pub async fn test_connection_with_cancel(
        &self,
        connection_id: &str,
        cancel: Option<watch::Receiver<bool>>,
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
            .execute_command_with_cancel(connection_id, "echo OK", Some(10_000), cancel.clone())
            .await;

        let latency_ms = start.elapsed().as_millis() as u64;

        match probe {
            Ok(out)
                if out.stdout.trim() == "OK" && (!out.exit_code_known || out.exit_code == 0) =>
            {
                // 会话既已建立，顺手取一次远端版本（失败不影响结论）
                let version = self
                    .execute_command_with_cancel(connection_id, "uname -sr", Some(5_000), cancel)
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
            Ok(out) if !out.exit_code_known => Ok(TestConnectionResult {
                status: "failed".to_string(),
                latency_ms,
                server_version: None,
                error: Some(format!(
                    "远端已输出 {:?}，但没有返回退出状态，无法判定命令是否成功。",
                    out.stdout.trim()
                )),
            }),
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

    pub fn tasks(&self) -> super::tasks::TaskManager {
        self.tasks.clone()
    }

    pub async fn sftp_upload(
        &self,
        connection_id: &str,
        local_path: &str,
        remote_path: &str,
    ) -> Result<TransferResult, AppError> {
        self.sftp_upload_with_cancel(connection_id, local_path, remote_path, None, None)
            .await
    }

    pub async fn sftp_upload_with_cancel(
        &self,
        connection_id: &str,
        local_path: &str,
        remote_path: &str,
        cancel: Option<watch::Receiver<bool>>,
        on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
    ) -> Result<TransferResult, AppError> {
        let _target = self
            .target_guard(format!("upload|{}|{}", connection_id, remote_path))
            .await;
        let session_id = self.ensure_session(connection_id).await?;
        self.sftp_executor
            .upload_with_cancel(&session_id, local_path, remote_path, cancel, on_progress)
            .await
    }

    pub async fn sftp_download(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &str,
    ) -> Result<TransferResult, AppError> {
        self.sftp_download_with_cancel(connection_id, remote_path, local_path, None, None)
            .await
    }

    pub async fn sftp_download_with_cancel(
        &self,
        connection_id: &str,
        remote_path: &str,
        local_path: &str,
        cancel: Option<watch::Receiver<bool>>,
        on_progress: Option<&(dyn Fn(u64, u64) + Send + Sync)>,
    ) -> Result<TransferResult, AppError> {
        let _target = self
            .target_guard(format!("download|{}|{}", connection_id, local_path))
            .await;
        let session_id = self.ensure_session(connection_id).await?;
        self.sftp_executor
            .download_with_cancel(&session_id, remote_path, local_path, cancel, on_progress)
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
        // 先让长任务协作收尾（清理 sidecar/.part），再关它们依赖的 SSH 会话。
        self.tasks.shutdown().await;
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
        assert!(!is_dead_session_error(&AppError::SudoAuthRequired));
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
        let store = JsonStore::new(&dir, ConnectionStore::new(), None);
        let executor = ExternalExecutor::new(store.clone(), exec_mgr, Arc::new(ssh));

        // 空表：查不到
        assert!(!executor.connection_exists("nope").await);

        // 建一条临时连接后：查得到（这是 agent_task 前置校验的依据）
        let id = executor
            .create_connection(
                "t",
                "example.com",
                22,
                "u",
                "password",
                Some("pw"),
                None,
                None,
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
        let store = JsonStore::new(&dir, ConnectionStore::new(), None);
        let executor = ExternalExecutor::new(store, exec_mgr, Arc::new(ssh));

        // 大小写在边界处归一：内部存 "Password"，外部只认小写 "password"
        let id = executor
            .create_connection(
                "t",
                "h.example.com",
                22,
                "u",
                "password",
                Some("pw"),
                None,
                None,
            )
            .await
            .unwrap();
        let saved = executor.saved_connection(&id).await.unwrap();
        assert_eq!(
            saved.auth_method, "Password",
            "内部 SavedConnection 用首字母大写，与 GUI 侧一致"
        );

        let err = executor
            .create_connection(
                "t",
                "h.example.com",
                22,
                "u",
                "PASSWORD",
                Some("pw"),
                None,
                None,
            )
            .await
            .expect_err("大写不该被接受——外部契约是小写");
        assert!(err.to_string().contains("password"));
    }

    #[tokio::test]
    async fn execute_command_task_detaches_at_soft_timeout_and_enforces_remaining_hard_timeout() {
        use crate::command_exec::executor::{ChunkCallback, ExecExit, ExecOutcome, ExecTransport};
        use tokio::sync::Mutex as AsyncMutex;

        struct HangUntilCancel {
            seen_timeouts: AsyncMutex<Vec<Duration>>,
        }

        #[async_trait::async_trait]
        impl ExecTransport for HangUntilCancel {
            async fn exec(
                &self,
                ticket: &CommandTicket,
                _app: Option<&tauri::AppHandle>,
                _cancel: Option<&watch::Receiver<CancelReason>>,
            ) -> Result<ExecOutcome, AppError> {
                self.seen_timeouts.lock().await.push(ticket.timeout);
                Ok(ExecOutcome::Completed {
                    output: "ok".into(),
                    exit: ExecExit {
                        code: Some(0),
                        signal: None,
                    },
                })
            }

            async fn exec_observable(
                &self,
                ticket: &CommandTicket,
                _app: Option<&tauri::AppHandle>,
                _on_chunk: ChunkCallback,
                cancel: Option<&watch::Receiver<CancelReason>>,
            ) -> Result<ExecOutcome<()>, AppError> {
                self.seen_timeouts.lock().await.push(ticket.timeout);
                let mut rx = cancel.cloned().expect("detachable 必须带 cancel");
                let _ = rx.changed().await;
                let reason = *rx.borrow();
                Ok(ExecOutcome::Cancelled { reason })
            }
        }

        let ssh = crate::SshManager::new();
        let (_conn, _channels, _commands) =
            ssh.register_exec_loopback_session("sess-timeout", None).await;
        let dir = std::env::temp_dir().join(format!("marcel-exec-to-{}", uuid::Uuid::new_v4()));
        let transport = Arc::new(HangUntilCancel {
            seen_timeouts: AsyncMutex::new(Vec::new()),
        });
        let exec_mgr = Arc::new(CommandExecutionManager::with_transport_at(
            transport.clone(),
            dir.clone(),
        ));
        let store = JsonStore::new(&dir, ConnectionStore::new(), None);
        let executor = ExternalExecutor::new(store, exec_mgr.clone(), Arc::new(ssh));
        executor.register_test_session("conn-1", "sess-timeout").await;

        let started = std::time::Instant::now();
        let outcome = executor
            .execute_command_task(
                "conn-1",
                "sleep 10",
                Some(250),
                Duration::from_millis(50),
                false,
                None,
            )
            .await
            .expect("超过软超时应转后台");
        let detach_elapsed = started.elapsed();
        assert!(
            detach_elapsed < Duration::from_millis(200),
            "应按 soft_timeout(50ms) 转后台，不能等到 timeout_ms(250ms)，实际={:?}",
            detach_elapsed
        );

        let job_id = match outcome {
            CommandExecutionOutcome::Detached { job_id, .. } => job_id,
            CommandExecutionOutcome::Finished(_) => panic!("不应直接完成"),
        };

        // 显式 timeout_ms=250ms，转后台后应按剩余时间（总计约 250ms）自动终止，
        // 而不是重睡一整段 250ms。
        tokio::time::sleep(Duration::from_millis(260)).await;
        let status = exec_mgr.job_status(&job_id).await.unwrap();
        assert_eq!(status, JobStatus::Killed);

        // background=false 且不传 timeout_ms 时，不应再被 30 秒默认超时掐断。
        executor
            .execute_command_with_cancel("conn-1", "echo ok", None, None)
            .await
            .unwrap();
        let seen = transport.seen_timeouts.lock().await;
        assert_eq!(seen.last().copied(), Some(crate::command_exec::BACKGROUND_JOB_TIMEOUT));
    }

    #[tokio::test]
    async fn execute_command_task_invalidates_dead_session_and_retries() {
        use crate::command_exec::executor::{ChunkCallback, ExecOutcome, ExecTransport};

        struct DeadChannelTransport;

        #[async_trait::async_trait]
        impl ExecTransport for DeadChannelTransport {
            async fn exec(
                &self,
                _ticket: &CommandTicket,
                _app: Option<&tauri::AppHandle>,
                _cancel: Option<&watch::Receiver<CancelReason>>,
            ) -> Result<ExecOutcome, AppError> {
                Err(AppError::Ssh("打开 exec 通道失败: channel closed".into()))
            }

            async fn exec_observable(
                &self,
                _ticket: &CommandTicket,
                _app: Option<&tauri::AppHandle>,
                _on_chunk: ChunkCallback,
                _cancel: Option<&watch::Receiver<CancelReason>>,
            ) -> Result<ExecOutcome<()>, AppError> {
                Err(AppError::Ssh("打开 exec 通道失败: channel closed".into()))
            }
        }

        let ssh = crate::SshManager::new();
        let (_conn, _channels, _commands) =
            ssh.register_exec_loopback_session("sess-dead", None).await;
        let dir = std::env::temp_dir().join(format!("marcel-exec-dead-{}", uuid::Uuid::new_v4()));
        let exec_mgr = Arc::new(CommandExecutionManager::with_transport_at(
            Arc::new(DeadChannelTransport),
            dir.clone(),
        ));
        let store = JsonStore::new(&dir, ConnectionStore::new(), None);
        let executor = ExternalExecutor::new(store, exec_mgr, Arc::new(ssh));
        executor.register_test_session("conn-missing", "sess-dead").await;

        let err = executor
            .execute_command_task(
                "conn-missing",
                "echo hi",
                None,
                Duration::from_millis(50),
                false,
                None,
            )
            .await
            .err()
            .expect("重连应因 conn-missing 不在配置中而失败");
        assert!(
            err.to_string().contains(CONNECTION_NOT_FOUND_PREFIX),
            "死会话应触发失效并重连，而不是直接透传通道错误: {}",
            err
        );
        assert!(
            executor.sessions.lock().await.get("conn-missing").is_none(),
            "失效会话必须从缓存移除"
        );
    }
}
