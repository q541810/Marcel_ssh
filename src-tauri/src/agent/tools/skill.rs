use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::RiskLevel;
use crate::agent::templates::TemplateManager;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;
use crate::skills::store::Skill;

/// skill 注册成工具时的名字前缀。
///
/// 单独提成常量是因为「这次注册里有没有 skill」只能按前缀判断 —— skills 是
/// 运行时动态注册的（`skill_<名称>_<id>`），不像内置工具那样有声明条目。
pub const SKILL_TOOL_PREFIX: &str = "skill_";

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
            format!("{}{}", SKILL_TOOL_PREFIX, id_tag)
        } else {
            format!("{}{}_{}", SKILL_TOOL_PREFIX, safe_name, id_tag)
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
///
/// 文本在 `templates/skill/平台说明.hbs`，桌面/移动走 `is_mobile` 分支——同一份
/// 模板的两个分支都能在桌面构建的测试里跑到（`#[cfg]` 两份副本做不到）。前面的
/// `\n\n` 分隔符由这里补，模板文件只放正文。存储层（skills.json）始终保存纯净
/// 内容，注入只发生在工具调用时。
fn builtin_platform_section() -> String {
    format!(
        "\n\n{}",
        TemplateManager.render_fragment("平台说明", &json!({ "is_mobile": cfg!(mobile) }))
    )
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
