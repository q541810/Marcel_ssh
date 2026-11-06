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

/// 取出问题与选项（去空白、去空选项）；不合规返回给模型的中文说明。
fn parse_suggestion(params: &serde_json::Value) -> Result<(String, Vec<String>), String> {
    let question = params
        .get("question")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "question 不能为空".to_string())?
        .to_string();
    let options: Vec<String> = params
        .get("options")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    if !(MIN_OPTIONS..=MAX_OPTIONS).contains(&options.len()) {
        return Err(format!(
            "options 需要 {MIN_OPTIONS} 到 {MAX_OPTIONS} 个非空选项，现在有 {} 个",
            options.len()
        ));
    }
    Ok((question, options))
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
        "任务做完后，在你的结论下面放一张小建议卡片：一句话问题加 2 到 4 个选项，用户点一下就等于回复你。不会等待用户，调用后本轮结束；用户点选后会以新消息回复你。"
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
                    "description": "2 到 4 个简短选项，每个都是用户点了就会原样发给你的话，如「好的，帮我推送到生产环境」「不需要」",
                    "items": { "type": "string" }
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
                    options.join(" / ")
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
        assert_eq!(o, ["好的", "不需要"]);
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
