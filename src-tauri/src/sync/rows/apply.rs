//! 落地远端行 op。
//!
//! 安全边界（每条都有测试钉住）：
//! - **整批一个事务**：任何一条 op 失败（列不满足约束、磁盘满……）都整批回滚，不会留下半批数据，
//!   也不会把半批的时钟写进去；
//! - **落地期间抑制捕获**：否则本机把刚落地的东西又记一遍、再传回给对方，两边来回弹；
//! - **先比时钟**：远端 op 只有比本行时钟新才落地，乱序到达的旧 op 直接丢弃；
//! - **永远不写 `Local` 列**：本机路径、窗口尺寸这类值属于这台设备；
//! - **本机不认识的列 / 表只存不用**：升级后由 [`replay_unknown`] 补落地，老版本不会把新版本的
//!   字段悄悄删掉。
//!
//! 引用完整性（为什么本模块要管这些）：
//! - 业务库的 `FOREIGN KEY` 是真的在生效的（rusqlite 的 bundled SQLite 编译时开了
//!   `SQLITE_DEFAULT_FOREIGN_KEYS`），所以**父行没到、子行先到**不能直接写：多设备之间没有
//!   全局顺序，C 完全可能先读到 B 对一个 A 新建会话的修改。这种 op 先存进 `sync_row_clock`
//!   等父行到达再重放；父行已经被删（墓碑）的，子行直接丢弃。
//! - 父行墓碑落地时要**级联删子行**：发送方只发一个会话墓碑（不为每条消息各发一个），
//!   接收方必须把会话连同消息一起删掉，否则本地会留下孤儿行、外键也会直接拒绝删父行。
//!   `RowTable::parent` 声明了这张图，级联就按它走。业务侧还要清的其它东西（图片桶）
//!   由调用方经 [`RowApplyHook::before_row_delete`] 处理。

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;
use serde_json::Value;

use super::super::super::error::AppError;
use super::super::core::format;
use super::capture::{incoming_columns, insert_parts, UNKNOWN_OP_KEY};
use super::shared::{
    in_savepoint, quote_ident, read_clock, read_columns, sql_err, suppress_capture, write_clock,
    ClockRow,
};
use super::{AliasMap, ColumnScope, ParsedSegment, RowApplied, RowMerge, RowOp, RowTable};

/// 落地过程中的扩展点。默认实现什么都不做。
///
/// 只提供「即将删除某一行」一个点：业务侧需要清理的数据（会话的图片桶）都挂在被删的行下面，
/// 在 SQL 删掉它之前读出来最省事。它运行在 apply 的事务里，此时捕获已被抑制，回调里的写入
/// 不会产生上传。
pub trait RowApplyHook {
    fn before_row_delete(
        &self,
        conn: &Connection,
        table: &str,
        row_id: &str,
    ) -> Result<(), AppError> {
        let _ = (conn, table, row_id);
        Ok(())
    }
}

/// 什么都不做的钩子（[`apply`] 的默认实现）。
pub struct NoHook;

impl RowApplyHook for NoHook {}

/// 落地一段行 op（`ops_json` 是段明文的完整 JSON）。
pub fn apply(
    conn: &Connection,
    tables: &'static [RowTable],
    ops_json: &[u8],
    aliases: &AliasMap,
) -> Result<RowApplied, AppError> {
    apply_with_hook(conn, tables, ops_json, aliases, &NoHook)
}

/// 同 [`apply`]，但允许调用方挂一个删除钩子（T2 用它清图片桶）。
pub fn apply_with_hook(
    conn: &Connection,
    tables: &'static [RowTable],
    ops_json: &[u8],
    aliases: &AliasMap,
    hook: &dyn RowApplyHook,
) -> Result<RowApplied, AppError> {
    // 先看 format：新版本的文件不能当成损坏数据反复重读，要能让上层进入「需要升级」。
    // 引擎读远端文件时已经查过一次，这里再查是为了让本模块单独使用时也安全。
    format::check_format(ops_json)?;
    let segment = ParsedSegment::parse(ops_json)?;
    apply_ops_with_hook(conn, tables, &segment.ops, aliases, hook)
}

