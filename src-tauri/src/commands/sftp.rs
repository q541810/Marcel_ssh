use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::emit_event;
use crate::error::AppError;
use crate::util::{is_content_uri, shell_escape, validate_local_path, validate_sftp_remote_path};
use crate::AppState;

use super::sftp_sysopen::{
    cancel as cancel_sysopen, cleanup_session as cleanup_sysopen_session, open_with_system,
};
pub use super::sftp_sysopen::{OpenWithSystemResult, SysopenPhase, SysopenStateEvent};

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
pub async fn sftp_extract_archive(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    target_dir: String,
) -> Result<(), AppError> {
    let remote_path = validate_sftp_remote_path(&remote_path)?;
    let target_dir = validate_sftp_remote_path(&target_dir)?;

    let filename = remote_path.rsplit('/').next().unwrap_or(&remote_path);

    let kind = crate::ssh::sftp_extract::get_archive_type(filename).ok_or_else(|| {
        AppError::Ssh(
            "不支持的压缩格式，仅支持 .zip、.tar、.tar.gz、.tgz、.tar.bz2、.tar.xz".into(),
        )
    })?;

    let check_cmd = match kind {
        crate::ssh::sftp_extract::ArchiveType::Zip => {
            crate::ssh::sftp_extract::build_unzip_check_cmd()
        }
        _ => crate::ssh::sftp_extract::build_tar_check_cmd(),
    };
    let check_output = state
        .ssh_manager
        .exec_command(&session_id, check_cmd)
        .await?;
    if !crate::ssh::sftp_extract::has_tool(&check_output) {
        let tool = match kind {
            crate::ssh::sftp_extract::ArchiveType::Zip => "unzip",
            _ => "tar",
        };
        return Err(AppError::Ssh(format!(
            "远端服务器缺少 {}，无法解压。请安装后重试。",
            tool
        )));
    }

    let cmd = crate::ssh::sftp_extract::build_extract_to_dir_cmd(&remote_path, &target_dir, kind);
    let output = state.ssh_manager.exec_command(&session_id, &cmd).await?;

    if !output.trim().contains("OK") {
        return Err(AppError::Ssh(format!("解压失败: {}", output.trim())));
    }

    Ok(())
}

/// 系统目录黑名单：禁止压缩这些目录，防止意外打包整个系统或敏感数据。
const SYSTEM_PATH_BLACKLIST: &[&str] = &[
    "/",
    "/usr",
    "/usr/local",
    "/var",
    "/var/log",
    "/var/lib",
    "/var/lib/docker",
    "/proc",
    "/sys",
    "/dev",
    "/etc",
    "/bin",
    "/sbin",
    "/lib",
    "/lib64",
    "/boot",
    "/run",
    "/snap",
    "/opt",
];

/// 检查路径是否在系统目录黑名单内（精确匹配或前缀匹配）。
fn is_system_path(path: &str) -> bool {
    let normalized = path.trim_end_matches('/');
    if normalized.is_empty() {
        return true; // 根目录
    }
    SYSTEM_PATH_BLACKLIST
        .iter()
        .any(|blocked| *blocked == normalized || normalized.starts_with(&format!("{}/", blocked)))
}

