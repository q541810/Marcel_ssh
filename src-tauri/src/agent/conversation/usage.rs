// 会话级 token 用量：累计口径、最近一次请求的上下文快照、与「本会话 + 直接子对话」
// 的界面读数口径。落库在 `conversations.usage_json`（见 `ConversationUsage`）。
use rusqlite::{Connection, OptionalExtension, Result as RusqliteResult};
use serde::{Deserialize, Serialize};

/// 最近一次 LLM 请求的上下文快照（`ConversationUsage.last_context`）。
///
/// 与占用环一一对应：`used_tokens` 是那次请求的 prompt 总量，
/// `estimated = true` 表示 provider 没返回用量、这三个数是本地估算（chars/4），
/// 前端据此加 `~` 前缀。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LastContext {
    pub used_tokens: u64,
    pub estimated: bool,
    pub system_tokens: u64,
    pub tools_tokens: u64,
    pub message_tokens: u64,
}

/// 界面读数：**本会话那一行 + 各直接子对话的累计**（「含子 agent」口径）。
///
/// 为什么求和放在后端：会话列表**过滤掉**子对话（`filter_sub_conversations`），
/// 前端手里根本没有子对话那几行；而发往前端的事件与列表读数必须是同一个数字
/// （事件是覆盖语义，不是累加），所以两条路都得走这一个函数。
///
/// `last_context` **只取本会话自己的**：占用环讲的是本会话的上下文，
/// 子 agent 有它自己的窗口，把它并进来就是另一个数了。
///
/// 子 agent 不会再派发子 agent（`subagent` 工具不给子任务注册），
/// 所以一层直接子对话就够了，不需要递归。
fn sum_with_sub_conversations(
    conn: &Connection,
    conversation_id: &str,
) -> RusqliteResult<ConversationUsage> {
    let own_raw: Option<Option<String>> = conn
        .query_row(
            "SELECT usage_json FROM conversations WHERE id = ?1",
            [conversation_id],
            |row| row.get(0),
        )
        .optional()?;
    // 会话行不存在：空用量（调用方一般会当成「没有数据」而不是 0）
    let Some(own_raw) = own_raw else {
        return Ok(ConversationUsage::default());
    };

    let own = ConversationUsage::from_json_column(own_raw);
    let mut total = ConversationUsage {
        prompt_tokens: own.prompt_tokens,
        completion_tokens: own.completion_tokens,
        total_tokens: own.total_tokens,
        reasoning_tokens: own.reasoning_tokens,
        cached_read_tokens: own.cached_read_tokens,
        last_context: own.last_context,
    };

    let mut stmt =
        conn.prepare("SELECT usage_json FROM conversations WHERE parent_conversation_id = ?1")?;
    let mut rows = stmt.query_map([conversation_id], |row| row.get::<_, Option<String>>(0))?;
    while let Some(child_raw) = rows.next() {
        let child = ConversationUsage::from_json_column(child_raw?);
        total.prompt_tokens += child.prompt_tokens;
        total.completion_tokens += child.completion_tokens;
        total.total_tokens += child.total_tokens;
        if let Some(v) = child.reasoning_tokens {
            *total.reasoning_tokens.get_or_insert(0) += v;
        }
        if let Some(v) = child.cached_read_tokens {
            *total.cached_read_tokens.get_or_insert(0) += v;
        }
    }

    Ok(total)
}

/// 会话级 token 用量（落库在 `conversations.usage_json`）。
///
/// 两套口径各占一半，别混着读：
/// - 前五项是**累计**：本会话每一次 LLM 请求之和（所有任务、所有工具轮次）。
///   子 agent 有它自己那一行，父会话**不重复计入**——前端的「含子 agent」
///   是把父行与各子行相加得到的。
/// - `last_context` 是**最近一次请求**的上下文快照，供占用环使用。
///
/// **窗口不在这里**：窗口由配置派生（模型级 → 全局），存进库会在用户改设置后
/// 说谎。窗口由会话读时 overlay（`commands::agent_conversation`）实时给出。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConversationUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    /// `None` = 该渠道从未报过这个字段（与 0 区分：0 是「报了，是 0」）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_tokens: Option<u64>,
    /// 同上（OpenAI 兼容协议的 `prompt_tokens_details.cached_tokens`）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_read_tokens: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_context: Option<LastContext>,
}

impl ConversationUsage {
    /// 整块为空（从未记过任何用量）：老会话、还没跑过请求的会话。
    /// 返回 `true` 时不给前端发这个字段，让「没数据」与「0 token」在界面上区分开。
    pub fn is_empty(&self) -> bool {
        self.prompt_tokens == 0
            && self.completion_tokens == 0
            && self.total_tokens == 0
            && self.reasoning_tokens.is_none()
            && self.cached_read_tokens.is_none()
            && self.last_context.is_none()
    }

