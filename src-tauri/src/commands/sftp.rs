use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
// notify 的 watch 方法来自 Watcher trait，需在作用域内才能调用 watcher.watch(...)。
use notify::Watcher;

use crate::command_exec::{CancelReason, CommandSource, CommandTicket, SubmitOutcome};
use crate::emit_event;
use crate::error::AppError;
use crate::util::{is_content_uri, shell_escape, validate_local_path, validate_sftp_remote_path};
use crate::AppState;

const MAX_UPLOAD_BYTES: usize = 32 * 1024 * 1024;
const MAX_STREAM_UPLOAD_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES: u64 = 32 * 1024 * 1024;

/// 远端长任务（压缩 / 解压）的显式超时。
/// 解压大文件夹/大压缩包可能远超命令执行默认的 120s（见
/// [`crate::command_exec::ticket::DEFAULT_EXEC_TIMEOUT`]），停留在默认值
/// 会让 UI 在任务中途误报「命令在 120 秒后超时」。与压缩路径共用同一上限。
const REMOTE_TASK_TIMEOUT: Duration = Duration::from_secs(1800);

const SYSOPEN_TEMP_DIR_PREFIX: &str = "marcel-sysopen";
const SYSOPEN_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// 单个 SSH 会话同时「用系统方式打开」的文件数上限。超过则拒绝，
/// 避免本地临时文件过多、SFTP 通道被回传任务挤占、磁盘被打满。
const SYSOPEN_MAX_CONCURRENT_PER_SESSION: usize = 8;
/// 自动回传连续失败上限：达到后停止监视并标记失败，避免无限重试刷日志。
const SYSOPEN_SYNC_MAX_RETRIES: u32 = 5;
/// notify 事件去抖时长：本地文件变化后等此时长再回传，避免编辑器半截写造成脏读。
const SYSOPEN_SYNC_DEBOUNCE: Duration = Duration::from_millis(800);
/// 流式下载/上传 buffer 大小。
const SYSOPEN_BUFFER_BYTES: usize = 131_072;
/// Keep below common 255-byte component limits and leave room for editor temp suffixes.
const SYSOPEN_LOCAL_FILENAME_MAX_BYTES: usize = 240;

fn truncate_utf8(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    &value[..end]
}

fn sanitize_sysopen_component(value: &str, fallback: &str) -> String {
    let sanitized = value
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>();
    let sanitized = sanitized.trim().trim_end_matches(['.', ' ']);
    if sanitized.is_empty() {
        fallback.to_string()
    } else {
        sanitized.to_string()
    }
}

