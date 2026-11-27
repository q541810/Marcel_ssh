//! 后台复盘：一段对话告一段落后，用记忆模型过一遍「还没复盘过的那段」，对记忆库
//! 做增删改。
//!
//! # 什么时候算「告一段落」
//!
//! 1. 主任务收尾后 [`IDLE_DELAY`] 内没有新回合（定时器，新回合开始即取消）；
//! 2. 用户在**同一台机器**上的另一段对话里开了新回合，或这段对话所在的 SSH 会话
//!    断开（关了标签）→ 挂着的定时器立即触发；
//! 3. 压缩落库之后 → 复盘到压缩边界（被压掉的那段已经有了结论）；
//! 4. 启动时补：最近 [`CATCH_UP_DAYS`] 天里上次没来得及复盘的。
//!
//! # 不变式
//!
//! - **每条消息只复盘一次**：`reflection_progress` 记到哪条，下次从它之后开始；
//! - **记忆库建立之前的消息不复盘**（功能上线前的旧会话不自动补——想补用整理助手）；
//! - **开关关着时触发照走，但只推进进度、不调模型**：再打开时不会补旧账；
//! - 全局同一时刻只跑一个复盘；同一会话不并发；有任务在跑的会话（压缩触发除外）先不复盘；
//! - 只复盘主对话；压缩卡不进复盘输入；
//! - 失败安静放弃：进度不动，下次时机到了再试。

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::Emitter;

use crate::agent::conversation::{ConversationUsage, StoredMessage};
use crate::agent::conversation_persister::COMPACTION_CARD_PREFIX;
use crate::agent::templates::TemplateManager;
use crate::config::connections::SavedConnection;
use crate::llm::provider::{LlmMessage, TokenUsage};
use crate::llm::streaming::StreamEvent;
use crate::AppState;

use super::model::{
    BatchContext, Kind, MemoryItem, MemoryPatch, NewMemory, ReflectionNote, Scope, ScopeRef,
    Source, WriteOp,
};
use super::scope::{self, ScopeContext};
use super::store::{ReflectionProgress, Rejection};

/// 回合结束后多久没有新回合，算「告一段落」。
pub const IDLE_DELAY: Duration = Duration::from_secs(10 * 60);
/// 启动补复盘只看最近这么多天的会话。
pub const CATCH_UP_DAYS: i64 = 7;
/// 第一次复盘说明卡的 meta 键。
pub const INTRO_KEY: &str = "reflection_intro_shown";
/// 转写太短（寒暄、一问一答）不值得花一次调用。
const MIN_TRANSCRIPT_CHARS: usize = 200;
/// 单次复盘输入的转写上限：超出时只取最后这么多（结论通常在后面）。
const MAX_TRANSCRIPT_CHARS: usize = 60_000;
const MESSAGE_CHARS: usize = 3_000;
const TOOL_ARGS_CHARS: usize = 300;
const TOOL_OUTPUT_CHARS: usize = 600;
/// 一次复盘最多采纳几个操作（防模型一次刷屏）。
const MAX_OPS: usize = 10;

pub const EVENT_REFLECTION: &str = "memory-reflection";
pub const EVENT_CHANGED: &str = "memory-changed";

/// 复盘的触发来源（日志与「有任务在跑时要不要等」用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Idle,
    SameHostActivity,
    Compaction,
    CatchUp,
}

struct Pending {
    connection_id: String,
    /// 挂定时器时这段对话所在的 SSH 会话：它断开（用户关了标签）就立即复盘。
    session_id: String,
    generation: u64,
    abort: tokio::task::AbortHandle,
}

#[derive(Default)]
struct Inner {
    pending: HashMap<String, Pending>,
    running: HashSet<String>,
    next_generation: u64,
}

/// 复盘调度器（`MemoryManager` 持有一个）。
pub struct Reflector {
    inner: Mutex<Inner>,
    /// 全局同时只跑一个复盘。
    gate: tokio::sync::Semaphore,
}

impl Default for Reflector {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            gate: tokio::sync::Semaphore::new(1),
        }
    }
}

/// 发给前端的复盘结果事件。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReflectionEvent {
    pub conversation_id: String,
    /// 这次有改动（或是第一次复盘）才有提示行；没有时事件只为把用量读数送到前端。
    pub note: Option<ReflectionNote>,
    /// 复盘花掉的 token 已累加进会话用量：这里带上最新读数（含子对话口径）。
    pub usage: Option<ConversationUsage>,
}

/// 发给前端的「记忆变了」事件（管理页、Agent 面板据此刷新）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedEvent {
    pub source: Source,
    pub conversation_id: Option<String>,
}

