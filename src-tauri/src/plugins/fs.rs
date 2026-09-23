//! Plugin-scoped filesystem path resolution with path-traversal protection.
//!
//! Single source of truth for resolving plugin-relative paths. All callers
//! (Tauri commands, local handlers, HTTP API dispatch, URI scheme handler)
//! must route through these functions so the traversal invariant is enforced
//! in exactly one place.

use std::path::{Path, PathBuf};

use crate::error::AppError;

/// 插件清单文件名（写保护比较的唯一来源）。
pub const PLUGIN_MANIFEST_FILE_NAME: &str = "plugin.json";

/// `path`（插件根目录下的相对路径）是否指向插件清单 `plugin.json`。
///
/// 比较必须**大小写无关**：NTFS / APFS 默认大小写不敏感，`PLUGIN.JSON` 这类
/// 变体会解析回真实的 `plugin.json`（`candidate.exists()` 命中 → `canonicalize()`
/// 还原真实文件），按字面量比较等于给写保护开了个旁路。
/// 尾部的 `/`、空格与点一并忽略：Win32 会丢掉路径结尾的空格与点，
/// `PLUGIN.JSON ` 同样落在真实清单上。读取、写入、`preservePaths` 三处都走这里。
pub fn is_manifest_relative_path(path: &str) -> bool {
    let norm = path.replace('\\', "/");
    let name = norm
        .trim_end_matches('/')
        .trim_end_matches(|c: char| c == ' ' || c == '.');
    name.eq_ignore_ascii_case(PLUGIN_MANIFEST_FILE_NAME)
}

/// Check whether `candidate` resolves to a path inside `base_dir`.
///
/// Both paths are canonicalised before comparison, so symlinks and
/// `..` segments are resolved. Returns `false` if either path cannot
/// be canonicalised (e.g. the candidate does not exist).
pub fn is_within_base(base_dir: &Path, candidate: &Path) -> bool {
    let base = match base_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };
    match candidate.canonicalize() {
        Ok(p) => p.starts_with(&base),
        Err(_) => false,
    }
}

/// Resolve a plugin-relative read path, rejecting path traversal.
/// The file must already exist (canonicalize is used to normalise).
pub fn resolve_read_path(
    config_dir: &Path,
    plugin_id: &str,
    path: &str,
) -> Result<PathBuf, AppError> {
    // Block internal bookkeeping files before any FS access
    if !is_safe_relative_path(path) {
        return Err(AppError::Other("path traversal rejected".into()));
    }
    if is_manifest_relative_path(path) {
        return Err(AppError::Other("plugin.json access rejected".into()));
    }
    let plugin_dir = config_dir.join("plugins").join(plugin_id);
    let base_dir = plugin_dir
        .canonicalize()
        .map_err(|_| AppError::Other(format!("plugin directory not found: {}", plugin_id)))?;

    let candidate = plugin_dir.join(path);
    let file_path = candidate
        .canonicalize()
        .map_err(|_| AppError::Other(format!("path not found: {}", path)))?;

    if !file_path.starts_with(&base_dir) {
        return Err(AppError::Other("path traversal rejected".into()));
    }

    Ok(file_path)
}

/// Resolve a plugin-relative write path, rejecting path traversal.
/// The file does NOT need to exist yet; parent directories are created.
pub fn resolve_write_path(
    config_dir: &Path,
    plugin_id: &str,
    path: &str,
) -> Result<PathBuf, AppError> {
    if !is_safe_relative_path(path) {
        return Err(AppError::Other("path traversal rejected".into()));
    }
    if is_manifest_relative_path(path) {
        return Err(AppError::Other("plugin.json write rejected".into()));
    }
    let plugin_dir = config_dir.join("plugins").join(plugin_id);
    let base_dir = plugin_dir
        .canonicalize()
        .map_err(|_| AppError::Other(format!("plugin directory not found: {}", plugin_id)))?;

    let candidate = plugin_dir.join(path);

    if let Some(parent) = candidate.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AppError::Other(format!("failed to create directory: {}", e)))?;
    }

    let file_path = if candidate.exists() {
        let canonical = candidate
            .canonicalize()
            .map_err(|_| AppError::Other("path resolution failed".into()))?;
        if !canonical.starts_with(&base_dir) {
            return Err(AppError::Other("path traversal rejected".into()));
        }
        canonical
    } else {
        let parent = candidate.parent().unwrap_or(&candidate);
        let canonical_parent = parent
            .canonicalize()
            .map_err(|_| AppError::Other("parent directory resolution failed".into()))?;
        if !canonical_parent.starts_with(&base_dir) {
            return Err(AppError::Other("path traversal rejected".into()));
        }
        candidate
    };

    Ok(file_path)
}

