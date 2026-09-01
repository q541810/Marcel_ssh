use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use uuid::Uuid;

static IMAGES_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Initialize the images root directory (`{config_dir}/images`).
/// Safe to call multiple times; only the first call wins.
pub fn init(config_dir: &Path) {
    let root = config_dir.join("images");
    let _ = std::fs::create_dir_all(&root);
    let _ = IMAGES_ROOT.set(root);
}

fn images_root() -> PathBuf {
    IMAGES_ROOT
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from("images"))
}

/// Relative path form: `{conversation_id}/{message_id}_{n}.webp`
pub fn relative_path(conversation_id: &str, message_id: &str, index: usize) -> String {
    format!("{}/{}_{}.webp", conversation_id, message_id, index)
}

fn resolve_relative(rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    if rel.is_empty()
        || rel.starts_with('/')
        || rel.contains("..")
        || rel.contains('\0')
        || Path::new(&rel).is_absolute()
    {
        return Err(format!("invalid image path: {}", rel));
    }
    let full = images_root().join(&rel);
    let root = images_root()
        .canonicalize()
        .unwrap_or_else(|_| images_root());
    // Best-effort containment check after parent exists
    if let Ok(canon) = full.canonicalize() {
        if !canon.starts_with(&root) {
            return Err("image path escapes images root".into());
        }
        return Ok(canon);
    }
    // File may not exist yet (write path)
    if let Some(parent) = full.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    Ok(full)
}

/// Save compressed image bytes for a message. Returns relative path.
pub fn save_image_bytes(
    conversation_id: &str,
    message_id: &str,
    index: usize,
    bytes: &[u8],
) -> Result<String, String> {
    if bytes.is_empty() {
        return Err("empty image data".into());
    }
    // Soft cap ~8MB after frontend compression
    if bytes.len() > 8 * 1024 * 1024 {
        return Err("image too large".into());
    }
    let rel = relative_path(conversation_id, message_id, index);
    let path = resolve_relative(&rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create image dir: {}", e))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("write image: {}", e))?;
    Ok(rel)
}

/// Decode base64 (raw or data-URL) and save. Returns relative path.
pub fn save_image_base64(
    conversation_id: &str,
    message_id: &str,
    index: usize,
    data: &str,
) -> Result<String, String> {
    let b64 = if let Some(rest) = data.strip_prefix("data:") {
        rest.split_once(',')
            .map(|(_, b)| b)
            .ok_or_else(|| "invalid data URL".to_string())?
    } else {
        data
    };
    let bytes = B64
        .decode(b64.trim())
        .map_err(|e| format!("base64 decode: {}", e))?;
    save_image_bytes(conversation_id, message_id, index, &bytes)
}

/// Read image file and return `data:image/webp;base64,...` (or sniff mime).
pub fn read_image_data_url(rel: &str) -> Result<String, String> {
    let path = resolve_relative(rel)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("read image: {}", e))?;
    let mime = guess_mime(&path, &bytes);
    Ok(format!("data:{};base64,{}", mime, B64.encode(bytes)))
}

fn guess_mime(path: &Path, bytes: &[u8]) -> &'static str {
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "image/webp";
    }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return "image/jpeg";
    }
    if bytes.len() >= 8 && &bytes[0..8] == b"\x89PNG\r\n\x1a\n" {
        return "image/png";
    }
    if bytes.len() >= 6 && (&bytes[0..6] == b"GIF87a" || &bytes[0..6] == b"GIF89a") {
        return "image/gif";
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        _ => "image/webp",
    }
}

/// Delete a single image file by relative path. Missing file is success (idempotent).
pub fn delete_image(rel: &str) -> Result<(), String> {
    let path = resolve_relative(rel)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete image: {}", e)),
    }
}

/// Delete all images for a conversation (`images/{conversation_id}/`).
pub fn delete_conversation_images(conversation_id: &str) {
    let Some(root) = IMAGES_ROOT.get() else {
        return;
    };
    if conversation_id.is_empty()
        || conversation_id.contains("..")
        || conversation_id.contains('/')
        || conversation_id.contains('\\')
    {
        return;
    }
    let dir = root.join(conversation_id);
    let _ = std::fs::remove_dir_all(dir);
}

/// Absolute path for UI asset protocol (if needed).
#[allow(dead_code)]
pub fn absolute_path(rel: &str) -> Result<PathBuf, String> {
    resolve_relative(rel)
}

/// Generate a message id for image filenames when not yet persisted.
pub fn new_message_id() -> String {
    Uuid::new_v4().to_string()
}

/// 测试专用：所有触碰 [`IMAGES_ROOT`] 全局状态的测试必须串行执行。
///
/// `IMAGES_ROOT` 是进程级 `OnceLock`（首个 `init` 获胜），而各测试用
/// `tempdir()` 作为 init 目录——并行时先结束的测试 drop 自己的 tempdir
/// 会整树删除仍在运行的测试正在读写的目录（Windows 上表现为
/// `os error 3` 找不到路径 / 残留目录），产生随机失败。
#[cfg(test)]
pub(crate) fn test_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    LOCK.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn save_and_read_roundtrip() {
        let _guard = test_lock();
        let dir = tempdir().unwrap();
        init(dir.path());
        let rel = save_image_bytes("conv1", "msg1", 0, b"fake-webp-bytes").unwrap();
        assert_eq!(rel, "conv1/msg1_0.webp");
        let data_url = read_image_data_url(&rel).unwrap();
        assert!(data_url.starts_with("data:image/webp;base64,"));
        delete_conversation_images("conv1");
        assert!(!images_root().join("conv1").exists());
    }

    #[test]
    fn rejects_path_traversal() {
        let _guard = test_lock();
        let dir = tempdir().unwrap();
        init(dir.path());
        assert!(resolve_relative("../secret").is_err());
        assert!(resolve_relative("a/../../b").is_err());
        assert!(delete_image("../secret").is_err());
    }

    #[test]
    fn delete_image_is_idempotent() {
        let _guard = test_lock();
        let dir = tempdir().unwrap();
        init(dir.path());
        let rel = save_image_bytes("conv1", "msg1", 0, b"fake-webp-bytes").unwrap();
        assert!(images_root().join(&rel).exists());
        delete_image(&rel).unwrap();
        assert!(!images_root().join(&rel).exists());
        delete_image(&rel).unwrap();
    }
}
