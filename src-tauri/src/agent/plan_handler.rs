use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::agent::task::{AgentTaskPlan, PlanItem, PlanItemStatus};
use crate::emit_event;
use crate::AppState;

/// Events emitted during agent planning and step execution.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub(crate) enum PlanStreamEvent {
    PlanCreated {
        items: Vec<PlanItem>,
    },
    #[serde(rename_all = "camelCase")]
    PlanItemStarted {
        item_id: String,
        title: String,
        index: usize,
        total: usize,
    },
    #[serde(rename_all = "camelCase")]
    PlanItemCompleted {
        item_id: String,
        title: String,
        index: usize,
        total: usize,
    },
    #[serde(rename_all = "camelCase")]
    PlanItemFailed {
        item_id: String,
        title: String,
        error: String,
        index: usize,
        total: usize,
    },
    #[serde(rename_all = "camelCase")]
    PlanItemSkipped {
        item_id: String,
        title: String,
        index: usize,
        total: usize,
    },
    PlanCompleted {
        completed: usize,
        total: usize,
        failed: usize,
    },
}

/// Emit a plan event to both `agent://plan/` and `agent://stream/` channels.
fn emit_plan_event(app: &AppHandle, task_id: &str, event: &PlanStreamEvent) {
    emit_event(app, &format!("agent://plan/{}", task_id), event);
    emit_event(app, &format!("agent://stream/{}", task_id), event);
}

/// Build a plan context string for injection into the LLM conversation.
/// Returns `None` if no plan exists or the plan is fully completed.
pub(crate) fn build_plan_context(state: &AppState, task_id: &str) -> Option<String> {
    let plans = state.plans.read();
    let plan = plans.get(task_id)?;

    let all_terminal = plan.items.iter().all(|item| {
        matches!(
            item.status,
            PlanItemStatus::Completed | PlanItemStatus::Failed | PlanItemStatus::Skipped
        )
    });
    if all_terminal {
        return None;
    }

    let status_symbol = |s: &PlanItemStatus| -> &str {
        match s {
            PlanItemStatus::Completed => "\u{2713}",
            PlanItemStatus::InProgress => "\u{25B6}",
            PlanItemStatus::Pending => "\u{25CB}",
            PlanItemStatus::Failed => "\u{2717}",
            PlanItemStatus::Skipped => "\u{2298}",
        }
    };

    let mut lines = Vec::with_capacity(plan.items.len() + 2);
    lines.push("当前计划:".to_string());
    for (i, item) in plan.items.iter().enumerate() {
        let symbol = status_symbol(&item.status);
        lines.push(format!("[{}] {}. {}", symbol, i + 1, item.title));
    }
    lines.push("请先完成当前步骤，然后调用 update_plan_item 标记状态为 \"completed\"、\"failed\" 或 \"skipped\"。".to_string());

    Some(lines.join("\n"))
}

