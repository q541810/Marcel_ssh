//! 全量导出：首次开启某一档、或服务端还没有本机数据时用。
//!
//! **流式**遍历每张表（`query` + 逐行序列化，按字节切段），不把整个库塞进内存——
//! 对话库动辄几百 MB，`Vec` 全装一遍足以把手机打死。
//!
//! 没有时钟的行用 [`Hlc::zero_for`]：语义同一期的「加入同步」——任何真实写入的 `ms` 都大于 0，
//! 所以云端在每一次冲突上都赢，本机独有的行照样传上去。**不推进 `sync_row_clock`**：
//! 全量导出只是「把本机现状说给别人听」，不是本机改动，导出后本机行也没变。

use std::collections::BTreeMap;

use rusqlite::Connection;

use super::super::super::error::AppError;
use super::super::core::hlc::Hlc;
use super::capture::SegmentBuilder;
use super::shared::{quote_ident, sql_err, value_to_json};
use super::{AliasMap, ColumnScope, RowOp, RowTable, SegmentMeta};

/// `export_all` 的变体参数。
#[derive(Clone, Copy, Debug)]
pub struct ExportOptions {
    /// 这条流（写进段头的 `"stream"`）。
    pub stream: &'static str,
    /// conv 流专有的库名，见 [`SegmentMeta`]。
    pub db: Option<&'static str>,
    /// 单段上限（0 = 不切）。调用方通常传 [`super::DEFAULT_MAX_SEGMENT_BYTES`]。
    pub batch_bytes: usize,
    /// 完整检查点保留墓碑；首次加入保留历史零时钟语义。
    pub include_tombstones: bool,
}

impl ExportOptions {
    pub fn new(stream: &'static str, batch_bytes: usize) -> Self {
        Self {
            stream,
            db: None,
            batch_bytes,
            include_tombstones: false,
        }
    }

    pub fn with_db(mut self, db: &'static str) -> Self {
        self.db = Some(db);
        self
    }

    pub fn checkpoint(mut self) -> Self {
        self.include_tombstones = true;
        self
    }
}

/// 导出每张表里所有 `Shared` 列（契约签名）。
pub fn export_all(
    conn: &Connection,
    tables: &'static [RowTable],
    device: &str,
    aliases: &AliasMap,
    batch_bytes: usize,
    stream: &'static str,
) -> Result<Vec<Vec<u8>>, AppError> {
    export_all_with(
        conn,
        tables,
        device,
        aliases,
        ExportOptions::new(stream, batch_bytes),
    )
}

/// 同 [`export_all`]，可以指定段头的 `db`。
pub fn export_all_with(
    conn: &Connection,
    tables: &'static [RowTable],
    device: &str,
    aliases: &AliasMap,
    options: ExportOptions,
) -> Result<Vec<Vec<u8>>, AppError> {
    // `SegmentBuilder` 的段头只取决于 stream / device / db（与批内容无关），
    // 所以整趟导出共用一个 builder 即可，逐行 push 时按字节自动切段。
    let mut builder = SegmentBuilder::new(
        SegmentMeta {
            stream: options.stream,
            db: options.db,
        },
        device,
        options.batch_bytes,
    );

    // 每张表流式读（`query` 返回游标，行是逐条取的），不 collect 整表。
    let mut sink = |op| {
        builder.push(op);
        Ok(())
    };
    if options.include_tombstones {
        for_each_checkpoint_op(conn, tables, device, aliases, &mut sink)?;
    } else {
        for table in tables {
            let columns: Vec<&str> = table.shared_columns().collect();
            export_table(conn, table, &columns, device, aliases, &mut sink, false)?;
        }
    }
    Ok(builder.finish())
}