    /// 累加一轮请求的用量。可选字段保持「从未有值则仍是 None」语义：
    /// 一半的渠道报了缓存读取、另一半没报，混在一起显示会让人以为后者是 0。
    pub fn add_round(&mut self, round: &crate::llm::provider::TokenUsage) {
        self.prompt_tokens += round.prompt_tokens as u64;
        self.completion_tokens += round.completion_tokens as u64;
        self.total_tokens += round.total_tokens as u64;
        if let Some(v) = round.reasoning_tokens {
            *self.reasoning_tokens.get_or_insert(0) += v as u64;
        }
        if let Some(v) = round.cached_read_tokens {
            *self.cached_read_tokens.get_or_insert(0) += v as u64;
        }
    }

    /// 把 `usage_json` 列读成结构。**缺失 / 空串 / 损坏 / 形状不符**一律回落
    /// 到「整块为空」——老数据与脏数据都不该让会话打不开，也不该伪造出一个 0。
    pub fn from_json_column(raw: Option<String>) -> Self {
        let Some(raw) = raw else {
            return Self::default();
        };
        if raw.trim().is_empty() {
            return Self::default();
        }
        serde_json::from_str(&raw).unwrap_or_default()
    }
}

use super::ConversationDb;

impl ConversationDb {
    /// 界面读数：本会话 + 各子对话的累计用量（见
    /// [`sum_with_sub_conversations`]）。读会话命令的 overlay 用它覆盖
    /// `Conversation::usage`，与事件里带的数字同源。
    pub fn usage_with_sub_conversations(
        &self,
        conversation_id: &str,
    ) -> RusqliteResult<ConversationUsage> {
        let conn = self.conn.lock().unwrap();
        sum_with_sub_conversations(&conn, conversation_id)
    }

    /// 记一轮 LLM 请求的用量：累计值加上这一轮，并用这一轮的上下文快照覆盖
    /// `last_context`。返回**写后**的整块用量（事件与落库共用同一个数字，
    /// 前端只覆盖不累加，重启后读到的也是它）。
    ///
    /// `round` 为 `None` = provider 这一轮**没报用量**：累计值原样不动，只更新
    /// 上下文快照（快照的 `used_tokens` 由调用方给出本地估算）。别把它当成 0
    /// 累加 —— 那会把「不知道」写成「这轮没花」。
    ///
    /// 读-改-写在同一把锁内完成（并发任务/子 agent 都在写各自的会话行，
    /// 同一行的两次写不会交错丢更新）。调用是同步的，**不要**把它跨 await 持有。
    ///
    /// 刻意**不更新 `updated_at`**：用量不是内容变更，顺手 touch 会让对话在
    /// 日期分组里乱跳（同 `set_conversation_pinned`）。
    ///
    /// 会话行不存在（已被删除）时返回 `None`，不新建行。
    pub fn record_usage(
        &self,
        conversation_id: &str,
        round: Option<&crate::llm::provider::TokenUsage>,
        last: LastContext,
    ) -> RusqliteResult<Option<ConversationUsage>> {
        let conn = self.conn.lock().unwrap();

        // `query_row(...).optional()` 三层含义：外层 None = 行不存在；
        // 内层 None = 列是 NULL（老行 / 第一次记）。
        let raw: Option<String> = match conn
            .query_row(
                "SELECT usage_json FROM conversations WHERE id = ?1",
                [conversation_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
        {
            None => return Ok(None),
            Some(v) => v,
        };

        let mut usage = ConversationUsage::from_json_column(raw);
        if let Some(round) = round {
            usage.add_round(round);
        }
        usage.last_context = Some(last);

        let json = serde_json::to_string(&usage).unwrap_or_default();
        conn.execute(
            "UPDATE conversations SET usage_json = ?1 WHERE id = ?2",
            (&json, conversation_id),
        )?;

        // 返回界面读数（含子对话）而不是刚写的那一行：事件带的是这个数字。
        sum_with_sub_conversations(&conn, conversation_id).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::create_test_db;
    use crate::agent::conversation::Conversation;
    use chrono::Utc;

    /// 用量累计：多轮相加、可选字段「从未报过就保持 None」、
    /// 最近一次请求的快照被后一轮覆盖。
    #[test]
    fn test_record_usage_accumulates_rounds() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "A").expect("conv");

        let round1 = crate::llm::provider::TokenUsage {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
            reasoning_tokens: Some(4),
            cached_read_tokens: None,
        };
        let snapshot = |used: u64| LastContext {
            used_tokens: used,
            estimated: false,
            system_tokens: 1,
            tools_tokens: 2,
            message_tokens: used.saturating_sub(3),
        };
        let after1 = db
            .record_usage(&conv.id, Some(&round1), snapshot(100))
            .expect("record 1")
            .expect("row exists");
        assert_eq!(after1.prompt_tokens, 100);
        assert_eq!(after1.reasoning_tokens, Some(4));
        assert!(
            after1.cached_read_tokens.is_none(),
            "没报过就是 None，不是 0"
        );
        assert_eq!(after1.last_context.map(|c| c.used_tokens), Some(100));

        let round2 = crate::llm::provider::TokenUsage {
            prompt_tokens: 250,
            completion_tokens: 30,
            total_tokens: 280,
            reasoning_tokens: Some(6),
            cached_read_tokens: Some(200),
        };
        let after2 = db
            .record_usage(&conv.id, Some(&round2), snapshot(250))
            .expect("record 2")
            .expect("row exists");
        assert_eq!(after2.prompt_tokens, 350);
        assert_eq!(after2.completion_tokens, 40);
        assert_eq!(after2.total_tokens, 390);
        assert_eq!(after2.reasoning_tokens, Some(10));
        assert_eq!(after2.cached_read_tokens, Some(200));
        assert_eq!(
            after2.last_context.map(|c| c.used_tokens),
            Some(250),
            "快照是最近一次，不是累加"
        );

        // 读回来与返回值一致（事件与落库共用一个数字）
        let loaded = db.get_conversation(&conv.id).expect("get").expect("exists");
        assert_eq!(loaded.usage, after2);
    }

    /// 会话行不存在时返回 None（不新建行）；损坏的 `usage_json` 不容错崩
    /// —— 从空用量重新开始，历史消息不受影响。
    #[test]
    fn test_record_usage_ghost_row_and_corrupt_json() {
        let db = create_test_db();
        let round = crate::llm::provider::TokenUsage {
            prompt_tokens: 5,
            completion_tokens: 1,
            total_tokens: 6,
            ..Default::default()
        };
        let last = LastContext {
            used_tokens: 5,
            estimated: true,
            system_tokens: 0,
            tools_tokens: 0,
            message_tokens: 5,
        };
        assert!(db
            .record_usage("no-such-conv", Some(&round), last)
            .expect("ghost must not error")
            .is_none());

        let conv = db.create_conversation("conn_1", "A").expect("conv");
        {
            // 手工写坏这一列（模拟旧版本/半截写）
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE conversations SET usage_json = '{\"promptTokens\": ' WHERE id = ?1",
                [&conv.id],
            )
            .unwrap();
        }
        let recovered = db
            .record_usage(&conv.id, Some(&round), last)
            .expect("corrupt must not error")
            .expect("row exists");
        assert_eq!(recovered.prompt_tokens, 5, "损坏后从空用量重新累计");
    }

