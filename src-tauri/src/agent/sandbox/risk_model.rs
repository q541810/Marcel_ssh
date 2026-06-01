use std::cmp;

use crate::agent::RiskLevel;
use crate::error::AppError;

use super::parser::{parse_segment, split_command_chain, ParseError};

/// Shared parsing + risk classification for a command string.
/// Handles split_command_chain, parse_segment, embedded_eval recursion,
/// assess_segment_risk + sudo elevation. Returns original segments, tokens, and max risk.
pub fn parse_and_classify(cmd: &str) -> Result<(Vec<String>, Vec<Vec<String>>, RiskLevel), AppError> {
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
                cmp::max(RiskLevel::Moderate, assess_risk(s))
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

fn assess_segment_risk(parsed: &super::parser::ParsedSegment) -> RiskLevel {
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
