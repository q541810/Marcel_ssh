//! 命令风险评估：给一条命令定一个 [`Disposition`]（放行 / 请求审批 / 强制审批 / 直接拒绝）。
//!
//! 这里**不做隔离**——进程/文件系统/网络的隔离不归它管。它是执行**之前**的一层静态判定：
//! 解析 shell 语法（[`parser`]）→ 逐段定档（[`model`]）→ 按参数与策略收敛（[`policy`]）。
//! 别把它叫沙箱：那会让人以为这里兜住了执行。
//!
//! 档位只有四档，而且**没有"严重度"这个概念**：算出一个没人拿来做决定的等级没有意义。
//! 判定规则全部在 [`policy::RiskAssessor::assess_command`]，那是唯一入口。

mod checker;
mod disposition;
mod model;
mod parser;
mod policy;

pub use disposition::{Assessment, Disposition};
pub use policy::{RiskAssessor, SecurityPolicy};

/// 外部（tool_dispatcher / 工具实现）真正需要的那几个小工具。
pub use checker::normalize_path;
pub use parser::split_command_chain;

#[cfg(test)]
mod tests;