/// 落地已经解析好的 op 列表。T2 需要按「正在运行的会话」筛 op 时，先用
/// [`parse_segment_ops`] 解析、筛完再调这里。
pub fn apply_ops(
    conn: &Connection,
    tables: &'static [RowTable],
    ops: &[RowOp],
    aliases: &AliasMap,
) -> Result<RowApplied, AppError> {
    apply_ops_with_hook(conn, tables, ops, aliases, &NoHook)
}

/// 同 [`apply_ops`]，带删除钩子。
pub fn apply_ops_with_hook(
    conn: &Connection,
    tables: &'static [RowTable],
    ops: &[RowOp],
    aliases: &AliasMap,
    hook: &dyn RowApplyHook,
) -> Result<RowApplied, AppError> {
    apply_parsed(conn, tables, ops, aliases, hook)
}

/// 解析一段明文里的 op 列表（格式过新 → `AppError`，文案里带「请升级应用」）。
pub fn parse_segment_ops(ops_json: &[u8]) -> Result<Vec<RowOp>, AppError> {
    super::parse_segment(ops_json).map(|s| s.ops)
}

fn apply_parsed(
    conn: &Connection,
    tables: &'static [RowTable],
    ops: &[RowOp],
    aliases: &AliasMap,
    hook: &dyn RowApplyHook,
) -> Result<RowApplied, AppError> {
    if ops.is_empty() {
        return Ok(RowApplied::default());
    }

    // 父墓碑先整批扫一遍：同一批里父行被删，子行 op 直接丢弃（父行会另有 op 到达，
    // 子行的墓碑没有必要再发一遍；而如果子行 op 是「改」，父行都没了它只会变成孤儿）。
    // 先扫而不是边落边看，是因为子行 op 可能排在父墓碑前面。
    let mut parent_tombstones: BTreeSet<(&str, &str)> = BTreeSet::new();
    for op in ops {
        if !op.del {
            continue;
        }
        let is_parent = tables
            .iter()
            .any(|t| t.parent.map(|(_, p)| p) == Some(op.table.as_str()));
        if is_parent {
            parent_tombstones.insert((op.table.as_str(), op.id.as_str()));
        }
    }

    in_savepoint(conn, "sync_rows_apply", || {
        // 落地抑制：`temp.sync_applying` 里有一行时，所有本模块的触发器都不记日志。
        let _suppress = suppress_capture(conn)?;
        let mut result = RowApplied::default();
        // 本批里成功写入了哪些父表：它们的子表可能有一批「等父行」的 op 可以重放了。
        let mut touched_parents: BTreeSet<&'static str> = BTreeSet::new();

        for op in ops {
            let Some(table) = tables.iter().find(|t| t.name == op.table) else {
                // 本机没有这张表：整条 op 存进 sync_row_clock，等升级后重放。
                if store_pending_op(conn, op)? {
                    result.stored_unknown += 1;
                } else {
                    result.skipped += 1;
                }
                continue;
            };

            // 同一批里父行有墓碑：子行 op 直接丢弃（任务书第一节第 5 条）。
            // 墓碑是「终局」的（见 `accept` 的文档），子行无论时钟新旧都没有意义。
            if masked_by_parent(conn, table, op, &parent_tombstones)? {
                result.skipped += 1;
                continue;
            }

            match apply_one(conn, tables, table, op, aliases, hook, &mut result)? {
                Outcome::Applied => {
                    result.applied += 1;
                    // 父行写成功了：暂存的子行 op 可能可以重放了。哪怕内容没变也要试一次
                    // （子行等的是「父行存在」这个事实，不是父行内容变化）。
                    if !op.del {
                        touched_parents.insert(table.name);
                    }
                }
                Outcome::Deferred => result.deferred += 1,
                Outcome::Orphan => result.skipped += 1,
                Outcome::Rejected => result.skipped += 1,
            }
        }

        // 父行到了：把之前因为父行没到而暂存的子行 op 补落地。
        if !touched_parents.is_empty() {
            let children: Vec<&'static str> = tables
                .iter()
                .filter(|t| {
                    t.parent
                        .map(|(_, p)| p)
                        .is_some_and(|p| touched_parents.contains(p))
                })
                .map(|t| t.name)
                .collect();
            for child in children {
                let replayed = replay_pending_for(conn, tables, aliases, hook, child)?;
                result.merge(replayed);
            }
        }

        Ok(result)
    })
}

