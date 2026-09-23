use serde::{Deserialize, Serialize};
use std::collections::HashMap;

use super::persist::JsonPersistable;
use crate::llm::provider::LlmConfig;
use crate::llm::registry::LlmRegistry;

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

/// 命令审批用哪个引擎（`enableModelCommandApproval` 打开后才生效）。
///
/// 线上格式是与 TS 侧共享的两个小写字符串（`"model"` / `"jev"`），`Deserialize`
/// 手写而不用 derive：**未知取值不能炸掉整个 settings.json**（未来版本加了第三种
/// 引擎后用户回退到本版本时，派生实现会让整个配置文件解析失败 → 用户设置被备份
/// 并重置），依据与原因同 [`UpdateMode`] 那段注释。`Serialize` 仍走 derive，
/// 线上取值由 `approval_engine_serde_values_are_stable` 钉住。
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CommandApprovalEngine {
    /// 走会话模型（或「命令审核」槽位指定的模型），自由文本判定 + JSON 解析。
    /// **旧数据的默认值**——settings.json 里没有这个键时落在这里，
    /// 于是行为与引入 Jev 之前逐字节一致。
    Model,
    /// 走 TypeSafe 的 Jev（System One 决策模型）：一次 POST 返回类型化选项与概率，
    /// 不需要 API Key 之外的模型配置。
    Jev,
}

impl CommandApprovalEngine {
    /// 未知取值（更高版本写入的引擎）→ 会话模型引擎：这是引入 Jev 之前的行为，
    /// 且不需要用户额外配置任何东西，是两者里最保守的选择。
    fn from_wire(raw: &str) -> Self {
        match raw {
            "model" => CommandApprovalEngine::Model,
            "jev" => CommandApprovalEngine::Jev,
            other => {
                log::warn!(
                    "未知的命令审批引擎 {:?}（可能来自更高版本），按会话模型引擎处理",
                    other
                );
                CommandApprovalEngine::Model
            }
        }
    }
}

impl Default for CommandApprovalEngine {
    fn default() -> Self {
        Self::Model
    }
}

impl<'de> Deserialize<'de> for CommandApprovalEngine {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // 反序列化成 Value 再取字符串：字段缺失不会走到这里（serde default 兜底），
        // 类型不对（数字/对象/数组）也退回保守取值，而不是让整个配置文件解析失败。
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(match value.as_str() {
            Some(s) => Self::from_wire(s),
            None => {
                log::warn!(
                    "命令审批引擎字段类型异常（{:?}），按会话模型引擎处理",
                    value
                );
                CommandApprovalEngine::Model
            }
        })
    }
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
    /// 当 true 时，Plan 模式也走命令名单与「每条都手动确认」的人审（旧行为）。
    ///
    /// 默认 false：Plan 的命令审批语义与 Auto 一致 —— 不弹人工审批，只有
    /// `ForceApproval`（系统级命令 / 受保护路径 / sudo…）与 `Deny` 两档照旧拦。
    /// 规划阶段绝大多数命令是只读研究，逐条弹窗是纯摩擦。
    #[serde(default)]
    pub plan_mode_requires_approval: bool,
    /// When true, bash will later run an extra model-based approval
    /// check before execution.
    #[serde(default)]
    pub enable_model_command_approval: bool,
    /// 审批引擎。仅在 `enable_model_command_approval` 为 true 时生效。
    /// 缺该键（旧 settings.json）时取 `Model`，行为不变。
    #[serde(default)]
    pub command_approval_engine: CommandApprovalEngine,
    /// Jev 引擎使用的模型 ID。默认**钉版本号**而不是 `jev-latest` 别名：
    /// 官方文档明说别名会随发布前移，而审批是安全闸门，行为不该悄悄变。
    /// 空值会在构造时回落 `llm::jev::JEV_DEFAULT_MODEL`。
    #[serde(default)]
    pub jev_model_id: String,
    /// Jev 的 API 根地址（企业代理 / 私有网关 / 本地 mock）。**空 = 用官方地址。**
    ///
    /// 与模型服务渠道的 `base_url` 同一个意思：只改「请求打到哪台机器」，
    /// 不改请求契约。空值**不覆盖**默认地址（不是「清空」）——兼容旧数据 =
    /// 保持原样。
    #[serde(default)]
    pub jev_base_url: String,
    /// Jev 引擎的判据（作为 Choice 的 `instructions`，空 = 用内置模板）。
    ///
    /// 与 `model_approval_prompt` **分开存放**是刻意的：chat 的自定义提示词通常
    /// 带「输出严格的 JSON {...}」这类格式要求，而 Jev 不生成文本，喂过去只会
    /// 变成噪音指令、静默劣化判定质量。两个引擎的判据形状不同，不能共用一个输入框。
    #[serde(default)]
    pub jev_approval_prompt: String,
    /// Optional model name override for the model-based command approval step.
    /// When empty, the main LLM model is used. Set to a smaller/faster model
    /// name to reduce approval latency and cost.
    #[serde(default)]
    pub model_approval_model: String,
    /// Custom system prompt for the model-based command approval step.
    /// When empty, the built-in approval prompt is used.
    #[serde(default)]
    pub model_approval_prompt: String,
    /// User-defined extra content appended to the system prompt sent to the LLM.
    /// Empty means nothing is appended.
    #[serde(default)]
    pub system_prompt: String,
    /// Maximum number of consecutive LLM ↔ tool-execution round-trips per task.
    #[serde(default = "default_max_tool_rounds")]
    pub max_tool_rounds: usize,
    /// Model context window size in tokens. `0` = unset: only the overflow
    /// trigger compacts (after the provider reports a context-length error).
    /// When > 0, pressure-based proactive compaction is enabled (estimated
    /// tokens beyond 80% of this window trigger compaction of old history).
    #[serde(default)]
    pub context_window: u64,
    /// When true, edit_file requires human confirmation before execution.
    #[serde(default = "default_true")]
    pub confirm_edit_file: bool,
}

