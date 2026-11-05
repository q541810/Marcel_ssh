use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;

use crate::agent::interaction::SourceSubagent;
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
}

/// 校验 `source_subagent`：必须是**当前对话**派发的子对话、且正停在 `ask_parent` 上。
/// 失败返回给模型的中文说明（纯函数便于单测）。
fn resolve_source_subagent(
    sub_id: &str,
    conversation: Option<&crate::agent::conversation::Conversation>,
    parent_conversation_id: &str,
    pending: Option<crate::agent::tools::ask_parent::PendingParentAsk>,
) -> Result<SourceSubagent, String> {
    let Some(conv) = conversation else {
        return Err(format!(
            "source_subagent=\"{sub_id}\" 找不到对应的子agent对话。它应是子agent提问时给你的 continue_id；没有要转问的子agent提问就别传这个参数。"
        ));
    };
    if conv.parent_conversation_id.as_deref() != Some(parent_conversation_id) {
        return Err(format!(
            "source_subagent=\"{sub_id}\" 不是当前对话派发的子agent。只能转问你自己派发的子agent的提问。"
        ));
    }
    let Some(ask) = pending else {
        return Err(format!(
            "source_subagent=\"{sub_id}\" 的子agent当前没有等你回答的提问（可能已回答过、已结束或没有提过问）。去掉 source_subagent，或换成正在等你回答的那个子agent的 continue_id。"
        ));
    };
    Ok(SourceSubagent {
        conversation_id: conv.id.clone(),
        title: conv.title.clone(),
        ask_tool_call_id: ask.tool_call_id,
    })
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
                                "description": "完整的提问内容。要让用户只看这张卡片就能明白情况并做决定：交代背景、选项后果、你的推荐，同时保持简短易读"
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
                            }
                        },
                        "required": ["question", "header"]
                    }
                },
                "source_subagent": {
                    "type": "string",
                    "description": "可选。你在替一个暂停的子agent向用户转问时，填它的 continue_id（子agent提问的结果里给出）。界面会标明这是子agent的问题；之后再用同一个 continue_id 把答案转给它。"
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
        let questions: Vec<QuestionItem> = serde_json::from_value(
            params
                .get("questions")
                .cloned()
                .unwrap_or_else(|| json!([])),
        )
        .map_err(|e| AppError::Agent(format!("ask_user: 解析 questions 参数失败: {}", e)))?;

        if questions.is_empty() {
            return Ok(ToolOutput::fail("ask_user: questions 不能为空", ""));
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

        let source_subagent = match params
            .get("source_subagent")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            None => None,
            Some(sub_id) => {
                let conv = state
                    .conversation_db
                    .get_conversation(sub_id)
                    .ok()
                    .flatten();
                let pending = state
                    .conversation_db
                    .pending_parent_ask(sub_id)
                    .ok()
                    .flatten();
                match resolve_source_subagent(sub_id, conv.as_ref(), &conversation_id, pending) {
                    Ok(source) => Some(source),
                    Err(detail) => {
                        return Ok(ToolOutput::fail("ask_user: source_subagent 无效", detail));
                    }
                }
            }
        };

        let answers = state
            .agent_interaction
            .request_question(
                &ctx.app_handle,
                task_id,
                ctx.session_id.clone(),
                conversation_id,
                question_id,
                questions.clone(),
                source_subagent,
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
        }
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

    // ── source_subagent 校验 ──

    fn sub_conv(parent: Option<&str>) -> crate::agent::conversation::Conversation {
        let db = crate::agent::conversation::ConversationDb::in_memory().unwrap();
        let mut c = db.create_conversation("conn", "查磁盘（子agent）").unwrap();
        c.id = "sub-1".into();
        c.parent_conversation_id = parent.map(String::from);
        c
    }

    fn pending() -> crate::agent::tools::ask_parent::PendingParentAsk {
        crate::agent::tools::ask_parent::PendingParentAsk {
            tool_call_id: "ask-1".into(),
            question: "q".into(),
            context: None,
            arguments: json!({}),
        }
    }

    #[test]
    fn source_subagent_accepts_own_waiting_subagent() {
        let source = resolve_source_subagent(
            "sub-1",
            Some(&sub_conv(Some("main"))),
            "main",
            Some(pending()),
        )
        .unwrap();
        assert_eq!(source.conversation_id, "sub-1");
        assert_eq!(source.title, "查磁盘（子agent）");
        assert_eq!(source.ask_tool_call_id, "ask-1");
        // 前端契约：驼峰键
        let json = serde_json::to_value(&source).unwrap();
        assert_eq!(json["conversationId"], "sub-1");
        assert_eq!(json["askToolCallId"], "ask-1");
    }

    #[test]
    fn source_subagent_rejects_missing_foreign_and_not_waiting() {
        assert!(resolve_source_subagent("x", None, "main", Some(pending())).is_err());
        let foreign = resolve_source_subagent(
            "sub-1",
            Some(&sub_conv(Some("other"))),
            "main",
            Some(pending()),
        );
        assert!(foreign.unwrap_err().contains("不是当前对话派发"));
        let main_conv =
            resolve_source_subagent("sub-1", Some(&sub_conv(None)), "main", Some(pending()));
        assert!(main_conv.is_err());
        let idle = resolve_source_subagent("sub-1", Some(&sub_conv(Some("main"))), "main", None);
        assert!(idle.unwrap_err().contains("没有等你回答的提问"));
    }

    #[test]
    fn question_detail_omits_source_subagent_when_absent() {
        let detail = crate::agent::interaction::QuestionDetail {
            question_id: "q".into(),
            questions: vec![],
            source_subagent: None,
        };
        assert!(serde_json::to_value(&detail)
            .unwrap()
            .get("sourceSubagent")
            .is_none());
    }
}
