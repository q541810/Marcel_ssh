//! `suggest_next` —— 任务做完后，在结论下面放一张「小建议」卡片，让用户一键回复。
//!
//! 和 `ask_user` 的本质区别：**不阻塞**。`ask_user` 停下 agent、等用户答完才继续；
//! 这个工具只是把问题和几个选项记进对话，工具立刻返回，agent 本轮就此结束。
//! 「就此结束」由 agent loop 兑现（[`ends_turn`]）：一轮里只调了合规的卡片，执行完
//! 就走收尾，**不再请求模型**——再请求一次，模型几乎每次都会补一句「本轮已结束」
//! 之类的废话挂在卡片下面，还白花一轮（评测里 16 次卡片 16 次都这样）。用户
//! 点某个选项，前端把它当作一条普通的用户消息发出（消息里带着「这是对哪次调用的
//! 回信」），agent 在下一轮收到。卡片由前端按对话内容渲染，后端不维护任何待答状态。
//!
//! 选项可以带 `mode`（plan / agent / auto）：用户点它的同时前端先把运行模式切过去再发
//! 回信（切换与发送的编排在前端 `SuggestionCard`，模式的唯一入口仍是 `taskStore.setMode`）。
//! agent 只是「提议」，自己切不了模式——这个工具在 Plan 与 Agent/Auto 下都提供，所以
//! Plan 规划完能让用户一键「按计划执行」。
//!
//! 用法规则（什么时候放卡片、问题与选项怎么写）的唯一来源是提示词片段
//! `templates/agent/沟通.hbs`，这里的工具描述只说它做什么。

use async_trait::async_trait;
use serde_json::json;

use crate::agent::risk::Disposition;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

pub(crate) const SUGGEST_NEXT_TOOL: &str = "suggest_next";

const MIN_OPTIONS: usize = 2;
const MAX_OPTIONS: usize = 4;

#[derive(Default)]
pub struct SuggestNextTool;

impl SuggestNextTool {
    pub fn new() -> Self {
        Self
    }
}

/// 选项点下去可以顺带切换到的运行模式（与前端 `AgentMode` 同名）。
const SWITCH_MODES: [&str; 3] = ["plan", "agent", "auto"];

/// 一个选项：用户点了会原样发给 agent 的话，和（可选的）点了之后切换到的模式。
#[derive(Debug, Clone, PartialEq, Eq)]
struct SuggestOption {
    text: String,
    mode: Option<String>,
}

/// 取一个选项。字符串 = 只有文字（旧格式照常通过）；对象 = `{text, mode?}`。
/// 空文字的选项直接丢掉；`mode` 不是三档之一时返回给模型的中文说明。
fn parse_option(item: &serde_json::Value) -> Result<Option<SuggestOption>, String> {
    let (text, mode) = match item {
        serde_json::Value::String(s) => (s.as_str(), None),
        serde_json::Value::Object(map) => (
            map.get("text").and_then(|v| v.as_str()).unwrap_or(""),
            map.get("mode").and_then(|v| v.as_str()).map(str::trim),
        ),
        _ => return Ok(None),
    };
    let text = text.trim();
    if text.is_empty() {
        return Ok(None);
    }
    let mode = match mode {
        None | Some("") => None,
        Some(m) if SWITCH_MODES.contains(&m) => Some(m.to_string()),
        Some(m) => {
            return Err(format!(
                "选项「{text}」的 mode「{m}」不认识，只能是 plan / agent / auto，或者不写"
            ))
        }
    };
    Ok(Some(SuggestOption {
        text: text.to_string(),
        mode,
    }))
}

/// 取出问题与选项（去空白、去空选项）；不合规返回给模型的中文说明。
fn parse_suggestion(params: &serde_json::Value) -> Result<(String, Vec<SuggestOption>), String> {
    let question = params
        .get("question")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "question 不能为空".to_string())?
        .to_string();
    let mut options = Vec::new();
    for item in params
        .get("options")
        .and_then(|v| v.as_array())
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if let Some(option) = parse_option(item)? {
            options.push(option);
        }
    }
    if !(MIN_OPTIONS..=MAX_OPTIONS).contains(&options.len()) {
        return Err(format!(
            "options 需要 {MIN_OPTIONS} 到 {MAX_OPTIONS} 个非空选项，现在有 {} 个",
            options.len()
        ));
    }
    Ok((question, options))
}

fn mode_label(mode: &str) -> &'static str {
    match mode {
        "plan" => "Plan",
        "agent" => "Agent",
        _ => "Auto",
    }
}

/// 这一轮的工具调用是不是「只放了一张（或几张）合规的建议卡片」：是的话 agent loop
/// 执行完就收尾，不再请求模型。参数不合规的卡片会执行失败，模型得看到报错改正，
/// 所以不算；和别的工具混在一起时，别的工具的结果模型还没看过，也不算。
pub(crate) fn ends_turn(calls: &[crate::llm::provider::ToolCall]) -> bool {
    !calls.is_empty()
        && calls
            .iter()
            .all(|call| call.name == SUGGEST_NEXT_TOOL && parse_suggestion(&call.arguments).is_ok())
}

#[async_trait]
impl AgentTool for SuggestNextTool {
    fn name(&self) -> &str {
        SUGGEST_NEXT_TOOL
    }

