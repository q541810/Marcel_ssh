//! Agent 系统提示词的组装 + 提示词清单。
//!
//! # 提示词清单（改提示词先看这里）
//!
//! | 段 | 来源 | 门控 | 送达方式 |
//! |---|---|---|---|
//! | 角色 | `templates/agent/角色.hbs` | 无条件 | system prompt |
//! | 子 agent 角色约束 | `templates/agent/子agent_只读.hbs`、`子agent_执行.hbs` | 仅子 agent | system prompt（经 `prompt_extra`） |
//! | 多机操控 | `templates/agent/多机.hbs`（`render_multi_host`） | 主 agent 且有多机上下文 | system prompt |
//! | 先理清需求 / 沟通 / 上下文管理 / 收尾 | `templates/agent/沟通.hbs` | **仅主 agent**（`audience`） | system prompt |
//! | 联网搜索 | `templates/agent/联网搜索.hbs` | 注册了声明 `WebSearch` 段的工具（当前是 `web_search`） | system prompt |
//! | 网页访问 | `templates/agent/网页访问.hbs` | 注册了声明 `HttpFetch` 段的工具（当前是 `http_get`） | system prompt |
//! | 会话 | `templates/agent/会话.hbs` | 无条件 | system prompt |
//! | 技能 | `templates/agent/技能.hbs` | 注册了 `skill_*` | system prompt |
//! | 规划模式 | `templates/agent/规划模式.hbs` | Plan 模式 | system prompt |
//! | 子agent 派发 | `templates/agent/子agent.hbs` | 注册了声明 `Subagent` 段的工具（当前是 `subagent`） | system prompt |
//! | 用户附加指令 | `templates/agent/用户指令.hbs` | 设置为非空（上限 2000 字） | system prompt |
//! | 插件扩展指令 | `templates/agent/插件指令.hbs` | 有插件 `systemPromptSection` | system prompt |
//! | 压缩前言 / 压缩指令 | `templates/context/压缩前言.hbs`、`压缩指令.hbs` | 每次上下文压缩 | 摘要专用 LLM 调用（带常规请求同一份 tools schema） |
//! | 技能平台说明 | `templates/skill/平台说明.hbs` | 调用内置教学 skill | skill 工具结果 |
//! | 命令审批 | `templates/approval/审批.hbs` | 启用模型审批且用户未自定义 | 审批专用 LLM 调用（chat 引擎） |
//! | 审批（Plan 追加） | `templates/approval/审批规划.hbs` | 同上 + Plan 模式 | 审批专用 LLM 调用（**两个引擎共用**） |
//! | 命令审批（Jev） | `templates/approval/审批Jev.hbs` | 启用模型审批 + 引擎选 Jev + 用户未自定义 | Jev 的 `instructions`（不走 chat） |
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
//! - 需求澄清 / 沟通风格 / 结论放哪 / 上下文管理 → `templates/agent/沟通.hbs`
//!   （仅主 agent，见 `render_agent_prompt` 的 `audience` 门控）
//! - 人设、主动性、惯例、后台作业、停止命令与残余进程 → `templates/agent/角色.hbs`
//! - **工具作用在哪一侧**（远端 / 用户本机 / 两端 / 应用内）→ 各工具自己的
//!   `description()`，权威在那里；提示词里只允许说"以工具说明为准"，不得复述
//!   工具清单（`tools::ToolSide` 必填 + `acting_tools_state_their_side` 测试：
//!   新增工具不声明 `side` 编译不过，声明了但描述没写测试会红）
//! - 子 agent 行为约束 → `templates/agent/子agent_只读.hbs` / `子agent_执行.hbs`
//!   （桌面/移动的工具清单差异走 `can_transfer` 分支，不要再写 cfg 副本）
//! - 多机操控与 host 规则 → `templates/agent/多机.hbs`（工具侧只复用
//!   `tools::HOST_MATCH_RULE` 短句）
//! - 上下文压缩的质量 → `templates/context/压缩指令.hbs`（八段标题与
//!   `summarizer::REQUIRED_SECTIONS` 硬校验一一对应，别改标题；开头与结尾各一段
//!   同样的强警告禁止调用工具——只靠单处压不住；中间要求先写 `<analysis>` 预写块
//!   再写八段，`<analysis>` 在回注前由 `summarizer::sanitize_summary` 剥离，
//!   不进上下文/不落库/不展示）
//! - 技能里的平台措辞 → `templates/skill/平台说明.hbs`
//! - 命令审批判据 → 分两个引擎，各自的判据模板不同，但**不变的规则由护栏测试
//!   钉住**（`approval_invariants_shared_by_both_engines`）：
//!   - chat 引擎 → `templates/approval/审批.hbs`（含 JSON 输出格式）
//!   - Jev 引擎 → `templates/approval/审批Jev.hbs`（无 JSON：Jev 返回类型化选项，
//!     不生成文本，所以没有"从散文里抠 JSON"那一步）
//!   - Plan 模式追加 → `templates/approval/审批规划.hbs`，**两个引擎共用同一份**
//!     （它是纯约束描述、不含输出格式），不得再写第二份
//!   - 用户在设置里填的「审批提示词」两个引擎都覆盖各自的上面那一份；
//!     Plan 追加段始终生效
//!   - 前端经 `agent_default_approval_prompt` 取用，不再自带副本
//!
//! 段落之间的分隔由本文件统一生成（见 `render_agent_prompt` 的 join），
//! 模板文件首尾的空行没有语义，不必维护。

