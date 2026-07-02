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
    pub command: String,
    #[serde(default)]
    pub parameters: serde_json::Value,
    #[serde(default = "default_risk")]
    pub risk_level: String,
}

fn default_risk() -> String {
    "Moderate".to_string()
}
