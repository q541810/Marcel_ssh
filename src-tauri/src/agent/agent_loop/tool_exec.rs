//! 工具调用分批与执行（自原 `agent_loop.rs` 搬出）：
//! - `ToolCallBatch` / `group_tool_calls_into_batches`：按并发安全性分批；
//! - `execute_tool_batches`：逐批执行 + 结果回填（原 `run_agent_loop`
//!   回合体的工具批次段），并与本轮的模型审批预取并行推进；
//! - `build_tool_ctx` / `execute_single_tool`：上下文组装与单工具执行；
//! - `owner_conversation_for` / `interruption_notice`：作业归属与中断文案。

use tauri::AppHandle;

use super::{is_task_cancelled, PersistedToolResult, MAX_CONCURRENT_TOOL_EXECUTIONS};
use crate::agent::conversation_persister::ConversationPersister;
use crate::agent::plan_handler::handle_plan_tool_output;
use crate::agent::risk::Disposition;
use crate::agent::tool_dispatcher::{
    ApprovalPrefetch, ApprovalSlot, ToolDispatcher, ToolResultEvent,
};
use crate::agent::tools::{ToolContext, ToolRegistry};
use crate::config::settings::AgentModeSettings;
use crate::emit_event;
use crate::llm::provider::{LlmMessage, LlmRole, ToolCall};
use crate::ssh::connection::SshManager;
use crate::AppState;

/// A batch of tool calls grouped for execution.
#[derive(Debug)]
pub(super) struct ToolCallBatch<'a> {
    pub(super) is_concurrent: bool,
    pub(super) calls: Vec<(usize, &'a ToolCall)>,
}

/// Helper holding the execution result and metadata of a single tool call.
struct SingleToolExecution {
    index: usize,
    persisted: PersistedToolResult,
    tool_msg: LlmMessage,
    was_cancelled_or_aborted: bool,
}

/// 一轮工具执行共用的环境（整轮不变的那些引用）。
///
/// 以前这十来个参数在 `execute_tool_batches` → 并发闭包 → `execute_single_tool`
/// 之间逐个手传；模型审批预取也要拿同一套去组装工具上下文，收成一个结构体，
/// 保证执行与预取用的是**同一份**环境（尤其是本机 / 远端的分流依据 `local_side`）。
struct RoundEnv<'a> {
    state: &'a AppState,
    app: &'a AppHandle,
    event_name: &'a str,
    task_id: &'a str,
    session_id: &'a str,
    conversation_id: &'a str,
    ssh: &'a SshManager,
    dispatcher: &'a ToolDispatcher,
    registry: &'a ToolRegistry,
    config_dir: &'a std::path::Path,
    local_side: bool,
    agent_settings: &'a std::sync::Arc<AgentModeSettings>,
}

/// Groups a slice of `ToolCall`s into contiguous batches based on `is_concurrent_safe`.
///
/// Adjacent tools where `is_concurrent_safe() == true` are merged into a single concurrent batch.
/// Tools where `is_concurrent_safe() == false` each form their own sequential batch.
pub(super) fn group_tool_calls_into_batches<'a>(
    tool_calls: &'a [ToolCall],
    registry: &ToolRegistry,
) -> Vec<ToolCallBatch<'a>> {
    let mut batches: Vec<ToolCallBatch<'a>> = Vec::new();

    for (idx, tc) in tool_calls.iter().enumerate() {
        let is_concurrent = registry
            .get(&tc.name)
            .map(|tool| tool.is_concurrent_safe())
            .unwrap_or(false);

        if is_concurrent {
            if let Some(last_batch) = batches.last_mut() {
                if last_batch.is_concurrent {
                    last_batch.calls.push((idx, tc));
                    continue;
                }
            }
            batches.push(ToolCallBatch {
                is_concurrent: true,
                calls: vec![(idx, tc)],
            });
        } else {
            batches.push(ToolCallBatch {
                is_concurrent: false,
                calls: vec![(idx, tc)],
            });
        }
    }

    batches
}

