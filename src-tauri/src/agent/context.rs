use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Record of a command executed during a session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandRecord {
    pub command: String,
    pub output: String,
    pub exit_code: i32,
    pub timestamp: DateTime<Utc>,
}

/// Type of file change tracked during agent operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FileChangeType {
    Created,
    Modified,
    Deleted,
}

/// Record of a file change on the remote system.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileChange {
    pub path: String,
    pub change_type: FileChangeType,
    pub timestamp: DateTime<Utc>,
}

/// Context maintained for the agent during a session.
/// Provides server environment info and history for LLM calls.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionContext {
    pub os_info: String,
    pub shell_type: String,
    pub current_directory: String,
    pub command_history: Vec<CommandRecord>,
    pub file_changes: Vec<FileChange>,
}

impl SessionContext {
    pub fn new() -> Self {
        Self {
            os_info: String::new(),
            shell_type: String::from("bash"),
            current_directory: String::from("/"),
            command_history: Vec::new(),
            file_changes: Vec::new(),
        }
    }

    pub fn add_command_record(&mut self, record: CommandRecord) {
        self.command_history.push(record);
        // Keep only the last 100 commands to manage context size
        if self.command_history.len() > 100 {
            self.command_history.remove(0);
        }
    }

    pub fn add_file_change(&mut self, change: FileChange) {
        self.file_changes.push(change);
    }
}

impl Default for SessionContext {
    fn default() -> Self {
        Self::new()
    }
}
