// 跨会话回忆（长期记忆用）：按机器检索历史会话、列出最近活跃的主会话。
//
// 与 `history.rs` 的分工：那边是**本会话族之内**的回读（agent 读自己的过去、子代理
// 读父会话），这里是**同一台机器的其它会话**——「上次在这台机器上改过什么」。
// 范围由调用方（`memory_recall` 工具 / 整理助手）按连接 id 圈定，这里不做权限判断。

use chrono::{DateTime, Utc};
use rusqlite::{params_from_iter, Result as RusqliteResult};
use serde::{Deserialize, Serialize};

use super::{escape_like, ConversationDb};
use crate::agent::conversation_persister::COMPACTION_CARD_PREFIX;

/// 一条跨会话检索命中。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallHit {
    pub conversation_id: String,
    pub conversation_title: String,
    pub connection_id: String,
    pub message_id: String,
    pub role: String,
    pub created_at: String,
    /// 命中处前后的片段（按字符截取）。
    pub snippet: String,
}

/// 一个主会话的概要（启动补复盘、整理助手列会话用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RootConversationBrief {
    pub id: String,
    pub connection_id: String,
    pub title: String,
    pub updated_at: String,
}

/// 片段半径（字符）。
const SNIPPET_RADIUS: usize = 120;

fn snippet_around(text: &str, terms: &[String]) -> String {
    let chars: Vec<char> = text.chars().collect();
    let lower: String = text.to_lowercase();
    // 找第一个命中的词，按字符位置截取。
    let pos_chars = terms
        .iter()
        .filter_map(|t| lower.find(t.as_str()))
        .min()
        .map(|byte_pos| lower[..byte_pos].chars().count())
        .unwrap_or(0);
    let start = pos_chars.saturating_sub(SNIPPET_RADIUS);
    let end = (pos_chars + SNIPPET_RADIUS).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s.insert(0, '…');
    }
    if end < chars.len() {
        s.push('…');
    }
    s.replace('\n', " ")
}

