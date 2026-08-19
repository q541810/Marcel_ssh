pub mod agent;
pub mod command_exec;
pub mod commands;
pub mod config;
pub mod error;
pub mod llm;
pub mod mcp;
pub mod plugins;
pub mod notification;
pub mod skills;
pub mod ssh;
pub mod sync;
pub mod util;

use std::collections::HashMap;
use std::path::PathBuf;

use parking_lot::RwLock as PlRwLock;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use tokio::sync::RwLock as TokioRwLock;

use crate::agent::conversation::ConversationDb;
use crate::agent::task::AgentTask;
use crate::agent::task::AgentTaskPlan;
use crate::config::connections::ConnectionStore;
use crate::config::persist::JsonPersistable;
use crate::config::quick_commands::QuickCommandStore;
use crate::config::settings::AppSettings;
use crate::mcp::manager::McpManager;
use crate::mcp::store::McpServerStore;
use crate::skills::store::SkillStore;
use crate::ssh::connection::SshManager;
use crate::ssh::known_hosts::KnownHostsStore;

/// 发射事件到原始通道 + plugin://events 通道
/// 插件系统通过监听 plugin://events 接收所有应用事件
pub fn emit_event<S: serde::Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    let _ = app.emit(event, &payload);
    let _ = app.emit("plugin://events", serde_json::json!({
        "event": event,
        "data": payload,
    }));
}

/// Shared application state managed by Tauri.
///
/// Note: SSH-related state uses `tokio::sync::RwLock` because async tasks
/// hold these locks across `.await` points. Other state uses `parking_lot`
/// for cheaper, sync access.
#[derive(Clone)]
pub struct AppState {
    pub ssh_manager: SshManager,
    pub agent_tasks: std::sync::Arc<PlRwLock<HashMap<String, AgentTask>>>,
    pub plans: std::sync::Arc<PlRwLock<HashMap<String, AgentTaskPlan>>>,
    pub connection_store: std::sync::Arc<TokioRwLock<ConnectionStore>>,
    pub settings: std::sync::Arc<TokioRwLock<AppSettings>>,
    pub quick_command_store: std::sync::Arc<TokioRwLock<QuickCommandStore>>,
    pub conversation_db: std::sync::Arc<ConversationDb>,
    pub skill_store: std::sync::Arc<TokioRwLock<SkillStore>>,
    pub mcp_store: std::sync::Arc<TokioRwLock<McpServerStore>>,
    pub mcp_manager: std::sync::Arc<McpManager>,
    /// Application config directory. Used for persisting connections, settings, etc.
    pub config_dir: PathBuf,
    /// Pending approval requests: (task_id, operation_id) -> oneshot sender for approval response
    pub pending_approvals:
        std::sync::Arc<PlRwLock<HashMap<(String, String), oneshot::Sender<bool>>>>,
    /// Pending question answers: (task_id, question_id) -> oneshot sender for user answer
    pub pending_questions:
        std::sync::Arc<PlRwLock<HashMap<(String, String), oneshot::Sender<Vec<serde_json::Value>>>>>,
    /// Cancellation signals for running agent tasks: task_id -> watch sender.
    /// Setting the value to `true` signals the agent loop to abort the current LLM call.
    pub cancel_senders: std::sync::Arc<PlRwLock<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    /// Cancellation signals for SFTP uploads: upload_id -> watch sender.
    pub upload_cancel_senders: std::sync::Arc<PlRwLock<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    /// Cancellation signals for SFTP downloads: download_id -> watch sender.
    pub download_cancel_senders:
        std::sync::Arc<PlRwLock<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    /// Cancellation signals for plugin installs: install_id -> watch sender.
    pub plugin_install_cancel_senders:
        std::sync::Arc<PlRwLock<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    /// 命令执行统一管理器：所有 SSH 命令执行（用户直发 / 系统长任务 /
    /// Agent 工具 / 插件）的唯一入口，集中管理执行记录、取消注册表
    /// （取代旧的 long_exec_cancel_senders）与断连级联取消。
    pub command_exec: crate::command_exec::CommandExecutionManager,
    /// Watcher state for "open with system" files, keyed by task_id.
    /// Value = (session_id, local_path, cancel sender). local_path 用于「重复打开」时
    /// 复用已下载的本地副本（再次唤起系统应用，不重新下载、不重复监视）；
    /// cancel sender 设为 true 中止下载 + 监视。
    pub sysopen_watchers:
        std::sync::Arc<PlRwLock<HashMap<String, (String, std::path::PathBuf, tokio::sync::watch::Sender<bool>)>>>,
    /// Active "open with system" dedup table: (session_id, remote_path) -> task_id.
    /// Prevents the same remote file being opened twice concurrently (which would
    /// have the two local copies clobber each other and race on sync-back).
    pub sysopen_active_paths:
        std::sync::Arc<PlRwLock<HashMap<(String, String), String>>>,
    /// Non-fatal warning about settings load (e.g. file backed up). Surfaced to
    /// the frontend via `config_get_settings` so it can show a notification.
    pub settings_warning: std::sync::Arc<PlRwLock<Option<String>>>,
    /// Plugin registry: single source of truth for plugin manifests + state.
    /// Reloads on startup and whenever settings change (enable/disable plugin,
    /// authorized capabilities). Emits `plugin-registry-changed` after reload.
    pub plugin_registry: crate::plugins::registry::SharedPluginRegistry,
    /// 跨设备同步引擎（None = 未初始化）
    pub sync_engine: Option<std::sync::Arc<crate::sync::engine::SyncEngine>>,
    /// 同步调度器（None = 未初始化）
    pub sync_scheduler: Option<std::sync::Arc<crate::sync::scheduler::SyncScheduler>>,
}

