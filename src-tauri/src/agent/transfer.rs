//! Agent 传输的统一调度与记账层。
//!
//! 职责：
//! - **互斥**：同一时刻只跑一个 Agent 传输（多 agent 任务的上传/下载串行）。
//!   这是 Agent 侧自己的调度，**不受**用户 SFTP 面板的前端双道
//!   （transferScheduler upload/download lane）限制——两者独立运行，
//!   只是都显示在同一个传输中心（条目以 `source: "agent"` 区分）。
//! - **记账**：task_id → 传输 id 集合；任务终态/停止时级联取消其名下传输
//!   （只取消传输，不取消任务本身）。
//! - **前端可见**：传输开始时发 `agent-transfer-start` 事件，前端据此在
//!   传输中心创建条目（source=agent）；进度/完成复用 sftp 的
//!   `sftp-upload-progress`/`sftp-upload-done`/`sftp-download-progress`/
//!   `sftp-download-done` 事件。取消 watch 注册进
//!   AppState::upload_cancel_senders / download_cancel_senders（id 以
//!   `agent-transfer-` 为前缀），前端「取消」按钮按 id 调
//!   sftp_cancel_upload/download 即生效。
//!
//! 复用原则：本模块**不**实现传输字节拷贝——流式核心在
//! `commands::sftp::{stream_upload_single_file, stream_download_single_file}`，
//! 用户面板与 Agent 共用同一套。

use std::collections::HashSet;

use tauri::{AppHandle, Emitter};

use crate::error::AppError;
use crate::AppState;

/// Agent 传输 id 前缀。前端据此识别条目来源；与用户传输 id 空间隔离。
pub const AGENT_TRANSFER_ID_PREFIX: &str = "agent-transfer-";

/// Agent 传输条目元信息（前端创建传输中心条目需要）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTransferStartPayload {
    pub transfer_id: String,
    pub kind: String, // "upload" | "download"
    pub session_id: String,
    pub file_name: String,
    pub local_path: String,
    pub remote_path: String,
    pub total: u64,
    pub task_id: String,
    /// 目标机器展示名（多机跨机传输时 ≠ 当前会话；空 = 当前会话）
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_host_label: Option<String>,
}

/// 生成本次 Agent 传输的 id（`agent-transfer-{uuid}`）。
pub fn new_transfer_id() -> String {
    format!("{}{}", AGENT_TRANSFER_ID_PREFIX, uuid::Uuid::new_v4())
}

/// 拿 Agent 传输互斥锁：同一时刻只跑一个 Agent 传输。
/// guard 由调用方持有到传输结束。
pub async fn acquire_mutex(state: &AppState) -> tokio::sync::MutexGuard<'_, ()> {
    state.agent_transfer_mutex.lock().await
}

/// 记账：task_id → 传输 id（级联取消用）。
pub async fn register_transfer(state: &AppState, task_id: &str, transfer_id: &str) {
    state
        .agent_transfer_by_task
        .write()
        .await
        .entry(task_id.to_string())
        .or_insert_with(HashSet::new)
        .insert(transfer_id.to_string());
}

/// 传输开始事件（前端建传输中心条目）。
pub fn emit_start(app: &AppHandle, payload: &AgentTransferStartPayload) {
    let _ = app.emit("agent-transfer-start", payload);
}

/// Agent 传输终态事件（前端把条目置 done/error/cancelled）。
/// 用户传输的终态由前端 scheduler 的 command reject 驱动；agent 传输不经
/// scheduler，必须由后端显式通知终态，否则条目会永久停在 active/cancelling。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTransferFinishedPayload {
    pub transfer_id: String,
    pub status: String, // "done" | "error" | "cancelled"
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

pub fn emit_finished(app: &AppHandle, payload: &AgentTransferFinishedPayload) {
    let _ = app.emit("agent-transfer-finished", payload);
}

/// 任务终态/停止：级联取消该任务名下全部 Agent 传输（只取消传输本身）。
/// 置位 AppState 里该传输 id 的取消 watch（upload/download 表），传输本体
/// 收到后自行清理 .part/sidecar 并结束。
pub async fn cancel_task_transfers(state: &AppState, task_id: &str) -> usize {
    let ids: Vec<String> = state
        .agent_transfer_by_task
        .write()
        .await
        .remove(task_id)
        .map(|s| s.into_iter().collect())
        .unwrap_or_default();
    for id in &ids {
        let removed_up = state.upload_cancel_senders.write().remove(id.as_str());
        let removed_dl = state.download_cancel_senders.write().remove(id.as_str());
        if let Some(tx) = removed_up {
            let _ = tx.send(true);
        }
        if let Some(tx) = removed_dl {
            let _ = tx.send(true);
        }
    }
    if !ids.is_empty() {
        log::info!(
            "agent_transfer: 任务 {} 终态，级联取消 {} 个传输",
            task_id,
            ids.len()
        );
    }
    ids.len()
}

/// 用户从传输中心取消单个 Agent 传输：前端实际调 sftp_cancel_upload/download
/// 按 id 触发 watch（工具执行时已注册）。这里仅清理记账，幂等。
pub async fn cancel_transfer_record(state: &AppState, transfer_id: &str) {
    let mut found = false;
    {
        let mut by_task = state.agent_transfer_by_task.write().await;
        for ids in by_task.values_mut() {
            if ids.remove(transfer_id) {
                found = true;
            }
        }
        if found {
            by_task.retain(|_, ids| !ids.is_empty());
        }
    }
    if found {
        log::info!("agent_transfer: 清理传输记账 {}", transfer_id);
    }
}

/// AppError 便捷构造：Agent 传输被取消/失败时的统一文案。
pub fn transfer_error(msg: impl Into<String>) -> AppError {
    AppError::Agent(msg.into())
}
