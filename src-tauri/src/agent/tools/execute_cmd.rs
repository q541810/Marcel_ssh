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
use std::time::Duration;
use zeroize::Zeroize;

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
         always rejected. Timeout is configured by the user (default 120s)."
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
            return Ok(ToolOutput::fail("execute_command", "Error: empty command"));
        }

        // Static safety check. Higher-level policy (allow/deny lists, user
        // approval) is applied by `commands/agent.rs`.
        let sandbox = match ctx.policy.as_ref() {
            Some(p) => Sandbox::new((**p).clone()),
            None => Sandbox::default(),
        };
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
        let mut sudo_password: Option<String> = None;
        let final_command = if is_sudo_command(command) {
            match lookup_password(ctx).await {
                Some(password) => {
                    let rewritten = rewrite_sudo(command, &password);
                    log::info!(
                        "execute_command: sudo auto-fill enabled for cmd='{}'",
                        command
                    );
                    sudo_password = Some(password);
                    rewritten
                }
                None => {
                    log::debug!(
                        "execute_command: no password found for sudo auto-fill (session={})",
                        ctx.session_id
                    );
                    command.to_string()
                }
            }
        } else {
            command.to_string()
        };

        log::info!(
            "execute_command: risk={:?} cmd={} final={}",
            risk,
            command,
            if final_command != command {
                "(auto-fill)"
            } else {
                "(original)"
            }
        );

        let timeout_secs = ctx
            .policy
            .as_ref()
            .map(|p| p.command_timeout_secs)
            .unwrap_or(180);
        let timeout = Duration::from_secs(timeout_secs);

        // Use streaming exec if we have a tool_call_id and event_name, otherwise fall back to timed
        let exec_result =
            if let (Some(tool_call_id), Some(event_name)) = (&ctx.tool_call_id, &ctx.event_name) {
                ctx.exec_streamed(&final_command, timeout, event_name, tool_call_id)
                    .await
            } else {
                ctx.exec_timed(&final_command, timeout).await
            };

        // Zeroize password and rewritten command immediately after execution
        if let Some(ref mut p) = sudo_password {
            p.zeroize();
        }
        let mut cmd = final_command;
        cmd.zeroize();

        match exec_result {
            Ok((output, was_timeout)) => {
                let mut truncated = truncate_output(output, MAX_OUTPUT_BYTES);
                if was_timeout {
                    truncated.push_str(&format!(
                        "\n\n[命令执行在 {} 秒后超时，已停止等待输出；远端进程可能仍在运行]",
                        timeout_secs
                    ));
                }
                Ok(
                    ToolOutput::ok(format!("$ {}", command), truncated).with_metadata(
                        json!({ "risk": format!("{:?}", risk), "was_timeout": was_timeout }),
                    ),
                )
            }
            Err(e) => Ok(ToolOutput::fail(
                format!("$ {}", command),
                format!("execution failed: {}", e),
            )),
        }
    }
}

/// Check if a command starts with `sudo` (possibly preceded by env-var
/// assignments such as `FOO=bar sudo ...`). Recognises `sudo`, `sudo `
/// and `sudo\t`. Never panics.
fn is_sudo_command(command: &str) -> bool {
    let mut remaining = command.trim();
    loop {
        if remaining == "sudo" || remaining.starts_with("sudo ") || remaining.starts_with("sudo\t")
        {
            return true;
        }
        // Try to peel off a leading `NAME=value` (value may be quoted).
        let eq_pos = match remaining.find('=') {
            Some(p) => p,
            None => return false,
        };
        let name = &remaining[..eq_pos];
        if name.is_empty()
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            || name.chars().next().map_or(true, |c| c.is_ascii_digit())
        {
            return false;
        }
        let after_eq = &remaining[eq_pos + 1..];
        let advanced = match after_eq.chars().next() {
            Some('"') | Some('\'') => {
                let quote = after_eq.chars().next().unwrap();
                match after_eq[1..].find(quote) {
                    Some(end) => &after_eq[1 + end + 1..],
                    None => return false,
                }
            }
            _ => match after_eq.find(|c: char| c == ' ' || c == '\t') {
                Some(p) => &after_eq[p..],
                None => return false,
            },
        };
        let next = advanced.trim_start_matches(|c: char| c == ' ' || c == '\t');
        if next.len() == remaining.len() {
            return false;
        }
        remaining = next;
    }
}

/// Look up the SSH password from keychain using the session's connection_id.
/// NEVER logs the actual password content.
async fn lookup_password(ctx: &ToolContext) -> Option<String> {
    let connection_id = ctx.ssh.get_connection_id(&ctx.session_id).await;
    log::info!(
        "execute_command: session={} connection_id={:?}",
        ctx.session_id,
        connection_id
    );

    match &connection_id {
        Some(id) => {
            let result = keychain::get_password(id);
            match &result {
                Ok(Some(_)) => {
                    log::info!("execute_command: password available for connection={}", id);
                }
                Ok(None) => {
                    log::info!("execute_command: no password stored for connection={}", id);
                }
                Err(e) => {
                    log::warn!(
                        "execute_command: keychain error for connection={}: {}",
                        id,
                        e
                    );
                }
            }
            result.ok().flatten()
        }
        None => {
            log::debug!("execute_command: no connection_id for session, cannot look up password");
            None
        }
    }
}

/// Rewrite a sudo command to auto-fill password via stdin using `sudo -S`.
///
/// The password is passed as a `printf` **argument** (not embedded in the
/// format string), so characters like `%s` in the password stay literal.
/// Single quotes in the password are escaped for the surrounding shell.
fn rewrite_sudo(command: &str, password: &str) -> String {
    let escaped_password = password.replace('\'', "'\\''");

    // Extract everything after the leading `sudo` token. Works for
    // "sudo args...", "sudo\targs..." and bare "sudo".
    let trimmed = command.trim();
    let sudo_arg = trimmed
        .strip_prefix("sudo ")
        .or_else(|| trimmed.strip_prefix("sudo\t"))
        .unwrap_or("");

    format!(
        "printf '%s\\n' '{}' | sudo -S -p '' -- {}",
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
        assert_eq!(
            result,
            "printf '%s\\n' 'mypassword' | sudo -S -p '' -- apt update"
        );
    }

    #[test]
    fn rewrite_sudo_escapes_quotes() {
        let result = rewrite_sudo("sudo ls", "pass'word");
        assert!(
            result.contains("'pass'\\''word'"),
            "expected escaped password in output: {}",
            result
        );
    }

    #[test]
    fn rewrite_sudo_does_not_panic_on_bare_sudo() {
        let _ = rewrite_sudo("sudo", "pw");
        let _ = rewrite_sudo("  sudo  ", "pw");
    }

    #[test]
    fn rewrite_sudo_handles_tab_separator() {
        let result = rewrite_sudo("sudo\tls -l", "pw");
        assert!(result.contains("-- ls -l"), "got: {}", result);
    }

    #[test]
    fn rewrite_sudo_password_with_format_specifier_is_literal() {
        let result = rewrite_sudo("sudo ls", "ab%scd");
        // Password must appear literally inside single quotes as a printf
        // argument, not in the format string.
        assert!(result.contains("'ab%scd'"), "got: {}", result);
        assert!(result.starts_with("printf '%s\\n' '"), "got: {}", result);
    }
}
