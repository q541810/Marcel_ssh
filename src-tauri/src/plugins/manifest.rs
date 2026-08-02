use serde::{Deserialize, Serialize};

use crate::agent::RiskLevel;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub version: String,
    pub name: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub views: Vec<PluginViewDef>,
    #[serde(default)]
    pub agent_tools: Vec<PluginAgentToolDef>,
    #[serde(default)]
    pub config_view: Option<String>,
    /// Content script injections: JS/CSS injected into the main window.
    /// Requires the `ui.inject` capability.
    #[serde(default)]
    pub injections: Vec<PluginInjectionDef>,
    /// Optional path (relative to plugin root) of a static Markdown section
    /// appended to the Agent system prompt. Only injected in Agent/Auto mode.
    /// The file content supports context-variable substitution
    /// (e.g. `{{__host_port__}}`).
    #[serde(default)]
    pub system_prompt_section: Option<String>,
    /// Minimum app version this plugin is compatible with (semver-like, optional).
    /// When the running app version is lower, the plugin is loaded into the
    /// registry but automatically disabled (state `Incompatible`) — it is not
    /// enabled, its tools/injections never activate, and the settings UI shows
    /// the required version.
    #[serde(default)]
    pub min_app_version: Option<String>,
}

/// A content-script injection entry. The plugin's JS runs inside the main
/// window and can manipulate the DOM freely (subject to capability checks
/// on IPC calls). CSS is injected as a global `<style>` tag.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInjectionDef {
    /// Unique id within the plugin (e.g. "main-ui").
    pub id: String,
    /// Which main-UI regions this injection targets. Values match
    /// `data-region` attributes. "*" means always inject.
    #[serde(default)]
    pub matches: Vec<String>,
    /// CSS file paths relative to the plugin root, injected as `<style>` tags.
    #[serde(default)]
    pub styles: Vec<String>,
    /// JS file paths relative to the plugin root, executed with the `marcel`
    /// runtime API as the argument.
    #[serde(default)]
    pub scripts: Vec<String>,
    /// When to inject: "idle" (default, on next idle callback after load)
    /// or "instant" (immediately when plugins are loaded).
    #[serde(default = "default_run_at")]
    pub run_at: RunAt,
    /// Sort weight for multi-plugin ordering (lower = earlier).
    #[serde(default = "default_injection_order")]
    pub order: i32,
}

/// When a content-script injection runs.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RunAt {
    /// On the next idle callback after load (default).
    #[default]
    Idle,
    /// Immediately when plugins are loaded.
    Instant,
}

fn default_run_at() -> RunAt {
    RunAt::Idle
}

fn default_injection_order() -> i32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginViewDef {
    pub id: String,
    pub mount: ViewMount,
    pub title: String,
    #[serde(default)]
    pub icon: Option<PluginIconDef>,
    #[serde(default)]
    pub nav_group: Option<String>,
    #[serde(default)]
    pub order: i32,
    pub entry: String,
    #[serde(default)]
    pub exclusive: bool,
}

/// Where a plugin view mounts in the main UI. Only `sidebar` and `settings`
/// are exposed to plugins; `agent` and `center` are reserved for builtins
/// and rejected at parse time if a plugin declares them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ViewMount {
    Sidebar,
    Settings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIconDef {
    pub kind: IconKind,
    pub src: String,
}

/// Icon rendering strategy. `svg` injects inline SVG markup; `img` loads
/// `src` as an image URL; `emoji` renders `src` as a glyph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IconKind {
    Svg,
    Img,
    Emoji,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginAgentToolDef {
    pub name: String,
    pub description: String,
    #[serde(default)]
    pub command: String,
    /// Tool execution kind: `"ssh"` (default, runs `command` on the remote
    /// server via SSH) or `"local"` (calls a kernel-registered handler).
    #[serde(default = "default_tool_kind")]
    pub kind: ToolKind,
    /// Required when `kind = "local"`. Names a kernel-registered local
    /// handler (e.g. `"fs.read"`, `"fs.append"`). Ignored for `kind = "ssh"`.
    #[serde(default)]
    pub handler: Option<String>,
    #[serde(default)]
    pub parameters: serde_json::Value,
    #[serde(default = "default_risk")]
    pub risk_level: RiskLevel,
}

/// Plugin agent tool execution mode.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToolKind {
    /// Runs `command` on the remote server via SSH (default).
    #[default]
    Ssh,
    /// Calls a kernel-registered local handler.
    Local,
}

fn default_risk() -> RiskLevel {
    RiskLevel::Moderate
}

fn default_tool_kind() -> ToolKind {
    ToolKind::Ssh
}

