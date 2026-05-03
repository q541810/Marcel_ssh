use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::RwLock;
use tauri::State;

use crate::crash::{CrashHandler, CrashInfo, CrashReport, ConfigBackup};
use crate::error::AppError;

pub struct CrashState {
    pub handler: Arc<RwLock<Option<CrashHandler>>>,
    pub pending_crash: Arc<RwLock<Option<CrashInfo>>>,
}

impl CrashState {
    pub fn new() -> Self {
        Self {
            handler: Arc::new(RwLock::new(None)),
            pending_crash: Arc::new(RwLock::new(None)),
        }
    }
}

impl Default for CrashState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn crash_check_previous(state: State<'_, CrashState>) -> Result<Option<CrashInfo>, AppError> {
    let pending = state.pending_crash.read();
    Ok(pending.clone())
}

#[tauri::command]
pub async fn crash_get_report(state: State<'_, CrashState>) -> Result<Option<CrashReport>, AppError> {
    let pending = state.pending_crash.read();
    if let Some(crash_info) = pending.as_ref() {
        let handler_lock = state.handler.read();
        if let Some(handler) = handler_lock.as_ref() {
            Ok(Some(handler.generate_report(crash_info)))
        } else {
            Ok(None)
        }
    } else {
        Ok(None)
    }
}

#[tauri::command]
pub async fn crash_export_report(
    state: State<'_, CrashState>,
    export_path: String,
) -> Result<String, AppError> {
    let pending = state.pending_crash.read();
    let crash_info = pending.as_ref()
        .ok_or_else(|| AppError::Other("没有崩溃报告可导出".to_string()))?;

    let handler_lock = state.handler.read();
    let handler = handler_lock.as_ref()
        .ok_or_else(|| AppError::Other("崩溃处理器未初始化".to_string()))?;

    let report = handler.generate_report(crash_info);
    let path = PathBuf::from(&export_path);
    
    handler.export_report(&report, &path)
        .map_err(|e| AppError::Other(e))?;

    Ok(format!("崩溃报告已导出到: {}", export_path))
}

#[tauri::command]
pub async fn crash_repair_config(
    state: State<'_, CrashState>,
    file_name: String,
) -> Result<(), AppError> {
    let handler_lock = state.handler.read();
    let handler = handler_lock.as_ref()
        .ok_or_else(|| AppError::Other("崩溃处理器未初始化".to_string()))?;

    let recovery = handler.get_recovery();
    
    match file_name.as_str() {
        "settings.json" => {
            recovery.repair_settings()
                .map_err(|e| AppError::Config(e))?;
        }
        "connections.json" => {
            recovery.repair_connections()
                .map_err(|e| AppError::Config(e))?;
        }
        _ => {
            return Err(AppError::Other(format!("不支持的配置文件: {}", file_name)));
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn crash_list_backups(
    state: State<'_, CrashState>,
    file_name: String,
) -> Result<Vec<ConfigBackup>, AppError> {
    let handler_lock = state.handler.read();
    let handler = handler_lock.as_ref()
        .ok_or_else(|| AppError::Other("崩溃处理器未初始化".to_string()))?;

    let recovery = handler.get_recovery();
    let backups = recovery.get_backups_for_file(&file_name)
        .into_iter()
        .cloned()
        .collect();

    Ok(backups)
}

#[tauri::command]
pub async fn crash_restore_backup(
    state: State<'_, CrashState>,
    backup_path: String,
) -> Result<(), AppError> {
    let handler_lock = state.handler.read();
    let handler = handler_lock.as_ref()
        .ok_or_else(|| AppError::Other("崩溃处理器未初始化".to_string()))?;

    let recovery = handler.get_recovery();
    let path = PathBuf::from(&backup_path);
    
    recovery.restore_backup(&path)
        .map_err(|e| AppError::Config(e))?;

    Ok(())
}

#[tauri::command]
pub async fn crash_dismiss(state: State<'_, CrashState>) -> Result<(), AppError> {
    let mut pending = state.pending_crash.write();
    *pending = None;
    Ok(())
}

#[tauri::command]
pub async fn crash_mark_resolved(state: State<'_, CrashState>) -> Result<(), AppError> {
    let handler_lock = state.handler.read();
    if let Some(handler) = handler_lock.as_ref() {
        handler.mark_clean_shutdown();
    }
    
    let mut pending = state.pending_crash.write();
    *pending = None;
    
    Ok(())
}
