use tauri::State;
use uuid::Uuid;

use crate::config::connections::{RemotePlatform, SavedConnection};
use crate::config::keychain::{self, SecretSlot};
use crate::error::AppError;
use crate::AppState;

/// Get all saved connections.
#[tauri::command]
pub async fn config_get_connections(
    state: State<'_, AppState>,
) -> Result<Vec<SavedConnection>, AppError> {
    let store = state.connection_store.read().await;
    Ok(store.get_all().to_vec())
}

/// Save a new or updated connection. Returns the connection ID.
/// Persists the updated store to disk.
///
/// 已存在的连接**原地替换**：数组顺序就是用户拖拽出来的展示顺序（见
/// `ConnectionStore::replace_keeping_order`），新连接才追加到末尾。
#[tauri::command]
pub async fn config_save_connection(
    state: State<'_, AppState>,
    mut connection: SavedConnection,
) -> Result<String, AppError> {
    if connection.id.is_empty() {
        connection.id = Uuid::new_v4().to_string();
    }
    let id = connection.id.clone();

    // 先持久化候选快照，成功后再提交内存（`mutate` 保证，失败保持旧值）。
    state
        .connection_store
        .mutate(|store| {
            store.replace_keeping_order(connection);
            Ok(())
        })
        .await?;

    Ok(id)
}

/// Persist an auto-detected remote platform.
///
/// A missing id is a successful no-op: the user may delete a connection while
/// the asynchronous probe is still in flight.
#[tauri::command]
pub async fn config_set_connection_remote_platform(
    state: State<'_, AppState>,
    id: String,
    platform: RemotePlatform,
) -> Result<(), AppError> {
    // 找不到 id / 值没变都是成功的 no-op：`set_remote_platform` 返回 false 时没动候选值，
    // `mutate` 序列化前后相同就不写盘。
    state
        .connection_store
        .mutate(|store| {
            store.set_remote_platform(&id, platform);
            Ok(())
        })
        .await
}

/// 一条连接的落位：id + 目标分组（`None` = 未分组）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionOrderEntry {
    pub id: String,
    #[serde(default)]
    pub group: Option<String>,
}

/// 应用前端计算好的连接顺序（拖拽排序的结果）。
///
/// 数组顺序即展示顺序、分组顺序即「组在数组里首次出现的位置」，所以三种拖拽
/// （组内重排 / 跨组拖拽即移入 / 拖动整个分组）最终都收敛为一次全量顺序写入。
/// 请求里缺的 id 补到末尾、不存在的 id 忽略，见 `ConnectionStore::apply_order`。
#[tauri::command]
pub async fn config_apply_connection_order(
    state: State<'_, AppState>,
    order: Vec<ConnectionOrderEntry>,
) -> Result<(), AppError> {
    if order.is_empty() {
        return Ok(());
    }
    let pairs: Vec<(String, Option<String>)> = order
        .into_iter()
        .map(|entry| {
            let group = entry
                .group
                .map(|g| g.trim().to_string())
                .filter(|g| !g.is_empty());
            (entry.id, group)
        })
        .collect();

    // 改动前后的「连接 → 分组」都在 mutate 的闭包里取：闭包看到的就是持写者锁时的
    // 那一份，不会被并发写者插队。
    let (groups_before, groups_after, reordered, appended, ignored) = state
        .connection_store
        .mutate(|store| {
            let groups_before: Vec<(String, Option<String>)> = store
                .get_all()
                .iter()
                .map(|c| (c.id.clone(), c.group.clone()))
                .collect();
            let (reordered, appended, ignored) = store.apply_order(&pairs);
            let groups_after: Vec<(String, Option<String>)> = store
                .get_all()
                .iter()
                .map(|c| (c.id.clone(), c.group.clone()))
                .collect();
            Ok((groups_before, groups_after, reordered, appended, ignored))
        })
        .await?;

    // 分组改名 → 分组记忆跟着搬（认不出来的不动，见 `detect_group_renames`）。
    let mut moved_any = false;
    for (from, to) in crate::memory::scope::detect_group_renames(&groups_before, &groups_after) {
        match state.memory.store.rename_group(&from, &to) {
            Ok(n) if n > 0 => {
                moved_any = true;
                log::info!("分组改名 {from} → {to}：迁移 {n} 条分组记忆");
            }
            Ok(_) => {}
            Err(e) => log::warn!("分组改名 {from} → {to}：迁移分组记忆失败: {e}"),
        }
    }
    if moved_any {
        crate::memory::reflect::emit_changed(state.inner(), crate::memory::Source::User, None);
    }

    if appended > 0 || ignored > 0 {
        log::warn!(
            "连接排序：重排 {} 条，补齐 {} 条（请求里缺失），忽略 {} 条（请求里不存在的 id）",
            reordered,
            appended,
            ignored
        );
    }

    Ok(())
}

