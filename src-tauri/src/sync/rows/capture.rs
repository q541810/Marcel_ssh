//! 从 `sync_changelog` 捕获本机改动，产出待上传的行 op 与段。
//!
//! 流程：
//! 1. 按 `seq` 升序读整个 changelog（它只是「哪一行脏了」，量很小）；
//! 2. 同一行合并成一条（取最大的 seq），**最终是插入还是删除以行现在在不在为准**——
//!    一次事务里先插后删，最终就是墓碑，不必关心中间每一步；
//! 3. 读当前行、只带上 `Shared` 列、过别名换算、把 `extra_json` 里本机不认识的列也带上；
//! 4. 给这一行发一个新 HLC，写进 `sync_row_clock`；
//! 5. 按字节切段。
//!
//! **不删 changelog**：上传成功、账本落盘之后由调用方 [`ack`](super::ack)。
//! 崩溃时宁可重发，不能丢。

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;
use serde_json::Value;

use super::super::super::error::AppError;
use super::super::core::hlc::HlcClock;
use super::shared::{quote_ident, read_clock, read_columns, sql_err, write_clock};
use super::{
    AliasMap, CapturedRows, ColumnScope, HeldRow, RowOp, RowTable, SegmentMeta,
    DEFAULT_MAX_SEGMENT_BYTES,
};

/// 捕获参数。加这个结构而不是继续往 [`capture`] 上加参数：T2 / T4 除了流名还要指定
/// 段头的 `db`（对话库 / 记忆库）、段上限，以及「用户确认了大量删除、放行」。
#[derive(Clone, Copy, Debug)]
pub struct CaptureOptions {
    /// 这条流（写进段头的 `"stream"`）。
    pub stream: &'static str,
    /// conv 流专有的库名（`"conversations"` / `"memory"`）。`None` = 段头不写这个字段。
    pub db: Option<&'static str>,
    /// 单段字节上限。`0` = 不切段，默认 [`DEFAULT_MAX_SEGMENT_BYTES`]。
    pub max_segment_bytes: usize,
    /// 用户在账本里点了「放行」：这一轮不再走大量删除闸。
    ///
    /// 放行的语义就是「重新捕获一遍之前被扣下的行」——被扣下的行既没有推进时钟、
    /// changelog 也没有 ack，所以重捕一定拿得到。
    pub release_held: bool,
}

impl CaptureOptions {
    pub fn new(stream: &'static str) -> Self {
        Self {
            stream,
            db: None,
            max_segment_bytes: DEFAULT_MAX_SEGMENT_BYTES,
            release_held: false,
        }
    }

    pub fn with_db(mut self, db: &'static str) -> Self {
        self.db = Some(db);
        self
    }

    pub fn with_max_bytes(mut self, max: usize) -> Self {
        self.max_segment_bytes = max;
        self
    }
}

/// 捕获一批本机改动。
///
/// `stream` 只写进段头；序号不在段里（引擎封包时才分配，见 `segment` 模块文档）。
pub fn capture(
    conn: &Connection,
    tables: &'static [RowTable],
    clock: &mut HlcClock,
    device: &str,
    wall_ms: u64,
    aliases: &AliasMap,
    stream: &'static str,
) -> Result<CapturedRows, AppError> {
    capture_with(
        conn,
        tables,
        clock,
        device,
        wall_ms,
        aliases,
        CaptureOptions::new(stream),
    )
}