enum Outcome {
    /// 被接受（内容变没变记在 `RowApplied` 里）。
    Applied,
    /// 父行还没到：存起来，等父行落地后重放。
    Deferred,
    /// 父行已经被删：这条子行 op 永远没用了。
    Orphan,
    /// 时钟更旧或合并策略判定不该落地。
    Rejected,
}

/// 子行 op 是否被同一批里的父墓碑压掉。
fn masked_by_parent(
    conn: &Connection,
    table: &RowTable,
    op: &RowOp,
    tombstones: &BTreeSet<(&str, &str)>,
) -> Result<bool, AppError> {
    let Some((fk_col, parent_table)) = table.parent else {
        return Ok(false);
    };
    if tombstones.is_empty() {
        return Ok(false);
    }
    // 外键值：upsert 的 op 里带着；墓碑 / 部分列 op 里没有，就去读本机当前行。
    let from_op = op
        .cols
        .as_ref()
        .and_then(|c| c.get(fk_col))
        .and_then(Value::as_str)
        .map(str::to_string);
    let value = match from_op {
        Some(v) => Some(v),
        None => read_columns(conn, table.name, table.pk, &op.id, &[fk_col])?
            .and_then(|m| m.get(fk_col).and_then(Value::as_str).map(str::to_string)),
    };
    Ok(value
        .map(|v| tombstones.contains(&(parent_table, v.as_str())))
        .unwrap_or(false))
}

