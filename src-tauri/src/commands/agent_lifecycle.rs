use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::agent::manager::{AgentManager, AgentRole, AgentSpec};
use crate::agent::task::{AgentMode, AgentStatus, AgentTask};
use crate::error::AppError;
use crate::llm::provider::LlmMessage;
use crate::AppState;

#[tauri::command]
pub async fn agent_start_task(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    prompt: String,
    mode: AgentMode,
    history: Vec<LlmMessage>,
    conversation_id: String,
) -> Result<String, AppError> {
    // 组装与 spawn 统一走 AgentManager；这里只声明「要跑什么」。
    let task_id = Uuid::new_v4().to_string();
    let spec = AgentSpec {
        task_id: task_id.clone(),
        mode,
        role: AgentRole::Main,
        session_id,
        conversation_id,
        prompt,
        history,
        model_override: None,
        prompt_extra: Vec::new(),
    };
    let manager = AgentManager::new(state.inner().clone());
    let handle = manager.spawn(&app, spec).await?;
    Ok(handle.task_id)
}

fn send_approval(state: &AppState, task_id: &str, operation_id: &str, approved: bool) {
    let label = if approved { "approved" } else { "rejected" };
    log::info!("Operation {}: task={}, op={}", label, task_id, operation_id);
    let sender = state
        .pending_approvals
        .write()
        .remove(&(task_id.to_string(), operation_id.to_string()));
    if let Some(tx) = sender {
        let _ = tx.send(approved);
    }
}

/// 收集 task_id 及其全部后代子任务（task 工具派发的子agent）。
/// 子agent不能再派发子agent（plan 工具集无 task 工具 + 工具内嵌套防御），
/// 一层即可覆盖全部后代，BFS 遍历防御任何残留的多层结构。
fn collect_descendant_tasks(
    tasks: &std::collections::HashMap<String, AgentTask>,
    task_id: &str,
) -> Vec<String> {
    let mut to_cancel: Vec<String> = vec![task_id.to_string()];
    let mut idx = 0;
    while idx < to_cancel.len() {
        let parent = to_cancel[idx].clone();
        for (tid, t) in tasks.iter() {
            if t.parent_task_id.as_deref() == Some(parent.as_str()) && !to_cancel.contains(tid) {
                to_cancel.push(tid.clone());
            }
        }
        idx += 1;
    }
    to_cancel
}

