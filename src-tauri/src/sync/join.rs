//! 加入同步时的「本机数据与云端对账」：纯函数，不碰 IO。
//!
//! 加入的原则是**云端赢、本机独有的保留**（本机数据以 `Hlc::zero_for` 并入镜像）。唯一需要额外处理的
//! 是**同一台服务器在两边有不同 id**：用户在新设备上先手动加过一遍同一台服务器，再加入同步，
//! 连接列表里就会出现两条一模一样的服务器。所以按「主机 + 端口 + 用户名」认出重复，保留云端那条
//! （id 是各设备共用的），把本机那条删掉，并把对它的引用改写成云端的 id。

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::core::{Path, Seg};
use super::store::PersistedState;
use crate::config::connections::SavedConnection;
use crate::ssh::known_hosts::KnownHostEntry;

/// 同步码里带的 SFTP 服务器信息（连接配置 + 主机指纹）。**不含私钥，也不含密码**
/// （密码在同步码的 `secret` 字段里）。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpBundle {
    pub connection: SavedConnection,
    /// 创建者本机记录的这台服务器的主机指纹：等于用户在旧设备上确认过了。
    #[serde(default)]
    pub host_key: Option<HostKeyBundle>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyBundle {
    pub host: String,
    pub port: u16,
    pub entry: KnownHostEntry,
}

/// 云端镜像里可见的连接：id → (主机小写, 端口, 用户名)。
fn cloud_connection_keys(
    visible: &BTreeMap<Path, Value>,
) -> BTreeMap<String, (Option<String>, Option<u64>, Option<String>)> {
    let mut out: BTreeMap<String, (Option<String>, Option<u64>, Option<String>)> = BTreeMap::new();
    for (path, value) in visible {
        let [Seg::Key(list), Seg::Id { id }, Seg::Key(field)] = path.as_slice() else {
            continue;
        };
        if list != "connections" {
            continue;
        }
        let entry = out.entry(id.clone()).or_default();
        match field.as_str() {
            "host" => entry.0 = value.as_str().map(|s| s.trim().to_lowercase()),
            "port" => entry.1 = value.as_u64(),
            "username" => entry.2 = value.as_str().map(|s| s.trim().to_string()),
            _ => {}
        }
    }
    out.retain(|_, (h, p, u)| h.is_some() && p.is_some() && u.is_some());
    out
}

/// 本机连接里和云端重复的：从 `local_doc` 删掉，返回 `(本机 id, 云端 id)`。
///
/// 一条云端连接最多认领一条本机连接；id 相同的不算重复（同一条）。
pub fn reconcile_connections(
    local_doc: &mut Value,
    cloud_visible: &BTreeMap<Path, Value>,
) -> Vec<(String, String)> {
    let cloud = cloud_connection_keys(cloud_visible);
    if cloud.is_empty() {
        return Vec::new();
    }
    let Some(list) = local_doc
        .get_mut("connections")
        .and_then(Value::as_array_mut)
    else {
        return Vec::new();
    };
    let local_ids: BTreeSet<String> = list
        .iter()
        .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
        .collect();

    let mut claimed: BTreeSet<String> = BTreeSet::new();
    let mut pairs = Vec::new();
    for conn in list.iter() {
        let Some(id) = conn.get("id").and_then(Value::as_str) else {
            continue;
        };
        if cloud.contains_key(id) {
            continue; // 本机和云端是同一条
        }
        let host = conn
            .get("host")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_lowercase());
        let port = conn.get("port").and_then(Value::as_u64);
        let user = conn
            .get("username")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string());
        let (Some(host), Some(port), Some(user)) = (host, port, user) else {
            continue;
        };
        let twin = cloud.iter().find(|(cloud_id, (h, p, u))| {
            !local_ids.contains(*cloud_id)
                && !claimed.contains(*cloud_id)
                && h.as_deref() == Some(host.as_str())
                && *p == Some(port)
                && u.as_deref() == Some(user.as_str())
        });
        if let Some((cloud_id, _)) = twin {
            claimed.insert(cloud_id.clone());
            pairs.push((id.to_string(), cloud_id.clone()));
        }
    }
    if !pairs.is_empty() {
        let drop: BTreeSet<&str> = pairs.iter().map(|(l, _)| l.as_str()).collect();
        list.retain(|c| {
            !c.get("id")
                .and_then(Value::as_str)
                .is_some_and(|id| drop.contains(id))
        });
    }
    pairs
}

