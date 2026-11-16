//! 插件页面调用守卫。
//!
//! 插件视图 / 独立窗口与主窗口共用同一套 Tauri IPC。Tauri v2 只对 `plugin:`
//! 前缀的命令做 ACL；本应用没有 app ACL manifest，自定义 app 命令默认不受
//! capability 约束。因此必须在统一入口按「调用者属于哪个插件」再做一道判定：
//!
//! - 非插件 WebView（主窗口、普通窗口）：放行，保持既有功能；
//! - 插件 WebView：`plugin:` 核心命令（事件 / 窗口，由 Tauri ACL 另行约束）
//!   放行；`plugin_fs_read` / `plugin_fs_write` 只允许 `pluginId` 等于调用者
//!   自己的插件；其余 app 命令一律拒绝。
//!
//! 插件自己的能力入口是 `plugin://<id>/api/*` 与事件 IPC（`plugin-request`），
//! 不走直接 `invoke`。声明见 `docs/plugin-api.md` 的安全边界。

use std::collections::HashMap;
use std::sync::OnceLock;

use serde_json::Value;
use tauri::ipc::{Invoke, InvokeBody};
use tauri::Runtime;

/// label → 所属插件 id。只登记插件页面 WebView（插件视图 / 配置页 / 独立窗口）。
///
/// 用 `OnceLock` 而不是裸 `static mut`：表只在首次使用时初始化，之后由
/// `parking_lot::Mutex` 串行化读写。
static PLUGIN_WEBVIEWS: OnceLock<parking_lot::Mutex<HashMap<String, String>>> = OnceLock::new();

fn webviews() -> &'static parking_lot::Mutex<HashMap<String, String>> {
    PLUGIN_WEBVIEWS.get_or_init(|| parking_lot::Mutex::new(HashMap::new()))
}

/// 登记一个插件页面 WebView。创建成功后调用。
pub fn remember_plugin_webview(label: &str, plugin_id: &str) {
    webviews()
        .lock()
        .insert(label.to_string(), plugin_id.to_string());
}

/// 注销一个插件页面 WebView。关闭 / 销毁时调用。
pub fn forget_plugin_webview(label: &str) {
    webviews().lock().remove(label);
}

/// 查询某个 WebView label 所属的插件 id；不是插件页面则返回 `None`。
pub fn plugin_of_webview(label: &str) -> Option<String> {
    webviews().lock().get(label).cloned()
}

/// 守卫判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Decision {
    Allow,
    Deny(&'static str),
}

/// 插件页面直接调用 app 命令时的统一拒绝文案。
pub const DENY_PLUGIN_APP_COMMAND: &str = "插件必须通过 plugin:// API 或自己的工具调用";
/// 插件页面访问别的插件目录时的拒绝文案。
const DENY_PLUGIN_FS_OTHER: &str = "插件只能访问自己的目录";

/// 纯判定：`caller_plugin_id == None` 表示非插件 WebView（主窗口等）。
///
/// 单独抽成纯函数，守卫的行为不依赖 Tauri 运行时即可单测。
pub fn decide(caller_plugin_id: Option<&str>, command: &str, payload: &Value) -> Decision {
    let Some(caller) = caller_plugin_id else {
        return Decision::Allow;
    };

    // 核心插件命令（`plugin:event|...`、`plugin:window|...` 等）由 Tauri ACL
    // 按 capability 约束，这里不重复判断。
    if command.starts_with("plugin:") {
        return Decision::Allow;
    }

    if command == "plugin_fs_read" || command == "plugin_fs_write" {
        let target = payload
            .get("pluginId")
            .or_else(|| payload.get("plugin_id"))
            .and_then(Value::as_str);
        return if target == Some(caller) {
            Decision::Allow
        } else {
            Decision::Deny(DENY_PLUGIN_FS_OTHER)
        };
    }

    Decision::Deny(DENY_PLUGIN_APP_COMMAND)
}