/// 执行整批 tool 调用并回填结果（原 `run_agent_loop` 的工具批次段 +
/// 结果排序/持久化段）。
///
/// Concurrent-safe tools (like `SubagentTool`) are batched and run in parallel using
/// `futures::future::join_all`. Sequential tools are run one by one to preserve
/// causal order, security policies (read-before-edit), and approval flows.
///
/// 开了模型审批、且这一轮不止一个调用时，各命令的模型审批在轮次开始时**一起**
/// 发出（[`prefetch_approvals`]），与按顺序执行并行推进：执行顺序、人工审批、
/// 取消都不变，只是轮到某条命令时它的审批结论多半已经在等着了。
///
/// 返回 `task_was_cancelled`（批次执行期间是否观测到取消）。
#[allow(clippy::too_many_arguments)]
pub(super) async fn execute_tool_batches(
    state: &AppState,
    app: &AppHandle,
    event_name: &str,
    task_id: &str,
    session_id: &str,
    conversation_id: &str,
    ssh: &SshManager,
    dispatcher: &ToolDispatcher,
    registry: &ToolRegistry,
    config_dir: &std::path::Path,
    messages: &mut Vec<LlmMessage>,
    persister: &ConversationPersister,
    local_side: bool,
    agent_settings_snapshot: &std::sync::Arc<AgentModeSettings>,
    tool_calls: &[ToolCall],
) -> bool {
    let env = RoundEnv {
        state,
        app,
        event_name,
        task_id,
        session_id,
        conversation_id,
        ssh,
        dispatcher,
        registry,
        config_dir,
        local_side,
        agent_settings: agent_settings_snapshot,
    };

    let (mut all_results, task_was_cancelled) = {
        // 本轮执行期间历史只读：工具结果整轮跑完才写回（下方），所以执行与
        // 审批预取看到的是同一份上下文。
        let history: &[LlmMessage] = messages;
        let (prefetch, slots) = match dispatcher.plan_approval_prefetch(tool_calls) {
            Some((prefetch, slots)) => (Some(prefetch), slots),
            None => (None, Vec::new()),
        };
        let work = run_batches(&env, tool_calls, history, prefetch.as_ref());
        if slots.is_empty() {
            work.await
        } else {
            // 预取与执行在同一个 future 里并行推进；执行一结束（含取消）就整个
            // 丢弃预取 —— 还在路上的审批请求随之取消，不会留下无主的后台请求。
            let driver = async {
                prefetch_approvals(&env, tool_calls, history, slots).await;
                std::future::pending::<()>().await
            };
            tokio::pin!(work);
            tokio::pin!(driver);
            tokio::select! {
                out = &mut work => out,
                () = &mut driver => unreachable!("审批预取的驱动永不结束"),
            }
        }
    };

    // Sort results by original index to ensure strict order alignment with tool_calls
    all_results.sort_by_key(|r| r.index);

    for mut res in all_results {
        let tool_result_json = serde_json::to_string(&res.persisted).ok();
        if let Some(db_id) = persister.save_msg(
            "tool",
            &res.tool_msg.content,
            tool_result_json.as_deref(),
            None,
        ) {
            res.tool_msg.db_id = Some(db_id.clone());
            // 落库 id 已广播（下方 emit），前端 store 拿得到 → pressure 压缩
            // 可用它作区间锚点（shrink_to_known_tail 的 known_only 判定）。
            res.tool_msg.db_id_known = true;
            // 广播库内 id：前端按工具卡片的 toolCallId（与库内同一 id 域）
            // 定位回填，live 工具卡由此对上库内身份。
            super::emit_message_saved(
                app,
                event_name,
                conversation_id,
                "tool",
                &db_id,
                Some(&res.persisted.id),
            );
        }
        messages.push(res.tool_msg);
    }

    task_was_cancelled
}

