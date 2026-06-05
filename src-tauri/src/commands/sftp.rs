use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::util::{shell_escape, validate_sftp_remote_path, validate_local_path};
use crate::error::AppError;
use crate::AppState;

const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;
const MAX_STREAM_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 32 * 1024 * 1024;

#[derive(Debug, Serialize)]
pub struct FileEntry {
    pub name: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub is_symlink: bool,
    pub size: u64,
    pub mode: u32,
}

#[tauri::command]
pub async fn sftp_list_dir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<FileEntry>, AppError> {
    let path = validate_sftp_remote_path(&path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;
    let mut entries = Vec::new();

    let mut dir = sftp.read_dir(&path).await.map_err(|e| {
        AppError::Ssh(format!("读取目录失败: {}", e))
    })?;

    while let Some(entry) = dir.next() {
        let metadata = entry.metadata();
        entries.push(FileEntry {
            name: entry.file_name(),
            is_dir: metadata.is_dir(),
            is_file: metadata.is_regular(),
            is_symlink: metadata.is_symlink(),
            size: metadata.len(),
            mode: metadata.permissions.unwrap_or(0),
        });
    }

    Ok(entries)
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    data: Vec<u8>,
) -> Result<(), AppError> {
    if data.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::Ssh(format!(
            "文件过大 ({} MB)，单文件上传限制为 32 MB",
            data.len() as f64 / 1_048_576.0
        )));
    }

    let remote_path = validate_sftp_remote_path(&remote_path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    if sftp.metadata(&remote_path).await.is_ok() {
        return Err(AppError::Ssh("远程文件已存在，请先删除或重命名再上传".into()));
    }

    let mut file = sftp
        .open_with_flags(
            &remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {}", e)))?;

    tokio::io::AsyncWriteExt::write_all(&mut file, &data)
        .await
        .map_err(|e| AppError::Ssh(format!("写入远程文件失败: {}", e)))?;

    file.flush()
        .await
        .map_err(|e| AppError::Ssh(format!("刷新远程文件失败: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
) -> Result<Vec<u8>, AppError> {
    let remote_path = validate_sftp_remote_path(&remote_path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    let metadata = sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| AppError::Ssh(format!("获取文件信息失败: {}", e)))?;

    if metadata.is_dir() {
        return Err(AppError::Ssh("不能下载目录，请使用文件管理器下载".into()));
    }

    if metadata.len() > MAX_DOWNLOAD_BYTES {
        return Err(AppError::Ssh(format!(
            "文件过大 ({} MB)，单文件下载限制为 {} MB，请使用流式下载功能",
            metadata.len() as f64 / 1_048_576.0,
            MAX_DOWNLOAD_BYTES as f64 / 1_048_576.0
        )));
    }

    let data = sftp
        .read(&remote_path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取远程文件失败: {}", e)))?;

    Ok(data)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), AppError> {
    let path = validate_sftp_remote_path(&path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    sftp.create_dir(&path)
        .await
        .map_err(|e| AppError::Ssh(format!("创建目录失败: {}", e)))?;

    Ok(())
}

async fn sftp_remove_recursive(
    sftp: &russh_sftp::client::SftpSession,
    path: &str,
    is_dir: bool,
) -> Result<(), AppError> {
    if is_dir {
        let mut dir = sftp.read_dir(path).await
            .map_err(|e| AppError::Ssh(format!("读取目录失败: {}", e)))?;
        while let Some(entry) = dir.next() {
            let name = entry.file_name();
            if name == "." || name == ".." { continue; }
            let child = format!("{}/{}", path.trim_end_matches('/'), name);
            let child_is_dir = entry.metadata().is_dir();
            Box::pin(sftp_remove_recursive(sftp, &child, child_is_dir)).await?;
        }
        sftp.remove_dir(path).await
            .map_err(|e| AppError::Ssh(format!("删除目录失败: {}", e)))?;
    } else {
        sftp.remove_file(path).await
            .map_err(|e| AppError::Ssh(format!("删除文件失败: {}", e)))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), AppError> {
    let path = validate_sftp_remote_path(&path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;
    sftp_remove_recursive(&sftp, &path, is_dir).await
}

#[tauri::command]
pub async fn sftp_remove_via_shell(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), AppError> {
    let path = validate_sftp_remote_path(&path)?;
    if !is_dir {
        return Err(AppError::Ssh("快速删除仅支持目录".into()));
    }
    let command = format!("rm -rf -- {}", shell_escape(&path));
    state.ssh_manager.exec_command(&session_id, &command).await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), AppError> {
    let old_path = validate_sftp_remote_path(&old_path)?;
    let new_path = validate_sftp_remote_path(&new_path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    sftp.rename(&old_path, &new_path)
        .await
        .map_err(|e| AppError::Ssh(format!("重命名失败: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub async fn sftp_upload_folder(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    archive_data: Vec<u8>,
) -> Result<String, AppError> {
    if archive_data.len() > MAX_UPLOAD_BYTES {
        return Err(AppError::Ssh(format!(
            "文件夹过大 ({} MB)，单次上传限制为 32 MB",
            archive_data.len() as f64 / 1_048_576.0
        )));
    }

    let remote_path = validate_sftp_remote_path(&remote_path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    let tmp_path = format!("/tmp/marcel-upload-{}.zip", uuid::Uuid::new_v4());

    let mut file = sftp
        .open_with_flags(
            &tmp_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("创建临时文件失败: {}", e)))?;

    tokio::io::AsyncWriteExt::write_all(&mut file, &archive_data)
        .await
        .map_err(|e| AppError::Ssh(format!("写入临时文件失败: {}", e)))?;

    file.flush()
        .await
        .map_err(|e| AppError::Ssh(format!("刷新临时文件失败: {}", e)))?;

    drop(file);
    drop(sftp);

    let exec_cmd = crate::ssh::sftp_extract::build_extract_cmd(&tmp_path, &remote_path);
    let output = state.ssh_manager.exec_command(&session_id, &exec_cmd).await?;

    if output.trim().contains("OK") {
        Ok(format!("文件夹已上传并解压到 {}", remote_path))
    } else {
        Err(AppError::Ssh(format!("解压失败: {}", output.trim())))
    }
}

const MAX_EDITOR_FILE_SIZE: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<String, AppError> {
    let path = validate_sftp_remote_path(&path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;
    let metadata = sftp
        .metadata(&path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取文件信息失败: {}", e)))?;

    if metadata.is_dir() {
        return Err(AppError::Ssh("无法编辑目录".into()));
    }

    if metadata.len() > MAX_EDITOR_FILE_SIZE {
        return Err(AppError::Ssh(format!(
            "文件过大 ({} MB)，编辑器限制为 2 MB",
            metadata.len() as f64 / 1_048_576.0
        )));
    }

    let data = sftp
        .read(&path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取文件失败: {}", e)))?;

    if data.len() > MAX_EDITOR_FILE_SIZE as usize {
        return Err(AppError::Ssh(format!(
            "文件过大 ({} MB)，编辑器限制为 2 MB",
            data.len() as f64 / 1_048_576.0
        )));
    }

    // strip BOM if present
    let bytes = if data.starts_with(b"\xEF\xBB\xBF") {
        &data[3..]
    } else {
        &data[..]
    };

    String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::Ssh("无法解码文件，可能为二进制文件或使用了不支持的编码".into()))
}

#[tauri::command]
pub async fn sftp_write_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    content: String,
) -> Result<(), AppError> {
    let path = validate_sftp_remote_path(&path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    let mut file = sftp
        .open_with_flags(
            &path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {}", e)))?;

    tokio::io::AsyncWriteExt::write_all(&mut file, content.as_bytes())
        .await
        .map_err(|e| AppError::Ssh(format!("写入远程文件失败: {}", e)))?;

    file.flush()
        .await
        .map_err(|e| AppError::Ssh(format!("刷新远程文件失败: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub async fn sftp_download_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    download_id: String,
) -> Result<(), AppError> {
    let remote_path = validate_sftp_remote_path(&remote_path)?;
    let local_path = validate_local_path(&local_path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    let metadata = sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| AppError::Ssh(format!("获取文件信息失败: {}", e)))?;

    if !metadata.is_regular() {
        return Err(AppError::Ssh("只能下载普通文件".into()));
    }

    let total = metadata.len();

    let mut remote = sftp
        .open_with_flags(&remote_path, OpenFlags::READ)
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {}", e)))?;

    let mut local = tokio::fs::File::create(&local_path)
        .await
        .map_err(|e| AppError::Ssh(format!("创建本地文件失败: {}", e)))?;

    let mut buf = vec![0u8; 131072];
    let mut written: u64 = 0;

    let result: Result<(), AppError> = async {
        loop {
            let n = remote
                .read(&mut buf)
                .await
                .map_err(|e| AppError::Ssh(format!("读取远程文件失败: {}", e)))?;

            if n == 0 {
                break;
            }

            local
                .write_all(&buf[..n])
                .await
                .map_err(|e| AppError::Ssh(format!("写入本地文件失败: {}", e)))?;

            written += n as u64;

            let _ = app.emit(
                "sftp-download-progress",
                json!({ "downloadId": &download_id, "written": written, "total": total }),
            );
        }

        local
            .flush()
            .await
            .map_err(|e| AppError::Ssh(format!("刷新本地文件失败: {}", e)))?;

        Ok(())
    }
    .await;

    if result.is_err() {
        let _ = tokio::fs::remove_file(&local_path).await;
        return result;
    }

    if written != total {
        let _ = tokio::fs::remove_file(&local_path).await;
        return Err(AppError::Ssh(format!(
            "下载不完整：预期 {} 字节，实际写入 {} 字节",
            total, written
        )));
    }

    let _ = app.emit("sftp-download-done", json!({ "downloadId": &download_id }));

    Ok(())
}

#[tauri::command]
pub async fn sftp_upload_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_path: String,
    upload_id: String,
) -> Result<(), AppError> {
    let remote_path = validate_sftp_remote_path(&remote_path)?;
    let local_path = validate_local_path(&local_path)?;

    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    let local_meta = tokio::fs::metadata(&local_path)
        .await
        .map_err(|e| AppError::Ssh(format!("无法读取本地文件信息: {}", e)))?;

    if local_meta.is_dir() {
        return Err(AppError::Ssh("请使用文件夹上传功能上传目录".into()));
    }

    let total = local_meta.len();
    if total > MAX_STREAM_UPLOAD_BYTES {
        return Err(AppError::Ssh(format!(
            "文件过大 ({} MB)，单文件上传限制为 2 GB",
            total as f64 / 1_048_576.0
        )));
    }

    if sftp.metadata(&remote_path).await.is_ok() {
        return Err(AppError::Ssh("远程文件已存在，请先删除或重命名再上传".into()));
    }

    let mut remote_file = sftp
        .open_with_flags(
            &remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {}", e)))?;

    let mut local_file = tokio::fs::File::open(&local_path)
        .await
        .map_err(|e| AppError::Ssh(format!("打开本地文件失败: {}", e)))?;

    let mut buf = vec![0u8; 131072];
    let mut written: u64 = 0;

    let result: Result<(), AppError> = async {
        loop {
            let n = local_file
                .read(&mut buf)
                .await
                .map_err(|e| AppError::Ssh(format!("读取本地文件失败: {}", e)))?;

            if n == 0 {
                break;
            }

            tokio::io::AsyncWriteExt::write_all(&mut remote_file, &buf[..n])
                .await
                .map_err(|e| AppError::Ssh(format!("写入远程文件失败: {}", e)))?;

            written += n as u64;

            let _ = app.emit(
                "sftp-upload-progress",
                json!({ "uploadId": &upload_id, "written": written, "total": total }),
            );
        }

        remote_file
            .flush()
            .await
            .map_err(|e| AppError::Ssh(format!("刷新远程文件失败: {}", e)))?;

        Ok(())
    }
    .await;

    if result.is_err() {
        let _ = sftp.remove_file(&remote_path).await;
        return result;
    }

    if written != total {
        let _ = sftp.remove_file(&remote_path).await;
        return Err(AppError::Ssh(format!(
            "上传不完整：预期 {} 字节，实际上传 {} 字节",
            total, written
        )));
    }

    let _ = app.emit("sftp-upload-done", json!({ "uploadId": &upload_id }));

    Ok(())
}
