//! Agent 回合主循环（`run_agent_loop`）。
//!
//! 本目录由原单文件 `agent_loop.rs` 拆出（纯提取、零行为变化）：
//! - `mod.rs`：回合主干与共享的常量 / 类型 / 纯辅助函数；
//! - `phases.rs`：回合的各阶段函数（回合准备 / 单轮 LLM 请求 / 无工具回复
//!   处置 / 工具轮持久化 / 最大轮数收尾）；
//! - `tool_exec.rs`：工具调用分批与单工具执行。

use tauri::AppHandle;

use crate::agent::conversation::ConversationDb;
use crate::agent::conversation_persister::PromptOrigin;
use crate::agent::plan_handler::emit_final_plan_normalized;
use crate::agent::task::AgentMode;
use crate::agent::thinking_filter::strip_thinking_tags;
use crate::agent::tool_dispatcher::ToolDispatcher;
use crate::agent::tools::ToolRegistry;
use crate::config::settings::AgentModeSettings;
use crate::emit_event;
use crate::llm::jev::JevConfig;
use crate::llm::manager::LlmManager;
use crate::llm::provider::{LlmConfig, LlmMessage, ToolDefinition};
use crate::llm::streaming::StreamEvent;
use crate::ssh::connection::SshManager;
use crate::AppState;

mod phases;
mod tool_exec;

#[cfg(all(test, target_os = "windows"))]
mod scripted_tests;

use self::phases::{
    finish_text_reply, persist_assistant_tool_calls, prepare_turn, report_max_rounds_exceeded,
    request_round_reply, resolve_summarizer_manager, RoundOutcome, TextReplyOutcome,
};
use self::tool_exec::execute_tool_batches;

/// 最大并发执行的 tool 调用数量（超出则排队等待 permit 释放）。
/// 移动端收紧：单 WebView + 电池/内存约束下，10 路并发 tool（含多机
/// subagent 各自拉起 SSH + LLM 流）容易导致 UI 卡顿与系统杀进程。
#[cfg(desktop)]
const MAX_CONCURRENT_TOOL_EXECUTIONS: usize = 10;
#[cfg(not(desktop))]
const MAX_CONCURRENT_TOOL_EXECUTIONS: usize = 2;

/// 持久化的工具执行结果元数据（存入 role=tool 的 tool_calls_json）。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct PersistedToolResult {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
    /// 历史行里这个键叫 `risk_level`、值是五档严重度（`LowRisk` 之类）。
    /// 这里的别名加上 `Disposition` 自带的变体别名一起把它们读进来，
    /// 老会话照常打开、不需要数据迁移。
    #[serde(alias = "risk_level")]
    pub disposition: crate::agent::risk::Disposition,
    pub summary: String,
    pub success: bool,
    pub blocked: bool,
    #[serde(default)]
    pub was_timeout: bool,
    #[serde(default)]
    pub was_aborted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metadata: Option<serde_json::Value>,
}

/// 持久化的 assistant tool_calls 列表（存入 role=assistant 的 tool_calls_json）。
/// 与 PersistedToolResult 区分：assistant 侧是完整并行 tool call 列表，
/// 用于跨 task 重建 LLM history，避免被拆成多条假 assistant。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct PersistedAssistantToolCall {
    pub id: String,
    pub name: String,
    pub arguments: serde_json::Value,
}

/// Checks if a task has been cancelled by the user.
///
/// 问的是「因取消而终止」而不是「已终态」—— 失败的任务不该让循环表现为被取消
/// （谓词语义见 `AgentStatus::is_cancelled`）。
fn is_task_cancelled(state: &AppState, task_id: &str) -> bool {
    state
        .agent_tasks
        .read()
        .get(task_id)
        .is_some_and(|t| t.status.is_cancelled())
}

