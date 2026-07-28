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

/// How much recent conversation context the model-based approval step sees.
///
/// Lets the user trade off cost/latency against informed decisions.
/// `Normal` matches the original hard-coded behavior so existing users see no change.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalContextLevel {
    /// 2 rounds · 200 / 400 char caps. Cheapest, may miss recent actions.
    Concise,
    /// 5 rounds · 500 / 1000 char caps. Default; matches the original hard-coded limits.
    #[default]
    Normal,
    /// 10 rounds · 1500 / 3000 char caps. Best-informed, most tokens.
    Detailed,
}

/// Settings for the AGENT mode's command-execution policy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
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
    /// When true, execute_command will later run an extra model-based approval
    /// check before execution.
    #[serde(default)]
    pub enable_model_command_approval: bool,
    /// Optional model name override for the model-based command approval step.
    /// When empty, the main LLM model is used. Set to a smaller/faster model
    /// name to reduce approval latency and cost.
    #[serde(default)]
    pub model_approval_model: String,
    /// Custom system prompt for the model-based command approval step.
    /// When empty, the built-in approval prompt is used.
    #[serde(default)]
    pub model_approval_prompt: String,
    /// How much recent conversation context the approval model sees.
    /// More context = more informed decision but more tokens/latency.
    /// `Normal` matches the original hard-coded behavior.
    #[serde(default)]
    pub model_approval_context_level: ApprovalContextLevel,
    /// User-defined extra content appended to the system prompt sent to the LLM.
    /// Empty means nothing is appended.
    #[serde(default)]
    pub system_prompt: String,
    /// Maximum number of consecutive LLM ↔ tool-execution round-trips per task.
    #[serde(default = "default_max_tool_rounds")]
    pub max_tool_rounds: usize,
    /// When true, tool results in LLM history are compressed when
    /// cumulative token count exceeds configured thresholds.
    #[serde(default)]
    pub compact_context: bool,
    /// When true, edit_file requires human confirmation before execution.
    #[serde(default = "default_true")]
    pub confirm_edit_file: bool,
}

fn default_max_tool_rounds() -> usize {
    80
}