fn default_max_tool_rounds() -> usize {
    500
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
            confirm_each_command: default_true(),
            plan_mode_requires_approval: false,
            enable_model_command_approval: false,
            command_approval_engine: CommandApprovalEngine::default(),
            jev_model_id: String::new(),
            jev_base_url: String::new(),
            jev_approval_prompt: String::new(),
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            system_prompt: String::new(),
            max_tool_rounds: default_max_tool_rounds(),
            context_window: 0,
            confirm_edit_file: default_true(),
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

/// Which Bing host `web_search` uses for browser/html modes.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum WebSearchEndpoint {
    /// cn.bing.com — China-region node; stable tokenization for mixed CN/EN queries.
    #[default]
    Cn,
    /// www.bing.com — international CDN node; may degrade on some networks.
    Www,
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
    /// When enabled, the Agent can render interactive HTML visualizations
    /// directly in the conversation via `render_html` (simulators, charts,
    /// comparison panels, UI mockups). Rendered locally in a sandboxed
    /// iframe; never touches the remote server.
    #[serde(default = "default_true")]
    pub enable_html_render: bool,
    /// Which backend `web_search` uses. Defaults to browser for quality.
    #[serde(default)]
    pub web_search_mode: WebSearchMode,
    /// Which search API vendor to use when `web_search_mode == Api`.
    #[serde(default)]
    pub web_search_api_provider: WebSearchApiProvider,
    /// Which Bing host `web_search` uses for browser/html modes.
    #[serde(default)]
    pub web_search_endpoint: WebSearchEndpoint,
    /// Which backend `http_get` uses. Independent of search mode.
    #[serde(default)]
    pub http_fetch_mode: HttpFetchMode,
    /// 多机操控的「可跨机目标机器」集合（SavedConnection id 列表，空 = 仅
    /// 当前机器可执行）。双端多机操控恒开启（无开关），Agent 工具（bash /
    /// upload_file / download_file / subagent）可携带 `host` 参数；目标机器
    /// 必须在此集合内（或为当前会话所在机器），否则拒绝。由用户在 Agent
    /// 面板（桌面顶栏 / 移动 Sheet）勾选维护；后端任务/工具解析时读取同一
    /// 份做白名单。upload/download 仍为桌面专属工具（本机文件系统语义）。
    #[serde(default)]
    pub multi_host_connection_ids: Vec<String>,
}

impl Default for ExperimentalSettings {
    fn default() -> Self {
        Self {
            enable_web_search: default_true(),
            enable_http_fetch: default_true(),
            enable_cloud_page: false,
            enable_html_render: default_true(),
            web_search_mode: WebSearchMode::Browser,
            web_search_api_provider: WebSearchApiProvider::Brave,
            web_search_endpoint: WebSearchEndpoint::Cn,
            http_fetch_mode: HttpFetchMode::Browser,
            multi_host_connection_ids: Vec::new(),
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
            agent_approval: default_true(),
            agent_question: default_true(),
            agent_task_done: default_true(),
            agent_task_failed: default_true(),
            notification_volume: default_volume(),
        }
    }
}

/// 移动端独立通知开关。
///
/// 与桌面端 `NotificationSettings` 完全隔离：
/// - 不包含 `notification_volume`（移动端不发提示音，走系统通知通道，无声）
/// - 设备本地，桌面端修改不影响移动端，反之亦然
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
/// 设备本地行为：保活每台设备独立设置。
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

/// 更新方式（三态）：自动更新 / 仅提醒 / 关闭。
///
/// 取代此前的单一 `auto_update` 布尔开关 —— 那个开关只切「要不要自动下载」，
/// 新版本检查永远在跑，用户想「彻底不查新版本」时没有任何入口。三态把两种
/// 语义分开：
///
/// - `Auto`：检查 + 自动后台下载 + 就绪后自动安装（桌面退出即静默装）；
/// - `Notify`：只检查并在药丸/浮层提示，下载与安装都由用户手动发起；
/// - `Off`：不检查新版本，也不自动下载/安装（设置页的手动「检查更新」仍可用，
///   「手动检查是你主动发起的」不该被自己的开关锁死）。
///
/// 线上格式是与 TS 侧共享的三个小写字符串（`"auto"` / `"notify"` / `"off"`），
/// 手写 Serialize/Deserialize 而不用 derive：**未知取值不能炸掉整个
/// settings.json**（未来版本加了第四种模式后用户回退到本版本时，派生实现会
/// 让整个配置文件解析失败 → 用户设置被备份并重置）。未知值按最保守的
/// 「仅提醒」处理并记日志。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UpdateMode {
    #[default]
    Auto,
    Notify,
    Off,
}

