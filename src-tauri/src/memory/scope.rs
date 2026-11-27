//! 作用域解析：一个连接 / 一个 SSH 会话 → 它能看到哪几个作用域。
//!
//! 唯一来源：注入、`memory` / `memory_recall` 工具、复盘、管理页都经这里把
//! 「当前机器」翻译成作用域，不各自去读连接表。

use crate::config::connections::SavedConnection;
use crate::AppState;

use super::model::{Scope, ScopeRef};

/// 一段对话所在的位置：哪台机器、它属于哪个分组。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScopeContext {
    /// `SavedConnection.id`；本机子 agent 等没有机器的场合为 `None`（只剩全局）。
    pub connection_id: Option<String>,
    /// 连接名（给人和模型看）。连接已删除时为 `None`。
    pub connection_name: Option<String>,
    pub group: Option<String>,
}

impl ScopeContext {
    pub fn global_only() -> Self {
        Self::default()
    }

    pub fn host_scope(&self) -> Option<ScopeRef> {
        self.connection_id.clone().map(ScopeRef::host)
    }

    pub fn group_scope(&self) -> Option<ScopeRef> {
        self.group.clone().map(ScopeRef::group)
    }

    /// 能看到的作用域，固定顺序：全局 → 分组 → 这台机器（注入按这个顺序排版）。
    pub fn scopes(&self) -> Vec<ScopeRef> {
        let mut out = vec![ScopeRef::user()];
        out.extend(self.group_scope());
        out.extend(self.host_scope());
        out
    }

    /// 给人看的机器名：连接名，连接已删除时退回 id。
    pub fn host_label(&self) -> Option<String> {
        self.connection_name
            .clone()
            .or_else(|| self.connection_id.clone())
    }
}

fn normalized_group(group: Option<&str>) -> Option<String> {
    group
        .map(|g| g.trim().to_string())
        .filter(|g| !g.is_empty())
}

/// 纯函数版本：按连接表解析（可单测）。
pub fn from_connections(
    connections: &[SavedConnection],
    connection_id: Option<&str>,
) -> ScopeContext {
    let Some(id) = connection_id.filter(|id| !id.is_empty()) else {
        return ScopeContext::global_only();
    };
    match connections.iter().find(|c| c.id == id) {
        Some(c) => ScopeContext {
            connection_id: Some(c.id.clone()),
            connection_name: Some(c.name.clone()),
            group: normalized_group(c.group.as_deref()),
        },
        // 连接表里没有（调试连接 / 已删除）：机器作用域照样按 id 记，只是没有名字与分组。
        None => ScopeContext {
            connection_id: Some(id.to_string()),
            connection_name: None,
            group: None,
        },
    }
}

pub async fn for_connection(state: &AppState, connection_id: Option<&str>) -> ScopeContext {
    let store = state.connection_store.read().await;
    from_connections(store.get_all(), connection_id)
}

/// SSH 会话 → 作用域。本机子 agent 的哨兵会话 `"local"` 不在 SSH 管理器里，自然只剩全局。
pub async fn for_session(state: &AppState, session_id: &str) -> ScopeContext {
    let connection_id = state.ssh_manager.get_connection_id(session_id).await;
    for_connection(state, connection_id.as_deref()).await
}

/// 给人看的作用域名：「全局」「分组「prod」」「web-01」。
pub fn scope_display(scope: &ScopeRef, connections: &[SavedConnection]) -> String {
    match scope.scope {
        Scope::User => "全局".to_string(),
        Scope::Group => format!("分组「{}」", scope.key),
        Scope::Host => connections
            .iter()
            .find(|c| c.id == scope.key)
            .map(|c| format!("机器「{}」", c.name))
            .unwrap_or_else(|| "已删除的连接".to_string()),
    }
}

