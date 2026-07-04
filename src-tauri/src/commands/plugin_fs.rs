use std::path::{Path, PathBuf};
use tauri::State;

use crate::error::AppError;
use crate::AppState;

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

#[tauri::command]
pub async fn plugin_fs_read(
    state: State<'_, AppState>,
    plugin_id: String,
    path: String,
) -> Result<String, AppError> {
    let config_dir = state.config_dir.clone();
    let file_path = resolve_read_path(&config_dir, &plugin_id, &path)?;
    std::fs::read_to_string(&file_path)
        .map_err(|e| AppError::Other(format!("failed to read file: {}", e)))
}

#[tauri::command]
pub async fn plugin_fs_write(
    state: State<'_, AppState>,
    plugin_id: String,
    path: String,
    content: String,
) -> Result<(), AppError> {
    let config_dir = state.config_dir.clone();
    let file_path = resolve_write_path(&config_dir, &plugin_id, &path)?;
    std::fs::write(&file_path, content)
        .map_err(|e| AppError::Other(format!("failed to write file: {}", e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn resolve_valid_read_path_succeeds() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(plugin_dir.join("data.txt"), "hello").unwrap();

        let result = resolve_read_path(tmp.path(), "test-plugin", "data.txt");
        assert!(result.is_ok());
    }

    #[test]
    fn resolve_read_traversal_rejected() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();
        fs::write(tmp.path().join("secret.txt"), "secret").unwrap();

        let result = resolve_read_path(tmp.path(), "test-plugin", "../secret.txt");
        assert!(result.is_err());
    }

    #[test]
    fn read_write_roundtrip() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(plugin_dir.join("config")).unwrap();

        let content = r#"{"key": "value"}"#;
        let file_path = plugin_dir.join("config/data.json");
        fs::write(&file_path, content).unwrap();

        let read_result = fs::read_to_string(&file_path);
        assert!(read_result.is_ok());
        assert_eq!(read_result.unwrap(), content);
    }

    #[test]
    fn resolve_write_path_creates_intermediate_directories() {
        let tmp = TempDir::new().unwrap();
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();

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
        let plugin_dir = tmp.path().join("plugins").join("test-plugin");
        fs::create_dir_all(&plugin_dir).unwrap();

        let result = resolve_write_path(tmp.path(), "test-plugin", "../../escape.txt");
        assert!(result.is_err(), "path traversal must be rejected");
    }
}
