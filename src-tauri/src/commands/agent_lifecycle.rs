use std::sync::Arc;

use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::agent::agent_loop::{run_agent_loop, LoopContext};
use crate::agent::system_prompt::build_system_prompt;
use crate::agent::task::{AgentMode, AgentStatus, AgentTask};
use crate::agent::templates::TemplateManager;
use crate::agent::tools::{
    mcp::register_mcp_tools, plugin_tool::register_plugin_tools, ToolRegistry,
};
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ProviderType, ToolDefinition};
use crate::mcp::manager::McpManager;
use crate::mcp::store::McpServerConfig;
use crate::plugins::context::{apply_to_string, SessionContext};
use crate::plugins::manifest::PluginManifest;
use crate::plugins::registry::PluginRegistry;
use crate::ssh::connection::SessionInfo;
use crate::AppState;

/// Maximum length (in chars) of a single plugin-contributed system-prompt
/// section. Sections exceeding this are truncated and a warning is logged.
const PLUGIN_SECTION_MAX_CHARS: usize = 2000;

// ── helpers ──

async fn build_registry(
    mode: &AgentMode,
    enabled_skills: &[crate::skills::store::Skill],
    enabled_mcp_servers: &[McpServerConfig],
    mcp_manager: Arc<McpManager>,
    experimental_settings: &crate::config::settings::ExperimentalSettings,
    plugin_registry: &PluginRegistry,
) -> (Arc<ToolRegistry>, Vec<PluginManifest>) {
    match mode {
        AgentMode::Plan => {
            let registry = ToolRegistry::build_for_plan_mode(enabled_skills, experimental_settings);
            (Arc::new(registry), Vec::new())
        }
        AgentMode::Agent | AgentMode::Auto => {
            let mut registry =
                ToolRegistry::build_mut_for_mode(enabled_skills, experimental_settings);

            let manifests = plugin_registry.enabled_manifests();
            for m in &manifests {
                register_plugin_tools(&mut registry, &m.id, &m.capabilities, &m.agent_tools);
            }

            let mut set = tokio::task::JoinSet::new();
            for server in enabled_mcp_servers {
                let mgr = mcp_manager.clone();
                let server = server.clone();
                set.spawn(async move {
                    let result = mgr.refresh_tools(&server).await;
                    (server, result)
                });
            }
            while let Some(result) = set.join_next().await {
                match result {
                    Ok((server, Ok(tools))) => register_mcp_tools(&mut registry, &server, tools),
                    Ok((server, Err(err))) => {
                        log::warn!("刷新 MCP tools 失败 [{}]: {}", server.name, err)
                    }
                    Err(join_err) => log::warn!("MCP 刷新任务 panic: {}", join_err),
                }
            }
            (Arc::new(registry), manifests)
        }
    }
}

/// Replace all 7 context variables in `s` using the given session info.
/// Missing session info (None) yields empty-string substitutions.
fn apply_section_context_variables(
    s: &str,
    info: Option<&SessionInfo>,
    session_id: &str,
) -> String {
    match info {
        Some(i) => apply_to_string(s, &SessionContext::from_session(i, session_id)),
        None => {
            log::warn!("无法获取会话上下文，systemPromptSection 中的上下文变量替换为空字符串");
            apply_to_string(s, &SessionContext::empty(session_id))
        }
    }
}

/// Collect plugin-contributed system-prompt sections from enabled plugins.
///
/// - **Plan mode**: returns an empty vec (no plugin sections injected).
/// - **Agent/Auto mode**: for each manifest with a `systemPromptSection`:
///   1. Look up the cached section content from the `PluginRegistry`
///      (mtime-invalidated, single source of truth). Skip if absent.
///   2. Substitute the 7 context variables (`{{__host__}}` etc.).
///   3. Truncate to `PLUGIN_SECTION_MAX_CHARS` chars; warn if truncated.
async fn collect_plugin_sections(
    registry: &PluginRegistry,
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    mode: &AgentMode,
) -> Vec<String> {
    // Plan mode: never inject plugin sections (plugin tools are not registered).
    if matches!(mode, AgentMode::Plan) {
        return Vec::new();
    }

    // Fetch session info once for context-variable substitution.
    let session_info = ssh.get_session_info(session_id).await;

    let mut sections = Vec::new();
    for entry in registry.enabled_manifests() {
        // Only enabled plugins with a declared section contribute. The
        // registry caches the (mtime, content) pair so no filesystem I/O
        // happens here even on repeated agent task launches.
        if entry.system_prompt_section.is_none() {
            continue;
        }
        let content = match registry.section_for(&entry.id) {
            Some(c) => c.to_string(),
            None => continue, // declared but file missing/unreadable — already warned at reload
        };

        let substituted =
            apply_section_context_variables(&content, session_info.as_ref(), session_id);

        // Enforce per-section length limit (char count, not bytes).
        let char_count = substituted.chars().count();
        let truncated: String = if char_count > PLUGIN_SECTION_MAX_CHARS {
            log::warn!(
                "插件 {} systemPromptSection 超过 {} 字符（{}），已截断",
                entry.id,
                PLUGIN_SECTION_MAX_CHARS,
                char_count
            );
            substituted.chars().take(PLUGIN_SECTION_MAX_CHARS).collect()
        } else {
            substituted
        };

        sections.push(truncated);
    }
    sections
}

