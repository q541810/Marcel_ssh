//! 同步存储适配器：把「一个能存取文件的地方」抽象成 [`SyncStorage`]。
//!
//! 同步引擎只依赖这个 trait，不知道背后是 WebDAV、SFTP 还是内存里的一张表——换存储不用改
//! 引擎。**存储只会存取文件**：所有判断（谁新谁旧、冲突怎么合）都在客户端，每台设备只往自己
//! 的目录写，所以适配器既不需要锁，也不需要版本比较，更不需要「条件写入」这类各家实现不一的
//! 高级能力。
//!
//! 约定（三个适配器一致，`contract_tests` 对每个适配器跑同一套）：
//!
//! - 路径一律是相对同步根目录（root）的、用 `/` 分隔的相对路径，`""` 就是根本身。多余的 `/`、
//!   `.` 会被吃掉；出现 `..`、`\`、控制字符一律拒绝——适配器不允许越出根目录。
//! - 以 `.` 开头的名字是适配器自己的临时文件（SFTP 原子写入的 sidecar 等），`list` 不返回，
//!   同步引擎也永远不该用这样的名字。
//! - `delete` 指向目录时**连同里面的内容一起删**（WebDAV 的 DELETE 本来就是这个语义，SFTP /
//!   内存适配器对齐它），「停止同步并删除云端数据」靠这一条把 `devices/` 整棵摘掉。拒绝删除根
//!   本身（空路径）：根目录是用户选的，里面可能还有别的东西。
//! - 错误里的文案是中文、给人看的，**绝不含密码**（适配器对外抛错前过一遍，URL 里的账号也剥掉）。

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub mod memory;
pub mod sftp;
pub mod webdav;

#[cfg(test)]
pub(crate) mod contract_tests;

pub use memory::MemoryStorage;
pub use sftp::{SavedConnectionConnector, SftpConnector, SftpStorage};
pub use webdav::WebDavStorage;

/// 同步根目录的默认名字（在用户选的位置下面再建一层，免得和别的文件混在一起）。
pub const DEFAULT_ROOT: &str = "marcel-sync";

fn default_root() -> String {
    DEFAULT_ROOT.to_string()
}

/// 一个远端条目（`list` 的结果）。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteEntry {
    /// 只是名字（最后一段），不含路径；百分号编码等传输细节已在适配器里还原。
    pub name: String,
    pub is_dir: bool,
    /// 字节数；目录与服务器没给的一律 0。
    pub size: u64,
}

/// 存储适配器出错的原因。分类是给同步引擎与界面用的（网络错误会退避重试，认证 / 权限 / 主机
/// 密钥错误要提示用户去改设置），文案本身已经是写给人看的中文整句。
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
pub enum StorageError {
    /// 连不上、超时、服务器暂时拒绝（限流 / 5xx）。多半过一会儿就好。
    #[error("{0}")]
    Network(String),
    /// 账号、密码或密钥被服务器拒绝。
    #[error("{0}")]
    Auth(String),
    /// 登录没问题，但没有权限做这件事（目录不可写、不允许在此建文件夹……）。
    #[error("{0}")]
    Permission(String),
    /// SFTP 服务器的主机密钥与本机记录的不一致（或校验失败）。**安全边界，不自动信任。**
    #[error("{0}")]
    HostKey(String),
    /// 其它：服务器不支持、路径非法、返回内容读不懂……
    #[error("{0}")]
    Other(String),
}

impl From<StorageError> for AppError {
    /// 统一落成 `AppError::Other`：它的展示文本就是原文，界面用 `getErrorMessage` 直接显示一整句
    /// 中文，不会带上 `Network error:` 之类的英文前缀。需要按类别分支的调用方（同步引擎）在转换
    /// 之前就拿着 `StorageError` 自己匹配了。
    fn from(e: StorageError) -> Self {
        AppError::Other(e.to_string())
    }
}

/// 存储位置的配置（会持久化进同步状态，也是「同步码」的一部分）。
///
/// **不含任何密码**：WebDAV 的密码、SFTP 连接的密码 / 口令都另存密钥链，由调用方在构造适配器时
/// 传入。前端契约见 4.9：`{ kind: 'webDav', url, username, root }` /
/// `{ kind: 'sftp', connectionId, root }`，所以变体名与字段名都是 camelCase。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum StorageConfig {
    WebDav {
        url: String,
        username: String,
        #[serde(default = "default_root")]
        root: String,
    },
    Sftp {
        connection_id: String,
        #[serde(default = "default_root")]
        root: String,
    },
}

/// 同步存储。见模块文档里的约定。
#[async_trait]
pub trait SyncStorage: Send + Sync {
    /// 列出 `dir`（相对 root，`""` = root）下的直接子项。目录不存在 → `Ok(空)`。
    async fn list(&self, dir: &str) -> Result<Vec<RemoteEntry>, StorageError>;
    /// 读文件。不存在 → `Ok(None)`。
    async fn get(&self, path: &str) -> Result<Option<Vec<u8>>, StorageError>;
    /// 写文件（覆盖同名文件），自动建缺失的父目录；能原子就原子（SFTP 先写临时文件再改名）。
    async fn put(&self, path: &str, bytes: &[u8]) -> Result<(), StorageError>;
    /// 删文件或目录（目录连内容一起删）。不存在也算成功。
    async fn delete(&self, path: &str) -> Result<(), StorageError>;
    /// 连通性 + 权限自检：确保 root 存在，并写入 / 读回一个探针文件（删除是尽力清理，删不掉不算失败）。
    async fn probe(&self) -> Result<(), StorageError>;
}

