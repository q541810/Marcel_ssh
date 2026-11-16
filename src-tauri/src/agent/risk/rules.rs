//! 命令风险规则表 —— **所有**命令审批规则的唯一来源。
//!
//! 以前判定规则散落在 `checker` / `model` / `windows` / `policy` 里，设置页只露出命令名单和
//! 受保护路径，其余（直接拒绝、系统级命令、磁盘工具、Windows 整套……）用户既看不到也改不了。
//! 现在每一条规则都在这里登记：稳定 id、人话说明、默认档位、可编辑的名单参数。检测代码
//! 命中后经 [`RuleConfig::verdict`] 出结论 —— 档位、开关、名单都以用户的覆盖项为准。
//!
//! ## 两类条目
//!
//! - **规则**（[`RuleKind::Rule`]）：命中即给出一个档位，用户可改档、可关。
//! - **豁免**（[`RuleKind::Exemption`]）：把某类形态**排除**在别的规则之外（`systemctl status`
//!   不算改系统、`cat /etc/hosts` 不算写受保护路径……），只有开/关，没有档位。
//!
//! ## 用户改动只存差异
//!
//! [`RuleConfig`] 只记录与默认不同的项：缺字段 = 默认；未知 id 直接忽略（更高版本写的）；
//! 内置规则以后调整默认值，用户没动过的跟着走。
//!
//! 加一条内置规则：在 [`RULES`] 里登记，检测代码里用同一个 id 调 `verdict`；
//! `rules_are_consistent` 测试会钉住 id 唯一、名单 key 唯一。

use std::collections::HashMap;

use serde::{Deserialize, Deserializer, Serialize};

use super::disposition::{Assessment, Disposition};
use super::parser::ParsedSegment;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleKind {
    /// 命中即给出一个档位。
    Rule,
    /// 只有开/关：开 = 这类形态被排除在别的规则之外。
    Exemption,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RuleScope {
    /// 按 POSIX shell 的写法判定。
    Posix,
    /// 按 PowerShell / cmd 的写法判定。
    Windows,
    /// 与 shell 种类无关。
    Any,
}

/// 一条规则依赖的、用户可编辑的名单。
pub struct ListDef {
    pub key: &'static str,
    pub label: &'static str,
    pub hint: &'static str,
    pub defaults: &'static [&'static str],
}

pub struct RuleDef {
    pub id: &'static str,
    pub kind: RuleKind,
    pub scope: RuleScope,
    pub title: &'static str,
    /// 一两句话：命中什么、为什么要拦、不拦什么。
    pub description: &'static str,
    pub examples: &'static [&'static str],
    /// 豁免恒为 `Allow`。
    pub default_level: Disposition,
    pub lists: &'static [ListDef],
    /// 命中时回给模型 / 显示在弹窗里的默认说明（模板，`{名}` 在命中时换成实际值）。
    /// 设置页把它原样预填进「拒绝说明」输入框，用户在它的基础上改；检测代码**只从这里取**默认说明
    /// （`RuleConfig::verdict_default`），不再另写一份。同一条规则里措辞不同的少数分支
    /// （如 `win_accounts` 的「加入管理员组」）由检测代码就地写，这里放的是最常见的那一种。
    /// 豁免没有说明。
    pub reason: &'static str,
    /// 模板里能用的占位名与含义（设置页在输入框下面列出来）。
    pub reason_vars: &'static [(&'static str, &'static str)],
}

/// 自定义规则的默认说明模板与占位（设置页预填「拒绝说明」用，经目录命令下发，前端不抄）。
pub const CUSTOM_REASON: &str = "命中自定义规则「{规则}」";
pub const CUSTOM_REASON_VARS: &[(&str, &str)] = &[
    ("规则", "这条规则的名字（命令 + 参数）"),
    ("命令", "规则里写的命令名"),
    ("参数", "规则里写的参数关键字（没写则为空）"),
];

