use std::collections::HashMap;
use std::path::PathBuf;

use tauri::http::Response;
use tauri::utils::config::Color;
use tauri::{
    LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl,
};
use tauri_plugin_notification::NotificationExt;

use crate::config::persist::JsonPersistable;
use crate::config::settings::AppSettings;
use crate::plugins::manifest::PluginManifest;

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
    app: &tauri::AppHandle<R>,
    plugin_id: &str,
    cmd: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> Response<std::borrow::Cow<'static, [u8]>> {
    // Parse request body as JSON args
    let body = String::from_utf8_lossy(request.body());
    let args: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let args_map = match &args {
        serde_json::Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    };

    // Read manifest from disk and check capability
    let config_dir = match app.path().app_config_dir() {
        Ok(d) => d,
        Err(_) => return json_error(500, "no config dir"),
    };

    let manifest = match read_manifest_from_disk(&config_dir, plugin_id) {
        Some(m) => m,
        None => return json_error(404, "plugin not found"),
    };

    let required_cap = match command_to_capability(cmd) {
        Some(cap) => cap,
        None => return json_error(400, &format!("unknown command: {}", cmd)),
    };

    if !manifest.capabilities.contains(&required_cap.to_string()) {
        return json_error(403, &format!("capability '{}' not declared", required_cap));
    }

    // Execute command via tokio runtime
    let handle = match tokio::runtime::Handle::try_current() {
        Ok(h) => h,
        Err(_) => return json_error(500, "no async runtime"),
    };

    let result = handle.block_on(execute_command(app, cmd, &args_map, plugin_id));

    match result {
        Ok(data) => json_ok(data),
        Err(e) => json_error(500, &e),
    }
}

fn read_manifest_from_disk(config_dir: &PathBuf, plugin_id: &str) -> Option<PluginManifest> {
    let manifest_path = config_dir.join("plugins").join(plugin_id).join("plugin.json");
    let content = std::fs::read_to_string(&manifest_path).ok()?;
    serde_json::from_str(&content).ok()
}

fn command_to_capability(cmd: &str) -> Option<&'static str> {
    match cmd {
        // ssh.list virtual commands
        "session.active" | "session.info" | "connection.info" | "connection.list"
        | "ssh_list_sessions" => Some("ssh.list"),
        // ssh.exec
        "ssh_exec" => Some("ssh.exec"),
        // sftp
        "sftp_read_file" => Some("sftp.read"),
        "sftp_write_file" => Some("sftp.write"),
        // plugin-scoped
        "plugin_fs_read" | "fs.read" => Some("fs.read"),
        "plugin_fs_write" | "fs.write" => Some("fs.write"),
        "plugin_http_request" | "net.request" => Some("net.request"),
        "plugin_send_notification" | "notification" => Some("notification"),
        // events
        "events.subscribe" | "events.unsubscribe" => Some("events"),
        _ => None,
    }
}

