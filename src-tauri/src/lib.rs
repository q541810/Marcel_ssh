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
use crate::agent::runtime::AgentTask;
use crate::agent::runtime::AgentTaskPlan;
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
    pub fn new(config_dir: PathBuf) -> Self {
        // Load known_hosts (TOFU). If the file is unreadable we fall back to
        // an empty in-memory store; mismatches will then prompt the user.
        let known_hosts_path = config_dir.join("known_hosts.json");
        let known_hosts = futures::executor::block_on(KnownHostsStore::load(known_hosts_path))
            .unwrap_or_else(|e| {
                log::error!("无法加载 known_hosts.json，使用空 store: {}", e);
                // Fallback to a temp-path store so we don't crash. Subsequent
                // saves will still attempt the original path? No — once
                // constructed, the path is fixed. This is best-effort.
                futures::executor::block_on(KnownHostsStore::load(
                    std::env::temp_dir().join("marcel-ssh-known-hosts-fallback.json"),
                ))
                .expect("fallback known_hosts init")
            });

        // Load persisted config (best-effort: log errors and fall back to defaults)
        let connection_store = ConnectionStore::load_from_path(
            &ConnectionStore::default_file(&config_dir),
        )
        .unwrap_or_else(|e| {
            log::warn!("无法加载连接配置，使用默认值：{}", e);
            ConnectionStore::new()
        });

        let mut settings = AppSettings::load_from_path(
            &AppSettings::default_file(&config_dir),
        )
        .unwrap_or_else(|e| {
            log::warn!("无法加载应用设置，使用默认值：{}", e);
            AppSettings::default()
        });

        // Backwards-compat: existing settings files written before LLM support
        // had `llmConfig: null`. Backfill with a working default so users get a
        // ready-to-use configuration on upgrade.
        if settings.llm_config.is_none() {
            settings.llm_config = Some(crate::llm::provider::LlmConfig::default());
            log::info!("settings.json 缺少 llmConfig，已填入默认值");
            // Best-effort: persist back so the user can edit it via the Settings UI.
            let _ = settings.save_to_path(&AppSettings::default_file(&config_dir));
        }

        // Load LLM API key from the system keychain (if available)
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

        let db_path = config_dir.join("conversations.db");
        let conversation_db = match ConversationDb::new(&db_path) {
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
                log::warn!("  Check write permissions: {}", config_dir.display());
                match ConversationDb::in_memory() {
                    Ok(db) => db,
                    Err(e2) => {
                        panic!("Failed to init in-memory DB: {}", e2);
                    }
                }
            }
        };

        let skill_store = SkillStore::load_from_path(
            &SkillStore::default_file(&config_dir),
        )
        .unwrap_or_else(|e| {
            log::warn!("Failed to load skills, using defaults: {}", e);
            SkillStore::new()
        });

        let quick_command_store = QuickCommandStore::load_from_path(
            &QuickCommandStore::default_file(&config_dir),
        )
        .unwrap_or_else(|e| {
            log::warn!("Failed to load quick commands, using defaults: {}", e);
            QuickCommandStore::new()
        });

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
        .setup(|app| {
            // Determine config directory (e.g. %APPDATA%\com.marcel.ssh on Windows)
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| PathBuf::from("."));

            log::info!("App config directory: {}", config_dir.display());

            let app_state = AppState::new(config_dir);
            app.manage(app_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // SSH commands
            commands::ssh::ssh_connect,
            commands::ssh::ssh_disconnect,
            commands::ssh::ssh_send_input,
            commands::ssh::ssh_resize,
            commands::ssh::ssh_list_sessions,
            // Agent commands
            commands::agent::agent_start_task,
            commands::agent::agent_stop_task,
            commands::agent::agent_approve_operation,
            commands::agent::agent_reject_operation,
            commands::agent::agent_check_command,
            commands::agent::agent_create_conversation,
            commands::agent::agent_list_conversations,
            commands::agent::agent_load_conversation,
            commands::agent::agent_delete_conversation,
            commands::agent::agent_list_conversations_by_connection,
            commands::agent::agent_delete_conversations_by_session,
            // Config commands
            commands::connections::config_get_connections,
            commands::connections::config_save_connection,
            commands::connections::config_delete_connection,
            commands::settings::config_get_settings,
            commands::settings::config_save_settings,
            commands::keychain::config_save_password,
            commands::keychain::config_get_password,
            commands::keychain::config_delete_password,
            // Quick command commands
            commands::quick_command::quick_command_list,
            commands::quick_command::quick_command_add,
            commands::quick_command::quick_command_update,
            commands::quick_command::quick_command_delete,
        // LLM API Key management
        commands::keychain::config_save_llm_api_key,
        commands::keychain::config_get_llm_api_key,
        commands::keychain::config_delete_llm_api_key,
        // Skill commands
        commands::skill::skill_list,
        commands::skill::skill_add,
        commands::skill::skill_update,
        commands::skill::skill_toggle,
        commands::skill::skill_delete,
        commands::skill::import_skill_file,
        ])
        .run(tauri::generate_context!())
        .expect("Fatal: failed to start Tauri application");
}
