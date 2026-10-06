use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use serde_json::json;
use std::path::Path;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::command_exec::{CancelReason, CommandSource, CommandTicket, SubmitOutcome};
use crate::emit_event;
use crate::error::AppError;
use crate::util::{is_content_uri, shell_escape, validate_local_path, validate_sftp_remote_path};
use crate::AppState;

// 「用系统方式打开」(sysopen) 子系统与文件夹上传引擎整体外迁到 commands/ 下的
// 平级文件；本文件只保留命令薄壳与用户 / Agent 共用的流式传输实现。
// 模块挂在 sftp.rs 之下（#[path] 指向平级文件），commands/mod.rs 无需改动。
#[path = "sftp_folder_upload.rs"]
mod sftp_folder_upload;
#[path = "sftp_sysopen.rs"]
mod sftp_sysopen;

pub use sftp_sysopen::OpenWithSystemResult;
pub(crate) use sftp_sysopen::cleanup_session_sysopen;
use sftp_sysopen::sanitize_sysopen_component;

/// 远端长任务（压缩 / 解压）的显式超时。
/// 解压大文件夹/大压缩包可能远超命令执行默认的 120s（见
/// [`crate::command_exec::ticket::DEFAULT_EXEC_TIMEOUT`]），停留在默认值
/// 会让 UI 在任务中途误报「命令在 120 秒后超时」。与压缩路径共用同一上限。
const REMOTE_TASK_TIMEOUT: Duration = Duration::from_secs(1800);

