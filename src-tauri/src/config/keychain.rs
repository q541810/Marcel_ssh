use std::borrow::Cow;
use std::sync::{Mutex, OnceLock};

use crate::data::{DataChangeBus, DataSourceId, SyncTier};
use crate::error::AppError;

/// Service name used in the system keychain. All entries for this app are scoped
/// under this service to avoid colliding with other apps.
const SERVICE: &str = "com.marcel.ssh";

// ── Android ──────────────────────────────────────────────────────────────────
// keyring v4 的 `v1` 便利模块只覆盖 macOS/Windows/Linux，Android 不在其中
// （v1.rs set_credential_store 对 Android 无分支，Entry::new 返回 NoDefaultStore）。
// 因此 Android 直接用 android-native-keyring-store（SharedPreferences + Android
// Keystore AES 加密，hardware-backed），通过 keyring-core 的 Entry API 操作。
// ndk-context 由 Tauri Android 在启动时初始化（util.rs 已在用 android_context()）。

#[cfg(target_os = "android")]
mod android_store {
    use std::sync::{Arc, OnceLock};

    use keyring_core::{api::CredentialStoreApi, Entry, Error, Result};

    /// 单例 store，避免每次 Entry::new 都重建 vault 连接。
    fn store() -> Result<&'static Arc<android_native_keyring_store::Store>> {
        static STORE: OnceLock<Result<Arc<android_native_keyring_store::Store>>> = OnceLock::new();
        STORE
            .get_or_init(android_native_keyring_store::Store::new)
            .as_ref()
            .map_err(|e| {
                Error::PlatformFailure(
                    std::io::Error::new(
                        std::io::ErrorKind::Other,
                        format!("Android 密钥存储初始化失败：{e}"),
                    )
                    .into(),
                )
            })
    }

    pub fn entry(service: &str, user: &str) -> Result<Entry> {
        store()?.build(service, user, None)
    }

    /// 把 keyring-core 的 NoEntry 映射为 Ok(None)，其他错误原样冒泡。
    pub fn get_optional_password(entry: &Entry) -> Result<Option<String>> {
        match entry.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// 删除条目，NoEntry 视为成功（与桌面端 delete_password 语义一致）。
    pub fn delete_if_exists(entry: &Entry) -> Result<()> {
        match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(target_os = "android")]
use android_store as store_impl;

// ── Desktop ──────────────────────────────────────────────────────────────────

#[cfg(not(target_os = "android"))]
mod desktop_store {
    use keyring::{Entry, Error, Result};

    pub fn entry(service: &str, user: &str) -> Result<Entry> {
        Entry::new(service, user)
    }

    pub fn get_optional_password(entry: &Entry) -> Result<Option<String>> {
        match entry.get_password() {
            Ok(pw) => Ok(Some(pw)),
            Err(Error::NoEntry) => Ok(None),
            Err(e) => Err(e),
        }
    }

    pub fn delete_if_exists(entry: &Entry) -> Result<()> {
        match entry.delete_credential() {
            Ok(()) | Err(Error::NoEntry) => Ok(()),
            Err(e) => Err(e),
        }
    }
}

#[cfg(not(target_os = "android"))]
use desktop_store as store_impl;

// ── 槽位表 ───────────────────────────────────────────────────────────────────

/// 密钥链里每一条凭据的「身份」：**本应用写进系统密钥链的全部条目的唯一来源。**
///
/// 为什么要一张表：以前每个 Key 各写一组 `get_/save_/delete_` 函数，账号名散在十几处字符串
/// 字面量里，「密钥链里到底存了哪些东西、哪些该跟着设备走」没有一个地方能回答。以后跨设备
/// 同步要按档导出 / 导入密钥链条目，就必须能枚举并分档——所以账号名、分档、说明都收在这个
/// 枚举上，`account()` / `tier()` / `describe()` 的 `match` 都不写 `_ =>`，新增变体不补全就
/// 编译不过。
///
/// **账号名一个字都不能改**：它就是老用户密钥链里条目的名字，改了等于所有人的 Key 凭空消失。
/// `tests` 里的快照表钉着这一点。
///
/// 带参数的变体（渠道 / SSH 连接）的参数是渠道 id / 连接 id，**不是机密**，可以进日志与
/// `Debug`；机密本身（`get` 的返回值）永远不要。
///
/// 读写一律走本模块的 [`get`] / [`set`] / [`delete`] / [`has`]，别再另拼账号名去碰密钥链。
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SecretSlot {
    /// 旧版单配置的 LLM API Key（账号 `llm_api_key`）。
    ///
    /// 多渠道改造后不再写入，也**不删**（兼容旧版回滚）：仍被读取的地方是旧配置迁移
    /// （`llm::registry::migrate_legacy_settings`）与设置页拉模型列表的兜底。
    LegacyLlmApiKey,
    /// 某个模型渠道的 API Key（账号 `llm_channel_{渠道 id}`）。多渠道下每个渠道独立存放。
    LlmChannel(String),
    /// 某个模型渠道的自定义请求头（账号 `llm_channel_headers_{渠道 id}`），值是 JSON 对象。
    ///
    /// 与 `LlmChannel` 分槽：清空 API Key 不该顺手把头也删了。放在密钥链而非普通配置的
    /// 理由和 `McpHeaders` 一样——这些头里经常就是令牌（`x-opencode-session` 之类），
    /// 不能明文躺在 `settings.json` 里跟着同步上云。
    LlmChannelHeaders(String),
    /// Brave / Tavily 网页搜索共用的 Key（账号 `web_search_api_key`）。
    ///
    /// 由用户当前选的搜索提供商轮流占用，所以**不能**借给 DeepSeek / 自定义地址 / Tavily 抓取。
    WebSearchApiKey,
    /// DeepSeek 工具类 Key，搜索与网页获取共用（账号 `deepseek_tools_api_key`）。
    ///
    /// 独立槽位，不并进 `WebSearchApiKey`（会把 Brave 的 Key 发给 DeepSeek），也不复用渠道
    /// Key（渠道 Key 随渠道增删，工具类接口不属于任何渠道）。
    DeepseekToolsApiKey,
    /// 用户自配的「自定义搜索 API」的 Key（账号 `custom_search_api_key`）。
    ///
    /// 地址是用户自己填的任意主机，借别家的 Key 给它就是把凭据发给一个完全不认识的服务。
    CustomSearchApiKey,
    /// 用户自配的「自定义网页获取」服务的 Key（账号 `custom_fetch_api_key`）。
    CustomFetchApiKey,
    /// Tavily Extract（网页获取）的 Key（账号 `tavily_fetch_api_key`）。
    ///
    /// 与 `WebSearchApiKey` 分开：那个槽位可能装着 Brave 的 Key。抓取时优先用这里；留空且
    /// 搜索提供商恰好是 Tavily 才沿用搜索那把（见 `http_get`）。
    TavilyFetchApiKey,
    /// TypeSafe（Jev）命令审批引擎的 Key（账号 `jev_api_key`）。全局一份，不分渠道。
    JevApiKey,
    /// 某个 MCP 服务器配置里的鉴权头（账号 `mcp_headers:{服务器 id}`），值是 headers 的 JSON。
    ///
    /// 以前 headers 明文躺在 `mcp_servers.json` 里（可能含 Bearer 令牌）。三期改成存密钥链：
    /// 这样它既不会跟着普通配置明文上云，又能经机密流按设备同步。
    McpHeaders(String),
    /// 某个 SSH 连接的登录密码（账号 = 连接 id 本身，没有前缀）。
    SshPassword(String),
    /// 某个 SSH 连接的私钥口令（账号 `pk:{连接 id}`）。
    SshKeyPassphrase(String),
    /// 某个连接的跳板机登录密码（账号 `jump:{连接 id}`）。
    JumpPassword(String),
    /// 某个连接的跳板机私钥口令（账号 `jump:pk:{连接 id}`）。
    JumpKeyPassphrase(String),
    /// 私钥库的主密钥（账号 `keys:master`）：32 字节 AES 密钥的 base64，用来加解密
    /// `keys/` 目录里的私钥密文（见 `ssh::key_store`）。
    ///
    /// **设备绑定**：它只在生成它的这台设备上有效，密文换设备解不开，所以是 `Local`，
    /// 以后的机密同步绝不能把它导出去（导过去也没用，反而多一份泄露面）。
    KeyStoreMaster,
    /// 跨设备同步的数据密钥 DK（账号 `sync2_data_key`，32 字节的 base64）。
    ///
    /// 加密所有同步文件的密钥。**设备本机保存，不进任何同步**：它由恢复密钥在每台新设备上
    /// 重新解出，没有必要、也不应该再多一条泄露途径。
    SyncDataKey,
    /// 跨设备同步的恢复密钥（账号 `sync2_recovery_key`，32 位规范形式）。
    ///
    /// 存在本机是为了让用户随时能在「同步」页重新查看它、并给新设备生成同步码。
    SyncRecoveryKey,
    /// 同步存储的密码（账号 `sync2_storage_password`）：WebDAV 的应用密码。SFTP 存储复用那台
    /// 服务器连接自己的密码，不用这个槽位。
    SyncStoragePassword,
    /// 旧版同步遗留（账号 `sync_key`）：启动时清理，不再读取。
    LegacySyncKey,
    /// 旧版同步遗留（账号 `sync_device_api_key`）：启动时清理，不再读取。
    LegacySyncDeviceApiKey,
    /// 旧版同步遗留（账号 `sync_device_id`）：启动时清理，不再读取。
    LegacySyncDeviceId,
    /// 旧版同步遗留（账号 `sync_server_url`）：启动时清理，不再读取。
    LegacySyncServerUrl,
}

impl SecretSlot {
    /// 系统密钥链里的账号名（`SERVICE` 下的 user 字段）。**逐字不可改**，见类型文档。
    pub fn account(&self) -> Cow<'static, str> {
        match self {
            SecretSlot::LegacyLlmApiKey => Cow::Borrowed("llm_api_key"),
            SecretSlot::LlmChannel(id) => Cow::Owned(format!("llm_channel_{}", id)),
            SecretSlot::LlmChannelHeaders(id) => {
                Cow::Owned(format!("llm_channel_headers_{}", id))
            }
            SecretSlot::WebSearchApiKey => Cow::Borrowed("web_search_api_key"),
            SecretSlot::DeepseekToolsApiKey => Cow::Borrowed("deepseek_tools_api_key"),
            SecretSlot::CustomSearchApiKey => Cow::Borrowed("custom_search_api_key"),
            SecretSlot::CustomFetchApiKey => Cow::Borrowed("custom_fetch_api_key"),
            SecretSlot::TavilyFetchApiKey => Cow::Borrowed("tavily_fetch_api_key"),
            SecretSlot::JevApiKey => Cow::Borrowed("jev_api_key"),
            SecretSlot::McpHeaders(id) => Cow::Owned(format!("mcp_headers:{}", id)),
            SecretSlot::SshPassword(id) => Cow::Owned(id.clone()),
            SecretSlot::SshKeyPassphrase(id) => Cow::Owned(format!("pk:{}", id)),
            SecretSlot::JumpPassword(id) => Cow::Owned(format!("jump:{}", id)),
            SecretSlot::JumpKeyPassphrase(id) => Cow::Owned(format!("jump:pk:{}", id)),
            SecretSlot::KeyStoreMaster => Cow::Borrowed("keys:master"),
            SecretSlot::SyncDataKey => Cow::Borrowed("sync2_data_key"),
            SecretSlot::SyncRecoveryKey => Cow::Borrowed("sync2_recovery_key"),
            SecretSlot::SyncStoragePassword => Cow::Borrowed("sync2_storage_password"),
            SecretSlot::LegacySyncKey => Cow::Borrowed("sync_key"),
            SecretSlot::LegacySyncDeviceApiKey => Cow::Borrowed("sync_device_api_key"),
            SecretSlot::LegacySyncDeviceId => Cow::Borrowed("sync_device_id"),
            SecretSlot::LegacySyncServerUrl => Cow::Borrowed("sync_server_url"),
        }
    }

    /// 同步分档：用户的各种 Key / 密码是 [`SyncTier::Secret`]（机密同步的单独开关管它）；
    /// 设备绑定的主密钥是 [`SyncTier::Local`]（永不同步）。
    pub fn tier(&self) -> SyncTier {
        match self {
            SecretSlot::LegacyLlmApiKey
            | SecretSlot::LlmChannel(_)
            | SecretSlot::LlmChannelHeaders(_)
            | SecretSlot::WebSearchApiKey
            | SecretSlot::DeepseekToolsApiKey
            | SecretSlot::CustomSearchApiKey
            | SecretSlot::CustomFetchApiKey
            | SecretSlot::TavilyFetchApiKey
            | SecretSlot::JevApiKey
            | SecretSlot::McpHeaders(_)
            | SecretSlot::SshPassword(_)
            | SecretSlot::SshKeyPassphrase(_)
            | SecretSlot::JumpPassword(_)
            | SecretSlot::JumpKeyPassphrase(_) => SyncTier::Secret,
            // 同步自己的密钥与旧版遗留：都只对这台设备有意义，绝不进机密同步。
            SecretSlot::KeyStoreMaster
            | SecretSlot::SyncDataKey
            | SecretSlot::SyncRecoveryKey
            | SecretSlot::SyncStoragePassword
            | SecretSlot::LegacySyncKey
            | SecretSlot::LegacySyncDeviceApiKey
            | SecretSlot::LegacySyncDeviceId
            | SecretSlot::LegacySyncServerUrl => SyncTier::Local,
        }
    }

    /// 一句话中文名（不含参数）。同时拼进密钥链读写失败的错误信息（「保存{名}到密钥链失败」），
    /// 所以保持短、能直接接在动词后面。
    pub fn describe(&self) -> &'static str {
        match self {
            SecretSlot::LegacyLlmApiKey => "旧版 LLM API Key",
            SecretSlot::LlmChannel(_) => "渠道 API Key",
            SecretSlot::LlmChannelHeaders(_) => "渠道自定义请求头",
            SecretSlot::WebSearchApiKey => "搜索 API Key",
            SecretSlot::DeepseekToolsApiKey => "DeepSeek API Key",
            SecretSlot::CustomSearchApiKey => "自定义搜索 API Key",
            SecretSlot::CustomFetchApiKey => "自定义抓取 API Key",
            SecretSlot::TavilyFetchApiKey => "Tavily 抓取 API Key",
            SecretSlot::JevApiKey => "TypeSafe API Key",
            SecretSlot::McpHeaders(_) => "MCP 鉴权头",
            SecretSlot::SshPassword(_) => "连接密码",
            SecretSlot::SshKeyPassphrase(_) => "私钥口令",
            SecretSlot::JumpPassword(_) => "跳板机密码",
            SecretSlot::JumpKeyPassphrase(_) => "跳板机私钥口令",
            SecretSlot::KeyStoreMaster => "私钥库主密钥",
            SecretSlot::SyncDataKey => "同步数据密钥",
            SecretSlot::SyncRecoveryKey => "同步恢复密钥",
            SecretSlot::SyncStoragePassword => "同步存储密码",
            SecretSlot::LegacySyncKey => "旧版同步密钥",
            SecretSlot::LegacySyncDeviceApiKey => "旧版同步设备密钥",
            SecretSlot::LegacySyncDeviceId => "旧版同步设备标识",
            SecretSlot::LegacySyncServerUrl => "旧版同步服务器地址",
        }
    }

    /// 一个已保存连接名下的全部槽位（登录密码 / 私钥口令 / 跳板机密码 / 跳板机私钥口令）。
    ///
    /// 删连接要把它们一并清掉，以后同步按连接导出凭据也走这里——**新增「跟着连接走」的
    /// 变体必须加进来**，否则删连接会在密钥链里留下孤儿条目。
    pub fn for_connection(connection_id: &str) -> [SecretSlot; 4] {
        [
            SecretSlot::SshPassword(connection_id.to_string()),
            SecretSlot::SshKeyPassphrase(connection_id.to_string()),
            SecretSlot::JumpPassword(connection_id.to_string()),
            SecretSlot::JumpKeyPassphrase(connection_id.to_string()),
        ]
    }

    /// 一个 MCP 服务器名下要清理的槽位（删服务器时调用）。
    pub fn for_mcp_server(server_id: &str) -> [SecretSlot; 1] {
        [SecretSlot::McpHeaders(server_id.to_string())]
    }

    /// 全部**不带参数**的槽位（枚举用：同步引擎按档导出、守护测试查重）。
    ///
    /// 带参数的槽位（渠道 / 连接）由各自的 id 现拼，没法在这里列出；它们的 id 来自
    /// 设置里的渠道清单与已保存的连接。**新增不带参数的变体必须同步加进这里**
    /// （`tests::fixed_slots_cover_every_unit_variant` 会提醒）。
    pub fn fixed_slots() -> Vec<SecretSlot> {
        vec![
            SecretSlot::LegacyLlmApiKey,
            SecretSlot::WebSearchApiKey,
            SecretSlot::DeepseekToolsApiKey,
            SecretSlot::CustomSearchApiKey,
            SecretSlot::CustomFetchApiKey,
            SecretSlot::TavilyFetchApiKey,
            SecretSlot::JevApiKey,
            SecretSlot::KeyStoreMaster,
            SecretSlot::SyncDataKey,
            SecretSlot::SyncRecoveryKey,
            SecretSlot::SyncStoragePassword,
            SecretSlot::LegacySyncKey,
            SecretSlot::LegacySyncDeviceApiKey,
            SecretSlot::LegacySyncDeviceId,
            SecretSlot::LegacySyncServerUrl,
        ]
    }

    /// 当前版本同步功能自己用的槽位（停止同步时整体清掉）。
    pub fn sync_slots() -> [SecretSlot; 3] {
        [
            SecretSlot::SyncDataKey,
            SecretSlot::SyncRecoveryKey,
            SecretSlot::SyncStoragePassword,
        ]
    }

    /// 旧版同步遗留的槽位：启动时清理（见 `sync::init` 的残留清理），之后再没有读者。
    pub fn legacy_sync_slots() -> [SecretSlot; 4] {
        [
            SecretSlot::LegacySyncKey,
            SecretSlot::LegacySyncDeviceApiKey,
            SecretSlot::LegacySyncDeviceId,
            SecretSlot::LegacySyncServerUrl,
        ]
    }

    /// 按账号名反查槽位：机密流落地远端 op 时只有 `account()` 字符串，必须能还原成槽位
    /// 才知道要不要写本机密钥链。
    ///
    /// 带参数的变体需要知道本机有哪些连接 / 渠道（它们的 id 在配置文件里，不在密钥链里），
    /// 所以由调用方现取一份 [`SecretSlotCatalog`] 传进来。**认不出来就返回 `None`**：
    /// 那可能是更新版本加的槽位，也可能属于本机已经删掉的连接 / 渠道——两种都只能
    /// 存进加密镜像等以后认识，绝不能凭字符串硬造一个槽位往密钥链里写。
    pub fn from_account(account: &str, catalog: &SecretSlotCatalog) -> Option<SecretSlot> {
        // 固定槽位（账号名本身没有前缀，必须最先精确匹配）
        if let Some(slot) = Self::fixed_slots()
            .into_iter()
            .find(|s| s.account() == account)
        {
            return Some(slot);
        }
        // 带前缀的长前缀在前：`jump:pk:` ⊃ `pk:`，`jump:` 又要排在 `pk:` 之前判断不到的错误
        if let Some(id) = account.strip_prefix("jump:pk:") {
            return catalog
                .connection_ids
                .iter()
                .any(|c| c == id)
                .then(|| SecretSlot::JumpKeyPassphrase(id.to_string()));
        }
        if let Some(id) = account.strip_prefix("jump:") {
            return catalog
                .connection_ids
                .iter()
                .any(|c| c == id)
                .then(|| SecretSlot::JumpPassword(id.to_string()));
        }
        if let Some(id) = account.strip_prefix("pk:") {
            return catalog
                .connection_ids
                .iter()
                .any(|c| c == id)
                .then(|| SecretSlot::SshKeyPassphrase(id.to_string()));
        }
        if let Some(id) = account.strip_prefix("mcp_headers:") {
            return catalog
                .mcp_ids
                .iter()
                .any(|m| m == id)
                .then(|| SecretSlot::McpHeaders(id.to_string()));
        }
        // 长前缀在前：`llm_channel_headers_{id}` ⊃ `llm_channel_{id}`
        if let Some(id) = account.strip_prefix("llm_channel_headers_") {
            return catalog
                .channel_ids
                .iter()
                .any(|c| c == id)
                .then(|| SecretSlot::LlmChannelHeaders(id.to_string()));
        }
        if let Some(id) = account.strip_prefix("llm_channel_") {
            return catalog
                .channel_ids
                .iter()
                .any(|c| c == id)
                .then(|| SecretSlot::LlmChannel(id.to_string()));
        }
        // 连接密码的账号名就是连接 id 本身（没有前缀），只能靠「本机确实有这条连接」认
        if catalog.connection_ids.iter().any(|c| c == account) {
            return Some(SecretSlot::SshPassword(account.to_string()));
        }
        None
    }

    /// 本机**可枚举**的全部槽位（机密流全量比对 / 规模估算用）。
    ///
    /// = 固定槽位 ∪ 每条连接的四个槽位 ∪ 每个渠道的 Key ∪ 每个 MCP 服务器的鉴权头。
    /// **顺序稳定**（连接 / 渠道 / 服务器都按传入顺序），便于测试与展示。
    pub fn enumerable_slots(catalog: &SecretSlotCatalog) -> Vec<SecretSlot> {
        let mut out = Self::fixed_slots();
        for id in &catalog.connection_ids {
            out.extend(Self::for_connection(id));
        }
        for id in &catalog.channel_ids {
            out.push(SecretSlot::LlmChannel(id.clone()));
            out.push(SecretSlot::LlmChannelHeaders(id.clone()));
        }
        for id in &catalog.mcp_ids {
            out.push(SecretSlot::McpHeaders(id.clone()));
        }
        out
    }
}

