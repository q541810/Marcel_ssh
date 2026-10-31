//! 同步对前端暴露的数据类型（契约见 `src/lib/types.ts` 的 `Sync*`）。字段名一律 camelCase。

use serde::{Deserialize, Serialize};

use super::storage::StorageConfig;
use super::store::TierSwitches;
use super::streams::StreamProgress;

/// 同步状态机的对外形态。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SyncState {
    Off,
    Idle,
    Syncing,
    Error,
    /// 云端有本机版本读不懂的新格式数据；本机暂停推进该设备的数据，升级后自动恢复。
    NeedsUpgrade,
    /// 本机一次删除了很多条目，等用户确认要不要同步给其它设备。
    NeedsConfirm,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeldSummary {
    pub source: String,
    pub count: usize,
}

/// 一条流的状态（`sync_status` 的 `streams`）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamStatus {
    /// `"config"` / `"conv"` / `"sec"`。
    pub key: String,
    /// 它属于哪一档：`"config"` / `"conversation"` / `"secret"`。
    pub tier: String,
    /// 待上传的段数（配置流按 op 数）。
    pub pending: usize,
    /// 这一轮这条流失败的原因（成功时清空）。
    pub last_error: Option<String>,
    /// 首次开启时的进度（「正在同步对话 N / M」）。
    pub progress: Option<StreamProgress>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub state: SyncState,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
    pub pending_count: usize,
    pub device_id: Option<String>,
    pub device_name: Option<String>,
    pub storage: Option<StorageConfig>,
    pub held: Option<Vec<HeldSummary>>,
    /// 本机三档开关。老前端不认识这个字段也不影响（`#[serde(default)]`）。
    #[serde(default)]
    pub tiers: TierSwitches,
    #[serde(default)]
    pub streams: Vec<StreamStatus>,
}

