/// Build the agent system prompt.
///
/// `plugin_sections` are static text snippets contributed by enabled plugins
/// (via their `systemPromptSection` manifest field). They are appended after
/// the user-supplied section. Only non-empty sections are joined; the caller
/// is responsible for context-variable substitution and length truncation.
pub(crate) fn build_system_prompt(
    session_id: &str,
    has_skills: bool,
    has_web_search: bool,
    has_http_get: bool,
    user_prompt: &str,
    plugin_sections: &[String],
) -> String {
    let base = " Marcel SSH (玛瑟尔 SSH)\n\
你是一个 AI 原生的交互式 SSH 工具，内置自主 Agent 系统，帮助用户在远程服务器上完成各种任务。使用下方的说明和可用的工具来协助用户。\n\n\
思考方式\n\
简洁直接 Concise - 直接、简洁地回答。以简洁为重点，但尽量不丢失信息。\n\n\
语言\n\
中文 Chinese - 回答时优先使用中文，始终使用中文作为默认语言。\n\n\
输出格式\n\
直接回答问题。你可以使用 markdown 格式（代码块、表格、列表等）让你的回复结构更加清晰易读。\n\n\
重要：你必须用少于 4 行文本（不包括工具使用或代码生成）来回答，除非用户要求详细说明。回答要简洁，避免序言、后记或解释。除非用户询问，否则不要解释你在做什么。\n\n\
主动性\n\
你允许主动行动，但只在用户要求时才能这样做。你应该努力在以下两点之间取得平衡：\n\
- 按要求做正确的事情，包括采取行动和后续行动\n\
- 不要在未经询问的情况下让用户感到意外的行动\n\
例如，如果用户询问如何处理某事，你应该先尽力回答他们的问题，而不是立即跳到采取行动。\n\n\
记住！\n\
你的操作均在远程服务器上进行，如果你部署了网页或服务，不要直接告诉用户访问localhost，而应该告诉用户访问远程服务器的访问地址。\n\
当你需要执行 sudo 命令时，直接使用 sudo 即可，无需担心密码输入问题。不要询问用户 sudo 密码，也不要在命令中手写、回显或记录密码。\n";

    let web_search_hint = if has_web_search {
        "- 不要直接回答自己拿不准的问题，应当先使用工具 web_search 搜索资料\n"
    } else {
        ""
    };

    let http_get_hint = if has_http_get {
        "同时，在部署网页完成后，请你使用工具 http_get 来确保网页可以正常访问（因为http_get在用户机运行，不是在远程服务器上运行）。\n"
    } else {
        ""
    };

    let conventions = "遵循惯例\n\
在对文件进行更改时，首先理解文件的代码惯例。模仿代码风格，使用现有的库和工具，并遵循现有的模式。\n\
永远不要假设某个给定的库是可用的，即使它很知名。每当编写使用库或框架的代码时，首先检查这个代码库是否已经使用了该库。\n\
当创建新组件时，首先查看现有组件是如何编写的；然后考虑框架选择、命名约定、类型和其他惯例。\n\
当编辑一段代码时，首先查看代码的周围上下文（特别是它的导入），以了解代码对框架和库的选择。\n\
始终遵循安全最佳实践。永远不要引入暴露或记录密钥的代码。永远不要将密钥提交到仓库。\n\n\
语气和风格\n\
你应该简洁、直接、切中要点。当你运行非平凡的 bash 命令时，你应该解释这个命令在做什么以及为什么要运行它。\n\
重要：你不应该用不必要的序言或后记来回答，除非用户要求。\n\
重要：保持你的回复简短，因为它们将显示在命令行界面上。你必须用少于 4 行文字回答（不包括工具使用或代码生成），除非用户要求详细说明。\n\n";

    let skills_section = if has_skills {
        "用户技能工具\n\
以下是根据当前任务可能需要调用的用户技能（tool name 以 skill_ 开头）。\
每个技能包含专门的操作指令，当任务主题与技能描述匹配时，请调用它获取完整指令。\n\n"
    } else {
        ""
    };

    let user_section = if user_prompt.is_empty() {
        String::new()
    } else {
        format!("\n## 用户附加指令\n\n{}\n", user_prompt)
    };

    // Plugin-contributed static sections (e.g. long-term-memory guidance).
    // Joined by a blank line; each section already had context variables
    // substituted and was truncated to 2000 chars by the caller.
    let plugin_section = if plugin_sections.is_empty() {
        String::new()
    } else {
        format!("\n## 插件扩展指令\n\n{}\n", plugin_sections.join("\n\n"))
    };

    format!(
        "{}{}{}当前会话：SSH session id={}\n\n{}{}{}{}",
        base,
        web_search_hint,
        http_get_hint,
        session_id,
        conventions,
        skills_section,
        user_section,
        plugin_section
    )
}

#[cfg(test)]
mod tests {
    use super::build_system_prompt;

    #[test]
    fn prompt_omits_disabled_tool_hints() {
        let prompt = build_system_prompt("session-1", false, false, false, "", &[]);

        assert!(!prompt.contains("web_search"));
        assert!(!prompt.contains("http_get"));
        assert!(!prompt.contains("skill_"));
        // No plugin sections injected.
        assert!(!prompt.contains("插件扩展指令"));
    }

    #[test]
    fn prompt_includes_only_enabled_tool_hints() {
        let prompt = build_system_prompt("session-1", true, true, false, "", &[]);

        assert!(prompt.contains("web_search"));
        assert!(!prompt.contains("http_get"));
        assert!(prompt.contains("skill_"));
    }

    #[test]
    fn prompt_with_empty_plugin_sections_omits_section() {
        let prompt = build_system_prompt("session-1", false, false, false, "", &[]);
        assert!(!prompt.contains("插件扩展指令"));
    }

    #[test]
    fn prompt_appends_single_plugin_section() {
        let sections = vec!["记住用户偏好".to_string()];
        let prompt = build_system_prompt("session-1", false, false, false, "", &sections);
        assert!(prompt.contains("插件扩展指令"));
        assert!(prompt.contains("记住用户偏好"));
    }

    #[test]
    fn prompt_appends_multiple_plugin_sections_separated_by_blank_line() {
        let sections = vec![
            "插件A 指令".to_string(),
            "插件B 指令".to_string(),
        ];
        let prompt = build_system_prompt("session-1", false, false, false, "", &sections);
        assert!(prompt.contains("插件A 指令\n\n插件B 指令"));
    }

    #[test]
    fn prompt_plugin_section_appears_after_user_section() {
        let sections = vec!["PLUGIN_MARKER".to_string()];
        let prompt =
            build_system_prompt("session-1", false, false, false, "USER_MARKER", &sections);
        let user_pos = prompt.find("USER_MARKER").unwrap();
        let plugin_pos = prompt.find("PLUGIN_MARKER").unwrap();
        assert!(
            user_pos < plugin_pos,
            "plugin section must come after user section"
        );
    }

    #[test]
    fn prompt_with_empty_string_section_still_joins() {
        // An empty string in the sections vec should not break the join.
        let sections = vec!["".to_string()];
        let prompt = build_system_prompt("session-1", false, false, false, "", &sections);
        assert!(prompt.contains("插件扩展指令"));
    }
}
