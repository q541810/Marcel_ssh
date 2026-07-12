use serde::Serialize;
use serde_json::json;
use tauri::AppHandle;

use crate::agent::task::{AgentTaskPlan, PlanItem, PlanItemStatus};
use crate::emit_event;
use crate::AppState;

/// 每轮 agent loop 注入的「当前计划状态」system 消息前缀。
/// 构建与清理共用同一前缀，避免多轮累积污染 history。
pub(crate) const PLAN_CONTEXT_PREFIX: &str = "当前计划:";

/// 把 plan 序列化存盘。在 create/update/edit 改完内存 plan 后调用。
/// 失败只记日志，不影响主流程（plan 持久化是 best-effort）。
fn persist_plan(state: &AppState, task_id: &str, plan: &AgentTaskPlan) {
    let conversation_id = state
        .agent_tasks
        .read()
        .get(task_id)
        .map(|t| t.conversation_id.clone());
    let Some(conversation_id) = conversation_id else {
        log::warn!("persist_plan: task {} not found in agent_tasks", task_id);
        return;
    };
    match serde_json::to_string(plan) {
        Ok(plan_json) => {
            if let Err(e) = state
                .conversation_db
                .save_plan(task_id, &conversation_id, &plan_json)
            {
                log::warn!("persist_plan: save_plan failed for task {}: {}", task_id, e);
                return;
            }
            // 成功落盘后写时间点快照，供撤回消息时恢复 plan
            if let Err(e) = state.conversation_db.insert_plan_snapshot(
                &conversation_id,
                task_id,
                &plan_json,
            ) {
                log::warn!(
                    "persist_plan: insert_plan_snapshot failed for task {}: {}",
                    task_id,
                    e
                );
            }
        }
        Err(e) => {
            log::warn!("persist_plan: serialize failed for task {}: {}", task_id, e);
        }
    }
}

/// Events emitted during agent planning and step execution.
///
/// 所有变体都携带完整 `items` 和 `current_index`（全量推送），前端收到后
/// 直接 `setPlan` 覆盖即可，无需增量合并，避免状态不一致。
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
        items: Vec<PlanItem>,
        current_index: usize,
    },
    #[serde(rename_all = "camelCase")]
    PlanItemCompleted {
        item_id: String,
        title: String,
        index: usize,
        total: usize,
        items: Vec<PlanItem>,
        current_index: usize,
    },
    #[serde(rename_all = "camelCase")]
    PlanItemFailed {
        item_id: String,
        title: String,
        error: String,
        index: usize,
        total: usize,
        items: Vec<PlanItem>,
        current_index: usize,
    },
    #[serde(rename_all = "camelCase")]
    PlanItemSkipped {
        item_id: String,
        title: String,
        index: usize,
        total: usize,
        items: Vec<PlanItem>,
        current_index: usize,
    },
    #[serde(rename_all = "camelCase")]
    PlanCompleted {
        completed: usize,
        total: usize,
        failed: usize,
        items: Vec<PlanItem>,
        current_index: usize,
    },
    /// 计划结构被 edit_plan 工具调整（增删改 item）。
    /// 整体替换 items，前端无需逐 op 渲染。
    #[serde(rename_all = "camelCase")]
    PlanEdited {
        ops: Vec<serde_json::Value>,
        items: Vec<PlanItem>,
        current_index: usize,
    },
}

/// Emit a plan event to `agent://plan/` channel.
///
/// 不再推到 `agent://stream/`：stream listener 不处理 plan-* 事件，推过去
/// 只会触发 `console.warn('[agent] unknown event type')` 污染控制台。
fn emit_plan_event(app: &AppHandle, task_id: &str, event: &PlanStreamEvent) {
    emit_event(app, &format!("agent://plan/{}", task_id), event);
}

/// 判断 task 是否正在运行（agent 还在跑）。
/// 用于决定向前端发送 plan 时是否需要把 in_progress 降级为 pending。
pub(crate) fn is_task_running_for_load(state: &AppState, task_id: &str) -> bool {
    state
        .agent_tasks
        .read()
        .get(task_id)
        .map_or(false, |t| {
            matches!(
                t.status,
                crate::agent::task::AgentStatus::Planning
                    | crate::agent::task::AgentStatus::Executing
                    | crate::agent::task::AgentStatus::WaitingApproval
            )
        })
}