fn build_definitions(registry: &Arc<ToolRegistry>, mode: &AgentMode) -> Vec<ToolDefinition> {
    match mode {
        AgentMode::Plan | AgentMode::Agent | AgentMode::Auto => registry
            .definitions()
            .into_iter()
            .map(|d| ToolDefinition {
                name: d.name,
                description: d.description,
                parameters: d.parameters,
            })
            .collect(),
    }
}

pub(crate) fn build_agent_messages(
    template_manager: &TemplateManager,
    session_id: &str,
    tools: &[ToolDefinition],
    history: &[LlmMessage],
    prompt: &str,
    agent_system_prompt: &str,
    plugin_sections: &[String],
    plan_mode: bool,
) -> Result<Vec<LlmMessage>, AppError> {
    let has_tool = |name: &str| tools.iter().any(|t| t.name == name);
    let has_skills = tools.iter().any(|t| t.name.starts_with("skill_"));
    let system_prompt = build_system_prompt(
        template_manager,
        session_id,
        has_skills,
        has_tool("web_search"),
        has_tool("http_get"),
        agent_system_prompt,
        plugin_sections,
        plan_mode,
        has_tool("task"),
    )?;
    let mut messages: Vec<LlmMessage> = Vec::with_capacity(history.len() + 2);
    messages.push(LlmMessage::system(system_prompt));
    for msg in history {
        if msg.role == LlmRole::System {
            continue;
        }
        messages.push(msg.clone());
    }
    if !messages
        .last()
        .map_or(false, |m| m.role == LlmRole::User && m.content == prompt)
    {
        // History from frontend already includes the current user turn (with
        // optional image_paths). Only append a text-only fallback when missing.
        messages.push(LlmMessage::user(prompt.to_string()));
    }
    Ok(messages)
}

