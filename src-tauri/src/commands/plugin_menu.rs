//! Plugin native context menus (desktop only).
//!
//! Lets a plugin register a set of menu items and pop them up as a native
//! right-click menu on one of its owned independent windows. Clicks are
//! reported back via the `menu://clicked/{label}` event carrying the
//! `actionId` the plugin registered.
//!
//! This is a general capability available to every plugin — it is not
//! tailored to any specific plugin. A plugin must declare `context_menu`
//! in its manifest capabilities.

#![cfg_attr(mobile, allow(dead_code))]

#[cfg(desktop)]
use std::collections::{HashMap, HashSet};
#[cfg(desktop)]
use std::sync::Mutex;

#[cfg(desktop)]
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
#[cfg(desktop)]
use tauri::{AppHandle, Manager};

#[cfg(desktop)]
use crate::error::AppError;

#[cfg(mobile)]
const MOBILE_UNSUPPORTED: &str = "plugin context menus are not supported on mobile";

/// A single menu item a plugin wants to show.
#[derive(serde::Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MenuItemDef {
    /// Stable id the plugin gets back on click (via `menu://clicked`).
    pub action_id: String,
    /// Visible label.
    pub label: String,
    #[serde(default)]
    pub disabled: bool,
    /// Insert a separator *before* this item.
    #[serde(default)]
    pub separator_before: bool,
}

/// `plugin_id` → registered menu items.
#[cfg(desktop)]
static PLUGIN_MENUS: Mutex<Option<HashMap<String, Vec<MenuItemDef>>>> = Mutex::new(None);

/// Window labels that already have an `on_menu_event` handler installed,
/// so we don't overwrite a previously installed handler on every popup.
#[cfg(desktop)]
static MENUS_WIRED: Mutex<Option<HashSet<String>>> = Mutex::new(None);

#[cfg(desktop)]
fn menus_map() -> std::sync::MutexGuard<'static, Option<HashMap<String, Vec<MenuItemDef>>>> {
    let mut guard = PLUGIN_MENUS.lock().expect("PLUGIN_MENUS poisoned");
    if guard.is_none() {
        *guard = Some(HashMap::new());
    }
    guard
}

#[cfg(desktop)]
fn wired_set() -> std::sync::MutexGuard<'static, Option<HashSet<String>>> {
    let mut guard = MENUS_WIRED.lock().expect("MENUS_WIRED poisoned");
    if guard.is_none() {
        *guard = Some(HashSet::new());
    }
    guard
}

// ── register / unregister ─────────────────────────────────────────────

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_menu_register(
    _plugin_id: String,
    _items: Vec<MenuItemDef>,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_menu_register(
    plugin_id: String,
    items: Vec<MenuItemDef>,
) -> Result<(), AppError> {
    let mut map = menus_map();
    map.as_mut().unwrap().insert(plugin_id, items);
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_menu_unregister(_plugin_id: String) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_menu_unregister(plugin_id: String) -> Result<(), AppError> {
    let mut map = menus_map();
    map.as_mut().unwrap().remove(&plugin_id);
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_menu_update(
    _plugin_id: String,
    _items: Vec<MenuItemDef>,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_menu_update(plugin_id: String, items: Vec<MenuItemDef>) -> Result<(), AppError> {
    // Alias of register: replace the whole item set.
    let mut map = menus_map();
    map.as_mut().unwrap().insert(plugin_id, items);
    Ok(())
}

// ── popup ─────────────────────────────────────────────────────────────

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_menu_popup(
    _app: tauri::AppHandle,
    _plugin_id: String,
    _label: String,
) -> Result<(), AppError> {
    Err(AppError::Other(MOBILE_UNSUPPORTED.to_string()))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_menu_popup(
    app: AppHandle,
    plugin_id: String,
    label: String,
) -> Result<(), AppError> {
    // Ownership check: the plugin may only pop menus on windows it owns.
    if !crate::commands::plugin_window::owns_window(&plugin_id, &label) {
        return Err(AppError::Other(format!(
            "plugin \"{}\" does not own window \"{}\"",
            plugin_id, label
        )));
    }

    let items = {
        let map = menus_map();
        map.as_ref()
            .unwrap()
            .get(&plugin_id)
            .cloned()
            .unwrap_or_default()
    };
    if items.is_empty() {
        return Err(AppError::Other(format!(
            "plugin \"{}\" has no menu items registered",
            plugin_id
        )));
    }

    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| AppError::Other(format!("window \"{}\" not found", label)))?;

    // Install the menu-event handler once per window. Tauri's
    // `on_menu_event` replaces any prior handler, so we guard with a set.
    {
        let mut wired = wired_set();
        let set = wired.as_mut().unwrap();
        if !set.contains(&label) {
            let app_h = app.clone();
            let label_h = label.clone();
            let plugin_id_h = plugin_id.clone();
            win.on_menu_event(move |_w, event| {
                let action_id = event.id.as_ref().to_string();
                eprintln!("[plugin_menu] on_menu_event fired: label={}, action_id={}", label_h, action_id);
                let _ = crate::emit_event(
                    &app_h,
                    &format!("menu://clicked/{}", label_h),
                    serde_json::json!({
                        "pluginId": &plugin_id_h,
                        "label": &label_h,
                        "actionId": action_id,
                    }),
                );
            });
            set.insert(label);
        }
    }

    // Build the native menu from the plugin's item defs. Items are boxed as
    // trait objects so separators and menu items share one Vec.
    let mut menu_entries: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for def in &items {
        if def.separator_before {
            let sep = PredefinedMenuItem::separator(&app)
                .map_err(|e| AppError::Other(format!("separator build failed: {}", e)))?;
            menu_entries.push(Box::new(sep));
        }
        let item = MenuItem::with_id(&app, &def.action_id, &def.label, !def.disabled, None::<&str>)
            .map_err(|e| AppError::Other(format!("menu item build failed: {}", e)))?;
        menu_entries.push(Box::new(item));
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> =
        menu_entries.iter().map(|b| b.as_ref()).collect();
    let menu = Menu::with_items(&app, &refs)
        .map_err(|e| AppError::Other(format!("menu build failed: {}", e)))?;

    win.popup_menu(&menu)
        .map_err(|e| AppError::Other(format!("popup_menu failed: {}", e)))?;

    Ok(())
}
