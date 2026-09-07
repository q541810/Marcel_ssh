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
        let _ =
            reg.register_template_string("多机", include_str!("../../templates/agent/多机.hbs"));
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

    /// Render the multi-host control section（动态机器清单 + 操作策略）。
    /// `machines` = [{label: 展示名(含消歧后缀), status: "在线"|"离线，将自动连接"|"当前会话"}]
    /// 由调用方（multi_host）收集数据；模板文本外置于 templates/agent/多机.hbs。
    pub fn render_multi_host(&self, current_host: &str, machines: &[serde_json::Value]) -> String {
        let reg = Self::build_agent_registry();
        reg.render(
            "多机",
            &json!({
                "current_host": current_host,
                "machines": machines,
            }),
        )
        .unwrap_or_else(|e| {
            log::warn!("模板 [多机] 渲染失败: {}", e);
            String::new()
        })
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
        assert!(!prompt.contains("子agent 派发"));
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
        assert!(prompt.contains("子agent 派发"));
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
    fn prompt_subagent_section_when_subagent_tool_present() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, false, false, false, true);
        assert!(prompt.contains("子agent 派发"));
        assert!(prompt.contains("subagent"));
        // 联网搜集信息默认派发子agent 的引导（web_search 质量低/token 消耗/会话时长）
        assert!(prompt.contains("联网搜集信息"));
        assert!(prompt.contains("token"));
    }

    #[test]
    fn prompt_subagent_section_omitted_when_subagent_tool_absent() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, false, false, false, false);
        assert!(!prompt.contains("子agent 派发"));
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

    #[test]
    fn render_multi_host_lists_machines_with_status() {
        let machines = serde_json::json!([
            { "label": "web:0", "status": "在线" },
            { "label": "db", "status": "离线，将自动连接" },
        ]);
        let out = TemplateManager.render_multi_host("web", machines.as_array().unwrap());
        assert!(out.contains("当前机器：web"));
        assert!(out.contains("- web:0（在线）"));
        assert!(out.contains("- db（离线，将自动连接）"));
        // 策略文案在模板内（不是硬编码在 Rust 侧）。
        assert!(out.contains("批量操作"));
        assert!(out.contains("生成任务指派代理执行"));
    }

    #[test]
    fn render_multi_host_empty_machines_produces_header_only() {
        let out = TemplateManager.render_multi_host("web", &[]);
        assert!(out.contains("当前机器：web"));
        assert!(!out.contains("可操作机器"));
    }
}
