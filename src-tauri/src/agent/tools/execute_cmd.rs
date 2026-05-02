//! `execute_command` — run an arbitrary shell command on the remote server.
//!
//! Security:
//! - The [`Sandbox`] is consulted before execution and rejects destructive
//!   patterns regardless of agent mode.
//! - Higher-level confirmation/approval flow is implemented in
//!   `commands/agent.rs`, which wraps this tool with mode-aware policy.
//!
//! Sudo auto-fill:
//! - When a command starts with `sudo` and a password is available in the keychain,
//!   the command is rewritten to pipe the password via stdin (`sudo -S`).

use async_trait::async_trait;
use serde_json::json;

use crate::agent::sandbox::{self, RiskLevel, Sandbox};
use crate::agent::tools::{truncate_output, AgentTool, ToolContext, ToolOutput};
use crate::config::keychain;
use crate::error::AppError;

/// Maximum bytes of combined stdout+stderr returned to the LLM.
const MAX_OUTPUT_BYTES: usize = 8_000;

pub struct ExecuteCommandTool;

impl ExecuteCommandTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for ExecuteCommandTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl AgentTool for ExecuteCommandTool {
    fn name(&self) -> &str {
        "execute_command"
    }

    fn description(&self) -> &str {
        "Execute a shell command on the remote server. Returns combined \
         stdout+stderr. Long output is truncated. The command is statically \
         analyzed by a security sandbox before execution; some patterns \
         (e.g. `rm -rf /`, `mkfs`, dd-to-block-device, shell evasion) are \
         always rejected."
    }

    fn parameters_schema(&self) -> serde_json::Value {
        json!({
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "Shell command line to execute (run via the user's login shell)."
                }
            },
            "required": ["command"]
        })
    }

    fn risk_level(&self) -> RiskLevel {
        // Baseline. Real risk is computed per-invocation via [`sandbox::assess_risk`].
        RiskLevel::Moderate
    }

    async fn execute(
        &self,
        params: serde_json::Value,
        ctx: &ToolContext,
    ) -> Result<ToolOutput, AppError> {
        let command = params
            .get("command")
            .and_then(|v| v.as_str())
            .ok_or_else(|| AppError::Agent("Missing 'command' parameter".into()))?
            .trim();

        if command.is_empty() {
            return Ok(ToolOutput::fail(
                "execute_command",
                "Error: empty command",
            ));
        }

        // Static safety check. Higher-level policy (allow/deny lists, user
        // approval) is applied by `commands/agent.rs`.
        let sandbox = Sandbox::default();
        if let Err(e) = sandbox.check_command(command) {
            return Ok(ToolOutput::fail(
                format!("$ {}", command),
                format!("BLOCKED by sandbox: {}", e),
            )
            .with_metadata(json!({
                "blocked": true,
                "reason": e.to_string(),
            })));
        }

        let risk = sandbox::assess_risk(command);

        // Auto-inject password for sudo commands when running as non-root
        let final_command = if is_sudo_command(command) {
            match lookup_password(ctx).await {
                Some(password) => {
                    let rewritten = rewrite_sudo(command, &password);
                    log::info!("execute_command: sudo auto-fill enabled for cmd='{}'", command);
                    rewritten
                }
                None => {
                    log::debug!("execute_command: no password found for sudo auto-fill (session={})", ctx.session_id);
                    command.to_string()
                }
            }
        } else {
            command.to_string()
        };

        log::info!("execute_command: risk={:?} cmd={} final={}", risk, command, if final_command != command { "(auto-fill)" } else { "(original)" });

        match ctx.exec(&final_command).await {
            Ok(output) => {
                let truncated = truncate_output(output, MAX_OUTPUT_BYTES);
                Ok(ToolOutput::ok(format!("$ {}", command), truncated)
                    .with_metadata(json!({ "risk": format!("{:?}", risk) })))
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("$ {}", command),
                format!("execution failed: {}", e),
            )),
        }
    }
}