impl AppState {
    /// Create a new AppState, loading any persisted config from `config_dir`.
    ///
    /// All independent stores are loaded in parallel. File I/O is offloaded to
    /// the blocking thread pool via `tokio::task::spawn_blocking` so the async
    /// runtime is never stalled. Settings-dependent work (keychain, llm_config
    /// backfill) runs sequentially after settings are loaded.
    pub async fn new(config_dir: PathBuf) -> Self {
        crate::agent::image_store::init(&config_dir);

        // Pre-compute file paths so each `spawn_blocking` closure can own its
        // own copy without borrowing `config_dir`.
        let known_hosts_path = config_dir.join("known_hosts.json");
        let connections_file = ConnectionStore::default_file(&config_dir);
        let settings_file = AppSettings::default_file(&config_dir);
        let db_path = config_dir.join("conversations.db");
        let skills_file = SkillStore::default_file(&config_dir);
        let quick_commands_file = QuickCommandStore::default_file(&config_dir);
        let mcp_servers_file = McpServerStore::default_file(&config_dir);

        // Clone before the file path is moved into the spawn_blocking closure.
        let settings_backup_src = settings_file.clone();

        // Captured during phase-2 fallbacks; surfaced via AppState.settings_warning.
        let mut settings_warning: Option<String> = None;

        // ── Phase 1: parallel loads (all independent) ──────────────────────
        let (
            known_hosts_res,
            connections_res,
            settings_res,
            db_handle,
            skills_res,
            qc_res,
            mcp_res,
        ) = {
            // Clone once for the ConversationDb closure which needs both paths.
            let config_dir_for_db = config_dir.clone();

            tokio::join!(
                // KnownHostsStore::load is already async.
                KnownHostsStore::load(known_hosts_path),
                // Sync JSON stores – offload to blocking thread pool.
                tokio::task::spawn_blocking(move || {
                    ConnectionStore::load_from_path(&connections_file)
                }),
                tokio::task::spawn_blocking(move || {
                    AppSettings::load_from_path(&settings_file)
                }),
                // ConversationDb involves SQLite file I/O + schema migration.
                tokio::task::spawn_blocking(move || -> ConversationDb {
                    match ConversationDb::new(&db_path) {
                        Ok(db) => {
                            log::info!("✓ 对话数据库已加载: {}", db_path.display());
                            match db.list_conversations("__diagnostic__") {
                                Ok(count) if !count.is_empty() => {
                                    log::info!("  数据库中有 {} 个会话记录", count.len());
                                }
                                _ => {
                                    log::info!("  数据库中暂无会话记录（首次使用）");
                                }
                            }
                            db
                        }
                        Err(e) => {
                            log::warn!("Failed to init file DB ({}): {}", db_path.display(), e);
                            log::warn!("  Falling back to in-memory DB");
                            log::warn!(
                                "  Check write permissions: {}",
                                config_dir_for_db.display()
                            );
                            ConversationDb::in_memory().expect("Failed to init in-memory DB")
                        }
                    }
                }),
                tokio::task::spawn_blocking(move || { SkillStore::load_from_path(&skills_file) }),
                tokio::task::spawn_blocking(move || {
                    QuickCommandStore::load_from_path(&quick_commands_file)
                }),
                tokio::task::spawn_blocking(move || {
                    McpServerStore::load_from_path(&mcp_servers_file)
                }),
            )
        };

        // ── Phase 2: process results with fallbacks ────────────────────────

        // KnownHosts – async fallback on error (can still .await here).
        let known_hosts = match known_hosts_res {
            Ok(kh) => kh,
            Err(e) => {
                log::error!("无法加载 known_hosts.json，尝试 fallback: {}", e);
                match KnownHostsStore::load(
                    std::env::temp_dir().join("marcel-ssh-known-hosts-fallback.json"),
                )
                .await
                {
                    Ok(store) => {
                        log::warn!("known_hosts 使用临时目录 fallback");
                        store
                    }
                    Err(e2) => {
                        log::error!(
                            "known_hosts fallback 也失败: {}; 使用纯内存 store",
                            e2
                        );
                        KnownHostsStore::in_memory()
                    }
                }
            }
        };

        let connection_store = match connections_res {
            Ok(Ok(store)) => store,
            Ok(Err(e)) => {
                log::warn!("无法加载连接配置，使用默认值：{}", e);
                ConnectionStore::new()
            }
            Err(join_err) => {
                log::warn!("连接配置加载任务失败：{}", join_err);
                ConnectionStore::new()
            }
        };

        let mut settings = match settings_res {
            Ok(Ok(s)) => s,
            Ok(Err(e)) => {
                log::warn!("无法加载应用设置，使用默认值：{}", e);
                // The file exists but is unreadable/incompatible.
                // Back it up before any save overwrites it silently.
                let bak_path = backup_settings_on_load_failure(&settings_backup_src);
                let msg = match bak_path {
                    Some(path) => format!(
                        "配置文件加载失败: {}。旧文件已备份到 {}，当前使用默认设置。",
                        e,
                        path.display()
                    ),
                    None => format!("配置文件加载失败: {}。当前使用默认设置。", e),
                };
                settings_warning = Some(msg);
                AppSettings::default()
            }
            Err(join_err) => {
                log::warn!("应用设置加载任务失败：{}", join_err);
                settings_warning = Some(format!(
                    "应用设置加载任务失败: {}。当前使用默认设置。",
                    join_err
                ));
                AppSettings::default()
            }
        };

        // Backwards-compat: existing settings files written before LLM support
        // had `llmConfig: null`. Backfill with a working default so users get a
        // ready-to-use configuration on upgrade.
        if settings.llm_config.is_none() {
            settings.llm_config = Some(crate::llm::provider::LlmConfig::default());
            log::info!("settings.json 缺少 llmConfig，已填入默认值");
            let _ = settings.save_to_path(&AppSettings::default_file(&config_dir));
        }

        // ── Phase 3: settings-dependent work (sequential) ──────────────────

        // Load LLM API key from the system keychain (if available).
        // This is separate from settings.json to avoid storing sensitive data on disk.
        if let Some(ref mut llm_config) = settings.llm_config {
            match crate::config::keychain::get_llm_api_key() {
                Ok(Some(key)) => {
                    llm_config.api_key = key;
                    log::info!("已从密钥链加载 LLM API Key");
                }
                Ok(None) => {
                    log::info!("未在密钥链中找到 LLM API Key，用户需在设置中输入");
                }
                Err(e) => {
                    log::warn!("读取密钥链失败：{}", e);
                }
            }
        }

        log::info!(
            "Loaded {} saved connections from {}",
            connection_store.get_all().len(),
            config_dir.display()
        );

        let conversation_db = db_handle.expect("对话数据库初始化任务失败");

        let skill_store = match skills_res {
            Ok(Ok(store)) => store,
            Ok(Err(e)) => {
                log::warn!("Failed to load skills, using defaults: {}", e);
                SkillStore::new()
            }
            Err(join_err) => {
                log::warn!("Skills 加载任务失败：{}", join_err);
                SkillStore::new()
            }
        };

        let quick_command_store = match qc_res {
            Ok(Ok(store)) => store,
            Ok(Err(e)) => {
                log::warn!("Failed to load quick commands, using defaults: {}", e);
                QuickCommandStore::new()
            }
            Err(join_err) => {
                log::warn!("Quick commands 加载任务失败：{}", join_err);
                QuickCommandStore::new()
            }
        };

        let mcp_store = match mcp_res {
            Ok(Ok(store)) => store,
            Ok(Err(e)) => {
                log::warn!("Failed to load MCP servers, using defaults: {}", e);
                McpServerStore::new()
            }
            Err(join_err) => {
                log::warn!("MCP servers 加载任务失败：{}", join_err);
                McpServerStore::new()
            }
        };

        // ── Phase 3: sync engine + scheduler + accessor ──────────────
        // Sync is optional — initialization is best-effort and non-fatal.
        // Scheduler stays NotConfigured until the user pairs via sync_pair_first/join.
        //
        // 先把各 store 包成 Arc<TokioRwLock<T>>，这样 accessor 可以 clone 这些 Arc，
        // 同时 Self{} 可以直接 move 它们。
        let connection_store_arc = std::sync::Arc::new(TokioRwLock::new(connection_store));
        let settings_arc = std::sync::Arc::new(TokioRwLock::new(settings));
        let quick_command_store_arc = std::sync::Arc::new(TokioRwLock::new(quick_command_store));
        let conversation_db_arc = std::sync::Arc::new(conversation_db);
        let skill_store_arc = std::sync::Arc::new(TokioRwLock::new(skill_store));
        let mcp_store_arc = std::sync::Arc::new(TokioRwLock::new(mcp_store));

        // SSH 连接管理器 + 命令执行统一管理器（后者注册断连观察者，
        // 必须在 SshManager 构造后立即创建并共享同一句柄）。
        let ssh_manager = SshManager::with_known_hosts(known_hosts);
        let command_exec =
            crate::command_exec::CommandExecutionManager::new(ssh_manager.clone()).await;

        let (sync_engine, sync_scheduler) = {
            let profile = crate::sync::profile::SyncProfile::default();
            let engine = std::sync::Arc::new(
                crate::sync::engine::SyncEngine::new(config_dir.clone(), profile),
            );

            // Load local version table (best-effort)
            if let Err(e) = engine.load().await {
                log::warn!("同步引擎加载本地版本表失败: {}", e);
            }

            // 创建 accessor 并注入到 engine
            // accessor 持有各 store 的 Arc 引用，用于 push 时读值 / pull 时写值
            let accessor = std::sync::Arc::new(crate::sync::accessor::SyncStoreAccessor::new(
                config_dir.clone(),
                settings_arc.clone(),
                connection_store_arc.clone(),
                quick_command_store_arc.clone(),
                skill_store_arc.clone(),
                mcp_store_arc.clone(),
                conversation_db_arc.clone(),
            ));
            engine.set_accessor(accessor);

            let server_url = crate::sync::keychain::get_server_url()
                .ok()
                .flatten()
                .unwrap_or_default();

            // 降级：即使 server_url 为空也创建一个 client，sync 操作会失败但不会 panic
            let client_url = if server_url.is_empty() {
                "http://localhost:0".to_string()
            } else {
                server_url
            };
            let client = match crate::sync::client::SyncClient::new(&client_url) {
                Ok(c) => std::sync::Arc::new(c),
                Err(e) => {
                    log::warn!("同步客户端初始化失败: {}", e);
                    return Self {
                        ssh_manager: ssh_manager.clone(),
                        agent_tasks: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        plans: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        connection_store: connection_store_arc,
                        settings: settings_arc,
                        quick_command_store: quick_command_store_arc,
                        conversation_db: conversation_db_arc,
                        skill_store: skill_store_arc,
                        mcp_store: mcp_store_arc,
                        mcp_manager: std::sync::Arc::new(McpManager::new()),
                        config_dir,
                        pending_approvals: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        pending_questions: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        cancel_senders: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        upload_cancel_senders: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        download_cancel_senders: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        plugin_install_cancel_senders: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        command_exec: command_exec.clone(),
                        sysopen_watchers: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        sysopen_active_paths: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
                        settings_warning: std::sync::Arc::new(PlRwLock::new(settings_warning)),
                        plugin_registry: crate::plugins::registry::new_shared(),
                        sync_engine: Some(engine),
                        sync_scheduler: None,
                    };
                }
            };

            let scheduler = std::sync::Arc::new(
                crate::sync::scheduler::SyncScheduler::new(engine.clone(), client),
            );

            (Some(engine), Some(scheduler))
        };

        Self {
            ssh_manager,
            agent_tasks: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            plans: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            connection_store: connection_store_arc,
            settings: settings_arc,
            quick_command_store: quick_command_store_arc,
            conversation_db: conversation_db_arc,
            skill_store: skill_store_arc,
            mcp_store: mcp_store_arc,
            mcp_manager: std::sync::Arc::new(McpManager::new()),
            config_dir,
            pending_approvals: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            pending_questions: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            cancel_senders: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            upload_cancel_senders: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            download_cancel_senders: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            plugin_install_cancel_senders: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            command_exec,
            sysopen_watchers: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            sysopen_active_paths: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            settings_warning: std::sync::Arc::new(PlRwLock::new(settings_warning)),
            plugin_registry: crate::plugins::registry::new_shared(),
            sync_engine,
            sync_scheduler,
        }
    }
}