/// 把文档里对旧连接 id 的引用改写成新 id（连接去重之后）。返回改写了几处。
///
/// 目前有两处引用连接 id：快捷指令的 `sessionKey`（范围是「某台连接」的快捷指令），
/// 以及设置里多机操控的目标机器清单 `experimentalSettings.multiHostConnectionIds`。
pub fn remap_connection_refs(
    source: &str,
    doc: &mut Value,
    map: &BTreeMap<String, String>,
) -> usize {
    if map.is_empty() {
        return 0;
    }
    let mut changed = 0;
    match source {
        "quickCommands" => {
            if let Some(list) = doc.get_mut("commands").and_then(Value::as_array_mut) {
                for cmd in list {
                    if let Some(key) = cmd.get("sessionKey").and_then(Value::as_str) {
                        if let Some(new) = map.get(key) {
                            cmd["sessionKey"] = Value::String(new.clone());
                            changed += 1;
                        }
                    }
                }
            }
        }
        "settings" => {
            if let Some(ids) = doc
                .pointer_mut("/experimentalSettings/multiHostConnectionIds")
                .and_then(Value::as_array_mut)
            {
                let mut seen = BTreeSet::new();
                let mut next: Vec<Value> = Vec::with_capacity(ids.len());
                for v in ids.iter() {
                    let s = v
                        .as_str()
                        .map(|s| map.get(s).map(String::as_str).unwrap_or(s));
                    match s {
                        Some(s) => {
                            if v.as_str() != Some(s) {
                                changed += 1;
                            }
                            if seen.insert(s.to_string()) {
                                next.push(Value::String(s.to_string()));
                            }
                        }
                        None => next.push(v.clone()),
                    }
                }
                *ids = next;
            }
        }
        _ => {}
    }
    changed
}