pub(crate) fn emit_changed(state: &AppState, source: Source, conversation_id: Option<&str>) {
    if let Some(app) = state.memory.app() {
        let _ = app.emit(
            EVENT_CHANGED,
            ChangedEvent {
                source,
                conversation_id: conversation_id.map(String::from),
            },
        );
    }
}

impl Reflector {
    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 主任务开始：本会话挂着的定时器作废（对话还在继续）；同一台机器上**别的**
    /// 会话挂着的定时器立即触发（用户已经转去干别的了）。
    pub fn on_turn_started(
        &self,
        state: &AppState,
        conversation_id: &str,
        connection_id: Option<&str>,
    ) {
        let mut fire: Vec<String> = Vec::new();
        {
            let mut inner = self.lock();
            if let Some(p) = inner.pending.remove(conversation_id) {
                p.abort.abort();
            }
            if let Some(cid) = connection_id {
                let others: Vec<String> = inner
                    .pending
                    .iter()
                    .filter(|(_, p)| p.connection_id == cid)
                    .map(|(k, _)| k.clone())
                    .collect();
                for k in others {
                    if let Some(p) = inner.pending.remove(&k) {
                        p.abort.abort();
                        fire.push(k);
                    }
                }
            }
        }
        for conv in fire {
            spawn_reflect(state.clone(), conv, Trigger::SameHostActivity);
        }
    }

    /// 主任务收尾：挂一个空闲定时器。
    pub fn on_turn_finished(
        &self,
        state: &AppState,
        conversation_id: &str,
        connection_id: &str,
        session_id: &str,
    ) {
        let mut inner = self.lock();
        inner.next_generation += 1;
        let generation = inner.next_generation;
        if let Some(old) = inner.pending.remove(conversation_id) {
            old.abort.abort();
        }
        let st = state.clone();
        let conv = conversation_id.to_string();
        let handle = tokio::spawn(async move {
            tokio::time::sleep(IDLE_DELAY).await;
            let still_mine = {
                let mut inner = st.memory.reflector.lock();
                match inner.pending.get(&conv) {
                    Some(p) if p.generation == generation => {
                        inner.pending.remove(&conv);
                        true
                    }
                    _ => false,
                }
            };
            if still_mine {
                reflect(st, conv, Trigger::Idle).await;
            }
        });
        inner.pending.insert(
            conversation_id.to_string(),
            Pending {
                connection_id: connection_id.to_string(),
                session_id: session_id.to_string(),
                generation,
                abort: handle.abort_handle(),
            },
        );
    }

    /// SSH 会话断开（用户关了标签 / 掉线）：挂在它上面的定时器立即触发。
    ///
    /// 断连观察者拿到的只有 session id（会话此时可能已从表里摘掉，查不到连接），
    /// 所以按挂定时器时记下的 session id 匹配。
    pub fn on_session_closed(&self, state: &AppState, session_id: &str) {
        let fire: Vec<String> = {
            let mut inner = self.lock();
            let keys: Vec<String> = inner
                .pending
                .iter()
                .filter(|(_, p)| p.session_id == session_id)
                .map(|(k, _)| k.clone())
                .collect();
            keys.into_iter()
                .filter_map(|k| {
                    inner.pending.remove(&k).map(|p| {
                        p.abort.abort();
                        k
                    })
                })
                .collect()
        };
        for conv in fire {
            spawn_reflect(state.clone(), conv, Trigger::SameHostActivity);
        }
    }

    /// 会话被删：挂着的定时器作废。
    pub fn forget(&self, conversation_id: &str) {
        if let Some(p) = self.lock().pending.remove(conversation_id) {
            p.abort.abort();
        }
    }

    fn try_mark_running(&self, conversation_id: &str) -> bool {
        self.lock().running.insert(conversation_id.to_string())
    }

    fn unmark_running(&self, conversation_id: &str) {
        self.lock().running.remove(conversation_id);
    }

    fn is_pending_or_running(&self, conversation_id: &str) -> bool {
        let inner = self.lock();
        inner.pending.contains_key(conversation_id) || inner.running.contains(conversation_id)
    }
}

/// 压缩落库之后：清掉本会话的注入快照（下一轮重渲染），并复盘到压缩边界。
pub fn on_compacted(state: &AppState, conversation_id: &str) {
    if let Err(e) = state.memory.store.drop_snapshot(conversation_id) {
        log::warn!("压缩后清除记忆快照失败（会话 {conversation_id}）: {e}");
    }
    spawn_reflect(
        state.clone(),
        conversation_id.to_string(),
        Trigger::Compaction,
    );
}

