use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;

use crate::agent::risk::Disposition;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuestionItem {
    pub question: String,
    pub header: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<QuestionOption>>,
    #[serde(default)]
    pub multiple: bool,
    /// 这个问题对应正文里哪一段：小标题原文（已归一化）。执行时已校验过确实在
    /// 同一轮正文的小标题里；前端凭它跳转，不做任何文本模糊搜索。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
}

/// 小标题 / anchor 的统一归一化：去掉 `*` `_` 强调符和反引号，去首尾空白与结尾冒号，
/// 内部连续空白折成一个空格。正文小标题与模型填的 anchor 走同一个函数再比较相等。
pub fn normalize_heading(text: &str) -> String {
    let stripped: String = text
        .chars()
        .filter(|c| !matches!(c, '*' | '_' | '`'))
        .collect();
    let trimmed = stripped.trim().trim_end_matches([':', '：']);
    trimmed.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// ATX 标题（`# 标题`，最多 3 个前导空格，可带结尾 `#`）的正文部分。
fn atx_heading_text(line: &str) -> Option<&str> {
    let indent = line.len() - line.trim_start_matches(' ').len();
    if indent > 3 {
        return None;
    }
    let rest = &line[indent..];
    let hashes = rest.len() - rest.trim_start_matches('#').len();
    if !(1..=6).contains(&hashes) {
        return None;
    }
    let after = &rest[hashes..];
    if !after.starts_with(char::is_whitespace) {
        return None;
    }
    let mut body = after.trim();
    // 结尾的 `##` 只有前面是空白才算闭合标记。
    let without_hashes = body.trim_end_matches('#');
    if without_hashes.len() != body.len() && without_hashes.ends_with(char::is_whitespace) {
        body = without_hashes.trim_end();
    }
    Some(body)
}

/// 整行只有 `**X**` / `__X__`（可后跟 `:` `：`，冒号也可在加粗内）的小标题正文。
fn bold_line_text(line: &str) -> Option<&str> {
    let t = line.trim().trim_end_matches([':', '：']);
    for marker in ["**", "__"] {
        if t.len() > 2 * marker.len() && t.starts_with(marker) && t.ends_with(marker) {
            let inner = &t[marker.len()..t.len() - marker.len()];
            if !inner.contains(marker) {
                return Some(inner);
            }
        }
    }
    None
}

/// 从一段 Markdown 正文提取小标题（归一化后，按出现顺序）。
/// 认 ATX 标题与整行加粗；围栏代码块（``` / ~~~）内的行跳过。
pub fn extract_headings(text: &str) -> Vec<String> {
    let mut headings = Vec::new();
    let mut fence: Option<char> = None;
    for line in text.lines() {
        let trimmed = line.trim_start();
        let fence_char = if trimmed.starts_with("```") {
            Some('`')
        } else if trimmed.starts_with("~~~") {
            Some('~')
        } else {
            None
        };
        if let Some(fc) = fence_char {
            match fence {
                None => fence = Some(fc),
                Some(open) if open == fc => fence = None,
                _ => {}
            }
            continue;
        }
        if fence.is_some() {
            continue;
        }
        let raw = atx_heading_text(line).or_else(|| bold_line_text(line));
        if let Some(raw) = raw {
            let normalized = normalize_heading(raw);
            if !normalized.is_empty() {
                headings.push(normalized);
            }
        }
    }
    headings
}

/// 校验并归一化每个问题的 anchor。失败返回给模型的中文说明（指出第几题与可选小标题）。
fn resolve_anchors(questions: &mut [QuestionItem], headings: &[String]) -> Result<(), String> {
    for (i, q) in questions.iter_mut().enumerate() {
        let Some(raw) = q.anchor.take() else { continue };
        let normalized = normalize_heading(&raw);
        if normalized.is_empty() {
            continue; // 空 anchor 等同没填
        }
        if headings.iter().any(|h| *h == normalized) {
            q.anchor = Some(normalized);
            continue;
        }
        let n = i + 1;
        return Err(if headings.is_empty() {
            format!(
                "第 {n} 个问题的 anchor「{normalized}」无法对应：你刚才的正文里没有小标题。请在正文里按事分段并加上小标题（Markdown 标题 `#…`，或单独成行的加粗小标题 `**…**`）后重新提问，或去掉 anchor 后重新提问。"
            )
        } else {
            format!(
                "第 {n} 个问题的 anchor「{normalized}」在你刚才的正文里找不到对应的小标题。现有小标题：{}。请改成其中一个的原文，或去掉 anchor 后重新提问。",
                headings.join("、")
            )
        });
    }
    Ok(())
}

const MODE_SWITCH_OVERRIDE_PARAM: &str = "is_mode_switch_request";
const MODE_SWITCH_KEYWORDS: [&str; 3] = ["auto", "agent", "模式"];

pub struct QuestionTool {
    reject_plan_mode_switch_questions: bool,
}

impl QuestionTool {
    pub fn new(reject_plan_mode_switch_questions: bool) -> Self {
        Self {
            reject_plan_mode_switch_questions,
        }
    }
}

fn contains_mode_switch_keyword(text: &str) -> bool {
    let lowercase = text.to_lowercase();
    MODE_SWITCH_KEYWORDS.iter().any(|keyword| {
        if keyword.is_ascii() {
            lowercase
                .split(|character: char| !character.is_alphanumeric() && character != '_')
                .any(|word| word == *keyword)
        } else {
            lowercase.contains(keyword)
        }
    })
}

fn questions_contain_mode_switch_keyword(questions: &[QuestionItem]) -> bool {
    questions.iter().any(|question| {
        contains_mode_switch_keyword(&question.question)
            || contains_mode_switch_keyword(&question.header)
            || question.options.as_ref().is_some_and(|options| {
                options.iter().any(|option| {
                    contains_mode_switch_keyword(&option.label)
                        || contains_mode_switch_keyword(&option.description)
                })
            })
    })
}

fn should_reject_mode_switch_question(
    params: &serde_json::Value,
    questions: &[QuestionItem],
    reject_in_plan_mode: bool,
) -> bool {
    let explicitly_not_mode_switch = params
        .get(MODE_SWITCH_OVERRIDE_PARAM)
        .and_then(|value| value.as_bool())
        == Some(false);
    reject_in_plan_mode
        && !explicitly_not_mode_switch
        && questions_contain_mode_switch_keyword(questions)
}

#[async_trait]
impl AgentTool for QuestionTool {
    fn name(&self) -> &str {
        "ask_user"
    }

    fn description(&self) -> &str {
        "向用户提问，收集信息或澄清需求。支持多个问题分页展示、选项建议和多选。每个问题可附带选项列表，多选模式下可同时选择多个选项。用于收集用户偏好、确认理解、获取决策。"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "questions": {
                    "type": "array",
                    "description": "要提问的问题列表",
                    "items": {
                        "type": "object",
                        "properties": {
                            "question": {
                                "type": "string",
                                "description": "完整的提问内容"
                            },
                            "header": {
                                "type": "string",
                                "description": "简短标签（最多 30 字符）"
                            },
                            "options": {
                                "type": "array",
                                "description": "可选答案建议列表",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "label": {
                                            "type": "string",
                                            "description": "选项文本（点击后填入回答）"
                                        },
                                        "description": {
                                            "type": "string",
                                            "description": "选项的补充说明"
                                        }
                                    },
                                    "required": ["label", "description"]
                                }
                            },
                            "multiple": {
                                "type": "boolean",
                                "description": "是否允许多选（默认 false）"
                            },
                            "anchor": {
                                "type": "string",
                                "description": "可选。这个问题对应你刚才正文里哪一段：填那一段小标题的原文（Markdown 标题 `#…`，或单独成行的加粗小标题 `**…**`），一字不差。一次问多件事时，正文按事分段写小标题，并给每个问题填上对应标题。不填则跳转到正文开头。"
                            }
                        },
                        "required": ["question", "header"]
                    }
                }
            },
            "required": ["questions"]
        })
    }

    fn disposition(&self) -> Disposition {
        Disposition::Allow
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let mut questions: Vec<QuestionItem> = serde_json::from_value(
            params
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )
        .map_err(|e| AppError::Agent(format!("ask_user: 解析 questions 参数失败: {}", e)))?;

        if questions.is_empty() {
            return Ok(ToolOutput::fail("ask_user: questions 不能为空", ""));
        }

        let headings = extract_headings(ctx.assistant_text.as_deref().unwrap_or(""));
        if let Err(detail) = resolve_anchors(&mut questions, &headings) {
            return Ok(ToolOutput::fail(
                "ask_user: anchor 与正文小标题不符",
                detail,
            ));
        }

        if should_reject_mode_switch_question(
            &params,
            &questions,
            self.reject_plan_mode_switch_questions,
        ) {
            return Ok(ToolOutput::fail(
                "ask_user: Plan 模式下不能要求用户切换模式",
                r#"用户无法在 agent loop 运行时切换模式。不要询问或要求用户切换到 Agent/Auto/其他模式；请继续在当前 Plan 模式下工作。
如果这些词只是问题内容，并非询问或要求用户切换模式，请重试并加入隐藏参数（必须使用布尔值 false，不要用于真正的模式切换请求）：
{"questions":[{"question":"你的完整问题","header":"简短标签","options":[{"label":"选项文本","description":"选项说明"}],"multiple":false}],"is_mode_switch_request":false}"#,
            ));
        }

        let question_id = ctx
            .tool_call_id
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let event_name = ctx
            .event_name
            .clone()
            .unwrap_or_else(|| "agent://stream/unknown".to_string());

        let task_id = ctx.task_id.clone().unwrap_or_else(|| {
            event_name
                .strip_prefix("agent://stream/")
                .unwrap_or(&event_name)
                .to_string()
        });

        let state = ctx.app_handle.state::<crate::AppState>();
        let conversation_id = state
            .agent_tasks
            .read()
            .get(&task_id)
            .map(|t| t.conversation_id.clone())
            .unwrap_or_default();

        let answers = state
            .agent_interaction
            .request_question(
                &ctx.app_handle,
                task_id,
                ctx.session_id.clone(),
                conversation_id,
                question_id,
                questions.clone(),
            )
            .await;

        let answers = match answers {
            Some(a) => a,
            None => {
                // Channel dropped = cancelled, return empty answers
                return Ok(ToolOutput::fail("ask_user: 用户取消", ""));
            }
        };

        // 回喂 LLM：直接输出回答内容，不加「补充说明/自定义回复」等字段标签。
        // 前端单选会把选项写在 custom；多选选项在 selected，文本在 custom。
        let mut lines = Vec::new();
        for (i, answer_val) in answers.iter().enumerate() {
            let num = i + 1;
            let header = questions
                .get(i)
                .map(|q| q.header.as_str())
                .filter(|h| !h.is_empty())
                .unwrap_or("回答");
            let selected: Vec<String> = answer_val
                .get("selected")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let custom = answer_val
                .get("custom")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            if selected.is_empty() && custom.is_empty() {
                lines.push(format!("{}. [{}] 用户未回答", num, header));
                continue;
            }

            // 仅 custom（含单选点选项）：一行写完，无字段前缀
            if selected.is_empty() {
                lines.push(format!("{}. [{}] {}", num, header, custom));
                continue;
            }

            // 多选：列表；若有额外文本直接跟在后面，不加「补充说明」标签
            lines.push(format!("{}. [{}]", num, header));
            for s in &selected {
                lines.push(format!("   - {}", s));
            }
            if !custom.is_empty() {
                lines.push(format!("   {}", custom));
            }
        }

        let output = lines.join("\n");
        let summary = if answers.iter().any(|a| {
            a.get("selected")
                .and_then(|v| v.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false)
                || a.get("custom")
                    .and_then(|v| v.as_str())
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false)
        }) {
            "用户已回答".to_string()
        } else {
            "用户取消了提问".to_string()
        };

        Ok(ToolOutput::ok(summary, output))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn question(question: &str) -> QuestionItem {
        QuestionItem {
            question: question.to_string(),
            header: "确认".to_string(),
            options: None,
            multiple: false,
            anchor: None,
        }
    }

    fn with_anchor(anchor: &str) -> QuestionItem {
        QuestionItem {
            anchor: Some(anchor.to_string()),
            ..question("要继续吗？")
        }
    }

    #[test]
    fn extracts_atx_headings_and_closing_hashes() {
        let text = "前言\n# 方案 A\n正文\n## 方案 B ##\n   ### 缩进三格\n    #### 四格是代码\n#无空格不算\n####### 七个不算\n";
        assert_eq!(extract_headings(text), ["方案 A", "方案 B", "缩进三格"]);
        // `C#` 里的 # 不是闭合标记
        assert_eq!(extract_headings("## 迁移到 C#"), ["迁移到 C#"]);
    }

    #[test]
    fn extracts_standalone_bold_lines_with_colons() {
        let text = "**部署方式**\n__数据库__：\n**端口：**\n**备份**:\n正文里有 **加粗** 不算\n**甲** 和 **乙**\n";
        assert_eq!(
            extract_headings(text),
            ["部署方式", "数据库", "端口", "备份"]
        );
    }

    #[test]
    fn skips_fenced_code_blocks() {
        let text =
            "# 真标题\n```bash\n# 注释不是标题\n**假**\n```\n~~~\n# 也不是\n~~~\n**后面的**\n";
        assert_eq!(extract_headings(text), ["真标题", "后面的"]);
    }

    #[test]
    fn normalizes_emphasis_backticks_and_whitespace() {
        assert_eq!(
            normalize_heading("  `foo`  **bar**   baz： "),
            "foo bar baz"
        );
        assert_eq!(
            extract_headings("## 用 `nginx`  还是  *caddy*？"),
            ["用 nginx 还是 caddy？"]
        );
    }

    #[test]
    fn anchor_is_normalized_and_matched_exactly() {
        let hs = extract_headings("**部署方式：**\n## 备份策略\n");
        let mut qs = vec![with_anchor(" **部署方式** "), with_anchor("`备份策略`:")];
        resolve_anchors(&mut qs, &hs).unwrap();
        assert_eq!(qs[0].anchor.as_deref(), Some("部署方式"));
        assert_eq!(qs[1].anchor.as_deref(), Some("备份策略"));
    }

    #[test]
    fn missing_anchor_and_blank_anchor_pass() {
        let mut qs = vec![question("a"), with_anchor("  ")];
        resolve_anchors(&mut qs, &[]).unwrap();
        assert!(qs[0].anchor.is_none() && qs[1].anchor.is_none());
    }

    #[test]
    fn unknown_anchor_errors_with_available_headings() {
        let hs = extract_headings("# A\n# B\n");
        let mut qs = vec![question("x"), with_anchor("C")];
        let err = resolve_anchors(&mut qs, &hs).unwrap_err();
        assert!(err.contains("第 2 个问题") && err.contains("「C」") && err.contains("A、B"));
        let err = resolve_anchors(&mut [with_anchor("C")], &[]).unwrap_err();
        assert!(err.contains("没有小标题"));
    }

    #[test]
    fn anchor_serializes_camel_case_and_is_omitted_when_none() {
        let v = serde_json::to_value(with_anchor("A")).unwrap();
        assert_eq!(v["anchor"], "A");
        let v = serde_json::to_value(question("q")).unwrap();
        assert!(v.get("anchor").is_none());
        let back: QuestionItem =
            serde_json::from_value(json!({"question":"q","header":"h","anchor":"A"})).unwrap();
        assert_eq!(back.anchor.as_deref(), Some("A"));
    }

    #[test]
    fn hidden_override_is_not_advertised_in_schema() {
        let schema = QuestionTool::new(true).parameters_schema();

        assert!(schema["properties"]
            .get(MODE_SWITCH_OVERRIDE_PARAM)
            .is_none());
        assert_eq!(schema["required"], json!(["questions"]));
    }

    #[test]
    fn detects_mode_keywords_case_insensitively_without_substring_false_positives() {
        for text in ["切换到 auto", "Use AGENT mode", "选择运行模式"] {
            assert!(contains_mode_switch_keyword(text), "should match: {text}");
        }
        for text in ["automation", "agentic workflow"] {
            assert!(
                !contains_mode_switch_keyword(text),
                "should not match: {text}"
            );
        }
    }

    #[test]
    fn scans_question_headers_and_options() {
        let mut item = question("请选择下一步");
        item.options = Some(vec![QuestionOption {
            label: "Agent".to_string(),
            description: "切换后继续".to_string(),
        }]);

        assert!(questions_contain_mode_switch_keyword(&[item]));
    }

    #[test]
    fn hidden_false_override_bypasses_only_plan_keyword_guard() {
        let questions = [question("Agent 模式有什么区别？")];

        assert!(should_reject_mode_switch_question(
            &json!({"questions": [], (MODE_SWITCH_OVERRIDE_PARAM): true}),
            &questions,
            true,
        ));
        assert!(!should_reject_mode_switch_question(
            &json!({"questions": [], (MODE_SWITCH_OVERRIDE_PARAM): false}),
            &questions,
            true,
        ));
        assert!(!should_reject_mode_switch_question(
            &json!({"questions": []}),
            &questions,
            false,
        ));
    }

    #[test]
    fn unrelated_questions_are_not_rejected() {
        assert!(!questions_contain_mode_switch_keyword(&[question(
            "你希望使用哪种部署策略？"
        )]));
    }
}
