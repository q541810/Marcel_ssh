//! 同步引擎的本机账本：`<配置目录>/sync/` 下的所有文件（登记表里的 `DataSourceId::SyncState`）。
//!
//! ```text
//! sync/state.json                 设备身份、开关、存储配置、游标、登记表、各源的落地标记……
//! sync/mirror/<source>.json       每个同步源的镜像（所有设备操作的并集）
//! sync/baseline/<source>.json     每个同步源的基线（本机代码上次自己序列化的结果）
//! sync/outbox.json                已捕获、还没上传的 op（重启不丢）
//! sync/held.json                  等待用户确认的大量删除（只含 Tombstone）
//! sync/history.json               同步记录（最近 500 条）
//! ```
//!
//! 全部经 `atomic_write`（tmp + fsync + rename）。**只改变了的才写**：引擎用脏标记驱动，
//! 空闲轮次一个字节都不写。同步源名来自远端文件（不可信输入），拼进文件名前必须过
//! [`valid_source_key`]。

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path as FsPath, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::core::{Hlc, IdMapRegistry, Mirror, Op};
use super::storage::StorageConfig;
use crate::config::persist::atomic_write;
use crate::data::{DataSourceId, SyncTier};
use crate::error::AppError;

/// 三档开关（每台设备自己的）。定义在 `core/format`（远端文件头要写它），这里再导出一次，
/// 让 `sync::store::TierSwitches` 这个契约里的名字照样可用。
pub use super::core::format::TierSwitches;

/// 本机账本格式版本（`state.json` 的 `format`）。
pub const STATE_FORMAT: u32 = 1;

/// 同步的流：配置（一期）、对话与记忆（二期）、机密（三期）。
///
/// 放在 `store` 而不是 `streams`，是因为**账本按流存状态**（`StreamState` / 游标），
/// `store` 必须认识它；`streams`（驱动）反过来依赖 `store`，方向才是干净的。
/// `sync::streams` 会把它再导出一次，契约里写的 `sync::streams::StreamName` 依然可用。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StreamName {
    Config,
    Conv,
    Sec,
}

impl StreamName {
    /// 全部流（固定顺序：配置 → 对话 → 机密）。
    pub const ALL: &'static [StreamName] = &[StreamName::Config, StreamName::Conv, StreamName::Sec];

    /// 写进 `state.json` / 状态事件的短名，**跨版本稳定**。
    pub fn as_str(self) -> &'static str {
        match self {
            StreamName::Config => "config",
            StreamName::Conv => "conv",
            StreamName::Sec => "sec",
        }
    }

    /// 它属于哪个「档」（档是用户开关的单位）。
    pub fn tier(self) -> SyncTier {
        match self {
            StreamName::Config => SyncTier::Config,
            StreamName::Conv => SyncTier::Conversation,
            StreamName::Sec => SyncTier::Secret,
        }
    }

    /// 远端目录名的那一层（配置流没有子目录）。
    pub fn dir_suffix(self) -> Option<&'static str> {
        match self {
            StreamName::Config => None,
            StreamName::Conv => Some("conv"),
            StreamName::Sec => Some("sec"),
        }
    }

    /// `devices/<device>` 或 `devices/<device>/conv` / `…/sec`。
    pub fn remote_dir(self, device: &str) -> String {
        match self.dir_suffix() {
            Some(suffix) => format!("{}/{}", super::core::format::device_dir(device), suffix),
            None => super::core::format::device_dir(device),
        }
    }
}

/// 一条流自己的进度。配置流沿用 [`PersistedState`] 顶层的 `seq` / `cursors` /
/// `segs_since_snapshot`（一期不动）；conv / sec 存在 `streams` 里。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StreamState {
    pub seq: u64,
    pub cursors: BTreeMap<String, Cursor>,
    pub segs_since_snapshot: u32,
    /// 这条流的镜像是否已经落地过（首次开启该档时为 false，落地一次后置 true）。
    pub applied: bool,
}

/// 同步源 key 能不能安全拼进文件名：1–64 个 `[A-Za-z0-9_-]`。
pub fn valid_source_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 对某台其它设备「读到哪了」。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cursor {
    /// 已吸收的最新快照序号。
    #[serde(default)]
    pub snap: u64,
    /// 已吸收到的最大序号（快照与增量段共用一套编号，吸收了快照就至少到它的序号）。
    #[serde(default)]
    pub seg: u64,
}