/// 把一批已结算的后台作业渲染成一条给模型的 user 通知。
/// 格式对齐 DSH completion notice：列出 job_id、描述与终态，
/// 并指示用 `job_output` 读取输出。多条合并为一条（一次决策）。
///
/// **两个调用方共用这一份文本**：本轮内注入（模型还在跑，见本文件的自然
/// 结束守卫）与跨轮唤醒（前端经 `job_pending_notice` 取走，开新一轮交给
/// 模型）。两处各写一份必然分叉。
pub(crate) fn build_job_settlement_notice(jobs: &[crate::command_exec::JobInfo]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for j in jobs {
        let status = match j.status {
            crate::command_exec::JobStatus::Completed => "已完成",
            crate::command_exec::JobStatus::Killed => "已被终止",
            crate::command_exec::JobStatus::Failed => "执行失败",
            // 恢复出来的历史作业本不该走到这里（它们的结算发生在
            // 上一次运行）；穷尽列出，真出现时如实说。
            crate::command_exec::JobStatus::Interrupted => "随应用退出中断",
            crate::command_exec::JobStatus::Running => "仍在运行", // 理论不可达
        };
        let desc = if j.description.is_empty() {
            j.command.clone()
        } else {
            j.description.clone()
        };
        lines.push(format!("后台作业 {}（{}）{}", j.job_id, desc, status));
    }
    lines.push(
        "用 job_output(job_id=...) 读取其输出并纳入结论；\
         若作业已不再需要，可用 job_kill 终止。"
            .to_string(),
    );
    lines.join("\n")
}

/// 一轮请求结束后的上下文快照（占用环那几个数）。
///
/// provider 报了用量 → 用它的 prompt 总量（**精确值**）；没报 → 退回本地估算
/// 并置 `estimated`（界面加 `~`，不能把估算讲成精确值）。三段构成**始终是估算**
/// —— provider 不给这个拆分，这也是为什么前端分段条只有长度可信。
fn round_context_snapshot(
    round: Option<&crate::llm::provider::TokenUsage>,
    breakdown: crate::agent::context::meter::ContextBreakdown,
) -> crate::agent::conversation::LastContext {
    let estimated_total = (breakdown.system + breakdown.tools + breakdown.messages) as u64;
    crate::agent::conversation::LastContext {
        used_tokens: round
            .map(|u| u.prompt_tokens as u64)
            .unwrap_or(estimated_total),
        estimated: round.is_none(),
        system_tokens: breakdown.system as u64,
        tools_tokens: breakdown.tools as u64,
        message_tokens: breakdown.messages as u64,
    }
}

/// 把单个压缩生命周期事件实时转发为前端 stream 事件（压缩可感知/可监视）。
/// 压缩期间摘要文本增量也会经 `Progress` 事件实时推送，前端据此显示进度。
pub(crate) fn forward_compaction_event(
    app: &AppHandle,
    event_name: &str,
    ev: crate::agent::context::CompactionEvent,
) {
    match ev {
        crate::agent::context::CompactionEvent::SummarizingStart { trigger } => {
            emit_event(
                app,
                event_name,
                StreamEvent::CompactionStart {
                    trigger: trigger.to_string(),
                },
            );
        }
        crate::agent::context::CompactionEvent::Progress { text } => {
            emit_event(app, event_name, StreamEvent::CompactionProgress { text });
        }
        crate::agent::context::CompactionEvent::Done { outcome } => {
            emit_event(
                app,
                event_name,
                StreamEvent::CompactionDone {
                    summary: outcome.summary.clone(),
                    shadowed_messages: outcome.shadowed_messages,
                    shadowed_tokens: outcome.shadowed_tokens,
                    tail_db_id: outcome.tail_db_id.clone(),
                },
            );
        }
        crate::agent::context::CompactionEvent::Skipped { reason, attempted } => {
            emit_event(
                app,
                event_name,
                StreamEvent::CompactionSkipped {
                    reason: reason.clone(),
                    attempted,
                },
            );
        }
    }
}

/// 非截断「哑火」（无可见正文、也无工具调用）之后允许的补问次数。
///
/// 哑火与截断不是一回事：截断是「模型没说完」（下一轮补完是合理的），哑火是
/// 模型这一轮什么都没说——再 `continue` 很可能下一轮还是空。所以哑火用**有界**
/// 补问把它拉回来：补问一次仍哑火就按失败收场（既不能落一条空 assistant 行，
/// 也不能把「什么都没说」记成 Completed 并通知用户「任务已成功完成」）。
const EMPTY_REPLY_MAX_RETRIES: usize = 1;

/// 哑火补问文本（落库 + 进消息链，与作业结算通知同一条生命周期）。
const EMPTY_REPLY_NUDGE: &str =
    "你上一条回复没有任何可见正文：内容为空，或整段都包在思维标签里——思维内容用户看不到。\
     请用正文直接给出你的回答或结论，不要只写在思维标签里。";

