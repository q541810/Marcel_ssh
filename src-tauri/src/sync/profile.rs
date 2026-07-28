//! sync_profile 管理 + 平台过滤。
//!
//! sync_profile 是用户选择的同步项，per-device 存储。
//! 平台过滤基于 UI 暴露面（软过滤）：手机端硬接收桌面专属项也能存（只是没 UI 改），
//! 不会反序列化失败——因为 AppSettings 在两端结构完全一致。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// 一级分类（用户可勾选的大类）
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncCategory {
    /// SSH 连接（不含密码/密钥）
    Connections,
    /// 快捷命令
    QuickCommands,
    /// 技能
    Skills,
    /// MCP 服务器
    McpServers,
    /// 对话历史（含 plans）
    Conversations,
    /// 终端设置
    TerminalSettings,
    /// 模型服务
    ModelService,
    /// Agent 策略
    AgentPolicy,
    /// 对话显示
    DisplaySettings,
    /// API Key（敏感，默认关）
    Secrets,
}

impl SyncCategory {
    /// 该分类在指定平台是否可用（基于 UI 暴露面，软过滤）。
    ///
    /// 手机端无 MCP UI，MCP 仅桌面同步/展示。
    pub fn is_available_on_platform(&self, platform: Platform) -> bool {
        match self {
            SyncCategory::McpServers => platform == Platform::Desktop,
            _ => true,
        }
    }
}

/// 二级字段 key（扁平化路径）
///
/// 命名规范：
/// - settings 顶层字段：`settings.{field}`
/// - settings 嵌套字段：`settings.{group}.{field}`
/// - 列表项：`connections.{id}` / `quickCommands.{id}` / `skills.{id}` / `mcpServers.{id}`
/// - 对话：`conversations.{id}`（整 conversation 作为一个单元）
/// - 敏感：`secrets.llmApiKey`
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SyncKey(String);

