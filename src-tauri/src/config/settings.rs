use serde::{Deserialize, Serialize};

use crate::llm::provider::LlmConfig;
use super::persist::JsonPersistable;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TerminalColors {
    pub background: String,
    pub foreground: String,
    pub cursor: String,
    pub cursor_accent: String,
    pub selection_background: String,
    pub black: String,
    pub red: String,
    pub green: String,
    pub yellow: String,
    pub blue: String,
    pub magenta: String,
    pub cyan: String,
    pub white: String,
    pub bright_black: String,
    pub bright_red: String,
    pub bright_green: String,
    pub bright_yellow: String,
    pub bright_blue: String,
    pub bright_magenta: String,
    pub bright_cyan: String,
    pub bright_white: String,
}

impl Default for TerminalColors {
    fn default() -> Self {
        Self {
            background: "#18181b".to_string(),
            foreground: "#e4e4e7".to_string(),
            cursor: "#a1a1aa".to_string(),
            cursor_accent: "#18181b".to_string(),
            selection_background: "#3f3f46".to_string(),
            black: "#27272a".to_string(),
            red: "#ef4444".to_string(),
            green: "#22c55e".to_string(),
            yellow: "#eab308".to_string(),
            blue: "#3b82f6".to_string(),
            magenta: "#a855f7".to_string(),
            cyan: "#06b6d4".to_string(),
            white: "#e4e4e7".to_string(),
            bright_black: "#52525b".to_string(),
            bright_red: "#f87171".to_string(),
            bright_green: "#4ade80".to_string(),
            bright_yellow: "#facc15".to_string(),
            bright_blue: "#60a5fa".to_string(),
            bright_magenta: "#c084fc".to_string(),
            bright_cyan: "#22d3ee".to_string(),
            bright_white: "#fafafa".to_string(),
        }
    }
}

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExperimentalSettings {
    pub enable_web_search: bool,
    pub enable_http_fetch: bool,
    /// When enabled, the Agent can open the cloud gaming page in the main UI.
    #[serde(default)]
    pub enable_cloud_page: bool,
}

impl Default for ExperimentalSettings {
    fn default() -> Self {
        Self {
            enable_web_search: true,
            enable_http_fetch: true,
            enable_cloud_page: false,
        }
    }
}

/// Application-wide settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub terminal_colors: TerminalColors,
    pub font_size: u16,
    pub font_family: String,
    pub default_agent_mode: String,
    #[serde(default)]
    pub llm_config: Option<LlmConfig>,
    #[serde(default)]
    pub agent_mode_settings: AgentModeSettings,
    #[serde(default)]
    pub experimental_settings: ExperimentalSettings,
    /// File manager last browsed path
    #[serde(default = "default_file_manager_path")]
    pub file_manager_path: String,
    /// File manager show hidden files
    #[serde(default)]
    pub file_manager_show_hidden: bool,
    /// Bottom panel height in pixels
    #[serde(default = "default_panel_height")]
    pub panel_height: u16,
}

fn default_file_manager_path() -> String { "/".to_string() }
fn default_panel_height() -> u16 { 256 }

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            terminal_colors: TerminalColors::default(),
            font_size: 14,
            font_family: "monospace".into(),
            default_agent_mode: "agent".into(),
            llm_config: Some(LlmConfig::default()),
            agent_mode_settings: AgentModeSettings {
                list_mode: CommandListMode::Denylist,
                command_list: vec![
                    "rm".into(),
                    "mkfs".into(),
                    "dd".into(),
                    "shutdown".into(),
                    "reboot".into(),
                ],
                confirm_each_command: true,
            },
            experimental_settings: ExperimentalSettings::default(),
            file_manager_path: default_file_manager_path(),
            file_manager_show_hidden: false,
            panel_height: default_panel_height(),
        }
    }
}

impl JsonPersistable for AppSettings {
    fn default_filename() -> &'static str {
        "settings.json"
    }
}
