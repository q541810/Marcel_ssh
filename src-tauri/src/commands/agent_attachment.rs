//! Agent 输入框附件：读取本地文件（普通路径 / Android SAF content:// URI），
//! 以 base64 + 文件名返回给前端（图片走压缩预览链路，文本走解码插入链路）。
//! 纯只读命令，不落库、不触发 sync。

use serde::Serialize;
use std::path::Path;
use tokio::io::AsyncReadExt;

use crate::commands::sftp::{open_content_uri_file, ContentOpenMode};
use crate::error::AppError;
use crate::util::{is_content_uri, validate_local_path};

/// 附件读取硬上限：文本单文件 5MB 由前端限制，后端再给一个更宽的兜底，
/// 防止误传超大文件打爆内存。图片走前端压缩（<5MB），不会触到该上限。
pub const MAX_ATTACHMENT_READ_BYTES: u64 = 10 * 1024 * 1024;

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

    // 超大文件直接拒绝：不读进内存（size 未知的 content:// 以读入后检查兜底）。
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
        let mut file =
            open_content_uri_file(&app, path, ContentOpenMode::Read).await?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)
            .await
            .map_err(|e| AppError::Agent(format!("读取文件失败: {}", e)))?;
        buf
    } else {
        tokio::fs::read(&path)
            .await
            .map_err(|e| AppError::Agent(format!("读取文件失败: {}", e)))?
    };

    if data.len() as u64 > MAX_ATTACHMENT_READ_BYTES {
        return Err(AppError::Agent(format!(
            "文件过大 ({} MB)，单文件限制为 {} MB",
            data.len() as f64 / 1_048_576.0,
            MAX_ATTACHMENT_READ_BYTES as f64 / 1_048_576.0
        )));
    }

    use base64::{engine::general_purpose::STANDARD as B64, Engine};
    Ok(LocalFilePayload {
        name,
        base64: B64.encode(&data),
        size: data.len() as u64,
    })
}

/// 解析本地文件的展示名：content:// URI 查 ContentResolver DISPLAY_NAME
/// （失败退化为 URI 最后一段解码），普通路径取 basename。
async fn local_file_name(path: &str) -> Result<String, AppError> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn plain_path_takes_basename() {
        let name = local_file_name("/home/user/docs/report.md").await.unwrap();
        assert_eq!(name, "report.md");
    }

    #[tokio::test]
    async fn windows_path_takes_basename() {
        let name = local_file_name("C:\\Users\\me\\Downloads\\server.log").await.unwrap();
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
}
