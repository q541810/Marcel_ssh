use std::path::{Path, PathBuf};
use std::fs;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::config::settings::AppSettings;
use crate::config::connections::ConnectionStore;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigBackup {
    pub path: PathBuf,
    pub backup_path: PathBuf,
    pub created_at: DateTime<Utc>,
    pub size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigRecovery {
    pub config_dir: PathBuf,
    pub backups: Vec<ConfigBackup>,
}

impl ConfigRecovery {
    const BACKUP_DIR: &'static str = "backups";
    const MAX_BACKUPS: usize = 10;

    pub fn new(config_dir: &Path) -> Self {
        let backup_dir = config_dir.join(Self::BACKUP_DIR);
        let backups = Self::load_backup_list(&backup_dir);
        
        Self {
            config_dir: config_dir.to_path_buf(),
            backups,
        }
    }

    fn load_backup_list(backup_dir: &Path) -> Vec<ConfigBackup> {
        if !backup_dir.exists() {
            return Vec::new();
        }

        let mut backups = Vec::new();
        if let Ok(entries) = fs::read_dir(backup_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().map_or(false, |ext| ext == "bak") {
                    if let Ok(metadata) = entry.metadata() {
                        let created_at = metadata.modified()
                            .ok()
                            .and_then(|t| DateTime::from_timestamp(
                                t.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64, 0
                            ))
                            .unwrap_or_else(Utc::now);

                        let original_name = path.file_name()
                            .and_then(|n| n.to_str())
                            .and_then(|n| n.strip_suffix(".bak"))
                            .and_then(|n| n.strip_suffix(|c: char| c.is_numeric() || c == '-' || c == 'T'))
                            .unwrap_or("unknown");

                        backups.push(ConfigBackup {
                            path: PathBuf::from(original_name),
                            backup_path: path,
                            created_at,
                            size: metadata.len(),
                        });
                    }
                }
            }
        }

        backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        backups
    }

    pub fn create_backup(&self, file_name: &str) -> Result<PathBuf, String> {
        let source_path = self.config_dir.join(file_name);
        if !source_path.exists() {
            return Err(format!("配置文件不存在: {}", file_name));
        }

        let backup_dir = self.config_dir.join(Self::BACKUP_DIR);
        fs::create_dir_all(&backup_dir)
            .map_err(|e| format!("创建备份目录失败: {}", e))?;

        let timestamp = Utc::now().format("%Y-%m-%dT%H-%M-%S");
        let backup_name = format!("{}-{}.bak", file_name, timestamp);
        let backup_path = backup_dir.join(&backup_name);

        fs::copy(&source_path, &backup_path)
            .map_err(|e| format!("创建备份失败: {}", e))?;

        log::info!("已创建配置备份: {}", backup_path.display());
        Ok(backup_path)
    }

    pub fn restore_backup(&self, backup_path: &Path) -> Result<(), String> {
        let file_name = backup_path.file_name()
            .and_then(|n| n.to_str())
            .and_then(|n| n.split('-').next())
            .ok_or("无法解析备份文件名")?;

        let target_path = self.config_dir.join(file_name);

        self.create_backup(file_name).ok();

        fs::copy(backup_path, &target_path)
            .map_err(|e| format!("恢复备份失败: {}", e))?;

        log::info!("已从备份恢复: {} -> {}", backup_path.display(), target_path.display());
        Ok(())
    }

    pub fn cleanup_old_backups(&self) {
        let backup_dir = self.config_dir.join(Self::BACKUP_DIR);
        if !backup_dir.exists() {
            return;
        }

        let mut backups: Vec<_> = fs::read_dir(&backup_dir)
            .ok()
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.path().extension().map_or(false, |ext| ext == "bak"))
            .collect();

        backups.sort_by(|a, b| {
            b.metadata().and_then(|m| m.modified()).ok()
                .cmp(&a.metadata().and_then(|m| m.modified()).ok())
        });

        for old_backup in backups.into_iter().skip(Self::MAX_BACKUPS) {
            if let Err(e) = fs::remove_file(old_backup.path()) {
                log::warn!("删除旧备份失败: {}", e);
            }
        }
    }

    pub fn validate_settings(&self) -> Result<AppSettings, String> {
        let path = AppSettings::default_file(&self.config_dir);
        if !path.exists() {
            return Ok(AppSettings::default());
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取设置文件失败: {}", e))?;

        if content.trim().is_empty() {
            return Ok(AppSettings::default());
        }

        serde_json::from_str(&content)
            .map_err(|e| format!("设置文件格式错误: {}", e))
    }

    pub fn validate_connections(&self) -> Result<ConnectionStore, String> {
        let path = ConnectionStore::default_file(&self.config_dir);
        if !path.exists() {
            return Ok(ConnectionStore::new());
        }

        let content = fs::read_to_string(&path)
            .map_err(|e| format!("读取连接配置失败: {}", e))?;

        if content.trim().is_empty() {
            return Ok(ConnectionStore::new());
        }

        serde_json::from_str(&content)
            .map_err(|e| format!("连接配置格式错误: {}", e))
    }

    pub fn repair_settings(&self) -> Result<(), String> {
        self.create_backup("settings.json")?;

        let default_settings = AppSettings::default();
        default_settings.save_to_path(&AppSettings::default_file(&self.config_dir))
            .map_err(|e| format!("保存默认设置失败: {}", e))?;

        log::info!("已修复设置文件");
        Ok(())
    }

    pub fn repair_connections(&self) -> Result<(), String> {
        self.create_backup("connections.json")?;

        let empty_store = ConnectionStore::new();
        empty_store.save_to_path(&ConnectionStore::default_file(&self.config_dir))
            .map_err(|e| format!("保存空连接配置失败: {}", e))?;

        log::info!("已修复连接配置文件");
        Ok(())
    }

    pub fn get_backups_for_file(&self, file_name: &str) -> Vec<&ConfigBackup> {
        self.backups.iter()
            .filter(|b| b.path.to_str().map_or(false, |p| p == file_name))
            .collect()
    }
}
