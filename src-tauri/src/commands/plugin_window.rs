//! Plugin independent OS-level windows (desktop only).
//!
//! Unlike `plugin_webview` (which adds child webviews *inside* the main
//! window), this module creates standalone `WebviewWindow`s that can float
//! above other applications (`always_on_top`), be transparent, and skip the
//! taskbar — enabling desktop-pet / overlay / notification-bar style plugins.
//!
//! Sensitive properties (transparent / always_on_top / skip_taskbar) are
//! gated by their **own** capabilities so a user may grant `window.create`
//! without granting invisible topmost windows. This is a general capability
//! available to every plugin, not tailored to any specific one.

#![cfg_attr(mobile, allow(dead_code))]

#[cfg(desktop)]
use std::collections::HashMap;
#[cfg(desktop)]
use std::sync::Mutex;

#[cfg(desktop)]
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
    WebviewWindowBuilder,
};
#[cfg(desktop)]
use tauri::utils::config::Color;

#[cfg(desktop)]
use crate::error::AppError;
#[cfg(desktop)]
use crate::plugins::auth::authorize;
#[cfg(desktop)]
use crate::plugins::enabled::is_plugin_enabled_async;
#[cfg(desktop)]
use crate::AppState;

#[cfg(mobile)]
const MOBILE_UNSUPPORTED: &str = "plugin independent windows are not supported on mobile";

/// Max independent windows a single plugin may keep open simultaneously.
#[cfg(desktop)]
const MAX_WINDOWS_PER_PLUGIN: usize = 3;

/// `plugin_id` → list of live window labels owned by that plugin.
///
/// Stored as `Option<HashMap>` so the `static` initializer is `const` (HashMap
/// has no const constructor); the map is lazily filled on first access.
#[cfg(desktop)]
static PLUGIN_WINDOWS: Mutex<Option<HashMap<String, Vec<String>>>> = Mutex::new(None);

#[cfg(desktop)]
fn windows_map() -> std::sync::MutexGuard<'static, Option<HashMap<String, Vec<String>>>> {
    let mut guard = PLUGIN_WINDOWS.lock().expect("PLUGIN_WINDOWS poisoned");
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard
}

/// Remove a label from a plugin's owned-window list (idempotent).
#[cfg(desktop)]
fn remove_window(plugin_id: &str, label: &str) {
    let mut map = windows_map();
    let owned = map.as_mut().unwrap();
    if let Some(entry) = owned.get_mut(plugin_id) {
        entry.retain(|l| l != label);
        if entry.is_empty() {
            owned.remove(plugin_id);
        }
    }
}

/// Whether `plugin_id` owns a window with `label`.
#[cfg(desktop)]
pub(crate) fn owns_window(plugin_id: &str, label: &str) -> bool {
    let map = windows_map();
    map.as_ref()
        .unwrap()
        .get(plugin_id)
        .map_or(false, |v| v.iter().any(|l| l == label))
}

/// Close every live plugin-owned window.
///
/// Called when the main window receives a close request: Tauri only exits the
/// app after the **last** window closes, so a floating plugin window (e.g. a
/// desktop pet) would otherwise keep the app alive after the user closed it.
#[cfg(desktop)]
pub(crate) fn close_all_plugin_windows(app: &AppHandle) {
    let labels: Vec<String> = {
        let map = windows_map();
        map.as_ref()
            .unwrap()
            .values()
            .flatten()
            .cloned()
            .collect()
    };
    for label in labels {
        if let Some(win) = app.get_webview_window(&label) {
            let _ = win.close();
        }
    }
}

#[cfg(desktop)]
async fn auth_context(
    state: &State<'_, AppState>,
    plugin_id: &str,
) -> (crate::config::settings::AppSettings, Option<crate::plugins::manifest::PluginManifest>) {
    let settings = state.settings.read().await.clone();
    let manifest = {
        let reg = state.plugin_registry.read().await;
        reg.all_manifests().into_iter().find(|m| m.id == plugin_id)
    };
    (settings, manifest)
}

// ── params ────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWindowCreateParams {
    pub label: String,
    /// HTML path relative to the plugin root (served via `plugin://`).
    pub entry: String,
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub decorations: bool,
    #[serde(default)]
    pub transparent: bool,
    #[serde(default)]
    pub shadow: bool,
    #[serde(default)]
    pub always_on_top: bool,
    #[serde(default)]
    pub skip_taskbar: bool,
    #[serde(default)]
    pub resizable: bool,
}

