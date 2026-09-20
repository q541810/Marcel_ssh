use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::persist::JsonPersistable;

/// A saved SSH connection configuration.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub key_path: Option<String>,
    pub group: Option<String>,
    pub last_connected: Option<DateTime<Utc>>,
    /// Whether ProxyJump is enabled. Missing on old data = disabled.
    #[serde(default)]
    pub use_jump: bool,
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_username: Option<String>,
    /// `withTarget` | `Password` | `PrivateKey`
    #[serde(default)]
    pub jump_auth_method: Option<String>,
    #[serde(default)]
    pub jump_key_path: Option<String>,
}

/// Store for managing saved SSH connections.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionStore {
    pub connections: Vec<SavedConnection>,
}

impl ConnectionStore {
    pub fn new() -> Self {
        Self {
            connections: Vec::new(),
        }
    }

    pub fn add(&mut self, connection: SavedConnection) {
        self.connections.push(connection);
    }

    /// 写回一个已存在的连接，**保持它在数组里的位置**；不存在则追加到末尾。
    ///
    /// 为什么不能沿用 `remove` + `add`：数组顺序就是列表展示顺序
    /// （用户拖拽排序的结果），编辑一次连接把它甩到末尾会让排序白拖。
    pub fn replace_keeping_order(&mut self, connection: SavedConnection) {
        match self.connections.iter_mut().find(|c| c.id == connection.id) {
            Some(slot) => *slot = connection,
            None => self.connections.push(connection),
        }
    }

    /// 按给定顺序重排连接，并顺带写入目标分组（`None` = 未分组）。
    ///
    /// - 只重排 / 改分组，**不动 `last_connected` 等其他字段**
    /// - 请求里缺的 id 按原相对顺序补到末尾（并发新增的连接不能丢）
    /// - 请求里不存在的 id 忽略（可能来自旧快照）
    ///
    /// 返回 `(重排数量, 补齐数量, 忽略数量)`，调用方用于日志。
    pub fn apply_order(&mut self, order: &[(String, Option<String>)]) -> (usize, usize, usize) {
        let mut remaining: Vec<SavedConnection> = std::mem::take(&mut self.connections);
        let mut ordered: Vec<SavedConnection> = Vec::with_capacity(remaining.len());
        let mut ignored = 0usize;

        for (id, group) in order {
            match remaining.iter().position(|c| &c.id == id) {
                Some(idx) => {
                    let mut conn = remaining.remove(idx);
                    if &conn.group != group {
                        conn.group = group.clone();
                    }
                    ordered.push(conn);
                }
                None => ignored += 1,
            }
        }

        let appended = remaining.len();
        ordered.extend(remaining);
        let reordered = ordered.len() - appended;
        self.connections = ordered;
        (reordered, appended, ignored)
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let len_before = self.connections.len();
        self.connections.retain(|c| c.id != id);
        self.connections.len() < len_before
    }

    pub fn get_all(&self) -> &[SavedConnection] {
        &self.connections
    }

    pub fn get_by_id(&self, id: &str) -> Option<&SavedConnection> {
        self.connections.iter().find(|c| c.id == id)
    }

    /// Update `last_connected` timestamp for a connection.
    pub fn mark_connected(&mut self, id: &str) {
        if let Some(c) = self.connections.iter_mut().find(|c| c.id == id) {
            c.last_connected = Some(Utc::now());
        }
    }
}

impl JsonPersistable for ConnectionStore {
    fn default_filename() -> &'static str {
        "connections.json"
    }
}

impl Default for ConnectionStore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conn(id: &str, group: Option<&str>) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: format!("name-{id}"),
            host: "127.0.0.1".into(),
            port: 22,
            username: "root".into(),
            auth_method: "Agent".into(),
            key_path: None,
            group: group.map(String::from),
            last_connected: None,
            use_jump: false,
            jump_host: None,
            jump_port: None,
            jump_username: None,
            jump_auth_method: None,
            jump_key_path: None,
        }
    }

    fn store_of(items: Vec<SavedConnection>) -> ConnectionStore {
        ConnectionStore {
            connections: items,
        }
    }

    fn ids(store: &ConnectionStore) -> Vec<String> {
        store.get_all().iter().map(|c| c.id.clone()).collect()
    }

    #[test]
    fn apply_order_reorders_and_moves_between_groups() {
        let mut store = store_of(vec![
            conn("a", Some("prod")),
            conn("b", Some("test")),
            conn("c", Some("prod")),
        ]);

        // 把 c 拖到最前并移入 test 组
        let (reordered, appended, ignored) = store.apply_order(&[
            ("c".into(), Some("test".into())),
            ("a".into(), Some("prod".into())),
            ("b".into(), Some("test".into())),
        ]);

        assert_eq!(ids(&store), vec!["c", "a", "b"]);
        assert_eq!(reordered, 3);
        assert_eq!(appended, 0);
        assert_eq!(ignored, 0);
        assert_eq!(store.get_by_id("c").unwrap().group.as_deref(), Some("test"));
    }

    #[test]
    fn apply_order_clears_group_with_none() {
        let mut store = store_of(vec![conn("a", Some("prod"))]);
        store.apply_order(&[("a".into(), None)]);
        assert_eq!(store.get_by_id("a").unwrap().group, None);
    }

    /// 请求里缺的 id 补到末尾（并发新增的连接不能丢），未知 id 忽略。
    #[test]
    fn apply_order_appends_missing_and_ignores_unknown() {
        let mut store = store_of(vec![conn("a", None), conn("b", None), conn("c", None)]);

        let (reordered, appended, ignored) =
            store.apply_order(&[("c".into(), None), ("ghost".into(), None)]);

        assert_eq!(ids(&store), vec!["c", "a", "b"]);
        assert_eq!(reordered, 1);
        assert_eq!(appended, 2);
        assert_eq!(ignored, 1);
    }

    /// 排序只动顺序与分组，不碰 lastConnected 等其他字段。
    #[test]
    fn apply_order_keeps_other_fields() {
        let mut mark = conn("a", Some("prod"));
        mark.last_connected = Some(Utc::now());
        let mut store = store_of(vec![mark, conn("b", None)]);

        store.apply_order(&[("b".into(), None), ("a".into(), Some("prod".into()))]);

        let a = store.get_by_id("a").unwrap();
        assert!(a.last_connected.is_some());
        assert_eq!(a.name, "name-a");
        assert_eq!(a.host, "127.0.0.1");
    }

    /// 编辑已存在的连接不能改变它在列表里的位置（拖拽排序的结果要保住）。
    #[test]
    fn replace_keeping_order_keeps_slot() {
        let mut store = store_of(vec![conn("a", None), conn("b", None), conn("c", None)]);

        let mut edited = conn("b", Some("test"));
        edited.name = "改过名字".into();
        edited.host = "10.0.0.1".into();
        store.replace_keeping_order(edited);

        assert_eq!(ids(&store), vec!["a", "b", "c"]);
        assert_eq!(store.get_by_id("b").unwrap().name, "改过名字");
        assert_eq!(store.get_by_id("b").unwrap().host, "10.0.0.1");
    }

    #[test]
    fn replace_keeping_order_appends_new_connection() {
        let mut store = store_of(vec![conn("a", None)]);
        store.replace_keeping_order(conn("new", None));
        assert_eq!(ids(&store), vec!["a", "new"]);
    }
}
