//! 记忆整理助手：记忆管理页里的对话框，一句话批量整理记忆。
//!
//! 刻意是一个**独立的小循环**，不复用 agent loop：它不碰任何服务器、不需要审批、
//! 不落会话库、不进会话列表——agent loop 的那些机制（SSH 会话、风险评估、落库、
//! 压缩、回合折叠）它一样都用不上，硬套只会处处打补丁。
//!
//! 一次请求（`run`）里所有 `memory_apply` 共用一个 batch：界面上的「撤销这次」就是
//! `revert_batch` 这一个 batch。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::agent::templates::TemplateManager;
use crate::config::connections::SavedConnection;
use crate::error::AppError;
use crate::llm::provider::{LlmMessage, LlmRole, ToolCall, ToolDefinition};
use crate::llm::streaming::StreamEvent;
use crate::AppState;

use super::inject::relative_time;
use super::model::{
    BatchContext, Kind, MemoryItem, MemoryOpRecord, MemoryPatch, NewMemory, Scope, ScopeRef,
    Source, WriteOp,
};
use super::reflect::{build_transcript, emit_changed};

/// 一次请求最多几轮工具调用。
const MAX_ROUNDS: usize = 16;
/// history_read 每页的转写字数。
const HISTORY_PAGE_CHARS: usize = 16_000;
/// memory_list 的默认与最大条数。
const LIST_DEFAULT: usize = 100;
const LIST_MAX: usize = 300;

pub const EVENT_PROGRESS: &str = "memory-assistant-progress";

/// 进行中的请求（run_id → 取消信号）。
#[derive(Default)]
pub struct AssistantRuns {
    cancels: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

impl AssistantRuns {
    pub fn cancel(&self, run_id: &str) -> bool {
        match self
            .cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(run_id)
        {
            Some(tx) => {
                let _ = tx.send(true);
                true
            }
            None => false,
        }
    }
}

struct RunGuard<'a> {
    runs: &'a AssistantRuns,
    run_id: String,
}

impl Drop for RunGuard<'_> {
    fn drop(&mut self) {
        self.runs
            .cancels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.run_id);
    }
}

/// 对话框里之前的往来（只有文字，工具过程不回放）。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantTurn {
    pub role: String,
    pub content: String,
}

/// 助手做的一步：看了什么、读了哪段会话、改了多少。整理过程要摆在用户面前，不能是黑箱。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantStep {
    /// 本次请求内的序号（事件与最终回复靠它对上同一步）。
    pub id: usize,
    pub tool: String,
    /// 「查看记忆」「阅读历史会话」这类动作名。
    pub label: String,
    /// 对谁做的：机器、关键词、哪个会话……
    pub detail: String,
    /// 结果：「列出 12 条」「读完了」「没有命中」；失败时是原因。运行中为空。
    pub outcome: String,
    pub ok: bool,
    pub running: bool,
    /// 模型在发起这一步之前说的话（「我先看看现有的记忆」），没有则为空。
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantReply {
    pub text: String,
    /// 本次请求的改动所在 batch（没改任何东西时为 None）。
    pub batch_id: Option<String>,
    pub ops: Vec<MemoryOpRecord>,
    /// 完整的步骤清单（权威：进度事件可能错过，以这份为准）。
    pub steps: Vec<AssistantStep>,
}

/// 进度事件：`kind = "text"` 是回复正文的增量，`"tool"` 是一步开始了（`step.running`），
/// `"step"` 是这一步有结果了，`"ops"` 是刚提交生效的一批改动（带 batch id —— 中途停止时前端照样能「撤销这次」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEvent {
    pub run_id: String,
    pub kind: &'static str,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub ops: Vec<MemoryOpRecord>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step: Option<AssistantStep>,
}

/// 可引用的机器：全部已保存连接，同名按 `name:N` 消歧（与多机操控同一套规则）。
#[derive(Debug, Clone)]
pub(crate) struct Machines {
    entries: Vec<(String, SavedConnection)>,
}

