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
        // 非 ASCII 字母数字替换为 _，折叠连续 _ 并去除首尾 _。
        // 纯中文名会得到空串（或撞名），此时追加 id 前 8 位保证工具名
        // 稳定且互不冲突（内置 skill id 固定，工具名跨启动一致）。
        let mut safe_name = String::new();
        let mut prev_underscore = true; // 抑制开头的 _
        for c in skill.name.chars() {
            if c.is_ascii_alphanumeric() || c == '-' {
                safe_name.push(c);
                prev_underscore = false;
            } else if !prev_underscore {
                safe_name.push('_');
                prev_underscore = true;
            }
        }
        let safe_name = safe_name.trim_matches('_');
        let id_tag: String = skill
            .id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .take(8)
            .collect();
        let name = if safe_name.is_empty() {
            format!("skill_{}", id_tag)
        } else {
            format!("skill_{}_{}", safe_name, id_tag)
        };
        let mut prompt = skill.prompt.clone();
        if crate::skills::builtin::is_builtin_skill_id(&skill.id) {
            prompt.push_str(&builtin_platform_section());
        }
        Self {
            name,
            display_name: skill.name.clone(),
            description: format!("{}: {}", skill.name, skill.description),
            prompt,
        }
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }
}

/// 内置教学 skill 调用时追加的平台说明。
/// 桌面与 Android 是分别构建的二进制，编译期判定即可，无需运行时探测；
/// 存储层（skills.json）始终保存纯净内容，注入只发生在工具调用时。
fn builtin_platform_section() -> &'static str {
    // 两个 cfg 块恰好编译其一
    #[cfg(mobile)]
    {
        "\n\n---\n\n## 用户当前平台\n\n用户当前正在使用 Marcel SSH 的**移动版（Android）**。指导操作时只使用该端的界面路径；内容区分桌面端与移动端时，以该端为准。若不确定用户当前所在界面，先询问再指导。\n"
    }
    #[cfg(desktop)]
    {
        "\n\n---\n\n## 用户当前平台\n\n用户当前正在使用 Marcel SSH 的**桌面版**。指导操作时只使用该端的界面路径；内容区分桌面端与移动端时，以该端为准。若不确定用户当前所在界面，先询问再指导。\n"
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_skill_gets_platform_section() {
        let mut skill = Skill::new("Agent 模式与审批指导", "教学", "正文内容");
        skill.id = "builtin.agent-modes".into();
        let tool = SkillTool::new(&skill);
        assert!(
            tool.prompt.contains("用户当前平台"),
            "内置 skill 必须追加平台段"
        );
        assert!(
            tool.prompt.contains("桌面版") || tool.prompt.contains("移动版"),
            "平台段必须包含具体平台名"
        );
        assert!(tool.prompt.contains("正文内容"), "原 prompt 必须保留");
    }

    #[test]
    fn user_skill_has_no_platform_section() {
        // 普通 uuid id（用户自建 skill 的形态）
        let skill = Skill::new("我的技能", "desc", "正文内容");
        assert!(!crate::skills::builtin::is_builtin_skill_id(&skill.id));
        let tool = SkillTool::new(&skill);
        assert!(!tool.prompt.contains("用户当前平台"));
        assert!(tool.prompt.contains("正文内容"));
    }
}
