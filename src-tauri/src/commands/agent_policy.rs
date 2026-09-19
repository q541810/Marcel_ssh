use serde::Serialize;
use tauri::State;

use crate::agent::risk::{assess_risk, RiskLevel};
use crate::agent::task::AgentMode;
use crate::config::settings::CommandListMode;
use crate::error::AppError;
use crate::AppState;

/// Result of evaluating a command against the current AGENT-mode policy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCheckResult {
    pub allowed: bool,
    pub requires_confirmation: bool,
    pub risk_level: RiskLevel,
    pub reason: String,
}

/// 内置的命令审批系统提示词。设置页用它做默认值展示与「恢复默认」，避免前端
/// 再抄一份——两份逐字节相同的副本会各自漂移（见 `templates/approval/审批.hbs`）。
#[tauri::command]
pub async fn agent_default_approval_prompt() -> String {
    crate::agent::templates::TemplateManager.render_approval_base()
}

/// 仅用于 Agent 审批流的风险预估（allowlist/denylist），**不替代执行前的完整评估**。
/// 命令真正执行前的完整评估在 `agent/tools/bash.rs` 中完成
/// （`RiskAssessor::assess_command()` 包含 fork bomb 检测、blocked commands/patterns、
/// protected paths、dd 阻断等，任一命中即拒绝执行）。
/// 注意：本命令自身走 `assess_risk`（纯分级、不做策略否决），返回值只用于审批前的展示预估。
#[tauri::command]
pub async fn agent_check_command(
    state: State<'_, AppState>,
    command: String,
    mode: AgentMode,
) -> Result<CommandCheckResult, AppError> {
    let trimmed = command.trim();
    let risk = assess_risk(trimmed);

    match mode {
        AgentMode::Plan | AgentMode::Agent => {
            let settings = state.settings.read().await;
            let policy = &settings.agent_mode_settings;
            let base = trimmed
                .split_whitespace()
                .next()
                .unwrap_or("")
                .rsplit('/')
                .next()
                .unwrap_or("");
            let in_list = policy.command_list.iter().any(|c| c == base);

            match policy.list_mode {
                CommandListMode::Allowlist => {
                    if in_list {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: policy.confirm_each_command,
                            risk_level: risk,
                            reason: format!("'{}' 在白名单中", base),
                        })
                    } else {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: true,
                            risk_level: risk,
                            reason: format!("'{}' 不在白名单中，需要用户确认", base),
                        })
                    }
                }
                CommandListMode::Denylist => {
                    if in_list {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: true,
                            risk_level: risk,
                            reason: format!("'{}' 在黑名单中，需要用户确认", base),
                        })
                    } else {
                        Ok(CommandCheckResult {
                            allowed: true,
                            requires_confirmation: policy.confirm_each_command,
                            risk_level: risk,
                            reason: format!("'{}' 不在黑名单中", base),
                        })
                    }
                }
            }
        }
        AgentMode::Auto => Ok(CommandCheckResult {
            allowed: true,
            requires_confirmation: false,
            risk_level: risk,
            reason: "AUTO 模式自动同意所有命令".into(),
        }),
    }
}