/// 同 [`capture`]，可以指定段头的 `db`、段上限、是否放行被扣下的墓碑。
pub fn capture_with(
    conn: &Connection,
    tables: &'static [RowTable],
    clock: &mut HlcClock,
    device: &str,
    wall_ms: u64,
    aliases: &AliasMap,
    options: CaptureOptions,
) -> Result<CapturedRows, AppError> {
    let pending = read_pending(conn)?;
    if pending.is_empty() {
        return Ok(CapturedRows::default());
    }

    // 同一行合并：只需要最大的 seq（决定它排在哪），以及这张表。
    let mut merged: BTreeMap<(String, String), i64> = BTreeMap::new();
    for (seq, tbl, row_id) in &pending {
        let key = (tbl.clone(), row_id.clone());
        let entry = merged.entry(key).or_insert(*seq);
        if *seq > *entry {
            *entry = *seq;
        }
    }

    // 先扫一遍：每张表这批有多少个墓碑。大量删除闸按「整张表的墓碑数」判定。
    let mut tombstones: Vec<(String, String, i64)> = Vec::new();
    for ((tbl, row_id), seq) in &merged {
        let Some(table) = find_table(tables, tbl) else {
            continue;
        };
        // 行还在就是 upsert，不在了才是墓碑。只看是否存在，不读内容。
        if read_columns(conn, table.name, table.pk, row_id, &[])?.is_none() {
            tombstones.push((tbl.clone(), row_id.clone(), *seq));
        }
    }
    let mut tombstone_count: BTreeMap<&str, usize> = BTreeMap::new();
    for (tbl, _, _) in &tombstones {
        if let Some(table) = find_table(tables, tbl) {
            if table.mass_delete_limit > 0 && !options.release_held {
                *tombstone_count.entry(table.name).or_default() += 1;
            }
        }
    }
    let gated_tables: BTreeSet<&str> = tombstone_count
        .iter()
        .filter(|(name, count)| {
            let limit = find_table(tables, name)
                .map(|t| t.mass_delete_limit)
                .unwrap_or(0);
            limit > 0 && **count >= limit
        })
        .map(|(name, _)| *name)
        .collect();
    let held_keys: BTreeSet<(String, String)> = tombstones
        .iter()
        .filter(|(tbl, _, _)| gated_tables.contains(tbl.as_str()))
        .map(|(tbl, row_id, _)| (tbl.clone(), row_id.clone()))
        .collect();

    // 第一个被扣下的 seq：ack 水位最多到这里的前一条。被扣下的行（以及它后面的所有行）
    // 下一轮重新捕获——重复上传无害（同内容 + 更大的 HLC），丢改动才是事故。
    let first_held_seq = tombstones
        .iter()
        .filter(|(tbl, row_id, _)| held_keys.contains(&(tbl.clone(), row_id.clone())))
        .map(|(_, _, seq)| *seq)
        .min();

    let mut ordered: Vec<((String, String), i64)> = merged.into_iter().collect();
    ordered.sort_by_key(|(_, seq)| *seq);

    let watermark = match first_held_seq {
        Some(seq) => seq - 1,
        None => pending.last().map(|(seq, _, _)| *seq).unwrap_or(0),
    };

    let mut builder = SegmentBuilder::new(
        SegmentMeta {
            stream: options.stream,
            db: options.db,
        },
        device,
        options.max_segment_bytes,
    );
    let mut held = Vec::new();
    let mut captured = 0usize;
    for ((tbl, row_id), seq) in ordered {
        let Some(table) = find_table(tables, &tbl) else {
            // 表已经从清单里移除（旧库残留）：不产出 op，但它的 seq 会随水位被 ack 掉。
            continue;
        };
        if held_keys.contains(&(tbl.clone(), row_id.clone())) {
            // 扣下的墓碑：不发 HLC、不推进时钟、不 ack。用户确认后下一轮重新捕获。
            held.push(HeldRow { table: tbl, row_id });
            continue;
        }
        if seq > watermark {
            // 水位之后的行这轮不上传（否则 ack 不到它们、下一轮还会再发一遍）。
            // 它们不在 `held` 里，用户确认删除后照常随下一轮走。
            continue;
        }
        if let Some(op) = capture_one(conn, table, clock, wall_ms, aliases, &row_id)? {
            builder.push(op);
            captured += 1;
        }
    }

    Ok(CapturedRows {
        segments: builder.finish(),
        watermark,
        held,
        captured,
    })
}

/// 一行 → 一条 op；同时把这一行的时钟推进到新 HLC。
fn capture_one(
    conn: &Connection,
    table: &RowTable,
    clock: &mut HlcClock,
    wall_ms: u64,
    aliases: &AliasMap,
    row_id: &str,
) -> Result<Option<RowOp>, AppError> {
    let columns: Vec<&str> = table.shared_columns().collect();
    let current = read_columns(conn, table.name, table.pk, row_id, &columns)?;
    let before = read_clock(conn, table.name, row_id)?;

    let Some(mut cols) = current else {
        // 墓碑：extra 清空（行都没了，留着旧字段只会在重建时诈尸）。
        let hlc = clock.now(wall_ms);
        write_clock(conn, table.name, row_id, &hlc, true, &BTreeMap::new())?;
        return Ok(Some(RowOp {
            table: table.name.to_string(),
            id: row_id.to_string(),
            hlc,
            cols: None,
            extra: None,
            del: true,
        }));
    };

    // 别名换算：上传的是「云端 id」，否则对端收到一个它从没见过的连接 id。
    if let Some(alias_col) = table.alias.column() {
        if table.column(alias_col).map(|c| c.scope) == Some(ColumnScope::Shared) {
            if let Some(Value::String(v)) = cols.get(alias_col) {
                let resolved = aliases.resolve(v);
                if &resolved != v {
                    cols.insert(alias_col.to_string(), Value::String(resolved));
                }
            }
        }
    }

    // extra 只补本机不认识的那些列：同名列以本机当前值为准（本机认识它，说明它就在
    // `columns` 里，值已经读出来了）。升级后某列从「不认识」变成「认识」时，旧的 extra
    // 条目也要丢掉，否则它会一直跟着行跑，还会在落地时被当成未知列存回去。
    let mut extra = before.map(|c| c.extra).unwrap_or_default();
    extra.retain(|name, _| table.column(name).is_none());
    // 占位时钟里的「待重放 op」不是一列数据，别把它当未知列传出去。
    strip_pending_marker(&mut extra);

    let hlc = clock.now(wall_ms);
    // 时钟里留着的 extra 是「本机不认识、但对端认识」的列，下次还要原样带出去。
    write_clock(conn, table.name, row_id, &hlc, false, &extra)?;

    Ok(Some(RowOp {
        table: table.name.to_string(),
        id: row_id.to_string(),
        hlc,
        cols: Some(cols),
        extra: if extra.is_empty() { None } else { Some(extra) },
        del: false,
    }))
}

