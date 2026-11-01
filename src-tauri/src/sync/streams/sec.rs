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
use super::super::core::{Hlc, HlcClock};
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
/// 本流 HLC 的落盘文件（`<config>/sync/sec_clock.json`，属 `DataSourceId::SyncState`）。
const CLOCK_FILE: &str = "sec_clock.json";
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

/// 读本流时钟。文件缺失 / 损坏 / 设备 id 变了 → 从零开始（沿用一个不属于本机的
/// 设备 id 会让别处看到「这台设备的时间线倒流」）。
fn load_clock(config_dir: &std::path::Path, device: &str) -> HlcClock {
    let path = crate::data::DataSourceId::SyncState
        .path(config_dir)
        .join(CLOCK_FILE);
    #[derive(Deserialize)]
    struct Saved {
        last: Hlc,
    }
    match std::fs::read_to_string(&path)
        .ok()
        .and_then(|t| serde_json::from_str::<Saved>(&t).ok())
    {
        Some(saved) if saved.last.device == device => HlcClock::from_last(saved.last),
        _ => HlcClock::new(device),
    }
}

fn save_clock(config_dir: &std::path::Path, last: &Hlc) -> Result<(), AppError> {
    #[derive(Serialize)]
    struct Saved<'a> {
        last: &'a Hlc,
    }
    let path = crate::data::DataSourceId::SyncState
        .path(config_dir)
        .join(CLOCK_FILE);
    let text = serde_json::to_string(&Saved { last })
        .map_err(|e| AppError::Config(format!("序列化机密流时钟失败：{e}")))?;
    crate::config::persist::atomic_write(&path, &text)
        .map_err(|e| AppError::Config(format!("写入机密流时钟失败：{e}")))
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
    /// 存储后端（私钥 blob 上传 / 下载用）。
    backend: Option<Arc<dyn crate::sync::backends::Backend>>,
    /// 本机私钥库（T7）。默认是应用配置目录下那一份；测试可换成临时目录。
    key_store: Arc<dyn crate::ssh::key_store::KeyStoreAccess>,
    /// 本机当前的可枚举槽位目录（每次比对前现算）。
    catalog: SecretSlotCatalog,
    /// 本流的时间戳：**必须单调**。同一毫秒内发两条 op（用户导入后立刻删除）时，
    /// 只有 counter 能分出先后——恒定 `counter: 0` 会让后一条被镜像当成「不更新」丢掉。
    /// 持久化在 `sync/sec_clock.json`，重启 / 墙钟回拨后仍严格递增。
    clock: HlcClock,
    /// 待上传的段（`capture` 产出、引擎上传成功后 `ack_capture` 才更新基线）。
    pending_baseline: Vec<(String, Option<String>)>,
    /// 私钥基线的待确认改动：`Some(pem)` = 上传成功后记成「已同步」，`None` = 删掉这条记录。
    ///
    /// 与槽位同理：**上传成功才能改基线**，否则段没传出去、下轮又以为已经同步过了。
    pending_key_baseline: Vec<(String, Option<String>)>,
}

impl SecretStreamDriver {
    pub fn new(
        config_dir: PathBuf,
        secrets: Arc<dyn SyncSecretStore>,
        device: String,
        state: StreamState,
        catalog: SecretSlotCatalog,
    ) -> Self {
        let clock = load_clock(&config_dir, &device);
        Self {
            config_dir,
            secrets,
            device,
            state,
            dk: None,
            backend: None,
            key_store: Arc::new(crate::ssh::key_store::SystemKeyStore),
            catalog,
            clock,
            pending_baseline: Vec::new(),
            pending_key_baseline: Vec::new(),
        }
    }

    /// 引擎在拿到 DK / 后端之后调一次（捕获阶段不需要）。
    pub fn with_data_key(mut self, dk: DataKey) -> Self {
        self.dk = Some(dk);
        self
    }

    /// 注入存储后端（私钥 blob 用）。
    pub fn with_backend(mut self, backend: Arc<dyn crate::sync::backends::Backend>) -> Self {
        self.backend = Some(backend);
        self
    }

