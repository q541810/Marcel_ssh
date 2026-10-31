//! 同步的「流」抽象：一台设备的远端目录分成几条互相独立的流，每条流有自己的序号、
//! 游标、压缩计数和 AAD 前缀。
//!
//! ```text
//! config  配置（一期，devices/<id>/seg-…）          恒为开
//! conv    对话与记忆（二期，devices/<id>/conv/…）   conversation 档
//! sec     机密（三期，devices/<id>/sec/…）          secret 档
//! ```
//!
//! 引擎只认 [`StreamDriver`]：捕获 → 上传 → 拉取 → 落地 → 再捕获 → 压缩，每一步都由驱动
//! 自己决定怎么做（配置流还是那套 JSON 叶子镜像，对话流是按行后写者赢，机密流是加密 op）。
//! 引擎负责**编排**：挑开着的流、按顺序调驱动、按流记账与报错——一条流失败不影响别的流。
//!
//! [`StreamRemote`] 是引擎交给驱动的远端只读视图：驱动只能按流拼好的路径与 AAD 读，
//! 拿不到 DK 本身。上传方向由引擎按 [`aad_tag_for`] 封包，驱动只给明文。
//!
//! 本模块的 `StreamName` / `TierSwitches` 定义在 [`crate::sync::store`]（账本按流存状态，
//! 依赖方向是 `streams → store`），这里原样再导出，契约里的 `sync::streams::StreamName` 照样可用。

use std::collections::BTreeMap;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

use std::sync::Arc;

use super::backends::Backend;
use super::core::crypto::DataKey;
use super::core::format::{self, FormatError};
use super::storage::{RemoteEntry, StorageError};
use crate::error::AppError;

pub mod config;
pub mod sec;

pub use super::store::{StreamName, TierSwitches};
pub use config::ConfigStreamDriver;

/// 一个远端文件的种类（相对它所在的流）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StreamFileKind {
    Segment,
    Snapshot,
    /// 分包快照的索引（`conv/snap-<seq>/index.msync`）。
    SnapshotIndex,
    /// 分包快照的一个包（`conv/snap-<seq>/part-<i:04>.msync`）。
    SnapshotPart,
}

impl StreamFileKind {
    /// 分包快照才有 part。
    pub fn needs_part(self) -> bool {
        matches!(self, StreamFileKind::SnapshotPart)
    }
}

/// 引擎交给流的一张「远端只读视图」：只读、按流拼好 AAD。
#[async_trait]
pub trait StreamRemote: Send + Sync {
    /// 对端设备 id（AAD 用）。
    fn peer(&self) -> &str;
    /// 这条视图对应哪条流。
    fn stream(&self) -> StreamName;
    async fn list(&self, dir: &str) -> Result<Vec<RemoteEntry>, StorageError>;
    async fn get(&self, path: &str) -> Result<Option<Vec<u8>>, StorageError>;
    /// 解密本流的一个文件。`part` 只有分页快照才用（`None` = 非分页）。
    fn open(
        &self,
        kind: StreamFileKind,
        seq: u64,
        part: Option<u32>,
        bytes: &[u8],
    ) -> Result<Vec<u8>, FormatError>;
}

/// 一次落地 / 捕获的结果。
#[derive(Default, Debug)]
pub struct StreamApplied {
    pub changed: bool,
    /// 落地后要随 `sync-data-applied` 告诉前端的会话 id（conv 用，其它留空）。
    pub conversation_ids: Vec<String>,
    /// 供 `sync_status` 显示的进度（首次加入时「已同步 N / 共 M 段对话」）。
    pub progress: Option<StreamProgress>,
}

/// `sync_status.streams[].progress`（契约第 8 节）。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamProgress {
    pub done: usize,
    pub total: usize,
    pub label: String,
}

/// 快照的远端布局：单文件（配置 / 机密）还是目录 + 分包（对话）。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum StreamSnapshotLayout {
    /// `devices/<id>[/sec]/snap-<seq>.msync`
    SingleFile,
    /// `devices/<id>/conv/snap-<seq>/…`（`files` 的 key 是相对这个目录的名字）
    #[default]
    Directory,
}

/// `make_snapshot` 的产物：文件名（相对快照目录）→ 明文。
pub struct StreamSnapshot {
    pub files: BTreeMap<String, Vec<u8>>,
    pub total_items: usize,
}

#[async_trait]
pub trait StreamDriver: Send + Sync {
    fn name(&self) -> StreamName;

    /// 这条流自己的账本（序号、对每台设备的游标、压缩计数、是否落地过）。
    ///
    /// **引擎是权威**：序号由引擎分配、游标由引擎推进、压缩计数由引擎累加，都写在
    /// `state.json` 里。驱动只是在构造时拿到一份起始状态（`StreamDriverFactory::create`），
    /// 需要自己记内部进度时覆盖这两个方法把状态同步回来；不需要就保持默认（空实现）。
    fn state(&self) -> super::store::StreamState {
        super::store::StreamState::default()
    }

    fn set_state(&mut self, _state: super::store::StreamState) {}

