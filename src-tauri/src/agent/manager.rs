//! AgentManager — 统一 agent 的组装与生命周期管理。
//!
//! 职责边界（manager 而非纯功能）：
//! - **组装**：从 [`AgentSpec`]（声明式描述）派生出 provider / registry /
//!   messages，收敛 Plan / Agent / Auto 三种模式在工具集、system prompt、
//!   插件段上的差异。
//! - **生命周期**：注册 [`AgentTask`]、spawn [`run_agent_loop`]、统一终态
//!   更新、取消信号清理与 panic 兜底。
//!
//! 主任务与子任务（`subagent` 工具派发）共用同一个 [`AgentManager::spawn`]
//! 入口，子代理只是 [`AgentSpec`] 叠加了角色约束，不再复制组装逻辑。
//!
//! 调用方（`commands/agent_lifecycle`、`agent/tools/subagent`）负责「决定要
//! 跑什么」（spec）与前后的事件/对话准备，不各自实现组装与 spawn。

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::OnceLock;
use std::time::Instant;

use futures::FutureExt;
use parking_lot::RwLock as PlRwLock;
use tauri::AppHandle;

use crate::agent::agent_loop::{run_agent_loop, LoopContext};
use crate::agent::conversation_persister::{ConversationPersister, PromptOrigin};
use crate::agent::system_prompt::build_system_prompt;
use crate::agent::task::{AgentMode, AgentStatus, AgentTask, AgentTaskPlan, TurnState};
use crate::agent::templates::TemplateManager;
use crate::agent::tools::{
    mcp::register_mcp_tools, plugin_tool::register_plugin_tools, ToolRegistry,
};
use crate::config::settings::{CommandApprovalEngine, ExperimentalSettings};
use crate::config::keychain;
use crate::error::AppError;
use crate::llm::jev::JevConfig;
use crate::llm::manager::LlmManager;
use crate::llm::provider::{LlmConfig, LlmMessage, LlmRole, ToolDefinition};
use crate::mcp::store::McpServerConfig;
use crate::plugins::context::{apply_to_string, SessionContext};
use crate::plugins::registry::PluginRegistry;
use crate::ssh::connection::SessionInfo;
use crate::AppState;

/// 单个插件贡献的 system prompt 段的最大字符数。
const PLUGIN_SECTION_MAX_CHARS: usize = 2000;

/// 一个 agent 实例的角色。
#[derive(Debug, Clone, PartialEq)]
pub enum AgentRole {
    /// 主任务：由用户直接发起。
    Main,
    /// 子任务：由 `subagent` 工具派发的调研子 agent。
    Sub { parent_task_id: String },
}

impl AgentRole {
    fn is_subtask(&self) -> bool {
        matches!(self, AgentRole::Sub { .. })
    }

    fn parent_task_id(&self) -> Option<&str> {
        match self {
            AgentRole::Sub { parent_task_id } => Some(parent_task_id),
            AgentRole::Main => None,
        }
    }
}

/// 声明式描述一次 agent 组装与运行。
pub struct AgentSpec {
    /// 任务实例标识，由调用方生成：主任务要返回给前端，子任务要在 spawn
    /// 前 emit `SubTaskStart` 注册子对话流监听。
    pub task_id: String,
    pub mode: AgentMode,
    pub role: AgentRole,
    pub session_id: String,
    pub conversation_id: String,
    pub prompt: String,
    /// 前端传入的历史消息（子任务通常为空）。
    pub history: Vec<LlmMessage>,
    /// 覆盖主模型的 model 名（子任务可选）。
    pub model_override: Option<String>,
    /// 追加到 system prompt 的角色约束段（子任务的调研约束）。
    /// 作为拼装组件传入，与基础段一样由模板拼装器统一拼接。
    pub prompt_extra: Vec<String>,
    /// 本轮 prompt 的来源（用户输入 / 作业结算告知）。决定它在会话里的身份
    /// （落库 role，见 [`PromptOrigin`]）与「算不算用户输入」（自动继续的预算
    /// 只由用户输入重置）。主任务由 IPC 给，子任务恒为用户输入。
    pub prompt_origin: PromptOrigin,
    /// 审批语义覆盖：`None` = 跟随自身 `mode`（Plan 模式默认与 Auto 一样不弹
    /// 人审，除非设置了 `plan_mode_requires_approval`）；`Some(Auto)` = 命令执行
    /// 静默放行不弹人审（模型审批的 route_to_human 也不转人审），仅保留 风险
    /// 评估硬拦截。Auto 父任务派发的只读调研子 agent 用它，避免主任务在 Auto
    /// 全自主时子 agent 的只读命令仍弹审批窗 —— 这条覆盖**优先于**上面的设置，
    /// 用户把「Plan 模式也需要审批」打开后 Auto 父任务的子 agent 依然静默。
    pub approval_mode: Option<AgentMode>,
}

/// [`AgentManager::spawn`] 返回的任务句柄。
///
/// 主任务通常 fire-and-forget（drop 句柄即可，spawn 内部已保证终态与取消
/// 清理）；子任务需要 [`AgentTaskHandle::join`] 拿回调研结果文本。
pub struct AgentTaskHandle {
    pub task_id: String,
    join: tokio::task::JoinHandle<Option<String>>,
}

impl AgentTaskHandle {
    pub async fn join(self) -> Option<String> {
        let task_id = self.task_id.clone();
        match self.join.await {
            Ok(result) => result,
            Err(e) => {
                log::error!("agent task {} join error: {}", task_id, e);
                None
            }
        }
    }
}

// ── 「组装期间收到的停止」墓碑 ──

/// 墓碑有效期（安全网）。
///
/// 正常路径下墓碑活不过一次 `spawn`：`spawn` 开头就把它取走、注册取消表后再认领，
/// 所以只有「任务根本没起来 / 前端发了停止却没有对应的启动」才会留下它。留个上限
/// 免得这类请求永久堆积，也避免 task_id 复用（极端情况下前端可能重发同一个 id）
/// 在很久之后被一枚旧墓碑误伤。
const PENDING_CANCEL_TTL: std::time::Duration = std::time::Duration::from_secs(600);
/// 墓碑条数上限：组装窗口是秒级、来源只有用户点击；超量丢最旧的，
/// 保证这张表不会无限增长（真被塞满也只是退化回「组装期停止可能丢」）。
const PENDING_CANCEL_MAX: usize = 64;

/// `task_id → 请求停止的时间点`。进程级表：`AppState` 里没有这一类槽位，
/// 而墓碑只服务于「同一次 spawn 的组装窗口」这一瞬间。
fn pending_cancels() -> &'static std::sync::Mutex<std::collections::VecDeque<(String, Instant)>> {
    static TABLE: OnceLock<std::sync::Mutex<std::collections::VecDeque<(String, Instant)>>> =
        OnceLock::new();
    TABLE.get_or_init(|| std::sync::Mutex::new(std::collections::VecDeque::new()))
}

/// 记下一枚「还没出生就被要求停止」的墓碑（同 id 去重、顺带清理过期条目）。
fn record_pending_cancel(task_id: &str) {
    let now = Instant::now();
    let mut table = pending_cancels().lock().unwrap_or_else(|e| e.into_inner());
    table.retain(|(id, at)| id != task_id && now.duration_since(*at) < PENDING_CANCEL_TTL);
    table.push_back((task_id.to_string(), now));
    while table.len() > PENDING_CANCEL_MAX {
        table.pop_front();
    }
}

