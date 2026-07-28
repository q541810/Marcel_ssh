use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use notify::Watcher;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::emit_event;
use crate::error::AppError;
use crate::util::validate_sftp_remote_path;
use crate::AppState;

use super::sftp::{commit_remote_temp_file, remote_sidecar_path};

pub(super) const TEMP_DIR_PREFIX: &str = "marcel-sysopen";
pub(super) const MAX_BYTES: u64 = 512 * 1024 * 1024;
/// 单个 SSH 会话同时「用系统方式打开」的文件数上限。
pub(super) const MAX_CONCURRENT_PER_SESSION: usize = 8;
/// 自动回传连续失败上限，达到后停止监视。
pub(super) const SYNC_MAX_RETRIES: u32 = 5;
/// 本地文件变化后的回传去抖时间。
pub(super) const SYNC_DEBOUNCE: Duration = Duration::from_millis(800);
/// 流式下载与回传的 buffer 大小。
pub(super) const BUFFER_BYTES: usize = 131_072;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenWithSystemResult {
    pub task_id: String,
    pub local_path: String,
    /// true 表示复用了已有任务，只重新唤起系统应用。
    pub reused: bool,
}

/// 前端传输中心展示的系统打开任务阶段。
#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
#[serde(tag = "kind")]
pub enum SysopenPhase {
    Downloading { written: u64, total: u64 },
    Opened,
    Monitoring,
    Syncing { written: u64, total: u64 },
    Synced,
    Cancelled,
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

/// 校验请求、注册任务并启动系统打开生命周期。
pub(super) async fn open_with_system(
    app: AppHandle,
    state: &AppState,
    session_id: String,
    remote_path: String,
    task_id: String,
    download_id: String,
    upload_id: String,
) -> Result<OpenWithSystemResult, AppError> {
    let remote_path = validate_sftp_remote_path(&remote_path)?;

    let remote_basename = Path::new(&remote_path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(str::to_string)
        .ok_or_else(|| AppError::Ssh("无法解析远端文件名".into()))?;
    if remote_basename.contains('/')
        || remote_basename.contains('\\')
        || remote_basename.contains('\0')
        || remote_basename == "."
        || remote_basename == ".."
    {
        return Err(AppError::Ssh("远端文件名包含非法字符".into()));
    }

    let existing_task_id = {
        let active = state.sysopen_active_paths.read();
        active
            .get(&(session_id.clone(), remote_path.clone()))
            .cloned()
    };
    if let Some(existing_task_id) = existing_task_id {
        let local_to_reopen = {
            let watchers = state.sysopen_watchers.read();
            watchers
                .get(&existing_task_id)
                .map(|(_, local_path, _)| local_path.clone())
        };
        match local_to_reopen {
            Some(local_path) => {
                use tauri_plugin_opener::OpenerExt;
                app.opener()
                    .open_path(local_path.to_string_lossy().to_string(), None::<&str>)
                    .map_err(|e| AppError::Ssh(format!("重新打开失败: {}", e)))?;
                return Ok(OpenWithSystemResult {
                    task_id: existing_task_id,
                    local_path: local_path.to_string_lossy().to_string(),
                    reused: true,
                });
            }
            None => {
                state
                    .sysopen_active_paths
                    .write()
                    .remove(&(session_id.clone(), remote_path.clone()));
            }
        }
    }

    {
        let watchers = state.sysopen_watchers.read();
        let count = watchers
            .iter()
            .filter(|(_, (sid, _, _))| sid.as_str() == session_id.as_str())
            .count();
        if count >= MAX_CONCURRENT_PER_SESSION {
            return Err(AppError::Ssh(format!(
                "同时打开的文件过多（上限 {}），请先关闭部分再重试",
                MAX_CONCURRENT_PER_SESSION
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
    if total > MAX_BYTES {
        return Err(AppError::Ssh(format!(
            "文件过大 ({} MB)，系统打开限制为 {} MB，请使用下载功能",
            total / (1024 * 1024),
            MAX_BYTES / (1024 * 1024)
        )));
    }

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Ssh(format!("获取 app_data_dir 失败: {}", e)))?;
    let temp_root = app_data.join(TEMP_DIR_PREFIX).join(&session_id);
    std::fs::create_dir_all(&temp_root)
        .map_err(|e| AppError::Ssh(format!("创建临时目录失败: {}", e)))?;
    let local_path = temp_root.join(&remote_basename);

    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    state.sysopen_watchers.write().insert(
        task_id.clone(),
        (session_id.clone(), local_path.clone(), cancel_tx),
    );
    state
        .sysopen_active_paths
        .write()
        .insert((session_id.clone(), remote_path.clone()), task_id.clone());

    let result = OpenWithSystemResult {
        task_id: task_id.clone(),
        local_path: local_path.to_string_lossy().to_string(),
        reused: false,
    };
    let task_state = state.clone();
    tokio::spawn(async move {
        run_task(
            app,
            task_state,
            session_id,
            remote_path,
            task_id,
            download_id,
            upload_id,
            local_path,
            total,
            cancel_rx,
        )
        .await;
    });

    Ok(result)
}

/// 推送状态失败不应中断文件下载、打开或回传流程。
pub(super) fn emit_state(
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

/// 单次回传：本地文件 → 远程临时文件 → 原子替换远程原文件。
pub(super) async fn sync_back(
    app: &AppHandle,
    state: &AppState,
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

    emit_state(
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

    let mut buf = vec![0u8; BUFFER_BYTES];
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
        emit_state(
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

/// mtime 或 size 任一改变即视为本地文件有未回传修改。
pub(super) async fn is_dirty(local_path: &Path, last: &(Option<SystemTime>, u64)) -> bool {
    match tokio::fs::metadata(local_path).await {
        Ok(m) => {
            let mtime = m.modified().ok();
            (mtime, m.len()) != *last
        }
        Err(_) => false,
    }
}

/// 停止监听、删除本地临时文件，并清理任务状态表。
pub(super) async fn teardown(
    state: &AppState,
    task_id: &str,
    session_id: &str,
    remote_path: &str,
    local_path: &Path,
    watcher: Option<notify::RecommendedWatcher>,
) {
    drop(watcher);
    let _ = tokio::fs::remove_file(local_path).await;
    state.sysopen_watchers.write().remove(task_id);
    state
        .sysopen_active_paths
        .write()
        .remove(&(session_id.to_string(), remote_path.to_string()));
}

/// 请求指定系统打开任务停止；任务本身负责最终状态和收尾。
pub(super) fn cancel(state: &AppState, task_id: &str) {
    if let Some((_, _, tx)) = state.sysopen_watchers.read().get(task_id) {
        let _ = tx.send(true);
    }
}

/// 会话断开时停止该会话的所有任务，并清理去重表和临时目录。
pub(super) async fn cleanup_session(app: &AppHandle, state: &AppState, session_id: &str) {
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

    {
        let mut active = state.sysopen_active_paths.write();
        let keys_to_remove: Vec<_> = active
            .keys()
            .filter(|(sid, _)| sid.as_str() == session_id)
            .cloned()
            .collect();
        for key in keys_to_remove {
            active.remove(&key);
        }
    }

    let app_data = match app.path().app_data_dir() {
        Ok(dir) => dir,
        Err(_) => return,
    };
    let temp_dir = app_data.join(TEMP_DIR_PREFIX).join(session_id);
    if temp_dir.exists() {
        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }
}

/// 下载远程文件，用系统默认应用打开，并监视本地修改自动回传。
pub(super) async fn run_task(
    app: AppHandle,
    state: AppState,
    session_id: String,
    remote_path: String,
    task_id: String,
    download_id: String,
    upload_id: String,
    local_path: PathBuf,
    total: u64,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    let sftp = match state.ssh_manager.open_sftp(&session_id).await {
        Ok(s) => s,
        Err(e) => {
            emit_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("打开 SFTP 通道失败: {}", e),
                },
            );
            teardown(
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
        Ok(file) => file,
        Err(e) => {
            emit_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("打开远程文件失败: {}", e),
                },
            );
            teardown(
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
        Ok(file) => file,
        Err(e) => {
            emit_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("创建本地临时文件失败: {}", e),
                },
            );
            teardown(
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

    let mut buf = vec![0u8; BUFFER_BYTES];
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
                            emit_state(
                                &app,
                                &task_id,
                                &download_id,
                                &upload_id,
                                SysopenPhase::Failed {
                                    message: format!("写入本地临时文件失败: {}", e),
                                },
                            );
                            let _ = tokio::fs::remove_file(&temp_part).await;
                            teardown(
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
                        written += n as u64;
                        emit_state(
                            &app,
                            &task_id,
                            &download_id,
                            &upload_id,
                            SysopenPhase::Downloading { written, total },
                        );
                    }
                    Err(e) => {
                        emit_state(
                            &app,
                            &task_id,
                            &download_id,
                            &upload_id,
                            SysopenPhase::Failed {
                                message: format!("读取远程文件失败: {}", e),
                            },
                        );
                        let _ = tokio::fs::remove_file(&temp_part).await;
                        teardown(
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
            }
        }
    }
    let _ = local.flush().await;
    drop(local);
    drop(remote);

    if cancelled {
        let _ = tokio::fs::remove_file(&temp_part).await;
        emit_state(
            &app,
            &task_id,
            &download_id,
            &upload_id,
            SysopenPhase::Cancelled,
        );
        teardown(
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
        emit_state(
            &app,
            &task_id,
            &download_id,
            &upload_id,
            SysopenPhase::Failed {
                message: format!("下载不完整：预期 {} 字节，实际 {} 字节", total, written),
            },
        );
        teardown(
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
        emit_state(
            &app,
            &task_id,
            &download_id,
            &upload_id,
            SysopenPhase::Failed {
                message: format!("保存临时文件失败: {}", e),
            },
        );
        teardown(
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

    emit_state(
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
            emit_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("用系统默认应用打开失败: {}", e),
                },
            );
            teardown(
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

    emit_state(
        &app,
        &task_id,
        &download_id,
        &upload_id,
        SysopenPhase::Monitoring,
    );

    let initial_sig = tokio::fs::metadata(&local_path)
        .await
        .ok()
        .and_then(|m| m.modified().ok().map(|time| (Some(time), m.len())))
        .unwrap_or((None, total));

    let (notify_tx, mut notify_rx) = tokio::sync::mpsc::channel::<()>(64);
    let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, _>| {
        if res.is_ok() {
            let _ = notify_tx.blocking_send(());
        }
    }) {
        Ok(watcher) => watcher,
        Err(e) => {
            emit_state(
                &app,
                &task_id,
                &download_id,
                &upload_id,
                SysopenPhase::Failed {
                    message: format!("启动文件监视失败: {}", e),
                },
            );
            teardown(
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
        emit_state(
            &app,
            &task_id,
            &download_id,
            &upload_id,
            SysopenPhase::Failed {
                message: format!("监视文件失败: {}", e),
            },
        );
        teardown(
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

    let mut last_sig = initial_sig;
    let mut consecutive_failures: u32 = 0;
    let mut pending_sync = false;
    let final_phase;

    loop {
        if pending_sync {
            tokio::select! {
                biased;
                _ = cancel_rx.changed() => {
                    if is_dirty(&local_path, &last_sig).await {
                        let _ = sync_back(
                            &app, &state, &session_id, &remote_path, &local_path,
                            &task_id, &download_id, &upload_id,
                        ).await;
                    }
                    final_phase = SysopenPhase::Cancelled;
                    break;
                }
                _ = tokio::time::sleep(SYNC_DEBOUNCE) => {
                    pending_sync = false;
                    match sync_back(
                        &app, &state, &session_id, &remote_path, &local_path,
                        &task_id, &download_id, &upload_id,
                    ).await {
                        Ok(new_sig) => {
                            last_sig = new_sig;
                            consecutive_failures = 0;
                            emit_state(&app, &task_id, &download_id, &upload_id, SysopenPhase::Synced);
                            emit_state(&app, &task_id, &download_id, &upload_id, SysopenPhase::Monitoring);
                        }
                        Err(e) => {
                            consecutive_failures += 1;
                            if consecutive_failures >= SYNC_MAX_RETRIES {
                                final_phase = SysopenPhase::Failed {
                                    message: format!("连续 {} 次回传失败：{}", consecutive_failures, e),
                                };
                                break;
                            }
                            emit_state(&app, &task_id, &download_id, &upload_id, SysopenPhase::Monitoring);
                        }
                    }
                }
                _ = notify_rx.recv() => {
                    continue;
                }
            }
        } else {
            tokio::select! {
                biased;
                _ = cancel_rx.changed() => {
                    if is_dirty(&local_path, &last_sig).await {
                        let _ = sync_back(
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

    emit_state(&app, &task_id, &download_id, &upload_id, final_phase);
    teardown(
        &state,
        &task_id,
        &session_id,
        &remote_path,
        &local_path,
        Some(watcher),
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_event_keeps_existing_frontend_shape() {
        let value = serde_json::to_value(SysopenStateEvent {
            task_id: "task".into(),
            download_id: "download".into(),
            upload_id: "upload".into(),
            phase: SysopenPhase::Downloading {
                written: 12,
                total: 34,
            },
        })
        .expect("serialize");

        assert_eq!(value["taskId"], "task");
        assert_eq!(value["downloadId"], "download");
        assert_eq!(value["uploadId"], "upload");
        assert_eq!(value["phase"]["kind"], "downloading");
        assert_eq!(value["phase"]["written"], 12);
        assert_eq!(value["phase"]["total"], 34);
    }
}
