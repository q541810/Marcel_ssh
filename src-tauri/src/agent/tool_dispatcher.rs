use serde::Serialize;

use crate::agent::approval::ApprovalManager;
use crate::agent::model_approval::{CommandApprover, ModelApprovalDecision, ModelApprover};
use crate::agent::risk::{split_command_chain, Disposition, RiskAssessor, SecurityPolicy};
use crate::agent::task::AgentMode;
use crate::agent::tools::{PathWrite, ToolContext, ToolOutput, ToolRegistry};
use crate::config::settings::{AgentModeSettings, CommandListMode};
use crate::emit_event;
use crate::llm::manager::LlmManager;
use crate::llm::provider::{LlmConfig, LlmMessage, ToolCall};
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
    ) -> Self {
        let enable = agent_settings.enable_model_command_approval;
        let approver: Option<std::sync::Arc<dyn CommandApprover>> = if enable {
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
            // 审批提示词是否按「Plan 模式只读」渲染：取决于本任务实际工具
            // 定位（自身 mode）。Auto 父派发的静默子 agent 自身仍是 Plan
            // 只读工具集，这里自然为 true——plan 提示词约束"不得修改系统"
            // 对只读调研场景更保守，与 approval_mode 静默放行互补。
            let is_plan_mode = matches!(mode, AgentMode::Plan);
            Some(std::sync::Arc::new(ModelApprover::new(
                approval_manager,
                agent_settings.model_approval_prompt.clone(),
                is_plan_mode,
            )))
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
        let approval_mode = self.approval_mode.as_ref().unwrap_or(&self.mode);
        let command_decision = declares_command.then(|| {
            decide_command(
                command.unwrap_or(""),
                approval_mode,
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
            return DispatchResult::blocked(summary, reason, Disposition::Deny);
        }

        let requires_default_approval = tool.requires_approval_by_default();

        // 0.5 / 0.6 写前必须已读：注定失败的写会直接失败并提示先读取，不进入审批
        // 流程（不值得让用户为一次注定失败的调用点确认）。强度由声明决定：
        //   Edit      —— 改写既有文件，目标必须已读过；
        //   Overwrite —— 覆盖已存在的目标前要求已读过，新建放行。
        match path_write {
            PathWrite::Edit => {
                if let Some(path) = path {
                    if !path_was_read(&self.read_files.read(), path) {
                        return DispatchResult::from_tool_output(
                            ToolOutput::fail(
                                format!("edit {}", path),
                                read_before_edit_error(path),
                            ),
                            effective_disposition,
                        );
                    }
                }
            }
            PathWrite::Overwrite => {
                if let Some(path) = path {
                    if !path_was_read(&self.read_files.read(), path)
                        && remote_file_exists(&ctx.ssh, &ctx.session_id, path).await
                    {
                        return DispatchResult::from_tool_output(
                            ToolOutput::fail(
                                format!("write {}", path),
                                read_before_write_error(path),
                            ),
                            effective_disposition,
                        );
                    }
                }
            }
            PathWrite::None => {}
        }

        // 1. 需不需要人确认 —— 模式 × 档位 × 命令名单三者的交叉点。
        //    命令类工具的结论来自 `decide_command`（它把风险评估和名单一起算完，
        //    `deny` 已经在上面短路掉了）；其余工具按自己声明的档位走。
        let assessed_needs_confirm = needs_human_confirmation(
            approval_mode,
            command_decision.as_ref(),
            effective_disposition,
            requires_default_approval,
            &self.agent_settings,
            semantics
                .and_then(|s| s.approval_switch)
                .map(|switch| switch.is_on(&self.agent_settings))
                .unwrap_or(false),
        );

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
                    Ok(ModelApprovalDecision::Block(rs)) => {
                        emit_event(
                            &ctx.app_handle,
                            event_name,
                            ModelApprovalDoneEvent {
                                event_type: "modelApprovalDone".to_string(),
                                tool_call_id: tc.id.clone(),
                                decision: "block".to_string(),
                                reasons: rs.clone(),
                            },
                        );
                        let reason = if rs.is_empty() {
                            "模型审批阻止".to_string()
                        } else {
                            format!("模型审批阻止: {}", rs.join("; "))
                        };
                        let hint = "\n如果你认为这个命令是被冤枉阻止的，请先解释你的理由，然后重新尝试执行。";
                        return DispatchResult::blocked(
                            format!("$ {}", cmd),
                            format!("{}{}", reason, hint),
                            effective_disposition,
                        );
                    }
                    Ok(ModelApprovalDecision::RouteToHuman(rs)) => {
                        emit_event(
                            &ctx.app_handle,
                            event_name,
                            ModelApprovalDoneEvent {
                                event_type: "modelApprovalDone".to_string(),
                                tool_call_id: tc.id.clone(),
                                decision: "route_to_human".to_string(),
                                reasons: rs.clone(),
                            },
                        );
                        // Auto 模式下跳过人审，直接执行；Agent/Plan 模式弹窗。
                        // 判定同样遵循 approval_mode：Auto 父派发的只读子
                        // agent（自身 Plan）在 route_to_human 时也不转人审。
                        // 例外：强制审批档。Auto 拦不住它，模型说"要转人审"
                        // 时当然更不能把它咽掉。
                        if *approval_mode != AgentMode::Auto
                            || effective_disposition.survives_auto()
                        {
                            final_needs_confirm = true;
                            model_reasons = if rs.is_empty() { None } else { Some(rs) };
                        }
                    }
                    Ok(ModelApprovalDecision::Approve) => {
                        emit_event(
                            &ctx.app_handle,
                            event_name,
                            ModelApprovalDoneEvent {
                                event_type: "modelApprovalDone".to_string(),
                                tool_call_id: tc.id.clone(),
                                decision: "approve".to_string(),
                                reasons: vec![],
                            },
                        );
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
                            },
                        );
                        return DispatchResult::blocked(
                            format!("$ {}", cmd),
                            format!("模型审批失败: {}", err_msg),
                            effective_disposition,
                        );
                    }
                }
            }
        }

        // 3. Human approval (if the risk assessment or the model requires it).
        if final_needs_confirm {
            let mut approval_metadata: Option<serde_json::Value> = None;

            // 需要预演的工具（`edit_file`）先做一次预读 + 校验再问用户：
            // 会让 execute() 失败的调用不该打开审批对话框。
            if semantics
                .map(|s| s.preview_before_approval)
                .unwrap_or(false)
            {
                match crate::agent::tools::file_ops::preview_edit_for_approval(
                    &ctx.ssh,
                    &ctx.session_id,
                    &tc.arguments,
                )
                .await
                {
                    Ok(meta) => approval_metadata = Some(meta),
                    Err(e) => {
                        return DispatchResult {
                            summary: e.summary,
                            output: e.message,
                            success: false,
                            blocked: false,
                            was_timeout: false,
                            was_aborted: false,
                            metadata: None,
                            disposition: effective_disposition,
                        };
                    }
                }
            }

            set_task_status(
                &self.state,
                &self.task_id,
                crate::agent::task::AgentStatus::WaitingApproval,
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
                    model_reasons.as_deref(),
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
                return DispatchResult::blocked(
                    summary,
                    rejection_message(answer.reason.as_deref()),
                    effective_disposition,
                );
            }
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

/// 远程目标是否存在（SFTP stat）。stat 失败按"不存在"处理：
/// 连接问题会由 write 自己报 SFTP 错误，这里不双重误拦新建。
async fn remote_file_exists(
    ssh: &crate::ssh::connection::SshManager,
    session_id: &str,
    path: &str,
) -> bool {
    match ssh.open_sftp(session_id).await {
        Ok(sftp) => sftp.metadata(path).await.is_ok(),
        Err(_) => false,
    }
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

/// 给一条命令下结论：**风险评估 + 命令名单一起算，这是唯一一份实现**。
///
/// dispatcher 用它决定要不要拦、要不要弹窗，设置页的「命令测试」也用它 —— 那两处
/// 曾经各写了一份，导致设置页测出来的结论和真实执行时的行为可以不一样（设置页那
/// 份甚至完全不看风险评估）。改这里就是改两处。
///
/// 四档的产生方式：
///   - `Deny` —— 只有灾难模式判定能产出（见 `risk/checker.rs`），不征求意见
///   - `ForceApproval` —— 系统级命令 / 受保护路径 / `sudo` …，Auto 也拦
///   - `Approval` / `Allow` —— 由命令名单决定（白名单命中就放行、黑名单命中就要审批）
pub(crate) fn decide_command(
    cmd: &str,
    mode: &AgentMode,
    settings: &AgentModeSettings,
    policy: Option<&SecurityPolicy>,
) -> CommandDecision {
    let assessment = RiskAssessor::from_optional(policy).assess_command(cmd);

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
            let needs_confirm = match mode {
                AgentMode::Plan | AgentMode::Agent => command_list_requires_confirm(cmd, settings),
                AgentMode::Auto => false,
            };
            CommandDecision {
                disposition: if needs_confirm {
                    Disposition::Approval
                } else {
                    Disposition::Allow
                },
                reason: if needs_confirm {
                    "命中命令名单的确认规则，需要用户确认".to_string()
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
pub(crate) fn needs_human_confirmation(
    approval_mode: &AgentMode,
    command_decision: Option<&CommandDecision>,
    effective_disposition: Disposition,
    requires_default_approval: bool,
    settings: &AgentModeSettings,
    approval_switch_on: bool,
) -> bool {
    match approval_mode {
        AgentMode::Plan | AgentMode::Agent => match command_decision {
            Some(d) => d.requires_confirmation,
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
        // Auto 模式不是"万事不商量"：强制审批档连 Auto 都拦得住，这正是它与
        // 「请求审批」的唯一差别。`requires_default_approval` 是外置工具（MCP）
        // 自己提的要求，同样带上。
        AgentMode::Auto => match command_decision {
            Some(d) => d.requires_confirmation,
            None => effective_disposition.survives_auto() || requires_default_approval,
        },
    }
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
            enable_model_command_approval: false,
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
            assert_eq!(d.disposition, Disposition::Deny, "{:?} 模式下也应当拒绝", mode);
            assert!(!d.requires_confirmation, "拒绝不是「要不要确认」的问题");
            assert!(d.reason.contains("/etc"), "理由要能让模型知道踩了哪一步");
        }
    }

    /// 强制审批：**Auto 模式也拦得住**，这是它和「请求审批」的唯一差别。
    ///
    /// 走的是 `needs_human_confirmation`（`dispatch` 调的同一个函数），不是
    /// `decide_command` —— 后者在 Auto 下也一样返回"要确认"，只测它的话，
    /// 把 `dispatch` 的 Auto 分支改回只看 `requires_default_approval` 也照样绿，
    /// 那护栏就是假的（这版第一稿正是这么写的）。
    #[test]
    fn force_approval_survives_auto_mode() {
        let mut s = default_settings();
        // 名单里没有 reboot，且关掉了「逐条确认」—— 按名单逻辑它本该静默放行。
        s.confirm_each_command = false;

        for cmd in ["reboot", "systemctl restart nginx", "sudo apt update"] {
            let d = decide_command(cmd, &AgentMode::Auto, &s, None);
            assert_eq!(
                d.disposition,
                Disposition::ForceApproval,
                "`{}` 在 Auto 下也必须是强制审批",
                cmd
            );
            assert!(
                needs_human_confirmation(&AgentMode::Auto, Some(&d), d.disposition, false, &s, false),
                "`{}` 在 Auto 下必须要求人确认",
                cmd
            );
        }
    }

    /// 非命令类工具（声明了强制审批档的）在 Auto 下同样拦得住。
    #[test]
    fn force_approval_survives_auto_for_non_command_tools() {
        let s = default_settings();
        assert!(needs_human_confirmation(
            &AgentMode::Auto,
            None,
            Disposition::ForceApproval,
            false,
            &s,
            false
        ));
        // 但普通的"请求审批"档在 Auto 下不弹 —— Auto 不能变成逐条确认。
        assert!(!needs_human_confirmation(
            &AgentMode::Auto,
            None,
            Disposition::Approval,
            false,
            &s,
            false
        ));
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
        // 反过来：同一个工具若被标成强制审批档（例如将来收紧了），Auto 也拦得住
        assert!(needs_human_confirmation(
            &AgentMode::Auto,
            None,
            Disposition::ForceApproval,
            false,
            &s,
            false
        ));
    }

    /// 受保护路径 → 强制审批，而且**用户自定义的那份也算**。
    #[test]
    fn protected_paths_force_approval_even_in_auto() {
        let s = default_settings();
        let policy = SecurityPolicy {
            custom_protected_paths: vec!["/srv/prod".into()],
            ..Default::default()
        };

        let d = decide_command("tee /srv/prod/app.conf", &AgentMode::Auto, &s, Some(&policy));
        assert_eq!(d.disposition, Disposition::ForceApproval);
        assert!(d.requires_confirmation);
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
            enable_model_command_approval: false,
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
            enable_model_command_approval: false,
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
            enable_model_command_approval: false,
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
