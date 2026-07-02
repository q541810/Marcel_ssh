//! Shell command parsing utilities for sandbox risk assessment.
//!
//! Provides:
//! - [`split_command_chain`] — splits a command line by `;`, `&&`, `||`, `|`,
//!   `&`, and bare `\n`/`\r` (which bash treats as equivalent to `;`);
//!   respects single/double quotes and `\` escapes; rejects
//!   command/process substitution forms.
//! - [`parse_segment`] — tokenizes a single segment via `shell-words` and
//!   normalizes the base command (strips path, leading env-var assignments,
//!   wrappers like `sudo`/`env`/`nohup`/`time`).
//!
//! These are intentionally conservative: anything that smells like dynamic
//! evaluation (command substitution, process substitution, eval/source/exec
//! with a string arg) is surfaced so the caller can reject or downgrade.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParseError {
    UnbalancedQuote,
    SubshellDetected,
    ShellWordsError(String),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::UnbalancedQuote => write!(f, "unbalanced quote"),
            ParseError::SubshellDetected => write!(f, "command/process substitution detected"),
            ParseError::ShellWordsError(s) => write!(f, "shell-words: {}", s),
        }
    }
}

/// Split a command line into segments at top-level `;`, `&&`, `||`, `|`, `&`,
/// and bare `\n`/`\r`.
/// Honors `'...'`, `"..."` quoting and `\` escapes. Rejects strings containing
/// `$(`, backticks, or `<(` / `>(` (process substitution).
pub fn split_command_chain(input: &str) -> Result<Vec<String>, ParseError> {
    let bytes = input.as_bytes();
    let mut segments = Vec::new();
    let mut cur = String::new();
    let mut i = 0;
    let mut in_single = false;
    let mut in_double = false;

    while i < bytes.len() {
        let c = bytes[i] as char;

        if in_single {
            if c == '\'' {
                in_single = false;
            }
            cur.push(c);
            i += 1;
            continue;
        }
        if in_double {
            if c == '\\' && i + 1 < bytes.len() {
                cur.push(c);
                cur.push(bytes[i + 1] as char);
                i += 2;
                continue;
            }
            if c == '"' {
                in_double = false;
            }
            // Backtick command substitution inside double quotes: reject.
            if c == '`' {
                return Err(ParseError::SubshellDetected);
            }
            // $(...) inside double quotes: reject.
            if c == '$' && i + 1 < bytes.len() && bytes[i + 1] as char == '(' {
                return Err(ParseError::SubshellDetected);
            }
            cur.push(c);
            i += 1;
            continue;
        }

        // Outside quotes
        match c {
            '\'' => {
                in_single = true;
                cur.push(c);
                i += 1;
            }
            '"' => {
                in_double = true;
                cur.push(c);
                i += 1;
            }
            '\\' => {
                if i + 1 < bytes.len() {
                    cur.push(c);
                    cur.push(bytes[i + 1] as char);
                    i += 2;
                } else {
                    cur.push(c);
                    i += 1;
                }
            }
            '`' => return Err(ParseError::SubshellDetected),
            '$' if i + 1 < bytes.len() && bytes[i + 1] as char == '(' => {
                return Err(ParseError::SubshellDetected);
            }
            '<' | '>' if i + 1 < bytes.len() && bytes[i + 1] as char == '(' => {
                return Err(ParseError::SubshellDetected);
            }
            ';' => {
                push_segment(&mut segments, &mut cur);
                i += 1;
            }
            '&' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '&' {
                    push_segment(&mut segments, &mut cur);
                    i += 2;
                } else {
                    push_segment(&mut segments, &mut cur);
                    i += 1;
                }
            }
            '|' => {
                if i + 1 < bytes.len() && bytes[i + 1] as char == '|' {
                    push_segment(&mut segments, &mut cur);
                    i += 2;
                } else {
                    push_segment(&mut segments, &mut cur);
                    i += 1;
                }
            }
            '\n' | '\r' => {
                push_segment(&mut segments, &mut cur);
                i += 1;
            }
            _ => {
                cur.push(c);
                i += 1;
            }
        }
    }

    if in_single || in_double {
        return Err(ParseError::UnbalancedQuote);
    }
    push_segment(&mut segments, &mut cur);
    Ok(segments)
}

fn push_segment(segments: &mut Vec<String>, cur: &mut String) {
    let s = cur.trim().to_string();
    if !s.is_empty() {
        segments.push(s);
    }
    cur.clear();
}

