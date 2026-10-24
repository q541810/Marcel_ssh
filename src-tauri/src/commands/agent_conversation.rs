use serde::Serialize;
use tauri::State;

use crate::agent::conversation::{AnchorRef, Conversation, ConversationSearchResult, ForkError};
use crate::agent::task::AgentTaskPlan;
use crate::error::AppError;
use crate::AppState;

/// The frontend debug server is intentionally an in-memory session and never
/// registers an SSH connection. Conversation records still need a stable
/// connection bucket so the normal Agent UI can use the LLM while the fake
/// terminal remains inert.
const DEBUG_SERVER_ID: &str = "debug:msfakeserver";

/// 归档保留天数上限（十年）。与前端设置项上限一致 —— 手改 settings.json 传入
/// `u64::MAX` 时，`Utc::now() - Duration::days(..)` 会 panic，这里先夹住。
const MAX_ARCHIVE_RETENTION_DAYS: u64 = 3650;

/// 保留天数 → 实际用于计算截止时间的天数（夹到上限，避免极端值溢出 panic）。
fn retention_window_days(retention_days: u64) -> i64 {
    retention_days.min(MAX_ARCHIVE_RETENTION_DAYS) as i64
}

/// 归档前的「正在运行」判定，与前端 `conversationIsBusy` 同口径：
/// 子树（主对话 + 子agent对话）里任一对话有运行中的任务，或正在手动压缩。
///
/// 放在命令层而不是前端，是因为 MCP / 插件等调用方可以绕过 UI 直接调命令 ——
/// 前端拦截只保护「用户点按钮」这一条路径。
fn conversation_subtree_is_busy(
    tasks: &std::collections::HashMap<String, crate::agent::task::AgentTask>,
    compactions: &crate::cancel::CancellationRegistry,
    ids: &[String],
) -> bool {
    ids.iter().any(|id| {
        compactions.is_registered(id)
            || tasks
                .values()
                .any(|task| &task.conversation_id == id && task.status.is_running())
    })
}

async fn connection_id_for_session(
    state: &AppState,
    session_id: &str,
) -> Result<String, AppError> {
    if session_id.starts_with("debug-session:") {
        return Ok(DEBUG_SERVER_ID.to_string());
    }
    state
        .ssh_manager
        .get_connection_id(session_id)
        .await
        .ok_or_else(|| AppError::Ssh(format!("会话不存在: {}", session_id)))
}

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
    let connection_id = connection_id_for_session(state.inner(), &session_id).await?;

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

/// 解析会话当前「生效模型 id」：会话级模型记忆（session_models，须仍存在
/// 于注册表）优先；无记忆/记忆失效 → 全局最近使用（last_used_model_id，仍
/// 存在时）→ 注册表第一个模型；完全无模型 → None。
/// 语义与前端 `effectiveModel`/`effectiveDefaultModel` 完全一致。
fn effective_model_id(
    registry: &crate::llm::registry::LlmRegistry,
    session_models: &std::collections::HashMap<String, String>,
    conv_id: &str,
) -> Option<String> {
    if let Some(mid) = session_models.get(conv_id).filter(|s| !s.is_empty()) {
        if registry.find_model(mid).is_some() {
            return Some(mid.clone());
        }
    }
    if !registry.last_used_model_id.is_empty() {
        if registry.find_model(&registry.last_used_model_id).is_some() {
            return Some(registry.last_used_model_id.clone());
        }
    }
    registry.models.first().map(|m| m.id.clone())
}

/// 会话当前生效模型的思考档位：`session_efforts[conv][生效模型 id]`。
/// 无记忆/空档位 = None（跟随模型自身默认，不注入 reasoning_effort）。
fn effort_for_model<'a>(
    efforts: &'a std::collections::HashMap<String, std::collections::HashMap<String, String>>,
    conv_id: &str,
    eff_model_id: Option<&str>,
) -> Option<String> {
    let eff = eff_model_id?;
    efforts
        .get(conv_id)
        .and_then(|m| m.get(eff))
        .filter(|s| !s.is_empty())
        .cloned()
}