/// 反查槽位需要的「本机有哪些带参数的槽位」。
///
/// 全部来自本机配置（`connections.json` / `settings.json` 的渠道列表 / `mcp_servers.json`），
/// 由调用方现取。**不含任何机密**：连接 / 渠道 / 服务器的 id 本来就明文躺在配置文件里。
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SecretSlotCatalog {
    pub connection_ids: Vec<String>,
    pub channel_ids: Vec<String>,
    /// MCP 服务器 id（`SecretSlot::McpHeaders` 用）。
    pub mcp_ids: Vec<String>,
}

impl SecretSlotCatalog {
    pub fn is_empty(&self) -> bool {
        self.connection_ids.is_empty() && self.channel_ids.is_empty() && self.mcp_ids.is_empty()
    }
}

// ── 变更广播与落地抑制 ───────────────────────────────────────────────────────
//
// 密钥链本身没有变更通知。机密流要捕获「用户改了哪个 Key」，只能靠我们在**写入口**广播；
// 同时落地远端机密时又会走同一个 `set/delete`，那一次绝不能再被捕获成一条新 op 发出去
// （两台设备会互相把对方的删除又发回去，形成 ping-pong）。所以：
//
// - 广播：`set/delete` 成功后，若槽位是 `SyncTier::Secret` 且当前不在抑制深度里，发一条
//   `DataSourceId::Secrets`。只带「机密变了」，不带是哪个槽位、更不带值——订阅方自己
//   做全量比对（捕获的主要机制，广播只是让捕获更及时）。
// - 抑制：`CaptureSuppression` 是 RAII 的深度计数（落地期间可能嵌套调用），计数 > 0 时
//   照常写密钥链但**不广播**。
// - 进程级总线用 `OnceLock` 注册一次：[`install_change_bus`]。理应由 `lib.rs` 在构造
//   `DataChangeBus` 之后立刻调用；测试里各设备用各自的临时总线，所以注册口允许被覆盖
//   （`#[cfg(test)]` 下用线程局部的替换，见 `tests`）。

