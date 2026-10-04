// 历史回读（agent 侧只读入口）：概览、窗口内检索、锚点回读、派发上界、子对话清单。
// 窗口把「子代理可读的父会话范围」表达成行序位置；归档边界 = 最新一张压缩卡。
use chrono::Utc;
use rusqlite::{Connection, OptionalExtension, Result as RusqliteResult};
use serde::{Deserialize, Serialize};

use super::ConversationDb;
use crate::agent::conversation_persister::COMPACTION_CARD_PREFIX;

use super::messages::messages_select_columns;
use super::model::SubConversationInfo;
use super::StoredMessage;
use super::{escape_like, make_match_snippet};

// ───────────────────── 历史回读（agent 侧只读入口） ─────────────────────
//
// 压缩从不删原文：它只把一段历史从**内存里**的 LLM 消息数组里 splice 掉、
// 换上一张 `【上下文已压缩】` 卡片行，并吸收掉上一张卡。原文照常躺在 `messages`
// 表里（用户往上滚就能看到），所以「读回被压掉的原文」只是给已有数据加一个只读
// 入口 —— 不新增表、不新增列、不迁移。
//
// 归档边界复用既有的那条规则：**最新一张压缩卡之前的行 = 归档原文，卡片及之后 =
// 当前上下文**。压缩恒从头部开始 ⇒ 新卡必然吸收旧卡 ⇒ 一个会话在任何时刻最多一张卡。
//
// 但别把"复用"读成"收敛"：这条规则在仓库里是**多处各写一遍**的等价实现 ——
//   · 共享的只有卡片前缀常量 `COMPACTION_CARD_PREFIX`（写卡与认卡一处定义）；
//   · 定位边界卡的 SQL 有两份：`load_active_messages` 与 `boundary_card`；
//   · `(created_at, rowid)` 行序比较在 SQL 片段里 6 处、Rust 里 2 处各写一遍；
//   · 前端还有自己的一份等价信号：`compaction?.status === 'done'`（从 DB 重载时
//     `parseCompactionSummary` 会把带前缀的行强制置成 done，两套信号因此等价，
//     由 `messageConversion.test.ts` 与 `conversationStore.test.ts` 钉住）。
// 改这条规则时这几处必须一起想，见各处交叉引用注释。

/// 行序游标：`messages` 的 `(created_at ASC, rowid ASC)` 位置。
/// 与 `load_earlier_messages` 用的是同一套比较语义。
#[derive(Debug, Clone, PartialEq, Eq)]
struct MsgPos {
    created_at: String,
    rowid: i64,
}

impl MsgPos {
    /// 是否严格早于另一位置（决定行序的完整比较）。
    fn before(&self, other: &MsgPos) -> bool {
        (self.created_at.as_str(), self.rowid) < (other.created_at.as_str(), other.rowid)
    }
}

/// 归档边界的那张压缩卡（带行序位置）。
#[derive(Debug, Clone)]
struct BoundaryCard {
    id: String,
    created_at: String,
    rowid: i64,
    timestamp: String,
    content: String,
}

/// 回读窗口的下界起点。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowStart {
    /// 不限下界（从会话最早一条开始）。
    Earliest,
    /// 从该会话**读取那一刻**的最新压缩卡所在行开始（含卡片本身）。
    ///
    /// 子代理读父会话用这个：父会话之后再压缩只会让窗口变小 —— 那仍然只含
    /// 主 agent 当前上下文里有的部分，且**永远不会漏进归档原文**，也不会
    /// 因为旧卡被新卡吸收而锚点失效（下界是读时现算的，不是派发时冻结的）。
    LatestCard,
}

/// 回读窗口（**闭区间**）：`start` 是下界，`upto_message_id` 是上界（含该行）。
/// 两端都表达成"行序位置"，调用方不必懂 `(created_at, rowid)` 那套比较规则。
#[derive(Debug, Clone)]
pub struct HistoryWindow {
    pub start: WindowStart,
    /// 上界：这条消息所在行（含）。`None` = 不限（到会话最新一条）。
    /// 子代理读父会话时冻结在"派发那一刻"的最后一条已落库消息上。
    pub upto_message_id: Option<String>,
}

/// 已解析成行序位置的窗口。
#[derive(Debug, Clone, Default)]
struct ResolvedWindow {
    from: Option<MsgPos>,
    upto: Option<MsgPos>,
}

impl ResolvedWindow {
    /// 绑定用的四个值（None → SQL 里的 NULL → 该侧不限）。
    fn bindings(&self) -> (Option<&str>, Option<i64>, Option<&str>, Option<i64>) {
        (
            self.from.as_ref().map(|p| p.created_at.as_str()),
            self.from.as_ref().map(|p| p.rowid),
            self.upto.as_ref().map(|p| p.created_at.as_str()),
            self.upto.as_ref().map(|p| p.rowid),
        )
    }

    /// 位置是否落在窗口内（锚点越界要**明确报错**，不能静默返回空）。
    fn contains(&self, pos: &MsgPos) -> bool {
        if let Some(from) = &self.from {
            if pos.before(from) {
                return false;
            }
        }
        if let Some(upto) = &self.upto {
            if upto.before(pos) {
                return false;
            }
        }
        true
    }

    /// 窗口是不是**空区间**（两端都有位置、且上界排在下界之前）。
    ///
    /// 任一端为 `None` = 那一侧不限 ⇒ 永远不空。所以只有 `scope=parent` 能触发：
    /// 主 agent 在派发之后又压缩过，新卡排到了"派发那一刻"的冻结上界之后。
    /// 空区间在语义上是**正确**的（整段都落在最新卡之前 = 归档），错的只是报告方式 ——
    /// 检索会静默给"没有命中"、回读会报"这条不在窗口内"，都让 agent 误以为历史里没有。
    fn is_empty(&self) -> bool {
        match (&self.from, &self.upto) {
            (Some(from), Some(upto)) => upto.before(from),
            _ => false,
        }
    }
}

/// 窗口条件的 SQL 片段。`:win_*` 为 NULL 时对应侧短路为真。
/// 列名带 `messages.` 前缀：调用方可能把它拼进带 JOIN 的查询。
const HISTORY_WINDOW_SQL: &str = "
      AND (:win_from_created IS NULL
           OR messages.created_at > :win_from_created
           OR (messages.created_at = :win_from_created AND messages.rowid >= :win_from_rowid))
      AND (:win_upto_created IS NULL
           OR messages.created_at < :win_upto_created
           OR (messages.created_at = :win_upto_created AND messages.rowid <= :win_upto_rowid))";

