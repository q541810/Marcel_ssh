//! Model-based command approval.
//!
//! Pure-function module: an independent approval judge inserted after the
//! sandbox risk assessment and before the human-approval trigger. Even when
//! the sandbox says no human approval is needed, this step still runs for
//! `execute_command` (when enabled).
//!
//! Power boundary:
//! - `Approve` — allow the command. Cannot override a sandbox human-approval
//!   requirement (the sandbox's `needs_confirm` stays in effect).
//! - `RouteToHuman` — force the command into the human approval flow. Reasons
//!   are surfaced to the user in the approval dialog.
//! - `Block` — block the command outright. Reasons describe the problem points.
//!
//! The model can only judge; it cannot rewrite the command text. Reuses the
//! agent's normal model + retry path (`OpenAiProvider::send_message`); if the
//! call still fails after retries, the error is surfaced as a blocked tool
//! result by the dispatcher.

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;

use crate::agent::templates::TemplateManager;
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmProvider, LlmRole, ToolDefinition};

/// Model's decision on whether a command may proceed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ModelApprovalDecision {
    /// Allow the command. Cannot override a sandbox human-approval requirement.
    Approve,
    /// Force the command into the human approval flow. Reasons are shown to the user.
    RouteToHuman(Vec<String>),
    /// Block the command outright. Reasons describe the problem points.
    Block(Vec<String>),
}

/// Pluggable command approver so the dispatch logic is unit-testable.
#[async_trait]
pub(crate) trait CommandApprover: Send + Sync {
    async fn evaluate(
        &self,
        command: &str,
        recent_messages: &[LlmMessage],
    ) -> Result<ModelApprovalDecision, AppError>;
}

/// LLM-backed command approver. Reuses the agent's normal model + retry path.
pub(crate) struct ModelApprover {
    provider: Arc<OpenAiProvider>,
    custom_prompt: String,
    plan_mode: bool,
}

impl ModelApprover {
    pub(crate) fn new(
        provider: Arc<OpenAiProvider>,
        custom_prompt: String,
        plan_mode: bool,
    ) -> Self {
        Self {
            provider,
            custom_prompt,
            plan_mode,
        }
    }
}

#[async_trait]
impl CommandApprover for ModelApprover {
    async fn evaluate(
        &self,
        command: &str,
        recent_messages: &[LlmMessage],
    ) -> Result<ModelApprovalDecision, AppError> {
        let context = build_context(recent_messages);

        let user_prompt = format!(
            "用户任务上下文：\n{context}\n\n\
             待审批命令：\n{command}\n\n\
             请给出你的判定。"
        );

        let system_prompt = if self.custom_prompt.is_empty() {
            let mgr = TemplateManager;
            let mut prompt = mgr.render_approval_base();
            if self.plan_mode {
                prompt.push_str(&mgr.render_approval_plan());
            }
            prompt
        } else if self.plan_mode {
            format!(
                "{}\n{}",
                self.custom_prompt,
                TemplateManager.render_approval_plan()
            )
        } else {
            self.custom_prompt.clone()
        };

        let messages = vec![
            LlmMessage::system(system_prompt),
            LlmMessage::user(user_prompt),
        ];
        let tools: Vec<ToolDefinition> = vec![];

        let resp = self.provider.send_message(&messages, &tools).await?;
        parse_decision(&resp.content)
    }
}

