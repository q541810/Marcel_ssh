//! 会话历史到 LLM 协议的只读投影。
//!
//! `HistorySnapshot` 描述调用方已经持有的消息次序：有数据库身份的消息按 id 回读，
//! 尚无身份的流式尾部保留原始记录。数据库里后来增加的消息不会自行混进这次快照。
//! 工具组重建、协议闭合与压缩卡 framing 在这里统一完成；不改变压缩、预算或任务策略。

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::messages::messages_select_columns;
use super::{ConversationDb, HistoryError, StoredMessage};
use crate::agent::context::summarizer::{checkpoint_preamble, SUMMARY_CLOSE_TAG, SUMMARY_OPEN_TAG};
use crate::agent::conversation_persister::COMPACTION_CARD_PREFIX;
use crate::llm::provider::{LlmMessage, LlmRole, ToolCall};

/// 原始历史快照，不是调用方预先组装好的 provider 消息。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistorySnapshot {
    #[serde(default)]
    pub entries: Vec<HistoryEntry>,
}

/// 已加载的消息引用与尚未取得数据库身份的流式记录。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HistoryEntry {
    Stored {
        id: String,
        /// 缺字段保留数据库 / fallback 的原值；显式 null 清除，字符串替换。
        /// 现有 live 行为会清除中间 assistant 的 reasoning，明确传 null 才表达
        /// 这次清除，不能把旧快照不认识该字段也解释成清除。
        #[serde(
            rename = "reasoningContent",
            default,
            deserialize_with = "reasoning_override",
            skip_serializing_if = "Option::is_none"
        )]
        reasoning_content: Option<Option<String>>,
        /// 迁移期间的恢复快照：行被删除或数据库暂时不可读时，不丢已有有效内容。
        #[serde(default, skip_serializing_if = "Option::is_none")]
        fallback: Option<Box<HistoryMessage>>,
    },
    Transient {
        message: Box<HistoryMessage>,
    },
}