/// 落地一条已知表的 op。
fn apply_one(
    conn: &Connection,
    tables: &'static [RowTable],
    table: &RowTable,
    op: &RowOp,
    aliases: &AliasMap,
    hook: &dyn RowApplyHook,
    result: &mut RowApplied,
) -> Result<Outcome, AppError> {
    let clock = read_clock(conn, table.name, &op.id)?;

    if !accept(conn, table, op, clock.as_ref())? {
        return Ok(Outcome::Rejected);
    }

    let mut incoming = incoming_columns(table, op, aliases);

    // `LatestBy` 的比较列一定要写进去（部分列 op 可能只带了别的字段）。
    if let RowMerge::LatestBy(col) = table.merge {
        if !incoming.contains_key(col) {
            let fallback = op
                .cols
                .as_ref()
                .and_then(|c| c.get(col))
                .or_else(|| op.extra.as_ref().and_then(|c| c.get(col)));
            if let Some(v) = fallback {
                if table.column(col).map(|c| c.scope) == Some(ColumnScope::Shared) {
                    incoming.insert(col.to_string(), v.clone());
                }
            }
        }
    }
    // 主键由 `insert_parts` 用自己的形参写，别当成普通列再写一遍。
    incoming.remove(table.pk);

    // 先从本机当前行取「这条 op 影响的会话 id」（删除前必须读，删完就没了）。
    let conversation = conversation_of(conn, table, op, &incoming)?;

    if op.del {
        let existed = row_exists(conn, table.name, table.pk, &op.id)?;
        // 先让业务侧清理它自己的资源（图片桶），再删子行、删父行：顺序反了就读不到图片路径了。
        if existed {
            hook.before_row_delete(conn, table.name, &op.id)?;
        }
        let cascaded = cascade_delete_children(conn, tables, table.name, &op.id)?;
        // 之前因为「父行还没到」被暂存的子行 op 现在也永远用不上了，一并清掉，
        // 免得占位记录一直躺在 sync_row_clock 里。
        drop_pending_children(conn, tables, table.name, &op.id)?;
        if existed {
            conn.execute(
                &format!(
                    "DELETE FROM {} WHERE {} = ?1",
                    quote_ident(table.name),
                    quote_ident(table.pk)
                ),
                [&op.id],
            )
            .map_err(|e| sql_err("删除同步行失败", e))?;
        }
        if existed || cascaded {
            mark_changed(result, table.name);
            push_conversation(result, conversation);
        }
        // 行本来就不在 = 内容没变，但时钟照样推进（否则同一条墓碑每次都会被当成新的）。
        // 删除时 extra 清空：行都没了，留着旧字段只会在重建时诈尸。
        write_clock(conn, table.name, &op.id, &op.hlc, true, &BTreeMap::new())?;
        return Ok(Outcome::Applied);
    }

    // 子行：父行在不在？不在就先等（见模块文档的引用完整性一节）。
    if let Some((fk_col, parent_table)) = table.parent {
        if let Some(parent_id) = incoming.get(fk_col).and_then(Value::as_str) {
            if !row_exists(
                conn,
                parent_table,
                parent_pk(tables, parent_table),
                parent_id,
            )? {
                let parent_gone = read_clock(conn, parent_table, parent_id)?
                    .map(|c| c.deleted)
                    .unwrap_or(false);
                if parent_gone {
                    // 父行已经被删掉了：这条子行永远不会有归属，丢弃。
                    return Ok(Outcome::Orphan);
                }
                // 父行还没到：先存起来，等父行落地后重放。
                store_pending_op(conn, op)?;
                return Ok(Outcome::Deferred);
            }
        }
    }

    let extra = merge_extra(table, op, clock.as_ref().map(|c| c.extra.clone()));

    let compare_cols = column_names(table, &incoming);
    let current = read_columns(conn, table.name, table.pk, &op.id, &compare_cols)?;
    let changed = match &current {
        None => true,
        Some(row) => incoming.iter().any(|(k, v)| row.get(k) != Some(v)),
    };

    if changed {
        if current.is_some() {
            update_row(conn, table, &op.id, &incoming)?;
        } else {
            insert_row(conn, table, &op.id, &incoming)?;
        }
        mark_changed(result, table.name);
        push_conversation(result, conversation);
    }
    // 内容没变也写时钟：这条 op 已经「看过」了，下次同一条不必再比较。
    write_clock(conn, table.name, &op.id, &op.hlc, false, &extra)?;
    Ok(Outcome::Applied)
}