impl PluginAgentToolDef {
    /// Validate the tool definition. Returns `Err(message)` if the tool
    /// should be skipped (e.g. `kind=local` without a `handler`).
    pub fn validate(&self) -> Result<(), String> {
        if self.kind == ToolKind::Local && self.handler.as_deref().map_or(true, |h| h.is_empty()) {
            return Err(format!(
                "agent tool `{}` has kind=local but no handler",
                self.name
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_kind_is_ssh() {
        let raw = r#"{
            "name": "test",
            "description": "",
            "command": "echo hi"
        }"#;
        let def: PluginAgentToolDef = serde_json::from_str(raw).unwrap();
        assert_eq!(def.kind, ToolKind::Ssh);
        assert!(def.handler.is_none());
    }

    #[test]
    fn local_without_handler_fails_validation() {
        let def = PluginAgentToolDef {
            name: "test".into(),
            description: "".into(),
            command: "".into(),
            kind: ToolKind::Local,
            handler: None,
            parameters: serde_json::Value::Null,
            risk_level: RiskLevel::LowRisk,
        };
        assert!(def.validate().is_err());
    }

    #[test]
    fn local_with_handler_passes_validation() {
        let def = PluginAgentToolDef {
            name: "test".into(),
            description: "".into(),
            command: "".into(),
            kind: ToolKind::Local,
            handler: Some("fs.append".into()),
            parameters: serde_json::Value::Null,
            risk_level: RiskLevel::LowRisk,
        };
        assert!(def.validate().is_ok());
    }

    #[test]
    fn ssh_kind_passes_validation_without_handler() {
        let def = PluginAgentToolDef {
            name: "test".into(),
            description: "".into(),
            command: "echo hi".into(),
            kind: ToolKind::Ssh,
            handler: None,
            parameters: serde_json::Value::Null,
            risk_level: RiskLevel::ReadOnly,
        };
        assert!(def.validate().is_ok());
    }

    #[test]
    fn manifest_with_system_prompt_section_parses() {
        let raw = r#"{
            "id": "p",
            "version": "1.0.0",
            "name": "P",
            "systemPromptSection": "system-prompt.md"
        }"#;
        let m: PluginManifest = serde_json::from_str(raw).unwrap();
        assert_eq!(m.system_prompt_section.as_deref(), Some("system-prompt.md"));
    }

    #[test]
    fn manifest_without_system_prompt_section_defaults_none() {
        let raw = r#"{
            "id": "p",
            "version": "1.0.0",
            "name": "P"
        }"#;
        let m: PluginManifest = serde_json::from_str(raw).unwrap();
        assert!(m.system_prompt_section.is_none());
    }

    // ── enum validation ──

    #[test]
    fn unknown_risk_level_rejected_at_parse() {
        let raw = r#"{
            "name": "t",
            "description": "",
            "riskLevel": "Catastrophic"
        }"#;
        assert!(serde_json::from_str::<PluginAgentToolDef>(raw).is_err());
    }

    #[test]
    fn unknown_tool_kind_rejected_at_parse() {
        let raw = r#"{
            "name": "t",
            "description": "",
            "kind": "remote"
        }"#;
        assert!(serde_json::from_str::<PluginAgentToolDef>(raw).is_err());
    }

    #[test]
    fn unknown_mount_rejected_at_parse() {
        let raw = r#"{
            "id": "v",
            "mount": "agent",
            "title": "T",
            "entry": "index.html"
        }"#;
        assert!(serde_json::from_str::<PluginViewDef>(raw).is_err());
    }

    #[test]
    fn unknown_run_at_rejected_at_parse() {
        let raw = r#"{ "id": "i", "runAt": "defer" }"#;
        assert!(serde_json::from_str::<PluginInjectionDef>(raw).is_err());
    }

    #[test]
    fn unknown_icon_kind_rejected_at_parse() {
        let raw = r#"{ "kind": "bitmap", "src": "x" }"#;
        assert!(serde_json::from_str::<PluginIconDef>(raw).is_err());
    }

    #[test]
    fn valid_enum_values_parse() {
        let raw = r#"{
            "name": "t",
            "description": "",
            "kind": "local",
            "handler": "fs.read",
            "riskLevel": "HighRisk"
        }"#;
        let def = serde_json::from_str::<PluginAgentToolDef>(raw).unwrap();
        assert_eq!(def.kind, ToolKind::Local);
        assert_eq!(def.risk_level, RiskLevel::HighRisk);
    }

    #[test]
    fn run_at_defaults_to_idle() {
        let raw = r#"{ "id": "i" }"#;
        let def = serde_json::from_str::<PluginInjectionDef>(raw).unwrap();
        assert_eq!(def.run_at, RunAt::Idle);
    }

    #[test]
    fn mount_sidebar_parses() {
        let raw = r#"{
            "id": "v",
            "mount": "sidebar",
            "title": "T",
            "entry": "index.html"
        }"#;
        let def = serde_json::from_str::<PluginViewDef>(raw).unwrap();
        assert_eq!(def.mount, ViewMount::Sidebar);
    }
}
