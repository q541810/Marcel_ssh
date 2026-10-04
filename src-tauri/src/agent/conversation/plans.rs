// plan 与 plan 快照的存取（plans / plan_snapshots 两张表）。
// plan_json 是 AgentTaskPlan 序列化后的 JSON 字符串。
use chrono::Utc;
use rusqlite::Result as RusqliteResult;

use super::ConversationDb;

impl ConversationDb {
    /// 保存或更新 plan（按 task_id upsert）。
    /// plan_json 是 AgentTaskPlan 序列化后的 JSON 字符串。
    pub fn save_plan(
        &self,
        task_id: &str,
        conversation_id: &str,
        plan_json: &str,
    ) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        // 先清理同 conversation 下旧 task_id 的 stale 行（重启后新 task 恢复了
        // 旧 plan 并继续更新，旧 task_id 的行不再需要）。
        conn.execute(
            "DELETE FROM plans WHERE conversation_id = ?1 AND task_id != ?2",
            (conversation_id, task_id),
        )?;
        conn.execute(
            "INSERT INTO plans (task_id, conversation_id, plan_json, updated_at) \
             VALUES (?1, ?2, ?3, ?4) \
             ON CONFLICT(task_id) DO UPDATE SET \
             conversation_id = excluded.conversation_id, \
             plan_json = excluded.plan_json, \
             updated_at = excluded.updated_at",
            (task_id, conversation_id, plan_json, Utc::now().to_rfc3339()),
        )?;
        Ok(())
    }

    /// 加载某对话下所有 plan（按 updated_at 倒序），返回 (task_id, plan_json, updated_at) 列表。
    pub fn load_plans_by_conversation(
        &self,
        conversation_id: &str,
    ) -> RusqliteResult<Vec<(String, String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT task_id, plan_json, updated_at FROM plans WHERE conversation_id = ?1 \
             ORDER BY updated_at DESC",
        )?;
        let rows = stmt
            .query_map([conversation_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 加载某对话下最近一条 plan（按 updated_at 倒序取第一条），返回 plan_json。
    /// 用于新 task 启动时恢复旧 plan 到后端内存，避免 LLM 重复 create_plan。
    pub fn load_latest_plan_by_conversation(
        &self,
        conversation_id: &str,
    ) -> RusqliteResult<Option<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT plan_json FROM plans WHERE conversation_id = ?1 \
             ORDER BY updated_at DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map([conversation_id], |row| row.get::<_, String>(0))?;
        match rows.next() {
            Some(Ok(plan_json)) => Ok(Some(plan_json)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// 删除单个 plan（按 task_id）。
    pub fn delete_plan(&self, task_id: &str) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM plans WHERE task_id = ?1", [task_id])?;
        Ok(())
    }

    /// 删除某对话下全部 plan 行。
    pub fn delete_plans_by_conversation(&self, conversation_id: &str) -> RusqliteResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "DELETE FROM plans WHERE conversation_id = ?1",
            [conversation_id],
        )?;
        Ok(())
    }

    /// 列出某对话下 plans 表中的 task_id（用于清理内存）。
    pub fn list_plan_task_ids(&self, conversation_id: &str) -> RusqliteResult<Vec<String>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT task_id FROM plans WHERE conversation_id = ?1")?;
        let rows = stmt
            .query_map([conversation_id], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// 每次 plan 持久化后追加快照，供撤回消息时按时间点恢复。
    /// 单 conversation 最多保留 200 条，超出按 created_at 删最旧的。
    pub fn insert_plan_snapshot(
        &self,
        conversation_id: &str,
        task_id: &str,
        plan_json: &str,
    ) -> RusqliteResult<()> {
        const MAX_SNAPSHOTS_PER_CONV: i64 = 200;
        let created_at = Utc::now().to_rfc3339();
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO plan_snapshots (conversation_id, task_id, plan_json, created_at) \
             VALUES (?1, ?2, ?3, ?4)",
            (conversation_id, task_id, plan_json, &created_at),
        )?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM plan_snapshots WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0),
        )?;
        if count > MAX_SNAPSHOTS_PER_CONV {
            let to_delete = count - MAX_SNAPSHOTS_PER_CONV;
            conn.execute(
                "DELETE FROM plan_snapshots WHERE id IN ( \
                    SELECT id FROM plan_snapshots WHERE conversation_id = ?1 \
                    ORDER BY created_at ASC LIMIT ?2 \
                 )",
                rusqlite::params![conversation_id, to_delete],
            )?;
        }
        Ok(())
    }

    /// 取截断点之前最近一条 plan 快照：`created_at < from_timestamp`。
    /// 返回 (task_id, plan_json)。
    pub fn load_plan_snapshot_before(
        &self,
        conversation_id: &str,
        from_timestamp: &str,
    ) -> RusqliteResult<Option<(String, String)>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT task_id, plan_json FROM plan_snapshots \
             WHERE conversation_id = ?1 AND created_at < ?2 \
             ORDER BY created_at DESC LIMIT 1",
        )?;
        let mut rows = stmt.query_map((conversation_id, from_timestamp), |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        match rows.next() {
            Some(Ok(pair)) => Ok(Some(pair)),
            Some(Err(e)) => Err(e),
            None => Ok(None),
        }
    }

    /// 该对话是否存在任意 plan 快照（用于区分「旧数据无快照」与「有快照但均在截断点之后」）。
    pub fn has_any_plan_snapshot(&self, conversation_id: &str) -> RusqliteResult<bool> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM plan_snapshots WHERE conversation_id = ?1",
            [conversation_id],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    /// 删除截断点及之后产生的 plan 快照（撤回后未来进度的快照不应再参与恢复）。
    pub fn delete_plan_snapshots_from(
        &self,
        conversation_id: &str,
        from_timestamp: &str,
    ) -> RusqliteResult<usize> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute(
            "DELETE FROM plan_snapshots WHERE conversation_id = ?1 AND created_at >= ?2",
            (conversation_id, from_timestamp),
        )?;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::conversation::test_support::create_test_db;

    #[test]
    fn test_plan_snapshot_before_and_clear() {
        let db = create_test_db();
        let conversation = db
            .create_conversation("conn_1", "Plan Snap")
            .expect("Failed to create");

        let plan_a = r#"{"taskId":"t1","items":[{"id":"1","title":"a","status":"pending"}],"currentIndex":0,"nextItemSeq":2,"reflectionReminded":false}"#;
        let plan_b = r#"{"taskId":"t1","items":[{"id":"1","title":"a","status":"completed"}],"currentIndex":1,"nextItemSeq":2,"reflectionReminded":false}"#;

        db.save_plan("t1", &conversation.id, plan_a)
            .expect("save plan a");
        db.insert_plan_snapshot(&conversation.id, "t1", plan_a)
            .expect("snap a");

        // Ensure later snapshot has later created_at
        std::thread::sleep(std::time::Duration::from_millis(15));

        db.save_plan("t1", &conversation.id, plan_b)
            .expect("save plan b");
        db.insert_plan_snapshot(&conversation.id, "t1", plan_b)
            .expect("snap b");

        let t_user = Utc::now().to_rfc3339();
        // snapshot after t_user should not be selected; insert one more after
        std::thread::sleep(std::time::Duration::from_millis(15));
        let plan_c = r#"{"taskId":"t1","items":[{"id":"1","title":"a","status":"completed"},{"id":"2","title":"b","status":"pending"}],"currentIndex":1,"nextItemSeq":3,"reflectionReminded":false}"#;
        db.insert_plan_snapshot(&conversation.id, "t1", plan_c)
            .expect("snap c");

        let before = db
            .load_plan_snapshot_before(&conversation.id, &t_user)
            .expect("load before")
            .expect("should have snapshot before user ts");
        assert_eq!(before.0, "t1");
        assert!(before.1.contains("\"status\":\"completed\""));
        assert!(!before.1.contains("\"title\":\"b\""));

        let none = db
            .load_plan_snapshot_before(&conversation.id, "2000-01-01T00:00:00Z")
            .expect("load early");
        assert!(none.is_none());

        db.delete_plans_by_conversation(&conversation.id)
            .expect("delete plans");
        let remaining = db
            .load_plans_by_conversation(&conversation.id)
            .expect("list");
        assert!(remaining.is_empty());
    }

    #[test]
    fn test_delete_conversation_clears_snapshots() {
        let db = create_test_db();
        let conversation = db.create_conversation("conn_1", "Del").expect("create");
        let plan = r#"{"taskId":"t9","items":[],"currentIndex":0,"nextItemSeq":1,"reflectionReminded":false}"#;
        db.insert_plan_snapshot(&conversation.id, "t9", plan)
            .expect("snap");
        db.delete_conversation(&conversation.id).expect("delete");
        let snap = db
            .load_plan_snapshot_before(&conversation.id, "9999-01-01T00:00:00Z")
            .expect("query");
        assert!(snap.is_none());
    }
}