impl Machines {
    pub(crate) fn new(conns: &[SavedConnection]) -> Self {
        let names: Vec<String> = conns.iter().map(|c| c.name.clone()).collect();
        let labels = crate::multi_host::disambiguated_labels(&names);
        Self {
            entries: labels.into_iter().zip(conns.iter().cloned()).collect(),
        }
    }

    fn by_label(&self, label: &str) -> Option<&SavedConnection> {
        let label = label.trim();
        self.entries
            .iter()
            .find(|(l, _)| l == label)
            .map(|(_, c)| c)
    }

    fn label_of(&self, connection_id: &str) -> Option<&str> {
        self.entries
            .iter()
            .find(|(_, c)| c.id == connection_id)
            .map(|(l, _)| l.as_str())
    }

    fn scope_text(&self, m: &MemoryItem) -> String {
        match m.scope {
            Scope::User => "全局".into(),
            Scope::Group => format!("分组「{}」", m.scope_key),
            Scope::Host => match self.label_of(&m.scope_key) {
                Some(l) => format!("机器「{l}」"),
                None => format!(
                    "已删除的连接（{}）",
                    &m.scope_key.chars().take(8).collect::<String>()
                ),
            },
        }
    }
}

fn tool_defs() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition {
            name: "memory_list".into(),
            description: "列出记忆（带 id 与版本号 v）。不给筛选条件时列出全部。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "enum": ["all", "user", "group", "host"], "description": "作用域，默认 all"},
                    "host": {"type": "string", "description": "scope=host 时只看这台机器（机器名原样取自系统提示里的列表）"},
                    "group": {"type": "string", "description": "scope=group 时只看这个分组"},
                    "query": {"type": "string", "description": "关键词（空格分隔，命中越多越靠前）"},
                    "limit": {"type": "integer", "description": "默认 100，最大 300"}
                }
            }),
        },
        ToolDefinition {
            name: "memory_apply".into(),
            description: "提交一批修改：要么全部生效，要么全不生效（任何一条出错整批作废并告诉你原因）。\
                          修改与删除必须带刚读到的版本号 version；新增同一作用域里重复标题会被拒绝。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "ops": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "op": {"type": "string", "enum": ["add", "update", "delete"]},
                                "id": {"type": "string", "description": "update / delete 的目标"},
                                "version": {"type": "integer", "description": "update / delete 必填：memory_list 里的 v"},
                                "scope": {"type": "string", "enum": ["user", "group", "host"], "description": "add 必填；update 时给了就是改作用域"},
                                "host": {"type": "string", "description": "scope=host 时的机器名"},
                                "group": {"type": "string", "description": "scope=group 时的分组名"},
                                "kind": {"type": "string", "enum": ["preference", "fact", "lesson", "change"]},
                                "title": {"type": "string"},
                                "content": {"type": "string"},
                                "pinned": {"type": "boolean"}
                            },
                            "required": ["op"]
                        }
                    }
                },
                "required": ["ops"]
            }),
        },
        ToolDefinition {
            name: "history_list".into(),
            description: "列出某台机器以前的会话（新→旧，带会话 id、标题、最后活动时间）。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "host": {"type": "string", "description": "机器名"},
                    "limit": {"type": "integer", "description": "默认 30，最大 100"}
                },
                "required": ["host"]
            }),
        },
        ToolDefinition {
            name: "history_search".into(),
            description: "在某台机器以前的会话里按关键词搜（每个词都要命中），返回会话 id 与命中片段。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "host": {"type": "string", "description": "机器名"},
                    "query": {"type": "string", "description": "关键词，空格分隔"},
                    "limit": {"type": "integer", "description": "默认 20，最大 50"}
                },
                "required": ["host", "query"]
            }),
        },
        ToolDefinition {
            name: "history_read".into(),
            description: "按页读一段会话的转写（用户与 agent 的往来，工具输出已截断）。\
                          返回里有 next_page 就说明还没读完。".into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "conversation_id": {"type": "string"},
                    "page": {"type": "integer", "description": "从 0 开始，默认 0"}
                },
                "required": ["conversation_id"]
            }),
        },
    ]
}

