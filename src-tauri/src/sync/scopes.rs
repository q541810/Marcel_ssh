//! 六个同步源的作用域规则：**哪些字段跨设备同步、哪些只留在本机、哪些按平台分开**。
//!
//! 默认一切 `Shared`——新加的配置字段默认就会同步。例外全部登记在这里，`scope_guard` 测试把
//! 「每个同步源现有的字段 × 它们的作用域」钉成快照（`scope_snapshot.txt`），新字段出现时
//! 测试变红，逼着开发者当场表态：这个字段该不该跨设备同步？
//!
//! 判断标准（新字段该标哪种）：
//! - `Local`：只对这台设备有意义——窗口 / 面板尺寸、本机文件路径、本机的授权与引导进度、
//!   设备绑定的密钥库 id、「上次连接时间」这类每次使用都会变的流水；
//! - `Platform`：桌面与手机各有一份、但同类设备之间应当一致——通知偏好、终端字号 / 字体；
//! - `Shared`：用户理所当然希望「我在哪台设备改了，别的设备都跟着变」。
//!
//! 路径用字段的 **JSON 名**（camelCase / known_hosts 是 snake_case），`*` 匹配任意一段
//! （含 id 段），前缀匹配（写 `connections/*/keyPath` 就覆盖它的整个子树）。

use serde_json::Value;

use super::core::{ItemFilter, Scope, ScopeRules};

/// `settings.json`。
///
/// Local：
/// - `panelHeight` `fileManagerTreeWidth` `fileManagerTreeUserHidden` `workspaceLayout`：窗口与面板布局，
///   每台设备的屏幕不一样；
/// - `fileManagerPath` `fileManagerPaths`：文件管理器记住的目录（旧版遗留，只读兜底）；
/// - `hasCompletedOnboarding`：引导走到哪了是这台设备的事；
/// - `updateMode` `autoUpdate`：更新方式（桌面静默安装 / 手机下载安装器）两端语义不同，各自决定；
/// - `disabledPlugins` `authorizedCapabilities` `disableAllInjections`：插件本体在各设备分别安装，
///   启停与授权、「安全模式」都只对本机的插件有意义；
/// - `llmConfig`：旧版单配置遗留，迁移后恒为空；
/// - `mobileBackgroundSettings`：Android 前台服务保活（耗电、常驻通知），**每台设备自己决定**
///   （代码注释明确写着「设备本地行为」；两部手机不该因为其中一部打开了保活而互相影响）。
///
/// Platform（桌面一份、手机一份）：
/// - `notificationSettings`（桌面通知）`mobileNotificationSettings`（手机通知）；
/// - `fontSize` `fontFamily`：终端字号 / 字体。27 寸显示器与手机屏幕合适的字号相差很大，
///   手机上捏合缩放改的也是这个字段；系统里装的字体两端也不同。
///
/// 其余全部 Shared（外观主题、终端配色、Agent 策略、模型服务渠道、风险规则、受保护路径……）。
pub static SETTINGS_RULES: ScopeRules = ScopeRules {
    patterns: &[
        ("panelHeight", Scope::Local),
        ("fileManagerTreeWidth", Scope::Local),
        ("fileManagerTreeUserHidden", Scope::Local),
        ("workspaceLayout", Scope::Local),
        ("fileManagerPath", Scope::Local),
        ("fileManagerPaths", Scope::Local),
        ("hasCompletedOnboarding", Scope::Local),
        ("updateMode", Scope::Local),
        ("autoUpdate", Scope::Local),
        ("disabledPlugins", Scope::Local),
        ("authorizedCapabilities", Scope::Local),
        ("disableAllInjections", Scope::Local),
        ("llmConfig", Scope::Local),
        ("mobileBackgroundSettings", Scope::Local),
        ("notificationSettings", Scope::Platform),
        ("mobileNotificationSettings", Scope::Platform),
        ("fontSize", Scope::Platform),
        ("fontFamily", Scope::Platform),
    ],
    item_filters: &[],
};