#[derive(Debug, Clone)]
pub struct ParsedSegment {
    pub raw: String,
    pub tokens: Vec<String>,
    pub base_cmd: String,
    pub args: Vec<String>,
    /// Indicates the segment IS a shell-eval invocation (bash -c "...", sh -c,
    /// eval "...", source/.). The first element is the eval kind, the second
    /// is the inner string (if extractable).
    pub embedded_eval: Option<(String, Option<String>)>,
    pub redirect_targets: Vec<String>,
    /// True if the segment was wrapped in `sudo`/`doas`.
    pub sudo_wrapped: bool,
}

/// Wrappers that pass control to a real command after their own flags.
const WRAPPERS: &[&str] = &[
    "sudo", "doas", "env", "nohup", "time", "command", "builtin", "exec", "ionice", "nice",
];

/// Shell interpreters whose `-c <string>` argument needs nested evaluation.
const SHELLS: &[&str] = &["bash", "sh", "zsh", "dash", "ash", "ksh"];

pub fn parse_segment(seg: &str) -> Result<ParsedSegment, ParseError> {
    let tokens = shell_words::split(seg).map_err(|e| ParseError::ShellWordsError(e.to_string()))?;
    if tokens.is_empty() {
        return Ok(ParsedSegment {
            raw: seg.to_string(),
            tokens: vec![],
            base_cmd: String::new(),
            args: vec![],
            embedded_eval: None,
            redirect_targets: vec![],
            sudo_wrapped: false,
        });
    }

    // Skip leading env assignments and wrappers to find the real command.
    let mut idx = 0usize;
    let mut sudo_wrapped = false;
    loop {
        if idx >= tokens.len() {
            break;
        }
        let t = &tokens[idx];
        // ENV=val pattern at the head
        if is_env_assignment(t) {
            idx += 1;
            continue;
        }
        let base = strip_path_and_quotes(t);
        if WRAPPERS.contains(&base.as_str()) {
            // Skip the wrapper token; for `env`, also skip its `KEY=VAL` and
            // option args until we hit a real command. Other wrappers also
            // tolerate flag args (`sudo -u user`, `nohup`, `time -v`).
            idx += 1;
            if base == "env" {
                while idx < tokens.len()
                    && (is_env_assignment(&tokens[idx]) || tokens[idx].starts_with('-'))
                {
                    idx += 1;
                }
            } else if base == "sudo" || base == "doas" {
                sudo_wrapped = true;
                // sudo flags: -u user, -E, -i, -s, -- ; skip flags and any
                // values until the real command.
                while idx < tokens.len() {
                    let tk = &tokens[idx];
                    if tk == "--" {
                        idx += 1;
                        break;
                    }
                    if tk.starts_with('-') {
                        // -u <user>, -g <group>, -p <prompt>: also consume value.
                        let needs_val = matches!(
                            tk.as_str(),
                            "-u" | "-g" | "-p" | "-C" | "-D" | "-h" | "-r" | "-t" | "-T" | "-U"
                        );
                        idx += 1;
                        if needs_val && idx < tokens.len() {
                            idx += 1;
                        }
                    } else {
                        break;
                    }
                }
            } else if base == "nice" || base == "ionice" {
                while idx < tokens.len() && tokens[idx].starts_with('-') {
                    idx += 1;
                }
            }
            continue;
        }
        break;
    }

    let real = tokens.get(idx).cloned().unwrap_or_default();
    let base_cmd = strip_path_and_quotes(&real);
    let args: Vec<String> = if idx + 1 < tokens.len() {
        tokens[idx + 1..].to_vec()
    } else {
        vec![]
    };

    // Detect embedded shell evaluation.
    let embedded_eval = detect_embedded_eval(&base_cmd, &args);

    // Collect redirect targets (`>`, `>>`, `tee`, and fd-prefixed variants
    // like `1>`, `2>`, `&>`, `1>>`, `2>>`, `&>>`).
    let mut redirect_targets = Vec::new();
    let mut iter = args.iter().peekable();
    while let Some(a) = iter.next() {
        if a == ">" || a == ">>" {
            if let Some(t) = iter.next() {
                redirect_targets.push(t.clone());
            }
        } else if let Some(rest) = strip_redirect_prefix(a) {
            if !rest.is_empty() {
                redirect_targets.push(rest.to_string());
            }
        }
    }
    if base_cmd == "tee" {
        for a in &args {
            if !a.starts_with('-') {
                redirect_targets.push(a.clone());
            }
        }
    }

    Ok(ParsedSegment {
        raw: seg.to_string(),
        tokens,
        base_cmd,
        args,
        embedded_eval,
        redirect_targets,
        sudo_wrapped,
    })
}

