// 压缩落库：被压区间的定位（`locate_compaction_tail`）与提交（`commit_compaction`
// —— 单事务插卡 + 吸收旧卡，原文全保留）。卡片前缀常量的权威定义在 persister 侧。
use rusqlite::{OptionalExtension, Result as RusqliteResult};
use uuid::Uuid;

use super::messages::messages_insert_clause;

use super::ConversationDb;

impl ConversationDb {
    /// 压缩落库的定位查询：找出 tail 行的 `(created_at, timestamp)`，以及它
    /// **之前最近一张**压缩卡的 id（恒单卡——旧卡已被吸收，最多删一张）。
    ///
    /// `tail_db_id = Some`（自动压缩）按 id 定位被压区间末条；`None`（手动
    /// 压缩）取队尾最后一行（created_at, rowid 最大，与前端队尾追加位置一致）。
    /// 会话为空或 tail 行不存在返回 `None`。
    ///
    /// 只取定位所需的行，**不读全量历史**——旧实现为找这一行把全部归档正文
    /// 拉进内存（每次压缩 Θ(全部历史)）。`card_prefix` 由调用方传入
    /// （`COMPACTION_CARD_PREFIX` 的权威定义在 persister 侧）。
    pub fn locate_compaction_tail(
        &self,
        conversation_id: &str,
        tail_db_id: Option<&str>,
        card_prefix: &str,
    ) -> RusqliteResult<Option<(String, String, Option<String>)>> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let like = format!("{}%", card_prefix);

        let tail: Option<(String, String, i64)> = match tail_db_id {
            Some(id) => tx
                .query_row(
                    "SELECT created_at, timestamp, rowid FROM messages
                     WHERE conversation_id = ?1 AND id = ?2",
                    [conversation_id, id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?,
            None => tx
                .query_row(
                    "SELECT created_at, timestamp, rowid FROM messages
                     WHERE conversation_id = ?1
                     ORDER BY created_at DESC, rowid DESC LIMIT 1",
                    [conversation_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .optional()?,
        };
        let Some((created_at, timestamp, rowid)) = tail else {
            return Ok(None);
        };

        // created_at 用**原始 TEXT**（与写库同源），不做 DateTime 往返，
        // 保证 commit_compaction 写出的卡片 created_at 与旧行可比。
        let card_id: Option<String> = tx
            .query_row(
                "SELECT id FROM messages
                 WHERE conversation_id = ?1 AND role = 'system' AND content LIKE ?2
                   AND (created_at < ?3 OR (created_at = ?3 AND rowid < ?4))
                 ORDER BY created_at DESC, rowid DESC LIMIT 1",
                rusqlite::params![conversation_id, like, created_at, rowid],
                |r| r.get(0),
            )
            .optional()?;
        Ok(Some((created_at, timestamp, card_id)))
    }

    /// 提交一次上下文压缩（单事务，原文全保留、仅插卡片 + 吸收旧卡）：
    /// - `remove_card_ids`：被新卡吸收的旧压缩卡行（被压区间内的上一张卡，删除）；
    /// - 插入压缩摘要卡片行（role=system），`card_created_at` / `card_timestamp`
    ///   都取**被压末行**的值——created_at 定位行序（span 末尾、保留尾部之前），
    ///   timestamp 对齐 span 末行使撤回语义自然（目标在卡前 → 卡片被截断删除 =
    ///   解压；在卡后 → 卡片幸存 = 压缩保留）。
    pub fn commit_compaction(
        &self,
        conversation_id: &str,
        remove_card_ids: &[String],
        card_content: &str,
        card_created_at: &str,
        card_timestamp: &str,
    ) -> RusqliteResult<()> {
        let id = Uuid::new_v4().to_string();
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;

        // 吸收旧卡（按块执行，避免超过 SQLite 参数上限 ~999）
        for chunk in remove_card_ids.chunks(500) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!(
                "DELETE FROM messages
                 WHERE conversation_id = ?1 AND id IN ({placeholders})"
            );
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&conversation_id];
            params.extend(chunk.iter().map(|s| s as &dyn rusqlite::ToSql));
            tx.execute(&sql, rusqlite::params_from_iter(params))?;
        }

        tx.execute(
            &format!("INSERT INTO messages {}", messages_insert_clause()),
            (
                &id,
                conversation_id,
                "system",
                card_content,
                card_timestamp,
                card_created_at,
                None::<&str>,
                None::<&str>,
                None::<&str>,
                None::<&str>,
                None::<&str>,
            ),
        )?;
        tx.commit()?;
        drop(conn);

        self.touch_conversation(conversation_id)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::{create_test_db, seed_compacted_conversation};
    use crate::agent::conversation_persister::COMPACTION_CARD_PREFIX;

    #[test]
    fn test_commit_compaction_keeps_originals_and_positions_card_at_span_end() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(
            &conv.id,
            "assistant",
            "a1",
            "2026-01-01T00:00:01Z",
            None,
            None,
        )
        .expect("m2");
        db.save_message(&conv.id, "tool", "out", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");

        let rows = db.load_messages(&conv.id).expect("load");
        let span_end = rows[2].clone();

        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 3 条历史消息（约 100 tokens）\n\nsummary",
            &span_end.created_at.to_rfc3339(),
            &span_end.timestamp,
        )
        .expect("commit");

        // 原文全保留；卡片位于 span 末尾（被压 3 条之后、保留尾部之前）
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 5);
        assert_eq!(after[0].content, "u1");
        assert_eq!(after[1].content, "a1");
        assert_eq!(after[2].content, "out");
        assert_eq!(after[3].role, "system");
        assert!(after[3].content.starts_with("【上下文已压缩】"));
        assert_eq!(
            after[3].created_at.to_rfc3339(),
            span_end.created_at.to_rfc3339()
        );
        assert_eq!(after[3].timestamp, span_end.timestamp);
        assert_eq!(after[4].content, "u2");
    }