/// 无工具调用的 assistant 回复的处置方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TextReply {
    /// 有可见正文：照常落库、进消息链。
    Visible,
    /// 截断（`finish_reason == "length"`）且无可见正文：本片不落库、不进消息链，
    /// 直接下一轮让模型补完（截断是「没说完」，不是「什么都没说」）。
    TruncatedEmpty,
    /// 非截断且无可见正文：模型哑火。不落库（空 assistant 行会与 live store
    /// 漂移），也**不能**当自然结束。
    Empty,
}

/// 判定一次「无工具调用」的回复该怎么处置，并给出清理后的正文。
///
/// 判据必须落在**清理后**的正文上：整段内容都在思维标签里（或纯空白）的回复
/// 会被 `strip_thinking_tags` 清成空串，而 `finish_reason` 正常是 `stop` ——
/// 只看「截断且为空」会把这种哑火放进自然结束路径。
fn classify_text_reply(raw_content: &str, truncated: bool) -> (TextReply, String) {
    let cleaned = strip_thinking_tags(raw_content);
    if cleaned.trim().is_empty() {
        return (
            if truncated {
                TextReply::TruncatedEmpty
            } else {
                TextReply::Empty
            },
            cleaned,
        );
    }
    (TextReply::Visible, cleaned)
}

/// Groups all parameters needed by the agent loop into a single context struct.
pub(crate) struct LoopContext {
    pub ssh: SshManager,
    pub session_id: String,
    pub app: AppHandle,
    pub state: AppState,
    pub registry: std::sync::Arc<ToolRegistry>,
    pub conversation_id: String,
    pub conv_db: std::sync::Arc<ConversationDb>,
    /// Watch channel receiver for cancellation signals.
    /// When the value changes to `true`, the LLM call in progress should be aborted.
    pub cancel_rx: tokio::sync::watch::Receiver<bool>,
    /// Application config dir. Passed to `ToolContext` so plugin local handlers
    /// (fs.read/fs.write/fs.append) can resolve plugin-relative paths.
    pub config_dir: std::path::PathBuf,
    /// 子agent（subagent 工具派发的调研任务）标记：跳过系统通知，
    /// 避免子agent完成/失败与主任务的通知叠加打扰用户。
    pub is_subtask: bool,
    /// **本机侧标记**：这个任务的目标机器是用户自己这台电脑（本机子 agent，
    /// 由 `AgentRole::LocalSub` 在 manager 里置位）。
    ///
    /// 只用在本工具 ctx 的构造分支上（见 `execute_single_tool`）：置位时 ctx 挂
    /// `AppState.local_command_exec` 且 `local_side = true`，于是 `local_bash` 与
    /// 本机文件工具打的是这台电脑；不置位时一行行为都不变。
    pub local_side: bool,
    /// 本轮 prompt 的来源（用户输入 / 作业结算告知）。决定它落库的身份，
    /// 以及这一轮是不是「唤醒轮」（唤醒轮不触发计划收尾提醒——那个标记按
    /// 任务算，唤醒一次就重来一遍，会把模型念烦）。
    pub prompt_origin: PromptOrigin,
    pub user_input: Option<serde_json::Value>,
}