/// Check whether `path` is a safe relative path for `preservePaths` / zip entries.
/// Rejects absolute paths, Windows drive letters, `..` traversal, `//` double
/// slashes, empty segments, and the internal `.marcel-shipped.json` file.
/// Allows a single trailing `/` for directory preserves (e.g. `data/`).
pub fn is_safe_relative_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 200 {
        return false;
    }
    if path.trim().is_empty() {
        return false;
    }
    if path.contains('\0') {
        return false;
    }
    // Internal bookkeeping file must never be preserved / extracted.
    if path == ".marcel-shipped.json" || path.starts_with(".marcel-shipped") {
        return false;
    }
    let norm = path.replace('\\', "/");
    if norm.starts_with('/') {
        return false;
    }
    if norm.len() >= 2 && norm.as_bytes()[1] == b':' {
        return false;
    }
    if norm.contains("//") {
        return false;
    }
    // Reject "." / "./" etc.
    if norm == "." || norm == "./" {
        return false;
    }
    for seg in norm.split('/') {
        if seg.is_empty() {
            // Allow single trailing slash -> last segment empty
            continue;
        }
        if seg == "." || seg == ".." {
            return false;
        }
        if seg == ".marcel-shipped.json" {
            return false;
        }
    }
    // After filtering empty trailing, must have at least one real segment
    let has_real = norm.split('/').any(|s| !s.is_empty() && s != ".");
    if !has_real {
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_plugin(tmp: &TempDir) -> PathBuf {
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();
        plugin_dir
    }

    #[test]
    fn resolve_valid_read_path_succeeds() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = make_plugin(&tmp);
        fs::write(plugin_dir.join("data.txt"), "hello").unwrap();

        let result = resolve_read_path(tmp.path(), "test-plugin", "data.txt");
        assert!(result.is_ok());
    }

    #[test]
    fn resolve_read_traversal_rejected() {
        let tmp = TempDir::new().unwrap();
        make_plugin(&tmp);
        fs::write(tmp.path().join("secret.txt"), "secret").unwrap();

        let result = resolve_read_path(tmp.path(), "test-plugin", "../secret.txt");
        assert!(result.is_err());
    }

    #[test]
    fn resolve_write_path_creates_intermediate_directories() {
        let tmp = TempDir::new().unwrap();
        make_plugin(&tmp);

        let result = resolve_write_path(tmp.path(), "test-plugin", "a/b/c/file.txt");
        assert!(result.is_ok());
        let resolved = result.unwrap();
        assert!(resolved.parent().unwrap().exists());
    }

    #[test]
    fn nonexistent_plugin_dir_fails() {
        let tmp = TempDir::new().unwrap();
        let result = resolve_read_path(tmp.path(), "nonexistent", "file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn write_traversal_with_nonexistent_parent_rejected() {
        let tmp = TempDir::new().unwrap();
        make_plugin(&tmp);

        let result = resolve_write_path(tmp.path(), "test-plugin", "../../escape.txt");
        assert!(result.is_err(), "path traversal must be rejected");
    }

    #[test]
    fn write_traversal_with_existing_target_rejected() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = make_plugin(&tmp);
        // Create a file outside the plugin dir, then attempt to overwrite it
        // via a traversal path that lands on an existing file.
        fs::write(tmp.path().join("outside.txt"), "x").unwrap();
        let result = resolve_write_path(tmp.path(), "test-plugin", "../outside.txt");
        assert!(result.is_err());
    }

    #[test]
    fn read_existing_nested_path_succeeds() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = make_plugin(&tmp);
        fs::create_dir_all(plugin_dir.join("assets")).unwrap();
        fs::write(plugin_dir.join("assets/style.css"), "").unwrap();

        let result = resolve_read_path(tmp.path(), "test-plugin", "assets/style.css");
        assert!(result.is_ok());
    }

    // ── is_within_base ──

    #[test]
    fn is_within_base_allows_nested() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("plugin");
        fs::create_dir_all(base.join("assets")).unwrap();
        fs::write(base.join("assets/style.css"), "").unwrap();
        assert!(is_within_base(&base, &base.join("assets/style.css")));
    }

    #[test]
    fn is_within_base_rejects_traversal() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("plugin");
        fs::create_dir_all(&base).unwrap();
        fs::write(tmp.path().join("secret.txt"), "secret").unwrap();
        assert!(!is_within_base(&base, &base.join("../secret.txt")));
    }

    #[test]
    fn is_within_base_rejects_nonexistent() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("plugin");
        fs::create_dir_all(&base).unwrap();
        assert!(!is_within_base(&base, &base.join("does-not-exist.txt")));
    }

    #[test]
    fn is_safe_relative_allows_valid() {
        assert!(is_safe_relative_path("config.json"));
        assert!(is_safe_relative_path("memories/"));
        assert!(is_safe_relative_path("data/file.txt"));
        assert!(is_safe_relative_path("a/b/c.txt"));
    }

    #[test]
    fn is_safe_relative_rejects_traversal_and_absolute() {
        assert!(!is_safe_relative_path("../evil"));
        assert!(!is_safe_relative_path("/abs/path"));
        assert!(!is_safe_relative_path("a/../b"));
        assert!(!is_safe_relative_path("C:/evil"));
        assert!(!is_safe_relative_path(""));
        assert!(!is_safe_relative_path("a//b"));
        assert!(!is_safe_relative_path(".marcel-shipped.json"));
    }

    // ── plugin.json 写保护（大小写 / 尾部写法变体） ──

    /// NTFS / APFS 默认大小写不敏感，`PLUGIN.JSON` 落回真实清单；Win32 还会
    /// 丢掉结尾的空格与点。这些写法都必须被认成清单文件。
    #[test]
    fn manifest_name_is_recognised_in_any_case_or_trailing_separator() {
        for variant in [
            "plugin.json",
            "PLUGIN.JSON",
            "Plugin.Json",
            "plugin.JSON",
            "PLUGIN.json",
            "plugin.json/",
            "PLUGIN.JSON/",
            "plugin.json ",
            "PLUGIN.JSON.",
        ] {
            assert!(
                is_manifest_relative_path(variant),
                "{} 必须被识别为插件清单",
                variant
            );
        }
        for allowed in [
            "plugin.json.bak",
            "pluginjson",
            "my-plugin.json",
            "data/plugin.json",
            "",
        ] {
            assert!(
                !is_manifest_relative_path(allowed),
                "{} 不是插件清单，不该误伤",
                allowed
            );
        }
    }

    /// 读 / 写两处都必须拒绝大小写变体，且真实 manifest 不能被改动。
    #[test]
    fn manifest_case_variants_are_rejected_by_read_and_write() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = make_plugin(&tmp);
        fs::write(plugin_dir.join("plugin.json"), "{}").unwrap();

        for variant in ["PLUGIN.JSON", "Plugin.Json", "PLUGIN.JSON/"] {
            assert!(
                resolve_write_path(tmp.path(), "test-plugin", variant).is_err(),
                "写入 {} 必须被拒",
                variant
            );
            assert!(
                resolve_read_path(tmp.path(), "test-plugin", variant).is_err(),
                "读取 {} 必须被拒",
                variant
            );
        }
        assert_eq!(
            fs::read_to_string(plugin_dir.join("plugin.json")).unwrap(),
            "{}",
            "真实 manifest 不得被任何变体写坏"
        );
    }
}
