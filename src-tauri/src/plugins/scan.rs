use std::path::Path;

use crate::plugins::manifest::{PluginManifest, ToolKind};

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
        let plugin_dir = entry.path();
        let manifest_path = plugin_dir.join("plugin.json");
        let content = match std::fs::read_to_string(&manifest_path) {
            Ok(c) => c,
            Err(_) => continue,
        };
        let mut m: PluginManifest = match serde_json::from_str(&content) {
            Ok(m) => m,
            Err(e) => {
                log::warn!("插件 manifest 解析失败 {}: {}", manifest_path.display(), e);
                continue;
            }
        };

        if disabled.iter().any(|d| d == &m.id) {
            continue;
        }

        // Validate agent tools: drop any tool whose kind=local lacks a handler.
        // This keeps a single bad tool from breaking the whole plugin.
        let before = m.agent_tools.len();
        m.agent_tools.retain(|t| match t.validate() {
            Ok(()) => true,
            Err(reason) => {
                log::warn!("插件 {} 工具加载失败: {}", m.id, reason);
                false
            }
        });
        if m.agent_tools.len() < before {
            log::warn!(
                "插件 {} 跳过 {} 个无效工具（共 {} 个）",
                m.id,
                before - m.agent_tools.len(),
                before
            );
        }

        // Best-effort: warn (but do not block) if a declared systemPromptSection
        // file does not exist yet. The plugin still loads; the missing section
        // is simply skipped at prompt-build time.
        if let Some(rel) = m.system_prompt_section.as_ref() {
            let section_path = plugin_dir.join(rel);
            if !section_path.exists() {
                log::warn!(
                    "插件 {} 声明了 systemPromptSection={} 但文件不存在: {}",
                    m.id,
                    rel,
                    section_path.display()
                );
            }
        }

        result.push(m);
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

    fn write_manifest_with_tools(dir: &Path, id: &str, tools: serde_json::Value) {
        let manifest = serde_json::json!({
            "id": id,
            "version": "1.0.0",
            "name": id,
            "publisher": "test",
            "description": "",
            "capabilities": [],
            "views": [],
            "agentTools": tools
        });
        fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    }

    #[test]
    fn drops_local_tool_without_handler() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("plugins/bad-tool");
        fs::create_dir_all(&dir).unwrap();
        // kind=local but no handler → must be dropped, plugin still loads
        write_manifest_with_tools(
            &dir,
            "bad-tool",
            serde_json::json!([
                {"name": "broken", "description": "", "kind": "local"},
                {"name": "ok", "description": "", "kind": "ssh", "command": "echo hi"}
            ]),
        );

        let result = scan_plugins(tmp.path());
        assert_eq!(result.len(), 1);
        assert_eq!(
            result[0].agent_tools.len(),
            1,
            "only the valid ssh tool remains"
        );
        assert_eq!(result[0].agent_tools[0].name, "ok");
    }

    #[test]
    fn keeps_local_tool_with_handler() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("plugins/good-tool");
        fs::create_dir_all(&dir).unwrap();
        write_manifest_with_tools(
            &dir,
            "good-tool",
            serde_json::json!([
                {"name": "mem_save", "description": "", "kind": "local", "handler": "fs.append"}
            ]),
        );

        let result = scan_plugins(tmp.path());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].agent_tools.len(), 1);
        assert_eq!(
            result[0].agent_tools[0].handler.as_deref(),
            Some("fs.append")
        );
    }

    #[test]
    fn default_kind_ssh_backward_compat() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("plugins/legacy");
        fs::create_dir_all(&dir).unwrap();
        // No kind field → defaults to "ssh", must load normally
        write_manifest_with_tools(
            &dir,
            "legacy",
            serde_json::json!([
                {"name": "legacy_tool", "description": "", "command": "echo hi"}
            ]),
        );

        let result = scan_plugins(tmp.path());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].agent_tools.len(), 1);
        assert_eq!(result[0].agent_tools[0].kind, ToolKind::Ssh);
    }

    #[test]
    fn missing_system_prompt_section_file_warns_but_loads() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("plugins/missing-section");
        fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({
            "id": "missing-section",
            "version": "1.0.0",
            "name": "Missing Section",
            "systemPromptSection": "nonexistent.md"
        });
        fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();

        // Plugin still loads despite the missing section file
        let result = scan_plugins(tmp.path());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].id, "missing-section");
        assert_eq!(
            result[0].system_prompt_section.as_deref(),
            Some("nonexistent.md")
        );
    }
}