/// 认领（一次性消费）某任务的停止请求。
///
/// **过期的墓碑不算命中**：它是一条陈旧的请求（上一次运行留下的），认领会把
/// 这一次才起来的同名任务开场就收掉。命中与清理在同一次遍历里完成。
fn take_pending_cancel(task_id: &str) -> bool {
    let now = Instant::now();
    let mut table = pending_cancels().lock().unwrap_or_else(|e| e.into_inner());
    let mut hit = false;
    table.retain(|(id, at)| {
        let fresh = now.duration_since(*at) < PENDING_CANCEL_TTL;
        if id == task_id {
            if fresh {
                hit = true;
            }
            return false; // 认领即消费（过期的也一并摘掉）
        }
        fresh
    });
    hit
}

/// 记录一次「停止这个任务」的请求——**无论任务在不在册都不丢**。
///
/// 为什么需要它：`spawn` 在把任务写进 `agent_tasks` 之前要读设置、解析模型
/// （密钥链）、构建工具注册表（对每个启用的 MCP server 刷新工具，不可达的
/// server 单次上限 30s）、拼 system prompt——配了 MCP 的任务每次启动可以耗掉
/// 几十秒。前端点「停止」时任务可能**还没在册**，若那时只回一句 `Task not
/// found`，这次停止就被整个丢掉：任务随后照常启动、照常跑完，远端命令、审批
/// 弹窗、消息落库一样不少，用户以为自己已经停下了它。
///
/// 所以：
/// - 任务在册 → 置取消态（`transition_to`，Cancelled 是吸收态、重复写幂等）
///   并置位取消信号；级联（子 agent / 后台作业 / 待审批交互）仍由调用方负责，
///   那是一整套停止语义，不塞进这里。
/// - 任务不在册 → 记一枚墓碑，等 `spawn` 注册完取消表后认领。
///
/// **不要在持有 `agent_tasks` 写锁时调用**：本函数要读写同一把锁
/// （`parking_lot::RwLock` 不可重入，同线程再取读锁会死锁）。调用点先
/// `drop(tasks)` 再调。
pub(crate) fn request_cancel(state: &AppState, task_id: &str) {
    if state.agent_tasks.read().contains_key(task_id) {
        apply_pending_cancel(&state.agent_tasks, &state.task_cancel, task_id);
        return;
    }
    record_pending_cancel(task_id);
}

/// 应用一次停止：任务收成 `Cancelled` 并发出取消信号。
///
/// 抽成自由函数（只依赖任务表与取消表，不依赖整个 `AppState`）是为了让「取消
/// 表已有接收端」这条顺序约束可测——顺序错就退化成「用户以为停了，任务照常在
/// 后台跑完」。任务记录已被剪掉时不写状态（无从写起），但信号照发。
fn apply_pending_cancel(
    tasks: &std::sync::Arc<PlRwLock<HashMap<String, AgentTask>>>,
    cancel: &crate::cancel::CancellationRegistry,
    task_id: &str,
) {
    if let Some(task) = tasks.write().get_mut(task_id) {
        // Cancelled 是吸收态：重复置位是幂等空操作。
        task.transition_to(AgentStatus::Cancelled);
    }
    // 必须在取消表注册**之后**调用：表里没有接收端时 send 会丢，而 agent loop
    // 只在取消信号上中断正在进行的 LLM 调用（任务状态是每轮开头才查）。
    cancel.cancel(task_id);
}

/// 统一管理 agent 的组装与生命周期。
pub struct AgentManager {
    state: AppState,
}

impl AgentManager {
    pub fn new(state: AppState) -> Self {
        Self { state }
    }

    /// 按当前设置解析「工具集输入」：启用技能、启用的 MCP server、实验开关。
    ///
    /// `spawn` 与 [`Self::current_tool_definitions`] 共用同一来源——两处各写一份
    /// 必然分叉，而工具清单一分叉，摘要调用与常规请求的 tools 段就不再一致
    /// （上下文压缩把"与常规请求对齐"当作减少信息丢失的手段）。
    async fn resolve_tool_inputs(
        &self,
    ) -> (
        Vec<crate::skills::store::Skill>,
        Vec<McpServerConfig>,
        ExperimentalSettings,
    ) {
        let settings = self.state.settings.read().await;
        let skills = self.state.skill_store.read().await;
        let mcp_store = self.state.mcp_store.read().await;
        let experimental_settings = settings.experimental_settings.clone();
        let mut enabled_skills = skills
            .list()
            .iter()
            .filter(|s| s.enabled)
            .cloned()
            .collect::<Vec<_>>();
        let enabled_mcp_servers = mcp_store
            .list()
            .iter()
            .filter(|s| s.enabled)
            .cloned()
            .collect::<Vec<_>>();

        if !crate::agent::tools::html_render_enabled(&experimental_settings) {
            enabled_skills.retain(|skill| skill.id != "builtin.visualize");
        }
        (enabled_skills, enabled_mcp_servers, experimental_settings)
    }

    /// 「该会话下一次常规请求」会下发的工具 schema（角色 Main，模式取设置里持久化的
    /// 当前模式）：供手动压缩（无运行中任务）复用，让摘要调用与常规请求的 tools 段
    /// 一致。走 `spawn` 同一个 `build_registry`，工具集将来怎么变都自动跟上。
    ///
    /// 与常规请求同样过一遍状态门控（见 `apply_state_gate`）。这里问的是**压缩前**
    /// 那一刻的状态——摘要要解释的是压缩之前那段历史里的工具调用；首次压缩时那段
    /// 历史里不可能有 `read_history` 调用（工具当时还没出现），所以不会因此失配。
    ///
    /// 模式来源：前端切换模式时经 `taskStore.setMode` 写入 `defaultAgentMode`，
    /// 即下一次请求实际会用的模式；未知值回落 `Agent`，只影响工具清单不影响安全边界。
    pub async fn current_tool_definitions(&self, conversation_id: &str) -> Vec<ToolDefinition> {
        let (enabled_skills, enabled_mcp_servers, experimental_settings) =
            self.resolve_tool_inputs().await;
        let mode = {
            let raw = self.state.settings.read().await.default_agent_mode.clone();
            AgentMode::from_settings_str(&raw)
        };
        let plugin_registry_guard = self.state.plugin_registry.read().await;
        let registry = self
            .build_registry(
                &AgentRole::Main,
                &mode,
                &enabled_skills,
                &enabled_mcp_servers,
                &experimental_settings,
                &plugin_registry_guard,
            )
            .await;
        let expose = self
            .state
            .conversation_db
            .has_readable_history(conversation_id)
            .unwrap_or(true);
        apply_state_gate(build_definitions(&registry, &mode), expose)
    }