/// 一条消息的轻量标识（回读概览与检索命中用）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MsgBrief {
    pub id: String,
    pub role: String,
    pub timestamp: String,
}

/// 归档边界的压缩卡。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardBrief {
    pub id: String,
    pub timestamp: String,
    /// 卡片正文（含 `已整理 N 条历史消息（约 M tokens）` 与摘要全文）。
    pub content: String,
}

/// 本会话历史概览（需求：agent 得先知道"前面还有什么"）。
///
/// 所有计数与 id 都限定在**本次可读窗口内**：`scope=parent` 时窗口之外的东西
/// 一律不出现，免得给 agent 一串拿去做 `action=read` 必然失败的死 id。
/// 窗口外还有多少不告诉它不行 —— 那会让它以为"会话就这么多" —— 所以有
/// [`Self::hidden_before_window`]。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryOverview {
    /// 窗口内的总条数
    pub total: i64,
    /// 窗口内、边界卡之前的条数（= 归档段）；窗口内无卡 = 0
    pub archived: i64,
    /// 窗口内剩下的部分 = total - archived
    pub active: i64,
    pub oldest: Option<MsgBrief>,
    pub newest: Option<MsgBrief>,
    /// 归档段最后一条（配合 `oldest` 给出归档段的时间范围）
    pub archived_newest: Option<MsgBrief>,
    /// 归档边界 = 最新一张压缩卡，**且它落在窗口内**；无卡 / 卡在窗口外 = None
    pub boundary_card: Option<CardBrief>,
    /// 严格早于窗口下界的行数（"你看不到的那部分"）。非窗口路径恒为 0；
    /// `scope=parent` 下 > 0 表示有归档原文不在这个子代理的可读范围里。
    pub hidden_before_window: i64,
}

/// 检索命中（需求：返回可挑选的短清单，不是把历史倒出来）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryHit {
    pub id: String,
    pub role: String,
    pub timestamp: String,
    /// 命中处前后约 50 字的片段
    pub snippet: String,
}

/// 一次定向回读的结果。
#[derive(Debug, Clone)]
pub struct HistoryRead {
    /// 按时间升序（锚点前若干条 + 锚点 + 锚点后若干条）
    pub messages: Vec<StoredMessage>,
    /// 锚点之前（窗口内）是否还有更多
    pub has_more_before: bool,
    /// 锚点之后（窗口内）是否还有更多
    pub has_more_after: bool,
}

/// 历史回读的错误。**必须与「查不到」区分开**：静默返回空会让 agent 以为
/// "历史里没有这段内容"，从而做出错误判断。
#[derive(Debug)]
pub enum HistoryError {
    Db(rusqlite::Error),
    /// 引用的行不存在：已被撤回删除，或旧压缩卡已被新卡吸收
    Missing(String),
    /// 引用的行存在，但不在本次可读窗口内（例如子代理去读被压缩掉的归档原文）
    OutOfWindow(String),
    /// 整个可读窗口是**空区间**：范围里一条都没有。
    ///
    /// 与 `OutOfWindow` 分开是因为"这条路走不通"与"锅里本来就没有"是两件事：
    /// 前者让 agent 换个锚点，后者要它换一条路（找主 agent 或直接问用户）。
    /// 无载荷 —— 它不是某条消息的问题，是整个范围的问题。
    EmptyWindow,
}

impl std::fmt::Display for HistoryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Db(e) => write!(f, "history read db error: {e}"),
            Self::Missing(id) => write!(f, "message not found: {id}"),
            Self::OutOfWindow(id) => write!(f, "message out of readable window: {id}"),
            Self::EmptyWindow => write!(f, "readable window is empty"),
        }
    }
}

impl From<rusqlite::Error> for HistoryError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Db(e)
    }
}

impl ConversationDb {
    // ───────────────────── 历史回读（只读，agent 侧入口） ─────────────────────
    //
    // 每个方法都是「一次持锁 + 一个事务」把「解析锚点/窗口」与「取行」做完：
    // 压缩只可能在整次回读之前或之后发生，不会出现锚点用旧卡、取行用新卡的
    // 半新半旧拼接。工具侧每个 action 只调一个方法，同理。

    /// 本会话历史概览：窗口内总数、归档段（边界卡之前）条数与时间范围、边界卡、
    /// 以及窗口之外还有多少条。
    ///
    /// `window = None` 与加这个参数之前**逐字节相同**（`HISTORY_WINDOW_SQL` 的四段
    /// 条件在两端为 NULL 时全部短路为真，且 `hidden_before_window` 恒为 0）。
    pub fn history_overview(
        &self,
        conversation_id: &str,
        window: Option<&HistoryWindow>,
    ) -> Result<HistoryOverview, HistoryError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let win = Self::resolve_history_window(&tx, conversation_id, window)?;
        let (fc, fr, uc, ur) = win.bindings();

        let total: i64 = tx.query_row(
            &format!(
                "SELECT COUNT(*) FROM messages
                 WHERE conversation_id = :conv {HISTORY_WINDOW_SQL}"
            ),
            rusqlite::named_params! {
                ":conv": conversation_id,
                ":win_from_created": fc,
                ":win_from_rowid": fr,
                ":win_upto_created": uc,
                ":win_upto_rowid": ur,
            },
            |r| r.get(0),
        )?;
        let oldest = Self::boundary_message(&tx, conversation_id, true, &win)?;
        let newest = Self::boundary_message(&tx, conversation_id, false, &win)?;
        // 边界卡只有在**落在窗口内**时才报：窗口为空时（父会话在派发后又压过）
        // 那张卡排在冻结上界之后，报出去就是一串读不到的 id —— 正是要修的缺陷类。
        let card = Self::boundary_card(&tx, conversation_id)?.filter(|c| {
            win.contains(&MsgPos {
                created_at: c.created_at.clone(),
                rowid: c.rowid,
            })
        });

