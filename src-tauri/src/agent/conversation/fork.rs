// 会话分叉：把某个回合边界之前的历史整份复制成一条**独立**的新会话。
//
// 要解决的问题：做到一半想去验证另一条路线，又不想让试验污染当前会话的上下文，
// 也不想丢掉任何一边的记录。分叉出来的会话与来源完全独立 —— 各自的消息、图片、
// 子对话、计划、之后的用量都是自己的，删掉任何一边不会波及另一边。
//
// 复制的范围与撤回（`delete_messages_from_timestamp`）同一口径：取到锚点所在回合的
// 末尾（下一条 user/notice 之前）。压缩卡落在范围内就跟着复制，落在范围外就不复制
// （等于「解压」，与撤回到卡前的语义一致），所以归档边界规则不需要为分叉特殊处理。
//
// 这里只管**库里的东西**。内存里的会话级模型/思考档位、记忆快照、复盘进度由命令层
// （`commands::agent_conversation::agent_fork_conversation`）在拿到 [`ForkOutcome`] 后补上 ——
// 它们不归会话库管，也需要 `AppState`。
use std::collections::HashMap;

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use uuid::Uuid;

use super::messages::{StoredMessage, MESSAGES_COLUMNS};
use super::model::Conversation;
use super::usage::ConversationUsage;
use super::ConversationDb;
use crate::agent::task::TurnState;

