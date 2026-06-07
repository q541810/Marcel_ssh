use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;
use crate::skills::store::Skill;

pub struct SkillTool {
    name: String,
    display_name: String,
    description: String,
    prompt: String,
}

impl SkillTool {
    pub fn new(skill: &Skill) -> Self {
        let safe_name: String = skill
            .name
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                    c
                } else {
                    '_'
                }
            })
            .collect();
        Self {
            name: format!("skill_{}", safe_name),
            display_name: skill.name.clone(),
            description: format!("{}: {}", skill.name, skill.description),
            prompt: skill.prompt.clone(),
        }
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

#[async_trait]
impl AgentTool for SkillTool {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {}
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    async fn execute(
        &self,
        _params: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        Ok(ToolOutput::ok(
            format!("SKILL {}", self.display_name),
            format!(
                "## Skill: {}\n\nYou selected the skill \"{}\". Follow these instructions:\n\n{}",
                self.display_name, self.display_name, self.prompt
            ),
        ))
    }
}
