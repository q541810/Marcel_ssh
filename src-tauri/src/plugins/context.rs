//! Context-variable substitution for plugin tool templates and system-prompt
//! sections.
//!
//! Seven variables are supported (all prefixed `__`, wrapped in `{{ }}`):
//!
//! | Variable              | Source                          |
//! |-----------------------|---------------------------------|
//! | `{{__host__}}`        | `SessionInfo.host`              |
//! | `{{__port__}}        | `SessionInfo.port`              |
//! | `{{__host_port__}}    | `host_port` joined with `_`     |
//! | `{{__session_id__}}   | the active session id           |
//! | `{{__connection_id__}}`| `SessionInfo.connection_id`    |
//! | `{{__username__}}     | `SessionInfo.username`          |
//! | `{{__timestamp__}}    | unix seconds at substitution    |
//!
//! Missing values (e.g. no active session) fall back to empty strings and
//! emit a `log::warn!`. This module is the single source of truth — both
//! `plugin_tool.rs` (agent tool templates) and `agent_lifecycle.rs`
//! (systemPromptSection content) route through it.

use serde_json::Value;

use crate::ssh::connection::SessionInfo;

/// The 7 context variables that can appear in plugin templates.
pub const VARIABLES: &[&str] = &[
    "{{__host__}}",
    "{{__port__}}",
    "{{__host_port__}}",
    "{{__session_id__}}",
    "{{__connection_id__}}",
    "{{__username__}}",
    "{{__timestamp__}}",
];

/// Session context used for template-variable substitution. Extracted once
/// per tool call / section render; missing values (e.g. no active session)
/// are represented as empty strings.
#[derive(Debug, Clone, Default)]
pub struct SessionContext {
    pub host: String,
    pub port: String,
    /// `host_port` joined with `_` (e.g. `1.2.3.4_22`). Used as an isolation
    /// key for per-connection files. Distinct from the `host:port` form
    /// returned by the `host_port` handler (used for display).
    pub host_port: String,
    pub session_id: String,
    pub connection_id: String,
    pub username: String,
    pub timestamp: String,
}

impl SessionContext {
    /// Build a `SessionContext` from an active session. `timestamp` is set to
    /// the current unix seconds. All fields are populated from `info` and
    /// `session_id`.
    pub fn from_session(info: &SessionInfo, session_id: &str) -> Self {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_default();
        Self {
            host: info.host.clone(),
            port: info.port.to_string(),
            host_port: format!("{}_{}", info.host, info.port),
            session_id: session_id.to_string(),
            connection_id: info.connection_id.clone().unwrap_or_default(),
            username: info.username.clone(),
            timestamp,
        }
    }

    /// Build an empty context (all variables resolve to empty strings). Used
    /// when there is no active session; the caller should log a warning.
    pub fn empty(session_id: &str) -> Self {
        Self {
            session_id: session_id.to_string(),
            ..Default::default()
        }
    }
}

/// Replace all 7 context variables in `s`. Missing values resolve to empty
/// strings (no warning is emitted here — the caller decides whether a
/// missing session is worth warning about).
pub fn apply_to_string(s: &str, ctx: &SessionContext) -> String {
    s.replace("{{__host__}}", &ctx.host)
        .replace("{{__port__}}", &ctx.port)
        .replace("{{__host_port__}}", &ctx.host_port)
        .replace("{{__session_id__}}", &ctx.session_id)
        .replace("{{__connection_id__}}", &ctx.connection_id)
        .replace("{{__username__}}", &ctx.username)
        .replace("{{__timestamp__}}", &ctx.timestamp)
}

/// Replace context variables in every string value of a JSON object
/// (top-level only). Used to preprocess `kind=local` handler params so that
/// fixed path templates like `memories/{{__host_port__}}.jsonl` are resolved
/// before the handler sees them.
pub fn apply_to_value(value: &mut Value, ctx: &SessionContext) {
    if let Some(obj) = value.as_object_mut() {
        for (_, val) in obj.iter_mut() {
            if let Some(s) = val.as_str() {
                *val = Value::String(apply_to_string(s, ctx));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> SessionContext {
        SessionContext {
            host: "1.2.3.4".into(),
            port: "22".into(),
            host_port: "1.2.3.4_22".into(),
            session_id: "sess-abc".into(),
            connection_id: "conn-xyz".into(),
            username: "root".into(),
            timestamp: "1700000000".into(),
        }
    }

    #[test]
    fn replaces_all_seven_variables() {
        let template = "{{__host__}}:{{__port__}} {{__host_port__}} {{__session_id__}} {{__connection_id__}} {{__username__}} {{__timestamp__}}";
        assert_eq!(
            apply_to_string(template, &ctx()),
            "1.2.3.4:22 1.2.3.4_22 sess-abc conn-xyz root 1700000000"
        );
    }

    #[test]
    fn leaves_unrelated_text_untouched() {
        assert_eq!(apply_to_string("hello world", &ctx()), "hello world");
        assert_eq!(
            apply_to_string("{{__unknown__}}", &ctx()),
            "{{__unknown__}}"
        );
    }

    #[test]
    fn empty_context_yields_empty_strings() {
        let empty = SessionContext::empty("s1");
        let template = "{{__host__}}-{{__port__}}-{{__session_id__}}";
        assert_eq!(apply_to_string(template, &empty), "--s1");
    }

    #[test]
    fn from_session_populates_fields() {
        let info = SessionInfo {
            host: "h".into(),
            port: 22,
            username: "u".into(),
            connection_id: Some("c".into()),
        };
        let c = SessionContext::from_session(&info, "s");
        assert_eq!(c.host, "h");
        assert_eq!(c.port, "22");
        assert_eq!(c.host_port, "h_22");
        assert_eq!(c.session_id, "s");
        assert_eq!(c.connection_id, "c");
        assert_eq!(c.username, "u");
        assert!(!c.timestamp.is_empty());
    }

    #[test]
    fn from_session_with_no_connection_id() {
        let info = SessionInfo {
            host: "h".into(),
            port: 22,
            username: "u".into(),
            connection_id: None,
        };
        let c = SessionContext::from_session(&info, "s");
        assert_eq!(c.connection_id, "");
    }

    #[test]
    fn apply_to_value_replaces_string_fields() {
        let mut v = serde_json::json!({
            "path": "memories/{{__host_port__}}.jsonl",
            "count": 42,
            "flag": true,
        });
        apply_to_value(&mut v, &ctx());
        assert_eq!(v["path"], "memories/1.2.3.4_22.jsonl");
        // non-strings untouched
        assert_eq!(v["count"], 42);
        assert_eq!(v["flag"], true);
    }

    #[test]
    fn apply_to_value_handles_non_object() {
        let mut v = serde_json::json!(42);
        apply_to_value(&mut v, &ctx());
        assert_eq!(v, 42);
    }

    #[test]
    fn variables_list_has_seven_entries() {
        assert_eq!(VARIABLES.len(), 7);
    }
}