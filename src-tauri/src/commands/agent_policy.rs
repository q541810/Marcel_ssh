use serde::Serialize;
use tauri::State;

use crate::agent::risk::{Disposition, SecurityPolicy};
use crate::agent::tool_dispatcher::decide_command;
use crate::agent::task::AgentMode;
use crate::error::AppError;
use crate::AppState;

/// Result of evaluating a command against the current AGENT-mode policy.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandCheckResult {
    pub allowed: bool,
    pub requires_confirmation: bool,
    pub disposition: Disposition,
    pub reason: String,
}

/// 内置的命令审批系统提示词。设置页用它做默认值展示与「恢复默认」，避免前端
/// 再抄一份——两份逐字节相同的副本会各自漂移（见 `templates/approval/审批.hbs`）。
#[tauri::command]
pub async fn agent_default_approval_prompt() -> String {
    crate::agent::templates::TemplateManager.render_approval_base()
}

/// 设置页「命令测试」用的预演：这条命令在当前配置下会被怎么处置。
///
/// 它调用 [`crate::agent::tool_dispatcher::decide_command`] —— 和真正执行时
/// **同一份判定**，所以这里显示的结论就是实际会发生的事。这里以前自己抄了一份
/// 名单逻辑、而且完全不看风险评估，测出来的结论和跑起来的行为可以不一样。
#[tauri::command]
pub async fn agent_check_command(
    state: State<'_, AppState>,
    command: String,
    mode: AgentMode,
) -> Result<CommandCheckResult, AppError> {
    let settings = state.settings.read().await;
    let policy = SecurityPolicy::from_user_settings(
        &settings.custom_protected_paths,
        settings.command_timeout_secs,
    );
    let decision = decide_command(
        command.trim(),
        &mode,
        &settings.agent_mode_settings,
        Some(&policy),
    );

    Ok(CommandCheckResult {
        allowed: decision.disposition != Disposition::Deny,
        requires_confirmation: decision.requires_confirmation,
        disposition: decision.disposition,
        reason: decision.reason,
    })
}
