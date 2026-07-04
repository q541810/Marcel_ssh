//! Built-in local handlers for plugin tools that declare `kind: "local"`.
//!
//! These are generic, kernel-registered handlers — any plugin can reference
//! them by name (e.g. `"fs.read"`, `"fs.append"`) without registering its own.
//! No memory-specific handler lives here; the long-term-memory plugin composes
//! its tools from the generic fs handlers.
//!
//! Capability checks are enforced by [`PluginAgentTool::execute`] before the
//! handler is called, using [`required_capability`]. The handler can assume
//! the calling plugin has declared the matching capability.

use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value};
use tauri::Emitter;

use crate::agent::tools::{LocalHandler, ToolContext, ToolRegistry};
use crate::commands::plugin_fs::{resolve_read_path, resolve_write_path};
use crate::error::AppError;

/// Event payload emitted after a plugin-scoped file is modified by a
/// `kind=local` handler. Plugin WebViews can listen on `plugin-fs-changed`
/// to refresh their views without polling.
#[derive(Clone, serde::Serialize)]
struct PluginFsChanged {
    plugin_id: String,
    path: String,
    op: &'static str,
}

/// Emit a `plugin-fs-changed` event so plugin WebViews can react to file
/// modifications done via `kind=local` handlers (e.g. agent memory_save).
/// Silently ignored if emission fails — the write itself already succeeded.
fn emit_fs_changed(ctx: &ToolContext, plugin_id: &str, path: &str, op: &'static str) {
    let _ = ctx.app_handle.emit(
        "plugin-fs-changed",
        PluginFsChanged {
            plugin_id: plugin_id.to_string(),
            path: path.to_string(),
            op,
        },
    );
}

/// Map a handler name to the capability a plugin must declare to use it.
/// Returns `None` for unknown handler names (the caller should reject the
/// tool registration entirely in that case).
pub fn required_capability(handler_name: &str) -> Option<&'static str> {
    match handler_name {
        "fs.read" => Some("fs.read"),
        "fs.write" | "fs.append" => Some("fs.write"),
        "session.info" | "connection.info" | "host_port" => Some("ssh.list"),
        _ => None,
    }
}

// ───────────────────────── fs handlers ─────────────────────────

/// `fs.read` handler: reads a file under the calling plugin's directory.
/// Params: `{ "path": "<relative-path>", "__plugin_id": "<id>" }`.
/// Returns: `{ "content": "<file-content>" }`.
pub struct FsReadHandler;

#[async_trait]
impl LocalHandler for FsReadHandler {
    async fn call(&self, params: Value, ctx: &ToolContext) -> Result<Value, AppError> {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other("fs.read 缺少 path 参数".into()))?;
        let plugin_id = params
            .get("__plugin_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other("fs.read 缺少 __plugin_id".into()))?;

        let file_path = resolve_read_path(&ctx.config_dir, plugin_id, path)?;
        let content = std::fs::read_to_string(&file_path)
            .map_err(|e| AppError::Other(format!("读取文件失败: {}", e)))?;
        Ok(json!({ "content": content }))
    }
}

/// `fs.write` handler: overwrites a file under the calling plugin's directory.
/// Params: `{ "path": "<relative-path>", "content": "<new-content>", "__plugin_id": "<id>" }`.
/// Returns: `{ "bytes_written": <n> }`.
pub struct FsWriteHandler;

#[async_trait]
impl LocalHandler for FsWriteHandler {
    async fn call(&self, params: Value, ctx: &ToolContext) -> Result<Value, AppError> {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other("fs.write 缺少 path 参数".into()))?;
        let content = params
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other("fs.write 缺少 content 参数".into()))?;
        let plugin_id = params
            .get("__plugin_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other("fs.write 缺少 __plugin_id".into()))?;

        let file_path = resolve_write_path(&ctx.config_dir, plugin_id, path)?;
        let bytes = content.len();
        std::fs::write(&file_path, content)
            .map_err(|e| AppError::Other(format!("写入文件失败: {}", e)))?;
        emit_fs_changed(ctx, plugin_id, path, "write");
        Ok(json!({ "bytes_written": bytes }))
    }
}

/// `fs.append` handler: appends to a file under the calling plugin's directory.
/// Creates the file (and parent directories) if they do not exist.
/// Params: `{ "path": "<relative-path>", "content": "<append-content>", "__plugin_id": "<id>" }`.
/// Returns: `{ "bytes_written": <n> }`.
pub struct FsAppendHandler;

