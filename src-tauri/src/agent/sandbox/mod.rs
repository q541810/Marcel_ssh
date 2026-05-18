//! Sandbox: command risk assessment and policy enforcement.
//!
//! Replaces the prior substring-based detector with a real shell-aware
//! parser (see [`parser`]) and per-segment risk evaluation.

mod parser;

use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

use parser::{parse_segment, split_command_chain, ParseError, ParsedSegment};

/// Risk level for agent operations.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RiskLevel {
    ReadOnly,
    LowRisk,
    Moderate,
    HighRisk,
    Destructive,
}

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

/// Shared parsing + risk classification for a command string.
/// Handles split_command_chain, parse_segment, embedded_eval recursion,
/// assess_segment_risk + sudo elevation. Returns original segments, tokens, and max risk.
fn parse_and_classify(cmd: &str) -> Result<(Vec<String>, Vec<Vec<String>>, RiskLevel), AppError> {
    let segments = split_command_chain(cmd).map_err(|e| match e {
        ParseError::SubshellDetected => AppError::Agent(
            "Command contains command/process substitution which cannot be \
             safely analyzed; use explicit commands instead."
                .into(),
        ),
        ParseError::UnbalancedQuote => {
            AppError::Agent("Command has unbalanced quotes".into())
        }
        ParseError::ShellWordsError(s) => {
            AppError::Agent(format!("Failed to parse command: {}", s))
        }
    })?;

    let mut max_risk = RiskLevel::ReadOnly;
    let mut all_segments: Vec<String> = Vec::new();
    let mut all_tokens: Vec<Vec<String>> = Vec::new();
    for seg in &segments {
        let parsed = parse_segment(seg).map_err(|e| match e {
            ParseError::SubshellDetected => AppError::Agent(
                "Command contains command/process substitution".into(),
            ),
            ParseError::UnbalancedQuote => {
                AppError::Agent("Command has unbalanced quotes".into())
            }
            ParseError::ShellWordsError(s) => {
                AppError::Agent(format!("Failed to parse command: {}", s))
            }
        })?;
        all_segments.push(seg.to_string());
        all_tokens.push(parsed.tokens.clone());

        let r = if let Some((kind, inner)) = &parsed.embedded_eval {
            if kind == "source" || kind == "." {
                RiskLevel::HighRisk
            } else if let Some(s) = inner {
                std::cmp::max(RiskLevel::Moderate, assess_risk(s))
            } else {
                RiskLevel::HighRisk
            }
        } else {
            let mut r = assess_segment_risk(&parsed);
            if parsed.sudo_wrapped && r < RiskLevel::HighRisk {
                r = RiskLevel::HighRisk;
            }
            r
        };
        if r > max_risk {
            max_risk = r;
        }
    }
    Ok((all_segments, all_tokens, max_risk))
}

/// Free-function risk assessment used by tools needing a quick estimate.
pub fn assess_risk(cmd: &str) -> RiskLevel {
    let trimmed = cmd.trim();
    if trimmed.is_empty() {
        return RiskLevel::ReadOnly;
    }
    match parse_and_classify(trimmed) {
        Ok((_, _, risk)) => risk,
        Err(_) => RiskLevel::HighRisk,
    }
}

fn assess_segment_risk(parsed: &ParsedSegment) -> RiskLevel {
    let base_cmd = parsed.base_cmd.as_str();

    let base_risk = match base_cmd {
        "" => RiskLevel::ReadOnly,
        "ls" | "cat" | "pwd" | "whoami" | "hostname" | "uname" | "date" | "uptime" | "df"
        | "du" | "free" | "top" | "ps" | "id" | "env" | "head" | "tail" | "wc" | "find"
        | "grep" | "egrep" | "fgrep" | "which" | "file" | "stat" | "lsof" | "netstat"
        | "ss" | "ifconfig" | "ip" | "dig" | "nslookup" | "ping" | "traceroute" | "curl"
        | "wget" | "less" | "more" | "sort" | "uniq" | "diff" | "md5sum" | "sha256sum"
        | "readlink" | "realpath" | "type" | "man" | "help" => RiskLevel::ReadOnly,
        "echo" | "printf" => RiskLevel::ReadOnly,
        "mkdir" | "touch" | "cp" | "ln" | "tar" | "gzip" | "gunzip" | "zip" | "unzip"
        | "bzip2" | "xz" | "rsync" => RiskLevel::LowRisk,
        "mv" | "sed" | "awk" | "tee" | "nano" | "vim" | "vi" | "apt" | "apt-get" | "yum"
        | "dnf" | "pip" | "pip3" | "npm" | "npx" | "yarn" | "cargo" | "systemctl"
        | "service" | "docker" | "docker-compose" | "podman" | "git" | "crontab" | "at" => {
            RiskLevel::Moderate
        }
        "rm" | "chmod" | "chown" | "chgrp" | "kill" | "killall" | "pkill" | "iptables"
        | "ip6tables" | "nft" | "ufw" | "firewall-cmd" | "useradd" | "userdel" | "usermod"
        | "groupadd" | "groupdel" | "passwd" | "su" | "sudo" | "chroot" | "mount"
        | "umount" | "reboot" | "shutdown" | "poweroff" | "halt" | "init" => RiskLevel::HighRisk,
        "mkfs" | "fdisk" | "parted" | "dd" | "shred" | "wipefs" | "sgdisk" | "gdisk" => {
            RiskLevel::Destructive
        }
        _ => {
            if base_cmd.starts_with("mkfs.") {
                RiskLevel::Destructive
            } else {
                RiskLevel::Moderate
            }
        }
    };

    if !parsed.redirect_targets.is_empty() && base_risk < RiskLevel::Moderate {
        return RiskLevel::Moderate;
    }

    base_risk
}

