//! Plugin-scoped filesystem path resolution with path-traversal protection.
//!
//! Single source of truth for resolving plugin-relative paths. All callers
//! (Tauri commands, local handlers, HTTP API dispatch, URI scheme handler)
//! must route through these functions so the traversal invariant is enforced
//! in exactly one place.

use std::path::{Path, PathBuf};

use crate::error::AppError;

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
}