/// 把 plan 的 in_progress item 转为 pending（agent 没跑时的降级）。
///
/// 后端 state.plans 保留真实状态（in_progress），只在**发送给前端**时降级。
/// 这样前端 store 里的 data 就是 pending，UI 不会显示 spinning 误导用户
/// 以为 task 还在跑，排查问题时 data 和 UI 也一致。
///
/// 降级时机：
/// - agent_load_plans_by_conversation 返回前（重启后前端拉取）
/// - task 终止时主动 emit 一次降级后的 plan（见 emit_final_plan_normalized）
pub(crate) fn normalize_plan_for_frontend(plan: &AgentTaskPlan, is_running: bool) -> AgentTaskPlan {
    if is_running {
        return plan.clone();
    }
    let mut normalized = plan.clone();
    for item in &mut normalized.items {
        if item.status == PlanItemStatus::InProgress {
            item.status = PlanItemStatus::Pending;
        }
    }
    normalized
}

/// task 终止时调用：如果 plan 有非终态 item，emit 一次降级后的 plan 给前端。
/// agent_loop 在 emit Done/Error 之前调用，确保前端收到的最终 plan 状态
/// 是降级后的（in_progress → pending），避免 spinning 图标永久转下去。
pub(crate) fn emit_final_plan_normalized(
    app: &AppHandle,
    state: &AppState,
    task_id: &str,
) {
    let plan = match state.plans.read().get(task_id).cloned() {
        Some(p) => p,
        None => return,
    };
    // agent 已终止，is_running 一定为 false，这里显式传 false
    let normalized = normalize_plan_for_frontend(&plan, false);
    // 只有 plan 确实有变化时才 emit（避免无 plan 或全终态 plan 的无意义 emit）
    if normalized.items == plan.items {
        return;
    }
    let event = PlanStreamEvent::PlanCreated {
        items: normalized.items.clone(),
    };
    emit_plan_event(app, task_id, &event);
}