/// Dispatch plan-related tool output metadata after a tool executes.
pub(crate) async fn handle_plan_tool_output(
    tool_name: &str,
    _tool_call_id: &str,
    task_id: &str,
    meta: &serde_json::Value,
    app: &AppHandle,
    state: &AppState,
) {
    match tool_name {
        "create_plan" => handle_create_plan(app, state, task_id, meta).await,
        "update_plan_item" => {
            let updated = meta
                .get("plan_item_updated")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !updated {
                return;
            }
            let item_id = meta
                .get("item_id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let status = meta
                .get("status")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let error = meta.get("error").and_then(|v| v.as_str()).map(String::from);
            handle_update_plan_item(app, state, task_id, &item_id, &status, &error).await;
        }
        _ => {}
    }
}

/// Process `create_plan` tool output: parse items, store plan in state, emit events.
pub(crate) async fn handle_create_plan(
    app: &AppHandle,
    state: &AppState,
    task_id: &str,
    action: &serde_json::Value,
) {
    let plan_created = action
        .get("plan_created")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !plan_created {
        return;
    }

    let items_json = action.get("items").and_then(|v| v.as_array());
    let Some(items_json) = items_json else { return };

    let mut plan_items = Vec::with_capacity(items_json.len());
    for item_val in items_json {
        let id = item_val
            .get("id")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let title = item_val
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("未命名步骤")
            .to_string();
        let status_str = item_val
            .get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("pending");
        let status = match status_str {
            "pending" => PlanItemStatus::Pending,
            "in_progress" => PlanItemStatus::InProgress,
            "completed" => PlanItemStatus::Completed,
            "failed" => PlanItemStatus::Failed,
            "skipped" => PlanItemStatus::Skipped,
            _ => PlanItemStatus::Pending,
        };
        let error = item_val
            .get("error")
            .and_then(|v| v.as_str())
            .map(String::from);
        plan_items.push(PlanItem {
            id,
            title,
            status,
            error,
        });
    }

    let plan = AgentTaskPlan {
        task_id: task_id.to_string(),
        items: plan_items.clone(),
        current_index: 0,
    };

    state.plans.write().insert(task_id.to_string(), plan);

    if let Some(task) = state.agent_tasks.write().get_mut(task_id) {
        task.has_plan = true;
    }

    let event = PlanStreamEvent::PlanCreated {
        items: plan_items.clone(),
    };
    emit_plan_event(app, task_id, &event);

    log::info!(
        "Plan created for task {} with {} items",
        task_id,
        plan_items.len()
    );
}

/// Process `update_plan_item` tool output: update item status, advance index, emit events.
pub(crate) async fn handle_update_plan_item(
    app: &AppHandle,
    state: &AppState,
    task_id: &str,
    item_id: &str,
    status: &str,
    error: &Option<String>,
) {
    let mut plans = state.plans.write();
    let plan = match plans.get_mut(task_id) {
        Some(p) => p,
        None => return,
    };

    let item_index = plan.items.iter().position(|item| item.id == item_id);
    let Some(item_index) = item_index else { return };
    let total = plan.items.len();

    let new_status = match status {
        "completed" => PlanItemStatus::Completed,
        "failed" => PlanItemStatus::Failed,
        "skipped" => PlanItemStatus::Skipped,
        "in_progress" => PlanItemStatus::InProgress,
        _ => return,
    };

    let title = plan.items[item_index].title.clone();
    plan.items[item_index].status = new_status.clone();
    if let Some(e) = error {
        plan.items[item_index].error = Some(e.clone());
    }
    let error_msg = plan.items[item_index].error.clone();

    match new_status {
        PlanItemStatus::InProgress => {
            let event = PlanStreamEvent::PlanItemStarted {
                item_id: item_id.to_string(),
                title,
                index: item_index,
                total,
            };
            emit_plan_event(app, task_id, &event);
        }
        PlanItemStatus::Completed => {
            let event = PlanStreamEvent::PlanItemCompleted {
                item_id: item_id.to_string(),
                title,
                index: item_index,
                total,
            };
            emit_plan_event(app, task_id, &event);
            advance_current_index(plan);
        }
        PlanItemStatus::Failed => {
            let event = PlanStreamEvent::PlanItemFailed {
                item_id: item_id.to_string(),
                title,
                error: error_msg.unwrap_or_else(|| "未知错误".to_string()),
                index: item_index,
                total,
            };
            emit_plan_event(app, task_id, &event);
        }
        PlanItemStatus::Skipped => {
            let event = PlanStreamEvent::PlanItemSkipped {
                item_id: item_id.to_string(),
                title,
                index: item_index,
                total,
            };
            emit_plan_event(app, task_id, &event);
            advance_current_index(plan);
        }
        PlanItemStatus::Pending => {}
    }

    if is_plan_complete(plan) {
        let completed = plan
            .items
            .iter()
            .filter(|item| matches!(item.status, PlanItemStatus::Completed))
            .count();
        let failed = plan
            .items
            .iter()
            .filter(|item| matches!(item.status, PlanItemStatus::Failed))
            .count();
        let event = PlanStreamEvent::PlanCompleted {
            completed,
            total,
            failed,
        };
        emit_plan_event(app, task_id, &event);
        log::info!(
            "Plan completed for task {}: {}/{} completed, {} failed",
            task_id,
            completed,
            total,
            failed
        );
    }
}

/// Advance current_index to the next Pending item.
fn advance_current_index(plan: &mut AgentTaskPlan) {
    for i in 0..plan.items.len() {
        if matches!(plan.items[i].status, PlanItemStatus::Pending) {
            plan.current_index = i;
            return;
        }
    }
    plan.current_index = plan.items.len();
}

/// Check whether all plan items are in a terminal state.
fn is_plan_complete(plan: &AgentTaskPlan) -> bool {
    plan.items.iter().all(|item| {
        matches!(
            item.status,
            PlanItemStatus::Completed | PlanItemStatus::Failed | PlanItemStatus::Skipped
        )
    })
}
