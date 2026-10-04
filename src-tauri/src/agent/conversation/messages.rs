// 消息行的存取：`MESSAGES_COLUMNS` 是 messages 表全部列的唯一清单（SELECT / INSERT /
// UPSERT 都由它拼出），save / load / 归档翻页 / 回合收尾状态都在这里。
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Result as RusqliteResult};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::ConversationDb;
use crate::agent::conversation_persister::COMPACTION_CARD_PREFIX;
use crate::agent::task::TurnState;

/// `messages` 表的**全部列**，顺序 = `map_stored_message` 里 `row.get(N)` 的顺序。
///
/// 这里是唯一的列清单：SELECT 列、INSERT 列与占位符、UPSERT 的 SET 子句都由它拼
/// 出来。此前这份清单在 SELECT 里抄了 4 遍、INSERT 里 3 遍、UPSERT SET 里 1 遍
/// —— 加一列要改约 10 处，而漏一处是**静默**的：
/// - 漏在某个 SELECT → 那条路径列数少一 → `row.get(N)` 返 `Err` → 被 `.ok()`
///   吞掉 → 字段静默变 `None`（例如图片附件在某条读取路径上消失）；
/// - 列插在**中间**而不是末尾 → 位置整体错位 → 静默读错字段，SQLite 不报错。
///
/// 注意：加列时除了这里，还要在建表语句或迁移块里 `ALTER TABLE ... ADD COLUMN`。
/// `messages_columns_const_matches_the_live_schema` 会盯着两边是否一致。
const MESSAGES_COLUMNS: &[&str] = &[
    "id",
    "conversation_id",
    "role",
    "content",
    "timestamp",
    "created_at",
    "tool_calls_json",
    "reasoning_content",
    "image_paths_json",
    "turn_state",
];

/// `SELECT <全部列> FROM messages` 用的列清单（拼一次复用，别每处各写一遍）。
pub(super) fn messages_select_columns() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| MESSAGES_COLUMNS.join(", "))
}

/// `INSERT INTO messages <这一段>`：列清单 + `VALUES (?1 … ?N)` 占位符。
/// 占位符编号由列数生成，不会与列序错配。
pub(super) fn messages_insert_clause() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        let cols = MESSAGES_COLUMNS.join(", ");
        let placeholders = (1..=MESSAGES_COLUMNS.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!("({cols}) VALUES ({placeholders})")
    })
}

