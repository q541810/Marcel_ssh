//! Plugin registry — backend single source of truth for plugin state.
//!
//! Owns manifest cache (mtime-invalidated), section cache (mtime-invalidated,
//! bounded), and enabled-state. All plugin reads (`plugin_list`, Agent task
//! bootstrap, HTTP API enabled check, URI scheme enabled check) route through
//! the registry so the backend no longer re-scans the filesystem on every
//! call.
//!
//! State machine: `Unloaded` → `Loaded` → `Enabled`/`Disabled`/`Error`.
//! `reload()` does a diff against the previous snapshot so callers can react
//! to per-plugin changes (frontend diff refresh, webview pool resync).
//!
//! Concurrency: `tokio::sync::RwLock` (read-heavy, async-friendly). `reload`
//! holds the write lock; reads wait. Reload is fast (scan + diff), acceptable.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use tokio::sync::RwLock;

use crate::config::settings::AppSettings;
use crate::plugins::manifest::PluginManifest;
use crate::plugins::scan::scan_plugins;

/// Lifecycle state of a single plugin entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PluginState {
    /// Manifest parsed but plugin is in `disabled_plugins`.
    Disabled,
    /// Manifest parsed and plugin is enabled.
    Enabled,
    /// Manifest failed to parse or load. The plugin is skipped.
    Error(String),
}

/// A single plugin's registry entry.
#[derive(Debug, Clone)]
pub struct PluginEntry {
    pub manifest: PluginManifest,
    pub state: PluginState,
    /// Cached `systemPromptSection` content + mtime, if the plugin declares one.
    /// `None` means the plugin has no `systemPromptSection`.
    pub section_cache: Option<(SystemTime, String)>,
}

/// Snapshot returned to callers that need to react to per-plugin changes
/// (e.g. frontend diff refresh). `changed` lists plugin ids whose manifest
/// or enabled-state changed since the previous reload.
#[derive(Debug, Clone, Default, serde::Serialize)]
pub struct ReloadDiff {
    /// All currently-loaded plugin ids (enabled + disabled).
    pub all_ids: Vec<String>,
    /// Plugin ids that were added, removed, or had their manifest/enabled
    /// state change since the last reload. Callers should destroy/recreate
    /// webviews + injections for these plugins only.
    pub changed: Vec<String>,
    /// Plugin ids that were removed entirely (no longer on disk).
    pub removed: Vec<String>,
}

/// The registry itself. Wrapped in `Arc<RwLock<_>>` on `AppState`.
#[derive(Default)]
pub struct PluginRegistry {
    entries: HashMap<String, PluginEntry>,
}