use handlebars::Handlebars;
use serde_json::json;

use crate::agent::tools::{PromptSection, ToolAudience};
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
        let _ = reg.register_template_string(
            "审批Jev",
            include_str!("../../templates/approval/审批Jev.hbs"),
        );
        reg
    }

    /// Render the full agent system prompt by composing applicable template
    /// fragments in order. Conditions (`has_skills`, `plan_mode`, …) are
    /// evaluated by the caller — only applicable fragments are included.
    ///
    /// `tool_sections` 是「已注册工具声明出来的段需求」（见
    /// `tools::prompt_section_of`）。段落顺序就是提示词结构，仍是本函数显式写出
    /// 的；工具层只声明「我需要哪一段」，不决定位置、也不知道模板文件名。
    ///
    /// `audience` 是「这份提示词给谁用」，由任务角色推导（`manager::audience_of`）。
    /// 对用户说话的段只该主 agent 拿到：子 agent 的读者是主 agent 本身。
    pub fn render_agent_prompt(
        &self,
        vars: &AgentPromptVars,
        has_skills: bool,
        tool_sections: &std::collections::BTreeSet<PromptSection>,
        plan_mode: bool,
        audience: ToolAudience,
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
        // 主 agent 行为段（先理清需求 / 沟通 / 上下文管理 / 收尾），只按角色门控：
        // 它讲的是怎么跟用户对话、怎么汇报，而子 agent 的读者是主 agent 本身
        // （见 templates/agent/子agent_*.hbs），这些规则只会把它从调研带偏。
        // 位置仍必须在 extra_sections 之后 —— 那些是「角色」的追加约束，
        // 不能插在它们中间。
        if audience == ToolAudience::Main {
            parts.push(render("沟通"));
        }
        if tool_sections.contains(&PromptSection::WebSearch) {
            parts.push(render("联网搜索"));
        }
        if tool_sections.contains(&PromptSection::HttpFetch) {
            parts.push(render("网页访问"));
        }
        parts.push(render("会话"));
        if has_skills {
            parts.push(render("技能"));
        }
        if plan_mode {
            parts.push(render("规划模式"));
        }
        if tool_sections.contains(&PromptSection::Subagent) {
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
    ///
    /// 两个审批引擎共用这一份：它是纯约束描述、不含任何输出格式，所以既适合
    /// 追加在 chat 引擎的 system prompt 后，也适合作为 Jev 的 `instructions` 追加段。
    /// **不要再写第二份**——同一条「Plan 模式不得改系统」的规则只能有一个来源。
    pub fn render_approval_plan(&self) -> String {
        Self::build_approval_registry()
            .render("审批规划", &json!({}))
            .unwrap_or_default()
    }

    /// Render the built-in `instructions` for the Jev approval engine.
    ///
    /// Jev 不是 chat 模型：它没有 system prompt、不生成文本，判定的可选值由
    /// Choice 的 `criteria` 定义，这里渲染的是「要判断什么」的问题本身。
    /// 因此这份模板里**不得出现 JSON 输出格式说明**（那是 chat 引擎的事，
    /// 对 Jev 只会变成噪音指令）。护栏测试 `approval_jev_template_has_no_json_format`。
    pub fn render_approval_jev(&self) -> String {
        Self::build_approval_registry()
            .render("审批Jev", &json!({}))
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

    /// 把「需要提示词段的工具」列表转成集合，供直接调用 render 的测试使用。
    fn secs(list: &[PromptSection]) -> std::collections::BTreeSet<PromptSection> {
        list.iter().copied().collect()
    }

    fn build(
        vars: &AgentPromptVars,
        skills: bool,
        sections: &[PromptSection],
        plan: bool,
    ) -> String {
        build_for(vars, skills, sections, plan, ToolAudience::Main)
    }

    /// 同 `build`，但指定这份提示词给谁用（主 agent / 子 agent）。
    fn build_for(
        vars: &AgentPromptVars,
        skills: bool,
        sections: &[PromptSection],
        plan: bool,
        audience: ToolAudience,
    ) -> String {
        let tool_sections: std::collections::BTreeSet<PromptSection> =
            sections.iter().copied().collect();
        TemplateManager
            .render_agent_prompt(vars, skills, &tool_sections, plan, audience, &[])
            .unwrap()
    }

    #[test]
    fn prompt_omits_disabled_tool_hints() {
        let vars = AgentPromptVars {
            session_id: "session-1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, &[], false);

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
        let prompt = build(
            &vars,
            true,
            &[PromptSection::WebSearch, PromptSection::Subagent],
            false,
        );

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
        let prompt = build(&vars, false, &[], true);
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
        let prompt = build(&vars, false, &[], false);
        assert!(!prompt.contains("Plan 模式"));
    }

    #[test]
    fn prompt_includes_communication_sections() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, &[], false);
        assert!(prompt.contains("## 与用户沟通"));
        assert!(prompt.contains("先说结论"));
        // 回合折叠：结论必须落在最后一条不含工具调用的回复里。
        assert!(prompt.contains("最后一条不含工具调用的回复"));
        assert!(prompt.contains("## 上下文管理"));
        assert!(prompt.contains("## 收尾"));

        // 主 agent 行为段必须排在 extra_sections（子 agent 角色约束等）之后：
        // 那些是「角色」的追加约束，插到它们中间会让约束被日常行为规则隔开。
        let extras = vec!["EXTRA_MARKER".to_string()];
        let prompt = TemplateManager
            .render_agent_prompt(&vars, false, &secs(&[]), false, ToolAudience::Main, &extras)
            .unwrap();
        assert!(prompt.find("EXTRA_MARKER").unwrap() < prompt.find("## 与用户沟通").unwrap());
    }

    /// 「沟通」整段只给主 agent。它讲的是怎么跟用户对话、怎么把结论写给用户看，
    /// 而子 agent 的读者是主 agent 自己——它的输出约定写在
    /// `templates/agent/子agent_只读.hbs` / `子agent_执行.hbs` 里。
    /// 子 agent 拿着这些规则只会从调研滑向"和用户对话"。
    #[test]
    fn communication_section_is_main_agent_only() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };

        let main = build(&vars, false, &[], false);
        assert!(main.contains("## 先理清需求"));
        assert!(main.contains("## 与用户沟通"));
        assert!(main.contains("## 收尾"));

        // 只读子 agent 跑在 Plan 模式：模式段照旧，沟通段没有。
        let sub = build_for(&vars, false, &[], true, ToolAudience::Sub);
        assert!(!sub.contains("## 先理清需求"));
        assert!(!sub.contains("## 与用户沟通"));
        assert!(!sub.contains("## 上下文管理"));
        assert!(!sub.contains("## 收尾"));
        assert!(sub.contains("## Plan 模式"));
        // 「角色」无条件，子 agent 依然拿到。
        assert!(sub.contains("你是 Marcel SSH"));
    }

    /// 「改行为就同步已有文档」这条规则必须**两种角色都拿到**：主 agent 与执行型
    /// 子代理都会改文件，只读子代理拿到也无害（它不改东西，规则自然不触发）。
    ///
    /// 同时钉住它的反向半边——只同步**已有**文档、不主动新建、历史遗留的不一致
    /// 只提不修。少了这一半，这条规则会退化成"到处造 md"，比不同步更糟。
    #[test]
    fn doc_sync_rule_reaches_both_audiences_with_the_no_new_files_brake() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };

        for prompt in [
            build(&vars, false, &[], false),
            build_for(&vars, false, &[], true, ToolAudience::Sub),
        ] {
            assert!(
                prompt.contains("把已经在描述它的那份文档一起改掉"),
                "改了行为要同步已经在描述它的那份文档"
            );
            assert!(
                prompt.contains("不要新建文档"),
                "只同步已有文档，不主动新建 README / CHANGELOG"
            );
            assert!(
                prompt.contains("不要擅自修改"),
                "历史遗留的文档不一致只提不修"
            );
        }
    }

    /// 语言规则必须**覆盖"正文之外、用户会读到的文本"**，而且子 agent 也要拿到。
    ///
    /// 回归来源：这条规则原先只说「回答时优先使用中文」，于是模型把自己写在工具参数里、
    /// 最终显示在审批弹窗上的命令说明写成英文——用户一直用中文提问也一样，因为模型
    /// 不认为参数值属于"回答"。同一条规则也管计划标题、提问选项、后台作业描述。
    ///
    /// 两条断言各挡一种退化：把规则收窄回只管正文；把这个段挪进主 agent 专属段
    /// （子 agent 同样会调 bash，它的说明也显示在用户看到的审批弹窗里）。
    #[test]
    fn language_rule_covers_user_visible_text_for_both_audiences() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };

        let language_section = |prompt: &str| -> String {
            let start = prompt.find("## 语言").expect("提示词里应有「语言」段");
            let rest = &prompt[start..];
            let end = rest[3..]
                .find("\n## ")
                .map(|i| i + 3)
                .unwrap_or(rest.len());
            rest[..end].to_string()
        };

        let main_section = language_section(&build(&vars, false, &[], false));
        let sub_section = language_section(&build_for(&vars, false, &[], true, ToolAudience::Sub));

        for (who, section) in [("主 agent", &main_section), ("子 agent", &sub_section)] {
            assert!(
                section.contains("展示给用户"),
                "{who} 的语言段必须说明它管的是「用户会读到的文本」，而不只是正文：{section}"
            );
            assert!(
                section.contains("description"),
                "{who} 的语言段要点名会被展示的参数（如 bash 的 description）作为例子：{section}"
            );
        }
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
        let minimal = build(&vars, false, &[], false);
        let extras = vec!["EXTRA_MARKER".to_string()];
        let full = TemplateManager
            .render_agent_prompt(
                &vars,
                true,
                &secs(&[
                    PromptSection::WebSearch,
                    PromptSection::HttpFetch,
                    PromptSection::Subagent,
                ]),
                true,
                ToolAudience::Main,
                &extras,
            )
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
        let prompt = build(&vars, false, &[PromptSection::Subagent], false);
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
        let prompt = build(&vars, false, &[], false);
        assert!(!prompt.contains("子agent 派发"));
    }

    #[test]
    fn prompt_with_empty_plugin_sections_omits_section() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec![],
        };
        let prompt = build(&vars, false, &[], false);
        assert!(!prompt.contains("插件扩展指令"));
    }

    #[test]
    fn prompt_appends_single_plugin_section() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: String::new(),
            plugin_sections: vec!["记住用户偏好".into()],
        };
        let prompt = build(&vars, false, &[], false);
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
        let prompt = build(&vars, false, &[], false);
        assert!(prompt.contains("插件A 指令\n\n插件B 指令"));
    }

    #[test]
    fn prompt_plugin_section_appears_after_user_section() {
        let vars = AgentPromptVars {
            session_id: "s1".into(),
            user_prompt: "USER_MARKER".into(),
            plugin_sections: vec!["PLUGIN_MARKER".into()],
        };
        let prompt = build(&vars, false, &[], false);
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
            .render_agent_prompt(&vars, false, &secs(&[]), false, ToolAudience::Main, &extras)
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

    /// 两个审批引擎（chat / Jev）的判据模板各写一遍，但**这两条不变式必须同时
    /// 存在于两者之中**：只能判定不能改写命令、有异议就拦下。护栏的意义是
    /// 以后改了一个忘了另一个时测试会红——否则「模型不能改写命令」这条权限边界
    /// 会在某个引擎上悄悄消失。
    #[test]
    fn approval_invariants_shared_by_both_engines() {
        let chat = TemplateManager.render_approval_base();
        let jev = TemplateManager.render_approval_jev();

        assert!(
            jev.contains("命令"),
            "Jev 判据模板渲染为空或内容异常: {jev:?}"
        );

        for (name, text) in [("审批.hbs", &chat), ("审批Jev.hbs", &jev)] {
            // 不变式 1：模型只能判定，不能改写命令。
            assert!(
                text.contains("只能判定") && text.contains("改写命令"),
                "{name} 缺少「只能判定不能改写命令」这条权限边界"
            );
            // 不变式 2：有异议就拦下（而不是放行后再说）。
            assert!(
                text.contains("异议") && text.contains("阻止"),
                "{name} 缺少「有异议就阻止执行」这条判据"
            );
        }
    }

    /// Jev 不生成文本、返回的是类型化选项，所以它的判据模板里**不能出现
    /// JSON 输出格式说明**——那是 chat 引擎的契约，喂给 Jev 只会变成噪音指令。
    /// （这是把两份模板分开的直接原因，用测试钉住，防止以后有人"顺手统一"。）
    #[test]
    fn approval_jev_template_has_no_json_format() {
        let jev = TemplateManager.render_approval_jev();
        assert!(
            !jev.contains("{\"decision\""),
            "Jev 判据模板不得包含 JSON 输出格式"
        );
        assert!(
            !jev.contains("输出严格的 JSON"),
            "Jev 判据模板不得要求输出 JSON"
        );
    }

    /// Plan 追加段被两个引擎共用，因此它必须保持「纯约束」——不含任何输出格式，
    /// 否则它就只能给其中一个引擎用，共用前提被破坏。
    #[test]
    fn approval_plan_fragment_is_engine_agnostic() {
        let plan = TemplateManager.render_approval_plan();
        assert!(!plan.contains("JSON"), "Plan 追加段不得包含输出格式说明");
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