/// 压缩远程目录为 tar.gz 或 zip 归档。
///
/// 安全：
/// - 源路径和目标路径均经过 `validate_sftp_remote_path` 校验（拒绝 `..`、空字节）
/// - 源路径经过系统目录黑名单过滤（拒绝 `/`、`/usr`、`/proc` 等）
/// - 目标路径不能在源目录内（避免递归包含）
/// - 所有路径用 `shell_escape` 转义，防命令注入
/// - 执行前检查 `tar` / `zip` 工具是否存在
///
/// 进度：通过 `ssh-long-output` 事件实时透传 tar/zip 输出，通过 `task_id` 路由。
/// 取消：前端调 `ssh_exec_long_cancel(task_id)` 即可取消。
#[tauri::command]
pub async fn sftp_compress_archive(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    remote_dir: String,
    format: String,
    target_path: String,
    overwrite: bool,
    task_id: String,
) -> Result<(), AppError> {
    let remote_dir = validate_sftp_remote_path(&remote_dir)?;
    let target_path = validate_sftp_remote_path(&target_path)?;

    // 系统目录黑名单
    if is_system_path(&remote_dir) {
        return Err(AppError::Ssh(format!(
            "拒绝压缩系统目录「{}」，请选择用户目录下的文件夹",
            remote_dir
        )));
    }

    // 递归包含检测：目标路径不能在源目录内
    // 例如 source=/home/user/foo, target=/home/user/foo/bar.tar.gz 应拒绝
    let remote_dir_normalized = remote_dir.trim_end_matches('/');
    let target_normalized = target_path.trim_end_matches('/');
    if target_normalized.starts_with(&format!("{}/", remote_dir_normalized)) {
        return Err(AppError::Ssh(format!(
            "目标路径「{}」位于源目录「{}」内，会导致递归压缩，请改用其他路径",
            target_path, remote_dir
        )));
    }

    // 格式校验 + 工具检查
    let kind = match format.as_str() {
        "tar.gz" => crate::ssh::sftp_extract::ArchiveType::TarGz,
        "zip" => crate::ssh::sftp_extract::ArchiveType::Zip,
        other => {
            return Err(AppError::Ssh(format!(
                "不支持的压缩格式「{}」，仅支持 tar.gz 和 zip",
                other
            )));
        }
    };

    let check_cmd = match kind {
        crate::ssh::sftp_extract::ArchiveType::Zip => {
            crate::ssh::sftp_extract::build_zip_check_cmd()
        }
        _ => crate::ssh::sftp_extract::build_tar_check_cmd(),
    };
    let check_output = state
        .ssh_manager
        .exec_command(&session_id, check_cmd)
        .await?;
    if !crate::ssh::sftp_extract::has_tool(&check_output) {
        let tool = match kind {
            crate::ssh::sftp_extract::ArchiveType::Zip => "zip",
            _ => "tar",
        };
        return Err(AppError::Ssh(format!(
            "远端服务器缺少 {}，无法压缩。请安装后重试。",
            tool
        )));
    }

    // 目标已存在检查（不 overwrite 时拒绝）
    // 用 shell test 检查，瞬时返回，120s 超时足够
    if !overwrite {
        let target_esc = shell_escape(&target_path);
        let check_cmd = format!("test -e {} && echo EXISTS || echo MISSING", target_esc);
        let check_output = state
            .ssh_manager
            .exec_command(&session_id, &check_cmd)
            .await?;
        if check_output.trim().contains("EXISTS") {
            return Err(AppError::Ssh(format!(
                "目标文件「{}」已存在。请勾选「覆盖」或修改目标路径",
                target_path
            )));
        }
    }

    // 构造压缩命令
    let cmd =
        crate::ssh::sftp_extract::build_compress_to_archive_cmd(&remote_dir, &target_path, kind)
            .map_err(|e| AppError::Ssh(e.to_string()))?;

    // 用 ssh_exec_long 内核执行（30 分钟超时 + 取消 + 流式输出）
    // 直接调 exec_command_streamed，事件用 task_id 路由
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    state
        .long_exec_cancel_senders
        .write()
        .insert(task_id.clone(), cancel_tx);
    let _guard = TransferCancelGuard::new(task_id.clone(), state.long_exec_cancel_senders.clone());

    let timeout = std::time::Duration::from_secs(1800);
    let event_name = "ssh-long-output";

    let exec_fut = state.ssh_manager.exec_command_streamed(
        &session_id,
        &cmd,
        timeout,
        &app,
        event_name,
        &task_id,
    );

    let result = tokio::select! {
        biased;
        _ = cancel_rx.changed() => {
            emit_event(
                &app,
                "ssh-long-cancelled",
                &json!({ "taskId": &task_id }),
            );
            return Err(AppError::Ssh("压缩已取消".into()));
        }
        res = exec_fut => res,
    };

    match result {
        Ok((output, was_timeout)) => {
            if was_timeout {
                emit_event(
                    &app,
                    "ssh-long-error",
                    &json!({ "taskId": &task_id, "message": "压缩超时（30 分钟）" }),
                );
                return Err(AppError::Ssh("压缩超时，文件夹可能过大".into()));
            }
            // 检查 OK/FAILED 标记
            if output.lines().any(|line| line.trim() == "OK") {
                emit_event(&app, "ssh-long-done", &json!({ "taskId": &task_id }));
                Ok(())
            } else {
                let trimmed = output.trim();
                let preview = if trimmed.len() > 500 {
                    format!("{}...", &trimmed[..500])
                } else {
                    trimmed.to_string()
                };
                emit_event(
                    &app,
                    "ssh-long-error",
                    &json!({ "taskId": &task_id, "message": preview }),
                );
                Err(AppError::Ssh(format!("压缩失败: {}", preview)))
            }
        }
        Err(e) => {
            emit_event(
                &app,
                "ssh-long-error",
                &json!({ "taskId": &task_id, "message": e.to_string() }),
            );
            Err(e)
        }
    }
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

#[derive(Debug, Serialize)]
pub struct ReadFileResult {
    pub content: String,
    pub mtime: u64,
}

const MAX_EDITOR_FILE_SIZE: u64 = 2 * 1024 * 1024;

#[tauri::command]
pub async fn sftp_read_file(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<ReadFileResult, AppError> {
    let path = validate_sftp_remote_path(&path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;
    let metadata = sftp
        .metadata(&path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取文件信息失败: {}", e)))?;

    if metadata.is_dir() {
        return Err(AppError::Ssh("无法编辑目录".into()));
    }

    let mtime = metadata.mtime.unwrap_or(0) as u64;

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

    let content = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::Ssh("无法解码文件，可能为二进制文件或使用了不支持的编码".into()))?;

    Ok(ReadFileResult { content, mtime })
}

#[tauri::command]
pub async fn sftp_get_mtime(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<u64, AppError> {
    let path = validate_sftp_remote_path(&path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;
    let metadata = sftp
        .metadata(&path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取文件信息失败: {}", e)))?;

    if metadata.is_dir() {
        return Err(AppError::Ssh("路径是目录，不是文件".into()));
    }

    Ok(metadata.mtime.unwrap_or(0) as u64)
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
    let temp_path = remote_sidecar_path(&path, "edit")?;

    let mut file = sftp
        .open_with_flags(
            &temp_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {}", e)))?;

    if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, content.as_bytes()).await {
        let _ = sftp.remove_file(&temp_path).await;
        return Err(AppError::Ssh(format!("写入远程文件失败: {}", e)));
    }

    if let Err(e) = file.flush().await {
        let _ = sftp.remove_file(&temp_path).await;
        return Err(AppError::Ssh(format!("刷新远程文件失败: {}", e)));
    }

    drop(file);
    commit_remote_temp_file(&sftp, &temp_path, &path, true).await?;

    Ok(())
}

/// 远程 → 本地文件的分块拷贝循环（含取消、进度事件、结尾 flush）。
/// 返回实际写入字节数；上层负责对目标文件做失败清理。
async fn stream_remote_to_local_file(
    app: &AppHandle,
    remote: &mut russh_sftp::client::fs::File,
    local: &mut tokio::fs::File,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    download_id: &str,
    total: u64,
) -> Result<u64, AppError> {
    let mut buf = vec![0u8; 131072];
    let mut written: u64 = 0;

    loop {
        check_cancelled(cancel_rx, "下载已取消")?;

        let n = tokio::select! {
            result = remote.read(&mut buf) => {
                result.map_err(|e| AppError::Ssh(format!("读取远程文件失败: {}", e)))?
            }
            _ = cancel_rx.changed() => return Err(AppError::Ssh("下载已取消".into())),
        };

        if n == 0 {
            break;
        }

        tokio::select! {
            result = local.write_all(&buf[..n]) => {
                result.map_err(|e| AppError::Ssh(format!("写入本地文件失败: {}", e)))?;
            }
            _ = cancel_rx.changed() => return Err(AppError::Ssh("下载已取消".into())),
        }

        written += n as u64;

        emit_event(
            app,
            "sftp-download-progress",
            json!({ "downloadId": download_id, "written": written, "total": total }),
        );
    }

    tokio::select! {
        result = local.flush() => {
            result.map_err(|e| AppError::Ssh(format!("刷新本地文件失败: {}", e)))?;
        }
        _ = cancel_rx.changed() => return Err(AppError::Ssh("下载已取消".into())),
    }

    Ok(written)
}

/// content:// 目标的失败清理：SAF 文档无法从应用侧删除，退化为截断到 0，
/// 避免留下半截内容被误当作完整文件。
async fn truncate_content_target(app: &AppHandle, uri: &str) {
    if let Ok(file) =
        open_content_uri_file(app, uri.to_string(), ContentOpenMode::WriteTruncate).await
    {
        let _ = file.sync_all().await;
    }
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

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    state
        .download_cancel_senders
        .write()
        .insert(download_id.clone(), cancel_tx);
    let _guard = TransferCancelGuard {
        transfer_id: download_id.clone(),
        senders: state.download_cancel_senders.clone(),
    };

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

    // Android SAF content:// 目标：由 ACTION_CREATE_DOCUMENT 刚创建的文档本身就是
    // 新文件，且 content URI 无法拼 .part 兄弟路径，直接写入目标；
    // 失败时截断为 0 作为降级（SAF 不允许应用删除该文档）。
    if is_content_uri(&local_path) {
        let mut local =
            open_content_uri_file(&app, local_path.clone(), ContentOpenMode::WriteTruncate)
                .await
                .map_err(|e| AppError::Ssh(format!("创建本地文件失败: {}", e)))?;

        let written = match stream_remote_to_local_file(
            &app,
            &mut remote,
            &mut local,
            &mut cancel_rx,
            &download_id,
            total,
        )
        .await
        {
            Ok(written) => written,
            Err(e) => {
                drop(local);
                truncate_content_target(&app, &local_path).await;
                return Err(e);
            }
        };

        if written != total {
            drop(local);
            truncate_content_target(&app, &local_path).await;
            return Err(AppError::Ssh(format!(
                "下载不完整：预期 {} 字节，实际写入 {} 字节",
                total, written
            )));
        }

        if let Err(e) = check_cancelled(&cancel_rx, "下载已取消") {
            drop(local);
            truncate_content_target(&app, &local_path).await;
            return Err(e);
        }

        let _ = local.sync_all().await;
        emit_event(
            &app,
            "sftp-download-done",
            json!({ "downloadId": &download_id }),
        );
        return Ok(());
    }

    let temp_local_path = format!("{}.marcel-download-{}.part", local_path, download_id);
    let backup_local_path = format!("{}.marcel-download-{}.backup", local_path, download_id);

    let mut local = tokio::fs::File::create(&temp_local_path)
        .await
        .map_err(|e| AppError::Ssh(format!("创建本地文件失败: {}", e)))?;

    let result = stream_remote_to_local_file(
        &app,
        &mut remote,
        &mut local,
        &mut cancel_rx,
        &download_id,
        total,
    )
    .await;

    let written = match result {
        Ok(written) => written,
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp_local_path).await;
            return Err(e);
        }
    };

    if written != total {
        let _ = tokio::fs::remove_file(&temp_local_path).await;
        return Err(AppError::Ssh(format!(
            "下载不完整：预期 {} 字节，实际写入 {} 字节",
            total, written
        )));
    }

    if let Err(e) = check_cancelled(&cancel_rx, "下载已取消") {
        let _ = tokio::fs::remove_file(&temp_local_path).await;
        return Err(e);
    }

    let had_existing = match tokio::fs::metadata(&local_path).await {
        Ok(meta) => {
            if meta.is_dir() {
                let _ = tokio::fs::remove_file(&temp_local_path).await;
                return Err(AppError::Ssh("保存路径已存在同名目录".into()));
            }
            true
        }
        Err(_) => false,
    };

    if had_existing {
        let _ = tokio::fs::remove_file(&backup_local_path).await;
        if let Err(e) = tokio::fs::rename(&local_path, &backup_local_path).await {
            let _ = tokio::fs::remove_file(&temp_local_path).await;
            return Err(AppError::Ssh(format!("备份已有文件失败: {}", e)));
        }
    }

    if let Err(e) = tokio::fs::rename(&temp_local_path, &local_path).await {
        if had_existing {
            let _ = tokio::fs::rename(&backup_local_path, &local_path).await;
        }
        let _ = tokio::fs::remove_file(&temp_local_path).await;
        return Err(AppError::Ssh(format!("保存下载文件失败: {}", e)));
    }

    if had_existing {
        let _ = tokio::fs::remove_file(&backup_local_path).await;
    }

    emit_event(
        &app,
        "sftp-download-done",
        json!({ "downloadId": &download_id }),
    );

    Ok(())
}

#[tauri::command]
pub async fn sftp_cancel_upload(
    state: State<'_, AppState>,
    upload_id: String,
) -> Result<(), AppError> {
    if let Some(sender) = state.upload_cancel_senders.write().remove(&upload_id) {
        let _ = sender.send(true);
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_cancel_download(
    state: State<'_, AppState>,
    download_id: String,
) -> Result<(), AppError> {
    if let Some(sender) = state.download_cancel_senders.write().remove(&download_id) {
        let _ = sender.send(true);
    }
    Ok(())
}

/// Drop guard that removes the cancel sender from AppState on drop.
pub(crate) struct TransferCancelGuard {
    transfer_id: String,
    senders: std::sync::Arc<
        parking_lot::RwLock<std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>>,
    >,
}

impl TransferCancelGuard {
    pub(crate) fn new(
        transfer_id: String,
        senders: std::sync::Arc<
            parking_lot::RwLock<
                std::collections::HashMap<String, tokio::sync::watch::Sender<bool>>,
            >,
        >,
    ) -> Self {
        Self {
            transfer_id,
            senders,
        }
    }
}

impl Drop for TransferCancelGuard {
    fn drop(&mut self) {
        self.senders.write().remove(&self.transfer_id);
    }
}

/// content:// URI 的打开模式（Android SAF）。
#[derive(Clone, Copy)]
enum ContentOpenMode {
    /// 只读（上传源）。
    Read,
    /// 写入并截断（下载目标；SAF ACTION_CREATE_DOCUMENT 创建的文档直接覆写）。
    WriteTruncate,
}

/// 通过 tauri-plugin-fs 的 `FsExt::fs().open()` 打开 content:// URI。
/// Android 上底层走 ContentResolver.openAssetFileDescriptor 拿真实 fd，
/// 返回 std::fs::File；这里用 spawn_blocking 包 JNI 往返，再转 tokio File。
async fn open_content_uri_file(
    app: &AppHandle,
    uri: String,
    mode: ContentOpenMode,
) -> Result<tokio::fs::File, AppError> {
    use std::str::FromStr;
    use tauri_plugin_fs::{FilePath, FsExt, OpenOptions};

    let app = app.clone();
    let std_file = tokio::task::spawn_blocking(move || {
        // FromStr 是 Infallible；content:// 一定解析为 FilePath::Url
        let path = FilePath::from_str(&uri).expect("FilePath::from_str is infallible");
        let mut opts = OpenOptions::new();
        match mode {
            ContentOpenMode::Read => {
                opts.read(true);
            }
            ContentOpenMode::WriteTruncate => {
                opts.write(true).truncate(true);
            }
        }
        app.fs().open(path, opts)
    })
    .await
    .map_err(|e| AppError::Ssh(format!("打开文件任务失败: {}", e)))?
    .map_err(|e| AppError::Ssh(format!("打开文件失败: {}", e)))?;

    Ok(tokio::fs::File::from_std(std_file))
}

/// 解析本地文件的展示名：content:// URI 查 ContentResolver DISPLAY_NAME
/// （失败退化为 URI 最后一段解码），普通路径取 basename。
/// 供移动端上传前确定远端文件名。
#[tauri::command]
pub async fn sftp_local_file_name(path: String) -> Result<String, AppError> {
    let path = validate_local_path(&path)?;

    if is_content_uri(&path) {
        #[cfg(target_os = "android")]
        {
            let uri = path.clone();
            let queried =
                tokio::task::spawn_blocking(move || crate::util::query_content_display_name(&uri))
                    .await
                    .map_err(|e| AppError::Ssh(format!("查询文件名任务失败: {}", e)))?;
            if let Some(name) = queried {
                return Ok(name);
            }
        }
        return crate::util::content_uri_fallback_name(&path)
            .ok_or_else(|| AppError::Ssh("无法从所选文件解析文件名".into()));
    }

    Path::new(&path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .ok_or_else(|| AppError::Ssh("无法从路径解析文件名".into()))
}

fn check_cancelled(
    cancel_rx: &tokio::sync::watch::Receiver<bool>,
    message: &str,
) -> Result<(), AppError> {
    if *cancel_rx.borrow() {
        Err(AppError::Ssh(message.into()))
    } else {
        Ok(())
    }
}

pub(super) fn remote_sidecar_path(path: &str, label: &str) -> Result<String, AppError> {
    let normalized = path.trim_end_matches('/');
    let Some(idx) = normalized.rfind('/') else {
        return Err(AppError::Ssh("远程路径无效".into()));
    };
    let parent = if idx == 0 { "/" } else { &normalized[..idx] };
    let name = &normalized[idx + 1..];
    if name.is_empty() {
        return Err(AppError::Ssh("远程文件名不能为空".into()));
    }
    let sidecar = format!(".{}.marcel-{}-{}", name, label, uuid::Uuid::new_v4());
    Ok(if parent == "/" {
        format!("/{}", sidecar)
    } else {
        format!("{}/{}", parent, sidecar)
    })
}

pub(super) async fn commit_remote_temp_file(
    sftp: &russh_sftp::client::SftpSession,
    temp_path: &str,
    target_path: &str,
    allow_replace: bool,
) -> Result<(), AppError> {
    let existing = sftp.metadata(target_path).await.ok();
    if let Some(meta) = &existing {
        if meta.is_dir() {
            let _ = sftp.remove_file(temp_path).await;
            return Err(AppError::Ssh("目标路径已存在同名目录".into()));
        }
        if !allow_replace {
            let _ = sftp.remove_file(temp_path).await;
            return Err(AppError::Ssh(
                "远程文件已存在，请先删除或重命名再上传".into(),
            ));
        }
    }

    if existing.is_none() {
        return sftp
            .rename(temp_path, target_path)
            .await
            .map_err(|e| AppError::Ssh(format!("提交远程文件失败: {}", e)));
    }

    let backup_path = remote_sidecar_path(target_path, "backup")?;
    if let Err(e) = sftp.rename(target_path, &backup_path).await {
        let _ = sftp.remove_file(temp_path).await;
        return Err(AppError::Ssh(format!("备份远程文件失败: {}", e)));
    }

    if let Err(e) = sftp.rename(temp_path, target_path).await {
        let _ = sftp.rename(&backup_path, target_path).await;
        let _ = sftp.remove_file(temp_path).await;
        return Err(AppError::Ssh(format!("提交远程文件失败: {}", e)));
    }

    let _ = sftp.remove_file(&backup_path).await;
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

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    state
        .upload_cancel_senders
        .write()
        .insert(upload_id.clone(), cancel_tx);
    let _guard = TransferCancelGuard {
        transfer_id: upload_id.clone(),
        senders: state.upload_cancel_senders.clone(),
    };

    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    // content:// URI（Android SAF）：经 fs 插件按 fd 打开，大小从 fd 的 metadata 取
    // （ContentResolver 通常返回真实文件 fd，fstat 可得 size；个别 provider 返回
    // pipe，size 恒为 0，此时视为总量未知，跳过完整性校验，前端进度条降级隐藏）。
    // 普通路径保持原逻辑。
    let (mut local_file, total, size_known) = if is_content_uri(&local_path) {
        let file = open_content_uri_file(&app, local_path.clone(), ContentOpenMode::Read)
            .await
            .map_err(|e| AppError::Ssh(format!("打开本地文件失败: {}", e)))?;
        let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
        (file, size, size > 0)
    } else {
        let local_meta = tokio::fs::metadata(&local_path)
            .await
            .map_err(|e| AppError::Ssh(format!("无法读取本地文件信息: {}", e)))?;

        if local_meta.is_dir() {
            return Err(AppError::Ssh("请使用文件夹上传功能上传目录".into()));
        }

        let file = tokio::fs::File::open(&local_path)
            .await
            .map_err(|e| AppError::Ssh(format!("打开本地文件失败: {}", e)))?;
        (file, local_meta.len(), true)
    };

    if total > MAX_STREAM_UPLOAD_BYTES {
        return Err(AppError::Ssh(format!(
            "文件过大 ({} MB)，单文件上传限制为 2 GB",
            total as f64 / 1_048_576.0
        )));
    }

    let temp_remote_path = remote_sidecar_path(&remote_path, "upload")?;

    let mut remote_file = sftp
        .open_with_flags(
            &temp_remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {}", e)))?;

    let mut buf = vec![0u8; 131072];
    let mut written: u64 = 0;

    let result: Result<(), AppError> = async {
        loop {
            check_cancelled(&cancel_rx, "上传已取消")?;

            let n = tokio::select! {
                result = local_file.read(&mut buf) => {
                    result.map_err(|e| AppError::Ssh(format!("读取本地文件失败: {}", e)))?
                }
                _ = cancel_rx.changed() => return Err(AppError::Ssh("上传已取消".into())),
            };

            if n == 0 {
                break;
            }

            tokio::select! {
                result = tokio::io::AsyncWriteExt::write_all(&mut remote_file, &buf[..n]) => {
                    result.map_err(|e| AppError::Ssh(format!("写入远程文件失败: {}", e)))?;
                }
                _ = cancel_rx.changed() => return Err(AppError::Ssh("上传已取消".into())),
            }

            written += n as u64;

            emit_event(
                &app,
                "sftp-upload-progress",
                json!({ "uploadId": &upload_id, "written": written, "total": total }),
            );
        }

        tokio::select! {
            result = remote_file.flush() => {
                result.map_err(|e| AppError::Ssh(format!("刷新远程文件失败: {}", e)))?;
            }
            _ = cancel_rx.changed() => return Err(AppError::Ssh("上传已取消".into())),
        }

        Ok(())
    }
    .await;

    if result.is_err() {
        let _ = sftp.remove_file(&temp_remote_path).await;
        return result;
    }

    if size_known && written != total {
        let _ = sftp.remove_file(&temp_remote_path).await;
        return Err(AppError::Ssh(format!(
            "上传不完整：预期 {} 字节，实际上传 {} 字节",
            total, written
        )));
    }

    if let Err(e) = check_cancelled(&cancel_rx, "上传已取消") {
        let _ = sftp.remove_file(&temp_remote_path).await;
        return Err(e);
    }
    commit_remote_temp_file(&sftp, &temp_remote_path, &remote_path, false).await?;

    emit_event(&app, "sftp-upload-done", json!({ "uploadId": &upload_id }));

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
    emit_event(
        app,
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
    cancelled: &AtomicBool,
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
        if cancelled.load(Ordering::Relaxed) {
            let _ = std::fs::remove_file(&zip_path);
            return Err(AppError::Ssh("上传已取消".into()));
        }

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
    use super::{find_name_collisions, folder_upload_percent};

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

    #[test]
    fn finds_no_collision_when_disjoint() {
        let local = vec!["a.txt".to_string(), "lib".to_string()];
        let remote = vec!["b.txt".to_string(), "doc".to_string()];
        assert!(find_name_collisions(&local, &remote).is_empty());
    }

    #[test]
    fn detects_file_and_dir_name_collisions() {
        let local = vec!["a.txt".to_string(), "lib".to_string(), "c.png".to_string()];
        let remote = vec!["lib".to_string(), "c.png".to_string(), "other".to_string()];
        let collisions = find_name_collisions(&local, &remote);
        assert_eq!(collisions, vec!["c.png".to_string(), "lib".to_string()]);
    }

    #[test]
    fn collision_list_is_sorted_and_deduped() {
        let local = vec![
            "z.txt".to_string(),
            "z.txt".to_string(),
            "a.txt".to_string(),
        ];
        let remote = vec!["a.txt".to_string(), "z.txt".to_string()];
        let collisions = find_name_collisions(&local, &remote);
        assert_eq!(collisions, vec!["a.txt".to_string(), "z.txt".to_string()]);
    }

    #[test]
    fn handles_empty_inputs() {
        assert!(find_name_collisions(&[], &[]).is_empty());
        assert!(find_name_collisions(&["a.txt".to_string()], &[]).is_empty());
        assert!(find_name_collisions(&[], &["a.txt".to_string()]).is_empty());
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

fn collect_local_top_level_names(dir: &Path) -> Result<Vec<String>, AppError> {
    let entries = std::fs::read_dir(dir)
        .map_err(|e| AppError::Ssh(format!("读取本地目录失败 {}: {}", dir.display(), e)))?;
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| AppError::Ssh(format!("读取目录条目失败: {}", e)))?;
        names.push(entry.file_name().to_string_lossy().to_string());
    }
    Ok(names)
}

async fn collect_remote_top_level_names(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
) -> Result<Vec<String>, AppError> {
    let mut dir = sftp
        .read_dir(remote_path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取远端目录失败: {}", e)))?;
    let mut names = Vec::new();
    while let Some(entry) = dir.next() {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        names.push(name);
    }
    Ok(names)
}

fn find_name_collisions(local_names: &[String], remote_names: &[String]) -> Vec<String> {
    let remote_set: std::collections::HashSet<&String> = remote_names.iter().collect();
    let mut collisions: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for name in local_names {
        if remote_set.contains(name) {
            collisions.insert(name.clone());
        }
    }
    collisions.into_iter().collect()
}

#[tauri::command]
pub async fn sftp_upload_folder_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_path: String,
    upload_id: String,
    flat: bool,
) -> Result<(), AppError> {
    let local_path = validate_local_path(&local_path)?;
    let remote_path = validate_sftp_remote_path(&remote_path)?;

    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    state
        .upload_cancel_senders
        .write()
        .insert(upload_id.clone(), cancel_tx);
    let _guard = TransferCancelGuard {
        transfer_id: upload_id.clone(),
        senders: state.upload_cancel_senders.clone(),
    };

    let local = Path::new(&local_path);
    if !local.is_dir() {
        return Err(AppError::Ssh("本地路径不是目录".into()));
    }

    check_cancelled(&cancel_rx, "上传已取消")?;
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

    check_cancelled(&cancel_rx, "上传已取消")?;

    if flat {
        let local_names = collect_local_top_level_names(local)?;
        let sftp_check = state.ssh_manager.open_sftp(&session_id).await?;
        let remote_names = collect_remote_top_level_names(&sftp_check, &remote_path).await;
        drop(sftp_check);
        let remote_names = remote_names?;
        let collisions = find_name_collisions(&local_names, &remote_names);
        if !collisions.is_empty() {
            return Err(AppError::Ssh(format!(
                "远端目录已存在同名条目：{}，请先处理后再上传",
                collisions.join("、")
            )));
        }
    } else {
        let sftp_check = state.ssh_manager.open_sftp(&session_id).await?;
        if sftp_check.metadata(&remote_path).await.is_ok() {
            return Err(AppError::Ssh(
                "远端已存在同名目录，请重命名或选择上传到当前目录".into(),
            ));
        }
    }

    check_cancelled(&cancel_rx, "上传已取消")?;
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
    let cancelled = std::sync::Arc::new(AtomicBool::new(false));
    let cancelled_clone = cancelled.clone();
    let cancelled_weak = Arc::downgrade(&cancelled);

    // Background task: watch for cancellation signal and set the atomic flag
    {
        let mut rx = cancel_rx.clone();
        let weak = cancelled_weak;
        tokio::spawn(async move {
            loop {
                if rx.changed().await.is_err() {
                    break;
                }
                if *rx.borrow() {
                    if let Some(flag) = weak.upgrade() {
                        flag.store(true, Ordering::Relaxed);
                    }
                    break;
                }
            }
        });
    }

    let zip_path = tokio::task::spawn_blocking(move || {
        zip_local_folder(
            Path::new(&local_path_owned),
            compression_level,
            &cancelled_clone,
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
            check_cancelled(&cancel_rx, "上传已取消")?;

            let n = tokio::select! {
                result = local_file.read(&mut buf) => {
                    result.map_err(|e| AppError::Ssh(format!("读取本地zip文件失败: {}", e)))?
                }
                _ = cancel_rx.changed() => return Err(AppError::Ssh("上传已取消".into())),
            };

            if n == 0 {
                break;
            }

            tokio::select! {
                result = tokio::io::AsyncWriteExt::write_all(&mut remote_file, &buf[..n]) => {
                    result.map_err(|e| AppError::Ssh(format!("写入远程文件失败: {}", e)))?;
                }
                _ = cancel_rx.changed() => return Err(AppError::Ssh("上传已取消".into())),
            }

            written += n as u64;

            emit_event(
                &app,
                "sftp-upload-progress",
                json!({ "uploadId": &upload_id, "written": written, "total": total }),
            );
            emit_folder_upload_status(&app, &upload_id, "uploading", written, total);
        }

        tokio::select! {
            result = remote_file.flush() => {
                result.map_err(|e| AppError::Ssh(format!("刷新远程文件失败: {}", e)))?;
            }
            _ = cancel_rx.changed() => return Err(AppError::Ssh("上传已取消".into())),
        }

        Ok(())
    }
    .await;

    drop(remote_file);
    drop(sftp);

    let _ = tokio::fs::remove_file(&zip_path).await;

    if upload_result.is_err() {
        // Attempt to clean up remote temp file on error/cancel
        if let Ok(sftp) = state.ssh_manager.open_sftp(&session_id).await {
            let _ = sftp.remove_file(&tmp_remote).await;
        }
        return upload_result;
    }

    if written != total {
        return Err(AppError::Ssh(format!(
            "上传不完整：预期 {} 字节，实际上传 {} 字节",
            total, written
        )));
    }

    check_cancelled(&cancel_rx, "上传已取消")?;
    emit_folder_upload_status(&app, &upload_id, "extracting", 0, 1);

    let exec_cmd = crate::ssh::sftp_extract::build_extract_cmd(&tmp_remote, &remote_path);
    let output = state
        .ssh_manager
        .exec_command(&session_id, &exec_cmd)
        .await?;

    if !output.trim().contains("OK") {
        return Err(AppError::Ssh(format!("解压失败: {}", output.trim())));
    }

    emit_event(&app, "sftp-upload-done", json!({ "uploadId": &upload_id }));

    Ok(())
}

const MAX_DRAG_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;

fn copy_dir_recursive(src: &Path, dest: &Path) -> Result<(), AppError> {
    std::fs::create_dir_all(dest)
        .map_err(|e| AppError::Ssh(format!("创建目录失败 {}: {}", dest.display(), e)))?;

    for entry in std::fs::read_dir(src)
        .map_err(|e| AppError::Ssh(format!("读取目录失败 {}: {}", src.display(), e)))?
    {
        let entry = entry.map_err(|e| AppError::Ssh(format!("读取目录条目失败: {}", e)))?;
        let path = entry.path();
        let file_name = entry.file_name();
        let dest_path = dest.join(file_name);

        if path.is_symlink() {
            continue;
        }

        if path.is_dir() {
            copy_dir_recursive(&path, &dest_path)?;
        } else if path.is_file() {
            std::fs::copy(&path, &dest_path)
                .map_err(|e| AppError::Ssh(format!("复制文件失败 {}: {}", path.display(), e)))?;
        }
    }

    Ok(())
}

fn dir_size(path: &Path) -> Result<u64, AppError> {
    let mut total: u64 = 0;
    for entry in std::fs::read_dir(path)
        .map_err(|e| AppError::Ssh(format!("读取目录失败 {}: {}", path.display(), e)))?
    {
        let entry = entry.map_err(|e| AppError::Ssh(format!("读取目录条目失败: {}", e)))?;
        let path = entry.path();
        if path.is_symlink() {
            continue;
        }
        if path.is_dir() {
            total += dir_size(&path)?;
        } else if path.is_file() {
            total += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(total)
}

#[tauri::command]
pub async fn sftp_prepare_drag_upload(file_paths: Vec<String>) -> Result<String, AppError> {
    if file_paths.is_empty() {
        return Err(AppError::Ssh("没有提供文件路径".into()));
    }

    let temp_id = uuid::Uuid::new_v4();
    let temp_dir = std::env::temp_dir().join(format!("marcel-drag-{}", temp_id));
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| AppError::Ssh(format!("创建临时目录失败: {}", e)))?;

    let mut errors: Vec<String> = Vec::new();

    for path_str in &file_paths {
        let validated = match validate_local_path(path_str) {
            Ok(p) => p,
            Err(e) => {
                errors.push(format!("{}: {}", path_str, e));
                continue;
            }
        };
        let src = Path::new(&validated);

        if !src.exists() {
            errors.push(format!("{}: 文件不存在", path_str));
            continue;
        }

        let file_name = match src.file_name() {
            Some(n) => n,
            None => {
                errors.push(format!("{}: 无效的文件路径", path_str));
                continue;
            }
        };
        let dest = temp_dir.join(file_name);

        let result = if src.is_symlink() {
            Ok(())
        } else if src.is_dir() {
            copy_dir_recursive(src, &dest)
        } else if src.is_file() {
            std::fs::copy(src, &dest)
                .map(|_| ())
                .map_err(|e| AppError::Ssh(format!("复制文件失败: {}", e)))
        } else {
            Ok(())
        };

        if let Err(e) = result {
            errors.push(format!("{}: {}", path_str, e));
        }
    }

    let total_size = dir_size(&temp_dir).unwrap_or(0);
    if total_size > MAX_DRAG_UPLOAD_BYTES {
        let _ = std::fs::remove_dir_all(&temp_dir);
        return Err(AppError::Ssh(format!(
            "文件过大 ({} MB)，拖拽上传限制为 2 GB",
            total_size as f64 / 1_048_576.0
        )));
    }

    if !errors.is_empty() {
        log::warn!("拖拽上传部分文件复制失败: {:?}", errors);
    }

    Ok(temp_dir.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn sftp_cleanup_temp_dir(temp_dir: String) -> Result<(), AppError> {
    let path = Path::new(&temp_dir);
    if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
        if !name.starts_with("marcel-drag-") {
            return Err(AppError::Ssh("拒绝清理非 marcel 临时目录".into()));
        }
    } else {
        return Err(AppError::Ssh("无效的临时目录路径".into()));
    }

    if path.exists() {
        std::fs::remove_dir_all(path)
            .map_err(|e| AppError::Ssh(format!("清理临时目录失败: {}", e)))?;
    }

    Ok(())
}

// ──────────── 图片预览（下载到临时目录后由 WebView 通过 asset 协议加载） ────────────

const MAX_PREVIEW_IMAGE_BYTES: u64 = 50 * 1024 * 1024;
const PREVIEW_TEMP_DIR_PREFIX: &str = "marcel-previews";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewImageResult {
    pub local_path: String,
}

/// 下载远程图片到 `temp_dir/marcel-previews/{uuid}/{sanitized_filename}`，
/// 供前端通过 `convertFileSrc` 转为 asset 协议 URL 后用 `<img>` 渲染。
///
/// - 50MB 硬上限，超限拒绝并提示用户走下载
/// - 文件名取远端 basename 并做 sanitize，避免路径穿越
/// - 不复用 sftp_download_stream 的进度/取消/原子落盘逻辑：预览场景无需弹保存对话框，
///   临时文件失败可直接清理；如需进度可前端监听并按需扩展
#[tauri::command]
pub async fn sftp_preview_image(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    preview_id: String,
) -> Result<PreviewImageResult, AppError> {
    let remote_path = validate_sftp_remote_path(&remote_path)?;

    // 取远端 basename 并 sanitize，防止路径穿越与非法字符
    let remote_basename = Path::new(&remote_path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Ssh("无法解析远端文件名".into()))?;
    // basename 不允许包含路径分隔符或空字节（file_name 已剥离目录，这里二次防御）
    if remote_basename.contains('/')
        || remote_basename.contains('\\')
        || remote_basename.contains('\0')
        || remote_basename == "."
        || remote_basename == ".."
    {
        return Err(AppError::Ssh("远端文件名包含非法字符".into()));
    }

    let sftp = state.ssh_manager.open_sftp(&session_id).await?;

    let metadata = sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取文件信息失败: {}", e)))?;
    if !metadata.is_regular() {
        return Err(AppError::Ssh("只能预览普通文件".into()));
    }
    let total = metadata.len();
    if total > MAX_PREVIEW_IMAGE_BYTES {
        return Err(AppError::Ssh(format!(
            "图片过大 ({} MB)，预览上限为 {} MB，请使用下载功能",
            total / (1024 * 1024),
            MAX_PREVIEW_IMAGE_BYTES / (1024 * 1024)
        )));
    }

    // 准备临时目录：app_data_dir/marcel-previews/{preview_id}/
    // 用 APPDATA 而非 temp_dir，因为 Tauri assetProtocol 的 $TEMP 变量在某些情况下不被识别
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Ssh(format!("获取 app_data_dir 失败: {}", e)))?;
    let temp_root = app_data.join(PREVIEW_TEMP_DIR_PREFIX);
    std::fs::create_dir_all(&temp_root)
        .map_err(|e| AppError::Ssh(format!("创建预览临时根目录失败: {}", e)))?;
    let temp_dir = temp_root.join(&preview_id);
    std::fs::create_dir_all(&temp_dir)
        .map_err(|e| AppError::Ssh(format!("创建预览临时目录失败: {}", e)))?;

    let local_path = temp_dir.join(&remote_basename);
    let temp_part_path = format!("{}.part", local_path.to_string_lossy());

    // 流式下载到 .part 文件，完成后 rename
    let mut remote = sftp
        .open_with_flags(&remote_path, OpenFlags::READ)
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {}", e)))?;

    let mut local = tokio::fs::File::create(&temp_part_path)
        .await
        .map_err(|e| AppError::Ssh(format!("创建本地临时文件失败: {}", e)))?;

    let mut buf = vec![0u8; 131072];
    let mut written: u64 = 0;

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

        emit_event(
            &app,
            "sftp-preview-progress",
            json!({
                "previewId": &preview_id,
                "written": written,
                "total": total,
            }),
        );
    }

    local
        .flush()
        .await
        .map_err(|e| AppError::Ssh(format!("刷新本地文件失败: {}", e)))?;
    drop(local);
    drop(remote);

    if written != total {
        let _ = tokio::fs::remove_file(&temp_part_path).await;
        return Err(AppError::Ssh(format!(
            "下载不完整：预期 {} 字节，实际 {} 字节",
            total, written
        )));
    }

    tokio::fs::rename(&temp_part_path, &local_path)
        .await
        .map_err(|e| AppError::Ssh(format!("保存预览文件失败: {}", e)))?;

    let local_path_str = local_path.to_string_lossy().to_string();
    log::info!(
        "[sftp_preview_image] preview_id={} local_path={}",
        preview_id,
        local_path_str
    );

    emit_event(
        &app,
        "sftp-preview-done",
        json!({ "previewId": &preview_id }),
    );

    Ok(PreviewImageResult {
        local_path: local_path_str,
    })
}

/// 清理预览临时文件。
/// - 传入 `local_path`：仅清理该文件及其所在的 `marcel-previews/{uuid}` 目录
/// - 不传：扫描 `app_data_dir/marcel-previews/` 下所有子目录全部清理（应用启动时调用）
#[tauri::command]
pub async fn sftp_preview_cleanup(
    app: AppHandle,
    local_path: Option<String>,
) -> Result<(), AppError> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Ssh(format!("获取 app_data_dir 失败: {}", e)))?;
    let temp_root = app_data.join(PREVIEW_TEMP_DIR_PREFIX);

    if let Some(p) = local_path {
        let path = Path::new(&p);
        // 校验：文件必须位于 marcel-previews 根下，避免被诱导删除任意文件
        let canonical = path
            .canonicalize()
            .map_err(|e| AppError::Ssh(format!("路径解析失败: {}", e)))?;
        let canonical_root = temp_root
            .canonicalize()
            .map_err(|e| AppError::Ssh(format!("预览根目录解析失败: {}", e)))?;
        if !canonical.starts_with(&canonical_root) {
            return Err(AppError::Ssh("拒绝清理预览目录之外的路径".into()));
        }

        if path.exists() {
            tokio::fs::remove_file(path)
                .await
                .map_err(|e| AppError::Ssh(format!("清理预览文件失败: {}", e)))?;
        }

        // 清理所在 {uuid} 目录（若已空）
        if let Some(parent) = path.parent() {
            if parent != temp_root.as_path() {
                let _ = tokio::fs::remove_dir(parent).await;
            }
        }
        return Ok(());
    }

    // 无参：扫描整个 marcel-previews 根
    if temp_root.exists() {
        let mut entries = tokio::fs::read_dir(&temp_root)
            .await
            .map_err(|e| AppError::Ssh(format!("读取预览根目录失败: {}", e)))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|e| AppError::Ssh(format!("遍历预览根目录失败: {}", e)))?
        {
            let _ = tokio::fs::remove_dir_all(entry.path()).await;
        }
    }
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────────
// 「用系统方式打开」(sysopen) —— 完全重写
//
// 把远程文件下载到本地临时目录，用系统默认应用打开；用 notify 监听本地文件变化，
// 改动后自动回传到远程。一个 task_id 关联「下载」与「监视回传」两张传输卡片，
// 状态经 `sftp-sysopen-state` 事件统一推送（不复用标准 progress/done 事件，
// 避免文案被覆盖为「下载完成/上传完成」而丢失 sysopen 语义）。
//
// 防御性要点：
//   - 同名文件去重：(session_id, remote_path) 同时只允许一个 sysopen 任务
//   - 限制单个 session 的并发任务数
//   - 下载阶段即可取消（select! 读 cancel），不再只能等下载完
//   - notify 替代 3s 轮询：保存即感知、低 CPU；事件去抖避免编辑器半截写
//   - 回传走原子 rename + 完整性校验；连续失败超限停止，不再无限重试刷日志
//   - mtime + size 双校验判断脏（FAT 等 mtime 不可靠时 size 兜底）
//   - 任务退出统一收尾：drop watcher、删本地临时文件、清状态表
//   - 用 tauri-plugin-opener 替代已 deprecated 的 shell().open()
// ────────────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sftp_open_with_system(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    session_id: String,
    remote_path: String,
    task_id: String,
    download_id: String,
    upload_id: String,
) -> Result<OpenWithSystemResult, AppError> {
    open_with_system(
        app,
        state.inner(),
        session_id,
        remote_path,
        task_id,
        download_id,
        upload_id,
    )
    .await
}

#[tauri::command]
pub async fn sftp_cancel_sysopen(
    state: State<'_, crate::AppState>,
    task_id: String,
) -> Result<(), AppError> {
    cancel_sysopen(&state, &task_id);
    Ok(())
}

/// 会话断开时清理：取消该 session 所有 sysopen 任务 + 删除其临时目录。
/// 由 ssh disconnect 调用。
pub(crate) async fn cleanup_session_sysopen(
    app: &AppHandle,
    state: &crate::AppState,
    session_id: &str,
) {
    cleanup_sysopen_session(app, state, session_id).await;
}

#[cfg(test)]
mod preview_tests {
    use super::*;

    #[test]
    fn preview_image_size_limit_is_50mb() {
        assert_eq!(MAX_PREVIEW_IMAGE_BYTES, 50 * 1024 * 1024);
    }

    #[test]
    fn preview_temp_dir_prefix_is_stable() {
        assert_eq!(PREVIEW_TEMP_DIR_PREFIX, "marcel-previews");
    }
}
