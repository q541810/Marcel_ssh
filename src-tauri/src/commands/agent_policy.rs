use serde::Serialize;
use tauri::State;

use crate::agent::sandbox::{assess_risk, RiskLevel};
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

/// Evaluate a command against the current agent-mode settings.
#[tauri::command]
pub async fn agent_check_command(
    state: State<'_, AppState>,
    command: String,
    mode: AgentMode,
) -> Result<CommandCheckResult, AppError> {
    let trimmed = command.trim();
    let risk = assess_risk(trimmed);

    match mode {
        AgentMode::Chat => Ok(CommandCheckResult {
            allowed: false,
            requires_confirmation: false,
            risk_level: risk,
            reason: "CHAT 模式不执行任何命令".into(),
        }),
        AgentMode::Auto => Ok(CommandCheckResult {
            allowed: true,
            requires_confirmation: false,
            risk_level: risk,
            reason: "AUTO 模式自动同意所有命令".into(),
        }),
        AgentMode::Agent => {
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
    }
}