/// The main agentic loop:
///   LLM call → tool_calls? → execute → feed result → repeat
///
/// Returns the final assistant text when the loop ended with a natural
/// (no-tool-call) response; `None` when it stopped for any other reason
/// (cancelled, LLM error, max rounds). Main tasks ignore the return value;
/// the `subagent` tool uses it as the subagent's research result.
pub(crate) async fn run_agent_loop(
    task_id: String,
    llm_manager: LlmManager,
    mut messages: Vec<LlmMessage>,
    // 注册表全量构建出的工具清单（**未**过状态门控）。每轮发请求前再过一遍
    // `manager::apply_state_gate`——会话中途发生压缩时，`read_history` 从那一轮
    // 起才该出现（见 `tools::STATE_GATED_TOOLS`）。
    base_tools: Vec<ToolDefinition>,
    mode: AgentMode,
    approval_mode: Option<AgentMode>,
    agent_settings: AgentModeSettings,
    approval_cfg: Option<LlmConfig>,
    // Jev 引擎的客户端配置（API Key + 钉住的模型 ID + 全局 NetPolicy）。
    // `None` = 没配 Key；引擎选了 Jev 时审批者仍会构造，但每次调用明确报错，
    // 不静默回退到会话模型。
    jev_cfg: Option<JevConfig>,
    ctx: LoopContext,
) -> Option<String> {
    let event_name = format!("agent://stream/{}", task_id);
    let LoopContext {
        ssh,
        session_id,
        app,
        state,
        registry,
        conversation_id,
        conv_db,
        mut cancel_rx,
        config_dir,
        is_subtask,
        local_side,
        prompt_origin,
        user_input,
    } = ctx;

    // 回合准备（原开头段原样搬出）：唤醒轮标记、persister 构建、db_id_known
    // 回填、标题更新与回合锚点落库。
    let (persister, is_notice_turn) = prepare_turn(
        conv_db,
        &conversation_id,
        prompt_origin,
        user_input,
        &mut messages,
        &state,
        &task_id,
    );

    let max_rounds = agent_settings.max_tool_rounds.max(10);
    // 上下文超限恢复预算：每成功一轮重置（对齐 DSH maxOverflowRetries 语义）
    let mut overflow_retries = 0usize;
    // 连续哑火（无可见正文、无工具调用）计数：模型产出可见正文或工具调用即清零，
    // 上限见 `EMPTY_REPLY_MAX_RETRIES`。
    let mut empty_reply_retries = 0usize;

    // Wrap the manager in Arc so the dispatcher's command approver can share
    // it without cloning the underlying HTTP client / config.
    let llm_manager = std::sync::Arc::new(llm_manager);

    let summarizer_manager = resolve_summarizer_manager(&state, &conversation_id).await;
    // 压缩调用统一入口：显式槽位模型优先，否则主模型
    let compact_manager: &LlmManager = match &summarizer_manager {
        Some(m) => m,
        None => &llm_manager,
    };

    // Create the dispatcher once and reuse it.
    let dispatcher = ToolDispatcher::new(
        mode.clone(),
        approval_mode,
        agent_settings.clone(),
        task_id.clone(),
        app.clone(),
        state.clone(),
        registry.clone(),
        llm_manager.clone(),
        approval_cfg,
        jev_cfg,
    );

    // 设置快照的共享句柄：dispatcher 的审批判定用的是上面那份 `agent_settings.clone()`
    // （任务启动时读的一次），工具 ctx 也拿同一份 —— `local_subagent` 要在自己内部
    // 重算一遍「dispatcher 问不问」（补问面恰好是它不问的组合），两处输入必须是同一个
    // 值，否则任务中途改设置会让两边错位（重复问 / 谁都不问）。
    let agent_settings_snapshot = std::sync::Arc::new(agent_settings.clone());

    'round: for round in 0..max_rounds {
        log::info!("Agent {} round {}", task_id, round);

        // 单轮 LLM 请求（原回合体前半段原样搬出）：取消检查、plan 注入、工具
        // 门控、压力压缩、流式请求、用量记账与错误/溢出处置。
        let assistant_msg = match request_round_reply(
            &state,
            &app,
            &event_name,
            &task_id,
            &conversation_id,
            &mut messages,
            &base_tools,
            compact_manager,
            &persister,
            &llm_manager,
            &mut cancel_rx,
            &mut overflow_retries,
            is_subtask,
            &agent_settings,
        )
        .await
        {
            RoundOutcome::Reply(msg) => msg,
            RoundOutcome::Continue => continue 'round,
            RoundOutcome::Stop => return None,
        };

        // 2. max-tokens 截断处理（对齐 DSH BlockAssembler：丢弃未闭合的 tool-call block）。
        //    finish_reason == "length" 时，工具调用参数可能被截断不完整，执行会以残缺
        //    参数跑命令（安全相关）。整体丢弃 tool_calls（无法区分完整/残缺），
        //    并把本轮视为"未完成"：有文本则保存后继续下一轮补完，无文本则直接跳过。
        let truncated = assistant_msg.finish_reason.as_deref() == Some("length");
        let mut assistant_msg = assistant_msg;
        if truncated {
            if let Some(calls) = assistant_msg.tool_calls.take() {
                if !calls.is_empty() {
                    log::info!(
                        "Agent {} response truncated at token cap: dropped {} incomplete tool call(s)",
                        task_id,
                        calls.len()
                    );
                }
            }
        }

        // 3. Check if assistant returned tool calls
        let tool_calls = assistant_msg.tool_calls.clone().unwrap_or_default();
        if tool_calls.is_empty() {
            // 无工具调用的回复处置（原 if 块原样搬出）：哑火补问 / 作业结算
            // 注入 / 计划收尾提醒 / 自然结束。
            match finish_text_reply(
                &state,
                &app,
                &event_name,
                &task_id,
                &mut messages,
                &persister,
                &mut empty_reply_retries,
                is_subtask,
                is_notice_turn,
                truncated,
                assistant_msg,
            )
            .await
            {
                TextReplyOutcome::Continue => continue 'round,
                TextReplyOutcome::Stop => return None,
                TextReplyOutcome::Done(text) => return Some(text),
            }
        }

        // 3. 将带 tool_calls 的 assistant 消息写入 history。（原样搬出）
        persist_assistant_tool_calls(
            &persister,
            &tool_calls,
            assistant_msg,
            &mut messages,
            &mut empty_reply_retries,
        );

        // 4. Execute tool calls via the dispatcher.
        //    Concurrent-safe tools (like `SubagentTool`) are batched and run in parallel using
        //    `futures::future::join_all`. Sequential tools are run one by one to preserve
        //    causal order, security policies (read-before-edit), and approval flows.
        //    （分批 + 逐批执行 + 结果回填，原样搬出）
        let task_was_cancelled = execute_tool_batches(
            &state,
            &app,
            &event_name,
            &task_id,
            &session_id,
            &conversation_id,
            &ssh,
            &dispatcher,
            &registry,
            &config_dir,
            &mut messages,
            &persister,
            local_side,
            &agent_settings_snapshot,
            &tool_calls,
        )
        .await;

        if task_was_cancelled || is_task_cancelled(&state, &task_id) {
            log::info!(
                "Agent task {} cancelled during tool batch execution, stopping",
                task_id
            );
            emit_final_plan_normalized(&app, &state, &task_id);
            emit_event(&app, &event_name, StreamEvent::Cancelled);
            return None;
        }
    }

    // Exceeded max rounds（原样搬出）
    report_max_rounds_exceeded(&state, &app, &event_name, &task_id, is_subtask, max_rounds).await;
    None
}