    /// 组装并启动一个 agent 实例。负责：
    /// 1. 注册 [`AgentTask`]（主任务额外恢复最近一次 plan）；
    /// 2. 从 spec 派生 provider / registry / messages；
    /// 3. spawn [`run_agent_loop`] 并统一终态更新、取消清理与 panic 兜底。
    pub async fn spawn(
        &self,
        app: &AppHandle,
        spec: AgentSpec,
    ) -> Result<AgentTaskHandle, AppError> {
        let task_id = spec.task_id.clone();

        // 组装开始前就存在的停止请求：**当场消费掉**。它落在这里的两种情形都是
        // 「任务还没起来就被要求停止」——记下来，注册完取消表后立刻收场。消费（而
        // 不是留给后面再取）还保证墓碑不会陪着一路组装的失败路径长期残留。
        let cancel_requested_before_spawn = take_pending_cancel(&task_id);

        // ── 1. 读取设置 ──
        let (llm_registry, mut agent_settings) = {
            let settings = self.state.settings.read().await;
            (
                settings.llm_registry.clone(),
                settings.agent_mode_settings.clone(),
            )
        };
        let (enabled_skills, enabled_mcp_servers, experimental_settings) =
            self.resolve_tool_inputs().await;

        // ── 2. 模型路由（主模型语义 = 会话级 → 全局最近使用 → 第一个） ──
        // - 主任务：`spec.model_override` 为空时，先查本会话内存模型记忆；
        //   无记忆 → 全局最近使用（resolve_default = last_used/首个）。
        // - 子任务：model_override 恒为父任务 model_id（`subagent` 工具继承，
        //   不向 LLM 暴露 model 参数），空时同样回落到会话记忆/最近使用
        //   （与主任务同源语义）。
        // registry 解析会兜底补读 keychain（渠道密钥），无需再手动预取。
        let session_override = if spec.model_override.is_none() && spec.role == AgentRole::Main {
            self.state
                .session_models
                .read()
                .get(&spec.conversation_id)
                .filter(|s| !s.is_empty())
                .cloned()
        } else {
            None
        };
        let resolved = match spec
            .model_override
            .as_deref()
            .or(session_override.as_deref())
        {
            Some(id_or_name) => llm_registry.resolve_override(id_or_name)?,
            None => llm_registry.resolve_default()?,
        };
        // 模型级上下文窗口（>0）优先于全局设置；0 表示「用全局」。
        if resolved.context_window > 0 {
            agent_settings.context_window = resolved.context_window;
        }

        // ── 2.5 会话级思考强度（`reasoning_effort`，**仅主任务**）──
        // 档位字符串（low/medium/high/max 等）由用户在会话内选择，按
        // 「会话 × 模型」双维存于 `session_efforts`（内存）；任务启动时取
        // **该会话当前生效模型**的记忆（实时生效语义：正在运行的任务不受
        // 后续切换影响，只影响之后发起/继续的任务；切到别的模型用那个
        // 模型自己的记忆，切回原模型原档位仍在）。
        // - 主任务：查 (会话, 生效模型) 记忆；子任务**不继承**（调研子
        //   agent 只跟随自身模型默认，语义干净）。档位须在模型声明内才注入。
        let mut llm_config = resolved.config.clone();
        if spec.role == AgentRole::Main {
            let effort = self
                .state
                .session_efforts
                .read()
                .get(&spec.conversation_id)
                .and_then(|m| m.get(&resolved.model_id))
                .filter(|s| !s.is_empty())
                .cloned();
            if let Some(e) = effort {
                llm_config = apply_reasoning_effort(
                    llm_config,
                    &resolved.display_label,
                    &resolved.reasoning_efforts,
                    &e,
                );
                if let Some(v) = llm_config
                    .extra_body
                    .as_ref()
                    .and_then(|b| b.get("reasoning_effort"))
                    .and_then(|v| v.as_str())
                {
                    log::info!(
                        "Agent task {} 会话 {} 模型 {} 思考强度: {}",
                        spec.task_id,
                        spec.conversation_id,
                        resolved.model_id,
                        v
                    );
                }
            }
        }
        let llm_manager = LlmManager::new(llm_config)?;
        log::info!(
            "Agent task {} 使用模型: {} ({:?})",
            spec.task_id,
            resolved.display_label,
            spec.mode
        );

        // ── 3. 命令审核模型：显式审核槽位 > 本任务主模型（会话/最近使用）。
        //    旧实现 `resolve_slot("")` 会把空槽位解析成"全局默认模型"——与
        //    主任务模型可能不同（会话内选了 A、审核却走全局 B）。现在空槽位
        //    直接回落主模型 manager（tool_dispatcher 无独立配置时本就复用
        //    主模型），只有显式选了审核模型才切换。
        //    失败不炸任务：审核是辅助能力，回落主模型即可（与旧行为一致）。
        let approval_cfg = if agent_settings.enable_model_command_approval
            && !llm_registry.slots.model_approval_model_id.is_empty()
        {
            match llm_registry.resolve_model(&llm_registry.slots.model_approval_model_id) {
                Ok(mut r) => {
                    // 审批调用不带自由参数（extra_body 针对主对话模型调参）。
                    r.config.extra_body = None;
                    Some(r.config)
                }
                Err(e) => {
                    log::warn!("命令审核专用模型解析失败，回落主模型: {}", e);
                    None
                }
            }
        } else {
            None
        };

        // ── 3.5 Jev 审批引擎配置：只在「审批开启 + 引擎 = Jev」时读密钥链。
        //    读不到 Key **不炸任务**，也不静默回退成会话模型——`None` 交给
        //    `ToolDispatcher::build_jev_approver`，它照常构造审批者，
        //    每次 bash 都返回一句明确的「去设置填 Key」错误。静默回退会让用户
        //    以为自己受 Jev 保护，其实没有，比直接失败糟。
        //    重试/超时参数取全局 `NetPolicy` **本身**（不是抄一份字段），
        //    与 `build_resolved` 灌进 `LlmConfig` 的是同一份数据。
        let jev_cfg = if agent_settings.enable_model_command_approval
            && agent_settings.command_approval_engine == CommandApprovalEngine::Jev
        {
            match keychain::get_jev_api_key() {
                Ok(Some(key)) if !key.trim().is_empty() => Some(
                    JevConfig::new(
                        key,
                        agent_settings.jev_model_id.clone(),
                        llm_registry.net_policy.clone(),
                    )
                    // 空 = 保持官方地址（`with_base_url` 的语义是「空即不动」，
                    // 不是「空即清空」）。
                    .with_base_url(&agent_settings.jev_base_url),
                ),
                Ok(_) => {
                    log::warn!(
                        "命令审批引擎为 Jev，但密钥链里没有 TypeSafe API Key——审批调用会明确报错"
                    );
                    None
                }
                Err(e) => {
                    log::warn!("读取 TypeSafe API Key 失败: {}", e);
                    None
                }
            }
        } else {
            None
        };
        let plugin_registry_guard = self.state.plugin_registry.read().await;
        let registry = self
            .build_registry(
                &spec.role,
                &spec.mode,
                &enabled_skills,
                &enabled_mcp_servers,
                &experimental_settings,
                &plugin_registry_guard,
            )
            .await;
        let tools = build_definitions(&registry, &spec.mode);
        let plugin_sections = collect_plugin_sections(
            &plugin_registry_guard,
            &self.state.ssh_manager,
            &spec.session_id,
            &spec.mode,
        )
        .await;
        drop(plugin_registry_guard);

        // ── 4.5 多机操控：主任务注入机器清单段（子任务不注入——它们的
        //     目标机器由父任务经 subagent(host=...) 显式指定，系统提示已含约束）──
        let mut prompt_extra = spec.prompt_extra.clone();
        if spec.role == AgentRole::Main {
            if let Some(section) =
                crate::multi_host::build_prompt_section(&self.state, &spec.session_id).await
            {
                prompt_extra.push(section);
            }
        }

        // ── 5. 组装 messages（含角色约束段统一拼装） ──
        let messages = build_agent_messages(
            &TemplateManager,
            &spec.session_id,
            &tools,
            &spec.history,
            &spec.prompt,
            &agent_settings.system_prompt,
            &plugin_sections,
            matches!(spec.mode, AgentMode::Plan),
            audience_of(&spec.role),
            &prompt_extra,
        )?;

        // 子任务：冻结"父会话回读窗口"的上界 —— 派发这一刻父会话最后一条已落库
        // 消息（主 agent 此刻的上下文末尾）。子代理 `read_history(scope=parent)`
        // 靠它把可读范围钉死在"派发我之前"。记不下来就留 None：工具会明确报错，
        // 而不是把窗口放开成"不限上界"。
        let parent_history_upto: Option<String> = spec
            .role
            .parent_task_id()
            .and_then(|pid| {
                let tasks = self.state.agent_tasks.read();
                tasks.get(pid).map(|t| t.conversation_id.clone())
            })
            .and_then(|parent_conversation_id| {
                self.state
                    .conversation_db
                    .history_tail_anchor(&parent_conversation_id)
                    .ok()
                    .flatten()
            });

        // 所有可能失败的组装步骤完成后再提交运行态。spawn 返回 Err 时，
        // 不会留下前端拿不到 task_id、后端却永久视为 running 的幽灵任务。
        self.state.agent_tasks.write().insert(
            task_id.clone(),
            AgentTask {
                id: task_id.clone(),
                session_id: spec.session_id.clone(),
                conversation_id: spec.conversation_id.clone(),
                prompt: spec.prompt.clone(),
                mode: spec.mode.clone(),
                status: AgentStatus::Planning,
                has_plan: false,
                created_at: chrono::Utc::now(),
                parent_task_id: spec.role.parent_task_id().map(String::from),
                // 本任务实际使用的模型 id：子 agent 派发时据此继承父模型
                model_id: Some(resolved.model_id.clone()),
                // 回合锚点由 agent loop 开头 `begin_turn` 回填（那里才落库
                // user 消息）；此处先置空。
                turn_anchor_id: None,
                parent_history_upto,
            },
        );
        if spec.role == AgentRole::Main {
            self.restore_latest_plan(&task_id, &spec.conversation_id);
        }

        // ── 6. spawn + 生命周期 ──
        // 取消通道注册进统一表。guard 必须**活到任务结束**，所以它随下面
        // `tokio::spawn` 的 future 一起被捕获：在外面建、在外面 drop 的话，表里
        // 唯一的 sender 立刻消失，而 agent loop 把「通道关闭」也当成取消
        // （`llm/manager.rs` 的 `select!` 里 `rx.changed()` 的 Err 同样命中取消
        // 分支）—— 任务会在开跑前把自己取消掉。
        let cancel_registration = self.state.task_cancel.register(&task_id);

        // 组装期间用户点过停止（见 `request_cancel`）？认领这枚墓碑：任务收成
        // `Cancelled` 并置位取消信号，agent loop 第一轮开头就按取消退出——不发
        // 请求、不执行任何工具，收尾走 `TurnState::Cancelled`。
        //
        // 位置很讲究：必须在 `register` **之后**（信号要发给在册的那条通道，
        // 注册前 send 会因为表里没有接收端而丢），又不能靠把 `agent_tasks.insert`
        // 提前来实现（提交放最后是为了不留「前端拿不到 task_id、后端却永久
        // running」的幽灵任务，见上面的注释）。
        //
        // 两次取用分开写（不用 `||` 短路）：组装**期间**记下的那枚墓碑也必须
        // 被消费掉，否则它会留在表里，之后被同一 id 的另一次启动误领。
        let cancel_requested_during_spawn = take_pending_cancel(&task_id);
        if cancel_requested_before_spawn || cancel_requested_during_spawn {
            log::info!(
                "Agent task {} 在组装期间已被要求停止，注册取消表后立即收场",
                task_id
            );
            // 任务记录此刻已提交 → 走「在册」那条路（置取消态 + 发信号）。
            request_cancel(&self.state, &task_id);
        }

        let loop_ctx = LoopContext {
            ssh: self.state.ssh_manager.clone(),
            session_id: spec.session_id.clone(),
            app: app.clone(),
            state: self.state.clone(),
            registry,
            conversation_id: spec.conversation_id.clone(),
            conv_db: self.state.conversation_db.clone(),
            cancel_rx: cancel_registration.receiver(),
            config_dir: self.state.config_dir.clone(),
            is_subtask: spec.role.is_subtask(),
            prompt_origin: spec.prompt_origin,
        };

        let state_cleanup = self.state.clone();
        let task_id_owned = task_id.clone();
        let mode_owned = spec.mode.clone();
        let approval_mode_owned = spec.approval_mode.clone();
        let join = tokio::spawn(async move {
            // 持有注册凭据 = 任务尚未结束；Drop 即从取消表注销（原先由
            // `finalize_task` 手写 `cancel_senders.remove`，现在由类型保证）。
            let _cancel_registration = cancel_registration;
            // catch_unwind：无论 run_agent_loop 内部是否 panic，终态更新与
            // 取消清理都保证执行（此前主任务丢弃 JoinHandle，panic 时泄漏）。
            let result = std::panic::AssertUnwindSafe(run_agent_loop(
                task_id_owned.clone(),
                llm_manager,
                messages,
                tools,
                mode_owned,
                approval_mode_owned,
                agent_settings,
                approval_cfg,
                jev_cfg,
                loop_ctx,
            ))
            .catch_unwind()
            .await;
            let result = match result {
                Ok(r) => r,
                Err(e) => {
                    log::error!("agent task {} panicked: {:?}", task_id_owned, e);
                    None
                }
            };
            if let Some(turn_state) = finalize_task(&state_cleanup, &task_id_owned, &result) {
                log::info!(
                    "Agent task {} 收尾状态: {}",
                    task_id_owned,
                    turn_state.as_str()
                );
            }
            prune_terminal_tasks(&state_cleanup, 200);
            result
        });

        log::info!("Agent task started: {} ({:?})", task_id, spec.mode);
        Ok(AgentTaskHandle { task_id, join })
    }