/// 会话当前**生效的上下文窗口**（tokens；0 = 未配置）。
///
/// 与 `agent::manager` 启动任务时的规则**同一套**（`resolved.context_window > 0`
/// 优先，否则全局 `agentModeSettings.contextWindow`），只是这里每次读会话时现算
/// ——窗口不落库，用户改了设置立刻生效，占用环不会基于旧窗口算百分比。
/// 生效模型解析不出来（注册表为空等）→ 全局值。
fn effective_context_window(
    registry: &crate::llm::registry::LlmRegistry,
    effective_model_id: Option<&str>,
    global_context_window: u64,
) -> u64 {
    let model_window = effective_model_id
        .and_then(|id| registry.find_model(id))
        .map(|m| m.context_window)
        .unwrap_or(0);
    if model_window > 0 {
        model_window
    } else {
        global_context_window
    }
}

/// 把会话级模型记忆 / 思考强度记忆（内存）覆盖到会话元数据上返回给前端。
///
/// DB 的 `Conversation.model_id` 列已停用（启动迁移后清空），但前端 UI
/// 仍从 `conversations[id].modelId` 读取会话当前模型。
/// 这里统一用内存 `session_models` / `session_efforts` 覆盖该字段（有记忆 =
/// 记忆值；无记忆 = None = 跟随全局最近使用 / 模型默认），保证前端所有
/// 读取点语义与后端路由完全一致，且 DB 列保持干净。
/// `reasoningEffort` 语义：**当前生效模型**的档位（会话×模型 双维记忆里
/// 取生效模型那一维），模型切换后随 list/get 自动变为新模型自己的档位。
/// `contextWindow` 语义：当前生效模型声明的窗口（未声明则全局设置），
/// 同样是读时派生、不落库。
async fn overlay_session_model(state: &AppState, mut conv: Conversation) -> Conversation {
    let settings = state.settings.read().await;
    let registry = &settings.llm_registry;
    let global_window = settings.agent_mode_settings.context_window;
    let mem = state.session_models.read();
    let session_model_id = mem.get(&conv.id).filter(|s| !s.is_empty()).cloned();
    let eff_model_id = effective_model_id(registry, &mem, &conv.id);
    drop(mem);
    let efforts = state.session_efforts.read();
    let effort = effort_for_model(&efforts, &conv.id, eff_model_id.as_deref());
    drop(efforts);
    conv.model_id = session_model_id;
    conv.reasoning_effort = effort;
    conv.context_window = Some(effective_context_window(
        registry,
        eff_model_id.as_deref(),
        global_window,
    ));
    conv.usage = conversation_usage(state, &conv.id).unwrap_or_else(|| conv.usage.clone());
    conv
}

/// 会话的界面读数（本会话 + 各子对话的累计）。读失败时返回 `None`，
/// 调用方保留行上原本的值（宁可少算子 agent，也不能让会话打不开）。
fn conversation_usage(
    state: &AppState,
    conversation_id: &str,
) -> Option<crate::agent::conversation::ConversationUsage> {
    match state
        .conversation_db
        .usage_with_sub_conversations(conversation_id)
    {
        Ok(u) => Some(u),
        Err(e) => {
            log::warn!("读取会话用量失败（{}）: {}", conversation_id, e);
            None
        }
    }
}

async fn overlay_session_models(state: &AppState, convs: Vec<Conversation>) -> Vec<Conversation> {
    let settings = state.settings.read().await;
    let registry = &settings.llm_registry;
    let global_window = settings.agent_mode_settings.context_window;
    let mem = state.session_models.read();
    let efforts = state.session_efforts.read();
    let mut out = Vec::with_capacity(convs.len());
    for mut c in convs {
        let session_model_id = mem.get(&c.id).filter(|s| !s.is_empty()).cloned();
        let eff_model_id = effective_model_id(registry, &mem, &c.id);
        let effort = effort_for_model(&efforts, &c.id, eff_model_id.as_deref());
        c.model_id = session_model_id;
        c.reasoning_effort = effort;
        c.context_window = Some(effective_context_window(
            registry,
            eff_model_id.as_deref(),
            global_window,
        ));
        c.usage = conversation_usage(state, &c.id).unwrap_or_else(|| c.usage.clone());
        out.push(c);
    }
    out
}

/// 删除会话时同步清理内存模型/思考强度记忆，避免悬挂条目累积。
fn drop_session_models(state: &AppState, ids: &[String]) {
    if ids.is_empty() {
        return;
    }
    let mut mem = state.session_models.write();
    let mut efforts = state.session_efforts.write();
    for id in ids {
        mem.remove(id);
        efforts.remove(id);
    }
}

