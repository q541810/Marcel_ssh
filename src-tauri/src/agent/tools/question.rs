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
pub(crate) struct QuestionOption {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct QuestionItem {
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

pub struct QuestionTool;

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

        let question_id = ctx
            .tool_call_id
            .clone()
            .unwrap_or_else(|| "unknown".to_string());
        let event_name = ctx
            .event_name
            .clone()
            .unwrap_or_else(|| "agent://stream/unknown".to_string());

        // Send notification
        {
            let state = ctx.app_handle.state::<crate::AppState>();
            let ns = state.settings.read().await.notification_settings.clone();
            let title = format!("Agent 向您提问 ({} 题)", questions.len());
            let first_q = &questions[0];
            let body = format!("{}: {}", first_q.header, first_q.question);
            send_notification(
                &ctx.app_handle,
                NotificationKind::AgentQuestion,
                &ns,
                &title,
                &body,
            );
        }

        emit_event(
            &ctx.app_handle,
            &event_name,
            QuestionRequestEvent {
                event_type: "questionRequest".to_string(),
                question_id: question_id.clone(),
                questions: questions.clone(),
            },
        );

        let (tx, rx) = oneshot::channel::<Vec<serde_json::Value>>();
        {
            let task_id = event_name
                .strip_prefix("agent://stream/")
                .unwrap_or(&event_name);
            let pending = &ctx.pending_questions;
            let key = (task_id.to_string(), question_id.clone());
            pending.write().insert(key, tx);
        }

        let answers = match rx.await {
            Ok(a) => a,
            Err(_) => {
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
