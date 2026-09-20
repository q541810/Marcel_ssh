use super::checker::{is_listing_only, is_mkfs, is_read_only_system_query, DISK_COMMANDS};
use super::disposition::Assessment;
use super::parser::ParsedSegment;

/// 系统级命令：动的是整台机器的全局状态（服务、用户、防火墙、挂载、进程、权限）。
///
/// 这类命令不管在什么模式下都得有人点头 —— 它们是「强制审批」这一档的主要来源。
/// 判据是"影响范围超出当前工作目录"，不是"命令名听起来危险"。
pub const SYSTEM_LEVEL_COMMANDS: &[&str] = &[
    "reboot",
    "shutdown",
    "poweroff",
    "halt",
    "init",
    "mount",
    "umount",
    "useradd",
    "userdel",
    "usermod",
    "groupadd",
    "groupdel",
    "passwd",
    "su",
    "sudo",
    "chroot",
    "systemctl",
    "service",
    "iptables",
    "ip6tables",
    "nft",
    "ufw",
    "firewall-cmd",
    "crontab",
    "at",
    "chmod",
    "chown",
    "chgrp",
    "kill",
    "killall",
    "pkill",
];

/// 单段命令的**基础档位**：只看命令名与 `sudo` 包裹，不看策略、不看路径参数。
///
/// 返回 `Allow` 不代表"这条命令随便跑" —— 它只表示**这一层没有意见**，档位交给
/// 后面的命令名单去定（白名单命中就放行、黑名单命中就要审批）。所以这里刻意不再
/// 分"低风险 / 中风险"：那两级算出来也没人拿它做不同的决定，只是徒增维护点。
///
/// 反过来，返回 `ForceApproval` 是**这一层的最终意见**：不管名单怎么配、不管
/// 是不是 Auto 模式，都要有人确认。
pub fn base_assessment(parsed: &ParsedSegment) -> Assessment {
    let base = parsed.base_cmd.as_str();
    if parsed.sudo_wrapped {
        return Assessment::forced("命令经 sudo 提权执行");
    }
    if SYSTEM_LEVEL_COMMANDS.contains(&base) {
        // `systemctl status` / `service x status` / 裸 `mount` / `crontab -l` 这类
        // 查询形态什么也不改，别把它们和 `restart` / `umount` 一起抬档。
        if is_read_only_system_query(base, &parsed.args) {
            return Assessment::allow();
        }
        return Assessment::forced(format!("`{}` 是系统级命令，影响整台机器", base));
    }
    if is_mkfs(base) || DISK_COMMANDS.contains(&base) {
        // `fdisk -l` / `parted --list` 只是把分区表打出来看，没有写盘动作。
        if is_listing_only(base, &parsed.args) {
            return Assessment::allow();
        }
        return Assessment::forced(format!("`{}` 直接操作磁盘，数据无法恢复", base));
    }
    Assessment::allow()
}
