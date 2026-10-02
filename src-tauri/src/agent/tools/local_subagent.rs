//! `local_subagent` 工具 — 在**用户自己这台电脑**上派发一个隔离子 agent。
//!
//! 与 [`super::subagent`] 的关系：派发骨架、事件契约、结果归类全部共用（子 agent
//! 的组装与生命周期统一由 [`crate::agent::manager::AgentManager`] 负责），差异只有
//! 一处 —— **执行侧**：子 agent 的目标机器是运行 Marcel SSH 的这台电脑，而不是当前
//! SSH 会话那台服务器。
//!
//! 执行侧的接线（`AgentRole::LocalSub`，见 `agent/manager.rs`）：
//! - 子任务的 `session_id` 是哨兵 `"local"`（前端 `LOCAL_SESSION_SENTINEL`）；
//! - 子 agent 的 `ToolContext` 挂 `AppState.local_command_exec` 且 `local_side = true`
//!   （ctx 组装在 `agent_loop::execute_single_tool` 的本机分支）；
//! - 工具集收窄：远端语义工具（`bash` / `read_file` / …）一律剔除，只留本机族
//!   （`local_*`）、作业出口（`job_*` 读的正是本机管理器）、`read_history` /
//!   `ask_user` 与应用内工具（见 `tools/mod.rs` 的 `LOCAL_SUB_EXCLUDED_TOOLS`）。
//!
//! # 审批语义（本工具是**派发闸门**，为什么不能只靠 dispatcher 的通用判定）
//!
//! - 工具自身 `disposition() = Approval`：父任务经 dispatcher 走「请求审批」档
//!   （Agent 且开着逐条确认时弹一次；Auto 一次都不问 —— `needs_human_confirmation`
//!   的 Auto 分支恒 `false`，即「Agent 弹、Auto 跳过」）。
//! - **默认设置下的 Plan 父任务是例外**：`effective_approval_mode`
//!   （`tool_dispatcher.rs` 的 `effective_approval_mode`）把 Plan 折成 Auto，
//!   dispatcher 一次都不会问；而只读的本机子 agent 也能读用户电脑上的文件，所以
//!   这里在 `execute` 里补问一次。
//!   补问面**恰好等于 dispatcher 不问的那些组合**（不重复问、也不漏问），判据与
//!   理由见 [`needs_explicit_dispatch_approval`]。判据用的设置是**任务启动时的
//!   快照**（`ctx.agent_mode_settings`，与 dispatcher 手里同一份），不是实时设置 ——
//!   任务中途改设置时两边必须读到同一个值。
//! - 用户拒绝派发 → `ToolOutput::fail`：不建子对话、不启动子 agent、不落任何子任务
//!   记录（前端只在批准后才收到 `subTaskStart`）。
//!
//! 另外两条硬闸门（与 `subagent` 同源同义）：
//! - Plan 父任务不得派发 `mode="agent"` 的读写本机子 agent（只读任务不得经子
//!   agent 间接获得写权限）；
//! - 子 agent 不得再派发子 agent（嵌套防御）。
//!
//! 本工具只在主任务（`ToolRoles::MainOnly`）出现：远端子 agent 与**本机子 agent
//! 自己**都拿不到它，嵌套在工具集层面即不可能。

use async_trait::async_trait;
use serde_json::json;
use tauri::Manager;

use crate::agent::approval::ApprovalManager;
use crate::agent::conversation_persister::PromptOrigin;
use crate::agent::manager::{AgentManager, AgentRole, AgentSpec};
use crate::agent::risk::Disposition;
use crate::agent::task::{AgentMode, AgentStatus};
use crate::agent::templates::TemplateManager;
use crate::agent::tools::subagent::{
    classify_subagent_result, lookup_model_choice, model_param_schema,
    render_model_selection_section, resolved_sub_model_label, truncate_chars, unknown_model_note,
    ModelChoiceLookup, SubTaskStartEvent, SubagentModelCandidate, SubagentOutcome,
};
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::config::settings::AgentModeSettings;
use crate::emit_event;
use crate::error::AppError;
use crate::AppState;

/// 子 agent 结果回传给父 agent 的最大字符数（与 `subagent` 同值：完整过程保留在
/// 子对话里）。
const MAX_TASK_OUTPUT_CHARS: usize = 8000;

/// 本机子任务的会话哨兵值。
///
/// **前端契约**：`src/lib/toolCatalog.ts` 的 `LOCAL_SESSION_SENTINEL` 必须与它逐字
/// 一致（真会话 id 两侧都是 UUID，不会与这个串相撞）。它同时是子 agent 的
/// `AgentSpec.session_id`（→ `ctx.session_id`）与 `SubTaskStartEvent.sessionId`。
const LOCAL_SESSION_SENTINEL: &str = "local";