static CHANGE_BUS: OnceLock<Mutex<Option<DataChangeBus>>> = OnceLock::new();

fn bus_cell() -> &'static Mutex<Option<DataChangeBus>> {
    CHANGE_BUS.get_or_init(|| Mutex::new(None))
}

/// 注册进程级变更总线（`lib.rs` 构造 `DataChangeBus` 之后调用一次）。
///
/// 重复调用会替换成新的总线：应用里只调一次，但测试要按设备换总线，重复注册比
/// 「第一次赢、后面静默失效」更容易排错。
pub fn install_change_bus(bus: DataChangeBus) {
    *bus_cell().lock().unwrap() = Some(bus);
}

fn publish_secret_change() {
    let bus = bus_cell().lock().unwrap().clone();
    if let Some(bus) = bus {
        bus.publish(DataSourceId::Secrets);
    }
}

/// 抑制深度（嵌套安全的 RAII）。
///
/// 用 `Mutex<usize>` 而不是 bool：落地流程里可能存在「写一个 Key 顺手触发一次迁移」
/// 这种嵌套，内层先 Drop 不能把外层的抑制提前解除。
static SUPPRESS_DEPTH: Mutex<usize> = Mutex::new(0);

/// 落地期间的捕获抑制。Drop 时把深度减一。
///
/// **只影响广播**，不影响真正的写入：抑制期间 `set/delete` 照常落密钥链，只是不回
/// `DataChangeBus`。测试里用 [`suppress_depth`] 观察深度（不碰真实密钥链）。
pub struct CaptureSuppression(());