/// 远端命令的「成功标记」判定：`echo OK` 必须**独占一行**。
///
/// 不能用 `contains("OK")`：命令输出里任何含 "OK" 的路径/文件名（解压冲突时的
/// `CONFLICT: OK.txt`、远端报错里的目录名）都会被误判成成功 —— 解压其实没做，
/// 界面却报完成。压缩 / 解压 / 建目录三条路径统一走这里。
fn command_reported_ok(output: &str) -> bool {
    output.lines().any(|line| line.trim() == "OK")
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
            let child_meta = entry.metadata();
            // 目录项自身是符号链接时按文件删（删链接本身），绝不进链接目标递归：
            // 服务端若在 READDIR 里回跟随后的属性，is_dir() 会为 true，跟着删就会
            // 把链接目标目录里的内容一并删掉。
            let child_is_dir = child_meta.is_dir() && !child_meta.is_symlink();
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
    // 顶层 is_dir 来自前端双击/多选，不受本后端控制：符号链接目录必须先降级成
    // 「删链接本身」，否则递归会走进链接目标。用 LSTAT 判链接（STAT 会跟随）。
    let is_dir = if is_dir {
        match sftp.symlink_metadata(&path).await {
            Ok(meta) if meta.is_symlink() => false,
            _ => true,
        }
    } else {
        false
    };
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
    // 「快速删除」是长周期系统任务（几十万个小文件远超默认 120s，`ticket.rs`
    // 明确点名它必须覆写默认超时），否则 UI 会在删除中途误报超时。
    // 超时只关闭本机 exec 通道、不会杀远端 `rm`，所以文案必须说明服务器
    // 可能仍在继续删除，别让用户以为失败就等于没删。
    let ticket = CommandTicket::new(&session_id, &command, CommandSource::SystemTask)
        .timeout(REMOTE_TASK_TIMEOUT);
    match state.command_exec.submit(&app, ticket).await {
        SubmitOutcome::Completed { .. } => Ok(()),
        SubmitOutcome::TimedOut { .. } => Err(AppError::Ssh(format!(
            "快速删除等待超时（{} 分钟）：本机已停止等待，远端删除可能仍在继续，请稍后刷新确认",
            REMOTE_TASK_TIMEOUT.as_secs() / 60
        ))),
        SubmitOutcome::Cancelled { .. } => Err(AppError::Ssh("快速删除已取消（会话断开）".into())),
        SubmitOutcome::Failed { error } => Err(error),
    }
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

/// 把解压命令的输出翻成给用户的错误文案。
/// - 冲突标记 `CONFLICT: <rel>` 是远端给机器看的，原样拼出来是
///   「解压失败: CONFLICT: foo.txt」，这里翻成可读句；
/// - 其余失败透传远端输出（空输出给个兜底），保留诊断信息；
/// - 本函数不加「解压失败：」前缀，前缀由前端统一加一次。
fn extract_failure_message(output: &str) -> String {
    let trimmed = output.trim();
    if let Some(rel) = trimmed
        .lines()
        .find_map(|line| line.trim().strip_prefix("CONFLICT:"))
    {
        return format!(
            "目标目录已存在同名条目「{}」，已取消解压以免覆盖",
            rel.trim()
        );
    }
    if trimmed.is_empty() {
        "解压命令未返回预期结果".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 按需在文本前加 UTF-8 BOM：读端剥掉 BOM 后用 `hasBom` 单独回传，
/// 写端按参数还原，避免「打开-保存」静默改掉原文件字节。
pub(crate) fn encode_file_content(content: &str, bom: bool) -> Vec<u8> {
    if !bom {
        return content.as_bytes().to_vec();
    }
    let mut bytes = Vec::with_capacity(content.len() + 3);
    bytes.extend_from_slice(b"\xEF\xBB\xBF");
    bytes.extend_from_slice(content.as_bytes());
    bytes
}

pub(crate) fn has_utf8_bom(data: &[u8]) -> bool {
    data.starts_with(b"\xEF\xBB\xBF")
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

    if !command_reported_ok(&output) {
        return Err(AppError::Ssh(extract_failure_message(&output)));
    }

    Ok(())
}

/// 系统目录黑名单：禁止压缩这些目录，防止意外打包整个系统或敏感数据。
/// 本表按「前缀匹配」生效（连同子目录一起挡），适合 /usr、/var/log 这类
/// 整棵子树都不该被单独打包的目录。
/// `/opt` 保持前缀匹配：它是系统级第三方应用安装区，打包其中任意子目录
/// 都属于本次修复不打算放宽的范围（最小修正只补家目录等缺口）。
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

/// 仅精确匹配的黑名单：这些根目录本身被整体打包时是「打包所有人/整个服务数据」的
/// 危险操作，但它们的子目录正是用户日常要压缩的对象（如 /home/user/docs），
/// 前缀匹配会把功能整个挡死，所以只挡根本身。
const SYSTEM_PATH_EXACT_BLACKLIST: &[&str] = &["/home", "/root", "/srv", "/mnt", "/media"];

/// 检查路径是否在系统目录黑名单内（精确匹配或前缀匹配）。
fn is_system_path(path: &str) -> bool {
    let normalized = path.trim_end_matches('/');
    if normalized.is_empty() {
        return true; // 根目录
    }
    if SYSTEM_PATH_EXACT_BLACKLIST.contains(&normalized) {
        return true;
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
        SubmitOutcome::Completed { output, .. } => {
            // 检查 OK/FAILED 标记（整行匹配，判据只有 `command_reported_ok` 一处）
            if command_reported_ok(&output) {
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
            CancelReason::User
            | CancelReason::Agent
            | CancelReason::Task
            | CancelReason::RuntimeRestart => {
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    pub content: String,
    pub mtime: u64,
    /// 原文件是否带 UTF-8 BOM。读时 BOM 被剥掉（编辑器不该显示它），
    /// 保存时必须原样写回，否则一次「打开-保存」就会静默改掉文件头字节。
    pub has_bom: bool,
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
    let has_bom = has_utf8_bom(&data);
    let bytes = if has_bom { &data[3..] } else { &data[..] };

    let content = String::from_utf8(bytes.to_vec())
        .map_err(|_| AppError::Ssh("无法解码文件，可能为二进制文件或使用了不支持的编码".into()))?;

    Ok(ReadFileResult {
        content,
        mtime,
        has_bom,
    })
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
    bom: Option<bool>,
) -> Result<(), AppError> {
    let path = validate_sftp_remote_path(&path)?;
    let sftp = state.ssh_manager.open_sftp(&session_id).await?;
    let temp_path = remote_sidecar_path(&path, "edit")?;

    // BOM 属于原文件字节的一部分：读端剥掉后由 `ReadFileResult.hasBom` 单独
    // 回传，写端据 `bom` 参数写回，缺省 false 即旧行为（不带 BOM）。
    let data = encode_file_content(&content, bom.unwrap_or(false));

    let mut file = sftp
        .open_with_flags(
            &temp_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {}", e)))?;

    if let Err(e) = tokio::io::AsyncWriteExt::write_all(&mut file, &data).await {
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

/// 进度事件节流阈值：距上次推送至少 100ms、或新增至少 1MB 才再推一次。
/// 一次 2GB 的传输按 128KB 一次会推 ~1.6 万次事件、每次都写前端 store；节流只影响
/// 中间进度，完成 / 失败 / 取消的收尾事件照旧发送，终态不会漏。
const PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(100);
const PROGRESS_MIN_BYTES: u64 = 1024 * 1024;

/// 节流判定（拆成纯函数便于测试）：间隔够久或新增字节够多才该发。
fn progress_due(elapsed: Duration, last_written: u64, written: u64) -> bool {
    elapsed >= PROGRESS_MIN_INTERVAL || written.saturating_sub(last_written) >= PROGRESS_MIN_BYTES
}

/// 单个传输实例的进度节流器：第一次调用立即放行（进度条马上出现），
/// 之后按 [`progress_due`] 判定。
struct ProgressThrottle {
    last_emit: std::time::Instant,
    last_written: u64,
    emitted: bool,
}

impl ProgressThrottle {
    fn new() -> Self {
        Self {
            last_emit: std::time::Instant::now(),
            last_written: 0,
            emitted: false,
        }
    }

    fn should_emit(&mut self, written: u64) -> bool {
        let now = std::time::Instant::now();
        let due = progress_due(
            now.duration_since(self.last_emit),
            self.last_written,
            written,
        );
        if !self.emitted || due {
            self.emitted = true;
            self.last_emit = now;
            self.last_written = written;
            true
        } else {
            false
        }
    }
}

/// 远程 → 本地文件的分块拷贝循环（含取消、进度事件、结尾 flush）。
/// 返回实际写入字节数；上层负责对目标文件做失败清理。
/// `pub(crate)`：Agent 传输工具（下载）复用同一流式实现。
pub(crate) async fn stream_remote_to_local_file(
    app: &AppHandle,
    remote: &mut russh_sftp::client::fs::File,
    local: &mut tokio::fs::File,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    download_id: &str,
    total: u64,
) -> Result<u64, AppError> {
    let mut buf = vec![0u8; 131072];
    let mut written: u64 = 0;
    let mut throttle = ProgressThrottle::new();

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

        // 增长检测：实际写入一旦超过下载开始时的大小，说明源文件正在被
        // 程序写入/追加（如活跃日志）。若继续读会一路追着增长的 EOF 下载
        // 下去且无法收敛，故在此立即停止。检查放在进度事件之前，避免 UI
        // 闪现超 100% 的进度。
        if written > total {
            return Err(AppError::Ssh(format!(
                "下载后大小与预期不一致：预期 {} 字节，实际写入 {} 字节，可能有程序正在更改此文件",
                total, written
            )));
        }

        if throttle.should_emit(written) {
            emit_event(
                app,
                "sftp-download-progress",
                json!({ "downloadId": download_id, "written": written, "total": total }),
            );
        }
    }

    tokio::select! {
        result = local.flush() => {
            result.map_err(|e| AppError::Ssh(format!("刷新本地文件失败: {}", e)))?;
        }
        _ = cancel_rx.changed() => return Err(AppError::Ssh("下载已取消".into())),
    }

    // 落盘：.part 接着要被 rename 成目标文件，先把数据 sync 到磁盘，
    // 避免断电/崩溃后在目标路径留下「文件在但内容空/半截」的假象
    // （content:// 路径同样需要这道保险）。
    tokio::select! {
        result = local.sync_all() => {
            result.map_err(|e| AppError::Ssh(format!("同步本地文件失败: {}", e)))?;
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

    // 注册取消通道；guard 随本函数存活，函数返回即自动注销（原来靠
    // TransferCancelGuard 手写这件事，现在由 Registration 在 Drop 里做）。
    let _cancel_registration = state.download_cancel.register(&download_id);
    let mut cancel_rx = _cancel_registration.receiver();

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

        // 下载完整性收尾校验：写入少于下载开始时的大小才是中途真的断了
        // （增长场景已在循环内拦截并报错，不会走到这里）。
        if written < total {
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

    // 普通路径：流式下载逻辑与 Agent 传输工具共用同一实现
    // （stream_download_single_file，含 .part/.backup + 取消 + 完整性 + done 事件）。
    stream_download_single_file(
        &app,
        &mut remote,
        total,
        &local_path,
        &download_id,
        &mut cancel_rx,
        true,
    )
    .await
}

/// 清掉同一目标路径的历史 `.marcel-download-*.part` / `.backup` 残留。
/// 下载 id 每次唯一，进程被杀（或崩溃）后这些文件再无人认领，会永久占盘；
/// 新传输开始时顺手扫掉同目标、同命名模式的残留即可（只匹配本应用生成的
/// 名字，绝不碰目标文件本身）。同一目标的并发下载本来就会互相覆盖目标文件，
/// 这里不做额外保护。
async fn cleanup_stale_download_temp_files(local_path: &str, current_id: &str) {
    let target = Path::new(local_path);
    let (Some(parent), Some(file_name)) =
        (target.parent(), target.file_name().and_then(|n| n.to_str()))
    else {
        return;
    };
    let prefix = format!("{}.marcel-download-", file_name);
    let current_prefix = format!("{}.marcel-download-{}.", file_name, current_id);

    let Ok(mut entries) = tokio::fs::read_dir(parent).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(&prefix) || name.starts_with(&current_prefix) {
            continue;
        }
        let rest = &name[prefix.len()..];
        if !(rest.ends_with(".part") || rest.ends_with(".backup")) {
            continue;
        }
        let _ = tokio::fs::remove_file(entry.path()).await;
    }
}

/// 单文件流式下载的**共享实现**：远端 → 本地 .part 临时文件 → 原子替换。
/// 用户 SFTP 面板（sftp_download_stream）与 Agent 传输工具共用，避免两套实现。
///
/// 事件协议：进度发 `sftp-download-progress{downloadId,written,total}`，完成发
/// `sftp-download-done{downloadId}`——`download_id` 由调用方给定（Agent 用
/// `agent-transfer-*` 前缀即可复用前端传输中心的监听与取消按钮）。
/// 取消：`cancel_rx` 被置位即中止并清理 .part；调用方负责把 sender 注册进
/// `AppState::download_cancel`（前端 `sftp_cancel_download` 按 id 触发）。
pub(crate) async fn stream_download_single_file(
    app: &AppHandle,
    remote: &mut russh_sftp::client::fs::File,
    total: u64,
    local_path: &str,
    download_id: &str,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
    allow_replace: bool,
) -> Result<(), AppError> {
    let temp_local_path = format!("{}.marcel-download-{}.part", local_path, download_id);
    let backup_local_path = format!("{}.marcel-download-{}.backup", local_path, download_id);

    cleanup_stale_download_temp_files(local_path, download_id).await;

    let mut local = tokio::fs::File::create(&temp_local_path)
        .await
        .map_err(|e| AppError::Ssh(format!("创建本地文件失败: {}", e)))?;

    let result =
        stream_remote_to_local_file(app, remote, &mut local, cancel_rx, download_id, total).await;

    let written = match result {
        Ok(written) => written,
        Err(e) => {
            let _ = tokio::fs::remove_file(&temp_local_path).await;
            return Err(e);
        }
    };

    // 下载完整性收尾校验：写入少于下载开始时的大小才是中途真的断了
    // （增长场景已在循环内拦截并报错，不会走到这里）。
    if written < total {
        let _ = tokio::fs::remove_file(&temp_local_path).await;
        return Err(AppError::Ssh(format!(
            "下载不完整：预期 {} 字节，实际写入 {} 字节",
            total, written
        )));
    }

    if let Err(e) = check_cancelled(cancel_rx, "下载已取消") {
        let _ = tokio::fs::remove_file(&temp_local_path).await;
        return Err(e);
    }

    let had_existing = match tokio::fs::metadata(local_path).await {
        Ok(meta) => {
            if meta.is_dir() {
                let _ = tokio::fs::remove_file(&temp_local_path).await;
                return Err(AppError::Ssh("保存路径已存在同名目录".into()));
            }
            if !allow_replace {
                let _ = tokio::fs::remove_file(&temp_local_path).await;
                return Err(AppError::Ssh("本地文件已存在（未允许覆盖）".into()));
            }
            true
        }
        Err(_) => false,
    };

    if had_existing {
        let _ = tokio::fs::remove_file(&backup_local_path).await;
        if let Err(e) = tokio::fs::rename(local_path, &backup_local_path).await {
            let _ = tokio::fs::remove_file(&temp_local_path).await;
            return Err(AppError::Ssh(format!("备份已有文件失败: {}", e)));
        }
    }

    if let Err(e) = tokio::fs::rename(&temp_local_path, local_path).await {
        if had_existing {
            // 「备份 → 替换」之间失败：目标此刻是空的，恢复失败就等于把用户
            // 原文件藏进了 .backup。重试一次（重命名失败常常是瞬时占用），
            // 仍失败就把备份路径写进错误文案，并保留备份文件不删。
            let mut restored = tokio::fs::rename(&backup_local_path, local_path)
                .await
                .is_ok();
            if !restored {
                restored = tokio::fs::rename(&backup_local_path, local_path)
                    .await
                    .is_ok();
            }
            if !restored {
                let _ = tokio::fs::remove_file(&temp_local_path).await;
                return Err(AppError::Ssh(format!(
                    "保存下载文件失败: {}；原文件已备份到 {}，请手动改回原文件名",
                    e, backup_local_path
                )));
            }
        }
        let _ = tokio::fs::remove_file(&temp_local_path).await;
        return Err(AppError::Ssh(format!("保存下载文件失败: {}", e)));
    }

    if had_existing {
        let _ = tokio::fs::remove_file(&backup_local_path).await;
    }

    emit_event(
        app,
        "sftp-download-done",
        json!({ "downloadId": download_id }),
    );

    Ok(())
}

#[tauri::command]
pub async fn sftp_cancel_upload(
    state: State<'_, AppState>,
    upload_id: String,
) -> Result<(), AppError> {
    state.upload_cancel.cancel(&upload_id);
    Ok(())
}

#[tauri::command]
pub async fn sftp_cancel_download(
    state: State<'_, AppState>,
    download_id: String,
) -> Result<(), AppError> {
    state.download_cancel.cancel(&download_id);
    Ok(())
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

/// 取消检查：watch 已被置位则返回取消错误。
/// `pub(crate)`：Agent 传输工具（agent/tools/sftp_transfer.rs）复用统一取消协议。
pub(crate) fn check_cancelled(
    cancel_rx: &tokio::sync::watch::Receiver<bool>,
    message: &str,
) -> Result<(), AppError> {
    if *cancel_rx.borrow() {
        Err(AppError::Ssh(message.into()))
    } else {
        Ok(())
    }
}

/// 为远程路径生成隐藏 sidecar 临时路径（同目录，`.name.marcel-{label}-{uuid}`）。
/// `pub(crate)`：Agent 传输工具复用（上传/下载走临时文件 + 原子提交）。
pub(crate) fn remote_sidecar_path(path: &str, label: &str) -> Result<String, AppError> {
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

/// 解析提交目标：目标是符号链接时返回链接指向的真实文件路径，
/// 让提交「写穿」链接（与 shell 里 `> link` 语义一致），而不是用普通文件
/// 把链接替换掉。相对链接目标按链接所在目录解析；悬空链接（canonicalize
/// 失败）退化为手工解析，因为用户的本意就是让那个路径出现文件。
async fn resolve_commit_target(
    sftp: &russh_sftp::client::SftpSession,
    target_path: &str,
) -> Result<String, AppError> {
    let mut current = target_path.to_string();
    // 上限 8 层：REALPATH 通常一次就解完，手工解析一次一层，防御链接环路。
    for _ in 0..8 {
        match sftp.symlink_metadata(&current).await {
            Ok(meta) if meta.is_symlink() => {
                if let Ok(real) = sftp.canonicalize(&current).await {
                    current = real;
                    continue;
                }
                let link = sftp
                    .read_link(&current)
                    .await
                    .map_err(|e| AppError::Ssh(format!("解析符号链接失败: {}", e)))?;
                current = if link.starts_with('/') {
                    link
                } else {
                    match current.rfind('/') {
                        Some(0) => format!("/{}", link),
                        Some(idx) => format!("{}/{}", &current[..idx], link),
                        None => link,
                    }
                };
            }
            _ => break,
        }
    }
    Ok(current)
}

/// 提交后还原目标原有权限位：rename 不继承被覆盖 inode 的 mode（sidecar 是
/// 新建文件，服务器按 umask 给 0644），不还原就会把 0600 的 .env / 脚本、
/// 0755 的可执行文件悄悄放宽或改窄。失败只告警——数据已经提交成功，
/// 这时报错会让调用方误以为没写进去。
async fn restore_remote_permissions(
    sftp: &russh_sftp::client::SftpSession,
    target_path: &str,
    mode: Option<u32>,
) {
    let Some(mode) = mode else {
        return;
    };
    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
    // 只带 MODE 位（不含文件类型位），SETSTAT 只改权限，不动大小/时间。
    attrs.permissions = Some(mode & 0o7777);
    if let Err(e) = sftp.set_metadata(target_path, attrs).await {
        log::warn!(
            "[sftp] 还原远程文件权限位失败 {} (mode={:o}): {}",
            target_path,
            mode & 0o7777,
            e
        );
    }
}

/// 把临时远端文件原子提交到目标路径（可覆盖或拒绝覆盖已有）。
/// `pub(crate)`：Agent 传输工具复用（上传走临时文件 + 原子提交）。
pub(crate) async fn commit_remote_temp_file(
    sftp: &russh_sftp::client::SftpSession,
    temp_path: &str,
    target_path: &str,
    allow_replace: bool,
) -> Result<(), AppError> {
    let target = resolve_commit_target(sftp, target_path).await?;

    let existing = sftp.metadata(&target).await.ok();
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
    let preserve_mode = existing.as_ref().and_then(|meta| meta.permissions);

    if existing.is_none() {
        // 目标原先不存在：无权限位可还原；提交失败也要删 sidecar
        //（其余失败路径都删，这里曾漏掉导致失败后残留隐藏临时文件）。
        return match sftp.rename(temp_path, &target).await {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = sftp.remove_file(temp_path).await;
                Err(AppError::Ssh(format!("提交远程文件失败: {}", e)))
            }
        };
    }

    let backup_path = remote_sidecar_path(&target, "backup")?;
    if let Err(e) = sftp.rename(&target, &backup_path).await {
        let _ = sftp.remove_file(temp_path).await;
        return Err(AppError::Ssh(format!("备份远程文件失败: {}", e)));
    }

    if let Err(e) = sftp.rename(temp_path, &target).await {
        let _ = sftp.rename(&backup_path, &target).await;
        let _ = sftp.remove_file(temp_path).await;
        return Err(AppError::Ssh(format!("提交远程文件失败: {}", e)));
    }

    let _ = sftp.remove_file(&backup_path).await;
    restore_remote_permissions(sftp, &target, preserve_mode).await;
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

    let _cancel_registration = state.upload_cancel.register(&upload_id);
    let mut cancel_rx = _cancel_registration.receiver();

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

    // 不设体积上限：与大文件下载对齐，能传多大由磁盘和源文件决定。

    // 普通路径：流式上传逻辑与 Agent 传输工具共用同一实现
    // （stream_upload_single_file，含 sidecar + 取消 + 完整性校验 + done 事件）。
    stream_upload_single_file(
        &app,
        &sftp,
        &mut local_file,
        total,
        size_known,
        &remote_path,
        &upload_id,
        &mut cancel_rx,
    )
    .await
}

/// 单文件流式上传的**共享实现**：本地文件 → 远端 sidecar 临时文件 → 原子提交。
/// 用户 SFTP 面板（sftp_upload_stream）与 Agent 传输工具共用，避免两套实现。
///
/// 事件协议：进度发 `sftp-upload-progress{uploadId,written,total}`，完成发
/// `sftp-upload-done{uploadId}`——`upload_id` 由调用方给定（Agent 用
/// `agent-transfer-*` 前缀即可复用前端传输中心的监听与取消按钮）。
/// 取消：`cancel_rx` 被置位即中止并清理 sidecar（调用方负责把 sender 注册进
/// `AppState::upload_cancel`，前端 `sftp_cancel_upload` 按 id 触发）。
pub(crate) async fn stream_upload_single_file(
    app: &AppHandle,
    sftp: &russh_sftp::client::SftpSession,
    local_file: &mut tokio::fs::File,
    total: u64,
    size_known: bool,
    remote_path: &str,
    upload_id: &str,
    cancel_rx: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<(), AppError> {
    let temp_remote_path = remote_sidecar_path(remote_path, "upload")?;

    let mut remote_file = sftp
        .open_with_flags(
            &temp_remote_path,
            OpenFlags::CREATE | OpenFlags::TRUNCATE | OpenFlags::WRITE,
        )
        .await
        .map_err(|e| AppError::Ssh(format!("打开远程文件失败: {}", e)))?;

    let mut buf = vec![0u8; 131072];
    let mut written: u64 = 0;
    let mut throttle = ProgressThrottle::new();

    let result: Result<(), AppError> = async {
        loop {
            check_cancelled(cancel_rx, "上传已取消")?;

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

            // 增长检测（与下载侧同构）：实际读取一旦超过开始时的 stat 大小，
            // 说明本地文件正被程序追加（如活跃日志）。继续读会一路追着增长的
            // EOF 上传、进度字节数超过 total，最后报一句无意义的「上传不完整」。
            // 检查放在进度事件之前，避免 UI 闪现超 100% 的进度。
            // size_known=false（如 content:// 的 pipe provider）时 total 不可信，跳过。
            if size_known && written > total {
                return Err(AppError::Ssh(format!(
                    "上传后大小与预期不一致：预期 {} 字节，实际 {} 字节，可能有程序正在更改此文件",
                    total, written
                )));
            }

            if throttle.should_emit(written) {
                emit_event(
                    app,
                    "sftp-upload-progress",
                    json!({ "uploadId": upload_id, "written": written, "total": total }),
                );
            }
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

    if let Err(e) = check_cancelled(cancel_rx, "上传已取消") {
        let _ = sftp.remove_file(&temp_remote_path).await;
        return Err(e);
    }
    commit_remote_temp_file(sftp, &temp_remote_path, remote_path, false).await?;

    emit_event(app, "sftp-upload-done", json!({ "uploadId": upload_id }));

    Ok(())
}

/// 文件夹上传命令薄壳：引擎与编排见 [`sftp_folder_upload`]（整体外迁）。
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
    sftp_folder_upload::upload_folder_stream(
        app,
        state.inner(),
        session_id,
        local_path,
        remote_path,
        upload_id,
        flat,
    )
    .await
}

/// 递归复制本地目录（拖拽上传的暂存复制）。
///
/// 注意：`commands/plugin_install.rs` 里有一个**同名但不同语义**的实现
/// （`std::io::Result<()>` 版本），两者存在实质差异，不能盲目合并去重：
/// - 本实现跳过符号链接、只复制普通文件——拖拽的目录里可能有指向任意位置的
///   链接，顺藤摸瓜复制会拖进无关内容甚至敏感数据；
/// - plugin_install 版本不跳链接（`fs::copy` 跟随复制内容），服务于解压后的
///   插件目录跨卷 rename 失败时的回退复制。
///
/// 改任何一边之前先确认另一边的场景是否适用。
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

/// 取 AppError 的「人话」部分：`thiserror` 的 Display 会带 `SSH error: ` 之类
/// 前缀，拼进给用户看的 failures 列表里是噪声，这里只取内层文案。
fn error_text(err: &AppError) -> String {
    match err {
        AppError::Ssh(message)
        | AppError::Agent(message)
        | AppError::Llm(message)
        | AppError::Config(message)
        | AppError::Update(message)
        | AppError::Network(message)
        | AppError::Cancelled(message)
        | AppError::Other(message) => message.clone(),
        AppError::Sftp { message, .. } => message.clone(),
        AppError::KeyAuth { message, .. } => message.clone(),
        other => other.to_string(),
    }
}

/// 拖拽上传的准备结果。复制失败的文件通过 `failures`（"路径: 原因"）显式回传，
/// 前端必须展示出来——原来只 `log::warn` 就返回临时目录，用户看到的是
/// 「上传完成」，但少了的文件无人知晓。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DragUploadPrepare {
    pub temp_dir: String,
    pub failures: Vec<String>,
}

#[tauri::command]
pub async fn sftp_prepare_drag_upload(
    file_paths: Vec<String>,
) -> Result<DragUploadPrepare, AppError> {
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
                errors.push(format!("{}: {}", path_str, error_text(&e)));
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
            errors.push(format!("{}: {}", path_str, error_text(&e)));
        }
    }

    if !errors.is_empty() {
        log::warn!("拖拽上传部分文件复制失败: {:?}", errors);
    }

    Ok(DragUploadPrepare {
        temp_dir: temp_dir.to_string_lossy().to_string(),
        failures: errors,
    })
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

    // 远端 basename 不能直接 join 本地临时目录：Linux 合法的 `s:1.png`、`a|b.png`
    // 在 Windows 上是非法/会被解释成 NTFS 数据流的名字，可能把文件落到目录之外。
    // 复用 sysopen 的同一套 sanitize（保留扩展名，便于 WebView 判断类型）。
    let safe_basename = sanitize_sysopen_component(&remote_basename, "preview");
    let local_path = temp_dir.join(&safe_basename);
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

        // 增长检测：实际写入一旦超过下载开始时的大小，说明源文件正在被
        // 程序写入/追加，立即停止（否则会一路追着增长的 EOF 下不完）。
        // 检查放在进度事件之前，避免 UI 闪现超 100% 的进度。
        if written > total {
            let _ = tokio::fs::remove_file(&temp_part_path).await;
            return Err(AppError::Ssh(format!(
                "下载后大小与预期不一致：预期 {} 字节，实际 {} 字节，可能有程序正在更改此文件",
                total, written
            )));
        }

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

    // 下载完整性收尾校验：写入少于下载开始时的大小才是中途真的断了
    // （增长场景已在循环内拦截并报错，不会走到这里）。
    if written < total {
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

/// 「用系统方式打开」：命令薄壳，实现整体外迁见 [`sftp_sysopen`]（签名、参数、
/// 错误与 `sftp-sysopen-state` 事件协议全部不变）。
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
    sftp_sysopen::open_with_system(
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

/// 取消 sysopen 任务：命令薄壳（只发取消信号，实现见 [`sftp_sysopen`]）。
#[tauri::command]
pub async fn sftp_cancel_sysopen(
    state: State<'_, crate::AppState>,
    task_id: String,
) -> Result<(), AppError> {
    sftp_sysopen::cancel_sysopen(state.inner(), &task_id).await
}

#[cfg(test)]
mod tests {
    use super::{
        cleanup_stale_download_temp_files, encode_file_content, error_text,
        extract_failure_message, has_utf8_bom, is_system_path, progress_due, AppError, Duration,
        Path, MAX_PREVIEW_IMAGE_BYTES, PREVIEW_TEMP_DIR_PREFIX, PROGRESS_MIN_BYTES,
        PROGRESS_MIN_INTERVAL,
    };

    #[test]
    fn throttles_progress_until_interval_or_bytes_are_reached() {
        // 未满 100ms 且新增不足 1MB：不推
        assert!(!progress_due(
            Duration::from_millis(99),
            0,
            PROGRESS_MIN_BYTES - 1
        ));
        // 新增满 1MB：推（哪怕只有 1ms）
        assert!(progress_due(
            Duration::from_millis(1),
            0,
            PROGRESS_MIN_BYTES
        ));
        // 距上次满 100ms：推（哪怕只新增 1 字节）
        assert!(progress_due(PROGRESS_MIN_INTERVAL, 1024, 1025));
        // 第二次起 written 单调递增，saturating_sub 不会溢出
        assert!(!progress_due(
            Duration::from_millis(0),
            PROGRESS_MIN_BYTES,
            PROGRESS_MIN_BYTES - 1
        ));
    }

    #[test]
    fn system_path_blacklist_blocks_home_roots_but_not_their_children() {
        // 新增的精确匹配：根本身禁止整体打包
        for path in ["/home", "/home/", "/root", "/srv", "/mnt", "/media"] {
            assert!(is_system_path(path), "应拦截: {}", path);
        }
        // 子目录是用户日常压缩对象，必须放行
        for path in [
            "/home/user/docs",
            "/root/backup",
            "/srv/app/data",
            "/mnt/disk1/photos",
        ] {
            assert!(!is_system_path(path), "应放行: {}", path);
        }
        // 原有前缀匹配保持
        assert!(is_system_path("/etc"));
        assert!(is_system_path("/etc/nginx"));
        assert!(is_system_path("/opt/app"));
        assert!(is_system_path("/"));
        assert!(is_system_path("///"));
    }

    #[test]
    fn extract_conflict_marker_becomes_readable_sentence() {
        let message = extract_failure_message("CONFLICT: foo.txt\n");
        assert_eq!(
            message,
            "目标目录已存在同名条目「foo.txt」，已取消解压以免覆盖"
        );
        // 前缀由前端统一加：后端文案里不许再出现「解压失败」
        assert!(!message.contains("解压失败"));
        // 其他失败原样透传（保留远端诊断），空输出给兜底
        assert_eq!(extract_failure_message("booom\n"), "booom");
        assert_eq!(extract_failure_message("  \n"), "解压命令未返回预期结果");
    }

    #[test]
    fn bom_is_preserved_through_encode_and_detect() {
        let with_bom = encode_file_content("你好", true);
        assert!(has_utf8_bom(&with_bom));
        assert_eq!(with_bom.len(), 3 + "你好".len());
        let without_bom = encode_file_content("你好", false);
        assert!(!has_utf8_bom(&without_bom));
        assert_eq!(without_bom, "你好".as_bytes());
    }

    #[test]
    fn drag_upload_error_text_drops_enum_prefix() {
        assert_eq!(
            error_text(&AppError::Ssh("文件不存在".into())),
            "文件不存在"
        );
        assert_eq!(
            error_text(&AppError::Sftp {
                message: "权限不足".into(),
                code: 3
            }),
            "权限不足"
        );
    }

    #[tokio::test]
    async fn clears_only_stale_download_temp_files_of_same_target() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("data.bin");
        std::fs::write(&target, b"keep").unwrap();
        let stale_part = format!("{}.marcel-download-old-id.part", target.display());
        let stale_backup = format!("{}.marcel-download-old-id.backup", target.display());
        let other = dir.path().join("other.bin.marcel-download-old-id.part");
        std::fs::write(&stale_part, b"half").unwrap();
        std::fs::write(&stale_backup, b"old").unwrap();
        std::fs::write(&other, b"other").unwrap();

        cleanup_stale_download_temp_files(&target.to_string_lossy(), "new-id").await;

        assert!(
            !Path::new(&stale_part).exists(),
            "同目标 .part 残留应被清理"
        );
        assert!(
            !Path::new(&stale_backup).exists(),
            "同目标 .backup 残留应被清理"
        );
        assert!(other.exists(), "别的目标的残留不属于本次清理范围");
        assert!(target.exists(), "目标文件本身绝不能动");
    }

    #[test]
    fn preview_image_size_limit_is_50mb() {
        assert_eq!(MAX_PREVIEW_IMAGE_BYTES, 50 * 1024 * 1024);
    }

    #[test]
    fn preview_temp_dir_prefix_is_stable() {
        assert_eq!(PREVIEW_TEMP_DIR_PREFIX, "marcel-previews");
    }
}
