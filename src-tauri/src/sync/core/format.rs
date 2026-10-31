//! 远端目录布局、明文 JSON 结构与同步码。
//!
//! ```text
//! <root>/marcel-sync.json                          明文 meta：{"format":1,"salt":b64,"wrappedKey":b64,"createdAt":"…"}
//! <root>/devices/<deviceId>/seg-<seq:012>.msync    配置流 · 增量段（一批 op）
//! <root>/devices/<deviceId>/snap-<seq:012>.msync   配置流 · 快照（该设备的完整镜像）
//! <root>/devices/<id>/conv/seg-…                   对话与记忆流 · 增量段
//! <root>/devices/<id>/conv/snap-<seq>/index.msync  对话与记忆流 · 分包快照索引
//! <root>/devices/<id>/conv/snap-<seq>/part-0000.msync
//! <root>/devices/<id>/sec/seg-…                    机密流 · 增量段
//! <root>/devices/<id>/sec/snap-…                   机密流 · 快照
//! <root>/devices/<id>/blob/<64hex>.msync           按内容寻址的大块（图片 / 私钥正文）
//! ```
//!
//! **配置流的路径与文件名逐字不变**（老版本只认它们）；子目录对老版本而言是「目录项」，
//! 老版本的 `list` 只处理 `!is_dir` 的条目，所以天然跳过。二、三期的文件用各自的 AAD tag，
//! 把一条流的文件挪进另一条流会解不开（见 `crypto::aad`）。
//!
//! 版本策略：**加字段不升 `format`**（旧版本忽略不认识的字段）；只有旧版本会读错的结构变化才升。
//! 读到 `format` 大于本版本支持的 → [`FormatError::TooNew`]：运行时据此进入「需要升级」状态，
//! 并且**不推进该设备的游标**（升级后还能把没读的补上）。判断发生在结构化解析**之前**，
//! 因为新格式的形状本版本未必解析得了。

use std::collections::BTreeMap;

use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::{Zeroize, Zeroizing};

use super::crypto::{
    self, aad_tag, CryptoError, DataKey, FileKind, RecoveryKey, WrappedKey, ENVELOPE_VERSION,
};
use super::mirror::{Mirror, Op};
use super::path::IdMapRegistry;
use crate::error::AppError;

/// 本版本能读写的 `format`。
pub const FORMAT_VERSION: u32 = 1;

pub const META_FILE: &str = "marcel-sync.json";
pub const DEVICES_DIR: &str = "devices";
pub const FILE_EXT: &str = "msync";
pub const SYNC_CODE_PREFIX: &str = "MSYNC1-";

#[derive(Debug, thiserror::Error)]
pub enum FormatError {
    #[error("云端数据的格式版本（v{found}）比本版本支持的（v{supported}）新，请升级应用后再同步")]
    TooNew { found: u32, supported: u32 },
    #[error("同步数据已损坏：{0}")]
    Corrupt(String),
    #[error("{0}")]
    Crypto(CryptoError),
}

impl From<CryptoError> for FormatError {
    fn from(e: CryptoError) -> Self {
        match e {
            // 信封版本过新与 JSON format 过新是同一类处置（进入「需要升级」）
            CryptoError::EnvelopeTooNew(v) => FormatError::TooNew {
                found: v as u32,
                supported: ENVELOPE_VERSION as u32,
            },
            other => FormatError::Crypto(other),
        }
    }
}

impl FormatError {
    /// 是否「需要升级应用」。
    pub fn is_too_new(&self) -> bool {
        matches!(self, FormatError::TooNew { .. })
    }
}

impl From<FormatError> for AppError {
    fn from(e: FormatError) -> Self {
        AppError::Other(e.to_string())
    }
}

impl From<CryptoError> for AppError {
    fn from(e: CryptoError) -> Self {
        AppError::Other(e.to_string())
    }
}

// ---------------------------------------------------------------------------
// 路径与文件名
// ---------------------------------------------------------------------------

/// 新设备 id：不带横线的 UUIDv4（不含设备名等可识别信息）。
pub fn new_device_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// 设备 id 能否安全拼进远端路径。目录名来自远端 `list` 的结果，是不可信输入：
/// 只放行 1–64 个 `[A-Za-z0-9_-]`，挡住 `..`、`/`、控制字符。
pub fn is_valid_device_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// 三档开关（每台设备自己的）。写进每个段 / 快照的文件头，让别的设备知道「对方开了哪几档」。
///
/// 配置档恒为开（一期行为）：**序列化照常写**，读的时候忽略 `config: false`（见
/// `PersistedState::tier_enabled`）。缺字段 = 只有配置档（老版本写的文件）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TierSwitches {
    pub config: bool,
    pub conversation: bool,
    pub secret: bool,
}

impl Default for TierSwitches {
    fn default() -> Self {
        Self {
            config: true,
            conversation: false,
            secret: false,
        }
    }
}

impl TierSwitches {
    /// 只开配置档（老版本文件头缺 `tiers` 时的语义）。
    pub fn config_only() -> Self {
        Self::default()
    }

    /// 这条流所属的档开着没有。
    pub fn enabled(&self, stream: RemoteStream) -> bool {
        match stream {
            RemoteStream::Config => true,
            RemoteStream::Conv => self.conversation,
            RemoteStream::Sec => self.secret,
            // blob 跟着对话流走
            RemoteStream::Blob => self.conversation,
        }
    }
}

/// 远端文件属于哪条流。`Blob` 是对话图片 / 私钥正文这类按内容寻址的大块。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum RemoteStream {
    Config,
    Conv,
    Sec,
    Blob,
}

impl RemoteStream {
    /// 目录层名（配置流没有子目录）。
    pub fn dir_name(self) -> Option<&'static str> {
        match self {
            RemoteStream::Config => None,
            RemoteStream::Conv => Some("conv"),
            RemoteStream::Sec => Some("sec"),
            RemoteStream::Blob => Some("blob"),
        }
    }
}

/// 一个远端文件的种类（相对它所在的流）。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RemoteFileKind {
    Segment,
    Snapshot,
    /// 分包快照的索引（`conv/snap-<seq>/index.msync`）。
    SnapshotIndex,
    /// 分包快照的一个包（`conv/snap-<seq>/part-0000.msync`）。
    SnapshotPart,
    /// 按内容寻址的大块（`blob/<64hex>.msync`）。
    Blob,
}