/// 启动时补复盘：最近几天上次没来得及复盘的会话，逐个来（全局闸门本来也只放一个）。
pub fn spawn_catch_up(state: AppState) {
    tokio::spawn(async move {
        // 让启动先忙完自己的事。
        tokio::time::sleep(Duration::from_secs(30)).await;
        let since = chrono::Utc::now() - chrono::Duration::days(CATCH_UP_DAYS);
        let convs = match state
            .conversation_db
            .recent_root_conversations(since, None, 200)
        {
            Ok(c) => c,
            Err(e) => {
                log::warn!("启动补复盘：列会话失败: {e}");
                return;
            }
        };
        let idle_cutoff = chrono::Utc::now()
            - chrono::Duration::from_std(IDLE_DELAY).unwrap_or(chrono::Duration::minutes(10));
        for c in convs {
            // 还在「可能继续聊」的窗口里的，不抢跑（下次收尾会挂定时器）。
            let recent = chrono::DateTime::parse_from_rfc3339(&c.updated_at)
                .map(|t| t.with_timezone(&chrono::Utc) > idle_cutoff)
                .unwrap_or(false);
            if recent || state.memory.reflector.is_pending_or_running(&c.id) {
                continue;
            }
            reflect(state.clone(), c.id, Trigger::CatchUp).await;
        }
    });
}

fn spawn_reflect(state: AppState, conversation_id: String, trigger: Trigger) {
    tokio::spawn(async move {
        reflect(state, conversation_id, trigger).await;
    });
}

/// 复盘一个会话（单飞 + 全局闸门 + 失败只记日志）。
pub async fn reflect(state: AppState, conversation_id: String, trigger: Trigger) {
    if !state.memory.reflector.try_mark_running(&conversation_id) {
        return;
    }
    let _permit = state.memory.reflector.gate.acquire().await;
    let result = reflect_inner(&state, &conversation_id, trigger).await;
    state.memory.reflector.unmark_running(&conversation_id);
    match result {
        Ok(Outcome::Skipped(why)) => {
            log::debug!("复盘跳过（会话 {conversation_id}，{trigger:?}）：{why}")
        }
        Ok(Outcome::Done { applied, failed }) => log::info!(
            "复盘完成（会话 {conversation_id}，{trigger:?}）：采纳 {applied} 条，丢弃 {failed} 条"
        ),
        Err(e) => log::warn!("复盘失败（会话 {conversation_id}，{trigger:?}），下次再试：{e}"),
    }
}

enum Outcome {
    Skipped(&'static str),
    Done { applied: usize, failed: usize },
}

pub(crate) fn conversation_has_running_task(state: &AppState, conversation_id: &str) -> bool {
    state
        .agent_tasks
        .read()
        .values()
        .any(|t| t.conversation_id == conversation_id && !t.status.is_terminal())
}

/// 从全部消息里切出「待复盘的一段」：进度锚点之后、记忆库建立之后；压缩触发时
/// 截到最新压缩卡之前。返回 (这一段, 段尾——下次的进度锚点)。
pub(crate) fn pending_segment<'a>(
    rows: &'a [StoredMessage],
    progress: Option<&ReflectionProgress>,
    store_created_at: Option<&str>,
    up_to_latest_card: bool,
) -> (Vec<&'a StoredMessage>, Option<&'a StoredMessage>) {
    let start = match progress {
        Some(p) => match rows.iter().position(|m| m.id == p.anchor_message_id) {
            Some(i) => i + 1,
            // 锚点那条被回滚删掉了：按时间续上。
            None => rows
                .iter()
                .position(|m| m.created_at.to_rfc3339() > p.anchor_created_at)
                .unwrap_or(rows.len()),
        },
        None => 0,
    };
    let end = if up_to_latest_card {
        match rows
            .iter()
            .rposition(|m| m.content.starts_with(COMPACTION_CARD_PREFIX))
        {
            Some(i) => i,
            None => return (Vec::new(), None),
        }
    } else {
        rows.len()
    };
    if start >= end {
        return (Vec::new(), None);
    }
    let window = &rows[start..end];
    let tail = window
        .iter()
        .rev()
        .find(|m| !m.content.starts_with(COMPACTION_CARD_PREFIX));
    let created_floor = store_created_at
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&chrono::Utc));
    let segment = window
        .iter()
        .filter(|m| !m.content.starts_with(COMPACTION_CARD_PREFIX))
        .filter(|m| created_floor.map_or(true, |f| m.created_at >= f))
        .collect();
    (segment, tail)
}

fn truncate_chars(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{head}…（截断，原长 {n} 字）")
}

#[derive(Deserialize)]
struct PersistedCall {
    name: String,
    #[serde(default)]
    arguments: serde_json::Value,
}