    /// 捕获本机改动，返回待上传的明文段（已序列化 JSON，每段 ≤ 1 MB）。
    /// 返回空 = 没有改动。**上传成功、账本落盘之后**引擎才调 `ack_capture`。
    ///
    /// 约定：第 1 段用序号 `state.seq + 1`、第 2 段 `state.seq + 2`……（引擎上传时按同样顺序
    /// 递增并写进账本）。驱动要把序号写进明文 JSON 里——这样段的身份（AAD、文件名、内容自称
    /// 的 seq）始终一致。
    async fn capture(&mut self) -> Result<Vec<Vec<u8>>, AppError>;
    async fn ack_capture(&mut self) -> Result<(), AppError> {
        Ok(())
    }

    /// 全量导出（首次开启该档 / 服务端还没有本机数据时）：返回若干明文段。
    async fn export_full(&mut self) -> Result<Vec<Vec<u8>>, AppError>;

    /// 落地一个远端增量段（明文 JSON）。只更新这条流的镜像 / 缓存；真正写进本机数据的时机
    /// 由 [`Self::land`] 统一决定（配置流要等所有设备读完再一次性对齐，行为与一期一致）。
    async fn apply_segment(&mut self, plain: &[u8]) -> Result<StreamApplied, AppError>;

    /// 把已吸收的远端改动写进本机数据。引擎在拉取完所有设备后调用一次。
    async fn land(&mut self) -> Result<StreamApplied, AppError> {
        Ok(StreamApplied::default())
    }

    /// 本机增量段攒够 `COMPACT_AFTER_SEGS` 后调用，生成快照。`None` = 这条流不做快照。
    async fn make_snapshot(&mut self) -> Result<Option<StreamSnapshot>, AppError> {
        Ok(None)
    }

    /// 快照的远端布局。配置流是单文件，对话流是分包目录。
    fn snapshot_layout(&self) -> StreamSnapshotLayout {
        StreamSnapshotLayout::Directory
    }

    /// 拉取并落地远端快照。driver 自己决定要不要分包、按什么顺序拉。
    /// `remote` 只读；`index_seq` 是该快照的序号。
    async fn apply_snapshot(
        &mut self,
        remote: &dyn StreamRemote,
        index_seq: u64,
    ) -> Result<StreamApplied, AppError> {
        let _ = (remote, index_seq);
        Ok(StreamApplied::default())
    }
}

/// 二、三期的流驱动构造器：引擎构造时登记进 `SyncDeps::stream_drivers`。
///
/// 每轮开始时引擎把账本里这条流的 `StreamState` 交给它构造一个驱动，结束后再取回来写回。
/// T0 只有配置流的驱动（引擎内部直接构造），这个列表为空。
pub trait StreamDriverFactory: Send + Sync {
    fn name(&self) -> StreamName;
    /// `dk` 只有引擎在「需要封包 / 解本机镜像」的阶段才给得出（捕获阶段可能是 `None`）。
    fn create(
        &self,
        state: super::store::StreamState,
        dk: Option<DataKey>,
    ) -> Result<Box<dyn StreamDriver>, AppError>;

    /// 这条流的待上传条数（`sync_status.streams[].pending`）。0 = 不显示。
    fn pending(&self) -> usize {
        0
    }
}

/// 一条流的 AAD tag（契约第 2 节）。引擎用它封包 / 解释远端文件名。
pub fn aad_tag_for(stream: StreamName, kind: StreamFileKind) -> &'static str {
    use super::core::crypto::aad_tag;
    match (stream, kind) {
        (StreamName::Config, StreamFileKind::Segment) => aad_tag::CONFIG_SEG,
        (StreamName::Config, StreamFileKind::Snapshot) => aad_tag::CONFIG_SNAP,
        (StreamName::Conv, StreamFileKind::Segment) => aad_tag::CONV_SEG,
        (StreamName::Conv, StreamFileKind::SnapshotIndex) => aad_tag::CONV_SNAP_INDEX,
        (StreamName::Conv, StreamFileKind::SnapshotPart) => aad_tag::CONV_SNAP_PART,
        // 对话流只用分包快照；单文件快照的 tag 不存在，归到索引（不会被用到）
        (StreamName::Conv, StreamFileKind::Snapshot) => aad_tag::CONV_SNAP_INDEX,
        (StreamName::Sec, StreamFileKind::Segment) => aad_tag::SEC_SEG,
        (StreamName::Sec, StreamFileKind::Snapshot) => aad_tag::SEC_SNAP,
        (StreamName::Sec, StreamFileKind::SnapshotIndex)
        | (StreamName::Sec, StreamFileKind::SnapshotPart) => aad_tag::SEC_SNAP,
        // 配置流从不用分包快照（单文件）。给个同流 tag 而不是 panic：真被误用时 AAD 仍限在本流内。
        (StreamName::Config, StreamFileKind::SnapshotIndex)
        | (StreamName::Config, StreamFileKind::SnapshotPart) => aad_tag::CONFIG_SNAP,
    }
}

