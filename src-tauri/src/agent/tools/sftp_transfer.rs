//! SFTP-equivalent file transfer tools.
//!
//! We do not depend on a separate SFTP protocol stack. Transfers are
//! implemented on top of the already-open SSH exec channel using base64
//! framing, which is binary-safe and reliable across distros.

use async_trait::async_trait;
use serde_json::json;
use std::path::{Component, Path, PathBuf};
use tokio::fs;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::base64;
use crate::agent::tools::{shell_escape, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

/// Hard ceiling for a single transfer to prevent runaway memory use.
const MAX_TRANSFER_BYTES: u64 = 32 * 1024 * 1024;

// ────────────────────────────── LocalPathPolicy ──────────────────────────────

/// Policy controlling where downloaded files may be written and which
/// local paths are considered sensitive (and hence off-limits even for
/// uploads we read from disk).
#[derive(Debug, Clone)]
pub struct LocalPathPolicy {
    /// Canonical allowed roots. Any download target must canonicalize to a
    /// path under one of these roots.
    pub allowed_roots: Vec<PathBuf>,
    /// Canonical path prefixes that are forbidden. Takes precedence over
    /// `allowed_roots`.
    pub blacklist: Vec<PathBuf>,
}

impl LocalPathPolicy {
    /// Build a policy from explicit allowed roots, attaching the built-in
    /// blacklist. Non-existent blacklist entries are silently dropped.
    pub fn from_roots(roots: Vec<PathBuf>) -> Self {
        let allowed_roots = roots
            .into_iter()
            .filter_map(|r| canonicalize_or_identity(&r))
            .collect();
        Self {
            allowed_roots,
            blacklist: default_blacklist(),
        }
    }

    /// Default policy: sandbox directory under the user's Downloads folder.
    pub fn default_policy() -> Self {
        let root = dirs::download_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("marcel-ssh-downloads");
        let _ = std::fs::create_dir_all(&root);
        let canon = canonicalize_or_identity(&root).unwrap_or(root);
        Self {
            allowed_roots: vec![canon],
            blacklist: default_blacklist(),
        }
    }

    /// Test-only constructor: allowed roots without the built-in blacklist.
    /// Needed because on Windows `tempfile::TempDir` lives under
    /// `%LOCALAPPDATA%\Temp`, which is itself blacklisted.
    #[cfg(test)]
    pub(crate) fn from_roots_no_blacklist(roots: Vec<PathBuf>) -> Self {
        let allowed_roots = roots
            .into_iter()
            .filter_map(|r| canonicalize_or_identity(&r))
            .collect();
        Self {
            allowed_roots,
            blacklist: vec![],
        }
    }
}

fn canonicalize_or_identity(p: &Path) -> Option<PathBuf> {
    std::fs::canonicalize(p).ok()
}

// Re-export a tiny helper so `from_roots` compiles without adding the `dunce` crate.
mod _unused {}

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
        for d in ["/System", "/Library", "/Applications", "/private", "/etc", "/usr", "/bin", "/sbin", "/var"] {
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
        "CON" | "PRN" | "AUX" | "NUL"
            | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" | "COM6" | "COM7" | "COM8" | "COM9"
            | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" | "LPT6" | "LPT7" | "LPT8" | "LPT9"
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

/// Validate a download target. Returns the canonical-ish resolved path.
pub async fn validate_local_download_path(
    raw: &Path,
    overwrite: bool,
    policy: &LocalPathPolicy,
) -> Result<PathBuf, AppError> {
    if !raw.is_absolute() {
        return Err(AppError::Agent("local_path must be absolute".into()));
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

    // Must live under an allowed root.
    let in_allowed = policy
        .allowed_roots
        .iter()
        .any(|root| resolved.starts_with(root));
    if !in_allowed {
        return Err(AppError::Agent(format!(
            "local_path escapes the marcel-ssh download sandbox: {}",
            resolved.display()
        )));
    }

    // Blacklist check.
    for bad in &policy.blacklist {
        if resolved.starts_with(bad) {
            return Err(AppError::Agent(format!(
                "local_path falls under a protected system location: {}",
                bad.display()
            )));
        }
    }

    // Existing-target handling.
    if let Ok(meta) = fs::symlink_metadata(&resolved).await {
        let ft = meta.file_type();
        if ft.is_symlink() {
            return Err(AppError::Agent(
                "refusing to overwrite a symlink".into(),
            ));
        }
        if ft.is_dir() {
            return Err(AppError::Agent(
                "refusing to overwrite a directory".into(),
            ));
        }
        if !overwrite {
            return Err(AppError::Agent(format!(
                "local_path already exists and overwrite=false: {}",
                resolved.display()
            )));
        }
    }

    Ok(resolved)
}

/// Validate a local file path for upload: absolute, exists, is a regular
/// file, and resolves under the user's home directory or the download
/// sandbox. Unlike the old implementation, a literal `..` component is
/// tolerated as long as canonicalization keeps the result inside a safe
/// root (so e.g. `/home/u/sub/../file` is accepted).
async fn validate_local_upload_path(p: &Path) -> Result<(), AppError> {
    if !p.is_absolute() {
        return Err(AppError::Agent("local_path must be absolute".into()));
    }
    let meta = fs::metadata(p)
        .await
        .map_err(|e| AppError::Agent(format!("本地文件不可访问: {}", e)))?;
    if !meta.is_file() {
        return Err(AppError::Agent("路径不是普通文件".into()));
    }

    let canon = std::fs::canonicalize(p)
        .map_err(|e| AppError::Agent(format!("canonicalize 失败: {}", e)))?;

    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(home) = dirs::home_dir() {
        if let Some(h) = canonicalize_or_identity(&home) {
            roots.push(h);
        }
    }
    let sandbox = LocalPathPolicy::default_policy();
    roots.extend(sandbox.allowed_roots.clone());

    let ok = roots.iter().any(|r| canon.starts_with(r));
    if !ok {
        return Err(AppError::Agent(format!(
            "upload source must live under the user's home directory or the download sandbox: {}",
            canon.display()
        )));
    }

    // Still reject sensitive subtrees even for reads (keys, secrets).
    for bad in &sandbox.blacklist {
        if canon.starts_with(bad) {
            return Err(AppError::Agent(format!(
                "upload source falls under a protected location: {}",
                bad.display()
            )));
        }
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
impl UploadFileTool { pub fn new() -> Self { Self } }
impl Default for UploadFileTool { fn default() -> Self { Self::new() } }

#[async_trait]
impl AgentTool for UploadFileTool {
    fn name(&self) -> &str { "upload_file" }

    fn description(&self) -> &str {
        "Upload a file from the local filesystem to the remote server. \
         Binary-safe. Provide the local file path and the desired remote path."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "local_path": { "type": "string", "description": "Absolute path to the local file to upload" },
                "remote_path": { "type": "string", "description": "Absolute path on the remote server (directory or full file path)" },
                "file_name": { "type": "string", "description": "Optional: desired filename for the remote file. If omitted, uses original name." }
            },
            "required": ["local_path", "remote_path"]
        })
    }

    fn risk_level(&self) -> RiskLevel { RiskLevel::LowRisk }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let local_path = params.get("local_path").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'local_path' parameter".into()))?;
        let remote_path = params.get("remote_path").and_then(|v| v.as_str())
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
            Err(e) => return Ok(ToolOutput::fail(
                format!("upload {}", local_path_buf.display()),
                e.to_string(),
            )),
        };
        if size > MAX_TRANSFER_BYTES {
            return Ok(ToolOutput::fail(
                format!("upload {}", local_path_buf.display()),
                format!(
                    "file too large: {} bytes (limit {} bytes). Use rsync/scp via execute_command.",
                    size, MAX_TRANSFER_BYTES
                ),
            ));
        }

        let bytes = match fs::read(&local_path_buf).await {
            Ok(b) => b,
            Err(e) => return Ok(ToolOutput::fail(
                format!("upload {}", local_path_buf.display()),
                format!("local read failed: {}", e),
            )),
        };

        let final_remote = if params.get("file_name").and_then(|v| v.as_str()).map_or(false, |n| !n.is_empty()) {
            let dir = if remote_path.ends_with('/') || remote_path.ends_with('\\') {
                remote_path.to_string()
            } else {
                let parts: Vec<&str> = remote_path.rsplitn(2, '/').collect();
                if parts.last().map_or(false, |p| !p.contains('.')) {
                    format!("{}/", remote_path)
                } else {
                    remote_path.to_string()
                }
            };
            let name = params.get("file_name").and_then(|v| v.as_str()).unwrap_or("");
            if dir.ends_with('/') { format!("{}{}", dir, name) } else { format!("{}/{}", dir, name) }
        } else {
            let file_name = local_path_buf
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "upload".to_string());
            if remote_path.ends_with('/') || remote_path.ends_with('\\') {
                format!("{}{}", remote_path, file_name)
            } else {
                format!("{}/{}", remote_path, file_name)
            }
        };

        let payload = base64::b64_encode(&bytes);
        let escaped_remote = shell_escape(&final_remote);
        let cmd = format!(
            "{decode}\n[ -f {p} ] && wc -c < {p}",
            decode = base64::cmd_decode_to_file(&escaped_remote, &payload),
            p = escaped_remote,
        );

        match ctx.exec(&cmd).await {
            Ok(out) => {
                let last = out.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
                let remote_size: Option<u64> = last.trim().parse().ok();
                let ok = remote_size.map_or(false, |n| n == bytes.len() as u64);
                if ok {
                    Ok(ToolOutput::ok(
                        format!("upload {} ({} bytes)", final_remote, bytes.len()),
                        format!("uploaded {} bytes: {} -> remote:{}", bytes.len(), local_path_buf.display(), final_remote),
                    )
                    .with_metadata(json!({
                        "local_path": local_path_buf.display().to_string(),
                        "remote_path": final_remote,
                        "bytes": bytes.len(),
                    })))
                } else {
                    Ok(ToolOutput::fail(
                        format!("upload {}", final_remote),
                        format!(
                            "size mismatch after upload: sent {} bytes, remote reports {:?}",
                            bytes.len(), remote_size
                        ),
                    ))
                }
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("upload {}", final_remote),
                format!("transfer failed: {}", e),
            )),
        }
    }
}

