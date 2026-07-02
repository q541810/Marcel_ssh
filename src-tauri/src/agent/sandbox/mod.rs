//! Sandbox: command risk assessment and policy enforcement.
//!
//! Replaces the prior substring-based detector with a real shell-aware
//! parser (see [`parser`]) and per-segment risk evaluation.

pub use crate::agent::RiskLevel;

mod checker;
mod parser;
mod policy;
mod risk_model;

pub use checker::{
    analyze_rm_args, contains_top_level_pipe, is_bare_shell, is_dangerous_rm_target, is_fork_bomb,
    looks_like_path, normalize_path, pattern_matches,
};
pub use parser::split_command_chain;
pub use policy::{Sandbox, SecurityPolicy};
pub use risk_model::{assess_risk, parse_and_classify};

#[cfg(test)]
mod tests;
