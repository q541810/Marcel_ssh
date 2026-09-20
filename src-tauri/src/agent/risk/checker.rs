use std::path::{Component, Path, PathBuf};

use super::disposition::Assessment;
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

/// `rm -r` 的目标有多危险。
///
/// 分两档而不是一刀切，是因为前缀判断分不清"整棵树"和"树里的一次普通清理"：
/// `rm -rf /var/log` 和 `rm -rf /var/log/nginx/old` 前缀相同，性质完全不同。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum RmTargetClass {
    /// 随便删 —— `/tmp/build`、`/home/user/proj/dist` 这类工作目录。
    Safe,
    /// 系统树里"也可能是正常清理"的那部分（`/usr`、`/var` 下）。不拒绝，
    /// 但也绝不静默：强制审批。
    SystemTree,
    /// 根、系统关键目录、家目录本体 —— 删掉等于重装系统，直接拒绝。
    Catastrophic,
}

pub fn classify_rm_target(path: &str) -> RmTargetClass {
    let norm = normalize_path(path);
    let exact_dangerous = ["/", "/*", "/.*", "~", "$HOME", "~/", "$HOME/"];
    if exact_dangerous.contains(&norm.as_str()) {
        return RmTargetClass::Catastrophic;
    }

    // `/etc` 这类目录里没有"用户的活儿"，删它只能是出事了。
    let catastrophic_prefixes = [
        "/etc", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/sys", "/proc", "/dev", "/root",
    ];
    let np = Path::new(&norm);
    if catastrophic_prefixes.iter().any(|p| np.starts_with(p)) {
        return RmTargetClass::Catastrophic;
    }
    // `/usr`、`/var` 底下既有系统文件也有构建产物、日志、缓存 —— 交给人判断。
    if np.starts_with("/usr") || np.starts_with("/var") {
        return RmTargetClass::SystemTree;
    }
    // /home itself or /home/<single>
    if norm == "/home" {
        return RmTargetClass::Catastrophic;
    }
    if let Some(rest) = norm.strip_prefix("/home/") {
        if !rest.is_empty() && !rest.contains('/') {
            return RmTargetClass::Catastrophic;
        }
    }
    RmTargetClass::Safe
}

