//! 数据源登记表：**本机所有落盘数据的唯一来源**。
//!
//! 每份会落到磁盘上的数据（配置 JSON、数据库、目录……）都必须在这里登记一个
//! [`DataSourceId`]：它在哪（相对哪个基准目录的什么名字）、是文件还是目录、
//! 属于哪一[同步分档](SyncTier)。以后的跨设备同步引擎只认这张表——漏登记的数据
//! 就是「同步不到的数据」，所以这里把「登记」做成编译期强制的：
//!
//! - 所有属性都在 [`DataSourceId::spec`] 这**一个 `match`** 里，且不写 `_ =>`，
//!   新增变体不补全属性就编译不过；
//! - [`DataSourceId::ALL`] 由宏与枚举一起生成，不可能漏变体；
//! - 路径只能经 [`DataSourceId::path`] 取；`tests` 里的落盘位置普查会扫描全部源码，
//!   凡是在本目录之外直接 `config_dir.join(..)` 拼落盘路径的一律判失败。
//!
//! 子模块：
//! - [`bus`]：数据变更广播（以后同步引擎订阅它）；
//! - [`json_store`]：5 份 JSON 配置的**唯一写盘出口** `JsonStore`。

pub mod bus;
pub mod json_store;
pub mod legacy;

#[cfg(test)]
mod tests;

use std::path::{Path, PathBuf};

pub use bus::{DataChange, DataChangeBus};
pub use json_store::{JsonStore, UpdateGuard};

/// 同步分档：每份数据属于哪一档，决定以后同步时怎么处理。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SyncTier {
    /// 普通配置（默认跨设备同步）。
    Config,
    /// 对话与记忆（单独开关）。
    Conversation,
    /// 机密（单独开关，默认关）。
    Secret,
    /// 不同步：缓存、临时目录、设备绑定的东西。
    Local,
}

/// 登记项是单个文件、一个目录，还是「不落盘的虚拟源」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SourceKind {
    File,
    Dir,
    /// 不落盘：只是「哪份数据变了」的广播身份（例如密钥链）。**不能 `path()`**。
    Virtual,
}

/// 登记项的相对路径以哪个基准目录为根。
///
/// 绝大多数数据在应用配置目录；预览 / 系统打开的临时文件落在 `app_data_dir`
/// （Tauri asset 协议要求，见各自调用处的说明），更新安装包落在 `app_cache_dir`。
/// 这几个目录在 Windows 上可能重合，但别的平台不是同一个，所以登记时分开记。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BaseDir {
    /// `app_config_dir()`，即 `AppState.config_dir`。
    Config,
    /// `app_data_dir()`。
    AppData,
    /// `app_cache_dir()`。
    AppCache,
}

/// [`DataSourceId`] 的全部属性（见 [`DataSourceId::spec`]）。
#[derive(Debug, Clone, Copy)]
pub struct SourceSpec {
    pub tier: SyncTier,
    pub base: BaseDir,
    pub rel_path: &'static str,
    pub kind: SourceKind,
    pub describe: &'static str,
}