        let (archived, archived_newest) = match &card {
            Some(card) => {
                let count: i64 = tx.query_row(
                    &format!(
                        "SELECT COUNT(*) FROM messages
                         WHERE conversation_id = :conv
                           AND (messages.created_at < :card_created
                                OR (messages.created_at = :card_created
                                    AND messages.rowid < :card_rowid))
                           {HISTORY_WINDOW_SQL}"
                    ),
                    rusqlite::named_params! {
                        ":conv": conversation_id,
                        ":card_created": card.created_at,
                        ":card_rowid": card.rowid,
                        ":win_from_created": fc,
                        ":win_from_rowid": fr,
                        ":win_upto_created": uc,
                        ":win_upto_rowid": ur,
                    },
                    |r| r.get(0),
                )?;
                let last = tx
                    .query_row(
                        &format!(
                            "SELECT id, role, timestamp FROM messages
                             WHERE conversation_id = :conv
                               AND (messages.created_at < :card_created
                                    OR (messages.created_at = :card_created
                                        AND messages.rowid < :card_rowid))
                               {HISTORY_WINDOW_SQL}
                             ORDER BY created_at DESC, rowid DESC LIMIT 1"
                        ),
                        rusqlite::named_params! {
                            ":conv": conversation_id,
                            ":card_created": card.created_at,
                            ":card_rowid": card.rowid,
                            ":win_from_created": fc,
                            ":win_from_rowid": fr,
                            ":win_upto_created": uc,
                            ":win_upto_rowid": ur,
                        },
                        |r| {
                            Ok(MsgBrief {
                                id: r.get(0)?,
                                role: r.get(1)?,
                                timestamp: r.get(2)?,
                            })
                        },
                    )
                    .optional()?;
                (count, last)
            }
            None => (0, None),
        };

        // 窗口之外（更早）还有多少：不报的话 agent 会以为"会话就这么多"。
        let hidden_before_window: i64 = match win.from.as_ref() {
            Some(from) => tx.query_row(
                "SELECT COUNT(*) FROM messages
                 WHERE conversation_id = ?1
                   AND (created_at < ?2 OR (created_at = ?2 AND rowid < ?3))",
                rusqlite::params![conversation_id, from.created_at, from.rowid],
                |r| r.get(0),
            )?,
            None => 0,
        };

