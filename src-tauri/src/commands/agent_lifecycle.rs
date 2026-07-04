use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::agent::agent_loop::{run_agent_loop, LoopContext};
use crate::agent::system_prompt::build_system_prompt;
use crate::agent::task::{AgentMode, AgentStatus, AgentTask};
use crate::agent::tools::{mcp::register_mcp_tools, plugin_tool::register_plugin_tools, ToolRegistry};
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmRole, ProviderType, ToolDefinition};
use crate::plugins::manifest::PluginManifest;
use crate::plugins::scan::scan_plugins_filtered;
use crate::ssh::connection::SessionInfo;
use crate::AppState;
use crate::mcp::manager::McpManager;
use crate::mcp::store::McpServerConfig;

/// Maximum length (in chars) of a single plugin-contributed system-prompt
/// section. Sections exceeding this are truncated and a warning is logged.
const PLUGIN_SECTION_MAX_CHARS: usize = 2000;

/// Process-wide cache of plugin `systemPromptSection` file contents, keyed by
/// absolute path. Each entry stores `(mtime, content)` so we only re-read a
/// file when its modification time changes. This avoids re-reading the same
/// static file on every agent task launch.
///
/// Guarded by a plain `std::sync::Mutex` — the critical section is tiny
/// (HashMap lookup + occasional file read) and never awaits, so it is safe
/// to hold across the synchronous cache helper below.
static SECTION_CACHE: std::sync::Mutex<Option<HashMap<PathBuf, (SystemTime, String)>>> =
    std::sync::Mutex::new(None);

// ── helpers ──

async fn build_registry(
    mode: &AgentMode,
    enabled_skills: &[crate::skills::store::Skill],
    enabled_mcp_servers: &[McpServerConfig],
    mcp_manager: Arc<McpManager>,
    experimental_settings: &crate::config::settings::ExperimentalSettings,
    config_dir: &std::path::Path,
    disabled_plugins: &[String],
) -> (Arc<ToolRegistry>, Vec<PluginManifest>) {
    let AgentMode::Chat = mode else {
        let mut registry =
            ToolRegistry::build_mut_for_mode(enabled_skills, experimental_settings);

        let manifests = tokio::task::spawn_blocking({
            let config_dir = config_dir.to_path_buf();
            let disabled = disabled_plugins.to_vec();
            move || scan_plugins_filtered(&config_dir, &disabled)
        })
        .await
        .unwrap_or_default();
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
        return (Arc::new(registry), manifests);
    };
    (Arc::new(ToolRegistry::new()), Vec::new())
}

/// Read a plugin `systemPromptSection` file with mtime-based caching.
/// On a cache hit (unchanged mtime) the cached content is returned without
/// touching the filesystem. On a miss the file is read and the cache updated.
fn read_section_cached(path: &Path) -> Result<String, std::io::Error> {
    let metadata = std::fs::metadata(path)?;
    let mtime = metadata.modified()?;

    let mut cache_guard = SECTION_CACHE.lock().expect("SECTION_CACHE poisoned");
    let cache = cache_guard.get_or_insert_with(HashMap::new);

    if let Some((cached_mtime, cached_content)) = cache.get(path) {
        if *cached_mtime == mtime {
            return Ok(cached_content.clone());
        }
    }

    let content = std::fs::read_to_string(path)?;
    cache.insert(path.to_path_buf(), (mtime, content.clone()));
    Ok(content)
}

/// Replace all 7 context variables in `s` using the given session info.
/// Missing session info (None) yields empty-string substitutions.
fn apply_section_context_variables(s: &str, info: Option<&SessionInfo>, session_id: &str) -> String {
    match info {
        Some(i) => {
            let timestamp = SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs().to_string())
                .unwrap_or_default();
            let host_port = format!("{}_{}", i.host, i.port);
            s.replace("{{__host__}}", &i.host)
                .replace("{{__port__}}", &i.port.to_string())
                .replace("{{__host_port__}}", &host_port)
                .replace("{{__session_id__}}", session_id)
                .replace(
                    "{{__connection_id__}}",
                    &i.connection_id.clone().unwrap_or_default(),
                )
                .replace("{{__username__}}", &i.username)
                .replace("{{__timestamp__}}", &timestamp)
        }
        None => {
            log::warn!("无法获取会话上下文，systemPromptSection 中的上下文变量替换为空字符串");
            s.replace("{{__host__}}", "")
                .replace("{{__port__}}", "")
                .replace("{{__host_port__}}", "")
                .replace("{{__session_id__}}", "")
                .replace("{{__connection_id__}}", "")
                .replace("{{__username__}}", "")
                .replace("{{__timestamp__}}", "")
        }
    }
}