impl ConversationDb {
    /// 在若干连接的**主会话**里按关键词检索（每个词都要命中，大小写不敏感）。
    ///
    /// 只看 user / assistant 行：用户说过的话、agent 的结论，以及 agent 执行过的命令
    /// （在 assistant 行的 `tool_calls_json` 里）。工具输出不搜——又长又吵，命中了
    /// 也读不出结论；要看原始输出，拿命中的消息 id 去读它前后的消息。压缩卡不搜。
    pub fn search_connections_history(
        &self,
        connection_ids: &[String],
        terms: &[String],
        exclude_conversation_id: Option<&str>,
        limit: usize,
    ) -> RusqliteResult<Vec<RecallHit>> {
        if connection_ids.is_empty() || terms.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let terms: Vec<String> = terms.iter().map(|t| t.to_lowercase()).collect();
        let conn_placeholders = connection_ids
            .iter()
            .map(|_| "?")
            .collect::<Vec<_>>()
            .join(",");
        let term_clauses = terms
            .iter()
            .map(|_| {
                "(m.content || ' ' || COALESCE(m.tool_calls_json, '')) LIKE ? ESCAPE '\\' COLLATE NOCASE"
            })
            .collect::<Vec<_>>()
            .join(" AND ");
        let sql = format!(
            "SELECT m.id, m.role, m.content, m.tool_calls_json, m.created_at, c.id, c.title, c.connection_id
             FROM messages m
             INNER JOIN conversations c ON c.id = m.conversation_id
             WHERE c.connection_id IN ({conn_placeholders})
               AND c.parent_conversation_id IS NULL
               -- 归档会话退出长期回忆：agent 不该把「用户已经收起来的东西」
               -- 重新翻出来当成最近上下文。
               AND c.archived_at IS NULL
               AND c.id != ?
               AND m.role IN ('user', 'assistant')
               AND m.content NOT LIKE ? ESCAPE '\\'
               AND {term_clauses}
             ORDER BY m.created_at DESC, m.rowid DESC
             LIMIT ?"
        );
        let mut binds: Vec<String> = connection_ids.to_vec();
        binds.push(exclude_conversation_id.unwrap_or("").to_string());
        binds.push(format!("{}%", escape_like(COMPACTION_CARD_PREFIX)));
        for t in &terms {
            binds.push(format!("%{}%", escape_like(t)));
        }
        binds.push(limit.to_string());

        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
            let content: String = row.get(2)?;
            let tool_calls: Option<String> = row.get(3)?;
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                content,
                tool_calls,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (id, role, content, tool_calls, created_at, conv_id, title, conn_id) = r?;
            let hay = match &tool_calls {
                Some(tc) if !tc.is_empty() => format!("{content}\n{tc}"),
                _ => content,
            };
            out.push(RecallHit {
                conversation_id: conv_id,
                conversation_title: title,
                connection_id: conn_id,
                message_id: id,
                role,
                created_at,
                snippet: snippet_around(&hay, &terms),
            });
        }
        Ok(out)
    }

    /// 最近有活动的主会话（不含子对话），新→旧。
    pub fn recent_root_conversations(
        &self,
        since: DateTime<Utc>,
        connection_ids: Option<&[String]>,
        limit: usize,
    ) -> RusqliteResult<Vec<RootConversationBrief>> {
        let conn = self.conn.lock().unwrap();
        let mut binds: Vec<String> = vec![since.to_rfc3339()];
        let conn_filter = match connection_ids {
            Some(ids) if !ids.is_empty() => {
                binds.extend(ids.iter().cloned());
                format!(
                    "AND connection_id IN ({})",
                    ids.iter().map(|_| "?").collect::<Vec<_>>().join(",")
                )
            }
            Some(_) => return Ok(Vec::new()),
            None => String::new(),
        };
        binds.push(limit.to_string());
        let sql = format!(
            "SELECT id, connection_id, title, updated_at FROM conversations
             WHERE parent_conversation_id IS NULL AND archived_at IS NULL
               AND updated_at >= ? {conn_filter}
             ORDER BY updated_at DESC LIMIT ?"
        );
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(binds.iter()), |row| {
            Ok(RootConversationBrief {
                id: row.get(0)?,
                connection_id: row.get(1)?,
                title: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })?;
        rows.collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::create_test_db;

    #[test]
    fn searches_only_given_connections_and_skips_tool_rows_and_current() {
        let db = create_test_db();
        let a = db.create_conversation("conn_a", "A").unwrap();
        let a2 = db.create_conversation("conn_a", "A2").unwrap();
        let b = db.create_conversation("conn_b", "B").unwrap();
        db.save_message(&a.id, "user", "nginx 配置在哪", "t", None, None)
            .unwrap();
        db.save_message(&a.id, "tool", "nginx tool output", "t", None, None)
            .unwrap();
        db.save_message(&a.id, "assistant", "在 /opt/nginx/conf", "t", None, None)
            .unwrap();
        db.save_message(&a2.id, "user", "nginx 当前会话", "t", None, None)
            .unwrap();
        db.save_message(&b.id, "user", "nginx 在别的机器", "t", None, None)
            .unwrap();

        let hits = db
            .search_connections_history(&["conn_a".into()], &["NGINX".into()], Some(&a2.id), 10)
            .unwrap();
        // conn_a 的另一个会话里的 user / assistant 两行都命中；工具输出行、当前会话、
        // 别的机器都不在结果里。
        assert_eq!(hits.len(), 2, "{hits:?}");
        assert!(hits.iter().all(|h| h.conversation_id == a.id));
        assert!(hits.iter().all(|h| h.role != "tool"));

        let both = db
            .search_connections_history(
                &["conn_a".into()],
                &["nginx".into(), "opt".into()],
                None,
                10,
            )
            .unwrap();
        assert_eq!(both.len(), 1, "每个词都要命中");
        assert_eq!(both[0].role, "assistant");
    }

    #[test]
    fn snippet_is_centered_on_hit() {
        let text = format!("{}关键{}", "前".repeat(300), "后".repeat(300));
        let s = snippet_around(&text, &["关键".to_string()]);
        assert!(s.contains("关键"));
        assert!(s.starts_with('…') && s.ends_with('…'));
        assert!(s.chars().count() <= SNIPPET_RADIUS * 2 + 2);
    }

    #[test]
    fn recent_root_conversations_filters_by_time_and_connection() {
        let db = create_test_db();
        let a = db.create_conversation("conn_a", "A").unwrap();
        db.create_sub_conversation("conn_a", "sub", &a.id).ok();
        db.create_conversation("conn_b", "B").unwrap();
        let since = Utc::now() - chrono::Duration::days(1);
        assert_eq!(
            db.recent_root_conversations(since, None, 10).unwrap().len(),
            2
        );
        let only_a = db
            .recent_root_conversations(since, Some(&["conn_a".to_string()]), 10)
            .unwrap();
        assert_eq!(only_a.len(), 1);
        assert_eq!(only_a[0].id, a.id);
        let future = Utc::now() + chrono::Duration::days(1);
        assert!(db
            .recent_root_conversations(future, None, 10)
            .unwrap()
            .is_empty());
    }
}