impl SyncKey {
    pub fn new(key: impl Into<String>) -> Self {
        Self(key.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// 从 key 解析所属的一级分类。
    pub fn category(&self) -> Option<SyncCategory> {
        let key = &self.0;
        if key.starts_with("connections.") {
            Some(SyncCategory::Connections)
        } else if key.starts_with("quickCommands.") {
            Some(SyncCategory::QuickCommands)
        } else if key.starts_with("skills.") {
            Some(SyncCategory::Skills)
        } else if key.starts_with("mcpServers.") {
            Some(SyncCategory::McpServers)
        } else if key.starts_with("conversations.") {
            Some(SyncCategory::Conversations)
        } else if key.starts_with("secrets.") {
            Some(SyncCategory::Secrets)
        } else if key.starts_with("settings.") {
            // 二级分类：解析 settings 子字段
            let sub = key.strip_prefix("settings.").unwrap_or("");
            match sub {
                "terminalColors" | "fontSize" | "fontFamily" => {
                    Some(SyncCategory::TerminalSettings)
                }
                "llmConfig.baseUrl"
                | "llmConfig.model"
                | "llmConfig.vision"
                | "llmConfig.maxRetries"
                | "llmConfig.retryDelaySecs"
                | "llmConfig.retryHttpStatuses"
                | "agentModeSettings.compactContext" => Some(SyncCategory::ModelService),
                "commandTimeoutSecs"
                | "agentModeSettings.confirmEachCommand"
                | "agentModeSettings.confirmEditFile"
                | "agentModeSettings.enableModelCommandApproval"
                | "agentModeSettings.modelApprovalModel"
                | "agentModeSettings.modelApprovalPrompt"
                | "agentModeSettings.modelApprovalContextLevel"
                | "agentModeSettings.listMode"
                | "agentModeSettings.commandList"
                | "customProtectedPaths"
                | "agentModeSettings.maxToolRounds"
                | "agentModeSettings.systemPrompt" => Some(SyncCategory::AgentPolicy),
                "hideThinkingDisplay" => Some(SyncCategory::DisplaySettings),
                _ => None,
            }
        } else {
            None
        }
    }

    /// 该 key 在指定平台是否可用（软过滤，基于 UI 暴露面）。
    ///
    /// 桌面专属（手机端无 UI / 无能力）：
    /// - notificationSettings、experimentalSettings、folderUpload…
    /// - 插件相关 settings、llmConfig.providerType
    /// - mcpServers.*（移动端无 MCP）
    pub fn is_available_on_platform(&self, platform: Platform) -> bool {
        if platform == Platform::Desktop {
            return true;
        }

        // 手机端过滤
        let key = &self.0;
        if key.starts_with("mcpServers.") {
            return false;
        }
        if key.starts_with("settings.notificationSettings") {
            return false;
        }
        if key.starts_with("settings.experimentalSettings") {
            return false;
        }
        if key == "settings.folderUploadCompressionLevel" {
            return false;
        }
        if key == "settings.disabledPlugins"
            || key == "settings.authorizedCapabilities"
            || key == "settings.disableAllInjections"
        {
            return false;
        }
        if key == "settings.llmConfig.providerType" {
            return false;
        }

        true
    }
}

impl From<String> for SyncKey {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<&str> for SyncKey {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl std::fmt::Display for SyncKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// 平台标识
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    Desktop,
    Mobile,
}

impl Platform {
    /// 在当前编译目标下检测平台。
    pub fn current() -> Self {
        #[cfg(target_os = "android")]
        {
            Platform::Mobile
        }
        #[cfg(not(target_os = "android"))]
        {
            Platform::Desktop
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Platform::Desktop => "desktop",
            Platform::Mobile => "mobile",
        }
    }
}

/// sync_profile：用户选择的同步项。
///
/// 存储格式：用 HashSet<SyncCategory> 表示开启的一级分类。
/// 二级字段的开关通过 `is_category_enabled` 判断（大类开则子项开）。
/// 例外：`Secrets` 分类默认关，需用户显式开启。
///
/// `excluded_keys`：字段级排除清单（用户在冲突 UI 选"永久跳过"时加入）。
/// 被排除的 key 不会 push 也不会 pull，跨设备生效（因为 SyncProfile 本身同步）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProfile {
    /// 开启的一级分类集合
    pub enabled_categories: HashSet<SyncCategory>,
    /// 字段级排除清单（用户在冲突 UI 选"永久跳过"时加入）
    /// 存储完整 key 字符串（如 "settings.fontSize"）
    #[serde(default)]
    pub excluded_keys: HashSet<String>,
}

impl Default for SyncProfile {
    fn default() -> Self {
        // 默认开启除 Secrets 外的所有分类
        let mut enabled = HashSet::new();
        enabled.insert(SyncCategory::Connections);
        enabled.insert(SyncCategory::QuickCommands);
        enabled.insert(SyncCategory::Skills);
        enabled.insert(SyncCategory::McpServers);
        enabled.insert(SyncCategory::Conversations);
        enabled.insert(SyncCategory::TerminalSettings);
        enabled.insert(SyncCategory::ModelService);
        enabled.insert(SyncCategory::AgentPolicy);
        enabled.insert(SyncCategory::DisplaySettings);
        // Secrets 默认关
        // excluded_keys 默认空（用户在冲突 UI 选"永久跳过"时才加入）
        Self {
            enabled_categories: enabled,
            excluded_keys: HashSet::new(),
        }
    }
}

impl SyncProfile {
    /// 创建空 profile（全部关闭）
    pub fn empty() -> Self {
        Self {
            enabled_categories: HashSet::new(),
            excluded_keys: HashSet::new(),
        }
    }

    /// 检查某一级分类是否开启
    pub fn is_category_enabled(&self, category: &SyncCategory) -> bool {
        self.enabled_categories.contains(category)
    }

    /// 开启/关闭某分类
    pub fn set_category(&mut self, category: SyncCategory, enabled: bool) {
        if enabled {
            self.enabled_categories.insert(category);
        } else {
            self.enabled_categories.remove(&category);
        }
    }

    /// 添加字段级排除项（用户在冲突 UI 选"永久跳过"时调用）
    pub fn add_excluded_key(&mut self, key: impl Into<String>) {
        self.excluded_keys.insert(key.into());
    }

    /// 移除字段级排除项（用户在设置 UI 重新启用某字段时调用）
    pub fn remove_excluded_key(&mut self, key: &str) {
        self.excluded_keys.remove(key);
    }

    /// 判断某 key 是否被永久排除（用户选"永久跳过"）
    pub fn is_excluded(&self, key: &str) -> bool {
        self.excluded_keys.contains(key)
    }

    /// 过滤一组 key：只保留当前 profile 开启且平台支持且未被排除的 key。
    ///
    /// 用于 pull 时过滤服务端返回的变更集。
    pub fn filter_keys<'a>(
        &self,
        keys: impl IntoIterator<Item = &'a SyncKey>,
        platform: Platform,
    ) -> Vec<SyncKey> {
        keys.into_iter()
            .filter(|key| {
                // 1. 平台过滤
                if !key.is_available_on_platform(platform) {
                    return false;
                }
                // 2. 字段级排除
                if self.excluded_keys.contains(key.as_str()) {
                    return false;
                }
                // 3. profile 分类过滤
                match key.category() {
                    Some(cat) => {
                        cat.is_available_on_platform(platform) && self.is_category_enabled(&cat)
                    }
                    None => true, // 未知分类的 key 默认放行（向前兼容）
                }
            })
            .cloned()
            .collect()
    }

    /// 判断某个 key 是否应该被同步（profile + 平台 + 排除项三重过滤）
    pub fn should_sync(&self, key: &SyncKey, platform: Platform) -> bool {
        if !key.is_available_on_platform(platform) {
            return false;
        }
        if self.excluded_keys.contains(key.as_str()) {
            return false;
        }
        match key.category() {
            Some(cat) => cat.is_available_on_platform(platform) && self.is_category_enabled(&cat),
            None => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_profile() {
        let profile = SyncProfile::default();
        assert!(profile.is_category_enabled(&SyncCategory::Connections));
        assert!(profile.is_category_enabled(&SyncCategory::Conversations));
        assert!(!profile.is_category_enabled(&SyncCategory::Secrets));
    }

    #[test]
    fn test_set_category() {
        let mut profile = SyncProfile::empty();
        assert!(!profile.is_category_enabled(&SyncCategory::Connections));

        profile.set_category(SyncCategory::Connections, true);
        assert!(profile.is_category_enabled(&SyncCategory::Connections));

        profile.set_category(SyncCategory::Connections, false);
        assert!(!profile.is_category_enabled(&SyncCategory::Connections));
    }

    #[test]
    fn test_key_category_parsing() {
        let key = SyncKey::new("connections.abc123");
        assert_eq!(key.category(), Some(SyncCategory::Connections));

        let key = SyncKey::new("settings.fontSize");
        assert_eq!(key.category(), Some(SyncCategory::TerminalSettings));

        let key = SyncKey::new("settings.commandTimeoutSecs");
        assert_eq!(key.category(), Some(SyncCategory::AgentPolicy));

        let key = SyncKey::new("secrets.llmApiKey");
        assert_eq!(key.category(), Some(SyncCategory::Secrets));

        let key = SyncKey::new("unknown.key");
        assert_eq!(key.category(), None);
    }

    #[test]
    fn test_platform_filter_mobile() {
        // 桌面专属字段在手机端被过滤
        let key = SyncKey::new("settings.notificationSettings.agentApproval");
        assert!(!key.is_available_on_platform(Platform::Mobile));
        assert!(key.is_available_on_platform(Platform::Desktop));

        let key = SyncKey::new("settings.experimentalSettings.enableWebSearch");
        assert!(!key.is_available_on_platform(Platform::Mobile));

        let key = SyncKey::new("settings.folderUploadCompressionLevel");
        assert!(!key.is_available_on_platform(Platform::Mobile));

        // 通用字段在两端都可用
        let key = SyncKey::new("settings.fontSize");
        assert!(key.is_available_on_platform(Platform::Mobile));
        assert!(key.is_available_on_platform(Platform::Desktop));

        // MCP 仅桌面
        let key = SyncKey::new("mcpServers.abc");
        assert!(!key.is_available_on_platform(Platform::Mobile));
        assert!(key.is_available_on_platform(Platform::Desktop));
        assert!(!SyncCategory::McpServers.is_available_on_platform(Platform::Mobile));
    }

    #[test]
    fn test_should_sync() {
        let profile = SyncProfile::default();
        let platform = Platform::Desktop;

        // 默认 profile 开启的项
        assert!(profile.should_sync(&SyncKey::new("connections.abc"), platform));
        assert!(profile.should_sync(&SyncKey::new("settings.fontSize"), platform));

        // Secrets 默认关
        assert!(!profile.should_sync(&SyncKey::new("secrets.llmApiKey"), platform));

        // 手机端 + 桌面专属字段
        assert!(!profile.should_sync(
            &SyncKey::new("settings.notificationSettings.agentApproval"),
            Platform::Mobile
        ));
    }

    #[test]
    fn test_filter_keys() {
        let profile = SyncProfile::default();
        let keys = vec![
            SyncKey::new("connections.abc"),
            SyncKey::new("settings.fontSize"),
            SyncKey::new("secrets.llmApiKey"), // 默认关，应被过滤
            SyncKey::new("settings.notificationSettings.agentApproval"), // 桌面才可用
        ];

        let filtered = profile.filter_keys(&keys, Platform::Mobile);
        assert_eq!(filtered.len(), 2);
        assert!(filtered.contains(&SyncKey::new("connections.abc")));
        assert!(filtered.contains(&SyncKey::new("settings.fontSize")));
    }

    #[test]
    fn test_platform_current() {
        let platform = Platform::current();
        // 在当前编译目标下应该能正确判断
        #[cfg(target_os = "android")]
        assert_eq!(platform, Platform::Mobile);
        #[cfg(not(target_os = "android"))]
        assert_eq!(platform, Platform::Desktop);
    }

    #[test]
    fn test_excluded_keys_should_sync() {
        let mut profile = SyncProfile::default();
        let platform = Platform::Desktop;

        // 默认 settings.fontSize 应该同步
        assert!(profile.should_sync(&SyncKey::new("settings.fontSize"), platform));

        // 永久跳过后不再同步
        profile.add_excluded_key("settings.fontSize");
        assert!(!profile.should_sync(&SyncKey::new("settings.fontSize"), platform));

        // 其他字段不受影响
        assert!(profile.should_sync(&SyncKey::new("settings.fontFamily"), platform));

        // 移除排除后恢复同步
        profile.remove_excluded_key("settings.fontSize");
        assert!(profile.should_sync(&SyncKey::new("settings.fontSize"), platform));
    }

    #[test]
    fn test_excluded_keys_filter_keys() {
        let mut profile = SyncProfile::default();
        profile.add_excluded_key("connections.abc");

        let keys = vec![
            SyncKey::new("connections.abc"),   // 被排除
            SyncKey::new("connections.def"),   // 正常
            SyncKey::new("settings.fontSize"), // 正常
        ];

        let filtered = profile.filter_keys(&keys, Platform::Desktop);
        assert_eq!(filtered.len(), 2);
        assert!(!filtered.contains(&SyncKey::new("connections.abc")));
        assert!(filtered.contains(&SyncKey::new("connections.def")));
        assert!(filtered.contains(&SyncKey::new("settings.fontSize")));
    }

    #[test]
    fn test_excluded_keys_persistence_roundtrip() {
        // excluded_keys 在 serde 序列化/反序列化时应该保留
        let mut profile = SyncProfile::default();
        profile.add_excluded_key("settings.fontSize");
        profile.add_excluded_key("connections.abc");

        let json = serde_json::to_string(&profile).unwrap();
        let restored: SyncProfile = serde_json::from_str(&json).unwrap();

        assert!(restored.is_excluded("settings.fontSize"));
        assert!(restored.is_excluded("connections.abc"));
        assert!(!restored.is_excluded("settings.fontFamily"));
    }

    #[test]
    fn test_excluded_keys_deserialize_default_missing() {
        // 旧的 profile JSON（没有 excluded_keys 字段）应该能正确反序列化为空集合
        let json = r#"{"enabledCategories":["connections","conversations"]}"#;
        let profile: SyncProfile = serde_json::from_str(json).unwrap();
        assert!(profile.excluded_keys.is_empty());
    }
}
