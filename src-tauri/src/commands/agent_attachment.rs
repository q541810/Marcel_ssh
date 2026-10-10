//! Agent 输入框附件：读取本地文件（普通路径 / Android SAF content:// URI），
//! 以 base64 + 文件名返回给前端，供图片压缩预览和文本附件解码。
//! 纯只读命令，不落库、不触发 sync。

use serde::Serialize;
use std::path::Path;
use tokio::io::{AsyncRead, AsyncReadExt};

use crate::commands::sftp::{open_content_uri_file, ContentOpenMode};
use crate::error::AppError;
use crate::util::{is_content_uri, validate_local_path};

/// 附件读取硬上限：文本单文件 5MB 由前端限制，后端再给一个更宽的兜底，
/// 防止误传超大文件打爆内存。图片也先检查原始文件大小，再在前端压缩。
pub const MAX_ATTACHMENT_READ_BYTES: u64 = 10 * 1024 * 1024;

/// 最多读取上限加一个字节，以便识别超限，同时约束未知大小的 SAF 流。
async fn read_attachment_bytes(reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, AppError> {
    let mut data = Vec::new();
    reader
        .take(MAX_ATTACHMENT_READ_BYTES + 1)
        .read_to_end(&mut data)
        .await
        .map_err(|e| AppError::Agent(format!("读取文件失败: {}", e)))?;
    if data.len() as u64 > MAX_ATTACHMENT_READ_BYTES {
        return Err(AppError::Agent(format!(
            "文件过大，单文件限制为 {} MB",
            MAX_ATTACHMENT_READ_BYTES / 1_048_576
        )));
    }
    Ok(data)
}

#[derive(Serialize)]
pub struct LocalFilePayload {
    /// 解析后的文件名（content:// URI 查 DISPLAY_NAME，失败退化为 URI 段解码）。
    pub name: String,
    /// 文件内容，base64 编码（STANDARD，无 data: 前缀）。
    pub base64: String,
    /// 原始字节数（前端据此判断文本大小限制）。
    pub size: u64,
}

/// 读取本地文件用于附件导入。普通路径直接读；Android SAF content:// URI
/// 经 tauri-plugin-fs 按 fd 打开（与 SFTP 上传同一条通道）。
#[tauri::command]
pub async fn agent_read_local_file(
    app: tauri::AppHandle,
    path: String,
) -> Result<LocalFilePayload, AppError> {
    let path = validate_local_path(&path)?;

    // 已知大小先拒绝；读取时仍有界，覆盖大小未知和读取期间增长的文件。
    if !is_content_uri(&path) {
        let meta = tokio::fs::metadata(&path)
            .await
            .map_err(|e| AppError::Agent(format!("读取文件信息失败: {}", e)))?;
        if meta.len() > MAX_ATTACHMENT_READ_BYTES {
            return Err(AppError::Agent(format!(
                "文件过大 ({} MB)，单文件限制为 {} MB",
                meta.len() as f64 / 1_048_576.0,
                MAX_ATTACHMENT_READ_BYTES as f64 / 1_048_576.0
            )));
        }
    }

    let name = local_file_name(&path).await?;

    let data = if is_content_uri(&path) {
        let file = open_content_uri_file(&app, path, ContentOpenMode::Read).await?;
        read_attachment_bytes(file).await?
    } else {
        let file = tokio::fs::File::open(&path)
            .await
            .map_err(|e| AppError::Agent(format!("读取文件失败: {}", e)))?;
        read_attachment_bytes(file).await?
    };

    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    Ok(LocalFilePayload {
        name,
        base64: B64.encode(&data),
        size: data.len() as u64,
    })
}

/// 解析本地文件的展示名：content:// URI 查 ContentResolver DISPLAY_NAME
/// （失败退化为 URI 最后一段解码），普通路径取 basename。
pub(crate) async fn local_file_name(path: &str) -> Result<String, AppError> {
    if is_content_uri(path) {
        #[cfg(target_os = "android")]
        {
            let uri = path.to_string();
            let queried =
                tokio::task::spawn_blocking(move || crate::util::query_content_display_name(&uri))
                    .await
                    .map_err(|e| AppError::Agent(format!("查询文件名任务失败: {}", e)))?;
            if let Some(name) = queried {
                return Ok(name);
            }
        }
        return crate::util::content_uri_fallback_name(path)
            .ok_or_else(|| AppError::Agent("无法从所选文件解析文件名".into()));
    }

    Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Agent("无法从路径解析文件名".into()))
}