fn looks_like_path(s: &str) -> bool {
    s.starts_with('/')
        || s.starts_with('~')
        || s.starts_with("$HOME")
}

fn analyze_rm_args(args: &[String]) -> (bool, bool, Vec<String>) {
    let mut recursive = false;
    let mut force = false;
    let mut paths: Vec<String> = Vec::new();
    let mut after_dd = false;
    for a in args {
        if a == "--" {
            after_dd = true;
            continue;
        }
        if !after_dd && a.starts_with("--") {
            match a.as_str() {
                "--recursive" => recursive = true,
                "--force" => force = true,
                _ => {}
            }
            continue;
        }
        if !after_dd && a.starts_with('-') && a.len() > 1 {
            // short combined flags, e.g. -rf, -rfv
            for ch in a[1..].chars() {
                match ch {
                    'r' | 'R' => recursive = true,
                    'f' => force = true,
                    _ => {}
                }
            }
            continue;
        }
        paths.push(a.clone());
    }
    (recursive, force, paths)
}

fn is_dangerous_rm_target(path: &str) -> bool {
    let norm = normalize_path(path);
    let exact_dangerous = [
        "/", "/*", "/.*", "~", "$HOME", "~/", "$HOME/",
    ];
    if exact_dangerous.contains(&norm.as_str()) {
        return true;
    }
    // Glob expansion of root: `/<something>*` where prefix == "/" alone
    if norm == "/*" || norm == "/.*" {
        return true;
    }

    let dangerous_prefixes = [
        "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/sys", "/proc", "/dev",
        "/var", "/root",
    ];
    let np = Path::new(&norm);
    for p in &dangerous_prefixes {
        if np.starts_with(p) {
            return true;
        }
    }
    // /home itself or /home/<single>
    if norm == "/home" {
        return true;
    }
    if let Some(rest) = norm.strip_prefix("/home/") {
        if !rest.is_empty() && !rest.contains('/') {
            return true;
        }
    }
    false
}

/// Lightweight path normalizer: collapses `//`, resolves `.` and `..`
/// lexically (no symlink resolution), preserves leading `~`/`$HOME`.
fn normalize_path(s: &str) -> String {
    let s = s.trim();
    if s.is_empty() {
        return String::new();
    }
    // Preserve special leading marks.
    if s == "~" || s == "$HOME" {
        return s.to_string();
    }
    // Strip glob-trailing for dangerous-detection, but keep trailing star marker.
    let (prefix, body) = if let Some(rest) = s.strip_prefix("~/") {
        ("~/", rest.to_string())
    } else if let Some(rest) = s.strip_prefix("$HOME/") {
        ("$HOME/", rest.to_string())
    } else {
        ("", s.to_string())
    };

    let is_abs = body.starts_with('/') || prefix.is_empty() && s.starts_with('/');
    let work = if prefix.is_empty() { s.to_string() } else { body };

    let mut out: Vec<String> = Vec::new();
    let pb = PathBuf::from(&work);
    for comp in pb.components() {
        match comp {
            Component::CurDir => {}
            Component::ParentDir => {
                if out.last().map_or(false, |p| p != "..") {
                    out.pop();
                } else {
                    out.push("..".into());
                }
            }
            Component::RootDir => {
                out.clear();
                out.push("/".into());
            }
            Component::Normal(s) => out.push(s.to_string_lossy().into_owned()),
            Component::Prefix(_) => {}
        }
    }

    let joined = if out.first().map(|s| s.as_str()) == Some("/") {
        let rest: Vec<&str> = out.iter().skip(1).map(|s| s.as_str()).collect();
        if rest.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", rest.join("/"))
        }
    } else {
        out.join("/")
    };

    let result = if !prefix.is_empty() {
        format!("{}{}", prefix, joined)
    } else if is_abs && !joined.starts_with('/') {
        format!("/{}", joined)
    } else {
        joined
    };
    if result.is_empty() { s.to_string() } else { result }
}

