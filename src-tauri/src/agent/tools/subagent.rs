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
use crate::agent::sandbox::RiskLevel;
use crate::agent::task::{AgentMode, AgentStatus};
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::emit_event;
use crate::error::AppError;
use crate::AppState;

/// 子agent结果回传给主 agent 的最大字符数（完整过程保留在子对话中）。
const MAX_TASK_OUTPUT_CHARS: usize = 8000;

/// 追加到子agent系统提示的调研指令（只读版，现状保持）。
const SUBAGENT_INSTRUCTION: &str = "\
你是被主 Agent 派发的调研子agent（subagent）。你的唯一目标：只读调研并回答主 Agent 交给你的调研问题。

硬性约束：
- 你处于 Plan 模式：只能使用只读调研工具（read_file / list_directory / search_files / system_info / connection_info / bash / web_search / http_get / ask_user / 技能）
- 不得执行任何修改操作：不写文件、不编辑文件、不删除文件、不安装软件、不修改配置
- bash 仅用于信息收集（查看状态、读取输出、运行只读查询），禁止用于修改系统
- 不要调用计划工具（create_plan / update_plan_item / edit_plan 不存在于你的工具集）
- 若用 bash(run_in_background: true) 派发了后台作业：**不要**输出结束语后带着未完成作业离开——系统会在作业结算后自动把「作业已完成」通知发回给你，届时用 job_output(job_id=..., wait=true) 读取其输出并纳入结论；作业若不再需要，用 job_kill 终止。收到结算通知前不需要反复轮询，可继续其他调研。

完成调研后，用简洁清晰的中文输出调研结论：发现的事实（附证据）、关键结论。不要复述调研过程细节。";

/// 追加到子agent系统提示的**读写执行版**指令（多机操控：subagent mode="agent" 时）。
/// 与只读版的核心差异：允许真正执行修改类操作，但仍受 Agent 沙箱与
/// 父任务审批语义约束——子 agent 不是放养的，破坏性命令照常拦截。
///
/// 工具列表按平台拆分：`upload_file`/`download_file` 读写「本机文件系统」
/// （桌面路径语义），移动端不注册——提示词不得列出模型调用必败的工具。
#[cfg(desktop)]
const SUBAGENT_EXEC_INSTRUCTION: &str = "\
你是被主 Agent 派发的执行子agent（subagent）。你的目标是：在指定机器上实际完成任务并回报结果——不只是调研，可以真正执行修改类操作。

硬性约束：
- 你可以使用读写工具：read_file / write_file / edit_file / list_directory / search_files / system_info / connection_info / bash / upload_file / download_file / web_search / http_get / ask_user / 技能
- 可以执行修改操作（写文件、编辑、安装软件、改配置、运行部署脚本等），但必须谨慎：
  - 破坏性/删除类命令（rm、drop、shutdown 等）必须先解释意图，能避免则避免
  - 非平凡的 bash 命令先说明它在做什么与为什么
  - 你的执行与主 Agent 同级的沙箱审查；高风险命令按父任务模式要求审批
- 不要调用计划工具（create_plan / update_plan_item / edit_plan 不存在于你的工具集）
- 若用 bash(run_in_background: true) 派发了后台作业：**不要**输出结束语后带着未完成作业离开——系统会在作业结算后自动把「作业已完成」通知发回给你，届时用 job_output(job_id=..., wait=true) 读取其输出并纳入结论；作业若不再需要，用 job_kill 终止。

完成任务后，用简洁清晰的中文输出结果：做了什么、关键输出/证据、遗留风险或后续建议。不要复述过程细节。";

#[cfg(not(desktop))]
const SUBAGENT_EXEC_INSTRUCTION: &str = "\
你是被主 Agent 派发的执行子agent（subagent）。你的目标是：在指定机器上实际完成任务并回报结果——不只是调研，可以真正执行修改类操作。

