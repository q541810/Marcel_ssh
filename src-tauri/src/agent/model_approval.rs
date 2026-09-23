//! Model-based command approval.
//!
//! Pure-function module: an independent approval judge inserted after the
//! risk assessment and before the human-approval trigger. Even when
//! the risk assessment says no human approval is needed, this step still runs for
//! `bash` (when enabled).
//!
//! Power boundary:
//! - `Approve` — allow the command. Cannot override a risk-assessment human-approval
//!   requirement (its `needs_confirm` stays in effect).
//! - `RouteToHuman` — force the command into the human approval flow. Reasons
//!   are surfaced to the user in the approval dialog.
//! - `Block` — block the command outright. Reasons describe the problem points.
//!
//! The model can only judge; it cannot rewrite the command text. Reuses the
//! agent's normal model + retry path (`LlmManager::send_message`); if the
//! call still fails after retries, the error is surfaced as a blocked tool
//! result by the dispatcher.
//!
//! # 两个引擎
//!
//! `CommandApprover` 有两种实现，由设置的「审批引擎」选择：
//!
//! - [`ModelApprover`]（本文件）——走会话模型，自由文本判定 + JSON 解析。
//! - `JevApprover`（`agent/jev_approval.rs`）——走 TypeSafe 的 Jev（System One
//!   决策模型），结构化判定 + 概率分布。
//!
//! 上下文抽取口径由 [`recent_turns`] 统一持有：chat 引擎把它渲染成文本，
//! Jev 引擎把它渲染成结构化 state。上限只定义一次，避免两边漂移。

use std::sync::Arc;

use async_trait::async_trait;
use serde::Deserialize;

use crate::agent::templates::TemplateManager;
use crate::error::AppError;
use crate::llm::manager::LlmManager;
use crate::llm::provider::{LlmMessage, LlmRole, ToolDefinition};

/// Model's decision on whether a command may proceed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ModelApprovalDecision {
    /// Allow the command. Cannot override a risk-assessment human-approval requirement.
    Approve,
    /// Force the command into the human approval flow. Reasons are shown to the user.
    RouteToHuman(Vec<String>),
    /// Block the command outright. Reasons describe the problem points.
    Block(Vec<String>),
}

/// 一次审批判定的完整结果：决策本身 + 判定元信息。
///
/// `confidence` / `engine` 只用于**展示**——决策语义完全由 `decision` 决定，
/// 低置信度不会改变它。这是刻意的：两个引擎在判定语义上必须等价，差异只有
/// 速度、成本和理由形态。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ApprovalJudgement {
    pub decision: ModelApprovalDecision,
    /// 模型对自己这个判定的把握。`None` = 该引擎不提供（chat 引擎恒为 `None`）。
    ///
    /// ⚠️ 官方对 Jev 的 `confidence` 定义是「概率分布的集中程度」，
    /// **不是**「这次判定正确的概率」，也不是「可以据此执行」的许可。
    /// 展示时必须按这个口径措辞，否则会误导用户。
    pub confidence: Option<f32>,
    /// 产出这条判定的引擎：`"model"` | `"jev"`。
    pub engine: &'static str,
}

impl ApprovalJudgement {
    /// chat 引擎的结果（无置信度）。
    pub(crate) fn from_model(decision: ModelApprovalDecision) -> Self {
        Self {
            decision,
            confidence: None,
            engine: "model",
        }
    }
}

/// Pluggable command approver so the dispatch logic is unit-testable.
#[async_trait]
pub(crate) trait CommandApprover: Send + Sync {
    async fn evaluate(
        &self,
        command: &str,
        recent_messages: &[LlmMessage],
    ) -> Result<ApprovalJudgement, AppError>;
}

/// LLM-backed command approver. Reuses the agent's normal model + retry path.
pub(crate) struct ModelApprover {
    manager: Arc<LlmManager>,
    custom_prompt: String,
    plan_mode: bool,
}

impl ModelApprover {
    pub(crate) fn new(manager: Arc<LlmManager>, custom_prompt: String, plan_mode: bool) -> Self {
        Self {
            manager,
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
    ) -> Result<ApprovalJudgement, AppError> {
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

        let resp = self.manager.send_message(&messages, &tools, None).await?;
        parse_decision(&resp.content).map(ApprovalJudgement::from_model)
    }
}

/// 一段近期上下文（内容已按上限截断）。
pub(crate) struct ContextTurn {
    /// 稳定角色标识：`user` / `assistant` / `tool`。
    ///
    /// 刻意用英文稳定键而不是中文标签：chat 引擎把它渲染成中文（`build_context`），
    /// Jev 引擎直接把它作为结构化 state 里的字段值（Jev 的强项是英文，
    /// 而 state 里真正需要保持原文的是对话内容本身，不是角色名）。
    pub role: &'static str,
    pub content: String,
}

fn role_key(role: &LlmRole) -> &'static str {
    match role {
        LlmRole::User => "user",
        LlmRole::Assistant => "assistant",
        LlmRole::Tool => "tool",
        LlmRole::System => "system",
    }
}

fn role_key_zh(role: &str) -> &'static str {
    match role {
        "user" => "用户",
        "assistant" => "助手",
        "tool" => "工具结果",
        _ => "系统",
    }
}

/// 抽取「原始任务 + 最近若干轮」的上下文，按统一上限截断。
///
/// 这是**两个审批引擎共用的唯一上下文抽取口径**：chat 引擎把它渲染成文本，
/// Jev 引擎把它渲染成结构化 state 的 `conversation` 数组。截断上限只在这里
/// 定义一次，避免两个引擎各留一份而漂移。
///
/// system 消息一律不进上下文（系统提示词不该泄进审批请求）。
pub(crate) fn recent_turns(messages: &[LlmMessage]) -> Vec<ContextTurn> {
    const MAX_TOOL_OUTPUT: usize = 500;
    const MAX_OTHER_CONTENT: usize = 1000;
    const MAX_ROUNDS: usize = 5;

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

    non_system[start..]
        .iter()
        .map(|m| {
            let cap = if m.role == LlmRole::Tool {
                MAX_TOOL_OUTPUT
            } else {
                MAX_OTHER_CONTENT
            };
            ContextTurn {
                role: role_key(&m.role),
                content: truncate(&m.content, cap),
            }
        })
        .collect()
}

/// Build a compact context string from recent messages（chat 引擎用）。
fn build_context(messages: &[LlmMessage]) -> String {
    let turns = recent_turns(messages);
    if turns.is_empty() {
        return String::new();
    }
    let mut parts = vec!["[近期对话]".to_string()];
    for t in &turns {
        parts.push(format!("{}: {}", role_key_zh(t.role), t.content));
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
            db_id: None,
            db_id_known: false,
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
