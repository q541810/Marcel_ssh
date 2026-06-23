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

use crate::agent::sandbox::RiskLevel;
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
        risk: RiskLevel,
        sandbox_needs_confirm: bool,
        recent_messages: &[LlmMessage],
    ) -> Result<ModelApprovalDecision, AppError>;
}

/// LLM-backed command approver. Reuses the agent's normal model + retry path.
pub(crate) struct ModelApprover {
    provider: Arc<OpenAiProvider>,
}

impl ModelApprover {
    pub(crate) fn new(provider: Arc<OpenAiProvider>) -> Self {
        Self { provider }
    }
}

const APPROVAL_SYSTEM_PROMPT: &str = "\
你是一个命令执行审批助手。Agent 即将在远程服务器上执行一条 shell 命令，你需要结合上下文判断这条命令是否可以安全放行。

判断原则：
- 大多数常规命令（查看状态、列目录、读取文件等）应当放行，不要过度紧张。
- 只在命令存在真实风险时才转人工审批或阻止：不可逆的破坏、越权操作、与用户当前任务明显不符等。
- 你只能判定，不能改写命令。
- 沙箱已做过静态风险分析，其结论供你参考：沙箱要求人工审批的命令，你无法放行使其绕过人审，最多维持人审。

输出严格的 JSON，不要添加任何额外文字：
{\"decision\": \"approve\" 或 \"route_to_human\" 或 \"block\", \"reasons\": [\"问题点1\", \"问题点2\"]}
- approve：放行，reasons 可为空数组。
- route_to_human：需要人工审批，reasons 写明需要人审的原因。
- block：应当阻止，reasons 写明阻止原因。";

#[async_trait]
impl CommandApprover for ModelApprover {
    async fn evaluate(
        &self,
        command: &str,
        risk: RiskLevel,
        sandbox_needs_confirm: bool,
        recent_messages: &[LlmMessage],
    ) -> Result<ModelApprovalDecision, AppError> {
        let context = build_context(recent_messages);
        let risk_label = risk_label(risk);
        let sandbox_label = if sandbox_needs_confirm {
            "是（沙箱要求人工审批）"
        } else {
            "否"
        };

        let user_prompt = format!(
            "用户任务上下文：\n{context}\n\n\
             待审批命令：\n{command}\n\n\
             沙箱风险等级：{risk_label}\n\
             沙箱是否要求人工审批：{sandbox_label}\n\n\
             请给出你的判定。"
        );

        let messages = vec![
            LlmMessage::system(APPROVAL_SYSTEM_PROMPT),
            LlmMessage::user(user_prompt),
        ];
        let tools: Vec<ToolDefinition> = vec![];

        let resp = self.provider.send_message(&messages, &tools).await?;
        parse_decision(&resp.content)
    }
}

fn risk_label(r: RiskLevel) -> &'static str {
    match r {
        RiskLevel::ReadOnly => "只读",
        RiskLevel::LowRisk => "低风险",
        RiskLevel::Moderate => "中风险",
        RiskLevel::HighRisk => "高风险",
        RiskLevel::Destructive => "破坏性",
    }
}

/// Build a compact context string from recent messages.
///
/// Keeps the original user task + recent turns, truncating large tool outputs
/// so the approval call stays cheap and the model doesn't guess without context.
fn build_context(messages: &[LlmMessage]) -> String {
    const MAX_TOOL_OUTPUT: usize = 500;
    const MAX_OTHER_CONTENT: usize = 1000;
    const MAX_FIRST_USER: usize = 2000;
    const MAX_RECENT: usize = 8;

    let mut parts: Vec<String> = Vec::new();

    if let Some(first_user) = messages.iter().find(|m| m.role == LlmRole::User) {
        parts.push(format!(
            "[原始任务]\n{}",
            truncate(&first_user.content, MAX_FIRST_USER)
        ));
    }

    let mut recent: Vec<&LlmMessage> = messages
        .iter()
        .filter(|m| m.role != LlmRole::System)
        .rev()
        .take(MAX_RECENT)
        .collect::<Vec<_>>();
    recent.reverse();

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
    let parsed: ApprovalResponse = serde_json::from_str(&json_str).map_err(|e| {
        AppError::Llm(format!("模型审批响应解析失败: {} | 原文: {}", e, content))
    })?;
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
        let d =
            parse_decision(r#"{"decision":"route_to_human","reasons":["可能删除重要文件"]}"#).unwrap();
        assert_eq!(
            d,
            ModelApprovalDecision::RouteToHuman(vec!["可能删除重要文件".into()])
        );
    }

    #[test]
    fn parse_block_with_reasons() {
        let d = parse_decision(r#"{"decision":"block","reasons":["rm -rf / 不可逆"]}"#).unwrap();
        assert_eq!(d, ModelApprovalDecision::Block(vec!["rm -rf / 不可逆".into()]));
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
        assert!(ctx.contains("[原始任务]"));
        assert!(ctx.contains("帮我清理/tmp"));
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
    fn truncate_respects_char_boundary() {
        let s = "你好世界"; // each char is 3 bytes in UTF-8
        let t = truncate(s, 4); // 4 bytes would split a char
        assert!(t.ends_with("已截断）"));
        assert!(!t.contains('\u{FFFD}'), "no replacement char from splitting");
    }
}