/// Build a local-only sysopen filename while preserving the extension used by
/// the operating system to select an application. The remote path is kept
/// separately and remains the sole upload target.
fn sysopen_local_filename(
    remote_basename: &str,
    connection_name: &str,
) -> Result<String, AppError> {
    let path = Path::new(remote_basename);
    let (stem, extension) = match (
        path.file_stem().and_then(|value| value.to_str()),
        path.extension().and_then(|value| value.to_str()),
    ) {
        (Some(stem), Some(extension)) if !stem.is_empty() => (stem, Some(extension)),
        _ => (remote_basename, None),
    };
    let stem = sanitize_sysopen_component(stem, "file");
    let safe_connection_name = sanitize_sysopen_component(connection_name, "connection");
    let extension_suffix = extension
        .map(|extension| format!(".{}", sanitize_sysopen_component(extension, "file")))
        .unwrap_or_default();
    let fixed_bytes = extension_suffix.len() + 2;
    if fixed_bytes >= SYSOPEN_LOCAL_FILENAME_MAX_BYTES {
        return Err(AppError::Ssh(
            "远端文件扩展名过长，无法创建用于系统打开的本地副本".into(),
        ));
    }
    let connection_budget = (SYSOPEN_LOCAL_FILENAME_MAX_BYTES - fixed_bytes).min(80);
    let safe_connection_name = truncate_utf8(&safe_connection_name, connection_budget);
    let stem_budget = SYSOPEN_LOCAL_FILENAME_MAX_BYTES
        .saturating_sub(extension_suffix.len() + safe_connection_name.len() + 1);
    let stem = truncate_utf8(&stem, stem_budget);

    Ok(format!(
        "{}-{}{}",
        stem, safe_connection_name, extension_suffix
    ))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithSystemResult {
    pub task_id: String,
    pub local_path: String,
    /// true 表示复用了已存在的 sysopen 任务（再次唤起系统应用打开本地副本），
    /// 前端据此移除多余的监视卡片，不重新下载、不重复监视。
    pub reused: bool,
}

/// sysopen 任务阶段。前端据此更新传输中心「下载」与「监视回传」两张卡片的状态与文案，
/// 不复用标准 sftp-*-progress/done 事件（那些会强制覆盖文案为「下载完成/上传完成」，丢失 sysopen 语义）。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
pub enum SysopenPhase {
    /// 下载中：written/total 推送给 download 卡片。
    Downloading { written: u64, total: u64 },
    /// 下载完成，即将调用系统默认应用打开。
    Opened,
    /// 已用系统应用打开，正在监视本地文件变化。
    Monitoring,
    /// 检测到改动，正在回传：written/total 推送给 upload 卡片。
    Syncing { written: u64, total: u64 },
    /// 一次回传完成，继续监视。
    Synced,
    /// 用户取消，已做最终同步（如有改动）。
    Cancelled,
    /// 不可恢复错误（如连续回传失败超限、远程文件被删），已停止监视。
    Failed { message: String },
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SysopenStateEvent {
    pub task_id: String,
    pub download_id: String,
    pub upload_id: String,
    pub phase: SysopenPhase,
}

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
    app: AppHandle,
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
        .command_exec
        .exec_simple(&app, &session_id, &command, CommandSource::SystemTask)
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
    app: AppHandle,
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
        .command_exec
        .exec_simple(&app, &session_id, check_cmd, CommandSource::SystemTask)
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
    // 解压大压缩包可能远超命令执行默认 120s，显式放宽到远端长任务超时
    // （与压缩路径一致），避免中途误报超时。
    let output = state
        .command_exec
        .exec_simple_with_timeout(
            &app,
            &session_id,
            &cmd,
            CommandSource::SystemTask,
            REMOTE_TASK_TIMEOUT,
        )
        .await?;

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
        .command_exec
        .exec_simple(&app, &session_id, check_cmd, CommandSource::SystemTask)
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
            .command_exec
            .exec_simple(&app, &session_id, &check_cmd, CommandSource::SystemTask)
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

    // 经 command_exec 统一管理器执行（30 分钟超时 + 取消注册 + 流式输出，
    // 事件用 task_id 路由）；本函数只映射回旧的 ssh-long-* 事件协议。
    let ticket = CommandTicket::new(&session_id, &cmd, CommandSource::SystemTask)
        .timeout(REMOTE_TASK_TIMEOUT)
        .cancellable(task_id.clone(), "压缩已取消")
        .streaming("ssh-long-output", task_id.clone());

    match state.command_exec.submit(&app, ticket).await {
        SubmitOutcome::Completed { output } => {
            // 检查 OK/FAILED 标记
            if output.lines().any(|line| line.trim() == "OK") {
                emit_event(&app, "ssh-long-done", &json!({ "taskId": &task_id }));
                Ok(())
            } else {
                let trimmed = output.trim();
                let preview: String = trimmed.chars().take(500).collect();
                let preview = if preview.len() < trimmed.len() {
                    format!("{}...", preview)
                } else {
                    preview
                };
                emit_event(
                    &app,
                    "ssh-long-error",
                    &json!({ "taskId": &task_id, "message": preview }),
                );
                Err(AppError::Ssh(format!("压缩失败: {}", preview)))
            }
        }
        SubmitOutcome::TimedOut { .. } => {
            emit_event(
                &app,
                "ssh-long-error",
                &json!({ "taskId": &task_id, "message": "压缩超时（30 分钟）" }),
            );
            Err(AppError::Ssh("压缩超时，文件夹可能过大".into()))
        }
        SubmitOutcome::Cancelled { reason } => match reason {
            CancelReason::User | CancelReason::Agent | CancelReason::Task => {
                emit_event(&app, "ssh-long-cancelled", &json!({ "taskId": &task_id }));
                Err(AppError::Ssh("压缩已取消".into()))
            }
            CancelReason::Disconnected => {
                emit_event(
                    &app,
                    "ssh-long-error",
                    &json!({ "taskId": &task_id, "message": "SSH 连接已断开" }),
                );
                Err(AppError::Ssh("SSH 连接已断开，压缩已中止".into()))
            }
        },
        SubmitOutcome::Failed { error } => {
            emit_event(
                &app,
                "ssh-long-error",
                &json!({ "taskId": &task_id, "message": error.to_string() }),
            );
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn sftp_upload_folder(
    app: AppHandle,
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
    // 解压大文件夹可能远超命令执行默认 120s，显式放宽到远端长任务超时
    // （与压缩路径一致），避免中途误报超时。
    let output = state
        .command_exec
        .exec_simple_with_timeout(
            &app,
            &session_id,
            &exec_cmd,
            CommandSource::SystemTask,
            REMOTE_TASK_TIMEOUT,
        )
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

impl Drop for TransferCancelGuard {
    fn drop(&mut self) {
        self.senders.write().remove(&self.transfer_id);
    }
}

/// content:// URI 的打开模式（Android SAF）。
#[derive(Clone, Copy)]
pub(crate) enum ContentOpenMode {
    /// 只读（上传源）。
    Read,
    /// 写入并截断（下载目标；SAF ACTION_CREATE_DOCUMENT 创建的文档直接覆写）。
    WriteTruncate,
}

/// 通过 tauri-plugin-fs 的 `FsExt::fs().open()` 打开 content:// URI。
/// Android 上底层走 ContentResolver.openAssetFileDescriptor 拿真实 fd，
/// 返回 std::fs::File；这里用 spawn_blocking 包 JNI 往返，再转 tokio File。
pub(crate) async fn open_content_uri_file(
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

fn remote_sidecar_path(path: &str, label: &str) -> Result<String, AppError> {
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

async fn commit_remote_temp_file(
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
        .command_exec
        .exec_simple(&app, &session_id, check_cmd, CommandSource::SystemTask)
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
    // 解压大文件夹可能远超命令执行默认 120s，显式放宽到远端长任务超时
    // （与压缩路径一致），避免上传完成后卡在解压阶段被误报超时。
    let output = state
        .command_exec
        .exec_simple_with_timeout(
            &app,
            &session_id,
            &exec_cmd,
            CommandSource::SystemTask,
            REMOTE_TASK_TIMEOUT,
        )
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
//   - 单 session 并发上限：SYSOPEN_MAX_CONCURRENT_PER_SESSION
//   - 下载阶段即可取消（select! 读 cancel），不再只能等下载完
//   - notify 替代 3s 轮询：保存即感知、低 CPU；事件去抖避免编辑器半截写
//   - 回传走原子 rename + 完整性校验；连续失败超限停止，不再无限重试刷日志
//   - mtime + size 双校验判断脏（FAT 等 mtime 不可靠时 size 兜底）
//   - 任务退出统一收尾：drop watcher、删本地临时文件、清状态表
//   - 用 tauri-plugin-opener 替代已 deprecated 的 shell().open()
// ────────────────────────────────────────────────────────────────────────────

/// 推送一个 sysopen 状态事件给前端。失败仅 warn，不阻断任务。
fn emit_sysopen_state(
    app: &AppHandle,
    task_id: &str,
    download_id: &str,
    upload_id: &str,
    phase: SysopenPhase,
) {
    let event = SysopenStateEvent {
        task_id: task_id.to_string(),
        download_id: download_id.to_string(),
        upload_id: upload_id.to_string(),
        phase,
    };
    match serde_json::to_value(&event) {
        Ok(payload) => emit_event(app, "sftp-sysopen-state", payload),
        Err(e) => log::warn!("[sysopen] 序列化状态事件失败: {}", e),
    }
}

/// 单次回传：本地文件 → 远程 .sysopen-sync 临时文件 → 原子 rename 替换原文件。
/// 返回回传后的 (mtime, size) 签名，用于判断下次是否仍脏。
async fn sysopen_sync_back(
    app: &AppHandle,
    state: &crate::AppState,
    session_id: &str,
    remote_path: &str,
    local_path: &Path,
    task_id: &str,
    download_id: &str,
    upload_id: &str,
) -> Result<(Option<SystemTime>, u64), AppError> {
    let local_meta = tokio::fs::metadata(local_path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取本地文件信息失败: {}", e)))?;
    let total = local_meta.len();
    let mtime = local_meta.modified().ok();

    emit_sysopen_state(
        app,
        task_id,
        download_id,
        upload_id,
        SysopenPhase::Syncing { written: 0, total },
    );

    let sftp = state.ssh_manager.open_sftp(session_id).await?;
    let temp_remote = remote_sidecar_path(remote_path, "sysopen-sync")?;
    let mut remote = sftp
        .open_with_flags(
            &temp_remote,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程临时文件失败: {}", e)))?;
    let mut local = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| AppError::Ssh(format!("打开本地文件失败: {}", e)))?;

    let mut buf = vec![0u8; SYSOPEN_BUFFER_BYTES];
    let mut written: u64 = 0;
    loop {
        let n = local
            .read(&mut buf)
            .await
            .map_err(|e| AppError::Ssh(format!("读取本地文件失败: {}", e)))?;
        if n == 0 {
            break;
        }
        remote
            .write_all(&buf[..n])
            .await
            .map_err(|e| AppError::Ssh(format!("写入远程文件失败: {}", e)))?;
        written += n as u64;
        emit_sysopen_state(
            app,
            task_id,
            download_id,
            upload_id,
            SysopenPhase::Syncing { written, total },
        );
    }
    remote
        .flush()
        .await
        .map_err(|e| AppError::Ssh(format!("刷新远程文件失败: {}", e)))?;
    drop(remote);
    drop(local);

    if written != total {
        // 完整性校验失败：清理远程临时文件
        if let Ok(s) = state.ssh_manager.open_sftp(session_id).await {
            let _ = s.remove_file(&temp_remote).await;
        }
        return Err(AppError::Ssh(format!(
            "回传不完整：预期 {} 字节，实际 {} 字节",
            total, written
        )));
    }

    commit_remote_temp_file(&sftp, &temp_remote, remote_path, true).await?;
    Ok((mtime, total))
}

/// 本地文件是否相对上次同步签名发生了变化（mtime 或 size 任一不同即视为脏）。
/// size 兜底：某些文件系统（FAT）mtime 精度低或不可靠，size 变化也能感知。
async fn sysopen_is_dirty(local_path: &Path, last: &(Option<SystemTime>, u64)) -> bool {
    match tokio::fs::metadata(local_path).await {
        Ok(m) => {
            let mtime = m.modified().ok();
            (mtime, m.len()) != *last
        }
        // 文件暂时不可读（被编辑器独占等），不算脏，避免误触发同步。
        Err(_) => false,
    }
}

/// 任务统一收尾：drop watcher（停止监听）、删本地临时文件、清状态表。
/// 任何退出路径都应调用，确保不残留 watcher / 临时文件 / 去重表项。
async fn sysopen_teardown(
    state: &crate::AppState,
    task_id: &str,
    session_id: &str,
    remote_path: &str,
    local_path: &Path,
    watcher: Option<notify::RecommendedWatcher>,
) {
    drop(watcher);
    let part_path = format!("{}.part", local_path.to_string_lossy());
    let _ = tokio::fs::remove_file(part_path).await;
    let _ = tokio::fs::remove_file(local_path).await;
    if let Some(task_temp_root) = local_path.parent() {
        let _ = tokio::fs::remove_dir(task_temp_root).await;
    }
    state.sysopen_watchers.write().remove(task_id);
    state
        .sysopen_active_paths
        .write()
        .remove(&(session_id.to_string(), remote_path.to_string()));
}

/// sysopen 总控：下载 → 用系统应用打开 → notify 监视 → 改动回传。
/// 任何阶段失败/取消都会 emit 对应 phase 并统一收尾。
async fn run_sysopen_task(
    app: AppHandle,
    state: crate::AppState,
    session_id: String,
    remote_path: String,
    task_id: String,
    download_id: String,
    upload_id: String,
    local_path: PathBuf,
    total: u64,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    // ── 阶段 1：流式下载（cancel 可中断） ──
    let sftp = match state.ssh_manager.open_sftp(&session_id).await {
        Ok(s) => s,
        Err(e) => {
            emit_sysopen_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("打开 SFTP 通道失败: {}", e),
                },
            );
            sysopen_teardown(
                &state,
                &task_id,
                &session_id,
                &remote_path,
                &local_path,
                None,
            )
            .await;
            return;
        }
    };
    let mut remote = match sftp.open_with_flags(&remote_path, OpenFlags::READ).await {
        Ok(f) => f,
        Err(e) => {
            emit_sysopen_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("打开远程文件失败: {}", e),
                },
            );
            sysopen_teardown(
                &state,
                &task_id,
                &session_id,
                &remote_path,
                &local_path,
                None,
            )
            .await;
            return;
        }
    };
    let temp_part = format!("{}.part", local_path.to_string_lossy());
    let mut local = match tokio::fs::File::create(&temp_part).await {
        Ok(f) => f,
        Err(e) => {
            emit_sysopen_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("创建本地临时文件失败: {}", e),
                },
            );
            sysopen_teardown(
                &state,
                &task_id,
                &session_id,
                &remote_path,
                &local_path,
                None,
            )
            .await;
            return;
        }
    };

    let mut buf = vec![0u8; SYSOPEN_BUFFER_BYTES];
    let mut written: u64 = 0;
    let mut cancelled = false;
    loop {
        tokio::select! {
            biased;
            _ = cancel_rx.changed() => {
                cancelled = true;
                break;
            }
            read_res = remote.read(&mut buf) => {
                match read_res {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Err(e) = local.write_all(&buf[..n]).await {
                            emit_sysopen_state(&app, &task_id, &download_id, &upload_id,
                                SysopenPhase::Failed { message: format!("写入本地临时文件失败: {}", e) });
                            let _ = tokio::fs::remove_file(&temp_part).await;
                            sysopen_teardown(&state, &task_id, &session_id, &remote_path, &local_path, None).await;
                            return;
                        }
                        written += n as u64;
                        emit_sysopen_state(&app, &task_id, &download_id, &upload_id,
                            SysopenPhase::Downloading { written, total });
                    }
                    Err(e) => {
                        emit_sysopen_state(&app, &task_id, &download_id, &upload_id,
                            SysopenPhase::Failed { message: format!("读取远程文件失败: {}", e) });
                        let _ = tokio::fs::remove_file(&temp_part).await;
                        sysopen_teardown(&state, &task_id, &session_id, &remote_path, &local_path, None).await;
                        return;
                    }
                }
            }
        }
    }
    let _ = local.flush().await;
    drop(local);
    drop(remote);

    if cancelled {
        let _ = tokio::fs::remove_file(&temp_part).await;
        emit_sysopen_state(
            &app,
            &task_id,
            &download_id,
            &upload_id,
            SysopenPhase::Cancelled,
        );
        sysopen_teardown(
            &state,
            &task_id,
            &session_id,
            &remote_path,
            &local_path,
            None,
        )
        .await;
        return;
    }
    if written != total {
        let _ = tokio::fs::remove_file(&temp_part).await;
        emit_sysopen_state(
            &app,
            &task_id,
            &download_id,
            &upload_id,
            SysopenPhase::Failed {
                message: format!("下载不完整：预期 {} 字节，实际 {} 字节", total, written),
            },
        );
        sysopen_teardown(
            &state,
            &task_id,
            &session_id,
            &remote_path,
            &local_path,
            None,
        )
        .await;
        return;
    }
    if let Err(e) = tokio::fs::rename(&temp_part, &local_path).await {
        emit_sysopen_state(
            &app,
            &task_id,
            &download_id,
            &upload_id,
            SysopenPhase::Failed {
                message: format!("保存临时文件失败: {}", e),
            },
        );
        sysopen_teardown(
            &state,
            &task_id,
            &session_id,
            &remote_path,
            &local_path,
            None,
        )
        .await;
        return;
    }

    // ── 阶段 2：用系统默认应用打开（tauri-plugin-opener） ──
    emit_sysopen_state(
        &app,
        &task_id,
        &download_id,
        &upload_id,
        SysopenPhase::Opened,
    );
    {
        use tauri_plugin_opener::OpenerExt;
        if let Err(e) = app
            .opener()
            .open_path(local_path.to_string_lossy().to_string(), None::<&str>)
        {
            // 打开失败：文件已下载但无法用系统应用打开。停止任务并告知用户。
            emit_sysopen_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("用系统默认应用打开失败: {}", e),
                },
            );
            sysopen_teardown(
                &state,
                &task_id,
                &session_id,
                &remote_path,
                &local_path,
                None,
            )
            .await;
            return;
        }
    }

    // ── 阶段 3：notify 监视本地文件变化 ──
    emit_sysopen_state(
        &app,
        &task_id,
        &download_id,
        &upload_id,
        SysopenPhase::Monitoring,
    );

    let initial_sig = tokio::fs::metadata(&local_path)
        .await
        .ok()
        .and_then(|m| m.modified().ok().map(|t| (Some(t), m.len())))
        .unwrap_or((None, total));

    // notify 回调是同步线程调用，用 mpsc + blocking_send 投递到 tokio 通道。
    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<()>(64);
    let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, _>| {
        if res.is_ok() {
            let _ = notify_tx.blocking_send(());
        }
    }) {
        Ok(w) => w,
        Err(e) => {
            emit_sysopen_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("启动文件监视失败: {}", e),
                },
            );
            sysopen_teardown(
                &state,
                &task_id,
                &session_id,
                &remote_path,
                &local_path,
                None,
            )
            .await;
            return;
        }
    };
    if let Err(e) = watcher.watch(&local_path, notify::RecursiveMode::NonRecursive) {
        emit_sysopen_state(
            &app,
            &task_id,
            &download_id,
            &upload_id,
            SysopenPhase::Failed {
                message: format!("监视文件失败: {}", e),
            },
        );
        sysopen_teardown(
            &state,
            &task_id,
            &session_id,
            &remote_path,
            &local_path,
            None,
        )
        .await;
        return;
    }

    // 监视循环：notify 事件 → 去抖 → 回传；cancel → 最终回传 → 退出。
    let mut last_sig = initial_sig;
    let mut consecutive_failures: u32 = 0;
    let mut pending_sync = false;
    let mut final_phase = SysopenPhase::Synced;

    loop {
        if pending_sync {
            tokio::select! {
                biased;
                _ = cancel_rx.changed() => {
                    // 取消时若仍有未同步改动，做一次最终回传（尽力而为，失败忽略）
                    if sysopen_is_dirty(&local_path, &last_sig).await {
                        let _ = sysopen_sync_back(
                            &app, &state, &session_id, &remote_path, &local_path,
                            &task_id, &download_id, &upload_id,
                        ).await;
                    }
                    final_phase = SysopenPhase::Cancelled;
                    break;
                }
                _ = tokio::time::sleep(SYSOPEN_SYNC_DEBOUNCE) => {
                    pending_sync = false;
                    match sysopen_sync_back(
                        &app, &state, &session_id, &remote_path, &local_path,
                        &task_id, &download_id, &upload_id,
                    ).await {
                        Ok(new_sig) => {
                            last_sig = new_sig;
                            consecutive_failures = 0;
                            emit_sysopen_state(&app, &task_id, &download_id, &upload_id, SysopenPhase::Synced);
                            emit_sysopen_state(&app, &task_id, &download_id, &upload_id, SysopenPhase::Monitoring);
                        }
                        Err(e) => {
                            consecutive_failures += 1;
                            if consecutive_failures >= SYSOPEN_SYNC_MAX_RETRIES {
                                final_phase = SysopenPhase::Failed {
                                    message: format!("连续 {} 次回传失败：{}", consecutive_failures, e),
                                };
                                break;
                            }
                            // 未超限：继续监视，等下次 notify 事件重试。
                            emit_sysopen_state(&app, &task_id, &download_id, &upload_id, SysopenPhase::Monitoring);
                        }
                    }
                }
                _ = notify_rx.recv() => {
                    // 去抖期间又有新变化，保持 pending_sync，重新等满 debounce。
                    continue;
                }
            }
        } else {
            tokio::select! {
                biased;
                _ = cancel_rx.changed() => {
                    if sysopen_is_dirty(&local_path, &last_sig).await {
                        let _ = sysopen_sync_back(
                            &app, &state, &session_id, &remote_path, &local_path,
                            &task_id, &download_id, &upload_id,
                        ).await;
                    }
                    final_phase = SysopenPhase::Cancelled;
                    break;
                }
                _ = notify_rx.recv() => {
                    pending_sync = true;
                }
            }
        }
    }

    emit_sysopen_state(&app, &task_id, &download_id, &upload_id, final_phase);
    sysopen_teardown(
        &state,
        &task_id,
        &session_id,
        &remote_path,
        &local_path,
        Some(watcher),
    )
    .await;
}

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
    let remote_path = validate_sftp_remote_path(&remote_path)?;

    // 文件名合法性（防路径穿越/注入到本地临时目录）
    let remote_basename = Path::new(&remote_path)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|s| s.to_string())
        .ok_or_else(|| AppError::Ssh("无法解析远端文件名".into()))?;
    if remote_basename.contains('/')
        || remote_basename.contains('\\')
        || remote_basename.contains('\0')
        || remote_basename == "."
        || remote_basename == ".."
    {
        return Err(AppError::Ssh("远端文件名包含非法字符".into()));
    }

    // 同名去重：同一 (session, remote_path) 已有 sysopen 任务在跑 → 复用已下载的本地副本，
    // 再次唤起系统应用打开，不重新下载、不重复监视（旧 task 仍在监视改动并自动回传）。
    {
        let existing_task_id = {
            let active = state.sysopen_active_paths.read();
            active
                .get(&(session_id.clone(), remote_path.clone()))
                .cloned()
        };
        if let Some(existing_task_id) = existing_task_id {
            // 从 watchers 取已存在任务的本地路径
            let local_to_reopen = {
                let watchers = state.sysopen_watchers.read();
                watchers.get(&existing_task_id).map(|(_, lp, _)| lp.clone())
            };
            match local_to_reopen {
                Some(lp) => {
                    use tauri_plugin_opener::OpenerExt;
                    if let Err(e) = app
                        .opener()
                        .open_path(lp.to_string_lossy().to_string(), None::<&str>)
                    {
                        return Err(AppError::Ssh(format!("重新打开失败: {}", e)));
                    }
                    return Ok(OpenWithSystemResult {
                        task_id: existing_task_id,
                        local_path: lp.to_string_lossy().to_string(),
                        reused: true,
                    });
                }
                None => {
                    // 异常：active_paths 有记录但 watchers 已无（任务已结束但残留未清）。
                    // 清理残留后继续走完整下载+打开+监视流程。
                    state
                        .sysopen_active_paths
                        .write()
                        .remove(&(session_id.clone(), remote_path.clone()));
                }
            }
        }
    }

    // 单 session 并发上限
    {
        let watchers = state.sysopen_watchers.read();
        let count = watchers
            .iter()
            .filter(|(_, (sid, _, _))| sid.as_str() == session_id.as_str())
            .count();
        if count >= SYSOPEN_MAX_CONCURRENT_PER_SESSION {
            return Err(AppError::Ssh(format!(
                "同时打开的文件过多（上限 {}），请先关闭部分再重试",
                SYSOPEN_MAX_CONCURRENT_PER_SESSION
            )));
        }
    }

    let sftp = state.ssh_manager.open_sftp(&session_id).await?;
    let metadata = sftp
        .metadata(&remote_path)
        .await
        .map_err(|e| AppError::Ssh(format!("读取文件信息失败: {}", e)))?;
    if !metadata.is_regular() {
        return Err(AppError::Ssh("只能打开普通文件".into()));
    }
    let total = metadata.len();
    if total > SYSOPEN_MAX_BYTES {
        return Err(AppError::Ssh(format!(
            "文件过大 ({} MB)，系统打开限制为 {} MB，请使用下载功能",
            total / (1024 * 1024),
            SYSOPEN_MAX_BYTES / (1024 * 1024)
        )));
    }

    // 本地临时目录：app_data/marcel-sysopen/<session_id>/
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Ssh(format!("获取 app_data_dir 失败: {}", e)))?;
    let session_temp_root = app_data.join(SYSOPEN_TEMP_DIR_PREFIX).join(&session_id);
    let task_temp_root = session_temp_root.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&task_temp_root)
        .map_err(|e| AppError::Ssh(format!("创建临时目录失败: {}", e)))?;
    let connection_info = state.ssh_manager.get_connection_info(&session_id).await;
    let connection_id = state.ssh_manager.get_connection_id(&session_id).await;
    let connection_name = if let Some(connection_id) = connection_id {
        let store = state.connection_store.read().await;
        store
            .get_by_id(&connection_id)
            .map(|connection| connection.name.clone())
    } else {
        None
    }
    .filter(|name| !name.trim().is_empty())
    .or_else(|| connection_info.map(|(host, _)| host))
    .unwrap_or_else(|| "connection".to_string());
    let local_filename = sysopen_local_filename(&remote_basename, &connection_name)?;
    let local_path = task_temp_root.join(local_filename);

    // 先注册取消信号 + 活跃路径表，确保 spawn 后立即可被取消/去重
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    state.sysopen_watchers.write().insert(
        task_id.clone(),
        (session_id.clone(), local_path.clone(), cancel_tx),
    );
    state
        .sysopen_active_paths
        .write()
        .insert((session_id.clone(), remote_path.clone()), task_id.clone());

    let result_local_path = local_path.to_string_lossy().to_string();
    let result_task_id = task_id.clone();
    let task_app = app.clone();
    let task_state = state.inner().clone();
    let task_session = session_id.clone();
    let task_remote = remote_path.clone();
    let task_download = download_id.clone();
    let task_upload = upload_id.clone();

    tokio::spawn(async move {
        run_sysopen_task(
            task_app,
            task_state,
            task_session,
            task_remote,
            task_id,
            task_download,
            task_upload,
            local_path,
            total,
            cancel_rx,
        )
        .await;
    });

    Ok(OpenWithSystemResult {
        task_id: result_task_id,
        local_path: result_local_path,
        reused: false,
    })
}

