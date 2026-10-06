//! 「用系统方式打开」(sysopen) 子系统 —— 自 `commands/sftp.rs` 整体外迁。
//!
//! 把远程文件下载到本地临时目录，用系统默认应用打开；用 notify 监听本地文件变化，
//! 改动后自动回传到远程。一个 task_id 关联「下载」与「监视回传」两张传输卡片，
//! 状态经 `sftp-sysopen-state` 事件统一推送（不复用标准 progress/done 事件，
//! 避免文案被覆盖为「下载完成/上传完成」而丢失 sysopen 语义）。
//!
//! 防御性要点：
//!   - 同名文件去重：(session_id, remote_path) 同时只允许一个 sysopen 任务
//!   - 单 session 并发上限：SYSOPEN_MAX_CONCURRENT_PER_SESSION
//!   - 下载阶段即可取消（select! 读 cancel），不再只能等下载完
//!   - notify 替代 3s 轮询：保存即感知、低 CPU；事件去抖避免编辑器半截写
//!   - 回传走原子 rename + 完整性校验；连续失败超限停止，不再无限重试刷日志
//!   - mtime + size 双校验判断脏（FAT 等 mtime 不可靠时 size 兜底）
//!   - 任务退出统一收尾：drop watcher、删本地临时文件、清状态表
//!   - 用 tauri-plugin-opener 替代已 deprecated 的 shell().open()

// notify 的 watch 方法来自 Watcher trait，需在作用域内才能调用 watcher.watch(...)。
use notify::Watcher;
use russh_sftp::protocol::OpenFlags;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::emit_event;
use crate::error::AppError;
use crate::util::validate_sftp_remote_path;

use super::{commit_remote_temp_file, remote_sidecar_path};

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

