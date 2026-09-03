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
    task_id: Option<String>,
    model_id: Option<String>,
) -> Result<String, AppError> {
    // 前端可预生成 task_id 并先挂好事件 listener；旧调用方不传时仍由后端生成。
    let task_id = task_id.unwrap_or_else(|| Uuid::new_v4().to_string());
    // 会话级模型选择（llmRegistry 模型条目 id）；None = 跟随全局默认模型。
    // manager.spawn 的 resolve_override 会按 id 解析，找不到时回落默认。
    let model_override = model_id.filter(|s| !s.trim().is_empty());
    let spec = AgentSpec {
        task_id: task_id.clone(),
        mode,
        role: AgentRole::Main,
        session_id,
        conversation_id,
        prompt,
        history,
        model_override,
        prompt_extra: Vec::new(),
    };
    let manager = AgentManager::new(state.inner().clone());
    let handle = manager.spawn(&app, spec).await?;
    Ok(handle.task_id)
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
pub async fn agent_stop_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<(), AppError> {
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

    // 解除挂起交互：经 AgentInteractionManager 取消并在队列中淘汰，通知前端更新
    for tid in &tasks_to_cancel {
        state.agent_interaction.cancel_task_interactions(&app, tid);
    }

    for tid in &tasks_to_cancel {
        if let Some(cancel_tx) = state.cancel_senders.write().remove(tid) {
            let _ = cancel_tx.send(true);
        }
        // bash 以 Agent task_id 注册到统一命令 manager；任务停止属级联
        // 取消 → Task，与界面直接取消（User）、Agent job_kill（Agent）
        // 区分，job_output 的终止来源文案据此渲染。
        // 前台执行走 cancel_with_reason（注册表最后一条 exec）；
        // 后台作业可能多条并存，cancel_task_jobs 逐个 kill + 释放
        // 结算通知通道（让挂起的 agent loop 立即醒来以取消收场）。
        let _ = state
            .command_exec
            .cancel_with_reason(tid, crate::command_exec::CancelReason::Task)
            .await;
        let _ = state.command_exec.cancel_task_jobs(tid).await;
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
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    state
        .agent_interaction
        .respond_approval(&app, &task_id, &operation_id, true);
    Ok(())
}

#[tauri::command]
pub async fn agent_reject_operation(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    operation_id: String,
) -> Result<(), AppError> {
    state
        .agent_interaction
        .respond_approval(&app, &task_id, &operation_id, false);
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
            model_id: None,
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
        let tasks =
            std::collections::HashMap::from([("other".to_string(), make_task("other", None))]);
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