impl UpdateMode {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdateMode::Auto => "auto",
            UpdateMode::Notify => "notify",
            UpdateMode::Off => "off",
        }
    }

    /// 未知取值（更高版本写入的模式）→ 仅提醒：不自动下载、不自动安装，
    /// 但保留新版本提示，是三者里最保守且不丢信息的选择。
    fn from_wire(raw: &str) -> Self {
        match raw {
            "auto" => UpdateMode::Auto,
            "notify" => UpdateMode::Notify,
            "off" => UpdateMode::Off,
            other => {
                log::warn!("未知的更新方式 {:?}（可能来自更高版本），按「仅提醒」处理", other);
                UpdateMode::Notify
            }
        }
    }

    /// 是否要自动检查新版本（关闭模式下连检查都不做）。
    pub fn checks_for_updates(self) -> bool {
        !matches!(self, UpdateMode::Off)
    }

    /// 是否允许自动后台下载（只有自动更新模式会下载，其余等用户手动发起）。
    pub fn auto_downloads(self) -> bool {
        matches!(self, UpdateMode::Auto)
    }
}

impl Serialize for UpdateMode {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for UpdateMode {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        // 反序列化成 Value 再取字符串：字段缺失不会走到这里（serde default 兜底），
        // 类型不对（数字/对象）也退回上面的保守取值，而不是让整个配置文件解析失败。
        let value = serde_json::Value::deserialize(deserializer)?;
        Ok(match value.as_str() {
            Some(s) => Self::from_wire(s),
            None => {
                log::warn!("更新方式字段类型异常（{:?}），按「仅提醒」处理", value);
                UpdateMode::Notify
            }
        })
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
    #[serde(default = "default_llm_config")]
    pub llm_config: Option<LlmConfig>,
    /// 多渠道多模型注册表（渠道/模型/场景槽位）。旧 `llm_config` 迁移后恒为 None。
    #[serde(default)]
    pub llm_registry: LlmRegistry,
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
    /// 折叠「已完成且过程较长」的回合（前端 `ConversationDisplaySection`）。
    /// 后端不读它，只负责持久化 —— 但**必须有这个字段**，否则前端写进来会被
    /// serde 静默丢弃、重启即失效。
    #[serde(default = "default_true")]
    pub fold_completed_turns: bool,
    /// 隐私模式：连接名/地址在界面上打码（前端 `usePrivacyMode`）。
    /// 同上：后端不读，只负责持久化。
    #[serde(default)]
    pub privacy_mode: bool,
    /// 更新方式（三态）：自动更新 / 仅提醒 / 关闭。旧配置（1.4.0 及更早）没有
    /// 这个字段，由下面的 `auto_update` 推导 —— 见 `migrate_update_mode_from_legacy`。
    #[serde(default)]
    pub update_mode: UpdateMode,
    /// **旧字段（只读镜像）**：给还在用它的旧版本客户端读的兼容字段，一律由
    /// `update_mode` 派生（自动更新 = true，其余 = false），前端不再直接写它。
    /// 保持镜像一致，是为了让用户回退到旧版本时至少不会「关了更新却开始自动下载」。
    #[serde(default = "default_true")]
    pub auto_update: bool,
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

/// 旧单配置 `llm_config` 的默认值。
///
/// 它同时承担「新装用户预置一个默认渠道」的职责：启动时
/// `llm::registry::migrate_legacy_settings` 会把这里的旧配置铺成「默认渠道 +
/// 默认模型」（仅当注册表里一个渠道都没有时），用户只需填 API Key 即可用。
/// 因此它的默认值必须与 `AppSettings::default()` 一致，不能单方面退化成 `None`
/// —— 那会让全新安装的注册表变成空的。`serde_defaults_match_default_impl`
/// 守着这条一致性。
fn default_llm_config() -> Option<LlmConfig> {
    Some(LlmConfig::default())
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            terminal_colors: TerminalColors::default(),
            // 这几个字段一律调默认值函数，**不再内联抄一遍**：抄过的代价是
            // `font_family`（"monospace" vs 长字体栈）与 `max_tool_rounds`
            // （80 vs 500）两处漂移 —— serde 缺字段路径读函数、新装路径读内联值，
            // 于是「新装」和「读到没有该字段的旧配置」拿到不同默认值。
            font_size: default_font_size(),
            font_family: default_font_family(),
            default_agent_mode: default_agent_mode_str(),
            llm_config: default_llm_config(),
            llm_registry: LlmRegistry::default(),
            agent_mode_settings: AgentModeSettings::default(),
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
            disabled_plugins: vec![],
            authorized_capabilities: HashMap::new(),
            disable_all_injections: false,
            fold_completed_turns: true,
            privacy_mode: false,
            update_mode: UpdateMode::Auto,
            auto_update: default_true(),
        }
    }
}

impl AppSettings {
    /// 把旧字段镜像同步到当前模式（幂等）：`auto_update` 只是给旧版本客户端读的
    /// 兼容字段，真实语义以 `update_mode` 为准。保存设置与加载配置时都调用，
    /// 保证落盘的配置不会出现「模式说关闭、镜像说开着」这种自相矛盾的状态。
    pub fn sync_update_mode_mirror(&mut self) {
        self.auto_update = self.update_mode.auto_downloads();
    }

    /// 旧配置迁移 + 镜像同步（幂等）：
    ///
    /// 1. 配置文件里**没有** `updateMode` 键（1.4.0 及更早写出的配置）→ 按旧的
    ///    `autoUpdate` 推导：`true` → 自动更新，`false` → 仅提醒。旧语义下
    ///    「关掉开关」就是「不自动下载、仍然提示」，迁移后行为逐字保持不变；
    ///    `autoUpdate` 也缺失时用默认（自动更新，与 serde default 一致）。
    /// 2. 同步旧的 `auto_update` 镜像字段。
    ///
    /// 之所以要带原始文本：`updateMode` **缺失**才是迁移信号，而 serde 的
    /// 字段默认值会把「缺失」和「显式写了 auto」压成同一个值，解析结果里
    /// 分不出来。
    pub fn migrate_update_mode_from_legacy(&mut self, raw: &str) {
        let explicit = serde_json::from_str::<serde_json::Value>(raw)
            .ok()
            .and_then(|v| v.get("updateMode").map(|_| ()))
            .is_some();
        if !explicit {
            self.update_mode = if self.auto_update {
                UpdateMode::Auto
            } else {
                UpdateMode::Notify
            };
        }
        self.sync_update_mode_mirror();
    }
}