#[cfg(test)]
mod tests {
    use super::tool_exec::{group_tool_calls_into_batches, interruption_notice};
    use super::{
        build_job_settlement_notice, classify_text_reply, round_context_snapshot,
        PersistedAssistantToolCall, PersistedToolResult, TextReply, MAX_CONCURRENT_TOOL_EXECUTIONS,
    };
    use crate::agent::risk::Disposition;
    use crate::agent::tools::{AgentTool, ToolContext, ToolOutput, ToolRegistry};
    use crate::error::AppError;
    use crate::llm::provider::ToolCall;
    use async_trait::async_trait;
    use serde_json::json;
    use std::sync::Arc;

    struct DummyTool {
        name: String,
        concurrent: bool,
    }

    #[async_trait]
    impl AgentTool for DummyTool {
        fn name(&self) -> &str {
            &self.name
        }
        fn description(&self) -> &str {
            "dummy"
        }
        fn parameters_schema(&self) -> serde_json::Value {
            json!({})
        }
        fn disposition(&self) -> Disposition {
            Disposition::Allow
        }
        fn is_concurrent_safe(&self) -> bool {
            self.concurrent
        }
        async fn execute(
            &self,
            _params: serde_json::Value,
            _ctx: &ToolContext,
        ) -> Result<ToolOutput, AppError> {
            Ok(ToolOutput::ok("ok", "dummy"))
        }
    }