/// When settings.json exists but cannot be deserialised (schema mismatch,
/// corruption, version drift), copy it to a backup so the incompatible
/// file is never silently overwritten by a subsequent save.
/// Timestamped backups grow unbounded if loading fails on every launch.
/// Keep at most this many historical copies; prune older ones.
/// Returns the path of the "latest" backup (`settings.json.bak`) if it was
/// successfully created, for surfacing a warning to the user.
const MAX_TIMESTAMPED_SETTINGS_BACKUPS: usize = 5;

fn backup_settings_on_load_failure(settings_file: &std::path::Path) -> Option<std::path::PathBuf> {
    let parent = settings_file.parent().unwrap_or_else(|| std::path::Path::new("."));

    // Overwrite the most recent "last failure" backup (single file, always fresh).
    let bak_path = settings_file.with_extension("json.bak");
    let bak_created = match std::fs::copy(settings_file, &bak_path) {
        Ok(_) => {
            log::warn!("旧配置文件已备份到: {}", bak_path.display());
            true
        }
        Err(e) => {
            log::error!("无法备份旧配置文件: {} ({})", bak_path.display(), e);
            false
        }
    };

    // Timestamped snapshot — pruned so failures over many launches don't pile up.
    let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
    let ts_path = settings_file.with_extension(format!("json.{}.bak", ts));
    let _ = std::fs::copy(settings_file, &ts_path);

    // Prune excess timestamped backups (oldest first).
    if let Ok(dir) = std::fs::read_dir(parent) {
        let mut stamped: Vec<_> = dir
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("settings.json.")
            })
            .filter_map(|e| {
                let m = e.metadata().ok()?;
                Some((e.path(), m.modified().ok()?))
            })
            .collect();
        if stamped.len() > MAX_TIMESTAMPED_SETTINGS_BACKUPS {
            stamped.sort_by_key(|(_, t)| *t);
            for (path, _) in stamped.iter().take(stamped.len() - MAX_TIMESTAMPED_SETTINGS_BACKUPS) {
                let _ = std::fs::remove_file(path);
            }
        }
    }

    if bak_created {
        Some(bak_path)
    } else {
        None
    }
}

