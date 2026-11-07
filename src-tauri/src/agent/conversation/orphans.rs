// 被删服务器的对话：删服务器时对话原样留在库里，这里负责让它们「有名字、找得回、会被清理」。
//
// 做法是复用会话归档，不另造一套清理：
// - 删服务器 = 把它名下的对话全部归档，归档时间就是删除时刻，再记一条 `deleted_connections`
//   （服务器当时的名字和地址，否则孤儿对话只剩一串 id）。
// - 现有的「归档超过 N 天自动清理」（`purge_archived_before`）照常清掉它们，天数用同一个设置项。
// - 以前就已经删掉的服务器没有归档时间：[`ConversationDb::stamp_historic_orphans`] 在启动时
//   第一次发现它们才开始计时，所以升级后不会一次性被清光。
//
// 「孤儿」= 主对话的 `connection_id` 不在已保存的服务器里，且不是调试服务器 / MCP 临时连接这类
// 本来就不是已保存服务器的 id（见 [`is_saved_server_id`]）。判断「已保存服务器有哪些」由调用方
// 传入，这里不碰连接配置。
use std::collections::HashSet;

use chrono::Utc;
use rusqlite::OptionalExtension;
use rusqlite::Result as RusqliteResult;
use serde::Serialize;

use super::ConversationDb;

/// 不属于「已保存服务器」的 connection_id 前缀：调试服务器、MCP 无头模式的临时连接。
/// 这些 id 永远不在连接配置里，不能因此被当成「已删除的服务器」。
const NON_SERVER_PREFIXES: [&str; 2] = ["debug:", "mcp-temp-"];

/// 这个 connection_id 是不是「可能被用户删掉的已保存服务器」。
pub fn is_saved_server_id(connection_id: &str) -> bool {
    !connection_id.is_empty()
        && !NON_SERVER_PREFIXES
            .iter()
            .any(|p| connection_id.starts_with(p))
}

/// 一台已删除服务器名下的对话概况（历史页「已删除的服务器」分组的一行）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanGroup {
    pub connection_id: String,
    /// 删除时记下的名字；以前就删掉的服务器没有记录，为 `None`。
    pub name: Option<String>,
    pub host: Option<String>,
    /// 删除时间（RFC3339）。以前删掉的服务器是「第一次被发现」的时间。
    pub deleted_at: Option<String>,
    /// 主对话数（不含子 agent 对话）。
    pub conversation_count: usize,
    /// 名下最近一次有动静的对话的更新时间（RFC3339）。
    pub last_updated_at: String,
    /// 那条最近对话的标题，给「未知服务器」认人用。
    pub last_title: String,
}

impl ConversationDb {
    /// 服务器被删：一个事务里记下它的名字地址、把它名下尚未归档的对话全部归档。
    /// 归档时间与 `deleted_at` 是同一个值——转移时靠这个区分「删服务器时归档的」和
    /// 「用户更早自己归档的」（见 [`Self::reassign_connection`]）。返回归档的对话数。
    pub fn mark_connection_deleted(
        &self,
        connection_id: &str,
        name: Option<&str>,
        host: Option<&str>,
    ) -> RusqliteResult<usize> {
        let at = Utc::now().to_rfc3339();
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        tx.execute(
            "INSERT INTO deleted_connections (connection_id, name, host, deleted_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(connection_id) DO UPDATE SET
                name = excluded.name, host = excluded.host, deleted_at = excluded.deleted_at",
            rusqlite::params![connection_id, name, host, at],
        )?;
        let archived = Self::archive_unarchived_of(&tx, connection_id, &at)?;
        tx.commit()?;
        Ok(archived)
    }

