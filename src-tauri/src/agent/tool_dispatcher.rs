use serde::Serialize;

use crate::agent::approval::ApprovalManager;
use crate::agent::jev_approval::JevApprover;
use crate::agent::model_approval::{
    ApprovalJudgement, CommandApprover, ModelApprovalDecision, ModelApprover,
};
use crate::agent::risk::{split_command_chain, Disposition, RiskAssessor, SecurityPolicy};
use crate::agent::task::AgentMode;
use crate::agent::tools::sftp_probe::remote_file_exists;
use crate::agent::tools::{
    AgentTool, PathWrite, ToolContext, ToolOutput, ToolRegistry, ToolSemantics,
};
use crate::config::settings::{AgentModeSettings, CommandApprovalEngine, CommandListMode};
use crate::emit_event;
use crate::error::AppError;
use crate::llm::jev::JevConfig;
use crate::llm::manager::LlmManager;
use crate::llm::provider::{LlmConfig, LlmMessage, ToolCall};
use crate::llm::registry::NetPolicy;
use crate::AppState;

/// Event containing a tool call result, sent to the frontend.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ToolResultEvent {
    #[serde(rename = "type")]
    pub event_type: String,
    pub tool_call_id: String,
    pub tool_name: String,
    pub arguments: serde_json::Value,
    pub summary: String,
    pub result: String,
    pub success: bool,
    pub blocked: bool,
    pub was_timeout: bool,
    #[serde(default)]
    pub was_aborted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// Event emitted when model-based approval check starts.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelApprovalStartEvent {
    #[serde(rename = "type")]
    event_type: String,
    tool_call_id: String,
}

/// Event emitted when model-based approval check completes.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ModelApprovalDoneEvent {
    #[serde(rename = "type")]
    event_type: String,
    tool_call_id: String,
    /// "approve" | "route_to_human" | "block" | "error"
    decision: String,
    reasons: Vec<String>,
    /// 产出这次判定的引擎：`"model"` | `"jev"`。`None` = 判定失败，没有引擎信息。
    /// 前端据此在审批弹窗上标注「Jev 判定」，让用户知道自己在依赖谁。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    engine: Option<String>,
    /// 模型对自己这次判定的把握（0–1）。**只有 Jev 会给出**（chat 引擎恒为 `None`）。
    ///
    /// ⚠️ 官方定义是「概率分布的集中程度」，不是「判定正确的概率」，也不构成
    /// 执行许可。前端展示时必须按这个口径措辞，否则会误导用户。
    /// 它不参与任何判定分支——低置信度不会改变 approve/route_to_human/block。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    confidence: Option<f32>,
}

/// Result of executing a single tool call (UI/event view).
pub(crate) struct DispatchResult {
    pub summary: String,
    pub output: String,
    pub success: bool,
    pub blocked: bool,
    pub was_timeout: bool,
    pub was_aborted: bool,
    pub metadata: Option<serde_json::Value>,
    pub disposition: Disposition,
}