/// UPSERT 的 `DO UPDATE SET` 子句：除主键 `id` 外的每一列都取 `excluded.*`。
/// 同样由列清单生成 —— 手写这份清单的下场是「加了列却忘了同步 SET，于是更新
/// 时那一列永远保留旧值」。
pub(super) fn messages_upsert_set_clause() -> &'static str {
    static CACHE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    CACHE.get_or_init(|| {
        MESSAGES_COLUMNS
            .iter()
            .filter(|c| **c != "id")
            .map(|c| format!("{c} = excluded.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredMessage {
    pub id: String,
    pub conversation_id: String,
    pub role: String,
    pub content: String,
    pub timestamp: String,
    pub created_at: chrono::DateTime<Utc>,
    /// JSON-serialized tool_calls metadata (for assistant messages with tool invocations).
    pub tool_calls_json: Option<String>,
    /// Reasoning/thinking content from the model (DeepSeek thinking mode).
    /// Must be passed back to the API unchanged in subsequent requests.
    pub reasoning_content: Option<String>,
    /// JSON array of relative image paths under `images/` (user messages).
    pub image_paths_json: Option<String>,
    /// 回合收尾状态（`agent::task::TurnState` 的落库字符串）。
    ///
    /// **只写在回合首条 user 消息行上**（其余行恒为 NULL）：一行代表整个回合。
    /// `None` = 没有记录 —— 旧数据、或本回合没锚定到 user 行；前端据此回落
    /// 「按消息形态判定」的既有行为（不清空、不重置任何东西）。
    /// 读到不认识的字符串同样回落 `None`（见 `TurnState::from_db_str`）。
    pub turn_state: Option<String>,
}

/// 活跃消息段加载结果（用于首次加载会话时从最新 Compaction Checkpoint 开始切片）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActiveMessagesResult {
    /// 活跃消息列表（包含最新的 Checkpoint 卡片及之后的消息，若无卡片则为全量）
    pub messages: Vec<StoredMessage>,
    /// 在该活跃切片之前是否还有更早的归档历史消息
    pub has_earlier: bool,
    /// 截断锚点的 Checkpoint 消息 ID（若无压缩卡片则为 None）
    pub checkpoint_id: Option<String>,
}

/// 归档翻页一页的加载结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EarlierMessagesResult {
    /// 本页消息（按时间升序，紧跟在请求锚点之前）。
    pub messages: Vec<StoredMessage>,
    /// 本页之前是否还有更早的归档（调用方据此决定能不能继续翻）。
    pub has_more: bool,
}

impl ConversationDb {
    pub fn load_messages(&self, conversation_id: &str) -> RusqliteResult<Vec<StoredMessage>> {
        let conn = self.conn.lock().unwrap();
        Self::query_stored_messages(&conn, conversation_id, None)
    }

    /// 从最新的 Compaction Checkpoint（若存在）开始加载活跃消息段。
    /// - 若存在压缩卡片：返回该卡片及之后的所有消息，且 `has_earlier = true`（卡片前有更早消息）；
    /// - 若不存在压缩卡片：返回全量消息，`has_earlier = false`。
    pub fn load_active_messages(
        &self,
        conversation_id: &str,
    ) -> RusqliteResult<ActiveMessagesResult> {
        let conn = self.conn.lock().unwrap();

        // 1. 查询最新的 Compaction Checkpoint 消息 (role = 'system' 且以压缩卡前缀开头)。
        //    前缀从 COMPACTION_CARD_PREFIX 来：写卡的地方与认卡的地方只能有一份字面量，
        //    否则改一处会静默失去归档边界（卡片被当成普通 system 消息）。
        //
        // ⚠️ 这段"定位边界卡"的 SQL 在 `history.rs` 里还有一份等价实现：`boundary_card`
        // （回读用）。**改这里必须同时改那一处**，否则前端翻页与 agent 回读会对
        // 归档边界产生两种看法。前端另有一份等价判定，见 history.rs 文件头"归档边界"段落。
        let mut check_stmt = conn.prepare(
            "SELECT id, created_at, rowid FROM messages 
             WHERE conversation_id = ?1 
               AND role = 'system' 
               AND content LIKE ?2 ESCAPE '\\'
             ORDER BY created_at DESC, rowid DESC 
             LIMIT 1",
        )?;

        let checkpoint = check_stmt
            .query_row(
                rusqlite::params![conversation_id, format!("{COMPACTION_CARD_PREFIX}%")],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .optional()?;

        match checkpoint {
            Some((cp_id, cp_created_at, cp_rowid)) => {
                // 检查卡片前是否还有更早消息
                let mut count_stmt = conn.prepare(
                    "SELECT COUNT(*) FROM messages 
                     WHERE conversation_id = ?1 
                       AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))",
                )?;
                let earlier_count: i64 = count_stmt.query_row(
                    rusqlite::params![conversation_id, cp_created_at, cp_rowid],
                    |r| r.get(0),
                )?;

                // 查询从 Checkpoint 开始（含 Checkpoint 本身）到末尾的所有活跃消息
                let mut msg_stmt = conn.prepare(&format!(
                    "SELECT {}
                        FROM messages
                        WHERE conversation_id = ?1 
                        AND (created_at > ?2 OR (created_at = ?2 AND rowid >= ?3))
                        ORDER BY created_at ASC, rowid ASC",
                    messages_select_columns()
                ))?;
                let messages = msg_stmt
                    .query_map(
                        rusqlite::params![conversation_id, cp_created_at, cp_rowid],
                        Self::map_stored_message,
                    )?
                    .collect::<RusqliteResult<Vec<_>>>()?;

                Ok(ActiveMessagesResult {
                    messages,
                    has_earlier: earlier_count > 0,
                    checkpoint_id: Some(cp_id),
                })
            }
            None => {
                // 没有压缩卡片，直接加载全量
                let messages = Self::query_stored_messages(&conn, conversation_id, None)?;
                Ok(ActiveMessagesResult {
                    messages,
                    has_earlier: false,
                    checkpoint_id: None,
                })
            }
        }
    }

    /// 页缝安全角色：`user`/`notice` 是回合开头（前端 `agentTurnFold` 的
    /// `isTurnStart` 同口径），`system` 是永显锚点（lone 分支）。页首落在
    /// assistant/tool = 有个回合被切成了两半。
    fn is_turn_start_role(role: &str) -> bool {
        matches!(role, "user" | "notice" | "system")
    }

    /// 加载指定消息之前的更早归档历史消息（按需翻页）。
    ///
    /// 只取锚点前**最近的 `limit` 条**（与 `fetch_side` 同构：DESC 取
    /// `limit+1` 条当探针判断还有没有更多，再反转成升序），不再一次读出
    /// 全部归档——UI 每次只展示一页，全量读取是 Θ(B) 的重复搬运与锁占用。
    /// 返回 `(升序消息, 是否还有更早的)`；锚点不存在返回空且 `has_more=false`
    ///（调用方按「没有更早历史」处理，与旧行为一致）。
    ///
    /// **页缝必须落在「安全缝」上**（[`Self::is_turn_start_role`]）：页首若是
    /// assistant/tool，说明有个回合被从中间切开——前端对「没有 user 开头的
    /// 半截回合」按设计展开渲染（无折叠控制行），下一页把回合头补进来后
    /// 回合变完整、满足折叠条件，而 `turnFoldStore` 缺省收起，用户正看着的
    /// 过程当场折叠。因此页首不安全时把页面向前扩到最近一条安全缝（含），
    /// 宁可单页超过 `limit`：一个回合本来就必须原子地进来才能正确渲染。
    /// 归档里根本没有回合开头（纯 assistant/tool 残段）就整段返回、
    /// `has_more=false`。
    pub fn load_earlier_messages(
        &self,
        conversation_id: &str,
        before_message_id: &str,
        limit: usize,
    ) -> RusqliteResult<(Vec<StoredMessage>, bool)> {
        let conn = self.conn.lock().unwrap();

        // 获取 before_message 的 created_at 与 rowid 作为切分点
        let point: Option<(String, i64)> = conn
            .query_row(
                "SELECT created_at, rowid FROM messages WHERE conversation_id = ?1 AND id = ?2",
                [conversation_id, before_message_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;

        let Some((created_at, rowid)) = point else {
            return Ok((vec![], false));
        };

        // 探针页追加 rowid 与原始 created_at 两列（缀在常规列之后，不打乱
        // map_stored_message 的按位读取）。缝对齐的比较必须用与写库同源的
        // 原始 TEXT，不经过 DateTime 往返（同 locate_compaction_tail 的顾虑）。
        let mut stmt = conn.prepare(&format!(
            "SELECT {}, rowid, created_at
                FROM messages
                WHERE conversation_id = ?1
                AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
                ORDER BY created_at DESC, rowid DESC
                LIMIT ?4",
            messages_select_columns()
        ))?;

        let mut desc = stmt
            .query_map(
                rusqlite::params![conversation_id, created_at, rowid, (limit as i64) + 1],
                |row| {
                    let msg = Self::map_stored_message(row)?;
                    let rowid: i64 = row.get(MESSAGES_COLUMNS.len())?;
                    let raw_created_at: String = row.get(MESSAGES_COLUMNS.len() + 1)?;
                    Ok((rowid, raw_created_at, msg))
                },
            )?
            .collect::<RusqliteResult<Vec<_>>>()?;

        let has_more_beyond_limit = desc.len() > limit;
        if has_more_beyond_limit {
            desc.truncate(limit);
        }
        let Some(&(oldest_rowid, ref oldest_created_at, ref oldest_msg)) = desc.last() else {
            return Ok((vec![], has_more_beyond_limit));
        };
        if Self::is_turn_start_role(&oldest_msg.role) {
            let mut messages: Vec<StoredMessage> = desc.drain(..).map(|(_, _, msg)| msg).collect();
            messages.reverse();
            return Ok((messages, has_more_beyond_limit));
        }

        // 页缝切在回合中间：向前找最近一条安全缝（含）整页重取。
        let seam: Option<(String, i64)> = conn
            .query_row(
                "SELECT created_at, rowid FROM messages
                    WHERE conversation_id = ?1
                    AND role IN ('user', 'notice', 'system')
                    AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
                    ORDER BY created_at DESC, rowid DESC
                    LIMIT 1",
                rusqlite::params![conversation_id, oldest_created_at, oldest_rowid],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((seam_created_at, seam_rowid)) = seam else {
            // 没有任何安全缝（归档里没有 user/notice/system）：整段返回。
            let messages =
                Self::fetch_message_range(&conn, conversation_id, None, &(created_at, rowid))?;
            return Ok((messages, false));
        };
        let messages = Self::fetch_message_range(
            &conn,
            conversation_id,
            Some(&(seam_created_at.clone(), seam_rowid)),
            &(created_at, rowid),
        )?;
        // 扩页后「还有没有更早」以缝为界重新判定——探针多出的行已经在页里了。
        let has_more: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM messages
                WHERE conversation_id = ?1
                AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3)))",
            rusqlite::params![conversation_id, seam_created_at, seam_rowid],
            |r| r.get(0),
        )?;
        Ok((messages, has_more))
    }

    /// 取 `(start, end)` 升序区间：start 含（`None` = 会话开头），end 不含。
    /// 比较语义与 `load_earlier_messages` 的锚点切分完全同款
    ///（(created_at, rowid) 元组，见 history.rs 模块头「归档边界」段）。
    fn fetch_message_range(
        conn: &Connection,
        conversation_id: &str,
        start: Option<&(String, i64)>,
        end: &(String, i64),
    ) -> RusqliteResult<Vec<StoredMessage>> {
        let sql = match start {
            Some(_) => format!(
                "SELECT {}
                    FROM messages
                    WHERE conversation_id = ?1
                    AND (created_at > ?2 OR (created_at = ?2 AND rowid >= ?3))
                    AND (created_at < ?4 OR (created_at = ?4 AND rowid < ?5))
                    ORDER BY created_at ASC, rowid ASC",
                messages_select_columns()
            ),
            None => format!(
                "SELECT {}
                    FROM messages
                    WHERE conversation_id = ?1
                    AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))
                    ORDER BY created_at ASC, rowid ASC",
                messages_select_columns()
            ),
        };
        let mut stmt = conn.prepare(&sql)?;
        let mut rows = match start {
            Some((s_created_at, s_rowid)) => stmt.query(rusqlite::params![
                conversation_id,
                s_created_at,
                s_rowid,
                end.0,
                end.1
            ])?,
            None => stmt.query(rusqlite::params![conversation_id, end.0, end.1])?,
        };
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(Self::map_stored_message(row)?);
        }
        Ok(out)
    }

    pub(super) fn map_stored_message(row: &rusqlite::Row<'_>) -> RusqliteResult<StoredMessage> {
        Ok(StoredMessage {
            id: row.get(0)?,
            conversation_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            timestamp: row.get(4)?,
            created_at: row
                .get::<_, String>(5)?
                .parse()
                .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC),
            tool_calls_json: row.get(6).ok(),
            reasoning_content: row.get(7).ok(),
            image_paths_json: row.get(8).ok(),
            // 未知串 → None（降级运行读到未来版本写的值时不冒充正常结束）
            turn_state: row
                .get::<_, Option<String>>(9)
                .ok()
                .flatten()
                .filter(|raw| TurnState::from_db_str(raw).is_some()),
        })
    }

    fn query_stored_messages(
        conn: &Connection,
        conversation_id: &str,
        limit: Option<usize>,
    ) -> RusqliteResult<Vec<StoredMessage>> {
        let sql = match limit {
            Some(_) => &format!(
                "SELECT {}
                    FROM messages
                    WHERE conversation_id = ?1
                    ORDER BY created_at ASC, rowid ASC
                    LIMIT ?2",
                messages_select_columns()
            ),
            None => &format!(
                "SELECT {}
                    FROM messages
                    WHERE conversation_id = ?1
                    ORDER BY created_at ASC, rowid ASC",
                messages_select_columns()
            ),
        };

        let mut stmt = conn.prepare(sql)?;
        let mut rows = match limit {
            Some(lim) => stmt.query(rusqlite::params![conversation_id, lim as i64])?,
            None => stmt.query(rusqlite::params![conversation_id])?,
        };

        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(Self::map_stored_message(row)?);
        }
        Ok(out)
    }

    pub fn save_message(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        timestamp: &str,
        tool_calls_json: Option<&str>,
        reasoning_content: Option<&str>,
    ) -> RusqliteResult<StoredMessage> {
        self.save_message_with_images(
            conversation_id,
            role,
            content,
            timestamp,
            tool_calls_json,
            reasoning_content,
            None,
        )
    }

    pub fn save_message_with_images(
        &self,
        conversation_id: &str,
        role: &str,
        content: &str,
        timestamp: &str,
        tool_calls_json: Option<&str>,
        reasoning_content: Option<&str>,
        image_paths_json: Option<&str>,
    ) -> RusqliteResult<StoredMessage> {
        let now = Utc::now();
        let id = Uuid::new_v4().to_string();
        let now_str = now.to_rfc3339();
        let conn = self.conn.lock().unwrap();

        conn.execute(
            &format!("INSERT INTO messages {}", messages_insert_clause()),
            (
                &id,
                conversation_id,
                role,
                content,
                timestamp,
                &now_str,
                tool_calls_json,
                reasoning_content,
                image_paths_json,
                // 回合收尾状态不在这里写：只有回合首条 user 行需要，由
                // `begin_turn_state` / `set_message_turn_state` 事后 UPDATE。
                None::<&str>,
            ),
        )?;
        drop(conn);

        self.touch_conversation(conversation_id)?;

        Ok(StoredMessage {
            id,
            conversation_id: conversation_id.to_string(),
            role: role.to_string(),
            content: content.to_string(),
            timestamp: timestamp.to_string(),
            created_at: now,
            tool_calls_json: tool_calls_json.map(String::from),
            reasoning_content: reasoning_content.map(String::from),
            image_paths_json: image_paths_json.map(String::from),
            turn_state: None,
        })
    }

    /// 回合开始：把锚点行（回合首条 user 消息）标成 `running`。
    ///
    /// 为什么必须**在回合开始时**先写一笔：进程崩溃 / 被强杀时没有任何机会跑
    /// 收尾写入，行上留在 `running` 就是「这一轮没有正常收尾」的持久证据；
    /// 只在收尾时才写的话，崩溃与「旧版本留下的、压根没有记录的行」无法区分。
    ///
    /// 同一次调用顺手把本会话里**别的** `running` 行收敛成 `interrupted`：
    /// 这个会话既然还能开出新回合，那些行早已不属于任何在跑的任务 —— 只可能
    /// 是上次进程异常退出留下的。收敛放在这里而不是启动时全库扫一遍，是为了
    /// 不跟「另一个实例正在跑同一会话」互踩：作用域限定在本会话、本回合之外。
    pub fn begin_turn_state(&self, conversation_id: &str, message_id: &str) -> RusqliteResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "UPDATE messages SET turn_state = ?1
             WHERE conversation_id = ?2 AND turn_state = ?3 AND id <> ?4",
            (
                TurnState::Interrupted.as_str(),
                conversation_id,
                TurnState::Running.as_str(),
                message_id,
            ),
        )?;
        tx.execute(
            "UPDATE messages SET turn_state = ?1 WHERE id = ?2",
            (TurnState::Running.as_str(), message_id),
        )?;
        tx.commit()
    }

    /// 回合收尾：把终态写到锚点行上。返回是否命中了行 —— 锚点可能已被回滚
    /// 删除（回合本身都没了），那就不写、也不报错。
    pub fn set_message_turn_state(
        &self,
        message_id: &str,
        state: TurnState,
    ) -> RusqliteResult<bool> {
        let conn = self.conn.lock().unwrap();
        let rows = conn.execute(
            "UPDATE messages SET turn_state = ?1 WHERE id = ?2",
            (state.as_str(), message_id),
        )?;
        Ok(rows > 0)
    }

    pub fn delete_messages_from_timestamp(
        &self,
        conversation_id: &str,
        from_timestamp: &str,
    ) -> RusqliteResult<usize> {
        // 截断前收集磁盘图：保留「回撤目标」那条 user 的图（前端要恢复到输入框），
        // 其余被删消息的图全部回收，避免孤儿文件。
        let paths_to_delete: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare(
                "SELECT role, image_paths_json FROM messages
                 WHERE conversation_id = ?1 AND timestamp >= ?2
                 ORDER BY timestamp ASC, rowid ASC",
            )?;
            let rows: Vec<(String, Option<String>)> = stmt
                .query_map((conversation_id, from_timestamp), |row| {
                    Ok((row.get(0)?, row.get(1)?))
                })?
                .filter_map(|r| r.ok())
                .collect();

            let mut keep_first_user_images = true;
            let mut to_delete = Vec::new();
            for (role, image_json) in rows {
                let is_rollback_target = keep_first_user_images && role == "user";
                if is_rollback_target {
                    keep_first_user_images = false;
                    continue;
                }
                if role == "user" {
                    keep_first_user_images = false;
                }
                if let Some(json) = image_json {
                    if let Ok(paths) = serde_json::from_str::<Vec<String>>(&json) {
                        to_delete.extend(paths);
                    }
                }
            }
            to_delete
        };

        let deleted = {
            let conn = self.conn.lock().unwrap();
            conn.execute(
                "DELETE FROM messages WHERE conversation_id = ?1 AND timestamp >= ?2",
                (conversation_id, from_timestamp),
            )?
        };

        // 撤回语义（原文全保留，无归档）：
        // 目标在压缩卡之前 → 卡片（timestamp = span 末行 ≥ 目标）被截断删除 = 解压；
        // 目标在卡后（保留尾部）→ 卡片幸存 = 压缩保留。无额外逻辑。

        for path in paths_to_delete {
            let _ = crate::agent::image_store::delete_image(&path);
        }

        self.touch_conversation(conversation_id)?;
        Ok(deleted)
    }

    /// 替换会话的全部消息（删除旧的 + 插入新的）。
    /// 用于跨设备同步 pull 时整体覆盖会话消息。
    pub fn replace_messages(
        &self,
        conversation_id: &str,
        messages: &[StoredMessage],
    ) -> RusqliteResult<()> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        for m in messages {
            tx.execute(
                &format!(
                    "INSERT INTO messages {} ON CONFLICT(id) DO UPDATE SET {}",
                    messages_insert_clause(),
                    messages_upsert_set_clause()
                ),
                (
                    &m.id,
                    &m.conversation_id,
                    &m.role,
                    &m.content,
                    &m.timestamp,
                    m.created_at.to_rfc3339(),
                    &m.tool_calls_json,
                    &m.reasoning_content,
                    &m.image_paths_json,
                    // 跨设备同步的回合收尾状态照搬（同一台设备上被判定过的
                    // 回合，同步到别处不能突然变成「可以折叠」）
                    &m.turn_state,
                ),
            )?;
        }
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::create_test_db;

    #[test]
    fn test_save_and_load_messages() {
        let db = create_test_db();

        let conversation = db
            .create_conversation("conn_1", "Test")
            .expect("Failed to create conversation");

        let msg = db
            .save_message(
                &conversation.id,
                "user",
                "Hello",
                "2024-01-01T00:00:00Z",
                None,
                None,
            )
            .expect("Failed to save message");
        assert!(!msg.id.is_empty());
        assert_eq!(msg.role, "user");
        assert_eq!(msg.content, "Hello");
        assert!(msg.tool_calls_json.is_none());

        let messages = db
            .load_messages(&conversation.id)
            .expect("Failed to load messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "Hello");
    }

    #[test]
    fn test_delete_messages_from_timestamp() {
        let db = create_test_db();

        let conversation = db
            .create_conversation("conn_1", "Rollback")
            .expect("Failed to create conversation");

        db.save_message(
            &conversation.id,
            "user",
            "keep",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("Failed to save message");
        db.save_message(
            &conversation.id,
            "user",
            "rewrite",
            "2026-01-01T00:01:00Z",
            None,
            None,
        )
        .expect("Failed to save message");
        db.save_message(
            &conversation.id,
            "assistant",
            "answer",
            "2026-01-01T00:02:00Z",
            None,
            None,
        )
        .expect("Failed to save message");
        db.save_message(
            &conversation.id,
            "tool",
            "tool output",
            "2026-01-01T00:03:00Z",
            None,
            None,
        )
        .expect("Failed to save message");

        let deleted = db
            .delete_messages_from_timestamp(&conversation.id, "2026-01-01T00:01:00Z")
            .expect("Failed to delete messages");

        assert_eq!(deleted, 3);
        let messages = db
            .load_messages(&conversation.id)
            .expect("Failed to load messages");
        assert_eq!(messages.len(), 1);
        assert_eq!(messages[0].content, "keep");
    }

    #[test]
    fn truncate_deletes_later_images_keeps_rollback_target() {
        use crate::agent::image_store;
        use tempfile::tempdir;

        // image_store 的 IMAGES_ROOT 是进程级全局（OnceLock），必须与其它
        // image 测试串行，否则 tempdir drop 竞态导致随机失败。
        let _guard = image_store::test_lock();
        let dir = tempdir().unwrap();
        image_store::init(dir.path());
        let db = create_test_db();
        let conversation = db
            .create_conversation("conn_1", "ImgRollback")
            .expect("create");

        let keep_path =
            image_store::save_image_bytes(&conversation.id, "m0", 0, b"keep-bytes").unwrap();
        let target_path =
            image_store::save_image_bytes(&conversation.id, "m1", 0, b"target-bytes").unwrap();
        let later_path =
            image_store::save_image_bytes(&conversation.id, "m2", 0, b"later-bytes").unwrap();

        db.save_message_with_images(
            &conversation.id,
            "user",
            "keep",
            "2026-01-01T00:00:00Z",
            None,
            None,
            Some(&format!(r#"["{}"]"#, keep_path)),
        )
        .expect("save keep");
        db.save_message_with_images(
            &conversation.id,
            "user",
            "rewrite",
            "2026-01-01T00:01:00Z",
            None,
            None,
            Some(&format!(r#"["{}"]"#, target_path)),
        )
        .expect("save target");
        db.save_message_with_images(
            &conversation.id,
            "user",
            "later",
            "2026-01-01T00:02:00Z",
            None,
            None,
            Some(&format!(r#"["{}"]"#, later_path)),
        )
        .expect("save later");

        let deleted = db
            .delete_messages_from_timestamp(&conversation.id, "2026-01-01T00:01:00Z")
            .expect("truncate");
        assert_eq!(deleted, 2);

        let exists = |rel: &str| {
            image_store::absolute_path(rel)
                .map(|p| p.exists())
                .unwrap_or(false)
        };
        // 回撤目标图保留（前端恢复预览），之后轮次图删除
        assert!(exists(&keep_path), "pre-truncate image should remain");
        assert!(exists(&target_path), "rollback target image should remain");
        assert!(!exists(&later_path), "later-turn image should be deleted");
    }

    #[test]
    fn test_load_active_and_earlier_messages_with_compaction() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "Test").expect("create");

        // 1. 无压缩卡片时：load_active_messages 返回全量且 has_earlier 为 false
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

        let active1 = db.load_active_messages(&conv.id).expect("active1");
        assert_eq!(active1.messages.len(), 2);
        assert!(!active1.has_earlier);
        assert_eq!(active1.checkpoint_id, None);

        // 2. 增加消息并执行一次压缩
        db.save_message(&conv.id, "tool", "t1", "2026-01-01T00:00:02Z", None, None)
            .expect("m3");
        db.save_message(&conv.id, "user", "u2", "2026-01-01T00:00:03Z", None, None)
            .expect("m4");
        let rows = db.load_messages(&conv.id).expect("load");
        let span_end = rows[2].clone(); // t1 作为压缩末尾

        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】已整理 3 条历史消息（约 100 tokens）\n\nsummary",
            &span_end.created_at.to_rfc3339(),
            &span_end.timestamp,
        )
        .expect("commit");

        db.save_message(
            &conv.id,
            "assistant",
            "a2",
            "2026-01-01T00:00:04Z",
            None,
            None,
        )
        .expect("m5");

        // 此时物理消息顺序：[u1, a1, t1, <card>, u2, a2]
        let active2 = db.load_active_messages(&conv.id).expect("active2");
        assert_eq!(active2.messages.len(), 3); // <card>, u2, a2
        assert!(active2.has_earlier);
        assert!(active2.messages[0].content.starts_with("【上下文已压缩】"));
        assert_eq!(active2.messages[1].content, "u2");
        assert_eq!(active2.messages[2].content, "a2");

        let cp_id = active2.checkpoint_id.expect("checkpoint_id exists");
        assert_eq!(cp_id, active2.messages[0].id);

        // 3. 测试 load_earlier_messages 从卡片开始向前拉取归档历史
        let (earlier, has_more) = db
            .load_earlier_messages(&conv.id, &cp_id, 50)
            .expect("earlier");
        assert_eq!(earlier.len(), 3); // u1, a1, t1
        assert!(!has_more);
        assert_eq!(earlier[0].content, "u1");
        assert_eq!(earlier[1].content, "a1");
        assert_eq!(earlier[2].content, "t1");
    }

    /// 归档翻页必须真分页：跨页无重复无缺失、页序升序接续锚点；且**页缝
    /// 必须落在回合边界**（页面最旧一条是 user/notice/system）——缝切在
    /// 回合中间时向前扩页，单页可超过 limit。旧实现一次读出全部归档
    /// （无 LIMIT），这条测试在旧代码上直接失败。
    #[test]
    fn earlier_messages_page_through_the_archive_without_loss() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "paging").expect("create");

        // 8 条归档（含相同 created_at 不同 rowid、中文/emoji 正文）+ 一张压缩卡
        let archived: Vec<(&str, &str, &str)> = vec![
            ("user", "第 1 条", "2026-01-01T00:00:00Z"),
            ("assistant", "第 2 条 🎉", "2026-01-01T00:00:01Z"),
            ("assistant", "第 3 条（同秒前段）", "2026-01-01T00:00:02Z"),
            ("assistant", "第 4 条（同秒后段）", "2026-01-01T00:00:02Z"),
            ("tool", "第 5 条", "2026-01-01T00:00:03Z"),
            ("user", "第 6 条", "2026-01-01T00:00:04Z"),
            ("assistant", "第 7 条", "2026-01-01T00:00:05Z"),
            ("user", "第 8 条", "2026-01-01T00:00:06Z"),
        ];
        for (role, content, ts) in &archived {
            db.save_message(&conv.id, role, content, ts, None, None)
                .expect("archive row");
        }
        let rows = db.load_messages(&conv.id).expect("load");
        let span_end = rows[7].clone();
        db.commit_compaction(
            &conv.id,
            &[],
            "【上下文已压缩】summary",
            &span_end.created_at.to_rfc3339(),
            &span_end.timestamp,
        )
        .expect("commit");
        let active = db.load_active_messages(&conv.id).expect("active");
        let cp_id = active.checkpoint_id.expect("checkpoint");

        // 每页 3 条翻到底；翻页游标 = 已收集内容中最早一条（loadEarlierHistory
        // 是前插语义，新页到达后 first 就是下一页锚点）
        let mut collected: Vec<StoredMessage> = Vec::new();
        let mut anchor = cp_id;
        let mut pages = 0;
        loop {
            let (page, has_more) = db
                .load_earlier_messages(&conv.id, &anchor, 3)
                .expect("page");
            pages += 1;
            // 页缝必须落在回合边界：页面最旧一条是 user/notice/system。
            // 缝不安全时实现会向前扩页（第 2 页扩到 [1..6) 共 5 条 > limit）。
            assert!(
                ConversationDb::is_turn_start_role(page.first().expect("非空页").role.as_str()),
                "页面最旧一条必须是回合开头/永显锚点：{:?}",
                page.first().map(|m| &m.role)
            );
            if !page.is_empty() {
                let mut merged: Vec<StoredMessage> = page;
                merged.extend(collected);
                collected = merged;
            }
            if !has_more {
                break;
            }
            assert!(pages < 10, "翻页没有收敛：游标没有前进");
            anchor = collected
                .first()
                .expect("游标必须用本页最早一条")
                .id
                .clone();
        }

        assert_eq!(
            pages, 2,
            "8 条归档按 3 条一页翻页：第 2 页缝不安全扩到 5 条，共 2 页"
        );
        assert_eq!(collected.len(), 8, "跨页不能丢消息");
        let expected: Vec<&str> = archived.iter().map(|(_, c, _)| *c).collect();
        let got: Vec<&str> = collected.iter().map(|m| m.content.as_str()).collect();
        assert_eq!(got, expected, "跨页拼接应与原始顺序完全一致");
    }

    /// 页缝绝不允许切在回合中间：页面最旧一条必须是「安全缝」
    /// （role ∈ user/notice/system —— 与前端 `isTurnStart` 回合边界 + lone
    /// 锚点同口径）。缝切在回合中间时，前端把先到的后半段当「半截回合」
    /// 按设计展开渲染；下一页把回合头补进来后回合变完整、满足折叠条件，
    /// 而 `turnFoldStore` 缺省收起 —— 用户正看着的过程当场折叠（回归）。
    #[test]
    fn earlier_messages_pages_never_split_a_turn() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "seam").expect("create");

        // 三个回合：T1/T2 各 5 行（user + 过程 + 答案），T3 两行。
        // 逻辑顺序即插入顺序（created_at 同批递增、rowid 决胜）。
        let rows: Vec<(&str, &str)> = vec![
            ("user", "u1"),
            ("assistant", "a1"),
            ("tool", "t1"),
            ("tool", "t2"),
            ("assistant", "a2"),
            ("user", "u2"),
            ("assistant", "a3"),
            ("tool", "t3"),
            ("tool", "t4"),
            ("assistant", "a4"),
            ("user", "u3"),
            ("assistant", "a5"),
        ];
        for (role, content) in &rows {
            db.save_message(&conv.id, role, content, "2026-01-01T00:00:00Z", None, None)
                .expect("row");
        }
        let all = db.load_messages(&conv.id).expect("load");
        assert_eq!(all.len(), 12);
        // 锚点 = 内存里最旧一条（a5），页取它**之前**的行——锚点本身不进页。
        let anchor = all.last().unwrap().id.clone();

        // limit=4：探针页 [t3, t4, a4, u3] 的最旧一条是 tool —— 正好切在 T2 中间。
        let (page, has_more) = db
            .load_earlier_messages(&conv.id, &anchor, 4)
            .expect("page1");
        assert_eq!(
            page.first().map(|m| m.role.as_str()),
            Some("user"),
            "页面最旧一条必须是回合开头（页缝对齐）"
        );
        assert_eq!(
            page.first().map(|m| m.content.as_str()),
            Some("u2"),
            "缝切在 T2 中间 → 向前扩到 T2 的 user，T2 整段原子进入"
        );
        assert_eq!(page.len(), 6, "扩页 = u2..u3 六行一页拿全");
        assert!(has_more, "u2 之前还有 T1 → 还有更早的");

        // 第二页：锚点 u2，剩 [u1..a2] 5 行，limit=4 → 探针页最旧 a1（assistant，
        // 不安全）→ 扩到 u1，T1 整段一页拿全。
        let (page2, has_more2) = db
            .load_earlier_messages(&conv.id, page.first().unwrap().id.as_str(), 4)
            .expect("page2");
        assert_eq!(page2.first().map(|m| m.role.as_str()), Some("user"));
        assert_eq!(page2.first().map(|m| m.content.as_str()), Some("u1"));
        assert_eq!(page2.len(), 5, "T1 整段 5 行一页拿全");
        assert!(!has_more2, "u1 之前没有更多");
    }

    /// 页缝本来就落在回合边界（最旧一条是 user）→ 不扩页，页大小恒为 limit。
    #[test]
    fn earlier_messages_page_on_a_turn_boundary_is_not_extended() {
        let db = create_test_db();
        let conv = db
            .create_conversation("conn_1", "boundary")
            .expect("create");
        let rows: Vec<(&str, &str)> = vec![
            ("user", "u1"),
            ("assistant", "a1"),
            ("tool", "t1"),
            ("tool", "t2"),
            ("assistant", "a2"),
            ("user", "u2"),
            ("assistant", "a3"),
            ("tool", "t3"),
            ("tool", "t4"),
            ("assistant", "a4"),
            ("user", "u3"),
            ("assistant", "a5"),
        ];
        for (role, content) in &rows {
            db.save_message(&conv.id, role, content, "2026-01-01T00:00:00Z", None, None)
                .expect("row");
        }
        let all = db.load_messages(&conv.id).expect("load");
        // 锚点 = t3：页取它之前的 2 行 [u2, a3]，最旧一条恰是 user —— 边界缝。
        let anchor = all
            .iter()
            .find(|m| m.content == "t3")
            .expect("t3")
            .id
            .clone();

        let (page, has_more) = db
            .load_earlier_messages(&conv.id, &anchor, 2)
            .expect("page");
        assert_eq!(
            page.iter().map(|m| m.content.as_str()).collect::<Vec<_>>(),
            vec!["u2", "a3"],
            "缝正好落在 u2（回合边界）→ 原样返回，不扩页"
        );
        assert_eq!(page.len(), 2, "边界缝不扩页：页大小恒为 limit");
        assert!(has_more);
    }

    /// 翻页 SELECT 必须命中 (conversation_id, created_at) 复合索引，
    /// 不允许全表 SCAN 或 TEMP B-TREE 排序（深归档下每次翻页都是全表排序）。
    #[test]
    fn earlier_messages_query_uses_the_composite_index() {
        let db = create_test_db();
        let conn = db.conn.lock().unwrap();
        let plan: Vec<String> = conn
            .prepare("EXPLAIN QUERY PLAN SELECT id FROM messages WHERE conversation_id = 'c' AND (created_at < ?1 OR (created_at = ?1 AND rowid < ?2)) ORDER BY created_at DESC, rowid DESC LIMIT 4")
            .expect("prepare")
            .query_map(["2026-01-01T00:00:00Z", "1"], |r| r.get::<_, String>(3))
            .expect("query plan")
            .filter_map(|r| r.ok())
            .collect();
        let joined = plan.join(" | ");
        assert!(
            joined.contains("idx_messages_conv_time"),
            "翻页查询应命中复合索引，实际计划：{joined}"
        );
        assert!(
            !joined.to_uppercase().contains("SCAN"),
            "翻页查询不允许全表扫描，实际计划：{joined}"
        );
        assert!(
            !joined.to_uppercase().contains("TEMP B-TREE"),
            "翻页查询不允许临时排序，实际计划：{joined}"
        );
    }

    /// `MESSAGES_COLUMNS` 必须与**实际 schema**（建表 + 迁移跑完后的表）逐列一致、且顺序相同。
    ///
    /// 这条守的是「加了列却忘了更新列清单」：`MESSAGES_COLUMNS` 是 SELECT/INSERT 的
    /// 唯一来源，它少一列 → 每条读取路径都少一列 → `row.get(N)` 返 `Err` → 被
    /// `.ok()` 吞掉 → 字段静默变 `None`。顺序也要管：`map_stored_message` 用的是
    /// 位置下标，顺序错了就是静默读错字段。
    #[test]
    fn messages_columns_const_matches_the_live_schema() {
        let db = create_test_db();
        let conn = db.conn.lock().unwrap();
        let live: Vec<String> = conn
            .prepare("PRAGMA table_info(messages)")
            .expect("prepare table_info")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("query table_info")
            .filter_map(|r| r.ok())
            .collect();

        let expected: Vec<String> = MESSAGES_COLUMNS.iter().map(|c| c.to_string()).collect();
        assert_eq!(
            live, expected,
            "messages 表列与 MESSAGES_COLUMNS 不一致（加列时两边都要改）"
        );
    }

    /// 同一条消息里的每个可选字段都用**互不相同**的值写进去，再把每条读取路径都读
    /// 一遍 —— 任一路径**漏了列**（列数少一 → `row.get(N)` 返 `Err` → 被 `.ok()`
    /// 吞掉 → 字段静默变 `None`），这里的断言就会失败。
    ///
    /// 注意它**拦不住列序错位**：读写共用同一份 `MESSAGES_COLUMNS`，顺序错了也是一致地
    /// 错（值被写进"错"的库列，读回来却对得上），两个错误互相抵消。顺序由
    /// `messages_columns_const_matches_the_live_schema` 与真实 schema 比对来守 ——
    /// 实测：把 `reasoning_content` 挪到 `tool_calls_json` 前面，只有那条会红。
    /// 一遍 —— 任一路径漏了列或列序错位，这里的断言就会失败。
    ///
    /// 覆盖的读取路径（4 处 SELECT 各一条）：
    /// - `query_stored_messages`（全量 / 带 limit 两个分支）
    /// - `load_active_messages`：有压缩卡片 → 只取卡片之后的消息（内联 SELECT）
    /// - `load_active_messages`：无卡片 → 回落到 `query_stored_messages`
    /// - `load_earlier_messages`：翻页取更早的消息（内联 SELECT）
    #[test]
    fn every_optional_message_field_survives_all_read_paths() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "roundtrip").expect("conv");
        let tools = r#"[{"id":"call_1","name":"bash"}]"#;
        let reasoning = "先看目录再看文件";
        let images = r#"["/tmp/one.png","/tmp/two.png"]"#;

        let early = db
            .save_message_with_images(
                &conv.id,
                "assistant",
                "早的消息",
                "2026-01-01T00:00:00Z",
                Some(tools),
                Some(reasoning),
                Some(images),
            )
            .expect("early");

        // 压缩卡片：触发 load_active_messages 的 checkpoint 分支
        db.save_message(
            &conv.id,
            "system",
            "【上下文已压缩】测试卡片",
            "2026-01-01T00:00:30Z",
            None,
            None,
        )
        .expect("checkpoint");

        let late = db
            .save_message_with_images(
                &conv.id,
                "assistant",
                "晚的消息",
                "2026-01-01T00:01:00Z",
                Some(tools),
                Some(reasoning),
                Some(images),
            )
            .expect("late");

        let assert_rich = |m: &StoredMessage, what: &str| {
            assert_eq!(
                m.tool_calls_json.as_deref(),
                Some(tools),
                "{what}: tool_calls"
            );
            assert_eq!(
                m.reasoning_content.as_deref(),
                Some(reasoning),
                "{what}: reasoning"
            );
            assert_eq!(
                m.image_paths_json.as_deref(),
                Some(images),
                "{what}: images"
            );
            assert!(
                m.content == "早的消息" || m.content == "晚的消息" || m.content == "唯一一条",
                "{what}: content 被别的列顶掉了（列序错位？）: {}",
                m.content
            );
        };

        // ① 全量（query_stored_messages 无 limit 分支）
        {
            let conn = db.conn.lock().unwrap();
            let all = ConversationDb::query_stored_messages(&conn, &conv.id, None).expect("all");
            assert_eq!(all.len(), 3);
            assert_rich(&all[0], "query_stored_messages(无 limit)");
            assert_rich(&all[2], "query_stored_messages(无 limit)");
        }
        // ② 带 limit（query_stored_messages 的另一个分支）
        {
            let conn = db.conn.lock().unwrap();
            let limited =
                ConversationDb::query_stored_messages(&conn, &conv.id, Some(1)).expect("limited");
            assert_eq!(limited.len(), 1, "limit 分支应只取最后一条");
            assert_rich(&limited[0], "query_stored_messages(limit)");
        }
        // ③ 压缩卡片之后（load_active_messages 的 checkpoint 内联 SELECT）
        {
            let active = db.load_active_messages(&conv.id).expect("active");
            // 该分支的 SQL 是 `rowid >= 卡片 rowid` —— 卡片本身也在返回集里
            assert_eq!(active.messages.len(), 2, "卡片 + 卡片之后的消息");
            assert_eq!(active.messages[1].id, late.id);
            assert_rich(
                active.messages.last().expect("last"),
                "load_active_messages(checkpoint)",
            );
        }
        // ④ 翻页取更早（load_earlier_messages 的内联 SELECT）
        {
            let (earlier, _) = db
                .load_earlier_messages(&conv.id, &late.id, 50)
                .expect("earlier");
            let first = earlier.first().expect("应取到更早的消息");
            assert_eq!(first.id, early.id);
            assert_rich(first, "load_earlier_messages");
        }
        // ⑤ 没有卡片时回落到全量路径
        {
            let plain = db
                .create_conversation("conn_2", "no-checkpoint")
                .expect("conv2");
            db.save_message_with_images(
                &plain.id,
                "assistant",
                "唯一一条",
                "2026-01-01T00:00:00Z",
                Some(tools),
                Some(reasoning),
                Some(images),
            )
            .expect("plain msg");
            let active = db.load_active_messages(&plain.id).expect("active plain");
            assert_eq!(active.messages.len(), 1);
            assert_rich(&active.messages[0], "load_active_messages(无卡片)");
        }
    }

    /// 回合收尾状态：写进锚点行后，每条读取路径都要能读到（漏列 = 静默变 None
    /// —— 前端会把它当成「没有记录」而按形态折叠，正是本次要修的那个问题在
    /// 另一个层面的复现）。同时钉住两件默认行为：普通 INSERT 的行没有收尾状态、
    /// 未知字符串读回来是 None（不冒充「正常结束」）。
    #[test]
    fn turn_state_roundtrips_through_every_read_path() {
        let db = create_test_db();
        let conv = db
            .create_conversation("conn_1", "turn-state")
            .expect("conv");
        let anchor = db
            .save_message(
                &conv.id,
                "user",
                "跑一下",
                "2026-01-01T00:00:00Z",
                None,
                None,
            )
            .expect("anchor");
        // 普通 INSERT 的行没有回合收尾状态
        assert!(anchor.turn_state.is_none());
        let later = db
            .save_message(
                &conv.id,
                "assistant",
                "好的",
                "2026-01-01T00:00:01Z",
                None,
                None,
            )
            .expect("later");
        db.save_message(
            &conv.id,
            "system",
            "【上下文已压缩】测试卡片",
            "2026-01-01T00:00:02Z",
            None,
            None,
        )
        .expect("card");

        db.begin_turn_state(&conv.id, &anchor.id).expect("begin");
        db.set_message_turn_state(&anchor.id, TurnState::Cancelled)
            .expect("end");

        // ① 全量 + ② limit 分支 + ③ 卡片之后的切片 + ④ 翻页取更早
        let all = db.load_messages(&conv.id).expect("load");
        assert_eq!(all[0].turn_state.as_deref(), Some("cancelled"));
        assert!(all[1].turn_state.is_none(), "状态只写在锚点行上");
        let active = db.load_active_messages(&conv.id).expect("active");
        assert_eq!(
            active
                .messages
                .iter()
                .find(|m| m.id == anchor.id)
                .and_then(|m| m.turn_state.clone())
                .as_deref(),
            None,
            "锚点在压缩卡之前 → 该切片里本就不含锚点行"
        );
        let (earlier, _) = db
            .load_earlier_messages(&conv.id, &later.id, 50)
            .expect("earlier");
        assert_eq!(
            earlier.first().and_then(|m| m.turn_state.as_deref()),
            Some("cancelled"),
            "翻页路径漏列会让这里变成 None"
        );

        // 未知字符串不冒充正常结束
        db.set_message_turn_state(&anchor.id, TurnState::Completed)
            .expect("set completed");
        {
            let conn = db.conn.lock().unwrap();
            conn.execute(
                "UPDATE messages SET turn_state = 'whatever' WHERE id = ?1",
                [&anchor.id],
            )
            .expect("inject unknown");
        }
        assert!(
            db.load_messages(&conv.id).expect("load")[0]
                .turn_state
                .is_none(),
            "不认识的收尾状态读回来必须是 None"
        );
        // 不存在的行：不写也不报错（锚点被回滚删除的情形）
        assert!(!db
            .set_message_turn_state("ghost-row", TurnState::Failed)
            .expect("ghost"));
    }

    /// 崩溃的持久证据：回合开始时行上写 `running`，收尾才被终态覆盖。
    /// 下一次在同一会话开新回合时，遗留的 `running` 收敛成 `interrupted`
    /// （崩溃没有机会自己来写），并且**只动本会话**。
    #[test]
    fn begin_turn_state_resolves_stale_running_within_the_conversation() {
        let db = create_test_db();
        let a = db.create_conversation("conn_1", "A").expect("conv a");
        let b = db.create_conversation("conn_1", "B").expect("conv b");
        let save = |conv: &str, text: &str| {
            db.save_message(conv, "user", text, "2026-01-01T00:00:00Z", None, None)
                .expect("msg")
                .id
        };
        let a1 = save(&a.id, "第一轮");
        let b1 = save(&b.id, "另一个会话");
        let state_of = |conv: &str, id: &str| {
            db.load_messages(conv)
                .expect("load")
                .into_iter()
                .find(|m| m.id == id)
                .and_then(|m| m.turn_state)
        };

        db.begin_turn_state(&a.id, &a1).expect("begin a1");
        db.begin_turn_state(&b.id, &b1).expect("begin b1");
        assert_eq!(state_of(&a.id, &a1).as_deref(), Some("running"));

        // A 会话里又开了一轮（上一轮的 running 是上次进程死掉留下的）
        let a2 = save(&a.id, "第二轮");
        db.begin_turn_state(&a.id, &a2).expect("begin a2");
        assert_eq!(
            state_of(&a.id, &a1).as_deref(),
            Some("interrupted"),
            "上一轮的 running 收敛成 interrupted"
        );
        assert_eq!(state_of(&a.id, &a2).as_deref(), Some("running"));
        assert_eq!(
            state_of(&b.id, &b1).as_deref(),
            Some("running"),
            "别的会话的在跑回合不受影响"
        );

        // 收尾覆盖掉 running
        db.set_message_turn_state(&a2, TurnState::Failed)
            .expect("end a2");
        assert_eq!(state_of(&a.id, &a2).as_deref(), Some("failed"));
    }
    /// 列清单不许再被**整份抄回** SQL 字面量里。
    ///
    /// `MESSAGES_COLUMNS` 的意义是「一份清单」：SELECT 列、INSERT 列与占位符、UPSERT
    /// 的 SET 子句都由它拼出来。有人把完整清单粘回某条语句，就等于又开了第二份 ——
    /// 它当下仍是对的，但下一次加列必然漏掉那一处，而且是静默的。
    ///
    /// 实现是**整份源码的裸子串检查**，不是逐行扫：本模块的 SQL 都是多行字面量
    /// （`SELECT` 的列清单与 `FROM messages` 不在同一行），逐行看会恰好漏掉它要拦的
    /// 那种写法 —— 上一版就是逐行的，探针实测全绿。要匹配的模式由 `MESSAGES_COLUMNS`
    /// **派生**（拼一份手写清单来对比，等于又在维护第二份）。
    ///
    /// conversation.rs 拆成目录模块后，生产代码分散在多个文件里，扫描对象改为
    /// 本目录全部文件各自「首个 `#[cfg(test)]` 之前」的部分。测试代码不扫：里面
    /// 有一处 fixture 故意手建旧 schema 表、并插一条只有 7 列的旧版行，那不是
    /// "抄清单"而是"造旧数据"，拿它当违规会把这条护栏变成误报机器。
    ///
    /// **它拦不住什么**（别当万能）：手写的**子集**列清单不报 —— 那可能是合法的
    /// （history.rs 就有 `SELECT id, created_at, rowid FROM messages`），探针实测
    /// 注入前 6 列不会变红。「某条路径漏了列」由
    /// `every_optional_message_field_survives_all_read_paths` 守，不靠这条。
    #[test]
    fn no_literal_message_column_list_in_sql() {
        // 换行归一化：`include_str!` 读的是**文件原始字节**，而 Windows 工作区
        // （`core.autocrlf=true`）检出的是 CRLF，下面这个用 LF 写的切分点就永远匹配
        // 不上 —— 后果不是"少切一段"，而是 production 变成整份文件、测试 fixture 里
        // 那行旧 schema INSERT 被当成违规，护栏固定报红（实测：LF 工作区通过、CRLF 失败）。
        const SOURCES: &[&str] = &[
            include_str!("mod.rs"),
            include_str!("model.rs"),
            include_str!("usage.rs"),
            include_str!("messages.rs"),
            include_str!("history.rs"),
            include_str!("compaction.rs"),
            include_str!("conversations.rs"),
            include_str!("plans.rs"),
            include_str!("test_support.rs"),
        ];
        let production = SOURCES
            .iter()
            .map(|src| {
                src.replace(
                    "
", "
",
                )
                .split(
                    "
#[cfg(test)]",
                )
                .next()
                .expect("include_str 至少有一段")
                .to_string()
            })
            .collect::<Vec<_>>()
            .join(
                "
",
            );

        // 空白归一化后再比对：否则「把清单换行排版」就能绕过（实测放行过）。
        // 归一化不会误伤本文件的 const 定义 —— 那里每个列名带引号，归一化后是
        // `"id", "conversation_id"`，与不带引号的清单串不同。
        fn squeeze(text: &str) -> String {
            text.split_whitespace().collect::<Vec<_>>().join(" ")
        }
        let haystack = squeeze(&production);

        let literal_columns = MESSAGES_COLUMNS.join(", ");
        assert!(
            !haystack.contains(&squeeze(&literal_columns)),
            "源码里出现了 messages 列清单的字面量拷贝（应改用 messages_select_columns()              或 messages_insert_clause() 插值）：{literal_columns}"
        );

        let literal_placeholders = (1..=MESSAGES_COLUMNS.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", ");
        assert!(
            !haystack.contains(&squeeze(&format!("VALUES ({literal_placeholders})"))),
            "源码里出现了手写的占位符清单（应由 messages_insert_clause() 生成）"
        );

        // needle 在运行时拼出来：`include_str!` 会把**本测试自己**也扫进去，把字面量
        // 直接写在这条断言里，它就会命中自己。
        let insert_needle = format!(
            "INSERT INTO messages ({}, conversation_id",
            MESSAGES_COLUMNS[0]
        );
        assert!(
            !haystack.contains(&squeeze(&insert_needle)),
            "源码里出现了手写的 INSERT 列清单（应由 messages_insert_clause() 生成）"
        );
    }
}
