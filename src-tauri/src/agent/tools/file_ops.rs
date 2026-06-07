//! File-system tools (read / write / edit / list).
//!
//! Uses the SFTP subsystem protocol for binary-safe file operations.

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
const DEFAULT_READ_MAX_LINES: usize = 200;
const MAX_READ_MAX_LINES: usize = 2_000;
const DEFAULT_LIST_LIMIT: usize = 200;
const MAX_LIST_LIMIT: usize = 2_000;

struct ReadView {
    body: String,
    total_lines: usize,
    start_line: usize,
    end_line: usize,
    returned_lines: usize,
    next_line: Option<usize>,
    truncated: bool,
    lossy_utf8: bool,
}

#[derive(Clone)]
struct DirectoryEntryView {
    name: String,
    kind: String,
    size: u64,
    permissions: u32,
    permissions_text: String,
}

struct DirectoryView {
    body: String,
    total_entries: usize,
    returned_entries: usize,
    offset: usize,
    limit: usize,
    next_offset: Option<usize>,
    entries: Vec<DirectoryEntryView>,
}

#[derive(Clone, Copy)]
enum DirectorySortBy {
    Name,
    Size,
    Type,
}

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
        "Read a text file from the remote server with line numbers and pagination. \
         Use start_line and max_lines to continue through long files. Non-UTF-8 \
         bytes are replaced and reported in metadata."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Absolute path to the file" },
                "start_line": { "type": "integer", "description": "1-based first line to return (default: 1)", "default": 1 },
                "max_lines": { "type": "integer", "description": "Maximum lines to return (default: 200, max: 2000)", "default": 200 },
                "show_line_numbers": { "type": "boolean", "description": "Prefix each returned line with its line number (default: true)", "default": true }
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
        let start_line = params
            .get("start_line")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            .max(1) as usize;
        let max_lines = params
            .get("max_lines")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_READ_MAX_LINES as u64)
            .clamp(1, MAX_READ_MAX_LINES as u64) as usize;
        let show_line_numbers = params
            .get("show_line_numbers")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

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
        let read_view = build_read_view(&bytes, start_line, max_lines, show_line_numbers);
        let summary = format!(
            "read {} (lines {}-{} of {}, {} bytes)",
            path, read_view.start_line, read_view.end_line, read_view.total_lines, n
        );
        Ok(
            ToolOutput::ok(summary, read_view.body).with_metadata(json!({
                "path": path,
                "bytes": n,
                "total_lines": read_view.total_lines,
                "start_line": read_view.start_line,
                "end_line": read_view.end_line,
                "returned_lines": read_view.returned_lines,
                "next_line": read_view.next_line,
                "truncated": read_view.truncated,
                "lossy_utf8": read_view.lossy_utf8,
                "show_line_numbers": show_line_numbers
            })),
        )
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
        "List a remote directory with pagination, sorting, and structured metadata. \
         Defaults to the current directory and returns directories first by name."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string", "description": "Directory path; absolute paths are preferred, default: '.'", "default": "." },
                "offset": { "type": "integer", "description": "Number of sorted entries to skip (default: 0)", "default": 0 },
                "limit": { "type": "integer", "description": "Maximum entries to return (default: 200, max: 2000)", "default": 200 },
                "sort_by": { "type": "string", "enum": ["name", "size", "type"], "description": "Sort entries by name, size, or type (default: name)", "default": "name" }
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
        let offset = params.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let limit = params
            .get("limit")
            .and_then(|v| v.as_u64())
            .unwrap_or(DEFAULT_LIST_LIMIT as u64)
            .clamp(1, MAX_LIST_LIMIT as u64) as usize;
        let sort_by = parse_directory_sort_by(params.get("sort_by").and_then(|v| v.as_str()));

        match ctx.ssh.open_sftp(&ctx.session_id).await {
            Ok(sftp) => {
                let mut entries = Vec::new();

                match sftp.read_dir(path).await {
                    Ok(mut dir) => {
                        while let Some(entry) = dir.next() {
                            let metadata = entry.metadata();
                            let name = entry.file_name();
                            let size = metadata.len();
                            let permissions = metadata.permissions.unwrap_or(0);
                            let is_dir = metadata.is_dir();
                            let is_link = metadata.is_symlink();

                            let kind = if is_dir {
                                "directory"
                            } else if is_link {
                                "symlink"
                            } else {
                                "file"
                            };
                            entries.push(DirectoryEntryView {
                                name,
                                kind: kind.to_string(),
                                size,
                                permissions,
                                permissions_text: format_permissions(permissions),
                            });
                        }
                    }
                    Err(e) => {
                        return Ok(ToolOutput::fail(
                            format!("list {}", path),
                            format!("SFTP list failed: {}", e),
                        ))
                    }
                }

                let view = build_directory_view(entries, offset, limit, sort_by);
                Ok(ToolOutput::ok(
                    format!(
                        "list {} ({} of {} entries)",
                        path, view.returned_entries, view.total_entries
                    ),
                    view.body,
                )
                .with_metadata(json!({
                    "path": path,
                    "total_entries": view.total_entries,
                    "returned_entries": view.returned_entries,
                    "offset": view.offset,
                    "limit": view.limit,
                    "next_offset": view.next_offset,
                    "entries": directory_entries_metadata(&view.entries)
                })))
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("list {}", path),
                format!("SFTP unavailable: {}", e),
            )),
        }
    }
}