/// Match a blocked pattern such that a trailing `/` only matches root,
/// not a longer path like `/tmp/build`.
fn pattern_matches(haystack: &str, pat: &str) -> bool {
    let mut start = 0;
    while let Some(idx) = haystack[start..].find(pat) {
        let abs = start + idx;
        let end = abs + pat.len();
        let after = haystack.as_bytes().get(end).copied();
        let ends_with_slash = pat.ends_with('/');
        let ok = if ends_with_slash {
            // root-only: next char must be end or whitespace/separator
            match after {
                None => true,
                Some(b) => matches!(b as char, ' ' | '\t' | ';' | '|' | '&' | '\n'),
            }
        } else {
            true
        };
        if ok {
            return true;
        }
        start = abs + 1;
    }
    false
}

fn is_fork_bomb(raw: &str) -> bool {
    // Very narrow scanner for `name(){ ... | ... & } ;`.
    let s: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    if !s.contains("(){") {
        return false;
    }
    // Need a pipe and `&` and a `};` after `(){`.
    let after = match s.split_once("(){") {
        Some((_, a)) => a,
        None => return false,
    };
    let body_end = match after.find("};") {
        Some(i) => i,
        None => return false,
    };
    let body = &after[..body_end];
    body.contains('|') && body.contains('&')
}

const SHELL_NAMES: &[&str] = &["bash", "sh", "zsh", "dash", "ash", "ksh"];

fn is_bare_shell(parsed: &ParsedSegment) -> bool {
    if !SHELL_NAMES.contains(&parsed.base_cmd.as_str()) {
        return false;
    }
    // -c <str> => not bare; or any non-flag arg (treated as script path) => not bare.
    let mut i = 0;
    while i < parsed.args.len() {
        let a = &parsed.args[i];
        if a == "-c" {
            return false;
        }
        if !a.starts_with('-') {
            // Script path argument: also not a "stdin pipe" sink.
            return false;
        }
        i += 1;
    }
    true
}

