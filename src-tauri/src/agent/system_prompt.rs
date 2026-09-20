use crate::agent::templates::{AgentPromptVars, TemplateManager};
use crate::agent::tools::{PromptSection, ToolAudience};
use crate::error::AppError;
use std::collections::BTreeSet;

/// 用户附加指令的字符上限。与插件 `systemPromptSection` 的
/// `PLUGIN_SECTION_MAX_CHARS` 对齐：两者都是用户/第三方往系统提示词里塞的
/// 自由文本，没道理一个有限制一个能无限膨胀。设置页输入框有同样的上限，
/// 这里兜的是手改 settings.json 的情况。
const USER_PROMPT_MAX_CHARS: usize = 2000;

/// Build the agent system prompt by composing template fragments.
///
/// `tool_sections` 由已注册工具的声明推导（见 `tools::prompt_section_of`），
/// 不是逐个工具名 hardcode —— 加一个需要提示词段的工具时不必改这里。
/// `audience` 决定「对用户说话」的段（沟通等）给不给，见 `render_agent_prompt`。
pub(crate) fn build_system_prompt(
    template_manager: &TemplateManager,
    session_id: &str,
    has_skills: bool,
    tool_sections: &BTreeSet<PromptSection>,
    user_prompt: &str,
    plugin_sections: &[String],
    plan_mode: bool,
    audience: ToolAudience,
    extra_sections: &[String],
) -> Result<String, AppError> {
    let user_prompt = if user_prompt.chars().count() > USER_PROMPT_MAX_CHARS {
        log::warn!(
            "用户附加指令超过 {} 字，本次只取前 {} 字",
            USER_PROMPT_MAX_CHARS,
            USER_PROMPT_MAX_CHARS
        );
        user_prompt
            .chars()
            .take(USER_PROMPT_MAX_CHARS)
            .collect::<String>()
    } else {
        user_prompt.to_string()
    };
    let vars = AgentPromptVars {
        session_id: session_id.to_string(),
        user_prompt,
        plugin_sections: plugin_sections.to_vec(),
    };
    template_manager.render_agent_prompt(
        &vars,
        has_skills,
        tool_sections,
        plan_mode,
        audience,
        extra_sections,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试用：`sections` 是「需要提示词段的工具」对应的段集合（真实调用方由
    /// 工具声明表推导，见 `tools::prompt_section_of`）。
    fn build(
        skills: bool,
        sections: &[PromptSection],
        user: &str,
        plugins: &[String],
        plan: bool,
    ) -> String {
        let tool_sections: BTreeSet<PromptSection> = sections.iter().copied().collect();
        build_system_prompt(
            &TemplateManager,
            "session-1",
            skills,
            &tool_sections,
            user,
            plugins,
            plan,
            ToolAudience::Main,
            &[],
        )
        .unwrap()
    }

    #[test]
    fn prompt_omits_disabled_tool_hints() {
        let prompt = build(false, &[], "", &[], false);
        assert!(!prompt.contains("web_search"));
        assert!(!prompt.contains("http_get"));
        assert!(!prompt.contains("skill_"));
        assert!(!prompt.contains("插件扩展指令"));
        assert!(!prompt.contains("Plan 模式"));
        assert!(!prompt.contains("子agent 派发"));
    }

    #[test]
    fn prompt_includes_only_enabled_tool_hints() {
        let prompt = build(
            true,
            &[PromptSection::WebSearch, PromptSection::Subagent],
            "",
            &[],
            false,
        );
        assert!(prompt.contains("web_search"));
        assert!(!prompt.contains("http_get"));
        assert!(prompt.contains("skill_"));
        assert!(prompt.contains("子agent 派发"));
    }

    #[test]
    fn prompt_includes_plan_section_when_plan_mode() {
        let prompt = build(false, &[], "", &[], true);
        assert!(prompt.contains("Plan 模式"));
        assert!(prompt.contains("write_file"));
    }

    #[test]
    fn prompt_omits_plan_section_when_not_plan_mode() {
        let prompt = build(false, &[], "", &[], false);
        assert!(!prompt.contains("Plan 模式"));
    }

    #[test]
    fn prompt_subagent_section_when_subagent_tool_present() {
        let prompt = build(false, &[PromptSection::Subagent], "", &[], false);
        assert!(prompt.contains("子agent 派发"));
        assert!(prompt.contains("subagent"));
    }

    #[test]
    fn prompt_with_empty_plugin_sections_omits_section() {
        let prompt = build(false, &[], "", &[], false);
        assert!(!prompt.contains("插件扩展指令"));
    }

    #[test]
    fn prompt_appends_single_plugin_section() {
        let sections = vec!["记住用户偏好".to_string()];
        let prompt = build(false, &[], "", &sections, false);
        assert!(prompt.contains("插件扩展指令"));
        assert!(prompt.contains("记住用户偏好"));
    }

    #[test]
    fn prompt_appends_multiple_plugin_sections_separated_by_blank_line() {
        let sections = vec!["插件A 指令".to_string(), "插件B 指令".to_string()];
        let prompt = build(false, &[], "", &sections, false);
        assert!(prompt.contains("插件A 指令\n\n插件B 指令"));
    }

    #[test]
    fn prompt_plugin_section_appears_after_user_section() {
        let sections = vec!["PLUGIN_MARKER".to_string()];
        let prompt = build(false, &[], "USER_MARKER", &sections, false);
        let user_pos = prompt.find("USER_MARKER").unwrap();
        let plugin_pos = prompt.find("PLUGIN_MARKER").unwrap();
        assert!(user_pos < plugin_pos);
    }

    #[test]
    fn prompt_with_empty_string_section_still_joins() {
        let sections = vec!["".to_string()];
        let prompt = build(false, &[], "", &sections, false);
        assert!(prompt.contains("插件扩展指令"));
    }

    #[test]
    fn user_prompt_is_capped_at_the_configured_limit() {
        let long = "字".repeat(USER_PROMPT_MAX_CHARS + 500);
        let prompt = build(false, &[], &long, &[], false);
        assert!(!prompt.contains(&"字".repeat(USER_PROMPT_MAX_CHARS + 1)));
        assert!(prompt.contains(&"字".repeat(USER_PROMPT_MAX_CHARS)));

        // 未超限时原样保留。
        let short = "记住用中文回复".to_string();
        let prompt = build(false, &[], &short, &[], false);
        assert!(prompt.contains("记住用中文回复"));
    }
}
