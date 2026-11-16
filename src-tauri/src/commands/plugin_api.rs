//! HTTP API command dispatcher for the `plugin://<id>/api/<cmd>` channel.
//!
//! Runs on the URI scheme thread. Enforces the same three-layer authorization
//! as the event IPC channel (`pluginIpc.ts::isAuthorized`) via
//! `plugins::auth::authorize`, then dispatches to the shared command
//! implementations (no inline duplicates — fs/net/notification call the same
//! `pub(crate)` inner functions as the Tauri commands).

use std::collections::HashMap;
use std::path::PathBuf;

use tauri::http::{header, HeaderMap, Response};
use tauri::{Manager, Runtime};

use crate::agent::risk::{Disposition, RiskAssessor, SecurityPolicy};
use crate::config::settings::AppSettings;
use crate::plugins::auth::{authorize, AuthResult};
use crate::plugins::capability::capability_for;
use crate::plugins::enabled::manifest_for;
use crate::plugins::fs::{resolve_read_path, resolve_write_path};

/// 校验请求的 `Origin`（若有）是否属于 `plugin_id` 自己的页面。
///
/// `Ok(None)` = 非浏览器请求（无 Origin），不需要 CORS 头；`Err(())` = 来源
/// 与 URL 里的插件 id 不一致，调用方应直接拒绝且不要回任何 CORS 头。
pub(crate) fn request_cors_origin(
    headers: &HeaderMap,
    plugin_id: &str,
) -> Result<Option<String>, ()> {
    let Some(raw) = headers.get(header::ORIGIN) else {
        return Ok(None);
    };
    let origin = raw.to_str().map_err(|_| ())?;
    if origin_matches_plugin(origin, plugin_id) {
        Ok(Some(origin.to_string()))
    } else {
        Err(())
    }
}

/// `plugin://<id>`（macOS/Linux）与 `http(s)://plugin.<id>`（Windows/Android
/// 上 wry 对自定义协议的 workaround）都算该插件自己的页面；其它一律不算。
pub(crate) fn origin_matches_plugin(origin: &str, plugin_id: &str) -> bool {
    let Ok(url) = url::Url::parse(origin) else {
        return false;
    };
    match url.scheme() {
        "plugin" => url
            .host_str()
            .map_or(false, |host| host.eq_ignore_ascii_case(plugin_id)),
        "http" | "https" => url.host_str().map_or(false, |host| {
            host.eq_ignore_ascii_case(&format!("plugin.{}", plugin_id))
        }),
        _ => false,
    }
}

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

    // 跨源请求只允许插件自己的页面；来源与 URL 里的 plugin id 不一致直接拒绝。
    let cors_origin = match request_cors_origin(request.headers(), plugin_id) {
        Ok(origin) => origin,
        Err(()) => return json_error(None, 403, "origin not allowed"),
    };

    let required_cap = match capability_for(cmd) {
        Some(cap) => cap,
        None => {
            return json_error(
                cors_origin.as_deref(),
                400,
                &format!("unknown command: {}", cmd),
            )
        }
    };

    let handle = match tokio::runtime::Handle::try_current() {
        Ok(h) => h,
        Err(_) => return json_error(cors_origin.as_deref(), 500, "no async runtime"),
    };

    // Manifest comes from the registry (cached) — no per-request disk read.
    let manifest = match handle.block_on(manifest_for(app, plugin_id)) {
        Some(m) => m,
        None => return json_error(cors_origin.as_deref(), 404, "plugin not found"),
    };

    let state = app.state::<crate::AppState>();
    let auth = {
        let settings = handle.block_on(state.settings.read());
        authorize(plugin_id, required_cap, Some(&manifest), &settings)
    };
    if let AuthResult::Denied { reason } = auth {
        return json_error(cors_origin.as_deref(), 403, &reason);
    }

    let result = handle.block_on(execute_command(app, cmd, &args_map, plugin_id));

    match result {
        Ok(data) => json_ok(cors_origin.as_deref(), data),
        Err(e) => json_error(cors_origin.as_deref(), 500, &e),
    }
}