fn parent_pk(tables: &'static [RowTable], parent: &str) -> &'static str {
    tables
        .iter()
        .find(|t| t.name == parent)
        .map(|t| t.pk)
        // 表清单里声明了父表却找不到它，是使用方的清单写错了；退回 "id" 让 `row_exists`
        // 查一张不存在的表时报明确错误，而不是在这里 panic。
        .unwrap_or("id")
}

fn row_exists(conn: &Connection, table: &str, pk: &str, row_id: &str) -> Result<bool, AppError> {
    Ok(read_columns(conn, table, pk, row_id, &[])?.is_some())
}

/// 删掉所有声明了「父表 = `parent`」的子表里、外键指向这一行的行。
///
/// 发送方只发一个父墓碑（见任务书第一节第 5 条），级联删除是接收方的责任；同时它也是
/// 外键允许删掉父行的前提。
fn cascade_delete_children(
    conn: &Connection,
    tables: &'static [RowTable],
    parent: &str,
    row_id: &str,
) -> Result<bool, AppError> {
    let mut any = false;
    for child in tables {
        let Some((fk_col, child_parent)) = child.parent else {
            continue;
        };
        if child_parent != parent {
            continue;
        }
        let n = conn
            .execute(
                &format!(
                    "DELETE FROM {} WHERE {} = ?1",
                    quote_ident(child.name),
                    quote_ident(fk_col)
                ),
                [row_id],
            )
            .map_err(|e| sql_err("级联删除同步子行失败", e))?;
        any |= n > 0;
    }
    Ok(any)
}

/// 父行被删时，清掉子表里「等这个父行」的暂存 op。
fn drop_pending_children(
    conn: &Connection,
    tables: &'static [RowTable],
    parent: &str,
    parent_id: &str,
) -> Result<(), AppError> {
    for child in tables {
        let Some((fk_col, child_parent)) = child.parent else {
            continue;
        };
        if child_parent != parent {
            continue;
        }
        let ids: Vec<String> = {
            let mut stmt = conn
                .prepare(
                    "SELECT row_id, extra_json FROM sync_row_clock
                     WHERE tbl = ?1 AND extra_json LIKE '%__rowop%'",
                )
                .map_err(|e| sql_err("读取暂存子行失败", e))?;
            let rows = stmt
                .query_map([child.name], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?))
                })
                .map_err(|e| sql_err("读取暂存子行失败", e))?;
            let mut out = Vec::new();
            for row in rows {
                let (row_id, extra) = row.map_err(|e| sql_err("读取暂存子行失败", e))?;
                let Some(extra) = extra else { continue };
                let Ok(map) = serde_json::from_str::<BTreeMap<String, Value>>(&extra) else {
                    continue;
                };
                let Some(wrapped) = map.get(UNKNOWN_OP_KEY) else {
                    continue;
                };
                let Ok(op) = serde_json::from_value::<RowOp>(wrapped.clone()) else {
                    continue;
                };
                let same_parent = op
                    .cols
                    .as_ref()
                    .and_then(|c| c.get(fk_col))
                    .and_then(Value::as_str)
                    == Some(parent_id);
                if same_parent {
                    out.push(row_id);
                }
            }
            out
        };
        for id in ids {
            conn.execute(
                "DELETE FROM sync_row_clock WHERE tbl = ?1 AND row_id = ?2",
                rusqlite::params![child.name, id],
            )
            .map_err(|e| sql_err("清理暂存子行失败", e))?;
        }
    }
    Ok(())
}

/// 这条远端 op 该不该落地。
fn accept(
    conn: &Connection,
    table: &RowTable,
    op: &RowOp,
    clock: Option<&ClockRow>,
) -> Result<bool, AppError> {
    match table.merge {
        RowMerge::Lww => {
            // **删除是绝对且终局的**：只要这一行本机已经记成「删过」，之后任何 upsert 都不接受；
            // 反过来，墓碑本身永远接受（不看 HLC）。这是三设备随机收敛测试逼出来的规则：
            //
            //   A 改了会话（HLC 200）但还没收到 B 的删除（HLC 100）——若按纯 LWW，A 会拒绝这个
            //   「更旧」的墓碑，于是 A 有这一行、B 没有，且再没有任何 op 能让两边一致。
            //
            // 让删除无条件获胜就没有这个问题：所有设备最终都删。业务上也说得通——删会话是用户的
            // 明确意图，同时改标题本来就该让位于删除；id 是 UUID，不会「删除后又重建同一个 id」。
            // 子行的级联删除同理（见 `cascade_delete_children`），否则父行删了、子行还在，外键也不允许。
            if op.del {
                // 已经删过、而且这条墓碑不比已记下的新：重复投递，什么都不用做。
                return Ok(match clock {
                    Some(c) if c.deleted => op.hlc > c.hlc,
                    _ => true,
                });
            }
            Ok(match clock {
                // 本机从没见过这一行：没有可比的东西，接受。
                None => true,
                Some(c) if c.deleted => false,
                Some(c) => op.hlc > c.hlc,
            })
        }
        RowMerge::LatestBy(col) => {
            if op.del {
                // 这两张表没有删除语义；真出现删除就退回 HLC 比较，至少不会因为「没法比较」
                // 而让墓碑永远落不下来。
                return Ok(match clock {
                    None => true,
                    Some(c) => op.hlc > c.hlc,
                });
            }
            let Some(remote) = op
                .cols
                .as_ref()
                .and_then(|c| c.get(col))
                .or_else(|| op.extra.as_ref().and_then(|c| c.get(col)))
                .and_then(Value::as_str)
            else {
                // op 里没带比较列：无法判断，宁可不落地（下一轮完整行会来）。
                return Ok(false);
            };
            // 本机这一行已经不在了：没有可比的值，按「远端更新」处理。
            if clock.map(|c| c.deleted).unwrap_or(false) {
                // 这一行已经被删过，删除是终局（同 LWW 的规则）。
                return Ok(false);
            }
            let Some(local_row) = read_columns(conn, table.name, table.pk, &op.id, &[col])? else {
                return Ok(true);
            };
            let local = local_row.get(col).and_then(Value::as_str).unwrap_or("");
            // RFC3339 定长、同格式下字典序 == 时间序。
            if remote != local {
                return Ok(remote > local);
            }
            // 比较列相同（两条不同消息落在同一毫秒）时用 HLC 兜底：合并必须是全序，否则
            // 「anchor 相同、anchor_message_id 不同」的两台设备永远各执一份。HLC 本身是全序，
            // 用它做第二关键字既确定又不会让「更晚的 anchor」输给「更早的 anchor」。
            Ok(match clock {
                None => true,
                Some(c) => op.hlc > c.hlc,
            })
        }
    }
}

