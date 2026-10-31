use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use uuid::Uuid;

use crate::data::DataSourceId;

static IMAGES_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// Initialize the images root directory (`DataSourceId::Images`，即 `{config_dir}/images`).
/// Safe to call multiple times; only the first call wins.
pub fn init(config_dir: &Path) {
    let root = DataSourceId::Images.path(config_dir);
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
/// 把从别的设备拉回来的图片字节写进本机桶（路径沿用消息里的 `rel`）。
///
/// 目录不存在会建；已存在就覆盖（内容寻址的 blob 保证同名同内容，覆盖是幂等的）。
pub fn save_bytes_from_sync(rel: &str, bytes: &[u8]) -> Result<(), String> {
    let path = resolve_relative(rel)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create image dir: {e}"))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("write image: {e}"))
}

/// 读图片原始字节（上传到同步 blob 用）。
pub fn read_image_bytes(rel: &str) -> Result<Vec<u8>, String> {
    let path = resolve_relative(rel)?;
    std::fs::read(&path).map_err(|e| format!("read image: {}", e))
}

pub fn read_image_data_url(rel: &str) -> Result<String, String> {
    let path = resolve_relative(rel)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("read image: {}", e))?;
    let mime = guess_mime(&path, &bytes);
    Ok(format!("data:{};base64,{}", mime, B64.encode(bytes)))
}

// —— data URL 的进程内 LRU ─────────────────────────────────────────────
// vision 开启时每轮 LLM 请求都会把消息里的图片读回来；图片文件按内容哈希命名、
// 写入后不可变，逐轮读盘 + base64 是纯浪费。按字节预算淘汰，删除图片/会话时
// 联动清条目，缓存里不留已删数据。

/// data URL 缓存的字节预算（base64 文本长度计）。
const DATA_URL_CACHE_BUDGET_BYTES: usize = 32 * 1024 * 1024;

struct DataUrlLru {
    /// rel 路径 → (data URL, 字节大小)。键与会话目录同名前缀（`conv/msg_0.webp`）。
    entries: std::collections::HashMap<String, (String, usize)>,
    /// 使用顺序：尾部 = 最近使用，超预算从头部淘汰。
    order: std::collections::VecDeque<String>,
    used_bytes: usize,
}

impl DataUrlLru {
    fn new() -> Self {
        Self {
            entries: std::collections::HashMap::new(),
            order: std::collections::VecDeque::new(),
            used_bytes: 0,
        }
    }

    fn touch(&mut self, rel: &str) {
        if let Some(pos) = self.order.iter().position(|k| k == rel) {
            let k = self.order.remove(pos).unwrap();
            self.order.push_back(k);
        }
    }

    fn insert(&mut self, rel: String, url: String, size: usize) {
        if let Some((old, old_size)) = self.entries.insert(rel.clone(), (url, size)) {
            let _ = old;
            self.used_bytes = self.used_bytes.saturating_sub(old_size);
            if let Some(pos) = self.order.iter().position(|k| *k == rel) {
                self.order.remove(pos);
            }
        }
        self.order.push_back(rel);
        self.used_bytes += size;
        while self.used_bytes > DATA_URL_CACHE_BUDGET_BYTES {
            let Some(evict) = self.order.pop_front() else {
                break;
            };
            if let Some((_, sz)) = self.entries.remove(&evict) {
                self.used_bytes = self.used_bytes.saturating_sub(sz);
            }
        }
    }

    fn remove(&mut self, rel: &str) {
        if let Some((_, sz)) = self.entries.remove(rel) {
            self.used_bytes = self.used_bytes.saturating_sub(sz);
        }
        if let Some(pos) = self.order.iter().position(|k| k == rel) {
            self.order.remove(pos);
        }
    }

    fn remove_prefix(&mut self, conversation_id: &str) {
        let prefix = format!("{conversation_id}/");
        let hits: Vec<String> = self
            .entries
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        for k in hits {
            self.remove(&k);
        }
    }
}

