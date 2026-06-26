use std::path::Path;

use crate::plugins::manifest::PluginManifest;

pub fn scan_plugins(config_dir: &Path) -> Vec<PluginManifest> {
    scan_plugins_filtered(config_dir, &[])
}

pub fn scan_plugins_filtered(config_dir: &Path, disabled: &[String]) -> Vec<PluginManifest> {
    let plugins_dir = config_dir.join("plugins");
    let mut result = vec![];

    let entries = match std::fs::read_dir(&plugins_dir) {
        Ok(e) => e,
        Err(_) => return result,
    };

    for entry in entries.flatten() {
        let manifest_path = entry.path().join("plugin.json");
        let content = match std::fs::read_to_string(&manifest_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        match serde_json::from_str::<PluginManifest>(&content) {
            Ok(m) => {
                if disabled.iter().any(|d| d == &m.id) {
                    continue;
                }
                result.push(m);
            }
            Err(e) => log::warn!(
                "插件 manifest 解析失败 {}: {}",
                manifest_path.display(),
                e
            ),
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_manifest(dir: &Path, id: &str, name: &str) {
        let manifest = serde_json::json!({
            "id": id,
            "version": "1.0.0",
            "name": name,
            "publisher": "test",
            "description": "",
            "capabilities": [],
            "views": [],
            "agentTools": []
        });
        fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    }

    #[test]
    fn returns_empty_when_plugins_dir_missing() {
        let tmp = TempDir::new().unwrap();
        let result = scan_plugins(tmp.path());
        assert!(result.is_empty());
    }

    #[test]
    fn skips_entries_without_manifest() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("plugins/no-manifest")).unwrap();
        let result = scan_plugins(tmp.path());
        assert!(result.is_empty());
    }

    #[test]
    fn skips_entries_with_invalid_manifest() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("plugins/bad");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("plugin.json"), "not valid json").unwrap();
        let result = scan_plugins(tmp.path());
        assert!(result.is_empty());
    }

    #[test]
    fn scans_valid_manifests() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("plugins");
        let a = base.join("plug-a");
        let b = base.join("plug-b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        write_manifest(&a, "plug-a", "Plugin A");
        write_manifest(&b, "plug-b", "Plugin B");

        let mut result = scan_plugins(tmp.path());
        result.sort_by(|x, y| x.id.cmp(&y.id));
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].id, "plug-a");
        assert_eq!(result[1].id, "plug-b");
    }

    #[test]
    fn filters_out_disabled_plugins() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("plugins");
        let a = base.join("plug-a");
        let b = base.join("plug-b");
        fs::create_dir_all(&a).unwrap();
        fs::create_dir_all(&b).unwrap();
        write_manifest(&a, "plug-a", "Plugin A");
        write_manifest(&b, "plug-b", "Plugin B");

        let result = scan_plugins_filtered(tmp.path(), &["plug-a".to_string()]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "plug-b");
    }

    #[test]
    fn scan_plugins_passes_empty_disabled_list() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("plugins/p");
        fs::create_dir_all(&dir).unwrap();
        write_manifest(&dir, "p", "P");

        let result = scan_plugins(tmp.path());
        assert_eq!(result.len(), 1);
    }
}
