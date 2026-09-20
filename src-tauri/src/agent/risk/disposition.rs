use serde::{Deserialize, Serialize};

/// 一次工具调用的处置结果 —— 风险评估的**唯一**输出。
///
/// 变体的声明顺序就是严重程度的顺序：`Allow < Approval < ForceApproval < Deny`。
/// 这个顺序是刻意的：一条命令由多个 shell 段拼成（`a; b | c`），每段各判一次，
/// 取最严的那档，所以引擎里到处是 `cmp::max`。
///
/// 它取代了旧的五档严重度（`ReadOnly` / `LowRisk` / `Moderate` / `HighRisk` /
/// `Destructive`）。旧那套算出来没有任何决策读它，只当了个 UI 标签；四档才是
/// 决策本身。老值靠下面的 `alias` 继续能读进来，三处历史数据都不用迁移：
/// SQLite 里 `tool_calls_json` 的历史记录、已安装插件 manifest 里的 `riskLevel`、
/// 以及早先版本前端收到过的字符串。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum Disposition {
    /// 正常放行。
    #[serde(alias = "ReadOnly", alias = "LowRisk")]
    Allow,
    /// 请求审批。Auto 模式跳过。
    #[serde(alias = "Moderate")]
    Approval,
    /// 强制审批。Auto 模式**也**弹窗 —— 这是它与 `Approval` 的唯一差别。
    #[serde(alias = "HighRisk", alias = "Destructive")]
    ForceApproval,
    /// 直接拒绝。不执行，把原因回给模型。
    Deny,
}

impl Disposition {
    /// 给用户看的中文档位名（系统通知、审批弹窗、设置页的命令测试）。
    pub fn label(&self) -> &'static str {
        match self {
            Self::Allow => "正常放行",
            Self::Approval => "请求审批",
            Self::ForceApproval => "强制审批",
            Self::Deny => "直接拒绝",
        }
    }

    /// 是否连 Auto 模式都拦不住（必须由人确认）。
    pub fn survives_auto(&self) -> bool {
        matches!(self, Self::ForceApproval | Self::Deny)
    }
}

/// 定档结果，外加一句"为什么是这个档位"。
///
/// 理由不是可有可无的装饰：直接拒绝时它是回给模型的唯一线索（模型得知道自己是
/// 哪一步踩线了才改得回来），强制审批时它决定审批弹窗上那句解释。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assessment {
    pub disposition: Disposition,
    /// `Allow` 时为 `None`。
    pub reason: Option<String>,
}

impl Assessment {
    pub fn allow() -> Self {
        Self {
            disposition: Disposition::Allow,
            reason: None,
        }
    }

    pub fn forced(reason: impl Into<String>) -> Self {
        Self {
            disposition: Disposition::ForceApproval,
            reason: Some(reason.into()),
        }
    }

    pub fn denied(reason: impl Into<String>) -> Self {
        Self {
            disposition: Disposition::Deny,
            reason: Some(reason.into()),
        }
    }

    /// 取更严的那一个；同级保留先来的（先命中的理由更贴近原因）。
    pub fn worst(self, other: Self) -> Self {
        if other.disposition > self.disposition {
            other
        } else {
            self
        }
    }
}