/// 把模板里的 `{名}` 换成实际值；认不得的 `{…}` 原样留着。
pub fn fill_template(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (name, value) in vars {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

const SYSTEM_LEVEL_COMMANDS: &[&str] = &[
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
];

const READ_ONLY_COMMANDS: &[&str] = &[
    "ls",
    "cat",
    "pwd",
    "whoami",
    "hostname",
    "uname",
    "date",
    "uptime",
    "df",
    "du",
    "free",
    "top",
    "ps",
    "id",
    "env",
    "head",
    "tail",
    "wc",
    "find",
    "grep",
    "egrep",
    "fgrep",
    "which",
    "file",
    "stat",
    "lsof",
    "netstat",
    "ss",
    "ifconfig",
    "ip",
    "dig",
    "nslookup",
    "ping",
    "traceroute",
    "curl",
    "wget",
    "less",
    "more",
    "sort",
    "uniq",
    "diff",
    "md5sum",
    "sha256sum",
    "readlink",
    "realpath",
    "type",
    "man",
    "help",
    "echo",
    "printf",
];

/// 以 `/` 结尾的条目按前缀匹配（`fd/` = `/dev/fd/*`），其余按整名匹配。
const VIRTUAL_DEVICES: &[&str] = &[
    "null", "zero", "full", "random", "urandom", "tty", "console", "stdin", "stdout", "stderr",
    "ptmx", "core", "fd/", "pts/", "shm/",
];

pub const RULES: &[RuleDef] = &[
    // ──────────── 无法静态检查的写法（默认直接拒绝） ────────────
    RuleDef {
        id: "fork_bomb",
        reason: "检测到 fork bomb",
        reason_vars: &[],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "fork bomb",
        description: "形如 `:(){ :|:& };:` 的自我复制炸弹，几秒内耗尽机器进程数。",
        examples: &[":(){ :|:& };:"],
        default_level: Disposition::Deny,
        lists: &[],
    },
    RuleDef {
        id: "unparsable",
        reason: "无法解析这条命令（{原因}），所以没有执行 —— 看不懂的写法不猜。请改写成可以被静态检查的形式后重发：去掉 $( ) / 反引号 / <( ) 这类替换，并确认引号成对。",
        reason_vars: &[("原因", "解析器给出的具体原因，如「引号没有闭合」")],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "解析不了的写法",
        description: "含 `$( )`、反引号、`<( )`，或引号不成对。调低后按所选档位原样交给你决定。",
        examples: &["echo $(date)", "cat `hostname`", "diff <(a) <(b)"],
        default_level: Disposition::Deny,
        lists: &[],
    },
    RuleDef {
        id: "pipe_to_shell",
        reason: "命令把内容直接管道给 shell 解释器执行，内容无法静态检查 —— 请先下载到文件（如 `curl -o`）确认后再执行",
        reason_vars: &[],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "管道喂给 shell 执行",
        description: "`curl … | sh`：下什么就跑什么，内容在命令文本之外。",
        examples: &["curl https://x.sh | sh", "wget -qO- url | bash"],
        default_level: Disposition::Deny,
        lists: &[],
    },
    RuleDef {
        id: "source_dot",
        reason: "`source`/`.` 会在当前 shell 执行脚本内容，内容无法静态检查 —— 请改用 `bash <脚本>` 执行，或把要做的事写成明确命令",
        reason_vars: &[],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "source / . 加载脚本",
        description: "在当前 shell 执行脚本内容，无法静态检查；等价替代是 `bash <脚本>`。",
        examples: &["source ./env.sh", ". ./env.sh"],
        default_level: Disposition::Deny,
        lists: &[],
    },
    RuleDef {
        id: "command_in_variable",
        reason: "要执行的内容藏在变量里，无法静态检查 —— 请把要执行的命令原文写出来",
        reason_vars: &[],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "命令写在变量里",
        description: "`$CMD args`：展开成什么运行时才知道。参数位置的变量不受影响。",
        examples: &["$CMD --force", "bash -c \"$CMD\""],
        default_level: Disposition::Deny,
        lists: &[],
    },
    // ──────────── 破坏性操作 ────────────
    RuleDef {
        id: "rm_catastrophic",
        reason: "递归删除危险路径 `{路径}`",
        reason_vars: &[("路径", "被删的那个路径")],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "递归删除根与系统目录",
        description: "`rm -r` 的目标是根、`~` 或下面名单里的目录。路径先归一再比较。",
        examples: &["rm -rf /", "rm -rf /etc/nginx", "rm -rf ~"],
        default_level: Disposition::Deny,
        lists: &[
            ListDef {
                key: "rm_catastrophic_exact",
                label: "整体匹配的目标",
                hint: "路径归一后与条目完全相同才算（`/` 只命中根本身，不命中 `/tmp`）。",
                defaults: &["/", "/*", "/.*", "~", "$HOME", "~/", "$HOME/"],
            },
            ListDef {
                key: "rm_catastrophic_dirs",
                label: "整棵目录树",
                hint: "目标等于或位于这些目录之下都算。",
                defaults: &[
                    "/etc", "/bin", "/sbin", "/lib", "/lib64", "/boot", "/sys", "/proc", "/dev",
                    "/root",
                ],
            },
        ],
    },
    RuleDef {
        id: "rm_home",
        reason: "递归删除危险路径 `{路径}`",
        reason_vars: &[("路径", "被删的那个路径")],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "递归删除家目录",
        description: "目标是 `/home` 或 `/home/<用户名>`；更深的路径不算。",
        examples: &["rm -rf /home", "rm -rf /home/bob"],
        default_level: Disposition::Deny,
        lists: &[],
    },
    RuleDef {
        id: "rm_system_tree",
        reason: "递归删除系统目录下的 `{路径}`，范围和影响需要确认",
        reason_vars: &[("路径", "被删的那个路径")],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "递归删除 /usr、/var 下的内容",
        description: "既有系统文件，也有日志、缓存、构建产物，默认交给你确认。",
        examples: &["rm -rf /var/log/myapp", "rm -rf /usr/local/src/proj"],
        default_level: Disposition::ForceApproval,
        lists: &[ListDef {
            key: "rm_system_tree_dirs",
            label: "系统树目录",
            hint: "目标等于或位于这些目录之下都算。",
            defaults: &["/usr", "/var"],
        }],
    },
    RuleDef {
        id: "block_device_write",
        reason: "`{命令}` 直接作用于块设备 `{设备}`",
        reason_vars: &[("命令", "命中的命令名"), ("设备", "被写的设备")],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "写真实磁盘设备",
        description: "`dd of=/dev/sda`、`mkfs /dev/sdb1` 这类点名真实设备的写盘命令。",
        examples: &["dd if=x of=/dev/sda", "mkfs.ext4 /dev/sdb1"],
        default_level: Disposition::Deny,
        lists: &[],
    },
    RuleDef {
        id: "disk_tools",
        reason: "`{命令}` 直接操作磁盘，数据无法恢复",
        reason_vars: &[("命令", "命中的命令名")],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "磁盘工具",
        description: "正常用途就是改写数据，不点名设备也要看一眼。`mkfs.*` 按前缀识别。",
        examples: &["mkfs.ext4 disk.img", "dd if=/dev/zero of=/tmp/img"],
        default_level: Disposition::ForceApproval,
        lists: &[ListDef {
            key: "disk_commands",
            label: "磁盘工具命令名",
            hint: "`mkfs` 家族按前缀识别，不在名单里。",
            defaults: &[
                "dd", "fdisk", "parted", "shred", "mkswap", "wipefs", "sgdisk", "gdisk",
            ],
        }],
    },
    RuleDef {
        id: "name_based_kill",
        reason: "`{命令}` 按名字批量杀进程，误伤面不可控 —— 请用 `ps`/`pgrep` 查到 PID 后 `kill <PID>`，或用 `systemctl` 管理服务",
        reason_vars: &[("命令", "命中的命令名")],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "按名字批量杀进程",
        description: "`pkill -f ssh` 能把自己的 SSH 会话一起带走。更精确的写法是查 PID 再 `kill`。",
        examples: &["pkill -f myapp", "killall node"],
        default_level: Disposition::Deny,
        lists: &[ListDef {
            key: "name_based_kill_commands",
            label: "按名字杀进程的命令",
            hint: "",
            defaults: &["pkill", "killall"],
        }],
    },
    // ──────────── 系统级命令与受保护路径 ────────────
    RuleDef {
        id: "system_level_commands",
        reason: "`{命令}` 是系统级命令，影响整台机器",
        reason_vars: &[("命令", "命中的命令名")],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "系统级命令",
        description: "动的是整台机器：服务、用户、防火墙、挂载、权限、计划任务。",
        examples: &[
            "systemctl restart nginx",
            "useradd bob",
            "chmod 777 /var/www",
        ],
        default_level: Disposition::ForceApproval,
        lists: &[ListDef {
            key: "system_level_commands",
            label: "系统级命令名",
            hint: "按基础命令名匹配，不含路径和参数。",
            defaults: SYSTEM_LEVEL_COMMANDS,
        }],
    },
    RuleDef {
        id: "sudo_wrapper",
        reason: "命令经 sudo 提权执行",
        reason_vars: &[],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "sudo 提权",
        description: "保底至少请求审批；里面真正跑的命令照常评估、取最严。",
        examples: &["sudo apt update"],
        default_level: Disposition::Approval,
        lists: &[],
    },
    RuleDef {
        id: "protected_paths",
        reason: "命令会改动受保护路径 `{路径}`",
        reason_vars: &[("路径", "命中的受保护路径")],
        kind: RuleKind::Rule,
        scope: RuleScope::Posix,
        title: "写入受保护路径",
        description:
            "重定向或写文件的目标落在受保护路径下。目录在「命令执行策略 → 受保护路径」里管理。",
        examples: &["echo x > /etc/hosts", "tee /etc/nginx/nginx.conf"],
        default_level: Disposition::ForceApproval,
        lists: &[ListDef {
            key: "protected_paths",
            label: "内置受保护目录",
            hint: "自定义保护路径在下方「受保护路径」里单独管理，两处合起来生效。",
            defaults: &["/etc", "/boot", "/sys", "/proc", "/dev"],
        }],
    },
    // ──────────── Windows ────────────
    RuleDef {
        id: "win_disk_format",
        reason: "`{命令}` {说明} —— 请先确认要操作的是哪个盘符/分区/磁盘编号",
        reason_vars: &[("命令", "命中的命令名"), ("说明", "这条命令具体会做什么")],
        kind: RuleKind::Rule,
        scope: RuleScope::Windows,
        title: "格式化 / 改分区表",
        description: "`format`、`Format-Volume`、`diskpart`。",
        examples: &["format D: /q", "diskpart /s clean.txt"],
        default_level: Disposition::ForceApproval,
        lists: &[],
    },
    RuleDef {
        id: "win_boot_config",
        reason: "`{命令}` 会改写启动配置（BCD），改错会让系统无法启动 —— 请确认要改的启动项与取值",
        reason_vars: &[("命令", "命中的命令名")],
        kind: RuleKind::Rule,
        scope: RuleScope::Windows,
        title: "改写启动配置",
        description: "`bcdedit` 的修改形态、`bootrec /fixmbr` 等。",
        examples: &[
            "bcdedit /set {default} recoveryenabled no",
            "bootrec /fixmbr",
        ],
        default_level: Disposition::ForceApproval,
        lists: &[],
    },
    RuleDef {
        id: "win_recursive_delete",
        reason: "`{命令}` 递归删除 `{目标}`（{说明}）—— 命令删除不进回收站、无法恢复，影响范围远超当前工作目录",
        reason_vars: &[("命令", "命中的命令名"), ("目标", "被删的路径"), ("说明", "这个路径为什么危险")],
        kind: RuleKind::Rule,
        scope: RuleScope::Windows,
        title: "递归删除盘根 / 系统目录",
        description:
            "`Remove-Item -Recurse`、`rd /s` 删盘根、`C:\\Windows`、`C:\\Users` 及其下一层。",
        examples: &[
            "Remove-Item -Recurse -Force C:\\Windows",
            "rd /s /q C:\\Users\\bob",
        ],
        default_level: Disposition::ForceApproval,
        lists: &[],
    },
    RuleDef {
        id: "win_registry_delete",
        reason: "`{命令} delete {分支}` 会删除系统注册表 hive（HKLM/HKU）下的键 —— 影响整台机器而不只是当前用户，删错可能让系统或软件起不来",
        reason_vars: &[("命令", "命中的命令名"), ("分支", "被删的注册表分支")],
        kind: RuleKind::Rule,
        scope: RuleScope::Windows,
        title: "删除系统注册表",
        description: "`reg delete` 作用在 HKLM / HKU。",
        examples: &["reg delete HKLM\\Software\\Foo /f"],
        default_level: Disposition::ForceApproval,
        lists: &[],
    },
    RuleDef {
        id: "win_power",
        reason: "`{命令}` 会立刻关机/重启这台电脑 —— 本机执行时就是用户自己的机器，未保存的工作会丢失",
        reason_vars: &[("命令", "命中的命令（含关机/重启参数）")],
        kind: RuleKind::Rule,
        scope: RuleScope::Windows,
        title: "关机 / 重启",
        description: "`Restart-Computer`、`Stop-Computer`、`shutdown /r`。",
        examples: &["Restart-Computer", "shutdown /r /t 0"],
        default_level: Disposition::ForceApproval,
        lists: &[],
    },
    RuleDef {
        id: "win_accounts",
        reason: "`{命令}` 会在本机新建一个账号 —— 这是整台机器的状态改动，请确认要建的账号与用途",
        reason_vars: &[("命令", "命中的命令名")],
        kind: RuleKind::Rule,
        scope: RuleScope::Windows,
        title: "新建账号 / 加管理员",
        description: "`net user … /add`、`New-LocalUser`、加进 Administrators。",
        examples: &[
            "net user bob pw /add",
            "Add-LocalGroupMember -Group Administrators -Member bob",
        ],
        default_level: Disposition::ForceApproval,
        lists: &[],
    },
    // ──────────── 豁免 ────────────
    RuleDef {
        id: "system_query_exempt",
        reason: "",
        reason_vars: &[],
        kind: RuleKind::Exemption,
        scope: RuleScope::Posix,
        title: "放过系统命令的查询形态",
        description: "`systemctl status`、`crontab -l`、`iptables -L` 等只看不改，不算系统级命令。",
        examples: &["systemctl status nginx", "crontab -l"],
        default_level: Disposition::Allow,
        lists: &[],
    },
    RuleDef {
        id: "disk_listing_exempt",
        reason: "",
        reason_vars: &[],
        kind: RuleKind::Exemption,
        scope: RuleScope::Posix,
        title: "放过磁盘工具的只列不写",
        description: "`fdisk -l`、`parted --list` 不算磁盘工具。",
        examples: &["fdisk -l"],
        default_level: Disposition::Allow,
        lists: &[],
    },
    RuleDef {
        id: "read_only_exempt",
        reason: "",
        reason_vars: &[],
        kind: RuleKind::Exemption,
        scope: RuleScope::Posix,
        title: "放过只读命令读受保护路径",
        description: "名单里的命令读受保护路径（`cat /etc/passwd`）不算写。",
        examples: &["cat /etc/hosts", "grep root /etc/passwd"],
        default_level: Disposition::Allow,
        lists: &[ListDef {
            key: "read_only_commands",
            label: "只读命令名",
            hint: "",
            defaults: READ_ONLY_COMMANDS,
        }],
    },
    RuleDef {
        id: "virtual_device_exempt",
        reason: "",
        reason_vars: &[],
        kind: RuleKind::Exemption,
        scope: RuleScope::Posix,
        title: "放过 /dev/null 等虚拟设备",
        description: "`2>/dev/null` 这类丢弃输出的写法不算写受保护路径。",
        examples: &["ss -tlnp 2>/dev/null"],
        default_level: Disposition::Allow,
        lists: &[ListDef {
            key: "virtual_devices",
            label: "虚拟设备",
            hint: "写 `/dev/` 之后的部分；以 `/` 结尾的按前缀匹配（`fd/` = `/dev/fd/*`）。",
            defaults: VIRTUAL_DEVICES,
        }],
    },
];

pub fn rule_def(id: &str) -> Option<&'static RuleDef> {
    RULES.iter().find(|r| r.id == id)
}

/// 名单 key → 它的默认条目。
fn list_def(key: &str) -> Option<&'static ListDef> {
    RULES
        .iter()
        .flat_map(|r| r.lists.iter())
        .find(|l| l.key == key)
}

