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

use crate::agent::conversation_persister::PromptOrigin;
use crate::agent::manager::{AgentManager, AgentRole, AgentSpec};
use crate::agent::risk::Disposition;
use crate::agent::task::{AgentMode, AgentStatus};
use crate::agent::templates::TemplateManager;
use crate::agent::tools::{AgentTool, ToolContext, ToolOutput};
use crate::emit_event;
use crate::error::AppError;
use crate::llm::registry::LlmRegistry;
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
    /// 子 agent 在哪台机器上干活：`"local"` = 运行 Marcel SSH 的**这台电脑**
    /// （`local_subagent`，没有 SSH 会话）。
    ///
    /// 远端派发不写这个字段（`None` → 序列化时整个键不出现），保持既有事件形状
    /// 不变；前端以 `sessionId` 的哨兵值判定之外，`side` 是**权威标记**
    /// （见 `src/lib/types.ts` 的 `SubTaskStartPayload.side`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
}

fn default_sub_mode() -> String {
    "plan".to_string()
}

// ── 子agent 候选模型（`subagent` 与 `local_subagent` 共用）──────────────────
//
// 用户在「模型服务」设置里配置候选清单（llm_registry.subagentModels）后，主
// agent 派发子agent 时可经工具的 `model` 参数按任务难度选一个；清单为空则两个
// 工具的定义与引入本机制前逐字节一致（无参数、无附加描述），子agent 恒继承
// 会话模型。工具描述是这份清单的唯一权威（提示词模板不复述）。

/// 解析后的候选：派发侧已按注册表过滤，`label` 即 LLM 在 `model` 参数里传回的值。
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SubagentModelCandidate {
    /// ModelEntry id，命中后作为 `AgentSpec.model_override` 传给 spawn。
    pub model_id: String,
    /// 展示标签（display_name 优先，否则 model_name）——出现在描述、enum 与
    /// 结果 metadata 里的同一个值。
    pub label: String,
    /// 用户写的选型提示，可空。
    pub description: String,
}

/// 把设置里的候选解析成派发侧清单（纯函数便于单测）：
/// - 引用不存在模型的条目丢弃（模型被删后候选静默消失，不出现在工具描述里）；
/// - 渠道禁用的条目丢弃（与前端 `modelOptionsByChannel` 同口径：不让主 agent
///   选到解析必失败的模型）；
/// - **不同模型** label 撞名（同一模型配在两个渠道、或相同 display_name）→
///   走 `label · 渠道名` 消歧，两条都保留可选——用户配的候选不该无声消失；
///   消歧后仍撞（或无法消歧，如渠道名为空）才丢弃本条。enum 恒无重复值：每次
///   push 前都对照已产出清单查重，原始 label 撞上他组消歧结果的条目同样消歧；
/// - label / description 折叠换行（拼进单行清单；label 来自用户可编辑的
///   display_name，手改配置可携带换行/多余空白）。
///
/// 这些都是「设置里保留原样」的刻意行为，每次 spawn 都会发生——日志用
/// debug 级，避免长期保留失效候选的用户刷屏。
pub(crate) fn resolve_subagent_candidates(registry: &LlmRegistry) -> Vec<SubagentModelCandidate> {
    /// 第一遍过滤后的待定候选（label 消歧在第二遍做）。
    struct Pending {
        model_id: String,
        label: String,
        description: String,
        channel_name: String,
    }
    let mut pending: Vec<Pending> = Vec::new();
    for choice in &registry.subagent_models {
        // trim 与保存侧 normalize_subagent_models 同口径（手改配置带空格时
        // 仍能命中，下一次保存即被归一）。
        let model_id = choice.model_id.trim();
        let Some(model) = registry.find_model(model_id) else {
            log::debug!("子agent 候选引用了不存在的模型 ({model_id})，已跳过");
            continue;
        };
        let Some(channel) = registry.find_channel(&model.channel_id) else {
            log::debug!("子agent 候选 {} 的渠道不存在，已跳过", model.id);
            continue;
        };
        if !channel.enabled {
            log::debug!("子agent 候选 {} 所在渠道已禁用，已跳过", registry.model_label(model));
            continue;
        }
        // 同一模型重复条目（手改配置才会出现，UI 已排除）：直接只保留第一条，
        // 不参与下面的跨模型 label 消歧（消歧是给「不同模型同名」用的）。
        if pending.iter().any(|p| p.model_id == model.id) {
            log::debug!("子agent 候选 {} 重复出现，只保留第一条", model.id);
            continue;
        }
        pending.push(Pending {
            model_id: model.id.clone(),
            label: registry
                .model_label(model)
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            description: choice
                .description
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" "),
            channel_name: channel.name.split_whitespace().collect::<Vec<_>>().join(" "),
        });
    }
    let mut out: Vec<SubagentModelCandidate> = Vec::new();
    for (index, item) in pending.iter().enumerate() {
        // 撞名判据两个维度，缺一不可：
        // - pending 里其他条目与它同原始 label（跨模型撞名组，整组消歧）；
        // - out 里已有条目占用了它的原始 label（display_name 是自由文本，
        //   用户可能照抄消歧格式「X · 渠道名」；不查这里会让 enum 出现重复
        //   值，lookup 首条命中会让后配的候选永远选不中）。
        // 撞了就走 `label · 渠道名` 消歧；消歧后仍撞才丢弃本条。
        let label_taken_by_pending = pending
            .iter()
            .enumerate()
            .any(|(j, other)| j != index && other.label == item.label);
        let label_taken_by_out = out.iter().any(|c| c.label == item.label);
        let mut label = item.label.clone();
        if label_taken_by_pending || label_taken_by_out {
            if item.channel_name.is_empty() {
                log::debug!(
                    "子agent 候选标签重复 ({})，且无法用渠道名消歧，丢弃本条",
                    item.label
                );
                continue;
            }
            label = format!("{} · {}", item.label, item.channel_name);
            if out.iter().any(|c| c.label == label) {
                log::debug!("子agent 候选标签消歧后仍重复 ({label})，丢弃本条");
                continue;
            }
        }
        out.push(SubagentModelCandidate {
            model_id: item.model_id.clone(),
            label,
            description: item.description.clone(),
        });
    }
    out
}

