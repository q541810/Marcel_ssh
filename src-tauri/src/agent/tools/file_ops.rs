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

// ───────────────────── Shared SFTP helpers ─────────────────────

async fn sftp_read(
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    path: &str,
) -> Result<Vec<u8>, String> {
    let sftp = ssh
        .open_sftp(session_id)
        .await
        .map_err(|e| format!("SFTP unavailable: {}", e))?;
    sftp.read(path)
        .await
        .map_err(|e| format!("SFTP read failed: {}", e))
}

async fn sftp_write(
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    path: &str,
    bytes: &[u8],
) -> Result<(), String> {
    let sftp = ssh
        .open_sftp(session_id)
        .await
        .map_err(|e| format!("SFTP unavailable: {}", e))?;
    let mut file = sftp
        .open_with_flags(
            path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| format!("open failed: {}", e))?;
    file.write_all(bytes)
        .await
        .map_err(|e| format!("write failed: {}", e))?;
    file.flush()
        .await
        .map_err(|e| format!("flush failed: {}", e))?;
    Ok(())
}

// ────────────────────────────── Parse helpers ──────────────────────────────

struct EditParams {
    path: String,
    old_content: String,
    new_content: String,
    replace_all: bool,
}

fn parse_edit_params(params: &serde_json::Value) -> Result<EditParams, String> {
    let path = params
        .get("path")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'path' parameter")?;
    let old_content = params
        .get("old_content")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'old_content' parameter")?;
    let new_content = params
        .get("new_content")
        .and_then(|v| v.as_str())
        .ok_or("Missing 'new_content' parameter")?;
    let replace_all = params
        .get("replace_all")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    if path.is_empty() {
        return Err("empty path".into());
    }
    if old_content.is_empty() {
        return Err("old_content must not be empty".into());
    }
    Ok(EditParams {
        path: path.to_string(),
        old_content: old_content.to_string(),
        new_content: new_content.to_string(),
        replace_all,
    })
}

const EDIT_DISPLAY_MAX_BYTES: usize = 16_000;
const EDIT_DISPLAY_CONTEXT_LINES: usize = 30;

fn line_number_at_byte(content: &str, byte_pos: usize) -> usize {
    let pos = byte_pos.min(content.len());
    content[..pos].lines().count() + 1
}

/// Non-overlapping left-to-right match starts (same as `str::replace`).
fn match_byte_positions(content: &str, target: &str) -> Vec<usize> {
    if target.is_empty() {
        return Vec::new();
    }
    let mut positions = Vec::new();
    let mut search_from = 0;
    while search_from <= content.len() {
        if let Some(rel) = content[search_from..].find(target) {
            let abs = search_from + rel;
            positions.push(abs);
            search_from = abs + target.len();
        } else {
            break;
        }
    }
    positions
}

fn match_line_positions(content: &str, target: &str) -> Vec<usize> {
    match_byte_positions(content, target)
        .into_iter()
        .map(|p| line_number_at_byte(content, p))
        .collect()
}

fn extract_window_around(
    content: &str,
    center_line_1: usize,
    span_lines: usize,
    context_lines: usize,
) -> (usize, String) {
    let lines: Vec<&str> = content.lines().collect();
    if lines.is_empty() {
        return (1, String::new());
    }
    let idx = center_line_1.saturating_sub(1).min(lines.len().saturating_sub(1));
    let start = idx.saturating_sub(context_lines);
    let end = (idx + span_lines.max(1) + context_lines).min(lines.len());
    (start + 1, lines[start..end].join("\n"))
}

fn extract_display_content(
    content: &str,
    line_position: usize,
    target_line_count: usize,
    context_lines: usize,
    max_bytes: usize,
) -> String {
    if content.len() <= max_bytes {
        return content.to_string();
    }
    let lines: Vec<&str> = content.lines().collect();
    let line_idx = line_position.saturating_sub(1);
    let start = line_idx.saturating_sub(context_lines);
    let end = (line_idx + target_line_count + context_lines).min(lines.len());
    lines[start..end].join("\n")
}