#[async_trait]
impl LocalHandler for FsAppendHandler {
    async fn call(&self, params: Value, ctx: &ToolContext) -> Result<Value, AppError> {
        let path = params
            .get("path")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other("fs.append 缺少 path 参数".into()))?;
        let content = params
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other("fs.append 缺少 content 参数".into()))?;
        let plugin_id = params
            .get("__plugin_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Other("fs.append 缺少 __plugin_id".into()))?;

        let file_path = resolve_write_path(&ctx.config_dir, plugin_id, path)?;

        // JSONL convention: each entry on its own line. If the file already
        // exists and its last byte is not a newline (e.g. externally edited),
        // prepend one before appending to avoid gluing two entries together.
        let needs_leading_newline = file_path.exists()
            && std::fs::metadata(&file_path).map(|m| m.len() > 0).unwrap_or(false)
            && match std::fs::File::open(&file_path) {
                Ok(mut f) => {
                    use std::io::{Read, Seek, SeekFrom};
                    let mut tail = [0u8; 1];
                    f.seek(SeekFrom::End(-1)).is_ok()
                        && f.read_exact(&mut tail).is_ok()
                        && tail[0] != b'\n'
                }
                Err(_) => false,
            };

        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file_path)
            .map_err(|e| AppError::Other(format!("打开文件失败: {}", e)))?;
        // The memory_save tool description tells the model NOT to append a
        // trailing newline and promises "工具会自动处理追加" — honour that
        // here so multiple saves don't collapse into a single unparsable line.
        let mut bytes = content.len();
        if needs_leading_newline {
            file.write_all(b"\n")
                .map_err(|e| AppError::Other(format!("补写前置换行失败: {}", e)))?;
            bytes += 1;
        }
        file.write_all(content.as_bytes())
            .map_err(|e| AppError::Other(format!("追加写入失败: {}", e)))?;
        file.write_all(b"\n")
            .map_err(|e| AppError::Other(format!("追加换行失败: {}", e)))?;
        emit_fs_changed(ctx, plugin_id, path, "append");
        Ok(json!({ "bytes_written": bytes + 1 }))
    }
}

// ───────────────────────── session handlers ─────────────────────────

/// `session.info` handler: returns details about the current active session.
/// No params required (uses `ctx.session_id`).
/// Returns: `{ "session_id", "host", "port", "username", "connection_id" }`.
pub struct SessionInfoHandler;

#[async_trait]
impl LocalHandler for SessionInfoHandler {
    async fn call(&self, _params: Value, ctx: &ToolContext) -> Result<Value, AppError> {
        let info = ctx
            .ssh
            .get_session_info(&ctx.session_id)
            .await
            .ok_or_else(|| AppError::Other(format!("会话不存在: {}", ctx.session_id)))?;
        Ok(json!({
            "session_id": ctx.session_id,
            "host": info.host,
            "port": info.port,
            "username": info.username,
            "connection_id": info.connection_id,
        }))
    }
}

/// `connection.info` handler: returns connection details for the current session.
/// Returns: `{ "host", "port", "username", "connection_id" }`.
pub struct ConnectionInfoHandler;

#[async_trait]
impl LocalHandler for ConnectionInfoHandler {
    async fn call(&self, _params: Value, ctx: &ToolContext) -> Result<Value, AppError> {
        let info = ctx
            .ssh
            .get_session_info(&ctx.session_id)
            .await
            .ok_or_else(|| AppError::Other(format!("会话不存在: {}", ctx.session_id)))?;
        Ok(json!({
            "host": info.host,
            "port": info.port,
            "username": info.username,
            "connection_id": info.connection_id,
        }))
    }
}

/// `host_port` handler: returns the `host:port` string for the current session.
/// Returns: `{ "host_port": "1.2.3.4:22" }`.
pub struct HostPortHandler;

#[async_trait]
impl LocalHandler for HostPortHandler {
    async fn call(&self, _params: Value, ctx: &ToolContext) -> Result<Value, AppError> {
        let info = ctx
            .ssh
            .get_session_info(&ctx.session_id)
            .await
            .ok_or_else(|| AppError::Other(format!("会话不存在: {}", ctx.session_id)))?;
        Ok(json!({ "host_port": format!("{}:{}", info.host, info.port) }))
    }
}

// ───────────────────────── registration ─────────────────────────

