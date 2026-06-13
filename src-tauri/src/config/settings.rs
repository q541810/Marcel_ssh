use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::persist::JsonPersistable;
use crate::llm::provider::LlmConfig;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
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
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
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
#[serde(rename_all = "camelCase", default)]
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

/// Notification preferences.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettings {
    #[serde(default = "default_true")]
    pub agent_approval: bool,
    #[serde(default = "default_true")]
    pub agent_task_done: bool,
    #[serde(default = "default_true")]
    pub agent_task_failed: bool,
}

fn default_true() -> bool {
    true
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            agent_approval: true,
            agent_task_done: true,
            agent_task_failed: true,
        }
    }
}

/// Saved workspace layout intent. The frontend treats these as user-preferred
/// base widths, then scales them against the current window size.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceLayoutSettings {
    #[serde(default = "default_sidebar_base_width")]
    pub sidebar_base_width: u16,
    #[serde(default = "default_agent_base_width")]
    pub agent_base_width: u16,
    #[serde(default = "default_true")]
    pub sidebar_open: bool,
    #[serde(default = "default_true")]
    pub agent_open: bool,
}

fn default_sidebar_base_width() -> u16 {
    280
}

fn default_agent_base_width() -> u16 {
    460
}

fn legacy_ratio_to_base_width(ratio: Option<f64>, fallback: u16) -> u16 {
    let Some(ratio) = ratio else {
        return fallback;
    };
    if !ratio.is_finite() || ratio <= 0.0 {
        return fallback;
    }
    (1144.0 * ratio.clamp(0.12, 0.45)).round() as u16
}

impl<'de> Deserialize<'de> for WorkspaceLayoutSettings {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Helper {
            sidebar_base_width: Option<u16>,
            agent_base_width: Option<u16>,
            sidebar_ratio: Option<f64>,
            agent_ratio: Option<f64>,
            sidebar_open: Option<bool>,
            agent_open: Option<bool>,
        }

        let helper = Helper::deserialize(deserializer)?;
        Ok(Self {
            sidebar_base_width: helper.sidebar_base_width.unwrap_or_else(|| {
                legacy_ratio_to_base_width(helper.sidebar_ratio, default_sidebar_base_width())
            }),
            agent_base_width: helper.agent_base_width.unwrap_or_else(|| {
                legacy_ratio_to_base_width(helper.agent_ratio, default_agent_base_width())
            }),
            sidebar_open: helper.sidebar_open.unwrap_or(true),
            agent_open: helper.agent_open.unwrap_or(true),
        })
    }
}

impl Default for WorkspaceLayoutSettings {
    fn default() -> Self {
        Self {
            sidebar_base_width: default_sidebar_base_width(),
            agent_base_width: default_agent_base_width(),
            sidebar_open: true,
            agent_open: true,
        }
    }
}

/// Application-wide settings.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    #[serde(default)]
    pub terminal_colors: TerminalColors,
    #[serde(default = "default_font_size")]
    pub font_size: u16,
    #[serde(default = "default_font_family")]
    pub font_family: String,
    #[serde(default = "default_agent_mode_str")]
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
    /// File manager last browsed path per SSH connection key.
    #[serde(default)]
    pub file_manager_paths: HashMap<String, String>,
    /// File manager show hidden files
    #[serde(default)]
    pub file_manager_show_hidden: bool,
    /// Zip compression level for folder uploads (0 fastest/largest, 9 slowest/smallest).
    #[serde(default = "default_folder_upload_compression_level")]
    pub folder_upload_compression_level: i64,
    /// Bottom panel height in pixels
    #[serde(default = "default_panel_height")]
    pub panel_height: u16,
    /// Whether to hide thinking/reasoning content in the UI.
    /// Note: This only affects display. The thinking content is still
    /// processed and returned to the API as required by some models.
    #[serde(default)]
    pub hide_thinking_display: bool,
    /// Whether to enable the whip button in the Agent input area.
    #[serde(default)]
    pub whip_enabled: bool,
    /// Tip velocity threshold for whip crack detection; lower is more sensitive.
    #[serde(default = "default_whip_crack_speed")]
    pub whip_crack_speed: u16,
    /// Whether a whip crack appends text to the Agent input.
    #[serde(default = "default_true")]
    pub whip_auto_input_enabled: bool,
    /// User-editable phrases appended when the whip cracks.
    #[serde(default = "default_whip_phrases")]
    pub whip_phrases: Vec<String>,
    /// Notification preferences.
    #[serde(default)]
    pub notification_settings: NotificationSettings,
    /// Workspace layout intent for left/main/right columns.
    #[serde(default)]
    pub workspace_layout: WorkspaceLayoutSettings,
}

