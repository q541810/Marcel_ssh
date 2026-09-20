use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::agent::Disposition;

use super::checker::{
    contains_top_level_pipe, hard_verdict, is_bare_shell, is_fork_bomb, is_read_only_command,
    is_virtual_device, looks_like_path, normalize_path,
};
use super::disposition::Assessment;
use super::model::base_assessment;
use super::parser::{parse_segment, split_command_chain, ParseError, ParsedSegment};

/// 命令风险评估的策略输入 —— 只有用户真的能配的东西，其余一律写在代码里。
///
/// 这里曾经还有 `max_commands_per_task`、`task_timeout_secs`、`blocked_patterns`、
/// `blocked_base_commands`、`auto_approve_level` 五个字段：前两个和最后一个全仓
/// 无人读取（真正生效的同类限制在 `AgentModeSettings` / `AppSettings` 上），后两个
/// 是写死的"危险命令/模式"名单 —— 按名字整类拒会误伤（`fdisk -l` 是只读、
/// `mkfs.ext4 disk.img` 是常规操作），现在改由参数判定，名单本身也就不需要了。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityPolicy {
    /// 命令执行超时（秒）。由 `AppSettings::command_timeout_secs` 注入。
    pub command_timeout_secs: u64,
    /// 系统自带的受保护目录。用户不能改这一份，只能往上面叠。
    pub protected_paths: Vec<String>,
    /// 用户在设置里加的保护目录（桌面 / 移动端都有入口）。
    #[serde(default)]
    pub custom_protected_paths: Vec<String>,
}

impl SecurityPolicy {
    /// 路径是否落在受保护目录下（内置 + 用户自定义）。
    ///
    /// **这是"路径是否受保护"的唯一判定入口。** 曾经有一份只认内置目录的副本，
    /// 结果用户在设置里加的保护目录对命令行参数完全无效 —— 别再造第二份。
    ///
    /// 虚拟设备（`/dev/null`、`/dev/stdout`、`/dev/fd/*`）**不算**受保护路径：
    /// `/dev` 那一条本意是护住块设备，而 `2>/dev/null`、`curl -o /dev/null` 是
    /// 最常见的丢弃输出写法。把它们算进来，会让一整类只读诊断命令在 Auto 模式下
    /// 也弹窗（`ss -tlnp 2>/dev/null | grep 10030` 这种）。
    pub fn is_protected_path(&self, path: &str) -> bool {
        let norm = normalize_path(path);
        if is_virtual_device(&norm) {
            return false;
        }
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
            command_timeout_secs: 180,
            protected_paths: vec![
                "/etc".into(),
                "/boot".into(),
                "/sys".into(),
                "/proc".into(),
                "/dev".into(),
            ],
            custom_protected_paths: vec![],
        }
    }
}

/// 命令风险评估器。
///
/// 它**不做隔离** —— 进程、文件系统、网络的隔离不归它管。它只回答一个问题：
/// 这条命令该怎么处置（放行 / 请求审批 / 强制审批 / 直接拒绝）。
pub struct RiskAssessor {
    policy: SecurityPolicy,
}

impl RiskAssessor {
    pub fn new(policy: SecurityPolicy) -> Self {
        Self { policy }
    }

    /// 从可选的策略构造：`None` 时用默认策略（例如工具上下文里没注入策略）。
    pub fn from_optional(policy: Option<&SecurityPolicy>) -> Self {
        Self {
            policy: policy.cloned().unwrap_or_default(),
        }
    }

    pub fn policy(&self) -> &SecurityPolicy {
        &self.policy
    }