fn contains_top_level_pipe(input: &str) -> bool {
    let bytes = input.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_single {
            if c == '\'' { in_single = false; }
            i += 1;
            continue;
        }
        if in_double {
            if c == '\\' && i + 1 < bytes.len() { i += 2; continue; }
            if c == '"' { in_double = false; }
            i += 1;
            continue;
        }
        match c {
            '\'' => in_single = true,
            '"' => in_double = true,
            '\\' if i + 1 < bytes.len() => { i += 2; continue; }
            '|' => {
                // Skip `||` (logical OR is not a pipe sink).
                if i + 1 < bytes.len() && bytes[i + 1] as char == '|' {
                    i += 2;
                    continue;
                }
                return true;
            }
            _ => {}
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sb() -> Sandbox {
        Sandbox::default()
    }

    // ---- Original suite (preserved) ----

    #[test]
    fn test_readonly_commands() {
        assert_eq!(assess_risk("ls -la"), RiskLevel::ReadOnly);
        assert_eq!(assess_risk("cat /etc/hosts"), RiskLevel::ReadOnly);
        assert_eq!(assess_risk("pwd"), RiskLevel::ReadOnly);
        assert_eq!(assess_risk("echo hello"), RiskLevel::ReadOnly);
    }

    #[test]
    fn test_echo_with_redirect_elevated() {
        assert!(assess_risk("echo 'bad' > /etc/passwd") >= RiskLevel::Moderate);
    }

    #[test]
    fn test_destructive_commands() {
        assert_eq!(
            assess_risk("dd if=/dev/zero of=/dev/sda"),
            RiskLevel::Destructive
        );
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
        assert!(sb().check_command("rm -rf /").is_err());
        assert!(sb().check_command("rm  -rf  /").is_err());
        assert!(sb().check_command("rm --recursive --force /").is_err());
    }

    #[test]
    fn test_sandbox_blocks_mkfs() {
        assert!(sb().check_command("mkfs.ext4 /dev/sda1").is_err());
        assert!(sb().check_command("mkfs /dev/sda1").is_err());
    }

    #[test]
    fn test_sandbox_blocks_dd_to_device() {
        assert!(sb().check_command("dd if=/dev/zero of=/dev/sda").is_err());
        assert!(sb().check_command("dd of=/dev/sda if=/dev/zero").is_err());
    }

    #[test]
    fn test_sandbox_blocks_shell_evasion() {
        assert!(sb().check_command("cat /etc/shadow | bash").is_err());
        assert!(sb()
            .check_command("echo cm0gLXJmIC8= | base64 -d | sh")
            .is_err());
        assert!(sb().check_command("eval 'rm -rf /'").is_err());
    }

    #[test]
    fn test_sandbox_allows_safe_commands() {
        assert!(sb().check_command("ls -la").is_ok());
        assert!(sb().check_command("cat /var/log/syslog").is_ok());
        assert!(sb().check_command("mkdir /tmp/test").is_ok());
    }

    #[test]
    fn test_sandbox_elevates_protected_path_risk() {
        let risk = sb().check_command("mkdir /etc/myapp").unwrap();
        assert!(risk >= RiskLevel::HighRisk);
    }

    #[test]
    fn test_path_prefixed_commands() {
        assert_eq!(assess_risk("/usr/bin/ls -la"), RiskLevel::ReadOnly);
        assert_eq!(assess_risk("/bin/rm -rf /tmp/test"), RiskLevel::HighRisk);
    }

    // ---- New bypass-coverage suite ----

    #[test]
    fn bypass_chained() {
        assert!(sb().check_command("ls; rm -rf /").is_err());
        assert!(sb().check_command("true && rm -rf /etc").is_err());
        assert!(sb().check_command("false || rm -rf /usr").is_err());
    }

    #[test]
    fn bypass_quoted_and_path_and_backslash() {
        assert!(sb().check_command("\\rm -rf /").is_err());
        assert!(sb().check_command("'rm' -rf /").is_err());
        assert!(sb().check_command("/bin/rm -rf /").is_err());
    }

    #[test]
    fn bypass_env_wrappers() {
        assert!(sb().check_command("env FOO=1 rm -rf /").is_err());
        assert!(sb().check_command("env -i PATH=/bin rm -rf /").is_err());
        assert!(sb().check_command("sudo rm -rf /").is_err());
        assert!(sb().check_command("sudo -u root rm -rf /").is_err());
        assert!(sb().check_command("nohup rm -rf / &").is_err());
    }

    #[test]
    fn bypass_shell_dash_c() {
        assert!(sb().check_command("bash -c \"rm -rf /\"").is_err());
        assert!(sb().check_command("sh -c 'rm -rf /etc'").is_err());
        assert!(sb().check_command("eval \"rm -rf /\"").is_err());
    }

    #[test]
    fn source_is_high_risk() {
        let r = sb().check_command("source /tmp/evil.sh").unwrap();
        assert!(r >= RiskLevel::HighRisk);
    }

    #[test]
    fn subshell_rejected() {
        assert!(sb().check_command("rm -rf $(cat x)").is_err());
        assert!(sb().check_command("rm -rf `cat x`").is_err());
    }

    #[test]
    fn protected_dir_targets() {
        for p in ["/etc", "/usr", "/var", "/boot", "/home", "/root"] {
            assert!(
                sb().check_command(&format!("rm -rf {}", p)).is_err(),
                "should block rm -rf {}",
                p
            );
        }
    }

    #[test]
    fn root_glob_and_home() {
        assert!(sb().check_command("rm -rf /*").is_err());
        assert!(sb().check_command("rm -rf ~").is_err());
        assert!(sb().check_command("rm -rf $HOME").is_err());
    }

    #[test]
    fn rm_combined_flags() {
        assert!(sb().check_command("rm -rfv /etc").is_err());
        assert!(sb().check_command("rm -vfr /etc").is_err());
        assert!(sb().check_command("rm --recursive --force /etc").is_err());
    }

    #[test]
    fn rm_safe_workspaces() {
        let r = sb().check_command("rm -rf /tmp/build");
        eprintln!("DEBUG /tmp/build => {:?}", r);
        eprintln!("DEBUG dangerous = {}", is_dangerous_rm_target("/tmp/build"));
        eprintln!("DEBUG normalize = {}", normalize_path("/tmp/build"));
        assert!(sb().check_command("rm -rf /tmp/build").is_ok());
        assert!(sb().check_command("rm -rf /home/user/proj/dist").is_ok());
    }

    #[test]
    fn dd_targets() {
        assert!(sb().check_command("dd if=/dev/zero of=/dev/sda").is_err());
        assert!(sb()
            .check_command("dd of=/dev/nvme0n1p1 if=/dev/zero")
            .is_err());
        let r = sb()
            .check_command("dd if=/dev/zero of=/tmp/img bs=1M count=10")
            .unwrap();
        assert_eq!(r, RiskLevel::Destructive);
    }

    #[test]
    fn fork_bomb_blocked() {
        assert!(sb().check_command(":(){ :|:& };:").is_err());
    }

    #[test]
    fn no_false_positive_substring_etc() {
        let r = sb().check_command("cat /myetc/data").unwrap();
        assert_eq!(r, RiskLevel::ReadOnly);
    }

    #[test]
    fn echo_string_no_redirect_is_readonly() {
        let r = sb().check_command("echo \"wrote to /dev/sda\"").unwrap();
        assert_eq!(r, RiskLevel::ReadOnly);
    }
}
