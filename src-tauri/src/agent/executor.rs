use serde::{Deserialize, Serialize};

/// Result of a command executed on the remote server.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
}

/// Executor responsible for running commands on remote SSH sessions.
pub struct CommandExecutor;

impl CommandExecutor {
    pub fn new() -> Self {
        Self
    }

    /// Execute a command on the remote server (stubbed).
    /// In Phase 1 this will use the SSH channel to run the command.
    pub fn execute(&self, _session_id: &str, command: &str) -> Result<CommandResult, crate::error::AppError> {
        // Stub implementation — return a placeholder result
        log::info!("Stub execute: {}", command);
        Ok(CommandResult {
            exit_code: 0,
            stdout: format!("[stub] executed: {}", command),
            stderr: String::new(),
            duration_ms: 0,
        })
    }
}

impl Default for CommandExecutor {
    fn default() -> Self {
        Self::new()
    }
}