/// Check if a command starts with `sudo` (possibly preceded by env vars like `FOO=bar sudo`).
fn is_sudo_command(command: &str) -> bool {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return false;
    }

    // Skip leading environment variable assignments (e.g., "FOO=bar sudo ...")
    let mut remaining = trimmed;
    while let Some(eq_pos) = remaining.find('=') {
        // Check if the part before '=' is a valid variable name
        let before_eq = &remaining[..eq_pos];
        if before_eq.is_empty() || !before_eq.chars().all(|c| c.is_alphanumeric() || c == '_') {
            break;
        }
        // Find the end of this assignment (could be space-separated or quoted)
        let after_eq = &remaining[eq_pos + 1..];
        let rest = after_eq.trim_start();
        if let Some(first) = rest.chars().next() {
            if first == '"' || first == '\'' {
                // Skip to matching quote
                let quote = first;
                if let Some(end_quote) = rest[1..].find(quote) {
                    remaining = &rest[1 + end_quote + 1..];
                } else {
                    break;
                }
            } else {
                // Find next space
                if let Some(space_pos) = rest.find(' ') {
                    remaining = &rest[space_pos + 1..];
                } else {
                    // Only env var, no sudo after it
                    break;
                }
            }
        } else {
            break;
        }
        let remaining_trimmed = remaining.trim_start();
        if remaining_trimmed.starts_with("sudo ") || remaining_trimmed == "sudo" {
            return true;
        }
        if !remaining_trimmed.starts_with(|c: char| c.is_alphabetic() || c == '_') {
            break;
        }
    }

    // Simple check: first word is "sudo"
    trimmed.starts_with("sudo ") || trimmed == "sudo"
}

/// Look up the SSH password from keychain using the session's connection_id.
async fn lookup_password(ctx: &ToolContext) -> Option<String> {
    let connection_id = ctx.ssh.get_connection_id(&ctx.session_id).await;
    log::info!("execute_command: session={} connection_id={:?}", ctx.session_id, connection_id);

    match &connection_id {
        Some(id) => {
            match keychain::get_password(id) {
                Ok(Some(pw)) => {
                    log::info!("execute_command: password found for connection={}", id);
                    Some(pw)
                }
                Ok(None) => {
                    log::info!("execute_command: no password stored for connection={}", id);
                    None
                }
                Err(e) => {
                    log::warn!("execute_command: keychain error for connection={}: {}", id, e);
                    None
                }
            }
        }
        None => {
            log::debug!("execute_command: no connection_id for session, cannot look up password");
            None
        }
    }
}

/// Rewrite a sudo command to auto-fill password via stdin using sudo -S.
///
/// Uses printf with explicit newline to pipe password via stdin.
/// The -p '' suppresses the password prompt, and -S reads from stdin.
fn rewrite_sudo(command: &str, password: &str) -> String {
    // Escape single quotes in password for the shell
    let escaped_password = password.replace('\'', "'\\''");

    // Extract the actual command after "sudo"
    let sudo_arg = command
        .trim()
        .strip_prefix("sudo ")
        .unwrap_or(&command.trim()[5..]);

    // Use printf to pipe password to sudo's stdin via -S
    // The \\n ensures a newline is sent after the password
    format!(
        "printf '{}\\n' | sudo -S -p '' -- {}",
        escaped_password, sudo_arg
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_sudo_detects_plain_sudo() {
        assert!(is_sudo_command("sudo apt update"));
        assert!(is_sudo_command("sudo"));
    }

    #[test]
    fn is_sudo_detects_with_env_vars() {
        assert!(is_sudo_command("FOO=bar sudo apt update"));
        assert!(is_sudo_command("A=1 B=2 sudo ls"));
    }

    #[test]
    fn is_sudo_does_not_match() {
        assert!(!is_sudo_command("apt update"));
        assert!(!is_sudo_command("notsudo apt update"));
        assert!(!is_sudo_command("sudoedit file"));
    }

    #[test]
    fn rewrite_sudo_basic() {
        let result = rewrite_sudo("sudo apt update", "mypassword");
        assert!(result.contains("| sudo -S --"));
        assert!(result.contains("apt update"));
    }

    #[test]
    fn rewrite_sudo_escapes_quotes() {
        let result = rewrite_sudo("sudo ls", "pass'word");
        assert!(result.contains("'\\''"));
    }
}
