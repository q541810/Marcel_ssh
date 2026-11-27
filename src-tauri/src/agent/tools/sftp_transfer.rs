//! SFTP file transfer tools (upload_file / download_file).
//!
//! Uses the SFTP subsystem protocol for binary-safe file transfers.
//! 传输实现与用户 SFTP 面板**共用同一流式核心**
//! （commands::sftp::{stream_upload_single_file, stream_download_single_file}），
//! 不在此重复字节拷贝逻辑；本文件只做参数解析 / 本地路径校验（绝对路径 +
//! 系统/敏感路径黑名单；download 省略 local_path 时落系统 Downloads，
//! user_pick=true 时弹系统对话框让用户亲自选本机一侧）/ 传输中心接入
//! （互斥 + 记账 + 事件）。桌面专属工具（移动端不注册）。

use async_trait::async_trait;
use russh_sftp::protocol::OpenFlags;
use serde_json::json;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tokio::fs;

use crate::agent::risk::Disposition;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

/// Hard ceiling for a single transfer to prevent runaway memory use.
/// 「大文件」阈值：超过它不会直接开传，而是把决定权交回模型 —— 必须显式传
/// `allow_large_transfer=true` 才放行（提示文案见 [`large_upload_notice`]）。
///
/// 理由（产品决策）：云服务器的上行通常很小，几 GB 的文件可能是几十分钟到
/// 几小时的传输，值得先被确认一次，而不是默默占满带宽和会话。原实现是
/// 32 MiB 硬顶 + 一句「Use rsync/scp」，那条既拦掉了本来合理的几十 MB 传输，
/// 也没给模型任何判断余地。
///
/// **闸门只对非内网目标生效**（见 [`large_transfer_needs_confirmation`]）：
/// 连着局域网/本机时带宽不是瓶颈，没必要打扰。
const LARGE_TRANSFER_BYTES: u64 = 1024 * 1024 * 1024;

