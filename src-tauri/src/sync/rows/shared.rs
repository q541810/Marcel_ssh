//! 行同步内部共用的小工具：标识符引用、SQLite 值 ↔ JSON、时钟表读写、事务与落地抑制。
//!
//! 这些函数只在本模块内部使用，不对外导出——对外接口在 [`super`]（抑制相关的两个
//! 函数除外：T2 删会话时要借它只让父行墓碑被捕获，见 [`suppress_capture`]）。

use std::collections::BTreeMap;

use rusqlite::types::{Type, Value as SqlValue, ValueRef};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use super::super::core::hlc::Hlc;
use crate::error::AppError;

/// 给标识符加双引号。表名 / 列名来自使用方的表清单（编译期常量），但 DROP 触发器时
/// 名字来自 `sqlite_master`（可以包含任意字符），所以统一转义，不假设输入干净。
pub(super) fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

/// 给 SQL 字符串字面量转义单引号。
pub(super) fn quote_literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

pub(super) fn sql_err(context: &str, e: rusqlite::Error) -> AppError {
    AppError::Other(format!("{context}：{e}"))
}

/// SQLite 的一个值 → JSON。BLOB 直接报错：行同步的列里不该出现二进制（图片是路径、
/// 私钥走机密流），静默 base64 只会在落地时把 BLOB 变成 TEXT，两边就永远对不上了。
pub(super) fn value_to_json(v: ValueRef<'_>) -> Result<Value, AppError> {
    Ok(match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::Number(i.into()),
        ValueRef::Real(f) => serde_json::Number::from_f64(f)
            .map(Value::Number)
            // NaN / ±inf 存不进 JSON；SQLite 里它们本来就会被写成 NULL，这里只是兜底
            .unwrap_or(Value::Null),
        ValueRef::Text(t) => Value::String(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => {
            return Err(AppError::Other(
                "行同步的列不能是 BLOB：请把二进制拆到 blob 流（图片 / 私钥）或改用文本列".into(),
            ));
        }
    })
}

/// JSON → SQLite 的值。
///
/// 数组 / 对象按 JSON 文本写入：业务表里的 "xxx_json" 列本来就是 TEXT，读到的是字符串而不是
/// 数组；真出现结构化值（旧版本或手工构造的 op）时，写成合法 JSON 文本比整条 op 失败更有用。
pub(super) fn json_to_sql(v: &Value) -> SqlValue {
    match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                SqlValue::Integer(i)
            } else if let Some(f) = n.as_f64() {
                SqlValue::Real(f)
            } else {
                SqlValue::Null
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        other => SqlValue::Text(other.to_string()),
    }
}

/// `sync_row_clock` 的一行。
#[derive(Clone, Debug)]
pub(super) struct ClockRow {
    pub hlc: Hlc,
    pub deleted: bool,
    /// 本机不认识的列。删除时清空（行都没了，留着这些值只会让下一次重建的行带上旧字段）。
    pub extra: BTreeMap<String, Value>,
}

fn parse_hlc_column(text: &str) -> rusqlite::Result<Hlc> {
    serde_json::from_str(text)
        .map_err(|e| rusqlite::Error::FromSqlConversionFailure(0, Type::Text, Box::new(e)))
}

/// 读一行的时钟。没有 = `None`（本机从没捕获过这一行，或这次是首次加入同步）。
pub(super) fn read_clock(
    conn: &Connection,
    table: &str,
    row_id: &str,
) -> Result<Option<ClockRow>, AppError> {
    let row = conn
        .query_row(
            "SELECT hlc, deleted, extra_json FROM sync_row_clock WHERE tbl = ?1 AND row_id = ?2",
            params![table, row_id],
            |row| {
                let hlc_text: String = row.get(0)?;
                let hlc = parse_hlc_column(&hlc_text)?;
                let deleted: i64 = row.get(1)?;
                let extra_text: Option<String> = row.get(2)?;
                Ok((hlc, deleted != 0, extra_text))
            },
        )
        .optional()
        .map_err(|e| sql_err("读取行时钟失败", e))?;

    let Some((hlc, deleted, extra_text)) = row else {
        return Ok(None);
    };
    // extra_json 是本机自己写的；真损坏了也不能让整条同步卡死，当作没有额外列继续。
    let extra = extra_text
        .and_then(|t| serde_json::from_str::<BTreeMap<String, Value>>(&t).ok())
        .unwrap_or_default();
    Ok(Some(ClockRow {
        hlc,
        deleted,
        extra,
    }))
}

/// 写一行的时钟（有则覆盖）。`extra` 为空时不写 `extra_json`（NULL 比 `{}` 省）。
pub(super) fn write_clock(
    conn: &Connection,
    table: &str,
    row_id: &str,
    hlc: &Hlc,
    deleted: bool,
    extra: &BTreeMap<String, Value>,
) -> Result<(), AppError> {
    let hlc_text = serde_json::to_string(hlc)
        .map_err(|e| AppError::Other(format!("序列化行时钟失败：{e}")))?;
    let extra_text = if extra.is_empty() {
        None
    } else {
        Some(
            serde_json::to_string(extra)
                .map_err(|e| AppError::Other(format!("序列化扩展列失败：{e}")))?,
        )
    };
    conn.execute(
        "INSERT INTO sync_row_clock(tbl, row_id, hlc, deleted, extra_json)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(tbl, row_id) DO UPDATE SET
             hlc = excluded.hlc,
             deleted = excluded.deleted,
             extra_json = excluded.extra_json",
        params![table, row_id, hlc_text, i64::from(deleted), extra_text],
    )
    .map_err(|e| sql_err("写行时钟失败", e))?;
    Ok(())
}

