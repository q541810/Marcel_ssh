use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemInfo {
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub app_version: String,
    pub rust_version: String,
}

impl SystemInfo {
    pub fn collect() -> Self {
        Self {
            os_name: std::env::consts::OS.to_string(),
            os_version: SystemInfo::get_os_version(),
            arch: std::env::consts::ARCH.to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            rust_version: rustc_version_runtime::version().to_string(),
        }
    }

    fn get_os_version() -> String {
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            if let Ok(output) = Command::new("cmd").args(["/C", "ver"]).output() {
                if let Ok(ver) = String::from_utf8(output.stdout) {
                    return ver.trim().to_string();
                }
            }
        }
        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            if let Ok(output) = Command::new("sw_vers").output() {
                if let Ok(info) = String::from_utf8(output.stdout) {
                    return info.trim().to_string();
                }
            }
        }
        #[cfg(target_os = "linux")]
        {
            if let Ok(content) = std::fs::read_to_string("/etc/os-release") {
                for line in content.lines() {
                    if line.starts_with("PRETTY_NAME=") {
                        return line.trim_start_matches("PRETTY_NAME=").trim_matches('"').to_string();
                    }
                }
            }
        }
        "Unknown".to_string()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigFileStatus {
    pub path: String,
    pub exists: bool,
    pub is_valid: bool,
    pub error_message: Option<String>,
    pub file_size: Option<u64>,
    pub last_modified: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashReport {
    pub report_id: String,
    pub timestamp: DateTime<Utc>,
    pub crash_type: String,
    pub error_message: String,
    pub stack_trace: Option<String>,
    pub system_info: SystemInfo,
    pub config_status: Vec<ConfigFileStatus>,
    pub recent_logs: Vec<String>,
    pub recovery_available: bool,
}

impl CrashReport {
    pub fn new(
        crash_type: &str,
        error_message: &str,
        stack_trace: Option<String>,
        config_status: Vec<ConfigFileStatus>,
        recent_logs: Vec<String>,
        recovery_available: bool,
    ) -> Self {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);

        Self {
            report_id: format!("CRASH-{:x}", timestamp),
            timestamp: Utc::now(),
            crash_type: crash_type.to_string(),
            error_message: error_message.to_string(),
            stack_trace,
            system_info: SystemInfo::collect(),
            config_status,
            recent_logs,
            recovery_available,
        }
    }

    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        serde_json::to_string_pretty(self)
    }

    pub fn to_markdown(&self) -> String {
        let mut md = String::new();
        md.push_str("# Marcel SSH 崩溃报告\n\n");
        md.push_str(&format!("**报告ID**: {}\n\n", self.report_id));
        md.push_str(&format!("**时间**: {}\n\n", self.timestamp.format("%Y-%m-%d %H:%M:%S UTC")));
        md.push_str(&format!("**崩溃类型**: {}\n\n", self.crash_type));
        md.push_str(&format!("**错误信息**: {}\n\n", self.error_message));

        if let Some(ref trace) = self.stack_trace {
            md.push_str("## 堆栈跟踪\n\n```\n");
            md.push_str(trace);
            md.push_str("\n```\n\n");
        }

        md.push_str("## 系统信息\n\n");
        md.push_str(&format!("- **操作系统**: {} {}\n", self.system_info.os_name, self.system_info.os_version));
        md.push_str(&format!("- **架构**: {}\n", self.system_info.arch));
        md.push_str(&format!("- **应用版本**: {}\n", self.system_info.app_version));
        md.push_str(&format!("- **Rust版本**: {}\n\n", self.system_info.rust_version));

        md.push_str("## 配置文件状态\n\n");
        for config in &self.config_status {
            md.push_str(&format!("### {}\n", config.path));
            md.push_str(&format!("- **存在**: {}\n", if config.exists { "是" } else { "否" }));
            md.push_str(&format!("- **有效**: {}\n", if config.is_valid { "是" } else { "否" }));
            if let Some(ref err) = config.error_message {
                md.push_str(&format!("- **错误**: {}\n", err));
            }
            if let Some(size) = config.file_size {
                md.push_str(&format!("- **大小**: {} 字节\n", size));
            }
            if let Some(modified) = config.last_modified {
                md.push_str(&format!("- **修改时间**: {}\n", modified.format("%Y-%m-%d %H:%M:%S")));
            }
            md.push('\n');
        }

        if !self.recent_logs.is_empty() {
            md.push_str("## 最近日志\n\n```\n");
            for log in &self.recent_logs {
                md.push_str(log);
                md.push('\n');
            }
            md.push_str("```\n\n");
        }

        md.push_str(&format!("**恢复可用**: {}\n", if self.recovery_available { "是" } else { "否" }));

        md
    }

    pub fn save_to_file(&self, path: &std::path::Path) -> Result<(), std::io::Error> {
        let content = self.to_json().map_err(|e| {
            std::io::Error::new(std::io::ErrorKind::Other, e.to_string())
        })?;
        std::fs::write(path, content)
    }
}
