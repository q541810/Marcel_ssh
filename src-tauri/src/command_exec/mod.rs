//! # 命令执行统一管理（command_exec）
//!
//! 分层架构（借鉴「组合优于继承」的语音系统设计）：
//!
//! ```text
//! 调用方（commands/ssh.rs、commands/sftp.rs、ToolContext、plugin_api.rs）
//!    │  构造 CommandTicket —— 只声明意图（哪个会话、什么命令、怎么展示、
//!    │  超时多久、是否可取消、是否流式）
//!    ▼
//! CommandExecutionManager（协调层 manager.rs）
//!    │  执行记录 / 取消注册表 / 断连级联取消 / 快照查询
//!    ▼
//! executor（执行适配层 executor.rs，≈ VoicePlayer）
//!    │  开 exec channel / 超时宽限关闭 / 断连检测 / 流式事件
//!    ▼
//! SshManager / SshConnection（连接层）
//! ```
//!
//! - **调用方只声明意图**（像 `PlayVoice(VoiceID)` 一样 `submit(ticket)`），
//!   所有执行细节与调度决策在子系统内闭环。
//! - `SshManager::exec_command*` 系列保留为兼容 shim（内部委托 executor
//!   核心，不登记记录）；新代码一律走 manager。
//! - 安全：`ticket.command` 可能含 sudo 密码，绝不进入记录 / 快照 / 日志。

pub(crate) mod executor;
mod manager;
mod ticket;

pub use manager::{CancelReason, CommandExecutionManager, SubmitOutcome};
pub use ticket::{CommandSource, CommandTicket, ExecutionSnapshot, ExecutionStatus, StreamTarget};