#[tauri::command]
pub async fn sftp_cancel_sysopen(
    state: State<'_, crate::AppState>,
    task_id: String,
) -> Result<(), AppError> {
    // 只发取消信号；状态表由 run_sysopen_task 收尾时清理，避免竞态。
    if let Some((_, _, tx)) = state.sysopen_watchers.read().get(&task_id) {
        let _ = tx.send(true);
    }
    Ok(())
}

/// 会话断开时清理：取消该 session 所有 sysopen 任务 + 删除其临时目录。
/// 由 ssh disconnect 调用。
pub(crate) async fn cleanup_session_sysopen(
    app: &AppHandle,
    state: &crate::AppState,
    session_id: &str,
) {
    // 取消该 session 的所有 watcher（发信号，状态表由各 task 自行收尾）
    let to_cancel: Vec<String> = {
        let watchers = state.sysopen_watchers.read();
        watchers
            .iter()
            .filter(|(_, (sid, _, _))| sid.as_str() == session_id)
            .map(|(id, _)| id.clone())
            .collect()
    };
    for id in to_cancel {
        if let Some((_, _, tx)) = state.sysopen_watchers.write().remove(&id) {
            let _ = tx.send(true);
        }
    }

    // 清理该 session 的活跃路径表项（兜底，防止 task 未及时收尾导致去重表残留）
    {
        let mut active = state.sysopen_active_paths.write();
        let keys_to_remove: Vec<_> = active
            .keys()
            .filter(|(sid, _)| sid.as_str() == session_id)
            .cloned()
            .collect();
        for k in keys_to_remove {
            active.remove(&k);
        }
    }

    // 删除临时目录
    let app_data = match app.path().app_data_dir() {
        Ok(d) => d,
        Err(_) => return,
    };
    let temp_dir = app_data.join(SYSOPEN_TEMP_DIR_PREFIX).join(session_id);
    if temp_dir.exists() {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
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

    #[test]
    fn sysopen_filename_inserts_connection_name_before_extension() {
        assert_eq!(
            sysopen_local_filename("report.pdf", "生产服务器").unwrap(),
            "report-生产服务器.pdf"
        );
        assert_eq!(
            sysopen_local_filename("archive.tar.gz", "prod").unwrap(),
            "archive.tar-prod.gz"
        );
    }

    #[test]
    fn sysopen_filename_supports_extensionless_and_dot_files() {
        assert_eq!(
            sysopen_local_filename("Makefile", "prod").unwrap(),
            "Makefile-prod"
        );
        assert_eq!(sysopen_local_filename(".env", "prod").unwrap(), ".env-prod");
    }

    #[test]
    fn sysopen_filename_sanitizes_connection_name_for_local_filesystem() {
        assert_eq!(
            sysopen_local_filename("report.pdf", " prod/eu:1. ").unwrap(),
            "report-prod_eu_1.pdf"
        );
        assert_eq!(
            sysopen_local_filename("report.pdf", "<>:\"/\\|?*").unwrap(),
            "report-_________.pdf"
        );
    }

    #[test]
    fn sysopen_filename_stays_within_local_component_limit_on_utf8_boundary() {
        let filename = sysopen_local_filename(
            &format!("{}.pdf", "远程文件".repeat(80)),
            &"生产服务器".repeat(30),
        )
        .unwrap();
        assert!(filename.len() <= SYSOPEN_LOCAL_FILENAME_MAX_BYTES);
        assert!(filename.ends_with(".pdf"));
        assert!(filename.contains('-'));
    }

    #[test]
    fn sysopen_filename_sanitizes_remote_name_for_windows() {
        assert_eq!(
            sysopen_local_filename("report:2026?.txt", "prod").unwrap(),
            "report_2026_-prod.txt"
        );
    }

    #[test]
    fn sysopen_filename_rejects_extension_that_cannot_be_preserved() {
        let name = format!("report.{}", "x".repeat(SYSOPEN_LOCAL_FILENAME_MAX_BYTES));
        assert!(sysopen_local_filename(&name, "prod").is_err());
    }
}