硬性约束：
- 你可以使用读写工具：read_file / write_file / edit_file / list_directory / search_files / system_info / connection_info / bash / web_search / http_get / ask_user / 技能
- 不要调用 upload_file / download_file（当前平台未提供本机文件中转工具）
- 可以执行修改操作（写文件、编辑、安装软件、改配置、运行部署脚本等），但必须谨慎：
  - 破坏性/删除类命令（rm、drop、shutdown 等）必须先解释意图，能避免则避免
  - 非平凡的 bash 命令先说明它在做什么与为什么
  - 你的执行与主 Agent 同级的沙箱审查；高风险命令按父任务模式要求审批
- 不要调用计划工具（create_plan / update_plan_item / edit_plan 不存在于你的工具集）
- 若用 bash(run_in_background: true) 派发了后台作业：**不要**输出结束语后带着未完成作业离开——系统会在作业结算后自动把「作业已完成」通知发回给你，届时用 job_output(job_id=..., wait=true) 读取其输出并纳入结论；作业若不再需要，用 job_kill 终止。

完成任务后，用简洁清晰的中文输出结果：做了什么、关键输出/证据、遗留风险或后续建议。不要复述过程细节。";

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
         to answer, expected output format) — the subagent does NOT see your \
         conversation history. You can invoke several `subagent` tools concurrently in \
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
         modify files / run installs / deploy on its machine (still sandboxed and \
         subject to the parent task's approval semantics). mode=\"agent\" is only \
         allowed when the CURRENT parent task is in Agent/Auto mode — Plan-mode \
         parents can only spawn read-only research subagents (use \"plan\").\n\
         IMPORTANT: the `host` value must match the machine name in the multi-host \
         list CHARACTER-FOR-CHARACTER, case-sensitive — do not add, drop, or alter \
         any character (no extra spaces, no lowercase/uppercase changes, no \
         punctuation changes). A name that differs by even one character is \
         rejected, never silently redirected."
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
                    "description": "Optional (multi-host). Target machine's readable name: the current machine or one from the multi-host selected set. When omitted, the subagent runs on the current session's machine. IMPORTANT: must match the machine name in the multi-host list character-for-character, case-sensitive — any single-character difference (case, space, punctuation) is rejected, never silently redirected."
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
        // 执行子 agent）都继承 Some(Auto)：命令静默执行，仅保留 sandbox 硬
        // 拦截与工具默认审批（requires_default_approval）。
        // Plan/Agent 父任务保持 None：子 agent 走自身 mode 的审批语义——
        //   - Plan 子 agent：只读工具集，命令逐条人审；
        //   - mode="agent" 读写子 agent：破坏性命令人审（安全护栏，不能因
        //     换机/读写而放养；Auto 父除外——见上）。
        let approval_mode = state
            .agent_tasks
            .read()
            .get(&parent_task_id)
            .and_then(|t| (t.mode == AgentMode::Auto).then_some(AgentMode::Auto));

        // ── 组装 + spawn（子 agent = exec_mode + 对应约束段）──
        // 只读调研子 agent 用 SUBAGENT_INSTRUCTION（现状）；读写执行子 agent
        // 用 SUBAGENT_EXEC_INSTRUCTION。工具集由 AgentManager::build_registry
        // 按 spec.mode 自动派生（plan 无写工具，agent 有——见 plan 模式
        // 工具集收敛逻辑），这里不再硬编码只读。
        let sub_instruction = if exec_mode == AgentMode::Agent {
            SUBAGENT_EXEC_INSTRUCTION
        } else {
            SUBAGENT_INSTRUCTION
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
            prompt_extra: vec![sub_instruction.to_string()],
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
                        result_meta(json!({
                            "subTaskId": sub_task_id,
                            "subConversationId": sub_conversation_id,
                            "status": "completed",
                        })),
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
                    .with_metadata(result_meta(json!({
                        "subTaskId": sub_task_id,
                        "subConversationId": sub_conversation_id,
                        "status": "cancelled",
                    }))))
                } else {
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