    #[test]
    fn test_commit_compaction_removes_old_cards() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:01Z", None, None)
            .expect("m2");
        db.save_message(&conv.id, "user", "u3", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");

        // 第一次压缩：压 [u1]，卡片插在 u1 之后（无旧卡可吸收）
        let rows = db.load_messages(&conv.id).expect("load");
        let end1 = rows[0].clone();
        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 1 条历史消息（约 10 tokens）\n\ns1",
            &end1.created_at.to_rfc3339(),
            &end1.timestamp,
        )
        .expect("commit");
        let after1 = db.load_messages(&conv.id).expect("load");
        assert_eq!(after1.len(), 4);
        assert!(after1[1].content.starts_with("【上下文已压缩】"));

        // 第二次压缩：区间 [card1, u2]（head-anchored 含上一张卡）→ 只吸收旧卡 card1
        let rows2 = db.load_messages(&conv.id).expect("load");
        let card1_id = rows2[1].id.clone();
        let end2 = rows2[2].clone();
        db.commit_compaction(
            &conv.id,
            &[card1_id.clone()],
            "【上下文已压缩】已整理 2 条历史消息（约 20 tokens）\n\ns2",
            &end2.created_at.to_rfc3339(),
            &end2.timestamp,
        )
        .expect("commit");

