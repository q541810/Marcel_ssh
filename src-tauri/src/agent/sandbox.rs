use serde::{Deserialize, Serialize};

use crate::error::AppError;

/// Risk level for agent operations — determines approval requirements.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RiskLevel {
    ReadOnly,
    LowRisk,
    Moderate,
    HighRisk,
    Destructive,
}

/// Security policy configuration for the agent sandbox.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityPolicy {
    pub max_commands_per_task: usize,
    pub command_timeout_secs: u64,
    pub task_timeout_secs: u64,
    pub blocked_patterns: Vec<String>,
    pub blocked_base_commands: Vec<String>,
    pub protected_paths: Vec<String>,
    pub auto_approve_level: RiskLevel,
}

impl Default for SecurityPolicy {
    fn default() -> Self {
        Self {
            max_commands_per_task: 50,
            command_timeout_secs: 30,
            task_timeout_secs: 600,
            // Patterns that are always blocked (checked after normalization)
            blocked_patterns: vec![
                "rm -rf /".into(),
                "rm -fr /".into(),
                "rm --recursive --force /".into(),
                "rm --force --recursive /".into(),
                "> /dev/sda".into(),
                "> /dev/vda".into(),
                "> /dev/nvme".into(),
            ],
            // Base commands that are unconditionally blocked
            blocked_base_commands: vec![
                "mkfs".into(),
                "mkfs.ext4".into(),
                "mkfs.xfs".into(),
                "mkfs.btrfs".into(),
                "mkswap".into(),
                "shred".into(),
                "fdisk".into(),
                "parted".into(),
            ],
            protected_paths: vec![
                "/etc".into(),
                "/boot".into(),
                "/sys".into(),
                "/proc".into(),
                "/dev".into(),
            ],
            auto_approve_level: RiskLevel::ReadOnly,
        }
    }
}

/// Security sandbox that evaluates commands before execution.
pub struct Sandbox {
    policy: SecurityPolicy,
}

impl Sandbox {
    pub fn new(policy: SecurityPolicy) -> Self {
        Self { policy }
    }

    /// Check whether a command is allowed and determine its risk level.
    /// Returns Err if the command is blocked, Ok(RiskLevel) otherwise.
    pub fn check_command(&self, cmd: &str) -> Result<RiskLevel, AppError> {
        let trimmed = cmd.trim();

        // Reject empty commands
        if trimmed.is_empty() {
            return Err(AppError::Agent("Empty command".into()));
        }

        // Reject commands containing dangerous shell metacharacters / evasion patterns
        if Self::has_dangerous_patterns(trimmed) {
            return Err(AppError::Agent(
                "Command contains potentially dangerous shell patterns (pipes to shell, \
                 encoded execution, or eval). Use explicit commands instead."
                    .into(),
            ));
        }

        // Normalize whitespace for consistent pattern matching
        let normalized = Self::normalize_command(trimmed);

        // Check base command against unconditionally blocked list
        let base_cmd = normalized.split_whitespace().next().unwrap_or("");
        for blocked in &self.policy.blocked_base_commands {
            if base_cmd == blocked.as_str() || base_cmd.ends_with(&format!("/{}", blocked)) {
                return Err(AppError::Agent(format!(
                    "Command '{}' is blocked by security policy",
                    blocked
                )));
            }
        }

        // Check normalized command against blocked patterns
        for pattern in &self.policy.blocked_patterns {
            if normalized.contains(pattern.as_str()) {
                return Err(AppError::Agent(format!(
                    "Command blocked by security policy: matches pattern '{}'",
                    pattern
                )));
            }
        }

        // dd with output to block devices is always blocked
        if base_cmd == "dd" && Self::dd_targets_device(&normalized) {
            return Err(AppError::Agent(
                "dd writes to block devices are blocked".into(),
            ));
        }

        // Assess risk level
        let risk = assess_risk(trimmed);

        // If command modifies a protected path, elevate to HighRisk minimum
        if risk >= RiskLevel::LowRisk {
            for path in &self.policy.protected_paths {
                if normalized.contains(path.as_str()) {
                    return Ok(std::cmp::max(risk, RiskLevel::HighRisk));
                }
            }
        }

        Ok(risk)
    }