// ──────────────────────────── 用户配置 ────────────────────────────

/// `level` 反序列化：未知取值（更高版本写入的档位）当作没设置，而不是让整份配置解析失败。
fn lenient_level<'de, D: Deserializer<'de>>(d: D) -> Result<Option<Disposition>, D::Error> {
    let value = serde_json::Value::deserialize(d)?;
    Ok(match value {
        serde_json::Value::Null => None,
        v => match serde_json::from_value::<Disposition>(v.clone()) {
            Ok(level) => Some(level),
            Err(_) => {
                log::warn!("未知的规则档位 {:?}，按默认档位处理", v);
                None
            }
        },
    })
}

/// 按工具的审批档位表（`AgentModeSettings.tool_approval_levels`）的反序列化：某一项的档位
/// 读不懂（更高版本写入）时按强制审批处理 —— 宁严勿松，也不让整份配置解析失败。
pub fn lenient_level_map<'de, D: Deserializer<'de>>(
    d: D,
) -> Result<std::collections::BTreeMap<String, Disposition>, D::Error> {
    let raw = std::collections::BTreeMap::<String, serde_json::Value>::deserialize(d)?;
    Ok(raw
        .into_iter()
        .map(|(tool, v)| {
            let level = serde_json::from_value::<Disposition>(v.clone()).unwrap_or_else(|_| {
                log::warn!("工具 {tool} 的审批档位 {v:?} 读不懂，按强制审批处理");
                Disposition::ForceApproval
            });
            (tool, level)
        })
        .collect())
}

