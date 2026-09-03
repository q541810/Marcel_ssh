//! `task` 工具 — 派发一个强制 Plan 模式的调研子 agent。
//!
//! 主 agent（Agent/Auto 模式）调用此工具时，后端会：
//! 1. 创建一个新的子agent（`AgentMode::Plan` + plan 模式只读工具集）
//! 2. 为子agent创建独立的 conversation（标题为任务描述），子agent的完整过程
//!    实时流式输出到子对话，用户可随时点开查看
//! 3. 同步等待子agent结束（串行模型：同一时刻只跑一个子agent）
//! 4. 把子agent最终的调研文本作为工具结果返回给主 agent
//!
//! 子agent不可再派发子agent（嵌套防御：plan 模式工具集本身不注册 task 工具，
//! 这里再做一次 parent_task_id 检查兜底）。
//!
//! 子 agent 的组装与生命周期统一由 [`crate::agent::manager::AgentManager`]
//! 负责——本工具只声明「要跑什么」（AgentSpec），不再复制组装逻辑。

use async_trait::async_trait;
use serde::Serialize;
use serde_json::json;
use tauri::Manager;

use crate::agent::manager::{AgentManager, AgentRole, AgentSpec};
use crate::agent::sandbox::RiskLevel;
use crate::agent::task::{AgentMode, AgentStatus};
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::emit_event;
use crate::error::AppError;
use crate::AppState;

/// 子agent结果回传给主 agent 的最大字符数（完整过程保留在子对话中）。
const MAX_TASK_OUTPUT_CHARS: usize = 8000;

/// 追加到子agent系统提示的调研指令。
const SUBAGENT_INSTRUCTION: &str = "\
你是被主 Agent 派发的调研子agent（subagent）。你的唯一目标：只读调研并回答主 Agent 交给你的调研问题。

硬性约束：
- 你处于 Plan 模式：只能使用只读调研工具（read_file / list_directory / search_files / system_info / connection_info / bash / web_search / http_get / ask_user / 技能）
- 不得执行任何修改操作：不写文件、不编辑文件、不删除文件、不安装软件、不修改配置
- bash 仅用于信息收集（查看状态、读取输出、运行只读查询），禁止用于修改系统
- 不要调用计划工具（create_plan / update_plan_item / edit_plan 不存在于你的工具集）
- 若用 bash(run_in_background: true) 派发了后台作业：**不要**输出结束语后带着未完成作业离开——系统会在作业结算后自动把「作业已完成」通知发回给你，届时用 job_output(job_id=..., wait=true) 读取其输出并纳入结论；作业若不再需要，用 job_kill 终止。收到结算通知前不需要反复轮询，可继续其他调研。

完成调研后，用简洁清晰的中文输出调研结论：发现的事实（附证据）、关键结论、对主 Agent 行动的建议。不要复述调研过程细节。";

/// 子agent启动事件：发到**主任务**的 stream 通道，前端据此注册子对话
/// 并挂载子agent的流式 listener（运行中过程实时可见）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SubTaskStartEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub tool_call_id: String,
    pub sub_task_id: String,
    pub sub_conversation_id: String,
    pub description: String,
    pub prompt: String,
    /// 主对话 id：前端注册子对话时记录，用于会话列表隐藏、
    /// 子对话内"返回主对话"、删除主对话级联删除。
    pub parent_conversation_id: String,
}

pub struct TaskTool;

impl TaskTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for TaskTool {
    fn default() -> Self {
        Self::new()
    }
}

fn truncate_chars(s: &str, max: usize) -> String {
    let mut out: String = s.chars().take(max).collect();
    if s.chars().count() > max {
        out.push('…');
    }
    out
}

#[async_trait]
impl AgentTool for TaskTool {
    fn name(&self) -> &str {
        "task"
    }