/// 模型对「>1GB 传输」的显式确认。
fn allow_large_transfer(params: &serde_json::Value) -> bool {
    params
        .get("allow_large_transfer")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// 是否要拦住这次传输：超过 1GB、模型没确认、且**不是用户在原生对话框里
/// 亲自挑的**（用户自己选的文件就是明确授权，再要求模型补参数只会让用户
/// 重新选一次文件）。
fn needs_large_transfer_confirmation(size: u64, confirmed: bool, user_picked: bool) -> bool {
    size > LARGE_TRANSFER_BYTES && !confirmed && !user_picked
}

/// IP 是否属于「内网/本机」范围：RFC1918、回环、链路本地、IPv6 ULA。
/// 运营商级 NAT（100.64/10）刻意**不**算内网 —— 那是公网链路。
fn ip_is_private(ip: std::net::IpAddr) -> bool {
    match ip {
        std::net::IpAddr::V4(v4) => v4.is_private() || v4.is_loopback() || v4.is_link_local(),
        std::net::IpAddr::V6(v6) => {
            // IPv4-mapped（::ffff:192.168.1.1）按内层地址判
            if let Some(v4) = v6.to_ipv4_mapped() {
                return ip_is_private(std::net::IpAddr::V4(v4));
            }
            // ULA（fc00::/7）与链路本地（fe80::/10）用位判断，避免依赖
            // 只在新版 std 才稳定的 `is_unicast_link_local`。
            let head = v6.segments()[0];
            v6.is_loopback() || (head & 0xffc0) == 0xfe80 || (head & 0xfe00) == 0xfc00
        }
    }
}

/// 主机串的快速判定：`Some(true)` = 内网、`Some(false)` = 公网（IP 字面量），
/// `None` = 得解析一次 DNS 才知道。
fn host_lan_quick(host: &str) -> Option<bool> {
    let trimmed = host.trim();
    let bare = trimmed
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(trimmed);
    if let Ok(ip) = bare.parse::<std::net::IpAddr>() {
        return Some(ip_is_private(ip));
    }
    let lower = bare.trim_end_matches('.').to_ascii_lowercase();
    const LAN_SUFFIXES: [&str; 6] = [
        ".local",
        ".lan",
        ".internal",
        ".home",
        ".home.arpa",
        ".localdomain",
    ];
    if lower == "localhost" || LAN_SUFFIXES.iter().any(|s| lower.ends_with(s)) {
        return Some(true);
    }
    None
}

/// 目标主机是否在局域网/本机。
async fn target_is_lan(host: &str, port: u16) -> bool {
    match host_lan_quick(host) {
        Some(v) => v,
        None => match tokio::net::lookup_host((host, port)).await {
            // 任一解析结果落在内网段即算内网
            Ok(addrs) => addrs.into_iter().any(|a| ip_is_private(a.ip())),
            // 解析不出来（离线 / 名字错 / 无 DNS）：当公网处理 —— 宁可多提示一次，
            // 也不要让一次几小时的公网传输悄悄开跑。
            Err(_) => false,
        },
    }
}

/// 闸门总判定：>1GB、模型没确认、不是用户亲选，**且目标不是内网**。
/// 前几条不成立就直接返回 false —— 会话查询/DNS 只在真要提示时才发生。
async fn large_transfer_needs_confirmation(
    ctx: &ToolContext,
    size: u64,
    confirmed: bool,
    user_picked: bool,
) -> bool {
    if !needs_large_transfer_confirmation(size, confirmed, user_picked) {
        return false;
    }
    match ctx.ssh.get_connection_info(&ctx.session_id).await {
        Some((host, port)) => !target_is_lan(&host, port).await,
        // 拿不到会话信息（理论上不该发生）：保守当公网
        None => true,
    }
}

/// 体积的人类可读写法（提示文案用，只会出现在 >1GB 的场景）。
fn human_size(bytes: u64) -> String {
    const GB: f64 = 1024.0 * 1024.0 * 1024.0;
    format!("{:.2} GB", bytes as f64 / GB)
}

/// 超阈值时的提示：措辞由用户给定（逐字保留），参数名必须出现 —— 模型只有
/// 知道参数名才能过这一关。
fn large_upload_notice(size: u64) -> String {
    format!("文件体积为 {}，大于 1GB，对于云服务器，这需要的时间可能是灾难级的，所以请你在上传前思考「这有没有必要？」，如果真的有用，那么你可以加上 allow_large_transfer=true 参数把这个文件传上去。但如果是用户要求你传的，直接加上 allow_large_transfer=true 参数上传这个文件即可。", human_size(size))
}

/// 下载方向的同一条提示（与上传同构，只换方向词）。
fn large_download_notice(size: u64) -> String {
    format!("文件体积为 {}，大于 1GB，对于云服务器，这需要的时间可能是灾难级的，所以请你在下载前思考「这有没有必要？」，如果真的有用，那么你可以加上 allow_large_transfer=true 参数把这个文件取下来。但如果是用户要求你下载的，直接加上 allow_large_transfer=true 参数下载这个文件即可。", human_size(size))
}

// ────────────────────────────── LocalPathPolicy ──────────────────────────────

/// Policy controlling which local paths an agent transfer may touch.
///
/// 白名单沙箱（marcel-ssh-downloads containment）已按产品决策移除：下载/上传
/// 落点由 LLM 用绝对路径自行选择，不再强制落在下载沙箱根内。保留的只有
/// 黑名单——系统目录与敏感路径（~/.ssh 等）仍是安全底线，任何本地路径命中
/// 即拒绝。
#[derive(Debug, Clone)]
pub struct LocalPathPolicy {
    /// Canonical path prefixes that are forbidden. Any local path (download
    /// target / upload source / auto-created parent) under one of these is
    /// rejected.
    pub blacklist: Vec<PathBuf>,
}

impl LocalPathPolicy {
    /// Default policy: built-in blacklist only.
    pub fn default_policy() -> Self {
        Self {
            blacklist: default_blacklist(),
        }
    }

    /// 系统 Downloads 目录（download_file 省略 local_path 时的缺省落点），
    /// 解析失败时退回 home 目录。
    pub fn default_download_dir() -> Option<PathBuf> {
        dirs::download_dir().or_else(dirs::home_dir)
    }

    /// Test-only constructor: a policy with the given blacklist.
    #[cfg(test)]
    pub(crate) fn from_blacklist(blacklist: Vec<PathBuf>) -> Self {
        Self { blacklist }
    }

    /// Test-only constructor: a policy without any blacklist, so tests can
    /// exercise paths under `tempfile::TempDir` (which on Windows lives under
    /// `%LOCALAPPDATA%`, a default-blacklisted location).
    #[cfg(test)]
    pub(crate) fn no_blacklist() -> Self {
        Self { blacklist: vec![] }
    }
}

/// Test-only：返回一个路径已是「规范长名」的 `TempDir`。
///
/// `TempDir::new()` 的路径取自 `%TEMP%`，其形态不受我们控制：GitHub Actions 的 Windows
/// 机器上用户名 `runneradmin` 超过 8 个字符，`%TEMP%` 是 8.3 短名 `C:\Users\RUNNER~1\…`
/// （用户名长于 8 个字符的贡献者本地也一样）；macOS 上是 `/var/…`，canonicalize 后是
/// `/private/var/…`。而被测的路径校验会先把待检路径 canonicalize 成长名再比黑名单——测试
/// 若直接拿 `td.path()` 当黑名单条目，两边形态不同，黑名单就静默不命中，测的变成了临时目录
/// 的形态而不是黑名单本身。
///
/// 这里先把临时目录的父目录 canonicalize（展开 8.3 短名 / 符号链接），再去掉 Windows 的
/// `\\?\` verbatim 前缀：返回的路径既是规范形态，又保持「普通路径」的样子（`..` 组件测试、
/// 「回显调用方路径不带 verbatim 前缀」的断言都依赖后者）。
#[cfg(test)]
pub(crate) fn canonical_tempdir() -> tempfile::TempDir {
    let base = std::fs::canonicalize(std::env::temp_dir()).expect("临时目录必须存在");
    #[cfg(windows)]
    let base = {
        let s = base.as_os_str().to_string_lossy().into_owned();
        match s.strip_prefix(r"\\?\") {
            Some(rest) if !rest.starts_with(r"UNC\") => PathBuf::from(rest),
            _ => base,
        }
    };
    tempfile::TempDir::new_in(base).expect("创建临时目录失败")
}

/// 取路径的规范形态；路径不存在（`~/.ssh`、`~/.aws` 等在本机可能根本没有）
/// 或 canonicalize 失败时**原样返回**。
///
/// 这里必须是 identity 而不是 `None`：黑名单的语义是「这个位置**禁止**被
/// 写入/读取」，与它当前存不存在无关。此前返回 `Option` + `filter_map`，等于
/// 「受保护目录只要还没被创建过就自动退出黑名单」——Windows 新机上 `~/.ssh`、
/// `~/.gnupg`、`~/.config`、`~/.aws`、`~/.kube` 全是这种状态，于是
/// `download_file(local_path="C:\\Users\\X\\.ssh\\config", overwrite=true)`
/// 会当场替 agent 把这个目录建出来再写文件进去（含后续其它 key 写入）。
pub(crate) fn canonicalize_or_identity(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// 黑名单前缀比较用的路径「键」：只用于 [`blacklisted`] 的形态归一，不用于
/// 访问文件，因此可以容忍 lossy 转换。
///
/// 为什么需要它（Windows 上两个形态差异会让黑名单直接失效）：
/// 1. `std::fs::canonicalize` 在 Windows 返回 `\\?\` verbatim 形态
///    （`\\?\C:\...`；UNC 是 `\\?\UNC\server\share\...`），而黑名单里不存在的
///    受保护目录只能保留普通形态，两者用 `Path::starts_with` 比永远不相等；
/// 2. 比较必须按 Windows 的大小写不敏感语义（`C:\Users\x\.ssh` 与
///    `C:\Users\X\.SSH` 是同一个目录），否则改一下大小写就是一条绕过。
///    ASCII 小写足够：盘符与这些受保护目录名都是 ASCII。
/// 顺带把 `/` 统一成 `\`，免得同一路径的两种写法算出两个键。
///
/// 非 Windows 平台没有 verbatim 前缀；macOS 另做 ASCII 小写折叠（见下方 macOS
/// 分支的说明），其余平台比较本就大小写敏感，原样返回。
#[cfg(windows)]
pub(crate) fn path_key(p: &Path) -> PathBuf {
    let s = p.as_os_str().to_string_lossy().replace('/', "\\");
    let s = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{}", rest)
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s
    };
    PathBuf::from(s.to_ascii_lowercase())
}

/// 非 Windows 平台：没有 verbatim 前缀。macOS 仍要做 ASCII 小写折叠——
/// APFS / HFS+ 默认大小写**不敏感**，`/Users/me/.SSH/id_rsa` 与
/// `/Users/me/.ssh/id_rsa` 是同一个文件，黑名单若按大小写敏感比较，
/// 改一下大小写就是一条绕过（Windows 分支的注释里同一条理由）。
/// Linux 及其余平台区分大小写，原样返回。
///
/// 代价：挂载在 macOS 上的**大小写敏感**卷（区分大小写格式化的 APFS / HFS+、
/// 某些网络卷）上，`~/.SSH` 与 `~/.ssh` 是不同目录，前者会被误判成受保护位置。
/// 这是安全方向的保守误报（拒绝而不是放行），可以接受。
#[cfg(target_os = "macos")]
pub(crate) fn path_key(p: &Path) -> PathBuf {
    PathBuf::from(p.as_os_str().to_string_lossy().to_ascii_lowercase())
}

#[cfg(not(any(windows, target_os = "macos")))]
pub(crate) fn path_key(p: &Path) -> PathBuf {
    p.to_path_buf()
}

pub(crate) fn default_blacklist() -> Vec<PathBuf> {
    let mut raw: Vec<PathBuf> = Vec::new();

    if let Some(home) = dirs::home_dir() {
        for sub in [".ssh", ".gnupg", ".config", ".aws", ".kube"] {
            raw.push(home.join(sub));
        }
    }

    #[cfg(target_os = "linux")]
    {
        for d in [
            "/etc", "/root", "/boot", "/usr", "/bin", "/sbin", "/var", "/lib", "/proc", "/sys",
            "/dev",
        ] {
            raw.push(PathBuf::from(d));
        }
    }

    #[cfg(target_os = "macos")]
    {
        for d in [
            "/System",
            "/Library",
            "/Applications",
            "/private",
            "/etc",
            "/usr",
            "/bin",
            "/sbin",
            "/var",
            // `/dev`：Linux 分支早有它。缺了它，`/dev/zero`（len 恒为 0）这类
            // 字符设备在本机读路径上没有任何黑名单兜底——修掉无界读的那道
            // `is_file` 才是主防线，这条只是纵深（同时挡住 list 设备目录）。
            "/dev",
        ] {
            raw.push(PathBuf::from(d));
        }
    }

    #[cfg(target_os = "windows")]
    {
        for var in [
            "SystemRoot",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramData",
            "APPDATA",
            "LOCALAPPDATA",
        ] {
            if let Ok(v) = std::env::var(var) {
                if !v.is_empty() {
                    raw.push(PathBuf::from(v));
                }
            }
        }
    }

    raw.into_iter()
        .map(|p| canonicalize_or_identity(&p))
        .collect()
}

/// Windows 上只接受「盘符 + 根」形态的本机路径，拒绝 UNC（`\\server\share`）、
/// verbatim（`\\?\`）与设备命名空间（`\\.\`）前缀：
/// - UNC 指向**另一台机器**的位置：本机黑名单在那台机器上什么也保护不了，
///   而本工具承诺的本机语义只是「本机绝对路径 + 黑名单底线」；
/// - `\\?\` / `\\.\` 会绕过 Win32 路径规范化与一部分解析规则（也让「校验的
///   路径」和「落盘的路径」不再好对齐），LLM 没有任何理由用它。
///
/// 非 Windows 平台没有路径前缀概念，直接放行。
#[cfg(windows)]
pub(crate) fn reject_non_disk_prefix(p: &Path) -> Result<(), AppError> {
    use std::path::Prefix;
    if let Some(Component::Prefix(prefix)) = p.components().next() {
        if !matches!(prefix.kind(), Prefix::Disk(_)) {
            return Err(AppError::Agent(format!(
                "local path 只支持本机盘符路径（如 C:\\Users\\you\\file.txt）：不支持网络共享 \
                 (\\\\server\\share)、\\\\.\\ 与 \\\\?\\ 前缀。当前: {}",
                p.display()
            )));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn reject_non_disk_prefix(_p: &Path) -> Result<(), AppError> {
    Ok(())
}

/// Reserved Windows device names (case-insensitive).
#[cfg(windows)]
pub(crate) fn is_windows_reserved_name(name: &str) -> bool {
    let stem = name.split('.').next().unwrap_or(name).to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

/// 单个文件名（不含任何目录成分）的校验。本机路径的叶子与 upload_file 的
/// `file_name` 参数共用。`/` 在任何平台都不是合法文件名（在 Windows 上它也是
/// 分隔符）；`\` 只在 Windows 上非法（POSIX 的文件名里它是普通字符，不能误伤）。
pub(crate) fn validate_file_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(AppError::Agent(format!("invalid file name: {:?}", name)));
    }
    if name.contains('/') {
        return Err(AppError::Agent(format!(
            "file name contains path separator: {:?}",
            name
        )));
    }
    if name.contains('\0') {
        return Err(AppError::Agent("file name contains NUL byte".into()));
    }
    #[cfg(windows)]
    {
        for ch in ['<', '>', ':', '"', '|', '?', '*', '\\'] {
            if name.contains(ch) {
                return Err(AppError::Agent(format!(
                    "file name contains illegal character {:?}",
                    ch
                )));
            }
        }
        if name.ends_with(' ') || name.ends_with('.') {
            return Err(AppError::Agent(
                "file name has trailing space or dot (Windows)".into(),
            ));
        }
        if is_windows_reserved_name(name) {
            return Err(AppError::Agent(format!(
                "file name is a reserved Windows device name: {}",
                name
            )));
        }
    }
    Ok(())
}

/// Resolve an absolute, not-yet-existing path by canonicalizing the nearest
/// existing ancestor and re-appending the remaining path segments. This
/// defeats `..` traversal and symlink-based escapes for the existing portion.
pub(crate) fn resolve_against_ancestors(p: &Path) -> Result<PathBuf, AppError> {
    if !p.is_absolute() {
        return Err(AppError::Agent("local path must be absolute".into()));
    }

    // Validate components: no ParentDir, no weird prefix tricks.
    for c in p.components() {
        match c {
            Component::ParentDir => {
                return Err(AppError::Agent(
                    "local path contains parent-directory component (..)".into(),
                ));
            }
            Component::Normal(s) => {
                let seg = s.to_string_lossy();
                if seg.contains('\0') {
                    return Err(AppError::Agent("local path contains NUL byte".into()));
                }
                #[cfg(windows)]
                {
                    // `:` 出现在目录成分里只可能是 NTFS 数据流（`file.txt:stream`）
                    // 或驱动器相对写法：都不是「普通文件路径」的语义，且 `:` 左边
                    // 的名字可能命中黑名单前缀（`.ssh:stream`），一律拒绝。
                    if seg.contains(':') {
                        return Err(AppError::Agent(format!(
                            "local path segment contains ':' (NTFS 数据流 / 非法写法): {:?}",
                            seg
                        )));
                    }
                    // 尾随空格 / 点：Win32 会把它们悄悄去掉（`secret.` → `secret`），
                    // 落到别的目录去。这里拒绝，保证「校验的路径 == 落盘的路径」。
                    if seg.ends_with(' ') || seg.ends_with('.') {
                        return Err(AppError::Agent(format!(
                            "local path segment ends with space or dot (Windows 会去掉它们): {:?}",
                            seg
                        )));
                    }
                }
            }
            _ => {}
        }
    }

    // Walk up to the nearest existing ancestor.
    let mut tail: Vec<&std::ffi::OsStr> = Vec::new();
    let mut cursor: &Path = p;
    let base: PathBuf = loop {
        if cursor.exists() {
            break std::fs::canonicalize(cursor)
                .map_err(|e| AppError::Agent(format!("canonicalize failed: {}", e)))?;
        }
        match (cursor.file_name(), cursor.parent()) {
            (Some(name), Some(parent)) => {
                tail.push(name);
                cursor = parent;
            }
            _ => {
                return Err(AppError::Agent(
                    "no existing ancestor for local path".into(),
                ));
            }
        }
    };

    let mut resolved = base;
    for seg in tail.iter().rev() {
        resolved.push(seg);
    }
    Ok(resolved)
}

/// True if `p` equals or falls under any blacklisted prefix.
///
/// 两侧一律经 [`path_key`] 归一后再比：Windows 上黑名单条目与待检路径可能
/// 一个是 canonical（`\\?\`）形态、一个是原样形态，大小写也可能不同，
/// 直接 `starts_with` 会让黑名单静默失效。
pub(crate) fn blacklisted(p: &Path, blacklist: &[PathBuf]) -> bool {
    let key = path_key(p);
    blacklist.iter().any(|bad| key.starts_with(path_key(bad)))
}

/// Validate a download target. Returns the canonical-ish resolved path.
///
/// 规则（产品决策）：本地落点不强制在下载沙箱内——LLM 用绝对路径自选落点；
/// 但仍要求绝对路径，且任何命中黑名单（系统/敏感路径）的落点被拒绝。
pub async fn validate_local_download_path(
    raw: &Path,
    overwrite: bool,
    policy: &LocalPathPolicy,
) -> Result<PathBuf, AppError> {
    if !raw.is_absolute() {
        // 语义提示：local_path 是「运行本应用的这台电脑」上的路径，不是服务器
        // 路径——用户常把 SSH 会话里的 Linux 绝对路径误填进来（它们在本机当然
        // 不是绝对路径）。省略 local_path 可自动存到系统下载目录。
        return Err(AppError::Agent(
            "local_path 必须是本机（运行 Marcel SSH 的电脑）的绝对路径——它是你电脑上的路径，不是服务器路径。省略 local_path 时文件会自动保存到系统下载目录。".into(),
        ));
    }

    // Windows 前缀门槛：UNC / verbatim / 设备命名空间都不接受。
    reject_non_disk_prefix(raw)?;

    // File name checks.
    let file_name = raw
        .file_name()
        .ok_or_else(|| AppError::Agent("local_path has no file name".into()))?
        .to_string_lossy()
        .to_string();
    validate_file_name(&file_name)?;

    // 符号链接判定必须在 resolve **之前**、用**原始**路径做：
    // `resolve_against_ancestors` 对已存在的叶子会 canonicalize，链接会被解析
    // 成它的目标（普通文件/目录），之后再 `symlink_metadata` 永远看不到链接
    // 本身——此前正是这个顺序让「拒绝覆盖符号链接」成了死代码。
    if let Ok(meta) = fs::symlink_metadata(raw).await {
        if meta.file_type().is_symlink() {
            return Err(AppError::Agent(format!(
                "local_path 是一个符号链接，拒绝覆盖（先删除链接或换一个普通文件路径）：{}",
                raw.display()
            )));
        }
    }

    // Resolve safely.
    let resolved = resolve_against_ancestors(raw)?;

    // Blacklist check: reject any resolved path that falls under (or equals)
    // a blacklisted prefix. This covers both the target file itself and any
    // ancestor directory that would be auto-created.
    if blacklisted(&resolved, &policy.blacklist) {
        return Err(AppError::Agent(format!(
            "local_path falls under a protected system location: {}",
            resolved.display()
        )));
    }

    // Existing-target handling. 叶子形态（symlink）已在上面按原始路径判过；
    // 这里 resolved 的叶子一定是非链接（要么原本不存在，要么上面已拒绝）。
    if let Ok(meta) = fs::symlink_metadata(&resolved).await {
        let ft = meta.file_type();
        if ft.is_dir() {
            return Err(AppError::Agent("refusing to overwrite a directory".into()));
        }
        if !overwrite {
            return Err(AppError::Agent(format!(
                "本地文件已存在且未允许覆盖（未显式传 overwrite=true）：{}",
                resolved.display()
            )));
        }
    }

    Ok(resolved)
}

/// Validate a local file path for upload: absolute, exists, is a regular
/// file, and does not fall under a protected system location.
/// 产品决策：上传源不再限制在 home / 下载沙箱内——绝对路径 + 非黑名单即可。
async fn validate_local_upload_path(p: &Path) -> Result<(), AppError> {
    if !p.is_absolute() {
        // 语义提示：local_path 是本机文件路径（运行 Marcel SSH 的电脑），不是
        // 服务器路径。若想从服务器取文件再传，先 download_file 到本机。
        return Err(AppError::Agent(
            "local_path 必须是本机（运行 Marcel SSH 的电脑）上已存在文件的绝对路径——它读的是你电脑上的文件，不是服务器文件。".into(),
        ));
    }
    reject_non_disk_prefix(p)?;
    let meta = fs::metadata(p)
        .await
        .map_err(|e| AppError::Agent(format!("本地文件不可访问: {}", e)))?;
    if !meta.is_file() {
        return Err(AppError::Agent("路径不是普通文件".into()));
    }

    let canon = std::fs::canonicalize(p)
        .map_err(|e| AppError::Agent(format!("canonicalize 失败: {}", e)))?;

    let sandbox = LocalPathPolicy::default_policy();

    // Reject sensitive subtrees even for reads (keys, secrets).
    if blacklisted(&canon, &sandbox.blacklist) {
        return Err(AppError::Agent(format!(
            "upload source falls under a protected location: {}",
            canon.display()
        )));
    }
    Ok(())
}

pub(crate) async fn local_file_size(p: &Path) -> Result<u64, AppError> {
    let meta = fs::metadata(p)
        .await
        .map_err(|e| AppError::Agent(format!("local file inaccessible: {}", e)))?;
    if !meta.is_file() {
        return Err(AppError::Agent(format!(
            "local path is not a regular file: {}",
            p.display()
        )));
    }
    Ok(meta.len())
}

// ─────────────── 本地一侧的取值方式：local_path vs user_pick ───────────────

/// `user_pick=true` 与 `local_path` 同时给出的拒绝文案（两个工具共用一条语义：
/// 本机一侧要么 agent 给路径、要么弹窗让用户选，不能混用）。
const LOCAL_SIDE_CONFLICT: &str =
    "local_path 与 user_pick=true 只能二选一：要么自己指定本机绝对路径，要么弹窗让用户选，不要同时传。";

/// `user_pick=true` 且用户取消时的失败文案（附下一步指引）。
fn user_pick_cancelled() -> String {
    "用户在系统文件对话框中取消了选择，未执行任何传输。可改传显式 local_path 重试，\
     或先调用 ask_user 工具与用户确认本机路径。"
        .to_string()
}

/// `user_pick=true` 但对话框没能弹出 / 返回值无法转成本机路径时的失败文案。
///
/// 必须与 [`user_pick_cancelled`] 区分：两者都拿不到路径，但下一步动作完全
/// 相反——「用户取消」是用户的选择（该去问用户 / 换路径），「弹窗失败」是
/// 环境问题（该重试或让用户手写路径）。此前 `.await.ok().flatten()` 把
/// `JoinError`、`into_path` 失败与用户取消压成同一个 `None`，模型一律被告知
/// 「用户取消了选择」——真实原因被吞掉，模型还会去追问一个根本没做选择的人。
fn user_pick_failed(err: &str) -> String {
    format!(
        "系统文件对话框未能返回本机路径（不是用户取消，是弹窗/取路径失败）：{}。\
         可改传显式 local_path 重试，或先调用 ask_user 工具与用户确认本机路径。",
        err
    )
}

/// 本地一侧（上传的源文件 / 下载的落点）由谁决定。
#[derive(Debug, PartialEq, Eq)]
enum LocalSide {
    /// 参数显式给了本机绝对路径。
    Given(PathBuf),
    /// `user_pick=true`：弹系统对话框让用户亲自选。
    UserPick,
    /// `user_pick=true` 与 `local_path` 同时出现——互斥，必须拒绝。
    Conflict,
    /// 两者都没有。
    Missing,
}

/// 从工具参数解析本地一侧的取值方式（纯函数，单测覆盖互斥矩阵）。
/// 参数名不可叫 `ask_user`——那已是问询工具的名字。
fn resolve_local_side(params: &serde_json::Value) -> LocalSide {
    let given = params
        .get("local_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let pick = params
        .get("user_pick")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    match (pick, given) {
        (true, Some(_)) => LocalSide::Conflict,
        (true, None) => LocalSide::UserPick,
        (false, Some(p)) => LocalSide::Given(PathBuf::from(p)),
        (false, None) => LocalSide::Missing,
    }
}

/// `user_pick` 上传：弹系统文件选择框让用户挑本机源文件（单选、不过滤类型）。
///
/// `Ok(None)` = 用户在对话框里点了取消；`Err` = 弹窗/取路径失败（两者语义不同，
/// 见 [`user_pick_failed`]）。阻塞式对话框会卡住调用线程，必须用 spawn_blocking
/// 离开 tokio 工作线程。
async fn ask_user_pick_upload_source(app: &tauri::AppHandle) -> Result<Option<PathBuf>, String> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        match app
            .dialog()
            .file()
            .set_title("选择要上传到服务器的文件")
            .blocking_pick_file()
        {
            None => Ok(None),
            Some(fp) => fp
                .into_path()
                .map(Some)
                .map_err(|e| format!("无法把对话框返回值转成本机路径: {}", e)),
        }
    })
    .await
    .map_err(|e| format!("文件对话框任务异常退出: {}", e))?
}

/// `user_pick` 下载：弹系统保存对话框让用户选落点，预填远端文件名。
async fn ask_user_pick_download_target(
    app: &tauri::AppHandle,
    suggested_name: String,
) -> Result<Option<PathBuf>, String> {
    let app = app.clone();
    tokio::task::spawn_blocking(move || {
        match app
            .dialog()
            .file()
            .set_title("选择保存位置")
            .set_file_name(suggested_name)
            .blocking_save_file()
        {
            None => Ok(None),
            Some(fp) => fp
                .into_path()
                .map(Some)
                .map_err(|e| format!("无法把对话框返回值转成本机路径: {}", e)),
        }
    })
    .await
    .map_err(|e| format!("文件对话框任务异常退出: {}", e))?
}

// ────────────────────────────── UploadFileTool ──────────────────────────────

pub struct UploadFileTool;
impl UploadFileTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for UploadFileTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract the final path segment of a remote path (basename). Handles both
/// `/` and `\` separators; returns None for paths ending in a separator.
fn remote_file_name(remote: &str) -> Option<String> {
    let trimmed = remote.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        return None;
    }
    let idx = trimmed.rfind(['/', '\\']).map(|i| i + 1).unwrap_or(0);
    Some(trimmed[idx..].to_string())
}

/// 探测 `path` 在远端是否为已存在的目录。
/// `metadata` 失败（不存在 / stat 错误）一律按非目录处理——目标若是要新建的
/// 文件路径，stat 失败正是预期；真正不可达的错误会由后续写操作自己报出。
async fn remote_is_dir(sftp: &russh_sftp::client::SftpSession, path: &str) -> bool {
    match sftp.metadata(path).await {
        Ok(m) => m.is_dir(),
        Err(_) => false,
    }
}

/// 校验 upload_file 的 `remote_path`：复用用户 SFTP 面板那条链的既有校验
/// （[`crate::util::validate_sftp_remote_path`]：必须是服务器绝对路径、不含 `..`），
/// 并返回归一化形态（折叠 `//`）。错误文案里带上是哪一条不合格，模型好改。
fn validate_upload_remote_path(remote_path: &str) -> Result<String, AppError> {
    match crate::util::validate_sftp_remote_path(remote_path) {
        Ok(p) => Ok(p),
        Err(e) => {
            // 校验失败原因就写在 AppError::Ssh 的文案里（中文、可直接展示），
            // 不要整段 to_string 带出 "SSH error:" 前缀。
            let reason = match e {
                AppError::Ssh(m) => m,
                other => other.to_string(),
            };
            Err(AppError::Agent(format!(
                "remote_path 非法（{}）：remote_path 是**服务器**上的路径，必须是绝对路径\
                 （以 / 开头）、不能包含 `..`（路径穿越）或空字节。目录可写成 \
                 /home/user/uploads/。当前值: {:?}",
                reason, remote_path
            )))
        }
    }
}

/// 校验 upload_file 的 `file_name` 参数（远端重命名用）：只接受单个文件名。
/// 它会被拼到 `remote_path` 声称的目录后面，`../../etc/cron.d/x`、
/// `sub/x` 或 `/etc/passwd` 这类值都能让落点越出模型声称的目录（远端服务器
/// 会解析 `..`），必须在拼之前拒绝。
fn validate_upload_remote_file_name(name: &str) -> Result<(), AppError> {
    // 远端可能是 POSIX 也可能是 Windows 服务器：两种分隔符都当目录成分拒掉
    // （本机校验器只在 Windows 上拒 `\`，这里不能依赖平台）。
    if name.contains('/') || name.contains('\\') {
        return Err(AppError::Agent(format!(
            "file_name 非法（含路径分隔符）：它只能是**单个文件名**，目录部分请写在 \
             remote_path 里。当前值: {:?}",
            name
        )));
    }
    match validate_file_name(name) {
        Ok(()) => Ok(()),
        Err(e) => {
            let reason = match e {
                AppError::Agent(m) => m,
                other => other.to_string(),
            };
            Err(AppError::Agent(format!(
                "file_name 非法（{}）：它只能是**单个文件名**（不含 `/`、`\\`、`..`），\
                 目录部分请写在 remote_path 里；想改文件名用 `新名字.txt` 这种纯文件名。\
                 当前值: {:?}",
                reason, name
            )))
        }
    }
}

/// 解析上传的最终远端目标。
///
/// 规则（消除「目录还是完整文件路径」的猜测）：
/// - 显式给了 `file_name` → `remote_path` 一律按目录处理，拼上 `file_name`；
/// - 否则以 `/` 结尾 → 目录，拼本地原名；
/// - 否则**探测远端**：
///   - `remote_path` 是已存在目录 → 拼本地原名（兼容用户给目录不带尾斜杠）；
///   - 否则 → `remote_path` 本身就是完整目标文件路径（新建或覆盖该文件）。
async fn resolve_upload_remote_path(
    sftp: &russh_sftp::client::SftpSession,
    local_path_buf: &Path,
    remote_path: &str,
    params: &serde_json::Value,
) -> Result<String, AppError> {
    let local_name = local_path_buf
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "upload".to_string());

    // file_name 显式给定：remote_path 是目录。
    let explicit_name = params
        .get("file_name")
        .and_then(|v| v.as_str())
        .filter(|n| !n.is_empty());
    if let Some(name) = explicit_name {
        validate_upload_remote_file_name(name)?;
    }

    let (dir, name) = if let Some(name) = explicit_name {
        (remote_path.to_string(), name.to_string())
    } else if remote_path.ends_with('/') || remote_path.ends_with('\\') {
        (remote_path.to_string(), local_name.clone())
    } else if remote_is_dir(sftp, remote_path).await {
        // 已存在目录（不带尾斜杠）→ 当目录用。
        (format!("{}/", remote_path), local_name.clone())
    } else {
        // 不存在 / 是文件 → remote_path 本身就是完整文件路径。
        return Ok(remote_path.to_string());
    };

    let joined = if dir.ends_with('/') || dir.ends_with('\\') {
        format!("{}{}", dir, name)
    } else {
        format!("{}/{}", dir, name)
    };
    Ok(joined)
}