impl JsonPersistable for AppSettings {
    fn default_filename() -> &'static str {
        "settings.json"
    }

    /// 覆盖默认加载：解析后补一次三态更新方式的迁移（见
    /// `migrate_update_mode_from_legacy`）。原始文本读不到时跳过迁移 ——
    /// 此时保持 serde 的默认值（自动更新），与旧版本行为一致。
    fn load_from_path(path: &std::path::Path) -> Result<Self, crate::error::AppError> {
        let mut parsed = Self::load_parsed(path)?;
        if let Ok(raw) = std::fs::read_to_string(path) {
            parsed.migrate_update_mode_from_legacy(&raw);
        }
        Ok(parsed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

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
    }

    /// 旧 settings.json（没有 Jev 那三个键）必须落回「会话模型引擎」，
    /// 也就是与引入 Jev 之前**完全一样**的行为。
    ///
    /// 这是「兼容 = 保持原样」的硬护栏：反序列化一旦误判成 Jev，用户会在
    /// 毫无察觉的情况下把所有 bash 审批切到一个他还没配 Key 的引擎上。
    #[test]
    fn settings_without_jev_fields_fall_back_to_model_engine() {
        let old = r#"{
            "listMode": "denylist",
            "commandList": ["rm"],
            "confirmEachCommand": true,
            "enableModelCommandApproval": true,
            "modelApprovalModel": "",
            "modelApprovalPrompt": "我的老提示词",
            "systemPrompt": "",
            "maxToolRounds": 500,
            "contextWindow": 0,
            "confirmEditFile": true
        }"#;
        let s: AgentModeSettings = serde_json::from_str(old).expect("旧配置必须能反序列化");
        assert_eq!(
            s.command_approval_engine,
            CommandApprovalEngine::Model,
            "缺 commandApprovalEngine 时必须是会话模型引擎"
        );
        assert_eq!(s.jev_model_id, "", "不得替用户凭空填上一个 Jev 型号");
        assert_eq!(s.jev_approval_prompt, "");
        // 旧字段原样保留，不被新字段挤掉。
        assert!(s.enable_model_command_approval);
        assert_eq!(s.model_approval_prompt, "我的老提示词");
    }

    /// 新键的序列化取值必须稳定——前端 TS 映射与它逐字对齐。
    #[test]
    fn approval_engine_serde_values_are_stable() {
        assert_eq!(
            serde_json::to_string(&CommandApprovalEngine::Model).unwrap(),
            "\"model\""
        );
        assert_eq!(
            serde_json::to_string(&CommandApprovalEngine::Jev).unwrap(),
            "\"jev\""
        );
        assert_eq!(
            serde_json::from_str::<CommandApprovalEngine>("\"jev\"").unwrap(),
            CommandApprovalEngine::Jev
        );
    }

    /// 未知取值（更高版本写入的第三种引擎）不能让整个 settings.json 解析失败，
    /// 按引入 Jev 之前的「会话模型引擎」处理（同
    /// `unknown_update_mode_degrades_to_notify_without_failing`）。
    #[test]
    fn unknown_command_approval_engine_degrades_to_model_without_failing() {
        let json =
            "{\"fontSize\":15,\"agentModeSettings\":{\"commandApprovalEngine\":\"llm-judge\"}}";
        let parsed: AppSettings = serde_json::from_str(json).expect("unknown engine should load");
        assert_eq!(
            parsed.agent_mode_settings.command_approval_engine,
            CommandApprovalEngine::Model
        );
        assert_eq!(parsed.font_size, 15, "同文件其他字段照常生效");
    }

    /// 类型异常（数字）同样退化到会话模型引擎，不炸整个配置。
    #[test]
    fn malformed_command_approval_engine_type_degrades_to_model() {
        let json = "{\"agentModeSettings\":{\"commandApprovalEngine\":3}}";
        let parsed: AppSettings = serde_json::from_str(json).expect("malformed engine should load");
        assert_eq!(
            parsed.agent_mode_settings.command_approval_engine,
            CommandApprovalEngine::Model
        );
    }

    /// 容错反序列化不得把合法取值也一起吞掉：jev 必须原样读出，
    /// 且同文件其他审批字段照常生效。
    #[test]
    fn known_command_approval_engine_values_still_parse() {
        let json = r#"{"agentModeSettings":{"commandApprovalEngine":"jev","jevModelId":"jev-x","modelApprovalPrompt":"p"}}"#;
        let parsed: AppSettings = serde_json::from_str(json).expect("known engine should load");
        assert_eq!(
            parsed.agent_mode_settings.command_approval_engine,
            CommandApprovalEngine::Jev
        );
        assert_eq!(parsed.agent_mode_settings.jev_model_id, "jev-x");
        assert_eq!(parsed.agent_mode_settings.model_approval_prompt, "p");
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
        assert_eq!(s.web_search_endpoint, WebSearchEndpoint::Cn);
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
        assert_eq!(parsed.web_search_endpoint, WebSearchEndpoint::Cn);
        assert_eq!(parsed.http_fetch_mode, HttpFetchMode::Browser);
        // 多机操控：旧数据无集合字段 → 空集合（不报错、不改写）。
        assert!(parsed.multi_host_connection_ids.is_empty());
    }

    #[test]
    fn experimental_settings_multi_host_fields_roundtrip() {
        let mut s = ExperimentalSettings::default();
        s.multi_host_connection_ids = vec!["c1".to_string(), "c2".to_string()];
        let json = serde_json::to_string(&s).expect("serialize");
        assert!(json.contains("\"multiHostConnectionIds\":[\"c1\",\"c2\"]"));
        let parsed: ExperimentalSettings = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(parsed.multi_host_connection_ids, vec!["c1", "c2"]);
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
        // 钉**字面量**而不是调 `default_font_family()` 自比（那样永不可能失败）：
        // 历史上这里是 "monospace"，而 serde 缺字段路径走函数 → 同一批默认值两份。
        assert_eq!(
            s.font_family,
            "JetBrains Mono, Fira Code, Consolas, \"Microsoft YaHei\", monospace"
        );
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

    /// 旧配置里遗留的字段（如已废弃的 hasAcceptedSyncDisclaimer）应被忽略加载。
    #[test]
    fn app_settings_ignores_removed_legacy_fields() {
        let json = "{\"fontSize\": 14, \"hasAcceptedSyncDisclaimer\": true}";
        let parsed: AppSettings =
            serde_json::from_str(json).expect("legacy fields should be ignored");
        assert_eq!(parsed.font_size, 14);
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

    /// autoUpdate 旧配置缺失 → 默认开启（serde default），不改动用户现状。
    #[test]
    fn auto_update_defaults_true_for_old_configs() {
        let json = "{\"fontSize\": 14}";
        let parsed: AppSettings = serde_json::from_str(json).expect("old config should load");
        assert!(parsed.auto_update);
    }

    #[test]
    fn auto_update_roundtrip() {
        let mut settings = AppSettings::default();
        settings.auto_update = false;
        let json = serde_json::to_string(&settings).expect("serialize");
        assert!(json.contains("\"autoUpdate\":false"));
        let parsed: AppSettings = serde_json::from_str(&json).expect("deserialize");
        assert!(!parsed.auto_update);
    }

    // ── 更新方式三态（updateMode） ──────────────────────────────

    /// 新装/无此字段且无旧字段 → 自动更新（与三态引入前的默认行为一致）。
    #[test]
    fn update_mode_defaults_to_auto() {
        assert_eq!(AppSettings::default().update_mode, UpdateMode::Auto);
        let mut s = AppSettings::default();
        s.migrate_update_mode_from_legacy("{\"fontSize\":14}");
        assert_eq!(s.update_mode, UpdateMode::Auto);
        assert!(s.auto_update);
    }

    /// 旧配置 `autoUpdate:false`（旧语义 = 仅提醒）→ 迁移成「仅提醒」，
    /// 行为逐字不变：仍然检查并提示，只是不自动下载。
    #[test]
    fn legacy_auto_update_false_migrates_to_notify() {
        let json = "{\"autoUpdate\":false}";
        let mut parsed: AppSettings = serde_json::from_str(json).expect("old config should load");
        parsed.migrate_update_mode_from_legacy(json);
        assert_eq!(parsed.update_mode, UpdateMode::Notify);
        assert!(!parsed.auto_update, "镜像字段应保持 false");
    }

    /// 旧配置 `autoUpdate:true` → 自动更新。
    #[test]
    fn legacy_auto_update_true_migrates_to_auto() {
        let json = "{\"autoUpdate\":true}";
        let mut parsed: AppSettings = serde_json::from_str(json).expect("old config should load");
        parsed.migrate_update_mode_from_legacy(json);
        assert_eq!(parsed.update_mode, UpdateMode::Auto);
    }

    /// 显式写了 updateMode 时不被旧字段覆盖，且旧字段镜像被同步成一致值
    /// （否则用户回退旧版本会看到「关了更新却仍开着自动下载」的矛盾配置）。
    #[test]
    fn explicit_update_mode_wins_over_legacy_flag() {
        let json = "{\"autoUpdate\":true,\"updateMode\":\"off\"}";
        let mut parsed: AppSettings = serde_json::from_str(json).expect("config should load");
        parsed.migrate_update_mode_from_legacy(json);
        assert_eq!(parsed.update_mode, UpdateMode::Off);
        assert!(!parsed.auto_update, "镜像需同步为 false");
    }

    /// 未知取值（更高版本写入的第四种模式）不能让整个 settings.json 解析失败，
    /// 按最保守的「仅提醒」处理。
    #[test]
    fn unknown_update_mode_degrades_to_notify_without_failing() {
        let json = "{\"fontSize\":15,\"updateMode\":\"quiet\"}";
        let parsed: AppSettings = serde_json::from_str(json).expect("unknown mode should load");
        assert_eq!(parsed.update_mode, UpdateMode::Notify);
        assert_eq!(parsed.font_size, 15, "同文件其他字段照常生效");
    }

    /// 类型异常（数字）同样退化为「仅提醒」，不炸整个配置。
    #[test]
    fn malformed_update_mode_type_degrades_to_notify() {
        let parsed: AppSettings =
            serde_json::from_str("{\"updateMode\":3}").expect("malformed mode should load");
        assert_eq!(parsed.update_mode, UpdateMode::Notify);
    }

    #[test]
    fn update_mode_roundtrips_as_camel_case() {
        for (mode, wire) in [
            (UpdateMode::Auto, "\"updateMode\":\"auto\""),
            (UpdateMode::Notify, "\"updateMode\":\"notify\""),
            (UpdateMode::Off, "\"updateMode\":\"off\""),
        ] {
            let mut settings = AppSettings::default();
            settings.update_mode = mode;
            let json = serde_json::to_string(&settings).expect("serialize");
            assert!(json.contains(wire), "{} 应含 {}", json, wire);
            let parsed: AppSettings = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(parsed.update_mode, mode);
        }
    }

    /// 三态的能力划分：只有「自动更新」自动下载；只有「关闭」不检查。
    #[test]
    fn update_mode_capabilities() {
        assert!(UpdateMode::Auto.checks_for_updates());
        assert!(UpdateMode::Auto.auto_downloads());
        assert!(UpdateMode::Notify.checks_for_updates());
        assert!(!UpdateMode::Notify.auto_downloads());
        assert!(!UpdateMode::Off.checks_for_updates());
        assert!(!UpdateMode::Off.auto_downloads());
    }


    /// 读 `src/lib/types.ts`，取 `export interface NAME { ... }` 的字段名。
    /// 跳过块注释 / 行注释，去掉可选标记 `?`。
    fn extract_interface_fields(source: &str, name: &str) -> std::collections::BTreeSet<String> {
        let mut fields = std::collections::BTreeSet::new();
        let mut lines = source.lines();
        let needle = format!("export interface {name}");
        let mut in_block_comment = false;
        let mut inside = false;
        let mut depth = 0usize;

        while let Some(line) = lines.next() {
            let trimmed = line.trim();
            if in_block_comment {
                if trimmed.contains("*/") {
                    in_block_comment = false;
                }
                continue;
            }
            if !inside {
                if !trimmed.starts_with(&needle) {
                    continue;
                }
                inside = true;
                depth = trimmed.matches('{').count();
                continue;
            }
            if trimmed.starts_with("/*") {
                if !trimmed.contains("*/") {
                    in_block_comment = true;
                }
                continue;
            }
            if trimmed.starts_with("//") {
                continue;
            }
            depth += trimmed.matches('{').count();
            depth = depth.saturating_sub(trimmed.matches('}').count());
            if depth == 0 {
                break;
            }
            let field = trimmed.split([':', '?']).next().unwrap_or("").trim();
            if !field.is_empty()
                && field
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_')
            {
                fields.insert(field.to_string());
            }
        }
        fields
    }

    fn read_frontend_app_settings_interface() -> String {
        let path =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/types.ts");
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}: {e}", path.display()))
    }

    /// 后端存在但前端 `AppSettings` 里没有的字段（后端自用，不参与前端往返）。
    const BACKEND_ONLY_SETTINGS_FIELDS: &[&str] = &["llmConfig"];

    /// **嵌套**结构的 serde 默认值也必须与 `Default::default()` 一致。
    ///
    /// 顶层那条（`serde_defaults_match_default_impl`）管不到嵌套结构：字段属性写
    /// `#[serde(default = "default_true")]`，而 `impl Default` 里内联 `true`，就是
    /// 同一批默认值的两个来源。这种漂移的后果与 `max_tool_rounds` 80/500 那次一模
    /// 一样 ——「读到缺该键的旧配置」与「新装」拿到不同的默认值，而没有任何测试会红
    /// （实测：把 `default_max_tool_rounds()` 改成 800 后 37 条全绿）。
    /// 现在两处都调同一个函数，这条测试守的是「别再有人把它写回内联字面量」。
    #[test]
    fn nested_serde_defaults_match_their_default_impl() {
        fn assert_same<T>(name: &str)
        where
            T: serde::de::DeserializeOwned + Default + PartialEq + std::fmt::Debug,
        {
            let from_empty: T = serde_json::from_str("{}")
                .unwrap_or_else(|e| panic!("{name} 反序列化 {{}} 失败：{e}"));
            assert_eq!(
                from_empty,
                T::default(),
                "{name}：serde 缺字段默认值与 Default impl 不一致（同一个默认值两个来源）"
            );
        }

        assert_same::<AgentModeSettings>("AgentModeSettings");
        assert_same::<ExperimentalSettings>("ExperimentalSettings");
        assert_same::<NotificationSettings>("NotificationSettings");
        assert_same::<MobileNotificationSettings>("MobileNotificationSettings");
        assert_same::<MobileBackgroundSettings>("MobileBackgroundSettings");
        assert_same::<WorkspaceLayoutSettings>("WorkspaceLayoutSettings");
        assert_same::<TerminalColors>("TerminalColors");
    }

    /// 后端 `AppSettings` 的 serde 默认值必须与 `Default::default()` 一致。
    ///
    /// 两者是**两条独立路径**：`serde_json::from_str("{}")` 走 `#[serde(default = ...)]`
    /// 属性，而新装 / 重置走 `Default::default()`。同一批默认值写两遍，抄错就是
    /// 「新装是 A、读到缺字段的旧配置是 B」。`llm_config` 就这么漂过一次
    /// （serde 侧 `None`／Default 侧 `Some`），后果是全新安装的模型注册表是空的
    /// ——「新装预置一个默认渠道」那条路径直接失效。
    #[test]
    fn serde_defaults_match_default_impl() {
        let from_empty: AppSettings = serde_json::from_str("{}").expect("deserialize {}");
        let explicit = AppSettings::default();
        assert_eq!(
            from_empty, explicit,
            "serde 缺字段默认值与 Default impl 不一致：某个字段有两份默认值"
        );
    }

    /// 前端 `types.ts` 的 `AppSettings` 字段必须都在后端存在。
    ///
    /// 前端写进去、后端不认识的字段会被 serde **静默丢弃**，重启即失效 ——
    /// `privacyMode` / `foldCompletedTurns` 就这么幽灵过：前端有开关、能写进
    /// 配置文件？不能，后端根本没有这个字段。反方向（后端有、前端没暴露）也查，
    /// 否则「后端加了字段但忘了给前端」会一直没人发现。
    #[test]
    fn frontend_settings_fields_must_exist_in_backend() {
        let backend: serde_json::Value =
            serde_json::to_value(AppSettings::default()).expect("序列化 AppSettings");
        let backend_keys: std::collections::BTreeSet<String> = backend
            .as_object()
            .expect("AppSettings 应序列化为 JSON 对象")
            .keys()
            .cloned()
            .collect();

        let source = read_frontend_app_settings_interface();
        let frontend_keys = extract_interface_fields(&source, "AppSettings");
        assert!(
            frontend_keys.len() > 20,
            "只从 types.ts 解析出 {} 个 AppSettings 字段，解析器可能已失效",
            frontend_keys.len()
        );

        let dropped: Vec<&String> = frontend_keys.difference(&backend_keys).collect();
        assert!(
            dropped.is_empty(),
            "前端 AppSettings 存在后端没有的字段，保存时会被静默丢弃：{:?}。\
             要么给后端补上字段，要么从 types.ts 里删掉它。",
            dropped
        );

        let unexposed: Vec<&String> = backend_keys
            .difference(&frontend_keys)
            .filter(|k| !BACKEND_ONLY_SETTINGS_FIELDS.contains(&k.as_str()))
            .collect();
        assert!(
            unexposed.is_empty(),
            "后端 AppSettings 有字段没暴露给前端：{:?}。\
             要么加进 types.ts，要么登记进 BACKEND_ONLY_SETTINGS_FIELDS。",
            unexposed
        );
    }

    // ── 前端默认值 ↔ 后端默认值 ──────────────────────────────────────────

    /// 读前端 settingsStore 源码（那份手写的 DEFAULT 对象在里面）。
    fn read_frontend_settings_store() -> String {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../src/stores/settingsStore.ts");
        std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("读不到 {}: {e}", path.display()))
    }

    /// 去掉 TS 注释（`//` 与块注释）。字符串内部的斜杠不算注释。
    fn strip_ts_comments(source: &str) -> String {
        let chars: Vec<char> = source.chars().collect();
        let mut out = String::with_capacity(source.len());
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            let next = chars.get(i + 1).copied();
            if c == '/' && next == Some('/') {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
                continue;
            }
            if c == '/' && next == Some('*') {
                i += 2;
                while i < chars.len() && !(chars[i] == '*' && chars.get(i + 1) == Some(&'/')) {
                    i += 1;
                }
                i += 2;
                continue;
            }
            if c == '"' || c == '\'' || c == '`' {
                let quote = c;
                out.push(c);
                i += 1;
                while i < chars.len() {
                    if chars[i] == '\\' {
                        out.push(chars[i]);
                        if let Some(n) = chars.get(i + 1) {
                            out.push(*n);
                        }
                        i += 2;
                        continue;
                    }
                    out.push(chars[i]);
                    let done = chars[i] == quote;
                    i += 1;
                    if done {
                        break;
                    }
                }
                continue;
            }
            out.push(c);
            i += 1;
        }
        out
    }

    /// `key: <标量字面量>` → (key, 值)；不是标量（数组 / 对象 / 引用常量 / 展开）则 None。
    fn split_scalar_field(chunk: &str) -> Option<(String, serde_json::Value)> {
        let (key, value) = chunk.split_once(':')?;
        let key = key.trim();
        if key.is_empty() || key.contains("...") {
            return None;
        }
        let value = value.trim().trim_end_matches(',').trim();
        let single = value.strip_prefix('\'').and_then(|v| v.strip_suffix('\''));
        let double = value.strip_prefix('"').and_then(|v| v.strip_suffix('"'));
        let parsed = if let Some(inner) = single.or(double) {
            Some(serde_json::Value::String(unescape_ts(inner)))
        } else if value == "true" {
            Some(serde_json::Value::Bool(true))
        } else if value == "false" {
            Some(serde_json::Value::Bool(false))
        } else if !value.is_empty() && value.chars().all(|c| c.is_ascii_digit() || c == '-') {
            value.parse::<i64>().ok().map(serde_json::Value::from)
        } else {
            None
        };
        parsed.map(|v| (key.to_string(), v))
    }

    fn unescape_ts(s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut chars = s.chars();
        while let Some(c) = chars.next() {
            if c == '\\' {
                if let Some(n) = chars.next() {
                    out.push(n);
                }
            } else {
                out.push(c);
            }
        }
        out
    }

    /// 取 TS 源里 `OBJECT_NAME ... = { ... }` 那个对象**直属**的标量字段。
    ///
    /// 只收数字 / 字符串 / 布尔：数组与对象要么是空集合、要么引用别的常量
    /// （`DEFAULT_TERMINAL_COLORS` / `DEFAULT_WORKSPACE_LAYOUT`），它们不是
    /// 「同一个默认值被抄成两遍」，比不了也不该比。
    fn ts_object_scalars(source: &str, object_name: &str) -> BTreeMap<String, serde_json::Value> {
        let code = strip_ts_comments(source);
        let name_at = code
            .find(object_name)
            .unwrap_or_else(|| panic!("settingsStore.ts 里找不到 {object_name}"));
        let open = name_at
            + code[name_at..]
                .find("= {")
                .unwrap_or_else(|| panic!("{object_name} 后面没有 `= {{`"))
            + 2;

        // 先扫到配对的 '}'（跳过字符串里的花括号），拿到对象体。
        let chars: Vec<char> = code[open..].chars().collect();
        let mut depth = 0usize;
        let mut end = chars.len();
        let mut i = 0;
        while i < chars.len() {
            match chars[i] {
                '"' | '\'' | '`' => {
                    let q = chars[i];
                    i += 1;
                    while i < chars.len() {
                        if chars[i] == '\\' {
                            i += 2;
                            continue;
                        }
                        let done = chars[i] == q;
                        i += 1;
                        if done {
                            break;
                        }
                    }
                    continue;
                }
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i;
                        break;
                    }
                }
                _ => {}
            }
            i += 1;
        }

        // 按顶层逗号切块，逐块解析 `key: value`。
        let mut body: Vec<char> = chars[1..end].iter().copied().collect();
        body.push(',');
        let mut fields = BTreeMap::new();
        let mut chunk = String::new();
        let mut depth = 0usize;
        let mut i = 0;
        while i < body.len() {
            let c = body[i];
            match c {
                '"' | '\'' | '`' => {
                    let q = c;
                    chunk.push(c);
                    i += 1;
                    while i < body.len() {
                        if body[i] == '\\' {
                            chunk.push(body[i]);
                            if let Some(n) = body.get(i + 1) {
                                chunk.push(*n);
                            }
                            i += 2;
                            continue;
                        }
                        chunk.push(body[i]);
                        let done = body[i] == q;
                        i += 1;
                        if done {
                            break;
                        }
                    }
                    continue;
                }
                '{' | '[' | '(' => depth += 1,
                '}' | ']' | ')' => depth = depth.saturating_sub(1),
                ',' if depth == 0 => {
                    if let Some((k, v)) = split_scalar_field(&chunk) {
                        fields.insert(k, v);
                    }
                    chunk.clear();
                    i += 1;
                    continue;
                }
                _ => {}
            }
            chunk.push(c);
            i += 1;
        }
        fields
    }

    /// 把后端默认值序列化成 `字段名 → 标量值`（对象 / 数组字段跳过）。
    fn json_scalar_fields(value: &serde_json::Value) -> BTreeMap<String, serde_json::Value> {
        value
            .as_object()
            .expect("默认值应序列化为 JSON 对象")
            .iter()
            .filter(|(_, v)| v.is_number() || v.is_string() || v.is_boolean())
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// 前端那份手写的默认值必须与后端权威默认值一致。
    ///
    /// 为什么需要：前端**没法**等后端才渲染（首帧就要有值），所以同一批默认值被抄了
    /// 两遍 —— 而后端才是权威。抄错时没有任何提示，表现是「界面显示 80、后端按 500
    /// 跑」，用户一保存就把自己的设置改小了：`max_tool_rounds`(500 vs 80) 与
    /// `font_family`(长字体栈 vs `"monospace"`) 就是这么坏过一次的。
    ///
    /// 口径：只比**两边都有**的**标量**字段。数组 / 对象 / 引用常量的键跳过；前端多
    /// 出来的字段由 `frontend_settings_fields_must_exist_in_backend` 负责。
    #[test]
    fn frontend_default_values_match_backend_defaults() {
        let source = read_frontend_settings_store();

        let cases: Vec<(&str, serde_json::Value)> = vec![
            (
                "DEFAULT_AGENT_MODE_SETTINGS",
                serde_json::to_value(AgentModeSettings::default()).unwrap(),
            ),
            (
                "DEFAULT_EXPERIMENTAL_SETTINGS",
                serde_json::to_value(ExperimentalSettings::default()).unwrap(),
            ),
            (
                "DEFAULT_NOTIFICATION_SETTINGS",
                serde_json::to_value(NotificationSettings::default()).unwrap(),
            ),
            (
                "DEFAULT_MOBILE_NOTIFICATION_SETTINGS",
                serde_json::to_value(MobileNotificationSettings::default()).unwrap(),
            ),
            (
                "DEFAULT_MOBILE_BACKGROUND_SETTINGS",
                serde_json::to_value(MobileBackgroundSettings::default()).unwrap(),
            ),
            (
                "DEFAULT_SETTINGS",
                serde_json::to_value(AppSettings::default()).unwrap(),
            ),
        ];

        let mut compared = 0usize;
        let mut mismatches: Vec<String> = Vec::new();
        for (object_name, backend_default) in &cases {
            let frontend = ts_object_scalars(&source, object_name);
            assert!(
                !frontend.is_empty(),
                "{object_name} 一个标量字段都没解析出来 —— 解析器可能已失效（不许空跑通过）"
            );
            let backend = json_scalar_fields(backend_default);
            for (key, frontend_value) in &frontend {
                let Some(backend_value) = backend.get(key) else {
                    continue; // 前端独有的键：交给字段存在性测试
                };
                compared += 1;
                if frontend_value != backend_value {
                    mismatches.push(format!(
                        "{object_name}.{key}: 前端 {frontend_value} ≠ 后端 {backend_value}"
                    ));
                }
            }
        }

        assert!(
            compared >= 30,
            "只比对了 {compared} 个字段（预期 30+）—— 解析器可能已失效，不许空跑通过"
        );
        assert!(
            mismatches.is_empty(),
            "前端默认值与后端权威默认值不一致（前端抄的那份要跟着后端改）：\n  {}",
            mismatches.join("\n  ")
        );
    }
}
