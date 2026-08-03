//! Plugin install / uninstall.
//!
//! `plugin_install` downloads a plugin's GitHub source archive (mirror-first,
//! see `commands::market`), extracts it with zip-slip protection into
//! `<config>/plugins/<id>/`, and refreshes the registry.
//!
//! The frontend intentionally does **not** auto-refresh after install /
//! uninstall (a restart guarantees a clean, consistent plugin runtime), so
//! these commands only update the backend registry — they do not emit
//! `plugin-registry-changed`. The plugin becomes fully loaded after an app
//! restart.
//!
//! `plugin_uninstall` removes the plugin directory and cleans up settings
//! residue (`disabled_plugins` / `authorized_capabilities`).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::commands::market::{download_first, github_repo_parts, zip_urls};
use crate::config::persist::JsonPersistable;
use crate::config::settings::AppSettings;
use crate::error::AppError;
use crate::plugins::manifest::PluginManifest;
use crate::AppState;

/// 解压后内容总大小上限（防 zip bomb）。
const MAX_EXTRACT_BYTES: u64 = 300 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInstallResult {
    pub id: String,
    pub name: String,
    pub version: String,
    /// 安装后前端不自动刷新插件列表，重启应用后完整生效。
    pub restart_required: bool,
}

/// 插件 id 合法字符：字母、数字、连字符、下划线
/// （与插件目录命名约定一致，同时排除 `.`/`..` 穿越风险）。
fn validate_plugin_id(id: &str) -> Result<(), AppError> {
    if id.is_empty() {
        return Err(AppError::Other("插件 id 为空".into()));
    }
    if !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(AppError::Other(format!("插件 id 含非法字符: {}", id)));
    }
    Ok(())
}

/// 将 zip 条目路径规范化为安全相对路径：拒绝绝对路径、Windows 盘符、
/// `..` 穿越。`\` 统一转 `/`；空段与 `.` 段跳过。
fn sanitize_zip_path(name: &str) -> Result<PathBuf, String> {
    let norm = name.replace('\\', "/");
    if norm.starts_with('/') {
        return Err(format!("绝对路径: {}", name));
    }
    let bytes = norm.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' {
        return Err(format!("盘符路径: {}", name));
    }
    let mut parts = Vec::new();
    for seg in norm.split('/') {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            return Err(format!("路径穿越: {}", name));
        }
        parts.push(seg);
    }
    if parts.is_empty() {
        return Err(format!("空路径: {}", name));
    }
    Ok(parts.join("/").into())
}

/// 解压 zip 到 dest：全程路径穿越防护 + 解压总量限制。
fn extract_zip_archive(bytes: &[u8], dest: &Path) -> Result<(), AppError> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|e| AppError::Other(format!("zip 解析失败: {}", e)))?;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| AppError::Other(format!("zip 条目读取失败: {}", e)))?;
        let rel = sanitize_zip_path(entry.name())
            .map_err(|e| AppError::Other(format!("zip 条目路径非法（{}）: {}", entry.name(), e)))?;
        let out = dest.join(&rel);

        if entry.is_dir() {
            std::fs::create_dir_all(&out)
                .map_err(|e| AppError::Other(format!("创建目录失败 {}: {}", out.display(), e)))?;
            continue;
        }

        total += entry.size();
        if total > MAX_EXTRACT_BYTES {
            return Err(AppError::Other("压缩包解压后超过大小上限".into()));
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Other(format!("创建目录失败 {}: {}", parent.display(), e)))?;
        }
        let mut file = std::fs::File::create(&out)
            .map_err(|e| AppError::Other(format!("写入文件失败 {}: {}", out.display(), e)))?;
        std::io::copy(&mut entry, &mut file)
            .map_err(|e| AppError::Other(format!("解压失败 {}: {}", out.display(), e)))?;
    }
    Ok(())
}