#[async_trait]
impl AgentTool for UploadFileTool {
    fn name(&self) -> &str {
        "upload_file"
    }

    fn description(&self) -> &str {
        "Upload a file from THIS computer (where Marcel SSH runs) to the remote server \
         (binary-safe). local_path is the absolute path of an existing file ON THIS \
         COMPUTER — not a server path (system/secret paths like ~/.ssh, /etc are \
         blocked). Alternatively pass user_pick=true (and omit local_path) to open a \
         native file picker and let the user choose the source file on this computer; \
         the call fails if the user cancels. user_pick is for single, user-in-the-loop \
         uploads only: do NOT use it for server-to-server transfers (relaying files \
         between servers through this computer) — a dialog would block the task on \
         the user mid-automation; stage with an explicit local_path or transfer with \
         scp/rsync via bash instead. remote_path is a path ON THE SERVER: give an \
         existing directory, a directory ending with '/', or a full target file path \
         (the tool probes the server: existing directories get the local file name \
         appended, anything else is treated as the exact target file path). To rename \
         on the server pass file_name. Files larger than 1 GB are refused unless you \
         pass allow_large_transfer=true: on a cloud server such a transfer can take a \
         disastrously long time, so decide first whether it is really necessary (pass \
         it directly when the user asked for this upload; not needed when the user \
         picked the file themselves via user_pick, or when the server is on your local \
         network — the prompt exists because public links are slow).\n\
         Multi-host: you may pass an optional `host` (the current machine or a \
         machine from the selected set, by its readable name) to upload to that \
         machine instead of the current one. Desktop only."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "local_path": { "type": "string", "description": "Optional if user_pick=true. Absolute path of the file to upload ON THIS COMPUTER (not the server), on a local drive (UNC/network shares are not supported). System/secret paths are rejected." },
                "user_pick": { "type": "boolean", "description": "Optional. Open a native file picker and let the user choose the source file on this computer instead of passing local_path. Mutually exclusive with local_path; the call fails if the user cancels. Single user-in-the-loop uploads only — never for server-to-server transfers (relaying files between servers through this computer): stage with an explicit local_path or use bash scp/rsync there.", "default": false },
                "remote_path": { "type": "string", "description": "Required. Absolute destination ON THE SERVER (must start with '/'; '..' is rejected): an existing directory, a directory ending with '/', or the full target file path. Existing directories get the local file name appended; otherwise the path is used as-is as the target file." },
                "file_name": { "type": "string", "description": "Optional. Rename the uploaded file on the server. A single file name only — no '/', '\\\\' or '..' (put directories in remote_path). When given, remote_path is treated as a directory and file_name is appended." },
                "allow_large_transfer": { "type": "boolean", "description": "Optional. Files larger than 1 GB are refused unless you pass true here: on a cloud server such a transfer can take a disastrously long time, so decide first whether it is really necessary. Pass true to proceed — do it directly when the user asked for this upload. Not needed when the user picked the file themselves via user_pick.", "default": false },
                "host": { "type": "string", "description": format!("Optional. Target machine's readable name: the current machine or one from the multi-host selected set. When omitted, uploads to the current session's machine. Desktop only. {}", super::HOST_MATCH_RULE) }
            },
            "required": ["remote_path"]
        })
    }

    fn disposition(&self) -> Disposition {
        Disposition::Approval
    }

    async fn execute(
        &self,
        mut params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        // ── 多机操控：host 参数 → 目标机器会话 ──
        // 命中 host 时解析目标会话：不同机则 fork ctx 换 session，并从 params
        // 移除 host 后递归执行一次（无 host → 原逻辑），避免无限递归。
        if let Some(host) = crate::multi_host::optional_host(&params) {
            let task_id = ctx.task_id.clone().unwrap_or_default();
            if task_id.is_empty() {
                return Ok(ToolOutput::fail(
                    "upload_file",
                    "多机执行需要任务上下文（缺少 task_id）",
                ));
            }
            let resolved = crate::multi_host::resolve_target(
                &ctx.app_handle,
                &host,
                &task_id,
                &ctx.session_id,
            )
            .await?;
            if let Some(obj) = params.as_object_mut() {
                obj.remove("host");
            }
            // 换机执行：fork_to 携带目标机器展示名（传输条目/结果归属展示）。
            let target_ctx = ctx.fork_to(&resolved.session_id, &resolved.host_label);
            return self.execute(params, &target_ctx).await;
        }
        upload_execute(ctx, params).await
    }
}