    fn description(&self) -> &str {
        "Delegate a focused research task to a subagent. The subagent runs in \
         Plan mode (read-only research tools only), explores independently in its \
         own conversation, and returns a research report. Use this to offload \
         parallel-able research (codebase exploration, log analysis, config \
         auditing) instead of doing it inline. You can invoke multiple task tools \
         concurrently in one turn to explore different areas in parallel. Provide a \
         complete self-contained prompt with all necessary context — the subagent \
         does NOT see your conversation history. The subagent never writes or modifies anything.\n\
         \n\
         When NOT to use the task tool:\n\
         - Reading a single file or doing a small-scope search → use read_file / \
         search_files / list_directory directly, do not dispatch a subagent\n\
         - A decision that needs user confirmation → ask_user directly\n\
         - Anything that requires modification → the subagent is read-only; you \
         must perform the change yourself\n\
         - A short verification question → answer directly or run one command\n\
         \n\
         The subagent's full process lives in its own conversation (viewable from \
         the task card); you receive only its research report — integrate the \
         conclusions into your reply, do not echo the process."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The research task for the subagent. Must be self-contained: include the target paths, questions to answer, and expected output format. The subagent has no access to your conversation history."
                },
                "description": {
                    "type": "string",
                    "description": "A short (3-5 words) description of the subagent, used as the subagent's conversation title shown in the chat list (e.g. 'explore nginx config', 'audit disk usage')."
                },
                "model": {
                    "type": "string",
                    "description": "Optional model override for the subagent. When omitted, the main agent's model is used."
                }
            },
            "required": ["prompt"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        RiskLevel::ReadOnly
    }

    fn is_concurrent_safe(&self) -> bool {
        true
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let prompt = params
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if prompt.is_empty() {
            return Ok(ToolOutput::fail("task: prompt 不能为空", ""));
        }
        let description = params
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| truncate_chars(&prompt, 50));
        let model_override = params
            .get("model")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from);

        let state = ctx.app_handle.state::<AppState>();
        let state: AppState = state.inner().clone();

        // ── 子 agent 模型继承：LLM 未显式指定 model 参数时，继承父任务的模型 ──
        // 保证「父任务用 A 模型 → 派发的子 agent 默认也用 A」（会话级模型切换的
        // 直觉语义）。父任务 model_id 为 None（极端情况）时回落全局默认。
        let model_override = match model_override {
            Some(m) => Some(m),
            None => {
                if let Some(pid) = ctx.task_id.clone() {
                    state
                        .agent_tasks
                        .read()
                        .get(&pid)
                        .and_then(|t| t.model_id.clone())
                } else {
                    None
                }
            }
        };

        // ── 嵌套防御：子agent不能再派发子agent ──
        // parent_task_id = 当前任务 id（也是新子 agent 的父任务 id）。
        // 当前任务本身有 parent_task_id（即它已是子 agent）则禁止。
        let parent_task_id = ctx.task_id.clone().unwrap_or_default();
        if !parent_task_id.is_empty()
            && state
                .agent_tasks
                .read()
                .get(&parent_task_id)
                .and_then(|t| t.parent_task_id.clone())
                .is_some()
        {
            log::warn!("task tool blocked: {} is itself a subagent", parent_task_id);
            return Ok(ToolOutput::fail(
                "task: 子agent不能再派发子agent",
                "当前任务本身是子agent，不允许再派发子agent。",
            ));
        }

        // ── 创建子agent conversation（独立对话线程，parent 指向主对话）──
        let session_id = ctx.session_id.clone();
        let Some(connection_id) = state.ssh_manager.get_connection_id(&session_id).await else {
            return Ok(ToolOutput::fail(
                "task: SSH 会话不存在",
                "SSH 会话不存在，无法派发子agent。",
            ));
        };
        let sub_title = format!("{}（子agent）", description);
        let parent_conversation_id = state
            .agent_tasks
            .read()
            .get(&parent_task_id)
            .map(|t| t.conversation_id.clone())
            .unwrap_or_default();
        let sub_conv = match state.conversation_db.create_sub_conversation(
            &connection_id,
            &sub_title,
            &parent_conversation_id,
        ) {
            Ok(c) => c,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    "task: 创建子agent会话失败",
                    format!("创建子agent会话失败: {}", e),
                ));
            }
        };
        let sub_conversation_id = sub_conv.id;

        // ── 生成子任务 id 并告知前端（先注册子对话 + 挂载子流 listener）──
        let sub_task_id = uuid::Uuid::new_v4().to_string();
        if let Some(event_name) = ctx.event_name.clone() {
            emit_event(
                &ctx.app_handle,
                &event_name,
                SubTaskStartEvent {
                    event_type: "subTaskStart".to_string(),
                    tool_call_id: ctx
                        .tool_call_id
                        .clone()
                        .unwrap_or_else(|| "unknown".to_string()),
                    sub_task_id: sub_task_id.clone(),
                    sub_conversation_id: sub_conversation_id.clone(),
                    description: description.clone(),
                    prompt: prompt.clone(),
                    parent_conversation_id,
                },
            );
        }

        // ── 组装 + spawn（子代理 = Plan 模式 + 只读约束段）──
        let spec = AgentSpec {
            task_id: sub_task_id.clone(),
            mode: AgentMode::Plan,
            role: AgentRole::Sub { parent_task_id },
            session_id,
            conversation_id: sub_conversation_id.clone(),
            prompt,
            history: Vec::new(),
            model_override,
            prompt_extra: vec![SUBAGENT_INSTRUCTION.to_string()],
        };
        let manager = AgentManager::new(state.clone());
        let handle = match manager.spawn(&ctx.app_handle, spec).await {
            Ok(h) => h,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    "task: 子agent启动失败",
                    format!("子agent启动失败: {}", e),
                ));
            }
        };
        let result = handle.join().await;

        // ── 汇总结果 ──
        let status = state
            .agent_tasks
            .read()
            .get(&sub_task_id)
            .map(|t| t.status.clone())
            .unwrap_or(AgentStatus::Failed);

        match result {
            Some(text) => {
                let output = truncate_chars(&text, MAX_TASK_OUTPUT_CHARS);
                log::info!(
                    "Subtask {} completed: {} chars returned to parent",
                    sub_task_id,
                    text.chars().count()
                );
                Ok(
                    ToolOutput::ok(format!("子agent完成：{}", description), output).with_metadata(
                        json!({
                            "subTaskId": sub_task_id,
                            "subConversationId": sub_conversation_id,
                            "status": "completed",
                        }),
                    ),
                )
            }
            None => {
                if status == AgentStatus::Cancelled {
                    log::info!("Subtask {} cancelled", sub_task_id);
                    Ok(ToolOutput::fail(
                        format!("子agent已取消：{}", description),
                        "子agent已被取消，未返回调研结果。",
                    )
                    .with_metadata(json!({
                        "subTaskId": sub_task_id,
                        "subConversationId": sub_conversation_id,
                        "status": "cancelled",
                    })))
                } else {
                    log::warn!("Subtask {} failed (no result)", sub_task_id);
                    Ok(ToolOutput::fail(
                        format!("子agent失败：{}", description),
                        "子agent执行失败（LLM 错误或达到最大轮数），未返回调研结果。",
                    )
                    .with_metadata(json!({
                        "subTaskId": sub_task_id,
                        "subConversationId": sub_conversation_id,
                        "status": "failed",
                    })))
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_chars_short_string_unchanged() {
        assert_eq!(truncate_chars("hello", 100), "hello");
    }

    #[test]
    fn truncate_chars_long_string_cut_with_ellipsis() {
        let s = "a".repeat(120);
        let out = truncate_chars(&s, 50);
        assert_eq!(out.chars().count(), 51); // 50 + …
        assert!(out.ends_with('…'));
    }

    #[test]
    fn truncate_chars_exact_boundary_no_ellipsis() {
        let s = "abcde";
        assert_eq!(truncate_chars(s, 5), "abcde");
    }

    #[test]
    fn truncate_chars_multibyte_safe() {
        let s = "中文中文中文中文";
        let out = truncate_chars(s, 3);
        assert_eq!(out, "中文中…");
    }

    #[test]
    fn sub_task_start_event_serializes_camel_case() {
        let ev = SubTaskStartEvent {
            event_type: "subTaskStart".into(),
            tool_call_id: "call-1".into(),
            sub_task_id: "task-2".into(),
            sub_conversation_id: "conv-2".into(),
            description: "explore nginx".into(),
            prompt: "look at /etc/nginx".into(),
            parent_conversation_id: "conv-1".into(),
        };
        let json = serde_json::to_value(ev).unwrap();
        assert_eq!(json["type"], "subTaskStart");
        assert_eq!(json["toolCallId"], "call-1");
        assert_eq!(json["subTaskId"], "task-2");
        assert_eq!(json["subConversationId"], "conv-2");
        assert_eq!(json["parentConversationId"], "conv-1");
    }
}
