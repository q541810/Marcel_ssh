use serde::Serialize;
use tauri::{AppHandle, State};

use crate::agent::agent_loop::forward_compaction_event;
use crate::agent::conversation_persister::ConversationPersister;
use crate::agent::task::AgentStatus;
use crate::error::AppError;
use crate::llm::manager::LlmManager;
use crate::llm::provider::LlmMessage;
use crate::AppState;

/// 手动压缩命令的结果。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionCommandResult {
    /// 是否真正发生了压缩（false = 无可压区间 / 摘要未比原文更短等跳过）。
    pub compacted: bool,
    /// 压缩摘要（不含 framing 标签）。
    pub summary: Option<String>,
    /// 被压掉/替换的消息条数（compacted 为 true 时有值）。
    pub shadowed_messages: usize,
    /// 被压内容的估算 token 数（compacted 为 true 时有值）。
    pub shadowed_tokens: usize,
    /// 被压区间末条消息的 DB row id（统一 id 指针，compacted 为 true 时有值，
    /// 前端按 dbId 定位插卡）。
    pub tail_db_id: Option<String>,
    /// 跳过原因（compacted 为 false 时有值，供前端提示）。
    pub reason: Option<String>,
    /// 是否已进入摘要阶段（attempted=false：未开始就跳过，前端不留痕；
    /// attempted=true：摘要已跑但失败，前端低调交代）。
    pub attempted: bool,
}

/// 手动压缩指定会话的上下文（命令面板「压缩上下文」）。
///
/// 与自动压缩走**同一条路径**：
/// - `history` 由前端 `buildLlmHistory` 提供（与 `agent_start_task` 同一来源，
///   已做过 tool 调用协议闭合修正）——压缩对象就是 LLM 实际看到的历史；
/// - 压缩事件经 `forward_compaction_event` 实时转发到
///   `agent://stream/{task_id}`（task_id 由前端生成，作为事件通道），前端
///   复用 `attachStreamListener` + `handleCompaction*` 显示卡片；
/// - 压缩成功后由后端结构化落库（按 `tail_db_id` 指针定位卡片，取代
///   count-walk + 指纹），前端经 Done 事件按 `dbId` 原位插入 live store；
///   原文永不删改。
#[tauri::command]
pub async fn agent_compact_conversation(
    app: AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
    task_id: String,
    history: Vec<LlmMessage>,
) -> Result<CompactionCommandResult, AppError> {
    // busy 守卫：同一会话有任务正在运行时拒绝手动压缩（对齐 DSH compactNow
    // 的 idle 语义，避免运行中任务与手动替换并发造成竞态）。
    let running = state.agent_tasks.read().values().any(|t| {
        t.conversation_id == conversation_id
            && matches!(
                t.status,
                AgentStatus::Planning | AgentStatus::Executing | AgentStatus::WaitingApproval
            )
    });
    if running {
        return Err(AppError::Agent(
            "会话正在运行任务，请等待任务结束或停止后再压缩".into(),
        ));
    }

    // LLM 配置（摘要模型解析优先级）：
    //   1. 显式「上下文压缩模型」槽位（用户明确选了就固定用它，与会话无关）；
    //   2. 否则会话级模型记忆（本会话 agent 正在用的模型）；
    //   3. 否则全局最近使用（last_used）。
    // 旧实现把空槽位直接回落"默认模型"——会话内选了别的模型时压缩却用全局
    // 默认，现在改为跟随会话。任一解析失败（未配置模型）返回错误由调用方提示。
    let llm_registry = state.settings.read().await.llm_registry.clone();
    let resolved = if !llm_registry.slots.summarizer_model_id.is_empty() {
        llm_registry.resolve_model(&llm_registry.slots.summarizer_model_id)
    } else {
        let session_model = state
            .session_models
            .read()
            .get(&conversation_id)
            .filter(|s| !s.is_empty())
            .cloned();
        match session_model {
            Some(id) => llm_registry.resolve_override(&id),
            None => llm_registry.resolve_default(),
        }
    }?;
    let llm_manager = LlmManager::new(resolved.config)?;

    let mut messages: Vec<LlmMessage> = history;
    if messages.is_empty() {
        return Ok(CompactionCommandResult {
            compacted: false,
            summary: None,
            shadowed_messages: 0,
            shadowed_tokens: 0,
            tail_db_id: None,
            reason: Some("会话还没有消息，无需压缩".into()),
            attempted: false,
        });
    }
    // history 来自前端 buildLlmHistory：携带 dbId 的消息对前端 store 可见
    // （db_id_known=true，与 run_agent_loop 入口同规则）。
    for m in &mut messages {
        if m.db_id.is_some() {
            m.db_id_known = true;
        }
    }

    // 触发压缩（Manual：与 ContextOverflow 同一条强制缩减管线，跳过阈值；
    // 触发名 "manual" 让前端 running 卡显示"总结早期历史"而非
    // "上下文超限，自动重试"——手动压缩完成后没有"重发该轮请求"的行为）。
    // 事件实时转发到前端 stream 通道（与自动压缩同一事件模型）。
    let event_name = format!("agent://stream/{}", task_id);
    let on_event = |ev: crate::agent::context::CompactionEvent| {
        forward_compaction_event(&app, &event_name, ev);
    };
    let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let run = crate::agent::context::compact_if_needed(
        &mut messages,
        &llm_manager,
        &[],
        0, // context_window 仅 pressure 触发使用，Manual 跳过阈值
        crate::agent::context::CompactionTrigger::Manual,
        &mut cancel_rx,
        &on_event,
    )
    .await;

    let Some(outcome) = &run.outcome else {
        // 压缩被跳过：聚合跳过原因与 attempted 标记
        let mut attempted = false;
        let reason = run
            .events
            .iter()
            .filter_map(|ev| match ev {
                crate::agent::context::CompactionEvent::Skipped {
                    reason,
                    attempted: a,
                } => {
                    attempted = *a;
                    Some(reason.clone())
                }
                _ => None,
            })
            .collect::<Vec<_>>()
            .join("; ");
        log::info!(
            "Manual compaction skipped for conversation {}: {}",
            conversation_id,
            if reason.is_empty() {
                "no compactable range"
            } else {
                &reason
            }
        );
        return Ok(CompactionCommandResult {
            compacted: false,
            summary: None,
            shadowed_messages: 0,
            shadowed_tokens: 0,
            tail_db_id: None,
            reason: Some(if reason.is_empty() {
                "没有可压缩的早期历史区间".into()
            } else {
                reason
            }),
            attempted,
        });
    };

    // 压缩成功：结构化落库（count-walk + 指纹校验 + 归档 + 卡片定位），
    // 与自动压缩同一路径；前端经 Done 事件原位替换 live store。
    let persister =
        ConversationPersister::new(state.conversation_db.clone(), conversation_id.clone());
    let persisted = persister.persist_compaction(outcome);
    log::info!(
        "Manual compaction for conversation {}: {} messages, ~{} tokens (persisted={})",
        conversation_id,
        outcome.shadowed_messages,
        outcome.shadowed_tokens,
        persisted
    );
    Ok(CompactionCommandResult {
        compacted: true,
        summary: Some(outcome.summary.clone()),
        shadowed_messages: outcome.shadowed_messages,
        shadowed_tokens: outcome.shadowed_tokens,
        tail_db_id: outcome.tail_db_id.clone(),
        reason: None,
        attempted: true,
    })
}