/// UploadFileTool 无 host 时的执行主体（ctx = 目标会话上下文）。
/// 独立自由函数以便 [`AgentTool::execute`] 内联调用（trait 块内不得有
/// 非 trait 方法）。
async fn upload_execute(
    ctx: &ToolContext,
    params: serde_json::Value,
) -> Result<ToolOutput, AppError> {
    let remote_path = params
        .get("remote_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Agent("Missing 'remote_path' parameter".into()))?;
    if remote_path.is_empty() {
        return Ok(ToolOutput::fail("upload_file", "empty remote_path"));
    }
    // remote_path 与用户 SFTP 面板走同一条校验（绝对路径、无 `..`）：否则
    // `../x` 这类相对路径会落到远端 SFTP 的当前目录，与工具描述承诺的
    // 「服务器上的路径」不是一回事。
    let remote_path = match validate_upload_remote_path(remote_path) {
        Ok(p) => p,
        Err(e) => return Ok(ToolOutput::fail("upload_file", e.to_string())),
    };

    // 本机源：显式 local_path 或 user_pick 弹窗（互斥，见 resolve_local_side）。
    let local_side = resolve_local_side(&params);
    // 用户在原生对话框里亲自挑的源文件 = 明确授权，不再要求模型确认体积。
    let user_picked = matches!(local_side, LocalSide::UserPick);
    let local_path_buf = match local_side {
        LocalSide::Given(p) => p,
        LocalSide::UserPick => match ask_user_pick_upload_source(&ctx.app_handle).await {
            Ok(Some(p)) => p,
            Ok(None) => return Ok(ToolOutput::fail("upload_file", user_pick_cancelled())),
            Err(e) => return Ok(ToolOutput::fail("upload_file", user_pick_failed(&e))),
        },
        LocalSide::Conflict => return Ok(ToolOutput::fail("upload_file", LOCAL_SIDE_CONFLICT)),
        LocalSide::Missing => {
            return Err(AppError::Agent("Missing 'local_path' parameter".into()));
        }
    };
    if let Err(e) = validate_local_upload_path(&local_path_buf).await {
        return Ok(ToolOutput::fail("upload_file", e.to_string()));
    }

    let size = match local_file_size(&local_path_buf).await {
        Ok(n) => n,
        Err(e) => {
            return Ok(ToolOutput::fail(
                format!("upload {}", local_path_buf.display()),
                e.to_string(),
            ))
        }
    };
    // 内网/本机目标不打扰：闸门只在公网目标上生效。
    if large_transfer_needs_confirmation(ctx, size, allow_large_transfer(&params), user_picked)
        .await
    {
        return Ok(ToolOutput::fail(
            format!("upload {}", local_path_buf.display()),
            large_upload_notice(size),
        ));
    }

    // ── 统一传输体系接入：与用户 SFTP 面板共用同一流式核心；传输在
    //    传输中心可见（agent 条目）、可取消；多 agent 传输互斥（一次一个）。──
    let state = ctx.app_handle.state::<crate::AppState>();
    let state: crate::AppState = state.inner().clone();
    let transfer_id = crate::agent::transfer::new_transfer_id();
    let task_id = ctx.task_id.clone().unwrap_or_default();

    // 打开本地文件（流式读，不再整块读进内存）。
    let mut local_file = match tokio::fs::File::open(&local_path_buf).await {
        Ok(f) => f,
        Err(e) => {
            return Ok(ToolOutput::fail(
                format!("upload {}", local_path_buf.display()),
                format!("local open failed: {}", e),
            ))
        }
    };

    let file_name = local_path_buf
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "upload".to_string());

    // 先打开 SFTP：失败就不建传输条目，避免条目悬挂在 active；且目标路径的
    // 目录/文件判定需要 sftp 探测。
    let sftp = match ctx.ssh.open_sftp(&ctx.session_id).await {
        Ok(s) => s,
        Err(e) => {
            return Ok(ToolOutput::fail(
                format!("upload {}", remote_path),
                format!("SFTP unavailable: {}", e),
            ))
        }
    };

    // 解析最终远端目标（探测式：remote_path 是目录还是完整文件路径）。
    let final_remote =
        match resolve_upload_remote_path(&sftp, &local_path_buf, &remote_path, &params).await {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolOutput::fail("upload_file", e.to_string()));
            }
        };

    // 取消 watch 注册进统一取消表（前端传输中心「取消」按钮按 id 触发）。
    let _cancel_registration = state.upload_cancel.register(&transfer_id);
    let mut cancel_rx = _cancel_registration.receiver();

    // 记账（任务终态级联取消用）+ 互斥锁（多 agent 传输一次一个）。
    //
    // `register_transfer` 返回 false = 任务已经收尾（级联取消跑在了记账前面）：
    // 表里没有这一条，没人会替我们取消这次传输 —— 任务已停止，传输却继续跑。
    // 此刻还没 emit_start（传输中心条目尚未创建），直接放弃最干净；返回时
    // `_cancel_registration` 随之 Drop，取消通道也一并注销。
    if !task_id.is_empty()
        && !crate::agent::transfer::register_transfer(&state, &task_id, &transfer_id).await
    {
        log::info!(
            "agent_transfer: 任务 {} 已结束，放弃本次传输 {}",
            task_id,
            transfer_id
        );
        return Ok(ToolOutput::fail("upload_file", "任务已结束，未开始传输。"));
    }
    let _mutex = crate::agent::transfer::acquire_mutex(&state).await;

    // 通知前端创建传输中心条目（source=agent）。
    crate::agent::transfer::emit_start(
        &ctx.app_handle,
        &crate::agent::transfer::AgentTransferStartPayload {
            transfer_id: transfer_id.clone(),
            kind: "upload".to_string(),
            session_id: ctx.session_id.clone(),
            file_name: file_name.clone(),
            local_path: local_path_buf.display().to_string(),
            remote_path: final_remote.clone(),
            total: size,
            task_id: task_id.clone(),
            target_host_label: ctx.target_host_label.clone(),
        },
    );

    // 共享流式核心：sidecar 临时文件 + 进度事件 + 取消 + 完整性校验 + 原子提交。
    let result = crate::commands::sftp::stream_upload_single_file(
        Some(&ctx.app_handle),
        &sftp,
        &mut local_file,
        size,
        true,
        &final_remote,
        &transfer_id,
        &mut cancel_rx,
        None,
    )
    .await;

    if !task_id.is_empty() {
        crate::agent::transfer::cancel_transfer_record(&state, &transfer_id).await;
    }

    // 通知前端传输中心条目终态（agent 条目不经前端 scheduler，终态必须
    // 后端显式通知，否则条目永久停在 active）。
    let finished_status;
    let finished_message;
    let outcome = match result {
        Ok(()) => {
            finished_status = "done";
            finished_message = None;
            let mut meta = json!({
                "local_path": local_path_buf.display().to_string(),
                "remote_path": final_remote,
                "bytes": size,
            });
            if let (Some(obj), Some(label)) = (meta.as_object_mut(), &ctx.target_host_label) {
                obj.insert("targetHostLabel".to_string(), json!(label));
            }
            Ok(ToolOutput::ok(
                format!("upload {} ({} bytes)", final_remote, size),
                format!(
                    "uploaded {} bytes: {} -> remote:{}",
                    size,
                    local_path_buf.display(),
                    final_remote
                ),
            )
            .with_metadata(meta))
        }
        Err(e) => {
            let msg = e.to_string();
            if msg.contains("取消") {
                finished_status = "cancelled";
                finished_message = Some(msg.clone());
                Ok(ToolOutput::fail(
                    format!("upload {}", final_remote),
                    format!("上传已取消: {}", msg),
                ))
            } else {
                finished_status = "error";
                finished_message = Some(msg.clone());
                // 可操作指引：把「远端目标不可达/已存在」类失败翻译成下一步
                // 该怎么做的提示，避免只丢一句底层 No such file。
                let hint = upload_error_hint(&msg, &final_remote);
                Ok(ToolOutput::fail(
                    format!("upload {}", final_remote),
                    if hint.is_empty() {
                        format!("transfer failed: {}", msg)
                    } else {
                        format!("{}\n{}", msg, hint)
                    },
                ))
            }
        }
    };
    crate::agent::transfer::emit_finished(
        &ctx.app_handle,
        &crate::agent::transfer::AgentTransferFinishedPayload {
            transfer_id: transfer_id.clone(),
            status: finished_status.to_string(),
            message: finished_message,
        },
    );
    outcome
}

