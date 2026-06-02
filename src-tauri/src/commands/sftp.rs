use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::State;
use tokio::io::AsyncWriteExt;

use crate::util::shell_escape;
use crate::error::AppError;
use crate::AppState;

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
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

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
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

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
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    sftp.create_dir(&path)
        .await
        .map_err(|e| AppError::Ssh(format!("创建目录失败: {}", e)))?;

    Ok(())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), AppError> {
    if is_dir {
        // SFTP remove_dir only works on empty directories, use rm -rf for recursive deletion
        state.ssh_manager.exec_command(
            &session_id,
            &format!("rm -rf {}", shell_escape(&path)),
        ).await?;
    } else {
        let sftp = state.ssh_manager.open_sftp(&session_id).await?;
        sftp.remove_file(&path)
            .await
            .map_err(|e| AppError::Ssh(format!("删除文件失败: {}", e)))?;
    }

    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), AppError> {
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

    if output.contains("OK") {
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