    /// 按模式派生工具集（含插件/MCP 注册）。
    async fn build_registry(
        &self,
        role: &AgentRole,
        mode: &AgentMode,
        enabled_skills: &[crate::skills::store::Skill],
        enabled_mcp_servers: &[McpServerConfig],
        experimental_settings: &ExperimentalSettings,
        plugin_registry: &PluginRegistry,
    ) -> Arc<ToolRegistry> {
        match mode {
            AgentMode::Plan => Arc::new(build_plan_registry(
                role,
                enabled_skills,
                experimental_settings,
            )),
            AgentMode::Agent | AgentMode::Auto => {
                let mut registry = ToolRegistry::build_mut_for_mode(
                    audience_of(role),
                    enabled_skills,
                    experimental_settings,
                );
                // 子 agent 只携带核心读写工具，不加载插件生态，也不去刷新 MCP
                // server（省一次无谓连接）—— 与只读 Plan 子 agent 一致，提示词里
                // 的工具列表不会说谎。主任务（role=Main）插件/MCP 全套保留。
                //
                // 「子 agent 没有 subagent / plan 三件套」这一条不在本处删减：
                // 它由工具声明表的 `ToolRoles::MainOnly` 表达，见
                // `tools/mod.rs` 的 `BUILTIN_TOOLS_COMMON`。
                if !role.is_subtask() {
                    let manifests = plugin_registry.enabled_manifests();
                    for m in &manifests {
                        register_plugin_tools(
                            &mut registry,
                            &m.id,
                            &m.capabilities,
                            &m.agent_tools,
                        );
                    }
                    let mut set = tokio::task::JoinSet::new();
                    for server in enabled_mcp_servers {
                        let mgr = self.state.mcp_manager.clone();
                        let server = server.clone();
                        set.spawn(async move {
                            let result = mgr.refresh_tools(&server).await;
                            (server, result)
                        });
                    }
                    while let Some(result) = set.join_next().await {
                        match result {
                            Ok((server, Ok(tools))) => {
                                register_mcp_tools(&mut registry, &server, tools)
                            }
                            Ok((server, Err(err))) => {
                                log::warn!("刷新 MCP tools 失败 [{}]: {}", server.name, err)
                            }
                            Err(join_err) => log::warn!("MCP 刷新任务 panic: {}", join_err),
                        }
                    }
                }
                Arc::new(registry)
            }
        }
    }