fn format_permissions(mode: u32) -> String {
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
    let mut result = String::with_capacity(9);
    result.extend(perms.iter());
    result
}

fn build_read_view(
    bytes: &[u8],
    start_line: usize,
    max_lines: usize,
    show_line_numbers: bool,
) -> ReadView {
    let lossy_utf8 = std::str::from_utf8(bytes).is_err();
    let text = String::from_utf8_lossy(bytes);
    let lines: Vec<&str> = text.lines().collect();
    let total_lines = lines.len();

    let start_index = start_line.saturating_sub(1).min(total_lines);
    let end_index = start_index.saturating_add(max_lines).min(total_lines);
    let selected = &lines[start_index..end_index];

    let mut body = String::new();
    if lossy_utf8 {
        body.push_str("[warning: file contains non-UTF-8 bytes; invalid bytes were replaced]\n\n");
    }

    for (i, line) in selected.iter().enumerate() {
        let line_no = start_index + i + 1;
        if show_line_numbers {
            body.push_str(&format!("{:>6}: {}\n", line_no, line));
        } else {
            body.push_str(line);
            body.push('\n');
        }
    }

    let returned_lines = selected.len();
    let next_line = (end_index < total_lines).then_some(end_index + 1);
    let mut body = truncate_output(body, MAX_READ_BYTES);
    let truncated = next_line.is_some() || body.contains("[truncated to ");

    if let Some(next) = next_line {
        body.push_str(&format!(
            "\n[next: call read_file with start_line={} to continue]",
            next
        ));
    }

    ReadView {
        body,
        total_lines,
        start_line,
        end_line: end_index,
        returned_lines,
        next_line,
        truncated,
        lossy_utf8,
    }
}

fn parse_directory_sort_by(sort_by: Option<&str>) -> DirectorySortBy {
    match sort_by
        .map(str::trim)
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("size") => DirectorySortBy::Size,
        Some("type") => DirectorySortBy::Type,
        _ => DirectorySortBy::Name,
    }
}

fn build_directory_view(
    mut entries: Vec<DirectoryEntryView>,
    offset: usize,
    limit: usize,
    sort_by: DirectorySortBy,
) -> DirectoryView {
    entries.sort_by(|a, b| match sort_by {
        DirectorySortBy::Name => directory_kind_rank(&a.kind)
            .cmp(&directory_kind_rank(&b.kind))
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            }),
        DirectorySortBy::Size => b.size.cmp(&a.size).then_with(|| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        }),
        DirectorySortBy::Type => directory_kind_rank(&a.kind)
            .cmp(&directory_kind_rank(&b.kind))
            .then_with(|| {
                a.name
                    .to_ascii_lowercase()
                    .cmp(&b.name.to_ascii_lowercase())
            }),
    });

    let total_entries = entries.len();
    let start = offset.min(total_entries);
    let end = start.saturating_add(limit).min(total_entries);
    let page_entries = entries[start..end].to_vec();
    let next_offset = (end < total_entries).then_some(end);

    let mut body = String::new();
    body.push_str("TYPE       PERMISSIONS     SIZE NAME\n");
    for entry in &page_entries {
        body.push_str(&format!(
            "{:<10} {} {:>8} {}\n",
            entry.kind, entry.permissions_text, entry.size, entry.name
        ));
    }
    if let Some(next) = next_offset {
        body.push_str(&format!(
            "\n[next: call list_directory with offset={} to continue]",
            next
        ));
    }

    DirectoryView {
        body: truncate_output(body, MAX_LIST_BYTES),
        total_entries,
        returned_entries: page_entries.len(),
        offset: start,
        limit,
        next_offset,
        entries: page_entries,
    }
}

