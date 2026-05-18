use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::error::AppError;
use super::persist::JsonPersistable;

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
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommandPatch {
    pub scope: Option<QuickCommandScope>,
    pub session_key: Option<Option<String>>,
    pub name: Option<String>,
    pub commands: Option<Vec<String>>,
    pub interval_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommandStore {
    pub commands: Vec<QuickCommand>,
}

impl QuickCommandStore {
    pub fn new() -> Self {
        Self { commands: Vec::new() }
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
    if input.scope == QuickCommandScope::Session && normalized_session_key(input.session_key.clone()).is_none() {
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
    if command.scope == QuickCommandScope::Session && command.session_key.as_deref().unwrap_or("").trim().is_empty() {
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
