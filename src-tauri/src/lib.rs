pub mod agent;
pub mod commands;
pub mod config;
pub mod error;
pub mod llm;
pub mod skills;
pub mod ssh;

use std::collections::HashMap;
use std::path::PathBuf;

use parking_lot::RwLock as PlRwLock;
use tauri::Manager;
use tokio::sync::RwLock as TokioRwLock;
use tokio::sync::oneshot;

use crate::agent::audit::AuditLog;
use crate::agent::conversation::ConversationDb;
use crate::agent::task::AgentTask;
use crate::agent::task::AgentTaskPlan;
use crate::config::connections::ConnectionStore;
use crate::config::persist::JsonPersistable;
use crate::config::quick_commands::QuickCommandStore;
use crate::config::settings::AppSettings;
use crate::skills::store::SkillStore;
use crate::ssh::connection::SshManager;
use crate::ssh::known_hosts::KnownHostsStore;

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
    pub audit_log: std::sync::Arc<PlRwLock<AuditLog>>,
    pub conversation_db: std::sync::Arc<ConversationDb>,
    pub skill_store: std::sync::Arc<TokioRwLock<SkillStore>>,
    /// Application config directory. Used for persisting connections, settings, etc.
    pub config_dir: PathBuf,
    /// Pending approval requests: tool_call_id -> oneshot sender for approval response
    pub pending_approvals: std::sync::Arc<PlRwLock<HashMap<String, oneshot::Sender<bool>>>>,
}

impl AppState {
    /// Create a new AppState, loading any persisted config from `config_dir`.
    ///
    /// All independent stores are loaded in parallel. File I/O is offloaded to
    /// the blocking thread pool via `tokio::task::spawn_blocking` so the async
    /// runtime is never stalled. Settings-dependent work (keychain, llm_config
    /// backfill) runs sequentially after settings are loaded.
    pub async fn new(config_dir: PathBuf) -> Self {
        // Pre-compute file paths so each `spawn_blocking` closure can own its
        // own copy without borrowing `config_dir`.
        let known_hosts_path = config_dir.join("known_hosts.json");
        let connections_file = ConnectionStore::default_file(&config_dir);
        let settings_file = AppSettings::default_file(&config_dir);
        let db_path = config_dir.join("conversations.db");
        let skills_file = SkillStore::default_file(&config_dir);
        let quick_commands_file = QuickCommandStore::default_file(&config_dir);

        // ── Phase 1: parallel loads (all independent) ──────────────────────
        let (
            known_hosts_res,
            connections_res,
            settings_res,
            db_handle,
            skills_res,
            qc_res,
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
                            log::warn!(
                                "Failed to init file DB ({}): {}",
                                db_path.display(),
                                e
                            );
                            log::warn!("  Falling back to in-memory DB");
                            log::warn!(
                                "  Check write permissions: {}",
                                config_dir_for_db.display()
                            );
                            ConversationDb::in_memory()
                                .expect("Failed to init in-memory DB")
                        }
                    }
                }),

                tokio::task::spawn_blocking(move || {
                    SkillStore::load_from_path(&skills_file)
                }),
                tokio::task::spawn_blocking(move || {
                    QuickCommandStore::load_from_path(&quick_commands_file)
                }),
            )
        };

        // ── Phase 2: process results with fallbacks ────────────────────────

        // KnownHosts – async fallback on error (can still .await here).
        let known_hosts = match known_hosts_res {
            Ok(kh) => kh,
            Err(e) => {
                log::error!("无法加载 known_hosts.json，使用空 store: {}", e);
                KnownHostsStore::load(
                    std::env::temp_dir().join("marcel-ssh-known-hosts-fallback.json"),
                )
                .await
                .expect("fallback known_hosts init")
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
                AppSettings::default()
            }
            Err(join_err) => {
                log::warn!("应用设置加载任务失败：{}", join_err);
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

        Self {
            ssh_manager: SshManager::with_known_hosts(known_hosts),
            agent_tasks: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            plans: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            connection_store: std::sync::Arc::new(TokioRwLock::new(connection_store)),
            settings: std::sync::Arc::new(TokioRwLock::new(settings)),
            quick_command_store: std::sync::Arc::new(TokioRwLock::new(quick_command_store)),
            audit_log: std::sync::Arc::new(PlRwLock::new(AuditLog::new())),
            conversation_db: std::sync::Arc::new(conversation_db),
            skill_store: std::sync::Arc::new(TokioRwLock::new(skill_store)),
            config_dir,
            pending_approvals: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
        }
    }
}

/// Build and run the Tauri application.
pub fn run() {
    env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .init();

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_ready,
            commands::ssh::ssh_connect,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_send_input,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_list_sessions,
            commands::ssh::ssh_exec,
            commands::agent_lifecycle::agent_start_task,
            commands::agent_lifecycle::agent_stop_task,
            commands::agent_lifecycle::agent_approve_operation,
            commands::agent_lifecycle::agent_reject_operation,
            commands::agent_policy::agent_check_command,
            commands::agent_conversation::agent_create_conversation,
            commands::agent_conversation::agent_list_conversations,
            commands::agent_conversation::agent_load_conversation,
            commands::agent_conversation::agent_delete_conversation,
            commands::agent_conversation::agent_list_conversations_by_connection,
            commands::agent_conversation::agent_delete_conversations_by_session,
            commands::connections::config_get_connections,
            commands::connections::config_save_connection,
            commands::connections::config_delete_connection,
            commands::settings::config_get_settings,
            commands::settings::config_save_settings,
            commands::keychain::config_save_password,
            commands::keychain::config_get_password,
            commands::keychain::config_delete_password,
            commands::quick_command::quick_command_list,
            commands::quick_command::quick_command_add,
            commands::quick_command::quick_command_update,
            commands::quick_command::quick_command_delete,
            commands::keychain::config_save_llm_api_key,
            commands::keychain::config_get_llm_api_key,
            commands::keychain::config_delete_llm_api_key,
            commands::skill::skill_list,
            commands::skill::skill_add,
            commands::skill::skill_update,
            commands::skill::skill_toggle,
            commands::skill::skill_delete,
            commands::skill::import_skill_file,
            commands::update::check_update,
            commands::sftp::sftp_list_dir,
            commands::sftp::sftp_upload,
            commands::sftp::sftp_download,
            commands::sftp::sftp_mkdir,
            commands::sftp::sftp_remove,
            commands::sftp::sftp_rename,
            commands::sftp::sftp_upload_folder,
        ])
        .run(tauri::generate_context!())
        .expect("Fatal: failed to start Tauri application");
}
