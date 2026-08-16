use chrono::Utc;
use serde::{Deserialize, Serialize};

use super::persist::JsonPersistable;
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum QuickCommandScope {
    Global,
    Session,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    pub id: String,
    pub scope: QuickCommandScope,
    pub session_key: Option<String>,
    pub name: String,
    pub commands: Vec<String>,
    pub interval_ms: u64,
    /// 点击后仅插入内容（最后一行不回车），不自动执行，便于手动改参数
    #[serde(default)]
    pub insert_only: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommandInput {
    pub scope: QuickCommandScope,
    pub session_key: Option<String>,
    pub name: String,
    pub commands: Vec<String>,
    #[serde(default)]
    pub interval_ms: u64,
    /// 点击后仅插入内容（最后一行不回车），不自动执行，便于手动改参数
    #[serde(default)]
    pub insert_only: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommandPatch {
    pub scope: Option<QuickCommandScope>,
    pub session_key: Option<Option<String>>,
    pub name: Option<String>,
    pub commands: Option<Vec<String>>,
    pub interval_ms: Option<u64>,
    pub insert_only: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommandStore {
    pub commands: Vec<QuickCommand>,
}

impl QuickCommandStore {
    pub fn new() -> Self {
        Self {
            commands: Vec::new(),
        }
    }

    pub fn list_for_session(&self, session_key: Option<&str>) -> Vec<QuickCommand> {
        self.commands
            .iter()
            .filter(|cmd| match cmd.scope {
                QuickCommandScope::Global => true,
                QuickCommandScope::Session => session_key
                    .map(|key| cmd.session_key.as_deref() == Some(key))
                    .unwrap_or(false),
            })
            .cloned()
            .collect()
    }

    pub fn add(&mut self, id: String, input: QuickCommandInput) -> Result<QuickCommand, AppError> {
        validate_input(&input)?;
        let now = Utc::now().to_rfc3339();
        let command = QuickCommand {
            id,
            scope: input.scope,
            session_key: normalized_session_key(input.session_key),
            name: input.name.trim().to_string(),
            commands: normalize_commands(input.commands),
            interval_ms: input.interval_ms,
            insert_only: input.insert_only,
            created_at: now.clone(),
            updated_at: now,
        };
        self.commands.push(command.clone());
        Ok(command)
    }

    pub fn update(&mut self, id: &str, patch: QuickCommandPatch) -> Result<(), AppError> {
        let command = self
            .commands
            .iter_mut()
            .find(|cmd| cmd.id == id)
            .ok_or_else(|| AppError::Config(format!("未找到快捷指令: {}", id)))?;

        if let Some(scope) = patch.scope {
            command.scope = scope;
        }
        if let Some(session_key) = patch.session_key {
            command.session_key = normalized_session_key(session_key);
        }
        if let Some(name) = patch.name {
            command.name = name.trim().to_string();
        }
        if let Some(commands) = patch.commands {
            command.commands = normalize_commands(commands);
        }
        if let Some(interval_ms) = patch.interval_ms {
            command.interval_ms = interval_ms;
        }
        if let Some(insert_only) = patch.insert_only {
            command.insert_only = insert_only;
        }

        if command.scope == QuickCommandScope::Global {
            command.session_key = None;
        }

        validate_command(command)?;
        command.updated_at = Utc::now().to_rfc3339();
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let len_before = self.commands.len();
        self.commands.retain(|cmd| cmd.id != id);
        self.commands.len() < len_before
    }
}

impl JsonPersistable for QuickCommandStore {
    fn default_filename() -> &'static str {
        "quick_commands.json"
    }
}

fn validate_input(input: &QuickCommandInput) -> Result<(), AppError> {
    if input.name.trim().is_empty() {
        return Err(AppError::Config("快捷指令名称不能为空".into()));
    }
    let commands = normalize_commands(input.commands.clone());
    if commands.is_empty() {
        return Err(AppError::Config("快捷指令至少需要一条命令".into()));
    }
    if input.scope == QuickCommandScope::Session
        && normalized_session_key(input.session_key.clone()).is_none()
    {
        return Err(AppError::Config("会话快捷指令缺少连接配置 ID".into()));
    }
    Ok(())
}

fn validate_command(command: &QuickCommand) -> Result<(), AppError> {
    if command.name.trim().is_empty() {
        return Err(AppError::Config("快捷指令名称不能为空".into()));
    }
    if command.commands.is_empty() {
        return Err(AppError::Config("快捷指令至少需要一条命令".into()));
    }
    if command.scope == QuickCommandScope::Session
        && command
            .session_key
            .as_deref()
            .unwrap_or("")
            .trim()
            .is_empty()
    {
        return Err(AppError::Config("会话快捷指令缺少连接配置 ID".into()));
    }
    Ok(())
}

fn normalize_commands(commands: Vec<String>) -> Vec<String> {
    commands
        .into_iter()
        .map(|cmd| cmd.trim().to_string())
        .filter(|cmd| !cmd.is_empty())
        .collect()
}

fn normalized_session_key(session_key: Option<String>) -> Option<String> {
    session_key
        .map(|key| key.trim().to_string())
        .filter(|key| !key.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> QuickCommandStore {
        QuickCommandStore::new()
    }

    fn valid_global_input() -> QuickCommandInput {
        QuickCommandInput {
            scope: QuickCommandScope::Global,
            session_key: None,
            name: "My Command".into(),
            commands: vec!["echo hello".into(), "date".into()],
            interval_ms: 1000,
            insert_only: false,
        }
    }

    fn valid_session_input() -> QuickCommandInput {
        QuickCommandInput {
            scope: QuickCommandScope::Session,
            session_key: Some("conn-123".into()),
            name: "Session Cmd".into(),
            commands: vec!["ls -la".into()],
            interval_ms: 0,
            insert_only: false,
        }
    }

    #[test]
    fn add_global_command() {
        let mut s = store();
        let cmd = s.add("id-1".into(), valid_global_input()).unwrap();
        assert_eq!(cmd.name, "My Command");
        assert_eq!(cmd.scope, QuickCommandScope::Global);
        assert_eq!(cmd.commands.len(), 2);
        assert!(cmd.session_key.is_none());
    }

    #[test]
    fn add_session_command() {
        let mut s = store();
        let cmd = s.add("id-2".into(), valid_session_input()).unwrap();
        assert_eq!(cmd.scope, QuickCommandScope::Session);
        assert_eq!(cmd.session_key.as_deref(), Some("conn-123"));
    }

    #[test]
    fn add_persists_insert_only_flag() {
        let mut s = store();
        let input = QuickCommandInput {
            insert_only: true,
            ..valid_global_input()
        };
        let cmd = s.add("id-1".into(), input).unwrap();
        assert!(cmd.insert_only);
        let list = s.list_for_session(None);
        assert!(list[0].insert_only);
    }

    #[test]
    fn update_toggles_insert_only_flag() {
        let mut s = store();
        s.add("id-1".into(), valid_global_input()).unwrap();
        assert!(!s.list_for_session(None)[0].insert_only);

        let patch = QuickCommandPatch {
            insert_only: Some(true),
            scope: None,
            session_key: None,
            name: None,
            commands: None,
            interval_ms: None,
        };
        s.update("id-1", patch).unwrap();
        assert!(s.list_for_session(None)[0].insert_only);
    }

    #[test]
    fn old_json_without_insert_only_defaults_to_false() {
        let json = r#"{"id":"id-1","scope":"global","sessionKey":null,"name":"Old","commands":["ls"],"intervalMs":0,"createdAt":"t","updatedAt":"t"}"#;
        let cmd: QuickCommand = serde_json::from_str(json).unwrap();
        assert!(!cmd.insert_only);
    }

    #[test]
    fn add_rejects_empty_name() {
        let mut s = store();
        let input = QuickCommandInput {
            name: "   ".into(),
            ..valid_global_input()
        };
        assert!(s.add("id".into(), input).is_err());
    }

    #[test]
    fn add_rejects_empty_commands() {
        let mut s = store();
        let input = QuickCommandInput {
            commands: vec![],
            ..valid_global_input()
        };
        assert!(s.add("id".into(), input).is_err());
    }

    #[test]
    fn add_session_scope_requires_session_key() {
        let mut s = store();
        let input = QuickCommandInput {
            scope: QuickCommandScope::Session,
            session_key: None,
            ..valid_global_input()
        };
        assert!(s.add("id".into(), input).is_err());
    }

    #[test]
    fn update_existing_command() {
        let mut s = store();
        s.add("id-1".into(), valid_global_input()).unwrap();

        let patch = QuickCommandPatch {
            name: Some("Updated".into()),
            scope: None,
            session_key: None,
            commands: None,
            interval_ms: None,
            insert_only: None,
        };
        s.update("id-1", patch).unwrap();
        let list = s.list_for_session(None);
        assert_eq!(list[0].name, "Updated");
    }

    #[test]
    fn update_nonexistent_returns_error() {
        let mut s = store();
        let patch = QuickCommandPatch {
            name: Some("X".into()),
            scope: None,
            session_key: None,
            commands: None,
            interval_ms: None,
            insert_only: None,
        };
        assert!(s.update("nonexistent", patch).is_err());
    }

    #[test]
    fn update_clears_session_key_when_scope_changed_to_global() {
        let mut s = store();
        s.add("id-1".into(), valid_session_input()).unwrap();

        let patch = QuickCommandPatch {
            scope: Some(QuickCommandScope::Global),
            session_key: Some(None),
            name: None,
            commands: None,
            interval_ms: None,
            insert_only: None,
        };
        s.update("id-1", patch).unwrap();
        let list = s.list_for_session(None);
        assert_eq!(list.len(), 1);
    }

    #[test]
    fn remove_existing() {
        let mut s = store();
        s.add("id-1".into(), valid_global_input()).unwrap();
        assert!(s.remove("id-1"));
        assert!(s.list_for_session(None).is_empty());
    }

    #[test]
    fn remove_nonexistent_returns_false() {
        let mut s = store();
        assert!(!s.remove("nonexistent"));
    }

    #[test]
    fn list_for_session_filters_correctly() {
        let mut s = store();
        s.add(
            "g1".into(),
            QuickCommandInput {
                scope: QuickCommandScope::Global,
                name: "Global".into(),
                commands: vec!["g".into()],
                session_key: None,
                interval_ms: 0,
                insert_only: false,
            },
        )
        .unwrap();
        s.add(
            "s1".into(),
            QuickCommandInput {
                scope: QuickCommandScope::Session,
                name: "Session A".into(),
                commands: vec!["sa".into()],
                session_key: Some("conn-a".into()),
                interval_ms: 0,
                insert_only: false,
            },
        )
        .unwrap();

        let for_a = s.list_for_session(Some("conn-a"));
        assert_eq!(for_a.len(), 2); // global + session

        let for_b = s.list_for_session(Some("conn-b"));
        assert_eq!(for_b.len(), 1); // global only

        let none = s.list_for_session(None);
        assert_eq!(none.len(), 1); // global only
    }
}
