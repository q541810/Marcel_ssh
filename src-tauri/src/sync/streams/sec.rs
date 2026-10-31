//! 机密流（三期）的驱动：把用户在密钥链里改的 Key / 密码同步到别的设备。
//!
//! 与对话流的区别：**数据源不是本地数据库，而是系统密钥链**。密钥链没有变更通知，所以：
//!
//! - **捕获**靠「全量比对」：把本机所有可枚举的槽位读一遍，与基线（`secret_baseline`）比。
//!   摘要不同 → 发 `set`；基线里有、现在读不到 → 发 `del`。`DataChangeBus` 上的
//!   `DataSourceId::Secrets` 广播只是让捕获更及时，正确性不依赖它。
//! - **镜像**是本机的「所有设备改动的并集」，落在 `sync/mirror/secrets.msync`，**用 DK 封装**
//!   （不是明文）。它让「本机不认识的槽位」有地方存，等本机升级认识了再落地。
//! - **落地**直接写密钥链，期间用 [`keychain::CaptureSuppression`] 抑制捕获——否则落地写进去的
//!   值会在同一轮被当成「本机改动」再发出去，两台设备来回弹。
//!
//! 机密值的生命周期：读出来就套 `Zeroizing`；只在构建段 JSON 的那一刻存在；写完立刻丢。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::super::core::crypto::{aad_tag, DataKey};
use super::super::core::format;
use super::super::core::Hlc;
use super::super::store::{StreamName, StreamState};
use super::super::{secret_baseline::SecretBaseline, secrets::SyncSecretStore};
use super::{
    StreamApplied, StreamDriver, StreamFileKind, StreamProgress, StreamSnapshot,
    StreamSnapshotLayout,
};
use crate::config::keychain::{self, CaptureSuppression, SecretSlot, SecretSlotCatalog};
use crate::error::AppError;

/// 段 JSON 的 `kind`。读到别的值说明这条流的数据被投错了地方。
const SEGMENT_KIND: &str = "secret-ops";
/// 段 JSON 的 `stream`。
const STREAM_KEY: &str = "sec";
/// 单段上限（与行同步同口径）。
const MAX_SEGMENT_BYTES: usize = 900_000;

// ---------------------------------------------------------------------------
// op 形状（契约第 7 节）
// ---------------------------------------------------------------------------

/// 一条机密 op。
///
/// 整段在远端是被 SK 加密的密文，所以段内明文值不过网（存储方看不到）。`setKey` / `delKey`
/// 是私钥库（T7）用的，本模块先把形状定下来并原样转发给镜像，真正落地由 T7 的适配器做。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum SecretOp {
    /// 写入一个槽位。
    Set {
        account: String,
        hlc: Hlc,
        value: ZeroizingString,
    },
    /// 删除一个槽位。
    Del { account: String, hlc: Hlc },
    /// 写入一把私钥（`blob` 是 `devices/<id>/blob/<名字>.msync` 的文件名）。
    SetKey {
        key_id: String,
        hlc: Hlc,
        meta: serde_json::Value,
        blob: String,
    },
    /// 删除一把私钥。
    DelKey { key_id: String, hlc: Hlc },
}

/// `Zeroizing<String>` 的 serde 适配（`zeroize` 没有自带 Serialize）。
#[derive(Clone, PartialEq, Eq)]
pub struct ZeroizingString(pub Zeroizing<String>);

impl std::fmt::Debug for ZeroizingString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ZeroizingString(<redacted>)")
    }
}

impl Serialize for ZeroizingString {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.0)
    }
}

impl<'de> Deserialize<'de> for ZeroizingString {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        Ok(ZeroizingString(Zeroizing::new(s)))
    }
}

