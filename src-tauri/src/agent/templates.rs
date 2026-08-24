use handlebars::Handlebars;
use serde_json::json;

use crate::error::AppError;

/// Variables injected into agent prompt templates.
pub(crate) struct AgentPromptVars {
    pub session_id: String,
    pub user_prompt: String,
    pub plugin_sections: Vec<String>,
}

/// Stateless template manager. Templates are embedded in the binary via
/// `include_str!`; no runtime file I/O.
pub(crate) struct TemplateManager;

impl TemplateManager {
    fn build_agent_registry() -> Handlebars<'static> {
        let mut reg = Handlebars::new();
        reg.set_strict_mode(false);
        let _ =
            reg.register_template_string("角色", include_str!("../../templates/agent/角色.hbs"));
        let _ =
            reg.register_template_string("会话", include_str!("../../templates/agent/会话.hbs"));
        let _ = reg.register_template_string(
            "联网搜索",
            include_str!("../../templates/agent/联网搜索.hbs"),
        );
        let _ = reg.register_template_string(
            "网页访问",
            include_str!("../../templates/agent/网页访问.hbs"),
        );
        let _ =
            reg.register_template_string("技能", include_str!("../../templates/agent/技能.hbs"));
        let _ = reg.register_template_string(
            "规划模式",
            include_str!("../../templates/agent/规划模式.hbs"),
        );
        let _ = reg
            .register_template_string("子agent", include_str!("../../templates/agent/子agent.hbs"));
        let _ = reg.register_template_string(
            "用户指令",
            include_str!("../../templates/agent/用户指令.hbs"),
        );
        let _ = reg.register_template_string(
            "插件指令",
            include_str!("../../templates/agent/插件指令.hbs"),
        );
        reg
    }

    fn build_approval_registry() -> Handlebars<'static> {
        let mut reg = Handlebars::new();
        reg.set_strict_mode(false);
        let _ =
            reg.register_template_string("审批", include_str!("../../templates/approval/审批.hbs"));
        let _ = reg.register_template_string(
            "审批规划",
            include_str!("../../templates/approval/审批规划.hbs"),
        );
        reg
    }

    /// Render the full agent system prompt by composing applicable template
    /// fragments in order. Conditions (`has_skills`, `plan_mode`, etc.) are
    /// evaluated by the caller — only applicable fragments are included.
    pub fn render_agent_prompt(
        &self,
        vars: &AgentPromptVars,
        has_skills: bool,
        has_web_search: bool,
        has_http_get: bool,
        plan_mode: bool,
        has_task: bool,
        extra_sections: &[String],
    ) -> Result<String, AppError> {
        let reg = Self::build_agent_registry();
        let plugin_joined = vars.plugin_sections.join("\n\n");
        let ctx = json!({
            "session_id": &vars.session_id,
            "user_prompt": &vars.user_prompt,
            "plugin_sections": plugin_joined,
        });

        let render = |name: &str| -> String {
            reg.render(name, &ctx).unwrap_or_else(|e| {
                log::warn!("模板 [{}] 渲染失败: {}", name, e);
                String::new()
            })
        };

        let mut parts: Vec<String> = Vec::new();

        parts.push(render("角色"));
        // 角色追加约束段（如子代理的只读调研约束）——与基础段一样作为组件
        // 统一拼装，紧跟在「角色」之后，而不是在外部字符串拼接。
        for extra in extra_sections {
            parts.push(extra.clone());
        }
        if has_web_search {
            parts.push(render("联网搜索"));
        }
        if has_http_get {
            parts.push(render("网页访问"));
        }
        parts.push(render("会话"));
        if has_skills {
            parts.push(render("技能"));
        }
        if plan_mode {
            parts.push(render("规划模式"));
        }
        if has_task {
            parts.push(render("子agent"));
        }
        if !vars.user_prompt.is_empty() {
            parts.push(render("用户指令"));
        }
        if !vars.plugin_sections.is_empty() {
            parts.push(render("插件指令"));
        }

        Ok(parts.concat())
    }

    /// Render the base approval system prompt.
    pub fn render_approval_base(&self) -> String {
        Self::build_approval_registry()
            .render("审批", &json!({}))
            .unwrap_or_default()
    }

    /// Render the plan-mode addition for the approval prompt.
    pub fn render_approval_plan(&self) -> String {
        Self::build_approval_registry()
            .render("审批规划", &json!({}))
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build(
        vars: &AgentPromptVars,
        skills: bool,
        ws: bool,
        hg: bool,
        plan: bool,
        task: bool,
    ) -> String {
        TemplateManager
            .render_agent_prompt(vars, skills, ws, hg, plan, task, &[])
            .unwrap()
    }

    #[test]
    fn prompt_omits_disabled_tool_hints() {
        let vars = AgentPromptVars {
            session_id: "session-1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, false, false, false, false);

        assert!(!prompt.contains("web_search"));
        assert!(!prompt.contains("http_get"));
        assert!(!prompt.contains("skill_"));
        assert!(!prompt.contains("插件扩展指令"));
        assert!(!prompt.contains("Plan 模式"));
        assert!(!prompt.contains("子agent调研"));
    }

    #[test]
    fn prompt_includes_only_enabled_tool_hints() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, true, true, false, false, true);

        assert!(prompt.contains("web_search"));
        assert!(!prompt.contains("http_get"));
        assert!(prompt.contains("skill_"));
        assert!(prompt.contains("子agent调研"));
    }

    #[test]
    fn prompt_includes_plan_section_when_plan_mode() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, false, false, true, false);
        assert!(prompt.contains("Plan 模式"));
        assert!(prompt.contains("write_file"));
    }

    #[test]
    fn prompt_omits_plan_section_when_not_plan_mode() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, false, false, false, false);
        assert!(!prompt.contains("Plan 模式"));
    }

    #[test]
    fn prompt_task_section_when_task_tool_present() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, false, false, false, true);
        assert!(prompt.contains("子agent调研"));
        assert!(prompt.contains("task"));
        // 联网调研优先派发子agent 的引导（token 消耗/会话时长）
        assert!(prompt.contains("联网调研"));
        assert!(prompt.contains("token"));
    }

    #[test]
    fn prompt_task_section_omitted_when_task_tool_absent() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, false, false, false, false);
        assert!(!prompt.contains("子agent调研"));
    }

    #[test]
    fn prompt_with_empty_plugin_sections_omits_section() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, false, false, false, false);
        assert!(!prompt.contains("插件扩展指令"));
    }

    #[test]
    fn prompt_appends_single_plugin_section() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec!["记住用户偏好".into()],
        };
        let prompt = build(&vars, false, false, false, false, false);
        assert!(prompt.contains("插件扩展指令"));
        assert!(prompt.contains("记住用户偏好"));
    }

    #[test]
    fn prompt_appends_multiple_plugin_sections_separated_by_blank_line() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec!["插件A 指令".into(), "插件B 指令".into()],
        };
        let prompt = build(&vars, false, false, false, false, false);
        assert!(prompt.contains("插件A 指令\n\n插件B 指令"));
    }

    #[test]
    fn prompt_plugin_section_appears_after_user_section() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: "USER_MARKER".into(),
            plugin_sections: vec!["PLUGIN_MARKER".into()],
        };
        let prompt = build(&vars, false, false, false, false, false);
        let user_pos = prompt.find("USER_MARKER").unwrap();
        let plugin_pos = prompt.find("PLUGIN_MARKER").unwrap();
        assert!(user_pos < plugin_pos);
    }

    #[test]
    fn prompt_extra_sections_are_composed_into_output() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let extras = vec!["EXTRA_MARKER_A".to_string(), "EXTRA_MARKER_B".to_string()];
        let prompt = TemplateManager
            .render_agent_prompt(&vars, false, false, false, false, false, &extras)
            .unwrap();
        assert!(prompt.contains("EXTRA_MARKER_A"));
        assert!(prompt.contains("EXTRA_MARKER_B"));
    }

    #[test]
    fn render_approval_prompts() {
        let base = TemplateManager.render_approval_base();
        assert!(base.contains("命令执行审批助手"));
        assert!(base.contains("approve"));

        let plan = TemplateManager.render_approval_plan();
        assert!(plan.contains("Plan 模式"));
    }
}
