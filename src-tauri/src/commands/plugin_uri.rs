//! `plugin://` URI scheme handler — static file serving for plugin WebViews.
//!
//! Serves files from `<config_dir>/plugins/<plugin_id>/` with path-traversal
//! protection (via `plugins::fs::is_within_base`). API requests
//! (`plugin://<id>/api/<cmd>`) are forwarded to `plugin_api::handle_plugin_api`.
//! All other requests are served as static files with a guessed MIME type.

use tauri::http::Response;
use tauri::{Manager, Runtime};

use crate::plugins::enabled::is_plugin_enabled;
use crate::plugins::fs::is_within_base;

use super::plugin_api::handle_plugin_api;

/// Entry point registered as the `plugin://` URI scheme handler in `lib.rs`.
pub fn handle_plugin_uri<R: Runtime>(
    ctx: tauri::UriSchemeContext<'_, R>,
    request: tauri::http::Request<Vec<u8>>,
) -> Response<std::borrow::Cow<'static, [u8]>> {
    let app = ctx.app_handle();
    let uri = request.uri();
    let plugin_id = uri.host().unwrap_or("").to_string();
    let path = uri.path().to_string();

    if !is_plugin_enabled(app, &plugin_id) {
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
        Err(_) => return server_error("no config dir"),
    };
    let rel = path.trim_start_matches('/').to_string();
    let plugin_dir = config_dir.join("plugins").join(&plugin_id);
    let candidate = plugin_dir.join(if rel.is_empty() { "index.html" } else { &rel });
    if !is_within_base(&plugin_dir, &candidate) {
        return forbidden("invalid plugin resource path");
    }
    let file_path = match candidate.canonicalize() {
        Ok(p) => p,
        Err(_) => return not_found("plugin resource not found"),
    };

    match std::fs::read(&file_path) {
        Ok(data) => {
            let mime = guess_mime(&file_path);
            Response::builder()
                .header("Content-Type", mime)
                .body(std::borrow::Cow::Owned(data))
                .unwrap_or_else(|_| not_found("build failed"))
        }
        Err(_) => not_found(&format!("not found: {}", file_path.display())),
    }
}

/// Guess a MIME type from the file extension. Used for static plugin resource
/// serving only (HTTP API responses are always `application/json`).
pub(crate) fn guess_mime(path: &std::path::Path) -> &'static str {
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

fn not_found(msg: &str) -> Response<std::borrow::Cow<'static, [u8]>> {
    Response::builder()
        .status(404)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(std::borrow::Cow::Owned(msg.as_bytes().to_vec()))
        .unwrap()
}

fn server_error(msg: &str) -> Response<std::borrow::Cow<'static, [u8]>> {
    Response::builder()
        .status(500)
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