/// 把上传失败翻译成「下一步怎么做」的提示；无匹配时返回空串。
fn upload_error_hint(msg: &str, final_remote: &str) -> String {
    // 远端目标目录不存在：sidecar 创建会报 No such file / 打开远程文件失败。
    let dir_missing = msg.contains("No such file")
        || msg.contains("no such file")
        || msg.contains("打开远程文件失败")
        || msg.contains("File not found");
    // 远端已存在同名文件/目录（commit 拒绝覆盖）。
    let exists =
        msg.contains("已存在") || msg.contains("同名目录") || msg.contains("already exists");
    if dir_missing {
        return format!(
            "目标服务器目录可能不存在。若 remote_path 的父目录不存在，请先用 bash 执行 \
             `mkdir -p <父目录>` 创建目录后再上传；或确认 remote_path 给的是完整文件路径 \
             （父目录已存在）而不是不存在的目录。当前目标: {}",
            final_remote
        );
    }
    if exists {
        return format!(
            "目标文件在服务器上已存在且未允许覆盖。可改用 bash 先删除/重命名远端文件，\
             或上传到新路径/新文件名。当前目标: {}",
            final_remote
        );
    }
    String::new()
}

// ────────────────────────────── DownloadFileTool ──────────────────────────────

pub struct DownloadFileTool;
impl DownloadFileTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for DownloadFileTool {
    fn default() -> Self {
        Self::new()
    }
}

/// Ensure the target's parent directories exist, auto-creating them as
/// needed. Rejects parents that fall under a protected system location.
pub(crate) async fn ensure_parent_creatable(
    resolved: &Path,
    policy: &LocalPathPolicy,
) -> Result<(), String> {
    let Some(parent) = resolved.parent() else {
        return Ok(());
    };
    if parent.as_os_str().is_empty() {
        return Ok(());
    }
    // Resolve the nearest existing ancestor first so symlinked/..-tricky
    // parents are checked against the blacklist too.
    let resolved_parent = resolve_against_ancestors(parent)
        .map_err(|e| format!("local path resolution failed: {}", e))?;
    if blacklisted(&resolved_parent, &policy.blacklist) {
        return Err("refusing to create directories under a protected system location".into());
    }
    if !parent.exists() {
        fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("local mkdir failed: {}", e))?;
    }
    Ok(())
}

#[async_trait]
impl AgentTool for DownloadFileTool {
    fn name(&self) -> &str {
        "download_file"
    }

    fn description(&self) -> &str {
        "Download a remote file from the server to THIS computer (where Marcel SSH \
         runs, binary-safe). local_path is the absolute save path ON THIS COMPUTER — \
         not a server path. It is OPTIONAL: when omitted the file is saved to the \
         system Downloads folder with the remote file name (the actual local path is \
         reported back in the result). Alternatively pass user_pick=true (and omit \
         local_path) to open a native save dialog and let the user choose where to \
         save (prefilled with the remote file name; the call fails if the user \
         cancels). user_pick is for single, user-in-the-loop downloads only: do NOT \
         use it for server-to-server transfers (relaying files between servers \
         through this computer) — a dialog would block the task on the user \
         mid-automation; stage with an explicit local_path or transfer with \
         scp/rsync via bash instead. System/secret local paths (/, ~/.ssh, System32) \
         are blocked. Existing files are not overwritten unless overwrite=true (when \
         user_pick is on, replacing an existing file confirmed by the user in the \
         save dialog counts as overwrite). Files larger than 1 GB are refused unless \
         you pass allow_large_transfer=true: on a cloud server such a transfer can take \
         a disastrously long time, so decide first whether it is really necessary (pass \
         it directly when the user asked for this download; user_pick does NOT waive \
         this — the save dialog only chooses where to put it; it is also not needed \
         when the server is on your local network, since the prompt exists because \
         public links are slow).\n\
         Multi-host: you may pass an optional `host` (the current machine or a \
         machine from the selected set, by its readable name) to download from \
         that machine instead of the current one. Desktop only."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "remote_path": { "type": "string", "description": "Required. Absolute path of the remote file on the server to download" },
                "local_path":  { "type": "string", "description": "Optional. Absolute save path ON THIS COMPUTER (not the server), on a local drive (UNC/network shares are not supported). Omit to save to the system Downloads folder with the remote file name. Mutually exclusive with user_pick. System/secret paths are rejected." },
                "user_pick": { "type": "boolean", "description": "Optional. Open a native save dialog and let the user choose where to save (prefilled with the remote file name) instead of passing local_path. Mutually exclusive with local_path; the call fails if the user cancels. Single user-in-the-loop downloads only — never for server-to-server transfers (relaying files between servers through this computer): stage with an explicit local_path or use bash scp/rsync there.", "default": false },
                "overwrite": { "type": "boolean", "description": "If true, overwrite an existing regular file. Symlinks and directories are never overwritten. Default: false.", "default": false },
                "allow_large_transfer": { "type": "boolean", "description": "Optional. Files larger than 1 GB are refused unless you pass true here: on a cloud server such a transfer can take a disastrously long time, so decide first whether it is really necessary. Pass true to proceed — do it directly when the user asked for this download. user_pick does NOT waive this (the save dialog only chooses where to put it).", "default": false },
                "host": { "type": "string", "description": format!("Optional. Target machine's readable name: the current machine or one from the multi-host selected set. When omitted, downloads from the current session's machine. Desktop only. {}", super::HOST_MATCH_RULE) }
            },
            "required": ["remote_path"]
        })
    }

    fn disposition(&self) -> Disposition {
        Disposition::Approval
    }

    async fn execute(
        &self,
        mut params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        // ── 多机操控：host 参数 → 目标机器会话 ──
        if let Some(host) = crate::multi_host::optional_host(&params) {
            let task_id = ctx.task_id.clone().unwrap_or_default();
            if task_id.is_empty() {
                return Ok(ToolOutput::fail(
                    "download_file",
                    "多机执行需要任务上下文（缺少 task_id）",
                ));
            }
            let resolved = crate::multi_host::resolve_target(
                &ctx.app_handle,
                &host,
                &task_id,
                &ctx.session_id,
            )
            .await?;
            if let Some(obj) = params.as_object_mut() {
                obj.remove("host");
            }
            let target_ctx = ctx.fork_to(&resolved.session_id, &resolved.host_label);
            return self.execute(params, &target_ctx).await;
        }
        download_execute(ctx, params).await
    }
}

