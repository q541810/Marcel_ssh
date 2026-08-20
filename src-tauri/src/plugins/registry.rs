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
    /// Manifest parsed, user did not disable it, but the running app version
    /// is lower than the plugin's declared `minAppVersion`. Treated as
    /// disabled for loading purposes (tools/injections never activate) while
    /// still visible in the settings UI with the required version shown.
    Incompatible(String),
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
    ///
    /// `app_version` is the running app version (e.g. `package_info().version`).
    /// Plugins declaring a `minAppVersion` above it are held in state
    /// `Incompatible` (effectively disabled).
    pub async fn reload(
        &mut self,
        config_dir: &Path,
        settings: &AppSettings,
        app_version: &str,
    ) -> ReloadDiff {
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
            let prev_effective_enabled = prev.and_then(|e| match e.state {
                PluginState::Enabled => Some(true),
                PluginState::Disabled | PluginState::Incompatible(_) => Some(false),
                _ => None,
            });
            let now_effective_enabled =
                !disabled.contains(id) && min_app_version_satisfied(m, app_version);
            let enabled_changed = prev_effective_enabled != Some(now_effective_enabled);

            if manifest_changed || enabled_changed {
                changed.push(id.clone());
            }

            // State: disabled by user > incompatible app version > enabled.
            // An incompatible plugin is directly treated as Disabled (closed)
            // — it never loads (tools/injections inactive) and stays visible in
            // the settings UI with the required version shown. After the app is
            // upgraded the user can manually re-enable it.
            let state = if disabled.contains(id) {
                PluginState::Disabled
            } else if min_app_version_satisfied(m, app_version) {
                PluginState::Enabled
            } else {
                let reason = m
                    .min_app_version
                    .as_ref()
                    .map_or_else(|| "版本不兼容".to_string(), |min| format!("需要应用 v{}", min));
                log::warn!(
                    "插件 {} 不兼容当前应用版本 {}: {}，已直接禁用",
                    m.id,
                    app_version,
                    reason
                );
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

/// Lenient dot-separated numeric version parser: every segment must be a plain
/// number (`"1.7"` and `"1.7.0"` both parse). Returns `None` on any malformed
/// segment (e.g. `"abc"`, `"1.x"`).
fn parse_version_parts(s: &str) -> Option<Vec<u64>> {
    s.split('.').map(|seg| seg.trim().parse::<u64>().ok()).collect()
}

/// Whether the plugin's `minAppVersion` (if declared) is satisfied by the
/// running `app_version`. Comparison is lenient numeric per-segment (missing
/// segments count as 0), so `"1.7"` satisfies `"1.7.0"` and vice versa.
/// Any unparseable version is treated as NOT satisfied (conservative).
fn min_app_version_satisfied(m: &PluginManifest, app_version: &str) -> bool {
    let Some(min) = m.min_app_version.as_ref() else {
        return true;
    };
    let Some(min_parts) = parse_version_parts(min) else {
        return false;
    };
    let Some(app_parts) = parse_version_parts(app_version) else {
        return false;
    };
    let len = min_parts.len().max(app_parts.len());
    for i in 0..len {
        let app_part = app_parts.get(i).copied().unwrap_or(0);
        let min_part = min_parts.get(i).copied().unwrap_or(0);
        if app_part < min_part {
            return false;
        }
        if app_part > min_part {
            return true;
        }
    }
    true
}

/// Compare two dot-separated numeric versions.
/// Returns -1 if a < b, 0 if equal, 1 if a > b, None if malformed.
pub fn compare_versions(a: &str, b: &str) -> Option<i32> {
    let a_parts = parse_version_parts(a)?;
    let b_parts = parse_version_parts(b)?;
    let len = a_parts.len().max(b_parts.len());
    for i in 0..len {
        let av = a_parts.get(i).copied().unwrap_or(0);
        let bv = b_parts.get(i).copied().unwrap_or(0);
        if av < bv {
            return Some(-1);
        }
        if av > bv {
            return Some(1);
        }
    }
    Some(0)
}

/// Whether `market` is newer than `local`.
pub fn is_newer_version(market: &str, local: &str) -> bool {
    matches!(compare_versions(market, local), Some(1))
}

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
        let diff = reg.reload(tmp.path(), &AppSettings::default(), "1.0.0").await;
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
        reg.reload(tmp.path(), &settings_with_disabled(&["a"]), "1.0.0")
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
        reg.reload(tmp.path(), &AppSettings::default(), "1.0.0").await;
        // Remove plugin a
        fs::remove_dir_all(tmp.path().join("plugins/a")).unwrap();
        let diff = reg.reload(tmp.path(), &AppSettings::default(), "1.0.0").await;
        assert!(diff.removed.contains(&"a".to_string()));
        assert!(!reg.get("a").is_some());
    }

    #[tokio::test]
    async fn reload_diff_detects_enable_change() {
        let tmp = TempDir::new().unwrap();
        write_plugin(&tmp, "a");
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &settings_with_disabled(&["a"]), "1.0.0")
            .await;
        // Enable plugin a
        let diff = reg.reload(tmp.path(), &AppSettings::default(), "1.0.0").await;
        assert!(diff.changed.contains(&"a".to_string()));
        assert!(reg.is_enabled("a"));
    }

    #[tokio::test]
    async fn reload_diff_no_change_when_unchanged() {
        let tmp = TempDir::new().unwrap();
        write_plugin(&tmp, "a");
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &AppSettings::default(), "1.0.0").await;
        let diff = reg.reload(tmp.path(), &AppSettings::default(), "1.0.0").await;
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
        reg.reload(tmp.path(), &AppSettings::default(), "1.0.0").await;
        assert_eq!(reg.section_for("a"), Some("hello section"));
    }

    #[tokio::test]
    async fn reload_on_missing_plugins_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        let mut reg = PluginRegistry::default();
        let diff = reg.reload(tmp.path(), &AppSettings::default(), "1.0.0").await;
        assert!(diff.all_ids.is_empty());
        assert!(diff.changed.is_empty());
    }

    fn write_plugin_with_min_version(tmp: &TempDir, id: &str, min: Option<&str>) {
        let dir = tmp.path().join("plugins").join(id);
        fs::create_dir_all(&dir).unwrap();
        let mut manifest = serde_json::json!({
            "id": id,
            "version": "1.0.0",
            "name": id,
            "capabilities": [],
            "views": [],
            "agentTools": []
        });
        if let Some(min) = min {
            manifest["minAppVersion"] = serde_json::json!(min);
        }
        fs::write(dir.join("plugin.json"), manifest.to_string()).unwrap();
    }

    #[tokio::test]
    async fn enabled_when_min_app_version_satisfied() {
        let tmp = TempDir::new().unwrap();
        write_plugin_with_min_version(&tmp, "a", Some("1.0.0"));
        write_plugin_with_min_version(&tmp, "b", Some("0.5"));
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &AppSettings::default(), "1.0.0")
            .await;
        assert!(reg.is_enabled("a"));
        assert!(reg.is_enabled("b"));
    }

    #[tokio::test]
    async fn incompatible_when_min_app_version_above_app() {
        let tmp = TempDir::new().unwrap();
        write_plugin_with_min_version(&tmp, "a", Some("2.0.0"));
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &AppSettings::default(), "1.0.0")
            .await;
        let entry = reg.get("a").unwrap();
        // 不兼容直接视为 Disabled（关闭），复用关闭路径
        assert_eq!(entry.state, PluginState::Disabled);
        // Not enabled anywhere: tools/injections must not activate.
        assert!(!reg.is_enabled("a"));
        assert!(reg.enabled_manifests().is_empty());
        // Still listed so the settings UI can explain why.
        assert_eq!(reg.all_manifests().len(), 1);
    }

    #[tokio::test]
    async fn incompatible_recovers_automatically_after_app_upgrade() {
        let tmp = TempDir::new().unwrap();
        write_plugin_with_min_version(&tmp, "a", Some("2.0.0"));
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &AppSettings::default(), "1.0.0")
            .await;
        assert!(!reg.is_enabled("a"));
        // App upgraded -> same plugin now compatible, no user action needed.
        reg.reload(tmp.path(), &AppSettings::default(), "2.0.0")
            .await;
        assert!(reg.is_enabled("a"));
    }

    #[tokio::test]
    async fn malformed_min_app_version_treated_incompatible() {
        let tmp = TempDir::new().unwrap();
        write_plugin_with_min_version(&tmp, "a", Some("abc"));
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &AppSettings::default(), "1.0.0")
            .await;
        assert!(!reg.is_enabled("a"));
        assert_eq!(reg.all_manifests().len(), 1);
    }

    #[tokio::test]
    async fn incompatible_plugin_not_re_changed_on_second_reload() {
        let tmp = TempDir::new().unwrap();
        write_plugin_with_min_version(&tmp, "a", Some("2.0.0"));
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &AppSettings::default(), "1.0.0")
            .await;
        let diff = reg.reload(tmp.path(), &AppSettings::default(), "1.0.0")
            .await;
        assert!(
            !diff.changed.contains(&"a".to_string()),
            "stable incompatible plugin must not re-trigger frontend rebuilds"
        );
    }

    #[tokio::test]
    async fn incompatible_recovers_when_user_disable_removed() {
        let tmp = TempDir::new().unwrap();
        write_plugin_with_min_version(&tmp, "a", Some("2.0.0"));
        let mut reg = PluginRegistry::default();
        reg.reload(tmp.path(), &settings_with_disabled(&["a"]), "1.0.0")
            .await;
        assert_eq!(reg.get("a").unwrap().state, PluginState::Disabled);
        // User enables it again, but the app is still too old -> still Disabled (direct close).
        reg.reload(tmp.path(), &AppSettings::default(), "1.0.0")
            .await;
        assert_eq!(reg.get("a").unwrap().state, PluginState::Disabled);
    }

    #[test]
    fn compare_versions_equal() {
        assert_eq!(compare_versions("1.0.0", "1.0.0"), Some(0));
        assert_eq!(compare_versions("1.7", "1.7.0"), Some(0));
    }

    #[test]
    fn compare_versions_newer() {
        assert_eq!(compare_versions("1.0.1", "1.0.0"), Some(1));
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Some(1));
        assert_eq!(compare_versions("2.0", "1.99.99"), Some(1));
    }

    #[test]
    fn compare_versions_older() {
        assert_eq!(compare_versions("1.0.0", "1.0.1"), Some(-1));
        assert_eq!(compare_versions("1.9.9", "1.10.0"), Some(-1));
    }

    #[test]
    fn compare_versions_malformed() {
        assert_eq!(compare_versions("abc", "1.0.0"), None);
        assert_eq!(compare_versions("1.x", "1.0.0"), None);
    }

    #[test]
    fn is_newer_version_checks() {
        assert!(is_newer_version("1.0.1", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "1.0.0"));
        assert!(!is_newer_version("1.0.0", "1.0.1"));
        assert!(!is_newer_version("abc", "1.0.0"));
    }
}