fn str_arg<'a>(args: &'a Value, key: &str) -> Option<&'a str> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn usize_arg(args: &Value, key: &str, default: usize, max: usize) -> usize {
    args.get(key)
        .and_then(|v| v.as_u64())
        .map(|n| (n as usize).clamp(1, max))
        .unwrap_or(default)
}

fn render_items(items: &[MemoryItem], machines: &Machines) -> String {
    if items.is_empty() {
        return "（没有符合条件的记忆）".into();
    }
    let now = chrono::Utc::now();
    items
        .iter()
        .map(|m| {
            format!(
                "- id={} v={} [{}·{}{}] {}：{}（{}更新）",
                m.id,
                m.version,
                machines.scope_text(m),
                m.kind.as_str(),
                if m.pinned { "·置顶" } else { "" },
                m.title,
                m.content.replace('\n', " "),
                relative_time(&m.updated_at, now)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn resolve_scope(scope: Scope, args: &Value, machines: &Machines) -> Result<ScopeRef, String> {
    match scope {
        Scope::User => Ok(ScopeRef::user()),
        Scope::Group => str_arg(args, "group")
            .map(ScopeRef::group)
            .ok_or_else(|| "scope=group 时必须给 group".to_string()),
        Scope::Host => {
            let h = str_arg(args, "host").ok_or("scope=host 时必须给 host")?;
            machines
                .by_label(h)
                .map(|c| ScopeRef::host(c.id.clone()))
                .ok_or_else(|| format!("找不到机器「{h}」，请原样使用系统提示里的机器名"))
        }
    }
}

/// 把一条 memory_apply 的参数翻译成写入操作。
fn to_write_op(raw: &Value, machines: &Machines) -> Result<WriteOp, String> {
    let op = str_arg(raw, "op").ok_or("每条操作都要有 op")?;
    let kind = str_arg(raw, "kind").and_then(Kind::parse);
    let version = raw.get("version").and_then(|v| v.as_i64());
    match op {
        "add" => {
            let scope = str_arg(raw, "scope")
                .and_then(Scope::parse)
                .ok_or("add 必须给 scope（user / group / host）")?;
            let sr = resolve_scope(scope, raw, machines)?;
            Ok(WriteOp::Add {
                memory: NewMemory {
                    scope: sr.scope,
                    scope_key: sr.key,
                    kind: kind.unwrap_or(Kind::Fact),
                    title: str_arg(raw, "title").unwrap_or_default().to_string(),
                    content: str_arg(raw, "content").unwrap_or_default().to_string(),
                    pinned: raw.get("pinned").and_then(|v| v.as_bool()).unwrap_or(false),
                    source_conversation_id: None,
                    source_message_id: None,
                },
            })
        }
        "update" => {
            let id = str_arg(raw, "id").ok_or("update 必须给 id")?.to_string();
            let version = version.ok_or("update 必须带 version（memory_list 里的 v）")?;
            let scope = match str_arg(raw, "scope").and_then(Scope::parse) {
                Some(s) => Some(resolve_scope(s, raw, machines)?),
                None => None,
            };
            Ok(WriteOp::Update {
                id,
                expected_version: Some(version),
                patch: MemoryPatch {
                    title: str_arg(raw, "title").map(String::from),
                    content: str_arg(raw, "content").map(String::from),
                    kind,
                    scope,
                    pinned: raw.get("pinned").and_then(|v| v.as_bool()),
                },
            })
        }
        "delete" => Ok(WriteOp::Delete {
            id: str_arg(raw, "id").ok_or("delete 必须给 id")?.to_string(),
            expected_version: Some(version.ok_or("delete 必须带 version（memory_list 里的 v）")?),
        }),
        other => Err(format!("未知操作 {other}")),
    }
}

struct Ctx<'a> {
    state: &'a AppState,
    machines: Machines,
    batch: BatchContext,
    ops: Vec<MemoryOpRecord>,
}

impl Ctx<'_> {
    fn exec(&mut self, call: &ToolCall) -> String {
        let args = &call.arguments;
        let store = &self.state.memory.store;
        match call.name.as_str() {
            "memory_list" => {
                let scope = str_arg(args, "scope").and_then(Scope::parse);
                let limit = usize_arg(args, "limit", LIST_DEFAULT, LIST_MAX);
                let mut items = match store.list_all() {
                    Ok(i) => i,
                    Err(e) => return format!("读取失败：{e}"),
                };
                if let Some(s) = scope {
                    items.retain(|m| m.scope == s);
                    match s {
                        Scope::Host => {
                            if let Some(h) = str_arg(args, "host") {
                                match self.machines.by_label(h) {
                                    Some(c) => items.retain(|m| m.scope_key == c.id),
                                    None => return format!("找不到机器「{h}」"),
                                }
                            }
                        }
                        Scope::Group => {
                            if let Some(g) = str_arg(args, "group") {
                                items.retain(|m| m.scope_key == g);
                            }
                        }
                        Scope::User => {}
                    }
                }
                if let Some(q) = str_arg(args, "query") {
                    let terms: Vec<String> =
                        q.split_whitespace().map(|t| t.to_lowercase()).collect();
                    let mut scored: Vec<(usize, MemoryItem)> = items
                        .into_iter()
                        .filter_map(|m| {
                            let hay = format!("{}\n{}", m.title, m.content).to_lowercase();
                            let s = terms.iter().filter(|t| hay.contains(t.as_str())).count();
                            (s > 0).then_some((s, m))
                        })
                        .collect();
                    scored.sort_by_key(|b| std::cmp::Reverse(b.0));
                    items = scored.into_iter().map(|(_, m)| m).collect();
                }
                let total = items.len();
                items.truncate(limit);
                let mut out = render_items(&items, &self.machines);
                if total > items.len() {
                    out.push_str(&format!("\n……共 {total} 条，只列出前 {}", items.len()));
                }
                out
            }
            "memory_apply" => {
                let Some(raw_ops) = args.get("ops").and_then(|v| v.as_array()) else {
                    return "缺少 ops 数组".into();
                };
                let mut ops = Vec::with_capacity(raw_ops.len());
                for (i, raw) in raw_ops.iter().enumerate() {
                    match to_write_op(raw, &self.machines) {
                        Ok(op) => ops.push(op),
                        Err(e) => return format!("第 {} 条操作有误，整批未提交：{e}", i + 1),
                    }
                }
                if ops.is_empty() {
                    return "ops 是空的，没有提交任何修改".into();
                }
                match store.apply(&self.batch, &ops) {
                    Ok(records) => {
                        let n = records.len();
                        self.ops.extend(records);
                        emit_changed(self.state, Source::Assistant, None);
                        format!("已提交 {n} 条修改")
                    }
                    Err(e) => format!("整批未提交：{e}"),
                }
            }
            "history_list" | "history_search" => {
                let Some(h) = str_arg(args, "host") else {
                    return "必须给 host".into();
                };
                let Some(conn) = self.machines.by_label(h) else {
                    return format!("找不到机器「{h}」");
                };
                let db = &self.state.conversation_db;
                if call.name == "history_list" {
                    let limit = usize_arg(args, "limit", 30, 100);
                    let epoch = chrono::DateTime::<chrono::Utc>::MIN_UTC;
                    match db.recent_root_conversations(
                        epoch,
                        Some(std::slice::from_ref(&conn.id)),
                        limit,
                    ) {
                        Ok(list) if list.is_empty() => "这台机器没有历史会话".into(),
                        Ok(list) => list
                            .iter()
                            .map(|c| {
                                format!(
                                    "- conversation_id={} 「{}」（最后活动 {}）",
                                    c.id,
                                    c.title,
                                    c.updated_at.get(..10).unwrap_or(&c.updated_at)
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                        Err(e) => format!("读取失败：{e}"),
                    }
                } else {
                    let Some(q) = str_arg(args, "query") else {
                        return "必须给 query".into();
                    };
                    let terms: Vec<String> = q.split_whitespace().map(String::from).collect();
                    let limit = usize_arg(args, "limit", 20, 50);
                    match db.search_connections_history(
                        std::slice::from_ref(&conn.id),
                        &terms,
                        None,
                        limit,
                    ) {
                        Ok(hits) if hits.is_empty() => "没有命中".into(),
                        Ok(hits) => hits
                            .iter()
                            .map(|h| {
                                format!(
                                    "- conversation_id={} 「{}」 {} [{}] {}",
                                    h.conversation_id,
                                    h.conversation_title,
                                    h.created_at.get(..10).unwrap_or(&h.created_at),
                                    h.role,
                                    h.snippet
                                )
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                        Err(e) => format!("检索失败：{e}"),
                    }
                }
            }
            "history_read" => {
                let Some(cid) = str_arg(args, "conversation_id") else {
                    return "必须给 conversation_id".into();
                };
                let page = args.get("page").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
                let db = &self.state.conversation_db;
                match db.get_conversation(cid) {
                    Ok(Some(c)) if c.parent_conversation_id.is_none() => {}
                    Ok(_) => return "找不到这个会话（或它是子对话）".into(),
                    Err(e) => return format!("读取失败：{e}"),
                }
                let rows = match db.load_messages(cid) {
                    Ok(r) => r,
                    Err(e) => return format!("读取失败：{e}"),
                };
                let refs: Vec<_> = rows.iter().collect();
                let (text, _) = build_transcript(&refs);
                let chars: Vec<char> = text.chars().collect();
                let start = page * HISTORY_PAGE_CHARS;
                if start >= chars.len() {
                    return "没有更多内容了".into();
                }
                let end = (start + HISTORY_PAGE_CHARS).min(chars.len());
                let mut out: String = chars[start..end].iter().collect();
                if end < chars.len() {
                    out.push_str(&format!("\n\n（未完，next_page={}）", page + 1));
                }
                out
            }
            other => format!("没有工具 {other}"),
        }
    }
}

fn scope_phrase(args: &Value) -> String {
    match str_arg(args, "scope") {
        Some("user") => "全局".into(),
        Some("group") => match str_arg(args, "group") {
            Some(g) => format!("分组「{g}」"),
            None => "分组".into(),
        },
        Some("host") => match str_arg(args, "host") {
            Some(h) => format!("机器「{h}」"),
            None => "机器".into(),
        },
        _ => "全部".into(),
    }
}

/// 这一步是对谁做的（给人看，不含记忆正文）。
fn describe_call(call: &ToolCall, state: &AppState) -> String {
    let a = &call.arguments;
    match call.name.as_str() {
        "memory_list" => {
            let mut parts = vec![scope_phrase(a)];
            if let Some(q) = str_arg(a, "query") {
                parts.push(format!("关键词「{q}」"));
            }
            parts.join(" · ")
        }
        "memory_apply" => {
            let ops = a.get("ops").and_then(|v| v.as_array());
            let count = |kind: &str| {
                ops.map_or(0, |o| {
                    o.iter()
                        .filter(|x| x.get("op").and_then(|v| v.as_str()) == Some(kind))
                        .count()
                })
            };
            let mut parts = Vec::new();
            for (kind, verb) in [("add", "新增"), ("update", "更新"), ("delete", "删除")] {
                let n = count(kind);
                if n > 0 {
                    parts.push(format!("{verb} {n} 条"));
                }
            }
            if parts.is_empty() {
                "提交修改".into()
            } else {
                parts.join(" · ")
            }
        }
        "history_list" => match str_arg(a, "host") {
            Some(h) => format!("机器「{h}」"),
            None => String::new(),
        },
        "history_search" => {
            let mut parts = Vec::new();
            if let Some(h) = str_arg(a, "host") {
                parts.push(format!("机器「{h}」"));
            }
            if let Some(q) = str_arg(a, "query") {
                parts.push(format!("搜「{q}」"));
            }
            parts.join(" · ")
        }
        "history_read" => {
            let page = a.get("page").and_then(|v| v.as_u64()).unwrap_or(0) + 1;
            match str_arg(a, "conversation_id") {
                Some(cid) => {
                    let title = state
                        .conversation_db
                        .get_conversation(cid)
                        .ok()
                        .flatten()
                        .map(|c| c.title);
                    match title {
                        Some(t) => format!("「{t}」第 {page} 页"),
                        None => format!("会话 {cid} 第 {page} 页"),
                    }
                }
                None => String::new(),
            }
        }
        _ => String::new(),
    }
}

/// 工具输出 → 给人看的一句结果，以及这一步算不算成功。
fn summarize_outcome(name: &str, output: &str) -> (String, bool) {
    const FAIL_PREFIXES: [&str; 12] = [
        "读取失败",
        "检索失败",
        "找不到",
        "必须",
        "缺少",
        "第 ",
        "整批未提交",
        "ops 是空",
        "没有工具",
        "未知",
        "scope=",
        "没有可用",
    ];
    if FAIL_PREFIXES.iter().any(|p| output.starts_with(p)) {
        let reason: String = output.chars().take(80).collect();
        return (reason, false);
    }
    let lines_with = |prefix: &str| output.lines().filter(|l| l.starts_with(prefix)).count();
    let outcome = match name {
        "memory_list" => {
            if output.starts_with("（没有符合") {
                "没有符合条件的记忆".to_string()
            } else {
                let shown = lines_with("- id=");
                match output.lines().find_map(|l| l.strip_prefix("……共 ")) {
                    Some(rest) => {
                        let total: String =
                            rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                        format!("共 {total} 条，看了前 {shown} 条")
                    }
                    None => format!("列出 {shown} 条"),
                }
            }
        }
        "memory_apply" => output.to_string(),
        "history_list" => match lines_with("- conversation_id=") {
            0 => "没有历史会话".to_string(),
            n => format!("{n} 个会话"),
        },
        "history_search" => match lines_with("- conversation_id=") {
            0 => "没有命中".to_string(),
            n => format!("命中 {n} 处"),
        },
        "history_read" => {
            if output.starts_with("没有更多内容") {
                "没有更多内容了".to_string()
            } else if output.contains("next_page=") {
                "读了一页，还有后文".to_string()
            } else {
                "读完了".to_string()
            }
        }
        _ => String::new(),
    };
    (outcome, true)
}

fn tool_label(name: &str) -> &'static str {
    match name {
        "memory_list" => "查看记忆",
        "memory_apply" => "修改记忆",
        "history_list" => "翻看历史会话",
        "history_search" => "搜索历史会话",
        "history_read" => "阅读历史会话",
        _ => "处理中",
    }
}

fn focus_text(focus: Option<&ScopeRef>, machines: &Machines) -> Option<String> {
    let f = focus?;
    Some(match f.scope {
        Scope::User => "全局记忆".into(),
        Scope::Group => format!("分组「{}」的记忆", f.key),
        Scope::Host => match machines.label_of(&f.key) {
            Some(l) => format!("机器「{l}」的记忆"),
            None => "一台已删除连接的记忆".into(),
        },
    })
}

/// 跑一次请求。返回最终回复与本次改动。
pub async fn run(
    state: &AppState,
    run_id: &str,
    history: Vec<AssistantTurn>,
    prompt: &str,
    focus: Option<ScopeRef>,
    model_id: Option<&str>,
) -> Result<AssistantReply, AppError> {
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    state
        .memory
        .assistant
        .cancels
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(run_id.to_string(), cancel_tx);
    let _guard = RunGuard {
        runs: &state.memory.assistant,
        run_id: run_id.to_string(),
    };

    let connections = state.connection_store.read().await.get_all().to_vec();
    let machines = Machines::new(&connections);
    let machine_list: Vec<Value> = machines
        .entries
        .iter()
        .map(|(label, c)| json!({"label": label, "group": c.group.clone().unwrap_or_default()}))
        .collect();
    let system = TemplateManager.render_fragment(
        "整理助手",
        &json!({
            "machines": machine_list,
            "focus": focus_text(focus.as_ref(), &machines),
        }),
    );
    let manager = super::resolve_assistant_model(state, model_id).await?;

    let mut messages = vec![LlmMessage::system(system)];
    for t in history {
        match t.role.as_str() {
            "user" => messages.push(LlmMessage::user(t.content)),
            "assistant" => messages.push(LlmMessage::assistant(t.content)),
            _ => {}
        }
    }
    messages.push(LlmMessage::user(prompt.to_string()));

    let mut ctx = Ctx {
        state,
        machines,
        batch: BatchContext::new(Source::Assistant, None),
        ops: Vec::new(),
    };
    let tools = tool_defs();
    let app = state.memory.app().cloned();
    let emit = |kind: &'static str,
                text: String,
                ops: Vec<MemoryOpRecord>,
                batch_id: Option<String>,
                step: Option<AssistantStep>| {
        if let Some(app) = &app {
            let _ = app.emit(
                EVENT_PROGRESS,
                ProgressEvent {
                    run_id: run_id.to_string(),
                    kind,
                    text,
                    batch_id,
                    ops,
                    step,
                },
            );
        }
    };
    let mut steps: Vec<AssistantStep> = Vec::new();

    for _ in 0..MAX_ROUNDS {
        if *cancel_rx.borrow() {
            return Err(AppError::Cancelled("已停止".into()));
        }
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<StreamEvent>();
        let app_fwd = app.clone();
        let run_fwd = run_id.to_string();
        let forwarder = tokio::spawn(async move {
            while let Some(ev) = rx.recv().await {
                if let (StreamEvent::TextDelta { text }, Some(app)) = (&ev, &app_fwd) {
                    let _ = app.emit(
                        EVENT_PROGRESS,
                        ProgressEvent {
                            run_id: run_fwd.clone(),
                            kind: "text",
                            text: text.clone(),
                            batch_id: None,
                            ops: Vec::new(),
                            step: None,
                        },
                    );
                }
            }
        });
        let result = manager
            .stream_chat(&messages, &tools, &tx, Some(&mut cancel_rx))
            .await;
        drop(tx);
        let _ = forwarder.await;
        let reply = result?;
        if *cancel_rx.borrow() {
            return Err(AppError::Cancelled("已停止".into()));
        }
        let calls = reply.tool_calls.clone().unwrap_or_default();
        if calls.is_empty() {
            let batch_id = (!ctx.ops.is_empty()).then(|| ctx.batch.batch_id.clone());
            return Ok(AssistantReply {
                text: reply.content,
                batch_id,
                ops: ctx.ops,
                steps,
            });
        }
        // 这一轮模型在发起工具调用之前说的话，挂在这一轮的第一步上。
        let mut note = reply.content.trim().to_string();
        messages.push(reply);
        for call in &calls {
            let mut step = AssistantStep {
                id: steps.len(),
                tool: call.name.clone(),
                label: tool_label(&call.name).to_string(),
                detail: describe_call(call, state),
                outcome: String::new(),
                ok: true,
                running: true,
                note: std::mem::take(&mut note),
            };
            emit(
                "tool",
                step.label.clone(),
                Vec::new(),
                None,
                Some(step.clone()),
            );
            let applied_before = ctx.ops.len();
            let output = ctx.exec(call);
            if ctx.ops.len() > applied_before {
                emit(
                    "ops",
                    String::new(),
                    ctx.ops[applied_before..].to_vec(),
                    Some(ctx.batch.batch_id.clone()),
                    None,
                );
            }
            let (outcome, ok) = summarize_outcome(&call.name, &output);
            step.outcome = outcome;
            step.ok = ok;
            step.running = false;
            emit("step", String::new(), Vec::new(), None, Some(step.clone()));
            steps.push(step);
            messages.push(LlmMessage {
                estimate_cache: Default::default(),
                sent_at: None,
                role: LlmRole::Tool,
                content: output,
                tool_calls: None,
                tool_call_id: Some(call.id.clone()),
                reasoning_content: None,
                image_paths: None,
                finish_reason: None,
                db_id: None,
                db_id_known: false,
            });
        }
    }
    let batch_id = (!ctx.ops.is_empty()).then(|| ctx.batch.batch_id.clone());
    Ok(AssistantReply {
        text: "这次要处理的内容太多，我先停在这里。已经做的改动见下方清单，可以接着让我继续。"
            .into(),
        batch_id,
        ops: ctx.ops,
        steps,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(id: &str, name: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: name.into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth_method: "password".into(),
            key_path: None,
            key_id: None,
            group: Some("prod".into()),
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
        }
    }

    #[test]
    fn write_ops_resolve_machine_labels_and_require_versions() {
        let m = Machines::new(&[conn("a", "web"), conn("b", "web")]);
        let add = to_write_op(
            &json!({"op":"add","scope":"host","host":"web:1","kind":"fact","title":"t","content":"c"}),
            &m,
        )
        .unwrap();
        assert!(matches!(add, WriteOp::Add { memory } if memory.scope_key == "b"));

        assert!(to_write_op(
            &json!({"op":"add","scope":"host","host":"nope","title":"t","content":"c"}),
            &m
        )
        .is_err());
        assert!(
            to_write_op(&json!({"op":"delete","id":"m1"}), &m).is_err(),
            "删除必须带版本"
        );
        let upd = to_write_op(
            &json!({"op":"update","id":"m1","version":3,"scope":"user"}),
            &m,
        )
        .unwrap();
        assert!(matches!(
            upd,
            WriteOp::Update { expected_version: Some(3), patch, .. } if patch.scope == Some(ScopeRef::user())
        ));
    }

    #[test]
    fn deleted_connections_are_labelled() {
        let m = Machines::new(&[conn("a", "web")]);
        let item = MemoryItem {
            id: "m1".into(),
            scope: Scope::Host,
            scope_key: "ghost-connection-id".into(),
            kind: Kind::Fact,
            title: "t".into(),
            content: "c".into(),
            pinned: false,
            source: Source::User,
            source_conversation_id: None,
            source_message_id: None,
            created_at: String::new(),
            updated_at: String::new(),
            version: 1,
            is_new: false,
        };
        assert!(m.scope_text(&item).starts_with("已删除的连接"));
    }

    #[test]
    fn outcome_summaries_are_readable_and_flag_failures() {
        let (o, ok) = summarize_outcome(
            "memory_list",
            "- id=a v=1 [x] t：c（今天更新）\n- id=b v=1 [x] t：c（今天更新）",
        );
        assert!(ok);
        assert_eq!(o, "列出 2 条");
        let (o, _) = summarize_outcome(
            "memory_list",
            "- id=a v=1 [x] t：c（今天更新）\n……共 40 条，只列出前 1",
        );
        assert_eq!(o, "共 40 条，看了前 1 条");
        let (o, ok) = summarize_outcome("memory_list", "找不到机器「web」");
        assert!(!ok);
        assert!(o.contains("找不到机器"));
        assert_eq!(
            summarize_outcome("history_search", "没有命中"),
            ("没有命中".to_string(), true)
        );
        let (o, ok) = summarize_outcome("memory_apply", "第 2 条操作有误，整批未提交：缺 version");
        assert!(!ok);
        assert!(o.contains("整批未提交"));
        assert_eq!(
            summarize_outcome("history_read", "正文\n\n（未完，next_page=1）").0,
            "读了一页，还有后文"
        );
        assert_eq!(
            summarize_outcome("memory_apply", "已提交 3 条修改"),
            ("已提交 3 条修改".to_string(), true)
        );
    }
}