#[derive(Debug, thiserror::Error)]
pub enum ForkError {
    #[error("会话不存在")]
    NotFound,
    #[error("子 agent 对话不能单独分叉，请回到主对话再分叉")]
    SubConversation,
    #[error("要分叉的位置不在这个会话里")]
    AnchorNotFound,
    #[error("这个回合还在运行，等它结束后再分叉")]
    TailBusy,
    #[error("这个位置之前没有可以复制的消息")]
    Empty,
    #[error("分叉失败：{0}")]
    Db(#[from] rusqlite::Error),
}

/// 锚点的两种定位方式：
/// - [`ById`]：库内消息行 id（会话重载后前端消息的 id 就是它）；
/// - [`ByTurnStart`]：锚点所在回合**首条 user/notice 消息的发送时间**。live
///   回合的前端消息 id 是前端临时 UUID、库内不存在，但时间戳两个域通用
///   （与撤回同一条思路）。取「第一条 `created_at >= ts` 的 user/notice 行」
///   ——该回合的 user 行落库必然晚于前端发送时刻，之前回合的行必然早于它。
pub enum AnchorRef<'a> {
    ById(&'a str),
    ByTurnStart(DateTime<Utc>),
}

/// 一次分叉的结果。
pub struct ForkOutcome {
    /// 新会话的元数据（`forked_from_id` 已指向来源）。
    pub conversation: Conversation,
    /// 来源消息 id → 新会话里对应消息 id（只含主会话的消息，不含子对话）。
    pub id_map: HashMap<String, String>,
    /// 新会话里最后一条被复制的消息（命令层据此把复盘进度接在它后面）。
    pub last_message: (String, DateTime<Utc>),
}

/// 分叉复制到哪里（不含）：锚点所在回合的末尾。`None` = 整个会话。
///
/// 回合边界 = 下一条 `user` / `notice`。**不含 `system`**：压缩卡可能在回合中途
/// 落库（自动压缩），按它切会把一个回合劈成两半。
fn fork_end_index(messages: &[StoredMessage], anchor: Option<&AnchorRef>) -> Result<usize, ForkError> {
    let at = match anchor {
        None => return Ok(messages.len()),
        Some(AnchorRef::ById(id)) => messages
            .iter()
            .position(|m| m.id == *id)
            .ok_or(ForkError::AnchorNotFound)?,
        Some(AnchorRef::ByTurnStart(ts)) => messages
            .iter()
            .position(|m| matches!(m.role.as_str(), "user" | "notice") && m.created_at >= *ts)
            .ok_or(ForkError::AnchorNotFound)?,
    };
    Ok(messages[at + 1..]
        .iter()
        .position(|m| matches!(m.role.as_str(), "user" | "notice"))
        .map(|off| at + 1 + off)
        .unwrap_or(messages.len()))
}

/// 把 plan JSON 里自带的 task id 改成新会话自己的（读取时以行上的 task_id 为准，
/// 这里只是不留一份指向来源的陈旧值）。
fn retarget_plan_json(plan_json: &str, new_task_id: &str) -> String {
    let Ok(mut value) = serde_json::from_str::<serde_json::Value>(plan_json) else {
        return plan_json.to_string();
    };
    if let Some(obj) = value.as_object_mut() {
        for key in ["taskId", "task_id"] {
            if obj.contains_key(key) {
                obj.insert(key.into(), serde_json::Value::String(new_task_id.into()));
            }
        }
    }
    serde_json::to_string(&value).unwrap_or_else(|_| plan_json.to_string())
}

/// 逐行复制消息到新会话，返回 旧 id → 新 id。
///
/// 用 `INSERT … SELECT` 在库内搬运，created_at / timestamp 等原样保留（与写库同源的
/// 原始文本，不经 `DateTime` 往返）；列清单来自 [`MESSAGES_COLUMNS`]，将来加列自动跟着走。
/// 只有 id、会话、图片路径、回合状态四列需要改写。
fn copy_rows(
    conn: &Connection,
    new_conversation_id: &str,
    rows: &[StoredMessage],
    copied_image_dirs: &mut Vec<String>,
) -> Result<HashMap<String, String>, ForkError> {
    let select_list = MESSAGES_COLUMNS
        .iter()
        .map(|c| match *c {
            "id" => "?1",
            "conversation_id" => "?2",
            "image_paths_json" => "?3",
            "turn_state" => "?4",
            other => other,
        })
        .collect::<Vec<_>>()
        .join(", ");
    let mut stmt = conn.prepare(&format!(
        "INSERT INTO messages ({}) SELECT {} FROM messages WHERE id = ?5",
        MESSAGES_COLUMNS.join(", "),
        select_list
    ))?;

    let mut id_map = HashMap::with_capacity(rows.len());
    for m in rows {
        let new_id = Uuid::new_v4().to_string();

        // 图片按会话分桶、删会话整桶删，所以必须真复制。源文件已经丢了的图跳过
        // （原会话里它本来就是裂的）。
        let mut new_images: Vec<String> = Vec::new();
        if let Some(paths) = m
            .image_paths_json
            .as_deref()
            .and_then(|j| serde_json::from_str::<Vec<String>>(j).ok())
        {
            for path in paths {
                match crate::agent::image_store::copy_image(
                    &path,
                    new_conversation_id,
                    &new_id,
                    new_images.len(),
                ) {
                    Ok(rel) => {
                        if !copied_image_dirs.iter().any(|d| d == new_conversation_id) {
                            copied_image_dirs.push(new_conversation_id.to_string());
                        }
                        new_images.push(rel);
                    }
                    Err(e) => log::warn!("分叉时复制图片 {path} 失败，已跳过：{e}"),
                }
            }
        }
        let new_images_json = if new_images.is_empty() {
            None
        } else {
            serde_json::to_string(&new_images).ok()
        };

        // 没有任务在跑这条副本：`running` 只可能是来源遗留的崩溃痕迹，按「中断」带过来。
        let turn_state = match m.turn_state.as_deref() {
            Some(s) if s == TurnState::Running.as_str() => Some(TurnState::Interrupted.as_str()),
            other => other,
        };

        stmt.execute(params![
            new_id,
            new_conversation_id,
            new_images_json,
            turn_state,
            m.id
        ])?;
        id_map.insert(m.id.clone(), new_id);
    }
    Ok(id_map)
}

impl ConversationDb {
    /// 把 `source_id` 的历史（到锚点所在回合末尾，缺省 = 全部）复制成一条
    /// 新会话。`anchor` 的两种定位方式见 [`AnchorRef`]；id 解析不到时由
    /// 调用方决定是否换时间戳重试（这里不串联，两条路的错误口径相同）。
    /// `tail_busy`：来源当前有任务在跑 —— 复制范围到达会话末尾时拒绝，免得拷到
    /// 写了一半的回合；范围在更早的位置则不受影响。
    ///
    /// 整个过程在一个事务里；图片文件是事务外的副作用，失败时会清掉新建的图片目录。
    pub fn fork_conversation(
        &self,
        source_id: &str,
        anchor: Option<&AnchorRef<'_>>,
        title: &str,
        tail_busy: bool,
    ) -> Result<ForkOutcome, ForkError> {
        let mut conn = self.conn.lock().unwrap();

        let (connection_id, source_parent): (String, Option<String>) = conn
            .query_row(
                "SELECT connection_id, parent_conversation_id FROM conversations WHERE id = ?1",
                [source_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => ForkError::NotFound,
                other => ForkError::Db(other),
            })?;
        if source_parent.is_some() {
            return Err(ForkError::SubConversation);
        }

        let messages = Self::query_stored_messages(&conn, source_id, None)?;
        let end = fork_end_index(&messages, anchor)?;
        if end == 0 {
            return Err(ForkError::Empty);
        }
        if end == messages.len() && tail_busy {
            return Err(ForkError::TailBusy);
        }
        let copied = &messages[..end];
        // 排除区的第一行：计划快照只取它之前产生的（之后的是「未来」）。
        let bound = messages.get(end).map(|m| m.created_at.to_rfc3339());

        let new_id = Uuid::new_v4().to_string();
        let now = Utc::now();
        let now_str = now.to_rfc3339();
        let mut image_dirs: Vec<String> = Vec::new();

        let result = (|| -> Result<HashMap<String, String>, ForkError> {
            let tx = conn.transaction()?;
            tx.execute(
                "INSERT INTO conversations
                    (id, connection_id, title, created_at, updated_at, parent_conversation_id, forked_from_id)
                 VALUES (?1, ?2, ?3, ?4, ?4, NULL, ?5)",
                params![new_id, connection_id, title, now_str, source_id],
            )?;
            let id_map = copy_rows(&tx, &new_id, copied, &mut image_dirs)?;

            // 子对话：被复制的消息里引用到的才复制。必须深拷贝 —— 删来源会级联删掉它的
            // 子对话，共用的话分叉里的子 agent 卡片就全打不开了。
            let children: Vec<(String, String, String, String)> = {
                let mut stmt = tx.prepare(
                    "SELECT id, title, created_at, updated_at FROM conversations
                     WHERE parent_conversation_id = ?1",
                )?;
                let rows = stmt
                    .query_map([source_id], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            for (child_id, child_title, child_created, child_updated) in children {
                let referenced = copied.iter().any(|m| {
                    m.content.contains(&child_id)
                        || m.tool_calls_json
                            .as_deref()
                            .is_some_and(|j| j.contains(&child_id))
                });
                if !referenced {
                    continue;
                }
                let new_child_id = Uuid::new_v4().to_string();
                tx.execute(
                    "INSERT INTO conversations
                        (id, connection_id, title, created_at, updated_at, parent_conversation_id)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![
                        new_child_id,
                        connection_id,
                        child_title,
                        child_created,
                        child_updated,
                        new_id
                    ],
                )?;
                let child_rows = Self::query_stored_messages(&tx, &child_id, None)?;
                copy_rows(&tx, &new_child_id, &child_rows, &mut image_dirs)?;
                tx.execute(
                    "UPDATE messages
                     SET tool_calls_json = REPLACE(tool_calls_json, ?1, ?2),
                         content = REPLACE(content, ?1, ?2)
                     WHERE conversation_id = ?3",
                    params![child_id, new_child_id, new_id],
                )?;
            }

            // 计划：截止到分叉点的快照整串带过来（任务 id 重新发，plans 以 task_id 为主键），
            // 最后一条同时作为当前计划。这样在分叉里再撤回，也能按快照恢复。
            let snapshots: Vec<(String, String, String)> = {
                let sql = match &bound {
                    Some(_) => {
                        "SELECT task_id, plan_json, created_at FROM plan_snapshots
                         WHERE conversation_id = ?1 AND created_at < ?2
                         ORDER BY created_at ASC, id ASC"
                    }
                    None => {
                        "SELECT task_id, plan_json, created_at FROM plan_snapshots
                         WHERE conversation_id = ?1 AND ?2 IS NULL
                         ORDER BY created_at ASC, id ASC"
                    }
                };
                let mut stmt = tx.prepare(sql)?;
                let rows = stmt
                    .query_map(params![source_id, bound], |r| {
                        Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                    })?
                    .collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            let mut task_ids: HashMap<String, String> = HashMap::new();
            let mut latest_plan: Option<(String, String, String)> = None;
            for (task_id, plan_json, created_at) in snapshots {
                let new_task_id = task_ids
                    .entry(task_id)
                    .or_insert_with(|| Uuid::new_v4().to_string())
                    .clone();
                let plan_json = retarget_plan_json(&plan_json, &new_task_id);
                tx.execute(
                    "INSERT INTO plan_snapshots (conversation_id, task_id, plan_json, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![new_id, new_task_id, plan_json, created_at],
                )?;
                latest_plan = Some((new_task_id, plan_json, created_at));
            }
            if latest_plan.is_none() && bound.is_none() {
                // 没有快照体系的旧数据：整份复制时把当前计划带上，局部分叉不碰。
                let current: Option<(String, String)> = tx
                    .query_row(
                        "SELECT plan_json, updated_at FROM plans WHERE conversation_id = ?1
                         ORDER BY updated_at DESC LIMIT 1",
                        [source_id],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .ok();
                if let Some((plan_json, updated_at)) = current {
                    let new_task_id = Uuid::new_v4().to_string();
                    latest_plan = Some((
                        new_task_id.clone(),
                        retarget_plan_json(&plan_json, &new_task_id),
                        updated_at,
                    ));
                }
            }
            if let Some((task_id, plan_json, updated_at)) = latest_plan {
                tx.execute(
                    "INSERT INTO plans (task_id, conversation_id, plan_json, updated_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![task_id, new_id, plan_json, updated_at],
                )?;
            }

            tx.commit()?;
            Ok(id_map)
        })();

        let id_map = match result {
            Ok(map) => map,
            Err(e) => {
                drop(conn);
                for dir in image_dirs {
                    crate::agent::image_store::delete_conversation_images(&dir);
                }
                return Err(e);
            }
        };

        let last = copied.last().expect("end > 0");
        let last_new_id = id_map
            .get(&last.id)
            .cloned()
            .expect("每条被复制的消息都有映射");
        Ok(ForkOutcome {
            conversation: Conversation {
                id: new_id,
                connection_id,
                title: title.to_string(),
                created_at: now,
                updated_at: now,
                parent_conversation_id: None,
                forked_from_id: Some(source_id.to_string()),
                model_id: None,
                reasoning_effort: None,
                pinned: false,
                usage: ConversationUsage::default(),
                context_window: None,
                archived_at: None,
            },
            id_map,
            last_message: (last_new_id, last.created_at),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::create_test_db;

    /// 造 u1 a1 t1 a1b | u2 a2 两个回合，返回 (会话 id, 全部消息)。
    fn seed_two_turns(db: &ConversationDb) -> (String, Vec<StoredMessage>) {
        let conv = db.create_conversation("conn_1", "原会话").expect("conv");
        for (i, (role, content)) in [
            ("user", "第一个需求"),
            ("assistant", "先查一下"),
            ("tool", "查询结果"),
            ("assistant", "第一个需求完成"),
            ("user", "第二个需求"),
            ("assistant", "第二个需求完成"),
        ]
        .iter()
        .enumerate()
        {
            db.save_message(
                &conv.id,
                role,
                content,
                &format!("2026-01-01T00:0{i}:00Z"),
                None,
                None,
            )
            .expect("msg");
        }
        let rows = db.load_messages(&conv.id).expect("rows");
        (conv.id, rows)
    }

    #[test]
    fn end_index_snaps_to_turn_end_and_ignores_system_rows() {
        let db = create_test_db();
        let (_, rows) = seed_two_turns(&db);
        assert_eq!(fork_end_index(&rows, None).unwrap(), 6);
        // 锚点在第一个回合中间（tool）→ 取到该回合末尾（第二个 user 之前）
        assert_eq!(fork_end_index(&rows, Some(&AnchorRef::ById(&rows[2].id))).unwrap(), 4);
        // 锚点就是回合首条 user → 同样取整个回合
        assert_eq!(fork_end_index(&rows, Some(&AnchorRef::ById(&rows[0].id))).unwrap(), 4);
        // 最后一个回合 → 到末尾
        assert_eq!(fork_end_index(&rows, Some(&AnchorRef::ById(&rows[4].id))).unwrap(), 6);
        assert!(matches!(
            fork_end_index(&rows, Some(&AnchorRef::ById("ghost"))),
            Err(ForkError::AnchorNotFound)
        ));

        // 回合中途的压缩卡（system）不算回合边界
        let mut with_card = rows.clone();
        let mut card = rows[2].clone();
        card.id = "card".into();
        card.role = "system".into();
        with_card.insert(3, card);
        assert_eq!(fork_end_index(&with_card, Some(&AnchorRef::ById(&rows[0].id))).unwrap(), 5);
    }

    #[test]
    fn fork_copies_up_to_turn_end_with_fresh_ids_and_leaves_source_alone() {
        let db = create_test_db();
        let (src, rows) = seed_two_turns(&db);

        let out = db
            .fork_conversation(&src, Some(&AnchorRef::ById(&rows[3].id)), "原会话 · 分支", true)
            .expect("fork");
        assert_eq!(
            out.conversation.forked_from_id.as_deref(),
            Some(src.as_str())
        );
        assert!(out.conversation.parent_conversation_id.is_none());

        let forked = db.load_messages(&out.conversation.id).expect("load fork");
        assert_eq!(forked.len(), 4);
        for (orig, copy) in rows.iter().zip(&forked) {
            assert_ne!(orig.id, copy.id);
            assert_eq!(orig.role, copy.role);
            assert_eq!(orig.content, copy.content);
            assert_eq!(orig.timestamp, copy.timestamp);
            assert_eq!(orig.created_at, copy.created_at);
            assert_eq!(out.id_map.get(&orig.id), Some(&copy.id));
        }
        assert_eq!(out.last_message.0, forked[3].id);

        // 来源原封不动
        assert_eq!(db.load_messages(&src).unwrap().len(), 6);

        // 会话库里有它，且能读回分叉来源
        let meta = db.get_conversation(&out.conversation.id).unwrap().unwrap();
        assert_eq!(meta.forked_from_id.as_deref(), Some(src.as_str()));
        assert_eq!(meta.title, "原会话 · 分支");
    }

    #[test]
    fn tail_busy_only_blocks_forks_that_reach_the_end() {
        let db = create_test_db();
        let (src, rows) = seed_two_turns(&db);
        assert!(matches!(
            db.fork_conversation(&src, None, "t", true),
            Err(ForkError::TailBusy)
        ));
        assert!(matches!(
            db.fork_conversation(&src, Some(&AnchorRef::ById(&rows[4].id)), "t", true),
            Err(ForkError::TailBusy)
        ));
        // 更早的回合不受影响（尾巴在跑，但复制范围到不了它）
        assert!(db
            .fork_conversation(&src, Some(&AnchorRef::ById(&rows[0].id)), "t", true)
            .is_ok());
        // 没在跑就都能分
        assert!(db.fork_conversation(&src, None, "t", false).is_ok());
    }

    /// 时间戳锚点：live 回合的前端消息 id 在库里不存在，拿「回合首条 user 消息
    /// 的发送时刻」定位。第一条 `created_at >= ts` 的 user/notice 行就是那个
    /// 回合的锚点行——它落库必然晚于发送时刻，之前回合的行必然早于它。
    #[test]
    fn by_turn_start_resolves_the_turn_and_snaps_to_its_end() {
        let db = create_test_db();
        let (src, rows) = seed_two_turns(&db);

        // 锚点在第一个回合：ts = 该回合首条 user 行的 created_at（前端发送时刻
        // 早于等于它，取等值同样命中该行）
        let t1 = rows[0].created_at;
        let out = db
            .fork_conversation(&src, Some(&AnchorRef::ByTurnStart(t1)), "t", false)
            .expect("fork turn 1");
        assert_eq!(db.load_messages(&out.conversation.id).unwrap().len(), 4);

        // 锚点在第二个回合：ts 落在第一回合 assistant 行之后（用户还没发第二条
        // 之前的任意时刻都能把解析带到第二回合的 user 行）
        let t2 = rows[4].created_at;
        let out = db
            .fork_conversation(&src, Some(&AnchorRef::ByTurnStart(t2)), "t", false)
            .expect("fork turn 2");
        assert_eq!(db.load_messages(&out.conversation.id).unwrap().len(), 6);

        // 复制范围与 id 锚点同口径：都吸附到回合末尾
        let by_id = db
            .fork_conversation(&src, Some(&AnchorRef::ById(&rows[2].id)), "t", false)
            .unwrap();
        assert_eq!(
            db.load_messages(&by_id.conversation.id).unwrap().len(),
            db.load_messages(
                &db.fork_conversation(&src, Some(&AnchorRef::ByTurnStart(t1)), "t", false)
                    .unwrap()
                    .conversation
                    .id
            )
            .unwrap()
            .len()
        );

        // ts 晚于所有行：解析不到 → AnchorNotFound（不是静默分出整个会话）
        let beyond = t2 + chrono::Duration::hours(1);
        assert!(matches!(
            db.fork_conversation(&src, Some(&AnchorRef::ByTurnStart(beyond)), "t", false),
            Err(ForkError::AnchorNotFound)
        ));
    }

    #[test]
    fn sub_conversations_and_unknown_sources_are_rejected() {
        let db = create_test_db();
        assert!(matches!(
            db.fork_conversation("ghost", None, "t", false),
            Err(ForkError::NotFound)
        ));
        let (src, _) = seed_two_turns(&db);
        let sub = db
            .create_sub_conversation("conn_1", "sub", &src)
            .expect("sub");
        assert!(matches!(
            db.fork_conversation(&sub.id, None, "t", false),
            Err(ForkError::SubConversation)
        ));
        let empty = db.create_conversation("conn_1", "空").unwrap();
        assert!(matches!(
            db.fork_conversation(&empty.id, None, "t", false),
            Err(ForkError::Empty)
        ));
    }

    #[test]
    fn running_turn_state_is_carried_as_interrupted() {
        let db = create_test_db();
        let (src, rows) = seed_two_turns(&db);
        db.set_message_turn_state(&rows[0].id, TurnState::Completed)
            .unwrap();
        db.set_message_turn_state(&rows[4].id, TurnState::Running)
            .unwrap();
        let out = db.fork_conversation(&src, None, "t", false).unwrap();
        let forked = db.load_messages(&out.conversation.id).unwrap();
        assert_eq!(forked[0].turn_state.as_deref(), Some("completed"));
        assert_eq!(forked[4].turn_state.as_deref(), Some("interrupted"));
    }

    #[test]
    fn images_are_copied_so_deleting_the_source_keeps_the_fork_intact() {
        let _guard = crate::agent::image_store::test_lock();
        let dir = tempfile::tempdir().unwrap();
        crate::agent::image_store::init(dir.path());
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "带图").unwrap();
        let rel =
            crate::agent::image_store::save_image_bytes(&conv.id, "m1", 0, b"fake-webp").unwrap();
        db.save_message_with_images(
            &conv.id,
            "user",
            "看图",
            "2026-01-01T00:00:00Z",
            None,
            None,
            Some(&serde_json::to_string(&vec![rel.clone()]).unwrap()),
        )
        .unwrap();
        db.save_message(
            &conv.id,
            "assistant",
            "看到了",
            "2026-01-01T00:01:00Z",
            None,
            None,
        )
        .unwrap();

        let out = db.fork_conversation(&conv.id, None, "t", false).unwrap();
        let forked = db.load_messages(&out.conversation.id).unwrap();
        let paths: Vec<String> =
            serde_json::from_str(forked[0].image_paths_json.as_deref().unwrap()).unwrap();
        assert_eq!(paths.len(), 1);
        assert_ne!(paths[0], rel);
        assert!(paths[0].starts_with(&out.conversation.id));

        db.delete_conversation_cascade(&conv.id).unwrap();
        assert!(crate::agent::image_store::read_image_data_url(&paths[0]).is_ok());
        assert!(crate::agent::image_store::read_image_data_url(&rel).is_err());
    }

    #[test]
    fn referenced_sub_conversations_are_deep_copied_and_relinked() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "主").unwrap();
        let sub = db
            .create_sub_conversation("conn_1", "调研", &conv.id)
            .unwrap();
        let unrelated = db
            .create_sub_conversation("conn_1", "没引用", &conv.id)
            .unwrap();
        db.save_message(
            &sub.id,
            "assistant",
            "子对话里的结论",
            "2026-01-01T00:00:30Z",
            None,
            None,
        )
        .unwrap();
        db.save_message(
            &conv.id,
            "user",
            "去调研",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .unwrap();
        db.save_message(
            &conv.id,
            "assistant",
            "派发了",
            "2026-01-01T00:01:00Z",
            Some(&format!(
                r#"[{{"metadata":{{"subConversationId":"{}"}}}}]"#,
                sub.id
            )),
            None,
        )
        .unwrap();

        let out = db.fork_conversation(&conv.id, None, "t", false).unwrap();
        let forked = db.load_messages(&out.conversation.id).unwrap();
        let tool_json = forked[1].tool_calls_json.clone().unwrap();
        assert!(
            !tool_json.contains(&sub.id),
            "引用必须改指向分叉自己的子对话"
        );
        let new_sub_id = db
            .list_conversations("conn_1")
            .unwrap()
            .into_iter()
            .find(|c| c.parent_conversation_id.as_deref() == Some(out.conversation.id.as_str()))
            .expect("子对话已复制")
            .id;
        assert!(tool_json.contains(&new_sub_id));
        assert_eq!(db.load_messages(&new_sub_id).unwrap().len(), 1);

        // 没被引用的子对话不复制
        let copied_subs = db
            .list_conversations("conn_1")
            .unwrap()
            .into_iter()
            .filter(|c| c.parent_conversation_id.as_deref() == Some(out.conversation.id.as_str()))
            .count();
        assert_eq!(copied_subs, 1);
        let _ = unrelated;

        // 删来源（级联删子对话）后，分叉的子对话还在
        db.delete_conversation_cascade(&conv.id).unwrap();
        assert_eq!(db.load_messages(&new_sub_id).unwrap().len(), 1);
    }

    #[test]
    fn plan_snapshots_before_the_cut_are_copied_with_new_task_ids() {
        let db = create_test_db();
        let (src, rows) = seed_two_turns(&db);
        // 快照时间要夹在两个回合之间才有区分度：直接按行时间造
        let t_in = rows[1].created_at.to_rfc3339();
        let t_out = rows[5].created_at.to_rfc3339();
        {
            let conn = db.conn.lock().unwrap();
            for (task, json, at) in [
                ("task-a", r#"{"taskId":"task-a","items":["第一版"]}"#, &t_in),
                (
                    "task-b",
                    r#"{"taskId":"task-b","items":["第二版"]}"#,
                    &t_out,
                ),
            ] {
                conn.execute(
                    "INSERT INTO plan_snapshots (conversation_id, task_id, plan_json, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![src, task, json, at],
                )
                .unwrap();
            }
        }
        let out = db
            .fork_conversation(&src, Some(&AnchorRef::ById(&rows[0].id)), "t", false)
            .unwrap();
        let snaps = db
            .load_plan_snapshot_before(&out.conversation.id, "9999")
            .unwrap();
        let (task_id, plan_json) = snaps.expect("快照已复制");
        assert_ne!(task_id, "task-a");
        assert!(plan_json.contains("第一版"));
        assert!(plan_json.contains(&task_id));
        // 分叉点之后的快照不带
        assert!(!plan_json.contains("第二版"));
        let plans = db.load_plans_by_conversation(&out.conversation.id).unwrap();
        assert_eq!(plans.len(), 1);
        assert_eq!(plans[0].0, task_id);
    }

    #[test]
    fn deleting_the_source_clears_the_fork_link_but_keeps_the_fork() {
        let db = create_test_db();
        let (src, _) = seed_two_turns(&db);
        let out = db.fork_conversation(&src, None, "t", false).unwrap();
        db.delete_conversation_cascade(&src).unwrap();
        let meta = db.get_conversation(&out.conversation.id).unwrap().unwrap();
        assert!(meta.forked_from_id.is_none());
        assert_eq!(db.load_messages(&out.conversation.id).unwrap().len(), 6);
    }
}
