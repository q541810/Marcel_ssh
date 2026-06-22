use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::agent::RiskLevel;
use crate::error::AppError;

use super::checker::{
    analyze_rm_args, contains_top_level_pipe, is_bare_shell, is_dangerous_rm_target, is_fork_bomb,
    looks_like_path, normalize_path, pattern_matches,
};
use super::parser::{parse_segment, split_command_chain};
use super::risk_model::parse_and_classify;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityPolicy {
    pub max_commands_per_task: usize,
    pub command_timeout_secs: u64,
    pub task_timeout_secs: u64,
    pub blocked_patterns: Vec<String>,
    pub blocked_base_commands: Vec<String>,
    pub protected_paths: Vec<String>,
    #[serde(default)]
    pub custom_protected_paths: Vec<String>,
    pub auto_approve_level: RiskLevel,
}

impl SecurityPolicy {
    /// Check whether `path` falls under any protected system directory
    /// (built-in or user-defined).
    pub fn is_protected_path(&self, path: &str) -> bool {
        let norm = normalize_path(path);
        let np = Path::new(&norm);
        self.protected_paths
            .iter()
            .chain(self.custom_protected_paths.iter())
            .any(|prot| np.starts_with(prot))
    }

    /// Build a policy from the user's persisted settings, layering
    /// `custom_protected_paths` on top of the built-in defaults.
    pub fn from_user_settings(custom_paths: &[String], command_timeout_secs: u64) -> Self {
        let mut p = Self::default();
        p.custom_protected_paths = custom_paths.to_vec();
        p.command_timeout_secs = command_timeout_secs;
        p
    }
}
impl Default for SecurityPolicy {
    fn default() -> Self {
        Self {
            max_commands_per_task: 50,
            command_timeout_secs: 120,
            task_timeout_secs: 600,
            blocked_patterns: vec![
                "rm -rf /".into(),
                "rm -fr /".into(),
                "rm --recursive --force /".into(),
                "rm --force --recursive /".into(),
            ],
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
            custom_protected_paths: vec![],
            auto_approve_level: RiskLevel::ReadOnly,
        }
    }
}

pub struct Sandbox {
    policy: SecurityPolicy,
}

impl Sandbox {
    pub fn new(policy: SecurityPolicy) -> Self {
        Self { policy }
    }

    pub fn policy(&self) -> &SecurityPolicy {
        &self.policy
    }

