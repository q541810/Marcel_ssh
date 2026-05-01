use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::llm::provider::LlmConfig;

/// Agent command list mode — determines whether `commandList` is treated
/// as an allow-list (only listed commands may run) or a deny-list (listed
/// commands are blocked, all others may run).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CommandListMode {
    /// Whitelist mode — only commands matching the list are permitted.
    Allowlist,
    /// Blacklist mode — commands matching the list are blocked, all others allowed.
    Denylist,
}

impl Default for CommandListMode {
    fn default() -> Self {
        // Sensible default: only block known-dangerous commands rather than
        // forcing the user to enumerate every safe command.
        CommandListMode::Denylist
    }
}

/// Settings for the AGENT mode's command-execution policy.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentModeSettings {
    /// Whether `commandList` acts as allowlist or denylist.
    pub list_mode: CommandListMode,
    /// Command patterns (matched against the base command, e.g. "rm", "sudo").
    /// Each entry is a simple string match, not a regex.
    pub command_list: Vec<String>,
    /// When true (default), AGENT mode still asks the user to confirm any
    /// command that passes the list filter. When false, listed commands run
    /// silently — useful when the user has carefully curated the lists.
    pub confirm_each_command: bool,
}

/// Application-wide settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub theme: String,
    pub font_size: u16,
    pub font_family: String,
    pub default_agent_mode: String,
    #[serde(default)]
    pub llm_config: Option<LlmConfig>,
    #[serde(default)]
    pub agent_mode_settings: AgentModeSettings,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            theme: "dark".into(),
            font_size: 14,
            font_family: "monospace".into(),
            default_agent_mode: "agent".into(),
            // Ship a working default so users can chat immediately.
            llm_config: Some(LlmConfig::default()),
            agent_mode_settings: AgentModeSettings {
                list_mode: CommandListMode::Denylist,
                // Same dangerous defaults as the Sandbox blocklist
                command_list: vec![
                    "rm".into(),
                    "mkfs".into(),
                    "dd".into(),
                    "shutdown".into(),
                    "reboot".into(),
                ],
                confirm_each_command: true,
            },
        }
    }
}

impl AppSettings {
    /// Load settings from the given JSON file. Returns defaults if missing.
    pub fn load_from_path(path: &Path) -> Result<Self, AppError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(path)
            .map_err(|e| AppError::Config(format!("读取设置文件失败: {}", e)))?;
        if content.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str(&content)
            .map_err(|e| AppError::Config(format!("解析设置文件失败: {}", e)))
    }

    /// Serialize settings to a JSON file. Creates parent directories as needed.
    pub fn save_to_path(&self, path: &Path) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Config(format!("创建配置目录失败: {}", e))
            })?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::Config(format!("序列化设置失败: {}", e)))?;
        std::fs::write(path, json)
            .map_err(|e| AppError::Config(format!("写入设置文件失败: {}", e)))?;
        Ok(())
    }

    /// Convenience: build the default settings.json path inside the app config dir.
    pub fn default_file(config_dir: &Path) -> PathBuf {
        config_dir.join("settings.json")
    }
}
