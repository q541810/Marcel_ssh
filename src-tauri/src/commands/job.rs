//! 后台作业的 Tauri commands。
//!
//! 作业本体由 [`crate::command_exec::CommandExecutionManager`] 统一管理
//! （与前台执行共用注册表 / 取消 / 断连级联），这里只是 IPC 门面。

use tauri::State;

use crate::command_exec::{CancelReason, JobInfo};
use crate::error::AppError;
use crate::AppState;

#[tauri::command]
pub async fn job_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
    status: Option<String>,
) -> Result<Vec<JobInfo>, AppError> {
    // session_id 为空 = 拉取全部会话的作业（前端启动恢复用）。
    // Agent 的 job_list 工具传具体会话（见 tools/job_ops.rs），两者不冲突。
    Ok(state
        .command_exec
        .list_jobs(session_id.as_deref(), status.as_deref())
        .await)
}

#[tauri::command]
pub async fn job_kill(state: State<'_, AppState>, job_id: String) -> Result<JobInfo, AppError> {
    // 该 command 只由前端「终止」按钮调用（任务抽屉 / 移动端作业列表），
    // 是真·用户手动终止 → User。Agent 的 job_kill 工具走
    // tools/job_ops.rs，传 CancelReason::Agent，两者绝不混用。
    state
        .command_exec
        .kill_job(&job_id, CancelReason::User)
        .await
}