async fn execute_command<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    cmd: &str,
    args: &serde_json::Map<String, serde_json::Value>,
    plugin_id: &str,
) -> Result<serde_json::Value, String> {
    let state = app.state::<crate::AppState>();

    match cmd {
        // ── Virtual commands (backend implementation) ──
        "session.active" => {
            let sessions = state.ssh_manager.list_sessions().await;
            if sessions.is_empty() {
                return Ok(serde_json::Value::Null);
            }
            // Return the first connected session
            for sid in &sessions {
                if state.ssh_manager.is_connected(sid).await {
                    let connection_id = state.ssh_manager.get_connection_id(sid).await;
                    return Ok(serde_json::json!({
                        "sessionId": sid,
                        "connectionId": connection_id,
                        "status": "connected",
                        "configId": null,
                    }));
                }
            }
            Ok(serde_json::Value::Null)
        }
        "session.info" => {
            let sid = args.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            if sid.is_empty() {
                return Ok(serde_json::Value::Null);
            }
            if state.ssh_manager.is_connected(sid).await {
                let connection_id = state.ssh_manager.get_connection_id(sid).await;
                Ok(serde_json::json!({
                    "sessionId": sid,
                    "connectionId": connection_id,
                    "status": "connected",
                    "configId": null,
                }))
            } else {
                Ok(serde_json::Value::Null)
            }
        }
        "connection.info" => {
            let cid = args.get("connectionId").and_then(|v| v.as_str()).unwrap_or("");
            if cid.is_empty() {
                return Ok(serde_json::Value::Null);
            }
            let store = state.connection_store.read().await;
            let conn = store.connections.iter().find(|c| c.id == cid);
            match conn {
                Some(c) => Ok(serde_json::json!({
                    "id": c.id,
                    "name": c.name,
                    "host": c.host,
                    "port": c.port,
                    "username": c.username,
                    "group": c.group,
                })),
                None => Ok(serde_json::Value::Null),
            }
        }
        "connection.list" => {
            let store = state.connection_store.read().await;
            let list: Vec<_> = store.connections.iter().map(|c| {
                serde_json::json!({
                    "id": c.id,
                    "name": c.name,
                    "host": c.host,
                    "port": c.port,
                    "username": c.username,
                    "group": c.group,
                })
            }).collect();
            Ok(serde_json::Value::Array(list))
        }

        // ── Backend commands ──
        "ssh_list_sessions" => {
            let sessions = state.ssh_manager.list_sessions().await;
            Ok(serde_json::json!(sessions))
        }
        "ssh_exec" => {
            let sid = args.get("sessionId").and_then(|v| v.as_str()).unwrap_or("");
            let command = args.get("command").and_then(|v| v.as_str()).unwrap_or("");
            if sid.is_empty() || command.is_empty() {
                return Err("sessionId and command required".into());
            }
            let output = state.ssh_manager.exec_command(sid, command).await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::String(output))
        }

        // ── Plugin-scoped commands ──
        "plugin_fs_read" | "fs.read" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let plugin_dir = config_dir_for(app).join("plugins").join(plugin_id);
            let base = plugin_dir.canonicalize().map_err(|_| "plugin dir not found")?;
            let candidate = plugin_dir.join(path);
            let file_path = candidate.canonicalize().map_err(|_| "path not found")?;
            if !file_path.starts_with(&base) {
                return Err("path traversal rejected".into());
            }
            let content = std::fs::read_to_string(&file_path)
                .map_err(|e| format!("read failed: {}", e))?;
            Ok(serde_json::Value::String(content))
        }
        "plugin_fs_write" | "fs.write" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let plugin_dir = config_dir_for(app).join("plugins").join(plugin_id);
            let base = plugin_dir.canonicalize().map_err(|_| "plugin dir not found")?;
            let candidate = plugin_dir.join(path);
            let file_path = candidate.canonicalize().map_err(|e| {
                // Try to create intermediate dirs for new files
                if let Some(parent) = candidate.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                format!("path not found: {}", e)
            })?;
            if !file_path.starts_with(&base) {
                return Err("path traversal rejected".into());
            }
            std::fs::write(&file_path, content)
                .map_err(|e| format!("write failed: {}", e))?;
            Ok(serde_json::Value::Null)
        }
        "plugin_http_request" | "net.request" => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let method = args.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
            let headers = args.get("headers").and_then(|v| v.as_object());
            let body = args.get("body").and_then(|v| v.as_str());

            let client = reqwest::Client::new();
            let mut req = match method.to_uppercase().as_str() {
                "POST" => client.post(url),
                "PUT" => client.put(url),
                "DELETE" => client.delete(url),
                "PATCH" => client.patch(url),
                "HEAD" => client.head(url),
                _ => client.get(url),
            };

            if let Some(hdrs) = headers {
                for (k, v) in hdrs {
                    if let Some(val) = v.as_str() {
                        req = req.header(k.as_str(), val);
                    }
                }
            }
            if let Some(b) = body {
                req = req.body(b.to_string());
            }

            let resp = req.timeout(std::time::Duration::from_secs(20))
                .send().await.map_err(|e| format!("request failed: {}", e))?;

            let status = resp.status().as_u16();
            let resp_headers: HashMap<String, String> = resp.headers().iter()
                .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
                .collect();
            let resp_url = resp.url().to_string();
            let resp_body = resp.text().await.map_err(|e| format!("read body failed: {}", e))?;
            let truncated = if resp_body.len() > 256 * 1024 {
                &resp_body[..256 * 1024]
            } else {
                &resp_body
            };

            Ok(serde_json::json!({
                "status": status,
                "headers": resp_headers,
                "body": truncated,
                "url": resp_url,
            }))
        }
        "plugin_send_notification" | "notification" => {
            let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            let prefixed_title = format!("[{}] {}", plugin_id, title);
            let _ = app.notification()
                .builder()
                .title(&prefixed_title)
                .body(body)
                .show();
            Ok(serde_json::Value::Null)
        }

        _ => Err(format!("unhandled command: {}", cmd)),
    }
}

fn config_dir_for<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    app.path().app_config_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn json_ok(data: serde_json::Value) -> Response<std::borrow::Cow<'static, [u8]>> {
    let response = serde_json::json!({ "ok": true, "data": data });
    Response::builder()
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type")
        .body(std::borrow::Cow::Owned(response.to_string().into_bytes()))
        .unwrap_or_else(|_| bad_request("api build failed"))
}

fn json_error(status: u16, msg: &str) -> Response<std::borrow::Cow<'static, [u8]>> {
    let response = serde_json::json!({ "ok": false, "data": msg });
    Response::builder()
        .status(status)
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
