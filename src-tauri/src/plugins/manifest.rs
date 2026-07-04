use serde::{Deserialize, Serialize};

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
    /// `data-region` attributes: "sidebar" / "center" / "agent" /
    /// "terminal" / "settings" / "sessions" / "skills" / "mcp" /
    /// "agent-panel". "*" means always inject.
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
    pub run_at: String,
    /// Sort weight for multi-plugin ordering (lower = earlier).
    #[serde(default = "default_injection_order")]
    pub order: i32,
}

fn default_run_at() -> String {
    "idle".to_string()
}

fn default_injection_order() -> i32 {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginViewDef {
    pub id: String,
    pub mount: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginIconDef {
    pub kind: String,
    pub src: String,
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
    pub kind: String,
    /// Required when `kind = "local"`. Names a kernel-registered local
    /// handler (e.g. `"fs.read"`, `"fs.append"`). Ignored for `kind = "ssh"`.
    #[serde(default)]
    pub handler: Option<String>,
    #[serde(default)]
    pub parameters: serde_json::Value,
    #[serde(default = "default_risk")]
    pub risk_level: String,
}

fn default_risk() -> String {
    "Moderate".to_string()
}

fn default_tool_kind() -> String {
    "ssh".to_string()
}

impl PluginAgentToolDef {
    /// Validate the tool definition. Returns `Err(message)` if the tool
    /// should be skipped (e.g. `kind=local` without a `handler`).
    pub fn validate(&self) -> Result<(), String> {
        if self.kind == "local" && self.handler.as_deref().map_or(true, |h| h.is_empty()) {
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
        assert_eq!(def.kind, "ssh");
        assert!(def.handler.is_none());
    }

    #[test]
    fn local_without_handler_fails_validation() {
        let def = PluginAgentToolDef {
            name: "test".into(),
            description: "".into(),
            command: "".into(),
            kind: "local".into(),
            handler: None,
            parameters: serde_json::Value::Null,
            risk_level: "LowRisk".into(),
        };
        assert!(def.validate().is_err());
    }

    #[test]
    fn local_with_handler_passes_validation() {
        let def = PluginAgentToolDef {
            name: "test".into(),
            description: "".into(),
            command: "".into(),
            kind: "local".into(),
            handler: Some("fs.append".into()),
            parameters: serde_json::Value::Null,
            risk_level: "LowRisk".into(),
        };
        assert!(def.validate().is_ok());
    }

    #[test]
    fn ssh_kind_passes_validation_without_handler() {
        let def = PluginAgentToolDef {
            name: "test".into(),
            description: "".into(),
            command: "echo hi".into(),
            kind: "ssh".into(),
            handler: None,
            parameters: serde_json::Value::Null,
            risk_level: "ReadOnly".into(),
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
}