static DATA_URL_CACHE: std::sync::Mutex<Option<DataUrlLru>> = std::sync::Mutex::new(None);

fn with_cache<R>(f: impl FnOnce(&mut DataUrlLru) -> R) -> R {
    let mut guard = DATA_URL_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let lru = guard.get_or_insert_with(DataUrlLru::new);
    f(lru)
}

/// 带进程内 LRU 的 [`read_image_data_url`]：命中直接回 data URL，未命中读盘
/// 后入缓存（只缓存成功结果——读失败可能可修复，不固化）。
pub fn read_image_data_url_cached(rel: &str) -> Result<String, String> {
    let hit = with_cache(|lru| {
        if let Some((url, _)) = lru.entries.get(rel) {
            let url = url.clone();
            lru.touch(rel);
            Some(url)
        } else {
            None
        }
    });
    if let Some(url) = hit {
        return Ok(url);
    }
    let url = read_image_data_url(rel)?;
    let size = url.len();
    with_cache(|lru| lru.insert(rel.to_string(), url.clone(), size));
    Ok(url)
}

/// 测试专用：清空 data URL 缓存。
#[cfg(test)]
pub(crate) fn clear_data_url_cache_for_test() {
    with_cache(|lru| {
        lru.entries.clear();
        lru.order.clear();
        lru.used_bytes = 0;
    });
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

/// 把已落盘的图复制成另一条消息名下的图（会话分叉用）。返回新的相对路径。
///
/// 必须真复制而不是共用路径：图片目录按会话分桶，删会话时整桶 `remove_dir_all`，
/// 共用会让「删掉原会话 → 分叉里的图全裂」。
pub fn copy_image(
    src_rel: &str,
    dst_conversation_id: &str,
    dst_message_id: &str,
    index: usize,
) -> Result<String, String> {
    let src = resolve_relative(src_rel)?;
    let bytes = std::fs::read(&src).map_err(|e| format!("read image: {}", e))?;
    save_image_bytes(dst_conversation_id, dst_message_id, index, &bytes)
}

/// Delete a single image file by relative path. Missing file is success (idempotent).
pub fn delete_image(rel: &str) -> Result<(), String> {
    let path = resolve_relative(rel)?;
    match std::fs::remove_file(&path) {
        Ok(()) => {
            with_cache(|lru| lru.remove(rel));
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            with_cache(|lru| lru.remove(rel));
            Ok(())
        }
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
    with_cache(|lru| lru.remove_prefix(conversation_id));
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

    /// LRU：第二轮不再读盘（改盘上文件内容后仍回旧 data URL 即证明没读盘）；
    /// 删除图片联动清缓存；读失败不缓存。
    #[test]
    fn data_url_cache_hits_and_follows_deletion() {
        let _guard = test_lock();
        let dir = tempdir().unwrap();
        init(dir.path());
        clear_data_url_cache_for_test();

        let rel = save_image_bytes("conv1", "msg1", 0, b"fake-webp-bytes").unwrap();
        let first = read_image_data_url_cached(&rel).unwrap();
        assert!(first.starts_with("data:image/webp;base64,"));

        // 盘上内容被换掉（生产里图片不可变，这里仅用改文件证明第二轮没读盘）
        let abs = images_root().join(&rel);
        std::fs::write(&abs, b"different-bytes").unwrap();
        let second = read_image_data_url_cached(&rel).unwrap();
        assert_eq!(first, second, "命中缓存必须原样返回，不重新读盘");

        // 删除联动：删掉后缓存失效，读失败不缓存、也不回旧值
        delete_image(&rel).unwrap();
        assert!(read_image_data_url_cached(&rel).is_err());
        std::fs::write(&abs, b"fake-webp-bytes").unwrap();
        let third = read_image_data_url_cached(&rel).unwrap();
        assert_eq!(third, first, "重新落盘后应重读并得到一致内容");
        delete_conversation_images("conv1");
        assert!(read_image_data_url_cached(&rel).is_err());
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