fn is_env_assignment(s: &str) -> bool {
    if let Some(eq) = s.find('=') {
        if eq == 0 {
            return false;
        }
        let key = &s[..eq];
        return key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
            && key
                .chars()
                .next()
                .map_or(false, |c| c.is_ascii_alphabetic() || c == '_');
    }
    false
}

/// Strip shell redirect prefixes from a token and return the target path.
///
/// Recognized forms (in priority order):
/// - `>>` / `>`  (bare redirect)
/// - `&>>` / `&>` (stdout+stderr redirect)
/// - `N>>` / `N>` where N is a digit 0-9 (fd redirect)
fn strip_redirect_prefix(s: &str) -> Option<&str> {
    if let Some(rest) = s.strip_prefix(">>") {
        return Some(rest);
    }
    if let Some(rest) = s.strip_prefix('>') {
        return Some(rest);
    }
    if let Some(rest) = s.strip_prefix("&>>") {
        return Some(rest);
    }
    if let Some(rest) = s.strip_prefix("&>") {
        return Some(rest);
    }
    // fd prefix: single digit followed by `>>` or `>`
    let first = s.chars().next()?;
    if first.is_ascii_digit() {
        let rest = &s[1..];
        if let Some(target) = rest.strip_prefix(">>") {
            return Some(target);
        }
        if let Some(target) = rest.strip_prefix('>') {
            return Some(target);
        }
    }
    None
}

/// Strip leading `/path/to/`, surrounding quotes, and a leading backslash.
pub fn strip_path_and_quotes(tok: &str) -> String {
    let mut t = tok.trim();
    // Strip surrounding quotes if any
    if (t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2)
        || (t.starts_with('"') && t.ends_with('"') && t.len() >= 2)
    {
        t = &t[1..t.len() - 1];
    }
    // Strip leading backslash (alias-bypass): `\rm` -> `rm`
    let t = t.trim_start_matches('\\');
    // Strip path
    let t = match t.rsplit_once('/') {
        Some((_, name)) => name,
        None => t,
    };
    t.to_string()
}