/// prompt 为空的统一文案：预检（弹审批之前）与 `execute` 兜底共用同一句话，
/// 不让模型看到两种说法。
const EMPTY_PROMPT_MESSAGE: &str =
    "prompt 不能为空：请给出完整、自包含的派发指令（要做什么、看哪些路径、期望的输出形式）。";

/// Plan 父任务禁止派发 `mode="agent"` 的读写本机子 agent（纯函数便于单测）。
///
/// 判据与 `subagent.rs` 的 `is_plan_parent_write_subagent_blocked` 同源同义：只读
/// 父任务不得经子 agent 间接获得写权限。本机派发不涉及多机操控，故不参与那个判据
/// 里的 `mh_enabled` 一维 —— 本机子 agent 的读写模式与多机开关无关。
fn is_plan_parent_write_local_subagent_blocked(
    mode: &str,
    parent_mode: Option<&AgentMode>,
) -> bool {
    mode == "agent" && parent_mode == Some(&AgentMode::Plan)
}

/// 派发本机子 agent 时，`execute` 要不要**再问一次**用户（纯函数便于单测）。
///
/// 判据直接复用 dispatcher 的那一份实现，不另写第二套：
/// - `tool_dispatcher::effective_approval_mode` 把 Plan 默认折成 Auto（除非用户开了
///   「Plan 模式也需要审批」）；
/// - `tool_dispatcher::needs_human_confirmation` 对「无命令文本（本工具
///   `semantics = NONE`）、档位 = `disposition`」的调用：Agent 下的结论由
///   `confirm_each_command`（默认开）驱动，Auto 下恒为 `false`。
///
/// `disposition` 传**工具自己声明的档位**（调用处传 `self.disposition()`），
/// 不写字面量：这个函数的结论是「dispatcher 不问时才补问」，档位一旦从
/// `Approval` 降成 `Allow`，只改 `LocalSubagentTool::disposition` 就该同步改这里的
/// 结论；写字面量会让两处开始各说各话（降档后变成「谁都不问」）。
///
/// 所以结论是：`!needs_human_confirmation(自己这一档)` —— 每种设置下恰好问一次：
/// - 父任务 `Auto` → 不问：用户明确选了全自主，dispatcher 的静默是**设计**（不是
///   漏判），补一次弹窗正好破坏 Auto 的语义；
/// - 父任务 `Agent` → 默认（逐条确认开着）dispatcher 已经问过，不重复问；用户关掉
///   「逐条确认」时 dispatcher 不问，这里补上 —— 本机子 agent 能读用户自己的文件，
///   产品口径是「非 Auto 至少要问一次」；
/// - 父任务 `Plan` → 默认 dispatcher 折成 Auto、一次都不问，这里补上；用户若开了
///   「Plan 模式也需要审批」，dispatcher 会问，这里就不再问。
///
/// `None`（任务表里查不到父任务）在生产路径不可达（任务记录在 agent loop 启动前
/// 就已提交），保守起见按「要问」处理：读不到模式不等于用户可以不被问。
///
/// `settings` 必须是**任务启动时的那份快照**（调用处从 `ctx.agent_mode_settings`
/// 取，即 dispatcher 手里同一份）：两边各读各的实时设置时，任务中途改设置会让
/// 「dispatcher 问不问」与「这里补不补」错位 —— 重复问一次，或者谁都不问。
fn needs_explicit_dispatch_approval(
    parent_mode: Option<&AgentMode>,
    disposition: Disposition,
    settings: &AgentModeSettings,
) -> bool {
    match parent_mode {
        Some(AgentMode::Auto) => false,
        Some(mode) => !crate::agent::tool_dispatcher::needs_human_confirmation(
            mode,
            // 本工具不是命令类（`semantics = NONE`）——dispatcher 那边
            // `command_decision` 恒为 `None`。
            None,
            disposition,
            // 本工具没有 `requires_approval_by_default` / `approval_switch`。
            false,
            settings,
            false,
        ),
        None => true,
    }
}

/// 交互期间的任务状态。
///
/// 与 `tool_dispatcher::set_task_status` 同义：经 `AgentTask::transition_to` 写
/// （吸收规则只有那一处）。dispatcher 的那个是私有的，工具在 `execute` 里自己走
/// 审批时必须自己把状态摆到「等待审批」，否则用户在等弹窗时看到任务仍是「执行中」。
fn set_task_status(state: &AppState, task_id: &str, status: AgentStatus) {
    if let Some(task) = state.agent_tasks.write().get_mut(task_id) {
        task.transition_to(status);
    }
}

