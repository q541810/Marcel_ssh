pub mod agent;
pub mod commands;
pub mod config;
pub mod error;
pub mod llm;
pub mod ssh;

use std::collections::HashMap;
use std::path::PathBuf;

use parking_lot::RwLock as PlRwLock;
use tauri::Manager;
use tokio::sync::RwLock as TokioRwLock;
use tokio::sync::oneshot;

use crate::agent::audit::AuditLog;
use crate::agent::runtime::AgentTask;
use crate::config::connections::ConnectionStore;
use crate::config::settings::AppSettings;
use crate::ssh::connection::SshManager;

/// Shared application state managed by Tauri.
///
/// Note: SSH-related state uses `tokio::sync::RwLock` because async tasks
/// hold these locks across `.await` points. Other state uses `parking_lot`
/// for cheaper, sync access.
#[derive(Clone)]
pub struct AppState {
    pub ssh_manager: SshManager,
    pub agent_tasks: std::sync::Arc<PlRwLock<HashMap<String, AgentTask>>>,
    pub connection_store: std::sync::Arc<TokioRwLock<ConnectionStore>>,
    pub settings: std::sync::Arc<TokioRwLock<AppSettings>>,
    pub audit_log: std::sync::Arc<PlRwLock<AuditLog>>,
    /// Application config directory. Used for persisting connections, settings, etc.
    pub config_dir: PathBuf,
    /// Pending approval requests: tool_call_id -> oneshot sender for approval response
    pub pending_approvals: std::sync::Arc<PlRwLock<HashMap<String, oneshot::Sender<bool>>>>,
}

impl AppState {
    /// Create a new AppState, loading any persisted config from `config_dir`.
    pub fn new(config_dir: PathBuf) -> Self {
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

        Self {
            ssh_manager: SshManager::new(),
            agent_tasks: std::sync::Arc::new(PlRwLock::new(HashMap::new())),
            connection_store: std::sync::Arc::new(TokioRwLock::new(connection_store)),
            settings: std::sync::Arc::new(TokioRwLock::new(settings)),
            audit_log: std::sync::Arc::new(PlRwLock::new(AuditLog::new())),
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
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
            // Config commands
            commands::config::config_get_connections,
            commands::config::config_save_connection,
            commands::config::config_delete_connection,
            commands::config::config_get_settings,
            commands::config::config_save_settings,
            commands::config::config_save_password,
            commands::config::config_get_password,
            commands::config::config_delete_password,
            // LLM API Key management
            commands::config::config_save_llm_api_key,
            commands::config::config_get_llm_api_key,
            commands::config::config_delete_llm_api_key,
        ])
        .run(tauri::generate_context!())
        .expect("Fatal: failed to start Tauri application");
}
