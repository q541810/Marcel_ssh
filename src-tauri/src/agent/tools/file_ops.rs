//! File-system tools (read / write / edit / list).
//!
//! Implementation strategy
//! -----------------------
//! Reading and writing arbitrary file contents over `cat`/heredoc is fragile:
//! shells choke on embedded EOF markers, NULs, CRs, and 8-bit data. Instead
//! we wrap the payload with **base64**, which is universally supported and
//! transparent to the shell. `base64`/`openssl base64` are part of every
//! mainstream Linux distribution; we fall back across both.
//!
//! - `read_file`  : `base64 -w0 <path>` -> decode locally
//! - `write_file` : encode locally -> `base64 -d > <path>`
//! - `edit_file`  : read, locate `old_content`, replace, write back
//! - `list_directory` : `ls -la --color=never <path>`
//!
//! All tools shell-escape their path arguments via [`shell_escape`].

use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::base64;
use crate::agent::tools::{
    shell_escape, truncate_output, AgentTool, ToolContext, ToolOutput,
};
use crate::error::AppError;

const MAX_READ_BYTES: usize = 16_000;
const MAX_LIST_BYTES: usize = 8_000;
const MAX_FILE_WRITE_BYTES: usize = 1_000_000;

// ────────────────────────────── helpers ──────────────────────────────

/// Build a portable command that base64-encodes a file's contents to stdout.
/// Tries GNU `base64 -w0`, falls back to BSD `base64`, then `openssl base64 -A`.
fn cmd_read_b64(path_escaped: &str) -> String {
    format!(
        "(base64 -w0 {p} 2>/dev/null) || (base64 {p} 2>/dev/null | tr -d '\\n') || (openssl base64 -A -in {p} 2>/dev/null)",
        p = path_escaped
    )
}

/// Build a command that decodes base64 from a here-doc into the target path.
fn cmd_write_b64(path_escaped: &str, b64_payload: &str) -> String {
    // We use a here-doc with a unique sentinel and quote the sentinel so the
    // shell does no expansion on the payload. base64 with `-d` is GNU; BSD
    // accepts `-D`. We try `-d` first then fall back to `-D` and openssl.
    format!(
        "(\
base64 -d 2>/dev/null > {p} || base64 -D 2>/dev/null > {p} || openssl base64 -d -A 2>/dev/null > {p}\
) << 'MARCEL_B64_EOF'\n{payload}\nMARCEL_B64_EOF",
        p = path_escaped,
        payload = b64_payload,
    )
}

// ────────────────────────────── ReadFileTool ──────────────────────────────

pub struct ReadFileTool;

impl ReadFileTool { pub fn new() -> Self { Self } }
impl Default for ReadFileTool { fn default() -> Self { Self::new() } }

#[async_trait]
impl AgentTool for ReadFileTool {
    fn name(&self) -> &str { "read_file" }

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

    fn risk_level(&self) -> RiskLevel { RiskLevel::ReadOnly }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params.get("path").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'path' parameter".into()))?;
        if path.is_empty() {
            return Ok(ToolOutput::fail("read_file", "empty path"));
        }
        let escaped = shell_escape(path);
        let cmd = cmd_read_b64(&escaped);

        match ctx.exec(&cmd).await {
            Ok(b64) => {
                let trimmed = b64.trim();
                if trimmed.is_empty() {
                    return Ok(ToolOutput::fail(
                        format!("read {}", path),
                        "remote returned no data (file missing, empty, or base64 unavailable)",
                    ));
                }
                match base64::b64_decode(trimmed) {
                    Ok(bytes) => {
                        let n = bytes.len();
                        let text = String::from_utf8_lossy(&bytes).into_owned();
                        let body = truncate_output(text, MAX_READ_BYTES);
                        Ok(ToolOutput::ok(
                            format!("read {} ({} bytes)", path, n),
                            body,
                        )
                        .with_metadata(json!({ "path": path, "bytes": n })))
                    }
                    Err(e) => Ok(ToolOutput::fail(
                        format!("read {}", path),
                        format!("decode error: {}", e),
                    )),
                }
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("read {}", path),
                format!("read failed: {}", e),
            )),
        }
    }
}

// ────────────────────────────── WriteFileTool ──────────────────────────────

pub struct WriteFileTool;
impl WriteFileTool { pub fn new() -> Self { Self } }
impl Default for WriteFileTool { fn default() -> Self { Self::new() } }

#[async_trait]
impl AgentTool for WriteFileTool {
    fn name(&self) -> &str { "write_file" }

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

    fn risk_level(&self) -> RiskLevel { RiskLevel::Moderate }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params.get("path").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'path' parameter".into()))?;
        let content = params.get("content").and_then(|v| v.as_str())
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

        let escaped = shell_escape(path);
        let payload = base64::b64_encode(content.as_bytes());
        // Always check the resulting file size to confirm success.
        let cmd = format!(
            "{write}\n[ -f {p} ] && wc -c < {p}",
            write = cmd_write_b64(&escaped, &payload),
            p = escaped
        );