fn lenient_level_or_force<'de, D: Deserializer<'de>>(d: D) -> Result<Disposition, D::Error> {
    // 自定义规则读不出档位 → 强制审批：规则本来就是要拦的，读不懂时宁严勿松。
    Ok(lenient_level(d)?.unwrap_or(Disposition::ForceApproval))
}

fn default_true() -> bool {
    true
}

fn default_custom_level() -> Disposition {
    Disposition::ForceApproval
}

/// 用户对一条内置规则的改动。三项都可缺省，缺省 = 用默认。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RiskRuleOverride {
    /// `Some(false)` = 关闭这条规则（豁免则是不再豁免）。
    pub enabled: Option<bool>,
    #[serde(
        deserialize_with = "lenient_level",
        skip_serializing_if = "Option::is_none"
    )]
    pub level: Option<Disposition>,
    /// 名单参数的覆盖：key → 完整条目表（整体替换默认，不是增量）。
    pub lists: HashMap<String, Vec<String>>,
    /// 档位是「直接拒绝」时回给模型的话（替换这条规则自带的说明）。留空 = 用默认说明；
    /// 档位不是「直接拒绝」时不读（没有拒绝就没有要回的话）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

/// 用户自定义的规则：命令名（可再限定参数关键字）→ 档位。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CustomRiskRule {
    pub id: String,
    pub name: String,
    /// 基础命令名（不含路径），例如 `docker`。`sudo` 同时匹配经 sudo 提权的命令。
    pub command: String,
    /// 可选：任一参数包含这段文字才算命中（例如 `prune`）。留空 = 不限参数。
    pub arg_contains: String,
    #[serde(deserialize_with = "lenient_level_or_force")]
    pub level: Disposition,
    pub enabled: bool,
    /// 档位是「直接拒绝」时回给模型的话（替换默认的「命中自定义规则「…」」）。留空 = 用默认。
    /// 档位不是「直接拒绝」时不读。
    pub message: String,
}

