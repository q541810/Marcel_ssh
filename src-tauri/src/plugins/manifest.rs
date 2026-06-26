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
