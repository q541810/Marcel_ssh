use std::path::{Path, PathBuf};
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::report::{CrashReport, ConfigFileStatus};
use super::recovery::ConfigRecovery;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CrashType {
    ConfigCorrupted,
    StartupFailure,
    RuntimePanic,
    DatabaseError,
    Unknown,
}

impl CrashType {
    pub fn as_str(&self) -> &'static str {
        match self {
            CrashType::ConfigCorrupted => "config_corrupted",
            CrashType::StartupFailure => "startup_failure",
            CrashType::RuntimePanic => "runtime_panic",
            CrashType::DatabaseError => "database_error",
            CrashType::Unknown => "unknown",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "config_corrupted" => CrashType::ConfigCorrupted,
            "startup_failure" => CrashType::StartupFailure,
            "runtime_panic" => CrashType::RuntimePanic,
            "database_error" => CrashType::DatabaseError,
            _ => CrashType::Unknown,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashInfo {
    pub crash_type: CrashType,
    pub error_message: String,
    pub affected_files: Vec<String>,
    pub timestamp: DateTime<Utc>,
    pub report_path: Option<PathBuf>,
}

pub struct CrashHandler {
    config_dir: PathBuf,
    crash_flag_file: PathBuf,
    crash_info_file: PathBuf,
    log_file: PathBuf,
    recovery: ConfigRecovery,
    is_clean_shutdown: Arc<AtomicBool>,
}

impl CrashHandler {
    pub fn new(config_dir: &Path) -> Self {
        Self {
            config_dir: config_dir.to_path_buf(),
            crash_flag_file: config_dir.join(".crash_flag"),
            crash_info_file: config_dir.join("crash_info.json"),
            log_file: config_dir.join("app.log"),
            recovery: ConfigRecovery::new(config_dir),
            is_clean_shutdown: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn check_previous_crash(&self) -> Option<CrashInfo> {
        if !self.crash_flag_file.exists() {
            return None;
        }

        let crash_info = self.load_crash_info();
        log::warn!("检测到上次异常退出: {:?}", crash_info);
        crash_info
    }

    pub fn mark_startup(&self) {
        if let Err(e) = fs::write(&self.crash_flag_file, "running") {
            log::warn!("无法写入崩溃标志: {}", e);
        }
        self.is_clean_shutdown.store(false, Ordering::SeqCst);
    }

    pub fn mark_clean_shutdown(&self) {
        self.is_clean_shutdown.store(true, Ordering::SeqCst);
        if self.crash_flag_file.exists() {
            if let Err(e) = fs::remove_file(&self.crash_flag_file) {
                log::warn!("无法移除崩溃标志: {}", e);
            }
        }
        if self.crash_info_file.exists() {
            if let Err(e) = fs::remove_file(&self.crash_info_file) {
                log::warn!("无法移除崩溃信息: {}", e);
            }
        }
        log::info!("正常退出，已清理崩溃标志");
    }

    pub fn record_crash(&self, crash_type: CrashType, error_message: &str, affected_files: Vec<String>) -> CrashInfo {
        let crash_info = CrashInfo {
            crash_type: crash_type.clone(),
            error_message: error_message.to_string(),
            affected_files: affected_files.clone(),
            timestamp: Utc::now(),
            report_path: None,
        };

        if let Ok(json) = serde_json::to_string_pretty(&crash_info) {
            if let Err(e) = fs::write(&self.crash_info_file, json) {
                log::error!("无法写入崩溃信息: {}", e);
            }
        }

        log::error!("记录崩溃: {:?} - {}", crash_type, error_message);
        crash_info
    }

    fn load_crash_info(&self) -> Option<CrashInfo> {
        if !self.crash_info_file.exists() {
            return Some(CrashInfo {
                crash_type: CrashType::Unknown,
                error_message: "程序异常退出，无详细错误信息".to_string(),
                affected_files: vec![],
                timestamp: Utc::now(),
                report_path: None,
            });
        }

        let content = fs::read_to_string(&self.crash_info_file).ok()?;
        serde_json::from_str(&content).ok()
    }

    pub fn generate_report(&self, crash_info: &CrashInfo) -> CrashReport {
        let config_status = self.check_config_files();
        let recent_logs = self.read_recent_logs(50);
        let recovery_available = self.check_recovery_available(&crash_info.crash_type);

        CrashReport::new(
            crash_info.crash_type.as_str(),
            &crash_info.error_message,
            None,
            config_status,
            recent_logs,
            recovery_available,
        )
    }

    fn check_config_files(&self) -> Vec<ConfigFileStatus> {
        let mut status = Vec::new();

        let settings_path = self.config_dir.join("settings.json");
        status.push(self.check_single_config(&settings_path, "settings.json"));

        let connections_path = self.config_dir.join("connections.json");
        status.push(self.check_single_config(&connections_path, "connections.json"));

        let db_path = self.config_dir.join("conversations.db");
        status.push(self.check_database_file(&db_path));

        status
    }

    fn check_single_config(&self, path: &Path, name: &str) -> ConfigFileStatus {
        let exists = path.exists();
        let (is_valid, error_message) = if exists {
            match fs::read_to_string(path) {
                Ok(content) => {
                    if content.trim().is_empty() {
                        (true, None)
                    } else {
                        match serde_json::from_str::<serde_json::Value>(&content) {
                            Ok(_) => (true, None),
                            Err(e) => (false, Some(format!("JSON解析错误: {}", e))),
                        }
                    }
                }
                Err(e) => (false, Some(format!("读取失败: {}", e))),
            }
        } else {
            (true, None)
        };

        let (file_size, last_modified) = if exists {
            if let Ok(metadata) = fs::metadata(path) {
                let size = Some(metadata.len());
                let modified = metadata.modified().ok().and_then(|t| {
                    DateTime::from_timestamp(
                        t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64,
                        0
                    )
                });
                (size, modified)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        ConfigFileStatus {
            path: name.to_string(),
            exists,
            is_valid,
            error_message,
            file_size,
            last_modified,
        }
    }

    fn check_database_file(&self, path: &Path) -> ConfigFileStatus {
        let exists = path.exists();
        let (is_valid, error_message) = if exists {
            match rusqlite::Connection::open(path) {
                Ok(_) => (true, None),
                Err(e) => (false, Some(format!("数据库错误: {}", e))),
            }
        } else {
            (true, None)
        };

        let (file_size, last_modified) = if exists {
            if let Ok(metadata) = fs::metadata(path) {
                let size = Some(metadata.len());
                let modified = metadata.modified().ok().and_then(|t| {
                    DateTime::from_timestamp(
                        t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64,
                        0
                    )
                });
                (size, modified)
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        ConfigFileStatus {
            path: "conversations.db".to_string(),
            exists,
            is_valid,
            error_message,
            file_size,
            last_modified,
        }
    }

    fn read_recent_logs(&self, max_lines: usize) -> Vec<String> {
        if !self.log_file.exists() {
            return vec!["日志文件不存在".to_string()];
        }

        match fs::read_to_string(&self.log_file) {
            Ok(content) => {
                let lines: Vec<&str> = content.lines().collect();
                let start = lines.len().saturating_sub(max_lines);
                lines[start..].iter().map(|s| s.to_string()).collect()
            }
            Err(e) => vec![format!("读取日志失败: {}", e)],
        }
    }

    fn check_recovery_available(&self, crash_type: &CrashType) -> bool {
        matches!(crash_type, CrashType::ConfigCorrupted | CrashType::DatabaseError)
    }

    pub fn get_recovery(&self) -> &ConfigRecovery {
        &self.recovery
    }

    pub fn export_report(&self, report: &CrashReport, export_path: &Path) -> Result<(), String> {
        report.save_to_file(export_path)
            .map_err(|e| format!("导出报告失败: {}", e))
    }

    pub fn setup_panic_hook(&self) {
        let crash_info_path = self.crash_info_file.clone();

        std::panic::set_hook(Box::new(move |info| {
            let error_message = info.to_string();
            let crash_info = CrashInfo {
                crash_type: CrashType::RuntimePanic,
                error_message: error_message.clone(),
                affected_files: vec![],
                timestamp: Utc::now(),
                report_path: None,
            };

            if let Ok(json) = serde_json::to_string_pretty(&crash_info) {
                let _ = fs::write(&crash_info_path, json);
            }

            log::error!("程序发生恐慌: {}", error_message);
        }));
    }
}

impl Drop for CrashHandler {
    fn drop(&mut self) {
        if !self.is_clean_shutdown.load(Ordering::SeqCst) {
            log::warn!("程序异常终止，崩溃标志已保留");
        }
    }
}