/// Build a compact context string from recent messages.
///
/// Keeps the original user task + recent turns, truncating large tool outputs
/// so the approval call stays cheap and the model doesn't guess without context.
fn build_context(messages: &[LlmMessage]) -> String {
    const MAX_TOOL_OUTPUT: usize = 500;
    const MAX_OTHER_CONTENT: usize = 1000;
    const MAX_ROUNDS: usize = 5;

    let mut parts: Vec<String> = Vec::new();

    let non_system: Vec<&LlmMessage> = messages
        .iter()
        .filter(|m| m.role != LlmRole::System)
        .collect();

    // 按轮次切分：每条 User 消息是一个轮次的起点，取最后 MAX_ROUNDS 个完整轮次
    let user_indices: Vec<usize> = non_system
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == LlmRole::User)
        .map(|(i, _)| i)
        .collect();

    let start = if user_indices.len() > MAX_ROUNDS {
        user_indices[user_indices.len() - MAX_ROUNDS]
    } else {
        0
    };
    let recent = &non_system[start..];

    if !recent.is_empty() {
        parts.push("[近期对话]".to_string());
        for m in recent {
            let role = match m.role {
                LlmRole::User => "用户",
                LlmRole::Assistant => "助手",
                LlmRole::Tool => "工具结果",
                LlmRole::System => "系统",
            };
            let cap = if m.role == LlmRole::Tool {
                MAX_TOOL_OUTPUT
            } else {
                MAX_OTHER_CONTENT
            };
            parts.push(format!("{role}: {}", truncate(&m.content, cap)));
        }
    }

    parts.join("\n")
}

/// Char-boundary-safe truncation with a truncation marker.
fn truncate(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    if end == 0 {
        return "…（已截断）".to_string();
    }
    format!("{}…（已截断）", &s[..end])
}

#[derive(Deserialize)]
struct ApprovalResponse {
    decision: String,
    #[serde(default)]
    reasons: Vec<String>,
}

fn parse_decision(content: &str) -> Result<ModelApprovalDecision, AppError> {
    let json_str = extract_json(content);
    let parsed: ApprovalResponse = serde_json::from_str(&json_str)
        .map_err(|e| AppError::Llm(format!("模型审批响应解析失败: {} | 原文: {}", e, content)))?;
    match parsed.decision.as_str() {
        "approve" => Ok(ModelApprovalDecision::Approve),
        "route_to_human" => Ok(ModelApprovalDecision::RouteToHuman(parsed.reasons)),
        "block" => Ok(ModelApprovalDecision::Block(parsed.reasons)),
        other => Err(AppError::Llm(format!(
            "模型审批返回未知决策 {:?}，原文: {}",
            other, content
        ))),
    }
}