    fn description(&self) -> &str {
        "结论写完后，如果有一个明确的、用户很可能想要的下一步，就在结论下面放一张小建议卡片：一句话问题加 2 到 4 个选项，用户点一下就等于回复你。选项可以带 mode，用户点它的同时把运行模式切到 plan / agent / auto（你自己切不了模式，只能提议）。不会等待用户，调用后本轮结束；用户点选后会以新消息回复你。纯问答、事情已经全部做完时不用放。"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "一句话问题，如「需要我把这次的修改推送到生产环境吗？」。结论里已经说清楚的事不用在这里重复"
                },
                "options": {
                    "type": "array",
                    "description": "2 到 4 个简短选项，每个的 text 都是用户点了就会原样发给你的话，如「好的，帮我推送到生产环境」。只放要做某件事的选项，不要放「不需要」「我再改改」这类拒绝选项（点了只会白发一条消息）",
                    "items": {
                        "type": "object",
                        "properties": {
                            "text": {
                                "type": "string",
                                "description": "用户点了会原样发给你的话"
                            },
                            "mode": {
                                "type": "string",
                                "enum": SWITCH_MODES,
                                "description": "可选。用户点这个选项的同时把运行模式切到它，选项右边会显示「→ Agent」之类的提示。只在这个选项的后续动作需要另一个模式时才写（比如 Plan 里规划完，「按计划执行」写 agent）；不写就保持当前模式"
                            }
                        },
                        "required": ["text"]
                    }
                }
            },
            "required": ["question", "options"]
        })
    }

    fn disposition(&self) -> Disposition {
        Disposition::Allow
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        match parse_suggestion(&params) {
            Ok((question, options)) => Ok(ToolOutput::ok(
                "已展示建议卡片",
                format!(
                    "建议卡片「{question}」已显示在你的结论下面（选项：{}）。本轮已结束；用户点选后，会以一条新消息回复你。",
                    options
                        .iter()
                        .map(|o| match &o.mode {
                            Some(m) => format!("{}（点选后切到 {} 模式）", o.text, mode_label(m)),
                            None => o.text.clone(),
                        })
                        .collect::<Vec<_>>()
                        .join(" / ")
                ),
            )),
            Err(detail) => Ok(ToolOutput::fail("suggest_next: 参数不合规", detail)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_two_to_four_trimmed_options() {
        let (q, o) = parse_suggestion(&json!({
            "question": " 要推送吗？ ",
            "options": [" 好的 ", "不需要"]
        }))
        .unwrap();
        assert_eq!(q, "要推送吗？");
        assert_eq!(
            o.iter().map(|x| x.text.as_str()).collect::<Vec<_>>(),
            ["好的", "不需要"]
        );
        assert!(o.iter().all(|x| x.mode.is_none()));
    }

    #[test]
    fn options_may_carry_a_mode_to_switch_to() {
        let (_, o) = parse_suggestion(&json!({
            "question": "按计划执行吗？",
            "options": [
                {"text": "执行", "mode": "agent"},
                {"text": "全自动执行", "mode": " auto "},
                {"text": "再改改计划", "mode": ""},
                "不用了"
            ]
        }))
        .unwrap();
        let modes: Vec<_> = o.iter().map(|x| x.mode.as_deref()).collect();
        assert_eq!(modes, [Some("agent"), Some("auto"), None, None]);
        // 旧格式（纯字符串）与新格式可以混用，文字原样保留
        assert_eq!(o[3].text, "不用了");
    }

    #[test]
    fn unknown_mode_is_rejected_with_a_hint_for_the_model() {
        let err = parse_suggestion(&json!({
            "question": "q",
            "options": [{"text": "a", "mode": "yolo"}, "b"]
        }))
        .unwrap_err();
        assert!(
            err.contains("yolo") && err.contains("plan / agent / auto"),
            "{err}"
        );
        // 空文字的对象选项同样被丢掉，不让它占名额
        assert!(parse_suggestion(&json!({
            "question": "q",
            "options": [{"mode": "agent"}, "b"]
        }))
        .is_err());
    }

    #[test]
    fn execute_tells_the_model_which_options_switch_mode() {
        // 回给模型的话里要标出切模式的选项，它才知道用户点了之后自己处在哪个模式
        let (_, options) = parse_suggestion(&json!({
            "question": "q",
            "options": [{"text": "执行", "mode": "agent"}, "不用"]
        }))
        .unwrap();
        assert_eq!(options[0].mode.as_deref().map(mode_label), Some("Agent"));
    }

    #[test]
    fn rejects_blank_question_and_wrong_option_count() {
        assert!(parse_suggestion(&json!({"question": " ", "options": ["a", "b"]})).is_err());
        assert!(parse_suggestion(&json!({"question": "q", "options": ["a"]})).is_err());
        assert!(parse_suggestion(&json!({"question": "q", "options": ["a", " ", "b"]})).is_ok());
        assert!(
            parse_suggestion(&json!({"question": "q", "options": ["a", "b", "c", "d", "e"]}))
                .is_err()
        );
        assert!(parse_suggestion(&json!({"question": "q"})).is_err());
    }

    #[test]
    fn only_valid_card_only_rounds_end_the_turn() {
        use crate::llm::provider::ToolCall;
        let call = |name: &str, arguments: serde_json::Value| ToolCall {
            id: format!("id-{name}"),
            name: name.into(),
            arguments,
        };
        let card = || {
            call(
                SUGGEST_NEXT_TOOL,
                json!({"question": "要推送吗？", "options": ["好", "不要"]}),
            )
        };
        assert!(ends_turn(&[card()]));
        assert!(!ends_turn(&[]));
        // 参数不合规：执行会失败，模型得看到报错改正
        assert!(!ends_turn(&[call(
            SUGGEST_NEXT_TOOL,
            json!({"question": "q", "options": ["a"]})
        )]));
        // 和别的工具混在一起：别的工具的结果模型还没看过
        assert!(!ends_turn(&[
            card(),
            call("bash", json!({"command": "ls"}))
        ]));
    }

    #[test]
    fn schema_requires_question_and_options() {
        let schema = SuggestNextTool::new().parameters_schema();
        assert_eq!(schema["required"], json!(["question", "options"]));
    }
}