/// 把一次加入产生的「本机 id → 云端 id」记进账本，供以后的上传 / 落地换算。
///
/// 链式合并：如果云端 id 自己也在表里（A→B、B→C），新加的 A→B 不用展平——`resolve_connection_id`
/// 会跟到底。这里只负责去重（同一条别名不重复写）与置脏。
pub fn record_connection_aliases(state: &mut PersistedState, pairs: &[(String, String)]) -> usize {
    let mut changed = 0;
    for (local, cloud) in pairs {
        if local == cloud {
            continue;
        }
        if state.connection_aliases.get(local) == Some(cloud) {
            continue;
        }
        state
            .connection_aliases
            .insert(local.clone(), cloud.clone());
        changed += 1;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn visible_conn(id: &str, host: &str, port: u64, user: &str) -> BTreeMap<Path, Value> {
        let mut m = BTreeMap::new();
        for (field, v) in [
            ("host", json!(host)),
            ("port", json!(port)),
            ("username", json!(user)),
        ] {
            m.insert(
                vec![Seg::key("connections"), Seg::id(id), Seg::key(field)],
                v,
            );
        }
        m
    }

    fn doc(conns: Value) -> Value {
        json!({"connections": conns})
    }

    #[test]
    fn aliases_are_recorded_and_survive_as_a_chain() {
        let mut st = PersistedState::default();
        assert_eq!(
            record_connection_aliases(&mut st, &[("local-1".into(), "cloud-1".into())]),
            1
        );
        assert_eq!(st.connection_aliases["local-1"], "cloud-1");
        // 重复写入不算改动
        assert_eq!(
            record_connection_aliases(&mut st, &[("local-1".into(), "cloud-1".into())]),
            0
        );
        // 同一个本机 id 改指别的云端 id（极少见）：以新的为准
        assert_eq!(
            record_connection_aliases(&mut st, &[("local-1".into(), "cloud-2".into())]),
            1
        );
        assert_eq!(st.connection_aliases["local-1"], "cloud-2");
        // 链：A→B、B→C ⇒ A→C
        record_connection_aliases(&mut st, &[("A".into(), "B".into())]);
        record_connection_aliases(&mut st, &[("B".into(), "C".into())]);
        assert_eq!(st.resolve_connection_id("A"), "C");
        // 自指不记
        assert_eq!(
            record_connection_aliases(&mut st, &[("x".into(), "x".into())]),
            0
        );
        assert!(!st.connection_aliases.contains_key("x"));
    }

    #[test]
    fn duplicate_server_is_dropped_in_favour_of_the_cloud_one() {
        let cloud = visible_conn("cloud-1", "Example.com", 22, "root");
        let mut local = doc(json!([
            {"id": "local-1", "name": "我手动加的", "host": "example.com", "port": 22, "username": "root"},
            {"id": "local-2", "name": "本机独有", "host": "other.net", "port": 22, "username": "root"},
        ]));
        let pairs = reconcile_connections(&mut local, &cloud);
        assert_eq!(pairs, vec![("local-1".to_string(), "cloud-1".to_string())]);
        let ids: Vec<&str> = local["connections"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["local-2"], "本机独有的保留");
    }

    #[test]
    fn different_port_or_user_is_not_a_duplicate() {
        let cloud = visible_conn("c", "h", 22, "root");
        for (port, user) in [(2222u64, "root"), (22, "deploy")] {
            let mut local = doc(json!([
                {"id": "l", "host": "h", "port": port, "username": user}
            ]));
            assert!(reconcile_connections(&mut local, &cloud).is_empty());
            assert_eq!(local["connections"].as_array().unwrap().len(), 1);
        }
    }

    #[test]
    fn same_id_on_both_sides_is_the_same_connection() {
        let cloud = visible_conn("same", "h", 22, "u");
        let mut local = doc(json!([{"id": "same", "host": "h", "port": 22, "username": "u"}]));
        assert!(reconcile_connections(&mut local, &cloud).is_empty());
        assert_eq!(local["connections"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn one_cloud_connection_claims_at_most_one_local_twin() {
        let cloud = visible_conn("c", "h", 22, "u");
        let mut local = doc(json!([
            {"id": "l1", "host": "h", "port": 22, "username": "u"},
            {"id": "l2", "host": "h", "port": 22, "username": "u"},
        ]));
        let pairs = reconcile_connections(&mut local, &cloud);
        assert_eq!(pairs.len(), 1);
        assert_eq!(local["connections"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn references_follow_the_surviving_connection() {
        let map: BTreeMap<String, String> = [("local-1".to_string(), "cloud-1".to_string())].into();

        let mut qc = json!({"commands": [
            {"id": "q1", "scope": "session", "sessionKey": "local-1"},
            {"id": "q2", "scope": "session", "sessionKey": "other"},
            {"id": "q3", "scope": "global", "sessionKey": null},
        ]});
        assert_eq!(remap_connection_refs("quickCommands", &mut qc, &map), 1);
        assert_eq!(qc["commands"][0]["sessionKey"], json!("cloud-1"));
        assert_eq!(qc["commands"][1]["sessionKey"], json!("other"));

        let mut settings = json!({"experimentalSettings": {"multiHostConnectionIds": ["local-1", "cloud-1", "x"]}});
        assert_eq!(remap_connection_refs("settings", &mut settings, &map), 1);
        assert_eq!(
            settings["experimentalSettings"]["multiHostConnectionIds"],
            json!(["cloud-1", "x"]),
            "改写后重复的去掉"
        );

        // 不认识的源 / 空映射：什么都不动
        let mut other = json!({"a": 1});
        assert_eq!(remap_connection_refs("skills", &mut other, &map), 0);
        assert_eq!(
            remap_connection_refs("settings", &mut settings, &BTreeMap::new()),
            0
        );
    }
}