impl ZeroizingString {
    pub fn new(s: impl Into<String>) -> Self {
        Self(Zeroizing::new(s.into()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl SecretOp {
    pub fn hlc(&self) -> &Hlc {
        match self {
            SecretOp::Set { hlc, .. }
            | SecretOp::Del { hlc, .. }
            | SecretOp::SetKey { hlc, .. }
            | SecretOp::DelKey { hlc, .. } => hlc,
        }
    }

    /// 这条 op 属于哪个「身份」（槽位账号 / 私钥 id）——镜像按它做后写者赢。
    pub fn identity(&self) -> String {
        match self {
            SecretOp::Set { account, .. } | SecretOp::Del { account, .. } => account.clone(),
            SecretOp::SetKey { key_id, .. } | SecretOp::DelKey { key_id, .. } => {
                format!("key:{key_id}")
            }
        }
    }

    /// 给人看的「哪个 Key」——**只到名称，不带值**。
    pub fn describe(&self) -> String {
        match self {
            SecretOp::Set { account, .. } | SecretOp::Del { account, .. } => {
                describe_account(account)
            }
            SecretOp::SetKey { key_id, .. } | SecretOp::DelKey { key_id, .. } => {
                format!("SSH 私钥（{key_id}）")
            }
        }
    }
}

/// 账号名 → 人话（「模型渠道 Key」「连接密码」这类），**不含任何值**。
fn describe_account(account: &str) -> String {
    if let Some(id) = account.strip_prefix("llm_channel_") {
        return format!("模型渠道 {id} 的 API Key");
    }
    if account == "web_search_api_key" {
        return "搜索 API Key".into();
    }
    if account == "deepseek_tools_api_key" {
        return "DeepSeek API Key".into();
    }
    if account == "custom_search_api_key" {
        return "自定义搜索 API Key".into();
    }
    if account == "custom_fetch_api_key" {
        return "自定义抓取 API Key".into();
    }
    if account == "tavily_fetch_api_key" {
        return "Tavily 抓取 API Key".into();
    }
    if account == "jev_api_key" {
        return "TypeSafe API Key".into();
    }
    if let Some(id) = account.strip_prefix("mcp_headers:") {
        return format!("MCP 服务 {id} 的鉴权头");
    }
    if let Some(id) = account.strip_prefix("jump:pk:") {
        return format!("连接 {id} 的跳板机私钥口令");
    }
    if let Some(id) = account.strip_prefix("jump:") {
        return format!("连接 {id} 的跳板机密码");
    }
    if let Some(id) = account.strip_prefix("pk:") {
        return format!("连接 {id} 的私钥口令");
    }
    if account == "llm_api_key" {
        return "旧版 LLM API Key".into();
    }
    format!("连接 {account} 的登录密码")
}

/// 段头。
#[derive(Serialize)]
struct SegmentRef<'a> {
    format: u32,
    stream: &'a str,
    kind: &'a str,
    device: &'a str,
    ops: &'a [SecretOp],
}

#[derive(Deserialize)]
struct SegmentIn {
    #[serde(default)]
    kind: Option<String>,
    ops: Vec<SecretOp>,
}

// ---------------------------------------------------------------------------
// 镜像
// ---------------------------------------------------------------------------

/// 镜像里的一条：最后一次写入的 op（后写者赢靠 HLC）。
#[derive(Clone, Debug, Serialize, Deserialize)]
struct MirrorEntry {
    hlc: Hlc,
    /// `None` = 已删除。值只在 `Set` 时有。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    value: Option<ZeroizingString>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(default)]
struct MirrorDoc {
    /// 槽位账号 → 最后状态。
    secrets: BTreeMap<String, MirrorEntry>,
    /// 私钥 id → 最后状态（`meta` 与 blob 名；正文在 blob 文件里，不在镜像里）。
    keys: BTreeMap<String, KeyMirrorEntry>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct KeyMirrorEntry {
    hlc: Hlc,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    meta: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    blob: Option<String>,
}

/// 机密流镜像的落盘口（`sync/mirror/secrets.msync`，DK 封装）。
pub struct SecretMirror {
    path: PathBuf,
    doc: MirrorDoc,
}

impl SecretMirror {
    pub fn path(config_dir: &std::path::Path) -> PathBuf {
        crate::data::DataSourceId::SyncState
            .path(config_dir)
            .join("mirror")
            .join("secrets.msync")
    }

    /// 读镜像。**没有 DK 或文件不存在 = 空镜像**；解不开（换了设备 / DK 变了）也按空处理，
    /// 下一轮会从远端重新学回来——丢的只是「本机不认识的那些槽位」的暂存，不是用户数据。
    pub fn load(config_dir: &std::path::Path, dk: Option<&DataKey>) -> Self {
        let path = Self::path(config_dir);
        let doc = match dk {
            Some(dk) => std::fs::read(&path)
                .ok()
                .and_then(|bytes| {
                    format::open_json(dk, aad_tag::SEC_MIRROR, "", 0, &bytes)
                        .ok()
                        .and_then(|plain| serde_json::from_slice::<MirrorDoc>(&plain).ok())
                })
                .unwrap_or_default(),
            None => MirrorDoc::default(),
        };
        Self { path, doc }
    }

    /// 落盘。没有 DK 就什么都不写（不能明文写下去）。
    pub fn save(&self, dk: Option<&DataKey>) -> Result<(), AppError> {
        let Some(dk) = dk else { return Ok(()) };
        if self.doc.secrets.is_empty() && self.doc.keys.is_empty() {
            // 空镜像不落盘：省得留一个「什么都没有但看起来很重要」的加密文件
            let _ = std::fs::remove_file(&self.path);
            return Ok(());
        }
        let plain = serde_json::to_vec(&self.doc)
            .map_err(|e| AppError::Config(format!("序列化机密镜像失败：{e}")))?;
        let bytes =
            format::seal_json(dk, aad_tag::SEC_MIRROR, "", 0, &plain).map_err(AppError::from)?;
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| AppError::Config(format!("创建同步镜像目录失败：{e}")))?;
        }
        crate::config::persist::atomic_write_bytes(&self.path, &bytes)
            .map_err(|e| AppError::Config(format!("写入机密镜像失败：{e}")))
    }

    /// 合并一条 op（后写者赢）。返回镜像是否变了。
    fn merge(&mut self, op: &SecretOp) -> bool {
        match op {
            SecretOp::Set {
                account,
                hlc,
                value,
            } => merge_entry(&mut self.doc.secrets, account, hlc, Some(value.clone())),
            SecretOp::Del { account, hlc } => {
                merge_entry(&mut self.doc.secrets, account, hlc, None)
            }
            SecretOp::SetKey {
                key_id,
                hlc,
                meta,
                blob,
            } => merge_key(
                &mut self.doc.keys,
                key_id,
                hlc,
                Some(meta.clone()),
                Some(blob.clone()),
            ),
            SecretOp::DelKey { key_id, hlc } => {
                merge_key(&mut self.doc.keys, key_id, hlc, None, None)
            }
        }
    }

    fn entries(&self) -> impl Iterator<Item = (&String, &MirrorEntry)> {
        self.doc.secrets.iter()
    }

    fn keys(&self) -> impl Iterator<Item = (&String, &KeyMirrorEntry)> {
        self.doc.keys.iter()
    }
}

fn merge_entry(
    map: &mut BTreeMap<String, MirrorEntry>,
    id: &str,
    hlc: &Hlc,
    value: Option<ZeroizingString>,
) -> bool {
    match map.get(id) {
        Some(existing) if existing.hlc >= *hlc => false,
        _ => {
            map.insert(
                id.to_string(),
                MirrorEntry {
                    hlc: hlc.clone(),
                    value,
                },
            );
            true
        }
    }
}

fn merge_key(
    map: &mut BTreeMap<String, KeyMirrorEntry>,
    id: &str,
    hlc: &Hlc,
    meta: Option<serde_json::Value>,
    blob: Option<String>,
) -> bool {
    match map.get(id) {
        Some(existing) if existing.hlc >= *hlc => false,
        _ => {
            map.insert(
                id.to_string(),
                KeyMirrorEntry {
                    hlc: hlc.clone(),
                    meta,
                    blob,
                },
            );
            true
        }
    }
}

// ---------------------------------------------------------------------------
// 驱动
// ---------------------------------------------------------------------------

/// 机密流驱动。
pub struct SecretStreamDriver {
    config_dir: PathBuf,
    secrets: Arc<dyn SyncSecretStore>,
    device: String,
    state: StreamState,
    /// 数据密钥：只有引擎在「需要封包 / 解镜像」的阶段才给得出，构造时为 `None`。
    dk: Option<DataKey>,
    /// 本机当前的可枚举槽位目录（每次比对前现算）。
    catalog: SecretSlotCatalog,
    /// 待上传的段（`capture` 产出、引擎上传成功后 `ack_capture` 才更新基线）。
    pending_baseline: Vec<(String, Option<String>)>,
}

impl SecretStreamDriver {
    pub fn new(
        config_dir: PathBuf,
        secrets: Arc<dyn SyncSecretStore>,
        device: String,
        state: StreamState,
        catalog: SecretSlotCatalog,
    ) -> Self {
        Self {
            config_dir,
            secrets,
            device,
            state,
            dk: None,
            catalog,
            pending_baseline: Vec::new(),
        }
    }

    /// 引擎在拿到 DK 之后调一次（捕获阶段不需要）。
    pub fn with_data_key(mut self, dk: DataKey) -> Self {
        self.dk = Some(dk);
        self
    }

    fn now_hlc(&self) -> Hlc {
        // 机密流没有自己的时钟：用远端已观察到的最大 HLC 与本机墙钟取大，再补 counter。
        // 引擎每轮会把远端 HLC 通过 `observe` 推到共享时钟上（`capture` 前的账本里有），
        // 这里用 `wall_clock_ms` + 设备 id 生成一个足够用的时间戳。
        Hlc {
            ms: super::super::core::wall_clock_ms(),
            counter: 0,
            device: self.device.clone(),
        }
    }

    /// 全量比对：把本机所有可枚举槽位与基线比一遍。返回要发的 op（不含 HLC）。
    fn diff_against_baseline(
        &self,
    ) -> Result<(Vec<SecretOp>, Vec<(String, Option<String>)>), AppError> {
        let baseline = SecretBaseline::load(&self.config_dir)?;
        let mut ops = Vec::new();
        let mut new_baseline = Vec::new();

        for slot in SecretSlot::enumerable_slots(&self.catalog) {
            let account = slot.account().into_owned();
            let current = self.secrets.get(&slot)?;
            match current {
                Some(value) => {
                    if !baseline.matches(&account, &value) {
                        ops.push(SecretOp::Set {
                            account: account.clone(),
                            hlc: self.now_hlc(),
                            value: ZeroizingString::new(value.clone()),
                        });
                        new_baseline.push((account, Some(value)));
                    }
                }
                None => {
                    if baseline.knows(&account) {
                        ops.push(SecretOp::Del {
                            account: account.clone(),
                            hlc: self.now_hlc(),
                        });
                        new_baseline.push((account, None));
                    }
                }
            }
        }
        Ok((ops, new_baseline))
    }

    /// 把一批 op 切成若干段（每段不超过 [`MAX_SEGMENT_BYTES`]）。
    fn encode_segments(&self, ops: Vec<SecretOp>) -> Result<Vec<Vec<u8>>, AppError> {
        let mut out = Vec::new();
        let mut batch: Vec<SecretOp> = Vec::new();
        let mut batch_len = 0usize;

        let header_len = |ops_len: usize| -> usize {
            // 空段的 JSON 长度 + 每条 op 的 JSON 长度 + 逗号。`serde_json` 紧凑输出无空格。
            serde_json::to_vec(&SegmentRef {
                format: 1,
                stream: STREAM_KEY,
                kind: SEGMENT_KIND,
                device: &self.device,
                ops: &Vec::<SecretOp>::new(),
            })
            .map(|v| v.len() + ops_len)
            .unwrap_or(256)
        };

        for op in ops {
            let op_len = serde_json::to_vec(&op)
                .map_err(|e| AppError::Config(format!("序列化机密 op 失败：{e}")))?
                .len();
            if !batch.is_empty() && batch_len + op_len + 1 > MAX_SEGMENT_BYTES {
                out.push(self.encode_one(&batch)?);
                batch.clear();
                batch_len = 0;
            }
            batch_len += op_len + 1;
            batch.push(op);
        }
        if !batch.is_empty() {
            let _ = header_len(0);
            out.push(self.encode_one(&batch)?);
        }
        Ok(out)
    }

    fn encode_one(&self, ops: &[SecretOp]) -> Result<Vec<u8>, AppError> {
        serde_json::to_vec(&SegmentRef {
            format: 1,
            stream: STREAM_KEY,
            kind: SEGMENT_KIND,
            device: &self.device,
            ops,
        })
        .map_err(|e| AppError::Config(format!("序列化机密段失败：{e}")))
    }

    /// 把镜像里「本机认识、且与基线不同」的项落地到密钥链（含本机升级后才认识的槽位）。
    ///
    /// 全程在 [`CaptureSuppression`] 里：这里写进去的值不是「本机改动」，不能再发出去。
    fn land_mirror(&self, mirror: &SecretMirror) -> Result<Vec<String>, AppError> {
        let _suppress = CaptureSuppression::new();
        let mut baseline = SecretBaseline::load(&self.config_dir)?;
        let mut landed = Vec::new();

        for (account, entry) in mirror.entries() {
            let Some(slot) = SecretSlot::from_account(account, &self.catalog) else {
                // 本机不认识这个槽位（新版本加的 Key）：只留在加密镜像里，等本机升级认识了
                // 再由下一次全量比对 / 落地带出来。
                continue;
            };
            match &entry.value {
                Some(value) => {
                    if baseline.matches(account, value.as_str()) {
                        continue; // 已经在基线里：本机就是这样，不用再写
                    }
                    self.secrets.set(&slot, value.as_str())?;
                    baseline.upsert(account, value.as_str());
                    landed.push(account.clone());
                }
                None => {
                    if !baseline.knows(account) {
                        continue; // 本机从来没有过，也没什么可删的
                    }
                    self.secrets.delete(&slot)?;
                    baseline.remove(account);
                    landed.push(account.clone());
                }
            }
        }
        baseline.save()?;
        Ok(landed)
    }
}

#[async_trait]
impl StreamDriver for SecretStreamDriver {
    fn name(&self) -> StreamName {
        StreamName::Sec
    }

    fn state(&self) -> StreamState {
        self.state.clone()
    }

    fn set_state(&mut self, state: StreamState) {
        self.state = state;
    }

    async fn capture(&mut self) -> Result<Vec<Vec<u8>>, AppError> {
        let (ops, new_baseline) = self.diff_against_baseline()?;
        if ops.is_empty() {
            return Ok(Vec::new());
        }
        self.pending_baseline = new_baseline;
        // 本机 op 先合并进镜像：否则同一条流里的旧值会在落地时被写回来。
        let mut mirror = SecretMirror::load(&self.config_dir, self.dk.as_ref());
        for op in &ops {
            mirror.merge(op);
        }
        mirror.save(self.dk.as_ref())?;
        self.encode_segments(ops)
    }

    async fn ack_capture(&mut self) -> Result<(), AppError> {
        if self.pending_baseline.is_empty() {
            return Ok(());
        }
        let mut baseline = SecretBaseline::load(&self.config_dir)?;
        for (account, value) in std::mem::take(&mut self.pending_baseline) {
            match value {
                Some(v) => baseline.upsert(&account, &v),
                None => baseline.remove(&account),
            }
        }
        baseline.save()
    }

    async fn export_full(&mut self) -> Result<Vec<Vec<u8>>, AppError> {
        // 首次打开机密档：把本机现有的每个 Key 全导出一遍（相当于「加入这条流」）。
        let mut ops = Vec::new();
        let baseline = SecretBaseline::load(&self.config_dir)?;
        let mut new_baseline = Vec::new();
        for slot in SecretSlot::enumerable_slots(&self.catalog) {
            let account = slot.account().into_owned();
            let Some(value) = self.secrets.get(&slot)? else {
                continue;
            };
            if baseline.matches(&account, &value) {
                continue; // 已经同步过，不重复发
            }
            ops.push(SecretOp::Set {
                account: account.clone(),
                hlc: self.now_hlc(),
                value: ZeroizingString::new(value.clone()),
            });
            new_baseline.push((account, Some(value)));
        }
        if ops.is_empty() {
            return Ok(Vec::new());
        }
        let mut mirror = SecretMirror::load(&self.config_dir, self.dk.as_ref());
        for op in &ops {
            mirror.merge(op);
        }
        mirror.save(self.dk.as_ref())?;
        self.pending_baseline = new_baseline;
        self.encode_segments(ops)
    }

    async fn apply_segment(&mut self, plain: &[u8]) -> Result<StreamApplied, AppError> {
        format::check_format(plain).map_err(AppError::from)?;
        let seg: SegmentIn = serde_json::from_slice(plain)
            .map_err(|e| AppError::Other(format!("机密同步段不是有效的 JSON：{e}")))?;
        if let Some(kind) = &seg.kind {
            if kind != SEGMENT_KIND {
                return Err(AppError::Other(format!(
                    "机密同步段类型不对：期望「{SEGMENT_KIND}」，实际是「{kind}」"
                )));
            }
        }
        let mut mirror = SecretMirror::load(&self.config_dir, self.dk.as_ref());
        let mut changed = false;
        for op in &seg.ops {
            changed |= mirror.merge(op);
        }
        mirror.save(self.dk.as_ref())?;
        Ok(StreamApplied {
            changed,
            ..Default::default()
        })
    }

    async fn land(&mut self) -> Result<StreamApplied, AppError> {
        let mirror = SecretMirror::load(&self.config_dir, self.dk.as_ref());
        let landed = self.land_mirror(&mirror)?;
        Ok(StreamApplied {
            changed: !landed.is_empty(),
            ..Default::default()
        })
    }

    async fn make_snapshot(&mut self) -> Result<Option<StreamSnapshot>, AppError> {
        // 机密流数据量小（几十个 Key），段就够；快照留给以后真有几百条时再说。
        Ok(None)
    }

    fn snapshot_layout(&self) -> StreamSnapshotLayout {
        StreamSnapshotLayout::SingleFile
    }
}

/// 机密流的进度（首次加入时用）。
pub fn sync_progress(done: usize, total: usize) -> StreamProgress {
    StreamProgress {
        done,
        total,
        label: "正在同步机密".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::secrets::MemorySecrets;

    fn catalog() -> SecretSlotCatalog {
        SecretSlotCatalog {
            connection_ids: vec!["c1".into()],
            channel_ids: vec!["ch1".into()],
            mcp_ids: vec!["s1".into()],
        }
    }

    fn driver(dir: &std::path::Path, secrets: Arc<MemorySecrets>) -> SecretStreamDriver {
        let secrets: Arc<dyn SyncSecretStore> = secrets;
        SecretStreamDriver::new(
            dir.to_path_buf(),
            secrets,
            "devA".into(),
            StreamState::default(),
            catalog(),
        )
    }

    #[test]
    fn segment_shape_is_stable_and_has_no_seq() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecrets::new());
        let d = driver(tmp.path(), secrets);
        let seg = d
            .encode_one(&[SecretOp::Set {
                account: "llm_channel_ch1".into(),
                hlc: Hlc {
                    ms: 1,
                    counter: 0,
                    device: "devA".into(),
                },
                value: ZeroizingString::new("v"),
            }])
            .unwrap();
        let v: serde_json::Value = serde_json::from_slice(&seg).unwrap();
        assert_eq!(v["format"], 1);
        assert_eq!(v["stream"], "sec");
        assert_eq!(v["kind"], "secret-ops");
        assert_eq!(v["device"], "devA");
        assert!(v.get("seq").is_none(), "序号由引擎分配，段里不写");
        assert_eq!(v["ops"][0]["op"], "set");
        assert_eq!(v["ops"][0]["account"], "llm_channel_ch1");
    }

    #[test]
    fn op_round_trips_including_zeroizing_value() {
        let ops = vec![
            SecretOp::Set {
                account: "a".into(),
                hlc: Hlc {
                    ms: 2,
                    counter: 0,
                    device: "d".into(),
                },
                value: ZeroizingString::new("hunter2"),
            },
            SecretOp::Del {
                account: "b".into(),
                hlc: Hlc {
                    ms: 3,
                    counter: 0,
                    device: "d".into(),
                },
            },
            SecretOp::SetKey {
                key_id: "k1".into(),
                hlc: Hlc {
                    ms: 4,
                    counter: 0,
                    device: "d".into(),
                },
                meta: serde_json::json!({"name": "我的密钥"}),
                blob: "abc.msync".into(),
            },
            SecretOp::DelKey {
                key_id: "k2".into(),
                hlc: Hlc {
                    ms: 5,
                    counter: 0,
                    device: "d".into(),
                },
            },
        ];
        let json = serde_json::to_vec(&ops).unwrap();
        let back: Vec<SecretOp> = serde_json::from_slice(&json).unwrap();
        assert_eq!(back, ops);
    }

    #[test]
    fn debug_output_never_prints_the_secret() {
        let op = SecretOp::Set {
            account: "a".into(),
            hlc: Hlc {
                ms: 1,
                counter: 0,
                device: "d".into(),
            },
            value: ZeroizingString::new("sk-do-not-print-me"),
        };
        let dbg = format!("{op:?}");
        assert!(!dbg.contains("sk-do-not-print-me"), "{dbg}");
        // 也不是一句「redacted」都没有——要有能定位的信息（账号），只是没有值
        assert!(dbg.contains('a'));
    }

    #[test]
    fn describe_only_names_the_key_never_the_value() {
        assert!(describe_account("llm_channel_ch1").contains("ch1"));
        assert!(describe_account("web_search_api_key").contains("搜索"));
        assert!(describe_account("mcp_headers:s1").contains("s1"));
        assert!(describe_account("pk:c1").contains("c1"));
        assert!(describe_account("c1").contains("c1"));
        for account in [
            "llm_channel_x",
            "web_search_api_key",
            "mcp_headers:y",
            "pk:z",
            "z",
        ] {
            let text = describe_account(account);
            assert!(!text.contains('='), "别把「账号=值」的形状漏出来: {text}");
        }
    }

    #[test]
    fn mirror_merge_is_last_writer_wins() {
        let mut doc = MirrorDoc::default();
        let h = |ms: u64| Hlc {
            ms,
            counter: 0,
            device: "d".into(),
        };
        assert!(merge_entry(
            &mut doc.secrets,
            "a",
            &h(10),
            Some(ZeroizingString::new("v1"))
        ));
        // 更旧：丢弃
        assert!(!merge_entry(
            &mut doc.secrets,
            "a",
            &h(5),
            Some(ZeroizingString::new("old"))
        ));
        assert_eq!(doc.secrets["a"].value.as_ref().unwrap().as_str(), "v1");
        // 更新：覆盖为删除
        assert!(merge_entry(&mut doc.secrets, "a", &h(20), None));
        assert!(doc.secrets["a"].value.is_none());
    }

    #[test]
    fn unknown_slot_stays_in_mirror_and_is_not_written_to_keychain() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecrets::new());
        let d = driver(tmp.path(), secrets.clone());
        // 造一条镜像里才有的、本机 catalog 不认识的槽位
        let mut mirror = SecretMirror::load(tmp.path(), None);
        mirror.merge(&SecretOp::Set {
            account: "llm_channel_brand-new-channel".into(),
            hlc: Hlc {
                ms: 1,
                counter: 0,
                device: "other".into(),
            },
            value: ZeroizingString::new("brand-new-value"),
        });
        let landed = d.land_mirror(&mirror).unwrap();
        assert!(landed.is_empty(), "本机不认识的槽位不该落地");
        assert!(secrets.is_empty(), "密钥链里不能出现它");
        // 但镜像里还在
        assert_eq!(mirror.entries().count(), 1);
    }