#[derive(Deserialize)]
struct PersistedResult {
    name: String,
    #[serde(default)]
    success: bool,
    #[serde(default)]
    blocked: bool,
}

/// 把一段消息转写成复盘输入，顺带收集工具调用里出现过的 `host` 参数。
pub(crate) fn build_transcript(segment: &[&StoredMessage]) -> (String, Vec<String>) {
    let mut lines: Vec<String> = Vec::new();
    let mut hosts: Vec<String> = Vec::new();
    for m in segment {
        match m.role.as_str() {
            "user" => lines.push(format!(
                "[用户] {}",
                truncate_chars(&m.content, MESSAGE_CHARS)
            )),
            "notice" => lines.push(format!(
                "[系统告知] {}",
                truncate_chars(&m.content, MESSAGE_CHARS)
            )),
            "assistant" => {
                if !m.content.trim().is_empty() {
                    lines.push(format!(
                        "[agent] {}",
                        truncate_chars(&m.content, MESSAGE_CHARS)
                    ));
                }
                if let Some(calls) = m
                    .tool_calls_json
                    .as_deref()
                    .and_then(|j| serde_json::from_str::<Vec<PersistedCall>>(j).ok())
                {
                    for c in calls {
                        if let Some(h) = c.arguments.get("host").and_then(|v| v.as_str()) {
                            if !h.trim().is_empty() && !hosts.iter().any(|x| x == h.trim()) {
                                hosts.push(h.trim().to_string());
                            }
                        }
                        lines.push(format!(
                            "[agent 调用 {}] {}",
                            c.name,
                            truncate_chars(&c.arguments.to_string(), TOOL_ARGS_CHARS)
                        ));
                    }
                }
            }
            "tool" => {
                let meta = m
                    .tool_calls_json
                    .as_deref()
                    .and_then(|j| serde_json::from_str::<PersistedResult>(j).ok());
                let (name, status) = match &meta {
                    Some(r) if r.blocked => (r.name.as_str(), "被拦截"),
                    Some(r) if r.success => (r.name.as_str(), "成功"),
                    Some(r) => (r.name.as_str(), "失败"),
                    None => ("工具", "结果"),
                };
                lines.push(format!(
                    "[{name} {status}] {}",
                    truncate_chars(&m.content, TOOL_OUTPUT_CHARS)
                ));
            }
            _ => {}
        }
    }
    let mut text = lines.join("\n");
    let n = text.chars().count();
    if n > MAX_TRANSCRIPT_CHARS {
        let tail: String = text.chars().skip(n - MAX_TRANSCRIPT_CHARS).collect();
        text = format!("（前面较早的部分已省略）\n{tail}");
    }
    (text, hosts)
}

/// 复盘输入里的一台机器。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Machine {
    pub label: String,
    pub connection_id: String,
    pub group: Option<String>,
}

/// 涉及的机器：当前机器 + 工具调用里 `host` 指过的已保存连接（按名字 / `name:N`）。
pub(crate) fn involved_machines(
    connections: &[SavedConnection],
    current: &ScopeContext,
    host_refs: &[String],
) -> Vec<Machine> {
    let mut out: Vec<Machine> = Vec::new();
    let mut push = |id: &str, name: &str, group: Option<String>| {
        if out.iter().any(|m| m.connection_id == id) {
            return;
        }
        let mut label = name.to_string();
        let mut n = 1;
        while out.iter().any(|m| m.label == label) {
            label = format!("{name}#{n}");
            n += 1;
        }
        out.push(Machine {
            label,
            connection_id: id.to_string(),
            group,
        });
    };
    if let Some(id) = &current.connection_id {
        push(
            id,
            &current.host_label().unwrap_or_else(|| id.clone()),
            current.group.clone(),
        );
    }
    for h in host_refs {
        let found = connections.iter().find(|c| c.name == *h).or_else(|| {
            let (base, idx) = crate::multi_host::split_suffix(h);
            idx.and_then(|i| connections.iter().filter(|c| c.name == base).nth(i))
        });
        if let Some(c) = found {
            let group = c
                .group
                .clone()
                .map(|g| g.trim().to_string())
                .filter(|g| !g.is_empty());
            push(&c.id, &c.name, group);
        }
    }
    out
}