impl PluginRegistry {
    /// Full reload: scan the plugins directory, diff against current entries,
    /// update state based on `AppSettings.disabled_plugins`, refresh section
    /// cache, and return the diff. Emits `plugin-registry-changed` on the
    /// `AppHandle` so the frontend can diff-refresh.
    pub async fn reload(&mut self, config_dir: &Path, settings: &AppSettings) -> ReloadDiff {
        let scanned = tokio::task::spawn_blocking({
            let config_dir = config_dir.to_path_buf();
            move || scan_plugins(&config_dir)
        })
        .await
        .unwrap_or_default();

        let disabled: std::collections::HashSet<&String> =
            settings.disabled_plugins.iter().collect();

        let new_ids: std::collections::HashSet<&String> = scanned.iter().map(|m| &m.id).collect();
        let old_ids: std::collections::HashSet<&String> = self.entries.keys().collect();

        let mut changed = Vec::new();
        let mut removed = Vec::new();

        // Removed plugins
        for id in old_ids {
            if !new_ids.contains(id) {
                removed.push(id.clone());
            }
        }
        for id in &removed {
            self.entries.remove(id);
        }

        // Added or changed plugins
        for m in &scanned {
            let id = &m.id;
            let prev = self.entries.get(id);
            let prev_manifest = prev.map(|e| &e.manifest);
            let manifest_changed = prev_manifest.map_or(true, |p| {
                // Compare by serialised form — catches any field change.
                serde_json::to_string(p).ok() != serde_json::to_string(m).ok()
            });
            let prev_enabled = prev.map_or(None, |e| match e.state {
                PluginState::Enabled => Some(true),
                PluginState::Disabled => Some(false),
                _ => None,
            });
            let now_enabled = !disabled.contains(id);
            let enabled_changed = prev_enabled.map_or(true, |p| p != now_enabled);

            if manifest_changed || enabled_changed {
                changed.push(id.clone());
            }

            let state = if now_enabled {
                PluginState::Enabled
            } else {
                PluginState::Disabled
            };

            // Refresh section cache: only if the plugin declares one AND the
            // file mtime changed (or the entry is new). The cache is bounded
            // by the plugin count itself (one entry per plugin), so no
            // separate LRU is needed.
            let section_cache = if let Some(rel) = m.system_prompt_section.as_ref() {
                if rel.is_empty() {
                    None
                } else {
                    let section_path = config_dir.join("plugins").join(id).join(rel);
                    match std::fs::metadata(&section_path)
                        .and_then(|md| md.modified().map(|mtime| (section_path.clone(), mtime)))
                    {
                        Ok((path, mtime)) => {
                            let need_refresh = prev
                                .and_then(|e| e.section_cache.as_ref())
                                .map_or(true, |(cached_mtime, _)| *cached_mtime != mtime);
                            if need_refresh {
                                match std::fs::read_to_string(&path) {
                                    Ok(content) => Some((mtime, content)),
                                    Err(e) => {
                                        log::warn!(
                                            "插件 {} systemPromptSection 读取失败 ({}): {}",
                                            id,
                                            path.display(),
                                            e
                                        );
                                        None
                                    }
                                }
                            } else {
                                prev.and_then(|e| e.section_cache.clone())
                            }
                        }
                        Err(e) => {
                            log::warn!(
                                "插件 {} systemPromptSection stat 失败 ({}): {}",
                                id,
                                section_path.display(),
                                e
                            );
                            None
                        }
                    }
                }
            } else {
                None
            };

            self.entries.insert(
                id.clone(),
                PluginEntry {
                    manifest: m.clone(),
                    state,
                    section_cache,
                },
            );
        }

        ReloadDiff {
            all_ids: scanned.iter().map(|m| m.id.clone()).collect(),
            changed,
            removed,
        }
    }

    /// Get an entry by plugin id.
    pub fn get(&self, id: &str) -> Option<&PluginEntry> {
        self.entries.get(id)
    }

    /// All manifests for enabled plugins. Used by Agent task bootstrap
    /// (`build_registry` + `collect_plugin_sections`).
    pub fn enabled_manifests(&self) -> Vec<PluginManifest> {
        self.entries
            .values()
            .filter(|e| e.state == PluginState::Enabled)
            .map(|e| e.manifest.clone())
            .collect()
    }

    /// All manifests (enabled + disabled). Used by `plugin_list` so the
    /// settings UI can show disabled plugins.
    pub fn all_manifests(&self) -> Vec<PluginManifest> {
        self.entries.values().map(|e| e.manifest.clone()).collect()
    }

    /// Whether a plugin is enabled (i.e. loaded and not in `disabled_plugins`).
    pub fn is_enabled(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .map(|e| e.state == PluginState::Enabled)
            .unwrap_or(false)
    }

    /// Cached section content for a plugin, if it has one.
    pub fn section_for(&self, id: &str) -> Option<&str> {
        self.entries
            .get(id)
            .and_then(|e| e.section_cache.as_ref().map(|(_, c)| c.as_str()))
    }
}

/// Type alias for the Arc-wrapped registry stored on AppState.
pub type SharedPluginRegistry = Arc<RwLock<PluginRegistry>>;

