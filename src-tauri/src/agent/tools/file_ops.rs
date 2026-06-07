//! File-system tools (read / write / edit / list).
//!
//! Uses the SFTP subsystem protocol for binary-safe file operations.
//! Falls back to base64-over-exec if SFTP is unavailable.

use async_trait::async_trait;
use russh_sftp::protocol::OpenFlags;
use serde_json::json;
use tokio::io::AsyncWriteExt;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

const MAX_READ_BYTES: usize = 16_000;
const MAX_LIST_BYTES: usize = 8_000;
const MAX_FILE_WRITE_BYTES: usize = 1_000_000;

// ────────────────────────────── ReadFileTool ──────────────────────────────

pub struct ReadFileTool;

impl ReadFileTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for ReadFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for ReadFileTool {
    fn name(&self) -> &str {
        "read_file"
    }

    fn description(&self) -> &str {
        "Read a file from the remote server. Binary-safe (transferred via base64). \
         Output is returned as UTF-8; non-UTF-8 bytes are replaced. Long files \
         are truncated."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path to the file" }
            },
            "required": ["path"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'path' parameter".into()))?;
        if path.is_empty() {
            return Ok(ToolOutput::fail("read_file", "empty path"));
        }

        let bytes = match ctx.ssh.open_sftp(&ctx.session_id).await {
            Ok(sftp) => match sftp.read(path).await {
                Ok(data) => data,
                Err(e) => {
                    return Ok(ToolOutput::fail(
                        format!("read {}", path),
                        format!("SFTP read failed: {}", e),
                    ))
                }
            },
            Err(e) => {
                return Ok(ToolOutput::fail(
                    format!("read {}", path),
                    format!("SFTP unavailable: {}", e),
                ))
            }
        };

        let n = bytes.len();
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let body = truncate_output(text, MAX_READ_BYTES);
        Ok(ToolOutput::ok(format!("read {} ({} bytes)", path, n), body)
            .with_metadata(json!({ "path": path, "bytes": n })))
    }
}

// ────────────────────────────── WriteFileTool ──────────────────────────────

pub struct WriteFileTool;
impl WriteFileTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for WriteFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for WriteFileTool {
    fn name(&self) -> &str {
        "write_file"
    }

    fn description(&self) -> &str {
        "Write content to a file on the remote server, creating or overwriting it. \
         Content is transferred via base64 so binary data and embedded heredoc \
         markers are safe. Maximum size: 1 MB."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path":    { "type": "string", "description": "Absolute path to the file" },
                "content": { "type": "string", "description": "UTF-8 content to write" }
            },
            "required": ["path", "content"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::Moderate
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'path' parameter".into()))?;
        let content = params
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'content' parameter".into()))?;
        if path.is_empty() {
            return Ok(ToolOutput::fail("write_file", "empty path"));
        }
        if content.len() > MAX_FILE_WRITE_BYTES {
            return Ok(ToolOutput::fail(
                format!("write {}", path),
                format!(
                    "content too large: {} bytes (limit {} bytes). Split the write.",
                    content.len(),
                    MAX_FILE_WRITE_BYTES
                ),
            ));
        }

        let bytes = content.as_bytes();

        match ctx.ssh.open_sftp(&ctx.session_id).await {
            Ok(sftp) => {
                let write_result = async {
                    let mut file = sftp
                        .open_with_flags(
                            path,
                            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                        )
                        .await
                        .map_err(|e| AppError::Ssh(format!("open failed: {}", e)))?;

                    file.write_all(bytes)
                        .await
                        .map_err(|e| AppError::Ssh(format!("write failed: {}", e)))?;

                    file.flush()
                        .await
                        .map_err(|e| AppError::Ssh(format!("flush failed: {}", e)))?;

                    Ok::<(), AppError>(())
                }
                .await;

                match write_result {
                    Ok(()) => {
                        let lines = content.lines().count();
                        let summary = format!("write {} ({} lines)", path, lines);
                        let body = format!("wrote {} bytes to {}", bytes.len(), path);
                        Ok(ToolOutput::ok(summary, body).with_metadata(json!({
                            "path": path,
                            "bytes_sent": bytes.len(),
                        })))
                    }
                    Err(e) => Ok(ToolOutput::fail(
                        format!("write {}", path),
                        format!("write failed: {}", e),
                    )),
                }
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("write {}", path),
                format!("SFTP unavailable: {}", e),
            )),
        }
    }
}