// ────────────────────────────── DownloadFileTool ──────────────────────────────

pub struct DownloadFileTool;
impl DownloadFileTool { pub fn new() -> Self { Self } }
impl Default for DownloadFileTool { fn default() -> Self { Self::new() } }

#[async_trait]
impl AgentTool for DownloadFileTool {
    fn name(&self) -> &str { "download_file" }

    fn description(&self) -> &str {
        "Download a file from the remote server to the local filesystem. \
         Files are written to the user's marcel-ssh-downloads sandbox directory; \
         system paths (/, ~/.ssh, System32, etc.) are blocked. Absolute paths required. \
         Limit: 32 MB."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "remote_path": { "type": "string", "description": "Absolute path on the remote server" },
                "local_path":  { "type": "string", "description": "Absolute path under the marcel-ssh-downloads sandbox. System paths are rejected." },
                "overwrite": { "type": "boolean", "description": "If true, overwrite an existing regular file. Symlinks and directories are never overwritten. Default: false.", "default": false }
            },
            "required": ["remote_path", "local_path"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        // Writes to local disk (and may overwrite existing files).
        RiskLevel::Moderate
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let remote_path = params.get("remote_path").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'remote_path' parameter".into()))?;
        let local_path = params.get("local_path").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'local_path' parameter".into()))?;
        let overwrite = params.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);
        if local_path.is_empty() || remote_path.is_empty() {
            return Ok(ToolOutput::fail("download_file", "empty path"));
        }

