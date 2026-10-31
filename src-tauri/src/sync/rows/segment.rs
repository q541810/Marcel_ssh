//! 段明文的编码与解码。格式与契约第 6 节逐字一致：
//!
//! ```json
//! {"format":1,"stream":"conv","kind":"rows","device":"<本机 id>",
//!  "db":"conversations",
//!  "ops":[{"t":"messages","id":"...","hlc":{"ms":0,"counter":0,"device":"..."},
//!          "cols":{"role":"user"},"extra":{}},
//!         {"t":"messages","id":"...","hlc":{...},"del":true}]}
//! ```
//!
//! **段里不写 `seq`**：序号由引擎在封包时分配，并且已经进了文件名与 AAD；段内再抄一份只会
//! 制造「两份对不上」的隐患（同一轮里落地后还会再捕获一次，驱动拿到的起点序号会过期）。
//! 需要排查时看文件名即可。
//!
//! `format` 的检查统一走 `sync::core::format::check_format`（引擎已经先查过一遍，
//! [`super::apply`] 里再查一次是为了让这个模块单独使用时也安全）。

use serde::{Deserialize, Serialize};

use super::super::super::error::AppError;
use super::super::core::format::FORMAT_VERSION;
use super::{RowOp, SegmentMeta, SEGMENT_KIND};

/// 段头的可序列化形状。`ops` 用切片，`capture` / `export_all` 建段时按批填。
#[derive(Serialize)]
struct SegmentRef<'a> {
    format: u32,
    stream: &'a str,
    kind: &'a str,
    device: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    db: Option<&'a str>,
    ops: &'a [RowOp],
}

/// 读段时的形状。`ops` 必填，其余字段由调用方按需校验（引擎已经先 `check_format` 过）。
#[derive(Deserialize)]
pub struct ParsedSegment {
    #[serde(default)]
    pub stream: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub device: Option<String>,
    /// conv 流专有：这个段里的行属于哪个库（`"conversations"` / `"memory"`）。
    /// 缺省 = `"conversations"`（T2 先落地时的兼容约定）。
    #[serde(default)]
    pub db: Option<String>,
    pub ops: Vec<RowOp>,
}

impl ParsedSegment {
    /// 库里没有 `db` 字段时的默认值。
    pub const DEFAULT_DB: &'static str = "conversations";

    /// 这个段属于哪个库（缺省 `conversations`）。
    pub fn db_or_default(&self) -> &str {
        self.db.as_deref().unwrap_or(Self::DEFAULT_DB)
    }

    pub fn parse(bytes: &[u8]) -> Result<Self, AppError> {
        let seg: ParsedSegment = serde_json::from_slice(bytes)
            .map_err(|e| AppError::Other(format!("同步段不是有效的 JSON：{e}")))?;
        if let Some(kind) = &seg.kind {
            if kind != SEGMENT_KIND {
                return Err(AppError::Other(format!(
                    "同步段类型不对：期望「{SEGMENT_KIND}」，实际是「{kind}」"
                )));
            }
        }
        Ok(seg)
    }
}

/// 解析一段明文（`format` 过新 → 带「请升级应用」的 `AppError`）。
pub fn parse_segment(bytes: &[u8]) -> Result<ParsedSegment, AppError> {
    super::super::core::format::check_format(bytes)?;
    ParsedSegment::parse(bytes)
}

/// 编码一段。返回的字节数与 [`encoded_len`] 的估算口径一致（同一个函数算出来）。
pub fn encode_segment(meta: SegmentMeta, device: &str, ops: &[RowOp]) -> Result<Vec<u8>, AppError> {
    serde_json::to_vec(&SegmentRef {
        format: FORMAT_VERSION,
        stream: meta.stream,
        kind: SEGMENT_KIND,
        device,
        db: meta.db,
        ops,
    })
    .map_err(|e| AppError::Other(format!("序列化同步段失败：{e}")))
}

pub(super) fn encode(meta: SegmentMeta, device: &str, ops: &[RowOp]) -> Result<Vec<u8>, AppError> {
    encode_segment(meta, device, ops)
}