fn try_replace(
    current: &str,
    old_content: &str,
    new_content: &str,
    replace_all: bool,
) -> Result<(String, usize), String> {
    let occurrences = current.matches(old_content).count();
    if occurrences == 0 {
        return Err("old_content not found in file. Read the file again to refresh.".into());
    }
    if occurrences > 1 && !replace_all {
        return Err(format!(
            "old_content matches {} times; pass replace_all=true or supply more context",
            occurrences
        ));
    }
    let updated = if replace_all {
        current.replace(old_content, new_content)
    } else {
        current.replacen(old_content, new_content, 1)
    };
    if updated.len() > MAX_FILE_WRITE_BYTES {
        return Err(format!(
            "result exceeds size limit ({} bytes; limit {})",
            updated.len(),
            MAX_FILE_WRITE_BYTES
        ));
    }
    Ok((updated, occurrences))
}

/// Summary + message for failed edit (same strings as `EditFileTool::execute`).
pub(crate) struct EditPreviewError {
    pub summary: String,
    pub message: String,
}

fn build_edit_display_metadata(
    path: &str,
    current: &str,
    updated: &str,
    old_content: &str,
    new_content: &str,
    occurrences: usize,
) -> serde_json::Value {
    let byte_positions = match_byte_positions(current, old_content);
    let match_lines = match_line_positions(current, old_content);
    let line_position = match_lines.first().copied().unwrap_or(1);
    let line_count = updated.lines().count();
    let old_line_span = old_content.lines().count().max(1);
    let new_line_span = new_content.lines().count().max(1);
    let delta_bytes = new_content.len() as isize - old_content.len() as isize;

    let small_enough =
        current.len() <= EDIT_DISPLAY_MAX_BYTES && updated.len() <= EDIT_DISPLAY_MAX_BYTES;

    if small_enough {
        return json!({
            "path": path,
            "occurrences": occurrences,
            "old_bytes": current.len(),
            "new_bytes": updated.len(),
            "line_position": line_position,
            "line_count": line_count,
            "match_line_positions": match_lines,
            "before": current,
            "after": updated,
            // Compat for older FileChangeView fallback
            "file_content": updated,
        });
    }

    // Large file: per-match context windows on before/after.
    let mut hunks = Vec::new();
    for (i, &byte_pos) in byte_positions.iter().enumerate() {
        let before_line = line_number_at_byte(current, byte_pos);
        let (start_line, before_snip) = extract_window_around(
            current,
            before_line,
            old_line_span,
            EDIT_DISPLAY_CONTEXT_LINES,
        );
        let updated_byte = (byte_pos as isize + i as isize * delta_bytes).max(0) as usize;
        let updated_byte = updated_byte.min(updated.len());
        let after_line = line_number_at_byte(updated, updated_byte);
        let (_after_start, after_snip) = extract_window_around(
            updated,
            after_line,
            new_line_span,
            EDIT_DISPLAY_CONTEXT_LINES,
        );
        // Cap each snip so a single huge line cannot blow the event payload.
        let before_snip = if before_snip.len() > EDIT_DISPLAY_MAX_BYTES {
            extract_display_content(
                &before_snip,
                1,
                old_line_span,
                EDIT_DISPLAY_CONTEXT_LINES,
                EDIT_DISPLAY_MAX_BYTES,
            )
        } else {
            before_snip
        };
        let after_snip = if after_snip.len() > EDIT_DISPLAY_MAX_BYTES {
            extract_display_content(
                &after_snip,
                1,
                new_line_span,
                EDIT_DISPLAY_CONTEXT_LINES,
                EDIT_DISPLAY_MAX_BYTES,
            )
        } else {
            after_snip
        };
        hunks.push(json!({
            "startLine": start_line,
            "before": before_snip,
            "after": after_snip,
        }));
    }

    let first_after = hunks
        .first()
        .and_then(|h| h.get("after"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    json!({
        "path": path,
        "occurrences": occurrences,
        "old_bytes": current.len(),
        "new_bytes": updated.len(),
        "line_position": line_position,
        "line_count": line_count,
        "match_line_positions": match_lines,
        "hunks": hunks,
        "file_content": first_after,
    })
}

/// Read remote file and validate the edit would succeed (no write).
/// Used before human approval so the dialog can show full-file context diff.
pub(crate) async fn preview_edit_for_approval(
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    params: &serde_json::Value,
) -> Result<serde_json::Value, EditPreviewError> {
    let edit = parse_edit_params(params).map_err(|e| EditPreviewError {
        summary: "edit_file".into(),
        message: e,
    })?;

    let current_bytes = sftp_read(ssh, session_id, &edit.path)
        .await
        .map_err(|e| EditPreviewError {
            summary: format!("edit {}", edit.path),
            message: e,
        })?;

    let current = String::from_utf8(current_bytes).map_err(|_| EditPreviewError {
        summary: format!("edit {}", edit.path),
        message: "file is not valid UTF-8; edit_file requires text files".into(),
    })?;

    let (updated, occurrences) = try_replace(
        &current,
        &edit.old_content,
        &edit.new_content,
        edit.replace_all,
    )
    .map_err(|e| EditPreviewError {
        summary: format!("edit {}", edit.path),
        message: e,
    })?;

    Ok(build_edit_display_metadata(
        &edit.path,
        &current,
        &updated,
        &edit.old_content,
        &edit.new_content,
        occurrences,
    ))
}

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

        let bytes = match sftp_read(&ctx.ssh, &ctx.session_id, path).await {
            Ok(data) => data,
            Err(e) => {
                return Ok(ToolOutput::fail(format!("read {}", path), e));
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
        "Write UTF-8 text to a file on the remote server via SFTP, creating or \
         overwriting it. Maximum size: 1 MB per call; split larger writes. \
         Prefer absolute paths. Pass plain text content (not base64-encoded)."
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
        match sftp_write(&ctx.ssh, &ctx.session_id, path, bytes).await {
            Ok(()) => {
                let lines = content.lines().count();
                Ok(ToolOutput::ok(
                    format!("write {} ({} lines)", path, lines),
                    format!("wrote {} bytes to {}", bytes.len(), path),
                )
                .with_metadata(json!({
                    "path": path,
                    "bytes_sent": bytes.len(),
                })))
            }
            Err(e) => Ok(ToolOutput::fail(format!("write {}", path), e)),
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
        let edit = match parse_edit_params(&params) {
            Ok(p) => p,
            Err(e) => return Ok(ToolOutput::fail("edit_file", e)),
        };

        let current_bytes = match sftp_read(&ctx.ssh, &ctx.session_id, &edit.path).await {
            Ok(data) => data,
            Err(e) => return Ok(ToolOutput::fail(format!("edit {}", edit.path), e)),
        };

        let current = match String::from_utf8(current_bytes) {
            Ok(s) => s,
            Err(_) => {
                return Ok(ToolOutput::fail(
                    format!("edit {}", edit.path),
                    "file is not valid UTF-8; edit_file requires text files",
                ));
            }
        };

        let (updated, occurrences) = match try_replace(
            &current,
            &edit.old_content,
            &edit.new_content,
            edit.replace_all,
        ) {
            Ok(result) => result,
            Err(e) => return Ok(ToolOutput::fail(format!("edit {}", edit.path), e)),
        };

        let metadata = build_edit_display_metadata(
            &edit.path,
            &current,
            &updated,
            &edit.old_content,
            &edit.new_content,
            occurrences,
        );

        match sftp_write(&ctx.ssh, &ctx.session_id, &edit.path, updated.as_bytes()).await {
            Ok(()) => Ok(ToolOutput::ok(
                format!(
                    "edit {} ({} replacement{})",
                    edit.path,
                    occurrences,
                    if occurrences == 1 { "" } else { "s" }
                ),
                format!(
                    "replaced {} occurrence(s) in {} ({} -> {} bytes)",
                    occurrences,
                    edit.path,
                    current.len(),
                    updated.len()
                ),
            )
            .with_metadata(metadata)),
            Err(e) => Ok(ToolOutput::fail(format!("edit {}", edit.path), e)),
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

    // ── edit display metadata ──

    #[test]
    fn match_byte_positions_non_overlapping() {
        let positions = match_byte_positions("aa aa aa", "aa");
        assert_eq!(positions, vec![0, 3, 6]);
    }

    #[test]
    fn build_metadata_small_file_has_before_after() {
        let current = "x\nfoo\ny\nfoo\nz\n";
        let (updated, n) = try_replace(current, "foo", "bar", true).unwrap();
        assert_eq!(n, 2);
        let meta = build_edit_display_metadata("/t", current, &updated, "foo", "bar", n);
        assert_eq!(meta["occurrences"], 2);
        assert_eq!(meta["before"], current);
        assert_eq!(meta["after"], updated);
        let lines = meta["match_line_positions"].as_array().unwrap();
        assert_eq!(lines.len(), 2);
        assert!(meta.get("hunks").is_none());
    }

    #[test]
    fn build_metadata_large_file_emits_hunks() {
        let pad = "line\n".repeat(4000); // ~20k
        let current = format!("{pad}TARGET\nmiddle\nTARGET\n{pad}");
        let (updated, n) = try_replace(&current, "TARGET", "DONE", true).unwrap();
        assert_eq!(n, 2);
        assert!(current.len() > EDIT_DISPLAY_MAX_BYTES);
        let meta = build_edit_display_metadata("/big", &current, &updated, "TARGET", "DONE", n);
        let hunks = meta["hunks"].as_array().expect("hunks");
        assert_eq!(hunks.len(), 2);
        assert!(hunks[0]["before"].as_str().unwrap().contains("TARGET"));
        assert!(hunks[0]["after"].as_str().unwrap().contains("DONE"));
        assert!(meta.get("before").is_none());
    }

    // ── try_replace tests ──

    #[test]
    fn try_replace_single_occurrence() {
        let result = try_replace("hello world", "world", "there", false);
        assert!(result.is_ok());
        let (updated, occurrences) = result.unwrap();
        assert_eq!(updated, "hello there");
        assert_eq!(occurrences, 1);
    }

    #[test]
    fn try_replace_all() {
        let result = try_replace("a a a", "a", "b", true);
        let (updated, occurrences) = result.unwrap();
        assert_eq!(updated, "b b b");
        assert_eq!(occurrences, 3);
    }

    #[test]
    fn try_replace_not_found() {
        let result = try_replace("hello", "world", "x", false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not found"));
    }

    #[test]
    fn try_replace_multiple_without_replace_all() {
        let result = try_replace("hello hello", "hello", "x", false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("matches 2 times"));
    }

    #[test]
    fn try_replace_result_too_large() {
        // File is just under the limit, replacing a small sentinel pushes it over
        let sentinel = "START";
        let pad = "a".repeat((MAX_FILE_WRITE_BYTES - 20).max(1));
        let current = format!("{}{}END", sentinel, pad);
        assert!(current.len() < MAX_FILE_WRITE_BYTES);
        let result = try_replace(&current, sentinel, &"b".repeat(30), false);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exceeds size limit"));
    }

    #[test]
    fn try_replace_new_content_can_be_empty() {
        let result = try_replace("hello world", " world", "", false);
        let (updated, occurrences) = result.unwrap();
        assert_eq!(updated, "hello");
        assert_eq!(occurrences, 1);
    }

    // ── parse_edit_params tests ──

    fn edit_json(path: &str, old: &str, new: &str) -> serde_json::Value {
        json!({"path": path, "old_content": old, "new_content": new})
    }

    #[test]
    fn parse_edit_params_all_fields() {
        let params = edit_json("/a.txt", "old", "new");
        let p = parse_edit_params(&params).unwrap();
        assert_eq!(p.path, "/a.txt");
        assert_eq!(p.old_content, "old");
        assert_eq!(p.new_content, "new");
        assert!(!p.replace_all);
    }

    #[test]
    fn parse_edit_params_replace_all_true() {
        let mut params = edit_json("/a.txt", "old", "new");
        params["replace_all"] = json!(true);
        let p = parse_edit_params(&params).unwrap();
        assert!(p.replace_all);
    }

    #[test]
    fn parse_edit_params_missing_path() {
        let params = json!({"old_content": "x", "new_content": "y"});
        assert!(parse_edit_params(&params).is_err());
    }

    #[test]
    fn parse_edit_params_missing_old_content() {
        let params = json!({"path": "/a", "new_content": "y"});
        assert!(parse_edit_params(&params).is_err());
    }

    #[test]
    fn parse_edit_params_empty_path() {
        let params = edit_json("", "old", "new");
        assert!(parse_edit_params(&params).is_err());
    }

    #[test]
    fn parse_edit_params_empty_old_content() {
        let params = edit_json("/a.txt", "", "new");
        assert!(parse_edit_params(&params).is_err());
    }

    // ── existing tests ──

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