    pub fn check_command(&self, cmd: &str) -> Result<RiskLevel, AppError> {
        let trimmed = cmd.trim();
        if trimmed.is_empty() {
            return Err(AppError::Agent("Empty command".into()));
        }

        // Fork bomb detection on the raw string, before splitting.
        if is_fork_bomb(trimmed) {
            return Err(AppError::Agent("Fork bomb pattern detected".into()));
        }

        // Shared parsing + baseline risk classification.
        let (all_segments, all_tokens, base_risk) = parse_and_classify(trimmed)?;

        // Policy enforcement on parsed segments.
        let has_pipe = contains_top_level_pipe(trimmed);
        for (raw_seg, tokens) in all_segments.iter().zip(all_tokens.iter()) {
            if tokens.is_empty() {
                continue;
            }
            let base_cmd = tokens[0].as_str();
            let args = &tokens[1..];

            // 1. Blocked base commands (exact + mkfs.* prefix).
            for blocked in &self.policy.blocked_base_commands {
                if base_cmd == blocked {
                    return Err(AppError::Agent(format!(
                        "Command '{}' is blocked by security policy",
                        blocked
                    )));
                }
            }
            if base_cmd.starts_with("mkfs.") {
                return Err(AppError::Agent(format!(
                    "Command '{}' is blocked by security policy",
                    base_cmd
                )));
            }

            // 2. Fork bomb: name() { ... | ... & } ;
            // (already checked on raw string above)

            // 3. Embedded eval: shell -c <s>, eval <s>, source/.
            if let Ok(parsed) = parse_segment(raw_seg) {
                if let Some((kind, inner)) = &parsed.embedded_eval {
                    if kind == "source" || kind == "." {
                        // HighRisk but not blocked — continue to other segments.
                    } else if let Some(s) = inner {
                        // Recursively enforce policy on inner command.
                        self.check_command(s)?;
                    }
                }
                // Bare shell as pipe sink: `... | bash` etc.
                if has_pipe && is_bare_shell(&parsed) {
                    return Err(AppError::Agent(
                        "Piping into a shell interpreter is blocked".into(),
                    ));
                }
            }

            // 4. rm -r [-f] <dangerous-target>
            if base_cmd == "rm" {
                let (recursive, _force, paths) = analyze_rm_args(args);
                if recursive {
                    for p in &paths {
                        if is_dangerous_rm_target(p) {
                            return Err(AppError::Agent(format!(
                                "Refusing to recursively remove dangerous path: {}",
                                p
                            )));
                        }
                    }
                }
            }

            // 5. dd of=/dev/...
            if base_cmd == "dd" {
                for a in args {
                    if let Some(val) = a.strip_prefix("of=") {
                        let norm = normalize_path(val);
                        if norm.starts_with("/dev/") {
                            return Err(AppError::Agent(
                                "dd writes to block devices are blocked".into(),
                            ));
                        }
                    }
                }
            }

            // 6. blocked_patterns against original segment string.
            for pat in &self.policy.blocked_patterns {
                if pattern_matches(raw_seg, pat) {
                    return Err(AppError::Agent(format!(
                        "Command blocked by security policy: matches pattern '{}'",
                        pat
                    )));
                }
            }
        }

        // 7. Protected paths in path-like args + redirect targets.
        // Re-parse for redirect_targets.
        let segments = split_command_chain(trimmed).unwrap_or_default();
        let mut final_risk = base_risk;
        for seg in &segments {
            if let Ok(parsed) = parse_segment(seg) {
                let seg_risk = if parsed.sudo_wrapped && final_risk < RiskLevel::HighRisk {
                    RiskLevel::HighRisk
                } else {
                    final_risk
                };

                let mut candidate_paths: Vec<String> = parsed
                    .args
                    .iter()
                    .filter(|a| looks_like_path(a))
                    .cloned()
                    .collect();
                candidate_paths.extend(parsed.redirect_targets.iter().cloned());
                if seg_risk >= RiskLevel::LowRisk {
                    for p in &candidate_paths {
                        let norm = normalize_path(p);
                        let np = Path::new(&norm);
                        for prot in &self.policy.protected_paths {
                            if np.starts_with(prot) {
                                final_risk = std::cmp::max(seg_risk, RiskLevel::HighRisk);
                            }
                        }
                    }
                }
                if seg_risk > final_risk {
                    final_risk = seg_risk;
                }
            }
        }

        Ok(final_risk)
    }
}

impl Default for Sandbox {
    fn default() -> Self {
        Self::new(SecurityPolicy::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_protected_path_matches_known_protected_dirs() {
        let policy = SecurityPolicy::default();
        for protected in &policy.protected_paths {
            let path = format!("{}/some/file.txt", protected);
            assert!(
                policy.is_protected_path(&path),
                "expected `{}` to be detected as protected",
                path
            );
        }
    }

    #[test]
    fn is_protected_path_rejects_unrelated_paths() {
        let policy = SecurityPolicy::default();
        for path in ["/home/user/x.txt", "/tmp/foo", "/var/tmp/bar"] {
            assert!(
                !policy.is_protected_path(path),
                "expected `{}` to NOT be protected",
                path
            );
        }
    }

    #[test]
    fn is_protected_path_normalizes_relative_components() {
        let policy = SecurityPolicy::default();
        // /etc/foo/../cron.d/evil still falls under /etc after normalization
        assert!(policy.is_protected_path("/etc/foo/../cron.d/evil"));
        assert!(policy.is_protected_path("/etc//cron.d/evil"));
    }

    #[test]
    fn is_protected_path_checks_custom_protected_paths() {
        let mut policy = SecurityPolicy::default();
        policy.custom_protected_paths = vec!["/home/user/.ssh".into(), "/var/log".into()];
        assert!(policy.is_protected_path("/home/user/.ssh/authorized_keys"));
        assert!(policy.is_protected_path("/var/log/secure"));
        // Built-in paths still work alongside custom ones
        assert!(policy.is_protected_path("/etc/passwd"));
        assert!(!policy.is_protected_path("/home/user/.config"));
    }

    #[test]
    fn from_user_settings_populates_custom_paths() {
        let policy = SecurityPolicy::from_user_settings(&["/srv/prod".into()], 120);
        assert!(policy.is_protected_path("/srv/prod/db.sqlite"));
        assert!(policy.is_protected_path("/etc/passwd"));
    }
}