// ────────────────────────────── EditFileTool ──────────────────────────────

pub struct EditFileTool;
impl EditFileTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for EditFileTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for EditFileTool {
    fn name(&self) -> &str {
        "edit_file"
    }

    fn description(&self) -> &str {
        "Precisely edit a file by replacing an exact occurrence of `old_content` \
         with `new_content`. Fails if `old_content` is missing or appears more \
         than once (unless `replace_all` is true). Always read the file first \
         to obtain `old_content` verbatim."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path":        { "type": "string", "description": "Absolute path to the file" },
                "old_content": { "type": "string", "description": "Exact text currently in the file" },
                "new_content": { "type": "string", "description": "Replacement text" },
                "replace_all": { "type": "boolean", "description": "Replace all occurrences (default: false)", "default": false }
            },
            "required": ["path", "old_content", "new_content"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::Moderate
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'path' parameter".into()))?;
        let old_content = params
            .get("old_content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'old_content' parameter".into()))?;
        let new_content = params
            .get("new_content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'new_content' parameter".into()))?;
        let replace_all = params
            .get("replace_all")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        if path.is_empty() {
            return Ok(ToolOutput::fail("edit_file", "empty path"));
        }
        if old_content.is_empty() {
            return Ok(ToolOutput::fail(
                format!("edit {}", path),
                "old_content must not be empty",
            ));
        }

        // 1. Read current file via SFTP
        let current_bytes = match ctx.ssh.open_sftp(&ctx.session_id).await {
            Ok(sftp) => match sftp.read(path).await {
                Ok(data) => data,
                Err(e) => {
                    return Ok(ToolOutput::fail(
                        format!("edit {}", path),
                        format!("SFTP read failed: {}", e),
                    ))
                }
            },
            Err(e) => {
                return Ok(ToolOutput::fail(
                    format!("edit {}", path),
                    format!("SFTP unavailable: {}", e),
                ))
            }
        };

        let current = match String::from_utf8(current_bytes) {
            Ok(s) => s,
            Err(_) => {
                return Ok(ToolOutput::fail(
                    format!("edit {}", path),
                    "file is not valid UTF-8; edit_file requires text files",
                ));
            }
        };

        // 2. Locate match(es)
        let occurrences = current.matches(old_content).count();
        if occurrences == 0 {
            return Ok(ToolOutput::fail(
                format!("edit {}", path),
                "old_content not found in file. Read the file again to refresh.",
            ));
        }
        if occurrences > 1 && !replace_all {
            return Ok(ToolOutput::fail(
                format!("edit {}", path),
                format!(
                    "old_content matches {} times; pass replace_all=true or supply more context",
                    occurrences
                ),
            ));
        }

        // 3. Apply replacement
        let updated = if replace_all {
            current.replace(old_content, new_content)
        } else {
            current.replacen(old_content, new_content, 1)
        };

        if updated.len() > MAX_FILE_WRITE_BYTES {
            return Ok(ToolOutput::fail(
                format!("edit {}", path),
                format!(
                    "result exceeds size limit ({} bytes; limit {})",
                    updated.len(),
                    MAX_FILE_WRITE_BYTES
                ),
            ));
        }

        // 4. Write back via SFTP
        let write_result = async {
            let sftp = ctx
                .ssh
                .open_sftp(&ctx.session_id)
                .await
                .map_err(|e| AppError::Ssh(format!("SFTP unavailable: {}", e)))?;

            let mut file = sftp
                .open_with_flags(
                    path,
                    OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
                )
                .await
                .map_err(|e| AppError::Ssh(format!("open failed: {}", e)))?;

            file.write_all(updated.as_bytes())
                .await
                .map_err(|e| AppError::Ssh(format!("write failed: {}", e)))?;

            file.flush()
                .await
                .map_err(|e| AppError::Ssh(format!("flush failed: {}", e)))?;

            Ok::<(), AppError>(())
        }
        .await;

        match write_result {
            Ok(()) => Ok(ToolOutput::ok(
                format!(
                    "edit {} ({} replacement{})",
                    path,
                    occurrences,
                    if occurrences == 1 { "" } else { "s" }
                ),
                format!(
                    "replaced {} occurrence(s) in {} ({} -> {} bytes)",
                    occurrences,
                    path,
                    current.len(),
                    updated.len()
                ),
            )
            .with_metadata(json!({
                "path": path,
                "occurrences": occurrences,
                "old_bytes": current.len(),
                "new_bytes": updated.len(),
            }))),
            Err(e) => Ok(ToolOutput::fail(
                format!("edit {}", path),
                format!("write-back failed: {}", e),
            )),
        }
    }
}