/// 从连接排序前后的分组变化里认出「分组改名」：旧组 G 整组搬进同一个新组 G'，
/// G 从此不再存在，且 G' 之前并不存在。
///
/// 前端没有单独的「改名」接口（改名就是把整组连接重新排一遍），所以只能这样认。
/// 认不出来的情形（组被拆散、并进已有分组）不迁移：那些分组记忆会在管理页的
/// 「已不存在的分组」里出现，由用户决定去留，不替用户猜。
pub fn detect_group_renames(
    before: &[(String, Option<String>)],
    after: &[(String, Option<String>)],
) -> Vec<(String, String)> {
    use std::collections::{BTreeMap, BTreeSet};
    let norm = |g: &Option<String>| normalized_group(g.as_deref());
    let groups_before: BTreeSet<String> = before.iter().filter_map(|(_, g)| norm(g)).collect();
    let groups_after: BTreeSet<String> = after.iter().filter_map(|(_, g)| norm(g)).collect();
    let after_by_id: BTreeMap<&str, Option<String>> =
        after.iter().map(|(id, g)| (id.as_str(), norm(g))).collect();
    let mut out = Vec::new();
    for old in groups_before.difference(&groups_after) {
        let members: Vec<&str> = before
            .iter()
            .filter(|(_, g)| norm(g).as_deref() == Some(old.as_str()))
            .map(|(id, _)| id.as_str())
            .collect();
        let targets: BTreeSet<Option<String>> = members
            .iter()
            .filter_map(|id| after_by_id.get(id).cloned())
            .collect();
        if targets.len() != 1 {
            continue;
        }
        if let Some(Some(new)) = targets.into_iter().next() {
            if !groups_before.contains(&new) {
                out.push((old.clone(), new));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(v: &[(&str, Option<&str>)]) -> Vec<(String, Option<String>)> {
        v.iter()
            .map(|(a, b)| (a.to_string(), b.map(String::from)))
            .collect()
    }

    #[test]
    fn detects_whole_group_rename_only() {
        let before = pairs(&[("a", Some("prod")), ("b", Some("prod")), ("c", Some("dev"))]);
        let renamed = pairs(&[("a", Some("生产")), ("b", Some("生产")), ("c", Some("dev"))]);
        assert_eq!(
            detect_group_renames(&before, &renamed),
            vec![("prod".into(), "生产".into())]
        );

        // 并进已有分组：不是改名
        let merged = pairs(&[("a", Some("dev")), ("b", Some("dev")), ("c", Some("dev"))]);
        assert!(detect_group_renames(&before, &merged).is_empty());

        // 拆散：不是改名
        let split = pairs(&[("a", Some("x")), ("b", None), ("c", Some("dev"))]);
        assert!(detect_group_renames(&before, &split).is_empty());

        // 只是重排：没有变化
        assert!(detect_group_renames(&before, &before).is_empty());
    }

    fn conn(id: &str, name: &str, group: Option<&str>) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: name.into(),
            host: "h".into(),
            port: 22,
            username: "u".into(),
            auth_method: "password".into(),
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

    #[test]
    fn scopes_follow_connection_and_group() {
        let conns = vec![
            conn("c1", "web-01", Some(" prod ")),
            conn("c2", "db", Some("")),
        ];
        let ctx = from_connections(&conns, Some("c1"));
        assert_eq!(
            ctx.scopes(),
            vec![
                ScopeRef::user(),
                ScopeRef::group("prod"),
                ScopeRef::host("c1")
            ]
        );
        assert_eq!(ctx.host_label().as_deref(), Some("web-01"));

        let ungrouped = from_connections(&conns, Some("c2"));
        assert_eq!(
            ungrouped.scopes(),
            vec![ScopeRef::user(), ScopeRef::host("c2")]
        );
    }

    #[test]
    fn unknown_or_missing_connection() {
        assert_eq!(from_connections(&[], None).scopes(), vec![ScopeRef::user()]);
        let gone = from_connections(&[], Some("deleted"));
        assert_eq!(
            gone.scopes(),
            vec![ScopeRef::user(), ScopeRef::host("deleted")]
        );
        assert_eq!(gone.host_label().as_deref(), Some("deleted"));
    }
}