/// Delete a saved connection by ID. Persists the change and removes any
/// stored password from the system keychain.
#[tauri::command]
pub async fn config_delete_connection(
    state: State<'_, AppState>,
    id: String,
    delete_memories: Option<bool>,
    delete_conversations: Option<bool>,
) -> Result<(), AppError> {
    // 删之前先记下名字和地址：删完连接配置就没了，对话留下来要靠它们认人。
    let (name, host) = {
        let store = state.connection_store.read().await;
        match store.get_by_id(&id) {
            Some(c) => (Some(c.name.clone()), Some(c.host.clone())),
            None => (None, None),
        }
    };
    state
        .connection_store
        .mutate(|store| {
            if !store.remove(&id) {
                return Err(AppError::Config(format!("未找到连接: {}", id)));
            }
            Ok(())
        })
        .await?;

    // 这台服务器名下的对话：勾了「同时删除对话」就彻底删；否则全部归档并记下名字，
    // 在历史页「已删除的服务器」里还找得到，超过归档保留天数后随归档清理一起清掉。
    // 两条路都只是尽力而为，失败不影响删连接本身。
    if delete_conversations.unwrap_or(false) {
        match super::agent_conversation::delete_all_conversations_of_connection(state.inner(), &id)
        {
            Ok(n) if n > 0 => log::info!("删除连接 {id}：一并删除 {n} 条对话"),
            Ok(_) => {}
            Err(e) => log::warn!("删除连接 {id} 的对话失败: {e}"),
        }
    } else {
        match state
            .conversation_db
            .mark_connection_deleted(&id, name.as_deref(), host.as_deref())
        {
            Ok(n) if n > 0 => log::info!("删除连接 {id}：{n} 条对话已归档保留"),
            Ok(_) => {}
            Err(e) => log::warn!("归档连接 {id} 的对话失败: {e}"),
        }
    }

    // Best-effort: also purge every secret bound to this connection (登录密码 / 私钥口令 /
    // 跳板机密码 / 跳板机私钥口令) from the keychain. 槽位清单见 `SecretSlot::for_connection`。
    for slot in SecretSlot::for_connection(&id) {
        if let Err(e) = keychain::delete(&slot) {
            log::warn!("清除{}密钥链条目失败（id={}): {}", slot.describe(), id, e);
        }
    }
    // 删除确认框里勾了「同时删除这台机器的记忆」：作为一批用户改动删掉（可撤销）。
    // 没勾的话记忆留着，管理页会把它列在「已删除的连接」下。
    if delete_memories.unwrap_or(false) {
        match state
            .memory
            .store
            .delete_scope(&crate::memory::ScopeRef::host(id.clone()))
        {
            Ok((_, n)) if n > 0 => {
                log::info!("删除连接 {id}：一并删除 {n} 条机器记忆");
                crate::memory::reflect::emit_changed(
                    state.inner(),
                    crate::memory::Source::User,
                    None,
                );
            }
            Ok(_) => {}
            Err(e) => log::warn!("删除连接 {id} 的记忆失败: {e}"),
        }
    }
    Ok(())
}
