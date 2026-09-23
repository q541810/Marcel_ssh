//! `subagent` 工具 — 派发一个隔离的调研/执行子 agent。
//!
//! 主 agent（Agent/Auto 模式）调用此工具时，后端会：
//! 1. 创建一个新的子agent（`AgentMode::Plan` + plan 模式只读工具集）
//! 2. 为子agent创建独立的 conversation（标题为任务描述），子agent的完整过程
//!    实时流式输出到子对话，用户可随时点开查看
//! 3. 同步等待子agent结束（串行模型：同一时刻只跑一个子agent）
//! 4. 把子agent最终的报告文本作为工具结果返回给主 agent
//!
//! 子agent不可再派发子agent：**任何模式**的子 agent 工具集都不注册 subagent
//! （Plan 只读子 agent 见 build_plan_registry；mode="agent" 读写子 agent 见
//! AgentManager::build_registry 的 role 收敛），这里再做一次 parent_task_id
//! 检查作纵深防御。
//!
//! Plan 父任务不能派发 mode="agent" 读写子 agent（避免只读主任务经子 agent
//! 间接获得写权限）；执行时在 execute 内按父任务 mode 硬拦。
//!
//! 子 agent 的组装与生命周期统一由 [`crate::agent::manager::AgentManager`]
//! 负责——本工具只声明「要跑什么」（AgentSpec），不再复制组装逻辑。

use async_trait::async_trait;
use serde::Serialize;
use serde_json::json;
use tauri::Manager;

use crate::agent::manager::{AgentManager, AgentRole, AgentSpec};
use crate::agent::risk::Disposition;
use crate::agent::task::{AgentMode, AgentStatus};
use crate::agent::templates::TemplateManager;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::emit_event;
use crate::error::AppError;
use crate::AppState;

/// 子agent结果回传给主 agent 的最大字符数（完整过程保留在子对话中）。
const MAX_TASK_OUTPUT_CHARS: usize = 8000;

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
    /// 子 agent 实际运行机器的 SavedConnection id（多机操控时可能 ≠ 父任务
    /// 所在机器）。前端以其注册子对话归属，避免 DB/store 归属漂移。
    pub connection_id: String,
    /// 子 agent 实际运行所在的 SSH session id（多机时 ≠ 父任务 session）。
    /// 前端子任务记录据此做占用检测/跨 Tab 跳转。
    pub session_id: String,
    /// 子 agent 运行模式的展示提示："plan"（只读调研）| "agent"（读写执行）。
    #[serde(default = "default_sub_mode")]
    pub mode: String,
}

fn default_sub_mode() -> String {
    "plan".to_string()
}

pub struct SubagentTool;

impl SubagentTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SubagentTool {
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

/// Plan 父任务禁止派发 mode="agent" 读写子 agent（纯函数便于单测）。
fn is_plan_parent_write_subagent_blocked(
    mode: &str,
    mh_enabled: bool,
    parent_mode: Option<AgentMode>,
) -> bool {
    mode == "agent" && mh_enabled && parent_mode == Some(AgentMode::Plan)
}

/// 子 agent 的产出该如何回给父 agent。
#[derive(Debug, Clone, PartialEq)]
enum SubagentOutcome {
    /// 有实际结论文本 → 成功结果。
    Report(String),
    /// 跑完了但一个字的结论都没有（空 / 纯空白）：不是「调研结论」，
    /// 绝不能当成功回给父 agent。
    Empty,
    /// 被取消（用户停止 / 父任务级联停止）。
    Cancelled,
    /// 失败（LLM 错误 / 达到最大轮数 / panic）。
    Failed,
}

/// 把「agent loop 的返回值 + 子任务终态」归成一种结果。
///
/// 空串必须单独归一类：子 agent 哑火（正文为空、或整段都在思维标签里被
/// `strip_thinking_tags` 清空）时 loop 曾把空串当最终报告返回，父 agent 收到
/// 「子agent完成：…」却什么结论都没有——比明确报失败更糟（父 agent 会拿它去
/// 编结论）。终态里的 `status` 只用来区分「取消」与「失败」（取消是用户动作，
/// 不是失败）。
fn classify_subagent_result(result: Option<String>, status: &AgentStatus) -> SubagentOutcome {
    match result {
        Some(text) if !text.trim().is_empty() => SubagentOutcome::Report(text),
        Some(_) => SubagentOutcome::Empty,
        None if status.is_cancelled() => SubagentOutcome::Cancelled,
        None => SubagentOutcome::Failed,
    }
}

#[async_trait]
impl AgentTool for SubagentTool {
    fn name(&self) -> &str {
        "subagent"
    }

