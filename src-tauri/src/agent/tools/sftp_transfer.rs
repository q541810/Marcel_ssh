//! SFTP file transfer tools (upload_file / download_file).
//!
//! Uses the SFTP subsystem protocol for binary-safe file transfers.
//! 传输实现与用户 SFTP 面板**共用同一流式核心**
//! （commands::sftp::{stream_upload_single_file, stream_download_single_file}），
//! 不在此重复字节拷贝逻辑；本文件只做参数解析 / 本地路径校验（绝对路径 +
//! 系统/敏感路径黑名单；download 省略 local_path 时落系统 Downloads）/
//! 传输中心接入（互斥 + 记账 + 事件）。桌面专属工具（移动端不注册）。

use async_trait::async_trait;
use russh_sftp::protocol::OpenFlags;
use serde_json::json;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use tokio::fs;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

/// Hard ceiling for a single transfer to prevent runaway memory use.
const MAX_TRANSFER_BYTES: u64 = 32 * 1024 * 1024;

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

fn canonicalize_or_identity(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

fn default_blacklist() -> Vec<PathBuf> {
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
        .filter_map(|p| canonicalize_or_identity(&p))
        .collect()
}

/// Reserved Windows device names (case-insensitive).
#[cfg(windows)]
fn is_windows_reserved_name(name: &str) -> bool {
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

fn validate_file_name(name: &str) -> Result<(), AppError> {
    if name.is_empty() || name == "." || name == ".." {
        return Err(AppError::Agent(format!("invalid file name: {:?}", name)));
    }
    if name.contains('\0') {
        return Err(AppError::Agent("file name contains NUL byte".into()));
    }
    #[cfg(windows)]
    {
        for ch in ['<', '>', ':', '"', '|', '?', '*'] {
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
fn resolve_against_ancestors(p: &Path) -> Result<PathBuf, AppError> {
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
                if s.to_string_lossy().contains('\0') {
                    return Err(AppError::Agent("local path contains NUL byte".into()));
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
fn blacklisted(p: &Path, blacklist: &[PathBuf]) -> bool {
    blacklist.iter().any(|bad| p.starts_with(bad))
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

    // File name checks.
    let file_name = raw
        .file_name()
        .ok_or_else(|| AppError::Agent("local_path has no file name".into()))?
        .to_string_lossy()
        .to_string();
    validate_file_name(&file_name)?;

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

    // Existing-target handling.
    if let Ok(meta) = fs::symlink_metadata(&resolved).await {
        let ft = meta.file_type();
        if ft.is_symlink() {
            return Err(AppError::Agent("refusing to overwrite a symlink".into()));
        }
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

async fn local_file_size(p: &Path) -> Result<u64, AppError> {
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
         blocked). remote_path is a path ON THE SERVER: give an existing directory, a \
         directory ending with '/', or a full target file path (the tool probes the \
         server: existing directories get the local file name appended, anything else \
         is treated as the exact target file path). To rename on the server pass \
         file_name.\n\
         Multi-host: you may pass an optional `host` (the current machine or a \
         machine from the selected set, by its readable name) to upload to that \
         machine instead of the current one. Desktop only.\n\
         IMPORTANT: the `host` value must match the machine name in the multi-host \
         list CHARACTER-FOR-CHARACTER, case-sensitive — do not add, drop, or alter \
         any character (no extra spaces, no lowercase/uppercase changes, no \
         punctuation changes). A name that differs by even one character is \
         rejected, never silently redirected."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "local_path": { "type": "string", "description": "Required. Absolute path of the file to upload ON THIS COMPUTER (not the server). System/secret paths are rejected." },
                "remote_path": { "type": "string", "description": "Required. Destination ON THE SERVER: an existing directory, a directory ending with '/', or the full target file path. Existing directories get the local file name appended; otherwise the path is used as-is as the target file." },
                "file_name": { "type": "string", "description": "Optional. Rename the uploaded file on the server. When given, remote_path is treated as a directory and file_name is appended." },
                "host": { "type": "string", "description": "Optional. Target machine's readable name: the current machine or one from the multi-host selected set. When omitted, uploads to the current session's machine. Desktop only. IMPORTANT: must match the machine name in the multi-host list character-for-character, case-sensitive — any single-character difference (case, space, punctuation) is rejected, never silently redirected." }
            },
            "required": ["local_path", "remote_path"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::LowRisk
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
    let local_path = params
        .get("local_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Agent("Missing 'local_path' parameter".into()))?;
    let remote_path = params
        .get("remote_path")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Agent("Missing 'remote_path' parameter".into()))?;
    if remote_path.is_empty() {
        return Ok(ToolOutput::fail("upload_file", "empty remote_path"));
    }

    let local_path_buf = PathBuf::from(local_path);
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
    if size > MAX_TRANSFER_BYTES {
        return Ok(ToolOutput::fail(
            format!("upload {}", local_path_buf.display()),
            format!(
                "file too large: {} bytes (limit {} bytes). Use rsync/scp via bash.",
                size, MAX_TRANSFER_BYTES
            ),
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
        match resolve_upload_remote_path(&sftp, &local_path_buf, remote_path, &params).await {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolOutput::fail("upload_file", e.to_string()));
            }
        };

    // 取消 watch 注册进统一取消表（前端传输中心「取消」按钮按 id 触发）。
    let (_cancel_tx, mut cancel_rx, _guard) =
        crate::commands::sftp::register_upload_cancel(&state, &transfer_id);

    // 记账（任务终态级联取消用）+ 互斥锁（多 agent 传输一次一个）。
    if !task_id.is_empty() {
        crate::agent::transfer::register_transfer(&state, &task_id, &transfer_id).await;
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
        &ctx.app_handle,
        &sftp,
        &mut local_file,
        size,
        true,
        &final_remote,
        &transfer_id,
        &mut cancel_rx,
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
async fn ensure_parent_creatable(resolved: &Path, policy: &LocalPathPolicy) -> Result<(), String> {
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
         reported back in the result). System/secret local paths (/, ~/.ssh, System32) \
         are blocked. Existing files are not overwritten unless overwrite=true. \
         Limit: 32 MB.\n\
         Multi-host: you may pass an optional `host` (the current machine or a \
         machine from the selected set, by its readable name) to download from \
         that machine instead of the current one. Desktop only.\n\
         IMPORTANT: the `host` value must match the machine name in the multi-host \
         list CHARACTER-FOR-CHARACTER, case-sensitive — do not add, drop, or alter \
         any character (no extra spaces, no lowercase/uppercase changes, no \
         punctuation changes). A name that differs by even one character is \
         rejected, never silently redirected."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "remote_path": { "type": "string", "description": "Required. Absolute path of the remote file on the server to download" },
                "local_path":  { "type": "string", "description": "Optional. Absolute save path ON THIS COMPUTER (not the server). Omit to save to the system Downloads folder with the remote file name. System/secret paths are rejected." },
                "overwrite": { "type": "boolean", "description": "If true, overwrite an existing regular file. Symlinks and directories are never overwritten. Default: false.", "default": false },
                "host": { "type": "string", "description": "Optional. Target machine's readable name: the current machine or one from the multi-host selected set. When omitted, downloads from the current session's machine. Desktop only. IMPORTANT: must match the machine name in the multi-host list character-for-character, case-sensitive — any single-character difference (case, space, punctuation) is rejected, never silently redirected." }
            },
            "required": ["remote_path"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::Moderate
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

    // local_path 可选：省略时落到系统 Downloads 目录（解析失败退回 home），
    // 文件名取远端 basename。用户指定时必须是绝对路径（黑名单外）。
    let resolved = match params
        .get("local_path")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        Some(local_path) => {
            match validate_local_download_path(Path::new(local_path), overwrite, &policy).await {
                Ok(r) => r,
                Err(e) => return Ok(ToolOutput::fail("download_file", e.to_string())),
            }
        }
        None => {
            let remote_name =
                remote_file_name(remote_path).unwrap_or_else(|| "download".to_string());
            let Some(download_dir) = LocalPathPolicy::default_download_dir() else {
                return Ok(ToolOutput::fail(
                    "download_file",
                    "无法确定系统下载目录（Downloads 与 home 均不可用），请显式传 local_path",
                ));
            };
            let target = download_dir.join(&remote_name);
            match validate_local_download_path(&target, overwrite, &policy).await {
                Ok(r) => r,
                Err(e) => return Ok(ToolOutput::fail("download_file", e.to_string())),
            }
        }
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

    // 打开远端文件并取大小（超限检查在流式前，避免传一半才发现超限）。
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
    if total > MAX_TRANSFER_BYTES {
        return Ok(ToolOutput::fail(
            format!("download {}", remote_path),
            format!(
                "remote file too large: {} bytes (limit {} bytes). Use rsync/scp via bash.",
                total, MAX_TRANSFER_BYTES
            ),
        ));
    }
    let mut remote = match sftp.open_with_flags(remote_path, OpenFlags::READ).await {
        Ok(f) => f,
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
    let (_cancel_tx, mut cancel_rx, _guard) =
        crate::commands::sftp::register_download_cancel(&state, &transfer_id);

    // 记账（任务终态级联取消用）+ 互斥锁（多 agent 传输一次一个）。
    if !task_id.is_empty() {
        crate::agent::transfer::register_transfer(&state, &task_id, &transfer_id).await;
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
        &ctx.app_handle,
        &mut remote,
        total,
        &resolved.display().to_string(),
        &transfer_id,
        &mut cancel_rx,
        overwrite,
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
        assert!(!is_download_cancel("本地文件已存在且未允许覆盖（未显式传 overwrite=true）：/x/y"));
        assert!(!is_download_cancel("保存路径已存在同名目录"));
    }

    #[test]
    fn download_unrelated_error_is_not_cancel() {
        assert!(!is_download_cancel("打开远程文件失败: No such file"));
        assert!(!is_download_cancel("connection refused"));
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
}
