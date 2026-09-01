//! 命令执行的「意图声明」类型。
//!
//! 对应分层架构中的 Ticket 层：调用方只描述「我要在哪个会话上、以什么身份、
//! 执行什么命令、多久超时、怎么流式输出、怎么取消」，所有执行细节
//! （exec channel 生命周期、超时关闭、取消中断、事件路由）由
//! [`crate::command_exec::executor`] 统一处理。
//!
//! 安全约定：
//! - `command` 是实际下发到远端的命令。Agent 的 sudo 自动填充发生在工具层
//!   （`execute_cmd.rs` 的 `rewrite_sudo`），重写后的命令**含明文密码**，
//!   只允许传入 [`CommandExecutionManager::submit`] 并直达 executor，
//!   绝不进入 [`ExecutionRecord`] / [`ExecutionSnapshot`] / 事件 / 日志。
//! - `display_command` 是记录与快照使用的展示文本，调用方必须传原始命令
//!   （未重写、不含密码）。

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// 取消原因。决定 [`super::manager::SubmitOutcome::Cancelled`] 的语义与
/// 调用方映射的错误/状态文案。变体必须穷尽「谁发起了终止」：
/// 界面用户、Agent 自己、任务级联、断连——后台作业的终止来源文案
/// 依赖这一区分，不能把不同来源混进同一个变体。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CancelReason {
    /// 用户在界面主动取消（命令取消按钮、作业「终止」按钮）。
    User,
    /// Agent 通过 `job_kill` 工具终止自己派发的后台作业。
    Agent,
    /// Agent 任务被停止（`agent_stop_task`）时的级联取消。
    Task,
    /// 会话断开，由断连观察者级联取消。
    Disconnected,
}

/// 命令来源。用于执行记录归属、统一事件与未来的优先级/嘈杂度策略。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CommandSource {
    /// 用户侧直接执行（ProcessPanel / NetworkPanel / 插件经授权的 `ssh.exec`）。
    User,
    /// 系统内部长任务（压缩 / 解压 / 快速删除等由产品功能构造的命令）。
    SystemTask,
    /// Agent `bash` 工具（原 `bash`，已过沙箱与审批）。
    Agent,
    /// 插件系统后端路由的命令执行。
    Plugin,
}

/// 执行生命周期状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionStatus {
    Running,
    Completed,
    TimedOut,
    Cancelled,
    Failed,
    Killed,
}

/// 流式输出目标：每个数据 chunk 以 `{type:"toolOutput", toolCallId, chunk}`
/// payload 发射到 `event_name` 事件（与旧 `exec_command_streamed` 协议逐字节一致）。
#[derive(Debug, Clone)]
pub struct StreamTarget {
    /// chunk 事件名（如 `ssh-long-output` 或 Agent 工具的事件通道）。
    pub event_name: String,
    /// payload 中 `toolCallId` 字段的值（压缩等长任务为 task_id，Agent 工具为 tool_call_id）。
    pub stream_id: String,
}

/// 一次命令执行的完整请求描述。
#[derive(Debug, Clone)]
pub struct CommandTicket {
    pub session_id: String,
    /// 实际执行的命令（可能含 sudo 密码，绝不入记录/事件/日志）。
    pub command: String,
    /// 展示用命令（原始命令，不含密码）。默认等于 `command`；调用方在
    /// command 被重写时必须通过 [`CommandTicket::display_as`] 显式指定。
    pub display_command: String,
    pub source: CommandSource,
    pub timeout: Duration,
    /// 可取消标识：同时是取消注册表的键（`ssh_exec_long_cancel(task_id)`）。
    pub task_id: Option<String>,
    pub streaming: Option<StreamTarget>,
    /// 取消时返回给调用方的错误文案（不同调用方文案不同，保持旧兼容）。
    pub cancelled_message: String,
}

impl CommandTicket {
    pub fn new(
        session_id: impl Into<String>,
        command: impl Into<String>,
        source: CommandSource,
    ) -> Self {
        let command = command.into();
        Self {
            display_command: command.clone(),
            command,
            session_id: session_id.into(),
            source,
            timeout: Duration::from_secs(120),
            task_id: None,
            streaming: None,
            cancelled_message: "命令已取消".to_string(),
        }
    }

    /// 覆盖展示命令。command 被重写（如 sudo 密码填充）时必须调用。
    pub fn display_as(mut self, display: impl Into<String>) -> Self {
        self.display_command = display.into();
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    /// 声明可取消：注册取消键并指定取消时的错误文案。
    pub fn cancellable(
        mut self,
        task_id: impl Into<String>,
        cancelled_message: impl Into<String>,
    ) -> Self {
        self.task_id = Some(task_id.into());
        self.cancelled_message = cancelled_message.into();
        self
    }

    /// 声明流式输出。
    pub fn streaming(
        mut self,
        event_name: impl Into<String>,
        stream_id: impl Into<String>,
    ) -> Self {
        self.streaming = Some(StreamTarget {
            event_name: event_name.into(),
            stream_id: stream_id.into(),
        });
        self
    }
}

/// 对外查询快照（不包含实际执行命令全文，展示文本已截断）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionSnapshot {
    pub exec_id: u64,
    pub session_id: String,
    pub source: CommandSource,
    pub task_id: Option<String>,
    pub display_command: String,
    pub started_at_millis: u128,
}

/// 快照中展示命令的最大长度（字符）。
pub const DISPLAY_COMMAND_MAX_CHARS: usize = 120;

pub fn truncate_display(display: &str) -> String {
    if display.chars().count() <= DISPLAY_COMMAND_MAX_CHARS {
        display.to_string()
    } else {
        let truncated: String = display.chars().take(DISPLAY_COMMAND_MAX_CHARS).collect();
        format!("{}…", truncated)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ticket_defaults_match_legacy_exec_command() {
        let t = CommandTicket::new("s1", "ls -la", CommandSource::User);
        assert_eq!(t.timeout, Duration::from_secs(120));
        assert_eq!(t.display_command, "ls -la");
        assert!(t.task_id.is_none());
        assert!(t.streaming.is_none());
        assert_eq!(t.cancelled_message, "命令已取消");
    }

    #[test]
    fn display_as_decouples_execution_and_display() {
        let t = CommandTicket::new("s1", "printf 'pw' | sudo -S ls", CommandSource::Agent)
            .display_as("sudo ls");
        assert_eq!(t.command, "printf 'pw' | sudo -S ls");
        assert_eq!(t.display_command, "sudo ls");
    }

    #[test]
    fn truncate_display_keeps_short_and_cuts_long() {
        assert_eq!(truncate_display("ls"), "ls");
        let long = "a".repeat(500);
        let out = truncate_display(&long);
        assert!(out.chars().count() <= DISPLAY_COMMAND_MAX_CHARS + 1);
        assert!(out.ends_with('…'));
    }

    #[test]
    fn truncate_display_is_char_safe_for_cjk() {
        let long = "测".repeat(300);
        let out = truncate_display(&long);
        assert!(out.chars().count() <= DISPLAY_COMMAND_MAX_CHARS + 1);
    }
}
