use crate::agent::templates::{AgentPromptVars, TemplateManager};
use crate::error::AppError;

/// Build the agent system prompt by composing template fragments.
pub(crate) fn build_system_prompt(
    template_manager: &TemplateManager,
    session_id: &str,
    has_skills: bool,
    has_web_search: bool,
    has_http_get: bool,
    user_prompt: &str,
    plugin_sections: &[String],
    plan_mode: bool,
    has_task: bool,
) -> Result<String, AppError> {
    let vars = AgentPromptVars {
        session_id: session_id.to_string(),
        user_prompt: user_prompt.to_string(),
        plugin_sections: plugin_sections.to_vec(),
    };
    template_manager.render_agent_prompt(
        &vars,
        has_skills,
        has_web_search,
        has_http_get,
        plan_mode,
        has_task,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(
        skills: bool,
        ws: bool,
        hg: bool,
        user: &str,
        plugins: &[String],
        plan: bool,
        task: bool,
    ) -> String {
        build_system_prompt(
            &TemplateManager,
            "session-1",
            skills,
            ws,
            hg,
            user,
            plugins,
            plan,
            task,
        )
        .unwrap()
    }

    #[test]
    fn prompt_omits_disabled_tool_hints() {
        let prompt = build(false, false, false, "", &[], false, false);
        assert!(!prompt.contains("web_search"));
        assert!(!prompt.contains("http_get"));
        assert!(!prompt.contains("skill_"));
        assert!(!prompt.contains("插件扩展指令"));
        assert!(!prompt.contains("Plan 模式"));
        assert!(!prompt.contains("子agent调研"));
    }

    #[test]
    fn prompt_includes_only_enabled_tool_hints() {
        let prompt = build(true, true, false, "", &[], false, true);
        assert!(prompt.contains("web_search"));
        assert!(!prompt.contains("http_get"));
        assert!(prompt.contains("skill_"));
        assert!(prompt.contains("子agent调研"));
    }

    #[test]
    fn prompt_includes_plan_section_when_plan_mode() {
        let prompt = build(false, false, false, "", &[], true, false);
        assert!(prompt.contains("Plan 模式"));
        assert!(prompt.contains("write_file"));
    }

    #[test]
    fn prompt_omits_plan_section_when_not_plan_mode() {
        let prompt = build(false, false, false, "", &[], false, false);
        assert!(!prompt.contains("Plan 模式"));
    }

    #[test]
    fn prompt_task_section_when_task_tool_present() {
        let prompt = build(false, false, false, "", &[], false, true);
        assert!(prompt.contains("子agent调研"));
        assert!(prompt.contains("task"));
    }

    #[test]
    fn prompt_with_empty_plugin_sections_omits_section() {
        let prompt = build(false, false, false, "", &[], false, false);
        assert!(!prompt.contains("插件扩展指令"));
    }

    #[test]
    fn prompt_appends_single_plugin_section() {
        let sections = vec!["记住用户偏好".to_string()];
        let prompt = build(false, false, false, "", &sections, false, false);
        assert!(prompt.contains("插件扩展指令"));
        assert!(prompt.contains("记住用户偏好"));
    }

    #[test]
    fn prompt_appends_multiple_plugin_sections_separated_by_blank_line() {
        let sections = vec!["插件A 指令".to_string(), "插件B 指令".to_string()];
        let prompt = build(false, false, false, "", &sections, false, false);
        assert!(prompt.contains("插件A 指令\n\n插件B 指令"));
    }

    #[test]
    fn prompt_plugin_section_appears_after_user_section() {
        let sections = vec!["PLUGIN_MARKER".to_string()];
        let prompt = build(false, false, false, "USER_MARKER", &sections, false, false);
        let user_pos = prompt.find("USER_MARKER").unwrap();
        let plugin_pos = prompt.find("PLUGIN_MARKER").unwrap();
        assert!(user_pos < plugin_pos);
    }

    #[test]
    fn prompt_with_empty_string_section_still_joins() {
        let sections = vec!["".to_string()];
        let prompt = build(false, false, false, "", &sections, false, false);
        assert!(prompt.contains("插件扩展指令"));
    }
}