    /// provider 没报用量（`None`）的轮次：累计值原样不动，只刷新上下文快照
    /// —— 「不知道」不能被写成 0，否则界面会告诉你这一轮没花 token。
    #[test]
    fn test_record_usage_without_round_usage_keeps_totals() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "A").expect("conv");
        let round = crate::llm::provider::TokenUsage {
            prompt_tokens: 40,
            completion_tokens: 4,
            total_tokens: 44,
            ..Default::default()
        };
        db.record_usage(
            &conv.id,
            Some(&round),
            LastContext {
                used_tokens: 40,
                ..Default::default()
            },
        )
        .expect("record")
        .expect("row exists");

        let after = db
            .record_usage(
                &conv.id,
                None,
                LastContext {
                    used_tokens: 77,
                    estimated: true,
                    system_tokens: 7,
                    tools_tokens: 0,
                    message_tokens: 70,
                },
            )
            .expect("record none")
            .expect("row exists");
        assert_eq!(after.prompt_tokens, 40, "累计不因缺用量而变");
        assert_eq!(after.total_tokens, 44);
        let last = after.last_context.expect("快照必须被刷新");
        assert_eq!(last.used_tokens, 77);
        assert!(last.estimated);
    }

    /// 记用量**不动 `updated_at`**：它不是内容变更，顺手 touch 会让对话在
    /// 日期分组里乱跳（同 `set_conversation_pinned`）。
    #[test]
    fn test_record_usage_keeps_updated_at() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "A").expect("conv");
        let before = conv.updated_at;

        db.record_usage(
            &conv.id,
            Some(&crate::llm::provider::TokenUsage {
                prompt_tokens: 10,
                completion_tokens: 1,
                total_tokens: 11,
                ..Default::default()
            }),
            LastContext {
                used_tokens: 10,
                ..Default::default()
            },
        )
        .expect("record");

        let after = db.get_conversation(&conv.id).expect("get").expect("exists");
        assert_eq!(after.updated_at, before);
    }

    /// 用量块的线上/落库形状：camelCase 字段名 + 空块整块不出现。
    /// 前端按 `promptTokens` / `lastContext.usedTokens` 读，改名字这里会红。
    #[test]
    fn test_usage_json_shape_is_camel_case() {
        let mut usage = ConversationUsage::default();
        usage.add_round(&crate::llm::provider::TokenUsage {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
            reasoning_tokens: Some(2),
            cached_read_tokens: None,
        });
        usage.last_context = Some(LastContext {
            used_tokens: 3,
            estimated: true,
            system_tokens: 1,
            tools_tokens: 0,
            message_tokens: 2,
        });
        let v = serde_json::to_value(&usage).expect("serialize");
        assert_eq!(v["promptTokens"], 3);
        assert_eq!(v["completionTokens"], 1);
        assert_eq!(v["totalTokens"], 4);
        assert_eq!(v["reasoningTokens"], 2);
        assert!(
            v.get("cachedReadTokens").is_none(),
            "从未报过的可选字段不该出现在线上"
        );
        assert_eq!(v["lastContext"]["usedTokens"], 3);
        assert_eq!(v["lastContext"]["estimated"], true);
        assert_eq!(v["lastContext"]["toolsTokens"], 0);
        assert!(v["lastContext"]["messageTokens"].is_number());

        // 空块：整体不出现在会话 JSON 里（前端据此区分「没数据」与「0 token」）
        let conv = Conversation {
            id: "c".into(),
            connection_id: "conn".into(),
            title: "t".into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
            parent_conversation_id: None,
            model_id: None,
            reasoning_effort: None,
            pinned: false,
            usage: ConversationUsage::default(),
            context_window: None,
        };
        let conv_v = serde_json::to_value(&conv).expect("serialize conv");
        assert!(conv_v.get("usage").is_none(), "空用量不该发给前端");

        let with_usage = Conversation { usage, ..conv };
        let conv_v = serde_json::to_value(&with_usage).expect("serialize conv");
        assert_eq!(conv_v["usage"]["promptTokens"], 3);
    }

    /// 两套口径各就各位：行上是**本行自己**的累计（写路径只写本行，父子不重不漏），
    /// 界面读数是**本会话 + 子对话**之和；占用快照只取本会话自己的。
    #[test]
    fn test_usage_summing_includes_sub_conversations_but_snapshot_is_own() {
        let db = create_test_db();
        let parent = db.create_conversation("conn_1", "Parent").expect("parent");
        let child = db
            .create_sub_conversation("conn_1", "Sub（子agent）", &parent.id)
            .expect("child");
        let round = |n: u32| crate::llm::provider::TokenUsage {
            prompt_tokens: n,
            completion_tokens: n / 10,
            total_tokens: n + n / 10,
            ..Default::default()
        };
        let last = |used: u64| LastContext {
            used_tokens: used,
            estimated: false,
            system_tokens: 1,
            tools_tokens: 2,
            message_tokens: used.saturating_sub(3),
        };

        db.record_usage(&parent.id, Some(&round(1000)), last(900))
            .expect("parent round")
            .expect("exists");
        db.record_usage(&child.id, Some(&round(500)), last(400))
            .expect("child round")
            .expect("exists");

        // 行上：各记自己的（子 agent 的一轮只落在子对话行上）
        let parent_row = db
            .get_conversation(&parent.id)
            .expect("get")
            .expect("exists");
        assert_eq!(parent_row.usage.prompt_tokens, 1000);
        let child_row = db
            .get_conversation(&child.id)
            .expect("get")
            .expect("exists");
        assert_eq!(child_row.usage.prompt_tokens, 500);

        // 界面读数：父子相加
        let read = db
            .usage_with_sub_conversations(&parent.id)
            .expect("sum usage");
        assert_eq!(read.prompt_tokens, 1500);
        assert_eq!(read.total_tokens, 1100 + 550);
        assert_eq!(
            read.last_context.map(|c| c.used_tokens),
            Some(900),
            "占用快照只取本会话自己的（子 agent 有自己的窗口）"
        );

        // 父会话再记一轮：事件返回的也是同一个含子对话的读数
        let next = db
            .record_usage(&parent.id, Some(&round(100)), last(1000))
            .expect("parent round 2")
            .expect("exists");
        assert_eq!(next.prompt_tokens, 1600, "写后返回的读数含子对话");
        assert_eq!(next.last_context.map(|c| c.used_tokens), Some(1000));

        // 没有子对话的会话：读数 == 行上的值
        assert_eq!(
            db.usage_with_sub_conversations(&child.id)
                .expect("sum child")
                .prompt_tokens,
            500
        );
        // 会话已删：空用量（不留陈旧数字）
        assert!(db
            .usage_with_sub_conversations("ghost")
            .expect("ghost")
            .is_empty());
    }
}