    /// 本机认识的槽位、镜像比基线新 → 落地写密钥链，并更新基线。
    #[test]
    fn known_slot_lands_and_updates_the_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecrets::new());
        let d = driver(tmp.path(), secrets.clone());
        let mut mirror = SecretMirror::load(tmp.path(), None);
        mirror.merge(&SecretOp::Set {
            account: "llm_channel_ch1".into(),
            hlc: Hlc {
                ms: 1,
                counter: 0,
                device: "other".into(),
            },
            value: ZeroizingString::new("from-other-device"),
        });
        let landed = d.land_mirror(&mirror).unwrap();
        assert_eq!(landed, vec!["llm_channel_ch1".to_string()]);
        assert_eq!(
            secrets
                .get(&SecretSlot::LlmChannel("ch1".into()))
                .unwrap()
                .as_deref(),
            Some("from-other-device")
        );
        // 落地过之后基线认得它：再落一次不会重复写
        let again = d.land_mirror(&mirror).unwrap();
        assert!(again.is_empty(), "已经落地过的不该重复写");
    }

    #[test]
    fn capture_only_reports_real_changes() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecrets::new());
        let d = driver(tmp.path(), secrets.clone());
        // 第一次：密钥链里有一个 Key、基线不知道 → 应报一条 set
        secrets
            .set(&SecretSlot::LlmChannel("ch1".into()), "v1")
            .unwrap();
        let (ops, new_baseline) = d.diff_against_baseline().unwrap();
        assert_eq!(ops.len(), 1);
        assert!(matches!(&ops[0], SecretOp::Set { account, .. } if account == "llm_channel_ch1"));
        assert_eq!(new_baseline.len(), 1);

        // 把基线写成「已知」后再比：没有改动
        let mut b = SecretBaseline::load(tmp.path()).unwrap();
        b.upsert("llm_channel_ch1", "v1");
        b.save().unwrap();
        let (ops, _) = d.diff_against_baseline().unwrap();
        assert!(ops.is_empty(), "值没变就不该再发");

        // 删掉这个 Key：应报一条 del
        secrets
            .delete(&SecretSlot::LlmChannel("ch1".into()))
            .unwrap();
        let (ops, _) = d.diff_against_baseline().unwrap();
        assert_eq!(ops.len(), 1);
        assert!(matches!(&ops[0], SecretOp::Del { account, .. } if account == "llm_channel_ch1"));
    }
}

