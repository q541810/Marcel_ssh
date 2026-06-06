use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use serde_json::json;
use std::path::Path;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::AppError;
use crate::util::{shell_escape, validate_local_path, validate_sftp_remote_path};
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

    let mut dir = sftp
        .read_dir(&path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取目录失败: {}", e)))?;

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
        return Err(AppError::Ssh(
            "远程文件已存在，请先删除或重命名再上传".into(),
        ));
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
        let mut dir = sftp
            .read_dir(path)
            .await
            .map_err(|e| AppError::Ssh(format!("读取目录失败: {}", e)))?;
        while let Some(entry) = dir.next() {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child = format!("{}/{}", path.trim_end_matches('/'), name);
            let child_is_dir = entry.metadata().is_dir();
            Box::pin(sftp_remove_recursive(sftp, &child, child_is_dir)).await?;
        }
        sftp.remove_dir(path)
            .await
            .map_err(|e| AppError::Ssh(format!("删除目录失败: {}", e)))?;
    } else {
        sftp.remove_file(path)
            .await
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
    state
        .ssh_manager
        .exec_command(&session_id, &command)
        .await?;
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
    let output = state
        .ssh_manager
        .exec_command(&session_id, &exec_cmd)
        .await?;

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
        return Err(AppError::Ssh(
            "远程文件已存在，请先删除或重命名再上传".into(),
        ));
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

fn folder_upload_percent(phase: &str, written: u64, total: u64) -> u8 {
    let ratio = if total > 0 {
        (written.min(total) as f64 / total as f64).clamp(0.0, 1.0)
    } else {
        0.0
    };

    match phase {
        "checking" => 5,
        "zipping" => (5.0 + ratio * 30.0).round() as u8,
        "uploading" => (35.0 + ratio * 50.0).round() as u8,
        "extracting" => 90,
        _ => 0,
    }
}

fn emit_folder_upload_status(
    app: &AppHandle,
    upload_id: &str,
    phase: &str,
    written: u64,
    total: u64,
) {
    let _ = app.emit(
        "sftp-folder-upload-status",
        json!({
            "uploadId": upload_id,
            "phase": phase,
            "written": written,
            "total": total,
            "percent": folder_upload_percent(phase, written, total),
        }),
    );
}

fn zip_local_folder<F>(
    local_path: &Path,
    compression_level: i64,
    mut on_progress: F,
) -> Result<std::path::PathBuf, AppError>
where
    F: FnMut(u64, u64),
{
    let tmp_dir = std::env::temp_dir().join("marcel-ssh-zip");
    std::fs::create_dir_all(&tmp_dir)
        .map_err(|e| AppError::Ssh(format!("创建临时目录失败: {}", e)))?;

    let zip_path = tmp_dir.join(format!("{}.zip", uuid::Uuid::new_v4()));

    let zip_file = std::fs::File::create(&zip_path)
        .map_err(|e| AppError::Ssh(format!("创建本地zip文件失败: {}", e)))?;
    let mut zip_writer = zip::ZipWriter::new(zip_file);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(compression_level));

    let mut entries: Vec<(String, std::path::PathBuf)> = Vec::new();
    if let Err(e) = collect_dir_entries(local_path, "", &mut entries) {
        let _ = std::fs::remove_file(&zip_path);
        return Err(e);
    }

    let total_files = entries.len();
    let mut processed: usize = 0;

    for (rel_path, full_path) in &entries {
        if full_path.is_dir() {
            if let Err(e) = zip_writer.add_directory_from_path(Path::new(&rel_path), options) {
                let _ = std::fs::remove_file(&zip_path);
                return Err(AppError::Ssh(format!("zip添加目录失败: {}", e)));
            }
        } else {
            let file_result = std::fs::File::open(full_path);
            match file_result {
                Ok(mut file) => {
                    if let Err(e) = zip_writer.start_file_from_path(Path::new(&rel_path), options) {
                        let _ = std::fs::remove_file(&zip_path);
                        return Err(AppError::Ssh(format!("zip添加文件失败: {}", e)));
                    }
                    if let Err(e) = std::io::copy(&mut file, &mut zip_writer) {
                        let _ = std::fs::remove_file(&zip_path);
                        return Err(AppError::Ssh(format!("zip写入文件失败: {}", e)));
                    }
                }
                Err(e) => {
                    let _ = std::fs::remove_file(&zip_path);
                    return Err(AppError::Ssh(format!(
                        "打开本地文件失败 {}: {}",
                        full_path.display(),
                        e
                    )));
                }
            }
        }
        processed += 1;
        on_progress(processed as u64, total_files as u64);
        log::debug!("zip打包进度: {}/{} ({})", processed, total_files, rel_path);
    }

    if let Err(e) = zip_writer.finish() {
        let _ = std::fs::remove_file(&zip_path);
        return Err(AppError::Ssh(format!("zip打包完成失败: {}", e)));
    }

    Ok(zip_path)
}

#[cfg(test)]
mod tests {
    use super::folder_upload_percent;

    #[test]
    fn maps_folder_upload_phases_to_overall_percent() {
        assert_eq!(folder_upload_percent("checking", 0, 0), 5);
        assert_eq!(folder_upload_percent("zipping", 0, 10), 5);
        assert_eq!(folder_upload_percent("zipping", 5, 10), 20);
        assert_eq!(folder_upload_percent("zipping", 10, 10), 35);
        assert_eq!(folder_upload_percent("uploading", 0, 100), 35);
        assert_eq!(folder_upload_percent("uploading", 50, 100), 60);
        assert_eq!(folder_upload_percent("uploading", 100, 100), 85);
        assert_eq!(folder_upload_percent("extracting", 0, 0), 90);
    }