/// GitHub archive zip 通常带一层 `{repo}-{branch}/` 根目录：若解压目录下
/// 只有一个子目录且没有直接文件，则使用该子目录作为插件根。
fn find_plugin_root(extract_dir: &Path) -> Result<PathBuf, AppError> {
    let mut dirs = Vec::new();
    let mut file_count = 0u32;
    for entry in std::fs::read_dir(extract_dir)
        .map_err(|e| AppError::Other(format!("读取临时目录失败: {}", e)))?
    {
        let entry = entry
            .map_err(|e| AppError::Other(format!("读取临时目录条目失败: {}", e)))?;
        let p = entry.path();
        if p.is_dir() {
            dirs.push(p);
        } else {
            file_count += 1;
        }
    }
    if file_count == 0 && dirs.len() == 1 {
        Ok(dirs.remove(0))
    } else {
        Ok(extract_dir.to_path_buf())
    }
}

/// 递归复制目录（跨卷 rename 失败时的回退方案）。
fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if from.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 从已下载的 zip 字节安装插件：解压 → 校验 manifest → 移入插件目录。
/// 纯函数（不依赖 Tauri 运行时），可单测。返回 (id, name, version)。
fn install_from_archive(
    bytes: &[u8],
    config_dir: &Path,
    tmp_dir: &Path,
) -> Result<(String, String, String), AppError> {
    std::fs::create_dir_all(tmp_dir)
        .map_err(|e| AppError::Other(format!("创建临时目录失败: {}", e)))?;
    let result = (|| -> Result<(String, String, String), AppError> {
        extract_zip_archive(bytes, tmp_dir)?;
        let root = find_plugin_root(tmp_dir)?;

        let manifest_path = root.join("plugin.json");
        let content = std::fs::read_to_string(&manifest_path)
            .map_err(|_| AppError::Other("压缩包内缺少 plugin.json".into()))?;
        let manifest: PluginManifest = serde_json::from_str(&content)
            .map_err(|e| AppError::Other(format!("plugin.json 解析失败: {}", e)))?;
        validate_plugin_id(&manifest.id)?;

        let plugins_dir = config_dir.join("plugins");
        let target = plugins_dir.join(&manifest.id);
        if target.exists() {
            return Err(AppError::Other(format!(
                "插件 {} 已安装，请先卸载再安装",
                manifest.id
            )));
        }
        std::fs::create_dir_all(&plugins_dir)
            .map_err(|e| AppError::Other(format!("创建插件目录失败: {}", e)))?;
        // 优先 rename（同卷原子）；跨卷回退复制。
        if std::fs::rename(&root, &target).is_err() {
            copy_dir_recursive(&root, &target)
                .map_err(|e| AppError::Other(format!("安装插件失败: {}", e)))?;
            std::fs::remove_dir_all(&root).ok();
        }
        Ok((
            manifest.id.clone(),
            manifest.name.clone(),
            manifest.version.clone(),
        ))
    })();
    std::fs::remove_dir_all(tmp_dir).ok();
    result
}

/// Download a plugin's source archive (mirror-first) and install it into the
/// plugins directory. Rejects if a plugin with the same id already exists.
#[tauri::command]
pub async fn plugin_install(
    app: AppHandle,
    state: State<'_, AppState>,
    repo_url: String,
    mirror: Option<String>,
) -> Result<PluginInstallResult, AppError> {
    let Some((owner, repo)) = github_repo_parts(&repo_url) else {
        return Err(AppError::Other("非 GitHub 仓库无法自动安装".into()));
    };

    let urls = zip_urls(&owner, &repo, mirror.as_deref());
    let bytes = download_first(&urls)
        .await
        .map_err(|e| AppError::Network(format!("插件下载失败: {}", e)))?;

    let config_dir = state.config_dir.clone();
    let tmp_dir = std::env::temp_dir().join(format!("marcel-plugin-{}", uuid::Uuid::new_v4()));

    let installed = tokio::task::spawn_blocking(move || install_from_archive(&bytes, &config_dir, &tmp_dir))
        .await
        .map_err(|e| AppError::Other(format!("安装线程异常: {}", e)))?
    ?;

    // 更新 registry（内存与磁盘保持一致，已卸载插件实时从后端移除），
    // 但不 emit `plugin-registry-changed`——前端不自动刷新，重启后生效。
    let config_dir = state.config_dir.clone();
    let settings = state.settings.read().await.clone();
    let app_version = app.package_info().version.to_string();
    {
        let mut reg = state.plugin_registry.write().await;
        reg.reload(&config_dir, &settings, &app_version).await;
    }

    Ok(PluginInstallResult {
        id: installed.0,
        name: installed.1,
        version: installed.2,
        restart_required: true,
    })
}