/// 投影需要的原始消息字段。显示状态、附件展示元数据和回合收尾状态不参与协议构建。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_content: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<HistoryToolCall>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call: Option<HistoryToolCall>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_result: Option<HistoryToolResult>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image_paths: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub db_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<HistoryCompaction>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_loading: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryToolCall {
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub id: Option<String>,
    #[serde(
        default,
        deserialize_with = "optional_string",
        skip_serializing_if = "Option::is_none"
    )]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryToolResult {
    pub tool_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub arguments: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HistoryCompaction {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

impl HistoryMessage {
    /// 与旧 `storedMessageToAgentMessage` 的请求相关转换保持一致。
    /// 错误元数据只影响自身字段；正文始终原样保留，不重组 `user_input_json`。
    pub(crate) fn from_stored(message: &StoredMessage) -> Self {
        let mut history = Self {
            role: message.role.clone(),
            content: message.content.clone(),
            reasoning_content: message.reasoning_content.clone(),
            image_paths: message
                .image_paths_json
                .as_deref()
                .and_then(|raw| serde_json::from_str::<Vec<String>>(raw).ok())
                .filter(|paths| !paths.is_empty()),
            db_id: Some(message.id.clone()),
            ..Self::default()
        };

        if message.content.starts_with(COMPACTION_CARD_PREFIX) {
            let summary = message
                .content
                .split_once('\n')
                .map(|(_, body)| body.trim_start_matches(is_js_whitespace))
                .filter(|body| !body.is_empty())
                .map(str::to_owned);
            history.compaction = Some(HistoryCompaction {
                status: "done".into(),
                summary,
            });
        }

        let parsed = message
            .tool_calls_json
            .as_deref()
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok());
        match (message.role.as_str(), parsed) {
            ("assistant", Some(raw)) => {
                let calls = match raw {
                    Value::Array(calls) => calls,
                    other => vec![other],
                };
                // JS 的 c.id 在 null 上抛错（整组降级），但 {} / 数字等只得到缺失
                // 字段。后者不能连有效项一起丢：随后结果到达顺序未必等于调用顺序。
                if !calls.is_empty() && !calls.iter().any(Value::is_null) {
                    history.tool_calls = Some(
                        calls
                            .iter()
                            .map(|call| HistoryToolCall {
                                id: call.get("id").and_then(Value::as_str).map(str::to_owned),
                                name: call.get("name").and_then(Value::as_str).map(str::to_owned),
                                arguments: call.get("arguments").cloned(),
                            })
                            .collect(),
                    );
                }
            }
            ("tool", Some(raw)) => {
                // 新格式是对象；旧格式是调用数组，旧转换只使用数组第一项。
                let raw = match raw {
                    Value::Array(calls) => calls.into_iter().next(),
                    other => Some(other),
                };
                if let Some(raw) = raw {
                    if let Some(name) = raw.get("name").and_then(Value::as_str) {
                        history.tool_result = Some(HistoryToolResult {
                            tool_name: name.to_owned(),
                            result: Some(message.content.clone()),
                            arguments: raw.get("arguments").cloned(),
                            tool_call_id: raw.get("id").and_then(Value::as_str).map(str::to_owned),
                        });
                    }
                }
            }
            _ => {}
        }
        history
    }
}

impl ConversationDb {
    /// 按快照次序解析消息并构建 LLM 历史，不读取引用之外的消息，不修改数据库。
    ///
    /// 所有数据库读取在同一个事务里完成；id 查询固定限定在当前会话。缺失引用只能
    /// 使用该项明确携带的 fallback，不能改成读取会话最新历史或悄悄删掉这一项。
    pub(crate) fn resolve_llm_history(
        &self,
        conversation_id: &str,
        snapshot: &HistorySnapshot,
    ) -> Result<Vec<LlmMessage>, HistoryError> {
        let mut seen = HashSet::new();
        let ids: Vec<&str> = snapshot
            .entries
            .iter()
            .filter_map(|entry| match entry {
                HistoryEntry::Stored { id, .. } if seen.insert(id.as_str()) => Some(id.as_str()),
                _ => None,
            })
            .collect();

        let stored = match self.read_history_snapshot_rows(conversation_id, &ids) {
            Ok(rows) => rows,
            Err(error) => {
                if snapshot
                    .entries
                    .iter()
                    .any(|entry| matches!(entry, HistoryEntry::Stored { fallback: None, .. }))
                {
                    return Err(error.into());
                }
                // 前端旧路径只读内存；迁移后数据库短暂不可读时仍能沿用已有快照。
                log::warn!("读取上下文历史失败，沿用已有消息快照：{error}");
                HashMap::new()
            }
        };

        let mut messages = Vec::with_capacity(snapshot.entries.len());
        for entry in &snapshot.entries {
            match entry {
                HistoryEntry::Stored {
                    id,
                    reasoning_content,
                    fallback,
                } => {
                    let mut message = match stored.get(id) {
                        Some(row) => HistoryMessage::from_stored(row),
                        None => fallback
                            .as_deref()
                            .cloned()
                            .ok_or_else(|| HistoryError::Missing(id.clone()))?,
                    };
                    if let Some(reasoning_content) = reasoning_content {
                        message.reasoning_content.clone_from(reasoning_content);
                    }
                    messages.push(message);
                }
                HistoryEntry::Transient { message } => messages.push((**message).clone()),
            }
        }
        Ok(project_llm_history(&messages))
    }

    fn read_history_snapshot_rows(
        &self,
        conversation_id: &str,
        ids: &[&str],
    ) -> rusqlite::Result<HashMap<String, StoredMessage>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let mut rows_by_id = HashMap::with_capacity(ids.len());
        // 留出 conversation_id 参数；老 SQLite 的变量上限也能容纳这一批。
        for chunk in ids.chunks(500) {
            let placeholders = (2..chunk.len() + 2)
                .map(|index| format!("?{index}"))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT {} FROM messages WHERE conversation_id = ?1 AND id IN ({placeholders})",
                messages_select_columns()
            );
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&conversation_id];
            params.extend(chunk.iter().map(|id| id as &dyn rusqlite::ToSql));
            let mut stmt = tx.prepare(&sql)?;
            let rows =
                stmt.query_map(rusqlite::params_from_iter(params), Self::map_stored_message)?;
            for row in rows {
                let row = row?;
                rows_by_id.insert(row.id.clone(), row);
            }
        }
        tx.finish()?;
        Ok(rows_by_id)
    }
}