/// Build and run the Tauri application.
///
/// `mobile_entry_point` generates the JNI entry symbol Android needs to boot
/// the app from `libmarcel_ssh.so`; on desktop it's a no-op and `main.rs`
/// keeps calling `run()` directly.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .register_uri_scheme_protocol("plugin", |app, request| {
            crate::commands::plugin_uri::handle_plugin_uri(app, request)
        })
        .on_window_event(|window, event| {
            // 主窗口关闭时同步关闭所有插件独立窗口：Tauri 只在最后一个窗口
            // 关闭后退出应用，悬浮的插件窗口（如桌宠）不关会挡住应用退出。
            #[cfg(desktop)]
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { .. } = event {
                    crate::commands::plugin_window::close_all_plugin_windows(
                        &window.app_handle(),
                    );
                }
            }
        })
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));

            log::info!("App config directory: {}", config_dir.display());
            // AppState::new is async — create a short-lived runtime to drive
            // the parallel initialization. Independent stores load via
            // spawn_blocking (thread pool) while KnownHostsStore::load runs
            // natively on the async runtime. The runtime is dropped as soon as
            // the state is ready, so no extra threads linger.
            let init_rt = tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("Failed to create initialization runtime");
            let app_state = init_rt.block_on(AppState::new(config_dir));
            drop(init_rt);

            app.manage(app_state);

            // Load plugin manifests into the registry. Failure degrades to an
            // empty registry + log; the app still starts so the user can fix
            // the problem (e.g. bad plugin manifest) via the settings UI.
            {
                let state = app.state::<AppState>();
                let config_dir = state.config_dir.clone();
                let registry = state.plugin_registry.clone();
                let settings = state.settings.blocking_read().clone();
                let app_handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let app_version = app_handle.package_info().version.to_string();
                    let diff = {
                        let mut reg = registry.write().await;
                        reg.reload(&config_dir, &settings, &app_version).await
                    };
                    log::info!(
                        "插件注册表已加载: {} 个插件, {} 个变更",
                        diff.all_ids.len(),
                        diff.changed.len()
                    );
                    use tauri::Emitter;
                    let _ = app_handle.emit("plugin-registry-changed", &diff);
                });
            }

            // Background: refresh MCP tools for enabled servers without blocking startup.
            let mcp_manager = app.state::<AppState>().mcp_manager.clone();
            let mcp_store = app.state::<AppState>().mcp_store.clone();
            tauri::async_runtime::spawn(async move {
                let servers = mcp_store.read().await;
                let enabled: Vec<_> = servers
                    .list()
                    .iter()
                    .filter(|s| s.enabled)
                    .cloned()
                    .collect();
                drop(servers);
                let mut set = tokio::task::JoinSet::new();
                for server in enabled {
                    let mgr = mcp_manager.clone();
                    set.spawn(async move {
                        match mgr.refresh_tools(&server).await {
                            Ok(tools) => {
                                log::info!("MCP [{}] 发现 {} 个工具", server.name, tools.len())
                            }
                            Err(err) => log::warn!("MCP [{}] 刷新失败: {}", err, server.name),
                        }
                    });
                }
                while let Some(_) = set.join_next().await {}
            });

            // Background: start sync scheduler if sync was configured previously.
            // Engine + client + scheduler were initialized in AppState::new;
            // here we only start the background loops (push debounce + polling).
            // 同时注入 AppHandle 给 scheduler + accessor，让它们能 emit 前端事件。
            {
                let state = app.state::<AppState>();
                let app_handle = app.handle();
                if let Some(scheduler) = state.sync_scheduler.clone() {
                    scheduler.set_app_handle(app_handle.clone());
                    if let Some(api_key) = crate::sync::keychain::get_device_api_key()
                        .ok()
                        .flatten()
                    {
                        scheduler.set_api_key(Some(api_key));
                        let scheduler_clone = scheduler.clone();
                        tauri::async_runtime::spawn(async move {
                            scheduler_clone.start().await;
                        });
                    }
                }
                // 注入 AppHandle 给 accessor（通过 engine 转发），
                // 让 pull 时 apply_value 能 emit "sync-data-applied" 通知前端刷新。
                if let Some(ref engine) = state.sync_engine {
                    engine.set_accessor_app_handle(app_handle.clone());
                }
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_ready,
            commands::mobile_set_app_foreground,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_connect_with_saved_password,
            commands::ssh::ssh_connect_with_saved_passphrase,
            commands::ssh::ssh_reconnect,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_send_input,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_list_sessions,
            commands::ssh::ssh_exec,
            commands::ssh::ssh_exec_long,
            commands::ssh::ssh_exec_long_cancel,
            commands::agent_lifecycle::agent_start_task,
            commands::agent_lifecycle::agent_stop_task,
            commands::agent_lifecycle::agent_approve_operation,
            commands::agent_lifecycle::agent_reject_operation,
            commands::agent_lifecycle::agent_answer_question,
            commands::agent_compact::agent_compact_conversation,
            commands::agent_policy::agent_check_command,
            commands::agent_conversation::agent_create_conversation,
            commands::agent_conversation::agent_get_conversation,
            commands::agent_conversation::agent_list_conversations,
            commands::agent_conversation::agent_load_conversation,
            commands::agent_conversation::agent_delete_conversation,
            commands::agent_conversation::agent_save_message_images,
            commands::agent_conversation::agent_save_user_message,
            commands::agent_conversation::agent_resolve_image_path,
            commands::agent_conversation::agent_read_message_image,
            commands::agent_conversation::agent_delete_message_image,
            commands::agent_conversation::agent_truncate_conversation,
            commands::agent_conversation::agent_list_conversations_by_connection,
            commands::agent_conversation::agent_search_conversations,
            commands::agent_conversation::agent_delete_conversations_by_session,
            commands::agent_conversation::agent_load_plans_by_conversation,
            commands::connections::config_get_connections,
            commands::connections::config_save_connection,
            commands::connections::config_delete_connection,
            commands::settings::config_get_settings,
            commands::settings::config_save_settings,
            commands::settings::config_validate_custom_protected_paths,
            commands::settings::llm_list_models,
            commands::keychain::config_save_password,
            commands::keychain::config_has_password,
            commands::keychain::config_delete_password,
            commands::keychain::config_save_passphrase,
            commands::keychain::config_has_passphrase,
            commands::keychain::config_delete_passphrase,
            commands::keychain::config_save_jump_password,
            commands::keychain::config_has_jump_password,
            commands::keychain::config_delete_jump_password,
            commands::market::market_list,
            commands::market::market_detail,
            commands::keychain::config_save_jump_passphrase,
            commands::keychain::config_has_jump_passphrase,
            commands::keychain::config_delete_jump_passphrase,
            commands::quick_command::quick_command_list,
            commands::quick_command::quick_command_add,
            commands::quick_command::quick_command_update,
            commands::quick_command::quick_command_delete,
            commands::keychain::config_save_llm_api_key,
            commands::keychain::config_delete_llm_api_key,
            commands::keychain::config_save_web_search_api_key,
            commands::keychain::config_delete_web_search_api_key,

            commands::skill::skill_list,
            commands::skill::skill_add,
            commands::skill::skill_update,
            commands::skill::skill_toggle,
            commands::skill::skill_delete,
            commands::skill::import_skill_file,
            commands::mcp::mcp_list_servers,
            commands::mcp::mcp_add_server,
            commands::mcp::mcp_update_server,
            commands::mcp::mcp_delete_server,
            commands::mcp::mcp_toggle_server,
            commands::mcp::mcp_refresh_tools,
            commands::mcp::mcp_call_tool,
            commands::update::check_update,
            commands::update::open_external_url,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_download,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_remove_via_shell,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_extract_archive,
            commands::sftp::sftp_compress_archive,
            commands::sftp::sftp_upload_folder,
            commands::sftp::sftp_read_file,
            commands::sftp::sftp_get_mtime,
            commands::sftp::sftp_write_file,
            commands::sftp::sftp_download_stream,
            commands::sftp::sftp_upload_stream,
            commands::sftp::sftp_local_file_name,
            commands::sftp::sftp_cancel_upload,
            commands::sftp::sftp_cancel_download,
            commands::sftp::sftp_upload_folder_stream,
            commands::sftp::sftp_prepare_drag_upload,
            commands::sftp::sftp_cleanup_temp_dir,
            commands::sftp::sftp_preview_image,
            commands::sftp::sftp_preview_cleanup,
            commands::sftp::sftp_open_with_system,
            commands::sftp::sftp_cancel_sysopen,
            commands::plugin_webview::plugin_webview_create,
            commands::plugin_webview::plugin_webview_set_bounds,
            commands::plugin_webview::plugin_webview_close,
            commands::plugin_window::plugin_window_create,
            commands::plugin_window::plugin_window_show,
            commands::plugin_window::plugin_window_hide,
            commands::plugin_window::plugin_window_close,
            commands::plugin_window::plugin_window_focus,
            commands::plugin_window::plugin_window_set_position,
            commands::plugin_window::plugin_window_set_size,
            commands::plugin_window::plugin_window_set_always_on_top,
            commands::plugin_window::plugin_window_set_ignore_cursor_events,
            commands::plugin_menu::plugin_menu_register,
            commands::plugin_menu::plugin_menu_update,
            commands::plugin_menu::plugin_menu_unregister,
            commands::plugin_menu::plugin_menu_popup,
            commands::plugin::plugin_list,
            commands::plugin::plugin_capability_map,
            commands::plugin::plugin_reload,
            commands::plugin::get_plugin_dir,
            commands::plugin::open_plugin_dir,
            commands::plugin_install::plugin_install,
            commands::plugin_install::plugin_uninstall,
            commands::plugin_install::plugin_install_cancel,
            commands::plugin_fs::plugin_fs_read,
            commands::plugin_fs::plugin_fs_write,
            commands::plugin_http::plugin_http_request,
            commands::plugin_notification::plugin_send_notification,
            commands::sync::sync_get_summary,
            commands::sync::sync_pair_first,
            commands::sync::sync_pair_join,
            commands::sync::sync_update_profile,
            commands::sync::sync_push_now,
            commands::sync::sync_pull_now,
            commands::sync::sync_list_devices,
            commands::sync::sync_get_quota,
            commands::sync::sync_remove_device,
            commands::sync::sync_reset_account,
            commands::sync::sync_disable,
            commands::sync::sync_get_pending_conflicts,
            commands::sync::sync_resolve_conflict,
            commands::sync::sync_resolve_all_conflicts,
            commands::sync::sync_add_excluded_key,
            commands::sync::sync_remove_excluded_key,
            commands::sync::sync_get_excluded_keys,
        ])
        .build(tauri::generate_context!())
        .expect("Fatal: failed to start Tauri application")
        .run(|app, event| {
            // 移动端生命周期兜底：Android 切前台时 Tauri 抛出 Resumed。
            // 桌面端此事件通常不触发，emit 出去前端也只在移动端监听，无副作用。
            // 前端 (src/mobile/App.tsx) 用 visibilitychange 作为主信号，本事件作兜底，
            // 确保 WebView 被冻结后恢复时至少有一次状态刷新机会。
            //
            // 注：Tauri 2.10.3 的 RunEvent 无 Suspended variant，切后台信号
            // 仅靠前端 visibilitychange 触发，不影响 SSH/Agent 后台运行（前台服务保活）。
            // Resumed 时同步「在前台」给 notification，避免恢复后仍按后台发系统通知。
            if let tauri::RunEvent::Resumed = event {
                #[cfg(mobile)]
                crate::notification::set_app_in_foreground(true);
                let _ = app.emit("mobile://lifecycle", "resumed");
            }
        });
}