/// 逐批执行（并发安全的相邻调用并行、其余按序），返回各调用结果与是否观测到取消。
async fn run_batches(
    env: &RoundEnv<'_>,
    tool_calls: &[ToolCall],
    history: &[LlmMessage],
    prefetch: Option<&ApprovalPrefetch>,
) -> (Vec<SingleToolExecution>, bool) {
    let batches = group_tool_calls_into_batches(tool_calls, env.registry);
    let mut all_results: Vec<SingleToolExecution> = Vec::with_capacity(tool_calls.len());
    let mut task_was_cancelled = false;

    for batch in batches {
        if is_task_cancelled(env.state, env.task_id) {
            task_was_cancelled = true;
            break;
        }

        if batch.is_concurrent && batch.calls.len() > 1 {
            log::info!(
                "Agent task {} executing batch of {} concurrent tools in parallel (max concurrency: {})",
                env.task_id,
                batch.calls.len(),
                MAX_CONCURRENT_TOOL_EXECUTIONS
            );
            let semaphore = tokio::sync::Semaphore::new(MAX_CONCURRENT_TOOL_EXECUTIONS);
            let futures = batch.calls.into_iter().map(|(idx, tc)| {
                let sem = &semaphore;
                async move {
                    let _permit = sem.acquire().await.ok();
                    execute_single_tool(env, idx, tc, history, prefetch).await
                }
            });
            let batch_results = futures::future::join_all(futures).await;
            for res in batch_results {
                if res.was_cancelled_or_aborted {
                    task_was_cancelled = true;
                }
                all_results.push(res);
            }
        } else {
            for (idx, tc) in batch.calls {
                let res = execute_single_tool(env, idx, tc, history, prefetch).await;
                if res.was_cancelled_or_aborted {
                    task_was_cancelled = true;
                }
                all_results.push(res);
                if task_was_cancelled {
                    break;
                }
            }
        }

        if task_was_cancelled {
            break;
        }
    }

    (all_results, task_was_cancelled)
}

/// 把本轮各调用的模型审批一起发出去，结论投进各自的 `slot`。
///
/// 并发上限沿用工具并发的上限（桌面 10 / 移动 2）。`join_all` 按调用顺序首次
/// 轮询、tokio 信号量先到先得，所以超出上限时排在前面的调用先拿到名额 —— 最先
/// 要执行的那条最先出结论，后面的在它执行期间继续判。
async fn prefetch_approvals(
    env: &RoundEnv<'_>,
    tool_calls: &[ToolCall],
    history: &[LlmMessage],
    slots: Vec<ApprovalSlot>,
) {
    let semaphore = tokio::sync::Semaphore::new(MAX_CONCURRENT_TOOL_EXECUTIONS);
    let futures = tool_calls.iter().zip(slots).map(|(tc, slot)| {
        let sem = &semaphore;
        async move {
            let Ok(_permit) = sem.acquire().await else {
                return;
            };
            if is_task_cancelled(env.state, env.task_id) {
                return;
            }
            let ctx = build_tool_ctx(env, tc).await;
            env.dispatcher
                .prefetch_approval(tc, &ctx, env.event_name, history, slot)
                .await;
        }
    });
    futures::future::join_all(futures).await;
}

/// 作业归属的**根对话**。
///
/// 主 agent 的作业算在自己的对话名下；子 agent（subagent 工具派发的调研/
/// 执行任务）的作业算在派它的那个用户对话名下——子 agent 有自己独立的
/// 对话记录，但作业是父对话那摊活的一部分：父对话要看得见、收得回，
/// 重启后也要靠这个键认回来。沿 `parent_task_id` 往上找，带深度上限
/// 防止任务表异常时打成死循环；查不到任务时退回本任务自己的对话。
fn owner_conversation_for(state: &AppState, task_id: &str, fallback: &str) -> String {
    const MAX_DEPTH: usize = 16;
    let mut current = task_id.to_string();
    for _ in 0..MAX_DEPTH {
        let parent = {
            let tasks = state.agent_tasks.read();
            match tasks.get(&current) {
                // 没有父任务 = 主任务：它的对话就是根对话。
                Some(task) => match task.parent_task_id.clone() {
                    Some(parent) => Some(parent),
                    None => return task.conversation_id.clone(),
                },
                None => None,
            }
        };
        match parent {
            Some(parent) => current = parent,
            None => break,
        }
    }
    fallback.to_string()
}