fn default_file_manager_path() -> String {
    "/".to_string()
}
fn default_font_size() -> u16 {
    14
}
fn default_font_family() -> String {
    "JetBrains Mono, Fira Code, Consolas, \"Microsoft YaHei\", monospace".to_string()
}
fn default_agent_mode_str() -> String {
    "agent".to_string()
}
fn default_folder_upload_compression_level() -> i64 {
    6
}
fn default_panel_height() -> u16 {
    256
}
fn default_whip_crack_speed() -> u16 {
    240
}
fn default_whip_phrases() -> Vec<String> {
    vec![
        "快点干活，别磨蹭。".into(),
        "再慢鞭子又要响了。".into(),
        "别装死，继续。".into(),
        "速度，别让我等。".into(),
        "醒醒，该干活了。".into(),
    ]
}

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
            file_manager_paths: HashMap::new(),
            file_manager_show_hidden: false,
            folder_upload_compression_level: default_folder_upload_compression_level(),
            panel_height: default_panel_height(),
            hide_thinking_display: false,
            whip_enabled: false,
            whip_crack_speed: default_whip_crack_speed(),
            whip_auto_input_enabled: true,
            whip_phrases: default_whip_phrases(),
            notification_settings: NotificationSettings::default(),
            workspace_layout: WorkspaceLayoutSettings::default(),
        }
    }
}