/// 对一台设备的认知（从它写的文件头里来）。
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceRecord {
    pub name: String,
    pub platform: String,
    pub app_version: String,
    /// 该设备最近一次被我们读到的改动的时间（RFC3339）。
    pub last_seen_at: Option<String>,
    /// 对方文件头里写的「开了哪几档」。老版本的文件没有这个字段 = 只有配置档。
    pub tiers: TierSwitches,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PersistedState {
    pub format: u32,
    pub device_id: String,
    pub device_name: String,
    pub enabled: bool,
    pub storage: Option<StorageConfig>,
    /// 本机已用掉的最大序号（增量段与快照共用）。
    pub seq: u64,
    /// 时钟的最后状态（重启后恢复，免得墙钟被回拨的设备发出比旧 op 还小的时间戳）。
    pub hlc: Option<Hlc>,
    pub cursors: BTreeMap<String, Cursor>,
    pub last_app_version: String,
    /// 已把旧版仅本机的私钥引用补入配置流；正文仍只走机密流。
    pub key_references_shared: bool,
    /// 同步源 key → id 映射登记表。
    pub idmaps: BTreeMap<String, IdMapRegistry>,
    /// 同步源 key → 镜像是否已落地到本机文档。缺项 = 看镜像是否非空。
    pub applied_mirror: BTreeMap<String, bool>,
    /// 同步源 key → 本机配置损坏过、要从镜像整份恢复（期间不捕获）。
    pub needs_restore: BTreeMap<String, bool>,
    pub devices: BTreeMap<String, DeviceRecord>,
    pub last_sync_at: Option<String>,
    /// 自上次快照以来本机上传了多少个增量段（到 50 就压缩）。
    pub segs_since_snapshot: u32,
    /// 我们为同步目录加进「受保护路径」的绝对路径（SFTP 存储）。
    pub protected_path: Option<String>,
    /// 三档开关。配置档恒为开（一期行为），读的时候忽略 `config: false`。
    pub tiers: TierSwitches,
    /// conv / sec 两条流自己的进度。配置流不在这里（见 `StreamState` 的文档）。
    pub streams: BTreeMap<String, StreamState>,
    /// 一期加入同步时连接去重的「旧 id → 云端 id」，二期三期上传前 / 落地后都要过一遍。
    pub connection_aliases: BTreeMap<String, String>,
}

impl Default for PersistedState {
    fn default() -> Self {
        Self {
            format: STATE_FORMAT,
            device_id: String::new(),
            device_name: String::new(),
            enabled: false,
            storage: None,
            seq: 0,
            hlc: None,
            cursors: BTreeMap::new(),
            last_app_version: String::new(),
            key_references_shared: false,
            idmaps: BTreeMap::new(),
            applied_mirror: BTreeMap::new(),
            needs_restore: BTreeMap::new(),
            devices: BTreeMap::new(),
            last_sync_at: None,
            segs_since_snapshot: 0,
            protected_path: None,
            tiers: TierSwitches::default(),
            streams: BTreeMap::new(),
            connection_aliases: BTreeMap::new(),
        }
    }
}

impl PersistedState {
    /// 取一条流的进度。配置流是顶层字段的**等值视图**（一期账本照旧存在顶层）。
    pub fn stream(&self, name: StreamName) -> StreamState {
        match name {
            StreamName::Config => StreamState {
                seq: self.seq,
                cursors: self.cursors.clone(),
                segs_since_snapshot: self.segs_since_snapshot,
                applied: true,
            },
            StreamName::Conv | StreamName::Sec => {
                self.streams.get(name.as_str()).cloned().unwrap_or_default()
            }
        }
    }

    /// 写回一条流的进度。配置流写回顶层字段。
    pub fn set_stream(&mut self, name: StreamName, s: StreamState) {
        match name {
            StreamName::Config => {
                self.seq = s.seq;
                self.cursors = s.cursors;
                self.segs_since_snapshot = s.segs_since_snapshot;
            }
            StreamName::Conv | StreamName::Sec => {
                self.streams.insert(name.as_str().to_string(), s);
            }
        }
    }

    /// 这一档开着没有。**配置档恒为开**（一期行为）：老账本里没有 `tiers` 字段时也一样。
    pub fn tier_enabled(&self, tier: SyncTier) -> bool {
        match tier {
            SyncTier::Config => true,
            SyncTier::Conversation => self.tiers.conversation,
            SyncTier::Secret => self.tiers.secret,
            // Local 档不是「同步档」，永远不同步
            SyncTier::Local => false,
        }
    }

    /// 某条流开着没有（= 它所属的档开着）。
    pub fn stream_enabled(&self, name: StreamName) -> bool {
        self.tier_enabled(name.tier())
    }

    /// 连接 id 别名换算：一期加入同步时被去重掉的本机 id → 云端那条的 id。
    ///
    /// 别名可能链式（A→B、B→C）：跟到底，最多 [`ALIAS_MAX_HOPS`] 跳（防环）。
    /// 不在表里 = 它自己。
    pub fn resolve_connection_id(&self, id: &str) -> String {
        resolve_alias(&self.connection_aliases, id)
    }

    /// 记忆的 `scope_key` 换算（契约第 4 节）。只有主机作用域的 key 是连接 id；
    /// 全局作用域是空串、分组作用域是分组名——它们不在别名表里，所以原样返回。
    /// 万一某个分组名恰好等于一个旧连接 id（几乎不可能），会按别名换算：这是刻意接受的
    /// 保守偏置——宁可把一条记忆挂到改名后的同一台机器上，也不要留下指向已删连接的悬空 key。
    pub fn resolve_scope_key(&self, key: &str) -> String {
        self.resolve_connection_id(key)
    }
}

/// 别名最多跟多少跳（防 A→B→A 这类环把调用方卡死）。
pub const ALIAS_MAX_HOPS: usize = 8;

fn resolve_alias(aliases: &BTreeMap<String, String>, id: &str) -> String {
    let mut cur = id.to_string();
    for _ in 0..ALIAS_MAX_HOPS {
        match aliases.get(&cur) {
            Some(next) if next != &cur => cur = next.clone(),
            _ => break,
        }
    }
    cur
}

/// 磁盘上整套账本读出来的样子。
#[derive(Default)]
pub struct LoadedLedger {
    pub state: PersistedState,
    pub mirrors: BTreeMap<String, Mirror>,
    pub baselines: BTreeMap<String, Value>,
    pub outbox: Vec<Op>,
    pub held: Vec<Op>,
}

/// 账本目录的读写口。
#[derive(Clone, Debug)]
pub struct LedgerFiles {
    dir: PathBuf,
}

impl LedgerFiles {
    /// `config_dir` 是应用配置目录；账本目录取自登记表。
    pub fn new(config_dir: &FsPath) -> Self {
        Self {
            dir: DataSourceId::SyncState.path(config_dir),
        }
    }

    pub fn dir(&self) -> &FsPath {
        &self.dir
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    fn mirror_file(&self, source: &str) -> PathBuf {
        self.dir.join("mirror").join(format!("{source}.json"))
    }

    fn baseline_file(&self, source: &str) -> PathBuf {
        self.dir.join("baseline").join(format!("{source}.json"))
    }

    pub fn history_file(&self) -> PathBuf {
        self.file("history.json")
    }

    fn write_json<T: Serialize>(&self, path: PathBuf, value: &T) -> Result<(), AppError> {
        let text = serde_json::to_string(value)
            .map_err(|e| AppError::Config(format!("序列化同步状态失败: {e}")))?;
        atomic_write(&path, &text).map_err(|e| AppError::Config(format!("写入同步状态失败: {e}")))
    }

    fn read_json<T: serde::de::DeserializeOwned>(&self, path: &FsPath) -> Option<T> {
        let text = std::fs::read_to_string(path).ok()?;
        if text.trim().is_empty() {
            return None;
        }
        match serde_json::from_str(&text) {
            Ok(v) => Some(v),
            Err(e) => {
                // 账本损坏不应让应用起不来：按「没有」处理。镜像 / 基线丢了会在下一轮从云端重新学回来，
                // 最坏是本机还没上传的改动丢失（outbox），所以这里留一条显眼的日志。
                log::error!("同步状态文件 {} 无法解析，按空处理: {e}", path.display());
                None
            }
        }
    }

    // ── 写 ──

    pub fn save_state(&self, state: &PersistedState) -> Result<(), AppError> {
        self.write_json(self.file("state.json"), state)
    }

    pub fn save_mirror(&self, source: &str, mirror: &Mirror) -> Result<(), AppError> {
        debug_assert!(valid_source_key(source));
        self.write_json(self.mirror_file(source), mirror)
    }

    pub fn save_baseline(&self, source: &str, baseline: &Value) -> Result<(), AppError> {
        debug_assert!(valid_source_key(source));
        self.write_json(self.baseline_file(source), baseline)
    }

    pub fn save_outbox(&self, ops: &[Op]) -> Result<(), AppError> {
        self.write_json(self.file("outbox.json"), &ops)
    }

    pub fn save_held(&self, ops: &[Op]) -> Result<(), AppError> {
        self.write_json(self.file("held.json"), &ops)
    }

    // ── 读 ──

    /// 读整套账本。没有 `state.json` = 从没开过同步（返回默认的空账本）。
    pub fn load(&self) -> LoadedLedger {
        let Some(state) = self.read_json::<PersistedState>(&self.file("state.json")) else {
            return LoadedLedger::default();
        };
        let mut ledger = LoadedLedger {
            state,
            ..Default::default()
        };
        ledger.outbox = self
            .read_json(&self.file("outbox.json"))
            .unwrap_or_default();
        ledger.held = self.read_json(&self.file("held.json")).unwrap_or_default();
        for (dir, is_mirror) in [("mirror", true), ("baseline", false)] {
            let Ok(entries) = std::fs::read_dir(self.dir.join(dir)) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                let Some(name) = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.strip_suffix(".json"))
                else {
                    continue;
                };
                if !valid_source_key(name) {
                    continue;
                }
                let name = name.to_string();
                if is_mirror {
                    if let Some(m) = self.read_json::<Mirror>(&path) {
                        ledger.mirrors.insert(name, m);
                    }
                } else if let Some(b) = self.read_json::<Value>(&path) {
                    ledger.baselines.insert(name, b);
                }
            }
        }
        ledger
    }

    /// 删掉整个账本目录（停止同步）。目录不存在也算成功。
    pub fn wipe(&self) -> Result<(), AppError> {
        match std::fs::remove_dir_all(&self.dir) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(AppError::Config(format!("清除同步状态失败: {e}"))),
        }
    }
}