// ────────────────────────────── ListDirectoryTool ──────────────────────────────

pub struct ListDirectoryTool;
impl ListDirectoryTool {
    pub fn new() -> Self {
        Self
    }
}
impl Default for ListDirectoryTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for ListDirectoryTool {
    fn name(&self) -> &str {
        "list_directory"
    }

    fn description(&self) -> &str {
        "List the contents of a directory on the remote server (long format, no color)."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path to the directory (default: '.')" }
            },
            "required": []
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params.get("path").and_then(|v| v.as_str()).unwrap_or(".");

        match ctx.ssh.open_sftp(&ctx.session_id).await {
            Ok(sftp) => {
                let mut output = String::new();
                let mut entries = 0;

                match sftp.read_dir(path).await {
                    Ok(mut dir) => {
                        while let Some(entry) = dir.next() {
                            let metadata = entry.metadata();
                            let name = entry.file_name();
                            let size = metadata.len();
                            let permissions = metadata.permissions.unwrap_or(0);
                            let is_dir = metadata.is_dir();
                            let is_link = metadata.is_symlink();

                            let type_char = if is_dir {
                                'd'
                            } else if is_link {
                                'l'
                            } else {
                                '-'
                            };
                            let perms_str = format_permissions(permissions);

                            output.push_str(&format!(
                                "{} {} {:>8} {}\n",
                                type_char, perms_str, size, name
                            ));
                            entries += 1;
                        }
                    }
                    Err(e) => {
                        return Ok(ToolOutput::fail(
                            format!("list {}", path),
                            format!("SFTP list failed: {}", e),
                        ))
                    }
                }

                let body = truncate_output(output, MAX_LIST_BYTES);
                Ok(
                    ToolOutput::ok(format!("list {} ({} entries)", path, entries), body)
                        .with_metadata(json!({ "path": path, "entries": entries })),
                )
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("list {}", path),
                format!("SFTP unavailable: {}", e),
            )),
        }
    }
}

fn format_permissions(mode: u32) -> String {
    let is_dir = (mode & 0o170000) == 0o040000;
    let is_link = (mode & 0o170000) == 0o120000;
    let type_char = if is_dir {
        'd'
    } else if is_link {
        'l'
    } else {
        '-'
    };
    let perms = [
        if mode & 0o400 != 0 { 'r' } else { '-' },
        if mode & 0o200 != 0 { 'w' } else { '-' },
        if mode & 0o100 != 0 { 'x' } else { '-' },
        if mode & 0o040 != 0 { 'r' } else { '-' },
        if mode & 0o020 != 0 { 'w' } else { '-' },
        if mode & 0o010 != 0 { 'x' } else { '-' },
        if mode & 0o004 != 0 { 'r' } else { '-' },
        if mode & 0o002 != 0 { 'w' } else { '-' },
        if mode & 0o001 != 0 { 'x' } else { '-' },
    ];
    let mut result = String::with_capacity(10);
    result.push(type_char);
    result.extend(perms.iter());
    result
}

// ────────────────────────────── tests ──────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::base64;

    #[test]
    fn cmd_helpers_quote_path() {
        let c = base64::cmd_encode_file("'/etc/foo bar'");
        assert!(c.contains("'/etc/foo bar'"));
        let w = base64::cmd_decode_to_file("'/tmp/x'", "AAAA");
        assert!(w.contains("MARCEL_B64_EOF"));
        assert!(w.contains("AAAA"));
    }
}
