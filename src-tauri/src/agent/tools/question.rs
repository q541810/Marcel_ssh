use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Manager;
use tokio::sync::oneshot;

use crate::agent::sandbox::RiskLevel;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::emit_event;
use crate::error::AppError;
use crate::notification::{send_notification, NotificationKind};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuestionRequestEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub question_id: String,
    pub questions: Vec<QuestionItem>,
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
                            }
                        },
                        "required": ["question", "header"]
                    }
                }
            },
            "required": ["questions"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
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
}