/// 哪些东西自上次落盘以来变过。
#[derive(Default)]
pub struct Dirty {
    pub state: bool,
    pub outbox: bool,
    pub held: bool,
    pub mirrors: BTreeSet<String>,
    pub baselines: BTreeSet<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::SyncTier;
    use crate::sync::core::{Op, OpKind, Seg};
    use serde_json::json;

    fn op(source: &str, ms: u64) -> Op {
        Op {
            source: source.into(),
            path: vec![Seg::key("a")],
            kind: OpKind::Set(json!(ms)),
            hlc: Hlc {
                ms,
                counter: 0,
                device: "d".into(),
            },
        }
    }

    #[test]
    fn source_keys_are_validated_before_they_become_file_names() {
        for ok in ["settings", "quickCommands", "mcp-servers", "a_b", "X9"] {
            assert!(valid_source_key(ok), "{ok}");
        }
        for bad in [
            "",
            "../x",
            "a/b",
            "a\\b",
            "a.b",
            "x y",
            &"a".repeat(65),
            "设置",
        ] {
            assert!(!valid_source_key(bad), "{bad:?}");
        }
    }

    #[test]
    fn ledger_round_trips_through_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let files = LedgerFiles::new(tmp.path());
        assert!(!files.load().state.enabled, "什么都没写过：空账本");