impl CustomRiskRule {
    /// 命中时给模型 / 弹窗看的原因：直接拒绝且写了说明用说明，否则默认模板；占位按这条规则填。
    fn verdict_reason(&self) -> String {
        let message = self.message.trim();
        let template = if self.level == Disposition::Deny && !message.is_empty() {
            message
        } else {
            CUSTOM_REASON
        };
        fill_template(
            template,
            &[
                ("规则", &self.display_name()),
                ("命令", self.command.trim()),
                ("参数", self.arg_contains.trim()),
            ],
        )
    }

    /// 「这个命令要问一次」的最简规则：不限参数、档位「请求审批」。默认规则与旧命令名单的
    /// 迁移都用它。
    pub fn approval_for(id: String, command: &str) -> Self {
        Self {
            id,
            command: command.to_string(),
            level: Disposition::Approval,
            ..Self::default()
        }
    }

    /// 给人看的名字：写了名称用名称，否则「命令 参数」（例如 `docker prune`）。
    /// 设置页不再提供名称输入框，规则在命中提示、审批弹窗里就靠这个认。
    pub fn display_name(&self) -> String {
        let name = self.name.trim();
        if !name.is_empty() {
            return name.to_string();
        }
        let arg = self.arg_contains.trim();
        if arg.is_empty() {
            self.command.trim().to_string()
        } else {
            format!("{} {}", self.command.trim(), arg)
        }
    }
}