/// Remove an installed plugin (directory + settings residue). The frontend
/// does not auto-refresh after this — the plugin's runtime is fully gone
/// after an app restart.
#[tauri::command]
pub async fn plugin_uninstall(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
) -> Result<(), AppError> {
    validate_plugin_id(&plugin_id)?;

    let config_dir = state.config_dir.clone();
    let target = config_dir.join("plugins").join(&plugin_id);
    if !target.exists() {
        return Err(AppError::Other(format!("插件 {} 未安装", plugin_id)));
    }

    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&target))
        .await
        .map_err(|e| AppError::Other(format!("删除线程异常: {}", e)))?
        .map_err(|e| AppError::Other(format!("删除插件目录失败: {}", e)))?;

    // 清理设置残留（disabled_plugins / authorized_capabilities）并用更新后
    // 的快照 reload registry。落盘失败不阻断（内存已更新，下次保存设置会
    // 补齐；残留记录对功能无影响，也不主动触发云同步）。
    let updated_settings = {
        let mut settings = state.settings.write().await;
        settings.disabled_plugins.retain(|id| id != &plugin_id);
        settings.authorized_capabilities.remove(&plugin_id);
        settings.clone()
    };

    let app_version = app.package_info().version.to_string();
    {
        let mut reg = state.plugin_registry.write().await;
        reg.reload(&config_dir, &updated_settings, &app_version).await;
    }

    let path = AppSettings::default_file(&config_dir);
    if let Err(e) = tokio::task::block_in_place(|| updated_settings.save_to_path(&path)) {
        log::warn!("卸载后设置落盘失败（残留无害，下次保存设置会补齐）: {}", e);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;
    use tempfile::TempDir;

    fn make_zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut writer = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let options = zip::write::SimpleFileOptions::default();
            for (name, content) in files {
                writer.start_file(*name, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        buf
    }

    #[test]
    fn validates_plugin_ids() {
        assert!(validate_plugin_id("long-term-memory").is_ok());
        assert!(validate_plugin_id("marcel_pet2").is_ok());
        assert!(validate_plugin_id("").is_err());
        assert!(validate_plugin_id("..").is_err());
        assert!(validate_plugin_id("a/b").is_err());
        assert!(validate_plugin_id("a b").is_err());
        assert!(validate_plugin_id(".hidden").is_err());
        assert!(validate_plugin_id("中文").is_err());
    }

    #[test]
    fn sanitizes_zip_paths() {
        assert_eq!(
            sanitize_zip_path("repo-main/plugin.json").unwrap(),
            PathBuf::from("repo-main/plugin.json")
        );
        assert_eq!(
            sanitize_zip_path("repo-main/").unwrap(),
            PathBuf::from("repo-main")
        );
        assert_eq!(
            sanitize_zip_path("a\\b\\c.txt").unwrap(),
            PathBuf::from("a/b/c.txt")
        );
        assert!(sanitize_zip_path("../evil").is_err());
        assert!(sanitize_zip_path("a/../../evil").is_err());
        assert!(sanitize_zip_path("/abs/path").is_err());
        assert!(sanitize_zip_path("C:/evil").is_err());
        assert!(sanitize_zip_path("C:\\evil").is_err());
        assert!(sanitize_zip_path("").is_err());
    }

    #[test]
    fn extracts_zip_with_protection() {
        let tmp = TempDir::new().unwrap();
        let zip = make_zip(&[
            ("plug-main/plugin.json", "{}"),
            ("plug-main/index.html", "<html></html>"),
        ]);
        extract_zip_archive(&zip, tmp.path()).unwrap();
        assert!(tmp.path().join("plug-main/plugin.json").exists());
        assert!(tmp.path().join("plug-main/index.html").exists());

        // 路径穿越条目必须被拒绝，且不产生越界文件
        let evil = make_zip(&[
            ("plug-main/plugin.json", "{}"),
            ("../escaped.txt", "evil"),
        ]);
        assert!(extract_zip_archive(&evil, tmp.path()).is_err());
        assert!(!tmp.path().parent().unwrap().join("escaped.txt").exists());
    }

    #[test]
    fn finds_plugin_root() {
        let tmp = TempDir::new().unwrap();
        // 单根目录（GitHub archive 形态）
        fs::create_dir_all(tmp.path().join("repo-main")).unwrap();
        let root = find_plugin_root(tmp.path()).unwrap();
        assert_eq!(root, tmp.path().join("repo-main"));

        // 多目录 + 直接文件：用解压目录本身
        fs::create_dir_all(tmp.path().join("second")).unwrap();
        let root = find_plugin_root(tmp.path()).unwrap();
        assert_eq!(root, tmp.path());
    }

    #[test]
    fn installs_plugin_from_archive() {
        let config = TempDir::new().unwrap();
        let tmp = TempDir::new().unwrap();
        let zip = make_zip(&[
            ("plug-main/plugin.json", r#"{"id":"plug-a","version":"1.0.0","name":"A","capabilities":[],"views":[],"agentTools":[]}"#),
            ("plug-main/index.html", "<html></html>"),
        ]);
        let (id, name, _ver) =
            install_from_archive(&zip, config.path(), &tmp.path().join("work")).unwrap();
        assert_eq!(id, "plug-a");
        assert_eq!(name, "A");
        assert!(config.path().join("plugins/plug-a/index.html").exists());
        // 剥离了 GitHub archive 根目录层
        assert!(!config.path().join("plugins/plug-a/plug-main").exists());
        // 临时目录已清理
        assert!(!tmp.path().join("work").exists());
    }

    #[test]
    fn install_rejects_already_installed() {
        let config = TempDir::new().unwrap();
        let plugins_dir = config.path().join("plugins");
        fs::create_dir_all(plugins_dir.join("plug-a")).unwrap();
        let tmp = TempDir::new().unwrap();
        let zip = make_zip(&[(
            "plug-main/plugin.json",
            r#"{"id":"plug-a","version":"1.0.0","name":"A","capabilities":[],"views":[],"agentTools":[]}"#,
        )]);
        let err = install_from_archive(&zip, config.path(), &tmp.path().join("work")).unwrap_err();
        assert!(err.to_string().contains("已安装"));
    }

    #[test]
    fn install_rejects_missing_manifest() {
        let config = TempDir::new().unwrap();
        let tmp = TempDir::new().unwrap();
        let zip = make_zip(&[("plug-main/index.html", "<html></html>")]);
        let err = install_from_archive(&zip, config.path(), &tmp.path().join("work")).unwrap_err();
        assert!(err.to_string().contains("缺少 plugin.json"));
    }

    #[test]
    fn install_rejects_invalid_plugin_id() {
        let config = TempDir::new().unwrap();
        let tmp = TempDir::new().unwrap();
        let zip = make_zip(&[(
            "plug-main/plugin.json",
            r#"{"id":"../evil","version":"1.0.0","name":"E","capabilities":[],"views":[],"agentTools":[]}"#,
        )]);
        let err = install_from_archive(&zip, config.path(), &tmp.path().join("work")).unwrap_err();
        assert!(err.to_string().contains("非法字符"));
        assert!(!config.path().join("plugins").exists());
    }
}