        let policy = LocalPathPolicy::default_policy();
        let resolved = match validate_local_download_path(
            Path::new(local_path),
            overwrite,
            &policy,
        )
        .await
        {
            Ok(r) => r,
            Err(e) => return Ok(ToolOutput::fail("download_file", e.to_string())),
        };

        // Pre-check size.
        let escaped = shell_escape(remote_path);
        let size_cmd = format!(
            "[ -f {p} ] || {{ echo MISSING; exit 1; }}; wc -c < {p}",
            p = escaped
        );
        let size: u64 = match ctx.exec(&size_cmd).await {
            Ok(s) => {
                let line = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
                if line == "MISSING" || line.is_empty() {
                    return Ok(ToolOutput::fail(
                        format!("download {}", remote_path),
                        "remote file not found",
                    ));
                }
                match line.parse() {
                    Ok(n) => n,
                    Err(_) => return Ok(ToolOutput::fail(
                        format!("download {}", remote_path),
                        format!("unexpected size response: {}", line),
                    )),
                }
            }
            Err(e) => return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!("remote stat failed: {}", e),
            )),
        };

        if size > MAX_TRANSFER_BYTES {
            return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!(
                    "remote file too large: {} bytes (limit {} bytes). Use rsync/scp via execute_command.",
                    size, MAX_TRANSFER_BYTES
                ),
            ));
        }

        let fetch_cmd = base64::cmd_encode_file(&escaped);
        let b64 = match ctx.exec(&fetch_cmd).await {
            Ok(s) => s,
            Err(e) => return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!("remote fetch failed: {}", e),
            )),
        };
        let bytes = match base64::b64_decode(b64.trim()) {
            Ok(b) => b,
            Err(e) => return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!("decode error: {}", e),
            )),
        };
        if bytes.len() as u64 != size {
            return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!(
                    "size mismatch: remote {} bytes, decoded {} bytes",
                    size, bytes.len()
                ),
            ));
        }

        // Ensure parent exists — but only if the parent itself lives inside
        // the sandbox. We don't create directories outside the allowed roots.
        if let Some(parent) = resolved.parent() {
            if !parent.as_os_str().is_empty() {
                let parent_ok = policy
                    .allowed_roots
                    .iter()
                    .any(|r| parent.starts_with(r) || parent == r.as_path());
                // The parent might not exist yet; check its eventual resolved form.
                let parent_in_sandbox = parent_ok
                    || resolve_against_ancestors(parent)
                        .map(|rp| policy.allowed_roots.iter().any(|r| rp.starts_with(r)))
                        .unwrap_or(false);
                if !parent_in_sandbox {
                    return Ok(ToolOutput::fail(
                        format!("download {}", remote_path),
                        "refusing to create directories outside the sandbox",
                    ));
                }
                if !parent.exists() {
                    if let Err(e) = fs::create_dir_all(parent).await {
                        return Ok(ToolOutput::fail(
                            format!("download {}", remote_path),
                            format!("local mkdir failed: {}", e),
                        ));
                    }
                }
            }
        }

        use std::fs::OpenOptions;
        let open_res = OpenOptions::new()
            .write(true)
            .create_new(!overwrite)
            .create(overwrite)
            .truncate(overwrite)
            .open(&resolved);
        let mut file = match open_res {
            Ok(f) => f,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    format!("download {}", remote_path),
                    format!("local open failed: {}", e),
                ));
            }
        };
        use std::io::Write;
        if let Err(e) = file.write_all(&bytes) {
            return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!("local write failed: {}", e),
            ));
        }

        Ok(ToolOutput::ok(
            format!("download {} ({} bytes)", remote_path, bytes.len()),
            format!(
                "downloaded {} bytes: remote:{} -> {}",
                bytes.len(),
                remote_path,
                resolved.display()
            ),
        )
        .with_metadata(json!({
            "remote_path": remote_path,
            "local_path": resolved.display().to_string(),
            "bytes": bytes.len(),
            "overwrite": overwrite,
        })))
    }
}

