use serde::Serialize;
use tauri::State;

use crate::agent::conversation::{Conversation, ConversationSearchResult};
use crate::agent::task::AgentTaskPlan;
use crate::error::AppError;
use crate::AppState;

/// 持久化的 plan（已反序列化），用于返回给前端。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredPlan {
    pub task_id: String,
    pub plan: AgentTaskPlan,
    pub updated_at: String,
}

/// 截断会话消息后的结果：消息删除数 + 可选的 plan 调整。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateConversationResult {
    pub deleted_messages: usize,
    /// true：已按快照恢复或清空 plan；false：无可用快照（旧数据），plan 未改动
    pub plan_adjusted: bool,
    /// 恢复后的 plan；仅当 plan_adjusted 且非清空时有值
    pub plan: Option<AgentTaskPlan>,
    /// 与 plan.task_id 一致；清空或未调整时为 null
    pub plan_task_id: Option<String>,
}

/// Create a new AI conversation for the given SSH session.
#[tauri::command]
pub async fn agent_create_conversation(
    state: State<'_, AppState>,
    session_id: String,
    title: Option<String>,
) -> Result<String, AppError> {
    let connection_id = state
        .ssh_manager
        .get_connection_id(&session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    let title = title.unwrap_or_else(|| "新会话".to_string());
    let conversation = state
        .conversation_db
        .create_conversation(&connection_id, &title)
        .map_err(|e| AppError::Agent(format!("Failed to create conversation: {}", e)))?;
    log::info!(
        "Created conversation: {} (connection={})",
        conversation.id,
        connection_id
    );
    Ok(conversation.id)
}

/// List all conversations for a given SSH session.
#[tauri::command]
pub async fn agent_list_conversations(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Conversation>, AppError> {
    let connection_id = state
        .ssh_manager
        .get_connection_id(&session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    let conversations = state
        .conversation_db
        .list_conversations(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to list conversations: {}", e)))?;
    Ok(conversations)
}

/// Load all messages for a conversation.
#[tauri::command]
pub async fn agent_load_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<crate::agent::conversation::StoredMessage>, AppError> {
    let messages = state
        .conversation_db
        .load_messages(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to load messages: {}", e)))?;
    Ok(messages)
}

/// Delete a single conversation.
#[tauri::command]
pub async fn agent_delete_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), AppError> {
    state
        .conversation_db
        .delete_conversation(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to delete conversation: {}", e)))?;
    log::info!("Deleted conversation: {}", conversation_id);
    Ok(())
}

/// Save compressed user images for a message. Returns relative paths under `images/`.
/// `images_base64` items are raw base64 or data URLs (frontend already compressed).
#[tauri::command]
pub async fn agent_save_message_images(
    conversation_id: String,
    message_id: String,
    images_base64: Vec<String>,
) -> Result<Vec<String>, AppError> {
    if conversation_id.is_empty() || message_id.is_empty() {
        return Err(AppError::Agent("conversation_id / message_id 不能为空".into()));
    }
    if images_base64.len() > 5 {
        return Err(AppError::Agent("单次最多 5 张图片".into()));
    }
    let mut paths = Vec::with_capacity(images_base64.len());
    for (i, data) in images_base64.iter().enumerate() {
        let rel = crate::agent::image_store::save_image_base64(
            &conversation_id,
            &message_id,
            i,
            data,
        )
        .map_err(|e| AppError::Agent(format!("保存图片失败: {}", e)))?;
        paths.push(rel);
    }
    Ok(paths)
}

/// Resolve absolute filesystem path for a relative image path (for asset protocol).
#[tauri::command]
pub async fn agent_resolve_image_path(relative_path: String) -> Result<String, AppError> {
    let abs = crate::agent::image_store::absolute_path(&relative_path)
        .map_err(|e| AppError::Agent(e))?;
    Ok(abs.to_string_lossy().to_string())
}

/// Read a persisted message image as a data URL (for restore-to-input after rollback).
#[tauri::command]
pub async fn agent_read_message_image(relative_path: String) -> Result<String, AppError> {
    crate::agent::image_store::read_image_data_url(&relative_path)
        .map_err(|e| AppError::Agent(format!("读取图片失败: {}", e)))
}

/// Delete a message and all messages after it from a conversation,
/// and restore plan from the last snapshot before `from_timestamp` when possible.
///
/// Plan 策略：
/// - 有 `created_at < from_timestamp` 的快照 → 恢复到该快照
/// - 无此前快照，但对话里已有任意快照（plan 全是截断点之后产生的）→ 清空 plan
/// - 完全无快照（升级前旧数据）→ **不改动 plan**
#[tauri::command]
pub async fn agent_truncate_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    from_timestamp: String,
) -> Result<TruncateConversationResult, AppError> {
    let deleted = state
        .conversation_db
        .delete_messages_from_timestamp(&conversation_id, &from_timestamp)
        .map_err(|e| AppError::Agent(format!("Failed to truncate conversation: {}", e)))?;

    let mut task_ids_to_clear: std::collections::HashSet<String> = state
        .conversation_db
        .list_plan_task_ids(&conversation_id)
        .unwrap_or_default()
        .into_iter()
        .collect();
    {
        let tasks = state.agent_tasks.read();
        for (tid, task) in tasks.iter() {
            if task.conversation_id == conversation_id {
                task_ids_to_clear.insert(tid.clone());
            }
        }
    }

    let snapshot = state
        .conversation_db
        .load_plan_snapshot_before(&conversation_id, &from_timestamp)
        .map_err(|e| AppError::Agent(format!("Failed to load plan snapshot: {}", e)))?;

    let has_any_snapshot = state
        .conversation_db
        .has_any_plan_snapshot(&conversation_id)
        .unwrap_or(false);

    let (plan_adjusted, restored_plan, restored_task_id) = match snapshot {
        Some((task_id, plan_json)) => match serde_json::from_str::<AgentTaskPlan>(&plan_json) {
            Ok(mut plan) => {
                plan.task_id = task_id.clone();
                // 撤回时任务不在跑：与 load_plans 一致，in_progress → pending，避免 UI 永久转圈
                let plan = crate::agent::plan_handler::normalize_plan_for_frontend(&plan, false);
                match serde_json::to_string(&plan) {
                    Ok(json) => {
                        if let Err(e) =
                            state
                                .conversation_db
                                .save_plan(&task_id, &conversation_id, &json)
                        {
                            log::warn!(
                                "truncate: save restored plan failed for conv {}: {}",
                                conversation_id,
                                e
                            );
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "truncate: re-serialize restored plan failed for conv {}: {}",
                            conversation_id,
                            e
                        );
                    }
                }
                {
                    let mut plans = state.plans.write();
                    for tid in &task_ids_to_clear {
                        plans.remove(tid);
                    }
                    plans.insert(task_id.clone(), plan.clone());
                }
                // 丢掉截断点及之后的快照，避免「未来」进度再次被选中
                let _ = state
                    .conversation_db
                    .delete_plan_snapshots_from(&conversation_id, &from_timestamp);
                (true, Some(plan), Some(task_id))
            }
            Err(e) => {
                log::warn!(
                    "truncate: corrupt plan snapshot for conv {}: {}",
                    conversation_id,
                    e
                );
                if has_any_snapshot {
                    clear_conversation_plans(&state, &conversation_id, &task_ids_to_clear);
                    let _ = state
                        .conversation_db
                        .delete_plan_snapshots_from(&conversation_id, &from_timestamp);
                    (true, None, None)
                } else {
                    (false, None, None)
                }
            }
        },
        None if has_any_snapshot => {
            // 有快照体系，但截断点之前没有 → plan 全是该 user 消息之后产生的，应清空
            clear_conversation_plans(&state, &conversation_id, &task_ids_to_clear);
            let _ = state
                .conversation_db
                .delete_plan_snapshots_from(&conversation_id, &from_timestamp);
            (true, None, None)
        }
        None => {
            // 旧数据：从未写过快照 → 不碰 plan
            (false, None, None)
        }
    };

    log::info!(
        "Truncated conversation: {} from {} (deleted={}, plan_adjusted={}, plan_restored={})",
        conversation_id,
        from_timestamp,
        deleted,
        plan_adjusted,
        restored_plan.is_some()
    );

    Ok(TruncateConversationResult {
        deleted_messages: deleted,
        plan_adjusted,
        plan: restored_plan,
        plan_task_id: restored_task_id,
    })
}

fn clear_conversation_plans(
    state: &AppState,
    conversation_id: &str,
    task_ids: &std::collections::HashSet<String>,
) {
    if let Err(e) = state
        .conversation_db
        .delete_plans_by_conversation(conversation_id)
    {
        log::warn!(
            "truncate: delete_plans_by_conversation failed for {}: {}",
            conversation_id,
            e
        );
    }
    let mut plans = state.plans.write();
    for tid in task_ids {
        plans.remove(tid);
    }
}

/// List all conversations for a given connection config ID (persistent, works without active session).
#[tauri::command]
pub async fn agent_list_conversations_by_connection(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<Conversation>, AppError> {
    let conversations = state
        .conversation_db
        .list_conversations(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to list conversations: {}", e)))?;
    Ok(conversations)
}

/// 全文搜索聊天历史（消息 content），按会话聚合。
/// keyword 为空返回空列表；可选 connection_id 限定连接。
#[tauri::command]
pub async fn agent_search_conversations(
    state: State<'_, AppState>,
    keyword: String,
    connection_id: Option<String>,
) -> Result<Vec<ConversationSearchResult>, AppError> {
    log::info!(
        "agent_search_conversations: keyword_len={}, connection_filter={}",
        keyword.trim().chars().count(),
        connection_id.is_some()
    );
    let results = state
        .conversation_db
        .search_conversations(&keyword, connection_id.as_deref())
        .map_err(|e| AppError::Agent(format!("Failed to search conversations: {}", e)))?;
    Ok(results)
}

/// Delete all conversations for a given SSH session.
#[tauri::command]
pub async fn agent_delete_conversations_by_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    let connection_id = state
        .ssh_manager
        .get_connection_id(&session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))?;

    state
        .conversation_db
        .delete_conversations_by_connection(&connection_id)
        .map_err(|e| {
            AppError::Agent(format!("Failed to delete conversations by session: {}", e))
        })?;
    log::info!(
        "Deleted all conversations for session: {} (connection={})",
        session_id,
        connection_id
    );
    Ok(())
}

/// 加载某对话下所有持久化的 plan（按 updated_at 倒序），已反序列化为 AgentTaskPlan。
/// 前端在 switchConversation/loadConversation 时调用，把结果写入 useTaskStore.plans，
/// 使重启后仍能恢复 plan 列表展示。
///
/// **降级处理**：重启后 agent 没在跑，plan 里的 in_progress item 对用户而言是
/// "未完成"而非"进行中"。这里在返回前把 in_progress → pending，使前端 data
/// 和 UI 一致，避免 spinning 图标误导。后端 state.plans 不受影响。
#[tauri::command]
pub async fn agent_load_plans_by_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<StoredPlan>, AppError> {
    let rows = state
        .conversation_db
        .load_plans_by_conversation(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to load plans: {}", e)))?;

    let mut plans = Vec::with_capacity(rows.len());
    for (task_id, plan_json, updated_at) in rows {
        match serde_json::from_str::<AgentTaskPlan>(&plan_json) {
            Ok(mut plan) => {
                // 迁移旧格式 id：item-N → N（1-based 纯数字）。
                // 旧版 create_plan 生成 "item-0" 格式，新版生成 "1" 格式。
                // 这里在 load 时统一转成新格式，并 reflow next_item_seq 避免
                // 后续 edit_plan add 生成冲突 id。
                let needs_migrate = plan
                    .items
                    .iter()
                    .any(|it| it.id.starts_with("item-"));
                if needs_migrate {
                    for it in &mut plan.items {
                        if let Some(num) = it.id.strip_prefix("item-") {
                            // 旧格式 item-N 是 0-based，转成 1-based（item-0 → 1）
                            if let Ok(n) = num.parse::<usize>() {
                                it.id = (n + 1).to_string();
                            }
                        }
                    }
                    // reflow next_item_seq：取当前最大数字 id + 1
                    let max_id = plan
                        .items
                        .iter()
                        .filter_map(|it| it.id.parse::<usize>().ok())
                        .max()
                        .unwrap_or(0);
                    plan.next_item_seq = max_id + 1;
                    log::info!(
                        "Migrated plan ids for task {} in conversation {}: next_item_seq={}",
                        task_id,
                        conversation_id,
                        plan.next_item_seq
                    );
                }
                // agent 没跑时降级 in_progress → pending（见 plan_handler 文档）
                let is_running =
                    crate::agent::plan_handler::is_task_running_for_load(&state, &task_id);
                let normalized =
                    crate::agent::plan_handler::normalize_plan_for_frontend(&plan, is_running);
                plans.push(StoredPlan {
                    task_id,
                    plan: normalized,
                    updated_at,
                });
            }
            Err(e) => log::warn!(
                "Failed to deserialize plan for task {} in conversation {}: {}",
                task_id,
                conversation_id,
                e
            ),
        }
    }
    Ok(plans)
}