/// 按流 + 文件种类把明文封成远端文件（AAD 由 [`aad_tag_for`] 决定）。
pub fn seal_stream_file(
    dk: &DataKey,
    stream: StreamName,
    kind: StreamFileKind,
    device: &str,
    seq: u64,
    part: Option<u32>,
    plain: &[u8],
) -> Result<Vec<u8>, FormatError> {
    let tag = aad_tag_for(stream, kind);
    match (kind, part) {
        (StreamFileKind::SnapshotPart, Some(p)) => {
            format::seal_json_part(dk, tag, device, seq, p, plain)
        }
        _ => format::seal_json(dk, tag, device, seq, plain),
    }
}

/// 这条流的远端目录（相对同步根目录）。
pub fn remote_dir(stream: StreamName, device: &str) -> String {
    stream.remote_dir(device)
}

/// 远端只读视图：把某个对端设备在某条流下的文件读出来并**按这条流的 AAD 解密**。
///
/// 驱动拿不到 DK 本身，只能按 `kind` / `seq` / `part` 请求解密——AAD 由这里统一拼，
/// 所以一条流不可能解出另一条流的文件。
pub struct BackendStreamRemote {
    backend: Arc<dyn Backend>,
    dk: DataKey,
    peer: String,
    stream: StreamName,
}

impl BackendStreamRemote {
    pub fn new(backend: Arc<dyn Backend>, dk: DataKey, peer: String, stream: StreamName) -> Self {
        Self {
            backend,
            dk,
            peer,
            stream,
        }
    }
}

#[async_trait]
impl StreamRemote for BackendStreamRemote {
    fn peer(&self) -> &str {
        &self.peer
    }

    fn stream(&self) -> StreamName {
        self.stream
    }

    async fn list(&self, dir: &str) -> Result<Vec<RemoteEntry>, StorageError> {
        self.backend.list(dir).await
    }

    async fn get(&self, path: &str) -> Result<Option<Vec<u8>>, StorageError> {
        self.backend.get(path).await
    }

    fn open(
        &self,
        kind: StreamFileKind,
        seq: u64,
        part: Option<u32>,
        bytes: &[u8],
    ) -> Result<Vec<u8>, FormatError> {
        let tag = aad_tag_for(self.stream, kind);
        match (kind, part) {
            (StreamFileKind::SnapshotPart, Some(p)) => {
                format::open_json_part(&self.dk, tag, &self.peer, seq, p, bytes)
            }
            _ => format::open_json(&self.dk, tag, &self.peer, seq, bytes),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stream_names_and_dirs_match_the_contract() {
        assert_eq!(StreamName::Config.as_str(), "config");
        assert_eq!(StreamName::Conv.as_str(), "conv");
        assert_eq!(StreamName::Sec.as_str(), "sec");
        assert_eq!(StreamName::Config.remote_dir("d"), "devices/d");
        assert_eq!(StreamName::Conv.remote_dir("d"), "devices/d/conv");
        assert_eq!(StreamName::Sec.remote_dir("d"), "devices/d/sec");
        assert_eq!(StreamName::Config.dir_suffix(), None);
        assert_eq!(StreamName::Conv.dir_suffix(), Some("conv"));
        assert_eq!(StreamName::Sec.dir_suffix(), Some("sec"));
        assert_eq!(StreamName::Config.tier(), crate::data::SyncTier::Config);
        assert_eq!(StreamName::Conv.tier(), crate::data::SyncTier::Conversation);
        assert_eq!(StreamName::Sec.tier(), crate::data::SyncTier::Secret);
        assert_eq!(StreamName::ALL.len(), 3);
        assert_eq!(remote_dir(StreamName::Conv, "d"), "devices/d/conv");
    }

    #[test]
    fn every_stream_file_kind_has_a_distinct_aad_tag() {
        // 同一个流内，段与快照必须用不同的 tag；不同流的同名种类也要不同
        let tags = [
            aad_tag_for(StreamName::Config, StreamFileKind::Segment),
            aad_tag_for(StreamName::Config, StreamFileKind::Snapshot),
            aad_tag_for(StreamName::Conv, StreamFileKind::Segment),
            aad_tag_for(StreamName::Conv, StreamFileKind::SnapshotIndex),
            aad_tag_for(StreamName::Conv, StreamFileKind::SnapshotPart),
            aad_tag_for(StreamName::Sec, StreamFileKind::Segment),
            aad_tag_for(StreamName::Sec, StreamFileKind::Snapshot),
        ];
        let unique: std::collections::BTreeSet<&str> = tags.iter().copied().collect();
        assert_eq!(unique.len(), tags.len(), "AAD tag 有重复: {tags:?}");
        assert_eq!(
            aad_tag_for(StreamName::Config, StreamFileKind::Segment),
            "seg"
        );
        assert_eq!(
            aad_tag_for(StreamName::Conv, StreamFileKind::SnapshotPart),
            "conv-snap-part"
        );
    }

    #[test]
    fn progress_serializes_camel_case() {
        let p = StreamProgress {
            done: 3,
            total: 10,
            label: "正在同步对话".into(),
        };
        assert_eq!(
            serde_json::to_value(&p).unwrap(),
            serde_json::json!({"done": 3, "total": 10, "label": "正在同步对话"})
        );
    }
}