// ────────────────────────────────── tests ──────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn local_b64_roundtrip() {
        let data = b"\x00\x01\x02binary\xff\xfe test";
        let enc = base64::b64_encode(data);
        assert_eq!(base64::b64_decode(&enc).unwrap(), data);
    }

    fn sandbox_policy(root: &Path) -> LocalPathPolicy {
        // Use a blacklist-free policy so tests can sandbox under
        // `tempfile::TempDir`, which on Windows lives inside `%LOCALAPPDATA%`
        // (a default-blacklisted location). Tests that specifically validate
        // blacklist behavior construct their own policy.
        LocalPathPolicy::from_roots_no_blacklist(vec![root.to_path_buf()])
    }

    #[tokio::test]
    async fn download_inside_sandbox_ok() {
        let td = TempDir::new().unwrap();
        let policy = sandbox_policy(td.path());
        let target = std::fs::canonicalize(td.path()).unwrap().join("a.txt");
        let res = validate_local_download_path(&target, false, &policy).await;
        assert!(res.is_ok(), "{:?}", res);
    }

    #[tokio::test]
    async fn download_creates_subdir_ok() {
        let td = TempDir::new().unwrap();
        let policy = sandbox_policy(td.path());
        let target = std::fs::canonicalize(td.path())
            .unwrap()
            .join("sub/deeper/a.txt");
        assert!(validate_local_download_path(&target, false, &policy).await.is_ok());
    }

    #[tokio::test]
    async fn download_etc_passwd_rejected() {
        let td = TempDir::new().unwrap();
        let policy = LocalPathPolicy::from_roots(vec![td.path().to_path_buf()]);
        #[cfg(unix)]
        let p = PathBuf::from("/etc/passwd");
        #[cfg(windows)]
        let p = PathBuf::from("C:/Windows/System32/drivers/etc/hosts");
        let res = validate_local_download_path(&p, false, &policy).await;
        assert!(res.is_err(), "expected rejection, got {:?}", res);
    }

    #[tokio::test]
    async fn download_ssh_authorized_keys_rejected() {
        let td = TempDir::new().unwrap();
        let policy = LocalPathPolicy::from_roots(vec![td.path().to_path_buf()]);
        if let Some(home) = dirs::home_dir() {
            let p = home.join(".ssh").join("authorized_keys");
            // Only meaningful if ~/.ssh exists and is on the blacklist.
            if policy.blacklist.iter().any(|b| p.starts_with(b)) {
                let res = validate_local_download_path(&p, false, &policy).await;
                assert!(res.is_err());
            }
        }
    }

    #[tokio::test]
    async fn download_relative_path_rejected() {
        let td = TempDir::new().unwrap();
        let policy = sandbox_policy(td.path());
        let res = validate_local_download_path(Path::new("../../foo"), false, &policy).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn download_parentdir_component_rejected() {
        let td = TempDir::new().unwrap();
        let policy = sandbox_policy(td.path());
        let canon = std::fs::canonicalize(td.path()).unwrap();
        let sneaky = canon.join("..").join("..").join("etc").join("x");
        let res = validate_local_download_path(&sneaky, false, &policy).await;
        assert!(res.is_err(), "parent-dir components must be rejected");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn download_symlink_escape_rejected() {
        let td = TempDir::new().unwrap();
        let canon = std::fs::canonicalize(td.path()).unwrap();
        let policy = sandbox_policy(td.path());
        let link = canon.join("link");
        std::os::unix::fs::symlink("/etc", &link).unwrap();
        let target = link.join("x");
        let res = validate_local_download_path(&target, false, &policy).await;
        assert!(res.is_err(), "symlink escape must be rejected: {:?}", res);
    }

    #[tokio::test]
    async fn download_existing_no_overwrite_rejected() {
        let td = TempDir::new().unwrap();
        let canon = std::fs::canonicalize(td.path()).unwrap();
        let policy = sandbox_policy(td.path());
        let target = canon.join("exists.bin");
        std::fs::write(&target, b"hi").unwrap();
        let res = validate_local_download_path(&target, false, &policy).await;
        assert!(res.is_err());
    }

    #[tokio::test]
    async fn download_existing_with_overwrite_ok() {
        let td = TempDir::new().unwrap();
        let canon = std::fs::canonicalize(td.path()).unwrap();
        let policy = sandbox_policy(td.path());
        let target = canon.join("exists.bin");
        std::fs::write(&target, b"hi").unwrap();
        let res = validate_local_download_path(&target, true, &policy).await;
        assert!(res.is_ok(), "{:?}", res);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn download_symlink_overwrite_rejected() {
        let td = TempDir::new().unwrap();
        let canon = std::fs::canonicalize(td.path()).unwrap();
        let policy = sandbox_policy(td.path());
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
        let policy = sandbox_policy(td.path());
        let canon = std::fs::canonicalize(td.path()).unwrap();
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

    #[tokio::test]
    async fn upload_path_with_dotdot_inside_home_ok() {
        // Previously the validator rejected any ".." component outright. We
        // only care about the resolved location.
        let Some(home) = dirs::home_dir() else { return; };
        // Create a real temp file under home so we can reference it with "..".
        let dir = home.join(".marcel-ssh-upload-test");
        let _ = std::fs::create_dir_all(&dir);
        let sub = dir.join("sub");
        let _ = std::fs::create_dir_all(&sub);
        let file = dir.join("file.txt");
        std::fs::write(&file, b"hi").unwrap();
        let tricky = sub.join("..").join("file.txt");
        let res = validate_local_upload_path(&tricky).await;
        // Cleanup first so assertion failures still clean up.
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

    #[cfg(windows)]
    #[tokio::test]
    async fn download_windows_reserved_name_rejected() {
        let td = TempDir::new().unwrap();
        let policy = sandbox_policy(td.path());
        let canon = std::fs::canonicalize(td.path()).unwrap();
        let target = canon.join("CON");
        let res = validate_local_download_path(&target, false, &policy).await;
        assert!(res.is_err());
    }
}