    /// 注入私钥库（测试用；生产默认系统密钥库）。
    pub fn with_key_store(
        mut self,
        key_store: Arc<dyn crate::ssh::key_store::KeyStoreAccess>,
    ) -> Self {
        self.key_store = key_store;
        self
    }

    /// 下一个本机时间戳。严格大于此前发出的任何一个（同一毫秒靠 counter 递进），
    /// 发完立刻落盘——崩溃后重启不能退回去，否则删除墓碑会被旧值盖掉。
    fn now_hlc(&mut self) -> Hlc {
        let hlc = self.clock.now(super::super::core::wall_clock_ms());
        if let Err(e) = save_clock(&self.config_dir, &hlc) {
            log::warn!("同步：机密流时钟落盘失败（不影响本轮）: {e}");
        }
        hlc
    }

    /// 看到远端的时间戳：把本机时钟推到它之后，保证「看到删除后再做的修改」排在删除之后。
    fn observe_remote(&mut self, ops: &[SecretOp]) {
        let wall = super::super::core::wall_clock_ms();
        let before = self.clock.last().clone();
        for op in ops {
            self.clock.observe(op.hlc(), wall);
        }
        if self.clock.last() != &before {
            let last = self.clock.last().clone();
            if let Err(e) = save_clock(&self.config_dir, &last) {
                log::warn!("同步：机密流时钟落盘失败（不影响本轮）: {e}");
            }
        }
    }

    /// 捕获私钥库的改动（T7）：本机能解开的条目才上传，解不开的（备份恢复的设备）跳过。
    ///
    /// 私钥正文走 blob（单独文件、按内容寻址），段里只带 `meta` 与 blob 名字——
    /// 一把私钥几 KB，塞进段会让每轮同步都重传一遍。
    async fn capture_keys(
        &mut self,
    ) -> Result<(Vec<SecretOp>, Vec<(String, Option<String>)>), AppError> {
        let (Some(dk), Some(backend)) = (self.dk.clone(), self.backend.clone()) else {
            // 还没拿到 DK / 后端：这一轮不上传私钥。**不能**顺手发删除——
            // 那样会把「只是暂时读不到」误发成墓碑。
            return Ok((Vec::new(), Vec::new()));
        };
        let baseline = SecretBaseline::load(&self.config_dir)?;
        let mut ledger = crate::sync::blob::BlobLedger::load(&self.config_dir);
        let mut ops = Vec::new();
        let mut updates = Vec::new();
        let mut seen = std::collections::BTreeSet::new();
        for meta in self.key_store.list() {
            let Some((m, pem)) = self.key_store.export_for_sync(&meta.id) else {
                continue; // 主密钥解不开：不上传（传过去也没人能落地）
            };
            if baseline.key_matches(&meta.id, pem.as_str()) {
                // 已经同步过（包括「别的设备落地进本机」的那一把）：别再发，否则两边来回弹。
                seen.insert(meta.id);
                continue;
            }
            let (blob, _) = crate::sync::blob::upload_blob(
                &backend,
                &mut ledger,
                &dk,
                &self.device,
                pem.as_bytes(),
            )
            .await?;
            let meta_json = serde_json::to_value(&m)
                .map_err(|e| AppError::Config(format!("序列化私钥元数据失败：{e}")))?;
            ops.push(SecretOp::SetKey {
                key_id: meta.id.clone(),
                hlc: self.now_hlc(),
                meta: meta_json,
                blob,
            });
            updates.push((meta.id.clone(), Some(pem.as_str().to_string())));
            seen.insert(meta.id);
        }
        // 基线里记着、本机库里已经没有的私钥 → 发删除。
        //
        // **必须用基线而不是镜像**：捕获阶段 `self.dk` 是 `None`（引擎刻意不给），
        // 而镜像用 DK 封装，读出来永远是空的——那样删除墓碑一条都发不出去。
        // 基线只存 HMAC、不需要 DK，正好用来回答「这台设备以前同步过这把私钥吗」。
        for key_id in baseline.key_ids() {
            if !seen.contains(&key_id) && !self.key_store.has(&key_id) {
                ops.push(SecretOp::DelKey {
                    key_id: key_id.clone(),
                    hlc: self.now_hlc(),
                });
                updates.push((key_id, None));
            }
        }
        Ok((ops, updates))
    }