/// 用户中断时追到工具输出末尾的收尾说明。
///
/// 按工具分流，因为**收尾语义相同、收尾手段不同**，说错会把模型和用户引到
/// 错误的机器上：
/// - `bash`：SSH 通道上的远端命令，指路服务器上的 `ps/pgrep` + `kill`；
/// - `local_bash`：本机子进程，已停止等待并关闭我们这侧的读端（与
///   `command_exec::local_transport` 的收尾语义、以及 `local_bash.rs` 的超时
///   文案同一口径），指路本机的 `Get-Process` / `Stop-Process -Id`（Windows）
///   与 `ps` / `pgrep` + `kill <pid>`（macOS/Linux）；
/// - 其余工具：可能已执行完成，只用中性说明。
///
/// 两端都**不许**出现「已终止 / 已杀掉进程」的表述：取消只停止等待，进程
/// （远端或本机）都可能在继续跑。
pub(super) fn interruption_notice(tool_name: &str) -> String {
    match tool_name {
        "bash" => {
            "[用户中断：已停止等待输出并关闭 SSH 通道，但远端进程不保证已终止——只有它之后还往 stdout/stderr 写东西时，才可能因管道断开（SIGPIPE）退出；静默运行、重定向了输出、被 nohup/setsid/& 脱离的命令会继续在服务器上运行。必要时用 ps/pgrep 确认并按需 kill 清理。]".to_string()
        }
        "local_bash" => {
            "[用户中断：已停止等待输出并关闭我们这侧的读端，但本机进程不保证已结束——只有它之后还往 stdout/stderr 写东西时，才可能因管道断开而退出；静默运行、重定向了输出、被 Start-Process / nohup / & 脱离的命令会继续在这台电脑上运行。要收尾就自己查了再结束：Windows 用 `Get-Process` / `tasklist` 找到它、`Stop-Process -Id <pid>` 结束；macOS/Linux 用 `ps` / `pgrep` 找到它、`kill <pid>` 结束。]".to_string()
        }
        _ => "[用户手动中断，已停止等待结果；工具可能已执行完成]".to_string(),
    }
}

/// 组装一次工具调用的上下文（执行与模型审批预取共用这一处）。
///
/// `local_side` = 本机子 agent（`LoopContext::local_side`）：ctx 的目标是用户自己这台电脑。
/// `agent_settings` = 本任务启动时的设置快照（与 dispatcher 手里同一份），注入 ctx
/// 供需要重算审批结论的工具使用（见 [`ToolContext::with_agent_mode_settings`]）。
async fn build_tool_ctx(env: &RoundEnv<'_>, tc: &ToolCall) -> ToolContext {
    let settings = env.state.settings.read().await;
    let policy = std::sync::Arc::new(crate::agent::risk::SecurityPolicy::from_app_settings(
        &settings,
    ));
    let ctx = ToolContext::new(
        env.ssh.clone(),
        env.session_id.to_string(),
        env.conversation_id,
        env.app.clone(),
    )
    .with_policy(policy)
    .with_owner_conversation(owner_conversation_for(
        env.state,
        env.task_id,
        env.conversation_id,
    ))
    .with_task_id(env.task_id)
    .with_tool_call_id(&tc.id)
    .with_event_name(env.event_name)
    .with_config_dir(env.config_dir.to_path_buf())
    .with_local_handlers(env.registry.local_handlers_arc())
    .with_agent_mode_settings(env.agent_settings.clone());
    // 命令执行管理器按**任务的目标机器**分流：本机子 agent 挂本机管理器并置
    // `local_side`（`local_bash` 的最后一道闸门，见 `ToolContext::with_local_side`），
    // 其余任务一字不变地挂远端管理器。
    //
    // 只在这里分流（而不是让工具自己判断）是刻意的：拿错 ctx 会把「本机命令」
    // 顺着 SSH 打到服务器上，路由依据必须是组装处的事实，不能是模型给的参数。
    if env.local_side {
        ctx.with_command_exec(env.state.local_command_exec.clone())
            .with_local_side(true)
    } else {
        ctx.with_command_exec(env.state.command_exec.clone())
    }
}

