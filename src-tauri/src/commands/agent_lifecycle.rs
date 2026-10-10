use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::agent::conversation::HistorySnapshot;
use crate::agent::conversation_persister::PromptOrigin;
use crate::agent::manager::{AgentManager, AgentRole, AgentSpec};
use crate::agent::task::AgentMode;
use crate::error::AppError;
use crate::AppState;

#[tauri::command]
pub async fn agent_start_task(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    prompt: String,
    mode: AgentMode,
    history_snapshot: HistorySnapshot,
    conversation_id: String,
    task_id: Option<String>,
    model_id: Option<String>,
    // 这一轮 prompt 的来源：`None` / 未知值 = 用户自己打的字；
    // `"job_notice"` = 后台作业的结算告知（前端自动继续时带上）。
    // 它决定这条消息在会话里的身份（落库 role）与「算不算用户输入」——
    // 认不出来一律当用户输入，见 `PromptOrigin::from_ipc`。
    origin: Option<String>,
    user_input: Option<serde_json::Value>,
) -> Result<String, AppError> {
    // 兜底守卫：该会话正在手动压缩上下文 → 拒绝开这一轮。
    //
    // 正常时序下前端根本不会走到这里（压缩期间发送键禁用、`/` 菜单不唤出、后台
    // 作业的自动继续让路，见 `conversationIsBusy`）。留这道守卫是因为**压缩卡按
    // 「提交那一刻的队尾」落位**：从快照到提交之间写进来的任何一条消息，都会被
    // 随后落下的卡盖到后面，然后被归档边界（最新一张卡之前的行）从后续请求里抹掉
    // —— 那是静默丢上下文，不能只靠前端记得拦。
    if state.compactions.is_registered(&conversation_id) {
        return Err(AppError::Agent(
            "会话正在压缩上下文，请等待完成或取消后再发送".into(),
        ));
    }
    // 前端可预生成 task_id 并先挂好事件 listener；旧调用方不传时仍由后端生成。
    let task_id = task_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    // 会话级模型选择（llmRegistry 模型条目 id）；None = 跟随全局默认模型。
    // manager.spawn 的 resolve_override 会按 id 解析，找不到时回落默认。
    let model_override = model_id.filter(|s| !s.trim().is_empty());
    // 快照保留调用时的实时消息与可定位锚点；请求角色、压缩边界和工具协议统一
    // 在后端投影，不把仅落库的内部补问混入此前不可见的实时历史。
    let history = state
        .conversation_db
        .resolve_llm_history(&conversation_id, &history_snapshot)
        .map_err(|error| AppError::Agent(format!("读取会话历史失败：{error}")))?;
    let spec = AgentSpec {
        task_id: task_id.clone(),
        mode,
        // 主任务无审批覆盖：命令确认语义跟随自身 mode。
        approval_mode: None,
        role: AgentRole::Main,
        session_id,
        conversation_id,
        prompt,
        history,
        model_override,
        prompt_extra: Vec::new(),
        prompt_origin: PromptOrigin::from_ipc(origin.as_deref()),
        user_input,
    };
    let manager = AgentManager::new(state.inner().clone());
    let handle = manager.spawn(&app, spec).await?;
    Ok(handle.task_id)
}

/// 停止一个任务及其全部子 agent。
///
/// 整段停止语义只有一份实现（[`crate::agent::manager::stop_task_cascade`]）：
/// 「SSH 会话断开 → 级联停止」的观察者走的是同一个函数，两条触发不允许分叉。
#[tauri::command]
pub async fn agent_stop_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), AppError> {
    crate::agent::manager::stop_task_cascade(&app, state.inner(), &task_id).await;
    Ok(())
}

#[tauri::command]
pub async fn agent_approve_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    state
        .agent_interaction
        .respond_approval(&app, &task_id, &operation_id, true, None);
    Ok(())
}

#[tauri::command]
/// 拒绝一次待审批的操作。
///
/// `reason` 可选，会**原样转达给模型** —— 不说理由时模型只知道"被拒了"，于是换个
/// 写法再试，用户被迫反复拒绝。说了理由它才有依据调整方向。
pub async fn agent_reject_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
    reason: Option<String>,
) -> Result<(), AppError> {
    state
        .agent_interaction
        .respond_approval(&app, &task_id, &operation_id, false, reason);
    Ok(())
}

#[tauri::command]
pub async fn agent_answer_question(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    question_id: String,
    answers: Vec<serde_json::Value>,
) -> Result<(), AppError> {
    state
        .agent_interaction
        .respond_question(&app, &task_id, &question_id, answers);
    Ok(())
}