    /// 全量比对：把本机所有可枚举槽位与基线比一遍。返回要发的 op（不含 HLC）。
    fn diff_against_baseline(
        &mut self,
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

    /// 把镜像里的私钥落地到本机私钥库（用本机主密钥重新加密）。
    async fn land_keys(&self, mirror: &SecretMirror) -> Result<Vec<String>, AppError> {
        let (Some(dk), Some(backend)) = (self.dk.clone(), self.backend.clone()) else {
            return Ok(Vec::new());
        };
        // 落地期间不捕获：这里写进去的私钥不是「本机改动」。
        let _suppress = CaptureSuppression::new();
        let mut baseline = SecretBaseline::load(&self.config_dir)?;
        let mut landed = Vec::new();
        for (key_id, entry) in mirror.keys() {
            match (&entry.meta, &entry.blob) {
                (Some(meta), Some(blob)) => {
                    if self.key_store.has(key_id) {
                        continue; // 本机已有：不覆盖（可能是用户自己换过的一把）
                    }
                    let Some(bytes) =
                        crate::sync::blob::download_blob(&backend, &dk, &self.device, blob).await?
                    else {
                        log::warn!("同步：私钥 {key_id} 的正文在对端已经没有了，跳过");
                        continue;
                    };
                    let pem = String::from_utf8(bytes)
                        .map_err(|_| AppError::Other("同步来的私钥不是文本格式".into()))?;
                    let meta: crate::ssh::key_store::StoredKeyMeta =
                        serde_json::from_value(meta.clone()).map_err(|e| {
                            AppError::Other(format!("同步来的私钥元数据无法识别：{e}"))
                        })?;
                    if self.key_store.import_from_sync(key_id, &meta, &pem)? {
                        // 记进基线：否则下一轮捕获会把「别的设备刚落地进来的」当本机新增
                        // 又发出去（两台设备来回弹，段数无限涨）。
                        baseline.key_upsert(key_id, &pem);
                        landed.push(format!("key:{key_id}"));
                    }
                }
                _ => {
                    // 墓碑：对端删了这把私钥。
                    self.key_store.delete_from_sync(key_id)?;
                    baseline.key_remove(key_id);
                    landed.push(format!("key:{key_id}"));
                }
            }
        }
        if !landed.is_empty() {
            baseline.save()?;
        }
        Ok(landed)
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

    fn set_data_key(&mut self, dk: &DataKey) {
        self.dk = Some(dk.clone());
    }

    fn set_backend(&mut self, backend: Arc<dyn crate::sync::backends::Backend>) {
        self.backend = Some(backend);
    }

    async fn capture(&mut self) -> Result<Vec<Vec<u8>>, AppError> {
        let (mut ops, new_baseline) = self.diff_against_baseline()?;
        // 私钥（T7）：与槽位一起进同一条流。
        let (key_ops, key_baseline) = self.capture_keys().await?;
        ops.extend(key_ops);
        if ops.is_empty() {
            return Ok(Vec::new());
        }
        self.pending_baseline = new_baseline;
        self.pending_key_baseline = key_baseline;
        // 本机 op 先合并进镜像：否则同一条流里的旧值会在落地时被写回来。
        let mut mirror = SecretMirror::load(&self.config_dir, self.dk.as_ref());
        for op in &ops {
            mirror.merge(op);
        }
        mirror.save(self.dk.as_ref())?;
        self.encode_segments(ops)
    }

    async fn ack_capture(&mut self) -> Result<(), AppError> {
        if self.pending_baseline.is_empty() && self.pending_key_baseline.is_empty() {
            return Ok(());
        }
        let mut baseline = SecretBaseline::load(&self.config_dir)?;
        for (account, value) in std::mem::take(&mut self.pending_baseline) {
            match value {
                Some(v) => baseline.upsert(&account, &v),
                None => baseline.remove(&account),
            }
        }
        for (key_id, value) in std::mem::take(&mut self.pending_key_baseline) {
            match value {
                Some(pem) => baseline.key_upsert(&key_id, &pem),
                None => baseline.key_remove(&key_id),
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
        // 私钥也一起全导（首次打开机密档时）。
        let (key_ops, key_baseline) = self.capture_keys().await?;
        ops.extend(key_ops);
        if ops.is_empty() {
            return Ok(Vec::new());
        }
        self.pending_key_baseline = key_baseline;
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
        // 看到远端的时间戳要推进本机时钟：否则「本机改一下」与「远端刚删」可能撞在同一毫秒，
        // 本机那条会排在删除之前、被镜像丢掉。
        self.observe_remote(&seg.ops);
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
        let mut landed = self.land_mirror(&mirror)?;
        // 私钥：从 blob 拉正文，用本机主密钥重新加密后写进本机库。
        landed.extend(self.land_keys(&mirror).await?);
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

    /// 同一毫秒内连发两条 op 必须分得出先后（导入后立刻删除）。
    ///
    /// 曾经用 `wall_clock_ms()` + 恒定 `counter: 0`，两条 op 的时间戳**相等**，
    /// 而镜像合并是 `existing.hlc >= new` 就丢——删除墓碑被静默吞掉，
    /// 对面那台设备把私钥又落了回来。
    #[test]
    fn consecutive_ops_in_the_same_millisecond_still_advance() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecrets::new());
        let mut d = driver(tmp.path(), secrets);
        let a = d.now_hlc();
        let b = d.now_hlc();
        assert!(b > a, "同一毫秒里第二条 op 也必须更大：{a:?} vs {b:?}");

        // 删除墓碑能盖掉刚才的写入（镜像层面）
        let mut doc = MirrorDoc::default();
        assert!(merge_key(
            &mut doc.keys,
            "k",
            &a,
            Some(serde_json::json!({})),
            Some("x".into())
        ));
        assert!(
            merge_key(&mut doc.keys, "k", &b, None, None),
            "删除必须生效"
        );
        assert!(doc.keys["k"].meta.is_none());
    }

    /// 时钟落盘：重启后不能退回去（否则墓碑会被旧值盖掉）。
    #[test]
    fn the_clock_is_persisted_across_restarts() {
        let tmp = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemorySecrets::new());
        let mut d = driver(tmp.path(), secrets.clone());
        let first = d.now_hlc();
        drop(d);

        let mut again = driver(tmp.path(), secrets);
        let next = again.now_hlc();
        assert!(
            next > first,
            "重启后必须严格大于重启前：{first:?} vs {next:?}"
        );
    }

    /// 落地写进来的私钥不能下一轮再被当成「本机新增」传回去（两台设备来回弹）。
    #[test]
    fn a_key_that_was_just_synced_in_is_not_uploaded_back() {
        let tmp = tempfile::tempdir().unwrap();
        let mut baseline = SecretBaseline::load(tmp.path()).unwrap();
        baseline.key_upsert("k1", "PEM");
        baseline.save().unwrap();

        let again = SecretBaseline::load(tmp.path()).unwrap();
        assert!(again.key_matches("k1", "PEM"), "基线要认得出自己落地的那把");
        assert!(!again.key_matches("k1", "OTHER"));
        assert_eq!(again.key_ids(), vec!["k1".to_string()]);
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
        let mut d = driver(tmp.path(), secrets.clone());
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
        let mut d = driver(tmp.path(), secrets.clone());
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
        let mut d = driver(tmp.path(), secrets.clone());
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
    /// 本机私钥库（T7）。生产用 `SystemKeyStore`，集成测试换成每台设备自己的临时目录。
    pub key_store: Arc<dyn crate::ssh::key_store::KeyStoreAccess>,
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
    backend: parking_lot::RwLock<Option<Arc<dyn crate::sync::backends::Backend>>>,
}

impl SecretStreamFactory {
    pub fn new(deps: SecretFactoryDeps) -> Self {
        Self {
            deps,
            backend: parking_lot::RwLock::new(None),
        }
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
        driver = driver.with_key_store(self.deps.key_store.clone());
        if let Some(backend) = self.backend.read().clone() {
            driver = driver.with_backend(backend);
        }
        Ok(Box::new(driver))
    }

    fn pending(&self) -> usize {
        (self.deps.pending)()
    }

    fn set_backend(&self, backend: Arc<dyn crate::sync::backends::Backend>) {
        *self.backend.write() = Some(backend);
    }
}