fn spawn_agent_task(
    state: &AppState,
    app: &AppHandle,
    task_id: &str,
    session_id: &str,
    conversation_id: &str,
    mode: &AgentMode,
    provider: OpenAiProvider,
    messages: Vec<LlmMessage>,
    tools: Vec<ToolDefinition>,
    agent_settings: crate::config::settings::AgentModeSettings,
    registry: Arc<ToolRegistry>,
) {
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    state
        .cancel_senders
        .write()
        .insert(task_id.to_string(), cancel_tx);

    let loop_ctx = LoopContext {
        ssh: state.ssh_manager.clone(),
        session_id: session_id.to_string(),
        app: app.clone(),
        state: state.clone(),
        registry,
        conversation_id: conversation_id.to_string(),
        conv_db: state.conversation_db.clone(),
        cancel_rx,
        config_dir: state.config_dir.clone(),
        is_subtask: false,
    };

    let state_for_cleanup = state.clone();
    let task_id_for_cleanup = task_id.to_string();
    let task_id_owned = task_id.to_string();
    let mode_owned = mode.clone();
    let task_id_log = task_id.to_string();
    let mode_log = mode.clone();

    tokio::spawn(async move {
        let result = run_agent_loop(
            task_id_owned,
            provider,
            messages,
            tools,
            mode_owned,
            agent_settings,
            loop_ctx,
        )
        .await;

        // 任务结束：更新后端 agent_tasks 终态。此前主任务结束从不置终态，
        // 状态永远停在 Planning/Executing → busy 守卫（手动压缩等）误报
        // "会话正在运行任务"。停止路径已置 Cancelled 则保留；自然结束=Completed，
        // 其余（LLM 失败 / 达最大轮数）= Failed。
        if let Some(task) = state_for_cleanup
            .agent_tasks
            .write()
            .get_mut(&task_id_for_cleanup)
        {
            if task.status == AgentStatus::Cancelled {
                // 用户主动停止：保持 Cancelled（is_task_cancelled 语义不变）
            } else {
                task.status = if result.is_some() {
                    AgentStatus::Completed
                } else {
                    AgentStatus::Failed
                };
            }
        }

        state_for_cleanup
            .cancel_senders
            .write()
            .remove(&task_id_for_cleanup);
    });

    log::info!("Agent task started: {} ({:?})", task_id_log, mode_log);
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

// ── commands ──

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
    let task_id = Uuid::new_v4().to_string();

    state.agent_tasks.write().insert(
        task_id.clone(),
        AgentTask {
            id: task_id.clone(),
            session_id: session_id.clone(),
            conversation_id: conversation_id.clone(),
            prompt: prompt.clone(),
            mode: mode.clone(),
            status: AgentStatus::Planning,
            has_plan: false,
            created_at: chrono::Utc::now(),
            parent_task_id: None,
        },
    );

    // 恢复旧 plan 到新 task_id：重启后 state.plans 为空，若不恢复，LLM 看不到
    // 旧 plan context 会重复 create_plan。从 SQLite 加载该 conversation 最近一条
    // plan，更新 task_id 字段挂到新 task 下。reflection_reminded 保留原值，
    // 避免对已反思过的 plan 重复触发反思。
    if state.plans.read().get(&task_id).is_none() {
        match state
            .conversation_db
            .load_latest_plan_by_conversation(&conversation_id)
        {
            Ok(Some(plan_json)) => {
                match serde_json::from_str::<crate::agent::task::AgentTaskPlan>(&plan_json) {
                    Ok(mut plan) => {
                        plan.task_id = task_id.clone();
                        state.plans.write().insert(task_id.clone(), plan);
                        if let Some(task) = state.agent_tasks.write().get_mut(&task_id) {
                            task.has_plan = true;
                        }
                        log::info!(
                            "Restored plan for new task {} from conversation {}",
                            task_id,
                            conversation_id
                        );
                    }
                    Err(e) => {
                        log::warn!(
                            "Failed to deserialize plan for conversation {}: {}",
                            conversation_id,
                            e
                        );
                    }
                }
            }
            Ok(None) => {} // 该 conversation 没有 plan，正常流程
            Err(e) => {
                log::warn!(
                    "Failed to load latest plan for conversation {}: {}",
                    conversation_id,
                    e
                );
            }
        }
    }

    let (llm_config, agent_settings, experimental_settings, enabled_skills, enabled_mcp_servers) = {
        let settings = state.settings.read().await;
        let skills = state.skill_store.read().await;
        let mcp_store = state.mcp_store.read().await;
        (
            settings.llm_config.clone(),
            settings.agent_mode_settings.clone(),
            settings.experimental_settings.clone(),
            skills
                .list()
                .iter()
                .filter(|s| s.enabled)
                .cloned()
                .collect::<Vec<_>>(),
            mcp_store
                .list()
                .iter()
                .filter(|s| s.enabled)
                .cloned()
                .collect::<Vec<_>>(),
        )
    };

    let Some(llm_config) = llm_config else {
        return Err(AppError::Llm("尚未配置 LLM，请前往设置填写".into()));
    };
    if llm_config.provider_type != ProviderType::OpenAI {
        return Err(AppError::Llm("当前仅支持 OpenAI 兼容 Provider".into()));
    }
    let provider = OpenAiProvider::new(llm_config)?;

    let plugin_registry_guard = state.plugin_registry.read().await;
    let (tool_registry, _manifests) = build_registry(
        &mode,
        &enabled_skills,
        &enabled_mcp_servers,
        state.mcp_manager.clone(),
        &experimental_settings,
        &plugin_registry_guard,
    )
    .await;
    let tools = build_definitions(&tool_registry, &mode);
    let plugin_sections = collect_plugin_sections(
        &plugin_registry_guard,
        &state.ssh_manager,
        &session_id,
        &mode,
    )
    .await;
    drop(plugin_registry_guard); // release before agent loop runs (no longer needed)
    let template_manager = TemplateManager;
    let messages = build_agent_messages(
        &template_manager,
        &session_id,
        &tools,
        &history,
        &prompt,
        &agent_settings.system_prompt,
        &plugin_sections,
        matches!(mode, AgentMode::Plan),
    )?;

    spawn_agent_task(
        &state,
        &app,
        &task_id,
        &session_id,
        &conversation_id,
        &mode,
        provider,
        messages,
        tools,
        agent_settings,
        tool_registry,
    );

    Ok(task_id)
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