impl CaptureSuppression {
    pub fn new() -> Self {
        *SUPPRESS_DEPTH.lock().unwrap() += 1;
        Self(())
    }
}

impl Default for CaptureSuppression {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for CaptureSuppression {
    fn drop(&mut self) {
        let mut depth = SUPPRESS_DEPTH.lock().unwrap();
        *depth = depth.saturating_sub(1);
    }
}

/// 当前抑制深度（测试 / 断言用）。
pub fn suppress_depth() -> usize {
    *SUPPRESS_DEPTH.lock().unwrap()
}

/// 写成功之后决定要不要广播：抑制中或非 Secret 档都不发。
///
/// 拆成纯函数（只读全局深度）是为了能直接单测「抑制 / 分档」两个条件，而不必碰真实密钥链
/// ——以前出过单元测试误删本机真实条目的事故，这里的测试永远不调 `set/delete`。
fn should_broadcast(slot: &SecretSlot, suppress_depth: usize) -> bool {
    suppress_depth == 0 && slot.tier() == SyncTier::Secret
}

fn notify_if_secret(slot: &SecretSlot) {
    if should_broadcast(slot, suppress_depth()) {
        publish_secret_change();
    }
}

// ── 读写 ─────────────────────────────────────────────────────────────────────
//
// 平台分流（桌面 keyring / Android）全在上面的 `store_impl`，这里只管「槽位 → 账号名」。
// 错误信息只带槽位的中文名与底层错误，**绝不带机密本身**。

/// 把机密写进槽位（已有则覆盖）。
pub fn set(slot: &SecretSlot, secret: &str) -> Result<(), AppError> {
    let entry = store_impl::entry(SERVICE, &slot.account())
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    entry
        .set_password(secret)
        .map_err(|e| AppError::Config(format!("保存{}到密钥链失败：{}", slot.describe(), e)))?;
    // 写成功之后才广播：写失败时密钥链没变，订阅方不该被叫醒。
    notify_if_secret(slot);
    Ok(())
}

/// 读槽位里的机密；没存过返回 `Ok(None)`。
pub fn get(slot: &SecretSlot) -> Result<Option<String>, AppError> {
    let entry = store_impl::entry(SERVICE, &slot.account())
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    store_impl::get_optional_password(&entry)
        .map_err(|e| AppError::Config(format!("读取{}失败：{}", slot.describe(), e)))
}

/// 删除槽位里的机密；本来就没有视为成功。
pub fn delete(slot: &SecretSlot) -> Result<(), AppError> {
    let entry = store_impl::entry(SERVICE, &slot.account())
        .map_err(|e| AppError::Config(format!("密钥链初始化失败：{}", e)))?;
    store_impl::delete_if_exists(&entry)
        .map_err(|e| AppError::Config(format!("删除{}失败：{}", slot.describe(), e)))?;
    // 本来就没有时也广播一次：多发一条「机密变了」只会换来一次空的全量比对（无副作用），
    // 而漏发会让一次真实删除等下一轮才被发现——两边代价不对称，选保守的这边。
    notify_if_secret(slot);
    Ok(())
}

/// 槽位里有没有机密（只回答有无，不把值交给调用方）。
///
/// 读密钥链出错会原样返回 `Err`——「有没有」和「读不读得了」是两件事：
/// 要把出错当作「没有」的地方（设置页 / 启动快照的 `hasXxx` 标记）自己 `unwrap_or(false)`，
/// 要把错误弹给用户的地方（`config_has_password` 等命令）直接 `?`。
pub fn has(slot: &SecretSlot) -> Result<bool, AppError> {
    get(slot).map(|secret| secret.is_some())
}

/// 前端契约里 `hasXxx` 标记所对应的固定槽位是否有值（字段名与语义不变，见
/// `SettingsResponse` / `AppBootstrapData`）。
///
/// 一次成组的同步系统调用（每个槽位一次密钥链读取）：异步上下文里最好放进
/// `spawn_blocking`。读失败一律按「没有」算——与改造前 `.ok().flatten().is_some()` 一致。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct FeatureKeyFlags {
    /// 旧版单配置 Key 是否还在（`SecretSlot::LegacyLlmApiKey`）。
    pub legacy_llm_api_key: bool,
    pub web_search_api_key: bool,
    pub deepseek_tools_api_key: bool,
    pub custom_search_api_key: bool,
    pub custom_fetch_api_key: bool,
    pub tavily_fetch_api_key: bool,
    pub jev_api_key: bool,
}