        let after2 = db.load_messages(&conv.id).expect("load");
        // u1, u2, card2, u3 —— 旧卡 card1 行已删除，只留最新一张
        assert_eq!(after2.len(), 4);
        assert!(after2.iter().all(|m| m.id != card1_id));
        assert!(after2[2].content.starts_with("【上下文已压缩】"));
        assert_eq!(after2[3].content, "u3");
    }

    #[test]
    fn test_truncate_before_card_uncompacts() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(
            &conv.id,
            "assistant",
            "a1",
            "2026-01-01T00:00:01Z",
            None,
            None,
        )
        .expect("m2");
        db.save_message(&conv.id, "tool", "out", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");
        db.save_message(
            &conv.id,
            "assistant",
            "a2",
            "2026-01-01T00:00:04Z",
            None,
            None,
        )
        .expect("m5");

        let rows = db.load_messages(&conv.id).expect("load");
        let end = rows[2].clone();
        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 3 条历史消息（约 100 tokens）\n\ns",
            &end.created_at.to_rfc3339(),
            &end.timestamp,
        )
        .expect("commit");
        // 压缩后：[u1, a1, out, card, u2, a2]
        assert_eq!(db.load_messages(&conv.id).expect("load").len(), 6);

        // 撤回目标 = u2（timestamp 00:03，卡后）→ 删除其后行；卡片 timestamp=00:02 < 目标 → 幸存
        db.delete_messages_from_timestamp(&conv.id, "2026-01-01T00:00:03Z")
            .expect("truncate");
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 4);
        assert_eq!(after[0].content, "u1");
        assert_eq!(after[1].content, "a1");
        assert_eq!(after[2].content, "out");
        assert!(after[3].content.starts_with("【上下文已压缩】"));
    }

    #[test]
    fn test_truncate_into_span_deletes_card() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "Test").expect("create");
        db.save_message(&conv.id, "user", "u1", "2026-01-01T00:00:00Z", None, None)
            .expect("m1");
        db.save_message(
            &conv.id,
            "assistant",
            "a1",
            "2026-01-01T00:00:01Z",
            None,
            None,
        )
        .expect("m2");
        db.save_message(&conv.id, "tool", "out", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");
        let rows = db.load_messages(&conv.id).expect("load");
        let end = rows[2].clone();
        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 3 条历史消息（约 10 tokens）\n\ns",
            &end.created_at.to_rfc3339(),
            &end.timestamp,
        )
        .expect("commit");

        // 撤回目标在 span 中间（a1，timestamp 00:01 ≤ 卡片 timestamp 00:02）
        // → 卡片被截断删除（目标及其后行也删除）→ 解压，仅剩 u1
        db.delete_messages_from_timestamp(&conv.id, "2026-01-01T00:00:01Z")
            .expect("truncate");
        let after = db.load_messages(&conv.id).expect("load");
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].content, "u1");
    }

    /// 写-读并发的 **smoke test**（不是竞态证明 —— 请看下面那段）。
    ///
    /// 它守的是：写线程反复"插入新卡 + 吸收旧卡"（与 persister 同序）时，回读路径
    /// 不 panic、不死锁、不因为 fixture 腐烂而静默变成空断言。断言的内容是每次回读的
    /// 结果自洽（原文逐条完整有序、结果里最多一张卡）。
    ///
    /// **"不会有半新半旧的拼接"这个保证不来自本测试**，而是结构性的：两个线程共用
    /// 同一个 `Arc<ConversationDb>`（同一把 Mutex + 同一个 Connection），且
    /// `history_overview` / `search_history` / `read_history` 各自都是"一次持锁 +
    /// 一个事务"把解析锚点与取行做完 —— 交错在结构上就不可能发生，所以这个测试
    /// **无法失败**（它最多因为死锁或 `tx.finish()` 漏掉而失败）。
    /// 现状最坏的地方不是它弱，而是它一度看起来像"竞态已被证明"。
    #[test]
    fn concurrent_compaction_smoke_no_deadlock_or_half_written_state() {
        use std::sync::Arc;

        let db = Arc::new(create_test_db());
        let (conv_id, archived, card_id, _) = seed_compacted_conversation(&db);
        let oldest = archived[0].clone();
        // 参与回读的原文（不含卡）内容快照：压缩不碰原文
        let expected: Vec<String> = db
            .load_messages(&conv_id)
            .expect("load")
            .into_iter()
            .filter(|m| !m.content.starts_with(COMPACTION_CARD_PREFIX))
            .map(|m| m.content)
            .collect();

        let writer_db = Arc::clone(&db);
        let writer_conv = conv_id.clone();
        let mut prev_card = card_id.clone();
        let writer = std::thread::spawn(move || {
            for i in 0..40 {
                let card_content = format!("{COMPACTION_CARD_PREFIX}第 {i} 次压缩");
                // 手动压缩语义：卡片取**队尾行**的 created_at / timestamp，于是它排在
                // 队尾紧后面。此前这里写死一个与行序无关的时间戳，卡片实际排到了会话
                // 最前面 ⇒ `archived` 恒为 0，那条断言等于白写（注释还宣称"与被压区间
                // 末行对齐"，是假的）。
                let rows = writer_db.load_messages(&writer_conv).expect("reload");
                let tail = rows.last().expect("tail row");
                writer_db
                    .commit_compaction(
                        &writer_conv,
                        std::slice::from_ref(&prev_card),
                        &card_content,
                        &tail.created_at.to_rfc3339(),
                        &tail.timestamp,
                    )
                    .expect("commit");
                prev_card = writer_db
                    .load_messages(&writer_conv)
                    .expect("reload")
                    .into_iter()
                    .find(|m| m.content == card_content)
                    .expect("new card")
                    .id;
            }
        });

        let reader_db = Arc::clone(&db);
        let reader_conv = conv_id.clone();
        let reader = std::thread::spawn(move || {
            for _ in 0..40 {
                let ov = reader_db
                    .history_overview(&reader_conv, None)
                    .expect("overview");
                assert_eq!(
                    ov.archived + ov.active,
                    ov.total,
                    "归档段 + 活跃段必须等于总数（半新半旧的标志）"
                );
                assert!(
                    ov.archived > 0,
                    "卡片按手动压缩语义排在队尾 ⇒ 归档段非空；为 0 说明 fixture 的时间戳又写死了，\
                     这条 smoke test 会退化成空断言"
                );

                let read = reader_db
                    .read_history(&reader_conv, None, &oldest, 0, 100)
                    .expect("read");
                let cards = read
                    .messages
                    .iter()
                    .filter(|m| m.content.starts_with(COMPACTION_CARD_PREFIX))
                    .count();
                assert!(cards <= 1, "一次回读里不该出现两张卡（新旧拼接）：{cards}");
                let bodies: Vec<String> = read
                    .messages
                    .iter()
                    .filter(|m| !m.content.starts_with(COMPACTION_CARD_PREFIX))
                    .map(|m| m.content.clone())
                    .collect();
                assert_eq!(
                    bodies, expected,
                    "原文必须逐条完整且顺序不变，不允许缺行或错位"
                );
                assert!(
                    !read.has_more_after,
                    "只有 6 行、窗口开到 100，不该说还有更多"
                );
            }
        });

        writer.join().expect("writer");
        reader.join().expect("reader");
    }
}