/// DownloadFileTool 无 host 时的执行主体（ctx = 目标会话上下文）。
async fn download_execute(
    ctx: &ToolContext,
    params: serde_json::Value,
) -> Result<ToolOutput, AppError> {
    let remote_path = params
        .get("remote_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Agent("Missing 'remote_path' parameter".into()))?;
    if remote_path.is_empty() {
        return Ok(ToolOutput::fail("download_file", "empty remote_path"));
    }

    let overwrite = params
        .get("overwrite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let policy = LocalPathPolicy::default_policy();
    let suggested_name = remote_file_name(remote_path).unwrap_or_else(|| "download".to_string());

    // 先探测远端文件与大小（在碰本机一侧之前）：文件不存在 / 不是普通文件 /
    // 超过 1GB 且模型没有确认时直接失败，不让用户先白选一次保存位置。
    let sftp = match ctx.ssh.open_sftp(&ctx.session_id).await {
        Ok(s) => s,
        Err(e) => {
            return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!("SFTP unavailable: {}", e),
            ))
        }
    };
    let meta = match sftp.metadata(remote_path).await {
        Ok(m) => m,
        Err(e) => {
            return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!("获取远程文件信息失败: {}", e),
            ))
        }
    };
    if !meta.is_regular() {
        return Ok(ToolOutput::fail(
            format!("download {}", remote_path),
            "只能下载普通文件".to_string(),
        ));
    }
    let total = meta.len();
    // 下载不做 user_pick 豁免：保存对话框选的是落点，不等于「这么大也值得下载」。
    // 内网/本机目标不打扰（闸门只在公网目标上生效）。
    if large_transfer_needs_confirmation(ctx, total, allow_large_transfer(&params), false).await {
        return Ok(ToolOutput::fail(
            format!("download {}", remote_path),
            large_download_notice(total),
        ));
    }

    // 落点三选一：显式 local_path / user_pick 弹窗 / 省略落系统 Downloads。
    // user_pick 时用户已在系统保存对话框里亲自确认「替换已有文件」，validation
    // 直接放行 overwrite（黑名单、symlink/目录拒绝照常生效）。
    let picked_by_user;
    let raw_target = match resolve_local_side(&params) {
        LocalSide::Given(p) => {
            picked_by_user = false;
            p
        }
        LocalSide::UserPick => {
            picked_by_user = true;
            match ask_user_pick_download_target(&ctx.app_handle, suggested_name).await {
                Ok(Some(p)) => p,
                Ok(None) => return Ok(ToolOutput::fail("download_file", user_pick_cancelled())),
                Err(e) => return Ok(ToolOutput::fail("download_file", user_pick_failed(&e))),
            }
        }
        LocalSide::Conflict => return Ok(ToolOutput::fail("download_file", LOCAL_SIDE_CONFLICT)),
        LocalSide::Missing => {
            // 省略 local_path：落到系统 Downloads 目录（解析失败退回 home）。
            picked_by_user = false;
            let Some(download_dir) = LocalPathPolicy::default_download_dir() else {
                return Ok(ToolOutput::fail(
                    "download_file",
                    "无法确定系统下载目录（Downloads 与 home 均不可用），请显式传 local_path",
                ));
            };
            download_dir.join(&suggested_name)
        }
    };
    let overwrite = overwrite || picked_by_user;
    let resolved = match validate_local_download_path(&raw_target, overwrite, &policy).await {
        Ok(r) => r,
        Err(e) => return Ok(ToolOutput::fail("download_file", e.to_string())),
    };

    if let Err(e) = ensure_parent_creatable(&resolved, &policy).await {
        return Ok(ToolOutput::fail(format!("download {}", remote_path), e));
    }

    // ── 统一传输体系接入：与用户 SFTP 面板共用同一流式核心；传输在
    //    传输中心可见（agent 条目）、可取消；多 agent 传输互斥（一次一个）。──
    let state = ctx.app_handle.state::<crate::AppState>();
    let state: crate::AppState = state.inner().clone();
    let transfer_id = crate::agent::transfer::new_transfer_id();
    let task_id = ctx.task_id.clone().unwrap_or_default();

    // 数据面换独占的裸会话（并发预取 READ，见 stream_remote_to_local_file）；
    // 上面的高层会话只干了 stat。打开失败在真正开始传输前就拦下。
    let (raw, read_chunk) = match ctx.ssh.open_sftp_raw(&ctx.session_id).await {
        Ok(pair) => pair,
        Err(e) => {
            return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!("SFTP unavailable: {}", e),
            ))
        }
    };
    let raw = std::sync::Arc::new(raw);
    let remote_handle = match raw
        .open(
            remote_path,
            OpenFlags::READ,
            russh_sftp::protocol::FileAttributes::default(),
        )
        .await
    {
        Ok(h) => h.handle,
        Err(e) => {
            return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!("打开远程文件失败: {}", e),
            ))
        }
    };
    let file_name = resolved
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "download".to_string());

    // 取消 watch 注册进统一取消表（前端传输中心「取消」按钮按 id 触发）。
    let _cancel_registration = state.download_cancel.register(&transfer_id);
    let mut cancel_rx = _cancel_registration.receiver();

    // 记账（任务终态级联取消用）+ 互斥锁（多 agent 传输一次一个）。
    //
    // `register_transfer` 返回 false = 任务已经收尾（级联取消跑在了记账前面）：
    // 表里没有这一条，没人会替我们取消这次传输 —— 任务已停止，传输却继续跑。
    // 此刻还没 emit_start（传输中心条目尚未创建），直接放弃最干净；返回时
    // `_cancel_registration` 随之 Drop，取消通道也一并注销。
    if !task_id.is_empty()
        && !crate::agent::transfer::register_transfer(&state, &task_id, &transfer_id).await
    {
        log::info!(
            "agent_transfer: 任务 {} 已结束，放弃本次传输 {}",
            task_id,
            transfer_id
        );
        return Ok(ToolOutput::fail(
            "download_file",
            "任务已结束，未开始传输。",
        ));
    }
    let _mutex = crate::agent::transfer::acquire_mutex(&state).await;

    // 通知前端创建传输中心条目（source=agent）。
    crate::agent::transfer::emit_start(
        &ctx.app_handle,
        &crate::agent::transfer::AgentTransferStartPayload {
            transfer_id: transfer_id.clone(),
            kind: "download".to_string(),
            session_id: ctx.session_id.clone(),
            file_name: file_name.clone(),
            local_path: resolved.display().to_string(),
            remote_path: remote_path.to_string(),
            total,
            task_id: task_id.clone(),
            target_host_label: ctx.target_host_label.clone(),
        },
    );

    // 共享流式核心：.part 临时文件 + 进度事件 + 取消 + 完整性校验 + 原子替换。
    let result = crate::commands::sftp::stream_download_single_file(
        Some(&ctx.app_handle),
        raw,
        &remote_handle,
        read_chunk,
        total,
        &resolved.display().to_string(),
        &transfer_id,
        &mut cancel_rx,
        overwrite,
        None,
    )
    .await;

    if !task_id.is_empty() {
        crate::agent::transfer::cancel_transfer_record(&state, &transfer_id).await;
    }

    // 通知前端传输中心条目终态（agent 条目不经前端 scheduler，终态必须
    // 后端显式通知，否则条目永久停在 active）。
    let finished_status;
    let finished_message;
    let outcome = match result {
        Ok(()) => {
            finished_status = "done";
            finished_message = None;
            let mut meta_out = json!({
                "remote_path": remote_path,
                "local_path": resolved.display().to_string(),
                "bytes": total,
                "overwrite": overwrite,
            });
            if let (Some(obj), Some(label)) = (meta_out.as_object_mut(), &ctx.target_host_label) {
                obj.insert("targetHostLabel".to_string(), json!(label));
            }
            Ok(ToolOutput::ok(
                format!("download {} ({} bytes)", remote_path, total),
                format!(
                    "downloaded {} bytes: remote:{} -> {}",
                    total,
                    remote_path,
                    resolved.display()
                ),
            )
            .with_metadata(meta_out))
        }
        Err(e) => {
            let msg = e.to_string();
            // 取消 watch 置位 = 用户取消（含任务级联取消）；「未允许覆盖」等
            // 策略拒绝不是用户取消，归 error 而非 cancelled（此前把含「覆盖」
            // 的文案误判为取消，传输中心显示灰色「已取消」语义错误）。
            let is_cancel = is_download_cancel(&msg);
            finished_status = if is_cancel { "cancelled" } else { "error" };
            finished_message = Some(msg.clone());
            if is_cancel {
                Ok(ToolOutput::fail(
                    format!("download {}", remote_path),
                    format!("下载未完成: {}", msg),
                ))
            } else {
                // 远端取文件失败时点明 remote_path 是服务器路径、可省略 local_path。
                let local_hint =
                    "提示：remote_path 是服务器上的路径；local_path（本机保存路径）可省略，省略时自动存到系统下载目录。";
                Ok(ToolOutput::fail(
                    format!("download {}", remote_path),
                    format!("{}\n{}", msg, local_hint),
                ))
            }
        }
    };
    crate::agent::transfer::emit_finished(
        &ctx.app_handle,
        &crate::agent::transfer::AgentTransferFinishedPayload {
            transfer_id: transfer_id.clone(),
            status: finished_status.to_string(),
            message: finished_message,
        },
    );
    outcome
}

/// 判断下载失败文案是否为「用户/任务取消」。
/// 「未允许覆盖」「已存在」等策略拒绝**不是**取消——此前把含「覆盖」的文案
/// 也判成取消，导致传输中心把策略拒绝显示为灰色「已取消」。
fn is_download_cancel(msg: &str) -> bool {
    msg.contains("取消") && !msg.contains("未允许覆盖")
}