/// 落地抑制的层数（`temp.sync_applying` 里的行数）。
pub(super) fn applying_depth(conn: &Connection) -> Result<i64, AppError> {
    conn.query_row("SELECT COUNT(*) FROM temp.sync_applying", [], |r| r.get(0))
        .map_err(|e| sql_err("读取落地抑制状态失败", e))
}

/// 打开一层落地抑制的 RAII 守卫。`Drop` 时只在「最外层」清空标记；嵌套调用不会误删外层。
///
/// 用 guard 而不是「插入 / 删除两条语句」：闭包里 panic 时标记也要收回去，否则之后本机
/// 的任何写入都不会被捕获（而且用户看不到任何报错）。
pub struct CaptureGuard<'a> {
    conn: &'a Connection,
    clear_on_drop: bool,
}

impl Drop for CaptureGuard<'_> {
    fn drop(&mut self) {
        if self.clear_on_drop {
            if let Err(e) = self.conn.execute("DELETE FROM temp.sync_applying", []) {
                log::warn!("同步：清除落地抑制标记失败（下次 install 会兜底）: {e}");
            }
        }
    }
}

/// 打开一层落地抑制（业务侧手动包一段写库时用，比如 T2 删会话只让父行墓碑被捕获）。
///
/// 返回的 guard 必须活到这段写库结束；`install` 之后才有 `temp.sync_applying`。
pub fn suppress_capture(conn: &Connection) -> Result<CaptureGuard<'_>, AppError> {
    let depth = applying_depth(conn)?;
    conn.execute("INSERT INTO temp.sync_applying(dummy) VALUES (1)", [])
        .map_err(|e| sql_err("打开落地抑制失败", e))?;
    Ok(CaptureGuard {
        conn,
        clear_on_drop: depth == 0,
    })
}

/// [`suppress_capture`] 的闭包版：`f` 里对同步表的写入不会被记录成待上传改动。
///
/// T2 删一段会话时要先抑制子表的 `DELETE`（否则每条消息都会发一个墓碑），再单独删父行。
/// 嵌套调用安全；`f` 返回错误 / panic 时标记照样收回。
pub fn with_capture_suppressed<T>(
    conn: &Connection,
    f: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    let _guard = suppress_capture(conn)?;
    f()
}

/// 在 SAVEPOINT 里跑一段逻辑：成功 RELEASE、失败 ROLLBACK TO。
///
/// 用 SAVEPOINT 而不是 `BEGIN`：`apply` 可能被调用方包在自己的事务里
/// （T2/T4 落地时还要顺手做级联删除、缓存失效），嵌套的 `BEGIN` 会直接报
/// 「cannot start a transaction within a transaction」。
pub(super) fn in_savepoint<T>(
    conn: &Connection,
    name: &str,
    f: impl FnOnce() -> Result<T, AppError>,
) -> Result<T, AppError> {
    conn.execute_batch(&format!("SAVEPOINT {name}"))
        .map_err(|e| sql_err("开启同步事务失败", e))?;
    match f() {
        Ok(value) => {
            conn.execute_batch(&format!("RELEASE {name}"))
                .map_err(|e| sql_err("提交同步事务失败", e))?;
            Ok(value)
        }
        Err(e) => {
            if let Err(rollback) =
                conn.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"))
            {
                log::warn!("同步：回滚事务失败: {rollback}");
            }
            Err(e)
        }
    }
}

/// 把一个已存在的行读成「列名 → JSON」。只读指定列（调用方给的就是要同步的列），
/// 用于比较「这条 op 到底改没改东西」，以及父墓碑规则里找外键值。
pub(super) fn read_columns(
    conn: &Connection,
    table: &str,
    pk: &str,
    row_id: &str,
    columns: &[&str],
) -> Result<Option<BTreeMap<String, Value>>, AppError> {
    if columns.is_empty() {
        let exists = conn
            .query_row(
                &format!(
                    "SELECT 1 FROM {} WHERE {} = ?1",
                    quote_ident(table),
                    quote_ident(pk)
                ),
                params![row_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| sql_err("读取同步行失败", e))?;
        return Ok(exists.map(|_| BTreeMap::new()));
    }

    let select = columns
        .iter()
        .map(|c| quote_ident(c))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT {select} FROM {} WHERE {} = ?1",
        quote_ident(table),
        quote_ident(pk)
    );
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| sql_err("准备读取同步行失败", e))?;
    let mut rows = stmt
        .query(params![row_id])
        .map_err(|e| sql_err("读取同步行失败", e))?;
    let Some(row) = rows.next().map_err(|e| sql_err("读取同步行失败", e))? else {
        return Ok(None);
    };
    let mut out = BTreeMap::new();
    for (i, name) in columns.iter().enumerate() {
        let value = row.get_ref(i).map_err(|e| sql_err("读取同步列失败", e))?;
        out.insert((*name).to_string(), value_to_json(value)?);
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifiers_and_literals_are_escaped() {
        assert_eq!(quote_ident("a\"b"), "\"a\"\"b\"");
        assert_eq!(quote_literal("it's"), "'it''s'");
    }

    #[test]
    fn json_round_trips_common_values() {
        assert_eq!(json_to_sql(&Value::Null), SqlValue::Null);
        assert_eq!(json_to_sql(&Value::Bool(true)), SqlValue::Integer(1));
        assert_eq!(json_to_sql(&Value::from(7)), SqlValue::Integer(7));
        assert_eq!(json_to_sql(&Value::from(1.5)), SqlValue::Real(1.5));
        assert_eq!(json_to_sql(&Value::from("x")), SqlValue::Text("x".into()));
        // 结构化值写成合法 JSON 文本
        assert_eq!(
            json_to_sql(&serde_json::json!({"a":1})),
            SqlValue::Text("{\"a\":1}".into())
        );
    }
}