fn find_table(tables: &'static [RowTable], name: &str) -> Option<&'static RowTable> {
    tables.iter().find(|t| t.name == name)
}

/// changelog 里的一批待处理行，按 seq 升序。
fn read_pending(conn: &Connection) -> Result<Vec<(i64, String, String)>, AppError> {
    let mut stmt = conn
        .prepare("SELECT seq, tbl, row_id FROM sync_changelog ORDER BY seq ASC")
        .map_err(|e| sql_err("读取待同步改动失败", e))?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(|e| sql_err("读取待同步改动失败", e))?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| sql_err("读取待同步改动失败", e))
}

/// 待上传条数（`sync_status` 的 `pending` 用）。
///
/// 按**行**去重计数：同一行改十次只会在 `capture` 里产出 1 条 op，界面显示 10 会让用户
/// 以为还有一大堆没传完。`tables` 只为保持签名稳定（changelog 是按库划分的）。
pub fn pending_count(conn: &Connection, tables: &'static [RowTable]) -> Result<usize, AppError> {
    let _ = tables;
    let n: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM (SELECT DISTINCT tbl, row_id FROM sync_changelog)",
            [],
            |r| r.get(0),
        )
        .map_err(|e| sql_err("读取待同步条数失败", e))?;
    Ok(n as usize)
}

/// 清掉已经上传成功的 changelog。
///
/// **只能在段上传成功、账本落盘之后调用**（引擎的约定）：早调一次，崩溃时就永久丢了那批改动。
pub fn ack(conn: &Connection, watermark: i64) -> Result<(), rusqlite::Error> {
    conn.execute("DELETE FROM sync_changelog WHERE seq <= ?1", [watermark])?;
    Ok(())
}

/// 按字节切段。
///
/// 长度是**逐字节精确**算出来的：段长 = 空段 JSON 的长度 + Σ（每条 op 的 JSON 长度）
/// + (n-1) 个逗号。`serde_json` 是紧凑输出（无空格），所以这个等式成立；空段长度只取决于
/// 段头（stream / device / db），与批内容无关，构造时算一次即可。
pub(super) struct SegmentBuilder {
    meta: SegmentMeta,
    device: String,
    max_bytes: usize,
    header_len: usize,
    ops: Vec<RowOp>,
    /// 当前这一段的预计长度。
    size: usize,
    segments: Vec<Vec<u8>>,
}

impl SegmentBuilder {
    pub(super) fn new(meta: SegmentMeta, device: &str, max_bytes: usize) -> Self {
        let header_len = super::segment::encode(meta, device, &[])
            .map(|v| v.len())
            .unwrap_or(0);
        Self {
            meta,
            device: device.to_string(),
            // 0 是「不切」的哨兵：调用方偶尔会想要一整段（导出整份时）
            max_bytes: if max_bytes == 0 {
                usize::MAX
            } else {
                max_bytes
            },
            header_len,
            ops: Vec::new(),
            size: header_len,
            segments: Vec::new(),
        }
    }

    pub(super) fn push(&mut self, op: RowOp) {
        let Ok(op_bytes) = serde_json::to_vec(&op) else {
            // 全是 String / Value，序列化不可能失败；真失败也只能跳过这一行，
            // 绝不能让整个同步线程崩掉（下一轮 changelog 还在，会重试）。
            log::error!("同步：序列化行 op 失败（跳过这一行，下轮重试）");
            return;
        };
        // 段长 = 空段长 + Σop + (n-1) 个逗号。
        let delta = op_bytes.len() + usize::from(!self.ops.is_empty());
        if !self.ops.is_empty() && self.size + delta > self.max_bytes {
            self.flush();
        }
        let comma = usize::from(!self.ops.is_empty());
        self.size += op_bytes.len() + comma;
        self.ops.push(op);
    }