/// 出厂自带的自定义规则：原先「禁止的命令」名单里的那五个，现在以普通规则的身份摆在
/// 自定义规则里，用户看得到、删得掉。
pub fn default_custom_risk_rules() -> Vec<CustomRiskRule> {
    ["rm", "mkfs", "dd", "shutdown", "reboot"]
        .into_iter()
        .map(|cmd| CustomRiskRule::approval_for(format!("default-{cmd}"), cmd))
        .collect()
}

impl Default for CustomRiskRule {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            command: String::new(),
            arg_contains: String::new(),
            level: default_custom_level(),
            enabled: default_true(),
            message: String::new(),
        }
    }
}

/// 一次评估用到的全部规则配置（随 [`super::SecurityPolicy`] 一起传下去）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RuleConfig {
    pub overrides: HashMap<String, RiskRuleOverride>,
    pub custom: Vec<CustomRiskRule>,
}

impl RuleConfig {
    pub fn new(overrides: HashMap<String, RiskRuleOverride>, custom: Vec<CustomRiskRule>) -> Self {
        Self { overrides, custom }
    }

    /// 这条规则（或豁免）当前是否生效。未知 id = 不生效。
    pub fn enabled(&self, id: &str) -> bool {
        rule_def(id).is_some()
            && self
                .overrides
                .get(id)
                .and_then(|o| o.enabled)
                .unwrap_or(true)
    }

    /// 豁免是否生效（语义同 [`Self::enabled`]，调用处读起来更直白）。
    pub fn exempt(&self, id: &str) -> bool {
        self.enabled(id)
    }

    /// 规则当前的档位（用户覆盖优先，否则默认）。未知 id = `Allow`。
    pub fn level(&self, id: &str) -> Disposition {
        let Some(def) = rule_def(id) else {
            return Disposition::Allow;
        };
        self.overrides
            .get(id)
            .and_then(|o| o.level)
            .unwrap_or(def.default_level)
    }

