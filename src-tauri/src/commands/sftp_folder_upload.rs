//! 文件夹上传引擎 —— 自 `commands/sftp.rs` 整体外迁。
//!
//! 本地目录收集条目 → 打包 zip（可取消、带进度）→ 流式上传到远端 /tmp →
//! 远端 unzip 解压。阶段进度经 `sftp-folder-upload-status` 事件推送，
//! 字节进度复用 `sftp-upload-progress`，完成复用 `sftp-upload-done`。

use russh_sftp::protocol::OpenFlags;
use serde_json::json;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::command_exec::CommandSource;
use crate::emit_event;
use crate::error::AppError;
use crate::util::{shell_escape, validate_local_path, validate_sftp_remote_path};

use super::{
    check_cancelled, command_reported_ok, extract_failure_message, ProgressThrottle,
    REMOTE_TASK_TIMEOUT,
};

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

/// 文件夹上传编排（`sftp_upload_folder_stream` 命令的实现主体，薄壳留在
/// sftp.rs，签名与错误不变）：校验 → 冲突预检 → 空目录特判 → zip 打包
/// （spawn_blocking，取消经 watch→AtomicBool 桥接）→ 流式上传 → 远端解压，
/// 收尾每条出口都删远端临时压缩包。
pub(super) async fn upload_folder_stream(
    app: AppHandle,
    state: &crate::AppState,
    session_id: String,
    local_path: String,
    remote_path: String,
    upload_id: String,
    flat: bool,
) -> Result<(), AppError> {
    let local_path = validate_local_path(&local_path)?;
    let remote_path = validate_sftp_remote_path(&remote_path)?;

    let _cancel_registration = state.upload_cancel.register(&upload_id);
    let mut cancel_rx = _cancel_registration.receiver();

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

    // 空文件夹特判：zip 对空目录只能写出 22 字节的空归档，远端 unzip 大概率
    // 非 0 退出，整条 `&&` 链当场断掉——连目标目录都不会建（用户看到「上传失败」
    // 却也不知道其实什么都没传）。这里直接跳过 zip / 上传 / 解压：
    // 非 flat 模式只需在远端建出这个空目录；flat 模式目标目录已存在，无事可做。
    if collect_local_top_level_names(local)?.is_empty() {
        if !flat {
            // 用 OK 标记判定成功：exec_simple 对非零退出码也返回 Ok(output)，
            // 只看是否 Err 会把「权限不足」当成功。
            let cmd = format!("mkdir -p {} && echo OK", shell_escape(&remote_path));
            let output = state
                .command_exec
                .exec_simple(&app, &session_id, &cmd, CommandSource::SystemTask)
                .await?;
            if !command_reported_ok(&output) {
                return Err(AppError::Ssh(format!(
                    "创建远端目录失败: {}",
                    output.trim()
                )));
            }
        }
        emit_event(&app, "sftp-upload-done", json!({ "uploadId": &upload_id }));
        return Ok(());
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

    // 打包体积同样不设上限（压缩包大小由目录内容决定，超限与否不再由本机判定）。
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
    // 同一套进度节流：这段循环每个 chunk 会发两条事件（进度 + 阶段状态），
    // 一个 2GB 的包按 128KB 切是 3 万多次事件，全打给前端 store。
    let mut throttle = ProgressThrottle::new();

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

            if !throttle.should_emit(written) {
                continue;
            }

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

    // 收尾：上传之后的每条出口（上传失败/取消、字节数不符、解压失败、超时、
    // 成功）都必须删掉远端临时压缩包。原实现只在「上传失败」时删，成功或
    // 解压失败都会把整包 zip 永远留在 /tmp。
    let outcome: Result<(), AppError> = async {
        if upload_result.is_err() {
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

        if !command_reported_ok(&output) {
            return Err(AppError::Ssh(extract_failure_message(&output)));
        }

        emit_event(&app, "sftp-upload-done", json!({ "uploadId": &upload_id }));

        Ok(())
    }
    .await;

    if let Ok(sftp) = state.ssh_manager.open_sftp(&session_id).await {
        let _ = sftp.remove_file(&tmp_remote).await;
    }

    outcome
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