        match ctx.exec(&cmd).await {
            Ok(out) => {
                // Best-effort: parse the trailing wc number if present.
                let last_line = out.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
                let written: Option<u64> = last_line.trim().parse().ok();
                let lines = content.lines().count();
                let summary = format!("write {} ({} lines)", path, lines);
                let body = match written {
                    Some(n) => format!("wrote {} bytes to {}", n, path),
                    None => format!(
                        "wrote {} bytes to {} (size verification unavailable)",
                        content.len(), path
                    ),
                };
                Ok(ToolOutput::ok(summary, body).with_metadata(json!({
                    "path": path,
                    "bytes_sent": content.len(),
                    "bytes_written": written,
                })))
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("write {}", path),
                format!("write failed: {}", e),
            )),
        }
    }
}

// ────────────────────────────── EditFileTool ──────────────────────────────

pub struct EditFileTool;
impl EditFileTool { pub fn new() -> Self { Self } }
impl Default for EditFileTool { fn default() -> Self { Self::new() } }

#[async_trait]
impl AgentTool for EditFileTool {
    fn name(&self) -> &str { "edit_file" }

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

    fn risk_level(&self) -> RiskLevel { RiskLevel::Moderate }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params.get("path").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'path' parameter".into()))?;
        let old_content = params.get("old_content").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'old_content' parameter".into()))?;
        let new_content = params.get("new_content").and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'new_content' parameter".into()))?;
        let replace_all = params.get("replace_all").and_then(|v| v.as_bool()).unwrap_or(false);

        if path.is_empty() {
            return Ok(ToolOutput::fail("edit_file", "empty path"));
        }
        if old_content.is_empty() {
            return Ok(ToolOutput::fail(
                format!("edit {}", path),
                "old_content must not be empty",
            ));
        }

        // 1. Read current file
        let escaped = shell_escape(path);
        let raw = match ctx.exec(&cmd_read_b64(&escaped)).await {
            Ok(b) => b,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    format!("edit {}", path),
                    format!("read failed: {}", e),
                ));
            }
        };
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Ok(ToolOutput::fail(
                format!("edit {}", path),
                "remote file missing or unreadable",
            ));
        }
        let current_bytes = match base64::b64_decode(trimmed) {
            Ok(b) => b,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    format!("edit {}", path),
                    format!("decode error: {}", e),
                ));
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

        // 4. Write back
        let payload = base64::b64_encode(updated.as_bytes());
        let cmd = cmd_write_b64(&escaped, &payload);
        match ctx.exec(&cmd).await {
            Ok(_) => Ok(ToolOutput::ok(
                format!("edit {} ({} replacement{})", path, occurrences, if occurrences == 1 { "" } else { "s" }),
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
impl ListDirectoryTool { pub fn new() -> Self { Self } }
impl Default for ListDirectoryTool { fn default() -> Self { Self::new() } }

#[async_trait]
impl AgentTool for ListDirectoryTool {
    fn name(&self) -> &str { "list_directory" }

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

    fn risk_level(&self) -> RiskLevel { RiskLevel::ReadOnly }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let path = params.get("path").and_then(|v| v.as_str()).unwrap_or(".");
        let escaped = shell_escape(path);
        // --color=never may not exist on BSD; fall back gracefully.
        let cmd = format!(
            "ls -la --color=never {p} 2>/dev/null || ls -la {p}",
            p = escaped
        );
        match ctx.exec(&cmd).await {
            Ok(output) => {
                let entries = output.lines().count();
                let body = truncate_output(output, MAX_LIST_BYTES);
                Ok(ToolOutput::ok(
                    format!("list {} ({} entries)", path, entries),
                    body,
                )
                .with_metadata(json!({ "path": path, "entries": entries })))
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("list {}", path),
                format!("list failed: {}", e),
            )),
        }
    }
}

// ────────────────────────────── tests ──────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_roundtrip_text() {
        let cases = [
            "",
            "a",
            "ab",
            "abc",
            "hello, world",
            "中文 🚀 混合内容\n第二行\r\n第三行",
        ];
        for s in cases {
            let enc = base64::b64_encode(s.as_bytes());
            let dec = base64::b64_decode(&enc).unwrap();
            assert_eq!(dec, s.as_bytes(), "roundtrip failed for {:?}", s);
        }
    }

    #[test]
    fn b64_roundtrip_binary() {
        let bytes: Vec<u8> = (0u8..=255).collect();
        let enc = base64::b64_encode(&bytes);
        let dec = base64::b64_decode(&enc).unwrap();
        assert_eq!(dec, bytes);
    }

    #[test]
    fn b64_decode_ignores_whitespace() {
        let enc = "aGVs\nbG8s\nIHdv\ncmxk"; // "hello, world"
        let dec = base64::b64_decode(enc).unwrap();
        assert_eq!(dec, b"hello, world");
    }

    #[test]
    fn b64_decode_rejects_garbage() {
        assert!(base64::b64_decode("***").is_err());
    }

    #[test]
    fn cmd_helpers_quote_path() {
        let c = cmd_read_b64("'/etc/foo bar'");
        assert!(c.contains("'/etc/foo bar'"));
        let w = cmd_write_b64("'/tmp/x'", "AAAA");
        assert!(w.contains("MARCEL_B64_EOF"));
        assert!(w.contains("AAAA"));
    }
}
