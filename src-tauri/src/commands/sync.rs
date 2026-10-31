//! 跨设备同步的 tauri 命令。逻辑都在 `crate::sync`（`SyncManager`），这里只做参数转接。
//!
//! 参数名与返回结构必须和前端 `src/lib/tauri.ts` 的 `sync*` 绑定、`src/lib/types.ts` 的 `Sync*`
//! 类型一致（tauri 把 Rust 的 snake_case 参数名按 camelCase 对外）。
//!
//! 机密（存储密码、恢复密钥、同步码）只经这些命令的参数 / 返回值穿过，**不进日志、不进错误文案**。

use tauri::State;

use crate::error::AppError;
use crate::sync::storage::StorageConfig;
use crate::sync::types::TierEstimate;
use crate::sync::{SyncCreateResult, SyncDevice, SyncHistoryEntry, SyncStatus};
use crate::AppState;

#[tauri::command]
pub async fn sync_get_status(state: State<'_, AppState>) -> Result<SyncStatus, AppError> {
    Ok(state.sync.status())
}

/// 连通性 + 权限自检（写 / 读 / 删一个探针文件）。
#[tauri::command]
pub async fn sync_test_storage(
    state: State<'_, AppState>,
    storage: StorageConfig,
    secret: Option<String>,
) -> Result<(), AppError> {
    state.sync.test_storage(storage, secret).await
}

/// 开启同步（第一台设备）。返回的恢复密钥与同步码是机密，只展示一次。
#[tauri::command]
pub async fn sync_create(
    state: State<'_, AppState>,
    storage: StorageConfig,
    secret: Option<String>,
) -> Result<SyncCreateResult, AppError> {
    state.sync.create(storage, secret).await
}

/// 用同步码加入已有同步。
#[tauri::command]
pub async fn sync_join(state: State<'_, AppState>, sync_code: String) -> Result<(), AppError> {
    state.sync.join_code(sync_code).await
}

/// 手动加入：选存储位置 + 输入恢复密钥。
#[tauri::command]
pub async fn sync_join_manual(
    state: State<'_, AppState>,
    storage: StorageConfig,
    secret: Option<String>,
    recovery_key: String,
) -> Result<(), AppError> {
    state.sync.join_manual(storage, secret, recovery_key).await
}

/// 立即同步一次。前端在订阅好同步事件后第一次调用它，才会解除启动后的「等前端」闸门。
#[tauri::command]
pub async fn sync_now(state: State<'_, AppState>) -> Result<(), AppError> {
    state.sync.sync_now().await
}

/// 同步码（加新设备用，**等同于钥匙**）。
#[tauri::command]
pub async fn sync_get_sync_code(state: State<'_, AppState>) -> Result<String, AppError> {
    state.sync.get_sync_code().await
}

#[tauri::command]
pub async fn sync_get_recovery_key(state: State<'_, AppState>) -> Result<String, AppError> {
    state.sync.get_recovery_key()
}

#[tauri::command]
pub async fn sync_set_device_name(
    state: State<'_, AppState>,
    name: String,
) -> Result<(), AppError> {
    state.sync.set_device_name(name).await
}

#[tauri::command]
pub async fn sync_list_devices(state: State<'_, AppState>) -> Result<Vec<SyncDevice>, AppError> {
    Ok(state.sync.list_devices())
}

#[tauri::command]
pub async fn sync_list_history(
    state: State<'_, AppState>,
    limit: usize,
) -> Result<Vec<SyncHistoryEntry>, AppError> {
    Ok(state.sync.list_history(limit))
}

/// 撤销一条同步记录：把该处改回旧值（走一次本机写入，会再同步给其它设备）。
#[tauri::command]
pub async fn sync_undo(state: State<'_, AppState>, entry_id: String) -> Result<(), AppError> {
    state.sync.undo(&entry_id).await
}

/// 处理「大量删除」确认：`accept = true` 同步删除，`false` 撤销本机的删除。
#[tauri::command]
pub async fn sync_confirm_held(state: State<'_, AppState>, accept: bool) -> Result<(), AppError> {
    state.sync.confirm_held(accept).await
}

/// 打开 / 关闭某一档（`"conversation"` / `"secret"`）。配置档恒为开，不能关。
///
/// 打开时先把本机已有数据整份导出并上传（「加入这条流」），再追上别人的进度；
/// 关闭时**不删**远端文件、不删本机数据，只是之后不再上传 / 拉取。
#[tauri::command]
pub async fn sync_set_tier(
    state: State<'_, AppState>,
    tier: String,
    enabled: bool,
) -> Result<(), AppError> {
    state.sync.set_tier(tier, enabled).await
}

/// 某一档的规模估算（给「打开前先告诉用户大约要传多少」用）。
/// **只有数量与名称，绝不返回值本身。**
#[tauri::command]
pub async fn sync_tier_estimate(
    state: State<'_, AppState>,
    tier: String,
) -> Result<TierEstimate, AppError> {
    state.sync.tier_estimate(tier)
}

/// 停止同步。本机配置数据不动；`wipe_remote` 同时删掉云端本应用的同步文件。
#[tauri::command]
pub async fn sync_disable(state: State<'_, AppState>, wipe_remote: bool) -> Result<(), AppError> {
    state.sync.disable(wipe_remote).await
}