/// Executes a single tool call with context assembly, cancellation checks, plan override,
/// and frontend event emission.
async fn execute_single_tool(
    env: &RoundEnv<'_>,
    index: usize,
    tc: &ToolCall,
    messages: &[LlmMessage],
    prefetch: Option<&ApprovalPrefetch>,
) -> SingleToolExecution {
    let RoundEnv {
        state,
        app,
        event_name,
        task_id,
        dispatcher,
        ..
    } = *env;
    let tool_ctx = build_tool_ctx(env, tc).await;

    if is_task_cancelled(state, task_id) {
        log::info!(
            "Agent task {} cancelled before executing tool {}, aborting",
            task_id,
            tc.name
        );
        let persisted = PersistedToolResult {
            id: tc.id.clone(),
            name: tc.name.clone(),
            arguments: tc.arguments.clone(),
            disposition: Disposition::Allow,
            summary: format!("{} (cancelled)", tc.name),
            success: false,
            blocked: false,
            was_timeout: false,
            was_aborted: true,
            metadata: None,
        };
        let tool_msg = LlmMessage {
            estimate_cache: Default::default(),
            role: LlmRole::Tool,
            content: "[用户手动中断，已取消执行]".to_string(),
            tool_calls: None,
            tool_call_id: Some(tc.id.clone()),
            reasoning_content: None,
            image_paths: None,
            finish_reason: None,
            db_id: None,
            db_id_known: false,
        };
        return SingleToolExecution {
            index,
            persisted,
            tool_msg,
            was_cancelled_or_aborted: true,
        };
    }

    let mut exec = dispatcher
        .dispatch(tc, &tool_ctx, event_name, messages, prefetch)
        .await;

    let cancelled_after = is_task_cancelled(state, task_id);
    if cancelled_after {
        log::info!(
            "Agent task {} cancelled after executing tool {}, marking aborted",
            task_id,
            tc.name
        );
        exec.was_aborted = true;
        let notice = interruption_notice(&tc.name);
        if exec.output.is_empty() {
            exec.output = notice;
        } else {
            exec.output.push_str("\n\n");
            exec.output.push_str(&notice);
        }
        exec.success = false;
        exec.summary = format!("{} (aborted)", tc.name);
    } else {
        // Handle plan-related tool outputs if not cancelled
        let plan_override = if let Some(ref meta) = exec.metadata {
            handle_plan_tool_output(&tc.name, &tc.id, task_id, meta, app, state).await
        } else {
            None
        };
        if let Some(override_text) = plan_override {
            exec.output = override_text;
            exec.summary = "plan 处理提示".to_string();
        }

        // Emit result to frontend
        emit_event(
            app,
            event_name,
            ToolResultEvent {
                event_type: "toolResult".into(),
                tool_call_id: tc.id.clone(),
                tool_name: tc.name.clone(),
                arguments: tc.arguments.clone(),
                summary: exec.summary.clone(),
                result: exec.output.clone(),
                success: exec.success,
                blocked: exec.blocked,
                was_timeout: exec.was_timeout,
                was_aborted: exec.was_aborted,
                metadata: exec.metadata.clone(),
            },
        );
    }

    let persisted = PersistedToolResult {
        id: tc.id.clone(),
        name: tc.name.clone(),
        arguments: tc.arguments.clone(),
        disposition: exec.disposition,
        summary: exec.summary,
        success: exec.success,
        blocked: exec.blocked,
        was_timeout: exec.was_timeout,
        was_aborted: exec.was_aborted,
        metadata: exec.metadata,
    };

    let tool_msg = LlmMessage {
        estimate_cache: Default::default(),
        role: LlmRole::Tool,
        content: exec.output,
        tool_calls: None,
        tool_call_id: Some(tc.id.clone()),
        reasoning_content: None,
        image_paths: None,
        finish_reason: None,
        db_id: None,
        db_id_known: false,
    };

    SingleToolExecution {
        index,
        persisted,
        tool_msg,
        was_cancelled_or_aborted: cancelled_after,
    }
}