    /// 主任务：从 SQLite 恢复该 conversation 最近一条 plan 挂到新 task。
    fn restore_latest_plan(&self, task_id: &str, conversation_id: &str) {
        if self.state.plans.read().get(task_id).is_some() {
            return;
        }
        match self
            .state
            .conversation_db
            .load_latest_plan_by_conversation(conversation_id)
        {
            Ok(Some(plan_json)) => match serde_json::from_str::<AgentTaskPlan>(&plan_json) {
                Ok(mut plan) => {
                    plan.task_id = task_id.to_string();
                    self.state.plans.write().insert(task_id.to_string(), plan);
                    if let Some(task) = self.state.agent_tasks.write().get_mut(task_id) {
                        task.has_plan = true;
                    }
                    log::info!(
                        "Restored plan for new task {} from conversation {}",
                        task_id,
                        conversation_id
                    );
                }
                Err(e) => {
                    log::warn!(
                        "Failed to deserialize plan for conversation {}: {}",
                        conversation_id,
                        e
                    );
                }
            },
            Ok(None) => {}
            Err(e) => {
                log::warn!(
                    "Failed to load latest plan for conversation {}: {}",
                    conversation_id,
                    e
                );
            }
        }
    }
}

// ── 私有组装辅助 ──

/// 按角色构建 Plan 模式工具集。
///
/// `AgentRole` 是 manager 的概念，`ToolAudience` 是工具层的概念；这里做一次映射，
/// 免得 `tools` 反向依赖 manager（子 agent 的工具收敛规则本身写在声明表的
/// `ToolRoles` 里，不在这里删减）。
///
/// 抽成自由函数便于单测，避免为 `build_registry` 私有方法构造整个 `AppState`。
fn build_plan_registry(
    role: &AgentRole,
    enabled_skills: &[crate::skills::store::Skill],
    experimental_settings: &ExperimentalSettings,
) -> ToolRegistry {
    ToolRegistry::build_for_plan_mode(audience_of(role), enabled_skills, experimental_settings)
}

/// `AgentRole` → 工具层可见性角色。
fn audience_of(role: &AgentRole) -> crate::agent::tools::ToolAudience {
    if role.is_subtask() {
        crate::agent::tools::ToolAudience::Sub
    } else {
        crate::agent::tools::ToolAudience::Main
    }
}

fn build_definitions(registry: &Arc<ToolRegistry>, mode: &AgentMode) -> Vec<ToolDefinition> {
    match mode {
        AgentMode::Plan | AgentMode::Agent | AgentMode::Auto => registry
            .definitions()
            .into_iter()
            .map(|d| ToolDefinition {
                name: d.name,
                description: d.description,
                parameters: d.parameters,
            })
            .collect(),
    }
}

/// 按会话状态过滤「该下发的工具清单」：`has_readable_history` 为假时去掉
/// [`crate::agent::tools::STATE_GATED_TOOLS`] 里的工具。
///
/// 为什么是过滤而不是在注册表里不注册：注册表在任务启动时全量构建、整任务共用，
/// 而"这个会话有没有读不到的东西"会随压缩**在任务中途翻转**。所以
/// - `spawn` 交给循环的必须是**未过滤**的清单（循环每轮自己再过滤一次，
///   否则第 0 轮就少了那个工具、之后再也加不回来——过滤只能删不能加）；
/// - 循环在**每次发请求前**问一次状态；压缩这一步本身用的仍是压缩前那一刻的
///   清单（摘要要解释的是压缩**之前**那段历史里的工具调用）。
///
/// "只增不减"由判据的单调性保证（见 `ConversationDb::has_readable_history`）。
/// 判据算不出来时调用方按"宁可早给"传 `true`：少给一次工具会让模型失去一个它
/// 需要的能力，比多付一份说明严重得多。
pub(crate) fn apply_state_gate(
    mut defs: Vec<ToolDefinition>,
    has_readable_history: bool,
) -> Vec<ToolDefinition> {
    if has_readable_history {
        return defs;
    }
    defs.retain(|d| !crate::agent::tools::STATE_GATED_TOOLS.contains(&d.name.as_str()));
    defs
}

/// 某一轮请求该下发的工具清单：在未门控的 `base` 上按会话当前状态过一遍门控。
///
/// 这是循环每轮实际调用的那一步，单独抽出来是为了能直接用真实的会话库测它——
/// 判据、过滤、以及"子代理恒有"这三件事的**组合**只有在同一个函数里才可测。
///
/// `is_subtask` 恒为 `true`：子代理读主 agent 派发时刻的上下文，跟父会话压不压缩
/// 无关，这个能力对它有用于第一轮。
pub(crate) fn tools_for_round(
    base: &[ToolDefinition],
    is_subtask: bool,
    conv_db: &crate::agent::conversation::ConversationDb,
    conversation_id: &str,
) -> Vec<ToolDefinition> {
    let expose = is_subtask || conv_db.has_readable_history(conversation_id).unwrap_or(true);
    apply_state_gate(base.to_vec(), expose)
}

/// 把会话级思考强度注入 LLM 配置（纯函数，便于单测）。
///
/// 语义：
/// - `session_effort` 须在模型声明的 `declared` 内才注入；否则**原样返回**
///   config（不注入、不改动已有 extra_body），只记 warn。
/// - 注入方式：把 `reasoning_effort` 键写入 `config.extra_body` 顶层对象
///   （openai.rs 构建请求体时把 extra_body 合并进请求体顶层，等效顶层字段）。
///   若模型已有非对象 extra_body（异常数据）则保留原样返回，不污染。
pub(crate) fn apply_reasoning_effort(
    config: LlmConfig,
    model_label: &str,
    declared: &[String],
    session_effort: &str,
) -> LlmConfig {
    let effort = session_effort.trim();
    if effort.is_empty() {
        return config;
    }
    if !declared.iter().any(|x| x == effort) {
        log::warn!(
            "会话思考强度档位 \"{}\" 不在模型 \"{}\" 声明内（{:?}），已忽略",
            effort,
            model_label,
            declared
        );
        return config;
    }
    let Some(mut extra) = config.extra_body.clone() else {
        let mut obj = serde_json::Map::new();
        obj.insert(
            "reasoning_effort".to_string(),
            serde_json::Value::String(effort.to_string()),
        );
        let mut next = config;
        next.extra_body = Some(serde_json::Value::Object(obj));
        return next;
    };
    match extra.as_object_mut() {
        Some(obj) => {
            obj.insert(
                "reasoning_effort".to_string(),
                serde_json::Value::String(effort.to_string()),
            );
            let mut next = config;
            next.extra_body = Some(extra);
            next
        }
        None => {
            log::warn!(
                "模型 {} 的 extra_body 非 JSON 对象，无法注入 reasoning_effort={}",
                model_label,
                effort
            );
            config
        }
    }
}

