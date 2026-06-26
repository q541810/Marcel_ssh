use std::path::PathBuf;
use tauri::http::Response;
use tauri::utils::config::Color;
use tauri::{
    LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};

use crate::config::persist::JsonPersistable;
use crate::config::settings::AppSettings;

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

    window
        .add_child(
            WebviewBuilder::new(&params.label, webview_url)
                .background_color(Color(24, 24, 27, 255)),
            LogicalPosition::new(params.x, params.y),
            LogicalSize::new(params.width.max(1.0), params.height.max(1.0)),
        )
        .map_err(|e| e.to_string())?;

    Ok(())
}

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

#[tauri::command]
pub async fn plugin_webview_close(
    app: tauri::AppHandle,
    label: String,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        webview.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn handle_plugin_uri<R: tauri::Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> Response<std::borrow::Cow<'static, [u8]>> {
    let app = ctx.app_handle();
    let uri = request.uri();
    let plugin_id = uri.host().unwrap_or("").to_string();
    let path = uri.path().to_string();

    if !is_plugin_enabled_from_disk(app, &plugin_id) {
        return forbidden("plugin disabled");
    }

    if let Some(cmd) = path.strip_prefix("/api/") {
        if request.method() == "OPTIONS" {
            return Response::builder()
                .header("Access-Control-Allow-Origin", "*")
                .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                .header("Access-Control-Allow-Headers", "Content-Type")
                .body(std::borrow::Cow::Owned(Vec::new()))
                .unwrap();
        }
        if !cmd.is_empty() {
            return handle_plugin_api(app, &plugin_id, cmd, request);
        }
    }

    let config_dir = match app.path().app_config_dir() {
        Ok(d) => d,
        Err(_) => return bad_request("no config dir"),
    };
    let rel = path.trim_start_matches('/').to_string();
    let plugin_dir = config_dir.join("plugins").join(&plugin_id);
    let base_dir = match plugin_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return bad_request("plugin not found"),
    };
    let candidate = plugin_dir.join(if rel.is_empty() { "index.html" } else { &rel });
    let file_path = match candidate.canonicalize() {
        Ok(p) if p.starts_with(&base_dir) => p,
        _ => return forbidden("invalid plugin resource path"),
    };

    match std::fs::read(&file_path) {
        Ok(data) => {
            let mime = guess_mime(&file_path);
            Response::builder()
                .header("Content-Type", mime)
                .body(std::borrow::Cow::Owned(data))
                .unwrap_or_else(|_| bad_request("build failed"))
        }
        Err(_) => bad_request(&format!("not found: {}", file_path.display())),
    }
}

async fn is_plugin_enabled_async<R: tauri::Runtime>(app: &tauri::AppHandle<R>, plugin_id: &str) -> bool {
    let state = app.state::<crate::AppState>();
    let settings = state.settings.read().await;
    !settings.disabled_plugins.iter().any(|id| id == plugin_id)
}

fn is_plugin_enabled_from_disk<R: tauri::Runtime>(app: &tauri::AppHandle<R>, plugin_id: &str) -> bool {
    let config_dir = match app.path().app_config_dir() {
        Ok(d) => d,
        Err(_) => return false,
    };
    let path = AppSettings::default_file(&config_dir);
    match AppSettings::load_from_path(&path) {
        Ok(settings) => !settings.disabled_plugins.iter().any(|id| id == plugin_id),
        Err(err) => {
            log::warn!("读取插件启用状态失败，拒绝访问 [{}]: {}", plugin_id, err);
            false
        }
    }
}

fn handle_plugin_api<R: tauri::Runtime>(
    _app: &tauri::AppHandle<R>,
    plugin_id: &str,
    cmd: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> Response<std::borrow::Cow<'static, [u8]>> {
    let body = String::from_utf8_lossy(request.body());
    let response = serde_json::json!({
        "ok": true,
        "cmd": cmd,
        "plugin": plugin_id,
        "echo": serde_json::from_str::<serde_json::Value>(&body).unwrap_or(serde_json::Value::Null),
    });
    Response::builder()
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type")
        .body(std::borrow::Cow::Owned(response.to_string().into_bytes()))
        .unwrap_or_else(|_| bad_request("api build failed"))
}

fn guess_mime(path: &std::path::Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn bad_request(msg: &str) -> Response<std::borrow::Cow<'static, [u8]>> {
    Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(std::borrow::Cow::Owned(msg.as_bytes().to_vec()))
        .unwrap()
}

fn forbidden(msg: &str) -> Response<std::borrow::Cow<'static, [u8]>> {
    Response::builder()
        .status(403)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(std::borrow::Cow::Owned(msg.as_bytes().to_vec()))
        .unwrap()
}

pub fn is_path_within_base(base_dir: &std::path::Path, candidate: &std::path::Path) -> bool {
    let base = match base_dir.canonicalize() {
        Ok(p) => p,
        Err(_) => return false,
    };
    match candidate.canonicalize() {
        Ok(p) => p.starts_with(&base),
        Err(_) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn path_within_base_is_allowed() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("plugin");
        fs::create_dir_all(&base).unwrap();
        fs::write(base.join("index.html"), "ok").unwrap();
        let candidate = base.join("index.html");
        assert!(is_path_within_base(&base, &candidate));
    }

    #[test]
    fn path_traversal_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("plugin");
        fs::create_dir_all(&base).unwrap();
        fs::write(tmp.path().join("secret.txt"), "secret").unwrap();
        let candidate = base.join("../secret.txt");
        assert!(!is_path_within_base(&base, &candidate));
    }

    #[test]
    fn nonexistent_path_is_rejected() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("plugin");
        fs::create_dir_all(&base).unwrap();
        let candidate = base.join("does-not-exist.txt");
        assert!(!is_path_within_base(&base, &candidate));
    }

    #[test]
    fn nested_path_within_base_is_allowed() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path().join("plugin");
        fs::create_dir_all(base.join("assets")).unwrap();
        fs::write(base.join("assets/style.css"), "").unwrap();
        let candidate = base.join("assets/style.css");
        assert!(is_path_within_base(&base, &candidate));
    }
}