/// 候选清单段（拼在两个工具描述的末尾）。
pub(crate) fn render_model_selection_section(choices: &[SubagentModelCandidate]) -> String {
    if choices.is_empty() {
        return String::new();
    }
    let mut section = String::from(
        "\n\nMODEL SELECTION: the user configured candidate models for subagents — \
         pick the best fit for THIS task via the `model` parameter:\n",
    );
    for choice in choices {
        if choice.description.is_empty() {
            section.push_str(&format!("- \"{}\"\n", choice.label));
        } else {
            section.push_str(&format!("- \"{}\": {}\n", choice.label, choice.description));
        }
    }
    section.push_str(
        "When no candidate fits (or the current model is fine), omit `model` and the \
         subagent runs on the current session's model.",
    );
    section
}

/// `model` 参数的 schema 片段；候选为空 = 不暴露该参数（旧行为）。
pub(crate) fn model_param_schema(choices: &[SubagentModelCandidate]) -> Option<serde_json::Value> {
    if choices.is_empty() {
        return None;
    }
    Some(json!({
        "type": "string",
        "enum": choices.iter().map(|c| c.label.clone()).collect::<Vec<_>>(),
        "description": "Optional. Which model the subagent should run on: pick the best fit for THIS task from the candidate list (each candidate's strengths are in the tool description). When omitted, the subagent inherits the current session's model."
    }))
}

/// `model` 参数的解析结果。
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum ModelChoiceLookup {
    /// 参数未提供：继承父任务模型（旧行为）。
    NotProvided,
    /// 命中候选：以该 ModelEntry id 覆盖继承。
    Chosen(String),
    /// 提供了但不在候选清单：回落继承，并把提示带回给主 agent。
    Unknown(String),
}

/// 从工具入参解析 `model` 参数（两个 subagent 工具共用）。
pub(crate) fn lookup_model_choice(
    params: &serde_json::Value,
    choices: &[SubagentModelCandidate],
) -> ModelChoiceLookup {
    let Some(requested) = params
        .get("model")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    else {
        return ModelChoiceLookup::NotProvided;
    };
    match choices.iter().find(|c| c.label == requested) {
        Some(choice) => ModelChoiceLookup::Chosen(choice.model_id.clone()),
        None => ModelChoiceLookup::Unknown(requested.to_string()),
    }
}