fn apply_section_context_variables(
    s: &str,
    info: Option<&SessionInfo>,
    session_id: &str,
) -> String {
    match info {
        Some(i) => apply_to_string(s, &SessionContext::from_session(i, session_id)),
        None => {
            log::warn!("无法获取会话上下文，systemPromptSection 中的上下文变量替换为空字符串");
            apply_to_string(s, &SessionContext::empty(session_id))
        }
    }
}

async fn collect_plugin_sections(
    registry: &PluginRegistry,
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    mode: &AgentMode,
) -> Vec<String> {
    if matches!(mode, AgentMode::Plan) {
        return Vec::new();
    }
    let session_info = ssh.get_session_info(session_id).await;
    let mut sections = Vec::new();
    for entry in registry.enabled_manifests() {
        if entry.system_prompt_section.is_none() {
            continue;
        }
        let content = match registry.section_for(&entry.id) {
            Some(c) => c.to_string(),
            None => continue,
        };
        let substituted =
            apply_section_context_variables(&content, session_info.as_ref(), session_id);
        let char_count = substituted.chars().count();
        let truncated: String = if char_count > PLUGIN_SECTION_MAX_CHARS {
            log::warn!(
                "插件 {} systemPromptSection 超过 {} 字符（{}），已截断",
                entry.id,
                PLUGIN_SECTION_MAX_CHARS,
                char_count
            );
            substituted.chars().take(PLUGIN_SECTION_MAX_CHARS).collect()
        } else {
            substituted
        };
        sections.push(truncated);
    }
    sections
}

fn build_agent_messages(
    template_manager: &TemplateManager,
    session_id: &str,
    tools: &[ToolDefinition],
    history: &[LlmMessage],
    prompt: &str,
    agent_system_prompt: &str,
    plugin_sections: &[String],
    plan_mode: bool,
    audience: crate::agent::tools::ToolAudience,
    extra_sections: &[String],
) -> Result<Vec<LlmMessage>, AppError> {
    // 提示词段由「已注册工具的声明」推导，不按工具名 hardcode：
    // 声明表里给工具写了 `prompt_section`，它出现在本次注册里就会带上对应段落。
    let tool_sections: std::collections::BTreeSet<crate::agent::tools::PromptSection> = tools
        .iter()
        .filter_map(|t| crate::agent::tools::prompt_section_of(&t.name))
        .collect();
    // skills 是动态注册的工具（`skill_<id>`），不在声明表里，只能按前缀判断。
    let has_skills = tools.iter().any(|t| {
        t.name
            .starts_with(crate::agent::tools::skill::SKILL_TOOL_PREFIX)
    });
    let system_prompt = build_system_prompt(
        template_manager,
        session_id,
        has_skills,
        &tool_sections,
        agent_system_prompt,
        plugin_sections,
        plan_mode,
        audience,
        extra_sections,
    )?;
    let mut messages: Vec<LlmMessage> = Vec::with_capacity(history.len() + 2);
    messages.push(LlmMessage::system(system_prompt));
    for msg in history {
        if msg.role == LlmRole::System {
            continue;
        }
        messages.push(msg.clone());
    }
    if !messages
        .last()
        .map_or(false, |m| m.role == LlmRole::User && m.content == prompt)
    {
        messages.push(LlmMessage::user(prompt.to_string()));
    }
    Ok(messages)
}

/// 统一的任务收尾：更新终态 + **记录回合收尾状态** + 清理作业结算通道 +
/// 级联清理子资源。
/// （取消表的注销不在这里：由 spawned future 持有的 `Registration` 在 Drop 时
/// 完成，见 `spawn` 里的注释。）
/// 停止路径已置 Cancelled 则保留；自然结束=Completed，其余（LLM 失败 /
/// 达最大轮数 / panic）=Failed。
///
/// 返回本回合的收尾状态（`TurnState`）——它是「这一轮到底怎么停的」的唯一
/// 记录点：写在回合锚点行（agent loop 开头 `begin_turn` 标成 running 的那行）
/// 上，回合折叠据此决定要不要把过程收起来（只有 `Completed` 才收）。
/// 任务记录已被剪掉 / 锚点缺失 / 写库失败都不影响任务终态与界面：返回 None。
fn finalize_task(state: &AppState, task_id: &str, result: &Option<String>) -> Option<TurnState> {
    // 任务记录已被剪枝（只可能发生在本函数之外的清理竞态）时也要走完下面的
    // 通道清理与级联回收 —— 所以这里只把「写库要用的三样东西」取出来，
    // 不用 `?` 提前返回。
    let resolved = {
        let mut tasks = state.agent_tasks.write();
        match tasks.get_mut(task_id) {
            Some(task) => {
                // 吸收规则在 `AgentTask::transition_to` 里（Cancelled 不接受后续写入）。
                task.transition_to(if result.is_some() {
                    AgentStatus::Completed
                } else {
                    AgentStatus::Failed
                });
                // 写入之后**按真实状态**定档：停止命令先置 Cancelled，上面那次
                // 写入可能被吸收掉，问返回值会把「用户停止」误判成完成/失败。
                Some((
                    TurnState::from_status(&task.status),
                    task.conversation_id.clone(),
                    task.turn_anchor_id.clone(),
                ))
            }
            None => None,
        }
    };

    let turn_state = match resolved {
        Some((turn, conversation_id, anchor_id)) => {
            match anchor_id {
                Some(anchor_id) => {
                    ConversationPersister::new(state.conversation_db.clone(), conversation_id)
                        .end_turn(&anchor_id, turn)
                }
                None => log::debug!(
                    "任务 {} 没有回合锚点（未落库 user 消息），跳过收尾状态写入",
                    task_id
                ),
            }
            Some(turn)
        }
        None => None,
    };
    // 多机操控：任务终态关闭该任务自动拉起的全部目标会话（只在任务记账
    // 集合内，用户手动打开的会话绝不受影响）。异步 fire-and-forget——
    // 清理不阻塞任务收尾，且 spawn 里 catch_unwind 之外安全。
    //
    // **还有作业在跑的会话先留着**（对齐「作业活得比回合久」）：关掉它会连坐
    // 杀掉作业（断连观察者会取消该会话上所有执行，见 command_exec 的断连
    // 级联），而那些作业本来就该跑到结算、再由唤醒把结果交回模型。留下的
    // 会话仍在记账表里，由末条作业结算时的回收钩子取走
    // （`command_exec::set_task_drain_hook`，lib.rs 接线）。
    let mh_state = state.clone();
    let mh_task = task_id.to_string();
    tokio::spawn(async move {
        let busy_sessions: std::collections::HashSet<String> = mh_state
            .command_exec
            .running_jobs_for_task(&mh_task)
            .await
            .into_iter()
            .map(|job| job.session_id)
            .collect();
        crate::multi_host::cleanup_task_targets_except(&mh_state, &mh_task, &busy_sessions).await;
        // Agent 传输级联取消：任务终态取消其名下仍进行的传输（只取消
        // 传输本身；进行中的传输收到 cancel 后自行清理 .part/sidecar）。
        crate::agent::transfer::cancel_task_transfers(&mh_state, &mh_task).await;
    });
    turn_state
}