    /// 把某连接名下还没归档的对话（含子对话）归档到 `at`，同时清置顶（与单条归档同口径）。
    fn archive_unarchived_of(
        conn: &rusqlite::Connection,
        connection_id: &str,
        at: &str,
    ) -> RusqliteResult<usize> {
        conn.execute(
            "UPDATE conversations SET archived_at = ?1, pinned = 0
             WHERE connection_id = ?2 AND archived_at IS NULL",
            rusqlite::params![at, connection_id],
        )
    }

    /// 列出所有「已删除的服务器」分组。`known` 是当前已保存服务器的 id 集合。
    pub fn list_orphan_groups(&self, known: &HashSet<String>) -> RusqliteResult<Vec<OrphanGroup>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT c.connection_id, COUNT(*), MAX(c.updated_at),
                    d.name, d.host, d.deleted_at
             FROM conversations c
             LEFT JOIN deleted_connections d ON d.connection_id = c.connection_id
             WHERE c.parent_conversation_id IS NULL
             GROUP BY c.connection_id",
        )?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            })?
            .collect::<RusqliteResult<Vec<_>>>()?;
        drop(stmt);

        let mut out = Vec::new();
        for (connection_id, count, last_updated_at, name, host, deleted_at) in rows {
            if known.contains(&connection_id) || !is_saved_server_id(&connection_id) {
                continue;
            }
            let last_title: String = conn
                .query_row(
                    "SELECT title FROM conversations
                     WHERE connection_id = ?1 AND parent_conversation_id IS NULL
                     ORDER BY updated_at DESC LIMIT 1",
                    [&connection_id],
                    |r| r.get(0),
                )
                .optional()?
                .unwrap_or_default();
            out.push(OrphanGroup {
                connection_id,
                name,
                host,
                deleted_at,
                conversation_count: count.max(0) as usize,
                last_updated_at,
                last_title,
            });
        }
        out.sort_by(|a, b| b.last_updated_at.cmp(&a.last_updated_at));
        Ok(out)
    }

    /// 给「以前就已经删掉」的服务器补上记录并开始计时：没有记录的孤儿补一条
    /// （名字未知、`deleted_at` = 现在），名下尚未归档的对话归档到现在。幂等。
    /// 返回本次新归档的对话数。
    ///
    /// 调用方必须保证 `known` 来自一份**成功加载**的连接配置且非空——配置读失败时
    /// `known` 是空的，所有对话都会被当成孤儿。
    pub fn stamp_historic_orphans(&self, known: &HashSet<String>) -> RusqliteResult<usize> {
        let at = Utc::now().to_rfc3339();
        let mut conn = self.conn.lock().unwrap();
        let ids: Vec<String> = {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT connection_id FROM conversations
                 WHERE parent_conversation_id IS NULL",
            )?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<RusqliteResult<Vec<_>>>()?;
            rows
        };
        let tx = conn.transaction()?;
        let mut archived = 0;
        for id in ids
            .iter()
            .filter(|id| !known.contains(*id) && is_saved_server_id(id))
        {
            tx.execute(
                "INSERT OR IGNORE INTO deleted_connections (connection_id, deleted_at)
                 VALUES (?1, ?2)",
                rusqlite::params![id, at],
            )?;
            archived += Self::archive_unarchived_of(&tx, id, &at)?;
        }
        tx.commit()?;
        Ok(archived)
    }

    /// 把已删除服务器名下的全部对话改挂到另一台服务器。返回改挂的对话数（含子对话）。
    ///
    /// 删服务器时归档的（`archived_at` ≥ 删除时间）一并恢复；用户在那之前自己归档的保持归档。
    /// 没有删除记录（还没被盘点过）就不动归档状态，只改挂。
    pub fn reassign_connection(&self, from: &str, to: &str) -> RusqliteResult<usize> {
        let mut conn = self.conn.lock().unwrap();
        let tx = conn.transaction()?;
        let deleted_at: Option<String> = tx
            .query_row(
                "SELECT deleted_at FROM deleted_connections WHERE connection_id = ?1",
                [from],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(deleted_at) = deleted_at {
            tx.execute(
                "UPDATE conversations SET archived_at = NULL
                 WHERE connection_id = ?1 AND archived_at IS NOT NULL AND archived_at >= ?2",
                rusqlite::params![from, deleted_at],
            )?;
        }
        let moved = tx.execute(
            "UPDATE conversations SET connection_id = ?2 WHERE connection_id = ?1",
            rusqlite::params![from, to],
        )?;
        tx.execute(
            "DELETE FROM deleted_connections WHERE connection_id = ?1",
            [from],
        )?;
        tx.commit()?;
        Ok(moved)
    }

    /// 删掉已经没有任何对话的删除记录（对话被清理 / 彻底删除 / 转移走之后调用）。
    pub fn prune_deleted_connection_records(&self) -> RusqliteResult<usize> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM deleted_connections
             WHERE connection_id NOT IN (SELECT DISTINCT connection_id FROM conversations)",
            [],
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> (tempfile::TempDir, ConversationDb) {
        let dir = tempfile::tempdir().unwrap();
        let db = ConversationDb::new(dir.path().join("conversations.db")).unwrap();
        (dir, db)
    }

    fn known(ids: &[&str]) -> HashSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn special_ids_are_not_saved_servers() {
        assert!(is_saved_server_id("0b5f-uuid"));
        assert!(!is_saved_server_id("debug:msfakeserver"));
        assert!(!is_saved_server_id("mcp-temp-123"));
        assert!(!is_saved_server_id(""));
    }

    #[test]
    fn deleting_a_server_archives_its_conversations_and_lists_them() {
        let (_d, db) = db();
        let a = db.create_conversation("gone", "部署 nginx").unwrap();
        let b = db.create_conversation("gone", "排查磁盘").unwrap();
        db.create_conversation("alive", "别动我").unwrap();
        db.set_conversation_pinned(&a.id, true).unwrap();

        let n = db
            .mark_connection_deleted("gone", Some("web-01"), Some("10.0.0.1"))
            .unwrap();
        assert_eq!(n, 2);

        // 名下对话全部归档并清了置顶，别的服务器不受影响。
        assert_eq!(db.list_active_conversations("gone").unwrap().len(), 0);
        assert_eq!(db.list_archived_conversations("gone").unwrap().len(), 2);
        assert_eq!(db.list_active_conversations("alive").unwrap().len(), 1);
        assert!(db
            .list_conversations("gone")
            .unwrap()
            .iter()
            .all(|c| !c.pinned));

        let groups = db.list_orphan_groups(&known(&["alive"])).unwrap();
        assert_eq!(groups.len(), 1);
        let g = &groups[0];
        assert_eq!(g.connection_id, "gone");
        assert_eq!(g.name.as_deref(), Some("web-01"));
        assert_eq!(g.host.as_deref(), Some("10.0.0.1"));
        assert_eq!(g.conversation_count, 2);
        assert!(g.deleted_at.is_some());
        assert!([a.title.as_str(), b.title.as_str()].contains(&g.last_title.as_str()));
    }

    #[test]
    fn orphan_groups_skip_known_and_non_server_ids() {
        let (_d, db) = db();
        db.create_conversation("alive", "a").unwrap();
        db.create_conversation("debug:msfakeserver", "d").unwrap();
        db.create_conversation("mcp-temp-1", "m").unwrap();
        db.create_conversation("gone", "g").unwrap();
        let groups = db.list_orphan_groups(&known(&["alive"])).unwrap();
        assert_eq!(
            groups
                .iter()
                .map(|g| g.connection_id.as_str())
                .collect::<Vec<_>>(),
            vec!["gone"]
        );
        // 没有删除记录的孤儿：名字未知。
        assert_eq!(groups[0].name, None);
    }

    #[test]
    fn sub_conversations_do_not_count_as_groups() {
        let (_d, db) = db();
        let main = db.create_conversation("gone", "主").unwrap();
        db.create_sub_conversation("gone", "子", &main.id).unwrap();
        let groups = db.list_orphan_groups(&known(&["alive"])).unwrap();
        assert_eq!(groups[0].conversation_count, 1);
    }

    #[test]
    fn stamping_historic_orphans_starts_the_clock_once() {
        let (_d, db) = db();
        db.create_conversation("alive", "a").unwrap();
        db.create_conversation("old", "遗留").unwrap();
        db.create_conversation("debug:msfakeserver", "d").unwrap();

        let k = known(&["alive"]);
        assert_eq!(db.stamp_historic_orphans(&k).unwrap(), 1);
        // 遗留对话被归档，正常服务器与调试服务器不动。
        assert_eq!(db.list_archived_conversations("old").unwrap().len(), 1);
        assert_eq!(db.list_active_conversations("alive").unwrap().len(), 1);
        assert_eq!(
            db.list_active_conversations("debug:msfakeserver")
                .unwrap()
                .len(),
            1
        );
        // 幂等：第二次没有新归档，也没有重置时间。
        let first = db.list_orphan_groups(&k).unwrap()[0].deleted_at.clone();
        assert_eq!(db.stamp_historic_orphans(&k).unwrap(), 0);
        assert_eq!(db.list_orphan_groups(&k).unwrap()[0].deleted_at, first);
    }

    #[test]
    fn expired_orphans_are_purged_by_the_normal_archive_cleanup() {
        let (_d, db) = db();
        db.create_conversation("gone", "x").unwrap();
        db.mark_connection_deleted("gone", Some("web-01"), None)
            .unwrap();
        // 截止时间在未来 = 一定过期。
        let cutoff = (Utc::now() + chrono::Duration::days(1)).to_rfc3339();
        let purged = db.purge_archived_before(&cutoff).unwrap();
        assert_eq!(purged.len(), 1);
        assert!(db
            .list_orphan_groups(&known(&["alive"]))
            .unwrap()
            .is_empty());
        // 对话清完，删除记录也跟着清掉，不会在库里留尾巴。
        let leftover: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM deleted_connections", [], |r| r.get(0))
            .unwrap();
        assert_eq!(leftover, 0);
    }

    #[test]
    fn reassign_restores_deletion_archives_but_keeps_earlier_user_archives() {
        let (_d, db) = db();
        let early = db.create_conversation("gone", "早先自己归档的").unwrap();
        db.create_conversation("gone", "删服务器时归档的").unwrap();
        db.archive_conversation(&early.id).unwrap();
        // 保证删除时间严格晚于更早的归档时间。
        std::thread::sleep(std::time::Duration::from_millis(5));
        db.mark_connection_deleted("gone", Some("web-01"), None)
            .unwrap();

        let moved = db.reassign_connection("gone", "new").unwrap();
        assert_eq!(moved, 2);
        let active = db.list_active_conversations("new").unwrap();
        assert_eq!(active.len(), 1);
        assert_eq!(active[0].title, "删服务器时归档的");
        let archived = db.list_archived_conversations("new").unwrap();
        assert_eq!(archived.len(), 1);
        assert_eq!(archived[0].id, early.id);
        assert!(db.list_conversations("gone").unwrap().is_empty());
        assert!(db.list_orphan_groups(&known(&["new"])).unwrap().is_empty());
    }

    #[test]
    fn deleting_orphans_for_good_drops_the_record_too() {
        let (_d, db) = db();
        db.create_conversation("gone", "x").unwrap();
        db.mark_connection_deleted("gone", Some("web-01"), None)
            .unwrap();
        db.delete_conversations_by_connection("gone").unwrap();
        assert!(db.list_conversations("gone").unwrap().is_empty());
        let leftover: i64 = db
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT COUNT(*) FROM deleted_connections", [], |r| r.get(0))
            .unwrap();
        assert_eq!(leftover, 0);
    }
}