    /// 给一条命令定档 —— **风险评估的唯一入口**。
    ///
    /// 三个来源按严取一：
    ///   1. 灾难模式（[`catastrophic_reason`]）→ [`Disposition::Deny`]
    ///   2. 系统级命令 / 磁盘工具 / `sudo` / 管道进 shell / 受保护路径
    ///      → [`Disposition::ForceApproval`]
    ///   3. 其余 → [`Disposition::Allow`]，由调用方按命令名单决定要不要审批
    ///
    /// 一条命令由多个 shell 段拼成（`a; b | c`），每段各判一次，取最严的那档。
    ///
    /// **解析不了的命令直接拒绝，把原因回给模型让它改写重发**（见
    /// [`Self::unparsable`]）。看不懂的写法不猜 —— 也**不能**放行。
    pub fn assess_command(&self, cmd: &str) -> Assessment {
        let trimmed = cmd.trim();
        if trimmed.is_empty() {
            return Assessment::allow();
        }

        // fork bomb 按**原文**查，先于解析：它藏在引号或包装里也要拦住。
        // 这是唯一一个不需要解析成功就能给出的拒绝。
        if is_fork_bomb(trimmed) {
            return Assessment::denied("检测到 fork bomb");
        }

        let segments = match split_command_chain(trimmed) {
            Ok(s) => s,
            Err(e) => return Self::unparsable(&e, trimmed),
        };
        let has_pipe = contains_top_level_pipe(trimmed);

        let mut worst = Assessment::allow();
        for seg in &segments {
            let parsed = match parse_segment(seg) {
                Ok(p) => p,
                // 这一段切不出命令与参数 → 它的内容无从判断。
                //
                // **今天走不到这里**：`split_command_chain` 已经拒绝了 `shell_words`
                // 会拒绝的全部输入（两者对引号与转义的处理逐字符对齐，
                // `split_and_tokenize_agree_on_what_is_parseable` 钉住这个前提）。
                // 留着是因为"切不出来"的默认动作不该是放行：以前这里是 `continue`，
                // 等于把看不懂的那一段跳过让它照跑 —— 安全闸门要往「不放行」倒。
                Err(e) => return Self::unparsable(&e, trimmed),
            };

            if let Some(verdict) = hard_verdict(&parsed) {
                if verdict.disposition == Disposition::Deny {
                    log::warn!(
                        "命令被拒绝执行（灾难模式）：{:?} —— {}",
                        verdict.reason,
                        trimmed
                    );
                    return verdict;
                }
                worst = worst.worst(verdict);
            }

            // `curl … | sh` 这类"下什么就跑什么"：不是灾难，但必须有人看着。
            if has_pipe && is_bare_shell(&parsed) {
                worst = worst.worst(Assessment::forced(
                    "命令把内容管道给了 shell 解释器，等于执行下载来的代码",
                ));
            }

            if let Some((kind, inner)) = &parsed.embedded_eval {
                worst = worst.worst(self.assess_embedded(kind, inner.as_deref()));
            }

            worst = worst.worst(base_assessment(&parsed));

            if let Some(path) = self.protected_path_hit(&parsed) {
                worst = worst.worst(Assessment::forced(format!(
                    "命令会改动受保护路径 `{}`",
                    path
                )));
            }
        }
        worst
    }

    /// 解析不了的命令 → 拒绝，并给出一条能照着改的说明。
    ///
    /// 这里曾经返回 [`Assessment::allow`]，理由是"调用方那一步（命令名单）同样看不懂
    /// 原文，会保守地要求审批"。**那个理由只在 Plan / Agent 成立**：命令名单只在那两档
    /// 被调用（见 `tool_dispatcher::decide_command` 的 Auto 分支），于是
    /// `echo $(rm -rf /)` 在 Auto 下既没有风险判定、也没有名单、也没有弹窗，原样发给
    /// 远端 shell —— 而 HEAD 是靠这里返回 `Err` 硬拦、每个模式都拦住的，四档改造把那层
    /// 拦丢了。看不懂的东西不猜，也不能放行：回给模型，让它改写成静态可判定的形式重发。
    fn unparsable(err: &ParseError, cmd: &str) -> Assessment {
        log::warn!("命令被拒绝执行（无法解析）：{} —— {}", err, cmd);
        Assessment::denied(format!(
            "无法解析这条命令（{}），所以没有执行 —— 看不懂的写法不猜。\
             请改写成可以被静态检查的形式后重发：去掉 $( ) / 反引号 / <( ) 这类替换，并确认引号成对。",
            err.explain()
        ))
    }