/// 这条 op 所属的会话 id。
fn conversation_of(
    conn: &Connection,
    table: &RowTable,
    op: &RowOp,
    incoming: &BTreeMap<String, Value>,
) -> Result<Option<String>, AppError> {
    let Some(field) = conversation_field(table.name) else {
        return Ok(None);
    };
    let value = match field {
        // 会话表自己：行 id 就是会话 id。
        None => Some(op.id.clone()),
        Some(col) => incoming
            .get(col)
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| {
                read_columns(conn, table.name, table.pk, &op.id, &[col])
                    .ok()
                    .flatten()
                    .and_then(|m| m.get(col).and_then(Value::as_str).map(str::to_string))
            }),
    };
    Ok(value.filter(|v| !v.is_empty()))
}

/// 这张表里的行属于哪段会话：`Some(None)` = 行 id 本身就是会话 id；
/// `Some(Some(列))` = 读这一列；`None` = 与会话无关。
///
/// 表名固定来自契约第 11 节（T2 / T4 的表清单），所以用一张小映射而不是给 `RowTable`
/// 加字段：契约把 `RowTable` 的形状钉死了，加字段会让 T2 / T4 少写一个就编译不过。
fn conversation_field(table: &str) -> Option<Option<&'static str>> {
    match table {
        "conversations" => Some(None),
        "messages" | "plans" | "plan_snapshots" | "reflection_notes" => {
            Some(Some("conversation_id"))
        }
        "memories" | "memory_rejections" => Some(Some("source_conversation_id")),
        _ => None,
    }
}

fn push_conversation(result: &mut RowApplied, conversation: Option<String>) {
    if let Some(id) = conversation {
        if !result.conversation_ids.contains(&id) {
            result.conversation_ids.push(id);
        }
    }
}

/// 落地时合并 extra：
/// - 远端带的、本机认识且 `Shared` 的列进 `incoming`（写进行里），不进 extra；
/// - 本机认识的 `Local` 列直接忽略（远端值不覆盖本机），也不留；
/// - 本机不认识的列（无论出现在 `cols` 还是 `extra`）原样留着；
/// - 本机时钟里原有、这次没被提到的未知列继续保留（否则会丢）。
fn merge_extra(
    table: &RowTable,
    op: &RowOp,
    existing: Option<BTreeMap<String, Value>>,
) -> BTreeMap<String, Value> {
    let mut extra = existing.unwrap_or_default();
    // 升级后某列变成本机认识的了：旧 extra 里的同名条目必须丢掉，否则会一直跟着行跑。
    extra.retain(|name, _| table.column(name).is_none());
    for map in [&op.extra, &op.cols].into_iter().flatten() {
        for (name, value) in map {
            if table.column(name).is_some() {
                continue;
            }
            extra.insert(name.clone(), value.clone());
        }
    }
    extra
}

