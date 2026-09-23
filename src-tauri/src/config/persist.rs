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

/// 进程内 tmp 序号（见 [`tmp_path_for`] 的唯一性说明）。
static TMP_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// 给 `path` 生成本次写入专用的 tmp 路径。
///
/// tmp 名**必须唯一**：同一路径的两次并发保存若共用一个固定 `<name>.tmp`，
/// 会互相截断（`truncate(true)` 把对手已写的字节清零）并抢同一个 rename 源
/// （一方 rename 走后另一方报「文件不存在」，把一次成功保存误判成失败）。
/// pid 区分进程，进程内序号区分并发调用；字面量只用数字与 `.`，Windows 合法。
fn tmp_path_for(path: &Path) -> PathBuf {
    let mut tmp_name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_else(|| std::ffi::OsString::from("tmpfile"));
    tmp_name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        TMP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ));
    path.with_file_name(tmp_name)
}

/// Atomic write: tmp + fsync + rename.
///
/// Writes `content` to a uniquely-named sibling tmp file (see [`tmp_path_for`]),
/// calls `sync_all`, then renames the tmp file to `path`. On Unix also syncs the
/// parent directory. If anything fails the tmp file is cleaned up and the error
/// is returned (调用方依赖这个失败语义，例如作业台账只管记一条 warn)。
pub fn atomic_write(path: &Path, content: &str) -> Result<(), std::io::Error> {
    use std::io::Write;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let tmp = tmp_path_for(path);

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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "marcel-atomic-write-{}-{}",
            tag,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// 并发写同一路径：每次都必须是「某一次写入的完整内容」，且不留 tmp 残渣。
    ///
    /// 共用固定 `<name>.tmp` 时这条会红：两个写者互相 truncate/抢 rename 源，
    /// 结果是内容混成半截、或一方拿到「文件不存在」的错误。
    #[test]
    fn concurrent_writes_to_same_path_keep_last_content_intact() {
        // 大内容让两次写入的重叠窗口足够长，旧实现的错乱才稳定可见
        let payload_a = "A".repeat(512 * 1024);
        let payload_b = format!("{}{}", "B".repeat(256 * 1024), "1".repeat(256 * 1024));
        assert_eq!(payload_a.len(), payload_b.len());

        let dir = temp_dir("concurrent");
        let path = dir.join("settings.json");

        std::thread::scope(|scope| {
            let handles: Vec<_> = [payload_a.clone(), payload_b.clone()]
                .into_iter()
                .map(|payload| {
                    let path = path.clone();
                    scope.spawn(move || {
                        let mut results = Vec::new();
                        for _ in 0..8 {
                            results.push(atomic_write(&path, &payload).map_err(|e| e.to_string()));
                        }
                        results
                    })
                })
                .collect();

            for handle in handles {
                for result in handle.join().expect("写线程不得 panic") {
                    assert!(result.is_ok(), "并发保存不得失败: {:?}", result.err());
                }
            }
        });

        let final_content = std::fs::read_to_string(&path).expect("目标文件必须存在");
        assert!(
            final_content == payload_a || final_content == payload_b,
            "落盘内容必须是某一次写入的完整内容（长度 {}，期望 {}）",
            final_content.len(),
            payload_a.len()
        );
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不得残留 tmp 文件: {:?}", leftovers);
    }

    /// 每次调用用的 tmp 路径互不相同（这就是并发安全的根据）。
    #[test]
    fn tmp_names_are_unique_per_call() {
        let mut names = std::collections::HashSet::new();
        for _ in 0..64 {
            names.insert(tmp_path_for(Path::new("C:/tmp/settings.json")));
        }
        assert_eq!(names.len(), 64, "同一路径的 tmp 名必须互不相同");
    }

    /// 失败仍返回 Err 并清掉自己的 tmp（台账等调用方依赖的失败语义：
    /// 失败即返回 Err，临时文件不留在配置目录里）。
    #[test]
    fn failed_write_returns_err_and_cleans_up_tmp() {
        let dir = temp_dir("failure");
        // 目标路径已存在且是个目录：tmp 写得下去，rename 必然失败
        let target = dir.join("settings.json");
        std::fs::create_dir(&target).unwrap();

        let err = atomic_write(&target, "{}").expect_err("rename 失败必须报错");
        assert!(!err.to_string().is_empty());
        let leftovers: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|name| name.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "不得残留 tmp 文件: {:?}", leftovers);
    }
}