fn prune_terminal_tasks(state: &AppState, max_terminal: usize) {
    let mut tasks = state.agent_tasks.write();
    let mut terminal: Vec<(String, chrono::DateTime<chrono::Utc>)> = tasks
        .iter()
        .filter(|(_, task)| task.status.is_terminal())
        .map(|(id, task)| (id.clone(), task.created_at))
        .collect();
    if terminal.len() <= max_terminal {
        return;
    }
    terminal.sort_by_key(|(_, created_at)| *created_at);
    let remove_count = terminal.len() - max_terminal;
    let remove_ids: Vec<String> = terminal
        .into_iter()
        .take(remove_count)
        .map(|(task_id, _)| task_id)
        .collect();
    for task_id in &remove_ids {
        tasks.remove(task_id);
    }
    drop(tasks);
    let mut plans = state.plans.write();
    for task_id in &remove_ids {
        plans.remove(task_id);
    }
    drop(plans);
    // 子资源记账的收尾标记与 owner 同生命周期：任务记录都剪掉了，标记留着只会
    // 无限增长（而且 task_id 一旦被复用，旧标记会让新任务注册不上子资源）。
    // 本函数是同步的，而记账表用的是 tokio 锁 —— 照 finalize_task 的做法
    // fire-and-forget（剪枝不因这次清理而阻塞）。
    //
    // **顺序要紧：先清理、后遗忘**。`finalize_task` 的清理是另一次 fire-and-forget
    // spawn，tokio 不保证两次 spawn 的先后；如果先遗忘，`forget_owner` 会把还没被
    // 取走的子资源连同收尾标记一起删掉，随后晚到的 `take_all` 拿到空集 ——
    // 自动拉起的会话再也不会被断开、在册传输再也不会被取消（实测复现率约 1/300）。
    // 这里同一个 async 块内顺序 await 是有保证的，而对已清理过的 id 是幂等空操作。
    let prune_state = state.clone();
    tokio::spawn(async move {
        for task_id in &remove_ids {
            crate::multi_host::cleanup_task_targets(&prune_state, task_id).await;
            crate::agent::transfer::cancel_task_transfers(&prune_state, task_id).await;
            // 走到这里表项应当已空；非空 = 清理没跑到（或没取到），
            // 那些子资源此刻无人回收 —— 不许静默。
            let leftover_targets = prune_state.multi_host_targets.forget_owner(task_id).await;
            let leftover_transfers = prune_state.agent_transfer_by_task.forget_owner(task_id).await;
            if !leftover_targets.is_empty() || !leftover_transfers.is_empty() {
                log::warn!(
                    "任务 {} 记录剪枝时仍残留子资源（多机会话 {:?}／传输 {:?}）—— 清理未完成，这些资源已无人回收",
                    task_id,
                    leftover_targets,
                    leftover_transfers
                );
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::settings::ExperimentalSettings;

    fn exp() -> ExperimentalSettings {
        ExperimentalSettings::default()
    }

    fn make_task(id: &str) -> AgentTask {
        AgentTask {
            id: id.to_string(),
            session_id: "s1".to_string(),
            conversation_id: "c1".to_string(),
            prompt: "p".to_string(),
            mode: AgentMode::Agent,
            status: AgentStatus::Planning,
            has_plan: false,
            created_at: chrono::Utc::now(),
            parent_task_id: None,
            model_id: None,
            turn_anchor_id: None,
            parent_history_upto: None,
        }
    }

    /// 墓碑表是进程级的，测试各用唯一 id 互不干扰。
    fn unique_id(tag: &str) -> String {
        format!("test-{tag}-{}", uuid::Uuid::new_v4())
    }

    /// 「组装期间收到的停止」不能丢：记下之后必须能被 `spawn` 侧取走，且取走是
    /// **一次性**的（同一个 id 被重复认领会把后来的任务莫名其妙地取消掉）。
    #[test]
    fn pending_cancel_is_recorded_and_claimed_once() {
        let id = unique_id("tomb");
        assert!(!take_pending_cancel(&id), "没请求过就不该命中");
        record_pending_cancel(&id);
        assert!(take_pending_cancel(&id), "组装期间收到的停止必须能被认领");
        assert!(!take_pending_cancel(&id), "认领是一次性的");
    }

    #[test]
    fn pending_cancel_dedupes_same_task_and_isolates_others() {
        let (a, b) = (unique_id("a"), unique_id("b"));
        record_pending_cancel(&a);
        record_pending_cancel(&a); // 重复请求只是重复置位
        record_pending_cancel(&b);
        assert!(take_pending_cancel(&b));
        assert!(take_pending_cancel(&a), "重复请求不应把墓碑自己顶掉");
        assert!(!take_pending_cancel(&b), "不同 task 的请求互不干扰");
    }

    /// 过期墓碑（对应的启动再也没来）必须被清理，否则 task_id 一旦被复用，
    /// 新任务会带着一枚旧墓碑起来，开场即被取消。
    #[test]
    fn expired_pending_cancel_is_dropped() {
        let id = unique_id("expired");
        {
            let mut table = pending_cancels().lock().unwrap_or_else(|e| e.into_inner());
            table.push_back((
                id.clone(),
                Instant::now() - PENDING_CANCEL_TTL - std::time::Duration::from_secs(1),
            ));
        }
        assert!(!take_pending_cancel(&id), "过期墓碑不该再被认领");
        assert!(
            !pending_cancels()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .iter()
                .any(|(i, _)| i == &id),
            "清理应把过期条目摘掉（不能无限堆积）"
        );
    }

    /// 认领时该做两件事：把任务收成 `Cancelled`（最终显示「已停止」而不是
    /// 完成/失败），并把取消信号发给**在册**的那条通道（agent loop 只在信号上
    /// 中断进行中的 LLM 调用）。少做任何一件，用户点下的停止都会退化成
    /// 「任务照常在后台跑完」。
    #[test]
    fn applying_pending_cancel_marks_cancelled_and_signals() {
        let id = unique_id("apply");
        let tasks =
            std::sync::Arc::new(PlRwLock::new(HashMap::from([(id.clone(), make_task(&id))])));
        let cancel = crate::cancel::CancellationRegistry::new();
        // spawn 在认领之前已经注册：接收端必须拿得到这次信号
        let registration = cancel.register(&id);
        let rx = registration.receiver();
        assert!(!*rx.borrow(), "认领之前不该有取消信号");

        apply_pending_cancel(&tasks, &cancel, &id);
        assert!(
            tasks.read().get(&id).unwrap().status.is_cancelled(),
            "任务必须收成 Cancelled（收尾据此把回合标成 cancelled、不再走 Completed）"
        );
        assert!(*rx.borrow(), "取消信号必须发给在册通道");
    }

    /// 任务记录已被剪掉（只可能发生在清理竞态里）时不炸：没有状态可写，
    /// 但已有注册的取消信号仍要发出去。
    #[test]
    fn applying_pending_cancel_tolerates_missing_task_record() {
        let id = unique_id("ghost");
        let tasks = std::sync::Arc::new(PlRwLock::new(HashMap::new()));
        let cancel = crate::cancel::CancellationRegistry::new();
        let registration = cancel.register(&id);
        let rx = registration.receiver();

        apply_pending_cancel(&tasks, &cancel, &id);
        assert!(tasks.read().get(&id).is_none());
        assert!(*rx.borrow(), "记录没了也要把取消信号发出去");
    }

    /// 状态门控只做一件事：判据为假时摘掉 [`STATE_GATED_TOOLS`] 里的工具，别的
    /// 一个都不动；判据为真时原样返回（这是"只增不减"能成立的一半）。
    #[test]
    fn state_gate_removes_only_gated_tools() {
        let def = |name: &str| ToolDefinition {
            name: name.to_string(),
            description: "d".to_string(),
            parameters: serde_json::json!({ "type": "object" }),
        };
        let all = vec![def("bash"), def("read_history"), def("read_file")];

        let gated: Vec<String> = apply_state_gate(all.clone(), false)
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(gated, vec!["bash", "read_file"], "只该摘掉被门控的那一个");

        let open = apply_state_gate(all.clone(), true);
        assert_eq!(open.len(), all.len(), "判据为真时不该动清单");
    }

    /// 循环每轮实际调用的那一步的组合行为：新会话不给、压缩过或派发过子对话才给、
    /// 子代理恒给。这三件事只有放在同一个函数里才能这样一次测完。
    #[test]
    fn tools_for_round_gates_read_history_by_conversation_state() {
        use crate::agent::conversation::ConversationDb;
        use crate::agent::conversation_persister::COMPACTION_CARD_PREFIX;

        let def = |name: &str| ToolDefinition {
            name: name.to_string(),
            description: "d".to_string(),
            parameters: serde_json::json!({ "type": "object" }),
        };
        let base = vec![def("bash"), def("read_history")];
        let names = |v: Vec<ToolDefinition>| -> Vec<String> {
            v.into_iter().map(|d| d.name).collect()
        };

        let db = ConversationDb::in_memory().expect("db");
        let fresh = db.create_conversation("conn_1", "fresh").expect("fresh");

        // 全新会话：没有任何读不到的东西 ⇒ 不给（这正是要治的那种会话）
        assert_eq!(
            names(tools_for_round(&base, false, &db, &fresh.id)),
            vec!["bash"]
        );

        // 子代理恒给：它读主 agent 派发时刻的上下文，与父会话压不压缩无关
        assert_eq!(
            names(tools_for_round(&base, true, &db, &fresh.id)),
            vec!["bash", "read_history"]
        );

        // 派发过子对话 ⇒ 给（主 agent 要能核对子代理的过程）
        let child = db
            .create_sub_conversation("conn_1", "查磁盘", &fresh.id)
            .expect("child");
        assert_eq!(
            names(tools_for_round(&base, false, &db, &fresh.id)),
            vec!["bash", "read_history"]
        );
        db.delete_conversation(&child.id).expect("delete child");

        // 压缩过 ⇒ 给。归档卡按内容前缀认，这里直接落一行卡验判据
        db.save_message(
            &fresh.id,
            "system",
            &format!("{COMPACTION_CARD_PREFIX}已整理 3 条历史消息（约 100 tokens）"),
            "2026-01-02T00:00:00Z",
            None,
            None,
        )
        .expect("card");
        assert_eq!(
            names(tools_for_round(&base, false, &db, &fresh.id)),
            vec!["bash", "read_history"]
        );
    }

    #[test]
    fn plan_main_agent_gets_task_tool() {
        let registry = build_plan_registry(&AgentRole::Main, &[], &exp());
        assert!(
            registry.get("subagent").is_some(),
            "顶层 Plan agent 应注册 subagent 子agent 工具"
        );
    }

    #[test]
    fn plan_sub_agent_does_not_get_task_tool() {
        let registry = build_plan_registry(
            &AgentRole::Sub {
                parent_task_id: "parent-1".to_string(),
            },
            &[],
            &exp(),
        );
        assert!(
            registry.get("subagent").is_none(),
            "子agent（Plan 只读）不应注册 subagent 工具，保证子agent 不派发子agent"
        );
    }

    #[test]
    fn plan_registry_keeps_read_only_tools() {
        let registry = build_plan_registry(&AgentRole::Main, &[], &exp());
        assert!(registry.get("read_file").is_some());
        assert!(registry.get("search_files").is_some());
        assert!(registry.get("bash").is_some());
        // Plan 模式仍不含写/改工具
        assert!(registry.get("write_file").is_none());
        assert!(registry.get("edit_file").is_none());
    }

    /// 读写执行子 agent（Agent/Auto + Sub）拿不到任何编排工具。
    ///
    /// 这条规则现在由工具声明表的 `ToolRoles::MainOnly` 表达（见
    /// `tools/mod.rs` 的 `BUILTIN_TOOLS_COMMON`），不再「先注册全套、再按名字删」，
    /// 所以这里直接断言「以 Sub 身份构建出来的 registry」。
    #[test]
    fn sub_agent_registry_lacks_orchestration_tools() {
        use crate::agent::tools::{ToolAudience, ToolRegistry};
        let registry = ToolRegistry::build_mut_for_mode(ToolAudience::Sub, &[], &exp());
        for name in ["subagent", "create_plan", "update_plan_item", "edit_plan"] {
            assert!(registry.get(name).is_none(), "读写子agent 不应有 {}", name);
        }
        // 读写核心工具保留
        for name in ["bash", "write_file", "edit_file", "read_file"] {
            assert!(registry.get(name).is_some(), "读写子agent 应保留 {}", name);
        }
        // 桌面专属的本机文件系统工具同样保留（子 agent 也在桌面跑）。
        #[cfg(desktop)]
        for name in ["upload_file", "download_file"] {
            assert!(registry.get(name).is_some(), "读写子agent 应保留 {}", name);
        }
    }

    #[test]
    fn main_agent_registry_keeps_orchestration_tools() {
        use crate::agent::tools::{ToolAudience, ToolRegistry};
        let r = ToolRegistry::build_mut_for_mode(ToolAudience::Main, &[], &exp());
        for name in ["subagent", "create_plan", "bash", "write_file"] {
            assert!(r.get(name).is_some(), "主任务应保留 {}", name);
        }
    }

    fn base_cfg() -> LlmConfig {
        let mut c = LlmConfig::default();
        c.extra_body = None;
        c
    }

    fn declared(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn apply_effort_injects_top_level_when_declared() {
        let cfg =
            apply_reasoning_effort(base_cfg(), "ds", &declared(&["low", "high", "max"]), "high");
        let extra = cfg.extra_body.expect("extra_body set");
        assert_eq!(
            extra.get("reasoning_effort").and_then(|v| v.as_str()),
            Some("high")
        );
    }

    #[test]
    fn apply_effort_merges_into_existing_extra_body() {
        let mut c = base_cfg();
        c.extra_body = Some(serde_json::json!({ "thinking": { "type": "enabled" } }));
        let cfg = apply_reasoning_effort(c, "ds", &declared(&["low", "high"]), "low");
        let extra = cfg.extra_body.expect("extra_body set");
        assert_eq!(
            extra.get("reasoning_effort").and_then(|v| v.as_str()),
            Some("low")
        );
        // 既有 thinking 键保留
        assert_eq!(
            extra
                .get("thinking")
                .and_then(|v| v.get("type"))
                .and_then(|v| v.as_str()),
            Some("enabled")
        );
    }

    #[test]
    fn apply_effort_ignores_undeclared_or_empty() {
        // 未声明档位：原样返回（不注入、不 panic）
        let cfg = apply_reasoning_effort(base_cfg(), "gpt", &declared(&[]), "high");
        assert!(cfg.extra_body.is_none());
        // 声明内不包含该档位
        let cfg = apply_reasoning_effort(base_cfg(), "ds", &declared(&["low"]), "max");
        assert!(cfg.extra_body.is_none());
        // 空档位
        let cfg = apply_reasoning_effort(base_cfg(), "ds", &declared(&["low"]), "  ");
        assert!(cfg.extra_body.is_none());
    }

    #[test]
    fn apply_effort_keeps_non_object_extra_body_untouched() {
        let mut c = base_cfg();
        c.extra_body = Some(serde_json::json!([1, 2, 3]));
        let cfg = apply_reasoning_effort(c, "odd", &declared(&["low"]), "low");
        // 异常数据不注入也不破坏
        assert_eq!(cfg.extra_body, Some(serde_json::json!([1, 2, 3])));
    }
}