/// [`parse_device_rel_path`] 的结果。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ParsedRemoteFile {
    pub device: String,
    pub stream: RemoteStream,
    pub kind: RemoteFileKind,
    /// 段 / 快照序号。blob 没有序号，恒为 0（按 `name` 寻址）。
    pub seq: u64,
    /// 分包快照的包号（只有 `SnapshotPart` 有）。
    pub part: Option<u32>,
    /// blob 的内容名（64 位十六进制，不含扩展名）。
    pub name: Option<String>,
}

/// `devices/<id>`（相对同步根目录）。
pub fn device_dir(device_id: &str) -> String {
    format!("{DEVICES_DIR}/{device_id}")
}

/// 一条流在远端设备目录下的路径（`devices/<id>` / `devices/<id>/conv` …）。
pub fn stream_dir(device_id: &str, stream: RemoteStream) -> String {
    match stream.dir_name() {
        Some(name) => format!("{}/{}", device_dir(device_id), name),
        None => device_dir(device_id),
    }
}

/// `seg-000000000012.msync` / `snap-000000000040.msync`。
pub fn file_name(kind: FileKind, seq: u64) -> String {
    format!("{}-{:012}.{}", kind.as_str(), seq, FILE_EXT)
}

/// 配置流的 `devices/<id>/<file_name>`（一期路径，逐字不变）。
pub fn file_path(device_id: &str, kind: FileKind, seq: u64) -> String {
    format!("{}/{}", device_dir(device_id), file_name(kind, seq))
}

/// 某条流的段文件路径（`devices/<id>[/conv|/sec]/seg-<seq>.msync`）。
pub fn stream_segment_path(device_id: &str, stream: RemoteStream, seq: u64) -> String {
    format!(
        "{}/{}",
        stream_dir(device_id, stream),
        file_name(FileKind::Segment, seq)
    )
}

/// 某条流的单文件快照路径（`devices/<id>[/sec]/snap-<seq>.msync`）。
pub fn stream_snapshot_path(device_id: &str, stream: RemoteStream, seq: u64) -> String {
    format!(
        "{}/{}",
        stream_dir(device_id, stream),
        file_name(FileKind::Snapshot, seq)
    )
}

/// 分包快照目录（`devices/<id>/conv/snap-<seq>`）。
pub fn snapshot_dir(device_id: &str, stream: RemoteStream, seq: u64) -> String {
    format!("{}/snap-{:012}", stream_dir(device_id, stream), seq)
}

/// 分包快照的索引（`…/snap-<seq>/index.msync`）。
pub fn snapshot_index_path(device_id: &str, stream: RemoteStream, seq: u64) -> String {
    format!(
        "{}/index.{}",
        snapshot_dir(device_id, stream, seq),
        FILE_EXT
    )
}

/// 分包快照的一个包（`…/snap-<seq>/part-0000.msync`）。
pub fn snapshot_part_path(device_id: &str, stream: RemoteStream, seq: u64, part: u32) -> String {
    format!(
        "{}/part-{:04}.{}",
        snapshot_dir(device_id, stream, seq),
        part,
        FILE_EXT
    )
}

/// 按内容寻址的大块（`devices/<id>/blob/<name>.msync`）。
pub fn blob_path(device_id: &str, name: &str) -> String {
    format!(
        "{}/{}.{}",
        stream_dir(device_id, RemoteStream::Blob),
        name,
        FILE_EXT
    )
}

/// 解析远端目录里的文件名；不是本应用的文件（探针、临时文件、别的东西）返回 `None`。
///
/// **只认配置流**（一期路径）。子目录名（`conv` / `sec` / `blob`）在这里返回 `None`，
/// 老版本客户端正是靠它安静跳过新版本的子目录。新的流用 [`parse_device_rel_path`]。
pub fn parse_file_name(name: &str) -> Option<(FileKind, u64)> {
    let stem = name.strip_suffix(&format!(".{FILE_EXT}"))?;
    let (kind, num) = if let Some(n) = stem.strip_prefix("seg-") {
        (FileKind::Segment, n)
    } else if let Some(n) = stem.strip_prefix("snap-") {
        (FileKind::Snapshot, n)
    } else {
        return None;
    };
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((kind, num.parse().ok()?))
}

fn parse_seq_stem(name: &str, prefix: &str) -> Option<u64> {
    let stem = name.strip_suffix(&format!(".{FILE_EXT}"))?;
    let num = stem.strip_prefix(prefix)?;
    if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    num.parse().ok()
}