        let mut state = PersistedState {
            enabled: true,
            device_id: "dev1".into(),
            seq: 7,
            ..Default::default()
        };
        state
            .cursors
            .insert("dev2".into(), Cursor { snap: 3, seg: 9 });
        files.save_state(&state).unwrap();

        let mut mirror = Mirror::new();
        mirror.merge(&op("settings", 5));
        files.save_mirror("settings", &mirror).unwrap();
        files
            .save_baseline("settings", &json!({"fontSize": 14}))
            .unwrap();
        files.save_outbox(&[op("settings", 6)]).unwrap();
        files.save_held(&[op("connections", 8)]).unwrap();

        let back = files.load();
        assert_eq!(back.state, state);
        assert_eq!(back.mirrors["settings"], mirror);
        assert_eq!(back.baselines["settings"], json!({"fontSize": 14}));
        assert_eq!(back.outbox, vec![op("settings", 6)]);
        assert_eq!(back.held, vec![op("connections", 8)]);

        files.wipe().unwrap();
        assert!(!files.dir().exists());
        files.wipe().unwrap(); // 幂等
    }

    #[test]
    fn corrupt_ledger_files_degrade_to_empty_instead_of_failing() {
        let tmp = tempfile::tempdir().unwrap();
        let files = LedgerFiles::new(tmp.path());
        files
            .save_state(&PersistedState {
                enabled: true,
                ..Default::default()
            })
            .unwrap();
        std::fs::create_dir_all(files.dir().join("mirror")).unwrap();
        std::fs::write(files.dir().join("mirror").join("settings.json"), "{ broken").unwrap();
        std::fs::write(files.dir().join("outbox.json"), "not json").unwrap();
        // 文件名不合法的镜像文件直接忽略
        std::fs::write(files.dir().join("mirror").join("a.b.json"), "{}").unwrap();

        let back = files.load();
        assert!(back.state.enabled);
        assert!(back.mirrors.is_empty());
        assert!(back.outbox.is_empty());
    }

    #[test]
    fn state_json_uses_camel_case_and_tolerates_missing_fields() {
        let s: PersistedState =
            serde_json::from_str(r#"{"deviceId":"x","enabled":true,"futureField":1}"#).unwrap();
        assert_eq!(s.device_id, "x");
        assert!(s.enabled);
        assert_eq!(s.format, STATE_FORMAT);
        let v = serde_json::to_value(&s).unwrap();
        assert!(v.get("deviceId").is_some() && v.get("appliedMirror").is_some());
    }

    /// 老 state.json（一期写的，没有 tiers / streams / connectionAliases）能读；
    /// 读出来再写回，一期字段逐字保留，新字段以默认值出现。
    #[test]
    fn phase_one_state_json_reads_and_writes_back_without_losing_fields() {
        let tmp = tempfile::tempdir().unwrap();
        let files = LedgerFiles::new(tmp.path());
        let old = r#"{
            "format":1,
            "deviceId":"dev-a",
            "deviceName":"旧电脑",
            "enabled":true,
            "storage":{"kind":"webDav","url":"https://dav.example.com/dav/","username":"u","root":"marcel-sync"},
            "seq":17,
            "hlc":{"ms":1760000000000,"counter":3,"device":"dev-a"},
            "cursors":{"dev-b":{"snap":5,"seg":9}},
            "lastAppVersion":"1.12.0",
            "idmaps":{"connections":[]},
            "appliedMirror":{"settings":true},
            "needsRestore":{},
            "devices":{"dev-b":{"name":"手机","platform":"android","appVersion":"1.12.0","lastSeenAt":"2026-10-01T00:00:00Z"}},
            "lastSyncAt":"2026-10-01T00:00:00Z",
            "segsSinceSnapshot":4,
            "protectedPath":null
        }"#;
        std::fs::create_dir_all(files.dir()).unwrap();
        std::fs::write(files.dir().join("state.json"), old).unwrap();

        let back = files.load();
        let st = &back.state;
        assert_eq!(st.device_id, "dev-a");
        assert_eq!(st.seq, 17);
        assert_eq!(st.cursors["dev-b"], Cursor { snap: 5, seg: 9 });
        assert_eq!(st.last_sync_at.as_deref(), Some("2026-10-01T00:00:00Z"));
        assert_eq!(st.segs_since_snapshot, 4);
        assert_eq!(
            st.devices["dev-b"].tiers,
            TierSwitches::default(),
            "老文件头 = 只有配置档"
        );
        // 新字段以默认值出现
        assert_eq!(st.tiers, TierSwitches::default());
        assert!(st.tiers.config);
        assert!(st.streams.is_empty());
        assert!(st.connection_aliases.is_empty());
        assert!(st.tier_enabled(SyncTier::Config));
        assert!(!st.tier_enabled(SyncTier::Conversation));
        assert!(!st.tier_enabled(SyncTier::Secret));
        // 就算老账本里写着 config: false，也按「配置档恒为开」处理
        let mut forced = st.clone();
        forced.tiers.config = false;
        assert!(forced.tier_enabled(SyncTier::Config));

        // 写回：一期字段一个不少（逐项比对值），新字段也在
        files.save_state(st).unwrap();
        let round: Value =
            serde_json::from_str(&std::fs::read_to_string(files.dir().join("state.json")).unwrap())
                .unwrap();
        for key in [
            "format",
            "deviceId",
            "deviceName",
            "enabled",
            "storage",
            "seq",
            "hlc",
            "cursors",
            "lastAppVersion",
            "idmaps",
            "appliedMirror",
            "needsRestore",
            "devices",
            "lastSyncAt",
            "segsSinceSnapshot",
            "protectedPath",
        ] {
            assert!(round.get(key).is_some(), "写回后丢了 {key}");
        }
        assert_eq!(round["seq"], json!(17));
        assert_eq!(round["cursors"]["dev-b"]["snap"], json!(5));
        assert_eq!(
            round["tiers"],
            json!({"config": true, "conversation": false, "secret": false})
        );
        assert_eq!(round["streams"], json!({}));
        assert_eq!(round["connectionAliases"], json!({}));
    }

    #[test]
    fn stream_view_equals_the_top_level_fields_for_config() {
        let mut st = PersistedState {
            seq: 9,
            segs_since_snapshot: 3,
            ..Default::default()
        };
        st.cursors.insert("d".into(), Cursor { snap: 1, seg: 2 });
        let view = st.stream(StreamName::Config);
        assert_eq!(view.seq, 9);
        assert_eq!(view.segs_since_snapshot, 3);
        assert_eq!(view.cursors["d"], Cursor { snap: 1, seg: 2 });
        assert!(view.applied);

        // 写回顶层
        let mut st2 = PersistedState::default();
        st2.set_stream(StreamName::Config, view);
        assert_eq!(st2.seq, 9);
        assert_eq!(st2.segs_since_snapshot, 3);

        // conv / sec 存在 streams 里
        let mut st3 = PersistedState::default();
        st3.set_stream(
            StreamName::Conv,
            StreamState {
                seq: 4,
                segs_since_snapshot: 2,
                applied: true,
                ..Default::default()
            },
        );
        assert_eq!(st3.streams["conv"].seq, 4);
        assert_eq!(st3.stream(StreamName::Conv).seq, 4);
        assert_eq!(st3.stream(StreamName::Sec), StreamState::default());
        assert_eq!(st3.seq, 0, "配置流的顶层字段不受影响");
        // 序列化键名
        let v = serde_json::to_value(&st3).unwrap();
        assert_eq!(v["streams"]["conv"]["segsSinceSnapshot"], json!(2));
        assert_eq!(v["streams"]["conv"]["applied"], json!(true));
    }

    #[test]
    fn connection_aliases_resolve_chains_without_looping() {
        let mut st = PersistedState::default();
        assert_eq!(st.resolve_connection_id("a"), "a", "不在表里 = 它自己");
        st.connection_aliases.insert("a".into(), "b".into());
        st.connection_aliases.insert("b".into(), "c".into());
        assert_eq!(st.resolve_connection_id("a"), "c", "链式跟到底");
        assert_eq!(st.resolve_connection_id("b"), "c");
        assert_eq!(st.resolve_connection_id("c"), "c");
        // 自环与两节点环都不能卡死（最多 8 跳）
        st.connection_aliases.insert("x".into(), "x".into());
        assert_eq!(st.resolve_connection_id("x"), "x");
        st.connection_aliases.insert("p".into(), "q".into());
        st.connection_aliases.insert("q".into(), "p".into());
        let got = st.resolve_connection_id("p");
        assert!(got == "p" || got == "q", "环里停下即可，不能死循环: {got}");

        // 超过 8 跳的长链只跟 8 跳（防环的代价，正常数据不会有这么长的链）
        for i in 0..12 {
            st.connection_aliases
                .insert(format!("n{i}"), format!("n{}", i + 1));
        }
        assert_eq!(st.resolve_connection_id("n0"), "n8");

        // 记忆 scope_key：命中别名就换算，不命中就是它自己
        assert_eq!(st.resolve_scope_key("a"), "c");
        assert_eq!(st.resolve_scope_key("group-prod"), "group-prod");
        assert_eq!(st.resolve_scope_key(""), "");
    }
}