/// 构建注入 LLM 对话的 plan 上下文文本。
/// 无 plan 或全部步骤已终态时返回 `None`。
///
/// 以临时 **system** 消息注入（不是 user），避免模型把计划状态当成用户新发言。
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
    lines.push(PLAN_CONTEXT_PREFIX.to_string());
    for item in plan.items.iter() {
        let symbol = status_symbol(&item.status);
        // 用 item.id 作为编号，与用户在 PlanList UI 看到的编号一致。
        // id 不重排（删除留空洞），删除后可能跳号（1, 3, 4），但保证
        // LLM 和用户看到的编号指向同一个 item，无歧义。
        lines.push(format!("[{}] {}. {}", symbol, item.id, item.title));
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
) -> Option<String> {
    match tool_name {
        "create_plan" => {
            handle_create_plan(app, state, task_id, meta).await;
            None
        }
        "edit_plan" => {
            let edited = meta
                .get("plan_edited")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !edited {
                return None;
            }
            // plan 不存在时返回错误提示，覆盖 tool output（tool 层无 state 访问，
            // 会返回误导性成功）。让 LLM 知道需要先 create_plan。
            if state.plans.read().get(task_id).is_none() {
                return Some(
                    "当前任务没有 plan，无法执行 edit_plan。请先调用 create_plan 创建计划。"
                        .to_string(),
                );
            }
            let ops = meta
                .get("ops")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            handle_edit_plan(app, state, task_id, &ops).await;
            None
        }
        "update_plan_item" => {
            let updated = meta
                .get("plan_item_updated")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            if !updated {
                return None;
            }
            // plan 不存在时返回错误提示，覆盖 tool output。
            if state.plans.read().get(task_id).is_none() {
                return Some(
                    "当前任务没有 plan，无法执行 update_plan_item。请先调用 create_plan 创建计划。"
                        .to_string(),
                );
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
            handle_update_plan_item(app, state, task_id, &item_id, &status, &error).await
        }
        _ => None,
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
        // id 用 1-based（i+1），已用 id 范围 1..=len，下一个未用 id 是 len+1。
        // 之前误初始化为 len，会导致首次 edit_plan add 生成与最后一个 item
        // 相同的 id（都是 len），后续 update/remove 按 id 查找命中错误 item。
        next_item_seq: plan_items.len() + 1,
        reflection_reminded: false,
    };

    state.plans.write().insert(task_id.to_string(), plan);

    if let Some(task) = state.agent_tasks.write().get_mut(task_id) {
        task.has_plan = true;
    }

    // 持久化 plan 到 SQLite
    if let Some(p) = state.plans.read().get(task_id) {
        persist_plan(state, task_id, p);
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
///
/// 返回 `Option<String>`：如果触发反思拦截，返回反思提醒文本（需追加到 tool output
/// 给 LLM）。否则返回 `None`。
///
/// 反思拦截逻辑：
/// - 当本次 update 把某个 item 改为终态（completed/failed/skipped）后，所有 item
///   都进入终态，且 `!reflection_reminded` 时触发
/// - 触发时：回滚本次状态变更（item 改回原值），设 `reflection_reminded = true`，
///   不 emit PlanCompleted（前端保持"进行中"），返回反思提醒文本
/// - LLM 再次调用 update_plan_item 把最后一个 item 标记为终态时，`reflection_reminded
///   == true`，正常走完成流程，不再拦截
pub(crate) async fn handle_update_plan_item(
    app: &AppHandle,
    state: &AppState,
    task_id: &str,
    item_id: &str,
    status: &str,
    error: &Option<String>,
) -> Option<String> {
    let mut plans = state.plans.write();
    let plan = match plans.get_mut(task_id) {
        Some(p) => p,
        None => return None,
    };

    let item_index = plan.items.iter().position(|item| item.id == item_id);
    let Some(item_index) = item_index else { return None };
    let total = plan.items.len();

    let new_status = match status {
        "completed" => PlanItemStatus::Completed,
        "failed" => PlanItemStatus::Failed,
        "skipped" => PlanItemStatus::Skipped,
        "in_progress" => PlanItemStatus::InProgress,
        _ => return None,
    };

    // 记录原状态和原 error，用于反思拦截时回滚
    let original_status = plan.items[item_index].status.clone();
    let original_error = plan.items[item_index].error.clone();
    let is_terminal_transition = matches!(
        new_status,
        PlanItemStatus::Completed | PlanItemStatus::Failed | PlanItemStatus::Skipped
    );

    let title = plan.items[item_index].title.clone();
    plan.items[item_index].status = new_status.clone();
    // 非 failed 终态清除旧 error；failed 设置新 error；其他状态保留原 error
    if matches!(new_status, PlanItemStatus::Completed | PlanItemStatus::Skipped) {
        plan.items[item_index].error = None;
    } else if let Some(e) = error {
        plan.items[item_index].error = Some(e.clone());
    }
    let error_msg = plan.items[item_index].error.clone();

    // 反思拦截：本次改为终态 && 改完所有 item 都终态 && 没提醒过
    if is_terminal_transition && !plan.reflection_reminded && is_plan_complete(plan) {
        // 回滚本次状态变更（status 和 error 都恢复原值）
        plan.items[item_index].status = original_status.clone();
        plan.items[item_index].error = original_error;
        plan.reflection_reminded = true;

        log::info!(
            "Plan reflection triggered for task {}: item {} rolled back to {:?}",
            task_id,
            item_id,
            original_status
        );

        let reminder = "你刚尝试把最后一个 plan item 标记为完成的行动已被系统拦截，这个 plan item 仍非完成状态。请反思：任务真的都完成了吗？\n\
             - 如果确实完成，请再次调用 update_plan_item 把该 item 标记为终态，届时不会被拦截。\n\
             - 如果还有未完成的工作，请用 update_plan_item 把对应 item 改回 in_progress 继续执行，\n\
               或用 edit_plan 增补新步骤。"
            .to_string();
        // NLL: plan 的最后一次使用已结束，释放对 plans 的写锁借用
        drop(plans);
        if let Some(p) = state.plans.read().get(task_id) {
            persist_plan(state, task_id, p);
        }
        return Some(reminder);
    }

    match new_status {
        PlanItemStatus::InProgress => {
            let event = PlanStreamEvent::PlanItemStarted {
                item_id: item_id.to_string(),
                title,
                index: item_index,
                total,
                items: plan.items.clone(),
                current_index: plan.current_index,
            };
            emit_plan_event(app, task_id, &event);
        }
        PlanItemStatus::Completed => {
            advance_current_index(plan);
            let event = PlanStreamEvent::PlanItemCompleted {
                item_id: item_id.to_string(),
                title,
                index: item_index,
                total,
                items: plan.items.clone(),
                current_index: plan.current_index,
            };
            emit_plan_event(app, task_id, &event);
        }
        PlanItemStatus::Failed => {
            let event = PlanStreamEvent::PlanItemFailed {
                item_id: item_id.to_string(),
                title,
                error: error_msg.unwrap_or_else(|| "未知错误".to_string()),
                index: item_index,
                total,
                items: plan.items.clone(),
                current_index: plan.current_index,
            };
            emit_plan_event(app, task_id, &event);
        }
        PlanItemStatus::Skipped => {
            advance_current_index(plan);
            let event = PlanStreamEvent::PlanItemSkipped {
                item_id: item_id.to_string(),
                title,
                index: item_index,
                total,
                items: plan.items.clone(),
                current_index: plan.current_index,
            };
            emit_plan_event(app, task_id, &event);
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
            items: plan.items.clone(),
            current_index: plan.current_index,
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

    // NLL: plan 的最后一次使用已结束，释放对 plans 的写锁借用
    drop(plans);
    if let Some(p) = state.plans.read().get(task_id) {
        persist_plan(state, task_id, p);
    }
    None
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

/// 处理 `edit_plan` 工具输出：按 ops 批量调整 plan 结构（增删改 item）。
///
/// 规则：
/// - `add`：必填 `after_item_id` + `title`，在指定 item 后插入，id 由 `next_item_seq` 生成
/// - `remove`：必填 `item_id`，允许删除 in_progress 的 item
/// - `rename`：必填 `item_id` + `title`
/// - ops 顺序执行，无效 op（item_id 不存在等）跳过不中断
/// - 删除/插入后修正 `current_index`：若指向的 item 不再是 pending/in_progress，重置到第一个 pending
/// - id 不重排，删除留空洞（item-0/item-2 这种），避免 id 漂移
pub(crate) async fn handle_edit_plan(
    app: &AppHandle,
    state: &AppState,
    task_id: &str,
    ops: &[serde_json::Value],
) {
    let mut plans = state.plans.write();
    let Some(plan) = plans.get_mut(task_id) else {
        return;
    };
    let total = plan.items.len();

    let mut applied_ops: Vec<serde_json::Value> = Vec::with_capacity(ops.len());
    for op in ops {
        let action = op.get("action").and_then(|v| v.as_str()).unwrap_or("");
        match action {
            "add" => {
                let after_id = op.get("after_item_id").and_then(|v| v.as_str());
                let title = op
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名步骤");
                let Some(after_id) = after_id else { continue };
                let Some(after_idx) = plan.items.iter().position(|it| it.id == after_id) else {
                    continue;
                };
                let new_id = format!("{}", plan.next_item_seq);
                plan.next_item_seq += 1;
                plan.items.insert(
                    after_idx + 1,
                    PlanItem {
                        id: new_id.clone(),
                        title: title.to_string(),
                        status: PlanItemStatus::Pending,
                        error: None,
                    },
                );
                applied_ops.push(json!({
                    "action": "add",
                    "item_id": new_id,
                    "after_item_id": after_id,
                    "title": title
                }));
            }
            "remove" => {
                let Some(item_id) = op.get("item_id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(idx) = plan.items.iter().position(|it| it.id == item_id) else {
                    continue;
                };
                plan.items.remove(idx);
                applied_ops.push(json!({
                    "action": "remove",
                    "item_id": item_id
                }));
            }
            "rename" => {
                let Some(item_id) = op.get("item_id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(title) = op.get("title").and_then(|v| v.as_str()) else {
                    continue;
                };
                let Some(item) = plan.items.iter_mut().find(|it| it.id == item_id) else {
                    continue;
                };
                item.title = title.to_string();
                applied_ops.push(json!({
                    "action": "rename",
                    "item_id": item_id,
                    "title": title
                }));
            }
            _ => continue,
        }
    }

    // current_index 修正：若越界或指向的 item 已是终态，重置到第一个 pending
    let need_fix = plan.current_index >= plan.items.len()
        || !matches!(
            plan.items.get(plan.current_index).map(|it| &it.status),
            Some(PlanItemStatus::Pending) | Some(PlanItemStatus::InProgress)
        );
    if need_fix {
        plan.current_index = plan
            .items
            .iter()
            .position(|it| matches!(it.status, PlanItemStatus::Pending))
            .unwrap_or(plan.items.len());
    }

    let event = PlanStreamEvent::PlanEdited {
        ops: applied_ops.clone(),
        items: plan.items.clone(),
        current_index: plan.current_index,
    };
    emit_plan_event(app, task_id, &event);

    log::info!(
        "Plan edited for task {}: {} ops applied, items {} -> {}",
        task_id,
        applied_ops.len(),
        total,
        plan.items.len()
    );

    // NLL: plan 的最后一次使用已结束，释放对 plans 的写锁借用
    drop(plans);
    if let Some(p) = state.plans.read().get(task_id) {
        persist_plan(state, task_id, p);
    }
}