impl FeatureKeyFlags {
    pub fn probe() -> Self {
        let present = |slot: SecretSlot| has(&slot).unwrap_or(false);
        FeatureKeyFlags {
            legacy_llm_api_key: present(SecretSlot::LegacyLlmApiKey),
            web_search_api_key: present(SecretSlot::WebSearchApiKey),
            deepseek_tools_api_key: present(SecretSlot::DeepseekToolsApiKey),
            custom_search_api_key: present(SecretSlot::CustomSearchApiKey),
            custom_fetch_api_key: present(SecretSlot::CustomFetchApiKey),
            tavily_fetch_api_key: present(SecretSlot::TavilyFetchApiKey),
            jev_api_key: present(SecretSlot::JevApiKey),
        }
    }
}

// 这里的测试**只测纯函数**（账号名 / 分档 / 唯一性），绝不调用 `get/set/delete/has`：
// 以前出过单元测试误删本机系统密钥链里真实条目的事故。
#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    /// 每个变体的样本：不带参数的取 `fixed_slots()`，带参数的各给一个。
    /// 新增变体后上面 `account()` 等 `match` 先编译不过，补完回到这里再补样本与快照。
    fn all_samples() -> Vec<SecretSlot> {
        let mut v = SecretSlot::fixed_slots();
        v.push(SecretSlot::LlmChannel("c1".into()));
        v.push(SecretSlot::LlmChannelHeaders("c1".into()));
        v.push(SecretSlot::SshPassword("c1".into()));
        v.push(SecretSlot::SshKeyPassphrase("c1".into()));
        v.push(SecretSlot::JumpPassword("c1".into()));
        v.push(SecretSlot::JumpKeyPassphrase("c1".into()));
        v.push(SecretSlot::McpHeaders("s1".into()));
        v
    }

    /// 改造前的账号名快照。**这张表是老用户数据的护栏**：要让它变红的改动，
    /// 等于让已有用户的 Key / 密码全部找不到。
    #[test]
    fn account_names_match_pre_slot_table_snapshot() {
        // 全部写死成字面量（不用 format! 复刻实现），这样改了实现里的格式串这里必红
        let snapshot: Vec<(SecretSlot, &str)> = vec![
            (SecretSlot::LegacyLlmApiKey, "llm_api_key"),
            (SecretSlot::LlmChannel("c1".into()), "llm_channel_c1"),
            (
                SecretSlot::LlmChannelHeaders("c1".into()),
                "llm_channel_headers_c1",
            ),
            (SecretSlot::WebSearchApiKey, "web_search_api_key"),
            (SecretSlot::DeepseekToolsApiKey, "deepseek_tools_api_key"),
            (SecretSlot::CustomSearchApiKey, "custom_search_api_key"),
            (SecretSlot::CustomFetchApiKey, "custom_fetch_api_key"),
            (SecretSlot::TavilyFetchApiKey, "tavily_fetch_api_key"),
            (SecretSlot::JevApiKey, "jev_api_key"),
            (SecretSlot::McpHeaders("s1".into()), "mcp_headers:s1"),
            // SSH 连接密码：账号就是连接 id 本身，没有前缀
            (SecretSlot::SshPassword("c1".into()), "c1"),
            (SecretSlot::SshKeyPassphrase("c1".into()), "pk:c1"),
            (SecretSlot::JumpPassword("c1".into()), "jump:c1"),
            (SecretSlot::JumpKeyPassphrase("c1".into()), "jump:pk:c1"),
            (SecretSlot::KeyStoreMaster, "keys:master"),
            (SecretSlot::SyncDataKey, "sync2_data_key"),
            (SecretSlot::SyncRecoveryKey, "sync2_recovery_key"),
            (SecretSlot::SyncStoragePassword, "sync2_storage_password"),
            (SecretSlot::LegacySyncKey, "sync_key"),
            (SecretSlot::LegacySyncDeviceApiKey, "sync_device_api_key"),
            (SecretSlot::LegacySyncDeviceId, "sync_device_id"),
            (SecretSlot::LegacySyncServerUrl, "sync_server_url"),
        ];
        for (slot, expected) in &snapshot {
            assert_eq!(slot.account(), *expected, "槽位 {:?} 的账号名变了", slot);
        }
        // 真实 id（UUID）下格式也一样：前缀 / 拼接位置不因 id 内容而变
        let uuid = "7b1f0c9e-3a52-4d6e-9a41-2c8d5e0f6a13";
        assert_eq!(
            SecretSlot::LlmChannel(uuid.into()).account(),
            "llm_channel_7b1f0c9e-3a52-4d6e-9a41-2c8d5e0f6a13"
        );
        assert_eq!(SecretSlot::SshPassword(uuid.into()).account(), uuid);
        assert_eq!(
            SecretSlot::JumpKeyPassphrase(uuid.into()).account(),
            "jump:pk:7b1f0c9e-3a52-4d6e-9a41-2c8d5e0f6a13"
        );
        // 快照表本身要覆盖每个变体：样本里有而快照里没有就是漏钉
        assert_eq!(snapshot.len(), all_samples().len());
    }

    #[test]
    fn fixed_slot_accounts_are_unique() {
        let fixed = SecretSlot::fixed_slots();
        let accounts: HashSet<_> = fixed.iter().map(|s| s.account().into_owned()).collect();
        assert_eq!(accounts.len(), fixed.len(), "固定槽位的账号名有重复");
    }

    #[test]
    fn parameterized_slots_do_not_collide_for_the_same_id() {
        // 同一个 id 下的四种连接 / 渠道槽位，账号名必须各不相同
        let samples = all_samples();
        let accounts: HashSet<_> = samples.iter().map(|s| s.account().into_owned()).collect();
        assert_eq!(
            accounts.len(),
            samples.len(),
            "同 id 下不同槽位的账号名撞了"
        );
    }

    #[test]
    fn for_connection_lists_every_connection_bound_slot() {
        let slots = SecretSlot::for_connection("c1");
        // 密码 / 私钥口令 / 跳板机密码 / 跳板机私钥口令，账号名各不相同，且都在样本里
        let accounts: HashSet<_> = slots.iter().map(|s| s.account().into_owned()).collect();
        assert_eq!(accounts.len(), slots.len());
        let samples = all_samples();
        for slot in &slots {
            assert!(samples.contains(slot), "{:?} 不在样本表里", slot);
        }
        // 样本里「跟着连接走」的变体（SshPassword / SshKeyPassphrase / Jump*）一个不少
        let connection_bound = samples
            .iter()
            .filter(|s| {
                matches!(
                    s,
                    SecretSlot::SshPassword(_)
                        | SecretSlot::SshKeyPassphrase(_)
                        | SecretSlot::JumpPassword(_)
                        | SecretSlot::JumpKeyPassphrase(_)
                )
            })
            .count();
        assert_eq!(connection_bound, slots.len());
    }

    #[test]
    fn key_store_master_is_device_bound_local() {
        assert_eq!(SecretSlot::KeyStoreMaster.tier(), SyncTier::Local);
        assert_eq!(SecretSlot::KeyStoreMaster.account(), "keys:master");
    }

    #[test]
    fn every_other_slot_is_secret_tier() {
        for slot in all_samples() {
            let local = matches!(
                slot,
                SecretSlot::KeyStoreMaster
                    | SecretSlot::SyncDataKey
                    | SecretSlot::SyncRecoveryKey
                    | SecretSlot::SyncStoragePassword
                    | SecretSlot::LegacySyncKey
                    | SecretSlot::LegacySyncDeviceApiKey
                    | SecretSlot::LegacySyncDeviceId
                    | SecretSlot::LegacySyncServerUrl
            );
            if local {
                assert_eq!(slot.tier(), SyncTier::Local, "{:?} 应为 Local 档", slot);
            } else {
                assert_eq!(slot.tier(), SyncTier::Secret, "{:?} 应为 Secret 档", slot);
            }
        }
    }

    /// 同步自己的 / 旧版遗留的槽位清单与账号名（旧版账号名是历史遗留，清理时必须逐字对上）。
    #[test]
    fn sync_slot_groups_list_the_right_accounts() {
        let accounts = |slots: &[SecretSlot]| -> Vec<String> {
            slots.iter().map(|s| s.account().into_owned()).collect()
        };
        assert_eq!(
            accounts(&SecretSlot::sync_slots()),
            [
                "sync2_data_key",
                "sync2_recovery_key",
                "sync2_storage_password"
            ]
        );
        assert_eq!(
            accounts(&SecretSlot::legacy_sync_slots()),
            [
                "sync_key",
                "sync_device_api_key",
                "sync_device_id",
                "sync_server_url"
            ]
        );
    }

    #[test]
    fn describe_is_non_empty_and_parameter_free() {
        for slot in all_samples() {
            let text = slot.describe();
            assert!(!text.trim().is_empty(), "{:?} 缺少说明", slot);
            // 说明会进错误信息：不能带参数（连接 id / 渠道 id），更不能带机密
            assert!(!text.contains("c1"), "{:?} 的说明不应含参数", slot);
        }
    }

    /// 穷举 `match`：新增变体时这里先编译不过，逼着人决定它属于「固定」还是「带参数」，
    /// 并确认固定的那类已进 `fixed_slots()`。
    #[test]
    fn fixed_slots_cover_every_unit_variant() {
        let fixed = SecretSlot::fixed_slots();
        for slot in all_samples() {
            let is_unit = match &slot {
                SecretSlot::LegacyLlmApiKey
                | SecretSlot::WebSearchApiKey
                | SecretSlot::DeepseekToolsApiKey
                | SecretSlot::CustomSearchApiKey
                | SecretSlot::CustomFetchApiKey
                | SecretSlot::TavilyFetchApiKey
                | SecretSlot::JevApiKey
                | SecretSlot::KeyStoreMaster
                | SecretSlot::SyncDataKey
                | SecretSlot::SyncRecoveryKey
                | SecretSlot::SyncStoragePassword
                | SecretSlot::LegacySyncKey
                | SecretSlot::LegacySyncDeviceApiKey
                | SecretSlot::LegacySyncDeviceId
                | SecretSlot::LegacySyncServerUrl => true,
                SecretSlot::LlmChannel(_)
                | SecretSlot::LlmChannelHeaders(_)
                | SecretSlot::McpHeaders(_)
                | SecretSlot::SshPassword(_)
                | SecretSlot::SshKeyPassphrase(_)
                | SecretSlot::JumpPassword(_)
                | SecretSlot::JumpKeyPassphrase(_) => false,
            };
            assert_eq!(
                fixed.contains(&slot),
                is_unit,
                "{:?} 与 fixed_slots() 的登记不一致",
                slot
            );
        }
    }

    /// 每个样本槽位的账号名都能反查回自己（机密流落地时只有账号名）。
    #[test]
    fn every_sample_account_round_trips_through_from_account() {
        let catalog = SecretSlotCatalog {
            connection_ids: vec!["c1".into()],
            channel_ids: vec!["c1".into()],
            mcp_ids: vec!["s1".into()],
        };
        for slot in all_samples() {
            let account = slot.account().into_owned();
            assert_eq!(
                SecretSlot::from_account(&account, &catalog),
                Some(slot.clone()),
                "账号 {account} 反查不回 {slot:?}"
            );
        }
    }

    /// 反查的边界：认不出来的一律 `None`（只进加密镜像，绝不硬造槽位写密钥链）。
    #[test]
    fn from_account_rejects_unknown_or_dangling_accounts() {
        let catalog = SecretSlotCatalog {
            connection_ids: vec!["c1".into()],
            channel_ids: vec!["ch1".into()],
            mcp_ids: vec![],
        };
        for account in [
            "",
            "nope",
            "pk:does-not-exist",
            "jump:does-not-exist",
            "jump:pk:does-not-exist",
            "llm_channel_does-not-exist",
            "llm_channel_",   // 空 id
            "mcp_headers_s1", // T8 才认识
        ] {
            assert_eq!(
                SecretSlot::from_account(account, &catalog),
                None,
                "{account:?} 不该被认出来"
            );
        }
        // 长前缀不能被子串误伤：`jump:pk:c1` 是跳板机口令，不是 `pk:` 或 `jump:` 的变体
        assert_eq!(
            SecretSlot::from_account("jump:pk:c1", &catalog),
            Some(SecretSlot::JumpKeyPassphrase("c1".into()))
        );
        assert_eq!(
            SecretSlot::from_account("pk:c1", &catalog),
            Some(SecretSlot::SshKeyPassphrase("c1".into()))
        );
        assert_eq!(
            SecretSlot::from_account("jump:c1", &catalog),
            Some(SecretSlot::JumpPassword("c1".into()))
        );
        // 连接密码：账号名就是连接 id，必须本机确实有这条连接才认
        assert_eq!(
            SecretSlot::from_account("c1", &catalog),
            Some(SecretSlot::SshPassword("c1".into()))
        );
        // 固定槽位不依赖 catalog
        assert_eq!(
            SecretSlot::from_account("web_search_api_key", &SecretSlotCatalog::default()),
            Some(SecretSlot::WebSearchApiKey)
        );
    }

    /// 可枚举槽位 = 固定 ∪ 每条连接四个 ∪ 每个渠道一个，且不重复。
    #[test]
    fn enumerable_slots_cover_fixed_and_parameterized_slots() {
        let catalog = SecretSlotCatalog {
            connection_ids: vec!["c1".into(), "c2".into()],
            channel_ids: vec!["ch1".into()],
            mcp_ids: vec![],
        };
        let slots = SecretSlot::enumerable_slots(&catalog);
        // 每条连接 4 个槽位；每个渠道 2 个（API Key + 自定义请求头）
        assert_eq!(slots.len(), SecretSlot::fixed_slots().len() + 2 * 4 + 2);
        let accounts: std::collections::HashSet<String> =
            slots.iter().map(|s| s.account().into_owned()).collect();
        assert_eq!(accounts.len(), slots.len(), "枚举里有重复槽位");
        assert!(slots.contains(&SecretSlot::SshPassword("c2".into())));
        assert!(slots.contains(&SecretSlot::JumpKeyPassphrase("c2".into())));
        assert!(slots.contains(&SecretSlot::LlmChannel("ch1".into())));
        assert!(slots.contains(&SecretSlot::LlmChannelHeaders("ch1".into())));
        // 空 catalog 时只剩固定槽位
        assert_eq!(
            SecretSlot::enumerable_slots(&SecretSlotCatalog::default()).len(),
            SecretSlot::fixed_slots().len()
        );
    }

    /// 广播过滤：只有 Secret 档且不在抑制里才发。
    #[test]
    fn only_secret_tier_slots_broadcast_and_suppression_wins() {
        let secret = SecretSlot::LlmChannel("c1".into());
        let local = SecretSlot::SyncDataKey;
        assert!(should_broadcast(&secret, 0));
        assert!(!should_broadcast(&secret, 1), "抑制期间不广播");
        assert!(!should_broadcast(&local, 0), "Local 档不参与机密同步");
        assert!(!should_broadcast(&SecretSlot::KeyStoreMaster, 0));
        assert!(!should_broadcast(&SecretSlot::SyncRecoveryKey, 0));
        assert!(!should_broadcast(&SecretSlot::SyncStoragePassword, 0));
        assert!(!should_broadcast(&SecretSlot::LegacySyncKey, 0));
    }

    /// 抑制深度是嵌套安全的 RAII：内层先 Drop 不能解除外层的抑制。
    ///
    /// 测试串行执行（Rust 默认），但全局深度是进程级的，前后都要归零。
    #[test]
    fn capture_suppression_nests_and_unwinds_to_zero() {
        assert_eq!(suppress_depth(), 0);
        {
            let _outer = CaptureSuppression::new();
            assert_eq!(suppress_depth(), 1);
            {
                let _inner = CaptureSuppression::new();
                assert_eq!(suppress_depth(), 2);
            }
            assert_eq!(suppress_depth(), 1, "内层 Drop 后外层仍抑制");
            assert!(!should_broadcast(&SecretSlot::JevApiKey, suppress_depth()));
        }
        assert_eq!(suppress_depth(), 0, "全部 Drop 后恢复广播");
        assert!(should_broadcast(&SecretSlot::JevApiKey, suppress_depth()));
        // 多减一次不能变成负数（saturating_sub 的守卫）
        assert_eq!(suppress_depth(), 0);
    }
}