    /// 命中规则 `id` 时的评估结论：关闭或被调成「放行」= 无意见。
    pub fn verdict(&self, id: &str, reason: impl Into<String>) -> Assessment {
        self.verdict_with(id, reason, &[])
    }

    /// 用规则表里的默认说明模板出结论，`vars` 填占位（命令、路径……）。
    pub fn verdict_default(&self, id: &str, vars: &[(&str, &str)]) -> Assessment {
        let template = rule_def(id).map_or("", |d| d.reason);
        self.verdict_with(id, fill_template(template, vars), vars)
    }

    /// 同 [`Self::verdict`]，另带占位值：用户写了「拒绝说明」时用它填说明里的 `{名}`。
    pub fn verdict_with(
        &self,
        id: &str,
        reason: impl Into<String>,
        vars: &[(&str, &str)],
    ) -> Assessment {
        if !self.enabled(id) {
            return Assessment::allow();
        }
        let level = self.level(id);
        if level == Disposition::Allow {
            return Assessment::allow();
        }
        // 直接拒绝的话是回给模型的，用户写了自己的说明就用它，不再用规则自带的那句。
        let reason = match self.deny_message(id).filter(|_| level == Disposition::Deny) {
            Some(message) => fill_template(message, vars),
            None => reason.into(),
        };
        Assessment::at(level, reason).with_rule(id)
    }

    /// 用户给这条内置规则写的「拒绝说明」（空白视为没写）。
    fn deny_message(&self, id: &str) -> Option<&str> {
        self.overrides
            .get(id)
            .and_then(|o| o.message.as_deref())
            .map(str::trim)
            .filter(|m| !m.is_empty())
    }