    #[test]
    fn clamps_folder_upload_progress_ratio() {
        assert_eq!(folder_upload_percent("uploading", 150, 100), 85);
        assert_eq!(folder_upload_percent("unknown", 0, 0), 0);
    }
}

fn collect_dir_entries(
    dir: &Path,
    prefix: &str,
    entries: &mut Vec<(String, std::path::PathBuf)>,
) -> Result<(), AppError> {
    let dir_entries = std::fs::read_dir(dir)
        .map_err(|e| AppError::Ssh(format!("读取本地目录失败 {}: {}", dir.display(), e)))?;

    for entry in dir_entries {
        let entry = entry.map_err(|e| AppError::Ssh(format!("读取目录条目失败: {}", e)))?;
        let name = entry.file_name().to_string_lossy().to_string();
        let full_path = entry.path();
        let rel_path = if prefix.is_empty() {
            name.clone()
        } else {
            format!("{}/{}", prefix, name)
        };

        let file_type = entry
            .file_type()
            .map_err(|e| AppError::Ssh(format!("获取文件类型失败: {}", e)))?;

        if file_type.is_dir() {
            entries.push((format!("{}/", rel_path), full_path.clone()));
            collect_dir_entries(&full_path, &rel_path, entries)?;
        } else if file_type.is_file() {
            entries.push((rel_path, full_path));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn sftp_upload_folder_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    upload_id: String,
) -> Result<(), AppError> {
    let local_path = validate_local_path(&local_path)?;
    let remote_path = validate_sftp_remote_path(&remote_path)?;

    let local = Path::new(&local_path);
    if !local.is_dir() {
        return Err(AppError::Ssh("本地路径不是目录".into()));
    }

    emit_folder_upload_status(&app, &upload_id, "checking", 0, 1);

    let check_cmd = crate::ssh::sftp_extract::build_unzip_check_cmd();
    let check_output = state
        .ssh_manager
        .exec_command(&session_id, check_cmd)
        .await?;
    if !crate::ssh::sftp_extract::has_unzip(&check_output) {
        return Err(AppError::Ssh(
            "远端服务器缺少 unzip，无法解压文件夹上传包。请安装 unzip 后重试。".into(),
        ));
    }

    emit_folder_upload_status(&app, &upload_id, "zipping", 0, 1);

    let compression_level = state
        .settings
        .read()
        .await
        .folder_upload_compression_level
        .clamp(0, 9);

    let local_path_owned = local_path.clone();
    let zip_app = app.clone();
    let zip_upload_id = upload_id.clone();
    let zip_path = tokio::task::spawn_blocking(move || {
        zip_local_folder(
            Path::new(&local_path_owned),
            compression_level,
            |written, total| {
                emit_folder_upload_status(&zip_app, &zip_upload_id, "zipping", written, total);
            },
        )
    })
    .await
    .map_err(|e| AppError::Ssh(format!("zip打包任务失败: {}", e)))??;

    let zip_meta = tokio::fs::metadata(&zip_path).await.map_err(|e| {
        let _ = std::fs::remove_file(&zip_path);
        AppError::Ssh(format!("读取zip文件信息失败: {}", e))
    })?;
    let total = zip_meta.len();

    if total > MAX_STREAM_UPLOAD_BYTES {
        let _ = tokio::fs::remove_file(&zip_path).await;
        return Err(AppError::Ssh(format!(
            "压缩包过大 ({} MB)，单次上传限制为 2 GB",
            total as f64 / 1_048_576.0
        )));
    }

    emit_folder_upload_status(&app, &upload_id, "uploading", 0, total);

    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    let tmp_remote = format!("/tmp/marcel-upload-{}.zip", uuid::Uuid::new_v4());

    let mut remote_file = sftp
        .open_with_flags(
            &tmp_remote,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| {
            let _ = tokio::fs::remove_file(&zip_path);
            AppError::Ssh(format!("创建远程临时文件失败: {}", e))
        })?;

    let mut local_file = tokio::fs::File::open(&zip_path).await.map_err(|e| {
        let _ = tokio::fs::remove_file(&zip_path);
        AppError::Ssh(format!("打开本地zip文件失败: {}", e))
    })?;

    let mut buf = vec![0u8; 131072];
    let mut written: u64 = 0;

    let upload_result: Result<(), AppError> = async {
        loop {
            let n = local_file
                .read(&mut buf)
                .await
                .map_err(|e| AppError::Ssh(format!("读取本地zip文件失败: {}", e)))?;

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
            emit_folder_upload_status(&app, &upload_id, "uploading", written, total);
        }

        remote_file
            .flush()
            .await
            .map_err(|e| AppError::Ssh(format!("刷新远程文件失败: {}", e)))?;

        Ok(())
    }
    .await;

    drop(remote_file);
    drop(sftp);

    let _ = tokio::fs::remove_file(&zip_path).await;

    if upload_result.is_err() {
        return upload_result;
    }

    if written != total {
        return Err(AppError::Ssh(format!(
            "上传不完整：预期 {} 字节，实际上传 {} 字节",
            total, written
        )));
    }

    emit_folder_upload_status(&app, &upload_id, "extracting", 0, 1);

    let exec_cmd = crate::ssh::sftp_extract::build_extract_cmd(&tmp_remote, &remote_path);
    let output = state
        .ssh_manager
        .exec_command(&session_id, &exec_cmd)
        .await?;

    if !output.trim().contains("OK") {
        return Err(AppError::Ssh(format!("解压失败: {}", output.trim())));
    }

    let _ = app.emit("sftp-upload-done", json!({ "uploadId": &upload_id }));

    Ok(())
}