    /// 内嵌的 `bash -c "…"` / `eval …` / `source x`：里层当独立命令再判一次。
    fn assess_embedded(&self, kind: &str, inner: Option<&str>) -> Assessment {
        match (kind, inner) {
            // `source` / `.` 的正文没法静态看，一律要人确认。
            ("source", _) | (".", _) => {
                Assessment::forced("source 会执行脚本内容，而内容无法静态检查")
            }
            (_, Some(s)) => self.assess_command(s),
            // 有包装却没有内层字符串（例如 `bash -c "$CMD"`）：同样看不懂。
            _ => Assessment::forced("命令把要执行的内容藏在变量里，无法静态检查"),
        }
    }

    /// 参数或重定向目标命中的第一个受保护路径（内置 + 用户自定义）。
    fn protected_path_hit(&self, parsed: &ParsedSegment) -> Option<String> {
        // 重定向目标永远是写，任何命令都要查。
        if let Some(p) = parsed
            .redirect_targets
            .iter()
            .find(|p| self.policy.is_protected_path(p))
        {
            return Some(p.clone());
        }
        // 普通参数只有在命令可能写的时候才查：`cat /etc/passwd` 不该强制审批。
        if is_read_only_command(parsed) {
            return None;
        }
        parsed
            .args
            .iter()
            .filter(|a| looks_like_path(a))
            .find(|p| self.policy.is_protected_path(p))
            .cloned()
    }
}

impl Default for RiskAssessor {
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

    /// 虚拟设备不是"系统配置文件"。把它们算成受保护路径，会让所有带
    /// `2>/dev/null` 或 `curl -o /dev/null` 的只读诊断命令在 Auto 下弹窗
    /// —— 这是四档改造上线后立刻被用户撞到的回归。
    #[test]
    fn is_protected_path_ignores_virtual_devices() {
        let policy = SecurityPolicy::default();
        for p in [
            "/dev/null",
            "/dev/stdout",
            "/dev/stderr",
            "/dev/fd/2",
            "/dev/tty",
        ] {
            assert!(
                !policy.is_protected_path(p),
                "`{}` 是虚拟设备，不该算受保护路径",
                p
            );
        }
        // 但块设备仍然是受保护的。
        assert!(policy.is_protected_path("/dev/sda"));
        assert!(policy.is_protected_path("/dev/nvme0n1p1"));
    }

    #[test]
    fn from_user_settings_populates_custom_paths() {
        let policy = SecurityPolicy::from_user_settings(&["/srv/prod".into()], 120);
        assert!(policy.is_protected_path("/srv/prod/db.sqlite"));
        assert!(policy.is_protected_path("/etc/passwd"));
        assert_eq!(policy.command_timeout_secs, 120);
    }

    /// 自定义保护目录必须对**命令行参数**生效。
    ///
    /// 这条曾经是坏的：`assess_command` 里另有一份只遍历内置 `protected_paths`
    /// 的副本，于是用户在设置页加的保护目录只对 `write_file` 这类工具生效、
    /// 对 bash 命令完全无效。删掉那份副本、改成只走 `is_protected_path` 之后，
    /// 这条测试才可能通过。
    #[test]
    fn custom_protected_paths_force_approval_for_commands() {
        let policy = SecurityPolicy {
            custom_protected_paths: vec!["/srv/prod".into()],
            ..Default::default()
        };
        let assessor = RiskAssessor::new(policy);

        let a = assessor.assess_command("tee /srv/prod/app.conf");
        assert_eq!(a.disposition, Disposition::ForceApproval);
        assert!(a.reason.unwrap().contains("/srv/prod"));

        // 内置目录同样生效。
        assert_eq!(
            assessor.assess_command("tee /etc/hosts").disposition,
            Disposition::ForceApproval
        );
    }

