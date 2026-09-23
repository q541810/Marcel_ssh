//! 后台作业的 Tauri commands。
//!
//! 作业本体由 [`crate::command_exec::CommandExecutionManager`] 统一管理
//! （与前台执行共用注册表 / 取消 / 断连级联），这里只是 IPC 门面。

use serde::Serialize;
use tauri::State;

use crate::command_exec::{CancelReason, JobCaller, JobFilter, JobInfo};
use crate::error::AppError;
use crate::AppState;

/// 一条待交付给模型的「作业结算告知」：文本 + 它覆盖的作业 id。
///
/// 两个字段都要：文本交给模型，id 用来在**真的送出去之后**确认
/// （`job_ack_notice`）——只置一次 `settled_notified` 的话，一次「问了但没送
/// 出去」（会话已关、应用正要退出、自动继续的额度用尽）就会把结局吞掉。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobNotice {
    pub text: String,
    pub job_ids: Vec<String>,
}

#[tauri::command]
pub async fn job_list(
    state: State<'_, AppState>,
    session_id: Option<String>,
    status: Option<String>,
) -> Result<Vec<JobInfo>, AppError> {
    // session_id 为空 = 拉取全部会话的作业（界面按机器筛时传会话）。
    // 界面不设归属围栏（用户本来就该看到自己机器上的全部作业，包括上一次
    // 应用运行留下、已恢复成 interrupted 的那些）；Agent 的 job_list 工具
    // 走 tools/job_ops.rs，按对话归属过滤，两者语义不同、互不影响。
    let filter = match session_id.as_deref() {
        Some(sid) => JobFilter::Session(sid),
        None => JobFilter::All,
    };
    Ok(state
        .command_exec
        .list_jobs(filter, status.as_deref())
        .await)
}

#[tauri::command]
pub async fn job_kill(state: State<'_, AppState>, job_id: String) -> Result<JobInfo, AppError> {
    // 该 command 只由前端「终止」按钮调用（任务抽屉 / 移动端作业列表），
    // 是真·用户手动终止 → User。Agent 的 job_kill 工具走
    // tools/job_ops.rs，传 CancelReason::Agent，两者绝不混用。
    state
        .command_exec
        .kill_job(&job_id, CancelReason::User, JobCaller::Unscoped)
        .await
}

/// 取某会话「作业跑完了、但还没告诉过模型」的结局（没有则 `None`）。
///
/// 前端在两种时机调用：① 收到某条作业的 `job://updated`（终态）；② 某轮
/// 结束（Done / Cancelled / Failed）—— 后者关掉「作业恰好在回合收尾那一刻
/// 结算、通知谁都错过」的竞态窗口。
///
/// 拿到文本之后由前端开一轮把告知交给模型（`agent_start_task` 带
/// `origin: "job_notice"`），成功后调 [`job_ack_notice`] 确认。**只读**：
/// 光调用它不会消费结局。
#[tauri::command]
pub async fn job_pending_notice(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<JobNotice>, AppError> {
    let jobs = state.command_exec.pending_job_notices(&conversation_id);
    if jobs.is_empty() {
        return Ok(None);
    }
    Ok(Some(JobNotice {
        text: crate::agent::agent_loop::build_job_settlement_notice(&jobs),
        job_ids: jobs.into_iter().map(|j| j.job_id).collect(),
    }))
}

/// 确认这些作业的结局已经交给模型（此后不再播报）。返回真的被确认的条数
/// ——已被别的路径（`job_output` 读到终态、agent 自己 job_kill）消费过的
/// 不计入，那不是失败。
#[tauri::command]
pub async fn job_ack_notice(
    state: State<'_, AppState>,
    job_ids: Vec<String>,
) -> Result<usize, AppError> {
    Ok(state.command_exec.ack_job_notices(&job_ids))
}
