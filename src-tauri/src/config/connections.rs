use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::persist::JsonPersistable;

/// Auto-detected remote platform, persisted alongside the connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemotePlatform {
    Windows,
    Linux,
    Macos,
    Unix,
}

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
    /// 密钥库里那把私钥的 id（导入进来的私钥）。老数据没有这个字段，
    /// 为 `None` 时按 `key_path` 走——两条路都保留见 `ssh::key_store::resolve_pem`。
    #[serde(default)]
    pub key_id: Option<String>,
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
    /// 跳板机私钥的密钥库 id，语义同 `key_id`
    #[serde(default)]
    pub jump_key_id: Option<String>,
    /// 首次成功连接后自动探测到的远端平台；旧数据没有这个字段。
    #[serde(default)]
    pub remote_platform: Option<RemotePlatform>,
    /// 端口转发里被用户备注 / 置顶过的目标。跟着连接落盘与同步；
    /// 没被备注也没置顶的目标不记录，转发本身仍然只活在会话内。
    #[serde(default)]
    pub port_forwards: Vec<PortForwardNote>,
}

/// 端口转发的一条「记住」记录：按目标地址挂在这台已保存的服务器上。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortForwardNote {
    /// 数组元素 id（同步按 id 映射，同一连接内唯一）：`host|port`。
    pub id: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub pinned: bool,
}

fn port_forward_note_id(host: &str, port: u16) -> String {
    format!("{host}|{port}")
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

    /// Store the platform detected after a successful connection.
    ///
    /// Returns whether the value changed. Unknown ids are ignored so a stale
    /// probe cannot recreate a connection deleted while it was running.
    pub fn set_remote_platform(&mut self, id: &str, platform: RemotePlatform) -> bool {
        match self.connections.iter_mut().find(|c| c.id == id) {
            Some(connection) if connection.remote_platform != Some(platform) => {
                connection.remote_platform = Some(platform);
                true
            }
            _ => false,
        }
    }

    /// Update `last_connected` timestamp for a connection.
    pub fn mark_connected(&mut self, id: &str) {
        if let Some(c) = self.connections.iter_mut().find(|c| c.id == id) {
            c.last_connected = Some(Utc::now());
        }
    }

    /// 写一条端口转发备注。`note` 去掉首尾空白；「没备注也没置顶」= 删掉这条记录。
    ///
    /// 返回连接是否存在；不存在的 id 什么都不改。
    pub fn set_port_forward_note(
        &mut self,
        connection_id: &str,
        host: &str,
        port: u16,
        note: &str,
        pinned: bool,
    ) -> bool {
        let Some(connection) = self.connections.iter_mut().find(|c| c.id == connection_id) else {
            return false;
        };
        let id = port_forward_note_id(host, port);
        let note = note.trim();
        if note.is_empty() && !pinned {
            connection.port_forwards.retain(|n| n.id != id);
            return true;
        }
        match connection.port_forwards.iter_mut().find(|n| n.id == id) {
            Some(existing) => {
                existing.host = host.to_string();
                existing.port = port;
                existing.note = note.to_string();
                existing.pinned = pinned;
            }
            None => connection.port_forwards.push(PortForwardNote {
                id,
                host: host.to_string(),
                port,
                note: note.to_string(),
                pinned,
            }),
        }
        true
    }
}

impl JsonPersistable for ConnectionStore {
    const SOURCE: crate::data::DataSourceId = crate::data::DataSourceId::Connections;
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
            key_id: None,
            group: group.map(String::from),
            last_connected: None,
            use_jump: false,
            jump_host: None,
            jump_port: None,
            jump_username: None,
            jump_auth_method: None,
            jump_key_path: None,
            jump_key_id: None,
            remote_platform: None,
            port_forwards: Vec::new(),
        }
    }

    fn store_of(items: Vec<SavedConnection>) -> ConnectionStore {
        ConnectionStore { connections: items }
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

    /// 备注 / 置顶：同一条记录上更新；只保留标题也想记住的条目；都清空就删掉。
    #[test]
    fn port_forward_note_upserts_and_clears() {
        let mut store = store_of(vec![conn("a", None)]);
        assert!(store.set_port_forward_note("a", "localhost", 3000, "  前端  ", false));
        let note = &store.get_by_id("a").unwrap().port_forwards[0];
        assert_eq!(note.id, "localhost|3000");
        assert_eq!(note.note, "前端");

        assert!(store.set_port_forward_note("a", "localhost", 3000, "前端", true));
        assert_eq!(store.get_by_id("a").unwrap().port_forwards.len(), 1);
        assert!(store.get_by_id("a").unwrap().port_forwards[0].pinned);

        // 只把备注清空、仍然置顶：记录留着
        assert!(store.set_port_forward_note("a", "localhost", 3000, "", true));
        assert_eq!(store.get_by_id("a").unwrap().port_forwards.len(), 1);

        // 备注和置顶都没了：删除
        assert!(store.set_port_forward_note("a", "localhost", 3000, "", false));
        assert!(store.get_by_id("a").unwrap().port_forwards.is_empty());

        // 未知连接：不动，返回 false
        assert!(!store.set_port_forward_note("zzz", "localhost", 3000, "x", true));
    }

    /// 字段名是 `portForwards`（camelCase），老数据没有这个字段也能读。
    #[test]
    fn port_forwards_field_is_camel_case_and_optional() {
        let mut store = store_of(vec![conn("a", None)]);
        store.set_port_forward_note("a", "localhost", 3000, "前端", true);
        let mut value = serde_json::to_value(&store).unwrap();
        assert_eq!(value["connections"][0]["portForwards"][0]["host"], "localhost");

        value
            .pointer_mut("/connections/0")
            .unwrap()
            .as_object_mut()
            .unwrap()
            .remove("portForwards");
        let legacy: ConnectionStore = serde_json::from_value(value).unwrap();
        assert!(legacy.get_by_id("a").unwrap().port_forwards.is_empty());
    }

    #[test]
    fn set_remote_platform_only_touches_the_matching_connection() {
        let mut store = store_of(vec![conn("a", None), conn("b", None)]);

        assert!(store.set_remote_platform("a", RemotePlatform::Windows));
        assert_eq!(
            store.get_by_id("a").unwrap().remote_platform,
            Some(RemotePlatform::Windows)
        );
        assert_eq!(store.get_by_id("b").unwrap().remote_platform, None);
        assert!(!store.set_remote_platform("missing", RemotePlatform::Linux));
    }

    #[test]
    fn remote_platform_uses_stable_lowercase_json_values() {
        assert_eq!(
            serde_json::to_string(&RemotePlatform::Windows).unwrap(),
            "\"windows\""
        );
        assert_eq!(
            serde_json::to_string(&RemotePlatform::Linux).unwrap(),
            "\"linux\""
        );
        assert_eq!(
            serde_json::to_string(&RemotePlatform::Macos).unwrap(),
            "\"macos\""
        );
        assert_eq!(
            serde_json::to_string(&RemotePlatform::Unix).unwrap(),
            "\"unix\""
        );
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