pub struct LocalSubagentTool {
    /// 非空：向 LLM 暴露 model 参数并在描述里列出候选（与 `subagent` 同一份设置）。
    model_choices: Vec<SubagentModelCandidate>,
    /// 构造期渲染好的描述（`description()` 返回 `&str`，动态内容只能预拼进字段）。
    rendered_description: String,
}

impl LocalSubagentTool {
    pub fn new() -> Self {
        Self {
            model_choices: Vec::new(),
            rendered_description: BASE_DESCRIPTION.to_string(),
        }
    }

    /// 带候选构建。注入点唯一：`manager::build_role_registry`（仅主任务、候选非空）。
    pub(crate) fn with_choices(model_choices: Vec<SubagentModelCandidate>) -> Self {
        let rendered_description = format!(
            "{}{}",
            BASE_DESCRIPTION,
            render_model_selection_section(&model_choices)
        );
        Self {
            model_choices,
            rendered_description,
        }
    }
}

impl Default for LocalSubagentTool {
    fn default() -> Self {
        Self::new()
    }
}

/// 无候选配置时的工具描述（与引入子agent 模型候选前逐字节一致）。
const BASE_DESCRIPTION: &str =
    "Dispatch an isolated subagent that works on **this computer** — the machine \
         running Marcel SSH (the user's own computer), NOT the SSH server. Use it when \
         the job is about your local machine: reading local logs / configs, inspecting \
         local processes, disk or network state, or (in execution mode) making changes \
         here.\n\
         \n\
         WHY delegate instead of doing it inline: the subagent runs in its OWN \
         conversation with its own context window, does the work end-to-end there, and \
         returns only its final report — bulky local exploration never floods your \
         context, so the main conversation stays short.\n\
         \n\
         APPROVAL: working on the user's own computer is gated on their consent — the \
         dispatch asks the user to approve (in Plan mode too), except in Auto mode. If \
         they refuse, the subagent does not start; do not retry the same dispatch \
         verbatim.\n\
         \n\
         mode:\n\
         - \"plan\" (default) = a read-only research subagent on this computer: it can \
         read files, list directories and run read-only local shell queries, but cannot \
         modify anything.\n\
         - \"agent\" = a read-write execution subagent that can actually modify files / \
         run installs / manage processes on this computer. Only allowed when the \
         CURRENT parent task is in Agent/Auto mode — a Plan-mode parent can only \
         dispatch read-only ones (use \"plan\").\n\
         \n\
         SCOPE: it gets NO server tools at all — no `bash`, no SSH session, no \
         `read_file` / `write_file` / `upload_file` / `download_file`, and no subagent \
         of its own. Server-side work must be done by you (or by a remote `subagent`), \
         never by `local_subagent`.\n\
         \n\
         HOW to delegate: give a COMPLETE, self-contained prompt (what to inspect or \
         do, which paths, expected output format) — the subagent does not see the \
         history after dispatch; it can read your conversation up to the dispatch \
         moment via `read_history(scope=parent)`, but that is not a substitute for a \
         self-contained prompt. You receive only the report — integrate the conclusions \
         into your reply, do not echo the process. Its full process stays viewable in \
         its own conversation (open it from the subagent card).";

#[async_trait]
impl AgentTool for LocalSubagentTool {
    fn name(&self) -> &str {
        "local_subagent"
    }

    fn description(&self) -> &str {
        &self.rendered_description
    }