/// 「模型 X 不在候选清单」带回给主 agent 的提示（拼在结果标题后）。
pub(crate) fn unknown_model_note(label: &str) -> String {
    format!("（模型 \"{label}\" 不在候选清单，已沿用会话模型）")
}

/// 子任务实际使用的模型展示名（spawn 解析后的真实落地模型，含回落情形）。
pub(crate) fn resolved_sub_model_label(
    state: &AppState,
    registry: &LlmRegistry,
    sub_task_id: &str,
) -> Option<String> {
    let model_id = state
        .agent_tasks
        .read()
        .get(sub_task_id)
        .and_then(|t| t.model_id.clone())?;
    registry
        .find_model(&model_id)
        .map(|m| registry.model_label(m))
}

pub struct SubagentTool {
    /// 非空：向 LLM 暴露 model 参数并在描述里列出候选（来自设置
    /// `llm_registry.subagentModels`，经 [`resolve_subagent_candidates`] 过滤）。
    /// 空：工具定义与引入本机制前一致。
    model_choices: Vec<SubagentModelCandidate>,
    /// 构造期渲染好的描述（`description()` 返回 `&str`，动态内容只能预拼进字段）。
    rendered_description: String,
}

impl SubagentTool {
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

impl Default for SubagentTool {
    fn default() -> Self {
        Self::new()
    }
}

/// 按字符（不是字节）截断，超出时补省略号。`local_subagent` 复用同一份
/// （两处各写一份必然在「多字节安全」这类细节上分叉）。
pub(super) fn truncate_chars(s: &str, max: usize) -> String {
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
pub(super) enum SubagentOutcome {
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
pub(super) fn classify_subagent_result(
    result: Option<String>,
    status: &AgentStatus,
) -> SubagentOutcome {
    match result {
        Some(text) if !text.trim().is_empty() => SubagentOutcome::Report(text),
        Some(_) => SubagentOutcome::Empty,
        None if status.is_cancelled() => SubagentOutcome::Cancelled,
        None => SubagentOutcome::Failed,
    }
}

/// 无候选配置时的工具描述（与引入子agent 模型候选前逐字节一致；候选段由
/// [`render_model_selection_section`] 构造期追加）。
const BASE_DESCRIPTION: &str =
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
         parents can only spawn read-only research subagents (use \"plan\").";

#[async_trait]
impl AgentTool for SubagentTool {
    fn name(&self) -> &str {
        "subagent"
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
        });
        // 用户配置了候选清单才暴露 model 参数（enum = 候选标签，清单在工具描述里）。
        if let Some(model) = model_param_schema(&self.model_choices) {
            schema["properties"]
                .as_object_mut()
                .expect("parameters properties is an object")
                .insert("model".to_string(), model);
        }
        schema
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

        // ── 子 agent 模型：默认继承父任务模型；配置了候选清单时主 agent 可经
        // model 参数按 label 选一个（label → ModelEntry id 的映射在本工具内完成
        // —— spawn 侧 resolve_override 只认 id/模型名，不认 display_name）──
        // 父任务 model_id 为 None（极端情况）时回落最近使用/首个模型
        // （spawn 内 resolve_default 处理）。
        let mut model_note = String::new();
        let mut model_param_used = false;
        let model_override = match lookup_model_choice(&params, &self.model_choices) {
            ModelChoiceLookup::Chosen(model_id) => {
                model_param_used = true;
                Some(model_id)
            }
            // 清单为空时 schema 根本没有 model 参数——LLM 幻觉出的值视同未
            // 提供（无 note、无 modelLabel），保证未配置候选的路径与引入本
            // 机制前逐字节一致。
            ModelChoiceLookup::Unknown(label) if !self.model_choices.is_empty() => {
                model_param_used = true;
                model_note = unknown_model_note(&label);
                // label 无效：回落继承父任务模型，并把提示带回给主 agent。
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
            ModelChoiceLookup::Unknown(_) | ModelChoiceLookup::NotProvided => {
                // 恒继承父任务模型（旧行为）：父任务用 A，派发的子 agent 也用 A。
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
            log::warn!(
                "subagent tool blocked: {} is itself a subagent",
                parent_task_id
            );
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
                    // 远端派发：不写 side（与既有事件形状一致）。
                    side: None,
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
            TemplateManager
                .render_fragment("子agent_执行", &json!({ "can_transfer": cfg!(desktop) }))
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
            // 子 agent 的 prompt 是父 agent 写的派发任务，但它在自己的子会话里
            // 就是「这一轮用户说的话」——按用户输入落库（子会话没有唤醒轮）。
            prompt_origin: PromptOrigin::User,
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

        // 主 agent 显式选过模型（含选错回落）才带 modelLabel —— 展示的是 spawn
        // 解析后**真实落地**的模型（渠道失效回落时不说谎）；未传参时保持既有
        // metadata 形状不变。
        let model_label = if model_param_used {
            let settings = state.settings.read().await;
            resolved_sub_model_label(&state, &settings.llm_registry, &sub_task_id)
        } else {
            None
        };

        // 结果归属元数据（多机 badge / 子 agent 模式）——三处共用。
        let result_meta = |mut base: serde_json::Value| -> serde_json::Value {
            let obj = base.as_object_mut().expect("metadata is object");
            if let Some(label) = &target_host_label {
                obj.insert("targetHostLabel".to_string(), json!(label));
            }
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
                    "Subtask {} completed: {} chars returned to parent",
                    sub_task_id,
                    text.chars().count()
                );
                Ok(ToolOutput::ok(
                    format!("子agent完成：{}{}", description, model_note),
                    output,
                )
                .with_metadata(result_meta(json!({
                    "subTaskId": sub_task_id,
                    "subConversationId": sub_conversation_id,
                    "status": "completed",
                }))))
            }
            SubagentOutcome::Empty => {
                log::warn!("Subtask {} returned an empty report", sub_task_id);
                Ok(ToolOutput::fail(
                    format!("子agent未返回结论：{}{}", description, model_note),
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
                    format!("子agent已取消：{}{}", description, model_note),
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
                    format!("子agent失败：{}{}", description, model_note),
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
        assert!(!is_plan_parent_write_subagent_blocked("agent", true, None));
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
            side: None,
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
        // 远端派发不写 `side`：新增字段不能改动既有事件形状（前端按
        // `sessionId` 哨兵判定，`side` 只在本机派发时出现）。
        assert!(json.get("side").is_none());
    }

    // ── 子agent 候选模型 ─────────────────────────────────────────────

    use crate::llm::registry::{ChannelConfig, ModelEntry, SubagentModelChoice};

    /// 渠道 c1 启用（m1 有 display_name、m2 没有）；渠道 c2 禁用（m3）。
    fn registry_with_choices(choices: Vec<SubagentModelChoice>) -> LlmRegistry {
        let mut registry = LlmRegistry::default();
        registry.channels.push(ChannelConfig {
            id: "c1".into(),
            name: "渠道一".into(),
            base_url: "https://api.example.com/v1".into(),
            ..Default::default()
        });
        registry.channels.push(ChannelConfig {
            id: "c2".into(),
            name: "禁用渠道".into(),
            enabled: false,
            ..Default::default()
        });
        registry.models.push(ModelEntry {
            id: "m1".into(),
            channel_id: "c1".into(),
            model_name: "qwen3.8-32b-a3b".into(),
            display_name: "小杯".into(),
            ..Default::default()
        });
        registry.models.push(ModelEntry {
            id: "m2".into(),
            channel_id: "c1".into(),
            model_name: "claude-fable-5".into(),
            ..Default::default()
        });
        registry.models.push(ModelEntry {
            id: "m3".into(),
            channel_id: "c2".into(),
            model_name: "disabled-model".into(),
            ..Default::default()
        });
        registry.subagent_models = choices;
        registry
    }

    #[test]
    fn candidates_filter_missing_disabled_and_duplicate_labels() {
        let registry = registry_with_choices(vec![
            SubagentModelChoice {
                model_id: "m1".into(),
                description: "小模型，\n 适合搜索等简单任务".into(),
            },
            SubagentModelChoice {
                model_id: "missing".into(),
                description: "已被删除的模型".into(),
            },
            SubagentModelChoice {
                model_id: "m3".into(),
                description: "渠道禁用".into(),
            },
            SubagentModelChoice {
                model_id: "m2".into(),
                description: String::new(),
            },
            // 与第一条同模型 → label 撞名，只保留第一条。
            SubagentModelChoice {
                model_id: "m1".into(),
                description: "重复条目".into(),
            },
        ]);
        let candidates = resolve_subagent_candidates(&registry);
        assert_eq!(candidates.len(), 2, "丢失/禁用/撞名的候选都不进清单");
        assert_eq!(candidates[0].model_id, "m1");
        assert_eq!(candidates[0].label, "小杯", "display_name 优先");
        assert_eq!(candidates[0].description, "小模型， 适合搜索等简单任务");
        assert_eq!(
            candidates[1].label, "claude-fable-5",
            "display_name 为空时回落 model_name"
        );
    }

    #[test]
    fn empty_choices_registry_yields_no_candidates() {
        let registry = registry_with_choices(Vec::new());
        assert!(resolve_subagent_candidates(&registry).is_empty());
    }

    /// 两个**不同模型** label 撞名（同一模型配在两个渠道是真实场景）：
    /// 整组消歧为 `label · 渠道名`，两条都保留可选，enum 无歧义；
    /// 同渠道同名（消歧救不了）才回落「只保留第一条」。
    #[test]
    fn candidates_disambiguate_cross_model_label_collision() {
        let mut registry = LlmRegistry::default();
        for (id, name) in [("c1", "渠道一"), ("c2", "渠道二")] {
            registry.channels.push(ChannelConfig {
                id: id.into(),
                name: name.into(),
                base_url: format!("https://{id}.example.com"),
                ..Default::default()
            });
        }
        for (id, channel_id) in [("m1", "c1"), ("m2", "c1"), ("m3", "c2")] {
            registry.models.push(ModelEntry {
                id: id.into(),
                channel_id: channel_id.into(),
                model_name: "same-name".into(),
                ..Default::default()
            });
        }
        // 跨渠道：m1(c1) 与 m3(c2) 同名 → 都保留，label 带渠道名消歧。
        // 同渠道：m2(c1) 与 m1(c1) 同名 → 消歧救不了，只留清单里的第一条（m1）。
        registry.subagent_models = vec![
            SubagentModelChoice {
                model_id: "m1".into(),
                description: "第一条".into(),
            },
            SubagentModelChoice {
                model_id: "m3".into(),
                description: "跨渠道同名".into(),
            },
            SubagentModelChoice {
                model_id: "m2".into(),
                description: "同渠道同名".into(),
            },
        ];
        let candidates = resolve_subagent_candidates(&registry);
        let labels: Vec<&str> = candidates.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(
            labels,
            vec!["same-name · 渠道一", "same-name · 渠道二"],
            "跨渠道同名消歧共存；同渠道同名只留第一条"
        );
        assert_eq!(candidates[0].model_id, "m1");
        assert_eq!(candidates[1].model_id, "m3");
    }

    /// display_name 是自由文本，用户可能照抄消歧格式（「X · 渠道名」）：原始
    /// label 与他组消歧结果相撞的条目同样要走消歧——enum 恒无重复值，且不
    /// 无声丢弃（lookup 首条命中会让后配的候选永远选不中）。
    #[test]
    fn candidates_disambiguate_when_original_label_collides_with_disambiguated() {
        let mut registry = LlmRegistry::default();
        for (id, name) in [("c1", "官方"), ("c2", "中转")] {
            registry.channels.push(ChannelConfig {
                id: id.into(),
                name: name.into(),
                base_url: format!("https://{id}.example.com"),
                ..Default::default()
            });
        }
        // m1/m2 同名（跨渠道撞名组）→ 消歧为 `gemini · 官方` / `gemini · 中转`；
        // m3 的 display_name 手填 `gemini · 官方` → 原始 label 直接撞 m1 的消歧结果。
        registry.models.push(ModelEntry {
            id: "m1".into(),
            channel_id: "c1".into(),
            model_name: "gemini".into(),
            ..Default::default()
        });
        registry.models.push(ModelEntry {
            id: "m2".into(),
            channel_id: "c2".into(),
            model_name: "gemini".into(),
            ..Default::default()
        });
        registry.models.push(ModelEntry {
            id: "m3".into(),
            channel_id: "c1".into(),
            model_name: "other".into(),
            display_name: "gemini · 官方".into(),
            ..Default::default()
        });
        registry.subagent_models = vec![
            SubagentModelChoice {
                model_id: "m1".into(),
                description: String::new(),
            },
            SubagentModelChoice {
                model_id: "m2".into(),
                description: String::new(),
            },
            SubagentModelChoice {
                model_id: "m3".into(),
                description: String::new(),
            },
        ];
        let candidates = resolve_subagent_candidates(&registry);
        let labels: Vec<&str> = candidates.iter().map(|c| c.label.as_str()).collect();
        assert_eq!(
            labels,
            vec!["gemini · 官方", "gemini · 中转", "gemini · 官方 · 官方"],
            "三候选全保留、enum 无重复值"
        );
        assert_eq!(candidates[2].model_id, "m3");
    }

    /// 手改配置带首尾空格的 model_id 仍能命中（与保存侧 normalize 口径一致，
    /// 下一次保存即被归一）。
    #[test]
    fn candidates_tolerate_whitespace_in_model_id() {
        let registry = registry_with_choices(vec![SubagentModelChoice {
            model_id: " m1 ".into(),
            description: String::new(),
        }]);
        let candidates = resolve_subagent_candidates(&registry);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].model_id, "m1");
        assert_eq!(candidates[0].label, "小杯");
    }

    /// 未配置候选 = 工具定义与引入本机制前逐字节一致（无 model 参数、无附加段）。
    #[test]
    fn without_choices_definition_is_unchanged() {
        let tool = SubagentTool::new();
        let def = tool.definition();
        assert_eq!(def.description, BASE_DESCRIPTION);
        assert!(
            def.parameters["properties"].get("model").is_none(),
            "未配置候选时不得暴露 model 参数"
        );
    }

    #[test]
    fn with_choices_exposes_model_param_and_description_section() {
        let choices = vec![
            SubagentModelCandidate {
                model_id: "m1".into(),
                label: "小杯".into(),
                description: "小模型".into(),
            },
            SubagentModelCandidate {
                model_id: "m2".into(),
                label: "大杯".into(),
                description: String::new(),
            },
        ];
        let tool = SubagentTool::with_choices(choices);
        let def = tool.definition();
        assert!(def.description.starts_with(BASE_DESCRIPTION));
        assert!(def.description.contains("MODEL SELECTION"));
        assert!(def.description.contains("- \"小杯\": 小模型"));
        assert!(def.description.contains("- \"大杯\"\n"));
        let model = &def.parameters["properties"]["model"];
        assert_eq!(model["type"], "string");
        assert_eq!(model["enum"][0], "小杯");
        assert_eq!(model["enum"][1], "大杯");
        assert_eq!(model["enum"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn lookup_maps_label_and_reports_unknown() {
        let choices = vec![SubagentModelCandidate {
            model_id: "m1".into(),
            label: "小杯".into(),
            description: String::new(),
        }];
        assert_eq!(
            lookup_model_choice(&json!({}), &choices),
            ModelChoiceLookup::NotProvided
        );
        assert_eq!(
            lookup_model_choice(&json!({ "model": "  " }), &choices),
            ModelChoiceLookup::NotProvided,
            "空白值等同未提供"
        );
        assert_eq!(
            lookup_model_choice(&json!({ "model": "小杯" }), &choices),
            ModelChoiceLookup::Chosen("m1".into())
        );
        assert_eq!(
            lookup_model_choice(&json!({ "model": "不在清单的" }), &choices),
            ModelChoiceLookup::Unknown("不在清单的".into())
        );
        assert_eq!(
            unknown_model_note("X"),
            "（模型 \"X\" 不在候选清单，已沿用会话模型）"
        );
    }
}