/// 插件 `ssh_exec` 的最小硬闸门：只拦「直接拒绝」。
///
/// 这是**刻意的最小闸门**：插件一旦获得 `ssh.exec` 授权，请求审批 / 强制审批 /
/// 放行这些档位都不进入 Agent 的审批流（插件自己的交互由它负责）；但「直接拒绝」
/// 是用户明确禁止的命令，插件也不能绕过去。判定与 Agent 共用同一份
/// `SecurityPolicy::from_app_settings` + `RiskAssessor::assess_command`，规则表、
/// 用户覆盖、自定义规则因此完全一致。
///
/// 纯函数（不碰 Tauri），单测直接喂 `AppSettings`。
fn deny_reason_for_plugin_command(command: &str, settings: &AppSettings) -> Option<String> {
    let policy = SecurityPolicy::from_app_settings(settings);
    let assessment = RiskAssessor::from_optional(Some(&policy)).assess_command(command);
    (assessment.disposition == Disposition::Deny).then(|| {
        assessment
            .reason
            .filter(|reason| !reason.trim().is_empty())
            .unwrap_or_else(|| "判定为灾难性操作".to_string())
    })
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
            // 刻意的最小闸门：只保证「直接拒绝」无法被插件绕过，其余档位保持
            // 现有行为（插件已获 ssh.exec 授权，不引入审批流）。
            let denied = {
                let settings = state.settings.read().await;
                deny_reason_for_plugin_command(command, &settings)
            };
            if let Some(reason) = denied {
                return Err(format!("命令被风险规则拒绝，未执行：{}", reason));
            }
            // 经 command_exec 统一管理器执行（登记记录 + 断连级联取消）。
            // 插件必须显式选择密码交互，轮询类调用默认不会弹框。
            // 默认 120s 超时与旧 `SshManager::exec_command` 一致。
            let ticket = crate::command_exec::CommandTicket::new(
                sid,
                command,
                crate::command_exec::CommandSource::Plugin,
            )
            .interactive_sudo(
                args.get("interactiveSudo")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
            );
            // Production uses Wry; mock runtimes have no password UI.
            let ui = (app as &dyn std::any::Any).downcast_ref::<tauri::AppHandle>();
            let outcome = state.command_exec.submit_opt(ui, ticket).await;
            match outcome {
                crate::command_exec::SubmitOutcome::Completed { output, .. } => {
                    Ok(serde_json::Value::String(output))
                }
                crate::command_exec::SubmitOutcome::TimedOut { .. } => Err(format!(
                    "命令在 120 秒后超时: {}",
                    crate::command_exec::executor::timeout_preview(command)
                )),
                // 插件 ticket 无 task_id，仅断连级联会走到这里
                crate::command_exec::SubmitOutcome::Cancelled { .. } => {
                    Err("SSH 连接已断开".into())
                }
                crate::command_exec::SubmitOutcome::Failed { error } => Err(error.to_string()),
            }
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

fn json_ok(
    origin: Option<&str>,
    data: serde_json::Value,
) -> Response<std::borrow::Cow<'static, [u8]>> {
    let response = serde_json::json!({ "ok": true, "data": data });
    let builder = Response::builder()
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type");
    let builder = match origin {
        Some(origin) => builder.header("Access-Control-Allow-Origin", origin),
        None => builder,
    };
    builder
        .body(std::borrow::Cow::Owned(response.to_string().into_bytes()))
        .unwrap_or_else(|_| not_found("api build failed"))
}

fn json_error(
    origin: Option<&str>,
    status: u16,
    msg: &str,
) -> Response<std::borrow::Cow<'static, [u8]>> {
    let response = serde_json::json!({ "ok": false, "data": msg });
    let builder = Response::builder()
        .status(status)
        .header("Content-Type", "application/json; charset=utf-8")
        .header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type");
    let builder = match origin {
        Some(origin) => builder.header("Access-Control-Allow-Origin", origin),
        None => builder,
    };
    builder
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::risk::CustomRiskRule;

    /// 「直接拒绝」是硬闸门：插件拿到 ssh.exec 也不能执行。
    #[test]
    fn plugin_ssh_gate_rejects_deny_level() {
        let settings = AppSettings::default();
        let reason =
            deny_reason_for_plugin_command("rm -rf /", &settings).expect("删除根目录属于直接拒绝");
        assert!(!reason.trim().is_empty());
    }

    /// 其余档位保持现状：请求审批 / 强制审批都不在这里变成弹窗或拒绝。
    #[test]
    fn plugin_ssh_gate_passes_non_deny_levels() {
        let settings = AppSettings::default();
        assert!(deny_reason_for_plugin_command("ls -la", &settings).is_none());
        assert!(
            deny_reason_for_plugin_command("systemctl restart nginx", &settings).is_none(),
            "强制审批档不进入插件闸门（插件已获 ssh.exec 授权）"
        );
    }

    /// 用户自定义的「直接拒绝」规则同样生效（证明 settings → policy 的接线没漏）。
    #[test]
    fn plugin_ssh_gate_uses_user_custom_rules() {
        let mut settings = AppSettings::default();
        settings.custom_risk_rules.push(CustomRiskRule {
            id: "test-echo".into(),
            command: "echo".into(),
            level: Disposition::Deny,
            enabled: true,
            ..Default::default()
        });
        assert!(deny_reason_for_plugin_command("echo hi", &settings).is_some());
    }

    #[test]
    fn own_plugin_origins_are_allowed() {
        // macOS/Linux 的原生自定义 scheme
        assert!(origin_matches_plugin("plugin://plug-a", "plug-a"));
        // Windows/Android 上 wry 的 http(s)://<scheme>.<host> workaround
        assert!(origin_matches_plugin("http://plugin.plug-a", "plug-a"));
        assert!(origin_matches_plugin("https://plugin.plug-a", "plug-a"));
    }

    #[test]
    fn cross_plugin_and_foreign_origins_are_rejected() {
        assert!(!origin_matches_plugin("http://plugin.plug-b", "plug-a"));
        assert!(!origin_matches_plugin("plugin://plug-b", "plug-a"));
        // 主窗口 / 普通网页都不是插件页面
        assert!(!origin_matches_plugin("tauri://localhost", "plug-a"));
        assert!(!origin_matches_plugin("http://tauri.localhost", "plug-a"));
        assert!(!origin_matches_plugin("https://evil.example", "plug-a"));
        assert!(!origin_matches_plugin("null", "plug-a"));
    }

    #[test]
    fn cors_origin_requires_header_and_matching_plugin() {
        let mut headers = HeaderMap::new();
        assert_eq!(request_cors_origin(&headers, "plug-a"), Ok(None));

        headers.insert(header::ORIGIN, "http://plugin.plug-a".parse().unwrap());
        assert_eq!(
            request_cors_origin(&headers, "plug-a"),
            Ok(Some("http://plugin.plug-a".to_string()))
        );

        headers.insert(header::ORIGIN, "http://plugin.plug-b".parse().unwrap());
        assert_eq!(request_cors_origin(&headers, "plug-a"), Err(()));
    }
}