/// 逐行读取完整检查点，不经过中间的「段 JSON → 再解析成行」往返。
///
/// 调用方可以在回调里归组、打包，但**不能在回调里再次访问同一个数据库连接**：
/// 这里正持有只读游标，业务句柄通常也用同一把连接锁。
pub fn for_each_checkpoint_op(
    conn: &Connection,
    tables: &'static [RowTable],
    device: &str,
    aliases: &AliasMap,
    sink: &mut dyn FnMut(RowOp) -> Result<(), AppError>,
) -> Result<(), AppError> {
    for table in tables {
        let columns: Vec<&str> = table.shared_columns().collect();
        export_table(conn, table, &columns, device, aliases, sink, true)?;
    }
    export_unregistered_ops(conn, tables, sink)
}

/// 老设备还存着新版本表的待重放 op。检查点不能只因本版本不认识表名就把它抹掉。
fn export_unregistered_ops(
    conn: &Connection,
    tables: &'static [RowTable],
    sink: &mut dyn FnMut(RowOp) -> Result<(), AppError>,
) -> Result<(), AppError> {
    let mut stmt = conn
        .prepare(
            "SELECT tbl, row_id, hlc, deleted, extra_json FROM sync_row_clock
             ORDER BY tbl, row_id",
        )
        .map_err(|e| sql_err("准备导出未知同步行失败", e))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| sql_err("导出未知同步行失败", e))?;
    while let Some(row) = rows
        .next()
        .map_err(|e| sql_err("导出未知同步行失败", e))?
    {
        let table: String = row
            .get(0)
            .map_err(|e| sql_err("读取未知同步行失败", e))?;
        let known = tables.iter().any(|t| t.name == table);
        let extra: Option<String> = row
            .get(4)
            .map_err(|e| sql_err("读取未知同步行失败", e))?;
        let pending = extra
            .and_then(|text| {
                serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&text).ok()
            })
            .and_then(|mut map| map.remove(super::capture::UNKNOWN_OP_KEY))
            .map(serde_json::from_value::<RowOp>)
            .transpose()
            .map_err(|e| AppError::Other(format!("导出待重放同步行失败：{e}")))?;
        if let Some(op) = pending {
            // 已知表也可能有「等父行」的子行；它和存活行一起保留，重放是幂等的。
            sink(op)?;
            continue;
        }
        if known {
            continue;
        }
        let deleted: i64 = row
            .get(3)
            .map_err(|e| sql_err("读取未知同步行失败", e))?;
        if deleted == 0 {
            // 没有原始 op 就没有可恢复的列；不伪造一行空业务数据。
            continue;
        }
        let id: String = row
            .get(1)
            .map_err(|e| sql_err("读取未知同步行失败", e))?;
        let hlc: String = row
            .get(2)
            .map_err(|e| sql_err("读取未知同步行失败", e))?;
        sink(RowOp {
            table,
            id,
            hlc: serde_json::from_str(&hlc)
                .map_err(|e| AppError::Other(format!("导出行时钟损坏：{e}")))?,
            cols: None,
            extra: None,
            del: true,
        })?;
    }
    Ok(())
}