    fn description(&self) -> &str {
        "Spawn an isolated subagent to do a self-contained piece of work for you — \
         research, investigation, auditing, or (in execution mode) an actual job on \
         another machine. The subagent runs in its OWN conversation with its own \
         context window, does the work end-to-end there, and returns only its final \
         report to you — its intermediate steps never consume your context, so the \
         main conversation stays short and the session lasts far longer.\n\
         \n\
         WHY delegate instead of doing it inline? Independent, bulky work would \
         otherwise flood your own context with raw tool output and leave less room \
         for the user's actual goal. A subagent keeps that noise out of your window \
         and hands you a distilled conclusion.\n\
         \n\
         Especially use `subagent` for any web research that would need `web_search`: \
         web_search returns raw, noisy results that are costly to read; a subagent can \
         run searches in its own conversation, filter, cross-check and summarize, and \
         only hand back the useful conclusion. The same applies to multi-step \
         investigations across many files/directories (codebase exploration, log \
         analysis, config audit, system state forensics) and to parallel exploration \
         of several independent angles at once.\n\
         \n\
         HOW to delegate: give a COMPLETE, self-contained prompt (targets, questions \
         to answer, expected output format) — the subagent does NOT see the history \
         that comes AFTER dispatch; it CAN read your conversation up to the dispatch \
         moment via `read_history(scope=parent)`, but that is not a substitute for a \
         self-contained prompt. You can invoke several `subagent` tools concurrently in \
         one turn to explore different areas in parallel; each runs in its own \
         conversation. You receive only the report — integrate the conclusions into \
         your reply, do not echo the process. The subagent's full process stays \
         viewable in its own conversation (open it from the subagent card).\n\
         \n\
         When NOT to use `subagent`:\n\
         - Reading a single file or doing a small-scope search → use read_file / \
         search_files / list_directory directly, do not spawn a subagent\n\
         - A decision that needs user confirmation → ask_user directly\n\
         - A short verification question → answer directly or run one command\n\
         \n\
         Multi-host / execution mode:\n\
         - `host`: run the subagent on a specific machine: the current machine or \
         one from the selected set (by its readable name). When omitted, the \
         subagent runs on the current session's machine.\n\
         - `mode`: \"plan\" (default) = read-only research subagent as described \
         above; \"agent\" = a read-write execution subagent that can actually \
         modify files / run installs / deploy on its machine (still risk-assessed and \
         subject to the parent task's approval semantics). mode=\"agent\" is only \
         allowed when the CURRENT parent task is in Agent/Auto mode — Plan-mode \
         parents can only spawn read-only research subagents (use \"plan\")."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The COMPLETE, self-contained task for the subagent: what to do, target paths / queries, questions to answer, expected output format. The subagent has NO access to your conversation history, so everything it needs must be in this prompt."
                },
                "description": {
                    "type": "string",
                    "description": "A short (3-5 words) description of the subagent, used as the subagent's conversation title shown in the chat list (e.g. 'explore nginx config', 'audit disk usage')."
                },
                "host": {
                    "type": "string",
                    "description": format!("Optional (multi-host). Target machine's readable name: the current machine or one from the multi-host selected set. When omitted, the subagent runs on the current session's machine. {}", super::HOST_MATCH_RULE)
                },
                "mode": {
                    "type": "string",
                    "enum": ["plan", "agent"],
                    "description": "Optional (multi-host). 'plan' (default) = read-only research subagent; 'agent' = read-write execution subagent that can modify files / run installs / deploy — only when the current parent task is Agent/Auto mode (Plan-mode parents are rejected). When omitted, defaults to 'plan' (unchanged legacy behavior)."
                }
            },
            "required": ["prompt"]
        })
    }

    fn disposition(&self) -> Disposition {
        Disposition::Allow
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
            return Ok(ToolOutput::fail("subagent: prompt 不能为空", ""));
        }
        let description = params
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(String::from)
            .unwrap_or_else(|| truncate_chars(&prompt, 50));

        let state = ctx.app_handle.state::<AppState>();
        let state: AppState = state.inner().clone();

        // ── 子 agent 模型继承：恒继承父任务模型 ──
        // 保证「父任务用 A 模型 → 派发的子 agent 也用 A」。父任务 model_id
        // 为 None（极端情况）时回落全局默认（spawn 内 resolve_override 处理）。
        // 不再向 LLM 暴露 model 参数：子 agent 模型不可由模型自行指定。
        let model_override = if let Some(pid) = ctx.task_id.clone() {
            state
                .agent_tasks
                .read()
                .get(&pid)
                .and_then(|t| t.model_id.clone())
        } else {
            None
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
            log::warn!("subagent tool blocked: {} is itself a subagent", parent_task_id);
            return Ok(ToolOutput::fail(
                "subagent: 子agent不能再派发子agent",
                "当前任务本身是子agent，不允许再派发子agent。",
            ));
        }

        // ── 多机操控：host 参数 → 目标机器会话；mode → 读写/只读 ──
        // host 存在但不在「勾选集合 ∪ 当前机」/无凭证 → 明确错误（绝不落回
        // 当前会话假装在目标机）。mode="agent"（读写）双端可用（多机操控
        // 双端恒开启），且仅 Agent/Auto 父任务可派——Plan 父任务自身只读，
        // 不得经子 agent 间接获得写权限。未来若按设置收紧，此处统一降级只读。
        let mut exec_session_id = ctx.session_id.clone();
        let mut target_host_label: Option<String> = None;
        let mode = params
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("plan");

        // 多机操控双端恒开启：mode="agent" 接受（读写子 agent）；未知值
        // 一律只读（历史行为）。
        let mh_enabled = crate::multi_host::multi_host_enabled(&state).await;
        let parent_mode = if parent_task_id.is_empty() {
            None
        } else {
            state
                .agent_tasks
                .read()
                .get(&parent_task_id)
                .map(|t| t.mode.clone())
        };
        if is_plan_parent_write_subagent_blocked(mode, mh_enabled, parent_mode.clone()) {
            log::warn!(
                "subagent mode=agent blocked: parent {} is Plan mode",
                parent_task_id
            );
            return Ok(ToolOutput::fail(
                "subagent: Plan 模式不能派发读写子agent",
                "当前处于 Plan 模式，不能使用 mode=\"agent\" 派发可修改系统的子agent。请只使用默认只读调研，或请用户切换到 AGENT/AUTO 后再派发。",
            ));
        }
        let exec_mode = match mode {
            "agent" if mh_enabled => AgentMode::Agent,
            _ => AgentMode::Plan,
        };

        // host 解析（多机恒开时有意义；门控关闭则 host 非空 → 明确错误）。
        if let Some(host) = crate::multi_host::optional_host(&params) {
            if !mh_enabled {
                return Ok(ToolOutput::fail(
                    "subagent: 多机操控不可用",
                    "多机操控当前不可用。请去掉 host 参数在当前机器上运行。",
                ));
            }
            let task_id = ctx.task_id.clone().unwrap_or_default();
            if task_id.is_empty() {
                return Ok(ToolOutput::fail(
                    "subagent: 缺少任务上下文",
                    "多机派发需要任务上下文（缺少 task_id）。",
                ));
            }
            let resolved = crate::multi_host::resolve_target(
                &ctx.app_handle,
                &host,
                &task_id,
                &ctx.session_id,
            )
            .await?;
            exec_session_id = resolved.session_id;
            target_host_label = Some(resolved.host_label);
        }

        // ── 创建子agent conversation（独立对话线程，parent 指向主对话）──
        // 子对话归属 = 子 agent **实际运行机器**的 connection（多机时 ≠ 父机器），
        // 保证 DB 归属与前端注册一致。
        let Some(connection_id) = state.ssh_manager.get_connection_id(&exec_session_id).await
        else {
            return Ok(ToolOutput::fail(
                "subagent: SSH 会话不存在",
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
                    "subagent: 创建子agent会话失败",
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
                    connection_id: connection_id.clone(),
                    session_id: exec_session_id.clone(),
                    mode: if exec_mode == AgentMode::Agent {
                        "agent".to_string()
                    } else {
                        "plan".to_string()
                    },
                },
            );
        }

        // ── 审批语义：跟随父任务模式 ──
        // Auto 父任务派发的子 agent 是「全自主」的一部分——主用户选 Auto 即
        // 接受全程不打扰，因此 **任何模式** 的子 agent（含 mode="agent" 读写
        // 执行子 agent）都继承 Some(Auto)：命令静默执行，仅保留风险评估的
        // 硬拦截与工具默认审批（requires_default_approval）。这条覆盖优先于
        // 「Plan 模式也需要审批」设置：Auto 父任务的子 agent 恒静默。
        // Plan/Agent 父任务保持 None：子 agent 走自身 mode 的审批语义——
        //   - Plan 子 agent（只读调研）：默认与 Auto 一样不弹人审（plan 模式
        //     的默认口径，由 `plan_mode_requires_approval` 决定，见
        //     `tool_dispatcher::effective_approval_mode`）；
        //   - mode="agent" 读写子 agent：破坏性命令人审（安全护栏，不能因
        //     换机/读写而放养；Auto 父除外——见上）。
        let approval_mode = state
            .agent_tasks
            .read()
            .get(&parent_task_id)
            .and_then(|t| (t.mode == AgentMode::Auto).then_some(AgentMode::Auto));

        // ── 组装 + spawn（子 agent = exec_mode + 对应约束段）──
        // 约束段的文本在 templates/agent/子agent_只读.hbs、子agent_执行.hbs：
        // 桌面/移动的工具清单差异用 can_transfer 分支，避免两份 cfg 副本各自漂移。
        let sub_instruction = if exec_mode == AgentMode::Agent {
            TemplateManager.render_fragment("子agent_执行", &json!({ "can_transfer": cfg!(desktop) }))
        } else {
            TemplateManager.render_fragment("子agent_只读", &json!({}))
        };
        let spec = AgentSpec {
            task_id: sub_task_id.clone(),
            mode: exec_mode.clone(),
            approval_mode,
            role: AgentRole::Sub { parent_task_id },
            session_id: exec_session_id.clone(),
            conversation_id: sub_conversation_id.clone(),
            prompt,
            history: Vec::new(),
            model_override,
            prompt_extra: vec![sub_instruction],
        };
        let manager = AgentManager::new(state.clone());
        let handle = match manager.spawn(&ctx.app_handle, spec).await {
            Ok(h) => h,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    "subagent: 子agent启动失败",
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

        // 结果归属元数据（多机 badge / 子 agent 模式）——三处共用。
        let result_meta = |mut base: serde_json::Value| -> serde_json::Value {
            let obj = base.as_object_mut().expect("metadata is object");
            if let Some(label) = &target_host_label {
                obj.insert("targetHostLabel".to_string(), json!(label));
            }
            obj.insert(
                "mode".to_string(),
                json!(if exec_mode == AgentMode::Agent {
                    "agent"
                } else {
                    "plan"
                }),
            );
            base
        };

        match classify_subagent_result(result, &status) {
            SubagentOutcome::Report(text) => {
                let output = truncate_chars(&text, MAX_TASK_OUTPUT_CHARS);
                log::info!(
                    "Subtask {} completed: {} chars returned to parent",
                    sub_task_id,
                    text.chars().count()
                );
                Ok(
                    ToolOutput::ok(format!("子agent完成：{}", description), output).with_metadata(
                        result_meta(json!({
                            "subTaskId": sub_task_id,
                            "subConversationId": sub_conversation_id,
                            "status": "completed",
                        })),
                    ),
                )
            }
            SubagentOutcome::Empty => {
                log::warn!("Subtask {} returned an empty report", sub_task_id);
                Ok(ToolOutput::fail(
                    format!("子agent未返回结论：{}", description),
                    "子agent结束了，但没有返回任何结论（正文为空，或整段都在思维标签里）。\
                     不要把它当成调研结果：需要结论时重新派发，并在 prompt 里明确要求以正文给出最终报告。",
                )
                .with_metadata(result_meta(json!({
                    "subTaskId": sub_task_id,
                    "subConversationId": sub_conversation_id,
                    "status": "failed",
                }))))
            }
            SubagentOutcome::Cancelled => {
                log::info!("Subtask {} cancelled", sub_task_id);
                Ok(ToolOutput::fail(
                    format!("子agent已取消：{}", description),
                    "子agent已被取消，未返回调研结果。",
                )
                .with_metadata(result_meta(json!({
                    "subTaskId": sub_task_id,
                    "subConversationId": sub_conversation_id,
                    "status": "cancelled",
                }))))
            }
            SubagentOutcome::Failed => {
                log::warn!("Subtask {} failed (no result)", sub_task_id);
                Ok(ToolOutput::fail(
                    format!("子agent失败：{}", description),
                    "子agent执行失败（LLM 错误或达到最大轮数），未返回调研结果。",
                )
                .with_metadata(result_meta(json!({
                    "subTaskId": sub_task_id,
                    "subConversationId": sub_conversation_id,
                    "status": "failed",
                }))))
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

    /// 子 agent 哑火（正文为空 / 整段都在思维标签里被清空）时 loop 会返回
    /// `Some("")`：那**不是**调研结论，绝不能当成功回给父 agent。
    #[test]
    fn empty_report_is_a_failure_not_a_success() {
        for empty in ["", "   ", "\n\t "] {
            assert_eq!(
                classify_subagent_result(Some(empty.to_string()), &AgentStatus::Completed),
                SubagentOutcome::Empty,
                "{empty:?} 不该被当成调研结果"
            );
        }
        // 有正文才是结果（原样返回）
        assert_eq!(
            classify_subagent_result(Some("结论".to_string()), &AgentStatus::Completed),
            SubagentOutcome::Report("结论".to_string())
        );
    }

    /// None 的分流：取消是用户动作（不是失败），其余都是失败。
    #[test]
    fn missing_result_splits_cancel_from_failure() {
        assert_eq!(
            classify_subagent_result(None, &AgentStatus::Cancelled),
            SubagentOutcome::Cancelled
        );
        assert_eq!(
            classify_subagent_result(None, &AgentStatus::Failed),
            SubagentOutcome::Failed
        );
        assert_eq!(
            classify_subagent_result(None, &AgentStatus::Completed),
            SubagentOutcome::Failed,
            "有终态却没文本 → 失败（绝不能当成完成）"
        );
    }

    #[test]
    fn plan_parent_write_subagent_blocked() {
        assert!(is_plan_parent_write_subagent_blocked(
            "agent",
            true,
            Some(AgentMode::Plan)
        ));
        assert!(!is_plan_parent_write_subagent_blocked(
            "agent",
            true,
            Some(AgentMode::Agent)
        ));
        assert!(!is_plan_parent_write_subagent_blocked(
            "agent",
            true,
            Some(AgentMode::Auto)
        ));
        assert!(!is_plan_parent_write_subagent_blocked(
            "plan",
            true,
            Some(AgentMode::Plan)
        ));
        assert!(!is_plan_parent_write_subagent_blocked(
            "agent",
            false,
            Some(AgentMode::Plan)
        ));
        assert!(!is_plan_parent_write_subagent_blocked(
            "agent",
            true,
            None
        ));
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
            connection_id: "conn-b".into(),
            session_id: "sess-b".into(),
            mode: "plan".into(),
        };
        let json = serde_json::to_value(ev).unwrap();
        assert_eq!(json["type"], "subTaskStart");
        assert_eq!(json["toolCallId"], "call-1");
        assert_eq!(json["subTaskId"], "task-2");
        assert_eq!(json["subConversationId"], "conv-2");
        assert_eq!(json["parentConversationId"], "conv-1");
        assert_eq!(json["connectionId"], "conn-b");
        assert_eq!(json["sessionId"], "sess-b");
        assert_eq!(json["mode"], "plan");
    }
}