    /// 名单的当前条目（用户覆盖优先，否则默认）。
    ///
    /// 只采信**已知规则 id** 的覆盖项（与 [`Self::enabled`] / [`Self::level`] 同一口径）：
    /// 更高版本写入的未知 id 必须整条忽略，不能让它带一份 `lists` 进来改写内置名单。
    pub fn items<'a>(&'a self, key: &str) -> Box<dyn Iterator<Item = &'a str> + 'a> {
        if let Some(custom) = self
            .overrides
            .iter()
            .filter(|(id, _)| rule_def(id.as_str()).is_some())
            .find_map(|(_, o)| o.lists.get(key))
        {
            return Box::new(custom.iter().map(String::as_str));
        }
        match list_def(key) {
            Some(def) => Box::new(def.defaults.iter().copied()),
            None => Box::new(std::iter::empty()),
        }
    }

    pub fn list_has(&self, key: &str, item: &str) -> bool {
        self.items(key).any(|i| i == item)
    }

    /// 规则 id → 给人看的名字（内置或自定义）。
    pub fn title_of(&self, id: &str) -> Option<String> {
        rule_def(id).map(|d| d.title.to_string()).or_else(|| {
            self.custom
                .iter()
                .find(|c| c.id == id)
                .map(CustomRiskRule::display_name)
        })
    }

    /// 自定义规则对一个 shell 段的评估结论（可能命中多条）。
    pub fn custom_verdicts(&self, parsed: &ParsedSegment) -> Vec<Assessment> {
        self.custom
            .iter()
            .filter(|c| c.enabled && c.level != Disposition::Allow)
            .filter(|c| {
                let cmd = c.command.trim();
                if cmd.is_empty() {
                    return false;
                }
                let name_hit = parsed.base_cmd.eq_ignore_ascii_case(cmd)
                    || (cmd == "sudo" && parsed.sudo_wrapped);
                let needle = c.arg_contains.trim();
                name_hit && (needle.is_empty() || parsed.args.iter().any(|a| a.contains(needle)))
            })
            .map(|c| Assessment::at(c.level, c.verdict_reason()).with_rule(&c.id))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn rules_are_consistent() {
        let mut ids = HashSet::new();
        let mut keys = HashSet::new();
        for r in RULES {
            assert!(ids.insert(r.id), "规则 id 重复：{}", r.id);
            assert!(!r.title.is_empty() && !r.description.is_empty());
            if r.kind == RuleKind::Exemption {
                assert_eq!(
                    r.default_level,
                    Disposition::Allow,
                    "豁免 {} 必须是 Allow",
                    r.id
                );
            } else {
                assert_ne!(
                    r.default_level,
                    Disposition::Allow,
                    "规则 {} 默认不能是 Allow",
                    r.id
                );
            }
            for l in r.lists {
                assert!(keys.insert(l.key), "名单 key 重复：{}", l.key);
                assert!(!l.defaults.is_empty(), "名单 {} 默认不能为空", l.key);
            }
        }
    }

    #[test]
    fn defaults_apply_when_no_override() {
        let cfg = RuleConfig::default();
        assert_eq!(cfg.level("pipe_to_shell"), Disposition::Deny);
        assert_eq!(
            cfg.level("system_level_commands"),
            Disposition::ForceApproval
        );
        assert!(cfg.enabled("fork_bomb"));
        assert!(cfg.list_has("system_level_commands", "systemctl"));
        assert!(!cfg.list_has("system_level_commands", "ls"));
    }

    #[test]
    fn override_changes_level_and_disables() {
        let mut cfg = RuleConfig::default();
        cfg.overrides.insert(
            "name_based_kill".into(),
            RiskRuleOverride {
                level: Some(Disposition::ForceApproval),
                ..Default::default()
            },
        );
        assert_eq!(
            cfg.verdict("name_based_kill", "x").disposition,
            Disposition::ForceApproval
        );
        cfg.overrides.insert(
            "name_based_kill".into(),
            RiskRuleOverride {
                enabled: Some(false),
                ..Default::default()
            },
        );
        assert_eq!(
            cfg.verdict("name_based_kill", "x").disposition,
            Disposition::Allow
        );
        // 调成「放行」与关闭等效。
        cfg.overrides.insert(
            "name_based_kill".into(),
            RiskRuleOverride {
                level: Some(Disposition::Allow),
                ..Default::default()
            },
        );
        assert_eq!(
            cfg.verdict("name_based_kill", "x").disposition,
            Disposition::Allow
        );
    }

    #[test]
    fn list_override_replaces_defaults_entirely() {
        let mut cfg = RuleConfig::default();
        let mut lists = HashMap::new();
        lists.insert(
            "system_level_commands".to_string(),
            vec!["reboot".to_string()],
        );
        cfg.overrides.insert(
            "system_level_commands".into(),
            RiskRuleOverride {
                lists,
                ..Default::default()
            },
        );
        assert!(cfg.list_has("system_level_commands", "reboot"));
        assert!(!cfg.list_has("system_level_commands", "chmod"));
        // 别的名单不受影响。
        assert!(cfg.list_has("disk_commands", "dd"));
    }

    #[test]
    fn unknown_ids_are_ignored() {
        let mut cfg = RuleConfig::default();
        cfg.overrides.insert(
            "from_a_newer_version".into(),
            RiskRuleOverride {
                enabled: Some(false),
                ..Default::default()
            },
        );
        assert!(!cfg.enabled("from_a_newer_version"));
        assert_eq!(cfg.level("from_a_newer_version"), Disposition::Allow);
        assert!(cfg.verdict("from_a_newer_version", "x").disposition == Disposition::Allow);
    }

    #[test]
    fn lenient_parsing_never_fails_the_whole_config() {
        let json = r#"{
            "overrides": {
                "pipe_to_shell": { "level": "SuperDeny" },
                "fork_bomb": { "level": "ForceApproval", "enabled": false }
            },
            "custom": [ { "id": "c1", "name": "n", "command": "docker", "level": 42 } ]
        }"#;
        let cfg: RuleConfig = serde_json::from_str(json).expect("未知档位不能让配置解析失败");
        assert_eq!(
            cfg.level("pipe_to_shell"),
            Disposition::Deny,
            "读不懂的档位 = 默认"
        );
        assert_eq!(cfg.level("fork_bomb"), Disposition::ForceApproval);
        assert!(!cfg.enabled("fork_bomb"));
        assert_eq!(
            cfg.custom[0].level,
            Disposition::ForceApproval,
            "自定义规则读不懂时宁严勿松"
        );
        assert!(cfg.custom[0].enabled);
    }

    #[test]
    fn empty_json_is_default() {
        let cfg: RuleConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(cfg, RuleConfig::default());
    }

    /// 未知 id（更高版本 / 手改 / 跨设备同步）的 `lists` 必须整条忽略：
    /// 名单回落内置默认表，不能借未知 id 悄悄清空受保护目录。
    #[test]
    fn unknown_override_lists_are_ignored() {
        let mut cfg = RuleConfig::default();
        cfg.overrides.insert(
            "from_a_newer_version".into(),
            RiskRuleOverride {
                lists: HashMap::from([("protected_paths".to_string(), Vec::new())]),
                ..Default::default()
            },
        );
        let defaults_cfg = RuleConfig::default();
        let defaults: Vec<&str> = defaults_cfg.items("protected_paths").collect();
        let effective: Vec<&str> = cfg.items("protected_paths").collect();
        assert_eq!(effective, defaults);
        assert!(cfg.list_has("protected_paths", "/etc"));
    }
}