/// 纯投影：迁移原前端 `buildLlmHistory` 的转换顺序与降级，不调整 harness 策略。
pub(crate) fn project_llm_history(messages: &[HistoryMessage]) -> Vec<LlmMessage> {
    let start = messages
        .iter()
        .rposition(|message| {
            message.role == "system"
                && message
                    .compaction
                    .as_ref()
                    .is_some_and(|card| card.status == "done")
        })
        .unwrap_or(0);
    let mut output: Vec<LlmMessage> = Vec::new();
    let mut pending_assistant: Option<usize> = None;
    let mut open_tool_group = false;

    for message in &messages[start..] {
        if message.is_loading {
            continue;
        }
        match message.role.as_str() {
            "system" => {
                if let Some(card) = message
                    .compaction
                    .as_ref()
                    .filter(|card| card.status == "done")
                {
                    if let Some(summary) = card.summary.as_deref().filter(|text| !text.is_empty()) {
                        output.push(LlmMessage::user(format!(
                            "{}\n\n{SUMMARY_OPEN_TAG}\n{summary}\n{SUMMARY_CLOSE_TAG}",
                            checkpoint_preamble()
                        )));
                        // checkpoint 沿既有协议不带 db_id，不能新增 pressure 的可用锚点。
                        pending_assistant = None;
                        open_tool_group = false;
                    }
                }
            }
            "user" | "notice" => {
                let mut item = LlmMessage::user(message.content.clone());
                item.db_id = nonempty(&message.db_id);
                item.image_paths = message
                    .image_paths
                    .clone()
                    .filter(|paths| !paths.is_empty());
                output.push(item);
                pending_assistant = None;
                open_tool_group = false;
            }
            "assistant" => {
                let calls = message
                    .tool_calls
                    .as_ref()
                    .filter(|calls| !calls.is_empty())
                    .map(Vec::as_slice)
                    .or_else(|| message.tool_call.as_ref().map(std::slice::from_ref));
                let mut item = LlmMessage::assistant(message.content.clone());
                item.db_id = nonempty(&message.db_id);
                item.reasoning_content = nonempty(&message.reasoning_content);
                match calls {
                    Some(calls) => {
                        // Some([]) 在这里仍表示“原始记录有调用组，但项都缺少协议字段”。
                        // 后续 tool 可以补入这个组；没有结果时仍要经过闭合裁剪，不能
                        // 提前降成普通 assistant 而改变空正文 / reasoning 的保留行为。
                        item.tool_calls =
                            Some(calls.iter().filter_map(project_tool_call).collect());
                        output.push(item);
                        pending_assistant = None;
                        open_tool_group = true;
                    }
                    None => {
                        output.push(item);
                        pending_assistant = Some(output.len() - 1);
                        open_tool_group = false;
                    }
                }
            }
            "tool" => {
                let Some(result) = message.tool_result.as_ref() else {
                    open_tool_group = false;
                    continue;
                };
                let Some(call_id) = result.tool_call_id.as_deref().filter(|id| !id.is_empty())
                else {
                    open_tool_group = false;
                    continue;
                };
                let call = ToolCall {
                    id: call_id.to_owned(),
                    name: result.tool_name.clone(),
                    arguments: project_arguments(result.arguments.as_ref()),
                };
                if let Some(index) = pending_assistant.take() {
                    // 把第一个结果挂到前导纯文本 assistant；其正文、reasoning 与 id 不动。
                    output[index].tool_calls = Some(vec![call]);
                    open_tool_group = true;
                } else if open_tool_group {
                    for previous in output.iter_mut().rev() {
                        if previous.role == LlmRole::Assistant {
                            if let Some(calls) = previous.tool_calls.as_mut() {
                                if !calls.iter().any(|previous| previous.id == call.id) {
                                    calls.push(call);
                                }
                                break;
                            }
                        }
                        if previous.role == LlmRole::User {
                            break;
                        }
                    }
                } else {
                    let mut assistant = LlmMessage::assistant("");
                    assistant.tool_calls = Some(vec![call]);
                    output.push(assistant);
                    open_tool_group = true;
                }
                let content = result
                    .result
                    .as_deref()
                    .filter(|text| !text.is_empty())
                    .unwrap_or(&message.content);
                let mut item = LlmMessage::assistant(content);
                item.role = LlmRole::Tool;
                item.tool_call_id = Some(call_id.to_owned());
                item.db_id = nonempty(&message.db_id);
                output.push(item);
            }
            _ => open_tool_group = false,
        }
    }

    enforce_tool_protocol(close_tool_call_groups(output))
}

fn nonempty(value: &Option<String>) -> Option<String> {
    value.as_ref().filter(|text| !text.is_empty()).cloned()
}