        let overview = HistoryOverview {
            total,
            archived,
            active: total - archived,
            oldest,
            newest,
            archived_newest,
            boundary_card: card.as_ref().map(|c| CardBrief {
                id: c.id.clone(),
                timestamp: c.timestamp.clone(),
                content: c.content.clone(),
            }),
            hidden_before_window,
        };
        tx.finish()?;
        Ok(overview)
    }

    /// 在窗口内按关键词检索（大小写不敏感子串），返回按时间升序的命中清单。
    /// 空关键词返回空列表。
    pub fn search_history(
        &self,
        conversation_id: &str,
        keyword: &str,
        window: Option<&HistoryWindow>,
        limit: usize,
    ) -> Result<Vec<HistoryHit>, HistoryError> {
        let keyword = keyword.trim();
        if keyword.is_empty() {
            return Ok(vec![]);
        }
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let win = Self::resolve_history_window(&tx, conversation_id, window)?;
        // 空窗口放行到 SQL 会静默返回 0 行，工具渲染成"没有命中" —— agent 据此
        // 断定"历史里没有这段内容"，而事实是整个范围都读不到。必须明确报错。
        if win.is_empty() {
            return Err(HistoryError::EmptyWindow);
        }
        let (fc, fr, uc, ur) = win.bindings();
        let pattern = format!("%{}%", escape_like(keyword));
        let sql = format!(
            "SELECT id, role, content, timestamp FROM messages
             WHERE conversation_id = :conv
               AND content LIKE :pattern ESCAPE '\\' COLLATE NOCASE
               {HISTORY_WINDOW_SQL}
             ORDER BY created_at ASC, rowid ASC
             LIMIT :limit"
        );
        let hits = {
            let mut stmt = tx.prepare(&sql)?;
            let rows = stmt
                .query_map(
                    rusqlite::named_params! {
                        ":conv": conversation_id,
                        ":pattern": pattern,
                        ":limit": limit as i64,
                        ":win_from_created": fc,
                        ":win_from_rowid": fr,
                        ":win_upto_created": uc,
                        ":win_upto_rowid": ur,
                    },
                    |row| {
                        let content: String = row.get(2)?;
                        Ok(HistoryHit {
                            id: row.get(0)?,
                            role: row.get(1)?,
                            timestamp: row.get(3)?,
                            snippet: make_match_snippet(&content, keyword),
                        })
                    },
                )?
                .collect::<RusqliteResult<Vec<_>>>()?;
            rows
        };
        tx.finish()?;
        Ok(hits)
    }

    /// 以某条消息（或某张压缩卡）为锚点定向取原文：前 `before` 条 + 锚点本身 +
    /// 后 `after` 条，全部限定在窗口内。
    ///
    /// 锚点不在窗口内 → [`HistoryError::OutOfWindow`]；锚点不存在（已被撤回删除、
    /// 或旧卡被新卡吸收）→ [`HistoryError::Missing`]。两者都**不返回空列表**。
    pub fn read_history(
        &self,
        conversation_id: &str,
        window: Option<&HistoryWindow>,
        anchor_id: &str,
        before: usize,
        after: usize,
    ) -> Result<HistoryRead, HistoryError> {
        let conn = self.conn.lock().unwrap();
        let tx = conn.unchecked_transaction()?;
        let win = Self::resolve_history_window(&tx, conversation_id, window)?;
        // 空窗口的判断**必须早于锚点解析**：范围里一条都没有时，报"这条不在窗口内"
        // 或"这条不存在"都会把 agent 引去换锚点，而正确答案是"这个范围整个读不到"。
        // 有意保留的副作用：空窗口 + 不存在的锚点报 EmptyWindow 而不是 Missing ——
        // 空窗口是更上位的事实，两者都是明确报错，不会静默。
        if win.is_empty() {
            return Err(HistoryError::EmptyWindow);
        }
        let anchor = Self::msg_pos(&tx, conversation_id, anchor_id)?
            .ok_or_else(|| HistoryError::Missing(anchor_id.to_string()))?;
        if !win.contains(&anchor) {
            return Err(HistoryError::OutOfWindow(anchor_id.to_string()));
        }

        let (before_rows, has_more_before) =
            Self::fetch_side(&tx, conversation_id, &anchor, &win, false, before)?;
        let (after_rows, has_more_after) =
            Self::fetch_side(&tx, conversation_id, &anchor, &win, true, after)?;
        let anchor_row = Self::load_message_by_id(&tx, conversation_id, anchor_id)?
            .ok_or_else(|| HistoryError::Missing(anchor_id.to_string()))?;

        let mut messages = before_rows;
        messages.push(anchor_row);
        messages.extend(after_rows);
        tx.finish()?;
        Ok(HistoryRead {
            messages,
            has_more_before,
            has_more_after,
        })
    }

    /// 子代理可读父会话的**上界**：派发瞬间父会话最后一条已落库消息 id。
    ///
    /// 只冻结上界（"派发那一刻之前"）；下界（压缩卡）在读取时现取，
    /// 于是父会话之后再压缩只会让子代理的窗口变小 —— 那仍然只含主 agent
    /// 当前上下文里有的部分，且永远不会漏进归档原文，也不会因旧卡被吸收而失效。
    pub fn history_tail_anchor(&self, conversation_id: &str) -> RusqliteResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT id FROM messages
             WHERE conversation_id = ?1
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            [conversation_id],
            |r| r.get(0),
        )
        .optional()
    }

    /// 本会话此刻是否已经存在"读不到的东西"：出现过压缩（有归档卡），或派发过子对话。
    /// 决定 `read_history` 是否进本次请求的工具清单（见 `tools::STATE_GATED_TOOLS`）。
    ///
    /// 单调性：边界卡只会被新卡吸收、不会消失，所以压缩这一侧只增不减；子对话被
    /// 删除后判据会回落，但那时这个工具本来也读不到任何东西。
    ///
    /// 与 `history_overview` 分开是因为这是每轮请求前都要问一次的问题，不该为它
    /// 跑一次六条语句的概览。
    pub fn has_readable_history(&self, conversation_id: &str) -> RusqliteResult<bool> {
        let conn = self.conn.lock().unwrap();
        let pattern = format!("{COMPACTION_CARD_PREFIX}%");
        conn.query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM messages
                  WHERE conversation_id = ?1 AND role = 'system'
                    AND content LIKE ?2 ESCAPE '\\'
             ) OR EXISTS(
                 SELECT 1 FROM conversations WHERE parent_conversation_id = ?1
             )",
            rusqlite::params![conversation_id, pattern],
            |r| r.get(0),
        )
    }

    /// 本会话派发过的子对话（按创建时间升序）。
    pub fn list_sub_conversations(
        &self,
        parent_conversation_id: &str,
    ) -> RusqliteResult<Vec<SubConversationInfo>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.id, c.title, c.created_at, COUNT(m.id)
             FROM conversations c
             LEFT JOIN messages m ON m.conversation_id = c.id
             WHERE c.parent_conversation_id = ?1
             GROUP BY c.id, c.title, c.created_at
             ORDER BY c.created_at ASC",
        )?;
        let rows = stmt
            .query_map([parent_conversation_id], |row| {
                Ok(SubConversationInfo {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    created_at: row
                        .get::<_, String>(2)?
                        .parse()
                        .unwrap_or(chrono::DateTime::<Utc>::MIN_UTC),
                    message_count: row.get(3)?,
                })
            })?
            .collect::<RusqliteResult<Vec<_>>>()?;
        Ok(rows)
    }

    /// 消息 id → 行序位置；行不存在返回 None。
    fn msg_pos(
        conn: &Connection,
        conversation_id: &str,
        message_id: &str,
    ) -> RusqliteResult<Option<MsgPos>> {
        conn.query_row(
            "SELECT created_at, rowid FROM messages WHERE conversation_id = ?1 AND id = ?2",
            [conversation_id, message_id],
            |r| {
                Ok(MsgPos {
                    created_at: r.get(0)?,
                    rowid: r.get(1)?,
                })
            },
        )
        .optional()
    }

    /// 把窗口两端的 id 解析成行序位置；引用的行不存在 → 明确报错。
    fn resolve_history_window(
        conn: &Connection,
        conversation_id: &str,
        window: Option<&HistoryWindow>,
    ) -> Result<ResolvedWindow, HistoryError> {
        let Some(window) = window else {
            return Ok(ResolvedWindow::default());
        };
        let mut resolved = ResolvedWindow::default();
        if window.start == WindowStart::LatestCard {
            // 读时现算：没有卡片（从未压缩）⇒ 无下界，会话全部可读
            resolved.from = Self::boundary_card(conn, conversation_id)?.map(|c| MsgPos {
                created_at: c.created_at,
                rowid: c.rowid,
            });
        }
        if let Some(id) = window.upto_message_id.as_deref() {
            resolved.upto = Some(
                Self::msg_pos(conn, conversation_id, id)?
                    .ok_or_else(|| HistoryError::Missing(id.to_string()))?,
            );
        }
        Ok(resolved)
    }

    /// 窗口内最早/最新的一条消息。
    fn boundary_message(
        conn: &Connection,
        conversation_id: &str,
        oldest: bool,
        win: &ResolvedWindow,
    ) -> RusqliteResult<Option<MsgBrief>> {
        let order = if oldest { "ASC" } else { "DESC" };
        let (fc, fr, uc, ur) = win.bindings();
        conn.query_row(
            &format!(
                "SELECT id, role, timestamp FROM messages
                 WHERE conversation_id = :conv
                 {HISTORY_WINDOW_SQL}
                 ORDER BY created_at {order}, rowid {order} LIMIT 1"
            ),
            rusqlite::named_params! {
                ":conv": conversation_id,
                ":win_from_created": fc,
                ":win_from_rowid": fr,
                ":win_upto_created": uc,
                ":win_upto_rowid": ur,
            },
            |r| {
                Ok(MsgBrief {
                    id: r.get(0)?,
                    role: r.get(1)?,
                    timestamp: r.get(2)?,
                })
            },
        )
        .optional()
    }

    /// 归档边界 = 最新一张压缩卡（带行序位置，供比较用）。无卡 → None。
    ///
    /// ⚠️ 本查询与 `load_active_messages` 里那段"定位 checkpoint"是**同一件事的两份
    /// 实现**（前端翻页用那份，agent 回读用这份）。**改一处必须同时改另一处**，
    /// 否则两边对归档边界会有两种看法。前端还有一份等价判定（`compaction.status
    /// === 'done'` + 卡片前缀），见文件头"归档边界"段落。
    fn boundary_card(
        conn: &Connection,
        conversation_id: &str,
    ) -> RusqliteResult<Option<BoundaryCard>> {
        let pattern = format!("{COMPACTION_CARD_PREFIX}%");
        conn.query_row(
            "SELECT id, created_at, rowid, timestamp, content FROM messages
             WHERE conversation_id = ?1
               AND role = 'system'
               AND content LIKE ?2 ESCAPE '\\'
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            rusqlite::params![conversation_id, pattern],
            |r| {
                Ok(BoundaryCard {
                    id: r.get(0)?,
                    created_at: r.get(1)?,
                    rowid: r.get(2)?,
                    timestamp: r.get(3)?,
                    content: r.get(4)?,
                })
            },
        )
        .optional()
    }

    /// 按 id 取一条消息（整行）。
    fn load_message_by_id(
        conn: &Connection,
        conversation_id: &str,
        message_id: &str,
    ) -> RusqliteResult<Option<StoredMessage>> {
        conn.query_row(
            &format!(
                "SELECT {} FROM messages WHERE conversation_id = ?1 AND id = ?2",
                messages_select_columns()
            ),
            [conversation_id, message_id],
            Self::map_stored_message,
        )
        .optional()
    }

    /// 从锚点向某一侧取 `rows` 条（多取一条当探针判断还有没有更多），
    /// 返回 (按时间升序的行, 是否还有更多)。
    fn fetch_side(
        conn: &Connection,
        conversation_id: &str,
        anchor: &MsgPos,
        win: &ResolvedWindow,
        forward: bool,
        rows: usize,
    ) -> RusqliteResult<(Vec<StoredMessage>, bool)> {
        let (order, cmp) = if forward { ("ASC", ">") } else { ("DESC", "<") };
        let sql = format!(
            "SELECT {}
             FROM messages
             WHERE conversation_id = :conv
               AND (created_at {cmp} :anchor_created
                    OR (created_at = :anchor_created AND rowid {cmp} :anchor_rowid))
               {HISTORY_WINDOW_SQL}
             ORDER BY created_at {order}, rowid {order}
             LIMIT :limit",
            messages_select_columns()
        );
        let (fc, fr, uc, ur) = win.bindings();
        let mut stmt = conn.prepare(&sql)?;
        let mut out = stmt
            .query_map(
                rusqlite::named_params! {
                    ":conv": conversation_id,
                    ":anchor_created": anchor.created_at.as_str(),
                    ":anchor_rowid": anchor.rowid,
                    ":limit": (rows + 1) as i64,
                    ":win_from_created": fc,
                    ":win_from_rowid": fr,
                    ":win_upto_created": uc,
                    ":win_upto_rowid": ur,
                },
                Self::map_stored_message,
            )?
            .collect::<RusqliteResult<Vec<_>>>()?;
        let has_more = out.len() > rows;
        out.truncate(rows);
        if !forward {
            out.reverse();
        }
        Ok((out, has_more))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::{
        create_test_db, seed_compacted_conversation, seed_empty_window_conversation,
    };

    /// 概览：总数 / 归档段（条数与时间范围）/ 当前上下文段 / 边界卡。
    #[test]
    fn history_overview_reports_archive_boundary() {
        let db = create_test_db();
        let (conv_id, archived, card_id, active) = seed_compacted_conversation(&db);

        let ov = db.history_overview(&conv_id, None).expect("overview");
        assert_eq!(ov.total, 6, "3 条归档 + 卡片 + 2 条当前上下文");
        assert_eq!(ov.archived, 3, "卡片之前的 3 条 = 归档");
        assert_eq!(
            ov.active, 3,
            "卡片及之后 = 当前上下文（卡片本身算上下文里有的）"
        );
        assert_eq!(ov.oldest.as_ref().expect("oldest").id, archived[0]);
        assert_eq!(ov.newest.as_ref().expect("newest").id, active[1]);
        assert_eq!(
            ov.archived_newest.as_ref().expect("archived_newest").id,
            archived[2],
            "归档段最后一条 = 卡片紧邻的前一行（时间范围要用它）"
        );
        let card = ov.boundary_card.expect("boundary card");
        assert_eq!(card.id, card_id);
        assert!(card.content.starts_with(COMPACTION_CARD_PREFIX));
    }

    /// 没被压缩过的会话：归档段为 0，边界卡为 None —— 不报错、不编造。
    #[test]
    fn history_overview_without_compaction() {
        let db = create_test_db();
        let conv = db.create_conversation("conn_1", "plain").expect("conv");
        db.save_message(
            &conv.id,
            "user",
            "只有一条",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("msg");

        let ov = db.history_overview(&conv.id, None).expect("overview");
        assert_eq!(ov.total, 1);
        assert_eq!(ov.archived, 0);
        assert_eq!(ov.active, 1);
        assert!(ov.boundary_card.is_none());
        assert!(ov.archived_newest.is_none());

        // 空会话也不炸
        let empty = db.create_conversation("conn_1", "empty").expect("empty");
        let ov = db
            .history_overview(&empty.id, None)
            .expect("overview empty");
        assert_eq!(ov.total, 0);
        assert!(ov.oldest.is_none() && ov.newest.is_none());
    }

    /// **验收：能检索到只出现在压缩前那一段的关键词**（该关键词在卡片与后续消息里都不存在）。
    #[test]
    fn search_history_finds_keyword_only_in_archive() {
        let db = create_test_db();
        let (conv_id, archived, _, _) = seed_compacted_conversation(&db);

        // 关键词只出现在归档原文（那条命令输出）里：卡片摘要与当前上下文都没有它
        let hits = db
            .search_history(&conv_id, "inactive (dead)", None, 20)
            .expect("search");
        assert_eq!(hits.len(), 1, "只有归档原文里出现过");
        assert_eq!(hits[0].id, archived[2]);
        assert!(hits[0].snippet.contains("inactive (dead)"));
        assert_eq!(hits[0].role, "tool");

        // 同一句话在归档原文与卡片摘要里各出现一次 ⇒ 两条命中，归档那条也在（不筛掉归档）
        let hits = db
            .search_history(&conv_id, "nginx 换成 caddy", None, 20)
            .expect("search card");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].id, archived[0], "先命中的是归档原文");
        assert_eq!(hits[1].role, "system", "后命中的是卡片摘要");

        // 空关键词：空列表（不是全量）
        assert!(db
            .search_history(&conv_id, "   ", None, 20)
            .expect("empty kw")
            .is_empty());

        // 搜不到的关键词：空列表 + 不报错
        assert!(db
            .search_history(&conv_id, "绝对不存在的词", None, 20)
            .expect("no hit")
            .is_empty());
    }

    /// **验收：检索能被窗口裁掉归档段**（子代理看到的父会话里搜不到归档内容）。
    #[test]
    fn search_history_respects_window() {
        let db = create_test_db();
        // 窗口下界改成"读时最新卡"之后，这里不再需要卡 id
        let (conv_id, _, _card_id, _) = seed_compacted_conversation(&db);
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: None,
        };

        let hits = db
            .search_history(&conv_id, "inactive (dead)", Some(&window), 20)
            .expect("search");
        assert!(hits.is_empty(), "归档段被窗口裁掉 ⇒ 搜不到");

        // 断言窗口不是把所有东西都裁掉了：搜上下文里的词仍然命中
        let hits = db
            .search_history(&conv_id, "caddy 的配置", Some(&window), 20)
            .expect("search 2");
        assert_eq!(hits.len(), 1);
    }

    /// **验收：压缩之后能拿回压缩前某条消息的完整原文**（逐字相等，不是摘要）。
    #[test]
    fn read_history_returns_verbatim_archived_original() {
        let db = create_test_db();
        let (conv_id, archived, _, _) = seed_compacted_conversation(&db);

        let read = db
            .read_history(&conv_id, None, &archived[2], 0, 0)
            .expect("read");
        assert_eq!(read.messages.len(), 1, "before/after 都为 0 ⇒ 只读这一条");
        assert_eq!(read.messages[0].id, archived[2]);
        assert_eq!(
            read.messages[0].content, "systemctl status nginx 的输出：inactive (dead)",
            "必须是当时真实内容，逐字相等"
        );
        // 标志位说的是"该侧窗口内还有没有更多行"（翻页用），不是"你请求的条数被截断了"：
        // 这条锚点前后都还有东西（前 2 条归档、后面是卡片与当前上下文）
        assert!(read.has_more_before && read.has_more_after);
    }

    /// 带上下文：前若干条 + 锚点 + 后若干条，按时间升序；还有更多时给标志位。
    #[test]
    fn read_history_around_anchor_reports_more_flags() {
        let db = create_test_db();
        let (conv_id, archived, _, active) = seed_compacted_conversation(&db);

        // 以归档第 2 条为锚点，前后各 1 条
        let read = db
            .read_history(&conv_id, None, &archived[1], 1, 1)
            .expect("read around");
        let ids: Vec<&str> = read.messages.iter().map(|m| m.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                archived[0].as_str(),
                archived[1].as_str(),
                archived[2].as_str()
            ]
        );
        assert!(!read.has_more_before, "已经到会话最早一条");
        assert!(read.has_more_after, "后面还有（含卡片与当前上下文）");

        // 往前取到会话开头之外：请求 10 条只给得到 1 条，且 has_more_before=false
        let read = db
            .read_history(&conv_id, None, &archived[1], 10, 0)
            .expect("read before all");
        assert_eq!(read.messages.len(), 2);
        assert!(!read.has_more_before);

        // 最新一条之后没有任何东西
        let read = db
            .read_history(&conv_id, None, &active[1], 0, 5)
            .expect("read after tail");
        assert_eq!(read.messages.len(), 1);
        assert!(!read.has_more_after);
    }

    /// **验收：子代理窗口取不到归档原文，也取不到窗口外的任何行**；
    /// 窗口本身包含边界卡（主 agent 上下文里有的东西，子代理应该看得到摘要）。
    #[test]
    fn read_history_window_excludes_archive_and_includes_card() {
        let db = create_test_db();
        let (conv_id, archived, card_id, active) = seed_compacted_conversation(&db);

        // 上界冻结在"派发那一刻"（这里取所有行，便于单独验证下界效果）
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: None,
        };

        // 归档原文：明确报错"不在可读范围"，而不是返回空
        let err = db
            .read_history(&conv_id, Some(&window), &archived[0], 0, 0)
            .expect_err("归档行必须被窗口挡住");
        assert!(matches!(err, HistoryError::OutOfWindow(_)), "{err:?}");

        // 边界卡本身可读（它代表主 agent 当前上下文里的历史摘要）
        let read = db
            .read_history(&conv_id, Some(&window), &card_id, 0, 0)
            .expect("card readable");
        assert_eq!(read.messages.len(), 1);
        assert!(read.messages[0].content.starts_with(COMPACTION_CARD_PREFIX));

        // 活跃段可读
        let read = db
            .read_history(&conv_id, Some(&window), &active[0], 0, 1)
            .expect("active readable");
        assert_eq!(read.messages.len(), 2);

        // 窗口里检索同样取不到归档
        let hits = db
            .search_history(&conv_id, "systemctl", Some(&window), 20)
            .expect("search window");
        assert!(hits.is_empty());
    }

    /// 窗口上界：冻结在派发那一刻 ⇒ 之后新增的消息读不到（需求 8 的"派发那一刻之前"）。
    #[test]
    fn read_history_window_stops_at_upto_anchor() {
        let db = create_test_db();
        let (conv_id, _, _card_id, active) = seed_compacted_conversation(&db);
        // 派发瞬间最后一条落库消息 = active[0]
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(active[0].clone()),
        };

        let read = db
            .read_history(&conv_id, Some(&window), &active[0], 0, 5)
            .expect("read bounded");
        assert_eq!(read.messages.len(), 1, "上界之后的消息不可见");
        assert!(!read.has_more_after);

        let err = db
            .read_history(&conv_id, Some(&window), &active[1], 0, 0)
            .expect_err("上界之后的消息应报错");
        assert!(matches!(err, HistoryError::OutOfWindow(_)), "{err:?}");
    }

    /// **空窗口是真实可达的**（不是理论构造）：父会话在派发之后压缩，卡片就排到
    /// 冻结上界之后，`[最新卡, 派发锚]` 成为空区间。这条同时是后两个测试的 fixture。
    ///
    /// 控制组在同一处断言：同样的上界换成"不限下界"就不是空区间 —— 排除
    /// `is_empty()` 恒为真的可能。
    #[test]
    fn empty_window_arises_when_parent_compacts_after_dispatch() {
        let db = create_test_db();
        let (conv_id, dispatch_anchor, card_id) = seed_empty_window_conversation(&db);

        let empty = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(dispatch_anchor.clone()),
        };
        let control = HistoryWindow {
            start: WindowStart::Earliest,
            upto_message_id: Some(dispatch_anchor),
        };
        {
            let conn = db.conn.lock().unwrap();
            let win = ConversationDb::resolve_history_window(&conn, &conv_id, Some(&empty))
                .expect("resolve");
            assert!(win.is_empty(), "派发之后压缩 ⇒ 窗口应为空区间");
            assert!(
                win.from.is_some() && win.upto.is_some(),
                "两端都应有位置（空是因为上界排在下界之前）"
            );
            let ctrl = ConversationDb::resolve_history_window(&conn, &conv_id, Some(&control))
                .expect("resolve control");
            assert!(!ctrl.is_empty(), "同样的上界、不限下界时不是空区间");
        }

        // 成因：那张新卡实体上排在派发锚**之后**
        let rows = db.load_messages(&conv_id).expect("load");
        let pos = |id: &str| rows.iter().position(|m| m.id == id).expect("row");
        assert!(
            pos(&card_id) > pos(&rows[2].id),
            "新卡必须排在派发锚之后，否则窗口不会为空"
        );
    }

    /// **验收：空窗口必须明确报错** —— 不是"没有命中"，也不是"这条不在窗口内"。
    #[test]
    fn empty_window_reports_explicit_error() {
        let db = create_test_db();
        let (conv_id, dispatch_anchor, card_id) = seed_empty_window_conversation(&db);
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(dispatch_anchor),
        };

        // 检索：Err(EmptyWindow)，**不是** Ok(空) —— 后者会被渲染成"没有命中"，
        // agent 据此断定历史里没这段内容，而事实是整个范围都读不到。
        let err = db
            .search_history(&conv_id, "inactive", Some(&window), 20)
            .expect_err("空窗口不能静默返回空");
        assert!(matches!(err, HistoryError::EmptyWindow), "{err:?}");

        // 回读：拿卡当锚、拿旧消息当锚、不管前后取多少条，都是同一个事实
        for anchor in [card_id.as_str(), "2026-01-01T00:00:00Z 那条旧消息"] {
            for (before, after) in [(0usize, 0usize), (5, 5)] {
                let err = db
                    .read_history(&conv_id, Some(&window), anchor, before, after)
                    .expect_err("空窗口下回读必须报错");
                assert!(
                    matches!(err, HistoryError::EmptyWindow),
                    "({before},{after}) 应为 EmptyWindow，实得 {err:?}"
                );
            }
        }
        // 有意保留的副作用：空窗口 + 不存在的锚点 → EmptyWindow（更上位的事实）而不是 Missing
        let err = db
            .read_history(&conv_id, Some(&window), "根本不存在的 id", 0, 0)
            .expect_err("空窗口优先于锚点存在性");
        assert!(matches!(err, HistoryError::EmptyWindow), "{err:?}");

        // 回归：这个修复只对空窗口生效 —— 无窗口 / 非空窗口照旧能读
        assert!(db.search_history(&conv_id, "inactive", None, 20).is_ok());
        assert!(db.read_history(&conv_id, None, &card_id, 0, 0).is_ok());
    }

    /// **验收：带窗口的概览不再给出死 id** —— 概览里出现的每一个 id 都必须能用
    /// `read_history` 读到。这条钉住"窗口算好了却没传进概览"的缺陷：修复前概览报的是
    /// 整会话的 id，子代理拿去读必然 `OutOfWindow`。
    #[test]
    fn windowed_overview_only_reports_readable_ids() {
        let db = create_test_db();
        let (conv_id, archived, card_id, active) = seed_compacted_conversation(&db);
        // 派发瞬间的最后一条 = 会话最后一行
        let upto = active.last().expect("last active").clone();
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(upto),
        };

        let ov = db
            .history_overview(&conv_id, Some(&window))
            .expect("overview");
        assert_eq!(ov.total, 3, "窗口 = 卡片 + 2 条当前上下文");
        assert_eq!(ov.archived, 0, "归档段整个落在窗口外");
        assert_eq!(ov.active, ov.total);
        assert_eq!(
            ov.oldest.as_ref().expect("oldest").id,
            card_id,
            "窗口内最早一条就是边界卡本身"
        );
        assert_eq!(
            ov.hidden_before_window, 3,
            "3 条归档原文要报成「你看不到的那部分」"
        );

        // 最强的一条：概览给出的每一个 id 都读得到
        let mut ids: Vec<String> = vec![ov.oldest.as_ref().expect("oldest").id.clone()];
        if let Some(m) = &ov.newest {
            ids.push(m.id.clone());
        }
        if let Some(m) = &ov.archived_newest {
            ids.push(m.id.clone());
        }
        let card = ov.boundary_card.as_ref().expect("窗口内应报边界卡");
        ids.push(card.id.clone());
        for id in &ids {
            let read = db
                .read_history(&conv_id, Some(&window), id, 0, 0)
                .unwrap_or_else(|e| panic!("概览给出的 id={id} 读不到：{e:?}"));
            assert_eq!(&read.messages[0].id, id);
        }
        assert!(
            !ids.iter().any(|id| archived.contains(id)),
            "归档原文的 id 不该出现在概览里：{ids:?}"
        );

        // 对照：不带窗口时归档段照旧（证明上面的 0 是窗口造成的，不是 fixture 变了）
        let full = db.history_overview(&conv_id, None).expect("overview full");
        assert_eq!(full.archived, 3);
        assert_eq!(full.hidden_before_window, 0, "无窗口 ⇒ 没有被藏起来的");
    }

    /// 空窗口下的概览：范围内 0 条、边界卡也不报（它排在冻结上界之后，可能含
    /// 派发之后才发生的事）。让工具能说清"整个范围为空"，而不是给一串读不到的 id。
    #[test]
    fn overview_on_empty_window_reports_nothing_readable() {
        let db = create_test_db();
        let (conv_id, dispatch_anchor, _card_id) = seed_empty_window_conversation(&db);
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: Some(dispatch_anchor),
        };

        let ov = db
            .history_overview(&conv_id, Some(&window))
            .expect("overview");
        assert_eq!(ov.total, 0);
        assert_eq!(ov.archived, 0);
        assert_eq!(ov.active, 0);
        assert!(ov.oldest.is_none() && ov.newest.is_none());
        assert!(
            ov.boundary_card.is_none(),
            "窗口外的卡不报：它可能是派发之后新压的"
        );
        assert!(ov.hidden_before_window > 0, "要说明还有东西在范围外");
    }

    /// **验收：锚点=窗口下界那张卡 + `before > 0` 时不泄漏归档原文**
    /// （此前只有 `before = 0` 的用例，`before` 这条路径没人守）。
    #[test]
    fn read_history_from_card_anchor_with_before_never_leaks_archive() {
        let db = create_test_db();
        let (conv_id, archived, card_id, _) = seed_compacted_conversation(&db);
        let window = HistoryWindow {
            start: WindowStart::LatestCard,
            upto_message_id: None,
        };

        let read = db
            .read_history(&conv_id, Some(&window), &card_id, 5, 0)
            .expect("read");
        assert_eq!(
            read.messages.len(),
            1,
            "窗口下界就是这张卡，前面没有可读的行"
        );
        assert_eq!(read.messages[0].id, card_id);
        assert!(!read.has_more_before, "窗口内前面没有更多");
        for m in &read.messages {
            assert!(!archived.contains(&m.id), "归档原文不许出现：{}", m.id);
        }

        // 反向：拿归档里的行当锚 → 明确报错（不是静默少给几条）
        let err = db
            .read_history(&conv_id, Some(&window), &archived[0], 5, 5)
            .expect_err("归档锚点必须被窗口挡住");
        assert!(matches!(err, HistoryError::OutOfWindow(_)), "{err:?}");
    }

    /// **失败必须明确**：不存在的行、被吸收的旧卡，都返回 Err，绝不静默给空。
    #[test]
    fn read_history_errors_are_explicit() {
        let db = create_test_db();
        let (conv_id, _, _, _) = seed_compacted_conversation(&db);

        let err = db
            .read_history(&conv_id, None, "不存在的消息 id", 0, 0)
            .expect_err("不存在的行");
        assert!(matches!(err, HistoryError::Missing(_)), "{err:?}");

        // 窗口上界引用了不存在的行（例如父会话把那条消息撤回了）→ Missing，而不是"没有历史"
        let window = HistoryWindow {
            start: WindowStart::Earliest,
            upto_message_id: Some("已被撤回的消息 id".into()),
        };
        let err = db
            .search_history(&conv_id, "nginx", Some(&window), 20)
            .expect_err("上界行已不存在");
        assert!(matches!(err, HistoryError::Missing(_)), "{err:?}");

        // 别的会话的 id 在本会话里找不到 → 也是 Missing（调用方负责给出"不在可读范围"的文案）
        let other = db.create_conversation("conn_1", "other").expect("other");
        let foreign = db
            .save_message(
                &other.id,
                "user",
                "别人的消息",
                "2026-01-01T00:00:00Z",
                None,
                None,
            )
            .expect("foreign");
        let err = db
            .read_history(&conv_id, None, &foreign.id, 0, 0)
            .expect_err("跨会话 id");
        assert!(matches!(err, HistoryError::Missing(_)), "{err:?}");
    }

    /// 派发上界锚点：最后一条已落库消息；空会话 → None。
    #[test]
    fn history_tail_anchor_points_at_last_row() {
        let db = create_test_db();
        let (conv_id, _, _, active) = seed_compacted_conversation(&db);
        assert_eq!(
            db.history_tail_anchor(&conv_id).expect("anchor"),
            Some(active[1].clone())
        );

        let empty = db.create_conversation("conn_1", "empty").expect("empty");
        assert!(db
            .history_tail_anchor(&empty.id)
            .expect("anchor empty")
            .is_none());
    }

    /// 状态门控的判据：只有会话里真的存在"读不到的东西"（压缩过、或派发过子对话）
    /// 才为真。它是 `read_history` 能否进工具清单的唯一依据（见
    /// `tools::STATE_GATED_TOOLS`）——为此要治的正是"没压缩过却常驻占位"那种会话。
    #[test]
    fn has_readable_history_needs_an_archive_or_a_child() {
        let db = create_test_db();

        // 全新会话：历史全在上下文里，没有任何读不到的东西
        let fresh = db.create_conversation("conn_1", "fresh").expect("fresh");
        assert!(!db.has_readable_history(&fresh.id).expect("fresh"));

        // 有消息、但没压缩过也没派发过子对话 —— 仍然为假
        db.save_message(
            &fresh.id,
            "user",
            "帮我看看 nginx",
            "2026-01-01T00:00:00Z",
            None,
            None,
        )
        .expect("save");
        assert!(!db.has_readable_history(&fresh.id).expect("fresh with msgs"));

        // 派发过子对话 → 真（主 agent 要能核对子代理的过程）
        let sub = db
            .create_sub_conversation("conn_1", "查磁盘", &fresh.id)
            .expect("sub");
        assert!(db.has_readable_history(&fresh.id).expect("has child"));

        // 子对话被删掉后判据回落（文档里写明的已知回落：那时这工具本来也读不到东西）
        db.delete_conversation(&sub.id).expect("delete sub");
        assert!(!db.has_readable_history(&fresh.id).expect("child gone"));

        // 压缩过 → 真，且**持续**为真：归档卡只会被新卡吸收，不会消失
        let (compacted, _, _, _) = seed_compacted_conversation(&db);
        assert!(db.has_readable_history(&compacted).expect("compacted"));
        db.save_message(
            &compacted,
            "user",
            "继续",
            "2026-01-02T00:00:00Z",
            None,
            None,
        )
        .expect("save after compaction");
        assert!(db
            .has_readable_history(&compacted)
            .expect("still compacted"));
    }

    /// 子对话清单（主 agent 核对前先看有哪些）。
    #[test]
    fn list_sub_conversations_reports_children_only() {
        let db = create_test_db();
        let parent = db.create_conversation("conn_1", "main").expect("parent");
        let other = db
            .create_conversation("conn_1", "also main")
            .expect("other");
        let sub1 = db
            .create_sub_conversation("conn_1", "查一下磁盘", &parent.id)
            .expect("sub1");
        let sub2 = db
            .create_sub_conversation("conn_1", "查一下端口", &parent.id)
            .expect("sub2");
        db.save_message(&sub1.id, "user", "任务", "2026-01-01T00:00:00Z", None, None)
            .expect("msg");
        db.create_sub_conversation("conn_1", "别人的子对话", &other.id)
            .expect("foreign sub");

        let subs = db.list_sub_conversations(&parent.id).expect("list");
        assert_eq!(subs.len(), 2, "只看本会话派发的子对话");
        assert_eq!(subs[0].id, sub1.id);
        assert_eq!(subs[0].title, "查一下磁盘");
        assert_eq!(subs[0].message_count, 1);
        assert_eq!(subs[1].id, sub2.id);
        assert_eq!(subs[1].message_count, 0);
    }
}