    /// Detect dangerous shell patterns that could be used to evade checks.
    fn has_dangerous_patterns(cmd: &str) -> bool {
        let dangerous = [
            // Piping to shell interpreters
            "| bash",
            "| sh",
            "| zsh",
            "| dash",
            "|bash",
            "|sh",
            // Encoded/obfuscated execution
            "base64 -d |",
            "base64 --decode |",
            "| base64 -d",
            // eval and exec
            "eval ",
            "exec ",
            // Process substitution
            "<(",
            // Backtick command substitution (legitimate use is rare in agent context)
            "`",
        ];
        let lower = cmd.to_lowercase();
        dangerous.iter().any(|p| lower.contains(p))
    }

    /// Normalize a command string: collapse whitespace, trim.
    fn normalize_command(cmd: &str) -> String {
        cmd.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    /// Check if a `dd` command writes to a block device.
    fn dd_targets_device(normalized_cmd: &str) -> bool {
        // Check for of=/dev/ pattern (output file to device)
        normalized_cmd.contains("of=/dev/")
    }

    /// Get the current security policy.
    pub fn policy(&self) -> &SecurityPolicy {
        &self.policy
    }
}

impl Default for Sandbox {
    fn default() -> Self {
        Self::new(SecurityPolicy::default())
    }
}

/// Heuristically determine the risk level of a command.
///
/// Note: This is a first-pass heuristic based on the base command name.
/// The Sandbox layer adds additional checks for protected paths, blocked
/// patterns, and shell evasion techniques.
pub fn assess_risk(cmd: &str) -> RiskLevel {
    let trimmed = cmd.trim();

    // Extract the base command (first word), stripping any path prefix
    let first_word = trimmed.split_whitespace().next().unwrap_or("");
    let base_cmd = first_word.rsplit('/').next().unwrap_or(first_word);

    // Check for output redirection — elevates risk of any command
    let has_write_redirect = trimmed.contains('>') || trimmed.contains(">>") || trimmed.contains("tee ");

    let base_risk = match base_cmd {
        // Read-only commands — safe to execute without confirmation
        "ls" | "cat" | "pwd" | "whoami" | "hostname" | "uname" | "date" | "uptime" | "df"
        | "du" | "free" | "top" | "ps" | "id" | "env" | "head" | "tail" | "wc" | "find"
        | "grep" | "egrep" | "fgrep" | "which" | "file" | "stat" | "lsof" | "netstat"
        | "ss" | "ifconfig" | "ip" | "dig" | "nslookup" | "ping" | "traceroute" | "curl"
        | "wget" | "less" | "more" | "sort" | "uniq" | "diff" | "md5sum" | "sha256sum"
        | "readlink" | "realpath" | "type" | "man" | "help" => RiskLevel::ReadOnly,

        // echo is ReadOnly *unless* it has redirection (checked below)
        "echo" | "printf" => RiskLevel::ReadOnly,

        // Low-risk commands — simple filesystem operations
        "mkdir" | "touch" | "cp" | "ln" | "tar" | "gzip" | "gunzip" | "zip" | "unzip"
        | "bzip2" | "xz" | "rsync" => RiskLevel::LowRisk,

        // Moderate risk — file modification, package management, services
        "mv" | "sed" | "awk" | "tee" | "nano" | "vim" | "vi" | "apt" | "apt-get" | "yum"
        | "dnf" | "pip" | "pip3" | "npm" | "npx" | "yarn" | "cargo" | "systemctl"
        | "service" | "docker" | "docker-compose" | "podman" | "git" | "crontab" | "at" => {
            RiskLevel::Moderate
        }

        // High-risk — destructive file ops, permission changes, process control
        "rm" | "chmod" | "chown" | "chgrp" | "kill" | "killall" | "pkill" | "iptables"
        | "ip6tables" | "nft" | "ufw" | "firewall-cmd" | "useradd" | "userdel" | "usermod"
        | "groupadd" | "groupdel" | "passwd" | "su" | "sudo" | "chroot" | "mount"
        | "umount" | "reboot" | "shutdown" | "poweroff" | "halt" | "init" => {
            RiskLevel::HighRisk
        }

        // Destructive — disk/partition operations
        "mkfs" | "fdisk" | "parted" | "dd" | "shred" | "wipefs" | "sgdisk" | "gdisk" => {
            RiskLevel::Destructive
        }

        // Default: moderate for unknown commands (conservative)
        _ => {
            // Handle mkfs.* variants (mkfs.ext4, mkfs.xfs, etc.)
            if base_cmd.starts_with("mkfs.") {
                RiskLevel::Destructive
            } else {
                RiskLevel::Moderate
            }
        }
    };

    // Elevate risk if output redirection is present
    if has_write_redirect && base_risk < RiskLevel::Moderate {
        return RiskLevel::Moderate;
    }

    base_risk
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_readonly_commands() {
        assert_eq!(assess_risk("ls -la"), RiskLevel::ReadOnly);
        assert_eq!(assess_risk("cat /etc/hosts"), RiskLevel::ReadOnly);
        assert_eq!(assess_risk("pwd"), RiskLevel::ReadOnly);
        assert_eq!(assess_risk("echo hello"), RiskLevel::ReadOnly);
    }

    #[test]
    fn test_echo_with_redirect_elevated() {
        // echo with redirection should be at least Moderate
        assert!(assess_risk("echo 'bad' > /etc/passwd") >= RiskLevel::Moderate);
    }

    #[test]
    fn test_destructive_commands() {
        assert_eq!(assess_risk("dd if=/dev/zero of=/dev/sda"), RiskLevel::Destructive);
        assert_eq!(assess_risk("mkfs.ext4 /dev/sda1"), RiskLevel::Destructive);
    }

    #[test]
    fn test_high_risk_commands() {
        assert_eq!(assess_risk("rm -rf /tmp/test"), RiskLevel::HighRisk);
        assert_eq!(assess_risk("sudo apt update"), RiskLevel::HighRisk);
        assert_eq!(assess_risk("chmod 777 /var/www"), RiskLevel::HighRisk);
    }

    #[test]
    fn test_sandbox_blocks_rm_rf_root() {
        let sandbox = Sandbox::default();
        assert!(sandbox.check_command("rm -rf /").is_err());
        // With extra spaces (normalized)
        assert!(sandbox.check_command("rm  -rf  /").is_err());
        // With long flags
        assert!(sandbox.check_command("rm --recursive --force /").is_err());
    }

    #[test]
    fn test_sandbox_blocks_mkfs() {
        let sandbox = Sandbox::default();
        assert!(sandbox.check_command("mkfs.ext4 /dev/sda1").is_err());
        assert!(sandbox.check_command("mkfs /dev/sda1").is_err());
    }

    #[test]
    fn test_sandbox_blocks_dd_to_device() {
        let sandbox = Sandbox::default();
        assert!(sandbox.check_command("dd if=/dev/zero of=/dev/sda").is_err());
        // Reordered flags
        assert!(sandbox.check_command("dd of=/dev/sda if=/dev/zero").is_err());
    }

    #[test]
    fn test_sandbox_blocks_shell_evasion() {
        let sandbox = Sandbox::default();
        assert!(sandbox.check_command("cat /etc/shadow | bash").is_err());
        assert!(sandbox.check_command("echo cm0gLXJmIC8= | base64 -d | sh").is_err());
        assert!(sandbox.check_command("eval 'rm -rf /'").is_err());
    }

    #[test]
    fn test_sandbox_allows_safe_commands() {
        let sandbox = Sandbox::default();
        assert!(sandbox.check_command("ls -la").is_ok());
        assert!(sandbox.check_command("cat /var/log/syslog").is_ok());
        assert!(sandbox.check_command("mkdir /tmp/test").is_ok());
    }

    #[test]
    fn test_sandbox_elevates_protected_path_risk() {
        let sandbox = Sandbox::default();
        // mkdir is normally LowRisk, but /etc should elevate to HighRisk
        let risk = sandbox.check_command("mkdir /etc/myapp").unwrap();
        assert!(risk >= RiskLevel::HighRisk);
    }

    #[test]
    fn test_path_prefixed_commands() {
        // Commands with full path should still be classified correctly
        assert_eq!(assess_risk("/usr/bin/ls -la"), RiskLevel::ReadOnly);
        assert_eq!(assess_risk("/bin/rm -rf /tmp/test"), RiskLevel::HighRisk);
    }
}
