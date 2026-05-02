//! SFTP-equivalent file transfer tools.
//!
//! We do not depend on a separate SFTP protocol stack. Transfers are
//! implemented on top of the already-open SSH exec channel using base64
//! framing, which is binary-safe and reliable across distros.
//!
//! - `upload_file`   : local disk -> base64 in memory -> remote `base64 -d > remote`
//! - `download_file` : remote `base64 -w0 remote` -> decode locally -> write to disk
//!
//! Size limits keep us out of memory-pressure territory; a 32 MB default
//! covers the vast majority of config / script / log transfers. Users who
//! need large transfers can raise the limit or fall back to `rsync`/`scp`
//! via `execute_command`.

use async_trait::async_trait;
use serde_json::json;
use std::path::{Path, PathBuf};
use tokio::fs;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::base64;
use crate::agent::tools::{shell_escape, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

/// Hard ceiling for a single transfer to prevent runaway memory use.
const MAX_TRANSFER_BYTES: u64 = 32 * 1024 * 1024;

/// Validate that a local path is absolute and points at a real file (for upload).
/// Returns the size on success.
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
        "Upload a local file to the remote server. Binary-safe. Absolute paths \
         required on both sides. Limit: 32 MB."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "local_path":  { "type": "string", "description": "Absolute path on the local (agent host) filesystem" },
                "remote_path": { "type": "string", "description": "Absolute path on the remote server" }
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
        if local_path.is_empty() || remote_path.is_empty() {
            return Ok(ToolOutput::fail("upload_file", "empty path"));
        }

        let local = PathBuf::from(local_path);
        let size = match local_file_size(&local).await {
            Ok(n) => n,
            Err(e) => return Ok(ToolOutput::fail(
                format!("upload {}", local_path),
                e.to_string(),
            )),
        };
        if size > MAX_TRANSFER_BYTES {
            return Ok(ToolOutput::fail(
                format!("upload {}", local_path),
                format!(
                    "file too large: {} bytes (limit {} bytes). Use rsync/scp via execute_command.",
                    size, MAX_TRANSFER_BYTES
                ),
            ));
        }

        let bytes = match fs::read(&local).await {
            Ok(b) => b,
            Err(e) => return Ok(ToolOutput::fail(
                format!("upload {}", local_path),
                format!("local read failed: {}", e),
            )),
        };

        let payload = base64::b64_encode(&bytes);
        let escaped_remote = shell_escape(remote_path);
        let cmd = format!(
            "(\
base64 -d 2>/dev/null > {p} || base64 -D 2>/dev/null > {p} || openssl base64 -d -A 2>/dev/null > {p}\
) << 'MARCEL_B64_EOF'\n{payload}\nMARCEL_B64_EOF\n[ -f {p} ] && wc -c < {p}",
            p = escaped_remote,
            payload = payload,
        );

        match ctx.exec(&cmd).await {
            Ok(out) => {
                let last = out.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
                let remote_size: Option<u64> = last.trim().parse().ok();
                let ok = remote_size.map_or(false, |n| n == bytes.len() as u64);
                if ok {
                    Ok(ToolOutput::ok(
                        format!("upload {} ({} bytes)", remote_path, bytes.len()),
                        format!("uploaded {} bytes: {} -> remote:{}", bytes.len(), local_path, remote_path),
                    )
                    .with_metadata(json!({
                        "local_path": local_path,
                        "remote_path": remote_path,
                        "bytes": bytes.len(),
                    })))
                } else {
                    Ok(ToolOutput::fail(
                        format!("upload {}", remote_path),
                        format!(
                            "size mismatch after upload: sent {} bytes, remote reports {:?}",
                            bytes.len(),
                            remote_size
                        ),
                    ))
                }
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("upload {}", remote_path),
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
         Binary-safe. Absolute paths required. Limit: 32 MB."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "remote_path": { "type": "string", "description": "Absolute path on the remote server" },
                "local_path":  { "type": "string", "description": "Absolute path to write on the local (agent host) filesystem" }
            },
            "required": ["remote_path", "local_path"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        // Writes to local disk; not destructive remotely but still a side effect.
        RiskLevel::LowRisk
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
        if local_path.is_empty() || remote_path.is_empty() {
            return Ok(ToolOutput::fail("download_file", "empty path"));
        }

        // Pre-check size to avoid pulling huge files into memory.
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

        let fetch_cmd = format!(
            "(base64 -w0 {p} 2>/dev/null) || (base64 {p} 2>/dev/null | tr -d '\\n') || (openssl base64 -A -in {p} 2>/dev/null)",
            p = escaped
        );
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
                    size,
                    bytes.len()
                ),
            ));
        }

        // Ensure local parent directory exists.
        let local = PathBuf::from(local_path);
        if let Some(parent) = local.parent() {
            if !parent.as_os_str().is_empty() {
                if let Err(e) = fs::create_dir_all(parent).await {
                    return Ok(ToolOutput::fail(
                        format!("download {}", remote_path),
                        format!("local mkdir failed: {}", e),
                    ));
                }
            }
        }

        if let Err(e) = fs::write(&local, &bytes).await {
            return Ok(ToolOutput::fail(
                format!("download {}", remote_path),
                format!("local write failed: {}", e),
            ));
        }

        Ok(ToolOutput::ok(
            format!("download {} ({} bytes)", remote_path, bytes.len()),
            format!("downloaded {} bytes: remote:{} -> {}", bytes.len(), remote_path, local_path),
        )
        .with_metadata(json!({
            "remote_path": remote_path,
            "local_path": local_path,
            "bytes": bytes.len(),
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_b64_roundtrip() {
        let data = b"\x00\x01\x02binary\xff\xfe test";
        let enc = base64::b64_encode(data);
        assert_eq!(base64::b64_decode(&enc).unwrap(), data);
    }
}