/// 枚举与 `ALL` 同源生成：`ALL` 不可能漏变体。
macro_rules! data_sources {
    ($($(#[$meta:meta])* $name:ident),+ $(,)?) => {
        /// 一份落盘数据的身份。新增数据先在这里加变体，再到 [`DataSourceId::spec`] 补全属性。
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum DataSourceId {
            $($(#[$meta])* $name),+
        }

        impl DataSourceId {
            /// 全部登记项（遍历用）。
            pub const ALL: &'static [DataSourceId] = &[$(DataSourceId::$name),+];
        }
    };
}

data_sources! {
    /// `settings.json`：应用设置。
    Settings,
    /// `connections.json`：已保存的 SSH 连接。
    Connections,
    /// `quick_commands.json`：快捷指令。
    QuickCommands,
    /// `skills.json`：用户与内置 skill。
    Skills,
    /// `mcp_servers.json`：MCP client 的服务器配置。
    McpServers,
    /// `known_hosts.json`：SSH 主机密钥指纹（TOFU）。
    KnownHosts,
    /// `keys/`：导入的 SSH 私钥库（密文）。
    KeyStore,
    /// `conversations.db`：Agent 对话库。
    Conversations,
    /// `images/`：对话里的图片附件。
    Images,
    /// `memory.db`：长期记忆库。
    Memory,
    /// `jobs.json`：后台作业台账。
    JobLedger,
    /// `jobs_temp/`：后台作业输出的溢出文件。
    JobsTemp,
    /// `local_command/`：本机命令执行器自己的一整套（台账 + 溢出目录）。
    LocalCommand,
    /// `plugins/`：已安装的插件本体。
    Plugins,
    /// `marcel-previews/`：SFTP 图片预览的临时下载目录。
    Previews,
    /// `marcel-sysopen/`：「用系统方式打开」的本地临时副本。
    SysopenTemp,
    /// `update/`：更新安装包下载缓存。
    UpdateCache,
    /// `sync/`：跨设备同步的本机状态（设备 id、游标、镜像、基线、待上传队列、同步记录）。
    SyncState,
    /// 密钥链里的机密（**不落盘**）：只是「哪些 Key 变了」的广播身份，给机密同步用。
    Secrets,
}

impl DataSourceId {
    /// 全部属性的唯一出处。**不要写 `_ =>`**：新增变体必须在这里补全，编译器强制。
    pub const fn spec(self) -> SourceSpec {
        use SourceKind::*;
        use SyncTier::*;
        match self {
            DataSourceId::Settings => SourceSpec {
                tier: Config,
                base: BaseDir::Config,
                rel_path: "settings.json",
                kind: File,
                describe: "应用设置（外观、终端、Agent、模型服务渠道等）",
            },
            DataSourceId::Connections => SourceSpec {
                tier: Config,
                base: BaseDir::Config,
                rel_path: "connections.json",
                kind: File,
                describe: "已保存的 SSH 连接（地址、用户、认证方式、分组与顺序）",
            },
            DataSourceId::QuickCommands => SourceSpec {
                tier: Config,
                base: BaseDir::Config,
                rel_path: "quick_commands.json",
                kind: File,
                describe: "快捷指令",
            },
            DataSourceId::Skills => SourceSpec {
                tier: Config,
                base: BaseDir::Config,
                rel_path: "skills.json",
                kind: File,
                describe: "用户自建 skill 与内置 skill 的启用状态",
            },
            DataSourceId::McpServers => SourceSpec {
                tier: Config,
                base: BaseDir::Config,
                rel_path: "mcp_servers.json",
                kind: File,
                describe: "MCP 服务器配置（Marcel 作为客户端连接的外部服务）",
            },
            DataSourceId::KnownHosts => SourceSpec {
                tier: Config,
                base: BaseDir::Config,
                rel_path: "known_hosts.json",
                kind: File,
                describe: "SSH 主机密钥指纹（首次信任后的校验依据）",
            },
            // 私钥密文用**本机**主密钥（系统密钥链里的 keys:master）加密，换设备解不开，
            // 所以不走普通配置同步。三期起由机密流同步：上传时用数据密钥 SK 重新封装的
            // **私钥原文**（走 blob），落地时用对方自己的主密钥再加密一遍。
            // 主密钥本身仍然是设备绑定（`SecretSlot::KeyStoreMaster` 是 Local），永不外传。
            DataSourceId::KeyStore => SourceSpec {
                tier: Secret,
                base: BaseDir::Config,
                rel_path: "keys",
                kind: Dir,
                describe:
                    "SSH 私钥库（本机主密钥加密；三期起私钥正文经机密流同步，主密钥仍设备绑定）",
            },
            DataSourceId::Conversations => SourceSpec {
                tier: Conversation,
                base: BaseDir::Config,
                rel_path: "conversations.db",
                kind: File,
                describe: "Agent 对话库（会话、消息、计划）",
            },
            DataSourceId::Images => SourceSpec {
                tier: Conversation,
                base: BaseDir::Config,
                rel_path: "images",
                kind: Dir,
                describe: "对话里的图片附件（按会话分目录）",
            },
            DataSourceId::Memory => SourceSpec {
                tier: Conversation,
                base: BaseDir::Config,
                rel_path: "memory.db",
                kind: File,
                describe: "长期记忆库（记忆条目、操作日志、复盘进度）",
            },
            DataSourceId::JobLedger => SourceSpec {
                tier: Local,
                base: BaseDir::Config,
                rel_path: "jobs.json",
                kind: File,
                describe: "后台作业台账（作业序号水位，与本机进程绑定）",
            },
            DataSourceId::JobsTemp => SourceSpec {
                tier: Local,
                base: BaseDir::Config,
                rel_path: "jobs_temp",
                kind: Dir,
                describe: "后台作业输出的溢出文件（临时数据）",
            },
            DataSourceId::LocalCommand => SourceSpec {
                tier: Local,
                base: BaseDir::Config,
                rel_path: "local_command",
                kind: Dir,
                describe: "本机命令执行器的台账与溢出文件（只属于这台电脑）",
            },
            // 插件本体在各设备从市场装，不随同步搬运。
            DataSourceId::Plugins => SourceSpec {
                tier: Local,
                base: BaseDir::Config,
                rel_path: "plugins",
                kind: Dir,
                describe: "已安装的插件（本体与插件自己的数据，各设备分别安装）",
            },
            DataSourceId::Previews => SourceSpec {
                tier: Local,
                base: BaseDir::AppData,
                rel_path: "marcel-previews",
                kind: Dir,
                describe: "SFTP 图片预览的临时下载目录（用完即清）",
            },
            DataSourceId::SysopenTemp => SourceSpec {
                tier: Local,
                base: BaseDir::AppData,
                rel_path: "marcel-sysopen",
                kind: Dir,
                describe: "「用系统方式打开」的本地临时副本（用完即清）",
            },
            DataSourceId::UpdateCache => SourceSpec {
                tier: Local,
                base: BaseDir::AppCache,
                rel_path: "update",
                kind: Dir,
                describe: "应用更新安装包的下载缓存",
            },
            // 同步引擎自己的账本：设备 id、对每台设备读到哪、镜像与基线都只对这台设备有意义，
            // 搬到别的设备上反而会让对方以为「这些我都读过了」，所以绝不同步。
            DataSourceId::SyncState => SourceSpec {
                tier: Local,
                base: BaseDir::Config,
                rel_path: "sync",
                kind: Dir,
                describe: "跨设备同步的本机状态（设备标识、读取进度、镜像、待上传队列、同步记录）",
            },
            // 不落盘：密钥链里的每一份 Key / 密码。它没有磁盘位置，登记在这里只是为了让
            // 「密钥链变了」这条广播有一个稳定的身份（机密流据此捕获改动）。
            DataSourceId::Secrets => SourceSpec {
                tier: Secret,
                base: BaseDir::Config,
                rel_path: "secrets",
                kind: Virtual,
                describe: "密钥链里的机密（不落盘，只是密钥链变更的广播身份）",
            },
        }
    }

    /// 同步分档。
    pub const fn tier(self) -> SyncTier {
        self.spec().tier
    }

    /// 相对基准目录（见 [`Self::base`]）的文件或目录名。
    pub const fn rel_path(self) -> &'static str {
        self.spec().rel_path
    }

    /// 文件还是目录。
    pub const fn kind(self) -> SourceKind {
        self.spec().kind
    }

    /// 相对路径的基准目录。
    pub const fn base(self) -> BaseDir {
        self.spec().base
    }

    /// 中文一句话说明（给设置页 / 同步页 / 日志用）。
    pub const fn describe(self) -> &'static str {
        self.spec().describe
    }

    /// 跨设备同步里这份数据的**同步源 key**（写进远端文件的字符串，**跨版本稳定，不能改**）。
    ///
    /// 只有普通配置档（[`SyncTier::Config`]）有 key，其余档返回 `None`——对话与记忆、机密、
    /// 本机专属数据不在一期同步范围内。`match` 不写 `_ =>`：新增登记项必须表态。
    pub const fn sync_key(self) -> Option<&'static str> {
        match self {
            DataSourceId::Settings => Some("settings"),
            DataSourceId::Connections => Some("connections"),
            DataSourceId::QuickCommands => Some("quickCommands"),
            DataSourceId::Skills => Some("skills"),
            DataSourceId::McpServers => Some("mcpServers"),
            DataSourceId::KnownHosts => Some("knownHosts"),
            DataSourceId::KeyStore
            | DataSourceId::Conversations
            | DataSourceId::Images
            | DataSourceId::Memory
            | DataSourceId::JobLedger
            | DataSourceId::JobsTemp
            | DataSourceId::LocalCommand
            | DataSourceId::Plugins
            | DataSourceId::Previews
            | DataSourceId::SysopenTemp
            | DataSourceId::UpdateCache
            | DataSourceId::SyncState
            | DataSourceId::Secrets => None,
        }
    }

    /// 「这份数据变了」要不要触发一轮同步。
    ///
    /// 默认就是「它有同步源 key」（配置档）；机密不落盘、没有源 key，但密钥链的变化同样要
    /// 触发同步，所以单独为真。
    pub const fn sync_trigger(self) -> bool {
        match self {
            // 密钥链变了：机密流（三期）要捕获。它不是经由 JSON 写入口广播的，所以不靠 sync_key。
            DataSourceId::Secrets => true,
            other => other.sync_key().is_some(),
        }
    }

    /// 取这份数据的磁盘路径。
    ///
    /// `base_dir` 传 [`Self::base`] 对应的那个目录：绝大多数登记项是应用配置目录
    /// （`AppState.config_dir`）；`Previews` / `SysopenTemp` 传 `app_data_dir`，
    /// `UpdateCache` 传 `app_cache_dir`。登记项也可以相对另一份登记项取（例如
    /// `local_command/` 里面再放一份 `JobLedger`，传 `LocalCommand` 的路径即可）。
    pub fn path(self, base_dir: &Path) -> PathBuf {
        // Virtual 源没有磁盘位置：谁调了 `path()` 就是逻辑错误（调试版直接崩，发布版也别用返回值）。
        debug_assert!(
            self.kind() != SourceKind::Virtual,
            "{:?} 是不落盘的虚拟数据源，没有磁盘路径",
            self
        );
        base_dir.join(self.rel_path())
    }
}