#[tauri::command]
pub async fn agent_stop_task(state: State<'_, AppState>, task_id: String) -> Result<(), AppError> {
    // 级联取消：停掉该任务及其全部子agent。子任务与主任务一样要置
    // Cancelled——子agent loop 的退出检查（is_task_cancelled）只看 status，
    // 不置状态的话取消场景会被 subagent 工具误报为「执行失败」。
    let tasks_to_cancel = {
        let tasks = state.agent_tasks.read();
        collect_descendant_tasks(&tasks, &task_id)
    };

    {
        let mut tasks = state.agent_tasks.write();
        let mut found = false;
        for tid in &tasks_to_cancel {
            if let Some(task) = tasks.get_mut(tid) {
                task.status = AgentStatus::Cancelled;
                found = true;
            }
        }
        if !found {
            return Err(AppError::Agent(format!("Task not found: {}", task_id)));
        }
    }

    // 解除挂起：ask_user / 审批等待的是 oneshot channel，只有 sender 被 drop
    // 才会返回（question.rs / approval.rs 的 rx.await）。不清理的话，取消后
    // 任务会永久卡在工具执行中（前端弹窗已被清空，用户无法再回答）。
    let cancel_set: std::collections::HashSet<&String> = tasks_to_cancel.iter().collect();
    state
        .pending_questions
        .write()
        .retain(|(tid, _), _| !cancel_set.contains(tid));
    state
        .pending_approvals
        .write()
        .retain(|(tid, _), _| !cancel_set.contains(tid));

    for tid in &tasks_to_cancel {
        if let Some(cancel_tx) = state.cancel_senders.write().remove(tid) {
            let _ = cancel_tx.send(true);
        }
    }
    if tasks_to_cancel.len() > 1 {
        log::info!(
            "Cancelled task {} and {} sub-agent(s)",
            task_id,
            tasks_to_cancel.len() - 1
        );
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_approve_operation(
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    send_approval(&state, &task_id, &operation_id, true);
    Ok(())
}

#[tauri::command]
pub async fn agent_reject_operation(
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    send_approval(&state, &task_id, &operation_id, false);
    Ok(())
}

fn send_question_answer(
    state: &AppState,
    task_id: &str,
    question_id: &str,
    answers: Vec<serde_json::Value>,
) {
    log::info!(
        "Question answered: task={}, question={}, answers={}",
        task_id,
        question_id,
        answers.len()
    );
    let sender = state
        .pending_questions
        .write()
        .remove(&(task_id.to_string(), question_id.to_string()));
    if let Some(tx) = sender {
        let _ = tx.send(answers);
    }
}

#[tauri::command]
pub async fn agent_answer_question(
    state: State<'_, AppState>,
    task_id: String,
    question_id: String,
    answers: Vec<serde_json::Value>,
) -> Result<(), AppError> {
    send_question_answer(&state, &task_id, &question_id, answers);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_task(id: &str, parent: Option<&str>) -> AgentTask {
        AgentTask {
            id: id.to_string(),
            session_id: "s1".to_string(),
            conversation_id: format!("conv-{}", id),
            prompt: "p".to_string(),
            mode: AgentMode::Plan,
            status: AgentStatus::Planning,
            has_plan: false,
            created_at: chrono::Utc::now(),
            parent_task_id: parent.map(String::from),
        }
    }

    #[test]
    fn collect_descendant_tasks_includes_self_and_direct_subtasks() {
        let tasks = std::collections::HashMap::from([
            ("main".to_string(), make_task("main", None)),
            ("sub1".to_string(), make_task("sub1", Some("main"))),
            ("sub2".to_string(), make_task("sub2", Some("main"))),
            ("other".to_string(), make_task("other", None)),
        ]);
        let got = collect_descendant_tasks(&tasks, "main");
        assert_eq!(got.len(), 3);
        assert!(got.contains(&"main".to_string()));
        assert!(got.contains(&"sub1".to_string()));
        assert!(got.contains(&"sub2".to_string()));
        assert!(!got.contains(&"other".to_string()));
    }

    #[test]
    fn collect_descendant_tasks_bfs_covers_nested_layers() {
        // 防御性 BFS：即使未来出现多层嵌套（当前嵌套被工具集与工具内检查双重拦截），
        // 级联取消也能一次覆盖全部后代。
        let tasks = std::collections::HashMap::from([
            ("main".to_string(), make_task("main", None)),
            ("sub1".to_string(), make_task("sub1", Some("main"))),
            ("sub2".to_string(), make_task("sub2", Some("sub1"))),
            ("sub3".to_string(), make_task("sub3", Some("sub2"))),
        ]);
        let got = collect_descendant_tasks(&tasks, "main");
        assert_eq!(got.len(), 4);
        assert!(got.contains(&"sub3".to_string()));
    }

    #[test]
    fn collect_descendant_tasks_missing_task_returns_only_self() {
        let tasks = std::collections::HashMap::from([(
            "other".to_string(),
            make_task("other", None),
        )]);
        let got = collect_descendant_tasks(&tasks, "ghost");
        assert_eq!(got, vec!["ghost".to_string()]);
    }

    #[test]
    fn collect_descendant_tasks_child_of_other_task_not_collected() {
        let tasks = std::collections::HashMap::from([
            ("main".to_string(), make_task("main", None)),
            ("sub".to_string(), make_task("sub", Some("main"))),
        ]);
        let got = collect_descendant_tasks(&tasks, "sub");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0], "sub");
    }
}