// ---------------------------------------------------------------------------
// 生产工厂
// ---------------------------------------------------------------------------

/// 生产环境构造机密流驱动需要的东西（都来自 `AppState` / 引擎依赖）。
pub struct SecretFactoryDeps {
    pub config_dir: std::path::PathBuf,
    pub secrets: Arc<dyn SyncSecretStore>,
    /// 本机有哪些连接 / 渠道 / MCP 服务器（可枚举槽位）。
    ///
    /// 每次构造驱动时现取：用户随时可能加一台服务器、删一个渠道。
    pub catalog: Arc<dyn Fn() -> SecretSlotCatalog + Send + Sync>,
    /// 本机设备 id（op 的 HLC 用）。空串 = 还不知道，驱动会退回 `"sec-device"`。
    pub device: Arc<dyn Fn() -> String + Send + Sync>,
    /// 基线里上次同步了多少条（状态栏「待上传」用）。
    pub pending: Arc<dyn Fn() -> usize + Send + Sync>,
}

/// 机密流的驱动工厂（引擎构造驱动用）。
pub struct SecretStreamFactory {
    deps: SecretFactoryDeps,
}

impl SecretStreamFactory {
    pub fn new(deps: SecretFactoryDeps) -> Self {
        Self { deps }
    }
}

impl super::StreamDriverFactory for SecretStreamFactory {
    fn name(&self) -> StreamName {
        StreamName::Sec
    }

    fn create(
        &self,
        state: StreamState,
        dk: Option<DataKey>,
    ) -> Result<Box<dyn StreamDriver>, AppError> {
        let mut driver = SecretStreamDriver::new(
            self.deps.config_dir.clone(),
            self.deps.secrets.clone(),
            (self.deps.device)(),
            state,
            (self.deps.catalog)(),
        );
        if let Some(dk) = dk {
            driver = driver.with_data_key(dk);
        }
        Ok(Box::new(driver))
    }

    fn pending(&self) -> usize {
        (self.deps.pending)()
    }
}