/// 往已存在的行里写给定的列。
///
/// 不用 `INSERT … ON CONFLICT DO UPDATE`：SQLite 在解决冲突**之前**就会对 INSERT 的元组
/// 做 `NOT NULL` 检查，一条只带 `title` 的部分 op 会因为没有 `connection_id` 而失败。
/// 先判存在再 UPDATE 就没有这个问题（存在性上面已经查过）。
fn update_row(
    conn: &Connection,
    table: &RowTable,
    id: &str,
    cols: &BTreeMap<String, Value>,
) -> Result<(), AppError> {
    let mut assignments = Vec::new();
    let mut values = Vec::new();
    for (name, value) in cols {
        if table.column(name).map(|c| c.scope) != Some(ColumnScope::Shared) {
            continue;
        }
        assignments.push(format!("{} = ?", quote_ident(name)));
        values.push(super::shared::json_to_sql(value));
    }
    if assignments.is_empty() {
        return Ok(());
    }
    values.push(rusqlite::types::Value::Text(id.to_string()));
    let sql = format!(
        "UPDATE {} SET {} WHERE {} = ?{}",
        quote_ident(table.name),
        assignments.join(", "),
        quote_ident(table.pk),
        values.len()
    );
    conn.execute(&sql, rusqlite::params_from_iter(values.iter()))
        .map_err(|e| sql_err("更新同步行失败", e))?;
    Ok(())
}

/// 插入一行。
fn insert_row(
    conn: &Connection,
    table: &RowTable,
    id: &str,
    cols: &BTreeMap<String, Value>,
) -> Result<(), AppError> {
    let (names, values) = insert_parts(table, id, cols);
    let sql = format!(
        "INSERT INTO {} ({names}) VALUES ({placeholders})",
        quote_ident(table.name),
        placeholders = (1..=values.len())
            .map(|i| format!("?{i}"))
            .collect::<Vec<_>>()
            .join(", "),
    );
    conn.execute(&sql, rusqlite::params_from_iter(values.iter()))
        .map_err(|e| sql_err("写入同步行失败", e))?;
    Ok(())
}

fn column_names(table: &RowTable, cols: &BTreeMap<String, Value>) -> Vec<&'static str> {
    // 列名都来自表清单（'static），直接回传给 `read_columns`（它只需要 `&str`）。
    table
        .columns
        .iter()
        .filter(|c| c.scope == ColumnScope::Shared && cols.contains_key(c.name))
        .map(|c| c.name)
        .collect()
}

fn mark_changed(result: &mut RowApplied, table: &str) {
    result.changed = true;
    result.changed_tables.insert(table.to_string());
}

// ---------------------------------------------------------------------------
// 未知表 / 等父行的子行：存起来，以后再重放
// ---------------------------------------------------------------------------

/// 把整条 op 塞进 `sync_row_clock.extra_json`，等以后再重放。
///
/// 两种用途共用同一套标记：
/// - 本机不认识的表（升级后 [`replay_unknown`] 补落地）；
/// - 父行还没到的子行（父行落地时自动重放）。
///
/// 返回 `true` = 存下了新东西（比已有记录新）；`false` = 已经有更新的记录，忽略。
fn store_pending_op(conn: &Connection, op: &RowOp) -> Result<bool, AppError> {
    if let Some(clock) = read_clock(conn, &op.table, &op.id)? {
        if op.hlc <= clock.hlc {
            return Ok(false);
        }
    }
    let mut extra = BTreeMap::new();
    // 整条 op 原样放成对象（`__rowop` 不可能撞上真实列名，见 `UNKNOWN_OP_KEY` 的文档）。
    extra.insert(
        UNKNOWN_OP_KEY.to_string(),
        serde_json::to_value(op)
            .map_err(|e| AppError::Other(format!("序列化待重放行失败：{e}")))?,
    );
    // `deleted = 0`：这一行表示「躺着一整条等待重放的 op」，不是「这一行被删了」。
    write_clock(conn, &op.table, &op.id, &op.hlc, false, &extra)?;
    Ok(true)
}