fn directory_kind_rank(kind: &str) -> u8 {
    match kind {
        "directory" => 0,
        "file" => 1,
        "symlink" => 2,
        _ => 3,
    }
}

fn directory_entries_metadata(entries: &[DirectoryEntryView]) -> Vec<serde_json::Value> {
    entries
        .iter()
        .map(|entry| {
            json!({
                "name": &entry.name,
                "kind": &entry.kind,
                "size": entry.size,
                "permissions": entry.permissions,
                "permissions_text": &entry.permissions_text
            })
        })
        .collect()
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

    #[test]
    fn build_read_view_adds_line_numbers_and_next_hint() {
        let bytes = b"one\ntwo\nthree\nfour\n";
        let view = build_read_view(bytes, 2, 2, true);

        assert_eq!(view.total_lines, 4);
        assert_eq!(view.start_line, 2);
        assert_eq!(view.end_line, 3);
        assert_eq!(view.returned_lines, 2);
        assert_eq!(view.next_line, Some(4));
        assert!(view.truncated);
        assert!(view.body.contains("     2: two"), "{}", view.body);
        assert!(view.body.contains("     3: three"), "{}", view.body);
        assert!(view.body.contains("start_line=4"), "{}", view.body);
    }

    #[test]
    fn build_read_view_reports_lossy_utf8() {
        let bytes = [0xff, b'\n', b'o', b'k'];
        let view = build_read_view(&bytes, 1, 10, true);

        assert!(view.lossy_utf8);
        assert!(view.body.contains("non-UTF-8"), "{}", view.body);
    }

    #[test]
    fn build_directory_view_sorts_directories_first_and_paginates() {
        let entries = vec![
            DirectoryEntryView {
                name: "z.txt".to_string(),
                kind: "file".to_string(),
                size: 10,
                permissions: 0o100644,
                permissions_text: format_permissions(0o100644),
            },
            DirectoryEntryView {
                name: "app".to_string(),
                kind: "directory".to_string(),
                size: 0,
                permissions: 0o040755,
                permissions_text: format_permissions(0o040755),
            },
            DirectoryEntryView {
                name: "a.txt".to_string(),
                kind: "file".to_string(),
                size: 1,
                permissions: 0o100644,
                permissions_text: format_permissions(0o100644),
            },
        ];

        let view = build_directory_view(entries, 0, 2, DirectorySortBy::Name);

        assert_eq!(view.total_entries, 3);
        assert_eq!(view.returned_entries, 2);
        assert_eq!(view.next_offset, Some(2));
        assert_eq!(view.entries[0].name, "app");
        assert_eq!(view.entries[1].name, "a.txt");
        assert!(view.body.contains("TYPE"), "{}", view.body);
        assert!(view.body.contains("offset=2"), "{}", view.body);
    }

    #[test]
    fn directory_entries_metadata_contains_structured_entries() {
        let entries = vec![DirectoryEntryView {
            name: "file.txt".to_string(),
            kind: "file".to_string(),
            size: 42,
            permissions: 0o100644,
            permissions_text: format_permissions(0o100644),
        }];

        let metadata = directory_entries_metadata(&entries);

        assert_eq!(metadata[0]["name"], "file.txt");
        assert_eq!(metadata[0]["kind"], "file");
        assert_eq!(metadata[0]["size"], 42);
        assert_eq!(metadata[0]["permissions_text"], "rw-r--r--");
    }
}
