//! `ask_parent` —— 子 agent 向派发它的主 agent 提问。
//!
//! # 为什么是「暂停并交回」而不是一条实时双向通道
//!
//! `subagent` / `local_subagent` 对主 agent 是**同步**调用：主 agent 在 `join` 上
//! 等着子 agent 交报告。让子 agent 此刻再去「问」主 agent，主 agent 却正被它卡住，
//! 双方互等，死锁。所以提问的实现是：
//!
//! 1. 子 agent 调 `ask_parent` → agent loop **拦截**这个调用（不执行、不落工具结果），
//!    干净地结束这一轮，回合收尾状态写 `awaiting_parent`（[`TurnState::AwaitingParent`]）；
//! 2. 外层 `subagent` / `local_subagent` 工具发现子 agent 停在提问上，提前返回给主
//!    agent：问题 + 背景 + 怎么回答（metadata `kind = "subagentAsk"`）；
//! 3. 主 agent 想好答案（可以先 `ask_user` 问用户，传 `source_subagent`），用
//!    `continue_id` 续派，写进 `prompt` 的回答被落成**这次 `ask_parent` 调用的工具
//!    结果**（metadata `kind = "parentAnswer"`），子 agent 带着原有进度接着干。
//!
//! 「有没有一个待回答的提问」只看会话库（[`ConversationDb::pending_parent_ask`]）：
//! 最后一条带工具调用的 assistant 里有 `ask_parent` 调用、它后面没有对应的工具结果、
//! 且回合锚点是 `awaiting_parent`。重启后照样成立，随时可以接上。
//!
//! 本工具只给子 agent（声明表 `ToolRoles::SubOnly`）。用法规则（什么时候该问、
//! 先自己查什么）的唯一来源是提示词片段 `templates/agent/子agent_提问.hbs`，这里的
//! 工具描述只说「它做什么」。
//!
//! [`ConversationDb::pending_parent_ask`]: crate::agent::conversation::ConversationDb::pending_parent_ask
//! [`TurnState::AwaitingParent`]: crate::agent::task::TurnState::AwaitingParent

use std::collections::HashSet;
use std::sync::Mutex;

use async_trait::async_trait;
use serde_json::json;

use crate::agent::risk::Disposition;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::error::AppError;

pub(crate) const ASK_PARENT_TOOL: &str = "ask_parent";

/// 子 agent 停在 `ask_parent` 上的那一问。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PendingParentAsk {
    /// `ask_parent` 这次调用的 id（回答要作为它的工具结果落库）。
    pub tool_call_id: String,
    pub question: String,
    pub context: Option<String>,
    /// 提问时的原始参数（回答行里原样带上，让历史里的调用与结果成对可读）。
    pub arguments: serde_json::Value,
}

/// 从 `ask_parent` 的参数里取问题与背景。问题为空 → `None`（不拦截，走工具自己的报错）。
pub(crate) fn parse_ask_arguments(args: &serde_json::Value) -> Option<(String, Option<String>)> {
    let question = args
        .get("question")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let context = args
        .get("context")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    Some((question, context))
}

// ── 「本任务停在 ask_parent 上」的一次性标记 ──
//
// agent loop 的返回值只有 `Option<String>`，装不下第三种结局；而收尾写库的
// `manager::finalize_task` 需要知道「这次不是失败，是暂停」。标记按任务 id，
// loop 写、`finalize_task` 取走即删（不会累积）。真正的事实来源仍是会话库。

static PAUSED_TASKS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub(crate) fn mark_paused(task_id: &str) {
    let mut guard = PAUSED_TASKS.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .get_or_insert_with(Default::default)
        .insert(task_id.to_string());
}

/// 取走标记；返回此前是否被标记过。
pub(crate) fn take_paused(task_id: &str) -> bool {
    let mut guard = PAUSED_TASKS.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_mut().is_some_and(|set| set.remove(task_id))
}

pub struct AskParentTool;

impl AskParentTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for AskParentTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for AskParentTool {
    fn name(&self) -> &str {
        ASK_PARENT_TOOL
    }

    fn description(&self) -> &str {
        "向派发你的主 agent 提问。调用后你会暂停，问题交给主 agent（主 agent 能看主对话，\
         也能替你去问用户）；它的回答会作为这次调用的结果回到你这里，你带着已有进度接着干。\
         同一轮只能提一个问题。"
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "question": {
                    "type": "string",
                    "description": "完整的提问，脱离上文也能读懂（主 agent 读到的只有这句和 context）"
                },
                "context": {
                    "type": "string",
                    "description": "可选。你已经查到了什么、为什么需要这个答案、手头有哪些候选答案"
                }
            },
            "required": ["question"]
        })
    }

    fn disposition(&self) -> Disposition {
        Disposition::Allow
    }

    /// 真正的提问由 agent loop 在派发工具**之前**拦截（见 `agent_loop::run_agent_loop`），
    /// 走到这里说明没被拦：问题为空，或同一轮里的第二个 `ask_parent`。两种都只是
    /// 给模型一句明确的报错，让它改正。
    async fn execute(
        &self,
        params: serde_json::Value,
        _ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        if parse_ask_arguments(&params).is_none() {
            return Ok(ToolOutput::fail(
                "ask_parent: question 不能为空",
                "请把要问主 agent 的问题写进 question（一句脱离上文也能读懂的完整提问）。",
            ));
        }
        Ok(ToolOutput::fail(
            "ask_parent: 同一轮只能提一个问题",
            "同一轮里只处理第一个 ask_parent。把你要问的合并成一个问题，等主 agent 回答后再继续。",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arguments_parse_trims_and_requires_a_question() {
        assert_eq!(
            parse_ask_arguments(&json!({"question": " 用哪个端口？ ", "context": "  "})),
            Some(("用哪个端口？".to_string(), None))
        );
        assert_eq!(
            parse_ask_arguments(&json!({"question": "q", "context": "候选 80 / 8080"})),
            Some(("q".to_string(), Some("候选 80 / 8080".to_string())))
        );
        assert_eq!(parse_ask_arguments(&json!({"question": "  "})), None);
        assert_eq!(parse_ask_arguments(&json!({})), None);
    }

    #[test]
    fn paused_mark_is_taken_exactly_once() {
        assert!(!take_paused("ask-parent-test-never-marked"));
        mark_paused("ask-parent-test-1");
        assert!(take_paused("ask-parent-test-1"));
        assert!(!take_paused("ask-parent-test-1"));
    }

    #[test]
    fn schema_only_requires_question() {
        let schema = AskParentTool::new().parameters_schema();
        assert_eq!(schema["required"], json!(["question"]));
        assert!(schema["properties"]["context"].is_object());
    }
}