/// 按调用者 WebView 检查一条 IPC 请求。
pub fn check_invoke<R: Runtime>(invoke: &Invoke<R>) -> Result<(), &'static str> {
    let caller = plugin_of_webview(invoke.message.webview().label());
    let null = Value::Null;
    let payload = match invoke.message.payload() {
        InvokeBody::Json(value) => value,
        InvokeBody::Raw(_) => &null,
    };

    match decide(caller.as_deref(), invoke.message.command(), payload) {
        Decision::Allow => Ok(()),
        Decision::Deny(reason) => Err(reason),
    }
}

/// 统一 IPC 入口：先过守卫，再交给 `generate_handler!` 生成的处理器。
///
/// 返回 `true` 表示消息已被处理（拒绝也算处理），与 Tauri 的 invoke handler
/// 契约一致。
pub fn dispatch<R: Runtime, F>(invoke: Invoke<R>, handler: F) -> bool
where
    F: FnOnce(Invoke<R>) -> bool,
{
    match check_invoke(&invoke) {
        Ok(()) => handler(invoke),
        Err(reason) => {
            invoke.resolver.reject(reason.to_string());
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn main_window_commands_are_allowed() {
        assert_eq!(decide(None, "ssh_exec", &json!({})), Decision::Allow);
        assert_eq!(decide(None, "plugin_fs_read", &json!({})), Decision::Allow);
        assert_eq!(decide(None, "settings_save", &json!({})), Decision::Allow);
    }

    #[test]
    fn plugin_webview_ssh_exec_is_denied() {
        let d = decide(Some("plug-a"), "ssh_exec", &json!({ "sessionId": "s1" }));
        assert_eq!(d, Decision::Deny(DENY_PLUGIN_APP_COMMAND));
        let d = decide(Some("plug-a"), "ssh_list_sessions", &json!({}));
        assert_eq!(d, Decision::Deny(DENY_PLUGIN_APP_COMMAND));
    }

    #[test]
    fn plugin_webview_can_read_and_write_its_own_dir() {
        assert_eq!(
            decide(
                Some("plug-a"),
                "plugin_fs_read",
                &json!({ "pluginId": "plug-a", "path": "config.json" })
            ),
            Decision::Allow
        );
        assert_eq!(
            decide(
                Some("plug-a"),
                "plugin_fs_write",
                &json!({ "plugin_id": "plug-a", "path": "config.json", "content": "{}" })
            ),
            Decision::Allow
        );
    }

    #[test]
    fn plugin_webview_cannot_read_or_write_another_plugins_dir() {
        assert_eq!(
            decide(
                Some("plug-a"),
                "plugin_fs_read",
                &json!({ "pluginId": "plug-b", "path": "config.json" })
            ),
            Decision::Deny(DENY_PLUGIN_FS_OTHER)
        );
        assert_eq!(
            decide(
                Some("plug-a"),
                "plugin_fs_write",
                &json!({ "pluginId": "plug-b", "path": "config.json" })
            ),
            Decision::Deny(DENY_PLUGIN_FS_OTHER)
        );
        // 缺 pluginId 也按「不是自己的目录」处理，不能 fail-open。
        assert_eq!(
            decide(Some("plug-a"), "plugin_fs_read", &json!({})),
            Decision::Deny(DENY_PLUGIN_FS_OTHER)
        );
    }

    #[test]
    fn plugin_core_commands_pass_through() {
        assert_eq!(
            decide(Some("plug-a"), "plugin:event|emit", &json!({})),
            Decision::Allow
        );
        assert_eq!(
            decide(Some("plug-a"), "plugin:__TAURI_CHANNEL__|fetch", &json!({})),
            Decision::Allow
        );
    }

    #[test]
    fn plugin_keychain_style_commands_are_denied() {
        for cmd in [
            "config_save_password",
            "config_delete_passphrase",
            "config_has_sudo_password",
            "agent_start_task",
            "sftp_write_file",
            "settings_save",
            "connection_save",
        ] {
            assert_eq!(
                decide(Some("plug-a"), cmd, &json!({})),
                Decision::Deny(DENY_PLUGIN_APP_COMMAND),
                "{} 必须拒绝",
                cmd
            );
        }
    }
}