impl SyncStatus {
    /// 没开同步时的状态。
    pub fn off() -> Self {
        SyncStatus {
            enabled: false,
            state: SyncState::Off,
            last_sync_at: None,
            last_error: None,
            pending_count: 0,
            device_id: None,
            device_name: None,
            storage: None,
            held: None,
            tiers: TierSwitches::default(),
            streams: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDevice {
    pub id: String,
    pub name: String,
    /// `"desktop"` / `"android"`。
    pub platform: String,
    pub app_version: String,
    pub last_seen_at: String,
    pub is_self: bool,
    /// 对方开了哪几档（从它的文件头读；文件头没有 = 只有配置档）。
    #[serde(default)]
    pub tiers: TierSwitches,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HistoryKind {
    Change,
    Warning,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncHistoryEntry {
    pub id: String,
    pub at: String,
    pub device_name: String,
    pub source: String,
    /// 叶子路径（`connections/[id]/host` 这样的显示串；id 段用方括号）。
    pub path: String,
    /// 值是对象 / 长文本时只给摘要。
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub kind: HistoryKind,
    pub undone: bool,
    /// 后端生成的人话说明，例如「连接『生产服务器』的主机地址」。警告条的正文也放这里。
    pub label: String,
}

/// `sync_create` 的返回。两样都是机密，只在创建向导里展示一次。
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncCreateResult {
    pub recovery_key: String,
    pub sync_code: String,
}

impl std::fmt::Debug for SyncCreateResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SyncCreateResult(<redacted>)")
    }
}

impl Drop for SyncCreateResult {
    fn drop(&mut self) {
        use zeroize::Zeroize;
        self.recovery_key.zeroize();
        self.sync_code.zeroize();
    }
}

/// `sync-data-applied` 事件载荷。
///
/// `source` 一期取值 `settings` / `connections` / `quickCommands` / `skills` / `mcpServers` /
/// `knownHosts`，二期新增 `conversations` / `memory`，三期新增 `secrets`。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncDataApplied {
    pub source: String,
    /// 对话流落地后变化了的会话 id（其它 source 为空）。前端据此刷新「当前打开的对话」。
    #[serde(default)]
    pub conversation_ids: Vec<String>,
}

/// 某一档的规模估算（`sync_tier_estimate`）。**只有数量与名称，绝无值。**
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TierEstimate {
    pub tier: String,
    /// 对话与记忆：会话数、图片数、大致字节数。
    pub conversations: usize,
    pub images: usize,
    pub total_bytes: u64,
    /// 机密：按类别汇总。
    pub secret_groups: Vec<SecretGroupEstimate>,
}

/// 一类机密的规模（例如「模型渠道」「服务器密码」）。只给名称与数量。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretGroupEstimate {
    pub label: String,
    pub count: usize,
    pub names: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn status_matches_the_frontend_contract() {
        let status = SyncStatus {
            enabled: true,
            state: SyncState::NeedsConfirm,
            last_sync_at: Some("2026-10-30T00:00:00Z".into()),
            last_error: None,
            pending_count: 2,
            device_id: Some("abc".into()),
            device_name: Some("我的电脑".into()),
            storage: Some(StorageConfig::Sftp {
                connection_id: "c1".into(),
                root: "marcel-sync".into(),
            }),
            held: Some(vec![HeldSummary {
                source: "connections".into(),
                count: 6,
            }]),
            tiers: TierSwitches::default(),
            streams: Vec::new(),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "enabled": true,
                "state": "needsConfirm",
                "lastSyncAt": "2026-10-30T00:00:00Z",
                "lastError": null,
                "pendingCount": 2,
                "deviceId": "abc",
                "deviceName": "我的电脑",
                "storage": {"kind": "sftp", "connectionId": "c1", "root": "marcel-sync"},
                "held": [{"source": "connections", "count": 6}],
                "tiers": {"config": true, "conversation": false, "secret": false},
                "streams": [],
            })
        );
        for (state, text) in [
            (SyncState::Off, "off"),
            (SyncState::Idle, "idle"),
            (SyncState::Syncing, "syncing"),
            (SyncState::Error, "error"),
            (SyncState::NeedsUpgrade, "needsUpgrade"),
        ] {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(text));
        }
    }

    #[test]
    fn history_entry_and_device_match_the_frontend_contract() {
        let entry = SyncHistoryEntry {
            id: "h1".into(),
            at: "t".into(),
            device_name: "手机".into(),
            source: "settings".into(),
            path: "fontSize".into(),
            old_value: Some("14".into()),
            new_value: None,
            kind: HistoryKind::Warning,
            undone: false,
            label: "设置 · 终端字号".into(),
        };
        let v = serde_json::to_value(&entry).unwrap();
        assert_eq!(v["kind"], json!("warning"));
        assert_eq!(v["deviceName"], json!("手机"));
        assert_eq!(v["oldValue"], json!("14"));
        assert_eq!(v["newValue"], json!(null));
        assert_eq!(v["label"], json!("设置 · 终端字号"));

        let dev = SyncDevice {
            id: "d".into(),
            name: "n".into(),
            platform: "android".into(),
            app_version: "1.12.0".into(),
            last_seen_at: "t".into(),
            is_self: true,
            tiers: TierSwitches::default(),
        };
        let v = serde_json::to_value(&dev).unwrap();
        assert_eq!(v["isSelf"], json!(true));
        assert_eq!(v["appVersion"], json!("1.12.0"));
        assert_eq!(v["lastSeenAt"], json!("t"));
    }

    #[test]
    fn create_result_debug_never_prints_the_secrets() {
        let r = SyncCreateResult {
            recovery_key: "abcd-secret".into(),
            sync_code: "MSYNC1-secret".into(),
        };
        let dbg = format!("{r:?}");
        assert!(!dbg.contains("secret"));
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["recoveryKey"], json!("abcd-secret"));
        assert_eq!(v["syncCode"], json!("MSYNC1-secret"));
    }
}
