//! HTTP API command dispatcher for the `plugin://<id>/api/<cmd>` channel.
//!
//! Runs on the URI scheme thread. Enforces the same three-layer authorization
//! as the event IPC channel (`pluginIpc.ts::isAuthorized`) via
//! `plugins::auth::authorize`, then dispatches to the shared command
//! implementations (no inline duplicates — fs/net/notification call the same
//! `pub(crate)` inner functions as the Tauri commands).

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::http::Response;
use tauri::{Manager, Runtime};

use crate::plugins::auth::{authorize, AuthResult};
use crate::plugins::capability::capability_for;
use crate::plugins::enabled::manifest_for;
use crate::plugins::fs::{resolve_read_path, resolve_write_path};

/// Handle a `plugin://<id>/api/<cmd>` request.
pub fn handle_plugin_api<R: Runtime>(
    app: &tauri::AppHandle<R>,
    plugin_id: &str,
    cmd: &str,
    request: tauri::http::Request<Vec<u8>>,
) -> Response<std::borrow::Cow<'static, [u8]>> {
    let body = String::from_utf8_lossy(request.body());
    let args: serde_json::Value = serde_json::from_str(&body).unwrap_or(serde_json::Value::Null);
    let args_map = match &args {
        serde_json::Value::Object(m) => m.clone(),
        _ => serde_json::Map::new(),
    };

    let required_cap = match capability_for(cmd) {
        Some(cap) => cap,
        None => return json_error(400, &format!("unknown command: {}", cmd)),
    };

    let handle = match tokio::runtime::Handle::try_current() {
        Ok(h) => h,
        Err(_) => return json_error(500, "no async runtime"),
    };

    // Manifest comes from the registry (cached) — no per-request disk read.
    let manifest = match handle.block_on(manifest_for(app, plugin_id)) {
        Some(m) => m,
        None => return json_error(404, "plugin not found"),
    };

    let state = app.state::<crate::AppState>();
    let auth = {
        let settings = handle.block_on(state.settings.read());
        authorize(plugin_id, required_cap, Some(&manifest), &settings)
    };
    if let AuthResult::Denied { reason } = auth {
        return json_error(403, &reason);
    }

    let result = handle.block_on(execute_command(app, cmd, &args_map, plugin_id));

    match result {
        Ok(data) => json_ok(data),
        Err(e) => json_error(500, &e),
    }
}

async fn execute_command<R: Runtime>(
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
            let cid = args
                .get("connectionId")
                .and_then(|v| v.as_str())
                .unwrap_or("");
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
            let list: Vec<_> = store
                .connections
                .iter()
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "name": c.name,
                        "host": c.host,
                        "port": c.port,
                        "username": c.username,
                        "group": c.group,
                    })
                })
                .collect();
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
            let output = state
                .ssh_manager
                .exec_command(sid, command)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::String(output))
        }

        // ── Plugin-scoped commands (shared inner functions) ──
        "plugin_fs_read" | "fs.read" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let config_dir = config_dir_for(app);
            let file_path =
                resolve_read_path(&config_dir, plugin_id, path).map_err(|e| e.to_string())?;
            let content =
                std::fs::read_to_string(&file_path).map_err(|e| format!("read failed: {}", e))?;
            Ok(serde_json::Value::String(content))
        }
        "plugin_fs_write" | "fs.write" => {
            let path = args.get("path").and_then(|v| v.as_str()).unwrap_or("");
            let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("");
            let config_dir = config_dir_for(app);
            let file_path =
                resolve_write_path(&config_dir, plugin_id, path).map_err(|e| e.to_string())?;
            std::fs::write(&file_path, content).map_err(|e| format!("write failed: {}", e))?;
            Ok(serde_json::Value::Null)
        }
        "plugin_http_request" | "net.request" => {
            let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
            let method = args.get("method").and_then(|v| v.as_str()).unwrap_or("GET");
            let headers: HashMap<String, String> = args
                .get("headers")
                .and_then(|v| v.as_object())
                .map(|m| {
                    m.iter()
                        .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                        .collect()
                })
                .unwrap_or_default();
            let body = args
                .get("body")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            let request = crate::commands::plugin_http::PluginHttpRequest {
                url: url.to_string(),
                method: method.to_string(),
                headers,
                body,
            };
            let resp = crate::commands::plugin_http::plugin_http_request_inner(&request)
                .await
                .map_err(|e| e.to_string())?;
            Ok(serde_json::json!({
                "status": resp.status,
                "headers": resp.headers,
                "body": resp.body,
                "url": resp.url,
            }))
        }
        "plugin_send_notification" | "notification" => {
            let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("");
            let body = args.get("body").and_then(|v| v.as_str()).unwrap_or("");
            crate::commands::plugin_notification::plugin_send_notification_inner(
                app, plugin_id, title, body,
            )
            .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }

        _ => Err(format!("unhandled command: {}", cmd)),
    }
}

fn config_dir_for<R: Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn json_ok(data: serde_json::Value) -> Response<std::borrow::Cow<'static, [u8]>> {
    let response = serde_json::json!({ "ok": true, "data": data });
    Response::builder()
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type")
        .body(std::borrow::Cow::Owned(response.to_string().into_bytes()))
        .unwrap_or_else(|_| not_found("api build failed"))
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
        .unwrap_or_else(|_| not_found("api build failed"))
}

/// Fallback plain-text 404 response (used when JSON build itself fails).
fn not_found(msg: &str) -> Response<std::borrow::Cow<'static, [u8]>> {
    Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(std::borrow::Cow::Owned(msg.as_bytes().to_vec()))
        .unwrap()
}