/// 把相对路径拆成段，并做越界检查。三个适配器共用，所以「什么路径合法」只有这一份定义。
///
/// - 空段与 `.` 直接丢弃（`a//b/./c` == `a/b/c`，开头结尾的 `/` 也无所谓）。
/// - `..` 一律拒绝：同步引擎自己不会产生它，出现说明有 bug 或有人在构造路径逃出根目录。
/// - `\` 与控制字符拒绝：Windows 主机上的 WebDAV / SFTP 会把反斜杠当分隔符。
pub(crate) fn rel_segments(path: &str) -> Result<Vec<&str>, StorageError> {
    let mut out = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                return Err(StorageError::Other(
                    "同步路径不合法：不允许使用 .. 跳出同步目录".into(),
                ))
            }
            s if s.contains('\\') || s.chars().any(char::is_control) => {
                return Err(StorageError::Other(
                    "同步路径不合法：名称里含有反斜杠或控制字符".into(),
                ))
            }
            s => out.push(s),
        }
    }
    Ok(out)
}

/// 临时文件（适配器自己的 sidecar）与探针用的随机后缀。
pub(crate) fn random_suffix() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

/// 探针的「写入 → 读回 → 删除」三步，WebDAV / SFTP 共用（root 的创建与列目录自检各适配器自己做）。
///
/// **只有写和读回算硬指标**：同步协议的每一步都离不开它们，读写不通这个位置就没法用。
///
/// 删除只是尽力清理：删不掉只记一条日志，不让自检失败。同步本身不在正常轮次里删东西——只有配置流
/// 攒够 50 段压缩时才会删自己旧的段，删不掉的结果是云端多留几份旧段，不影响正确性。反过来把
/// 删除当硬指标，会让「能写能读、偏偏不能删」的位置（有的网盘桥接服务是这样）连开启同步都做不到，
/// 代价远大于收益。探针用随机文件名，服务器能删时不会留下痕迹。
pub(crate) async fn write_read_delete_probe(s: &dyn SyncStorage) -> Result<(), StorageError> {
    let name = format!("probe-{}.tmp", random_suffix());
    let payload = format!("marcel-sync-probe-{}", random_suffix()).into_bytes();
    s.put(&name, &payload).await?;
    let back = s.get(&name).await;
    // 先删再判读回的结果：不管读回是否正常，探针文件都不该留着。
    let deleted = s.delete(&name).await;
    match back? {
        Some(b) if b == payload => {}
        Some(_) => {
            return Err(StorageError::Other(
                "服务器返回的内容和刚写入的不一致，这个位置可能不适合做同步目录。".into(),
            ))
        }
        None => {
            return Err(StorageError::Other(
                "写入成功但读不回来，这个位置可能不适合做同步目录。".into(),
            ))
        }
    }
    if let Err(e) = deleted {
        log::warn!(
            "同步存储自检：探针文件删不掉（{e}）。同步照常进行，但云端旧的同步段不会被自动清理。"
        );
    }
    Ok(())
}

/// `list` 要不要把这个名字藏起来：以 `.` 开头的是适配器自己的临时文件。
pub(crate) fn is_hidden_name(name: &str) -> bool {
    name.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_segments_normalizes_and_rejects_escapes() {
        assert_eq!(rel_segments("").unwrap(), Vec::<&str>::new());
        assert_eq!(rel_segments("/").unwrap(), Vec::<&str>::new());
        assert_eq!(
            rel_segments("/devices//abc/./seg-1.msync/").unwrap(),
            vec!["devices", "abc", "seg-1.msync"]
        );
        // 中文、空格、百分号都是合法名字（编码是适配器的事，不是路径层的事）
        assert_eq!(
            rel_segments("我的 文件/100%").unwrap(),
            vec!["我的 文件", "100%"]
        );
        assert!(rel_segments("a/../b").is_err());
        assert!(rel_segments("..").is_err());
        assert!(rel_segments("a\\b").is_err());
        assert!(rel_segments("a/\u{0}b").is_err());
    }

    #[test]
    fn storage_config_matches_the_frontend_contract() {
        let dav = StorageConfig::WebDav {
            url: "https://dav.jianguoyun.com/dav/".into(),
            username: "me@example.com".into(),
            root: "marcel-sync".into(),
        };
        assert_eq!(
            serde_json::to_value(&dav).unwrap(),
            serde_json::json!({
                "kind": "webDav",
                "url": "https://dav.jianguoyun.com/dav/",
                "username": "me@example.com",
                "root": "marcel-sync",
            })
        );
        let sftp = StorageConfig::Sftp {
            connection_id: "c1".into(),
            root: "sync".into(),
        };
        assert_eq!(
            serde_json::to_value(&sftp).unwrap(),
            serde_json::json!({ "kind": "sftp", "connectionId": "c1", "root": "sync" })
        );
        // 往返，且缺省 root 回落到默认目录名（同步码里少了字段也别解析失败）
        let back: StorageConfig =
            serde_json::from_str(r#"{"kind":"sftp","connectionId":"c1"}"#).unwrap();
        assert_eq!(
            back,
            StorageConfig::Sftp {
                connection_id: "c1".into(),
                root: DEFAULT_ROOT.into()
            }
        );
        assert_eq!(
            serde_json::from_value::<StorageConfig>(serde_json::to_value(&dav).unwrap()).unwrap(),
            dav
        );
    }

    #[test]
    fn storage_error_becomes_a_plain_chinese_app_error() {
        let app: AppError = StorageError::Auth("用户名或密码不正确".into()).into();
        // 展示文本就是原文，没有 `Network error:` 之类的英文前缀
        assert_eq!(app.to_string(), "用户名或密码不正确");
    }
}