// ── create ────────────────────────────────────────────────────────────

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_window_create(
    _app: tauri::AppHandle,
    _state: State<'_, AppState>,
    _plugin_id: String,
    _params: PluginWindowCreateParams,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_window_create(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    params: PluginWindowCreateParams,
) -> Result<(), AppError> {
    let (settings, manifest) = auth_context(&state, &plugin_id).await;

    // Authorization: window.create always required.
    let deny = |cap: &str| {
        AppError::Other(format!(
            "capability \"{}\" not authorized for plugin \"{}\"",
            cap, plugin_id
        ))
    };
    if !authorize(&plugin_id, "window.create", manifest.as_ref(), &settings).ok() {
        return Err(deny("window.create"));
    }
    // Sensitive sub-capabilities, only enforced when requested.
    if params.transparent
        && !authorize(&plugin_id, "window.transparent", manifest.as_ref(), &settings).ok()
    {
        return Err(deny("window.transparent"));
    }
    if params.always_on_top
        && !authorize(&plugin_id, "window.always_on_top", manifest.as_ref(), &settings).ok()
    {
        return Err(deny("window.always_on_top"));
    }
    if params.skip_taskbar
        && !authorize(&plugin_id, "window.skip_taskbar", manifest.as_ref(), &settings).ok()
    {
        return Err(deny("window.skip_taskbar"));
    }

    // Per-plugin window count limit.
    {
        let mut map = windows_map();
        let owned = map.as_mut().unwrap();
        let entry = owned.entry(plugin_id.clone()).or_default();
        if entry.iter().any(|l| l == &params.label) {
            return Ok(()); // idempotent: same label already exists
        }
        if entry.len() >= MAX_WINDOWS_PER_PLUGIN {
            return Err(AppError::Other(format!(
                "plugin \"{}\" already has the maximum of {} independent windows",
                plugin_id, MAX_WINDOWS_PER_PLUGIN
            )));
        }
        entry.push(params.label.clone());
    }

    if !is_plugin_enabled_async(&app, &plugin_id).await {
        remove_window(&plugin_id, &params.label);
        return Err(AppError::Other(format!("plugin disabled: {}", plugin_id)));
    }

    let url = format!("plugin://{}/{}", plugin_id, params.entry);
    let webview_url =
        WebviewUrl::External(url::Url::parse(&url).map_err(|e| AppError::Other(e.to_string()))?);

    let label = params.label.clone();
    let plugin_id_evt = plugin_id.clone();
    let app_evt = app.clone();

    let mut builder = WebviewWindowBuilder::new(&app, &label, webview_url)
        .title("")
        .inner_size(params.width.max(1.0), params.height.max(1.0))
        .position(params.x, params.y)
        .decorations(params.decorations)
        .transparent(params.transparent)
        .shadow(params.shadow)
        .always_on_top(params.always_on_top)
        .skip_taskbar(params.skip_taskbar)
        .resizable(params.resizable)
        .focused(true);
    // 透明窗口需显式把 webview 背景设为透明（Windows 上 background_color 的
    // alpha=0 才让 webview layer 透明，否则默认白底导致方框）。
    if params.transparent {
        builder = builder.background_color(Color(0, 0, 0, 0));
    }
    let webview_window = builder.build().map_err(|e| {
        remove_window(&plugin_id, &label);
        AppError::Other(format!("failed to create window: {}", e))
    })?;

    let _ = crate::emit_event(
        &app_evt,
        &format!("window://created/{}", label),
        serde_json::json!({ "pluginId": plugin_id_evt, "label": &label }),
    );

    let app_close = app.clone();
    let label_close = label.clone();
    let plugin_id_close = plugin_id.clone();
    webview_window.on_window_event(move |event| {
        use tauri::WindowEvent;
        match event {
            WindowEvent::CloseRequested { .. } => {
                remove_window(&plugin_id_close, &label_close);
                let _ = crate::emit_event(
                    &app_close,
                    &format!("window://closed/{}", label_close),
                    serde_json::json!({ "label": &label_close }),
                );
            }
            WindowEvent::Focused(focused) => {
                let _ = crate::emit_event(
                    &app_close,
                    &format!("window://focus-changed/{}", label_close),
                    serde_json::json!({ "label": &label_close, "focused": focused }),
                );
            }
            WindowEvent::Moved(pos) => {
                let _ = crate::emit_event(
                    &app_close,
                    &format!("window://moved/{}", label_close),
                    serde_json::json!({ "label": &label_close, "x": pos.x, "y": pos.y }),
                );
            }
            _ => {}
        }
    });

    Ok(())
}

// ── show / hide / close / focus ───────────────────────────────────────

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_window_show(
    _app: tauri::AppHandle,
    _plugin_id: String,
    _label: String,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_window_show(
    app: AppHandle,
    plugin_id: String,
    label: String,
) -> Result<(), AppError> {
    let win = require_owned_window(&app, &plugin_id, &label)?;
    win.show().map_err(|e| AppError::Other(e.to_string()))
}

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_window_hide(
    _app: tauri::AppHandle,
    _plugin_id: String,
    _label: String,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_window_hide(
    app: AppHandle,
    plugin_id: String,
    label: String,
) -> Result<(), AppError> {
    let win = require_owned_window(&app, &plugin_id, &label)?;
    win.hide().map_err(|e| AppError::Other(e.to_string()))
}

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_window_close(
    _app: tauri::AppHandle,
    _plugin_id: String,
    _label: String,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_window_close(
    app: AppHandle,
    plugin_id: String,
    label: String,
) -> Result<(), AppError> {
    if let Some(win) = app.get_webview_window(&label) {
        // Only allow closing windows the plugin actually owns.
        if owns_window(&plugin_id, &label) {
            win.close().map_err(|e| AppError::Other(e.to_string()))?;
        } else {
            return Err(AppError::Other(format!(
                "plugin \"{}\" does not own window \"{}\"",
                plugin_id, label
            )));
        }
    }
    remove_window(&plugin_id, &label);
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_window_focus(
    _app: tauri::AppHandle,
    _plugin_id: String,
    _label: String,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_window_focus(
    app: AppHandle,
    plugin_id: String,
    label: String,
) -> Result<(), AppError> {
    let win = require_owned_window(&app, &plugin_id, &label)?;
    win.set_focus().map_err(|e| AppError::Other(e.to_string()))
}

// ── position / size ───────────────────────────────────────────────────

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_window_set_position(
    _app: tauri::AppHandle,
    _plugin_id: String,
    _label: String,
    _x: f64,
    _y: f64,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_window_set_position(
    app: AppHandle,
    plugin_id: String,
    label: String,
    x: f64,
    y: f64,
) -> Result<(), AppError> {
    let win = require_owned_window(&app, &plugin_id, &label)?;
    win.set_position(LogicalPosition::new(x, y))
        .map_err(|e| AppError::Other(e.to_string()))
}

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_window_set_size(
    _app: tauri::AppHandle,
    _plugin_id: String,
    _label: String,
    _width: f64,
    _height: f64,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_window_set_size(
    app: AppHandle,
    plugin_id: String,
    label: String,
    width: f64,
    height: f64,
) -> Result<(), AppError> {
    let win = require_owned_window(&app, &plugin_id, &label)?;
    win.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| AppError::Other(e.to_string()))
}

// ── always_on_top (sensitive: re-checked at runtime) ──────────────────

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_window_set_always_on_top(
    _app: tauri::AppHandle,
    _state: State<'_, AppState>,
    _plugin_id: String,
    _label: String,
    _always_on_top: bool,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_window_set_always_on_top(
    app: AppHandle,
    state: State<'_, AppState>,
    plugin_id: String,
    label: String,
    always_on_top: bool,
) -> Result<(), AppError> {
    let (settings, manifest) = auth_context(&state, &plugin_id).await;
    if !authorize(&plugin_id, "window.always_on_top", manifest.as_ref(), &settings).ok() {
        return Err(AppError::Other(format!(
            "capability \"window.always_on_top\" not authorized for plugin \"{}\"",
            plugin_id
        )));
    }
    let win = require_owned_window(&app, &plugin_id, &label)?;
    win.set_always_on_top(always_on_top)
        .map_err(|e| AppError::Other(e.to_string()))
}

// ── click-through ─────────────────────────────────────────────────────

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_window_set_ignore_cursor_events(
    _app: tauri::AppHandle,
    _plugin_id: String,
    _label: String,
    _ignore: bool,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_window_set_ignore_cursor_events(
    app: AppHandle,
    plugin_id: String,
    label: String,
    ignore: bool,
) -> Result<(), AppError> {
    let win = require_owned_window(&app, &plugin_id, &label)?;
    win.set_ignore_cursor_events(ignore)
        .map_err(|e| AppError::Other(e.to_string()))
}

// ── helper ────────────────────────────────────────────────────────────

#[cfg(desktop)]
fn require_owned_window(
    app: &AppHandle,
    plugin_id: &str,
    label: &str,
) -> Result<tauri::WebviewWindow, AppError> {
    if !owns_window(plugin_id, label) {
        return Err(AppError::Other(format!(
            "plugin \"{}\" does not own window \"{}\"",
            plugin_id, label
        )));
    }
    app.get_webview_window(label)
        .ok_or_else(|| AppError::Other(format!("window \"{}\" not found", label)))
}