/// blob 内容名：64 位小写十六进制（HMAC-SHA256 的十六进制表示）。
pub fn is_valid_blob_name(name: &str) -> bool {
    name.len() == 64 && name.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 解析一条**相对同步根目录**的路径，认出二、三期各条流的文件。
///
/// 支持（见契约第 1 节）：
/// ```text
/// devices/<id>/seg-N.msync               配置 · 段
/// devices/<id>/snap-N.msync              配置 · 快照
/// devices/<id>/conv/seg-N.msync          对话 · 段
/// devices/<id>/conv/snap-N/index.msync   对话 · 分包快照索引
/// devices/<id>/conv/snap-N/part-0000.msync
/// devices/<id>/sec/seg-N.msync           机密 · 段
/// devices/<id>/sec/snap-N.msync          机密 · 快照
/// devices/<id>/blob/<64hex>.msync        大块
/// ```
/// 其它一律 `None`（目录本身、探针、未知名字）。设备 id 来自远端，先过
/// [`is_valid_device_id`] 才敢用它拼路径。
pub fn parse_device_rel_path(path: &str) -> Option<ParsedRemoteFile> {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let ["devices", device, rest @ ..] = parts.as_slice() else {
        return None;
    };
    if !is_valid_device_id(device) {
        return None;
    }
    let device = device.to_string();
    let file = |stream, kind, seq, part, name| ParsedRemoteFile {
        device: device.clone(),
        stream,
        kind,
        seq,
        part,
        name,
    };
    match rest {
        [name] => match parse_file_name(name)? {
            (FileKind::Segment, seq) => Some(file(
                RemoteStream::Config,
                RemoteFileKind::Segment,
                seq,
                None,
                None,
            )),
            (FileKind::Snapshot, seq) => Some(file(
                RemoteStream::Config,
                RemoteFileKind::Snapshot,
                seq,
                None,
                None,
            )),
        },
        ["conv", name] => Some(file(
            RemoteStream::Conv,
            RemoteFileKind::Segment,
            parse_seq_stem(name, "seg-")?,
            None,
            None,
        )),
        ["sec", name] => {
            if let Some(seq) = parse_seq_stem(name, "seg-") {
                Some(file(
                    RemoteStream::Sec,
                    RemoteFileKind::Segment,
                    seq,
                    None,
                    None,
                ))
            } else {
                Some(file(
                    RemoteStream::Sec,
                    RemoteFileKind::Snapshot,
                    parse_seq_stem(name, "snap-")?,
                    None,
                    None,
                ))
            }
        }
        ["conv", snap, "index.msync"] => {
            let num = snap.strip_prefix("snap-")?;
            if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            Some(file(
                RemoteStream::Conv,
                RemoteFileKind::SnapshotIndex,
                num.parse().ok()?,
                None,
                None,
            ))
        }
        ["conv", snap, part] => {
            let num = snap.strip_prefix("snap-")?;
            if num.is_empty() || !num.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let seq = num.parse().ok()?;
            let stem = part.strip_suffix(&format!(".{FILE_EXT}"))?;
            let digits = stem.strip_prefix("part-")?;
            if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            let part = digits.parse().ok()?;
            Some(file(
                RemoteStream::Conv,
                RemoteFileKind::SnapshotPart,
                seq,
                Some(part),
                None,
            ))
        }
        ["blob", name] => {
            let stem = name.strip_suffix(&format!(".{FILE_EXT}"))?;
            if !is_valid_blob_name(stem) {
                return None;
            }
            Some(file(
                RemoteStream::Blob,
                RemoteFileKind::Blob,
                0,
                None,
                Some(stem.to_string()),
            ))
        }
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// 明文 JSON 结构
// ---------------------------------------------------------------------------

/// 写文件的设备的信息（出现在每个 seg / snap 里，「设备列表」就靠它）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    /// `"desktop"` / `"android"`；留作字符串，将来多出新平台旧版本也读得了。
    pub platform: String,
    pub app_version: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct SegmentFile {
    pub format: u32,
    pub device: DeviceInfo,
    pub seq: u64,
    pub ops: Vec<Op>,
    /// 写它的设备当时开着的档。缺省 = 只有配置档（老版本写的文件）。
    #[serde(default)]
    pub tiers: Option<TierSwitches>,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct SnapshotFile {
    pub format: u32,
    pub device: DeviceInfo,
    pub seq: u64,
    /// 同步源 key → 该源的完整镜像。
    pub mirrors: BTreeMap<String, Mirror>,
    /// 同步源 key → id 映射登记表（让读到快照的设备不必重新学习）。
    #[serde(default)]
    pub idmaps: BTreeMap<String, IdMapRegistry>,
    /// 写它的设备当时开着的档。缺省 = 只有配置档（老版本写的文件）。
    #[serde(default)]
    pub tiers: Option<TierSwitches>,
}

#[derive(Serialize)]
struct SegmentRef<'a> {
    format: u32,
    device: &'a DeviceInfo,
    seq: u64,
    ops: &'a [Op],
    tiers: TierSwitches,
}

#[derive(Serialize)]
struct SnapshotRef<'a> {
    format: u32,
    device: &'a DeviceInfo,
    seq: u64,
    mirrors: &'a BTreeMap<String, Mirror>,
    idmaps: &'a BTreeMap<String, IdMapRegistry>,
    tiers: TierSwitches,
}

/// 先看 `format` 再做结构化解析。
fn parse_checked<T: serde::de::DeserializeOwned>(plaintext: &[u8]) -> Result<T, FormatError> {
    let v: Value = serde_json::from_slice(plaintext)
        .map_err(|_| FormatError::Corrupt("不是有效的 JSON".into()))?;
    let format = v
        .get("format")
        .and_then(Value::as_u64)
        .ok_or_else(|| FormatError::Corrupt("缺少 format 字段".into()))?;
    if format > FORMAT_VERSION as u64 {
        return Err(FormatError::TooNew {
            found: u32::try_from(format).unwrap_or(u32::MAX),
            supported: FORMAT_VERSION,
        });
    }
    serde_json::from_value(v).map_err(|e| FormatError::Corrupt(format!("结构不符合预期：{e}")))
}

/// 只看 `format` 是否过新（给「先解密、后由各自的流解析」的路径用）。
///
/// 二、三期的段 / 快照结构由各自的驱动定义，但「格式过新要提示升级」是统一的：
/// 引擎在读任何远端文件时都要能识别出来，而不是当成损坏。
pub fn check_format(plaintext: &[u8]) -> Result<u64, FormatError> {
    let v: Value = serde_json::from_slice(plaintext)
        .map_err(|_| FormatError::Corrupt("不是有效的 JSON".into()))?;
    let format = v
        .get("format")
        .and_then(Value::as_u64)
        .ok_or_else(|| FormatError::Corrupt("缺少 format 字段".into()))?;
    if format > FORMAT_VERSION as u64 {
        return Err(FormatError::TooNew {
            found: u32::try_from(format).unwrap_or(u32::MAX),
            supported: FORMAT_VERSION,
        });
    }
    Ok(format)
}

/// 配置流的段明文（未加密）。驱动（`ConfigStreamDriver`）拿它生成待上传的段。
pub fn segment_plain(
    device: &DeviceInfo,
    seq: u64,
    ops: &[Op],
    tiers: TierSwitches,
) -> Result<Vec<u8>, FormatError> {
    serde_json::to_vec(&SegmentRef {
        format: FORMAT_VERSION,
        device,
        seq,
        ops,
        tiers,
    })
    .map_err(|e| FormatError::Corrupt(format!("序列化失败：{e}")))
}

/// 配置流的快照明文（未加密）。
pub fn snapshot_plain(
    device: &DeviceInfo,
    seq: u64,
    mirrors: &BTreeMap<String, Mirror>,
    idmaps: &BTreeMap<String, IdMapRegistry>,
    tiers: TierSwitches,
) -> Result<Vec<u8>, FormatError> {
    serde_json::to_vec(&SnapshotRef {
        format: FORMAT_VERSION,
        device,
        seq,
        mirrors,
        idmaps,
        tiers,
    })
    .map_err(|e| FormatError::Corrupt(format!("序列化失败：{e}")))
}

/// 编码一个增量段为密文（待 `put`）。`tiers` 是本机当前的三档开关（写进文件头，设备列表用）。
pub fn encode_segment(
    dk: &DataKey,
    device: &DeviceInfo,
    seq: u64,
    ops: &[Op],
    tiers: TierSwitches,
) -> Result<Vec<u8>, FormatError> {
    let json = serde_json::to_vec(&SegmentRef {
        format: FORMAT_VERSION,
        device,
        seq,
        ops,
        tiers,
    })
    .map_err(|e| FormatError::Corrupt(format!("序列化失败：{e}")))?;
    Ok(crypto::seal(
        dk,
        FileKind::Segment.as_str(),
        &device.id,
        seq,
        &json,
    )?)
}

/// 解码一个增量段。`device_id` / `seq` 取自文件所在目录与文件名（它们也是 AAD 的一部分）。
pub fn decode_segment(
    dk: &DataKey,
    device_id: &str,
    seq: u64,
    bytes: &[u8],
) -> Result<SegmentFile, FormatError> {
    let plain = crypto::open(dk, FileKind::Segment.as_str(), device_id, seq, bytes)?;
    let f: SegmentFile = parse_checked(&plain)?;
    check_identity(&f.device.id, f.seq, device_id, seq)?;
    Ok(f)
}

pub fn encode_snapshot(
    dk: &DataKey,
    device: &DeviceInfo,
    seq: u64,
    mirrors: &BTreeMap<String, Mirror>,
    idmaps: &BTreeMap<String, IdMapRegistry>,
    tiers: TierSwitches,
) -> Result<Vec<u8>, FormatError> {
    let json = serde_json::to_vec(&SnapshotRef {
        format: FORMAT_VERSION,
        device,
        seq,
        mirrors,
        idmaps,
        tiers,
    })
    .map_err(|e| FormatError::Corrupt(format!("序列化失败：{e}")))?;
    Ok(crypto::seal(
        dk,
        FileKind::Snapshot.as_str(),
        &device.id,
        seq,
        &json,
    )?)
}

pub fn decode_snapshot(
    dk: &DataKey,
    device_id: &str,
    seq: u64,
    bytes: &[u8],
) -> Result<SnapshotFile, FormatError> {
    let plain = crypto::open(dk, FileKind::Snapshot.as_str(), device_id, seq, bytes)?;
    let f: SnapshotFile = parse_checked(&plain)?;
    check_identity(&f.device.id, f.seq, device_id, seq)?;
    Ok(f)
}

/// 已解密的配置流快照明文 → 结构。
pub fn decode_snapshot_plain(
    device_id: &str,
    seq: u64,
    plaintext: &[u8],
) -> Result<SnapshotFile, FormatError> {
    let f: SnapshotFile = parse_checked(plaintext)?;
    check_identity(&f.device.id, f.seq, device_id, seq)?;
    Ok(f)
}

// ---------------------------------------------------------------------------
// 任意 JSON 的流文件（二、三期的 conv / sec 用）
// ---------------------------------------------------------------------------

/// 把一段**任意 JSON 明文**封成某条流的文件：AAD 由 `aad_tag` 决定（契约第 2 节）。
///
/// 二、三期的段 / 快照 JSON 结构由各自的驱动定义（按行 op、机密 op、分包快照索引……），
/// 这里只负责「压缩 + 加密 + AAD」这一层，避免每条流各写一遍信封代码。
/// 读回来用 [`open_json`]，调用方再自己 `serde_json::from_slice`。
pub fn seal_json(
    dk: &DataKey,
    aad_tag: &str,
    device_id: &str,
    seq: u64,
    plaintext: &[u8],
) -> Result<Vec<u8>, FormatError> {
    Ok(crypto::seal(dk, aad_tag, device_id, seq, plaintext)?)
}

/// [`seal_json`] 的逆操作。
pub fn open_json(
    dk: &DataKey,
    aad_tag: &str,
    device_id: &str,
    seq: u64,
    bytes: &[u8],
) -> Result<Vec<u8>, FormatError> {
    Ok(crypto::open(dk, aad_tag, device_id, seq, bytes)?)
}

/// 分包快照的一个包：AAD 多一段分包号。
pub fn seal_json_part(
    dk: &DataKey,
    aad_tag: &str,
    device_id: &str,
    seq: u64,
    part: u32,
    plaintext: &[u8],
) -> Result<Vec<u8>, FormatError> {
    Ok(crypto::seal_with_aad(
        dk,
        &crypto::aad_with_part(aad_tag, device_id, seq, part),
        plaintext,
    )?)
}

pub fn open_json_part(
    dk: &DataKey,
    aad_tag: &str,
    device_id: &str,
    seq: u64,
    part: u32,
    bytes: &[u8],
) -> Result<Vec<u8>, FormatError> {
    Ok(crypto::open_with_aad(
        dk,
        &crypto::aad_with_part(aad_tag, device_id, seq, part),
        bytes,
    )?)
}

/// 按内容寻址的大块：AAD 用内容名代替序号。
pub fn seal_blob(
    dk: &DataKey,
    device_id: &str,
    name: &str,
    plaintext: &[u8],
) -> Result<Vec<u8>, FormatError> {
    Ok(crypto::seal_with_aad(
        dk,
        &crypto::aad_named(aad_tag::BLOB, device_id, name),
        plaintext,
    )?)
}

pub fn open_blob(
    dk: &DataKey,
    device_id: &str,
    name: &str,
    bytes: &[u8],
) -> Result<Vec<u8>, FormatError> {
    Ok(crypto::open_with_aad(
        dk,
        &crypto::aad_named(aad_tag::BLOB, device_id, name),
        bytes,
    )?)
}

/// 明文里自称的设备 id / seq 必须与文件位置一致（AAD 已经保证了这一点，这里是第二道、便宜的自检）。
fn check_identity(
    inner_id: &str,
    inner_seq: u64,
    device_id: &str,
    seq: u64,
) -> Result<(), FormatError> {
    if inner_id != device_id || inner_seq != seq {
        return Err(FormatError::Corrupt("文件内容与它所在的位置不一致".into()));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// meta（明文，放在远端根目录）
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncMeta {
    pub format: u32,
    /// base64。
    pub salt: String,
    /// base64。
    pub wrapped_key: String,
    pub created_at: String,
}

impl SyncMeta {
    pub fn new(wrapped: WrappedKey, created_at: impl Into<String>) -> Self {
        SyncMeta {
            format: FORMAT_VERSION,
            salt: wrapped.salt,
            wrapped_key: wrapped.wrapped_key,
            created_at: created_at.into(),
        }
    }

    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec_pretty(self).expect("SyncMeta 可序列化")
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, FormatError> {
        parse_checked(bytes)
    }

    /// 用恢复密钥解出数据密钥。RK 不对 → `FormatError::Crypto(WrongKey)`。
    pub fn unwrap_data_key(&self, rk: &RecoveryKey) -> Result<DataKey, FormatError> {
        Ok(crypto::unwrap_data_key(rk, &self.salt, &self.wrapped_key)?)
    }
}

// ---------------------------------------------------------------------------
// 同步码
// ---------------------------------------------------------------------------

/// 同步码里装的东西。**本身就是机密**（含恢复密钥，可能含存储密码），不加密——
/// 它的用途就是让新设备一步拿到所有加入所需，保护靠用户当钥匙对待。
///
/// `S` 是存储配置的类型（运行时用 `StorageConfig`；core 不依赖存储模块，默认当 JSON 值）。
#[derive(Serialize, Deserialize)]
pub struct SyncCodePayload<S = Value> {
    pub storage: S,
    /// 存储密码（WebDAV 的应用密码 / SFTP 连接的密码）或空串。
    #[serde(default)]
    pub secret: String,
    /// 恢复密钥（规范形式）。
    pub rk: String,
    /// 存储是 SFTP 时，带上那条连接的 JSON 与主机指纹（由运行时定结构）。
    #[serde(
        rename = "sftpConnection",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sftp_connection: Option<Value>,
}

impl<S> Drop for SyncCodePayload<S> {
    fn drop(&mut self) {
        self.secret.zeroize();
        self.rk.zeroize();
    }
}

impl<S> std::fmt::Debug for SyncCodePayload<S> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SyncCodePayload(<redacted>)")
    }
}

/// 编码成 `MSYNC1-<base64url>`。
pub fn encode_sync_code<S: Serialize>(
    payload: &SyncCodePayload<S>,
) -> Result<Zeroizing<String>, FormatError> {
    let json = Zeroizing::new(
        serde_json::to_vec(payload).map_err(|_| FormatError::Corrupt("同步码序列化失败".into()))?,
    );
    let mut out = Zeroizing::new(String::with_capacity(
        SYNC_CODE_PREFIX.len() + json.len() * 4 / 3 + 4,
    ));
    out.push_str(SYNC_CODE_PREFIX);
    out.push_str(&B64URL.encode(&json[..]));
    Ok(out)
}

/// 解析同步码。容忍首尾空白与中间的换行 / 空格（从聊天、二维码扫描里粘贴出来常有）。
///
/// 错误文案不回显输入内容。
pub fn decode_sync_code<S: serde::de::DeserializeOwned>(
    code: &str,
) -> Result<SyncCodePayload<S>, FormatError> {
    let cleaned: Zeroizing<String> =
        Zeroizing::new(code.chars().filter(|c| !c.is_whitespace()).collect());
    let Some(body) = cleaned.strip_prefix(SYNC_CODE_PREFIX) else {
        // 「MSYNC2-」这类将来的版本：让用户去升级而不是报"无效"
        if let Some(rest) = cleaned.strip_prefix("MSYNC") {
            let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
            if let (Ok(v), Some('-')) = (digits.parse::<u32>(), rest[digits.len()..].chars().next())
            {
                if v > 1 {
                    return Err(FormatError::TooNew {
                        found: v,
                        supported: 1,
                    });
                }
            }
        }
        return Err(FormatError::Corrupt("不是有效的同步码".into()));
    };
    let json = Zeroizing::new(
        B64URL
            .decode(body)
            .map_err(|_| FormatError::Corrupt("同步码不完整或有错字".into()))?,
    );
    serde_json::from_slice(&json).map_err(|_| FormatError::Corrupt("同步码内容无法识别".into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::core::hlc::Hlc;
    use crate::sync::core::mirror::OpKind;
    use crate::sync::core::path::Seg;
    use serde_json::json;

    fn dev(id: &str) -> DeviceInfo {
        DeviceInfo {
            id: id.into(),
            name: "我的电脑".into(),
            platform: "desktop".into(),
            app_version: "1.12.0".into(),
        }
    }

    fn sample_ops() -> Vec<Op> {
        vec![
            Op {
                source: "settings".into(),
                path: vec![Seg::key("theme")],
                kind: OpKind::Set(json!("dark")),
                hlc: Hlc {
                    ms: 1_700_000_000_000,
                    counter: 0,
                    device: "d1".into(),
                },
            },
            Op {
                source: "connections".into(),
                path: vec![Seg::key("connections"), Seg::id("c1")],
                kind: OpKind::Tombstone,
                hlc: Hlc {
                    ms: 1_700_000_000_001,
                    counter: 2,
                    device: "d1".into(),
                },
            },
        ]
    }

    // ---------------- 文件名 ----------------

    #[test]
    fn file_names_round_trip() {
        assert_eq!(file_name(FileKind::Segment, 12), "seg-000000000012.msync");
        assert_eq!(file_name(FileKind::Snapshot, 40), "snap-000000000040.msync");
        assert_eq!(
            file_path("abc123", FileKind::Segment, 1),
            "devices/abc123/seg-000000000001.msync"
        );
        for (kind, seq) in [(FileKind::Segment, 0), (FileKind::Snapshot, 123456789012)] {
            assert_eq!(parse_file_name(&file_name(kind, seq)), Some((kind, seq)));
        }
    }

    #[test]
    fn parse_file_name_rejects_foreign_files() {
        for bad in [
            "",
            "seg-1.txt",
            "seg-.msync",
            "seg-12a.msync",
            "seg--1.msync",
            "foo-000000000001.msync",
            ".tmp-abc",
            "seg-000000000001.msync.tmp",
            "marcel-sync.json",
            "seg-99999999999999999999999.msync", // 溢出 u64
        ] {
            assert_eq!(parse_file_name(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn device_id_validation_blocks_path_tricks() {
        assert!(is_valid_device_id(&new_device_id()));
        assert!(is_valid_device_id("abc-DEF_123"));
        for bad in [
            "",
            "..",
            ".",
            "a/b",
            "a\\b",
            "a b",
            "../x",
            "中文",
            &"a".repeat(65),
            "a\0b",
        ] {
            assert!(!is_valid_device_id(bad), "{bad:?}");
        }
        let id = new_device_id();
        assert_eq!(id.len(), 32);
        assert!(!id.contains('-'));
    }

    // ---------------- 段与快照 ----------------

    #[test]
    fn segment_round_trip() {
        let dk = DataKey::generate().unwrap();
        let ops = sample_ops();
        let bytes = encode_segment(&dk, &dev("d1"), 7, &ops, TierSwitches::default()).unwrap();
        let back = decode_segment(&dk, "d1", 7, &bytes).unwrap();
        assert_eq!(back.format, FORMAT_VERSION);
        assert_eq!(back.seq, 7);
        assert_eq!(back.device, dev("d1"));
        assert_eq!(back.ops, ops);
    }

    #[test]
    fn segment_cannot_be_replayed_from_another_place() {
        let dk = DataKey::generate().unwrap();
        let bytes =
            encode_segment(&dk, &dev("d1"), 7, &sample_ops(), TierSwitches::default()).unwrap();
        assert!(decode_segment(&dk, "d1", 8, &bytes).is_err());
        assert!(decode_segment(&dk, "d2", 7, &bytes).is_err());
        // 当快照读也不行
        assert!(decode_snapshot(&dk, "d1", 7, &bytes).is_err());
    }

    #[test]
    fn snapshot_round_trip_with_mirrors_and_idmaps() {
        let dk = DataKey::generate().unwrap();
        let mut mirrors = BTreeMap::new();
        let mut m = Mirror::new();
        for o in sample_ops() {
            m.merge(&o);
        }
        mirrors.insert("settings".to_string(), m.clone());
        let mut idmaps = BTreeMap::new();
        let mut reg = IdMapRegistry::new();
        reg.register_array(&[Seg::key("connections")]);
        idmaps.insert("connections".to_string(), reg.clone());

        let bytes = encode_snapshot(
            &dk,
            &dev("d1"),
            40,
            &mirrors,
            &idmaps,
            TierSwitches::default(),
        )
        .unwrap();
        let back = decode_snapshot(&dk, "d1", 40, &bytes).unwrap();
        assert_eq!(back.seq, 40);
        assert_eq!(back.mirrors["settings"], m);
        assert_eq!(back.idmaps["connections"], reg);
    }

    /// 段 / 快照头里的 `tiers`：写进去、读回来一致；老文件（没有这个字段）读成 `None`
    /// 并由调用方当「只有配置档」处理。
    #[test]
    fn tiers_round_trip_and_old_files_without_tiers_still_read() {
        let dk = DataKey::generate().unwrap();
        let tiers = TierSwitches {
            config: true,
            conversation: true,
            secret: false,
        };
        let bytes = encode_segment(&dk, &dev("d1"), 3, &sample_ops(), tiers).unwrap();
        assert_eq!(
            decode_segment(&dk, "d1", 3, &bytes).unwrap().tiers,
            Some(tiers)
        );

        let bytes = encode_snapshot(
            &dk,
            &dev("d1"),
            4,
            &BTreeMap::new(),
            &BTreeMap::new(),
            tiers,
        )
        .unwrap();
        assert_eq!(
            decode_snapshot(&dk, "d1", 4, &bytes).unwrap().tiers,
            Some(tiers)
        );

        // 老版本（一期）写的文件：没有 tiers 字段
        let old = json!({
            "format": 1,
            "device": {"id": "d1", "name": "n", "platform": "desktop", "appVersion": "1.0.0"},
            "seq": 5,
            "ops": [],
        });
        let env = crypto::seal(
            &dk,
            FileKind::Segment.as_str(),
            "d1",
            5,
            old.to_string().as_bytes(),
        )
        .unwrap();
        let f = decode_segment(&dk, "d1", 5, &env).unwrap();
        assert_eq!(f.tiers, None, "老文件读成 None = 只有配置档");
        assert!(TierSwitches::config_only().config);
        assert!(!TierSwitches::config_only().conversation);

        // 序列化确实写了这个字段（设备列表靠它判断对方开了哪几档）
        let v: Value = serde_json::from_slice(
            &crypto::open(
                &dk,
                FileKind::Segment.as_str(),
                "d1",
                3,
                &encode_segment(&dk, &dev("d1"), 3, &[], tiers).unwrap(),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(
            v["tiers"],
            json!({"config": true, "conversation": true, "secret": false})
        );
        // 缺省的 TierSwitches = 只开配置档
        assert_eq!(
            serde_json::to_value(TierSwitches::default()).unwrap(),
            json!({"config": true, "conversation": false, "secret": false})
        );
        let read: TierSwitches = serde_json::from_str("{}").unwrap();
        assert_eq!(read, TierSwitches::default());
    }

    // ---------------- 流子目录 ----------------

    #[test]
    fn stream_paths_round_trip_through_the_parser() {
        let id = "abc123";
        let tag = "ff".repeat(32);
        let cases = [
            (
                stream_segment_path(id, RemoteStream::Config, 7),
                RemoteFileKind::Segment,
                RemoteStream::Config,
                7,
                None,
            ),
            (
                stream_snapshot_path(id, RemoteStream::Config, 8),
                RemoteFileKind::Snapshot,
                RemoteStream::Config,
                8,
                None,
            ),
            (
                stream_segment_path(id, RemoteStream::Conv, 9),
                RemoteFileKind::Segment,
                RemoteStream::Conv,
                9,
                None,
            ),
            (
                snapshot_index_path(id, RemoteStream::Conv, 10),
                RemoteFileKind::SnapshotIndex,
                RemoteStream::Conv,
                10,
                None,
            ),
            (
                snapshot_part_path(id, RemoteStream::Conv, 10, 3),
                RemoteFileKind::SnapshotPart,
                RemoteStream::Conv,
                10,
                Some(3),
            ),
            (
                stream_segment_path(id, RemoteStream::Sec, 11),
                RemoteFileKind::Segment,
                RemoteStream::Sec,
                11,
                None,
            ),
            (
                stream_snapshot_path(id, RemoteStream::Sec, 12),
                RemoteFileKind::Snapshot,
                RemoteStream::Sec,
                12,
                None,
            ),
            (
                blob_path(id, &tag),
                RemoteFileKind::Blob,
                RemoteStream::Blob,
                0,
                None,
            ),
        ];
        for (path, kind, stream, seq, part) in cases {
            let p = parse_device_rel_path(&path).unwrap_or_else(|| panic!("解析失败: {path}"));
            assert_eq!(p.device, id, "{path}");
            assert_eq!(p.kind, kind, "{path}");
            assert_eq!(p.stream, stream, "{path}");
            assert_eq!(p.seq, seq, "{path}");
            assert_eq!(p.part, part, "{path}");
        }
        assert_eq!(
            parse_device_rel_path(&blob_path(id, &tag)).unwrap().name,
            Some(tag)
        );
        // 配置流的两个路径与一期逐字一致
        assert_eq!(
            stream_segment_path(id, RemoteStream::Config, 7),
            "devices/abc123/seg-000000000007.msync"
        );
        assert_eq!(
            stream_snapshot_path(id, RemoteStream::Config, 8),
            "devices/abc123/snap-000000000008.msync"
        );
    }

    #[test]
    fn directory_names_and_foreign_paths_are_not_files() {
        // 老版本客户端列到的是「目录项」，不是文件名：parse_file_name 必须返回 None，
        // 这样老版本的 pull_device 里 `parse_file_name(&f.name)` 自然跳过、不报错。
        for dir in ["conv", "sec", "blob", "snap-000000000001"] {
            assert_eq!(parse_file_name(dir), None, "{dir}");
        }
        for path in [
            "devices/abc/conv",
            "devices/abc/sec",
            "devices/abc/blob",
            "devices/abc/conv/snap-000000000001",
            "devices/abc/other/seg-000000000001.msync",
            "devices/abc/conv/snap-000000000001/index.msync.tmp",
            "devices/abc/conv/seg-1.txt",
            "devices/abc/conv/snap-x/index.msync",
            "devices/abc/conv/snap-1/part-x.msync",
            "devices/abc/blob/not-hex.msync",
            "devices/../seg-000000000001.msync",
            "other/abc/seg-000000000001.msync",
        ] {
            assert_eq!(parse_device_rel_path(path), None, "{path:?}");
        }
        // blob 名字必须恰好 64 位十六进制
        assert!(is_valid_blob_name(&"a".repeat(64)));
        assert!(!is_valid_blob_name(&"a".repeat(63)));
        assert!(!is_valid_blob_name(&"A".repeat(64)));
        assert!(!is_valid_blob_name(&"g".repeat(64)));
    }

    /// 任意 JSON 的流信封：AAD 串流解不开、分包号 / blob 名字都在 AAD 里。
    #[test]
    fn generic_stream_envelopes_are_bound_to_their_aad() {
        let dk = DataKey::generate().unwrap();
        let plain = br#"{"format":1,"stream":"conv","ops":[]}"#;
        let env = seal_json(&dk, aad_tag::CONV_SEG, "d1", 5, plain).unwrap();
        assert_eq!(
            open_json(&dk, aad_tag::CONV_SEG, "d1", 5, &env).unwrap(),
            plain
        );
        assert!(open_json(&dk, aad_tag::SEC_SEG, "d1", 5, &env).is_err());
        assert!(open_json(&dk, aad_tag::CONV_SEG, "d2", 5, &env).is_err());
        assert!(open_json(&dk, aad_tag::CONV_SEG, "d1", 6, &env).is_err());

        let part = seal_json_part(&dk, aad_tag::CONV_SNAP_PART, "d1", 5, 2, plain).unwrap();
        assert_eq!(
            open_json_part(&dk, aad_tag::CONV_SNAP_PART, "d1", 5, 2, &part).unwrap(),
            plain
        );
        assert!(open_json_part(&dk, aad_tag::CONV_SNAP_PART, "d1", 5, 3, &part).is_err());

        let name = "b".repeat(64);
        let blob = seal_blob(&dk, "d1", &name, b"png bytes").unwrap();
        assert_eq!(open_blob(&dk, "d1", &name, &blob).unwrap(), b"png bytes");
        assert!(open_blob(&dk, "d1", &"c".repeat(64), &blob).is_err());
        assert!(open_blob(&dk, "d2", &name, &blob).is_err());
    }

    #[test]
    fn unknown_extra_fields_are_tolerated() {
        // 「加字段不升 format」：旧版本读到带新字段的文件照常工作
        let dk = DataKey::generate().unwrap();
        let json = json!({
            "format": 1,
            "device": {"id": "d1", "name": "n", "platform": "ios", "appVersion": "9.9.9", "futureField": 1},
            "seq": 3,
            "ops": [],
            "brandNewTopLevel": {"x": 1},
        });
        let env = crypto::seal(
            &dk,
            FileKind::Segment.as_str(),
            "d1",
            3,
            json.to_string().as_bytes(),
        )
        .unwrap();
        let f = decode_segment(&dk, "d1", 3, &env).unwrap();
        assert_eq!(f.device.platform, "ios");
        assert!(f.ops.is_empty());
    }

    #[test]
    fn newer_format_is_reported_as_too_new_before_parsing_structure() {
        let dk = DataKey::generate().unwrap();
        // 新格式的 ops 形状本版本根本解析不了——必须先看 format
        let json = json!({"format": 2, "device": 5, "seq": "x", "ops": "different shape"});
        let env = crypto::seal(
            &dk,
            FileKind::Segment.as_str(),
            "d1",
            3,
            json.to_string().as_bytes(),
        )
        .unwrap();
        let err = decode_segment(&dk, "d1", 3, &env).unwrap_err();
        assert!(err.is_too_new(), "{err}");
        assert!(matches!(
            err,
            FormatError::TooNew {
                found: 2,
                supported: 1
            }
        ));
        assert!(err.to_string().contains("升级"));
    }

    #[test]
    fn newer_envelope_version_maps_to_too_new() {
        let dk = DataKey::generate().unwrap();
        let mut env = encode_segment(&dk, &dev("d1"), 1, &[], TierSwitches::default()).unwrap();
        env[5] = 9;
        let err = decode_segment(&dk, "d1", 1, &env).unwrap_err();
        assert!(err.is_too_new());
    }

    #[test]
    fn missing_or_garbage_format_is_corrupt_not_too_new() {
        let dk = DataKey::generate().unwrap();
        for body in [
            r#"{"seq":1}"#,
            r#"{"format":"1"}"#,
            "not json",
            r#"{"format":-1}"#,
        ] {
            let env =
                crypto::seal(&dk, FileKind::Segment.as_str(), "d1", 1, body.as_bytes()).unwrap();
            let err = decode_segment(&dk, "d1", 1, &env).unwrap_err();
            assert!(matches!(err, FormatError::Corrupt(_)), "{body}: {err}");
        }
    }

    #[test]
    fn inner_identity_must_match_file_position() {
        let dk = DataKey::generate().unwrap();
        // 用合法 AAD 封装、但内容自称是别的设备 / 别的 seq
        let json = json!({"format": 1, "device": dev("other"), "seq": 3, "ops": []});
        let env = crypto::seal(
            &dk,
            FileKind::Segment.as_str(),
            "d1",
            3,
            json.to_string().as_bytes(),
        )
        .unwrap();
        assert!(matches!(
            decode_segment(&dk, "d1", 3, &env),
            Err(FormatError::Corrupt(_))
        ));
        let json = json!({"format": 1, "device": dev("d1"), "seq": 4, "ops": []});
        let env = crypto::seal(
            &dk,
            FileKind::Segment.as_str(),
            "d1",
            3,
            json.to_string().as_bytes(),
        )
        .unwrap();
        assert!(matches!(
            decode_segment(&dk, "d1", 3, &env),
            Err(FormatError::Corrupt(_))
        ));
    }

    #[test]
    fn wrong_key_and_tampering_surface_as_crypto_errors() {
        let dk = DataKey::generate().unwrap();
        let bytes =
            encode_segment(&dk, &dev("d1"), 1, &sample_ops(), TierSwitches::default()).unwrap();
        let other = DataKey::generate().unwrap();
        assert!(matches!(
            decode_segment(&other, "d1", 1, &bytes),
            Err(FormatError::Crypto(CryptoError::Decrypt))
        ));
        let mut bad = bytes.clone();
        let n = bad.len();
        bad[n / 2] ^= 0xff;
        assert!(decode_segment(&dk, "d1", 1, &bad).is_err());
    }

    // ---------------- meta ----------------

    #[test]
    fn meta_json_shape_and_round_trip() {
        let (rk, dk, wrapped) = crypto::generate_vault().unwrap();
        let meta = SyncMeta::new(wrapped, "2026-10-29T12:00:00Z");
        let bytes = meta.to_bytes();
        let v: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(v["format"], json!(1));
        assert!(v["salt"].is_string());
        assert!(v["wrappedKey"].is_string());
        assert_eq!(v["createdAt"], json!("2026-10-29T12:00:00Z"));
        let back = SyncMeta::from_bytes(&bytes).unwrap();
        assert_eq!(back, meta);
        assert_eq!(back.unwrap_data_key(&rk).unwrap(), dk);
    }

    #[test]
    fn meta_with_wrong_rk_says_wrong_key() {
        let (_rk, _dk, wrapped) = crypto::generate_vault().unwrap();
        let meta = SyncMeta::new(wrapped, "t");
        let other = RecoveryKey::generate().unwrap();
        assert!(matches!(
            meta.unwrap_data_key(&other),
            Err(FormatError::Crypto(CryptoError::WrongKey))
        ));
    }

    #[test]
    fn meta_newer_format_is_too_new() {
        let bytes = br#"{"format":2,"somethingElse":true}"#;
        assert!(SyncMeta::from_bytes(bytes).unwrap_err().is_too_new());
    }

    // ---------------- 同步码 ----------------

    #[test]
    fn sync_code_round_trip() {
        let payload = SyncCodePayload {
            storage: json!({"kind": "webDav", "url": "https://dav.example.com/dav/", "username": "u", "root": "marcel-sync"}),
            secret: "app-password".into(),
            rk: RecoveryKey::generate().unwrap().canonical().to_string(),
            sftp_connection: Some(json!({"host": "h", "fingerprint": "SHA256:xx"})),
        };
        let code = encode_sync_code(&payload).unwrap();
        assert!(code.starts_with("MSYNC1-"));
        assert!(!code.contains(char::is_whitespace));
        let back: SyncCodePayload = decode_sync_code(&code).unwrap();
        assert_eq!(back.storage, payload.storage);
        assert_eq!(back.secret, "app-password");
        assert_eq!(back.rk, payload.rk);
        assert_eq!(back.sftp_connection, payload.sftp_connection);
    }

    #[test]
    fn sync_code_without_optional_parts() {
        let payload: SyncCodePayload = SyncCodePayload {
            storage: json!({"kind": "sftp"}),
            secret: String::new(),
            rk: "abc".into(),
            sftp_connection: None,
        };
        let code = encode_sync_code(&payload).unwrap();
        let back: SyncCodePayload = decode_sync_code(&code).unwrap();
        assert!(back.sftp_connection.is_none());
        assert_eq!(back.secret, "");
    }

    #[test]
    fn sync_code_is_whitespace_tolerant_for_pasting() {
        let payload: SyncCodePayload = SyncCodePayload {
            storage: json!({"k": 1}),
            secret: "s".into(),
            rk: "r".into(),
            sftp_connection: None,
        };
        let code = encode_sync_code(&payload).unwrap();
        let mid = code.len() / 2;
        let messy = format!("  {}\n{} \r\n", &code[..mid], &code[mid..]);
        let back: SyncCodePayload = decode_sync_code(&messy).unwrap();
        assert_eq!(back.rk, "r");
    }

    #[test]
    fn sync_code_rejects_garbage_without_echoing_it() {
        for bad in [
            "",
            "hello",
            "MSYNC1-",
            "MSYNC1-!!!!",
            "MSYNC1-aGVsbG8",
            "XSYNC1-abcd",
        ] {
            let err = decode_sync_code::<Value>(bad).unwrap_err();
            let msg = err.to_string();
            assert!(matches!(err, FormatError::Corrupt(_)), "{bad:?}");
            if !bad.is_empty() {
                assert!(!msg.contains(bad), "错误文案回显了输入：{msg}");
            }
        }
    }

    #[test]
    fn sync_code_from_a_future_version_asks_to_upgrade() {
        let err = decode_sync_code::<Value>("MSYNC2-abcdef").unwrap_err();
        assert!(err.is_too_new());
        let err = decode_sync_code::<Value>("MSYNC12-abcdef").unwrap_err();
        assert!(err.is_too_new());
    }

    #[test]
    fn sync_code_payload_debug_is_redacted() {
        let p: SyncCodePayload = SyncCodePayload {
            storage: json!({}),
            secret: "hunter2".into(),
            rk: "supersecretkey".into(),
            sftp_connection: None,
        };
        let s = format!("{p:?}");
        assert!(!s.contains("hunter2") && !s.contains("supersecretkey"));
    }

    #[test]
    fn errors_convert_to_app_error_without_secrets() {
        let e: AppError = FormatError::TooNew {
            found: 2,
            supported: 1,
        }
        .into();
        assert!(e.to_string().contains("升级"));
        let e: AppError = CryptoError::WrongKey.into();
        assert!(e.to_string().contains("恢复密钥"));
    }
}