/// MCP 无头模式（`--mcp-server`）为外部调用方建的临时连接的 id 前缀：随进程生灭、刻意不进配置文件，
/// 任何情况下都不该跨设备同步。
pub const TEMP_CONNECTION_PREFIX: &str = "mcp-temp-";

fn connection_filter(element: &Value) -> Option<&'static [&'static str]> {
    match element.get("id").and_then(Value::as_str) {
        Some(id) if id.starts_with(TEMP_CONNECTION_PREFIX) => Some(&[]), // 整条 Local
        _ => None,
    }
}

/// `connections.json`。
///
/// Local：`keyPath` `jumpKeyPath`（本机私钥文件路径）、`keyId` `jumpKeyId`（本机私钥库里的 id，
/// 私钥库由本机主密钥加密，换设备解不开）、`lastConnected`（每次连接都会变的流水，同步它只会制造
/// 无谓的冲突与噪音）；`mcp-temp-` 开头的临时连接整条 Local。其余（地址、端口、用户名、认证方式、
/// 跳板机配置、分组与顺序……）Shared。密码与私钥口令在密钥链里，一期不同步。
pub static CONNECTIONS_RULES: ScopeRules = ScopeRules {
    patterns: &[
        ("connections/*/keyPath", Scope::Local),
        ("connections/*/jumpKeyPath", Scope::Local),
        ("connections/*/keyId", Scope::Local),
        ("connections/*/jumpKeyId", Scope::Local),
        ("connections/*/lastConnected", Scope::Local),
    ],
    item_filters: &[ItemFilter {
        list: "connections",
        keep_only: connection_filter,
    }],
};

/// `quick_commands.json`：全部 Shared（名称、命令内容、间隔、范围与所属连接）。
pub static QUICK_COMMANDS_RULES: ScopeRules = ScopeRules::SHARED_ALL;

fn skill_filter(element: &Value) -> Option<&'static [&'static str]> {
    match element.get("id").and_then(Value::as_str) {
        // 内置 skill 的内容以二进制内嵌版本为准（升级后覆盖），同步它只会让新旧版本的设备
        // 互相覆盖；只有「用户有没有启用它」是用户的选择，值得跨设备一致。
        Some(id) if crate::skills::builtin::is_builtin_skill_id(id) => Some(&["enabled"]),
        _ => None,
    }
}

/// `skills.json`：用户 skill 全同步；内置 skill 只同步 `enabled`。
pub static SKILLS_RULES: ScopeRules = ScopeRules {
    patterns: &[],
    item_filters: &[ItemFilter {
        list: "skills",
        keep_only: skill_filter,
    }],
};

/// `mcp_servers.json`。
///
/// Local：`trusted`（「信任这个服务」是每台设备自己的安全决定）。其余（名称、地址、启用状态、以及
/// 三期起恒为空的 `headers`）Shared。
///
/// **`headers` 不在表里了**：三期起鉴权头存在密钥链（`SecretSlot::McpHeaders`），由机密流同步，
/// 配置文件里只留一个空 map。留着这条 Local 只会误导——真正的鉴权头早就不在这份 JSON 里了。
pub static MCP_SERVERS_RULES: ScopeRules = ScopeRules {
    patterns: &[("servers/*/trusted", Scope::Local)],
    item_filters: &[],
};

/// `known_hosts.json`（字段名是 snake_case，这是这份文件历史上的写法）。
///
/// Local：`version`（文件格式版本）、`first_seen` `last_seen`（本机第一次 / 最近一次见到这台主机的
/// 时间，每次连接都会刷新）。同步的只有「哪台主机 → 什么算法 + 什么指纹」。
///
/// **安全规则**不在这里，在 `sources::KnownHostsAdapter`：远端对本机已有条目改指纹，不应用。
pub static KNOWN_HOSTS_RULES: ScopeRules = ScopeRules {
    patterns: &[
        ("version", Scope::Local),
        ("entries/*/first_seen", Scope::Local),
        ("entries/*/last_seen", Scope::Local),
    ],
    item_filters: &[],
};