/// Extract the first JSON object from a possibly fenced/contaminated response.
fn extract_json(content: &str) -> String {
    let trimmed = content.trim();
    let stripped = trimmed
        .strip_prefix("```json")
        .or_else(|| trimmed.strip_prefix("```"))
        .map(|rest| rest.trim_start_matches('\n'))
        .and_then(|rest| rest.strip_suffix("```").map(|r| r.trim()))
        .unwrap_or(trimmed);
    if let (Some(start), Some(end)) = (stripped.find('{'), stripped.rfind('}')) {
        if end > start {
            return stripped[start..=end].to_string();
        }
    }
    stripped.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_approve() {
        let d = parse_decision(r#"{"decision":"approve","reasons":[]}"#).unwrap();
        assert_eq!(d, ModelApprovalDecision::Approve);
    }

    #[test]
    fn parse_route_to_human_with_reasons() {
        let d = parse_decision(r#"{"decision":"route_to_human","reasons":["可能删除重要文件"]}"#)
            .unwrap();
        assert_eq!(
            d,
            ModelApprovalDecision::RouteToHuman(vec!["可能删除重要文件".into()])
        );
    }

    #[test]
    fn parse_block_with_reasons() {
        let d = parse_decision(r#"{"decision":"block","reasons":["rm -rf / 不可逆"]}"#).unwrap();
        assert_eq!(
            d,
            ModelApprovalDecision::Block(vec!["rm -rf / 不可逆".into()])
        );
    }

    #[test]
    fn parse_strips_json_fences() {
        let raw = "```json\n{\"decision\":\"approve\",\"reasons\":[]}\n```";
        let d = parse_decision(raw).unwrap();
        assert_eq!(d, ModelApprovalDecision::Approve);
    }

    #[test]
    fn parse_extracts_json_from_prose() {
        let raw = "好的，我的判定如下：\n{\"decision\":\"block\",\"reasons\":[\"危险\"]}\n以上。";
        let d = parse_decision(raw).unwrap();
        assert_eq!(d, ModelApprovalDecision::Block(vec!["危险".into()]));
    }

    #[test]
    fn parse_unknown_decision_errors() {
        let raw = r#"{"decision":"maybe","reasons":[]}"#;
        assert!(parse_decision(raw).is_err());
    }

    #[test]
    fn parse_missing_decision_errors() {
        let raw = r#"{"reasons":[]}"#;
        assert!(parse_decision(raw).is_err());
    }

    #[test]
    fn extract_json_handles_no_braces() {
        assert_eq!(extract_json("not json"), "not json");
    }

    #[test]
    fn extract_json_handles_nested_braces() {
        let raw = r#"prefix {"a":{"b":1},"c":2} suffix"#;
        assert_eq!(extract_json(raw), r#"{"a":{"b":1},"c":2}"#);
    }

    #[test]
    fn extract_json_strips_bare_fences() {
        let raw = "```\n{\"decision\":\"approve\",\"reasons\":[]}\n```";
        assert_eq!(extract_json(raw), r#"{"decision":"approve","reasons":[]}"#);
    }

    fn tool_msg(content: &str) -> LlmMessage {
        LlmMessage {
            role: LlmRole::Tool,
            content: content.into(),
            tool_calls: None,
            tool_call_id: Some("1".into()),
            reasoning_content: None,
            image_paths: None,
            finish_reason: None,
        }
    }

    #[test]
    fn build_context_includes_first_user_and_recent() {
        let messages = vec![
            LlmMessage::system("sys"),
            LlmMessage::user("帮我清理/tmp"),
            LlmMessage::assistant("好的"),
            tool_msg("result"),
        ];
        let ctx = build_context(&messages);
        assert!(ctx.contains("[近期对话]"));
        assert!(ctx.contains("助手: 好的"));
        assert!(ctx.contains("工具结果: result"));
        assert!(!ctx.contains("sys"), "system prompt must not leak");
    }

    #[test]
    fn build_context_truncates_tool_output() {
        let long = "x".repeat(1000);
        let messages = vec![LlmMessage::user("任务"), tool_msg(&long)];
        let ctx = build_context(&messages);
        assert!(ctx.contains("已截断"));
    }

    #[test]
    fn build_context_empty_messages() {
        let ctx = build_context(&[]);
        assert!(ctx.is_empty());
    }

    #[test]
    fn truncate_under_limit_is_identity() {
        assert_eq!(truncate("hello", 10), "hello");
    }

    #[test]
    fn truncate_over_limit_marks_truncation() {
        assert_eq!(truncate("hello world", 5), "hello…（已截断）");
    }

    #[test]
    fn build_context_takes_last_5_rounds() {
        // 7 个用户轮次，每轮 user + assistant + tool
        let mut messages: Vec<LlmMessage> = vec![LlmMessage::system("sys")];
        for i in 0..7 {
            messages.push(LlmMessage::user(format!("用户第{i}轮")));
            messages.push(LlmMessage::assistant(format!("助手第{i}轮回复")));
            messages.push(tool_msg(&format!("工具第{i}轮结果")));
        }
        let ctx = build_context(&messages);
        // 第 0、1 轮在近期对话中应该被裁掉（只保留最后 5 轮：2~6）
        let recent_section = ctx.split("[近期对话]").nth(1).unwrap_or("");
        assert!(!recent_section.contains("用户第1轮"));
        assert!(recent_section.contains("用户第2轮"));
        assert!(recent_section.contains("用户第6轮"));
    }

    #[test]
    fn truncate_respects_char_boundary() {
        let s = "你好世界"; // each char is 3 bytes in UTF-8
        let t = truncate(s, 4); // 4 bytes would split a char
        assert!(t.ends_with("已截断）"));
        assert!(
            !t.contains('\u{FFFD}'),
            "no replacement char from splitting"
        );
    }
}