/// Register all built-in local handlers on the given registry. Called once
/// at app startup; plugins reference these by name via `kind: "local"`.
pub fn register_default_handlers(registry: &mut ToolRegistry) {
    registry.register_local_handler("fs.read", Arc::new(FsReadHandler));
    registry.register_local_handler("fs.write", Arc::new(FsWriteHandler));
    registry.register_local_handler("fs.append", Arc::new(FsAppendHandler));
    registry.register_local_handler("session.info", Arc::new(SessionInfoHandler));
    registry.register_local_handler("connection.info", Arc::new(ConnectionInfoHandler));
    registry.register_local_handler("host_port", Arc::new(HostPortHandler));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::ToolRegistry;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn required_capability_mapping() {
        assert_eq!(required_capability("fs.read"), Some("fs.read"));
        assert_eq!(required_capability("fs.write"), Some("fs.write"));
        assert_eq!(required_capability("fs.append"), Some("fs.write"));
        assert_eq!(required_capability("session.info"), Some("ssh.list"));
        assert_eq!(required_capability("connection.info"), Some("ssh.list"));
        assert_eq!(required_capability("host_port"), Some("ssh.list"));
        assert_eq!(required_capability("unknown"), None);
    }

    #[test]
    fn register_default_handlers_registers_all_six() {
        let mut r = ToolRegistry::new();
        register_default_handlers(&mut r);
        for name in [
            "fs.read",
            "fs.write",
            "fs.append",
            "session.info",
            "connection.info",
            "host_port",
        ] {
            assert!(r.get_local_handler(name).is_some(), "missing {}", name);
        }
    }

    // Note: full handler-level integration tests would require a real
    // AppHandle (ToolContext.app_handle), which cannot be constructed in
    // unit tests. We therefore test the underlying path resolution and
    // capability mapping directly. The handler logic itself is a thin
    // wrapper over these primitives.

    #[tokio::test]
    async fn fs_read_rejects_path_traversal() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(tmp.path().join("secret.txt"), "secret").unwrap();

        // Directly test the underlying path resolution (the handler delegates to it)
        let result = resolve_read_path(tmp.path(), "test-plugin", "../secret.txt");
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fs_write_rejects_path_traversal() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();

        let result = resolve_write_path(tmp.path(), "test-plugin", "../../escape.txt");
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn fs_append_creates_parent_directories() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();

        // resolve_write_path creates parent dirs
        let resolved = resolve_write_path(tmp.path(), "test-plugin", "a/b/c/file.txt").unwrap();
        assert!(resolved.parent().unwrap().exists());

        // Simulate the append
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&resolved)
            .unwrap();
        file.write_all(b"first line\n").unwrap();
        file.write_all(b"second line\n").unwrap();

        let content = fs::read_to_string(&resolved).unwrap();
        assert_eq!(content, "first line\nsecond line\n");
    }

    /// Reproduces the JSONL粘行 bug: if a file ends without a trailing
    /// newline (e.g. externally edited) and we append a new entry, the
    /// two entries should NOT be glued together. The handler must
    /// prepend a leading newline in that case.
    #[tokio::test]
    async fn fs_append_prepends_newline_when_file_lacks_one() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();

        // Create a file WITHOUT a trailing newline (simulating external edit
        // or a hand-corrupted JSONL file).
        let resolved = resolve_write_path(tmp.path(), "test-plugin", "mem.jsonl").unwrap();
        fs::write(&resolved, "{\"id\":\"a\"}").unwrap(); // no \n at end

        // Replicate the handler's leading-newline detection logic.
        let needs_leading_newline = resolved.exists()
            && std::fs::metadata(&resolved).map(|m| m.len() > 0).unwrap_or(false)
            && match std::fs::File::open(&resolved) {
                Ok(mut f) => {
                    use std::io::{Read, Seek, SeekFrom};
                    let mut tail = [0u8; 1];
                    f.seek(SeekFrom::End(-1)).is_ok()
                        && f.read_exact(&mut tail).is_ok()
                        && tail[0] != b'\n'
                }
                Err(_) => false,
            };
        assert!(needs_leading_newline, "should detect missing trailing newline");

        // Append with the leading newline prepended.
        let mut file = OpenOptions::new().create(true).append(true).open(&resolved).unwrap();
        if needs_leading_newline {
            file.write_all(b"\n").unwrap();
        }
        file.write_all(b"{\"id\":\"b\"}\n").unwrap();

        let content = fs::read_to_string(&resolved).unwrap();
        assert_eq!(content, "{\"id\":\"a\"}\n{\"id\":\"b\"}\n");
        // Each line must be a valid standalone JSON object.
        for line in content.lines() {
            assert!(serde_json::from_str::<serde_json::Value>(line).is_ok());
        }
    }

    #[tokio::test]
    async fn host_port_handler_returns_correct_format_for_missing_session() {
        // The host_port handler should error when the session doesn't exist
        // (rather than panicking or returning a malformed string). We verify
        // by checking that a missing session produces a None lookup via the
        // SSH manager directly (the handler delegates to this).
        use crate::ssh::connection::SshManager;
        let ssh = SshManager::new();
        let result = ssh.get_session_info("nonexistent").await;
        assert!(result.is_none());
    }
}
