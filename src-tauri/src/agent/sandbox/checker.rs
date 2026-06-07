use std::path::{Component, Path, PathBuf};

use super::parser::ParsedSegment;

pub fn looks_like_path(s: &str) -> bool {
    s.starts_with('/') || s.starts_with('~') || s.starts_with("$HOME")
}

pub fn analyze_rm_args(args: &[String]) -> (bool, bool, Vec<String>) {
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

pub fn is_dangerous_rm_target(path: &str) -> bool {
    let norm = normalize_path(path);
    let exact_dangerous = ["/", "/*", "/.*", "~", "$HOME", "~/", "$HOME/"];
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
pub fn normalize_path(s: &str) -> String {
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
    let work = if prefix.is_empty() {
        s.to_string()
    } else {
        body
    };

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
    if result.is_empty() {
        s.to_string()
    } else {
        result
    }
}

/// Match a blocked pattern such that a trailing `/` only matches root,
/// not a longer path like `/tmp/build`.
pub fn pattern_matches(haystack: &str, pat: &str) -> bool {
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

pub fn is_fork_bomb(raw: &str) -> bool {
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

pub fn is_bare_shell(parsed: &ParsedSegment) -> bool {
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

pub fn contains_top_level_pipe(input: &str) -> bool {
    let bytes = input.as_bytes();
    let mut in_single = false;
    let mut in_double = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if in_single {
            if c == '\'' {
                in_single = false;
            }
            i += 1;
            continue;
        }
        if in_double {
            if c == '\\' && i + 1 < bytes.len() {
                i += 2;
                continue;
            }
            if c == '"' {
                in_double = false;
            }
            i += 1;
            continue;
        }
        match c {
            '\'' => in_single = true,
            '"' => in_double = true,
            '\\' if i + 1 < bytes.len() => {
                i += 2;
                continue;
            }
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

    // ──────────── looks_like_path ────────────

    #[test]
    fn looks_like_path_absolute() {
        assert!(looks_like_path("/etc/passwd"));
        assert!(looks_like_path("/"));
    }

    #[test]
    fn looks_like_path_home() {
        assert!(looks_like_path("~/"));
        assert!(looks_like_path("~"));
        assert!(looks_like_path("$HOME"));
    }

    #[test]
    fn looks_like_path_relative_false() {
        assert!(!looks_like_path("file.txt"));
        assert!(!looks_like_path("../etc"));
    }

    // ──────────── analyze_rm_args ────────────

    #[test]
    fn analyze_rm_recursive_force_paths() {
        let args: Vec<String> = vec!["-rf".into(), "/tmp".into(), "/var/cache".into()];
        let (r, f, paths) = analyze_rm_args(&args);
        assert!(r);
        assert!(f);
        assert_eq!(paths, vec!["/tmp", "/var/cache"]);
    }

    #[test]
    fn analyze_rm_long_flags() {
        let args: Vec<String> = vec!["--recursive".into(), "--force".into(), "/tmp".into()];
        let (r, f, _) = analyze_rm_args(&args);
        assert!(r);
        assert!(f);
    }

    #[test]
    fn analyze_rm_double_dash_terminates_flags() {
        let args: Vec<String> = vec!["-r".into(), "--".into(), "-f".into()];
        let (r, _, paths) = analyze_rm_args(&args);
        assert!(r);
        assert_eq!(paths, vec!["-f"]);
    }

    #[test]
    fn analyze_rm_no_flags() {
        let args: Vec<String> = vec!["/tmp/file".into()];
        let (r, f, _) = analyze_rm_args(&args);
        assert!(!r);
        assert!(!f);
    }

    // ──────────── is_dangerous_rm_target ────────────

    #[test]
    fn dangerous_rm_root_and_glob() {
        assert!(is_dangerous_rm_target("/"));
        assert!(is_dangerous_rm_target("/*"));
        assert!(is_dangerous_rm_target("/.*"));
    }

    #[test]
    fn dangerous_rm_home() {
        assert!(is_dangerous_rm_target("~"));
        assert!(is_dangerous_rm_target("$HOME"));
        assert!(is_dangerous_rm_target("~/"));
        assert!(is_dangerous_rm_target("$HOME/"));
    }

    #[test]
    fn dangerous_rm_system_dirs() {
        assert!(is_dangerous_rm_target("/etc"));
        assert!(is_dangerous_rm_target("/usr"));
        assert!(is_dangerous_rm_target("/boot"));
        assert!(is_dangerous_rm_target("/dev"));
        assert!(is_dangerous_rm_target("/proc"));
    }

    #[test]
    fn dangerous_rm_home_user_specific() {
        assert!(is_dangerous_rm_target("/home"));
        assert!(is_dangerous_rm_target("/home/user"));
        assert!(!is_dangerous_rm_target("/home/user/proj"));
    }

    #[test]
    fn safe_rm_targets() {
        assert!(!is_dangerous_rm_target("/tmp/build"));
        assert!(!is_dangerous_rm_target("/home/user/project/dist"));
    }

    // ──────────── normalize_path ────────────

    #[test]
    fn normalize_handles_double_slash() {
        assert_eq!(normalize_path("//home//user"), "/home/user");
    }

    #[test]
    fn normalize_resolves_dot() {
        assert_eq!(normalize_path("/home/./user"), "/home/user");
    }

    #[test]
    fn normalize_resolves_dotdot() {
        assert_eq!(normalize_path("/home/user/../other"), "/home/other");
    }

    #[test]
    fn normalize_preserves_home_prefix() {
        assert_eq!(normalize_path("~/a/b"), "~/a/b");
        assert_eq!(normalize_path("$HOME/a"), "$HOME/a");
    }

    #[test]
    fn normalize_empty() {
        assert_eq!(normalize_path(""), "");
    }

    #[test]
    fn normalize_tilde_and_dollar_home_bare() {
        assert_eq!(normalize_path("~"), "~");
        assert_eq!(normalize_path("$HOME"), "$HOME");
    }

    // ──────────── pattern_matches ────────────

    #[test]
    fn pattern_matches_slash_pattern_root_only() {
        assert!(pattern_matches("rm -rf /", "rm -rf /"));
        assert!(!pattern_matches("rm -rf /tmp/build", "rm -rf /"));
    }

    #[test]
    fn pattern_matches_non_slash_substring() {
        assert!(pattern_matches("rm -rf /etc/hosts", "/etc"));
        assert!(!pattern_matches("cat /myetc/data", "/etc"));
    }

    // ──────────── is_fork_bomb ────────────

    #[test]
    fn fork_bomb_classic() {
        assert!(is_fork_bomb(":(){ :|:& };:"));
    }

    #[test]
    fn fork_bomb_no_paren() {
        assert!(!is_fork_bomb("echo hello"));
    }

    #[test]
    fn fork_bomb_missing_pipe() {
        assert!(!is_fork_bomb("f(){ echo hi & }; f"));
    }

    #[test]
    fn fork_bomb_spaces_variant() {
        assert!(is_fork_bomb("x  (  )  {  x  |  x  &  }  ;  x"));
    }

    // ──────────── is_bare_shell ────────────

    #[test]
    fn bare_shell_no_args() {
        let seg = crate::agent::sandbox::parser::ParsedSegment {
            raw: "bash".into(),
            tokens: vec!["bash".into()],
            base_cmd: "bash".into(),
            args: vec![],
            embedded_eval: None,
            redirect_targets: vec![],
            sudo_wrapped: false,
        };
        assert!(is_bare_shell(&seg));
    }

    #[test]
    fn shell_with_dash_c_is_not_bare() {
        let seg = crate::agent::sandbox::parser::ParsedSegment {
            raw: "bash -c 'echo hi'".into(),
            tokens: vec!["bash".into(), "-c".into(), "echo hi".into()],
            base_cmd: "bash".into(),
            args: vec!["-c".into(), "echo hi".into()],
            embedded_eval: None,
            redirect_targets: vec![],
            sudo_wrapped: false,
        };
        assert!(!is_bare_shell(&seg));
    }

    #[test]
    fn shell_with_script_path_is_not_bare() {
        let seg = crate::agent::sandbox::parser::ParsedSegment {
            raw: "bash script.sh".into(),
            tokens: vec!["bash".into(), "script.sh".into()],
            base_cmd: "bash".into(),
            args: vec!["script.sh".into()],
            embedded_eval: None,
            redirect_targets: vec![],
            sudo_wrapped: false,
        };
        assert!(!is_bare_shell(&seg));
    }

    // ──────────── contains_top_level_pipe ────────────

    #[test]
    fn pipe_detected() {
        assert!(contains_top_level_pipe("cat file | grep x"));
    }

    #[test]
    fn logical_or_not_pipe() {
        assert!(!contains_top_level_pipe("true || false"));
    }

    #[test]
    fn pipe_inside_quotes_ignored() {
        assert!(!contains_top_level_pipe("echo \"a|b\""));
        assert!(!contains_top_level_pipe("echo 'a|b'"));
    }

    #[test]
    fn escaped_pipe_ignored() {
        assert!(!contains_top_level_pipe("echo \\| grep"));
    }
}