impl DispatchResult {
    fn from_tool_output(o: ToolOutput, disposition: Disposition) -> Self {
        let was_timeout = o
            .metadata
            .as_ref()
            .and_then(|m| m.get("was_timeout"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        Self {
            summary: o.summary,
            output: o.output,
            success: o.success,
            blocked: false,
            was_timeout,
            was_aborted: false,
            metadata: o.metadata,
            disposition,
        }
    }
    fn blocked(
        summary: impl Into<String>,
        reason: impl Into<String>,
        disposition: Disposition,
    ) -> Self {
        Self {
            summary: summary.into(),
            output: format!("BLOCKED: {}", reason.into()),
            success: false,
            blocked: true,
            was_timeout: false,
            was_aborted: false,
            metadata: None,
            disposition,
        }
    }
    fn unknown(name: &str) -> Self {
        Self {
            summary: format!("{} (not found)", name),
            output: format!("没有这个tool: {}", name),
            success: false,
            blocked: false,
            was_timeout: false,
            was_aborted: false,
            metadata: None,
            disposition: Disposition::Approval,
        }
    }
}

/// 审批者构造失败时的替身：**每条命令都明确报错**，绝不无声放行。
///
/// 与「选了 Jev 却没配 Key」同一处理哲学（见 `build_jev_approver`）：那种情况下
/// `JevApprover::evaluate` 也是直接 `Err`，让 `dispatch` 把命令拦下、把原因回给
/// 用户与模型。构造失败（HTTP 客户端建不起来）同样不能变成"没有审批"——
/// `dispatch` 里 `if let Some(ref approver)` 一旦拿不到 approver 就整段跳过，
/// 那是最不该出现的静默失败模式。
struct UnavailableApprover {
    /// 给用户看的完整原因（含下一步该怎么办）。
    reason: String,
}

impl UnavailableApprover {
    fn new(cause: String) -> Self {
        Self {
            reason: format!(
                "命令审批引擎（Jev）初始化失败，为避免命令在无人审批的情况下执行，本次任务的命令都会被拦下：{}。\
                 请检查网络/代理设置后重新开始任务，或把「设置 → Agent → 命令模型审批」的引擎改回「跟随会话模型」。",
                cause
            ),
        }
    }
}

#[async_trait::async_trait]
impl CommandApprover for UnavailableApprover {
    async fn evaluate(
        &self,
        _command: &str,
        _recent_messages: &[LlmMessage],
    ) -> Result<ApprovalJudgement, AppError> {
        Err(AppError::Config(self.reason.clone()))
    }
}

/// `dispatch` 处置合成段（[`ToolDispatcher::resolve_call_disposition`]）的产物：
/// 本次调用的最终档位，加上后续「要不要确认 / 模型审批 / 拒绝理由」各段都要读的
/// 中间结论。
struct ResolvedDisposition {
    effective_disposition: Disposition,
    command_decision: Option<CommandDecision>,
    resolved_approval_mode: AgentMode,
}

/// Dispatches tool calls through the registry with mode-aware security policy.
pub(crate) struct ToolDispatcher {
    mode: AgentMode,
    /// 审批判定实际使用的模式：`Some(m)` 覆盖 `mode`，`None` = 跟随 `mode`。
    /// Auto 父任务派发的只读调研子 agent 传 `Some(Auto)`：子 agent 自身是
    /// Plan（只读工具集），但命令确认语义按父任务 Auto 静默放行（不弹人审，
    /// 模型审批 route_to_human 也不转人审；风险评估硬拦截仍保留）。
    approval_mode: Option<AgentMode>,
    agent_settings: AgentModeSettings,
    task_id: String,
    state: AppState,
    approval: ApprovalManager,
    registry: std::sync::Arc<ToolRegistry>,
    /// LLM-backed command approver. `None` when the feature is disabled by
    /// settings or the tool is not `bash`. Inserted after the
    /// risk assessment and before the human-approval trigger.
    approver: Option<std::sync::Arc<dyn CommandApprover>>,
    /// 本任务内已观察过的路径（`read_file` / `write_file` / `edit_file` 成功
    /// 后按 `normalize_path` 归一化记账）。`edit_file` 的目标必须已读取，
    /// `write_file` 覆盖已存在文件也必须已读取，否则工具直接失败并提示先读取。
    read_files: parking_lot::RwLock<std::collections::HashSet<String>>,
}

impl ToolDispatcher {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        mode: AgentMode,
        approval_mode: Option<AgentMode>,
        agent_settings: AgentModeSettings,
        task_id: String,
        app: tauri::AppHandle,
        state: AppState,
        registry: std::sync::Arc<ToolRegistry>,
        llm_manager: std::sync::Arc<LlmManager>,
        approval_cfg: Option<LlmConfig>,
        jev_cfg: Option<JevConfig>,
    ) -> Self {
        let enable = agent_settings.enable_model_command_approval;
        // 审批提示词是否按「Plan 模式只读」渲染：取决于本任务实际工具
        // 定位（自身 mode）。Auto 父派发的静默子 agent 自身仍是 Plan
        // 只读工具集，这里自然为 true——plan 提示词约束"不得修改系统"
        // 对只读调研场景更保守，与 approval_mode 静默放行互补。
        // 两个引擎共用同一个判定（Plan 追加段也共用同一份模板）。
        let is_plan_mode = matches!(mode, AgentMode::Plan);

        // 审批者**要么在、要么整个功能被设置关掉**：两个构造函数返回的就是
        // approver 本身（返回值类型里没有 `None`），所以"开关开着却没有审批"
        // 在类型上不可能。这是刻意的：静默降级成"没有审批"等于把关卡整段跳过。
        let approver: Option<std::sync::Arc<dyn CommandApprover>> = if enable {
            let approver = match agent_settings.command_approval_engine {
                CommandApprovalEngine::Jev => Self::build_jev_approver(
                    jev_cfg,
                    &agent_settings.jev_model_id,
                    &agent_settings.jev_base_url,
                    &agent_settings.jev_approval_prompt,
                    is_plan_mode,
                    agent_settings.jev_reason_followup,
                ),
                CommandApprovalEngine::Model => Self::build_model_approver(
                    approval_cfg,
                    llm_manager,
                    &agent_settings.model_approval_prompt,
                    is_plan_mode,
                ),
            };
            Some(approver)
        } else {
            None
        };
        Self {
            mode,
            approval_mode,
            agent_settings,
            task_id,
            approval: ApprovalManager::new(app, state.agent_interaction.clone()),
            state,
            registry,
            approver,
            read_files: parking_lot::RwLock::new(std::collections::HashSet::new()),
        }
    }

    /// 审批判定实际使用的模式：`approval_mode` 覆盖优先（Auto 父任务派发的子
    /// agent），否则跟随本任务 `mode`；Plan 再按设置折成 Auto（见
    /// [`effective_approval_mode`]）。
    fn resolved_approval_mode(&self) -> AgentMode {
        effective_approval_mode(
            self.approval_mode.as_ref().unwrap_or(&self.mode),
            &self.agent_settings,
        )
    }

    /// 会话模型引擎（旧行为，逐字节保持不变）。
    fn build_model_approver(
        approval_cfg: Option<LlmConfig>,
        llm_manager: std::sync::Arc<LlmManager>,
        custom_prompt: &str,
        is_plan_mode: bool,
    ) -> std::sync::Arc<dyn CommandApprover> {
        // 审批专用配置由 AgentManager 按「命令审核槽位」解析（空/失效自动回落
        // 主模型）。extra_body 已在解析后剥离：自由参数（thinking、top_p 等）
        // 针对主对话模型调参，不应影响审批决策。
        let approval_manager = match approval_cfg {
            Some(cfg) => match LlmManager::new(cfg) {
                Ok(m) => {
                    log::info!("模型审批使用独立模型: {}", m.config().model);
                    std::sync::Arc::new(m)
                }
                Err(e) => {
                    log::warn!("模型审批专用模型创建失败，回退主模型: {}", e);
                    llm_manager.clone()
                }
            },
            None => {
                // 无独立配置：用主模型（剥离 extra_body）。
                let mut cfg = llm_manager.config().clone();
                cfg.extra_body = None;
                match LlmManager::new(cfg) {
                    Ok(m) => std::sync::Arc::new(m),
                    Err(e) => {
                        log::warn!("模型审批 manager 创建失败，回退主 manager: {}", e);
                        llm_manager.clone()
                    }
                }
            }
        };
        std::sync::Arc::new(ModelApprover::new(
            approval_manager,
            custom_prompt.to_string(),
            is_plan_mode,
        ))
    }

    /// Jev 引擎。
    ///
    /// `jev_cfg` 为 `None` = 用户选了 Jev 但还没配 API Key。这种情况下**仍然
    /// 构造 approver**（用空 Key 的配置），让每条 bash 都拿到一句明确的
    /// 「去设置里填 Key」错误，而不是静默回退到会话模型——静默回退会让用户
    /// 以为自己受 Jev 保护，其实没有。
    fn build_jev_approver(
        jev_cfg: Option<JevConfig>,
        model_id: &str,
        base_url: &str,
        custom_prompt: &str,
        is_plan_mode: bool,
        reason_followup: bool,
    ) -> std::sync::Arc<dyn CommandApprover> {
        let cfg = match jev_cfg {
            Some(cfg) => cfg,
            None => {
                log::warn!("命令审批引擎为 Jev 但未配置 TypeSafe API Key，每次 bash 将明确报错");
                JevConfig::new(String::new(), model_id.to_string(), NetPolicy::default())
            }
        };
        // 带根地址：配错地址时每条 bash 都会失败并指明打到了哪台机器，
        // 日志里也得能看出实际用的是官方地址还是自定义网关。
        let cfg = cfg.with_base_url(base_url);
        log::info!(
            "命令审批引擎: Jev ({} @ {}{}{})",
            cfg.model_id,
            cfg.endpoint_url(),
            if cfg.is_custom_base_url() {
                "，自定义根地址"
            } else {
                ""
            },
            if reason_followup {
                "，人审时追问原因（多一次请求）"
            } else {
                ""
            }
        );
        match JevApprover::new(
            cfg,
            custom_prompt.to_string(),
            is_plan_mode,
            reason_followup,
        ) {
            Ok(a) => std::sync::Arc::new(a),
            Err(e) => {
                // 构造失败（HTTP 客户端建不起来）属于极端情况。这里**不静默降级
                // 成"没有审批"**：返回一个每次调用都明确报错的替身，让每条命令
                // 都拿到"审批没能进行"，而不是在无人审批的情况下执行。
                log::error!("Jev 审批者创建失败，本任务的命令都将被拦下: {}", e);
                std::sync::Arc::new(UnavailableApprover::new(e.to_string()))
            }
        }
    }

    pub async fn dispatch(
        &self,
        tc: &ToolCall,
        ctx: &ToolContext,
        event_name: &str,
        recent_messages: &[LlmMessage],
    ) -> DispatchResult {
        let Some(tool) = self.registry.get(&tc.name) else {
            return DispatchResult::unknown(&tc.name);
        };
        // 参数语义来自内置工具声明表（`tools/mod.rs` 的 BUILTIN_TOOLS_*）：
        // 哪个参数键是命令、哪个是路径、会不会写路径、受哪个审批开关约束。
        // 动态工具（skill / 插件 / MCP）没有条目 → 走通用路径。
        let semantics = self.registry.semantics(&tc.name);
        // 命令文本有两个来源：内置工具从声明的参数键里取；动态工具（插件
        // `kind=ssh`）的命令要先渲染模板才成型，所以问工具自己。
        // 两个来源都没有，就不是命令类工具。
        let mut rendered_command: Option<String> = None;
        let command = match semantics
            .and_then(|s| s.command_arg)
            .and_then(|key| tc.arguments.get(key))
            .and_then(|v| v.as_str())
        {
            Some(c) => Some(c),
            None => {
                rendered_command = tool.rendered_command(&tc.arguments, ctx).await;
                rendered_command.as_deref()
            }
        };
        let declares_command = command.is_some();
        let path = semantics
            .and_then(|s| s.path_arg)
            .and_then(|key| tc.arguments.get(key))
            .and_then(|v| v.as_str());
        let path_write = semantics.map(|s| s.path_write).unwrap_or(PathWrite::None);

        // 处置档位合成（三个来源按严取一）+「直接拒绝」短路。
        let plan = match self.resolve_call_disposition(
            tc,
            tool.as_ref(),
            ctx,
            command,
            declares_command,
            path,
            path_write,
        ) {
            Ok(plan) => plan,
            Err(blocked) => return blocked,
        };
        let effective_disposition = plan.effective_disposition;

        let requires_default_approval = tool.requires_approval_by_default();

        // 0.4 必填参数预检 + 0.5/0.6 写前必须已读：注定失败的调用不进审批。
        if let Err(blocked) = self
            .run_entry_prechecks(
                tc,
                tool.as_ref(),
                ctx,
                path,
                path_write,
                effective_disposition,
            )
            .await
        {
            return blocked;
        }

        // 1. 需不需要人确认 —— 模式 × 档位 × 命令名单三者的交叉点。
        //    命令类工具的结论来自 `decide_command`（它把风险评估和名单一起算完，
        //    `deny` 已经在上面短路掉了）；其余工具按自己声明的档位走。
        let assessed_needs_confirm = needs_human_confirmation(
            &plan.resolved_approval_mode,
            plan.command_decision.as_ref(),
            effective_disposition,
            requires_default_approval,
            &self.agent_settings,
            semantics
                .and_then(|s| s.approval_switch)
                .map(|switch| switch.is_on(&self.agent_settings))
                .unwrap_or(false),
        );

        // 2. 模型审批（命令类工具；详见 `run_model_approval`）。
        let (final_needs_confirm, model_reasons) = match self
            .run_model_approval(
                tc,
                ctx,
                event_name,
                recent_messages,
                command,
                declares_command,
                &plan.resolved_approval_mode,
                effective_disposition,
                assessed_needs_confirm,
            )
            .await
        {
            Ok(outcome) => outcome,
            Err(blocked) => return blocked,
        };

        // 3. 人工审批（整个 dispatch 里唯一打开审批对话框的地方，详见
        //    `request_human_approval`）。
        if let Err(blocked) = self
            .request_human_approval(
                tc,
                ctx,
                tool.as_ref(),
                semantics,
                command,
                declares_command,
                &plan.resolved_approval_mode,
                effective_disposition,
                plan.command_decision.as_ref(),
                model_reasons,
                final_needs_confirm,
            )
            .await
        {
            return blocked;
        }

        set_task_status(
            &self.state,
            &self.task_id,
            crate::agent::task::AgentStatus::Executing,
        );
        match tool.execute(tc.arguments.clone(), ctx).await {
            Ok(out) => {
                // 带路径参数的工具成功即记账：模型刚读过，或刚写入/改过的文件
                // 内容都在其上下文中，等价于「已观察」。后续 edit_file 与
                // write_file 的写前检查以此集合为准。
                if out.success {
                    if let Some(path) = path {
                        self.read_files
                            .write()
                            .insert(crate::agent::risk::normalize_path(path));
                    }
                }
                DispatchResult::from_tool_output(out, effective_disposition)
            }
            Err(e) => DispatchResult {
                summary: format!("{} (error)", tc.name),
                output: format!("tool error: {}", e),
                success: false,
                blocked: false,
                was_timeout: false,
                was_aborted: false,
                metadata: None,
                disposition: effective_disposition,
            },
        }
    }

    /// 处置档位合成段 —— 本次调用的最终档位，与「直接拒绝」短路。
    ///
    /// 纯提取自 `dispatch`（原 393-444 行）：参数就是原来的捕获变量，判定顺序、
    /// 档位文案与错误路径逐字节保持。
    #[allow(clippy::too_many_arguments)]
    #[allow(clippy::result_large_err)] // 与 plugin_tool 同口径：DispatchResult 本身就大
    fn resolve_call_disposition(
        &self,
        tc: &ToolCall,
        tool: &dyn AgentTool,
        ctx: &ToolContext,
        command: Option<&str>,
        declares_command: bool,
        path: Option<&str>,
        path_write: PathWrite,
    ) -> Result<ResolvedDisposition, DispatchResult> {
        // 处置档位有三个来源，按严取一：
        //   1. 命令类工具 —— 按命令文本现算（`decide_command`，与设置页的
        //      「命令测试」共用同一份判定，否则会出现"测出来一个样、跑起来一个样"）
        //   2. 写路径类工具写到受保护路径 → 强制审批
        //   3. 其余 → 工具自己声明的档位
        let hits_protected_path = path
            .map(|p| {
                ctx.policy
                    .as_ref()
                    .map(|policy| policy.is_protected_path(p))
                    .unwrap_or(false)
            })
            .unwrap_or(false);
        let resolved_approval_mode = self.resolved_approval_mode();
        let command_decision = declares_command.then(|| {
            decide_command(
                command.unwrap_or(""),
                &resolved_approval_mode,
                &self.agent_settings,
                ctx.policy.as_deref(),
            )
        });
        let effective_disposition = resolve_disposition(
            command_decision.as_ref().map(|d| d.disposition),
            tool.disposition(),
            path_write != PathWrite::None && hits_protected_path,
        );

        // 直接拒绝：不执行、不弹窗，把原因回给模型（它得知道踩的是哪一步才改得回来）。
        //
        // 判据是**最终档位**，不是"命令文本算出来的档位"：插件 manifest 里声明
        // `Deny` 的工具（`kind=local` 没有命令文本）同样必须拦在这里。以前只看
        // `command_decision`，那种工具会落到"需要确认"，于是弹窗上写着「直接拒绝」
        // 却带着一个能批准它的按钮。
        if effective_disposition == Disposition::Deny {
            let reason = command_decision
                .as_ref()
                .filter(|d| d.disposition == Disposition::Deny)
                .map(|d| d.reason.clone())
                .unwrap_or_else(|| {
                    format!(
                        "工具 `{}` 的处置档位是「直接拒绝」，未执行。请不要原样重试，改用其他方式完成目标。",
                        tc.name
                    )
                });
            let summary = if declares_command {
                format!("$ {}", command.unwrap_or(""))
            } else {
                tc.name.clone()
            };
            return Err(DispatchResult::blocked(summary, reason, Disposition::Deny));
        }

        Ok(ResolvedDisposition {
            effective_disposition,
            command_decision,
            resolved_approval_mode,
        })
    }

    /// 预检段 —— 必填参数校验 + 写前必须已读：注定失败的调用在这里直接失败，
    /// 不进入任何审批流程。
    ///
    /// 纯提取自 `dispatch`（原 448-500 行）：顺序与 await 位置不变，读 guard
    /// 依旧不跨 `.await`。
    async fn run_entry_prechecks(
        &self,
        tc: &ToolCall,
        tool: &dyn AgentTool,
        ctx: &ToolContext,
        path: Option<&str>,
        path_write: PathWrite,
        effective_disposition: Disposition,
    ) -> Result<(), DispatchResult> {
        // 0.4 必填参数预检：参数不合格的调用既不弹审批、也不占用模型审批。
        //     与上面写前必须已读同一个道理——用户不该为一次注定失败的调用点批准，
        //     点完还得看它失败、等模型补参数后**再点一次**。
        if let Err(message) = tool.validate_arguments(&tc.arguments) {
            return Err(DispatchResult::from_tool_output(
                ToolOutput::fail(tc.name.clone(), message),
                effective_disposition,
            ));
        }

        // 0.5 / 0.6 写前必须已读：注定失败的写会直接失败并提示先读取，不进入审批
        // 流程（不值得让用户为一次注定失败的调用点确认）。强度由声明决定：
        //   Edit      —— 改写既有文件，目标必须已读过；
        //   Overwrite —— 覆盖已存在的目标前要求已读过，新建放行。
        // 「目标存不存在」这一问是**机器相关**的：先问工具（本机写工具会用本机
        // stat 回答），工具不回答（动态工具 / 远端工具）才回落到 SFTP stat。
        match path_write {
            PathWrite::Edit => {
                if let Some(path) = path {
                    if !path_was_read(&self.read_files.read(), path) {
                        return Err(DispatchResult::from_tool_output(
                            ToolOutput::fail(
                                format!("edit {}", path),
                                read_before_edit_error(path),
                            ),
                            effective_disposition,
                        ));
                    }
                }
            }
            PathWrite::Overwrite => {
                if let Some(path) = path {
                    // 已读判定单独一句：parking_lot 的读 guard 不能带过下面的 `.await`。
                    let already_read = path_was_read(&self.read_files.read(), path);
                    if !already_read {
                        let exists = match tool.target_exists(ctx, &tc.arguments).await {
                            Some(exists) => exists,
                            None => remote_file_exists(&ctx.ssh, &ctx.session_id, path).await,
                        };
                        if exists {
                            return Err(DispatchResult::from_tool_output(
                                ToolOutput::fail(
                                    format!("write {}", path),
                                    read_before_write_error(path),
                                ),
                                effective_disposition,
                            ));
                        }
                    }
                }
            }
            PathWrite::None => {}
        }
        Ok(())
    }

    /// 模型审批段 —— 命令类工具在配置了审批引擎时先过一遍模型判定。模型只能
    /// 判，不能改写命令；返回并集后的「要不要人确认」与模型给的理由，模型
    /// `Block` / 判定失败在这里短路。
    ///
    /// 纯提取自 `dispatch`（原 517-657 行）：事件顺序、放行/转人审语义不变。
    #[allow(clippy::too_many_arguments)]
    async fn run_model_approval(
        &self,
        tc: &ToolCall,
        ctx: &ToolContext,
        event_name: &str,
        recent_messages: &[LlmMessage],
        command: Option<&str>,
        declares_command: bool,
        resolved_approval_mode: &AgentMode,
        effective_disposition: Disposition,
        assessed_needs_confirm: bool,
    ) -> Result<(bool, Option<Vec<String>>), DispatchResult> {
        // 2. Model-based approval — runs for tools that declare a command
        //    argument (i.e. `bash`) when an approver is configured, regardless
        //    of whether the risk assessment requires human approval. The model can only
        //    judge; it cannot rewrite the command.
        //    Reuses the agent's normal model + retry path; failure after retries
        //    is surfaced as a blocked tool result.
        let mut final_needs_confirm = assessed_needs_confirm;
        let mut model_reasons: Option<Vec<String>> = None;

        if declares_command {
            if let Some(ref approver) = self.approver {
                let cmd = command.unwrap_or("");

                // Signal the frontend that model approval is in progress.
                emit_event(
                    &ctx.app_handle,
                    event_name,
                    ModelApprovalStartEvent {
                        event_type: "modelApprovalStart".to_string(),
                        tool_call_id: tc.id.clone(),
                    },
                );

                let eval_result = approver.evaluate(cmd, recent_messages).await;

                match eval_result {
                    Ok(judgement) => {
                        // 判定元信息只用于**展示**（弹窗上标注这次是谁判的、
                        // 把握多大）。下面的分支只看 `decision`——置信度不参与
                        // 任何判定，两个引擎的决策语义因此完全等价。
                        let engine = Some(judgement.engine.to_string());
                        let confidence = judgement.confidence;
                        match judgement.decision {
                            ModelApprovalDecision::Block(rs) => {
                                emit_event(
                                    &ctx.app_handle,
                                    event_name,
                                    ModelApprovalDoneEvent {
                                        event_type: "modelApprovalDone".to_string(),
                                        tool_call_id: tc.id.clone(),
                                        decision: "block".to_string(),
                                        reasons: rs.clone(),
                                        engine,
                                        confidence,
                                    },
                                );
                                let reason = if rs.is_empty() {
                                    "模型审批阻止".to_string()
                                } else {
                                    format!("模型审批阻止: {}", rs.join("; "))
                                };
                                let hint = "\n如果你认为这个命令是被冤枉阻止的，请先解释你的理由，然后重新尝试执行。";
                                return Err(DispatchResult::blocked(
                                    format!("$ {}", cmd),
                                    format!("{}{}", reason, hint),
                                    effective_disposition,
                                ));
                            }
                            ModelApprovalDecision::RouteToHuman(rs) => {
                                // 判据与「开不开窗」同源（`can_ask_human`）：
                                // 没有人工介入的场合，"转人审"就没有落点。Auto 下这一档
                                // 的实际结果就是放行，事件按**实际结果**发 `approve` ——
                                // 否则工具卡上会一直挂着「模型建议人工审批」，而根本
                                // 没有问过任何人，用户会以为自己漏掉了什么。模型的原判据
                                // 留在日志里备查。
                                if can_ask_human(resolved_approval_mode, true) {
                                    // Agent 模式弹窗（Plan 默认也走 Auto 那一支，除非开了
                                    // 「Plan 模式也需要审批」——判定同样遵循
                                    // `resolved_approval_mode`）。
                                    emit_event(
                                        &ctx.app_handle,
                                        event_name,
                                        ModelApprovalDoneEvent {
                                            event_type: "modelApprovalDone".to_string(),
                                            tool_call_id: tc.id.clone(),
                                            decision: "route_to_human".to_string(),
                                            reasons: rs.clone(),
                                            engine,
                                            confidence,
                                        },
                                    );
                                    final_needs_confirm = true;
                                    model_reasons = if rs.is_empty() { None } else { Some(rs) };
                                } else {
                                    log::info!(
                                        "模型审批判定 route_to_human，但当前模式没有人工介入的落点，直接放行：$ {}",
                                        cmd
                                    );
                                    emit_event(
                                        &ctx.app_handle,
                                        event_name,
                                        ModelApprovalDoneEvent {
                                            event_type: "modelApprovalDone".to_string(),
                                            tool_call_id: tc.id.clone(),
                                            decision: "approve".to_string(),
                                            reasons: vec![],
                                            engine,
                                            confidence,
                                        },
                                    );
                                }
                            }
                            ModelApprovalDecision::Approve => {
                                emit_event(
                                    &ctx.app_handle,
                                    event_name,
                                    ModelApprovalDoneEvent {
                                        event_type: "modelApprovalDone".to_string(),
                                        tool_call_id: tc.id.clone(),
                                        decision: "approve".to_string(),
                                        reasons: vec![],
                                        engine,
                                        confidence,
                                    },
                                );
                            }
                        }
                    }
                    Err(e) => {
                        let err_msg = e.to_string();
                        emit_event(
                            &ctx.app_handle,
                            event_name,
                            ModelApprovalDoneEvent {
                                event_type: "modelApprovalDone".to_string(),
                                tool_call_id: tc.id.clone(),
                                decision: "error".to_string(),
                                reasons: vec![err_msg.clone()],
                                engine: None,
                                confidence: None,
                            },
                        );
                        return Err(DispatchResult::blocked(
                            format!("$ {}", cmd),
                            format!("模型审批失败: {}", err_msg),
                            effective_disposition,
                        ));
                    }
                }
            }
        }

        Ok((final_needs_confirm, model_reasons))
    }

    /// 人工审批段 —— 打开审批对话框（预演、状态迁移、拒绝路径都在这里）。
    ///
    /// 纯提取自 `dispatch`（原 659-758 行）：预演与弹窗顺序不变，拒绝时返回
    /// `Err(DispatchResult)`。
    #[allow(clippy::too_many_arguments)]
    async fn request_human_approval(
        &self,
        tc: &ToolCall,
        ctx: &ToolContext,
        tool: &dyn AgentTool,
        semantics: Option<ToolSemantics>,
        command: Option<&str>,
        declares_command: bool,
        resolved_approval_mode: &AgentMode,
        effective_disposition: Disposition,
        command_decision: Option<&CommandDecision>,
        model_reasons: Option<Vec<String>>,
        final_needs_confirm: bool,
    ) -> Result<(), DispatchResult> {
        // 3. Human approval —— 整个 dispatch 里**唯一**打开审批对话框的地方。
        //
        //    `final_needs_confirm` 有两条来路（档位判定 `needs_human_confirmation`、
        //    命令审批模型判 route_to_human），两条提到"要人"之前都先过 `can_ask_human`；
        //    这里再过一次，是为了把 Auto 的保证钉在唯一的出口上 —— 将来新增第三条
        //    来路时忘了判模式，Auto 也不会因此悄悄弹窗。
        if can_ask_human(resolved_approval_mode, final_needs_confirm) {
            let mut approval_metadata: Option<serde_json::Value> = None;

            // 需要预演的工具（`edit_file` / 本机 `local_edit_file`）先做一次预读 +
            // 校验再问用户：会让 execute() 失败的调用不该打开审批对话框。
            //
            // 预演是**机器相关**的：先问工具（本机编辑工具读的是用户自己电脑上那个
            // 文件），工具不回答（动态工具）才回落到远端实现（读 SFTP 上的同名路径）。
            // 失败走同一分支：这与远端现状一致 —— 预演失败 = 这次调用注定失败，
            // 直接把原因回给模型，不弹一个注定失败的审批。
            if semantics
                .map(|s| s.preview_before_approval)
                .unwrap_or(false)
            {
                let preview = match tool.preview_write(ctx, &tc.arguments).await {
                    Some(result) => result,
                    None => {
                        crate::agent::tools::file_ops::preview_edit_for_approval(
                            &ctx.ssh,
                            &ctx.session_id,
                            &tc.arguments,
                        )
                        .await
                    }
                };
                match preview {
                    Ok(meta) => approval_metadata = Some(meta),
                    Err(e) => {
                        return Err(DispatchResult {
                            summary: e.summary,
                            output: e.message,
                            success: false,
                            blocked: false,
                            was_timeout: false,
                            was_aborted: false,
                            metadata: None,
                            disposition: effective_disposition,
                        });
                    }
                }
            }

            set_task_status(
                &self.state,
                &self.task_id,
                crate::agent::task::AgentStatus::WaitingApproval,
            );
            let approval_reasons = merge_approval_reasons(
                model_reasons,
                command_decision.map(|d| d.reason.clone()),
            );
            let answer = self
                .approval
                .request_approval(
                    self.task_id.clone(),
                    ctx.session_id.clone(),
                    ctx.task_id
                        .as_deref()
                        .and_then(|tid| {
                            self.state
                                .agent_tasks
                                .read()
                                .get(tid)
                                .map(|t| t.conversation_id.clone())
                        })
                        .unwrap_or_default(),
                    tc.id.clone(),
                    &tc.name,
                    tc.arguments.clone(),
                    effective_disposition,
                    approval_reasons.as_deref(),
                    approval_metadata,
                )
                .await;
            set_task_status(
                &self.state,
                &self.task_id,
                crate::agent::task::AgentStatus::Executing,
            );
            if !answer.approved {
                // 命令类工具的摘要用 `$ cmd`（用户看到的是被拒的那条命令），
                // 其余用工具名。
                let summary = if declares_command {
                    format!("$ {}", command.unwrap_or(""))
                } else {
                    tc.name.clone()
                };
                return Err(DispatchResult::blocked(
                    summary,
                    rejection_message(answer.reason.as_deref()),
                    effective_disposition,
                ));
            }
        }
        Ok(())
    }
}

fn set_task_status(state: &AppState, task_id: &str, status: crate::agent::task::AgentStatus) {
    if let Some(task) = state.agent_tasks.write().get_mut(task_id) {
        // 吸收规则在 `AgentTask::transition_to` 里：已取消的任务不接受后续写入
        // （用户点了停止之后，正在跑的工具不该把状态推回 Executing）。
        task.transition_to(status);
    }
}

/// read-before-edit：目标路径是否已被本任务成功读取（归一化比较）。
/// 复用风险评估模块的 `normalize_path`（折叠 `//`、`.`、`..`、尾斜杠）。
fn path_was_read(read_files: &std::collections::HashSet<String>, path: &str) -> bool {
    read_files.contains(&crate::agent::risk::normalize_path(path))
}

/// read-before-edit 拦截时的固定错误文案（xxx 为本次 edit 传入的 path）。
fn read_before_edit_error(path: &str) -> String {
    format!(
        "错误：编辑操作需要先读取\"{}\" —— 请先读取该文件，然后再重试。",
        path
    )
}

/// read-before-overwrite 拦截时的固定错误文案（xxx 为本次 write 传入的 path）。
fn read_before_write_error(path: &str) -> String {
    format!(
        "错误：覆盖已有文件需要先读取\"{}\" —— 请先读取该文件，然后再重试。",
        path
    )
}

/// 一条命令的最终处置结论。
pub(crate) struct CommandDecision {
    pub disposition: Disposition,
    /// 一句话说明为什么是这个档位（拒绝时回给模型，其余情况显示在审批弹窗/设置页）。
    pub reason: String,
    pub requires_confirmation: bool,
}

/// 一次工具调用的最终处置档位 —— **三个来源按严取一**。
///
///   1. `command_disposition` —— 命令文本算出来的档位（内置工具的命令参数、插件
///      `kind=ssh` 渲染出的命令；`None` = 这个工具没有命令文本）
///   2. `protected_path_write` —— 写路径类工具写到受保护路径 → 强制审批
///   3. `declared` —— 工具自己声明的档位（插件 manifest 的 `riskLevel`、各工具实现）
///
/// 必须是**取最严**，不能是"有命令文本就用命令文本"：
///
/// - 插件对自己的命令最清楚，manifest 里声明 `ForceApproval` / `Deny` 是作者在提要求
///   （两份插件文档都是这么承诺的）。以前命令文本会**顶掉**声明值，于是 `kind=ssh`
///   工具声明的档位成了死代码 —— 关掉「逐条确认」后声明了强制审批的命令会静默执行。
/// - 反过来声明 `Allow` 也压不住命令文本的判定：插件不能靠一句声明把自己的危险命令
///   说成安全。
///
/// 抽成纯函数是为了能单测：`dispatch` 依赖 SSH 会话与 `AppHandle`，跑不起来，而这
/// 里正是"声明的档位到底有没有被读"最容易悄悄退化的地方。
pub(crate) fn resolve_disposition(
    command_disposition: Option<Disposition>,
    declared: Disposition,
    protected_path_write: bool,
) -> Disposition {
    let mut worst = declared;
    if protected_path_write {
        worst = worst.max(Disposition::ForceApproval);
    }
    if let Some(from_command) = command_disposition {
        worst = worst.max(from_command);
    }
    worst
}

/// 审批判定实际使用的模式 —— **Plan 默认与 Auto 同档**。
///
/// 规划阶段绝大多数命令是只读研究（`ls` / `grep` / `tail`…），逐条弹窗是纯摩擦，
/// 所以关掉「Plan 模式也需要审批」时 Plan 复用 Auto 那一套判定，而不是另写一份：
/// 两边都一次不问（`Deny` 的提前短路照旧，它不看模式）。打开开关则原样返回
/// `Plan`，走命令名单与人工审批。
///
/// 幂等 —— `decide_command` / `needs_human_confirmation` 内部也调它，所以设置页的
/// 「命令测试」直接传 `Plan` 进来时，结论与真实执行一致（那两处曾经不一致过）。
///
/// 折的范围是**整个审批层**，不止 bash：Plan 工具集里唯一声明 `Approval` 的非命令类
/// 工具（`job_kill`）同样随之静默，与它在 Auto 下一致。`ForceApproval` 在 `decide_command`
/// 里仍照算（档位不受模式影响），只是到了 `needs_human_confirmation` 才因为 Auto 而不问；
/// `Deny` 两处都不受影响。
pub(crate) fn effective_approval_mode(mode: &AgentMode, settings: &AgentModeSettings) -> AgentMode {
    match mode {
        AgentMode::Plan if !settings.plan_mode_requires_approval => AgentMode::Auto,
        other => other.clone(),
    }
}

/// 给一条命令下结论：**风险评估 + 命令名单一起算，这是唯一一份实现**。
///
/// dispatcher 用它决定要不要拦、要不要弹窗，设置页的「命令测试」也用它 —— 那两处
/// 曾经各写了一份，导致设置页测出来的结论和真实执行时的行为可以不一样（设置页那
/// 份甚至完全不看风险评估）。改这里就是改两处。
///
/// 四档的产生方式：
///   - `Deny` —— 灾难模式判定 + 「该淘汰的写法」（按名字批量杀进程、管道进
///     shell、`source`/藏变量执行）都能产出；不征求意见，理由里写明替代写法，
///     模型会照着换
///   - `ForceApproval` —— 系统级命令 / 受保护路径 …，覆盖命令名单：Agent / Plan
///     （开了「Plan 模式也需要审批」时）下必须人点一次，Auto 下不问
///   - `Approval` —— sudo 包装保底抬到这一档（`base_assessment`）；普通模式下也由
///     命令名单产生，且会被名单降成放行
///   - `Allow` —— 其余交命令名单定（白名单命中就放行）
pub(crate) fn decide_command(
    cmd: &str,
    mode: &AgentMode,
    settings: &AgentModeSettings,
    policy: Option<&SecurityPolicy>,
) -> CommandDecision {
    let assessment = RiskAssessor::from_optional(policy).assess_command(cmd);
    // Plan 默认折成 Auto（见 `effective_approval_mode`）：命令名单这一层不参与，
    // 与真实执行时走的是同一个判定，不能只有 dispatcher 那边折。
    let mode = &effective_approval_mode(mode, settings);

    match assessment.disposition {
        Disposition::Deny => CommandDecision {
            disposition: Disposition::Deny,
            reason: assessment
                .reason
                .unwrap_or_else(|| "判定为灾难性操作".to_string()),
            requires_confirmation: false,
        },
        // 强制审批不看模式、不看名单：命中了就是要人点头。
        Disposition::ForceApproval => CommandDecision {
            disposition: Disposition::ForceApproval,
            reason: assessment.reason.unwrap_or_default(),
            requires_confirmation: true,
        },
        _ => {
            // 基础定档自己抬到「请求审批」的（sudo 包装保底，见 `base_assessment`）
            // 与名单命中同样要确认；Auto 模式跳过这一档 —— 这正是它与强制审批的
            // 唯一差别。名单看的是剥壳后的 base（`sudo -n tail` 在它眼里就是
            // `sudo`），只有基础档知道"经 sudo 提权"这回事，所以理由优先用它的。
            let needs_confirm = match mode {
                AgentMode::Auto => false,
                AgentMode::Plan | AgentMode::Agent => {
                    assessment.disposition == Disposition::Approval
                        || command_list_requires_confirm(cmd, settings)
                }
            };
            CommandDecision {
                disposition: if needs_confirm {
                    Disposition::Approval
                } else {
                    Disposition::Allow
                },
                reason: if needs_confirm {
                    assessment
                        .reason
                        .unwrap_or_else(|| "命中命令名单的确认规则，需要用户确认".to_string())
                } else {
                    "按当前命令名单判定为可直接执行".to_string()
                },
                requires_confirmation: needs_confirm,
            }
        }
    }
}

/// 拒绝后回给模型的那段话。
///
/// 抽成纯函数是为了能单测：它是模型唯一能看到的"用户为什么不让我做"，措辞错一点
/// 模型就理解不到点上（以前这里只有两个字「用户拒绝」，模型于是换个写法再提一次，
/// 用户被迫反复拒绝）。
pub(crate) fn rejection_message(reason: Option<&str>) -> String {
    match reason.map(str::trim).filter(|r| !r.is_empty()) {
        Some(r) => format!(
            "用户拒绝了这次调用，理由是：{}

请按这个理由调整方案；不要原样重试被拒的调用。",
            r
        ),
        None => "用户拒绝了这次调用，但没有说明原因。

请先向用户说明你的意图或换个方案，不要原样重试。"
            .to_string(),
    }
}

/// 「这次调用需不需要人确认」的完整判定。
///
/// 抽成纯函数不是为了让 `dispatch` 好看：它是整条链路里安全语义最集中的一处，
/// 而 `dispatch` 依赖 SSH 会话与 AppHandle、单测跑不起来 —— 留在里面就只能靠读
/// 代码确认「Auto 到底拦不拦得住强制审批」，而那正是最容易悄悄退化的地方
/// （把 Auto 分支改回只看 `requires_default_approval`，这里会立刻变红）。
///
/// 判据是**最终档位**（`resolve_disposition` 的产物），不是命令文本单独算出来的
/// 那份：`command_decision` 的入参里没有插件 manifest 声明，所以「声明了强制审批
/// + 命令文本只算放行」这种组合在 `d.requires_confirmation` 上是 `false`，只看它
/// 就等于把声明整条丢掉。
///
/// **Auto 恒为 `false`**：Auto 的语义是全自主、不掺任何人工确认（用户明确选了它），
/// 所以档位、插件/MCP 自己声明的强制审批、`requires_default_approval` 都不再征求
/// 意见。不在这里的是 `Deny`：`dispatch` 在调用本函数之前已把「最终档位 = 直接拒绝」
/// 的调用短路掉了（那种档位既不执行、也不弹窗），它根本到不了这里。
pub(crate) fn needs_human_confirmation(
    approval_mode: &AgentMode,
    command_decision: Option<&CommandDecision>,
    effective_disposition: Disposition,
    requires_default_approval: bool,
    settings: &AgentModeSettings,
    approval_switch_on: bool,
) -> bool {
    // 与 `decide_command` 同一处折法（幂等）：两处若只折一处，就会出现「档位算静默、
    // 这里却弹窗」的错位。
    let approval_mode = &effective_approval_mode(approval_mode, settings);

    match approval_mode {
        // 能在这里看到 `Plan`，只可能是「Plan 模式也需要审批」开着。
        AgentMode::Plan | AgentMode::Agent => match command_decision {
            Some(d) => {
                d.requires_confirmation || effective_disposition == Disposition::ForceApproval
            }
            None => {
                requires_default_approval
                    || match effective_disposition {
                        Disposition::Allow => false,
                        Disposition::Approval => settings.confirm_each_command,
                        Disposition::ForceApproval | Disposition::Deny => true,
                    }
                    || approval_switch_on
            }
        },
        // Auto 一次都不问 —— 强制审批档也不例外。危险命令的兜底不靠弹窗：灾难性写法
        // 仍由 `Deny` 在 `dispatch` 里更早地拒掉（那条路没有"能批准"的按钮），
        // 命令审批模型也照常跑（它只能拦、不能问人）。
        AgentMode::Auto => false,
    }
}

/// 这件事能不能交给用户 —— **Auto 下无处可交**，这是它唯一的权威判定。
///
/// `dispatch` 里有两个地方需要回答这个问题，且必须给同一个答案：
///   1. 打不打开审批对话框（档位判定与命令审批模型提出"要人确认"之后）；
///   2. 命令审批模型判 `route_to_human` 时，这个"转人审"要不要真的转过去
///      （转不过去就只能按放行呈现给前端，否则工具卡上会挂着一次根本没发生的
///      人工审批）。
///
/// 抽成一个纯函数是为了守住 Auto 的不变量：无论未来新增多少条"要人确认"的路径，
/// 只要还经过这里，Auto 就不会突然开始弹窗或者假装问过谁。
fn can_ask_human(approval_mode: &AgentMode, wants_human: bool) -> bool {
    wants_human && *approval_mode != AgentMode::Auto
}

/// 审批弹窗上给用户看的理由列表：模型审批的理由 + 静态评估命中的理由。
///
/// 静态理由（"命令经 sudo 提权执行"、"`systemctl` 是系统级命令…"）以前只落库、
/// 从不进弹窗 —— 用户只看到档位标签，不知道为什么被拦。模型理由与静态理由是
/// 两类信息，模型说批准或转人审都不能把静态理由顶掉；去重只为同一句话不出现两次。
/// 抽成纯函数是为了能单测：合并规则写在 `dispatch` 里就没人能验了。
fn merge_approval_reasons(
    model: Option<Vec<String>>,
    static_reason: Option<String>,
) -> Option<Vec<String>> {
    let Some(static_reason) = static_reason.filter(|r| !r.trim().is_empty()) else {
        return model;
    };
    let mut list = model.unwrap_or_default();
    if !list.iter().any(|r| r == &static_reason) {
        list.push(static_reason);
    }
    Some(list)
}

fn command_list_requires_confirm(cmd: &str, settings: &AgentModeSettings) -> bool {
    let segments = match split_command_chain(cmd) {
        Ok(segs) => segs,
        Err(_) => return true, // conservative: if we can't parse, require confirm
    };
    for seg in &segments {
        let base = seg
            .trim()
            .split_whitespace()
            .next()
            .unwrap_or("")
            .rsplit('/')
            .next()
            .unwrap_or("");
        let in_list = settings.command_list.iter().any(|c| c == base);
        let needs_confirm = match settings.list_mode {
            CommandListMode::Allowlist => {
                if in_list {
                    settings.confirm_each_command
                } else {
                    true
                }
            }
            CommandListMode::Denylist => {
                if in_list {
                    true
                } else {
                    settings.confirm_each_command
                }
            }
        };
        if needs_confirm {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_settings() -> AgentModeSettings {
        AgentModeSettings {
            list_mode: CommandListMode::Denylist,
            command_list: vec!["rm".into(), "mkfs".into(), "dd".into()],
            confirm_each_command: false,
            plan_mode_requires_approval: false,
            enable_model_command_approval: false,
            command_approval_engine: CommandApprovalEngine::Model,
            jev_model_id: String::new(),
            jev_base_url: String::new(),
            jev_reason_followup: false,
            jev_approval_prompt: String::new(),
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            system_prompt: String::new(),
            max_tool_rounds: 500,
            context_window: 0,
            confirm_edit_file: false,
        }
    }

    // ──────────── 拒绝后回给模型的话 ────────────

    /// 用户写了理由，理由必须原样出现在给模型的话里 —— 它是模型唯一能看到的
    /// 「为什么不让我做」。
    #[test]
    fn rejection_message_carries_the_users_reason() {
        let msg = rejection_message(Some("这台机器上不许动 nginx 配置"));
        assert!(msg.contains("这台机器上不许动 nginx 配置"));
        assert!(msg.contains("不要原样重试"), "要明确挡住它换个写法再来一次");
    }

    /// 没写理由时也不能只回一句「用户拒绝」—— 得告诉模型下一步该怎么办。
    #[test]
    fn rejection_message_without_reason_still_guides_the_model() {
        let msg = rejection_message(None);
        assert!(msg.contains("没有说明原因"));
        assert!(msg.contains("先向用户说明") || msg.contains("换个方案"));
    }

    /// 只有空白等于没填，别给模型塞一串空格。
    #[test]
    fn blank_reason_counts_as_no_reason() {
        assert_eq!(rejection_message(Some("   ")), rejection_message(None));
        assert_eq!(rejection_message(Some("")), rejection_message(None));
    }

    // ──────────── decide_command：四档是怎么落地的 ────────────

    /// 直接拒绝：不进入审批流程，也不需要人确认 —— 原因会被回给模型。
    #[test]
    fn deny_wins_in_every_mode_and_needs_no_confirmation() {
        let s = default_settings();
        for mode in [AgentMode::Plan, AgentMode::Agent, AgentMode::Auto] {
            let d = decide_command("rm -rf /etc", &mode, &s, None);
            assert_eq!(
                d.disposition,
                Disposition::Deny,
                "{:?} 模式下也应当拒绝",
                mode
            );
            assert!(!d.requires_confirmation, "拒绝不是「要不要确认」的问题");
            assert!(d.reason.contains("/etc"), "理由要能让模型知道踩了哪一步");
        }
    }

    /// 强制审批档在 Auto 下**同样不弹窗**（Auto = 全自主，没有任何人工介入），
    /// 但在 Agent 下必须弹 —— 这两种行为都要钉住。
    ///
    /// 走的是 `needs_human_confirmation`（`dispatch` 调的同一个函数），不是
    /// `decide_command` —— 后者在 Auto 下也一样返回"要确认"，只测它就等于没测
    /// `dispatch` 真正读的那个判据。
    #[test]
    fn force_approval_is_silent_in_auto_and_forced_in_agent() {
        let mut s = default_settings();
        // 名单里没有 reboot，且关掉了「逐条确认」—— 按名单逻辑它本该静默放行。
        s.confirm_each_command = false;

        for cmd in ["reboot", "systemctl restart nginx", "useradd bob"] {
            // 档位与模式无关：命令文本该判强制审批还是强制审批。
            let d = decide_command(cmd, &AgentMode::Auto, &s, None);
            assert_eq!(
                d.disposition,
                Disposition::ForceApproval,
                "`{}` 的档位不受模式影响",
                cmd
            );
            assert!(
                d.requires_confirmation,
                "`{}` 的档位本身仍标着「需要确认」（Agent 模式读它）",
                cmd
            );

            // Auto：一次都不问。
            assert!(
                !needs_human_confirmation(
                    &AgentMode::Auto,
                    Some(&d),
                    d.disposition,
                    false,
                    &s,
                    false
                ),
                "`{}` 在 Auto 下不该有任何确认",
                cmd
            );

            // Agent：必须问。
            assert!(
                needs_human_confirmation(
                    &AgentMode::Agent,
                    Some(&d),
                    d.disposition,
                    false,
                    &s,
                    false
                ),
                "`{}` 在 Agent 下必须要求人确认",
                cmd
            );
        }
    }

    /// sudo 包装保底抬到「请求审批」；Auto 两种都不问（Auto 里连提权改系统状态也
    /// 不问），Agent 两档都要问。
    #[test]
    fn sudo_wrapping_needs_approval_but_not_in_auto() {
        let s = default_settings();
        // 默认黑名单（rm/mkfs/dd）里没有 sudo，普通模式靠基础定档的保底档要确认。
        let d = decide_command(
            "sudo -n tail -n 20 /var/log/nginx/access.log",
            &AgentMode::Agent,
            &s,
            None,
        );
        assert_eq!(d.disposition, Disposition::Approval);
        assert!(d.requires_confirmation);
        assert!(
            d.reason.contains("sudo"),
            "理由要说清是 sudo 提权，实际 {:?}",
            d.reason
        );

        // Auto 模式跳过这一档 —— 提权看日志不再弹窗。
        let auto = decide_command(
            "sudo -n tail -n 20 /var/log/nginx/access.log",
            &AgentMode::Auto,
            &s,
            None,
        );
        assert_eq!(auto.disposition, Disposition::Allow);
        assert!(!auto.requires_confirmation);

        // 提权改系统状态的照样被里面的规则抬回强制审批：Agent 要人点头，Auto 不问。
        let forced = decide_command("sudo systemctl restart nginx", &AgentMode::Auto, &s, None);
        assert_eq!(forced.disposition, Disposition::ForceApproval);
        assert!(!needs_human_confirmation(
            &AgentMode::Auto,
            Some(&forced),
            forced.disposition,
            false,
            &s,
            false
        ));
        assert!(needs_human_confirmation(
            &AgentMode::Agent,
            Some(&forced),
            forced.disposition,
            false,
            &s,
            false
        ));
    }

    /// 静态理由要进弹窗：模型没给理由时它单独出现，模型给了就并排在后面，
    /// 同一句话不重复，空理由不算数。
    #[test]
    fn static_reasons_reach_the_approval_dialog() {
        assert_eq!(
            merge_approval_reasons(None, Some("命令经 sudo 提权执行".into())),
            Some(vec!["命令经 sudo 提权执行".to_string()])
        );
        assert_eq!(
            merge_approval_reasons(
                Some(vec!["模型判定有风险".to_string()]),
                Some("命令经 sudo 提权执行".into())
            ),
            Some(vec![
                "模型判定有风险".to_string(),
                "命令经 sudo 提权执行".to_string()
            ])
        );
        // 去重：decide_command 的理由与模型理由撞句时不出现两次。
        assert_eq!(
            merge_approval_reasons(
                Some(vec!["命令经 sudo 提权执行".to_string()]),
                Some("命令经 sudo 提权执行".into())
            ),
            Some(vec!["命令经 sudo 提权执行".to_string()])
        );
        // 空白理由与两头皆空都保持 None（前端按"没有理由"渲染）。
        assert_eq!(merge_approval_reasons(None, Some("  ".into())), None);
        assert_eq!(merge_approval_reasons(None, None), None);
    }

    /// Auto 对**任何**档位都不问：`Approval`、`ForceApproval`、以及外置工具自己提的
    /// `requires_default_approval` 一视同仁。Agent 下同样的输入必须问。
    #[test]
    fn auto_never_prompts_for_any_disposition() {
        let s = default_settings();
        for disposition in [Disposition::Allow, Disposition::Approval, Disposition::ForceApproval] {
            for requires_default_approval in [false, true] {
                assert!(
                    !needs_human_confirmation(
                        &AgentMode::Auto,
                        None,
                        disposition,
                        requires_default_approval,
                        &s,
                        false
                    ),
                    "Auto 下 {disposition:?}（requires_default_approval={requires_default_approval}）不该问"
                );
            }
        }
        // 非命令类工具的强制审批档在 Agent 下仍然要问。
        assert!(needs_human_confirmation(
            &AgentMode::Agent,
            None,
            Disposition::ForceApproval,
            false,
            &s,
            false
        ));
        // 外置工具自己提的审批要求同理。
        assert!(needs_human_confirmation(
            &AgentMode::Agent,
            None,
            Disposition::Allow,
            true,
            &s,
            false
        ));
    }

    /// 「交给用户」的唯一判定：Auto 无论谁提出要人都交不出去（既不开窗、也不把
    /// 模型判的 `route_to_human` 当成转人审），其余模式只看那个布尔。
    ///
    /// 这是 Auto 不变量的收口 —— 上面两条"要人确认"的路径任一漏写，这里仍然拦住。
    #[test]
    fn auto_never_hands_anything_to_a_human() {
        for wants_human in [false, true] {
            assert!(
                !can_ask_human(&AgentMode::Auto, wants_human),
                "Auto 下 wants_human={wants_human} 也不该交给用户"
            );
        }
        for mode in [AgentMode::Plan, AgentMode::Agent] {
            assert!(
                !can_ask_human(&mode, false),
                "{mode:?} 下没人要求人参与就不该交给用户"
            );
            assert!(
                can_ask_human(&mode, true),
                "{mode:?} 下有人要求人参与就得交给用户"
            );
        }
    }

    /// **回归：插件声明的强制审批曾被弹窗判定整条丢弃。**
    ///
    /// `decide_command` 的入参里没有 manifest 声明，所以声明了 `ForceApproval` 的插件
    /// 工具算出来仍是「命令文本只算放行」；这里以前在 `Some(d)` 分支只看
    /// `d.requires_confirmation`，于是 Agent 模式关掉「逐条确认」之后，那条声明的强制
    /// 审批命令**不弹窗直接执行**（只有 `Deny` 靠更早的短路侥幸逃过）。这条测试打的
    /// 就是那一跳：允许放行的命令判定 + 强制审批声明。
    ///
    /// Auto 下这条声明也**不**弹窗 —— 那是 Auto 的定义（全自主），不是这一跳的回归。
    #[test]
    fn declared_force_approval_reaches_the_prompt_in_agent_mode() {
        let mut s = default_settings();
        // 让「逐条确认」不参与兜底：必须靠声明本身拦住。
        s.confirm_each_command = false;

        // 只读查询：不在黑名单、逐条确认也关着 → 命令文本判定为放行。
        let d = decide_command("ls -la", &AgentMode::Agent, &s, None);
        assert_eq!(d.disposition, Disposition::Allow, "命令文本算放行");
        assert!(!d.requires_confirmation, "命令文本本身不要求确认");

        // 插件 manifest 声明 ForceApproval（`kind=ssh` 工具）→ 最终档位取严。
        let effective = resolve_disposition(Some(d.disposition), Disposition::ForceApproval, false);
        assert_eq!(effective, Disposition::ForceApproval);

        assert!(
            needs_human_confirmation(&AgentMode::Agent, Some(&d), effective, false, &s, false),
            "Agent 下插件声明的强制审批必须弹窗"
        );
        assert!(
            !needs_human_confirmation(&AgentMode::Auto, Some(&d), effective, false, &s, false),
            "Auto 下插件声明的强制审批也不问"
        );
    }

    /// 内建 `bash` 的档位下限是 `Approval`（见 `tools/bash.rs`）：命令文本算到
    /// `ForceApproval` 时取严仍是 `ForceApproval`，Agent 要人点头；Auto 与默认的
    /// Plan（折成 Auto）都不问。普通命令在任何模式下都静默。
    #[test]
    fn builtin_bash_prompting_is_unchanged() {
        // bash 的声明值；命令类工具的真实档位由命令文本现算后再与它取严。
        let declared = Disposition::Approval;

        for mode in [AgentMode::Plan, AgentMode::Agent, AgentMode::Auto] {
            let mut s = default_settings();
            s.confirm_each_command = false;

            // 系统级命令：命令文本自己就要人点头。
            let d = decide_command("systemctl restart nginx", &mode, &s, None);
            assert_eq!(d.disposition, Disposition::ForceApproval);
            assert!(d.requires_confirmation);
            let effective = resolve_disposition(Some(d.disposition), declared, false);
            let expect_prompt = mode == AgentMode::Agent;
            assert_eq!(
                needs_human_confirmation(&mode, Some(&d), effective, false, &s, false),
                expect_prompt,
                "{mode:?} 下系统级命令的弹窗判定不对"
            );

            // 普通命令：名单不命中 + 关掉逐条确认 → 任何模式都静默放行。
            let d = decide_command("ls -la", &mode, &s, None);
            assert_eq!(d.disposition, Disposition::Allow);
            let effective = resolve_disposition(Some(d.disposition), declared, false);
            assert_eq!(effective, Disposition::Approval, "bash 的声明是档位下限");
            assert!(
                !needs_human_confirmation(&mode, Some(&d), effective, false, &s, false),
                "{mode:?} 下普通命令不该弹窗"
            );
        }
    }

    /// 只读的非命令类工具（`read_history` 这种：`Disposition::Allow` + 没有命令参数
    /// + 不要求默认审批）在三档模式下都**不弹窗** —— 它不是命令、也不碰路径，
    /// 不该被逐条确认拖住。
    #[test]
    fn allow_only_non_command_tools_never_prompt() {
        let s = default_settings();
        for mode in [AgentMode::Plan, AgentMode::Agent, AgentMode::Auto] {
            assert!(
                !needs_human_confirmation(&mode, None, Disposition::Allow, false, &s, false),
                "{mode:?} 下只读工具不该弹窗"
            );
        }
    }

    /// 受保护路径 → 强制审批，而且**用户自定义的那份也算**（档位不看模式；
    /// 弹窗只看模式：Agent 问、Auto 不问）。
    #[test]
    fn protected_paths_force_approval() {
        let mut s = default_settings();
        s.confirm_each_command = false;
        let policy = SecurityPolicy {
            custom_protected_paths: vec!["/srv/prod".into()],
            ..Default::default()
        };

        let d = decide_command(
            "tee /srv/prod/app.conf",
            &AgentMode::Auto,
            &s,
            Some(&policy),
        );
        assert_eq!(d.disposition, Disposition::ForceApproval);
        assert!(d.requires_confirmation);
        assert!(needs_human_confirmation(
            &AgentMode::Agent,
            Some(&d),
            d.disposition,
            false,
            &s,
            false
        ));
        assert!(!needs_human_confirmation(
            &AgentMode::Auto,
            Some(&d),
            d.disposition,
            false,
            &s,
            false
        ));
    }

    /// 普通命令在 Auto 下静默 —— 强制审批那一档不能把整个 Auto 模式变成逐条弹窗。
    #[test]
    fn ordinary_commands_stay_silent_in_auto() {
        let s = default_settings();
        let d = decide_command("ls -la", &AgentMode::Auto, &s, None);
        assert_eq!(d.disposition, Disposition::Allow);
        assert!(!needs_human_confirmation(
            &AgentMode::Auto,
            Some(&d),
            d.disposition,
            false,
            &s,
            false
        ));
    }

    /// **Plan 默认与 Auto 同档，「Plan 模式也需要审批」打开后回到 Agent 那一套。**
    ///
    /// 诉求是「Plan 下执行 bash 默认不需要审批（和 Auto 一样），但要能关回去」。
    /// 两侧都要钉：默认静默时 Plan 的结论必须与 Auto **逐项相等**（不是"也静默"
    /// 就算 —— 系统级命令的判定得一起搬过来），打开开关后必须回到走名单的旧行为。
    /// 只测一侧等于给一半的护栏。
    #[test]
    fn plan_mode_is_silent_by_default_and_the_setting_gates_it_back() {
        // bash 的声明值（`tools/bash.rs`）：命令文本现算后再与它取严。
        let declared = Disposition::Approval;

        let mut silent = default_settings();
        // 默认设置里 `confirm_each_command` 就是 true —— 摩擦的来源。
        silent.confirm_each_command = true;
        let mut gated = silent.clone();
        gated.plan_mode_requires_approval = true;

        for cmd in ["ls -la", "grep -rn TODO /var/log"] {
            // 开关关着：Plan 与 Auto 逐项相等，且不弹窗。
            let plan = decide_command(cmd, &AgentMode::Plan, &silent, None);
            let auto = decide_command(cmd, &AgentMode::Auto, &silent, None);
            assert_eq!(
                plan.disposition, auto.disposition,
                "`{cmd}` 的档位要与 Auto 一致"
            );
            assert_eq!(plan.requires_confirmation, auto.requires_confirmation);
            assert_eq!(plan.disposition, Disposition::Allow);
            assert!(
                !needs_human_confirmation(
                    &AgentMode::Plan,
                    Some(&plan),
                    resolve_disposition(Some(plan.disposition), declared, false),
                    false,
                    &silent,
                    false
                ),
                "`{cmd}` 在 Plan 下不该弹窗"
            );

            // 开关打开：回到「走名单 + 逐条确认」。
            let plan = decide_command(cmd, &AgentMode::Plan, &gated, None);
            assert_eq!(plan.disposition, Disposition::Approval, "开关打开后走名单");
            assert!(plan.requires_confirmation);
            assert!(
                needs_human_confirmation(
                    &AgentMode::Plan,
                    Some(&plan),
                    resolve_disposition(Some(plan.disposition), declared, false),
                    false,
                    &gated,
                    false
                ),
                "`{cmd}` 开着开关时必须弹窗"
            );
        }

        // 开关打开后 Plan 才回到「走名单 + 人工审批」；开关关着时 Plan 折成 Auto，
        // 连系统级命令也不问。所以**同一个开关**同时决定这两件事。
        let silent_system = decide_command("systemctl restart nginx", &AgentMode::Plan, &silent, None);
        assert_eq!(silent_system.disposition, Disposition::ForceApproval);
        assert!(
            !needs_human_confirmation(
                &AgentMode::Plan,
                Some(&silent_system),
                resolve_disposition(Some(silent_system.disposition), declared, false),
                false,
                &silent,
                false
            ),
            "开关关着时 Plan 折成 Auto，系统级命令也不问"
        );

        let gated_system = decide_command("systemctl restart nginx", &AgentMode::Plan, &gated, None);
        assert_eq!(gated_system.disposition, Disposition::ForceApproval);
        assert!(gated_system.requires_confirmation, "强制审批档自己就要确认");
        assert!(needs_human_confirmation(
            &AgentMode::Plan,
            Some(&gated_system),
            resolve_disposition(Some(gated_system.disposition), declared, false),
            false,
            &gated,
            false
        ));

        // 开关只对 Plan 生效：Agent / Auto 的档位与弹窗判定前后一模一样。
        for cmd in ["ls -la", "systemctl restart nginx"] {
            for mode in [AgentMode::Agent, AgentMode::Auto] {
                let before = decide_command(cmd, &mode, &silent, None);
                let after = decide_command(cmd, &mode, &gated, None);
                assert_eq!(
                    before.disposition, after.disposition,
                    "{mode:?} 不受开关影响"
                );
                assert_eq!(
                    needs_human_confirmation(
                        &mode,
                        Some(&before),
                        resolve_disposition(Some(before.disposition), declared, false),
                        false,
                        &silent,
                        false
                    ),
                    needs_human_confirmation(
                        &mode,
                        Some(&after),
                        resolve_disposition(Some(after.disposition), declared, false),
                        false,
                        &gated,
                        false
                    ),
                    "{mode:?} 的弹窗判定不受开关影响"
                );
            }
        }
    }

    /// 名单决定 `Approval` / `Allow` 这一档：命中就审、不命中就放。
    #[test]
    fn the_command_list_decides_between_approval_and_allow() {
        let mut s = default_settings();
        s.confirm_each_command = false;

        // 黑名单模式：撞上名单 → 审批；没撞上 → 放行。
        assert_eq!(
            decide_command("rm -rf /tmp/x", &AgentMode::Agent, &s, None).disposition,
            Disposition::Approval
        );
        assert_eq!(
            decide_command("ls -la", &AgentMode::Agent, &s, None).disposition,
            Disposition::Allow
        );

        // 白名单模式：命中 → 放行；不命中 → 审批。
        s.list_mode = CommandListMode::Allowlist;
        s.command_list = vec!["ls".into()];
        assert_eq!(
            decide_command("ls -la", &AgentMode::Agent, &s, None).disposition,
            Disposition::Allow
        );
        assert_eq!(
            decide_command("cat /tmp/x", &AgentMode::Agent, &s, None).disposition,
            Disposition::Approval
        );
    }

    // ──────────── resolve_disposition：声明的档位必须被读到 ────────────

    /// **回归：插件 `kind=ssh` 声明的档位曾被命令文本顶掉。**
    ///
    /// `rendered_command()` 对所有 ssh 工具返回 `Some(渲染后的命令)`，于是
    /// "有命令文本"这一支恒成立、`tool.disposition()` 再也不被读 —— manifest 里
    /// 声明 `ForceApproval` 的工具在关掉「逐条确认」后会静默执行。两个来源取严
    /// 才把它救回来。
    #[test]
    fn a_declared_force_approval_survives_a_benign_command() {
        // 命令文本只算到 Allow（`top -bn1` 是只读查询），声明是强制审批 → 取强制审批。
        assert_eq!(
            resolve_disposition(Some(Disposition::Allow), Disposition::ForceApproval, false),
            Disposition::ForceApproval,
            "插件声明的强制审批不能被命令文本顶掉"
        );
        // 声明 Deny 同理（文档承诺「不执行」）。
        assert_eq!(
            resolve_disposition(Some(Disposition::Allow), Disposition::Deny, false),
            Disposition::Deny
        );
    }

    /// 反过来：声明 `Allow` 压不住命令文本里的灾难判定 —— 插件不能靠声明把自己
    /// 的危险命令说成安全。
    #[test]
    fn a_declared_allow_cannot_downgrade_the_command_text() {
        assert_eq!(
            resolve_disposition(Some(Disposition::Deny), Disposition::Allow, false),
            Disposition::Deny
        );
        assert_eq!(
            resolve_disposition(Some(Disposition::ForceApproval), Disposition::Allow, false),
            Disposition::ForceApproval
        );
    }

    /// 受保护路径那一支同样只升不降，而且对**没有命令文本**的工具也成立
    /// （`write_file` 这类走的就是这一支）。
    #[test]
    fn a_protected_path_write_raises_but_never_lowers() {
        assert_eq!(
            resolve_disposition(None, Disposition::Allow, true),
            Disposition::ForceApproval
        );
        assert_eq!(
            resolve_disposition(None, Disposition::Deny, true),
            Disposition::Deny,
            "已经声明成拒绝的，不能被受保护路径那一支降下来"
        );
        assert_eq!(
            resolve_disposition(None, Disposition::Allow, false),
            Disposition::Allow,
            "只有工具自己声明时，声明就是结论"
        );
    }

    /// 解析不了的命令在**三档模式下都是拒绝**，而且不是"要确认" —— 直接回给模型改写。
    ///
    /// 这条曾经断言 `Approval`（Agent 模式下被命令名单保守拦下）。只测 Agent 会漏掉
    /// 真正的洞：Auto 分支不看名单，那时它落到 `Allow`（无判定、无弹窗、直接执行），
    /// 所以必须逐档钉住。
    #[test]
    fn unparsable_commands_are_denied_in_every_mode() {
        let mut s = default_settings();
        s.confirm_each_command = false;
        for mode in [AgentMode::Plan, AgentMode::Agent, AgentMode::Auto] {
            let d = decide_command("echo $(cat /etc/shadow)", &mode, &s, None);
            assert_eq!(
                d.disposition,
                Disposition::Deny,
                "{:?} 下解析不了也必须拒绝",
                mode
            );
            assert!(!d.requires_confirmation, "拒绝不是「要不要确认」的问题");
            assert!(
                d.reason.contains("无法解析"),
                "理由要让模型看懂是解析问题，实际是 {:?}",
                d.reason
            );
        }
    }

    #[test]
    fn denylist_in_list_always_confirms() {
        let s = default_settings();
        assert!(command_list_requires_confirm("rm -rf /tmp", &s));
        assert!(command_list_requires_confirm("mkfs /dev/sda", &s));
        assert!(command_list_requires_confirm("dd if=/dev/zero of=img", &s));
    }

    #[test]
    fn denylist_not_in_list_respects_confirm_flag() {
        let s = default_settings();
        assert!(!command_list_requires_confirm("ls -la", &s));

        let mut s2 = default_settings();
        s2.confirm_each_command = true;
        assert!(command_list_requires_confirm("ls -la", &s2));
    }

    #[test]
    fn allowlist_in_list_respects_confirm_flag() {
        let s = AgentModeSettings {
            list_mode: CommandListMode::Allowlist,
            command_list: vec!["ls".into(), "cat".into()],
            confirm_each_command: false,
            plan_mode_requires_approval: false,
            enable_model_command_approval: false,
            command_approval_engine: CommandApprovalEngine::Model,
            jev_model_id: String::new(),
            jev_base_url: String::new(),
            jev_reason_followup: false,
            jev_approval_prompt: String::new(),
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            system_prompt: String::new(),
            max_tool_rounds: 80,
            context_window: 0,
            confirm_edit_file: false,
        };
        assert!(!command_list_requires_confirm("ls -la", &s));

        let mut s2 = s.clone();
        s2.confirm_each_command = true;
        assert!(command_list_requires_confirm("ls -la", &s2));
    }

    #[test]
    fn allowlist_not_in_list_always_confirms() {
        let s = AgentModeSettings {
            list_mode: CommandListMode::Allowlist,
            command_list: vec!["ls".into()],
            confirm_each_command: false,
            plan_mode_requires_approval: false,
            enable_model_command_approval: false,
            command_approval_engine: CommandApprovalEngine::Model,
            jev_model_id: String::new(),
            jev_base_url: String::new(),
            jev_reason_followup: false,
            jev_approval_prompt: String::new(),
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            system_prompt: String::new(),
            max_tool_rounds: 80,
            context_window: 0,
            confirm_edit_file: false,
        };
        assert!(command_list_requires_confirm("rm -rf /tmp", &s));
    }

    #[test]
    fn strips_path_prefix_from_base_command() {
        let s = default_settings();
        assert!(command_list_requires_confirm("/bin/rm -rf /tmp", &s));
        assert!(command_list_requires_confirm("/usr/bin/mkfs -t ext4", &s));
    }

    #[test]
    fn handles_empty_and_whitespace() {
        let s = default_settings();
        assert!(!command_list_requires_confirm("", &s));
        assert!(!command_list_requires_confirm("   ", &s));
    }

    #[test]
    fn confirm_each_command_true_overrides() {
        let s = AgentModeSettings {
            list_mode: CommandListMode::Denylist,
            command_list: vec![],
            confirm_each_command: true,
            plan_mode_requires_approval: false,
            enable_model_command_approval: false,
            command_approval_engine: CommandApprovalEngine::Model,
            jev_model_id: String::new(),
            jev_base_url: String::new(),
            jev_reason_followup: false,
            jev_approval_prompt: String::new(),
            model_approval_model: String::new(),
            model_approval_prompt: String::new(),
            system_prompt: String::new(),
            max_tool_rounds: 80,
            context_window: 0,
            confirm_edit_file: false,
        };
        assert!(command_list_requires_confirm("echo hello", &s));
        assert!(command_list_requires_confirm("git status", &s));
    }

    #[test]
    fn detects_denylisted_cmd_after_newline() {
        let s = default_settings();
        // "ls\nrm -rf /etc" — rm is hidden behind a newline, must be caught
        assert!(command_list_requires_confirm("ls\nrm -rf /etc", &s));
        // CRLF variant
        assert!(command_list_requires_confirm("ls\r\nrm -rf /etc", &s));
        // Multiple segments, denylisted cmd is the last one
        assert!(command_list_requires_confirm(
            "ls\necho hi\nmkfs /dev/sda",
            &s
        ));
        // Denylisted cmd after semicolon (already worked, regression test)
        assert!(command_list_requires_confirm("ls; rm -rf /", &s));
    }

    #[test]
    fn conservative_on_unparseable_input() {
        let s = default_settings();
        // Subshell detected → conservative: require confirm
        assert!(command_list_requires_confirm("ls $(rm -rf /)", &s));
        // Backtick subshell
        assert!(command_list_requires_confirm("ls `rm -rf /`", &s));
    }

    // ── 审批者构造：闸门不许无声消失 ──

    /// **回归：`build_jev_approver` 构造失败曾返回 `None`，那等于该任务没有模型审批。**
    ///
    /// `dispatch` 里是 `if let Some(ref approver)`，拿不到 approver 就整段跳过（注释
    /// 写着"不静默降级"，行为却正相反）。现在构造失败给出一个每次调用都明确报错的
    /// 替身：命令被拦下并带上原因，与"选了 Jev 却没配 Key"走同一条路。
    /// `build_*_approver` 的返回类型里也不再是 `Option`，这条不变式由类型保证。
    #[tokio::test]
    async fn failed_approver_construction_blocks_instead_of_vanishing() {
        let approver = UnavailableApprover::new("Jev HTTP 客户端初始化失败".to_string());
        let err = approver
            .evaluate("ls -la", &[])
            .await
            .expect_err("替身必须拒绝每一次判定");

        let msg = err.to_string();
        assert!(msg.contains("Jev HTTP 客户端初始化失败"), "实际是 {msg}");
        assert!(
            msg.contains("拦下"),
            "要让用户知道命令没被执行，实际是 {msg}"
        );
        assert!(msg.contains("设置"), "要给出下一步，实际是 {msg}");
    }

    /// 另一条「闸门必须还在」的路：选了 Jev 但没配 Key。它的 approver 也得每次
    /// 明确报错，而不是回退成放行 —— 由 `build_jev_approver` 的返回类型（没有
    /// `None`）保证构造出口只有这一个。
    #[tokio::test]
    async fn unconfigured_jev_approver_reports_itself_on_every_call() {
        let approver = ToolDispatcher::build_jev_approver(None, "", "", "", false, false);
        let err = approver
            .evaluate("ls -la", &[])
            .await
            .expect_err("没配 Key 必须明确报错");
        assert!(
            err.to_string().contains("TypeSafe API Key"),
            "实际是 {}",
            err
        );
    }

    // ── read-before-edit ──

    #[test]
    fn read_before_edit_error_message_format() {
        let msg = read_before_edit_error("/var/www/app.js");
        assert_eq!(
            msg,
            "错误：编辑操作需要先读取\"/var/www/app.js\" —— 请先读取该文件，然后再重试。"
        );
    }

    #[test]
    fn read_before_write_error_message_format() {
        let msg = read_before_write_error("/var/www/app.js");
        assert_eq!(
            msg,
            "错误：覆盖已有文件需要先读取\"/var/www/app.js\" —— 请先读取该文件，然后再重试。"
        );
    }

    #[test]
    fn path_was_read_matches_after_normalization() {
        let mut read = std::collections::HashSet::new();
        // 读取时带了冗余路径成分，编辑时用干净路径 → 归一化后应匹配
        read.insert(crate::agent::risk::normalize_path("/var//www/./app.js"));
        assert!(path_was_read(&read, "/var/www/app.js"));
        // 尾斜杠差异也应匹配
        assert!(path_was_read(&read, "/var/www/app.js/"));
        // 未读过的路径不匹配
        assert!(!path_was_read(&read, "/var/www/other.js"));
        // 空集合不匹配任何路径
        let empty = std::collections::HashSet::new();
        assert!(!path_was_read(&empty, "/var/www/app.js"));
    }
}