fn project_tool_call(call: &HistoryToolCall) -> Option<ToolCall> {
    Some(ToolCall {
        id: call.id.clone()?,
        name: call.name.clone()?,
        arguments: project_arguments(call.arguments.as_ref()),
    })
}

fn optional_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Ok(Value::deserialize(deserializer)?
        .as_str()
        .map(str::to_owned))
}

/// serde 的普通 Option 会把缺字段与 null 合并；仅字段出现时包一层 Some，
/// 缺字段由 #[serde(default)] 留成 None，回读时才知道是否真的要求覆盖。
fn reasoning_override<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

/// 原转换使用 `arguments || {}`；保留 JSON 值，不把合法的非对象参数擅自重写。
fn project_arguments(arguments: Option<&Value>) -> Value {
    arguments
        .filter(|value| match value {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(value) => value.as_f64() != Some(0.0),
            Value::String(value) => !value.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        })
        .cloned()
        .unwrap_or_else(|| Value::Object(serde_json::Map::new()))
}

/// ECMAScript trim/trimStart 的空白集合，避免搬到 Rust 后额外吞掉 U+0085 或保留 BOM。
fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0009}'..='\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
            | '\u{feff}'
    )
}

fn settle_tool_group(
    output: &mut Vec<LlmMessage>,
    open: &mut Option<usize>,
    replied: &mut HashSet<String>,
) {
    let Some(index) = open.take() else {
        return;
    };
    let replies = std::mem::take(replied);
    let item = &mut output[index];
    let Some(calls) = item.tool_calls.as_mut() else {
        return;
    };
    calls.retain(|call| replies.contains(&call.id));
    if !calls.is_empty() {
        return;
    }
    if item.content.trim_matches(is_js_whitespace).is_empty() && item.reasoning_content.is_none() {
        output.remove(index);
    } else {
        item.tool_calls = None;
    }
}

fn close_tool_call_groups(messages: Vec<LlmMessage>) -> Vec<LlmMessage> {
    let mut output = Vec::with_capacity(messages.len());
    let mut open: Option<usize> = None;
    let mut replied = HashSet::new();
    for item in messages {
        if item.role == LlmRole::Assistant && item.tool_calls.is_some() {
            settle_tool_group(&mut output, &mut open, &mut replied);
            open = Some(output.len());
            output.push(item);
            continue;
        }
        if item.role == LlmRole::Tool && open.is_some() {
            if let Some(id) = item.tool_call_id.as_ref().filter(|id| !id.is_empty()) {
                replied.insert(id.clone());
            }
        }
        if item.role == LlmRole::User {
            settle_tool_group(&mut output, &mut open, &mut replied);
        }
        output.push(item);
    }
    settle_tool_group(&mut output, &mut open, &mut replied);
    output
}

