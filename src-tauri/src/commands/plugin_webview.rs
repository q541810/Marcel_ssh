//! Plugin WebView lifecycle: create, set-bounds, close.
//!
//! Static file serving lives in `plugin_uri.rs`; HTTP API dispatch in
//! `plugin_api.rs`; enabled-state check in `plugins::enabled`.

// Multi-webview (Window::add_child + webview reposition/close) is a
// desktop-only capability in Tauri; on mobile these commands degrade to a
// clear error so plugin views simply don't mount there.
#[cfg(desktop)]
use tauri::utils::config::Color;
#[cfg(desktop)]
use tauri::{LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};

#[cfg(desktop)]
use crate::plugins::enabled::is_plugin_enabled_async;

#[cfg(mobile)]
const MOBILE_UNSUPPORTED: &str = "plugin webviews are not supported on mobile";

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginWebviewCreateParams {
    pub label: String,
    pub plugin_id: String,
    pub entry: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_webview_create(
    _app: tauri::AppHandle,
    _params: PluginWebviewCreateParams,
) -> Result<(), String> {
    Err(MOBILE_UNSUPPORTED.to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_webview_create(
    app: tauri::AppHandle,
    params: PluginWebviewCreateParams,
) -> Result<(), String> {
    if app.get_webview(&params.label).is_some() {
        return Ok(());
    }

    if !is_plugin_enabled_async(&app, &params.plugin_id).await {
        return Err(format!("plugin disabled: {}", params.plugin_id));
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;

    let url = format!("plugin://{}/{}", params.plugin_id, params.entry);
    let webview_url = WebviewUrl::External(url::Url::parse(&url).map_err(|e| e.to_string())?);

    let label_for_loaded = params.label.clone();
    let plugin_id_for_loaded = params.plugin_id.clone();
    let app_for_loaded = app.clone();
    let on_page_load = move |_webview: tauri::Webview, payload: tauri::webview::PageLoadPayload| {
        use tauri::Emitter;
        let event_name = match payload.event() {
            tauri::webview::PageLoadEvent::Started => "started",
            tauri::webview::PageLoadEvent::Finished => "finished",
        };
        let _ = app_for_loaded.emit(
            &format!("webview://page-load/{}", label_for_loaded),
            serde_json::json!({
                "pluginId": plugin_id_for_loaded,
                "phase": event_name,
                "url": payload.url(),
            }),
        );
    };

    window
        .add_child(
            WebviewBuilder::new(&params.label, webview_url)
                .background_color(Color(24, 24, 27, 255))
                .on_page_load(on_page_load),
            LogicalPosition::new(params.x, params.y),
            LogicalSize::new(params.width.max(1.0), params.height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;

    // Register a webview-event listener to surface crashes / navigation
    // failures to the main window. We resolve the webview by label after
    // it has been added to the window.
    let label_for_evt = params.label.clone();
    let plugin_id_for_evt = params.plugin_id.clone();
    let app_for_evt = app.clone();
    if let Some(webview) = app.get_webview(&params.label) {
        webview.on_webview_event(move |event| {
            use tauri::Emitter;
            let event_kind = format!("{:?}", event);
            let _ = app_for_evt.emit(
                &format!("webview://event/{}", label_for_evt),
                serde_json::json!({
                    "pluginId": plugin_id_for_evt,
                    "event": event_kind,
                }),
            );
        });
    }

    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_webview_set_bounds(
    _app: tauri::AppHandle,
    _label: String,
    _x: f64,
    _y: f64,
    _width: f64,
    _height: f64,
) -> Result<(), String> {
    Err(MOBILE_UNSUPPORTED.to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_webview_set_bounds(
    app: tauri::AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("webview {} not found", label))?;
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(mobile)]
#[tauri::command]
pub async fn plugin_webview_close(_app: tauri::AppHandle, _label: String) -> Result<(), String> {
    Err(MOBILE_UNSUPPORTED.to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn plugin_webview_close(app: tauri::AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}
