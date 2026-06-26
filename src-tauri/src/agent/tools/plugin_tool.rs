use async_trait::async_trait;
use serde_json::Value;

use crate::agent::sandbox::{RiskLevel, Sandbox};
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;
use crate::plugins::manifest::PluginAgentToolDef;

pub struct PluginAgentTool {
    name: String,
    description: String,
    command_template: String,
    parameters: Value,
    risk_level: RiskLevel,
}

impl PluginAgentTool {
    pub fn new(def: &PluginAgentToolDef) -> Self {
        let risk = match def.risk_level.as_str() {
            "ReadOnly" => RiskLevel::ReadOnly,
            "LowRisk" => RiskLevel::LowRisk,
            "HighRisk" => RiskLevel::HighRisk,
            _ => RiskLevel::Moderate,
        };
        Self {
            name: def.name.clone(),
            description: def.description.clone(),
            command_template: def.command.clone(),
            parameters: if def.parameters.is_null() {
                serde_json::json!({ "type": "object", "properties": {} })
            } else {
                def.parameters.clone()
            },
            risk_level: risk,
        }
    }

    fn render_command(&self, params: &Value) -> String {
        let mut cmd = self.command_template.clone();
        if let Some(obj) = params.as_object() {
            for (key, val) in obj {
                let placeholder = format!("{{{{{}}}}}", key);
                let replacement = match val {
                    Value::String(s) => s.clone(),
                    _ => val.to_string(),
                };
                cmd = cmd.replace(&placeholder, &replacement);
            }
        }
        cmd
    }
}

#[async_trait]
impl AgentTool for PluginAgentTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters_schema(&self) -> Value {
        self.parameters.clone()
    }

    fn risk_level(&self) -> RiskLevel {
        self.risk_level
    }

    async fn execute(
        &self,
        params: Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let command = self.render_command(&params);

        let sandbox = ctx
            .policy
            .as_ref()
            .map(|p| Sandbox::new((**p).clone()))
            .unwrap_or_default();
        let risk = sandbox.check_command(&command)?;
        if risk == RiskLevel::HighRisk {
            return Ok(ToolOutput::fail(
                "Blocked by sandbox",
                format!(
                    "命令被安全沙箱拒绝（插件工具: {}）。\n命令: {}",
                    self.name, command
                ),
            ));
        }

        let output = ctx.exec(&command).await?;
        let truncated = truncate_output(output, 8_000);
        Ok(ToolOutput::ok(
            format!("插件工具 {} 执行完成", self.name),
            truncated,
        ))
    }
}

pub fn register_plugin_tools(
    registry: &mut crate::agent::tools::ToolRegistry,
    tools: &[PluginAgentToolDef],
) {
    for def in tools {
        registry.register(std::sync::Arc::new(PluginAgentTool::new(def)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_def(name: &str, cmd: &str, risk: &str) -> PluginAgentToolDef {
        PluginAgentToolDef {
            name: name.into(),
            description: "test".into(),
            command: cmd.into(),
            parameters: serde_json::json!({
                "type": "object",
                "properties": {
                    "arg": { "type": "string" }
                }
            }),
            risk_level: risk.into(),
        }
    }

    #[test]
    fn render_command_replaces_placeholders() {
        let tool = PluginAgentTool::new(&make_def("test", "echo {{arg}}", "ReadOnly"));
        let cmd = tool.render_command(&serde_json::json!({ "arg": "hello" }));
        assert_eq!(cmd, "echo hello");
    }

    #[test]
    fn render_command_handles_missing_params() {
        let tool = PluginAgentTool::new(&make_def("test", "echo {{arg}}", "ReadOnly"));
        let cmd = tool.render_command(&serde_json::json!({}));
        assert_eq!(cmd, "echo {{arg}}");
    }

    #[test]
    fn risk_level_parses_correctly() {
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", "ReadOnly")).risk_level(),
            RiskLevel::ReadOnly
        );
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", "LowRisk")).risk_level(),
            RiskLevel::LowRisk
        );
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", "HighRisk")).risk_level(),
            RiskLevel::HighRisk
        );
        assert_eq!(
            PluginAgentTool::new(&make_def("t", "cmd", "invalid")).risk_level(),
            RiskLevel::Moderate
        );
    }

    #[test]
    fn null_parameters_defaults_to_empty_object() {
        let mut def = make_def("t", "cmd", "ReadOnly");
        def.parameters = Value::Null;
        let tool = PluginAgentTool::new(&def);
        assert_eq!(tool.parameters_schema()["type"], "object");
    }
}