fn enforce_tool_protocol(messages: Vec<LlmMessage>) -> Vec<LlmMessage> {
    let mut has_open_calls = false;
    messages
        .into_iter()
        .filter(|item| {
            if item.role == LlmRole::Assistant
                && item
                    .tool_calls
                    .as_ref()
                    .is_some_and(|calls| !calls.is_empty())
            {
                has_open_calls = true;
                return true;
            }
            if item.role == LlmRole::Tool
                && item.tool_call_id.as_ref().is_some_and(|id| !id.is_empty())
            {
                return has_open_calls;
            }
            if item.role == LlmRole::Assistant {
                has_open_calls = false;
            }
            true
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::create_test_db;
    use serde_json::json;

    fn snapshot(value: Value) -> HistorySnapshot {
        serde_json::from_value(value).expect("history snapshot")
    }

    fn stored_entry(id: &str) -> Value {
        json!({ "kind": "stored", "id": id, "reasoningContent": null })
    }

    fn save(
        db: &ConversationDb,
        conversation_id: &str,
        role: &str,
        content: &str,
    ) -> StoredMessage {
        db.save_message(
            conversation_id,
            role,
            content,
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("save message")
    }

    #[test]
    fn snapshot_order_is_preserved_and_unreferenced_rows_stay_out() {
        let db = create_test_db();
        let conversation = db.create_conversation("connection", "history").unwrap();
        let first = save(&db, &conversation.id, "user", "first");
        save(&db, &conversation.id, "user", "unseen reminder");
        let last = save(&db, &conversation.id, "user", "last");
        let input = snapshot(json!({
            "entries": [stored_entry(&last.id), stored_entry(&first.id), stored_entry(&last.id)]
        }));
        let output = db.resolve_llm_history(&conversation.id, &input).unwrap();
        assert_eq!(
            output
                .iter()
                .map(|item| item.content.as_str())
                .collect::<Vec<_>>(),
            ["last", "first", "last"]
        );
        assert!(output.iter().all(|item| !item.db_id_known));
        assert_eq!(db.load_messages(&conversation.id).unwrap().len(), 3);
    }

    #[test]
    fn empty_snapshot_does_not_fill_itself_from_the_database() {
        let db = create_test_db();
        let conversation = db.create_conversation("connection", "history").unwrap();
        save(&db, &conversation.id, "user", "keep existing history");
        assert!(db
            .resolve_llm_history(&conversation.id, &HistorySnapshot::default())
            .unwrap()
            .is_empty());
        assert_eq!(db.load_messages(&conversation.id).unwrap().len(), 1);
    }

    #[test]
    fn stored_reference_cannot_read_another_conversation() {
        let db = create_test_db();
        let own = db.create_conversation("connection", "own").unwrap();
        let other = db.create_conversation("connection", "other").unwrap();
        let secret = save(&db, &other.id, "user", "other conversation content");
        let input = snapshot(json!({ "entries": [stored_entry(&secret.id)] }));
        assert!(matches!(
            db.resolve_llm_history(&own.id, &input),
            Err(HistoryError::Missing(id)) if id == secret.id
        ));

        let input = snapshot(json!({ "entries": [{
            "kind": "stored", "id": secret.id, "reasoningContent": null,
            "fallback": { "role": "user", "content": "own snapshot" }
        }] }));
        let output = db.resolve_llm_history(&own.id, &input).unwrap();
        assert_eq!(output[0].content, "own snapshot");
    }

    #[test]
    fn database_content_wins_and_reasoning_override_does_not_modify_storage() {
        let db = create_test_db();
        let conversation = db.create_conversation("connection", "history").unwrap();
        let stored = db
            .save_message(
                &conversation.id,
                "assistant",
                "database original",
                "2026-01-01T00:00:00Z",
                None,
                Some("stored reasoning"),
            )
            .unwrap();
        let input = snapshot(json!({ "entries": [{
            "kind": "stored", "id": stored.id, "reasoningContent": null,
            "fallback": { "role": "assistant", "content": "stale fallback", "reasoningContent": "old" }
        }] }));
        let output = db.resolve_llm_history(&conversation.id, &input).unwrap();
        assert_eq!(output[0].content, "database original");
        assert!(output[0].reasoning_content.is_none());
        assert_eq!(output[0].db_id.as_deref(), Some(stored.id.as_str()));
        assert_eq!(
            db.load_messages(&conversation.id).unwrap()[0]
                .reasoning_content
                .as_deref(),
            Some("stored reasoning")
        );
    }

    #[test]
    fn stored_reasoning_override_distinguishes_omission_clear_and_replace() {
        let db = create_test_db();
        let conversation = db.create_conversation("connection", "history").unwrap();
        let stored = db
            .save_message(
                &conversation.id,
                "assistant",
                "database original",
                "2026-01-01T00:00:00Z",
                None,
                Some("stored reasoning"),
            )
            .unwrap();
        let before = serde_json::to_value(db.load_messages(&conversation.id).unwrap()).unwrap();
        for (override_value, expected) in [
            (None, Some("stored reasoning")),
            (Some(Value::Null), None),
            (
                Some(json!("replacement reasoning")),
                Some("replacement reasoning"),
            ),
        ] {
            let mut entry = json!({ "kind": "stored", "id": stored.id });
            if let Some(value) = override_value {
                entry["reasoningContent"] = value;
            }
            let input = snapshot(json!({ "entries": [entry.clone()] }));
            let roundtrip = serde_json::to_value(&input).unwrap();
            assert_eq!(
                roundtrip["entries"][0].get("reasoningContent"),
                entry.get("reasoningContent")
            );
            let output = db.resolve_llm_history(&conversation.id, &input).unwrap();
            assert_eq!(output[0].content, "database original");
            assert_eq!(output[0].reasoning_content.as_deref(), expected);
            assert_eq!(
                serde_json::to_value(db.load_messages(&conversation.id).unwrap()).unwrap(),
                before
            );
        }
    }

    #[test]
    fn fallback_reasoning_override_distinguishes_omission_clear_and_replace() {
        let db = create_test_db();
        let conversation = db.create_conversation("connection", "history").unwrap();
        for (override_value, expected) in [
            (None, Some("fallback reasoning")),
            (Some(Value::Null), None),
            (
                Some(json!("replacement reasoning")),
                Some("replacement reasoning"),
            ),
        ] {
            let mut entry = json!({
                "kind": "stored", "id": "missing",
                "fallback": {
                    "role": "assistant", "content": "fallback original",
                    "reasoningContent": "fallback reasoning"
                }
            });
            if let Some(value) = override_value {
                entry["reasoningContent"] = value;
            }
            let input = snapshot(json!({ "entries": [entry] }));
            let before = serde_json::to_value(&input).unwrap();
            let output = db.resolve_llm_history(&conversation.id, &input).unwrap();
            assert_eq!(output[0].content, "fallback original");
            assert_eq!(output[0].reasoning_content.as_deref(), expected);
            assert_eq!(serde_json::to_value(&input).unwrap(), before);
            assert!(db.load_messages(&conversation.id).unwrap().is_empty());
        }
    }

    #[test]
    fn missing_row_uses_the_existing_fallback_without_inserting_a_row() {
        let db = create_test_db();
        let conversation = db.create_conversation("connection", "history").unwrap();
        let input = snapshot(json!({ "entries": [{
            "kind": "stored", "id": "missing", "reasoningContent": null,
            "fallback": { "role": "user", "content": "still visible", "dbId": "missing" }
        }] }));
        let output = db.resolve_llm_history(&conversation.id, &input).unwrap();
        assert_eq!(output[0].content, "still visible");
        assert_eq!(output[0].db_id.as_deref(), Some("missing"));
        assert!(db.load_messages(&conversation.id).unwrap().is_empty());
    }

    #[test]
    fn read_failure_uses_fallback_only_when_every_reference_has_one() {
        let db = create_test_db();
        db.conn
            .lock()
            .unwrap()
            .execute("DROP TABLE messages", [])
            .unwrap();
        let input = snapshot(json!({ "entries": [{
            "kind": "stored", "id": "missing", "reasoningContent": null,
            "fallback": { "role": "user", "content": "keep the in-memory conversation" }
        }] }));
        let output = db.resolve_llm_history("conversation", &input).unwrap();
        assert_eq!(output[0].content, "keep the in-memory conversation");
        assert!(matches!(
            db.resolve_llm_history(
                "conversation",
                &snapshot(json!({ "entries": [stored_entry("missing")] }))
            ),
            Err(HistoryError::Db(_))
        ));
    }

    #[test]
    fn stored_references_are_batched_without_reordering() {
        let db = create_test_db();
        let conversation = db.create_conversation("connection", "history").unwrap();
        let mut entries = Vec::new();
        for index in 0..520 {
            let row = save(&db, &conversation.id, "user", &format!("message {index}"));
            entries.push(stored_entry(&row.id));
        }
        entries.reverse();
        let input = snapshot(json!({ "entries": entries }));
        let output = db.resolve_llm_history(&conversation.id, &input).unwrap();
        assert_eq!(output.len(), 520);
        for (index, item) in output.iter().enumerate() {
            assert_eq!(item.content, format!("message {}", 519 - index));
        }
    }

    fn assert_closed_protocol(messages: &[LlmMessage]) {
        let mut pending = HashSet::new();
        for message in messages {
            match message.role {
                LlmRole::Assistant => {
                    assert!(
                        pending.is_empty(),
                        "unanswered calls before assistant: {pending:?}"
                    );
                    pending = message
                        .tool_calls
                        .iter()
                        .flatten()
                        .map(|call| call.id.clone())
                        .collect();
                }
                LlmRole::Tool => {
                    let id = message.tool_call_id.as_ref().expect("result call id");
                    assert!(pending.remove(id), "result without an open call: {id}");
                }
                _ => assert!(
                    pending.is_empty(),
                    "unanswered calls at turn boundary: {pending:?}"
                ),
            }
        }
        assert!(pending.is_empty(), "unanswered calls at end: {pending:?}");
    }

    /// 对生产投影做组合属性检验；覆盖调用顺序与完成顺序不同、任意已完成子集、
    /// 用户中断、无正文 / 仅 reasoning、旧工具行等，不复制投影算法充当测试对象。
    #[test]
    fn interrupted_and_parallel_histories_keep_a_closed_protocol() {
        let mut cases = 0;
        for count in 1..=4 {
            for replied_mask in 0..(1 << count) {
                for text_kind in 0..3 {
                    for reverse_results in [false, true] {
                        let mut input = vec![json!({ "role": "user", "content": "begin" })];
                        let calls: Vec<Value> = (0..count)
                            .map(|index| {
                                json!({
                                    "id": format!("call-{index}"),
                                    "name": "read_file",
                                    "arguments": { "path": format!("/tmp/{index}") }
                                })
                            })
                            .collect();
                        input.push(json!({
                            "role": "assistant",
                            "content": if text_kind == 0 { "working" } else { "" },
                            "reasoningContent": if text_kind == 2 { Some("keep reasoning") } else { None },
                            "toolCalls": calls,
                            "dbId": "assistant-row"
                        }));
                        let mut completed: Vec<usize> = (0..count)
                            .filter(|index| replied_mask & (1 << index) != 0)
                            .collect();
                        if reverse_results {
                            completed.reverse();
                        }
                        for index in &completed {
                            input.push(json!({
                                "role": "tool", "content": "",
                                "toolResult": {
                                    "toolName": "read_file", "toolCallId": format!("call-{index}"),
                                    "result": format!("output {index}")
                                }
                            }));
                        }
                        input
                            .push(json!({ "role": "tool", "content": "legacy without a call id" }));
                        input.push(json!({ "role": "user", "content": "continue" }));
                        let messages: Vec<HistoryMessage> =
                            serde_json::from_value(json!(input)).unwrap();
                        let before = serde_json::to_value(&messages).unwrap();
                        let output = project_llm_history(&messages);
                        assert_closed_protocol(&output);
                        assert_eq!(serde_json::to_value(&messages).unwrap(), before);
                        assert_eq!(output.first().unwrap().content, "begin");
                        assert_eq!(output.last().unwrap().content, "continue");
                        let projected_calls: Vec<&str> = output
                            .iter()
                            .filter_map(|item| item.tool_calls.as_ref())
                            .flatten()
                            .map(|call| call.id.as_str())
                            .collect();
                        let expected: Vec<String> = (0..count)
                            .filter(|index| replied_mask & (1 << index) != 0)
                            .map(|index| format!("call-{index}"))
                            .collect();
                        assert_eq!(
                            projected_calls,
                            expected.iter().map(String::as_str).collect::<Vec<_>>()
                        );
                        if text_kind == 2 {
                            assert!(output
                                .iter()
                                .any(|item| item.reasoning_content.as_deref()
                                    == Some("keep reasoning")));
                        }
                        cases += 1;
                    }
                }
            }
        }
        assert!(cases >= 180);
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct ProjectionFixture {
        name: String,
        snapshot: HistorySnapshot,
        stored_messages: Vec<StoredMessage>,
        expected: Value,
    }

    /// 期望值由迁移前的真实前端转换生成；同一夹具还由前端测试验证。
    #[test]
    fn shared_fixtures_match_the_legacy_frontend_projection() {
        let fixture_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/llm_history.json");
        let fixtures: Vec<ProjectionFixture> = serde_json::from_str(
            &std::fs::read_to_string(fixture_path).expect("shared history fixtures"),
        )
        .expect("history fixtures JSON");
        assert!(!fixtures.is_empty());
        for mut fixture in fixtures {
            let db = create_test_db();
            let conversation = db.create_conversation("connection", &fixture.name).unwrap();
            for row in &mut fixture.stored_messages {
                row.conversation_id.clone_from(&conversation.id);
            }
            db.replace_messages(&conversation.id, &fixture.stored_messages)
                .expect("seed fixture rows");
            let output = db
                .resolve_llm_history(&conversation.id, &fixture.snapshot)
                .unwrap_or_else(|error| panic!("{}: {error}", fixture.name));
            assert_eq!(
                serde_json::to_value(output).unwrap(),
                fixture.expected,
                "fixture: {}",
                fixture.name
            );
            let stored_after = db.load_messages(&conversation.id).unwrap();
            assert_eq!(
                stored_after.len(),
                fixture.stored_messages.len(),
                "{}",
                fixture.name
            );
        }
    }
}