impl Default for AgentModeSettings {
    fn default() -> Self {
        Self {
            list_mode: CommandListMode::Denylist,
            command_list: vec![
                "rm".into(),
                "mkfs".into(),
                "dd".into(),
                "shutdown".into(),
                "reboot".into(),
            ],
            confirm_each_command: true,
            enable_model_command_approval: false,
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            model_approval_context_level: ApprovalContextLevel::Normal,
            system_prompt: String::new(),
            max_tool_rounds: 80,
            compact_context: false,
            confirm_edit_file: true,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum WebSearchMode {
    /// Local headless Chrome/Edge via CDP (best quality, default).
    #[default]
    Browser,
    /// Independent search-engine HTTP API (Brave / Tavily).
    Api,
    /// Bare Bing HTML scrape (zero config, lower quality).
    Html,
}

/// Backend for `http_get`. Independent from [`WebSearchMode`].
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum HttpFetchMode {
    /// Local headless Chrome/Edge via CDP (rendered DOM, default).
    #[default]
    Browser,
    /// Bare HTTP GET via reqwest.
    Html,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum WebSearchApiProvider {
    #[default]
    Brave,
    Tavily,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct ExperimentalSettings {
    pub enable_web_search: bool,
    pub enable_http_fetch: bool,
    /// When enabled, the Agent can open the cloud gaming page in the main UI.
    #[serde(default)]
    pub enable_cloud_page: bool,
    /// Which backend `web_search` uses. Defaults to browser for quality.
    #[serde(default)]
    pub web_search_mode: WebSearchMode,
    /// Which search API vendor to use when `web_search_mode == Api`.
    #[serde(default)]
    pub web_search_api_provider: WebSearchApiProvider,
    /// Which backend `http_get` uses. Independent of search mode.
    #[serde(default)]
    pub http_fetch_mode: HttpFetchMode,
}

impl Default for ExperimentalSettings {
    fn default() -> Self {
        Self {
            enable_web_search: true,
            enable_http_fetch: true,
            enable_cloud_page: false,
            web_search_mode: WebSearchMode::Browser,
            web_search_api_provider: WebSearchApiProvider::Brave,
            http_fetch_mode: HttpFetchMode::Browser,
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
    pub agent_question: bool,
    #[serde(default = "default_true")]
    pub agent_task_done: bool,
    #[serde(default = "default_true")]
    pub agent_task_failed: bool,
    #[serde(default = "default_volume")]
    pub notification_volume: u8,
}

fn default_volume() -> u8 {
    70
}

fn default_true() -> bool {
    true
}

impl Default for NotificationSettings {
    fn default() -> Self {
        Self {
            agent_approval: true,
            agent_question: true,
            agent_task_done: true,
            agent_task_failed: true,
            notification_volume: 70,
        }
    }
}

/// 移动端独立通知开关。
///
/// 与桌面端 `NotificationSettings` 完全隔离：
/// - 不包含 `notification_volume`（移动端不发提示音，走系统通知通道，无声）
/// - 不参与云端 syncStore 同步（`syncStore` 的 field paths 不包含本字段）
/// - 桌面端修改不影响移动端，反之亦然
///
/// Agent 事件通知由 Rust 侧 `send_notification` 在 `#[cfg(mobile)]` 分支下
/// 通过 `window.AndroidBridge.sendAgentNotification` 发出，走 `marcel_agent` 通道。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MobileNotificationSettings {
    #[serde(default = "default_true")]
    pub agent_approval: bool,
    #[serde(default = "default_true")]
    pub agent_question: bool,
    #[serde(default = "default_true")]
    pub agent_task_done: bool,
    #[serde(default = "default_true")]
    pub agent_task_failed: bool,
}

impl Default for MobileNotificationSettings {
    fn default() -> Self {
        Self {
            agent_approval: true,
            agent_question: true,
            agent_task_done: true,
            agent_task_failed: true,
        }
    }
}

/// 移动端后台保活设置。
///
/// 开启后 App 启动即启动 Android 前台服务（ForegroundService），切后台维持
/// SSH 会话与 Agent 任务运行。常驻通知为 Android 系统硬性要求，无法去除。
///
/// 不参与云端 syncStore 同步：保活是设备本地行为，跨设备同步无意义。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct MobileBackgroundSettings {
    /// 是否启用后台保活（前台服务）。默认关闭，用户主动开启。
    #[serde(default)]
    pub keep_alive_enabled: bool,
}

impl Default for MobileBackgroundSettings {
    fn default() -> Self {
        Self {
            keep_alive_enabled: false,
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
    /// Desktop file-manager directory tree width in pixels.
    #[serde(default = "default_file_manager_tree_width")]
    pub file_manager_tree_width: u16,
    /// User forced the directory tree closed (panel still auto-hides when narrow).
    #[serde(default)]
    pub file_manager_tree_user_hidden: bool,
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
    /// Notification preferences.
    #[serde(default)]
    pub notification_settings: NotificationSettings,
    /// 移动端独立通知开关（不参与云端同步）。
    /// 桌面端读写本字段无副作用，但 UI 不暴露；仅移动端设置页可改。
    #[serde(default)]
    pub mobile_notification_settings: MobileNotificationSettings,
    /// 移动端后台保活设置（不参与云端同步）。
    #[serde(default)]
    pub mobile_background_settings: MobileBackgroundSettings,
    /// Workspace layout intent for left/main/right columns.
    #[serde(default)]
    pub workspace_layout: WorkspaceLayoutSettings,
    /// User-defined protected paths. Writes to anything under these paths
    /// require explicit user approval, same as built-in `/etc`, `/boot`, etc.
    #[serde(default)]
    pub custom_protected_paths: Vec<String>,
    /// Command execution timeout in seconds for Agent tools.
    #[serde(default = "default_command_timeout")]
    pub command_timeout_secs: u64,
    /// Whether the user has completed the onboarding wizard.
    #[serde(default)]
    pub has_completed_onboarding: bool,
    /// Whether the user has accepted the cross-device sync disclaimer
    /// (shown once the first time they open the Sync settings page).
    /// Local-only flag; not included in sync field paths.
    #[serde(default)]
    pub has_accepted_sync_disclaimer: bool,
    /// Disabled plugin IDs. Plugins listed here are scanned but not loaded.
    #[serde(default)]
    pub disabled_plugins: Vec<String>,
    /// Per-plugin authorized capability IDs. If a plugin is not in the map,
    /// all declared capabilities are authorized (backward compatible).
    /// If a plugin IS in the map, only the listed capabilities are authorized.
    #[serde(default)]
    pub authorized_capabilities: HashMap<String, Vec<String>>,
    /// Safe-mode switch: when true, skip all content-script injections on
    /// startup. Used to recover from a plugin whose injected JS hangs the
    /// main window.
    #[serde(default)]
    pub disable_all_injections: bool,
}

fn default_file_manager_path() -> String {
    "/".to_string()
}
fn default_file_manager_tree_width() -> u16 {
    200
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
fn default_command_timeout() -> u64 {
    180
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
                enable_model_command_approval: false,
                model_approval_model: String::new(),
                model_approval_prompt: String::new(),
                model_approval_context_level: ApprovalContextLevel::Normal,
                system_prompt: String::new(),
                max_tool_rounds: 80,
                compact_context: false,
                confirm_edit_file: true,
            },
            experimental_settings: ExperimentalSettings::default(),
            file_manager_path: default_file_manager_path(),
            file_manager_paths: HashMap::new(),
            file_manager_show_hidden: false,
            file_manager_tree_width: default_file_manager_tree_width(),
            file_manager_tree_user_hidden: false,
            folder_upload_compression_level: default_folder_upload_compression_level(),
            panel_height: default_panel_height(),
            hide_thinking_display: false,
            notification_settings: NotificationSettings::default(),
            mobile_notification_settings: MobileNotificationSettings::default(),
            mobile_background_settings: MobileBackgroundSettings::default(),
            workspace_layout: WorkspaceLayoutSettings::default(),
            custom_protected_paths: vec![],
            command_timeout_secs: default_command_timeout(),
            has_completed_onboarding: false,
            has_accepted_sync_disclaimer: false,
            disabled_plugins: vec![],
            authorized_capabilities: HashMap::new(),
            disable_all_injections: false,
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
        assert!(!s.command_list.is_empty());
        assert!(s.command_list.contains(&"rm".to_string()));
        assert_eq!(s.model_approval_context_level, ApprovalContextLevel::Normal);
    }

    #[test]
    fn old_agent_settings_keep_original_approval_context_limits() {
        let parsed: AgentModeSettings = serde_json::from_str(
            r#"{"enableModelCommandApproval":true,"modelApprovalModel":"fast-model"}"#,
        )
        .expect("old agent settings should load");

        assert!(parsed.enable_model_command_approval);
        assert_eq!(parsed.model_approval_model, "fast-model");
        assert_eq!(
            parsed.model_approval_context_level,
            ApprovalContextLevel::Normal
        );
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
        assert_eq!(s.web_search_mode, WebSearchMode::Browser);
        assert_eq!(s.web_search_api_provider, WebSearchApiProvider::Brave);
        assert_eq!(s.http_fetch_mode, HttpFetchMode::Browser);
    }

    #[test]
    fn experimental_settings_loads_old_format_without_web_search_mode() {
        let json = r#"{"enableWebSearch":true,"enableHttpFetch":true}"#;
        let parsed: ExperimentalSettings =
            serde_json::from_str(json).expect("old experimental settings should load");
        assert!(parsed.enable_web_search);
        assert_eq!(parsed.web_search_mode, WebSearchMode::Browser);
        assert_eq!(parsed.web_search_api_provider, WebSearchApiProvider::Brave);
        assert_eq!(parsed.http_fetch_mode, HttpFetchMode::Browser);
    }

    #[test]
    fn experimental_settings_http_fetch_mode_independent_of_search() {
        let json = r#"{
            "enableWebSearch": true,
            "enableHttpFetch": true,
            "webSearchMode": "api",
            "webSearchApiProvider": "tavily",
            "httpFetchMode": "html"
        }"#;
        let parsed: ExperimentalSettings =
            serde_json::from_str(json).expect("mixed modes should load");
        assert_eq!(parsed.web_search_mode, WebSearchMode::Api);
        assert_eq!(parsed.web_search_api_provider, WebSearchApiProvider::Tavily);
        assert_eq!(parsed.http_fetch_mode, HttpFetchMode::Html);
    }

    #[test]
    fn experimental_settings_http_fetch_mode_roundtrip() {
        let mut s = ExperimentalSettings::default();
        s.http_fetch_mode = HttpFetchMode::Html;
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(json.contains("\"httpFetchMode\":\"html\""));
        let parsed: ExperimentalSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.http_fetch_mode, HttpFetchMode::Html);
        assert_eq!(parsed.web_search_mode, WebSearchMode::Browser);
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
        assert_eq!(s.file_manager_tree_width, 200);
        assert!(!s.file_manager_tree_user_hidden);
        assert_eq!(s.folder_upload_compression_level, 6);
        assert!(!s.hide_thinking_display);
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

    /// hasCompletedOnboarding should default to false for old configs.
    #[test]
    fn app_settings_loads_old_format_without_onboarding() {
        let json = "{\"fontSize\": 14}";
        let parsed: AppSettings =
            serde_json::from_str(json).expect("missing hasCompletedOnboarding should load");
        assert!(!parsed.has_completed_onboarding);
    }

    /// hasCompletedOnboarding should roundtrip correctly.
    #[test]
    fn app_settings_onboarding_roundtrip() {
        let mut settings = AppSettings::default();
        settings.has_completed_onboarding = true;
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains("\"hasCompletedOnboarding\":true"));
        let parsed: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert!(parsed.has_completed_onboarding);
    }

    /// Missing hasAcceptedSyncDisclaimer in old configs defaults to false.
    #[test]
    fn app_settings_loads_old_format_without_sync_disclaimer() {
        let json = "{\"fontSize\": 14}";
        let parsed: AppSettings =
            serde_json::from_str(json).expect("missing hasAcceptedSyncDisclaimer should load");
        assert!(!parsed.has_accepted_sync_disclaimer);
    }

    #[test]
    fn app_settings_sync_disclaimer_roundtrip() {
        let mut settings = AppSettings::default();
        settings.has_accepted_sync_disclaimer = true;
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains("\"hasAcceptedSyncDisclaimer\":true"));
        let parsed: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert!(parsed.has_accepted_sync_disclaimer);
    }

    #[test]
    fn disabled_plugins_defaults_to_empty() {
        let s = AppSettings::default();
        assert!(s.disabled_plugins.is_empty());
    }

    #[test]
    fn disabled_plugins_roundtrip() {
        let mut settings = AppSettings::default();
        settings.disabled_plugins = vec!["plug-a".into(), "plug-b".into()];
        let json = serde_json::to_string(&settings).expect("serialize");
        let parsed: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.disabled_plugins, vec!["plug-a", "plug-b"]);
    }

    #[test]
    fn disabled_plugins_loads_missing_as_empty() {
        let json = "{\"fontSize\": 14}";
        let parsed: AppSettings =
            serde_json::from_str(json).expect("missing disabledPlugins should load");
        assert!(parsed.disabled_plugins.is_empty());
    }

    #[test]
    fn disable_all_injections_defaults_false() {
        let s = AppSettings::default();
        assert!(!s.disable_all_injections);
    }

    #[test]
    fn disable_all_injections_loads_missing_as_false() {
        let json = "{\"fontSize\": 14}";
        let parsed: AppSettings =
            serde_json::from_str(json).expect("missing disableAllInjections should load");
        assert!(!parsed.disable_all_injections);
    }

    #[test]
    fn disable_all_injections_roundtrip() {
        let mut settings = AppSettings::default();
        settings.disable_all_injections = true;
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains("\"disableAllInjections\":true"));
        let parsed: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert!(parsed.disable_all_injections);
    }
}