fn render_existing(items: &[MemoryItem], machines: &[Machine]) -> String {
    if items.is_empty() {
        return "（暂无）".into();
    }
    items
        .iter()
        .map(|m| {
            let scope = match m.scope {
                Scope::User => "user".to_string(),
                Scope::Group => format!("group「{}」", m.scope_key),
                Scope::Host => {
                    let label = machines
                        .iter()
                        .find(|x| x.connection_id == m.scope_key)
                        .map(|x| x.label.as_str())
                        .unwrap_or(m.scope_key.as_str());
                    format!("host「{label}」")
                }
            };
            format!(
                "- id={} [{}·{}] {}：{}",
                m.id,
                scope,
                m.kind.as_str(),
                m.title,
                m.content.replace('\n', " ")
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_rejections(rej: &[Rejection]) -> String {
    if rej.is_empty() {
        return "（暂无）".into();
    }
    rej.iter()
        .map(|r| format!("- {}：{}", r.title, r.content.replace('\n', " ")))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn build_user_message(
    transcript: &str,
    machines: &[Machine],
    existing: &[MemoryItem],
    rejections: &[Rejection],
    today: &str,
) -> String {
    let machine_lines = if machines.is_empty() {
        "（这段对话不涉及已保存的机器，只能记 user 作用域）".to_string()
    } else {
        machines
            .iter()
            .map(|m| match &m.group {
                Some(g) => format!("- {}（分组：{}）", m.label, g),
                None => format!("- {}（未分组）", m.label),
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "今天是 {today}。\n\n## 涉及的机器\n{machine_lines}\n\n## 现有记忆\n{}\n\n## 用户撤销过、不想要的记忆\n{}\n\n## 对话\n{transcript}",
        render_existing(existing, machines),
        render_rejections(rejections),
    )
}

#[derive(Debug, Deserialize)]
struct RawOutput {
    #[serde(default)]
    ops: Vec<RawOp>,
}

#[derive(Debug, Deserialize)]
struct RawOp {
    op: String,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    host: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    id: Option<String>,
}

/// 从模型回复里抠出 JSON（容忍代码块与前后废话）。
fn extract_json(text: &str) -> Option<&str> {
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    (end > start).then(|| &text[start..=end])
}

/// 把模型输出翻译成写入操作：作用域、机器、id 都要能对上，对不上的丢弃。
pub(crate) fn parse_ops(
    text: &str,
    machines: &[Machine],
    existing: &[MemoryItem],
    conversation_id: &str,
    anchor_message_id: &str,
) -> Result<(Vec<WriteOp>, usize), String> {
    let json = extract_json(text).ok_or("复盘输出里没有 JSON")?;
    let raw: RawOutput =
        serde_json::from_str(json).map_err(|e| format!("复盘输出解析失败：{e}"))?;
    let known: HashSet<&str> = existing.iter().map(|m| m.id.as_str()).collect();
    let mut ops = Vec::new();
    let mut dropped = 0usize;
    for r in raw.ops.into_iter().take(MAX_OPS) {
        let op = match r.op.trim() {
            "add" => {
                let scope = r
                    .scope
                    .as_deref()
                    .and_then(Scope::parse)
                    .unwrap_or(Scope::Host);
                let machine = match r.host.as_deref().map(str::trim).filter(|h| !h.is_empty()) {
                    Some(h) => machines.iter().find(|m| m.label == h),
                    None => machines.first(),
                };
                let scope_key = match scope {
                    Scope::User => Some(String::new()),
                    Scope::Host => machine.map(|m| m.connection_id.clone()),
                    Scope::Group => machine.and_then(|m| m.group.clone()),
                };
                match (scope_key, r.title, r.content) {
                    (Some(scope_key), Some(title), Some(content)) => Some(WriteOp::Add {
                        memory: NewMemory {
                            scope,
                            scope_key,
                            kind: r
                                .kind
                                .as_deref()
                                .and_then(Kind::parse)
                                .unwrap_or(Kind::Fact),
                            title,
                            content,
                            pinned: false,
                            source_conversation_id: Some(conversation_id.to_string()),
                            source_message_id: Some(anchor_message_id.to_string()),
                        },
                    }),
                    _ => None,
                }
            }
            "update" => match r.id {
                Some(id) if known.contains(id.as_str()) => {
                    let patch = MemoryPatch {
                        title: r.title,
                        content: r.content,
                        kind: r.kind.as_deref().and_then(Kind::parse),
                        ..Default::default()
                    };
                    (!patch.is_empty()).then_some(WriteOp::Update {
                        id,
                        expected_version: None,
                        patch,
                    })
                }
                _ => None,
            },
            "delete" => match r.id {
                Some(id) if known.contains(id.as_str()) => Some(WriteOp::Delete {
                    id,
                    expected_version: None,
                }),
                _ => None,
            },
            _ => None,
        };
        match op {
            Some(op) => ops.push(op),
            None => dropped += 1,
        }
    }
    Ok((ops, dropped))
}

async fn reflect_inner(
    state: &AppState,
    conversation_id: &str,
    trigger: Trigger,
) -> Result<Outcome, String> {
    let settings = state.settings.read().await.memory_settings.clone();
    let db = state.conversation_db.clone();
    let store = state.memory.store.clone();

    let conversation = db
        .get_conversation(conversation_id)
        .map_err(|e| e.to_string())?
        .ok_or("会话已不存在")?;
    if conversation.parent_conversation_id.is_some() {
        return Ok(Outcome::Skipped("子对话不复盘"));
    }
    if trigger != Trigger::Compaction && conversation_has_running_task(state, conversation_id) {
        return Ok(Outcome::Skipped("会话还有任务在跑，等它收尾"));
    }

    let rows = db
        .load_messages(conversation_id)
        .map_err(|e| e.to_string())?;
    let progress = store.progress(conversation_id).map_err(|e| e.to_string())?;
    let created = store.meta("store_created_at").map_err(|e| e.to_string())?;
    let (segment, tail) = pending_segment(
        &rows,
        progress.as_ref(),
        created.as_deref(),
        trigger == Trigger::Compaction,
    );
    let Some(tail) = tail else {
        return Ok(Outcome::Skipped("没有新消息"));
    };
    let new_progress = ReflectionProgress {
        anchor_message_id: tail.id.clone(),
        anchor_created_at: tail.created_at.to_rfc3339(),
    };
    let advance = |why: &'static str| -> Result<Outcome, String> {
        store
            .set_progress(conversation_id, &new_progress)
            .map_err(|e| e.to_string())?;
        Ok(Outcome::Skipped(why))
    };

    if !settings.enabled || !settings.auto_reflect {
        return advance("后台复盘已关闭，只推进进度");
    }
    let (transcript, host_refs) = build_transcript(&segment);
    if transcript.chars().count() < MIN_TRANSCRIPT_CHARS
        || !segment.iter().any(|m| m.role == "user")
    {
        return advance("这一段太短，不值得复盘");
    }

    let connections = state.connection_store.read().await.get_all().to_vec();
    let ctx = scope::from_connections(&connections, Some(&conversation.connection_id));
    let machines = involved_machines(&connections, &ctx, &host_refs);
    let mut scopes: Vec<ScopeRef> = vec![ScopeRef::user()];
    for m in &machines {
        if let Some(g) = &m.group {
            let s = ScopeRef::group(g.clone());
            if !scopes.contains(&s) {
                scopes.push(s);
            }
        }
        scopes.push(ScopeRef::host(m.connection_id.clone()));
    }
    let existing = store.list_scopes(&scopes).map_err(|e| e.to_string())?;
    let rejections = store.rejections(&scopes).map_err(|e| e.to_string())?;

    let manager = super::resolve_memory_model(state, Some(conversation_id))
        .await
        .map_err(|e| format!("记忆模型不可用：{e}"))?;
    let system = TemplateManager.render_fragment("复盘", &json!({}));
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let user = build_user_message(&transcript, &machines, &existing, &rejections, &today);
    let (reply, usage) = call_model(
        &manager,
        vec![LlmMessage::system(system), LlmMessage::user(user)],
    )
    .await?;

    let usage_now = match &usage {
        Some(u) => db.add_side_usage(conversation_id, u).ok().flatten(),
        None => None,
    };

    let (ops, dropped) = parse_ops(&reply, &machines, &existing, conversation_id, &tail.id)?;
    let ctx_batch = BatchContext::new(Source::Reflection, Some(conversation_id.to_string()));
    let (records, failures) = if ops.is_empty() {
        (Vec::new(), Vec::new())
    } else {
        store
            .apply_lenient(&ctx_batch, &ops)
            .map_err(|e| e.to_string())?
    };
    for f in &failures {
        log::debug!("复盘的一个操作被拒：{f}");
    }
    store
        .set_progress(conversation_id, &new_progress)
        .map_err(|e| e.to_string())?;

    let intro = store.claim_once(INTRO_KEY).unwrap_or(false);
    let note = if !records.is_empty() || intro {
        let batch = (!records.is_empty()).then_some(ctx_batch.batch_id.as_str());
        Some(
            store
                .add_note(conversation_id, &tail.id, batch, intro)
                .map_err(|e| e.to_string())?,
        )
    } else {
        None
    };
    if note.is_some() || usage_now.is_some() {
        if let Some(app) = state.memory.app() {
            let _ = app.emit(
                EVENT_REFLECTION,
                ReflectionEvent {
                    conversation_id: conversation_id.to_string(),
                    note,
                    usage: usage_now,
                },
            );
        }
    }
    if !records.is_empty() {
        emit_changed(state, Source::Reflection, Some(conversation_id));
    }
    Ok(Outcome::Done {
        applied: records.len(),
        failed: dropped + failures.len(),
    })
}

/// 一次非流式调用，顺带拿回用量。
pub(crate) async fn call_model(
    manager: &crate::llm::manager::LlmManager,
    messages: Vec<LlmMessage>,
) -> Result<(String, Option<TokenUsage>), String> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
    let collector = tokio::spawn(async move {
        let mut usage = None;
        while let Some(ev) = rx.recv().await {
            if let StreamEvent::Usage { usage: u } = ev {
                usage = Some(u);
            }
        }
        usage
    });
    let result = manager.stream_chat(&messages, &[], &tx, None).await;
    drop(tx);
    let usage = collector.await.ok().flatten();
    let msg = result.map_err(|e| e.to_string())?;
    if msg.finish_reason.as_deref() == Some("length") {
        return Err("模型输出被长度上限截断".into());
    }
    Ok((msg.content, usage))
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn row(
        id: &str,
        role: &str,
        content: &str,
        secs: i64,
        tool_calls: Option<&str>,
    ) -> StoredMessage {
        StoredMessage {
            id: id.into(),
            conversation_id: "c".into(),
            role: role.into(),
            content: content.into(),
            timestamp: String::new(),
            created_at: chrono::DateTime::from_timestamp(1_800_000_000 + secs, 0).unwrap(),
            tool_calls_json: tool_calls.map(String::from),
            reasoning_content: None,
            image_paths_json: None,
            turn_state: None,
            user_input_json: None,
        }
    }

    #[test]
    fn segment_starts_after_progress_and_skips_cards() {
        let rows = vec![
            row("1", "user", "a", 1, None),
            row("2", "assistant", "b", 2, None),
            row(
                "3",
                "system",
                &format!("{COMPACTION_CARD_PREFIX}x"),
                3,
                None,
            ),
            row("4", "user", "c", 4, None),
            row("5", "assistant", "d", 5, None),
        ];
        let p = ReflectionProgress {
            anchor_message_id: "2".into(),
            anchor_created_at: rows[1].created_at.to_rfc3339(),
        };
        let (seg, tail) = pending_segment(&rows, Some(&p), None, false);
        assert_eq!(
            seg.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["4", "5"]
        );
        assert_eq!(tail.unwrap().id, "5");

        // 压缩触发：截到最新压缩卡之前
        let (seg, tail) = pending_segment(&rows, None, None, true);
        assert_eq!(
            seg.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["1", "2"]
        );
        assert_eq!(tail.unwrap().id, "2");
    }

    #[test]
    fn segment_falls_back_to_time_when_anchor_was_deleted() {
        let rows = vec![
            row("4", "user", "c", 4, None),
            row("5", "assistant", "d", 5, None),
        ];
        let p = ReflectionProgress {
            anchor_message_id: "gone".into(),
            anchor_created_at: chrono::DateTime::<Utc>::from_timestamp(1_800_000_004, 0)
                .unwrap()
                .to_rfc3339(),
        };
        let (seg, _) = pending_segment(&rows, Some(&p), None, false);
        assert_eq!(seg.len(), 1);
        assert_eq!(seg[0].id, "5");
    }

    #[test]
    fn segment_ignores_messages_before_store_creation() {
        let rows = vec![
            row("1", "user", "old", 1, None),
            row("2", "user", "new", 100, None),
        ];
        let floor = chrono::DateTime::<Utc>::from_timestamp(1_800_000_050, 0)
            .unwrap()
            .to_rfc3339();
        let (seg, tail) = pending_segment(&rows, None, Some(&floor), false);
        assert_eq!(seg.len(), 1);
        assert_eq!(seg[0].id, "2");
        assert_eq!(tail.unwrap().id, "2", "进度照样推进到段尾");
    }

    #[test]
    fn transcript_includes_calls_results_and_collects_hosts() {
        let call = r#"[{"id":"t1","name":"bash","arguments":{"command":"systemctl restart x","host":"db-01"}}]"#;
        let result = r#"{"id":"t1","name":"bash","arguments":{},"disposition":"Allow","summary":"s","success":false,"blocked":false}"#;
        let rows = [
            row("1", "user", "重启 x", 1, None),
            row("2", "assistant", "", 2, Some(call)),
            row("3", "tool", "Job for x.service failed", 3, Some(result)),
        ];
        let refs: Vec<&StoredMessage> = rows.iter().collect();
        let (text, hosts) = build_transcript(&refs);
        assert!(text.contains("[用户] 重启 x"));
        assert!(text.contains("[agent 调用 bash]"));
        assert!(text.contains("[bash 失败] Job for x.service failed"));
        assert_eq!(hosts, vec!["db-01".to_string()]);
    }

    fn machines() -> Vec<Machine> {
        vec![
            Machine {
                label: "web-01".into(),
                connection_id: "c1".into(),
                group: Some("prod".into()),
            },
            Machine {
                label: "db-01".into(),
                connection_id: "c2".into(),
                group: None,
            },
        ]
    }

    fn existing() -> Vec<MemoryItem> {
        vec![MemoryItem {
            id: "m1".into(),
            scope: Scope::Host,
            scope_key: "c1".into(),
            kind: Kind::Fact,
            title: "nginx".into(),
            content: "在 /opt".into(),
            pinned: false,
            source: Source::Agent,
            source_conversation_id: None,
            source_message_id: None,
            created_at: String::new(),
            updated_at: String::new(),
            version: 1,
            is_new: false,
        }]
    }

    #[test]
    fn parse_ops_maps_scopes_and_drops_unknowns() {
        let reply = r#"好的：
```json
{"ops":[
 {"op":"add","scope":"host","host":"db-01","kind":"lesson","title":"pg 重启","content":"要先停 pgbouncer"},
 {"op":"add","scope":"group","kind":"fact","title":"部署","content":"compose 在 /srv"},
 {"op":"add","scope":"user","kind":"preference","title":"语言","content":"中文"},
 {"op":"add","scope":"host","host":"不存在","title":"x","content":"y"},
 {"op":"update","id":"m1","content":"在 /etc/nginx"},
 {"op":"delete","id":"m999"},
 {"op":"frobnicate"}
]}
```"#;
        let (ops, dropped) = parse_ops(reply, &machines(), &existing(), "conv", "msg9").unwrap();
        assert_eq!(dropped, 3);
        assert_eq!(ops.len(), 4);
        match &ops[0] {
            WriteOp::Add { memory } => {
                assert_eq!(memory.scope, Scope::Host);
                assert_eq!(memory.scope_key, "c2");
                assert_eq!(memory.kind, Kind::Lesson);
                assert_eq!(memory.source_message_id.as_deref(), Some("msg9"));
            }
            other => panic!("{other:?}"),
        }
        match &ops[1] {
            WriteOp::Add { memory } => {
                assert_eq!(memory.scope, Scope::Group);
                assert_eq!(memory.scope_key, "prod", "没写 host 时按当前机器的分组");
            }
            other => panic!("{other:?}"),
        }
        assert!(matches!(&ops[3], WriteOp::Update { id, .. } if id == "m1"));
    }

    #[test]
    fn parse_ops_accepts_empty_and_rejects_garbage() {
        assert_eq!(
            parse_ops(r#"{"ops":[]}"#, &machines(), &[], "c", "m")
                .unwrap()
                .0
                .len(),
            0
        );
        assert!(parse_ops("我觉得没什么好记的", &machines(), &[], "c", "m").is_err());
    }

    #[test]
    fn involved_machines_resolves_names_and_suffixes() {
        use crate::memory::scope::from_connections;
        let mk = |id: &str, name: &str| SavedConnection {
            id: id.into(),
            name: name.into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth_method: "password".into(),
            key_path: None,
            key_id: None,
            group: None,
            last_connected: None,
            use_jump: false,
            jump_host: None,
            jump_port: None,
            jump_username: None,
            jump_auth_method: None,
            jump_key_path: None,
            jump_key_id: None,
            remote_platform: None,
            port_forwards: Vec::new(),
        };
        let conns = vec![mk("a", "web"), mk("b", "db"), mk("c", "db")];
        let cur = from_connections(&conns, Some("a"));
        let ms = involved_machines(&conns, &cur, &["db:1".into(), "web".into(), "nope".into()]);
        assert_eq!(
            ms.iter()
                .map(|m| (m.label.as_str(), m.connection_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("web", "a"), ("db", "c")]
        );
    }

    #[test]
    fn user_message_lists_machines_memories_and_rejections() {
        let msg = build_user_message(
            "[用户] hi",
            &machines(),
            &existing(),
            &[Rejection {
                scope: Scope::User,
                key: String::new(),
                title: "别记".into(),
                content: "x".into(),
            }],
            "2026-10-20",
        );
        assert!(msg.contains("今天是 2026-10-20"));
        assert!(msg.contains("- web-01（分组：prod）"));
        assert!(msg.contains("id=m1 [host「web-01」·fact] nginx：在 /opt"));
        assert!(msg.contains("- 别记：x"));
    }
}