/// 清洗用于本地文件名的组件（sysopen 本地副本与图片预览共用）：
/// 控制字符与 Windows 非法字符替换成 `_`，剥掉首尾空白与结尾的 `.`/空格
/// （Windows 会把结尾的点当扩展名分隔/丢弃），清洗后为空则退回 fallback。
/// `pub(super)`：sftp.rs 的图片预览复用同一套 sanitize，保证两端行为一致。
pub(super) fn sanitize_sysopen_component(value: &str, fallback: &str) -> String {
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
    /// 下载完成，且已成功调用系统默认应用打开。
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

/// 查 sysopen 去重表：同一 (session, remote_path) 已有任务时返回 (task_id, 本地副本)。
/// active_paths 有记录但 watchers 已无（任务已结束、残留未清）时顺手清掉残留并
/// 返回 None，让调用方走完整流程。
fn lookup_sysopen_task(
    state: &crate::AppState,
    session_id: &str,
    remote_path: &str,
) -> Option<(String, PathBuf)> {
    let key = (session_id.to_string(), remote_path.to_string());
    let existing_task_id = state.sysopen_active_paths.read().get(&key).cloned()?;
    let local_path = state
        .sysopen_watchers
        .read()
        .get(&existing_task_id)
        .map(|(_, lp, _)| lp.clone());
    match local_path {
        Some(lp) => Some((existing_task_id, lp)),
        None => {
            state.sysopen_active_paths.write().remove(&key);
            None
        }
    }
}

/// 复用一个已在跑的 sysopen 任务：再次用系统默认应用打开它的本地副本。
fn reopen_sysopen_local_copy(app: &AppHandle, local_path: &Path) -> Result<(), AppError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(local_path.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| AppError::Ssh(format!("重新打开失败: {}", e)))
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

/// 取消时的收尾：本地副本相对上次同步仍是脏的就做一次最终回传。
/// 返回 (要推送的终态, 是否保留本地副本)。
/// 回传失败绝不能吞掉：用户最后一次保存只落在本地副本里，原来 `let _ = ...`
/// 之后 teardown 无条件删副本，等于静默丢改动、界面还只说「已取消」。
async fn sysopen_final_sync_on_cancel(
    app: &AppHandle,
    state: &crate::AppState,
    session_id: &str,
    remote_path: &str,
    local_path: &Path,
    task_id: &str,
    download_id: &str,
    upload_id: &str,
    last_sig: &(Option<SystemTime>, u64),
) -> (SysopenPhase, bool) {
    if !sysopen_is_dirty(local_path, last_sig).await {
        return (SysopenPhase::Cancelled, false);
    }
    match sysopen_sync_back(
        app,
        state,
        session_id,
        remote_path,
        local_path,
        task_id,
        download_id,
        upload_id,
    )
    .await
    {
        Ok(_) => (SysopenPhase::Cancelled, false),
        Err(e) => (
            SysopenPhase::Failed {
                message: format!(
                    "取消时最终回传失败：{}。本地副本已保留在 {}，可手动取回",
                    e,
                    local_path.display()
                ),
            },
            true,
        ),
    }
}

/// 任务统一收尾：drop watcher（停止监听）、删本地临时文件、清状态表。
/// 任何退出路径都应调用，确保不残留 watcher / 临时文件 / 去重表项。
/// `keep_local`：取消时最终回传失败的情况下必须保留本地副本（用户的最终
/// 改动只存在于这个文件里），此时不删文件与所属临时目录，路径已写进提示。
async fn sysopen_teardown(
    state: &crate::AppState,
    task_id: &str,
    session_id: &str,
    remote_path: &str,
    local_path: &Path,
    watcher: Option<notify::RecommendedWatcher>,
    keep_local: bool,
) {
    drop(watcher);
    let part_path = format!("{}.part", local_path.to_string_lossy());
    let _ = tokio::fs::remove_file(part_path).await;
    if !keep_local {
        let _ = tokio::fs::remove_file(local_path).await;
        if let Some(task_temp_root) = local_path.parent() {
            let _ = tokio::fs::remove_dir(task_temp_root).await;
        }
    }
    // compare-and-remove：只有表里仍记录着「本次这个任务」时才摘除。
    // watchers 以 task_id 为键，身份靠随任务唯一的本地路径比对（每个任务
    // 一个 uuid 临时目录）；active_paths 比对登记的 task_id。否则本任务的
    // 收尾会把同键新任务的状态摘掉，新任务从此无法取消/去重。
    {
        let mut watchers = state.sysopen_watchers.write();
        let is_same_task =
            watchers
                .get(task_id)
                .is_some_and(|(stored_session, stored_local, _)| {
                    stored_session == session_id && stored_local == local_path
                });
        if is_same_task {
            watchers.remove(task_id);
        }
    }
    {
        let key = (session_id.to_string(), remote_path.to_string());
        let mut active = state.sysopen_active_paths.write();
        if active.get(&key).map(String::as_str) == Some(task_id) {
            active.remove(&key);
        }
    }
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
                false,
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
                false,
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
                false,
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
                            sysopen_teardown(&state, &task_id, &session_id, &remote_path, &local_path, None, false).await;
                            return;
                        }
                        written += n as u64;
                        // 增长检测：实际写入一旦超过下载开始时的大小，说明源文件
                        // 正在被程序写入/追加，立即停止（否则会一路追着增长的
                        // EOF 下不完）。检查放在进度事件之前，避免 UI 超 100%。
                        if written > total {
                            let _ = tokio::fs::remove_file(&temp_part).await;
                            emit_sysopen_state(&app, &task_id, &download_id, &upload_id,
                                SysopenPhase::Failed {
                                    message: format!(
                                        "下载后大小与预期不一致：预期 {} 字节，实际 {} 字节，可能有程序正在更改此文件",
                                        total, written
                                    ),
                                });
                            sysopen_teardown(&state, &task_id, &session_id, &remote_path, &local_path, None, false).await;
                            return;
                        }
                        emit_sysopen_state(&app, &task_id, &download_id, &upload_id,
                            SysopenPhase::Downloading { written, total });
                    }
                    Err(e) => {
                        emit_sysopen_state(&app, &task_id, &download_id, &upload_id,
                            SysopenPhase::Failed { message: format!("读取远程文件失败: {}", e) });
                        let _ = tokio::fs::remove_file(&temp_part).await;
                        sysopen_teardown(&state, &task_id, &session_id, &remote_path, &local_path, None, false).await;
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
            false,
        )
        .await;
        return;
    }
    // 下载完整性收尾校验：写入少于下载开始时的大小才是中途真的断了
    // （增长场景已在循环内拦截并报错，不会走到这里）。
    if written < total {
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
            false,
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
            false,
        )
        .await;
        return;
    }

    // ── 阶段 2：用系统默认应用打开（tauri-plugin-opener） ──
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
                false,
            )
            .await;
            return;
        }
    }
    // Opened 必须等打开真的成功后再发：先发会让前端下载卡片已经显示
    // 「已用系统应用打开」，而实际失败只能再补一条 Failed 覆盖它。
    emit_sysopen_state(
        &app,
        &task_id,
        &download_id,
        &upload_id,
        SysopenPhase::Opened,
    );

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
                false,
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
            false,
        )
        .await;
        return;
    }

    // 监视循环：notify 事件 → 去抖 → 回传；cancel → 最终回传 → 退出。
    let mut last_sig = initial_sig;
    let mut consecutive_failures: u32 = 0;
    let mut pending_sync = false;
    let mut final_phase = SysopenPhase::Synced;
    // 取消时最终回传失败 → 保留本地副本（路径已写进 Failed 提示）
    let mut keep_local_copy = false;

    loop {
        if pending_sync {
            tokio::select! {
                biased;
                _ = cancel_rx.changed() => {
                    let (phase, keep) = sysopen_final_sync_on_cancel(
                        &app, &state, &session_id, &remote_path, &local_path,
                        &task_id, &download_id, &upload_id, &last_sig,
                    ).await;
                    final_phase = phase;
                    keep_local_copy = keep;
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
                    let (phase, keep) = sysopen_final_sync_on_cancel(
                        &app, &state, &session_id, &remote_path, &local_path,
                        &task_id, &download_id, &upload_id, &last_sig,
                    ).await;
                    final_phase = phase;
                    keep_local_copy = keep;
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
        keep_local_copy,
    )
    .await;
}

/// `sftp_open_with_system` 命令的实现主体（薄壳留在 sftp.rs，签名与错误不变）。
/// 快路径复用已有任务的本地副本；否则校验 → 建临时目录 → 注册（查重 + 并发
/// 上限 + 落表一次完成）→ spawn [`run_sysopen_task`]。
pub(super) async fn open_with_system(
    app: AppHandle,
    state: &crate::AppState,
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

    // 同名去重（快路径）：同一 (session, remote_path) 已有 sysopen 任务在跑 → 复用
    // 已下载的本地副本，再次唤起系统应用打开，不重新下载、不重复监视
    //（旧 task 仍在监视改动并自动回传）。
    if let Some((existing_task_id, local_to_reopen)) =
        lookup_sysopen_task(state, &session_id, &remote_path)
    {
        reopen_sysopen_local_copy(&app, &local_to_reopen)?;
        return Ok(OpenWithSystemResult {
            task_id: existing_task_id,
            local_path: local_to_reopen.to_string_lossy().to_string(),
            reused: true,
        });
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

    // 注册 = 「查重 + 并发上限 + 落表」在同一个写锁临界区内一次做完。
    // 上面那条快路径到这里的中间隔着两次 SFTP 往返（metadata、建临时目录），
    // 若仍是 check-then-insert，两个并发请求会双双通过检查、各起一个监视任务，
    // 之后互相覆盖回写；旧任务的收尾还会把新任务的状态表项摘掉。
    enum Registration {
        Registered(tokio::sync::watch::Receiver<bool>),
        Reuse(String, PathBuf),
        TooMany,
    }
    let registration = {
        let mut watchers = state.sysopen_watchers.write();
        let mut active = state.sysopen_active_paths.write();
        let key = (session_id.clone(), remote_path.clone());
        let existing = active
            .get(&key)
            .and_then(|id| watchers.get(id).map(|(_, lp, _)| (id.clone(), lp.clone())));
        match existing {
            Some((existing_task_id, local_path)) => {
                Registration::Reuse(existing_task_id, local_path)
            }
            None => {
                let count = watchers
                    .iter()
                    .filter(|(_, (sid, _, _))| sid.as_str() == session_id.as_str())
                    .count();
                if count >= SYSOPEN_MAX_CONCURRENT_PER_SESSION {
                    Registration::TooMany
                } else {
                    // 先注册取消信号 + 活跃路径表，确保 spawn 后立即可被取消/去重
                    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
                    watchers.insert(
                        task_id.clone(),
                        (session_id.clone(), local_path.clone(), cancel_tx),
                    );
                    active.insert(key, task_id.clone());
                    Registration::Registered(cancel_rx)
                }
            }
        }
    };

    let cancel_rx = match registration {
        Registration::Registered(cancel_rx) => cancel_rx,
        Registration::Reuse(existing_task_id, local_path) => {
            // 抢锁晚了一步：另一个同目标请求已经注册。复用它，并把自己刚建的
            // 空临时目录清掉，别在 marcel-sysopen 下攒目录。
            let _ = std::fs::remove_dir_all(&task_temp_root);
            reopen_sysopen_local_copy(&app, &local_path)?;
            return Ok(OpenWithSystemResult {
                task_id: existing_task_id,
                local_path: local_path.to_string_lossy().to_string(),
                reused: true,
            });
        }
        Registration::TooMany => {
            let _ = std::fs::remove_dir_all(&task_temp_root);
            return Err(AppError::Ssh(format!(
                "同时打开的文件过多（上限 {}），请先关闭部分再重试",
                SYSOPEN_MAX_CONCURRENT_PER_SESSION
            )));
        }
    };

    let result_local_path = local_path.to_string_lossy().to_string();
    let result_task_id = task_id.clone();
    let task_app = app.clone();
    let task_state = state.clone();
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

/// `sftp_cancel_sysopen` 命令的实现主体（薄壳留在 sftp.rs）。
pub(super) async fn cancel_sysopen(state: &crate::AppState, task_id: &str) -> Result<(), AppError> {
    // 只发取消信号；状态表由 run_sysopen_task 收尾时清理，避免竞态。
    if let Some((_, _, tx)) = state.sysopen_watchers.read().get(task_id) {
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
mod tests {
    use super::{
        sanitize_sysopen_component, sysopen_local_filename, SYSOPEN_LOCAL_FILENAME_MAX_BYTES,
    };

    #[test]
    fn preview_basename_is_sanitized_for_windows_hosts() {
        // Linux 合法的 `s:1.png` 直接 join 到 Windows 临时目录会派生数据流/越界
        assert_eq!(sanitize_sysopen_component("s:1.png", "preview"), "s_1.png");
        assert_eq!(
            sanitize_sysopen_component("a|b?c*.png", "preview"),
            "a_b_c_.png"
        );
        assert_eq!(sanitize_sysopen_component("..", "preview"), "preview");
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
