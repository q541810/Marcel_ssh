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
use crate::config::settings::ApprovalContextLevel;
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::llm::provider::{LlmMessage, LlmProvider, LlmRole, ToolCall, ToolDefinition};

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
        tool_call: &ToolCall,
        recent_messages: &[LlmMessage],
    ) -> Result<ModelApprovalDecision, AppError>;
}

/// LLM-backed command approver. Reuses the agent's normal model + retry path.
pub(crate) struct ModelApprover {
    provider: Arc<OpenAiProvider>,
    custom_prompt: String,
    plan_mode: bool,
    context_level: ApprovalContextLevel,
}

impl ModelApprover {
    pub(crate) fn new(
        provider: Arc<OpenAiProvider>,
        custom_prompt: String,
        plan_mode: bool,
        context_level: ApprovalContextLevel,
    ) -> Self {
        Self {
            provider,
            custom_prompt,
            plan_mode,
            context_level,
        }
    }
}

#[async_trait]
impl CommandApprover for ModelApprover {
    async fn evaluate(
        &self,
        tool_call: &ToolCall,
        recent_messages: &[LlmMessage],
    ) -> Result<ModelApprovalDecision, AppError> {
        let user_prompt = build_user_prompt(tool_call, recent_messages, self.context_level)?;

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

fn build_user_prompt(
    tool_call: &ToolCall,
    recent_messages: &[LlmMessage],
    level: ApprovalContextLevel,
) -> Result<String, AppError> {
    let context = build_context(recent_messages, level);
    let current_call = serde_json::to_string(tool_call)
        .map_err(|e| AppError::Llm(format!("模型审批工具调用序列化失败: {e}")))?;

    Ok(format!(
        "用户任务上下文：\n{context}\n\n\
         待审批 Tool Call：\n{current_call}\n\n\
         请给出你的判定。"
    ))
}

/// Per-level limits for the approval context. `Normal` matches the original
/// hard-coded values so existing users see no change.
fn context_limits(level: ApprovalContextLevel) -> (usize, usize, usize) {
    match level {
        ApprovalContextLevel::Concise => (2, 200, 400),
        ApprovalContextLevel::Normal => (5, 500, 1000),
        ApprovalContextLevel::Detailed => (10, 1500, 3000),
    }
}

/// Build a compact context string from recent messages.
///
/// Keeps the original user task + recent turns, truncating large tool outputs
/// so the approval call stays cheap and the model doesn't guess without context.
/// Assistant tool calls (id/name/arguments) are emitted so the approval model
/// sees what actions the agent took, not just its prose.
fn build_context(messages: &[LlmMessage], level: ApprovalContextLevel) -> String {
    let (max_rounds, max_tool_output, max_other_content) = context_limits(level);

    let mut parts: Vec<String> = Vec::new();

    let non_system: Vec<&LlmMessage> = messages
        .iter()
        .filter(|m| m.role != LlmRole::System)
        .collect();

    // 按轮次切分：每条 User 消息是一个轮次的起点，取最后 max_rounds 个完整轮次
    let user_indices: Vec<usize> = non_system
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == LlmRole::User)
        .map(|(i, _)| i)
        .collect();

    let start = if user_indices.len() > max_rounds {
        user_indices[user_indices.len() - max_rounds]
    } else {
        0
    };
    let recent = &non_system[start..];

    if !recent.is_empty() {
        parts.push("[近期对话]".to_string());
        for m in recent {
            match m.role {
                LlmRole::Tool => {
                    let cap = max_tool_output;
                    let id = m.tool_call_id.as_deref().unwrap_or("unknown");
                    parts.push(format!(
                        "[Tool Result] [id={id}]: {}",
                        truncate(&m.content, cap)
                    ));
                }
                LlmRole::Assistant => {
                    // Assistant 可能同时有 prose (content) 和 tool_calls。
                    // 两者都要发给审批模型：prose 是它"怎么想"，tool_calls 是它"做了啥"。
                    let cap = max_other_content;
                    if !m.content.is_empty() {
                        parts.push(format!("助手: {}", truncate(&m.content, cap)));
                    }
                    if let Some(calls) = m.tool_calls.as_ref() {
                        for tc in calls {
                            let args = tc.arguments.to_string();
                            let line = format!(
                                "[Tool Call] {}({}) [id={}]",
                                tc.name,
                                truncate(&args, cap),
                                tc.id
                            );
                            parts.push(line);
                        }
                    }
                }
                LlmRole::User => {
                    let cap = max_other_content;
                    parts.push(format!("用户: {}", truncate(&m.content, cap)));
                }
                LlmRole::System => {
                    // 已经过滤，这里不应当进入
                }
            }
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
        }
    }

    fn assistant_with_tool_calls(prose: &str, calls: Vec<(&str, &str)>) -> LlmMessage {
        LlmMessage {
            role: LlmRole::Assistant,
            content: prose.into(),
            tool_calls: Some(
                calls
                    .into_iter()
                    .enumerate()
                    .map(|(i, (name, args))| crate::llm::provider::ToolCall {
                        id: format!("call_{i}"),
                        name: name.into(),
                        arguments: serde_json::from_str(args).expect("valid test arguments"),
                    })
                    .collect(),
            ),
            tool_call_id: None,
            reasoning_content: None,
            image_paths: None,
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
        let ctx = build_context(&messages, ApprovalContextLevel::Normal);
        assert!(ctx.contains("[近期对话]"));
        assert!(ctx.contains("助手: 好的"));
        assert!(ctx.contains("[Tool Result] [id=1]: result"));
        assert!(!ctx.contains("sys"), "system prompt must not leak");
    }

    #[test]
    fn build_context_truncates_tool_output() {
        let long = "x".repeat(1000);
        let messages = vec![LlmMessage::user("任务"), tool_msg(&long)];
        let ctx = build_context(&messages, ApprovalContextLevel::Normal);
        assert!(ctx.contains("已截断"));
    }

    #[test]
    fn build_context_empty_messages() {
        let ctx = build_context(&[], ApprovalContextLevel::Normal);
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
        let ctx = build_context(&messages, ApprovalContextLevel::Normal);
        // 第 0、1 轮在近期对话中应该被裁掉（只保留最后 5 轮：2~6）
        let recent_section = ctx.split("[近期对话]").nth(1).unwrap_or("");
        assert!(!recent_section.contains("用户第1轮"));
        assert!(recent_section.contains("用户第2轮"));
        assert!(recent_section.contains("用户第6轮"));
    }

    #[test]
    fn build_context_emits_assistant_tool_calls() {
        // 关键回归：审批模型必须能看到 assistant 之前调了啥工具、参数是啥
        // （需求 2：tool 调用的 call 和返回结果都要发给审批模型）
        let messages = vec![
            LlmMessage::user("看看 /etc/passwd"),
            assistant_with_tool_calls(
                "我先读取文件",
                vec![("read_file", r#"{"path":"/etc/passwd"}"#)],
            ),
            tool_msg("root:x:0:0:root:/root:/bin/bash"),
        ];
        let ctx = build_context(&messages, ApprovalContextLevel::Normal);
        assert!(
            ctx.contains("[Tool Call] read_file("),
            "tool call name+args 缺失"
        );
        assert!(ctx.contains("/etc/passwd"), "参数 path 必须出现");
        assert!(
            ctx.contains("[id=call_0]"),
            "id 必须保留以便和后续 tool 消息关联"
        );
        assert!(
            ctx.contains("[Tool Result] [id=1]: root:x:0:0"),
            "tool 返回结果及 call ID 必须保留"
        );
        // prose 和 tool_call 都要保留
        assert!(ctx.contains("助手: 我先读取文件"));
    }

    #[test]
    fn build_user_prompt_includes_current_tool_call_and_history_results() {
        let current = crate::llm::provider::ToolCall {
            id: "current_call".into(),
            name: "execute_command".into(),
            arguments: serde_json::json!({"command": "rm /tmp/old.log"}),
        };
        let messages = vec![LlmMessage::user("清理旧日志"), tool_msg("previous result")];

        let prompt = build_user_prompt(&current, &messages, ApprovalContextLevel::Normal)
            .expect("prompt should build");

        assert!(prompt.contains(r#""id":"current_call""#));
        assert!(prompt.contains(r#""name":"execute_command""#));
        assert!(prompt.contains(r#""command":"rm /tmp/old.log""#));
        assert!(prompt.contains("[Tool Result] [id=1]: previous result"));
    }

    #[test]
    fn build_context_assistant_only_tool_calls_no_prose() {
        // 纯 tool_calls（无 prose）也要正确输出，不能丢
        let messages = vec![
            LlmMessage::user("task"),
            assistant_with_tool_calls("", vec![("execute_command", r#"{"command":"ls"}"#)]),
        ];
        let ctx = build_context(&messages, ApprovalContextLevel::Normal);
        assert!(
            ctx.contains(r#"[Tool Call] execute_command({"command":"ls"})"#),
            "tool call name+完整 args JSON 必须出现"
        );
        // 不应出现"助手: " 前缀（因为 prose 为空）
        assert!(!ctx.contains("助手: "), "空 prose 不应输出「助手: 」");
    }

    #[test]
    fn build_context_assistant_multiple_parallel_calls() {
        // 一次 assistant 返回多个 tool_calls（并行调用）都要列出
        let messages = vec![
            LlmMessage::user("task"),
            assistant_with_tool_calls(
                "",
                vec![
                    ("read_file", r#"{"path":"/a"}"#),
                    ("read_file", r#"{"path":"/b"}"#),
                ],
            ),
        ];
        let ctx = build_context(&messages, ApprovalContextLevel::Normal);
        assert!(ctx.contains("/a"));
        assert!(ctx.contains("/b"));
        assert!(ctx.contains("[id=call_0]"));
        assert!(ctx.contains("[id=call_1]"));
    }

    #[test]
    fn build_context_concise_limits_to_2_rounds() {
        // Concise 档：只保留最后 2 个 user 轮次
        let mut messages: Vec<LlmMessage> = vec![LlmMessage::system("sys")];
        for i in 0..5 {
            messages.push(LlmMessage::user(format!("用户第{i}轮")));
            messages.push(LlmMessage::assistant(format!("助手第{i}轮")));
        }
        let ctx = build_context(&messages, ApprovalContextLevel::Concise);
        let recent = ctx.split("[近期对话]").nth(1).unwrap_or("");
        assert!(!recent.contains("用户第0轮"), "0 轮应被裁掉");
        assert!(!recent.contains("用户第2轮"), "2 轮应被裁掉（只留 3、4）");
        assert!(recent.contains("用户第3轮"));
        assert!(recent.contains("用户第4轮"));
    }

    #[test]
    fn build_context_detailed_limits_to_10_rounds() {
        // Detailed 档：保留最后 10 个 user 轮次
        let mut messages: Vec<LlmMessage> = vec![LlmMessage::system("sys")];
        for i in 0..15 {
            messages.push(LlmMessage::user(format!("用户第{i}轮")));
            messages.push(LlmMessage::assistant(format!("助手第{i}轮")));
        }
        let ctx = build_context(&messages, ApprovalContextLevel::Detailed);
        let recent = ctx.split("[近期对话]").nth(1).unwrap_or("");
        assert!(!recent.contains("用户第0轮"), "0-4 轮应被裁掉");
        assert!(!recent.contains("用户第4轮"), "4 轮应被裁掉（只留 5-14）");
        assert!(recent.contains("用户第5轮"));
        assert!(recent.contains("用户第14轮"));
    }

    #[test]
    fn build_context_concise_uses_smaller_tool_cap() {
        // Concise 档工具输出 cap 是 200，Normal 是 500
        let long = "x".repeat(300);
        let messages = vec![LlmMessage::user("任务"), tool_msg(&long)];

        let concise = build_context(&messages, ApprovalContextLevel::Concise);
        let normal = build_context(&messages, ApprovalContextLevel::Normal);

        // Concise 在 200 cap 处截断；Normal 在 500 cap 处
        // 提取"工具结果: "后的有效内容长度
        fn tool_len(ctx: &str) -> usize {
            let line = ctx
                .lines()
                .find(|l| l.starts_with("[Tool Result]"))
                .unwrap_or("");
            line.split_once(": ")
                .map(|(_, value)| value.len())
                .unwrap_or(0)
        }
        let c_len = tool_len(&concise);
        let n_len = tool_len(&normal);
        assert!(c_len < n_len, "concise ({c_len}) 应短于 normal ({n_len})");
        assert!(c_len <= 200 + "…（已截断）".len());
        assert!(n_len > 200, "normal 至少要超过 concise 的 cap");
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