fn export_table(
    conn: &Connection,
    table: &RowTable,
    columns: &[&str],
    device: &str,
    aliases: &AliasMap,
    sink: &mut dyn FnMut(RowOp) -> Result<(), AppError>,
    include_tombstones: bool,
) -> Result<(), AppError> {
    // 左连行时钟：一次查询就把「本机不认识的列」与「这一行自己的时钟」带出来，
    // 免得每行再点查两次（十万条消息就是二十万次查询）。
    let mut select = std::iter::once(table.pk)
        .chain(columns.iter().copied())
        .map(|c| format!("t.{}", quote_ident(c)))
        .collect::<Vec<_>>()
        .join(", ");
    select.push_str(", c.hlc, c.deleted, c.extra_json");
    let sql = format!(
        "SELECT {select} FROM {table} AS t
         LEFT JOIN sync_row_clock AS c ON c.tbl = ?1 AND c.row_id = t.{pk}",
        table = quote_ident(table.name),
        pk = quote_ident(table.pk),
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| sql_err("准备导出同步表失败", e))?;
    let mut rows = stmt
        .query([table.name])
        .map_err(|e| sql_err("导出同步表失败", e))?;

    while let Some(row) = rows.next().map_err(|e| sql_err("导出同步表失败", e))? {
        let id: String = row.get(0).map_err(|e| sql_err("读取导出行主键失败", e))?;
        let mut cols = BTreeMap::new();
        for (i, name) in columns.iter().enumerate() {
            let value = row
                .get_ref(i + 1)
                .map_err(|e| sql_err("读取导出行失败", e))?;
            cols.insert((*name).to_string(), value_to_json(value)?);
        }
        if let Some(alias_col) = table.alias.column() {
            if table.column(alias_col).map(|c| c.scope) == Some(ColumnScope::Shared) {
                if let Some(serde_json::Value::String(v)) = cols.get(alias_col) {
                    let resolved = aliases.resolve(v);
                    if &resolved != v {
                        cols.insert(alias_col.to_string(), serde_json::Value::String(resolved));
                    }
                }
            }
        }

        // 本机不认识的列（老设备写过的）也要带上，否则全量导出会把它们删掉。
        let hlc_text: Option<String> = row
            .get(columns.len() + 1)
            .map_err(|e| sql_err("读取导出行时钟失败", e))?;
        let deleted: Option<i64> = row
            .get(columns.len() + 2)
            .map_err(|e| sql_err("读取导出行时钟失败", e))?;
        let extra_text: Option<String> = row
            .get(columns.len() + 3)
            .map_err(|e| sql_err("读取导出行扩展列失败", e))?;
        let mut extra: BTreeMap<String, serde_json::Value> = extra_text
            .and_then(|t| serde_json::from_str::<BTreeMap<String, serde_json::Value>>(&t).ok())
            .unwrap_or_default()
            .into_iter()
            .filter(|(name, _)| table.column(name).is_none())
            .collect();
        // 占位时钟里的「待重放 op」不是一列数据。
        extra.remove(super::capture::UNKNOWN_OP_KEY);
        // 首次加入沿用旧的零时钟语义；完整检查点保留真实墓碑，不能用「空存活行」冒充。
        let deleted = deleted.unwrap_or(0) != 0;
        let hlc = match hlc_text {
            Some(t) if !deleted || include_tombstones => serde_json::from_str(&t)
                .map_err(|e| AppError::Other(format!("导出行时钟损坏：{e}")))?,
            _ => Hlc::zero_for(device),
        };
        let del = include_tombstones && deleted;

        sink(RowOp {
            table: table.name.to_string(),
            id,
            hlc,
            cols: if del { None } else { Some(cols) },
            extra: if del || extra.is_empty() {
                None
            } else {
                Some(extra)
            },
            del,
        })?;
    }

    if include_tombstones {
        // 业务表已级联删除子行，墓碑只存在时钟表里。只补「表里没有对应行」的项。
        let sql = format!(
            "SELECT row_id, hlc FROM sync_row_clock
             WHERE tbl = ?1 AND deleted = 1
               AND NOT EXISTS (SELECT 1 FROM {table} AS t WHERE t.{pk} = sync_row_clock.row_id)
             ORDER BY row_id",
            table = quote_ident(table.name),
            pk = quote_ident(table.pk),
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| sql_err("准备导出同步墓碑失败", e))?;
        let mut rows = stmt
            .query([table.name])
            .map_err(|e| sql_err("导出同步墓碑失败", e))?;
        while let Some(row) = rows
            .next()
            .map_err(|e| sql_err("导出同步墓碑失败", e))?
        {
            let id: String = row
                .get(0)
                .map_err(|e| sql_err("读取同步墓碑失败", e))?;
            let hlc: String = row
                .get(1)
                .map_err(|e| sql_err("读取同步墓碑失败", e))?;
            sink(RowOp {
                table: table.name.to_string(),
                id,
                hlc: serde_json::from_str(&hlc)
                    .map_err(|e| AppError::Other(format!("导出行时钟损坏：{e}")))?,
                cols: None,
                extra: None,
                del: true,
            })?;
        }
    }
    Ok(())
}