fn detect_embedded_eval(base: &str, args: &[String]) -> Option<(String, Option<String>)> {
    if SHELLS.contains(&base) {
        // Look for -c <string>
        let mut i = 0;
        while i < args.len() {
            if args[i] == "-c" && i + 1 < args.len() {
                return Some((base.to_string(), Some(args[i + 1].clone())));
            }
            i += 1;
        }
        return None;
    }
    if base == "eval" {
        let inner = args.join(" ");
        return Some(("eval".into(), Some(inner)));
    }
    if base == "source" || base == "." {
        return Some((base.to_string(), None));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_basic() {
        assert_eq!(
            split_command_chain("ls; rm -rf /").unwrap(),
            vec!["ls".to_string(), "rm -rf /".to_string()]
        );
        assert_eq!(
            split_command_chain("a && b || c | d").unwrap(),
            vec![
                "a".to_string(),
                "b".to_string(),
                "c".to_string(),
                "d".to_string()
            ]
        );
    }

    #[test]
    fn split_respects_quotes() {
        assert_eq!(
            split_command_chain("echo \"a;b\"").unwrap(),
            vec!["echo \"a;b\"".to_string()]
        );
        assert_eq!(
            split_command_chain("echo 'a|b'").unwrap(),
            vec!["echo 'a|b'".to_string()]
        );
    }

    #[test]
    fn split_rejects_subshell() {
        assert_eq!(
            split_command_chain("rm -rf $(cat /tmp/x)"),
            Err(ParseError::SubshellDetected)
        );
        assert_eq!(
            split_command_chain("rm -rf `cat /tmp/x`"),
            Err(ParseError::SubshellDetected)
        );
        assert_eq!(
            split_command_chain("diff <(a) <(b)"),
            Err(ParseError::SubshellDetected)
        );
    }

    #[test]
    fn parse_strips_path_and_quotes_and_backslash() {
        assert_eq!(parse_segment("/bin/rm -rf /").unwrap().base_cmd, "rm");
        assert_eq!(parse_segment("'rm' -rf /").unwrap().base_cmd, "rm");
        assert_eq!(parse_segment("\\rm -rf /").unwrap().base_cmd, "rm");
    }

    #[test]
    fn parse_skips_env_and_sudo() {
        assert_eq!(parse_segment("FOO=1 rm -rf /").unwrap().base_cmd, "rm");
        assert_eq!(parse_segment("env A=1 rm -rf /").unwrap().base_cmd, "rm");
        assert_eq!(parse_segment("env -i A=1 rm -rf /").unwrap().base_cmd, "rm");
        assert_eq!(parse_segment("sudo rm -rf /").unwrap().base_cmd, "rm");
        assert_eq!(
            parse_segment("sudo -u root rm -rf /").unwrap().base_cmd,
            "rm"
        );
        assert_eq!(parse_segment("nohup rm -rf /").unwrap().base_cmd, "rm");
    }

    #[test]
    fn detects_bash_dash_c() {
        let p = parse_segment("bash -c \"rm -rf /\"").unwrap();
        assert_eq!(p.base_cmd, "bash");
        assert!(p.embedded_eval.is_some());
        let (kind, inner) = p.embedded_eval.unwrap();
        assert_eq!(kind, "bash");
        assert_eq!(inner.as_deref(), Some("rm -rf /"));
    }

    #[test]
    fn detects_eval() {
        let p = parse_segment("eval 'rm -rf /'").unwrap();
        assert_eq!(p.base_cmd, "eval");
        assert!(p.embedded_eval.is_some());
    }

    #[test]
    fn collects_redirect_targets() {
        let p = parse_segment("echo x > /etc/passwd").unwrap();
        assert_eq!(p.redirect_targets, vec!["/etc/passwd".to_string()]);
        let p = parse_segment("echo x >>/etc/hosts").unwrap();
        assert_eq!(p.redirect_targets, vec!["/etc/hosts".to_string()]);
    }

    #[test]
    fn split_handles_newlines_as_separators() {
        // Bare newline acts like `;` in bash
        assert_eq!(
            split_command_chain("ls\nrm -rf /etc").unwrap(),
            vec!["ls".to_string(), "rm -rf /etc".to_string()]
        );
        // CRLF
        assert_eq!(
            split_command_chain("ls\r\nrm -rf /tmp").unwrap(),
            vec!["ls".to_string(), "rm -rf /tmp".to_string()]
        );
        // Multiple newlines, no empty segments
        assert_eq!(
            split_command_chain("a\n\nb\n\nc").unwrap(),
            vec!["a".to_string(), "b".to_string(), "c".to_string()]
        );
        // Newline inside quotes is NOT a separator
        assert_eq!(
            split_command_chain("echo \"a\nb\"").unwrap(),
            vec!["echo \"a\nb\"".to_string()]
        );
    }

    #[test]
    fn strip_redirect_prefix_covers_fd_variants() {
        assert_eq!(strip_redirect_prefix(">file"), Some("file"));
        assert_eq!(strip_redirect_prefix(">>file"), Some("file"));
        assert_eq!(strip_redirect_prefix("1>/etc/passwd"), Some("/etc/passwd"));
        assert_eq!(strip_redirect_prefix("2>/dev/null"), Some("/dev/null"));
        assert_eq!(strip_redirect_prefix("1>>/etc/hosts"), Some("/etc/hosts"));
        assert_eq!(strip_redirect_prefix("2>>file"), Some("file"));
        assert_eq!(strip_redirect_prefix("&>log"), Some("log"));
        assert_eq!(strip_redirect_prefix("&>>log"), Some("log"));
        assert_eq!(strip_redirect_prefix("0>file"), Some("file"));
        // Not a redirect
        assert_eq!(strip_redirect_prefix("foo"), None);
        assert_eq!(strip_redirect_prefix("echo"), None);
    }

    #[test]
    fn collects_fd_prefixed_redirect_targets() {
        let p = parse_segment("echo x 1>/etc/passwd").unwrap();
        assert_eq!(p.redirect_targets, vec!["/etc/passwd".to_string()]);

        let p = parse_segment("cmd 2>/dev/null").unwrap();
        assert_eq!(p.redirect_targets, vec!["/dev/null".to_string()]);

        let p = parse_segment("cmd &>log").unwrap();
        assert_eq!(p.redirect_targets, vec!["log".to_string()]);

        let p = parse_segment("echo x 1>>/etc/hosts").unwrap();
        assert_eq!(p.redirect_targets, vec!["/etc/hosts".to_string()]);

        let p = parse_segment("cmd &>>log").unwrap();
        assert_eq!(p.redirect_targets, vec!["log".to_string()]);
    }
}