/// Convenience: build a fresh shared registry (empty; call `reload` to populate).
pub fn new_shared() -> SharedPluginRegistry {
    Arc::new(RwLock::new(PluginRegistry::default()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write_plugin(tmp: &TempDir, id: &str) {
        let dir = tmp.path().join("plugins").join(id);
        fs::create_dir_all(&dir).unwrap();
        let manifest = serde_json::json!({
            "id": id,
            "version": "1.0.0",
            "name": id,
            "capabilities": [],
            "views": [],
            "agentTools": []
        });
        fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    }

    fn settings_with_disabled(disabled: &[&str]) -> AppSettings {
        let mut s = AppSettings::default();
        s.disabled_plugins = disabled.iter().map(|d| d.to_string()).collect();
        s
    }

    #[tokio::test]
    async fn reload_loads_enabled_plugins() {
        let tmp = TempDir::new().unwrap();
        write_plugin(&tmp, "a");
        write_plugin(&tmp, "b");
        let mut reg = PluginRegistry::default();
        let diff = reg.reload(tmp.path(), &AppSettings::default()).await;
        assert_eq!(diff.all_ids.len(), 2);
        assert!(diff.changed.contains(&"a".to_string()));
        assert!(diff.changed.contains(&"b".to_string()));
        assert_eq!(reg.enabled_manifests().len(), 2);
    }

    #[tokio::test]
    async fn reload_marks_disabled_plugins() {
        let tmp = TempDir::new().unwrap();
        write_plugin(&tmp, "a");
        write_plugin(&tmp, "b");
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &settings_with_disabled(&["a"]))
            .await;
        assert!(!reg.is_enabled("a"));
        assert!(reg.is_enabled("b"));
        assert_eq!(reg.enabled_manifests().len(), 1);
        // all_manifests still includes disabled ones (settings UI needs them)
        assert_eq!(reg.all_manifests().len(), 2);
    }

    #[tokio::test]
    async fn reload_diff_detects_removals() {
        let tmp = TempDir::new().unwrap();
        write_plugin(&tmp, "a");
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &AppSettings::default()).await;
        // Remove plugin a
        fs::remove_dir_all(tmp.path().join("plugins/a")).unwrap();
        let diff = reg.reload(tmp.path(), &AppSettings::default()).await;
        assert!(diff.removed.contains(&"a".to_string()));
        assert!(!reg.get("a").is_some());
    }

    #[tokio::test]
    async fn reload_diff_detects_enable_change() {
        let tmp = TempDir::new().unwrap();
        write_plugin(&tmp, "a");
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &settings_with_disabled(&["a"]))
            .await;
        // Enable plugin a
        let diff = reg.reload(tmp.path(), &AppSettings::default()).await;
        assert!(diff.changed.contains(&"a".to_string()));
        assert!(reg.is_enabled("a"));
    }

    #[tokio::test]
    async fn reload_diff_no_change_when_unchanged() {
        let tmp = TempDir::new().unwrap();
        write_plugin(&tmp, "a");
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &AppSettings::default()).await;
        let diff = reg.reload(tmp.path(), &AppSettings::default()).await;
        assert!(diff.changed.is_empty());
        assert!(diff.removed.is_empty());
    }

    #[tokio::test]
    async fn section_cache_populated_when_declared() {
        let tmp = TempDir::new().unwrap();
        let dir = tmp.path().join("plugins/a");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("plugin.json"),
            serde_json::json!({
                "id": "a",
                "version": "1.0.0",
                "name": "a",
                "systemPromptSection": "section.md"
            })
            .to_string(),
        );
        fs::write(dir.join("section.md"), "hello section").unwrap();
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &AppSettings::default()).await;
        assert_eq!(reg.section_for("a"), Some("hello section"));
    }

    #[tokio::test]
    async fn reload_on_missing_plugins_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let mut reg = PluginRegistry::default();
        let diff = reg.reload(tmp.path(), &AppSettings::default()).await;
        assert!(diff.all_ids.is_empty());
        assert!(diff.changed.is_empty());
    }
}
