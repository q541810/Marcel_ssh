//! 命令风险评估：把一个命令字符串判成一个 [`RiskLevel`]，并依据 [`SecurityPolicy`] 否决其中一部分。
//!
//! 这里**不做隔离**——进程/文件系统/网络的隔离不归它管。它是执行**之前**的一层静态判定：
//! 解析 shell 语法（[`parser`]）→ 逐段定级（[`model`]）→ 按策略否决或放行（[`RiskAssessor`]）。
//! 等级交给审批链决定要不要人确认，否决则是硬性拒绝执行。别把它叫沙箱：那会让人以为这里兜住了执行。

mod checker;
mod level;
mod model;
mod parser;
mod policy;

pub use checker::{
    analyze_rm_args, contains_top_level_pipe, is_bare_shell, is_dangerous_rm_target, is_fork_bomb,
    looks_like_path, normalize_path, pattern_matches,
};
pub use level::RiskLevel;
pub use model::{assess_risk, parse_and_classify};
pub use parser::split_command_chain;
pub use policy::{RiskAssessor, SecurityPolicy};

#[cfg(test)]
mod tests;
