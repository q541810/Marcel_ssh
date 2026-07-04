//! Plugin enabled-state check — delegates to the `PluginRegistry`, the
//! single source of truth for plugin lifecycle state.
//!
//! Both the async webview-creation path and the synchronous URI scheme
//! handler route through here so unsaved `AppSettings` changes (which trigger
//! a registry reload via `plugin_reload`) are reflected immediately.

use tauri::{Manager, Runtime};

use crate::plugins::registry::PluginRegistry;
use crate::AppState;

/// Async variant: for Tauri commands that are already async. Reads the
/// registry's in-memory state — never touches disk.
pub async fn is_plugin_enabled_async<R: Runtime>(app: &tauri::AppHandle<R>, plugin_id: &str) -> bool {
    let state = app.state::<AppState>();
    let reg = state.plugin_registry.read().await;
    reg.is_enabled(plugin_id)
}

/// Sync variant: for the URI scheme handler (runs on a thread with a tokio
/// runtime). Reads the registry's in-memory state via `blocking_read`.
pub fn is_plugin_enabled<R: Runtime>(app: &tauri::AppHandle<R>, plugin_id: &str) -> bool {
    let state = app.state::<AppState>();
    let reg = state.plugin_registry.blocking_read();
    reg.is_enabled(plugin_id)
}

/// Look up a plugin manifest from the registry (async). Used by the HTTP API
/// dispatcher so it no longer re-reads `plugin.json` from disk per request.
pub async fn manifest_for<R: Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_id: &str,
) -> Option<crate::plugins::manifest::PluginManifest> {
    let state = app.state::<AppState>();
    let reg = state.plugin_registry.read().await;
    reg.get(plugin_id).map(|e| e.manifest.clone())
}