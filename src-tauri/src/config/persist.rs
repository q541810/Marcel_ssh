use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use crate::error::AppError;

pub trait JsonPersistable: Sized + Serialize + for<'de> Deserialize<'de> + Default {
    fn default_filename() -> &'static str;

    fn default_file(config_dir: &Path) -> PathBuf {
        config_dir.join(Self::default_filename())
    }

    fn load_from_path(path: &Path) -> Result<Self, AppError> {
        if !path.exists() {
            return Ok(Self::default());
        }
        let content = std::fs::read_to_string(path)
            .map_err(|e| AppError::Config(format!("读取配置文件失败: {}", e)))?;
        if content.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str(&content)
            .map_err(|e| AppError::Config(format!("解析配置文件失败: {}", e)))
    }

    fn save_to_path(&self, path: &Path) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                AppError::Config(format!("创建配置目录失败: {}", e))
            })?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::Config(format!("序列化配置失败: {}", e)))?;
        std::fs::write(path, json)
            .map_err(|e| AppError::Config(format!("写入配置文件失败: {}", e)))?;
        Ok(())
    }
}