    fn flush(&mut self) {
        if self.ops.is_empty() {
            return;
        }
        let ops = std::mem::take(&mut self.ops);
        match super::segment::encode(self.meta, &self.device, &ops) {
            Ok(bytes) => {
                debug_assert!(
                    bytes.len() <= self.max_bytes || ops.len() == 1,
                    "段大小 {} 超过上限 {}",
                    bytes.len(),
                    self.max_bytes
                );
                self.segments.push(bytes);
            }
            // 序列化 RowOp 不可能失败（全是 String / Value），真失败只能是内存问题；
            // 这里不能 unwrap，否则一个坏行会让整个同步线程崩掉。
            Err(e) => log::error!("同步：序列化行段失败（这一批丢弃，下轮重试）: {e}"),
        }
        self.size = self.header_len;
    }

    pub(super) fn finish(mut self) -> Vec<Vec<u8>> {
        self.flush();
        // 空段没有意义：调用方拿到的应该是「没有改动」而不是一个 ops:[] 的文件。
        std::mem::take(&mut self.segments)
    }
}

/// `sync_row_clock.extra_json` 里「躺着一整条待重放 op」的标记键。
///
/// `extra_json` 平时是「列名 → 值」，和「整条 op」都是对象；用一个不可能撞上真实列名的
/// 键把两者分开，升级后 [`replay_unknown`](super::replay_unknown) 才认得出哪些能重放。
pub(super) const UNKNOWN_OP_KEY: &str = "__rowop";

/// 从 extra 里剔除「待重放 op」标记：它只属于占位时钟，绝不能被当成一个未知列上传/落地。
pub(super) fn strip_pending_marker(extra: &mut BTreeMap<String, Value>) {
    extra.remove(UNKNOWN_OP_KEY);
}

/// 把 op 里的已知 `Shared` 列整理成「要落地的列 → 值」，同时完成别名换算。
///
/// **`cols` 和 `extra` 都要看**：`extra` 是「发送方不认识的列」，本机可能认识它
/// （老设备 → 新设备的典型场景）。这时候它就是一个普通的已知列，必须写进行里，而不是
/// 当成未知列再存回 `extra_json`——否则新版本的那一列永远停在旧值上。
pub(super) fn incoming_columns(
    table: &RowTable,
    op: &RowOp,
    aliases: &AliasMap,
) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    // `extra` 先放，`cols` 后放：同一列两边都有时以发送方明确列出的 `cols` 为准。
    for map in [&op.extra, &op.cols].into_iter().flatten() {
        for (name, value) in map {
            if table.column(name).map(|c| c.scope) != Some(ColumnScope::Shared) {
                continue;
            }
            let mut value = value.clone();
            if table.alias.column() == Some(name.as_str()) {
                if let Value::String(v) = &value {
                    value = Value::String(aliases.resolve(v));
                }
            }
            out.insert(name.clone(), value);
        }
    }
    out
}

/// 把这一行要写进表的列拼成 `INSERT` 的列 / 值（主键单独给）。
pub(super) fn insert_parts(
    table: &RowTable,
    id: &str,
    cols: &BTreeMap<String, Value>,
) -> (String, Vec<rusqlite::types::Value>) {
    let mut names = vec![quote_ident(table.pk)];
    let mut values = vec![rusqlite::types::Value::Text(id.to_string())];
    for (name, value) in cols {
        // 只写本机认识的 `Shared` 列；`Local` 列即使远端带了也不碰。
        if table.column(name).map(|c| c.scope) != Some(ColumnScope::Shared) {
            continue;
        }
        names.push(quote_ident(name));
        values.push(super::shared::json_to_sql(value));
    }
    (names.join(", "), values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn segment_builder_never_exceeds_limit_unless_single_row() {
        let big = "x".repeat(1000);
        let mut b = SegmentBuilder::new(SegmentMeta::new("conv"), "A", 1500);
        for i in 0..10 {
            b.push(RowOp {
                table: "t".into(),
                id: format!("r{i}"),
                hlc: crate::sync::core::Hlc::zero_for("A"),
                cols: Some(BTreeMap::from([(
                    "v".to_string(),
                    Value::String(big.clone()),
                )])),
                extra: None,
                del: false,
            });
        }
        let segs = b.finish();
        assert!(segs.len() >= 5, "1KB 的行在 1.5KB 的段里应一条一段");
        for s in &segs {
            assert!(s.len() <= 1500, "段长 {} 超限", s.len());
        }
    }
}