/// 递归 `rm` 的全部目标里最严重的那一类，外带第一个命中它的路径。
fn classify_recursive_rm(parsed: &ParsedSegment) -> (RmTargetClass, Option<String>) {
    if parsed.base_cmd != "rm" {
        return (RmTargetClass::Safe, None);
    }
    let (recursive, _force, paths) = analyze_rm_args(&parsed.args);
    if !recursive {
        return (RmTargetClass::Safe, None);
    }
    let mut worst = RmTargetClass::Safe;
    let mut hit = None;
    for p in &paths {
        let class = classify_rm_target(p);
        if class > worst {
            worst = class;
            hit = Some(p.clone());
        }
    }
    (worst, hit)
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

/// `mkfs` / `mkfs.ext4` / `mkfs.xfs` … 同一个家族。
///
/// 只认 `mkfs` 和 `mkfs.` 前缀，不认更宽的前缀 —— 否则一个叫 `mkfsthing` 的
/// 脚本也会被当成格式化工具。
pub(super) fn is_mkfs(base: &str) -> bool {
    base == "mkfs" || base.starts_with("mkfs.")
}

/// 直接操作磁盘/块设备的命令族。
///
/// 它们**不点名设备时也一律强制审批** —— 正常用途就是把数据抹掉，没有"随手跑一下"
/// 的场景；一旦点名了真实设备则升到直接拒绝（见 [`catastrophic_reason`]）。
pub const DISK_COMMANDS: &[&str] = &[
    "dd", "fdisk", "parted", "shred", "mkswap", "wipefs", "sgdisk", "gdisk",
];

/// 纯读命令。它们**参数**里出现受保护路径不算"要改系统文件"，不必强制审批 ——
/// `cat /etc/passwd`、`grep x /etc/hosts` 都是日常操作，每次弹窗只会让人关掉审批。
///
/// 两个例外不受这份豁免保护：重定向目标（那是写），以及带了 [`WRITE_FLAGS`] 的命令。
const READ_ONLY_COMMANDS: &[&str] = &[
    "ls", "cat", "pwd", "whoami", "hostname", "uname", "date", "uptime", "df", "du", "free",
    "top", "ps", "id", "env", "head", "tail", "wc", "find", "grep", "egrep", "fgrep", "which",
    "file", "stat", "lsof", "netstat", "ss", "ifconfig", "ip", "dig", "nslookup", "ping",
    "traceroute", "curl", "wget", "less", "more", "sort", "uniq", "diff", "md5sum", "sha256sum",
    "readlink", "realpath", "type", "man", "help", "echo", "printf",
];

/// 会把上面那些"只读"命令变成写操作或执行操作的参数。带了这些就不再享受
/// 受保护路径的豁免 —— 例如 `find /etc -delete`、`curl -o /etc/hosts ...`。
const WRITE_FLAGS: &[&str] = &[
    "-delete", "-exec", "-execdir", "-ok", "-okdir", // find
    "-o", "-O", "--output", "--output-dir", // curl / wget
];

/// 系统级命令里"看一眼、什么也不改"的子命令形态。
///
/// `systemctl status nginx` 和 `systemctl restart nginx` 在只看命令名时一模一样，
/// 但一个是排查服务的第一步、另一个在改机器状态。只按命令名整类抬到强制审批，
/// 会把查询也一并拦下 —— 用户正在诊断 `server.js` 和 10030 端口，下一步几乎必然
/// 会敲 `systemctl status`。
///
/// 判据保守：只认各命令**明确无误的查询形态**，拿不准就照旧抬档。
pub(super) fn is_read_only_system_query(base: &str, args: &[String]) -> bool {
    let non_flag: Vec<&str> = args
        .iter()
        .map(|s| s.as_str())
        .filter(|a| !a.starts_with('-'))
        .collect();
    let first = non_flag.first().copied().unwrap_or("");
    match base {
        "systemctl" => matches!(
            first,
            "status"
                | "is-active"
                | "is-enabled"
                | "is-failed"
                | "show"
                | "cat"
                | "list-units"
                | "list-unit-files"
                | "list-sockets"
                | "list-timers"
                | "list-dependencies"
                | "get-default"
        ),
        // `service <name> status`
        "service" => non_flag.get(1).is_some_and(|a| *a == "status"),
        // 裸 `mount` / `mount -l` 只列当前挂载点
        "mount" => non_flag.is_empty(),
        // `crontab -l` 只列出来；`-e` / `-r` 才是改
        "crontab" => args.iter().any(|a| a == "-l"),
        "ufw" => first == "status",
        "iptables" | "ip6tables" => args
            .iter()
            .any(|a| matches!(a.as_str(), "-L" | "--list" | "-S" | "--list-rules")),
        "nft" => first == "list",
        "kill" => args.iter().any(|a| a == "-0"),
        _ => false,
    }
}

/// 这条命令是不是"只读"：只有只读命令才能忽略**参数**里的受保护路径
/// （`cat /etc/passwd` 不算要改系统文件）。重定向目标不受这份豁免保护。
pub fn is_read_only_command(parsed: &ParsedSegment) -> bool {
    READ_ONLY_COMMANDS.contains(&parsed.base_cmd.as_str())
        && !parsed.args.iter().any(|a| WRITE_FLAGS.contains(&a.as_str()))
}

/// `/dev` 下的虚拟设备 —— 往它们写等于丢弃或转发，不是"改系统"。
///
/// 它们跟 `/dev/sda` 长得几乎一样（同样在 `/dev` 前缀下），语义却完全相反：
/// `2>/dev/null`、`curl -o /dev/null`、`> /dev/stdout` 是最常见的写法。把这一族
/// 算进受保护路径，会让一批**纯只读的诊断命令**在 Auto 模式下也弹窗 —— 这是
/// 「受保护路径」判定第一次真正对 bash 生效时踩到的坑。
pub(super) fn is_virtual_device(path: &str) -> bool {
    let norm = normalize_path(path);
    let Some(rest) = norm.strip_prefix("/dev/") else {
        return false;
    };
    if rest.is_empty() {
        return false;
    }
    const VIRTUAL: &[&str] = &[
        "null", "zero", "full", "random", "urandom", "tty", "console", "stdin", "stdout",
        "stderr", "ptmx", "core",
    ];
    VIRTUAL.contains(&rest)
        || rest.starts_with("fd/")
        || rest.starts_with("pts/")
        || rest.starts_with("shm/")
}

/// `/dev/` 下的真实设备。虚拟设备不算 —— 往 `/dev/null` 写不是灾难。
fn is_real_device(path: &str) -> bool {
    let norm = normalize_path(path);
    norm.starts_with("/dev/") && !is_virtual_device(&norm)
}

/// `fdisk -l` / `parted --list` 只列分区表，不写盘。
pub(super) fn is_listing_only(base: &str, args: &[String]) -> bool {
    if base != "fdisk" && base != "parted" {
        return false;
    }
    args.iter().any(|a| {
        a == "--list"
            || (a.starts_with('-') && !a.starts_with("--") && a.len() > 1 && a[1..].contains('l'))
    })
}

/// 该段命令会写哪个真实块设备：`dd of=/dev/sda`、`mkfs.ext4 /dev/sdb1`、`wipefs -a /dev/sdc`…
fn block_device_target(base: &str, args: &[String]) -> Option<String> {
    if base == "dd" {
        return args
            .iter()
            .filter_map(|a| a.strip_prefix("of="))
            .find(|v| is_real_device(v))
            .map(|v| v.to_string());
    }
    let is_device_cmd = is_mkfs(base) || DISK_COMMANDS.contains(&base);
    if !is_device_cmd || is_listing_only(base, args) {
        return None;
    }
    // 目标不一定是第一个非选项参数：带值选项的值同样不是 `-` 开头
    // （`mkfs -t ext4 /dev/sda1` 里 `ext4` 会抢在设备前头）。这一族命令只要点名了
    // 真实设备就要拒绝，所以扫**全部**非选项参数，不能停在第一个。
    args.iter()
        .find(|a| !a.starts_with('-') && is_real_device(a))
        .cloned()
}

/// 参数层面的"硬判定"：这一段的参数本身就决定了它该被拒绝或强制审批，
/// 与命令名声望、用户配置都无关。返回 `None` 表示"这一层没意见"。
///
/// 只放两类情况进来：
///   - **直接拒绝** —— 百分百不可逆、或一眼就是参数写错了的（递归删到系统关键
///     目录/家目录本体、把东西直接写进块设备）。
///   - **强制审批** —— 命令本身合法、只是范围大得需要人看一眼的（`/usr`、`/var`
///     下的递归删除，磁盘工具作用在镜像文件上）。
///
/// 其余一切（管道进 shell、解析不了、按命令名看起来就不妙）都不在这里处理。
pub fn hard_verdict(parsed: &ParsedSegment) -> Option<Assessment> {
    let base = parsed.base_cmd.as_str();

    match classify_recursive_rm(parsed) {
        (RmTargetClass::Catastrophic, Some(p)) => {
            return Some(Assessment::denied(format!("递归删除危险路径 `{}`", p)));
        }
        (RmTargetClass::SystemTree, Some(p)) => {
            return Some(Assessment::forced(format!(
                "递归删除系统目录下的 `{}`，范围和影响需要确认",
                p
            )));
        }
        _ => {}
    }

    if let Some(dev) = block_device_target(base, &parsed.args) {
        return Some(Assessment::denied(format!(
            "`{}` 直接作用于块设备 `{}`",
            base, dev
        )));
    }

    None
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

    // ──────────── classify_rm_target ────────────

    #[test]
    fn rm_target_root_and_glob_are_catastrophic() {
        for p in ["/", "/*", "/.*", "~", "$HOME", "~/", "$HOME/", "/home", "/home/user"] {
            assert_eq!(
                classify_rm_target(p),
                RmTargetClass::Catastrophic,
                "`{}` 应当是灾难级目标",
                p
            );
        }
    }

    /// `/etc`、`/boot` 这类目录里没有"用户的活儿"，删它只能是出事了。
    #[test]
    fn rm_target_system_dirs_are_catastrophic() {
        for p in ["/etc", "/etc/nginx", "/boot", "/dev", "/proc", "/bin", "/lib64", "/root"] {
            assert_eq!(
                classify_rm_target(p),
                RmTargetClass::Catastrophic,
                "`{}` 应当是灾难级目标",
                p
            );
        }
    }

    /// `/usr`、`/var` 底下既有系统文件也有构建产物和日志 —— 拒绝太糙、放行太险，
    /// 交给人判断。这条曾经和上一组一起被直接拒绝，`rm -rf /var/log/myapp` 会
    /// 被无差别挡掉。
    #[test]
    fn rm_target_system_trees_need_approval_not_denial() {
        for p in ["/usr", "/usr/local/src/myproj", "/var", "/var/log/myapp"] {
            assert_eq!(
                classify_rm_target(p),
                RmTargetClass::SystemTree,
                "`{}` 应当是「需要确认」而不是「直接拒绝」",
                p
            );
        }
    }

    #[test]
    fn safe_rm_targets() {
        assert_eq!(classify_rm_target("/tmp/build"), RmTargetClass::Safe);
        assert_eq!(
            classify_rm_target("/home/user/project/dist"),
            RmTargetClass::Safe
        );
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
        let seg = crate::agent::risk::parser::ParsedSegment {
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
        let seg = crate::agent::risk::parser::ParsedSegment {
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
        let seg = crate::agent::risk::parser::ParsedSegment {
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