/// 把以前「本机不认识」的表 op 补落地。使用方在 `install` 之后调用一次（T2 / T4 启动时）。
pub fn replay_unknown(
    conn: &Connection,
    tables: &'static [RowTable],
    aliases: &AliasMap,
) -> Result<RowApplied, AppError> {
    replay_pending_for(conn, tables, aliases, &NoHook, "")
}

/// 重放 `sync_row_clock` 里暂存的 op：`only_table` 为空 = 所有已知表；否则只重放这张表。
/// 父行仍然没到的子行会再次被暂存（不会死循环：这次重放只跑一轮）。
fn replay_pending_for(
    conn: &Connection,
    tables: &'static [RowTable],
    aliases: &AliasMap,
    hook: &dyn RowApplyHook,
    only_table: &str,
) -> Result<RowApplied, AppError> {
    let mut pending: Vec<RowOp> = Vec::new();
    {
        let sql = if only_table.is_empty() {
            "SELECT tbl, row_id, extra_json FROM sync_row_clock WHERE extra_json LIKE '%__rowop%'"
                .to_string()
        } else {
            "SELECT tbl, row_id, extra_json FROM sync_row_clock
             WHERE tbl = ?1 AND extra_json LIKE '%__rowop%'"
                .to_string()
        };
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| sql_err("读取待重放的同步行失败", e))?;
        let map_row = |r: &rusqlite::Row<'_>| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        };
        let rows = if only_table.is_empty() {
            stmt.query_map([], map_row)
                .map_err(|e| sql_err("读取待重放的同步行失败", e))?
                .collect::<rusqlite::Result<Vec<_>>>()
        } else {
            stmt.query_map([only_table], map_row)
                .map_err(|e| sql_err("读取待重放的同步行失败", e))?
                .collect::<rusqlite::Result<Vec<_>>>()
        }
        .map_err(|e| sql_err("读取待重放的同步行失败", e))?;

        for (tbl, row_id, extra) in rows {
            if !tables.iter().any(|t| t.name == tbl) {
                continue;
            }
            let Some(extra) = extra else { continue };
            let Ok(map) = serde_json::from_str::<BTreeMap<String, Value>>(&extra) else {
                continue;
            };
            let Some(wrapped) = map.get(UNKNOWN_OP_KEY) else {
                continue;
            };
            if let Ok(op) = serde_json::from_value::<RowOp>(wrapped.clone()) {
                if op.table == tbl && op.id == row_id {
                    pending.push(op);
                }
            }
        }
    }
    if pending.is_empty() {
        return Ok(RowApplied::default());
    }

    // 先摘掉占位时钟（它们和 op 的 HLC 相等，正常比较会判「不比自己新」而拒绝）。
    for op in &pending {
        conn.execute(
            "DELETE FROM sync_row_clock WHERE tbl = ?1 AND row_id = ?2",
            rusqlite::params![op.table, op.id],
        )
        .map_err(|e| sql_err("清理待重放的同步行失败", e))?;
    }
    apply_parsed(conn, tables, &pending, aliases, hook)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversation_field_matches_contract_table_list() {
        assert_eq!(conversation_field("conversations"), Some(None));
        assert_eq!(
            conversation_field("messages"),
            Some(Some("conversation_id"))
        );
        assert_eq!(
            conversation_field("memories"),
            Some(Some("source_conversation_id"))
        );
        assert_eq!(conversation_field("reflection_progress"), None);
    }
}