impl JsonPersistable for AppSettings {
    fn default_filename() -> &'static str {
        "settings.json"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_settings_default_roundtrip_json() {
        let settings = AppSettings::default();
        let json = serde_json::to_string(&settings).expect("serialize");
        let parsed: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed, settings);
    }

    #[test]
    fn workspace_layout_reads_legacy_ratios_as_base_widths() {
        let json = r#"{
            "sidebarRatio": 0.22,
            "agentRatio": 0.3,
            "sidebarOpen": true,
            "agentOpen": false
        }"#;
        let parsed: WorkspaceLayoutSettings = serde_json::from_str(json).expect("deserialize");

        assert_eq!(parsed.sidebar_base_width, 252);
        assert_eq!(parsed.agent_base_width, 343);
        assert!(parsed.sidebar_open);
        assert!(!parsed.agent_open);
    }

    #[test]
    fn terminal_colors_default_has_all_fields() {
        let c = TerminalColors::default();
        assert!(!c.background.is_empty());
        assert!(!c.foreground.is_empty());
        assert!(!c.cursor.is_empty());
        assert!(c.background.starts_with('#'));
    }

    #[test]
    fn agent_mode_settings_default_is_denylist() {
        let s = AgentModeSettings::default();
        assert_eq!(s.list_mode, CommandListMode::Denylist);
        assert!(s.command_list.is_empty());
    }

    #[test]
    fn app_settings_default_has_command_list() {
        let s = AppSettings::default();
        assert!(!s.agent_mode_settings.command_list.is_empty());
        assert!(s
            .agent_mode_settings
            .command_list
            .contains(&"rm".to_string()));
        assert!(s
            .agent_mode_settings
            .command_list
            .contains(&"mkfs".to_string()));
        assert!(s
            .agent_mode_settings
            .command_list
            .contains(&"dd".to_string()));
        assert!(s
            .agent_mode_settings
            .command_list
            .contains(&"shutdown".to_string()));
        assert!(s
            .agent_mode_settings
            .command_list
            .contains(&"reboot".to_string()));
    }

    #[test]
    fn experimental_settings_default_enables_web_and_http() {
        let s = ExperimentalSettings::default();
        assert!(s.enable_web_search);
        assert!(s.enable_http_fetch);
        assert!(!s.enable_cloud_page);
    }

    #[test]
    fn command_list_mode_default_is_denylist() {
        assert_eq!(CommandListMode::default(), CommandListMode::Denylist);
    }

    #[test]
    fn app_settings_default_values() {
        let s = AppSettings::default();
        assert_eq!(s.font_size, 14);
        assert_eq!(s.font_family, "monospace");
        assert_eq!(s.default_agent_mode, "agent");
        assert_eq!(s.panel_height, 256);
        assert_eq!(s.file_manager_path, "/");
        assert!(s.file_manager_paths.is_empty());
        assert!(!s.file_manager_show_hidden);
        assert_eq!(s.folder_upload_compression_level, 6);
        assert!(!s.hide_thinking_display);
        assert!(!s.whip_enabled);
        assert_eq!(s.whip_crack_speed, 240);
        assert!(s.whip_auto_input_enabled);
        assert!(s.whip_phrases.contains(&"快点干活，别磨蹭。".to_string()));
    }

    /// Old configs (before fileManagerPaths was added) should still load — the
    /// struct-level `#[serde(default)]` fills missing fields from AppSettings::default().
    #[test]
    fn app_settings_loads_old_format_without_file_manager_paths() {
        let json = "{
            \"terminalColors\": {\"background\":\"#000\",\"foreground\":\"#fff\",\"cursor\":\"#fff\",
                \"cursorAccent\":\"#000\",\"selectionBackground\":\"#444\",\"black\":\"#000\",\"red\":\"#f00\",
                \"green\":\"#0f0\",\"yellow\":\"#ff0\",\"blue\":\"#00f\",\"magenta\":\"#f0f\",\"cyan\":\"#0ff\",
                \"white\":\"#fff\",\"brightBlack\":\"#888\",\"brightRed\":\"#f88\",\"brightGreen\":\"#8f8\",
                \"brightYellow\":\"#ff8\",\"brightBlue\":\"#88f\",\"brightMagenta\":\"#f8f\",\"brightCyan\":\"#8ff\",
                \"brightWhite\":\"#fff\"},
            \"fontSize\": 16,
            \"fontFamily\": \"Comic Sans\",
            \"defaultAgentMode\": \"auto\"
        }";
        let parsed: AppSettings =
            serde_json::from_str(json).expect("old format should load via struct default");
        assert_eq!(parsed.font_size, 16);
        assert_eq!(parsed.font_family, "Comic Sans");
        assert_eq!(parsed.default_agent_mode, "auto");
        // Missing nested objects filled from AppSettings::default().
        assert_eq!(parsed.file_manager_path, "/");
        assert!(parsed.file_manager_paths.is_empty());
        assert!(parsed.notification_settings.agent_approval);
    }

    /// Old configs that have a partial terminalColors (missing fields) should
    /// still load via field-level `#[serde(default)]` on the inner struct.
    #[test]
    fn terminal_colors_loads_with_missing_fields() {
        let json = "{\"background\": \"#000\", \"foreground\": \"#fff\"}";
        let parsed: TerminalColors =
            serde_json::from_str(json).expect("partial terminalColors should load");
        assert_eq!(parsed.background, "#000");
        assert_eq!(parsed.foreground, "#fff");
        // Missing fields fall back to TerminalColors::default() values.
        assert_eq!(parsed.cursor, "#a1a1aa");
        assert_eq!(parsed.bright_white, "#fafafa");
    }

    /// notificationSettings is entirely missing — should use Default.
    #[test]
    fn app_settings_loads_without_notification_settings() {
        let json = "{\"fontSize\": 14}";
        let parsed: AppSettings =
            serde_json::from_str(json).expect("missing notificationSettings should load");
        assert!(parsed.notification_settings.agent_approval);
        assert!(parsed.notification_settings.agent_task_done);
        assert!(parsed.notification_settings.agent_task_failed);
    }
}