// ────────────────────────────────── tests ──────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::base64;
    use tempfile::TempDir;

    #[test]
    fn local_b64_roundtrip() {
        let data = b"\x00\x01\x02binary\xff\xfe test";
        let enc = base64::b64_encode(data);
        assert_eq!(base64::b64_decode(&enc).unwrap(), data);
    }

    /// 无黑名单 policy：用于验证「任意非系统绝对路径可作下载落点/上传源」。
    /// TempDir 在 Windows 落在 %LOCALAPPDATA% 下（默认黑名单内），因此成功
    /// 路径测试必须用无黑名单 policy，避免被默认黑名单误拒。
    fn no_bl_policy() -> LocalPathPolicy {
        LocalPathPolicy::no_blacklist()
    }

    /// TempDir 的真实路径（绝对、非 verbatim，供 `..` 组件测试——canonicalize
    /// 在 Windows 会引入 `\\?\` verbatim 前缀，使 `..` 不被识别为 ParentDir）。
    fn canon_temp(td: &TempDir) -> PathBuf {
        td.path().to_path_buf()
    }

    // ── 下载落点：任意绝对非系统路径可写（不再强制沙箱） ──

    #[tokio::test]
    async fn download_any_user_path_ok() {
        let td = TempDir::new().unwrap();
        let policy = no_bl_policy();
        let target = canon_temp(&td).join("a.txt");
        let res = validate_local_download_path(&target, false, &policy).await;
        assert!(res.is_ok(), "{:?}", res);
    }

    #[tokio::test]
    async fn download_deep_subdir_ok() {
        let td = TempDir::new().unwrap();
        let policy = no_bl_policy();
        let target = canon_temp(&td).join("sub/deeper/a.txt");
        assert!(validate_local_download_path(&target, false, &policy)
            .await
            .is_ok());
    }

    // ── 黑名单仍拒绝（安全底线） ──

    #[tokio::test]
    async fn download_system_path_rejected() {
        let policy = LocalPathPolicy::default_policy();
        #[cfg(unix)]
        let p = PathBuf::from("/etc/passwd");
        #[cfg(windows)]
        let p = PathBuf::from("C:/Windows/System32/drivers/etc/hosts");
        let res = validate_local_download_path(&p, false, &policy).await;
        assert!(res.is_err(), "expected rejection, got {:?}", res);
    }

    #[tokio::test]
    async fn download_ssh_path_rejected() {
        let policy = LocalPathPolicy::default_policy();
        if let Some(home) = dirs::home_dir() {
            let p = home.join(".ssh").join("authorized_keys");
            if policy.blacklist.iter().any(|b| p.starts_with(b)) {
                let res = validate_local_download_path(&p, false, &policy).await;
                assert!(res.is_err());
            }
        }
    }

    // ── 绝对路径要求 ──

    #[tokio::test]
    async fn download_relative_path_rejected() {
        let policy = no_bl_policy();
        let res = validate_local_download_path(Path::new("../../foo"), false, &policy).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn download_parentdir_component_rejected() {
        let policy = no_bl_policy();
        let canon = canon_temp(&TempDir::new().unwrap());
        let sneaky = canon.join("..").join("..").join("etc").join("x");
        let res = validate_local_download_path(&sneaky, false, &policy).await;
        assert!(res.is_err(), "parent-dir components must be rejected");
    }

    // ── 符号链接 / 已存在文件 / 覆盖 ──

    #[cfg(unix)]
    #[tokio::test]
    async fn download_symlink_escape_rejected() {
        let td = TempDir::new().unwrap();
        let canon = canon_temp(&td);
        let policy = no_bl_policy();
        let link = canon.join("link");
        std::os::unix::fs::symlink("/etc", &link).unwrap();
        let target = link.join("x");
        let res = validate_local_download_path(&target, false, &policy).await;
        assert!(res.is_err(), "symlink escape must be rejected: {:?}", res);
    }

    #[tokio::test]
    async fn download_existing_no_overwrite_rejected() {
        let td = TempDir::new().unwrap();
        let canon = canon_temp(&td);
        let policy = no_bl_policy();
        let target = canon.join("exists.bin");
        std::fs::write(&target, b"hi").unwrap();
        let res = validate_local_download_path(&target, false, &policy).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn download_existing_with_overwrite_ok() {
        let td = TempDir::new().unwrap();
        let canon = canon_temp(&td);
        let policy = no_bl_policy();
        let target = canon.join("exists.bin");
        std::fs::write(&target, b"hi").unwrap();
        let res = validate_local_download_path(&target, true, &policy).await;
        assert!(res.is_ok(), "{:?}", res);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn download_symlink_overwrite_rejected() {
        let td = TempDir::new().unwrap();
        let canon = canon_temp(&td);
        let policy = no_bl_policy();
        let real = canon.join("real.bin");
        std::fs::write(&real, b"hi").unwrap();
        let link = canon.join("link.bin");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        let res = validate_local_download_path(&link, true, &policy).await;
        assert!(res.is_err(), "symlink overwrite must be rejected");
    }

    #[tokio::test]
    async fn download_nul_byte_rejected() {
        let td = TempDir::new().unwrap();
        let policy = no_bl_policy();
        let canon = canon_temp(&td);
        // Build a path containing NUL via OsString on unix; on Windows skip.
        #[cfg(unix)]
        {
            use std::ffi::OsString;
            use std::os::unix::ffi::OsStringExt;
            let mut bytes = canon.as_os_str().to_os_string().into_vec();
            bytes.extend_from_slice(b"/bad\0name");
            let os = OsString::from_vec(bytes);
            let p = PathBuf::from(os);
            let res = validate_local_download_path(&p, false, &policy).await;
            assert!(res.is_err());
        }
        #[cfg(not(unix))]
        {
            let _ = (policy, canon);
        }
    }

    // ── remote_file_name（缺省下载名的 basename 提取） ──

    #[test]
    fn remote_file_name_extracts_basename() {
        assert_eq!(remote_file_name("/var/log/app.log").unwrap(), "app.log");
        assert_eq!(remote_file_name("app.log").unwrap(), "app.log");
        assert_eq!(remote_file_name("/a/b/c.tar.gz").unwrap(), "c.tar.gz");
        assert_eq!(remote_file_name("C:\\dir\\file.txt").unwrap(), "file.txt");
        assert_eq!(remote_file_name("/a/b/").unwrap(), "b");
        assert_eq!(remote_file_name("/"), None);
    }

    // ── is_download_cancel（下载失败分类：取消 vs 策略拒绝） ──

    #[test]
    fn download_cancel_detects_user_cancel() {
        assert!(is_download_cancel("下载已取消"));
        assert!(is_download_cancel("上传已取消: something"));
        assert!(is_download_cancel("命令已取消（会话断开）"));
    }

    #[test]
    fn download_overwrite_rejection_is_not_cancel() {
        // 策略拒绝（覆盖/已存在）不是用户取消，必须归 error。
        assert!(!is_download_cancel("本地文件已存在（未允许覆盖）"));
        assert!(!is_download_cancel(
            "本地文件已存在且未允许覆盖（未显式传 overwrite=true）：/x/y"
        ));
        assert!(!is_download_cancel("保存路径已存在同名目录"));
    }

    #[test]
    fn download_unrelated_error_is_not_cancel() {
        assert!(!is_download_cancel("打开远程文件失败: No such file"));
        assert!(!is_download_cancel("connection refused"));
    }

    // ── resolve_local_side（local_path / user_pick 互斥矩阵） ──

    #[test]
    fn local_side_given_when_path_only() {
        assert_eq!(
            resolve_local_side(&json!({ "local_path": "/tmp/a.bin" })),
            LocalSide::Given(PathBuf::from("/tmp/a.bin"))
        );
    }

    #[test]
    fn local_side_user_pick_when_flag_only() {
        assert_eq!(
            resolve_local_side(&json!({ "user_pick": true })),
            LocalSide::UserPick
        );
    }

    #[test]
    fn local_side_conflict_when_both_given() {
        assert_eq!(
            resolve_local_side(&json!({ "user_pick": true, "local_path": "/tmp/a.bin" })),
            LocalSide::Conflict
        );
    }

    #[test]
    fn local_side_missing_when_neither() {
        assert_eq!(resolve_local_side(&json!({})), LocalSide::Missing);
    }

    #[test]
    fn local_side_empty_path_counts_as_missing() {
        assert_eq!(
            resolve_local_side(&json!({ "local_path": "" })),
            LocalSide::Missing
        );
    }

    #[test]
    fn local_side_non_boolean_flag_is_not_user_pick() {
        // 非布尔值（如字符串 "true"）不按启用处理，不猜参数。
        assert_eq!(
            resolve_local_side(&json!({ "user_pick": "true" })),
            LocalSide::Missing
        );
        assert_eq!(
            resolve_local_side(&json!({ "user_pick": "true", "local_path": "/tmp/a" })),
            LocalSide::Given(PathBuf::from("/tmp/a"))
        );
    }

    // ── user_pick 提醒护栏：描述与 schema 必须带上「跨机中转别用」的警告，
    //    防止后续改文案时把这条提醒删丢（多机.hbs 的中转流程依赖显式 local_path）。 ──

    #[test]
    fn transfer_tools_warn_not_to_user_pick_across_servers() {
        let upload = UploadFileTool::new();
        let download = DownloadFileTool::new();
        for (name, desc, schema) in [
            (
                "upload_file",
                upload.description(),
                upload.parameters_schema().to_string(),
            ),
            (
                "download_file",
                download.description(),
                download.parameters_schema().to_string(),
            ),
        ] {
            assert!(
                desc.contains("server-to-server"),
                "{name} 描述缺少跨机中转警告"
            );
            assert!(
                schema.contains("server-to-server"),
                "{name} schema 缺少跨机中转警告"
            );
            assert!(desc.contains("user_pick"), "{name} 描述未提及 user_pick");
        }
    }

    // ── upload_error_hint（上传失败的可操作指引） ──

    #[test]
    fn upload_error_hint_guides_when_parent_dir_missing() {
        let hint = upload_error_hint("打开远程文件失败: No such file", "/home/ubuntu/nodir/x.txt");
        assert!(hint.contains("mkdir"), "got: {}", hint);
        assert!(hint.contains("父目录"), "got: {}", hint);
    }

    #[test]
    fn upload_error_hint_guides_when_target_exists() {
        let hint = upload_error_hint("远程文件已存在，请先删除或重命名再上传", "/a/b.txt");
        assert!(hint.contains("已存在"), "got: {}", hint);
    }

    #[test]
    fn upload_error_hint_empty_for_unrelated_errors() {
        let hint = upload_error_hint("连接被拒绝", "/x");
        assert!(hint.is_empty(), "got: {}", hint);
    }

    // ── 上传源：任意非系统绝对路径可传（不再强制 home/沙箱内） ──
    // 注意：validate_local_upload_path 内部用默认黑名单 policy，而 TempDir 在
    // Windows 落在 %LOCALAPPDATA% 黑名单内——因此成功路径必须用 home 下真实
    // 文件（home 不在黑名单）。

    #[tokio::test]
    async fn upload_any_user_path_ok() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let dir = home.join(".marcel-ssh-upload-test");
        let _ = std::fs::create_dir_all(&dir);
        let file = dir.join("up.txt");
        std::fs::write(&file, b"hi").unwrap();
        let res = validate_local_upload_path(&file).await;
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
        assert!(res.is_ok(), "expected ok, got {:?}", res);
    }

    #[tokio::test]
    async fn upload_path_with_dotdot_inside_ok() {
        // A literal ".." component is tolerated as long as the resolved file
        // is real and outside protected locations.
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let dir = home.join(".marcel-ssh-upload-test");
        let _ = std::fs::create_dir_all(&dir);
        let sub = dir.join("sub");
        let _ = std::fs::create_dir_all(&sub);
        let file = dir.join("file.txt");
        std::fs::write(&file, b"hi").unwrap();
        let tricky = sub.join("..").join("file.txt");
        let res = validate_local_upload_path(&tricky).await;
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&sub);
        let _ = std::fs::remove_dir(&dir);
        assert!(res.is_ok(), "expected ok, got {:?}", res);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn upload_etc_shadow_rejected() {
        let p = PathBuf::from("/etc/shadow");
        let res = validate_local_upload_path(&p).await;
        assert!(res.is_err());
    }

    // upload 源指向黑名单内（~/.ssh）拒绝——但文件需真实存在才过 canonicalize。
    #[cfg(unix)]
    #[tokio::test]
    async fn upload_ssh_path_rejected() {
        if let Some(home) = dirs::home_dir() {
            let dir = home.join(".ssh");
            if dir.exists() {
                // 任取一个真实存在的文件
                if let Ok(entries) = std::fs::read_dir(&dir) {
                    if let Some(Ok(e)) = entries.next() {
                        let p = e.path();
                        if p.is_file() {
                            let res = validate_local_upload_path(&p).await;
                            assert!(res.is_err());
                        }
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn download_windows_reserved_name_rejected() {
        let td = TempDir::new().unwrap();
        let policy = no_bl_policy();
        let canon = canon_temp(&td);
        let target = canon.join("CON");
        let res = validate_local_download_path(&target, false, &policy).await;
        assert!(res.is_err());
    }

    // ── 黑名单形态归一：「目录还不存在」与 canonical 形态差异 ──
    //    （Windows 上 canonicalize 返回 `\\?\` verbatim 形态，identity 条目是
    //    普通形态，直接 starts_with 比不出来。）

    #[test]
    fn canonicalize_or_identity_keeps_missing_path() {
        let td = TempDir::new().unwrap();
        let missing = td.path().join("not-created-yet");
        assert!(!missing.exists());
        // 不存在必须保留原样（返回 None 会让 filter_map 把它从黑名单里剔掉）。
        assert_eq!(canonicalize_or_identity(&missing), missing);
    }

    /// 黑名单两侧形态能对上，全靠 `path_key`：在 Windows 上 `canonicalize`
    /// 返回 `\\?\` verbatim 形态，与普通形态直接 `starts_with` 永远不相等。
    /// 这条用例把该前提钉住——将来 canonicalize 的形态变了（或平台行为变了）
    /// 会在这里显式失败，提醒复核归一逻辑。
    #[cfg(windows)]
    #[test]
    fn windows_canonical_form_needs_normalization_to_match_plain_path() {
        // 规范长名临时目录：否则 %TEMP% 是 8.3 短名时，两边只差在短名 / 长名上。
        let td = canonical_tempdir();
        let canon = std::fs::canonicalize(td.path()).unwrap();
        let s = canon.as_os_str().to_string_lossy().to_string();
        assert!(
            s.starts_with(r"\\?\"),
            "canonicalize 形态变了（{}），path_key 的 verbatim 归一段需复核",
            s
        );
        assert!(!canon.starts_with(td.path()));
        assert_eq!(path_key(&canon), path_key(td.path()));
    }

    #[test]
    fn default_blacklist_covers_home_secret_dirs_whether_present_or_not() {
        let Some(home) = dirs::home_dir() else {
            return;
        };
        let bl = default_blacklist();
        for sub in [".ssh", ".gnupg", ".config", ".aws", ".kube"] {
            let p = home.join(sub);
            if p.exists() {
                // 存在：条目是 canonical 形态，靠 path_key 归一后仍要能命中。
                assert_eq!(
                    path_key(&canonicalize_or_identity(&p)),
                    path_key(&p),
                    "{}",
                    sub
                );
            } else {
                // 不存在：必须仍在黑名单里（identity 形态）——否则工具会替
                // agent 把受保护目录创建出来。
                assert!(
                    bl.iter().any(|b| path_key(b) == path_key(&p)),
                    "{} 在本机不存在时也必须留在黑名单",
                    sub
                );
            }
        }
    }

    #[tokio::test]
    async fn download_into_missing_blacklisted_dir_rejected() {
        // 黑名单条目取自 td.path()：必须是规范长名，见 canonical_tempdir。
        let td = canonical_tempdir();
        // 黑名单条目是「本机还不存在」的目录（identity 形态，非 canonical，
        // 与 TempDir 的真实路径无 verbatim 前缀可比性）——它必须仍然生效。
        let protected = td.path().join("protected-not-created");
        assert!(!protected.exists());
        let policy = LocalPathPolicy::from_blacklist(vec![protected.clone()]);
        let target = protected.join("config");
        let res = validate_local_download_path(&target, true, &policy).await;
        assert!(
            res.is_err(),
            "受保护目录尚不存在时也必须拒绝（否则会当场创建它并写入）: {:?}",
            res
        );
        assert!(!protected.exists(), "拒绝时不得创建该目录");
    }

    // ── 符号链接：判定必须发生在 resolve（canonicalize）之前 ──

    /// Windows 上的对应用例。创建符号链接需要开发者模式/管理员权限：造不出来
    /// 就跳过（跳过会打印原因，不伪装成通过）。能造出来时这条断言真正跑到，
    /// 它钉住的正是「resolve 之前判叶子」这一顺序——旧实现先 canonicalize
    /// （链接被解析成普通文件）再 symlink_metadata，永远拒不了。
    #[cfg(windows)]
    #[tokio::test]
    async fn download_windows_symlink_overwrite_rejected_when_creatable() {
        let td = TempDir::new().unwrap();
        let canon = canon_temp(&td);
        let policy = no_bl_policy();
        let real = canon.join("real.bin");
        std::fs::write(&real, b"hi").unwrap();
        let link = canon.join("link.bin");
        if std::os::windows::fs::symlink_file(&real, &link).is_err() {
            eprintln!("skip: 本机无法创建符号链接（需开发者模式或管理员权限）");
            return;
        }
        // 先记录「旧实现为什么看不见链接」：resolve 会把已存在的叶子
        // canonicalize 成链接目标（普通文件），所以 resolve 之后再做
        // symlink_metadata 永远看不到链接本身。
        let resolved = resolve_against_ancestors(&link).unwrap();
        assert_eq!(resolved, std::fs::canonicalize(&real).unwrap());
        assert!(!std::fs::symlink_metadata(&resolved)
            .unwrap()
            .file_type()
            .is_symlink());
        // 现在的判定在 resolve 之前用原始路径做，必须拒绝。
        let res = validate_local_download_path(&link, true, &policy).await;
        assert!(res.is_err(), "覆盖符号链接必须被拒绝: {:?}", res);
    }

    // ── Windows 路径前缀 / 组件形态 ──

    #[cfg(windows)]
    #[test]
    fn unc_verbatim_and_devicens_prefix_rejected() {
        for bad in [
            r"\\server\share\file.txt",
            r"\\?\C:\Users\X\a.txt",
            r"\\.\C:\x.txt",
            r"\\?\UNC\server\share\a.txt",
        ] {
            assert!(
                reject_non_disk_prefix(Path::new(bad)).is_err(),
                "{} 必须被拒绝",
                bad
            );
        }
        assert!(reject_non_disk_prefix(Path::new(r"C:\Users\X\a.txt")).is_ok());
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn download_unc_path_rejected() {
        // 旧实现在共享不可达时也会报错（no existing ancestor），但那是巧合：
        // 共享可达时 resolve 会成功且黑名单覆盖不到另一台机器上的位置。
        // 这条用例把「一律拒绝」钉成策略，不再依赖可达性。
        let policy = no_bl_policy();
        let res =
            validate_local_download_path(Path::new(r"\\server\share\a.txt"), true, &policy).await;
        assert!(res.is_err(), "UNC 落点必须被拒绝: {:?}", res);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn download_ads_and_trailing_dot_segment_rejected() {
        let td = TempDir::new().unwrap();
        let policy = no_bl_policy();
        let canon = canon_temp(&td);
        // NTFS 数据流写法（`:stream`）
        let ads = canon.join("a.txt:stream");
        assert!(validate_local_download_path(&ads, true, &policy)
            .await
            .is_err());
        // 中间目录带尾随点：Win32 会静默去掉，校验的路径 ≠ 落盘的路径。
        let dotted = canon.join("dir.").join("a.txt");
        assert!(validate_local_download_path(&dotted, true, &policy)
            .await
            .is_err());
    }

    // ── upload 远端参数：file_name / remote_path 复用既有校验 ──

    #[test]
    fn upload_file_name_rejects_traversal_and_separators() {
        for bad in [
            "../../etc/cron.d/x",
            "/etc/passwd",
            "sub/x",
            r"..\windows\x",
            "..",
            ".",
            "",
        ] {
            assert!(
                validate_upload_remote_file_name(bad).is_err(),
                "{:?} 必须被拒绝",
                bad
            );
        }
        for ok in ["x.txt", "报告.pdf", "a b.tar.gz", "no-extension"] {
            assert!(
                validate_upload_remote_file_name(ok).is_ok(),
                "{:?} 应当接受",
                ok
            );
        }
    }

    #[test]
    fn upload_remote_path_requires_absolute_without_parentdir() {
        for bad in ["../x", "x/y", "/a/../b", "", "/a\0b"] {
            assert!(validate_upload_remote_path(bad).is_err(), "{:?}", bad);
        }
        // 归一化：折叠重复斜杠（与用户 SFTP 面板同一条校验）。
        assert_eq!(validate_upload_remote_path("/a//b/").unwrap(), "/a/b/");
        assert_eq!(
            validate_upload_remote_path("/home/user/uploads").unwrap(),
            "/home/user/uploads"
        );
    }

    // ── user_pick：用户取消 vs 弹窗失败必须给不同文案 ──

    #[test]
    fn user_pick_failure_text_differs_from_cancel() {
        let cancelled = user_pick_cancelled();
        let failed = user_pick_failed("文件对话框任务异常退出: task panicked");
        assert!(cancelled.contains("取消"), "{}", cancelled);
        assert!(
            failed.contains("不是用户取消"),
            "失败文案必须点明不是用户取消: {}",
            failed
        );
        assert!(failed.contains("task panicked"), "保留底层原因: {}", failed);
        assert_ne!(cancelled, failed);
    }

    // ── 大文件（>1GB）确认闸门 ──
    // 提示措辞由用户给定、逐字钉住：模型只有看到 allow_large_transfer=true 才
    // 知道怎么过这一关，改文案之前先改这里的断言。

    const GB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn large_transfer_confirmation_matrix() {
        // 阈值本身不拦
        assert!(!needs_large_transfer_confirmation(GB, false, false));
        // 刚过阈值且未确认 → 拦
        assert!(needs_large_transfer_confirmation(GB + 1, false, false));
        // 模型确认了 → 放行
        assert!(!needs_large_transfer_confirmation(GB + 1, true, false));
        // 用户在原生对话框里亲自挑的 → 放行（否则要他重选一次文件）
        assert!(!needs_large_transfer_confirmation(GB + 1, false, true));
    }

    #[test]
    fn allow_large_transfer_param_parsing() {
        assert!(!allow_large_transfer(&json!({})));
        assert!(!allow_large_transfer(
            &json!({ "allow_large_transfer": false })
        ));
        // 只有真正的布尔 true 算确认：字符串 "true" 不算
        assert!(!allow_large_transfer(
            &json!({ "allow_large_transfer": "true" })
        ));
        assert!(allow_large_transfer(
            &json!({ "allow_large_transfer": true })
        ));
    }

    #[test]
    fn large_transfer_notice_text_is_pinned() {
        let expected_upload = concat!(
            "文件体积为 2.00 GB，大于 1GB，对于云服务器，这需要的时间可能是灾难级的，",
            "所以请你在上传前思考「这有没有必要？」，如果真的有用，那么你可以加上 ",
            "allow_large_transfer=true 参数把这个文件传上去。",
            "但如果是用户要求你传的，直接加上 allow_large_transfer=true 参数上传这个文件即可。"
        );
        assert_eq!(large_upload_notice(2 * GB), expected_upload);

        let expected_download = concat!(
            "文件体积为 1.50 GB，大于 1GB，对于云服务器，这需要的时间可能是灾难级的，",
            "所以请你在下载前思考「这有没有必要？」，如果真的有用，那么你可以加上 ",
            "allow_large_transfer=true 参数把这个文件取下来。",
            "但如果是用户要求你下载的，直接加上 allow_large_transfer=true 参数下载这个文件即可。"
        );
        assert_eq!(large_download_notice(3 * GB / 2), expected_download);
    }

    #[test]
    fn human_size_formats_gb_with_two_decimals() {
        assert_eq!(human_size(GB), "1.00 GB");
        assert_eq!(human_size(2 * GB + GB / 2), "2.50 GB");
    }

    // ── 闸门只对非内网目标生效 ──

    #[test]
    fn ip_private_classification() {
        use std::net::IpAddr;
        let lan = [
            "10.0.0.5",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.1.1",
            "::1",
            "fe80::1",
            "fd00::1",
            "fc00::1",
            "::ffff:192.168.1.1",
        ];
        for ip in lan {
            assert!(
                ip_is_private(ip.parse::<IpAddr>().unwrap()),
                "{ip} 应判为内网"
            );
        }
        let wan = [
            "8.8.8.8",
            "1.1.1.1",
            "172.15.0.1", // 172.16/12 之外
            "172.32.0.1",
            "100.64.0.1", // 运营商级 NAT：公网链路，刻意不算内网
            "203.0.113.10",
            "fe00::1", // fe80::/10 之外
            "2400:3200::1",
            "::ffff:8.8.8.8",
        ];
        for ip in wan {
            assert!(
                !ip_is_private(ip.parse::<IpAddr>().unwrap()),
                "{ip} 应判为公网"
            );
        }
    }

    #[test]
    fn host_lan_quick_matrix() {
        // IP 字面量（含带方括号的 IPv6）直接判，不需要 DNS
        assert_eq!(host_lan_quick("192.168.1.10"), Some(true));
        assert_eq!(host_lan_quick("203.0.113.7"), Some(false));
        assert_eq!(host_lan_quick("[::1]"), Some(true));
        assert_eq!(host_lan_quick("[2001:db8::1]"), Some(false));
        // 已知的本地后缀（含尾点写法）
        assert_eq!(host_lan_quick("localhost"), Some(true));
        assert_eq!(host_lan_quick("nas.local."), Some(true));
        assert_eq!(host_lan_quick("db.internal"), Some(true));
        // 普通主机名：交给一次 DNS 解析
        assert_eq!(host_lan_quick("web1"), None);
        assert_eq!(host_lan_quick("example.com"), None);
    }

    /// 与 user_pick 那条护栏同构：描述与 schema 都必须写明 1GB 规则与参数名，
    /// 否则模型既不知道有门槛、也不知道怎么过。
    #[test]
    fn transfer_tools_document_large_transfer_rule() {
        let upload = UploadFileTool::new();
        let download = DownloadFileTool::new();
        for (name, desc, schema) in [
            (
                "upload_file",
                upload.description(),
                upload.parameters_schema().to_string(),
            ),
            (
                "download_file",
                download.description(),
                download.parameters_schema().to_string(),
            ),
        ] {
            assert!(
                desc.contains("allow_large_transfer") && desc.contains("1 GB"),
                "{name} 描述缺少大文件规则"
            );
            assert!(
                schema.contains("allow_large_transfer"),
                "{name} schema 缺少 allow_large_transfer"
            );
        }
    }
}