    #[test]
    fn group_tool_calls_batches_adjacent_concurrent_tools() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(DummyTool {
            name: "subagent".into(),
            concurrent: true,
        }));
        registry.register(Arc::new(DummyTool {
            name: "bash".into(),
            concurrent: false,
        }));
        registry.register(Arc::new(DummyTool {
            name: "read_file".into(),
            concurrent: false,
        }));

        let calls = vec![
            ToolCall {
                id: "c1".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 1"}),
            },
            ToolCall {
                id: "c2".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 2"}),
            },
            ToolCall {
                id: "c3".into(),
                name: "bash".into(),
                arguments: json!({"command": "ls"}),
            },
            ToolCall {
                id: "c4".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 3"}),
            },
            ToolCall {
                id: "c5".into(),
                name: "read_file".into(),
                arguments: json!({"path": "/tmp/a"}),
            },
        ];

        let batches = group_tool_calls_into_batches(&calls, &registry);
        assert_eq!(batches.len(), 4);

        // Batch 0: [c1, c2] concurrent
        assert!(batches[0].is_concurrent);
        assert_eq!(batches[0].calls.len(), 2);
        assert_eq!(batches[0].calls[0].0, 0);
        assert_eq!(batches[0].calls[0].1.id, "c1");
        assert_eq!(batches[0].calls[1].0, 1);
        assert_eq!(batches[0].calls[1].1.id, "c2");

        // Batch 1: [c3] sequential
        assert!(!batches[1].is_concurrent);
        assert_eq!(batches[1].calls.len(), 1);
        assert_eq!(batches[1].calls[0].0, 2);
        assert_eq!(batches[1].calls[0].1.id, "c3");

        // Batch 2: [c4] concurrent (single call in batch)
        assert!(batches[2].is_concurrent);
        assert_eq!(batches[2].calls.len(), 1);
        assert_eq!(batches[2].calls[0].0, 3);
        assert_eq!(batches[2].calls[0].1.id, "c4");

        // Batch 3: [c5] sequential
        assert!(!batches[3].is_concurrent);
        assert_eq!(batches[3].calls.len(), 1);
        assert_eq!(batches[3].calls[0].0, 4);
        assert_eq!(batches[3].calls[0].1.id, "c5");
    }

    #[test]
    fn group_tool_calls_all_concurrent() {
        let mut registry = ToolRegistry::new();
        registry.register(Arc::new(DummyTool {
            name: "subagent".into(),
            concurrent: true,
        }));

        let calls = vec![
            ToolCall {
                id: "c1".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 1"}),
            },
            ToolCall {
                id: "c2".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 2"}),
            },
            ToolCall {
                id: "c3".into(),
                name: "subagent".into(),
                arguments: json!({"prompt": "subtask 3"}),
            },
        ];

        let batches = group_tool_calls_into_batches(&calls, &registry);
        assert_eq!(batches.len(), 1);
        assert!(batches[0].is_concurrent);
        assert_eq!(batches[0].calls.len(), 3);
    }

    #[tokio::test]
    async fn concurrent_semaphore_limits_in_flight_tasks() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let active = Arc::new(AtomicUsize::new(0));
        let max_observed = Arc::new(AtomicUsize::new(0));
        let semaphore = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT_TOOL_EXECUTIONS));

        let total_tasks = 25;
        let futures = (0..total_tasks).map(|idx| {
            let sem = semaphore.clone();
            let act = active.clone();
            let max_obs = max_observed.clone();
            async move {
                let _permit = sem.acquire().await.unwrap();
                let current = act.fetch_add(1, Ordering::SeqCst) + 1;
                max_obs.fetch_max(current, Ordering::SeqCst);
                // Simulate some work
                tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
                act.fetch_sub(1, Ordering::SeqCst);
                idx
            }
        });

        let results = futures::future::join_all(futures).await;
        assert_eq!(results.len(), total_tasks);
        for (i, &res) in results.iter().enumerate() {
            assert_eq!(res, i); // preserved original ordering
        }
        assert!(
            max_observed.load(Ordering::SeqCst) <= MAX_CONCURRENT_TOOL_EXECUTIONS,
            "Max concurrent in-flight was {}, expected <= {}",
            max_observed.load(Ordering::SeqCst),
            MAX_CONCURRENT_TOOL_EXECUTIONS
        );
    }

    /// 历史行里这个键叫 `risk_level`、值是五档严重度。老会话必须照样能打开 ——
    /// 这条测试盯的是「别名 + 变体别名」这条兼容链：去掉 `PersistedToolResult`
    /// 上的 `alias = "risk_level"`，或者去掉 `Disposition` 变体上的旧值别名，
    /// 这里都会解析失败。
    #[test]
    fn persisted_tool_result_reads_legacy_risk_level_key_and_values() {
        let raw = r#"{
            "id": "call-1",
            "name": "bash",
            "arguments": {"command": "ls"},
            "risk_level": "LowRisk",
            "summary": "$ ls",
            "success": true,
            "blocked": false
        }"#;

        let result: PersistedToolResult = serde_json::from_str(raw).unwrap();

        assert!(!result.was_timeout);
        assert!(!result.was_aborted);
        // 值也要映射对：LowRisk 属于四档里的 Allow，不是别的档。
        assert_eq!(result.disposition, crate::agent::risk::Disposition::Allow);
    }

    /// 新写入的行用新键名 `disposition`，读回来不能走别名那条路。
    #[test]
    fn persisted_tool_result_reads_current_disposition_key() {
        let raw = r#"{
            "id": "call-3",
            "name": "bash",
            "arguments": {"command": "reboot"},
            "disposition": "ForceApproval",
            "summary": "$ reboot",
            "success": true,
            "blocked": false
        }"#;

        let result: PersistedToolResult = serde_json::from_str(raw).unwrap();

        assert_eq!(
            result.disposition,
            crate::agent::risk::Disposition::ForceApproval
        );
    }

    #[test]
    fn persisted_tool_result_reads_was_aborted() {
        let raw = r#"{
            "id": "call-2",
            "name": "bash",
            "arguments": {"command": "ls"},
            "risk_level": "Moderate",
            "summary": "$ ls (aborted)",
            "success": false,
            "blocked": false,
            "was_timeout": false,
            "was_aborted": true
        }"#;

        let result: PersistedToolResult = serde_json::from_str(raw).unwrap();

        assert!(result.was_aborted);
        assert_eq!(
            result.disposition,
            crate::agent::risk::Disposition::Approval
        );
    }

    #[test]
    fn persisted_assistant_tool_calls_roundtrip() {
        let calls = vec![
            PersistedAssistantToolCall {
                id: "call-a".into(),
                name: "bash".into(),
                arguments: serde_json::json!({"command": "ls"}),
            },
            PersistedAssistantToolCall {
                id: "call-b".into(),
                name: "system_info".into(),
                arguments: serde_json::json!({"category": "os"}),
            },
        ];
        let json = serde_json::to_string(&calls).unwrap();
        let parsed: Vec<PersistedAssistantToolCall> = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].id, "call-a");
        assert_eq!(parsed[1].name, "system_info");
    }

    fn job_info(
        job_id: &str,
        description: &str,
        command: &str,
        status: crate::command_exec::JobStatus,
    ) -> crate::command_exec::JobInfo {
        crate::command_exec::JobInfo {
            job_id: job_id.into(),
            session_id: "s1".into(),
            task_id: Some("task-1".into()),
            owner_conversation_id: Some("conv-1".into()),
            description: description.into(),
            command: command.into(),
            status,
            detail: None,
            started_at_millis: 0,
            finished_at_millis: Some(1),
            total_output_bytes: 0,
        }
    }

    /// 「整段内容都是思维标签」是一条真实路径：上游的
    /// `is_effectively_empty_response` 看的是**原始** content（非空 → 不触发
    /// 自动重试），`strip_thinking_tags` 把它清成空串。旧守卫只认「截断且为空」，
    /// 于是这种哑火会落一条空 assistant 行、一路走到 Done（Completed）。
    #[test]
    fn text_reply_made_only_of_thinking_tags_is_empty() {
        for raw in [
            "<thinking>先看看磁盘再回答</thinking>",
            "<think>只有思维</think>",
            "<Thought>只有思维</Thought>",
            // 未闭合的思维标签同样清成空（后面的内容都是思维）
            "<thinking>没闭合的思维",
            "",
            "   \n\t ",
        ] {
            let (kind, cleaned) = classify_text_reply(raw, false);
            assert_eq!(kind, TextReply::Empty, "{raw:?} 应判为哑火");
            assert!(cleaned.trim().is_empty(), "{raw:?} 清理后应为空");
        }
        // 截断时同样一份输入走「跳过本片、下一轮补完」，而不是哑火补问
        let (kind, _) = classify_text_reply("<thinking>没说完", true);
        assert_eq!(kind, TextReply::TruncatedEmpty);
    }

    /// 有可见正文（哪怕被思维标签包着）必须照常落库/收尾——守卫不能过宽。
    #[test]
    fn text_reply_with_visible_text_stays_usable() {
        for (raw, expected) in [
            ("正文", "正文"),
            ("正文 <thinking>思维</thinking> 结尾", "正文  结尾"),
            ("<thinking>思维</thinking>正文", "正文"),
        ] {
            let (kind, cleaned) = classify_text_reply(raw, false);
            assert_eq!(kind, TextReply::Visible, "{raw:?}");
            assert_eq!(cleaned, expected);
        }
        // 截断但有正文：不是哑火
        let (kind, cleaned) = classify_text_reply("被截断的正文", true);
        assert_eq!(kind, TextReply::Visible);
        assert_eq!(cleaned, "被截断的正文");
    }

    /// 中断文案必须落到**跑命令的那台机器**上：远端 `bash` 指 ps/pgrep，本机
    /// `local_bash` 指 Get-Process / Stop-Process -Id；两端都不许声称进程已经
    /// 终止（超时 / 取消只停止等待，见 `command_exec::local_transport`）。
    #[test]
    fn interruption_notice_matches_the_machine_the_command_ran_on() {
        let remote = interruption_notice("bash");
        assert!(remote.contains("SSH 通道"));
        assert!(remote.contains("远端进程不保证已终止"));
        assert!(remote.contains("ps/pgrep"));
        assert!(
            !remote.contains("Get-Process"),
            "远端命令不该指路本机手段：{remote}"
        );

        let local = interruption_notice("local_bash");
        assert!(local.contains("关闭我们这侧的读端"), "{local}");
        assert!(local.contains("本机进程不保证已结束"), "{local}");
        assert!(
            local.contains("Get-Process") && local.contains("tasklist"),
            "本机命令要指路本机确认手段：{local}"
        );
        assert!(
            local.contains("Stop-Process -Id"),
            "本机命令要指路本机结束手段：{local}"
        );
        assert!(
            local.contains("pgrep") && local.contains("kill <pid>"),
            "其它平台的本机收尾手段也要说：{local}"
        );
        assert!(
            !local.contains("SSH 通道"),
            "本机命令不经 SSH，别把用户引到远端：{local}"
        );
        for text in [&remote, &local] {
            assert!(
                !text.contains("已终止进程") && !text.contains("已杀掉"),
                "取消只停止等待，不得声称进程已结束：{text}"
            );
        }

        // 其余工具（read_file / web_search / …）走中性文案：本机 / 远端都不占。
        let other = interruption_notice("read_file");
        assert!(other.contains("工具可能已执行完成"), "{other}");
        assert!(!other.contains("Get-Process") && !other.contains("SSH 通道"));
    }

    #[test]
    fn job_settlement_notice_lists_completed_jobs_and_collection_hint() {
        let jobs = vec![
            job_info(
                "job_1",
                "编译 release",
                "cargo build --release",
                crate::command_exec::JobStatus::Completed,
            ),
            job_info(
                "job_2",
                "下载模型",
                "wget big.bin",
                crate::command_exec::JobStatus::Killed,
            ),
        ];
        let notice = build_job_settlement_notice(&jobs);
        assert!(notice.contains("job_1"));
        assert!(notice.contains("编译 release"));
        assert!(notice.contains("已完成"));
        assert!(notice.contains("job_2"));
        assert!(notice.contains("已被终止"));
        assert!(notice.contains("job_output"));
        // 单条 notice 覆盖全部作业（一次决策，不逐条打断）
        assert!(notice.contains("job_1") && notice.contains("job_2"));
    }

    #[test]
    fn job_settlement_notice_fallback_description_to_command() {
        let jobs = vec![job_info(
            "job_3",
            "",
            "cargo test",
            crate::command_exec::JobStatus::Failed,
        )];
        let notice = build_job_settlement_notice(&jobs);
        assert!(notice.contains("job_3"));
        assert!(notice.contains("cargo test"));
        assert!(notice.contains("执行失败"));
    }

    fn breakdown(
        system: usize,
        tools: usize,
        messages: usize,
    ) -> crate::agent::context::meter::ContextBreakdown {
        crate::agent::context::meter::ContextBreakdown {
            system,
            tools,
            messages,
        }
    }

    /// provider 报了用量：用它的 prompt 总量，**不许**标成估算。
    #[test]
    fn context_snapshot_prefers_provider_usage() {
        let round = crate::llm::provider::TokenUsage {
            prompt_tokens: 84_213,
            completion_tokens: 30,
            total_tokens: 84_243,
            ..Default::default()
        };
        let snap = round_context_snapshot(Some(&round), breakdown(3000, 12_000, 69_213));
        assert_eq!(snap.used_tokens, 84_213);
        assert!(!snap.estimated);
        // 构成始终是估算（provider 不给这个拆分）
        assert_eq!(snap.system_tokens, 3000);
        assert_eq!(snap.tools_tokens, 12_000);
        assert_eq!(snap.message_tokens, 69_213);
    }

    /// provider 没报用量（有些中转会忽略 `include_usage`）：退回本地估算并标
    /// `estimated` —— 环仍有数，但界面会加 `~`，不会把估算讲成精确值。
    #[test]
    fn context_snapshot_falls_back_to_estimate() {
        let snap = round_context_snapshot(None, breakdown(100, 200, 300));
        assert_eq!(snap.used_tokens, 600);
        assert!(snap.estimated);
    }
}
