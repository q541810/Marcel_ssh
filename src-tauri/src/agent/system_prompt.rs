use crate::agent::task::AgentMode;
use crate::agent::templates::{AgentPromptVars, TemplateManager};
use crate::agent::tools::{PromptSection, ToolAudience};
use crate::error::AppError;
use std::collections::BTreeSet;

/// Build the agent system prompt by composing template fragments.
///
/// `tool_sections` 由已注册工具的声明推导（见 `tools::prompt_section_of`），
/// 不是逐个工具名 hardcode —— 加一个需要提示词段的工具时不必改这里。
/// `audience` 决定「对用户说话」的段（沟通等）给不给，见 `render_agent_prompt`。
/// `mode` 原样交给模板层：Plan 追加规划段，Agent/Auto 在「运行模式」段声明当前档。
pub(crate) fn build_system_prompt(
    template_manager: &TemplateManager,
    session_id: &str,
    has_skills: bool,
    tool_sections: &BTreeSet<PromptSection>,
    user_prompt: &str,
    plugin_sections: &[String],
    mode: &AgentMode,
    audience: ToolAudience,
    extra_sections: &[String],
    memory_section: &str,
) -> Result<String, AppError> {
    let vars = AgentPromptVars {
        session_id: session_id.to_string(),
        user_prompt: user_prompt.to_string(),
        plugin_sections: plugin_sections.to_vec(),
        memory_section: memory_section.to_string(),
    };
    template_manager.render_agent_prompt(
        &vars,
        has_skills,
        tool_sections,
        mode,
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
        mode: AgentMode,
    ) -> String {
        let tool_sections: BTreeSet<PromptSection> = sections.iter().copied().collect();
        build_system_prompt(
            &TemplateManager,
            "session-1",
            skills,
            &tool_sections,
            user,
            plugins,
            &mode,
            ToolAudience::Main,
            &[],
            "",
        )
        .unwrap()
    }

    #[test]
    fn prompt_omits_disabled_tool_hints() {
        let prompt = build(false, &[], "", &[], AgentMode::Agent);
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
            AgentMode::Agent,
        );
        assert!(prompt.contains("web_search"));
        assert!(!prompt.contains("http_get"));
        assert!(prompt.contains("skill_"));
        assert!(prompt.contains("子agent 派发"));
    }

    #[test]
    fn prompt_includes_plan_section_when_plan_mode() {
        let prompt = build(false, &[], "", &[], AgentMode::Plan);
        assert!(prompt.contains("Plan 模式"));
        assert!(prompt.contains("write_file"));
    }

    #[test]
    fn prompt_tells_the_model_which_exec_mode_it_is_in() {
        let auto = build(false, &[], "", &[], AgentMode::Auto);
        assert!(auto.contains("当前处于 **AUTO 模式**"));
        assert!(auto.contains("不要为了「让操作有人审批」建议切到 Agent"));
        assert!(!auto.contains("## Plan 模式"));

        let agent = build(false, &[], "", &[], AgentMode::Agent);
        assert!(agent.contains("当前处于 **Agent 模式**"));
        assert!(agent.contains("不要建议切到你已经在的模式"));
        assert!(!agent.contains("## Plan 模式"));
    }

    /// 后台作业那段必须与「回合不再被作业持住」这条新语义一致。
    ///
    /// 这条护栏钉的是**模型读到的契约**：旧文案承诺「你无法直接结束时，系统会
    /// 等你处理完」—— 那是持住回合时代的说法，早已不成立（模型会据此把结论拖着
    /// 不给、以为系统会替它等）。改回旧措辞、或抹掉承载新语义的那两处关键说明
    /// （作业跑完会**再开一轮**交回、真被挡住才自己 wait），这里就红。
    #[test]
    fn job_section_matches_the_no_longer_held_turn_semantics() {
        let prompt = build(false, &[], "", &[], AgentMode::Agent);
        assert!(
            !prompt.contains("系统会等你处理完"),
            "旧文案承诺了系统会替模型等作业 —— 回合早就不再被作业持住了"
        );
        assert!(
            prompt.contains("再开一轮"),
            "要告诉模型作业跑完会由系统再开一轮把结局交给它"
        );
        assert!(
            prompt.contains("wait=true"),
            "要告诉模型真的被挡住时用 job_output 的 wait 自己等（单次有上限）"
        );
    }

    #[test]
    fn prompt_omits_plan_section_when_not_plan_mode() {
        let prompt = build(false, &[], "", &[], AgentMode::Agent);
        assert!(!prompt.contains("Plan 模式"));
    }

    #[test]
    fn prompt_subagent_section_when_subagent_tool_present() {
        let prompt = build(false, &[PromptSection::Subagent], "", &[], AgentMode::Agent);
        assert!(prompt.contains("子agent 派发"));
        assert!(prompt.contains("subagent"));
    }

    #[test]
    fn prompt_with_empty_plugin_sections_omits_section() {
        let prompt = build(false, &[], "", &[], AgentMode::Agent);
        assert!(!prompt.contains("插件扩展指令"));
    }

    #[test]
    fn prompt_appends_single_plugin_section() {
        let sections = vec!["记住用户偏好".to_string()];
        let prompt = build(false, &[], "", &sections, AgentMode::Agent);
        assert!(prompt.contains("插件扩展指令"));
        assert!(prompt.contains("记住用户偏好"));
    }

    #[test]
    fn prompt_appends_multiple_plugin_sections_separated_by_blank_line() {
        let sections = vec!["插件A 指令".to_string(), "插件B 指令".to_string()];
        let prompt = build(false, &[], "", &sections, AgentMode::Agent);
        assert!(prompt.contains("插件A 指令\n\n插件B 指令"));
    }

    #[test]
    fn prompt_plugin_section_appears_after_user_section() {
        let sections = vec!["PLUGIN_MARKER".to_string()];
        let prompt = build(false, &[], "USER_MARKER", &sections, AgentMode::Agent);
        let user_pos = prompt.find("USER_MARKER").unwrap();
        let plugin_pos = prompt.find("PLUGIN_MARKER").unwrap();
        assert!(user_pos < plugin_pos);
    }

    #[test]
    fn prompt_with_empty_string_section_still_joins() {
        let sections = vec!["".to_string()];
        let prompt = build(false, &[], "", &sections, AgentMode::Agent);
        assert!(prompt.contains("插件扩展指令"));
    }

    /// 用户附加指令**不设字数上限**：写了多长就原样注入多长。
    ///
    /// 以前这里会把超过 2000 字的部分切掉（设置页输入框也拦着），但用户写规则
    /// 清单很容易过线，被静默截断比超长更难受。上下文压力由压缩机制兜，不靠这里
    /// 悄悄丢用户的字。
    #[test]
    fn user_prompt_is_injected_verbatim_without_a_cap() {
        let long = "字".repeat(20_000);
        let prompt = build(false, &[], &long, &[], AgentMode::Agent);
        assert!(prompt.contains(&long));

        let short = "记住用中文回复".to_string();
        let prompt = build(false, &[], &short, &[], AgentMode::Agent);
        assert!(prompt.contains("记住用中文回复"));
    }
}
