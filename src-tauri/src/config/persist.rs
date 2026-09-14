use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub trait JsonPersistable: Sized + Serialize + for<'de> Deserialize<'de> + Default {
    fn default_filename() -> &'static str;

    fn default_file(config_dir: &Path) -> PathBuf {
        config_dir.join(Self::default_filename())
    }

    /// 只做「读文件 + serde 解析」，**不含任何迁移/归一化**。
    ///
    /// 需要按原始内容迁移的配置（例如要区分「字段缺失」与「字段显式等于默认值」）
    /// 覆盖 `load_from_path` 时先调用它，再拿原始文本做迁移。
    fn load_parsed(path: &Path) -> Result<Self, AppError> {
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

    fn load_from_path(path: &Path) -> Result<Self, AppError> {
        Self::load_parsed(path)
    }

    fn save_to_path(&self, path: &Path) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Config(format!("创建配置目录失败: {}", e)))?;
        }
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| AppError::Config(format!("序列化配置失败: {}", e)))?;
        atomic_write(path, &json).map_err(|e| AppError::Config(format!("写入配置文件失败: {}", e)))
    }
}

/// Atomic write: tmp + fsync + rename.
///
/// Writes `content` to `<path>.tmp`, calls `sync_all`, then renames the
/// tmp file to `path`. On Unix also syncs the parent directory.  If
/// anything fails the tmp file is cleaned up.
pub fn atomic_write(path: &Path, content: &str) -> Result<(), std::io::Error> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let mut tmp_name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("tmpfile"));
    tmp_name.push(".tmp");
    let tmp = path.with_file_name(tmp_name);

    let write_res = (|| -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        Ok(())
    })();

    if let Err(e) = write_res {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }

    #[cfg(unix)]
    if let Some(parent) = path.parent() {
        if let Ok(dir) = std::fs::File::open(parent) {
            let _ = dir.sync_all();
        }
    }

    Ok(())
}
