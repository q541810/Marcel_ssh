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

use async_trait::async_trait;
use serde::Serialize;
use serde_json::json;
use tauri::Manager;
use tokio::sync::watch;

use crate::agent::agent_loop::{run_agent_loop, LoopContext};
use crate::agent::sandbox::RiskLevel;
use crate::agent::task::{AgentMode, AgentStatus, AgentTask};
use crate::agent::templates::TemplateManager;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput, ToolRegistry};
use crate::commands::agent_lifecycle::build_agent_messages;
use crate::emit_event;
use crate::error::AppError;
use crate::llm::openai::OpenAiProvider;
use crate::AppState;

/// 子agent结果回传给主 agent 的最大字符数（完整过程保留在子对话中）。
const MAX_TASK_OUTPUT_CHARS: usize = 8000;

/// 追加到子agent系统提示的调研指令。
const SUBAGENT_INSTRUCTION: &str = "\
你是被主 Agent 派发的调研子agent（subagent）。你的唯一目标：只读调研并回答主 Agent 交给你的调研问题。

硬性约束：
- 你处于 Plan 模式：只能使用只读调研工具（read_file / list_directory / search_files / system_info / connection_info / execute_command / web_search / http_get / ask_user / 技能）
- 不得执行任何修改操作：不写文件、不编辑文件、不删除文件、不安装软件、不修改配置
- execute_command 仅用于信息收集（查看状态、读取输出、运行只读查询），禁止用于修改系统
- 不要调用计划工具（create_plan / update_plan_item / edit_plan 不存在于你的工具集）

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
         auditing) instead of doing it inline. Provide a complete self-contained \
         prompt with all necessary context — the subagent does NOT see your \
         conversation history. The subagent never writes or modifies anything.\n\
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

        // ── 嵌套防御：子agent不能再派发子agent ──
        let parent_task_id = ctx.task_id.clone();
        if let Some(tid) = &parent_task_id {
            if state
                .agent_tasks
                .read()
                .get(tid)
                .and_then(|t| t.parent_task_id.clone())
                .is_some()
            {
                log::warn!("task tool blocked: {} is itself a subagent", tid);
                return Ok(ToolOutput::fail(
                    "task: 子agent不能再派发子agent",
                    "当前任务本身是子agent，不允许再派发子agent。",
                ));
            }
        }

        // ── 读取子agent需要的设置 ──
        let (llm_config, agent_settings, experimental_settings, enabled_skills) = {
            let settings = state.settings.read().await;
            let skills = state.skill_store.read().await;
            (
                settings.llm_config.clone(),
                settings.agent_mode_settings.clone(),
                settings.experimental_settings.clone(),
                skills
                    .list()
                    .iter()
                    .filter(|s| s.enabled)
                    .cloned()
                    .collect::<Vec<_>>(),
            )
        };
        let Some(llm_config) = llm_config else {
            return Ok(ToolOutput::fail(
                "task: 尚未配置 LLM",
                "尚未配置 LLM，无法派发子agent。",
            ));
        };
        let mut sub_llm_config = llm_config.clone();
        if let Some(m) = model_override {
            sub_llm_config.model = m;
        }
        let provider = match OpenAiProvider::new(sub_llm_config) {
            Ok(p) => p,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    "task: 子agent模型初始化失败".to_string(),
                    format!("模型初始化失败: {}", e),
                ));
            }
        };

        // ── 创建子agent conversation（独立对话线程，parent 指向主对话）──
        let session_id = ctx.session_id.clone();
        let Some(connection_id) = state.ssh_manager.get_connection_id(&session_id).await else {
            return Ok(ToolOutput::fail(
                "task: SSH 会话不存在",
                "SSH 会话不存在，无法派发子agent。",
            ));
        };
        let sub_title = format!("{}（子agent）", description);
        // 主对话 id：供前端隐藏子对话 / 返回主对话 / 级联删除。
        let parent_conversation_id = parent_task_id
            .as_ref()
            .and_then(|tid| {
                state
                    .agent_tasks
                    .read()
                    .get(tid)
                    .map(|t| t.conversation_id.clone())
            })
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

        // ── 注册子agent（强制 Plan 模式）──
        let sub_task_id = uuid::Uuid::new_v4().to_string();
        {
            let mut tasks = state.agent_tasks.write();
            tasks.insert(
                sub_task_id.clone(),
                AgentTask {
                    id: sub_task_id.clone(),
                    session_id: session_id.clone(),
                    conversation_id: sub_conversation_id.clone(),
                    prompt: prompt.clone(),
                    mode: AgentMode::Plan,
                    status: AgentStatus::Planning,
                    has_plan: false,
                    created_at: chrono::Utc::now(),
                    parent_task_id,
                },
            );
        }

        // ── 告知前端：子agent已启动（注册子对话 + 挂载子流 listener）──
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

        // ── 构建子agent上下文（plan 模式工具集 + 只读指令）──
        let registry = ToolRegistry::build_for_plan_mode(&enabled_skills, &experimental_settings);
        // 与 agent_lifecycle::build_definitions 一致：registry 定义转 LLM provider 定义。
        let tools: Vec<crate::llm::provider::ToolDefinition> = registry
            .definitions()
            .into_iter()
            .map(|d| crate::llm::provider::ToolDefinition {
                name: d.name,
                description: d.description,
                parameters: d.parameters,
            })
            .collect();
        let sub_system_prompt = if agent_settings.system_prompt.trim().is_empty() {
            SUBAGENT_INSTRUCTION.to_string()
        } else {
            format!(
                "{}\n\n{}",
                agent_settings.system_prompt.trim(),
                SUBAGENT_INSTRUCTION
            )
        };
        let messages = match build_agent_messages(
            &TemplateManager,
            &session_id,
            &tools,
            &[],
            &prompt,
            &sub_system_prompt,
            &[],
            true,
        ) {
            Ok(m) => m,
            Err(e) => {
                state.agent_tasks.write().remove(&sub_task_id);
                return Ok(ToolOutput::fail(
                    "task: 构建子agent上下文失败",
                    format!("构建子agent上下文失败: {}", e),
                ));
            }
        };

        // ── spawn 子 agent loop 并同步等待 ──
        let (cancel_tx, cancel_rx) = watch::channel(false);
        state
            .cancel_senders
            .write()
            .insert(sub_task_id.clone(), cancel_tx);

        let loop_ctx = LoopContext {
            ssh: ctx.ssh.clone(),
            session_id: session_id.clone(),
            app: ctx.app_handle.clone(),
            state: state.clone(),
            registry: std::sync::Arc::new(registry),
            conversation_id: sub_conversation_id.clone(),
            conv_db: state.conversation_db.clone(),
            cancel_rx,
            config_dir: ctx.config_dir.clone(),
            is_subtask: true,
        };

        let sub_task_id_for_spawn = sub_task_id.clone();
        let join_handle = tokio::spawn(async move {
            run_agent_loop(
                sub_task_id_for_spawn,
                provider,
                messages,
                tools,
                AgentMode::Plan,
                agent_settings,
                loop_ctx,
            )
            .await
        });
        let result = join_handle.await;
        state.cancel_senders.write().remove(&sub_task_id);

        // ── 汇总结果 ──
        let status = state
            .agent_tasks
            .read()
            .get(&sub_task_id)
            .map(|t| t.status.clone())
            .unwrap_or(AgentStatus::Failed);

        // 更新子任务终态（后端 agent_tasks；此前停留 Planning，busy 守卫
        // （手动压缩等）会对子对话误报"会话正在运行任务"）。停止路径已置
        // Cancelled 则保留；Ok(Some)=Completed，其余=Failed。
        {
            let completed = matches!(&result, Ok(Some(_)));
            if let Some(t) = state.agent_tasks.write().get_mut(&sub_task_id) {
                if t.status != AgentStatus::Cancelled {
                    t.status = if completed {
                        AgentStatus::Completed
                    } else {
                        AgentStatus::Failed
                    };
                }
            }
        }

        match result {
            Ok(Some(text)) => {
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
            Ok(None) => {
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
            Err(e) => {
                log::error!("Subtask {} panicked: {}", sub_task_id, e);
                Ok(ToolOutput::fail(
                    format!("子agent异常：{}", description),
                    format!("子agent运行异常: {}", e),
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