/// 仅返回本地文件的展示名，不读内容。
///
/// 用途：前端在「按扩展名/文件名分拣图片/文本附件」之前调用，拿到真实文件名。
/// Android SAF content:// URI 不能用 `split('/').pop()` 拿名（拿到的是 document id），
/// 必须经 ContentResolver 查 DISPLAY_NAME；这里把后端已有的 local_file_name
/// 单独暴露成命令，避免前端读整个文件只为分类。
#[tauri::command]
pub async fn agent_get_local_file_name(path: String) -> Result<String, AppError> {
    let path = validate_local_path(&path)?;
    local_file_name(&path).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn bounded_read_accepts_empty_and_regular_text() {
        assert!(
            read_attachment_bytes(std::io::Cursor::new(Vec::<u8>::new()))
                .await
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            read_attachment_bytes(std::io::Cursor::new(b"port=22"))
                .await
                .unwrap(),
            b"port=22"
        );
    }

    #[tokio::test]
    async fn bounded_read_accepts_exact_limit() {
        let bytes = vec![b'x'; MAX_ATTACHMENT_READ_BYTES as usize];
        assert_eq!(
            read_attachment_bytes(std::io::Cursor::new(bytes))
                .await
                .unwrap()
                .len(),
            MAX_ATTACHMENT_READ_BYTES as usize
        );
    }

    #[tokio::test]
    async fn oversized_unknown_length_stream_stops_before_reading_the_remainder() {
        let bytes = vec![b'x'; MAX_ATTACHMENT_READ_BYTES as usize + 4096];
        let mut reader = std::io::Cursor::new(bytes);
        let error = read_attachment_bytes(&mut reader).await.unwrap_err();
        assert!(error.to_string().contains("单文件限制为 10 MB"));
        assert_eq!(reader.position(), MAX_ATTACHMENT_READ_BYTES + 1);
    }

    #[tokio::test]
    async fn plain_path_takes_basename() {
        let name = local_file_name("/home/user/docs/report.md").await.unwrap();
        assert_eq!(name, "report.md");
    }

    #[tokio::test]
    async fn windows_path_takes_basename() {
        let name = local_file_name("C:\\Users\\me\\Downloads\\server.log")
            .await
            .unwrap();
        assert_eq!(name, "server.log");
    }

    #[tokio::test]
    async fn content_uri_decodes_last_segment() {
        let name = local_file_name(
            "content://com.android.externalstorage.documents/document/primary%3ADownload%2Freadme.txt",
        )
        .await
        .unwrap();
        assert_eq!(name, "readme.txt");
    }

    #[test]
    fn empty_path_rejected() {
        assert!(validate_local_path("").is_err());
    }

    #[test]
    fn path_traversal_rejected() {
        assert!(validate_local_path("/home/user/../etc/passwd").is_err());
        assert!(validate_local_path("C:\\Users\\..\\secret.txt").is_err());
    }

    #[test]
    fn null_byte_rejected() {
        assert!(validate_local_path("/tmp/a\0b.txt").is_err());
    }

    /// `agent_get_local_file_name` 必须把 content:// URI 的真实 DISPLAY_NAME
    /// 透出给前端（这里只能验非 Android 路径：验证 `local_file_name` 暴露成命令
    /// 后能正确走普通路径的 basename 逻辑）。
    #[tokio::test]
    async fn get_local_file_name_passes_through_for_plain_paths() {
        let n = agent_get_local_file_name("/home/u/d/report.md".into())
            .await
            .unwrap();
        assert_eq!(n, "report.md");
        let n = agent_get_local_file_name("C:\\Users\\me\\Downloads\\data.json".into())
            .await
            .unwrap();
        assert_eq!(n, "data.json");
    }

    /// 兜底：content:// URI 在非 Android 目标（CI / 桌面构建）也必须能解析出
    /// 最后一段（percent-decode 后），不能返回 None 让前端炸掉。
    #[tokio::test]
    async fn get_local_file_name_falls_back_for_content_uri_off_android() {
        let n = agent_get_local_file_name(
            "content://com.android.externalstorage.documents/document/primary%3APictures%2Fphoto.jpg".into(),
        )
        .await
        .unwrap();
        // 非 Android 不调 ContentResolver，但 content_uri_fallback_name
        // 能从最后一段 percent-decode 出 "photo.jpg"
        assert_eq!(n, "photo.jpg");
    }
}
