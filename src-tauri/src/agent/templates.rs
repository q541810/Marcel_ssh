//! Agent 系统提示词的组装 + 提示词清单。
//!
//! # 提示词清单（改提示词先看这里）
//!
//! | 段 | 来源 | 门控 | 送达方式 |
//! |---|---|---|---|
//! | 角色 | `templates/agent/角色.hbs` | 无条件 | system prompt |
//! | 子 agent 角色约束 | `templates/agent/子agent_只读.hbs`、`子agent_执行.hbs` | 仅子 agent | system prompt（经 `prompt_extra`） |
//! | 多机操控 | `templates/agent/多机.hbs`（`render_multi_host`） | 主 agent 且有多机上下文 | system prompt |
//! | 沟通 / 上下文管理 / 收尾 | `templates/agent/沟通.hbs` | 无条件 | system prompt |
//! | 联网搜索 | `templates/agent/联网搜索.hbs` | 注册了 `web_search` | system prompt |
//! | 网页访问 | `templates/agent/网页访问.hbs` | 注册了 `http_get` | system prompt |
//! | 会话 | `templates/agent/会话.hbs` | 无条件 | system prompt |
//! | 技能 | `templates/agent/技能.hbs` | 注册了 `skill_*` | system prompt |
//! | 规划模式 | `templates/agent/规划模式.hbs` | Plan 模式 | system prompt |
//! | 子agent 派发 | `templates/agent/子agent.hbs` | 注册了 `subagent` | system prompt |
//! | 用户附加指令 | `templates/agent/用户指令.hbs` | 设置为非空（上限 2000 字） | system prompt |
//! | 插件扩展指令 | `templates/agent/插件指令.hbs` | 有插件 `systemPromptSection` | system prompt |
//! | 压缩前言 / 压缩指令 | `templates/context/压缩前言.hbs`、`压缩指令.hbs` | 每次上下文压缩 | 摘要专用 LLM 调用 |
//! | 技能平台说明 | `templates/skill/平台说明.hbs` | 调用内置教学 skill | skill 工具结果 |
//! | 命令审批 | `templates/approval/审批.hbs` | 启用模型审批且用户未自定义 | 审批专用 LLM 调用 |
//! | 审批（Plan 追加） | `templates/approval/审批规划.hbs` | 同上 + Plan 模式 | 审批专用 LLM 调用 |
//!
//! 前 12 段由 `render_agent_prompt` 组装；其余各自在调用点用 `render_fragment`
//! 渲染（它们不是同一个 LLM 调用，或不属于 system prompt）。
//!
//! 不在此表的模型可见文本，各有其归属，别往这里搬：
//! 工具怎么用 → 各工具自己的 `description()`（`agent/tools/*.rs`）；
//! 技能正文 → `builtin_skills/*.md`，调用 `skill_*` 工具时才进上下文（渐进披露）；
//! 插件工具描述 → 插件 `plugin.json`；
//! 运行时状态消息（后台作业结算/超时提醒、plan 上下文、工具结果与错误）→ 随触发点就近留在 Rust，
//! 它们带插值、每轮重建，不是行为规则，搬进模板只会更难维护。
//!
//! # 两条规约
//!
//! 1. **新增或删除提示词段，必须同步更新上表**——顺序与门控都写在本文件的
//!    `render_agent_prompt` 里，没有第二处汇总。
//! 2. **同一条规则只允许一个权威来源**。别处只能引用，不得复述：例如 host
//!    "名字必须逐字符一致"的权威说明只在 `多机.hbs`，工具侧只留一句短提示。
//!
//! # 改 X 要动哪里
//!
//! - 沟通风格 / 结论放哪 / 上下文管理 → `templates/agent/沟通.hbs`
//! - 人设、主动性、惯例、后台作业 → `templates/agent/角色.hbs`
//! - 子 agent 行为约束 → `templates/agent/子agent_只读.hbs` / `子agent_执行.hbs`
//!   （桌面/移动的工具清单差异走 `can_transfer` 分支，不要再写 cfg 副本）
//! - 多机操控与 host 规则 → `templates/agent/多机.hbs`（工具侧只复用
//!   `tools::HOST_MATCH_RULE` 短句）
//! - 上下文压缩的质量 → `templates/context/压缩指令.hbs`（八段标题与
//!   `summarizer::REQUIRED_SECTIONS` 硬校验一一对应，别改标题）
//! - 技能里的平台措辞 → `templates/skill/平台说明.hbs`
//! - 命令审批判据 → `templates/approval/审批.hbs`（前端经 `agent_default_approval_prompt` 取用，
//!   不再自带副本）
//!
//! 段落之间的分隔由本文件统一生成（见 `render_agent_prompt` 的 join），
//! 模板文件首尾的空行没有语义，不必维护。

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
            reg.register_template_string("沟通", include_str!("../../templates/agent/沟通.hbs"));
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
        // 系统指令类片段：不经 render_agent_prompt 组装，由各自的调用点用
        // `render_fragment` 渲染（子 agent 约束、压缩指令与前言、技能平台说明）。
        let _ = reg.register_template_string(
            "子agent_只读",
            include_str!("../../templates/agent/子agent_只读.hbs"),
        );
        let _ = reg.register_template_string(
            "子agent_执行",
            include_str!("../../templates/agent/子agent_执行.hbs"),
        );
        let _ = reg.register_template_string(
            "压缩指令",
            include_str!("../../templates/context/压缩指令.hbs"),
        );
        let _ = reg.register_template_string(
            "压缩前言",
            include_str!("../../templates/context/压缩前言.hbs"),
        );
        let _ = reg.register_template_string(
            "平台说明",
            include_str!("../../templates/skill/平台说明.hbs"),
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
        // 常驻行为段（沟通 / 上下文 / 收尾），不按工具与模式门控；必须在
        // extra_sections 之后 —— 那些是「角色」的追加约束，不能插在中间。
        parts.push(render("沟通"));
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

        // 段间分隔统一在这里生成：模板文件首尾的空行不参与语义，渲染失败的
        // 空段也不会留下空档。这样就不存在“少留一个空行两段粘在一起”这种
        // 只在模型侧显形的静默问题。
        Ok(parts
            .iter()
            .map(|p| p.trim())
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join("\n\n"))
    }

    /// 渲染任意已注册的提示词片段。给不经 `render_agent_prompt` 组装的那几段
    /// 系统指令用（子 agent 约束、压缩指令与前言、技能平台说明），让它们的文本
    /// 也留在 `templates/` 里，而不是散在 Rust 字符串常量中。
    ///
    /// 与 `render_multi_host` 同款兜底：渲染失败只记日志并返回空串——
    /// 一段提示词坏掉不该让整个任务起不来。
    pub fn render_fragment(&self, name: &str, ctx: &serde_json::Value) -> String {
        Self::build_agent_registry()
            .render(name, ctx)
            .unwrap_or_else(|e| {
                log::warn!("模板 [{}] 渲染失败: {}", name, e);
                String::new()
            })
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
    /// `can_transfer`：是否注入跨机文件中转说明（upload/download 桌面专属）。
    pub fn render_multi_host(
        &self,
        current_host: &str,
        machines: &[serde_json::Value],
        can_transfer: bool,
    ) -> String {
        let reg = Self::build_agent_registry();
        reg.render(
            "多机",
            &json!({
                "current_host": current_host,
                "machines": machines,
                "can_transfer": can_transfer,
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
    fn prompt_includes_communication_sections() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, false, false, false, false);
        assert!(prompt.contains("## 与用户沟通"));
        assert!(prompt.contains("先说结论"));
        // 回合折叠：结论必须落在最后一条不含工具调用的回复里。
        assert!(prompt.contains("最后一条不含工具调用的回复"));
        assert!(prompt.contains("## 上下文管理"));
        assert!(prompt.contains("## 收尾"));

        // 常驻段必须排在 extra_sections（子 agent 角色约束等）之后：
        // 那些是「角色」的追加约束，插到它们中间会让约束被日常行为规则隔开。
        let extras = vec!["EXTRA_MARKER".to_string()];
        let prompt = TemplateManager
            .render_agent_prompt(&vars, false, false, false, false, false, &extras)
            .unwrap();
        assert!(prompt.find("EXTRA_MARKER").unwrap() < prompt.find("## 与用户沟通").unwrap());
    }

    /// 段落分隔由组装层生成：任何一段的标题前面都必须有空行。守卫的是
    /// “模板文件首尾少留一个空行 → 两段粘在同一行”这类只在模型侧显形的问题。
    #[test]
    fn rendered_prompt_separates_sections_with_blank_lines() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: "USER_MARKER".into(),
            plugin_sections: vec!["PLUGIN_MARKER".into()],
        };
        let minimal = build(&vars, false, false, false, false, false);
        let extras = vec!["EXTRA_MARKER".to_string()];
        let full = TemplateManager
            .render_agent_prompt(&vars, true, true, true, true, true, &extras)
            .unwrap();
        for prompt in [minimal, full] {
            let lines: Vec<&str> = prompt.lines().collect();
            for (idx, line) in lines.iter().enumerate() {
                if !line.starts_with("## ") {
                    continue;
                }
                assert!(idx > 0, "提示词不能以标题开头：{:?}", line);
                assert!(
                    lines[idx - 1].trim().is_empty(),
                    "标题「{}」前一行不是空行：{:?}",
                    line,
                    lines[idx - 1]
                );
            }
        }
    }

    /// 杜绝孤儿模板：新增 .hbs 忘了注册、或删了文件没删注册，都在这里报错。
    /// 子 agent 约束段走 `render_fragment`，调用点没有别的兜底——渲染失败会
    /// 静默返回空串，等于子 agent 一条约束都没有。这里钉住两条分支的实际内容。
    #[test]
    fn subagent_instruction_fragments_render_both_platform_branches() {
        let read_only = TemplateManager.render_fragment("子agent_只读", &json!({}));
        assert!(read_only.contains("只读调研"));
        assert!(read_only.contains("job_output"));

        let desktop =
            TemplateManager.render_fragment("子agent_执行", &json!({ "can_transfer": true }));
        assert!(desktop.contains("bash / upload_file / download_file / web_search"));
        assert!(!desktop.contains("不要调用 upload_file"));

        let mobile =
            TemplateManager.render_fragment("子agent_执行", &json!({ "can_transfer": false }));
        assert!(mobile.contains("bash / web_search"));
        assert!(mobile.contains("不要调用 upload_file / download_file"));
        assert!(!mobile.contains("upload_file / download_file / web_search"));
    }

    #[test]
    fn platform_note_renders_both_branches() {
        let desktop = TemplateManager.render_fragment("平台说明", &json!({ "is_mobile": false }));
        assert!(desktop.contains("**桌面版**"));
        let mobile = TemplateManager.render_fragment("平台说明", &json!({ "is_mobile": true }));
        assert!(mobile.contains("**移动版（Android）**"));
        assert!(!mobile.contains("**桌面版**"));
    }

    #[test]
    fn every_template_file_is_registered() {
        let agent_reg = TemplateManager::build_agent_registry();
        let approval_reg = TemplateManager::build_approval_registry();
        let mut count = 0;
        let mut dirs = vec![std::path::PathBuf::from("templates")];
        while let Some(dir) = dirs.pop() {
            for entry in std::fs::read_dir(&dir).expect("templates 目录不存在") {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    dirs.push(path);
                    continue;
                }
                if path.extension().and_then(|e| e.to_str()) != Some("hbs") {
                    continue;
                }
                let stem = path.file_stem().unwrap().to_str().unwrap();
                assert!(
                    agent_reg.get_template(stem).is_some()
                        || approval_reg.get_template(stem).is_some(),
                    "模板文件 {:?} 未在任何 registry 注册（孤儿模板）",
                    path
                );
                count += 1;
            }
        }
        assert!(
            count >= 15,
            "templates 下只找到 {} 个 .hbs，测试工作目录可能不对",
            count
        );
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
        let out = TemplateManager.render_multi_host("web", machines.as_array().unwrap(), true);
        assert!(out.contains("当前机器：web"));
        assert!(out.contains("- web:0（在线）"));
        assert!(out.contains("- db（离线，将自动连接）"));
        // 策略文案在模板内（不是硬编码在 Rust 侧）。
        assert!(out.contains("批量操作"));
        assert!(out.contains("生成任务指派代理执行"));
        assert!(out.contains("upload_file"));
    }

    #[test]
    fn render_multi_host_without_transfer_omits_upload_download() {
        let machines = serde_json::json!([{ "label": "web", "status": "在线" }]);
        let out = TemplateManager.render_multi_host("web", machines.as_array().unwrap(), false);
        assert!(out.contains("当前机器：web"));
        assert!(out.contains("跨机 bash / subagent"));
        // 不注入本机中转说明；给出明确禁用指引（文案中可出现工具名）。
        assert!(!out.contains("经本机中转完成跨机传输"));
        assert!(!out.contains("local_path 指运行"));
        assert!(out.contains("不提供 upload_file"));
        assert!(out.contains("不要尝试跨机文件传输"));
    }

    #[test]
    fn render_multi_host_empty_machines_produces_header_only() {
        let out = TemplateManager.render_multi_host("web", &[], true);
        assert!(out.contains("当前机器：web"));
        assert!(!out.contains("可操作机器"));
    }
}