    fn parameters_schema(&self) -> serde_json::Value {
        let mut schema = json!({
            "type": "object",
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "The COMPLETE, self-contained task for the local subagent: what to inspect or do on this computer, which paths / queries / processes, the questions to answer and the expected output format. The subagent has NO access to your conversation history, so everything it needs must be in this prompt."
                },
                "description": {
                    "type": "string",
                    "description": "A short (3-5 words) description of the subagent, used as the subagent's conversation title shown in the chat list (e.g. 'audit local disk usage', 'read local app logs')."
                },
                "mode": {
                    "type": "string",
                    "enum": ["plan", "agent"],
                    "description": "Optional. 'plan' (default) = read-only research subagent on this computer; 'agent' = read-write execution subagent that can modify files / run installs / manage local processes — only when the current parent task is Agent/Auto mode (Plan-mode parents are rejected)."
                }
            },
            "required": ["prompt"]
        });
        // 用户配置了候选清单才暴露 model 参数（与 `subagent` 同一份清单）。
        if let Some(model) = model_param_schema(&self.model_choices) {
            schema["properties"]
                .as_object_mut()
                .expect("parameters properties is an object")
                .insert("model".to_string(), model);
        }
        schema
    }

    /// 本机派发是「请求审批」档：Agent 父任务由 dispatcher 弹窗、Auto 静默；
    /// Plan 父任务的补问在 `execute` 里（见 [`needs_explicit_dispatch_approval`]）。
    fn disposition(&self) -> Disposition {
        Disposition::Approval
    }

    /// 预检：prompt 为空**在弹审批之前**就失败。
    ///
    /// 两件事：用户不该为一次注定失败的派发点批准；而审批面板展示的正文正是这个
    /// prompt（前端 `local_subagent` 的 `approvalView: 'prompt'`），空面板只会让人
    /// 以为自己在批准一件看不见的事。
    fn validate_arguments(&self, params: &serde_json::Value) -> Result<(), String> {
        let prompt = params
            .get("prompt")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if prompt.is_empty() {
            return Err(format!("local_subagent: {}", EMPTY_PROMPT_MESSAGE));
        }
        Ok(())
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
            return Ok(ToolOutput::fail(
                "local_subagent: prompt 不能为空",
                EMPTY_PROMPT_MESSAGE,
            ));
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

        // ── 父任务上下文：id / 模式 / 会话 / 对话 / 模型 ──
        let parent_task_id = ctx.task_id.clone().unwrap_or_default();
        if parent_task_id.is_empty() {
            return Ok(ToolOutput::fail(
                "local_subagent: 缺少任务上下文",
                "派发本机子 agent 需要任务上下文（缺少 task_id）。",
            ));
        }
        let parent = state.agent_tasks.read().get(&parent_task_id).cloned();
        let parent_mode = parent.as_ref().map(|t| t.mode.clone());
        // 子对话归属沿用父任务所在机器的 connection（本机子 agent 没有自己的 SSH
        // 会话）；父任务记录缺失时退回本工具 ctx 上的父会话信息。
        let parent_conversation_id = parent
            .as_ref()
            .map(|t| t.conversation_id.clone())
            .or_else(|| ctx.conversation_id.clone())
            .unwrap_or_default();
        let parent_session_id = parent
            .as_ref()
            .map(|t| t.session_id.clone())
            .unwrap_or_else(|| ctx.session_id.clone());

        // ── 嵌套防御：子agent不能再派发子agent（含本机子 agent 自己）──
        // 工具集层面已经靠 `ToolRoles::MainOnly` 收敛（本机子 agent 的 registry 里
        // 没有本工具），这里再按任务表检查一次作纵深防御。
        if parent
            .as_ref()
            .and_then(|t| t.parent_task_id.as_ref())
            .is_some()
        {
            log::warn!(
                "local_subagent tool blocked: {} is itself a subagent",
                parent_task_id
            );
            return Ok(ToolOutput::fail(
                "local_subagent: 子agent不能再派发子agent",
                "当前任务本身是子agent，不允许再派发子agent。",
            ));
        }

        // ── mode → 执行模式：Plan 父任务禁止派发读写本机子 agent ──
        let mode = params
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("plan");
        if is_plan_parent_write_local_subagent_blocked(mode, parent_mode.as_ref()) {
            log::warn!(
                "local_subagent mode=agent blocked: parent {} is Plan mode",
                parent_task_id
            );
            return Ok(ToolOutput::fail(
                "local_subagent: Plan 模式不能派发读写本机子agent",
                "当前处于 Plan 模式，不能使用 mode=\"agent\" 派发可修改这台电脑的本机子agent。\
                 请只使用默认只读调研，或请用户切换到 AGENT/AUTO 后再派发。",
            ));
        }
        let exec_mode = match mode {
            "agent" => AgentMode::Agent,
            _ => AgentMode::Plan,
        };

        // ── dispatcher 不问时的补问（判据与理由见 [`needs_explicit_dispatch_approval`]）──
        // 批准之前不建子对话、不发 `subTaskStart`：拒绝就是「什么都没发生」。
        //
        // 设置取**任务启动时的那份快照**（`ctx.agent_mode_settings`，与 dispatcher
        // 手里是同一份）：补问面 = 「dispatcher 不问的那些组合」，任务中途改设置时
        // 两边若各读各的实时值，就会出现重复问、或者更糟的谁都不问。快照缺失
        // （未注入的路径，只在测试/未来调用方出现）才回落到实时设置 —— 有延迟总
        // 好过不问。
        let agent_settings = match ctx.agent_mode_settings.as_deref() {
            Some(snapshot) => snapshot.clone(),
            None => {
                log::warn!(
                    "local_subagent: ctx 没有设置快照，补问判据回落到实时设置（任务中途改设置可能与 dispatcher 判定错位）"
                );
                state.settings.read().await.agent_mode_settings.clone()
            }
        };
        if needs_explicit_dispatch_approval(
            parent_mode.as_ref(),
            self.disposition(),
            &agent_settings,
        ) {
            set_task_status(&state, &parent_task_id, AgentStatus::WaitingApproval);
            let approval =
                ApprovalManager::new(ctx.app_handle.clone(), state.agent_interaction.clone());
            let answer = approval
                .request_approval(
                    parent_task_id.clone(),
                    // 交互事件用**父任务的真实会话**（不能塞本机哨兵 "local"：那会让
                    // 前端把它当成一个不存在的会话/幽灵标签页）。
                    ctx.session_id.clone(),
                    parent_conversation_id.clone(),
                    ctx.tool_call_id
                        .clone()
                        .unwrap_or_else(|| format!("local_subagent:{}", uuid::Uuid::new_v4())),
                    self.name(),
                    params.clone(),
                    Disposition::Approval,
                    Some(&[
                        "本机子agent 会在**你正在使用的这台电脑**上工作（运行 Marcel SSH 的机器，不是服务器）：\
                         批准之后它才会启动，未获批准不会读取或改动任何本地内容。"
                            .to_string(),
                    ]),
                    None,
                )
                .await;
            set_task_status(&state, &parent_task_id, AgentStatus::Executing);
            if !answer.approved {
                log::info!(
                    "local_subagent dispatch rejected by user (task {})",
                    parent_task_id
                );
                let reason = answer
                    .reason
                    .as_deref()
                    .map(str::trim)
                    .filter(|r| !r.is_empty());
                let detail = match reason {
                    Some(r) => format!(
                        "用户拒绝派发本机子agent，理由是：{}\n\n请按这个理由调整方案，不要原样重试这次派发。",
                        r
                    ),
                    None => "用户拒绝派发本机子agent，但没有说明原因。\n\n\
                             请先向用户说明这次派发要做什么，不要原样重试。"
                        .to_string(),
                };
                return Ok(ToolOutput::fail(
                    "local_subagent: 用户拒绝派发本机子agent",
                    detail,
                ));
            }
        }

        // ── 子对话：归属沿用父任务的 connection ──
        let connection_id = match state
            .ssh_manager
            .get_connection_id(&parent_session_id)
            .await
        {
            Some(id) => id,
            // 父任务的 SSH 会话可能已经结束（应用重启等），而对话记录还在：归属
            // 以对话为准，别让本机子 agent 因为一个已经关掉的会话起不来。
            None => state
                .conversation_db
                .get_conversation(&parent_conversation_id)
                .ok()
                .flatten()
                .map(|c| c.connection_id)
                .unwrap_or_default(),
        };
        if connection_id.is_empty() {
            return Ok(ToolOutput::fail(
                "local_subagent: 无法确定子对话归属",
                "找不到父任务所属的连接（SSH 会话与对话记录都不可用），无法创建本机子agent会话。",
            ));
        }
        let sub_title = format!("{}（本机子agent）", description);
        let sub_conv = match state.conversation_db.create_sub_conversation(
            &connection_id,
            &sub_title,
            &parent_conversation_id,
        ) {
            Ok(c) => c,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    "local_subagent: 创建本机子agent会话失败",
                    format!("创建本机子agent会话失败: {}", e),
                ));
            }
        };
        let sub_conversation_id = sub_conv.id;

        // ── 告知前端：先注册子对话 + 挂载子流 listener ──
        // 前端契约（`SubTaskStartPayload`）：`sessionId` = 哨兵 "local"、
        // `side` = "local"、`connectionId` 沿用父任务的。
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
                    parent_conversation_id: parent_conversation_id.clone(),
                    connection_id: connection_id.clone(),
                    session_id: LOCAL_SESSION_SENTINEL.to_string(),
                    mode: if exec_mode == AgentMode::Agent {
                        "agent".to_string()
                    } else {
                        "plan".to_string()
                    },
                    side: Some(LOCAL_SESSION_SENTINEL.to_string()),
                },
            );
        }

        // ── 审批语义：跟随父任务模式（与 `subagent` 同一口径）──
        // Auto 父任务派发的本机子 agent 是「全自主」的一部分：命令静默执行，只保留
        // 风险评估硬拦截。其余父任务保持 None：Plan 只读子 agent 走 plan 的默认口径
        // （不弹人审 —— 派发那一次已经问过），mode="agent" 的破坏性命令照常人审。
        let approval_mode = parent_mode
            .clone()
            .and_then(|m| (m == AgentMode::Auto).then_some(AgentMode::Auto));

        // ── 子 agent 模型：默认继承父任务；配置了候选清单时可经 model 参数选择 ──
        // label → ModelEntry id 的映射在本工具内完成（与 `subagent` 同一套）。
        let mut model_note = String::new();
        let mut model_param_used = false;
        let model_override = match lookup_model_choice(&params, &self.model_choices) {
            ModelChoiceLookup::Chosen(model_id) => {
                model_param_used = true;
                Some(model_id)
            }
            // 清单为空时 schema 根本没有 model 参数——LLM 幻觉出的值视同未
            // 提供（与 `subagent` 同口径：未配置路径与引入本机制前逐字节一致）。
            ModelChoiceLookup::Unknown(label) if !self.model_choices.is_empty() => {
                model_param_used = true;
                model_note = unknown_model_note(&label);
                // label 无效：回落继承父任务模型，并把提示带回给主 agent。
                parent.as_ref().and_then(|t| t.model_id.clone())
            }
            ModelChoiceLookup::Unknown(_) | ModelChoiceLookup::NotProvided => {
                // 恒继承父任务模型（旧行为）。
                parent.as_ref().and_then(|t| t.model_id.clone())
            }
        };

        // ── 组装 + spawn ──
        // 约束段复用远端子 agent 那两份（`子agent_只读` / `子agent_执行`），再追加
        // 本机环境段：它把约束段里「服务器 / 远端 / SSH 通道」的措辞按这台电脑重新
        // 解释，并交代 Windows 的 shell 事实与残余进程的本机收尾手段。
        let sub_instruction = if exec_mode == AgentMode::Agent {
            // `can_transfer` **固定 false**：本机子 agent 的工具集里没有
            // upload_file / download_file —— 收窄清单（`LOCAL_SUB_EXCLUDED_TOOLS`）
            // 把它们连同所有远端语义工具一起剔掉了（它们的目标机器是 SSH 会话，
            // 而本机 ctx 的 session_id 是哨兵 "local"）。曾经传 `cfg!(desktop)`，
            // 于是桌面端的提示词宣称「你可以用 upload_file / download_file」，
            // 而注册表里根本没有这两件工具 —— 模型照着做只会反复吃
            // 「没有这个 tool」。是否可中转由**角色收窄**决定，与平台无关。
            TemplateManager.render_fragment("子agent_执行", &json!({ "can_transfer": false }))
        } else {
            TemplateManager.render_fragment("子agent_只读", &json!({}))
        };
        let local_instruction = TemplateManager.render_fragment("本机子agent", &json!({}));
        let spec = AgentSpec {
            task_id: sub_task_id.clone(),
            mode: exec_mode.clone(),
            approval_mode,
            role: AgentRole::LocalSub {
                parent_task_id: parent_task_id.clone(),
            },
            session_id: LOCAL_SESSION_SENTINEL.to_string(),
            conversation_id: sub_conversation_id.clone(),
            prompt,
            history: Vec::new(),
            // 默认继承父任务模型；候选清单配置后可被 model 参数覆盖（见上）。
            model_override,
            prompt_extra: vec![sub_instruction, local_instruction],
            prompt_origin: PromptOrigin::User,
        };
        let manager = AgentManager::new(state.clone());
        let handle = match manager.spawn(&ctx.app_handle, spec).await {
            Ok(h) => h,
            Err(e) => {
                return Ok(ToolOutput::fail(
                    "local_subagent: 本机子agent启动失败",
                    format!("本机子agent启动失败: {}", e),
                ));
            }
        };
        let result = handle.join().await;

        // ── 汇总结果（与 `subagent` 同一套归类：空正文绝不当成结论）──
        let status = state
            .agent_tasks
            .read()
            .get(&sub_task_id)
            .map(|t| t.status.clone())
            .unwrap_or(AgentStatus::Failed);
        // 主 agent 显式选过模型（含选错回落）才带 modelLabel —— 展示的是 spawn
        // 解析后真实落地的模型；未传参时保持既有 metadata 形状不变。
        let model_label = if model_param_used {
            let settings = state.settings.read().await;
            resolved_sub_model_label(&state, &settings.llm_registry, &sub_task_id)
        } else {
            None
        };
        let result_meta = |mut base: serde_json::Value| -> serde_json::Value {
            let obj = base.as_object_mut().expect("metadata is object");
            if let Some(label) = &model_label {
                obj.insert("modelLabel".to_string(), json!(label));
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
                    "Local subtask {} completed: {} chars returned to parent",
                    sub_task_id,
                    text.chars().count()
                );
                Ok(ToolOutput::ok(
                    format!("本机子agent完成：{}{}", description, model_note),
                    output,
                )
                .with_metadata(result_meta(json!({
                    "subTaskId": sub_task_id,
                    "subConversationId": sub_conversation_id,
                    "status": "completed",
                }))))
            }
            SubagentOutcome::Empty => {
                log::warn!("Local subtask {} returned an empty report", sub_task_id);
                Ok(ToolOutput::fail(
                    format!("本机子agent未返回结论：{}{}", description, model_note),
                    "本机子agent结束了，但没有返回任何结论（正文为空，或整段都在思维标签里）。\
                     不要把它当成调研结果：需要结论时重新派发，并在 prompt 里明确要求以正文给出最终报告。",
                )
                .with_metadata(result_meta(json!({
                    "subTaskId": sub_task_id,
                    "subConversationId": sub_conversation_id,
                    "status": "failed",
                }))))
            }
            SubagentOutcome::Cancelled => {
                log::info!("Local subtask {} cancelled", sub_task_id);
                Ok(ToolOutput::fail(
                    format!("本机子agent已取消：{}{}", description, model_note),
                    "本机子agent已被取消，未返回调研结果。",
                )
                .with_metadata(result_meta(json!({
                    "subTaskId": sub_task_id,
                    "subConversationId": sub_conversation_id,
                    "status": "cancelled",
                }))))
            }
            SubagentOutcome::Failed => {
                log::warn!("Local subtask {} failed (no result)", sub_task_id);
                Ok(ToolOutput::fail(
                    format!("本机子agent失败：{}{}", description, model_note),
                    "本机子agent执行失败（LLM 错误或达到最大轮数），未返回结果。",
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
    fn plan_parent_cannot_dispatch_write_subagent() {
        assert!(is_plan_parent_write_local_subagent_blocked(
            "agent",
            Some(&AgentMode::Plan)
        ));
        for parent in [AgentMode::Agent, AgentMode::Auto] {
            assert!(!is_plan_parent_write_local_subagent_blocked(
                "agent",
                Some(&parent)
            ));
        }
        // 默认 mode（plan）不受限，父任务模式缺失时也不拦（与 `subagent` 一致：
        // 缺上下文不冒充 Plan）。
        assert!(!is_plan_parent_write_local_subagent_blocked(
            "plan",
            Some(&AgentMode::Plan)
        ));
        assert!(!is_plan_parent_write_local_subagent_blocked("agent", None));
    }

    /// 补问用户的判据：**dispatcher 不问时才问**，每种设置下恰好问一次。
    ///
    /// 这三个组合各挡一种退化：Auto 下补问（把全自主打断）、Agent 默认设置下
    /// 重复问（用户为同一次派发点两次批准）、Plan 默认设置下不问（本机文件读取
    /// 无人把关）。
    ///
    /// 档位参数传工具自己的 `disposition()`：这里同时钉住「判据跟着工具声明的档位
    /// 走」——降成 `Allow` 后 `needs_human_confirmation` 在 Agent 下不再要求确认，
    /// 补问随之接管（而不是两处各说各话、变成谁都不问）。
    #[test]
    fn explicit_dispatch_approval_mirrors_the_dispatcher() {
        let declared = LocalSubagentTool::new().disposition();
        assert_eq!(
            declared,
            Disposition::Approval,
            "判据的前提：本工具是审批档"
        );

        let defaults = AgentModeSettings::default();
        assert!(
            defaults.confirm_each_command,
            "默认逐条确认应开着（判据的前提）"
        );
        assert!(
            !defaults.plan_mode_requires_approval,
            "默认 Plan 折成 Auto（判据的前提）"
        );
        let no_each_command = AgentModeSettings {
            confirm_each_command: false,
            ..AgentModeSettings::default()
        };
        let plan_needs_approval = AgentModeSettings {
            plan_mode_requires_approval: true,
            ..AgentModeSettings::default()
        };

        // Auto：永远不问（连关掉逐条确认也一样）。
        for settings in [&defaults, &no_each_command, &plan_needs_approval] {
            assert!(!needs_explicit_dispatch_approval(
                Some(&AgentMode::Auto),
                declared,
                settings
            ));
        }
        // Agent：dispatcher 问过（默认设置）→ 不重复问；关掉逐条确认 → 补问。
        assert!(!needs_explicit_dispatch_approval(
            Some(&AgentMode::Agent),
            declared,
            &defaults
        ));
        assert!(needs_explicit_dispatch_approval(
            Some(&AgentMode::Agent),
            declared,
            &no_each_command
        ));
        // Plan：默认 dispatcher 静默 → 补问；开了「Plan 也需要审批」→ dispatcher
        // 会问，不重复问。
        assert!(needs_explicit_dispatch_approval(
            Some(&AgentMode::Plan),
            declared,
            &defaults
        ));
        assert!(!needs_explicit_dispatch_approval(
            Some(&AgentMode::Plan),
            declared,
            &plan_needs_approval
        ));
        // 查不到父任务（生产路径不可达）：保守起见按「要问」处理。
        assert!(needs_explicit_dispatch_approval(None, declared, &defaults));
        assert!(needs_explicit_dispatch_approval(
            None,
            declared,
            &no_each_command
        ));

        // 档位降成 Allow：`Allow` 在 `needs_human_confirmation` 里不要求确认（无论
        // 逐条确认开没开），于是 Agent / Plan 全由这里补上 —— 不会出现「谁都不问」。
        // 这正是把字面量 `Approval` 换成 `self.disposition()` 挡住的那条退化：
        // 字面量还在时，dispatcher 按 Allow 不问、这里按 Approval 认为「问过了」。
        for settings in [&defaults, &no_each_command, &plan_needs_approval] {
            assert!(needs_explicit_dispatch_approval(
                Some(&AgentMode::Agent),
                Disposition::Allow,
                settings
            ));
            assert!(needs_explicit_dispatch_approval(
                Some(&AgentMode::Plan),
                Disposition::Allow,
                settings
            ));
            assert!(!needs_explicit_dispatch_approval(
                Some(&AgentMode::Auto),
                Disposition::Allow,
                settings
            ));
        }
    }

    #[test]
    fn validate_arguments_rejects_blank_prompt() {
        let tool = LocalSubagentTool::new();
        for args in [
            json!({}),
            json!({ "prompt": "" }),
            json!({ "prompt": "   \n\t " }),
            json!({ "prompt": 42 }),
        ] {
            assert!(
                tool.validate_arguments(&args).is_err(),
                "{args} 应在弹审批之前被拦下"
            );
        }
        assert!(tool
            .validate_arguments(&json!({ "prompt": "读一下本机的磁盘占用" }))
            .is_ok());
    }

    /// 本机派发的 `subTaskStart`：哨兵会话 + `side: "local"` + 父任务连接归属。
    #[test]
    fn local_sub_task_start_event_carries_sentinel_and_side() {
        let ev = SubTaskStartEvent {
            event_type: "subTaskStart".into(),
            tool_call_id: "call-9".into(),
            sub_task_id: "task-9".into(),
            sub_conversation_id: "conv-9".into(),
            description: "盘点本机磁盘".into(),
            prompt: "看看 C 盘占用".into(),
            parent_conversation_id: "conv-parent".into(),
            connection_id: "conn-parent".into(),
            session_id: LOCAL_SESSION_SENTINEL.into(),
            mode: "plan".into(),
            side: Some("local".into()),
        };
        let json = serde_json::to_value(ev).unwrap();
        assert_eq!(json["sessionId"], "local");
        assert_eq!(json["side"], "local");
        assert_eq!(json["connectionId"], "conn-parent");
        assert_eq!(json["parentConversationId"], "conv-parent");
    }

    #[test]
    fn tool_is_declared_as_approval_on_the_local_side() {
        let tool = LocalSubagentTool::new();
        assert_eq!(tool.name(), "local_subagent");
        assert_eq!(tool.disposition(), Disposition::Approval);
        assert!(tool.is_concurrent_safe());
        // 作用侧的权威在描述里（`tools/mod.rs` 的 `acting_tools_state_their_side`）。
        let desc = tool.description().to_lowercase();
        assert!(desc.contains("this computer"));
    }

    /// 候选注入后：描述追加 MODEL SELECTION 段、schema 暴露 model 参数；
    /// 未注入（new）则与引入本机制前一致。共享机制（过滤/映射/枚举内容）由
    /// `subagent.rs` 的测试钉住，这里只钉本工具的接线。
    #[test]
    fn with_choices_exposes_model_param() {
        let plain = LocalSubagentTool::new();
        assert!(plain.definition().parameters["properties"]
            .get("model")
            .is_none());
        assert_eq!(plain.description(), BASE_DESCRIPTION);

        let configured = LocalSubagentTool::with_choices(vec![SubagentModelCandidate {
            model_id: "m1".into(),
            label: "小杯".into(),
            description: String::new(),
        }]);
        let def = configured.definition();
        assert!(def.description.starts_with(BASE_DESCRIPTION));
        assert!(def.description.contains("MODEL SELECTION"));
        assert!(def.description.contains("- \"小杯\"\n"));
        assert_eq!(def.parameters["properties"]["model"]["enum"][0], "小杯");
    }
}