/// 会话被删：清掉长期记忆里只属于这些会话的东西（注入快照、复盘进度与提示行、
/// 挂着的复盘定时器）。记忆条目本身保留——记忆比会话活得久正是它的意义。
fn forget_conversations_in_memory(state: &AppState, ids: &[String]) {
    for id in ids {
        state.memory.reflector.forget(id);
        if let Err(e) = state.memory.store.forget_conversation(id) {
            log::warn!("清理会话 {id} 的记忆附属数据失败: {e}");
        }
    }
}

/// 读取单个会话元数据（含 parent_conversation_id，用于子对话"返回主对话"）。
#[tauri::command]
pub async fn agent_get_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Conversation, AppError> {
    let conv = state
        .conversation_db
        .get_conversation(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to get conversation: {}", e)))?
        .ok_or_else(|| AppError::Agent(format!("会话不存在: {}", conversation_id)))?;
    Ok(overlay_session_model(&state, conv).await)
}

/// 过滤掉子agent对话（subagent 工具创建，parent_conversation_id 非空）：
/// 子对话不出现在会话列表/历史/搜索中，只通过主对话的 task 卡片进入。
fn filter_sub_conversations(convs: Vec<Conversation>) -> Vec<Conversation> {
    convs
        .into_iter()
        .filter(|c| c.parent_conversation_id.is_none())
        .collect()
}

/// List all conversations for a given SSH session.
#[tauri::command]
pub async fn agent_list_conversations(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<Conversation>, AppError> {
    let connection_id = connection_id_for_session(state.inner(), &session_id).await?;

    let conversations = state
        .conversation_db
        .list_active_conversations(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to list conversations: {}", e)))?;
    Ok(overlay_session_models(&state, filter_sub_conversations(conversations)).await)
}

/// List archived conversations for a connection (archived view).
#[tauri::command]
pub async fn agent_list_archived_conversations(
    state: State<'_, AppState>,
    connection_id: String,
) -> Result<Vec<Conversation>, AppError> {
    let conversations = state
        .conversation_db
        .list_archived_conversations(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to list archived conversations: {}", e)))?;
    Ok(overlay_session_models(&state, filter_sub_conversations(conversations)).await)
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

/// 从最新 Compaction Checkpoint 开始加载活跃消息段。
#[tauri::command]
pub async fn agent_load_active_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<crate::agent::conversation::ActiveMessagesResult, AppError> {
    let result = state
        .conversation_db
        .load_active_messages(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to load active messages: {}", e)))?;
    Ok(result)
}

/// 加载指定消息之前的更早归档历史消息（按需翻页，一页 `limit` 条）。
#[tauri::command]
pub async fn agent_load_earlier_messages(
    state: State<'_, AppState>,
    conversation_id: String,
    before_message_id: String,
    limit: Option<usize>,
) -> Result<crate::agent::conversation::EarlierMessagesResult, AppError> {
    // 页长由前端传（UI 每页展示条数）；服务端钳制防异常值。
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let (messages, has_more) = state
        .conversation_db
        .load_earlier_messages(&conversation_id, &before_message_id, limit)
        .map_err(|e| AppError::Agent(format!("Failed to load earlier messages: {}", e)))?;
    Ok(crate::agent::conversation::EarlierMessagesResult { messages, has_more })
}

/// Rename a conversation.
#[tauri::command]
pub async fn agent_rename_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    title: String,
) -> Result<(), AppError> {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return Err(AppError::Agent("会话名称不能为空".into()));
    }
    state
        .conversation_db
        .update_conversation_title(&conversation_id, trimmed)
        .map_err(|e| AppError::Agent(format!("Failed to rename conversation: {}", e)))?;
    log::info!("Renamed conversation: {} to {}", conversation_id, trimmed);

    Ok(())
}

/// 设置/取消会话置顶。
///
/// 只改列表视图的元数据：**不更新 `updated_at`、不产生内容变更**，
/// 因此取消置顶不会把对话打回日期分组最前面（见 `ConversationDb::set_conversation_pinned`）。
#[tauri::command]
pub async fn agent_set_conversation_pinned(
    state: State<'_, AppState>,
    conversation_id: String,
    pinned: bool,
) -> Result<(), AppError> {
    let updated = state
        .conversation_db
        .set_conversation_pinned(&conversation_id, pinned)
        .map_err(|e| AppError::Agent(format!("Failed to pin conversation: {}", e)))?;
    if !updated {
        return Err(AppError::Agent(format!("会话不存在: {}", conversation_id)));
    }
    log::info!(
        "{} conversation: {}",
        if pinned { "Pinned" } else { "Unpinned" },
        conversation_id
    );

    Ok(())
}

/// 分叉会话：把 `conversation_id` 的历史（到锚点所在回合末尾，缺省 = 整个
/// 会话）复制成一条独立的新会话并返回它的元数据。来源完全不受影响。
///
/// 锚点有两种定位：`anchor_message_id`（库内行 id；会话重载后前端消息的 id 就是
/// 它，live 回合则是前端临时 id、库里查不到）与 `anchor_turn_started_at`（锚点
/// 回合首条 user 消息的发送时刻，两个 id 域通用，与撤回的定位同思路）。id 优先、
/// 解析不到再拿时间戳兜底——live 回合的分叉靠这一条才能成立。
///
/// 库里的东西（消息、图片、子对话、计划）由 `ConversationDb::fork_conversation` 一次事务搬完；
/// 这里补上它够不着的会话级状态，让分叉「开口说话」时与来源一致：
/// - 会话级模型 / 思考档位（内存 + `efforts_json`）：否则分叉会落回全局最近使用的模型；
/// - 记忆注入快照与复盘进度（`MemoryStore::fork_conversation`）。
///
/// 这些补充都是尽力而为：失败只记日志，不让已经建好的分叉白建 —— 最坏是分叉的第一轮
/// 重新渲染一次记忆、用全局模型，用户随时可以改。
#[tauri::command]
pub async fn agent_fork_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    anchor_message_id: Option<String>,
    anchor_turn_started_at: Option<String>,
    title: Option<String>,
) -> Result<Conversation, AppError> {
    let source = state
        .conversation_db
        .get_conversation(&conversation_id)
        .map_err(|e| AppError::Agent(format!("读取会话失败: {}", e)))?
        .ok_or_else(|| AppError::Agent(format!("会话不存在: {}", conversation_id)))?;

    // 来源正在跑任务或压缩：范围到达会话末尾时会拷到写了一半的回合 / 压缩卡还没落位，
    // 库层据此拒绝；分叉更早的回合不受影响。
    let tail_busy = crate::memory::reflect::conversation_has_running_task(&state, &conversation_id)
        || state.compactions.is_registered(&conversation_id);

    // 时间戳解析失败不报错：id 锚点仍可能命中（重载过的会话），别让一个坏时间戳
    // 把整个分叉堵死。
    let anchor_ts = anchor_turn_started_at
        .as_deref()
        .and_then(|s| {
            chrono::DateTime::parse_from_rfc3339(s)
                .map(|t| t.with_timezone(&chrono::Utc))
                .ok()
        });
    if anchor_turn_started_at.is_some() && anchor_ts.is_none() {
        log::warn!("分叉锚点时间无法解析: {anchor_turn_started_at:?}");
    }

    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| format!("{} · 分支", source.title));
    let outcome = state
        .conversation_db
        .fork_conversation(
            &conversation_id,
            anchor_message_id
                .as_deref()
                .map(AnchorRef::ById)
                .as_ref(),
            &title,
            tail_busy,
        )
        .or_else(|e| {
            // id 没解析到（live 回合）→ 时间戳兜底；没有时间戳或别的错误原样上抛。
            match (&e, anchor_ts) {
                (ForkError::AnchorNotFound, Some(ts)) => state.conversation_db.fork_conversation(
                    &conversation_id,
                    Some(&AnchorRef::ByTurnStart(ts)),
                    &title,
                    tail_busy,
                ),
                _ => Err(e),
            }
        })
        .map_err(|e| AppError::Agent(e.to_string()))?;
    let fork_id = outcome.conversation.id.clone();

    // 会话级模型 / 思考档位
    let carried_efforts = {
        let model = state.session_models.read().get(&conversation_id).cloned();
        if let Some(model) = model {
            state.session_models.write().insert(fork_id.clone(), model);
        }
        let efforts = state.session_efforts.read().get(&conversation_id).cloned();
        match efforts {
            Some(map) if !map.is_empty() => {
                state
                    .session_efforts
                    .write()
                    .insert(fork_id.clone(), map.clone());
                serde_json::to_string(&map).ok()
            }
            _ => None,
        }
    };
    if let Some(json) = carried_efforts {
        if let Err(e) = state
            .conversation_db
            .save_conversation_efforts(&fork_id, Some(&json))
        {
            log::warn!("分叉 {fork_id} 持久化思考档位失败: {e}");
        }
    }

    // 记忆附属数据
    let (last_id, last_at) = &outcome.last_message;
    if let Err(e) = state.memory.store.fork_conversation(
        &conversation_id,
        &fork_id,
        &outcome.id_map,
        (last_id.as_str(), &last_at.to_rfc3339()),
    ) {
        log::warn!("分叉 {fork_id} 复制记忆附属数据失败: {e}");
    }

    log::info!(
        "Forked conversation: {} -> {} (messages={}, anchor={:?})",
        conversation_id,
        fork_id,
        outcome.id_map.len(),
        anchor_message_id
    );
    Ok(overlay_session_model(&state, outcome.conversation).await)
}

/// 设置会话级模型（**仅内存**：`AppState.session_models`）。
///
/// 会话 → 模型 的选择不再落盘（SQLite `conversations.model_id` 仅作旧数据
/// 遗留，启动时一次性迁入内存后清空）。`model_id` 为空串/None = 清除本会话
/// 的记忆，回落全局「最近使用」模型。
///
/// 注意：全局 `llmRegistry.lastUsedModelId` 的持久化由**前端**在用户切换
/// 模型后经 `settingsStore.update` 完成（复用完整设置保存链路），本命令
/// 不落盘设置——职责分离：本命令管「这个会话现在用哪个」，设置管「全局
/// 最近用哪个（重启后默认）」。
#[tauri::command]
pub async fn agent_set_session_model(
    state: State<'_, AppState>,
    conversation_id: String,
    model_id: Option<String>,
) -> Result<(), AppError> {
    let model_id = model_id.filter(|s| !s.trim().is_empty()).map(String::from);
    let exists = state
        .conversation_db
        .get_conversation(&conversation_id)
        .map_err(|e| AppError::Agent(format!("读取会话失败: {}", e)))?
        .is_some();
    if !exists {
        return Err(AppError::Agent(format!("会话不存在: {}", conversation_id)));
    }
    state.session_models.write().insert(
        conversation_id.clone(),
        model_id.clone().unwrap_or_default(),
    );
    log::info!(
        "Set session {} model override to {:?} (in-memory)",
        conversation_id,
        model_id
    );
    Ok(())
}

/// 读取会话级模型记忆（内存）。返回 None = 无记忆，跟随全局「最近使用」。
#[tauri::command]
pub async fn agent_get_session_model(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Option<String>, AppError> {
    let guard = state.session_models.read();
    Ok(guard
        .get(&conversation_id)
        .filter(|s| !s.is_empty())
        .cloned())
}

/// 设置会话级思考强度（内存 + 落盘：`AppState.session_efforts` +
/// `conversations.efforts_json`）。
///
/// 档位按「会话 × 模型」双维记忆：`model_id` = 该档位归属的模型（调用方
/// 传当前生效模型 id），会话切到别的模型时各模型记忆互不污染。
/// 档位字符串（如 `low` / `medium` / `high` / `max`）由该模型的
/// `reasoning_efforts` 声明决定，启动任务时若不在声明内则忽略。
/// `None`/空串 = 清除该 (会话, 模型) 的强度记忆，回落模型自身默认。
///
/// 每次变更后把该会话整张 (model→effort) 映射序列化写回 `efforts_json`
/// 列——**重启后档位仍记住**（启动时装载回内存 `session_efforts`）。
#[tauri::command]
pub async fn agent_set_session_effort(
    state: State<'_, AppState>,
    conversation_id: String,
    model_id: String,
    reasoning_effort: Option<String>,
) -> Result<(), AppError> {
    let effort = reasoning_effort
        .filter(|s| !s.trim().is_empty())
        .map(String::from);
    let exists = state
        .conversation_db
        .get_conversation(&conversation_id)
        .map_err(|e| AppError::Agent(format!("读取会话失败: {}", e)))?
        .is_some();
    if !exists {
        return Err(AppError::Agent(format!("会话不存在: {}", conversation_id)));
    }
    if model_id.trim().is_empty() {
        return Err(AppError::Agent("model_id 不能为空".into()));
    }
    let persisted_json = {
        let mut efforts = state.session_efforts.write();
        match effort.clone() {
            Some(e) => {
                efforts
                    .entry(conversation_id.clone())
                    .or_default()
                    .insert(model_id.clone(), e);
            }
            None => {
                if let Some(m) = efforts.get_mut(&conversation_id) {
                    m.remove(&model_id);
                    if m.is_empty() {
                        efforts.remove(&conversation_id);
                    }
                }
            }
        }
        // 落盘该会话最新整张映射：空 = 清空列
        match efforts.get(&conversation_id) {
            Some(m) if !m.is_empty() => Some(
                serde_json::to_string(m)
                    .map_err(|e| AppError::Agent(format!("序列化思考档位失败: {}", e)))?,
            ),
            _ => None,
        }
    };
    state
        .conversation_db
        .save_conversation_efforts(&conversation_id, persisted_json.as_deref())
        .map_err(|e| AppError::Agent(format!("持久化思考档位失败: {}", e)))?;
    log::info!(
        "Set session {} model {} reasoning effort to {:?} (persisted)",
        conversation_id,
        model_id,
        effort
    );
    Ok(())
}

/// 读取会话级思考强度记忆（内存）。`model_id` = 要读的模型；该模型无记忆
/// 时返回 None = 跟随模型默认。
#[tauri::command]
pub async fn agent_get_session_effort(
    state: State<'_, AppState>,
    conversation_id: String,
    model_id: String,
) -> Result<Option<String>, AppError> {
    let guard = state.session_efforts.read();
    Ok(guard
        .get(&conversation_id)
        .and_then(|m| m.get(&model_id))
        .filter(|s| !s.is_empty())
        .cloned())
}

/// Delete a single conversation and all its subagent conversations (cascade).
#[tauri::command]
pub async fn agent_delete_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), AppError> {
    let deleted = state
        .conversation_db
        .delete_conversation_cascade(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to delete conversation: {}", e)))?;
    log::info!(
        "Deleted conversation: {} (cascade: {})",
        conversation_id,
        deleted.len()
    );
    drop_session_models(&state, &deleted);
    forget_conversations_in_memory(&state, &deleted);

    Ok(())
}

/// 归档会话（含子agent对话）：默认列表/搜索/长期回忆不再返回它，但消息与
/// plan 全部保留，可随时恢复。**不做二次确认是产品决定**（见归档按钮文案），
/// 真正的不可逆操作只有归档视图里的「永久删除」。
#[tauri::command]
pub async fn agent_archive_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), AppError> {
    // 级联范围与前端一致：主对话 + 子agent对话，任一在跑都拒绝。
    let subtree = state
        .conversation_db
        .conversation_subtree_ids(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to archive conversation: {}", e)))?;
    let tasks = state.agent_tasks.read();
    if conversation_subtree_is_busy(&tasks, &state.compactions, &subtree) {
        return Err(AppError::Agent(
            "该会话正在运行，请先停止任务再归档".to_string(),
        ));
    }
    drop(tasks);

    let archived = state
        .conversation_db
        .archive_conversation_cascade(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to archive conversation: {}", e)))?;
    log::info!(
        "Archived conversation: {} (cascade: {})",
        conversation_id,
        archived.len()
    );
    // 刻意不清理 session_models / session_efforts / 记忆附属数据：
    // 恢复后模型与档位记忆还要继续生效，归档只是「收起来」。
    Ok(())
}

/// 恢复归档会话（含子agent对话）：回到默认列表的原日期分组。
#[tauri::command]
pub async fn agent_unarchive_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), AppError> {
    let restored = state
        .conversation_db
        .unarchive_conversation_cascade(&conversation_id)
        .map_err(|e| AppError::Agent(format!("Failed to unarchive conversation: {}", e)))?;
    log::info!(
        "Unarchived conversation: {} (cascade: {})",
        conversation_id,
        restored.len()
    );
    Ok(())
}

/// 清理归档超过 N 天的会话。`retention_days <= 0` 表示永不自动清理。
/// 由前端在启动时按设置项调用（设置是前端的权威来源）。
#[tauri::command]
pub async fn agent_purge_expired_archived(
    state: State<'_, AppState>,
    retention_days: u64,
) -> Result<usize, AppError> {
    if retention_days == 0 {
        return Ok(0);
    }
    let cutoff = chrono::Utc::now() - chrono::Duration::days(retention_window_days(retention_days));
    let purged = state
        .conversation_db
        .purge_archived_before(&cutoff.to_rfc3339())
        .map_err(|e| AppError::Agent(format!("Failed to purge archived conversations: {}", e)))?;
    if !purged.is_empty() {
        log::info!(
            "Purged {} archived conversation(s) older than {} day(s)",
            purged.len(),
            retention_days
        );
        drop_session_models(&state, &purged);
        forget_conversations_in_memory(&state, &purged);
    }
    Ok(purged.len())
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
        return Err(AppError::Agent(
            "conversation_id / message_id 不能为空".into(),
        ));
    }
    if images_base64.len() > 5 {
        return Err(AppError::Agent("单次最多 5 张图片".into()));
    }
    let mut paths = Vec::with_capacity(images_base64.len());
    for (i, data) in images_base64.iter().enumerate() {
        match crate::agent::image_store::save_image_base64(&conversation_id, &message_id, i, data) {
            Ok(rel) => paths.push(rel),
            Err(e) => {
                // 中途失败：回滚已写入的文件，避免半成功孤儿图
                for written in &paths {
                    let _ = crate::agent::image_store::delete_image(written);
                }
                return Err(AppError::Agent(format!("保存图片失败: {}", e)));
            }
        }
    }
    Ok(paths)
}

/// Persist a user message (e.g. after images saved but agent_start_task failed).
#[tauri::command]
pub async fn agent_save_user_message(
    state: State<'_, AppState>,
    conversation_id: String,
    content: String,
    timestamp: String,
    image_paths: Option<Vec<String>>,
    user_input: Option<serde_json::Value>,
) -> Result<(), AppError> {
    if conversation_id.is_empty() {
        return Err(AppError::Agent("conversation_id 不能为空".into()));
    }
    let image_paths_json = image_paths
        .as_ref()
        .filter(|p| !p.is_empty())
        .and_then(|p| serde_json::to_string(p).ok());
    let user_input_json = user_input
        .as_ref()
        .and_then(|input| serde_json::to_string(input).ok());
    state
        .conversation_db
        .save_message_with_user_input(
            &conversation_id,
            "user",
            &content,
            &timestamp,
            None,
            None,
            image_paths_json.as_deref(),
            user_input_json.as_deref(),
        )
        .map_err(|e| AppError::Agent(format!("保存用户消息失败: {}", e)))?;

    Ok(())
}

/// Resolve absolute filesystem path for a relative image path (for asset protocol).
#[tauri::command]
pub async fn agent_resolve_image_path(relative_path: String) -> Result<String, AppError> {
    let abs =
        crate::agent::image_store::absolute_path(&relative_path).map_err(|e| AppError::Agent(e))?;
    Ok(abs.to_string_lossy().to_string())
}

/// Read a persisted message image as a data URL (for restore-to-input after rollback).
#[tauri::command]
pub async fn agent_read_message_image(relative_path: String) -> Result<String, AppError> {
    crate::agent::image_store::read_image_data_url(&relative_path)
        .map_err(|e| AppError::Agent(format!("读取图片失败: {}", e)))
}

/// Delete a single persisted message image by relative path (idempotent).
#[tauri::command]
pub async fn agent_delete_message_image(relative_path: String) -> Result<(), AppError> {
    crate::agent::image_store::delete_image(&relative_path)
        .map_err(|e| AppError::Agent(format!("删除图片失败: {}", e)))
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
        .list_active_conversations(&connection_id)
        .map_err(|e| AppError::Agent(format!("Failed to list conversations: {}", e)))?;
    Ok(overlay_session_models(&state, filter_sub_conversations(conversations)).await)
}

/// 全文搜索聊天历史（消息 content），按会话聚合。
/// keyword 为空返回空列表；可选 connection_id 限定连接。
#[tauri::command]
pub async fn agent_search_conversations(
    state: State<'_, AppState>,
    keyword: String,
    connection_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<ConversationSearchResult>, AppError> {
    let include_archived = include_archived.unwrap_or(false);
    log::info!(
        "agent_search_conversations: keyword_len={}, connection_filter={}, include_archived={}",
        keyword.trim().chars().count(),
        connection_id.is_some(),
        include_archived
    );
    let results = state
        .conversation_db
        .search_conversations(&keyword, connection_id.as_deref(), include_archived)
        .map_err(|e| AppError::Agent(format!("Failed to search conversations: {}", e)))?;
    Ok(results)
}

/// Delete all conversations for a given SSH session.
#[tauri::command]
pub async fn agent_delete_conversations_by_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), AppError> {
    let connection_id = connection_id_for_session(state.inner(), &session_id).await?;

    // 先列出待删除的 conversation ids，用于日志与级联清理
    let conv_ids = state
        .conversation_db
        .list_conversations(&connection_id)
        .map(|v| v.into_iter().map(|c| c.id).collect::<Vec<_>>())
        .unwrap_or_default();

    state
        .conversation_db
        .delete_conversations_by_connection(&connection_id)
        .map_err(|e| {
            AppError::Agent(format!("Failed to delete conversations by session: {}", e))
        })?;
    log::info!(
        "Deleted all conversations for session: {} (connection={}, count={})",
        session_id,
        connection_id,
        conv_ids.len()
    );
    drop_session_models(&state, &conv_ids);
    forget_conversations_in_memory(&state, &conv_ids);

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
    app: tauri::AppHandle,
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
                let needs_migrate = plan.items.iter().any(|it| it.id.starts_with("item-"));
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
                // 恢复的 plan 补发一次事件：主界面走 loadPersistedPlans 直接写
                // store，但插件（桌宠等）只监听 plugin://events 通道，没有事件
                // 就感知不到 plan 已加载。emit 让插件侧与主界面同步。
                crate::agent::plan_handler::emit_plan_loaded(&app, &task_id, &normalized);
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
#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::task::{AgentMode, AgentStatus, AgentTask};
    use chrono::Utc;
    use std::collections::HashMap;

    fn task(conversation_id: &str, status: AgentStatus) -> AgentTask {
        AgentTask {
            id: format!("task-{}", conversation_id),
            session_id: "s1".to_string(),
            conversation_id: conversation_id.to_string(),
            prompt: "p".to_string(),
            mode: AgentMode::Agent,
            status,
            has_plan: false,
            created_at: Utc::now(),
            parent_task_id: None,
            model_id: None,
            turn_anchor_id: None,
            parent_history_upto: None,
        }
    }

    fn ids() -> Vec<String> {
        vec!["conv-1".to_string(), "conv-sub".to_string()]
    }

    #[test]
    fn running_task_on_sub_conversation_blocks_archive() {
        let tasks: HashMap<String, AgentTask> =
            [("t1".to_string(), task("conv-sub", AgentStatus::Executing))]
                .into_iter()
                .collect();
        assert!(conversation_subtree_is_busy(
            &tasks,
            &crate::cancel::CancellationRegistry::new(),
            &ids()
        ));
    }

    #[test]
    fn terminal_tasks_on_unrelated_conversations_do_not_block() {
        let tasks: HashMap<String, AgentTask> = [
            ("t1".to_string(), task("conv-1", AgentStatus::Completed)),
            ("t2".to_string(), task("conv-other", AgentStatus::Executing)),
        ]
        .into_iter()
        .collect();
        assert!(!conversation_subtree_is_busy(
            &tasks,
            &crate::cancel::CancellationRegistry::new(),
            &ids()
        ));
    }

    #[test]
    fn manual_compaction_counts_as_busy() {
        let tasks: HashMap<String, AgentTask> = HashMap::new();
        let compactions = crate::cancel::CancellationRegistry::new();
        let _guard = compactions.try_register("conv-sub").expect("register");
        assert!(conversation_subtree_is_busy(&tasks, &compactions, &ids()));
    }

    #[test]
    fn retention_days_are_clamped_to_the_decade_cap() {
        assert_eq!(retention_window_days(0), 0);
        assert_eq!(retention_window_days(30), 30);
        assert_eq!(retention_window_days(MAX_ARCHIVE_RETENTION_DAYS), 3650);
        // 手改 settings.json 传入极端值：夹住而不是让 chrono panic
        assert_eq!(retention_window_days(u64::MAX), 3650);
    }
}