/// Collect plugin-contributed system-prompt sections from enabled plugins.
///
/// - **Chat mode**: returns an empty vec (no plugin sections injected).
/// - **Agent/Auto mode**: for each manifest with a `systemPromptSection`:
///   1. Resolve the section file path under the plugin's directory.
///   2. Read the file (cached by mtime); on failure warn and skip.
///   3. Substitute the 7 context variables (`{{__host__}}` etc.).
///   4. Truncate to `PLUGIN_SECTION_MAX_CHARS` chars; warn if truncated.
async fn collect_plugin_sections(
    manifests: &[PluginManifest],
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    mode: &AgentMode,
    config_dir: &Path,
) -> Vec<String> {
    // Chat mode: never inject plugin sections (matches agentTools behaviour).
    if matches!(mode, AgentMode::Chat) {
        return Vec::new();
    }

    // Fetch session info once for context-variable substitution.
    let session_info = ssh.get_session_info(session_id).await;

    let mut sections = Vec::new();
    for m in manifests {
        let rel = match m.system_prompt_section.as_ref() {
            Some(p) if !p.is_empty() => p,
            _ => continue,
        };
        let section_path = config_dir.join("plugins").join(&m.id).join(rel);

        let content = match read_section_cached(&section_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!(
                    "插件 {} systemPromptSection 读取失败 ({}): {}",
                    m.id,
                    section_path.display(),
                    e
                );
                continue;
            }
        };

        let substituted = apply_section_context_variables(&content, session_info.as_ref(), session_id);

        // Enforce per-section length limit (char count, not bytes).
        let char_count = substituted.chars().count();
        let truncated: String = if char_count > PLUGIN_SECTION_MAX_CHARS {
            log::warn!(
                "插件 {} systemPromptSection 超过 {} 字符（{}），已截断",
                m.id,
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
        AgentMode::Chat => vec![],
        AgentMode::Agent | AgentMode::Auto => registry
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

fn build_agent_messages(
    session_id: &str,
    tools: &[ToolDefinition],
    history: &[LlmMessage],
    prompt: &str,
    agent_system_prompt: &str,
    plugin_sections: &[String],
) -> Vec<LlmMessage> {
    let has_tool = |name: &str| tools.iter().any(|t| t.name == name);
    let has_skills = tools.iter().any(|t| t.name.starts_with("skill_"));
    let system_prompt = build_system_prompt(
        session_id,
        has_skills,
        has_tool("web_search"),
        has_tool("http_get"),
        agent_system_prompt,
        plugin_sections,
    );
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
        messages.push(LlmMessage::user(prompt.to_string()));
    }
    messages
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
    };

    let state_for_cleanup = state.clone();
    let task_id_for_cleanup = task_id.to_string();
    let task_id_owned = task_id.to_string();
    let mode_owned = mode.clone();
    let task_id_log = task_id.to_string();
    let mode_log = mode.clone();

    tokio::spawn(async move {
        run_agent_loop(
            task_id_owned,
            provider,
            messages,
            tools,
            mode_owned,
            agent_settings,
            loop_ctx,
        )
        .await;

        state_for_cleanup
            .cancel_senders
            .write()
            .remove(&task_id_for_cleanup);
    });

    log::info!("Agent task started: {} ({:?})", task_id_log, mode_log);
}

fn send_approval(
    state: &AppState,
    task_id: &str,
    operation_id: &str,
    approved: bool,
) {
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

    state.agent_tasks.write().insert(task_id.clone(), AgentTask {
        id: task_id.clone(),
        session_id: session_id.clone(),
        prompt: prompt.clone(),
        mode: mode.clone(),
        status: AgentStatus::Planning,
        has_plan: false,
        created_at: chrono::Utc::now(),
    });

    let (llm_config, agent_settings, experimental_settings, enabled_skills, enabled_mcp_servers, disabled_plugins) = {
        let settings = state.settings.read().await;
        let skills = state.skill_store.read().await;
        let mcp_store = state.mcp_store.read().await;
        (
            settings.llm_config.clone(),
            settings.agent_mode_settings.clone(),
            settings.experimental_settings.clone(),
            skills.list().iter().filter(|s| s.enabled).cloned().collect::<Vec<_>>(),
            mcp_store.list().iter().filter(|s| s.enabled).cloned().collect::<Vec<_>>(),
            settings.disabled_plugins.clone(),
        )
    };

    let Some(llm_config) = llm_config else {
        return Err(AppError::Llm("尚未配置 LLM，请前往设置填写".into()));
    };
    if llm_config.provider_type != ProviderType::OpenAI {
        return Err(AppError::Llm("当前仅支持 OpenAI 兼容 Provider".into()));
    }
    let provider = OpenAiProvider::new(llm_config)?;

    let (registry, manifests) = build_registry(&mode, &enabled_skills, &enabled_mcp_servers, state.mcp_manager.clone(), &experimental_settings, &state.config_dir, &disabled_plugins).await;
    let tools = build_definitions(&registry, &mode);
    let plugin_sections = collect_plugin_sections(&manifests, &state.ssh_manager, &session_id, &mode, &state.config_dir).await;
    let messages = build_agent_messages(&session_id, &tools, &history, &prompt, &agent_settings.system_prompt, &plugin_sections);

    spawn_agent_task(
        &state, &app, &task_id, &session_id, &conversation_id, &mode,
        provider, messages, tools, agent_settings, registry,
    );

    Ok(task_id)
}

#[tauri::command]
pub async fn agent_stop_task(state: State<'_, AppState>, task_id: String) -> Result<(), AppError> {
    let mut tasks = state.agent_tasks.write();
    match tasks.get_mut(&task_id) {
        Some(task) => {
            task.status = AgentStatus::Cancelled;
            if let Some(cancel_tx) = state.cancel_senders.write().remove(&task_id) {
                let _ = cancel_tx.send(true);
            }
            Ok(())
        }
        None => Err(AppError::Agent(format!("Task not found: {}", task_id))),
    }
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