    /// 只读命令碰受保护路径不强制审批 —— 否则 `cat /etc/hosts` 每次都在 Auto 下弹窗。
    #[test]
    fn read_only_commands_may_read_protected_paths() {
        let assessor = RiskAssessor::default();
        assert_eq!(
            assessor.assess_command("cat /etc/hosts").disposition,
            Disposition::Allow
        );
        assert_eq!(
            assessor.assess_command("grep root /etc/passwd").disposition,
            Disposition::Allow
        );
        // 但重定向目标照查：写就是写。
        assert_eq!(
            assessor.assess_command("cat /tmp/x > /etc/hosts").disposition,
            Disposition::ForceApproval
        );
        // `-delete` / `-o` 会让"只读"命令变成写。
        assert_eq!(
            assessor
                .assess_command("find /etc -name '*.old' -delete")
                .disposition,
            Disposition::ForceApproval
        );
    }

    /// 解析不了的命令 → **拒绝**，理由要说清是哪种写法看不懂。
    ///
    /// 这条曾经反过来断言 `Allow`（"交给名单那一步保守要求审批"）—— 但名单在 Auto
    /// 模式下根本不被调用，那个 "保守" 在 Auto 里不存在，`echo $(rm -rf /)` 会直接执行。
    #[test]
    fn unparsable_commands_are_denied_with_an_actionable_reason() {
        let assessor = RiskAssessor::default();
        for cmd in [
            "echo $(date)",
            "cat `hostname`",
            "rm -rf $(cat x)",
            "diff <(a) <(b)",
            r"echo 'unbalanced",
        ] {
            let a = assessor.assess_command(cmd);
            assert_eq!(
                a.disposition,
                Disposition::Deny,
                "`{}` 解析不了就该拒绝，不能放行",
                cmd
            );
            let reason = a.reason.unwrap_or_default();
            assert!(
                reason.contains("无法解析"),
                "`{}` 的理由要让模型看懂是解析问题，实际是 {:?}",
                cmd,
                reason
            );
            assert!(
                reason.contains("重发"),
                "`{}` 的理由要告诉模型下一步（改写后重发），实际是 {:?}",
                cmd,
                reason
            );
        }
    }

    /// 段落切不出命令与参数时同样拒绝 —— 这一支今天不可达（见 `assess_command` 里的
    /// 注释），所以这里只钉住"外壳"能到达的形态：引号/转义在结尾处断掉的那些写法。
    #[test]
    fn quoting_that_breaks_at_the_end_is_denied() {
        let assessor = RiskAssessor::default();
        for cmd in [r#"echo "abc\"#, "echo 'abc", "echo \"abc"] {
            let a = assessor.assess_command(cmd);
            assert_eq!(a.disposition, Disposition::Deny, "`{}` 应当被拒绝", cmd);
            assert!(a.reason.unwrap_or_default().contains("无法解析"));
        }
    }

    /// 反过来：正常写法一条都不能被这条规则误伤（上限很硬的回归面）。
    #[test]
    fn ordinary_quoting_is_still_allowed() {
        let assessor = RiskAssessor::default();
        for cmd in [
            "echo 'a;b'",
            r#"grep -r "don't" /tmp/x"#,
            "echo \"a\nb\"",
            "echo 100%",
            r"echo a\ b",
            "echo $HOME",
            "echo ${HOME}",
            "ls | grep x",
        ] {
            assert_ne!(
                assessor.assess_command(cmd).disposition,
                Disposition::Deny,
                "`{}` 是正常写法，不该被拒绝",
                cmd
            );
        }
    }
}
