use serde::Serialize;
use tauri::State;

use crate::config::persist::JsonPersistable;
use crate::error::AppError;
use crate::mcp::manager::McpServerRuntimeStatus;
use crate::mcp::protocol::McpToolInfo;
use crate::mcp::store::{McpServerConfig, McpServerInput, McpServerStore};
use crate::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerListResponse {
    pub servers: Vec<McpServerConfig>,
    pub statuses: Vec<McpServerRuntimeStatus>,
}

#[tauri::command]
pub async fn mcp_list_servers(
    state: State<'_, AppState>,
) -> Result<McpServerListResponse, AppError> {
    let servers = state.mcp_store.read().await.list().to_vec();
    let statuses = state.mcp_manager.statuses(&servers).await;
    Ok(McpServerListResponse { servers, statuses })
}

#[tauri::command]
pub async fn mcp_add_server(
    state: State<'_, AppState>,
    input: McpServerInput,
) -> Result<McpServerConfig, AppError> {
    let server = McpServerConfig::new(input)?;
    let cloned = server.clone();
    let path = McpServerStore::default_file(&state.config_dir);
    let mut store = state.mcp_store.write().await;
    let mut candidate = store.clone();
    candidate.add(server);
    candidate.save_to_path(&path)?;
    *store = candidate;
    drop(store);

    // 触发跨设备同步：mcpServers 变更
    if let Some(ref scheduler) = state.sync_scheduler {
        if let Some(ref engine) = state.sync_engine {
            let _ = engine.record_local_change(
                &format!("mcpServers.{}", cloned.id),
                &serde_json::to_string(&cloned).unwrap_or_default(),
            );
            scheduler.schedule_push();
        }
    }

    Ok(cloned)
}

#[tauri::command]
pub async fn mcp_update_server(
    state: State<'_, AppState>,
    id: String,
    input: McpServerInput,
) -> Result<(), AppError> {
    let path = McpServerStore::default_file(&state.config_dir);
    let updated = {
        let mut store = state.mcp_store.write().await;
        let mut candidate = store.clone();
        candidate.update(&id, input)?;
        let updated = candidate
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::Config(format!("MCP server not found: {}", id)))?;
        candidate.save_to_path(&path)?;
        *store = candidate;
        updated
    };
    state.mcp_manager.clear_cache(&id).await;

    // 触发跨设备同步：mcpServers 变更
    if let Some(ref scheduler) = state.sync_scheduler {
        if let Some(ref engine) = state.sync_engine {
            let _ = engine.record_local_change(
                &format!("mcpServers.{}", id),
                &serde_json::to_string(&updated).unwrap_or_default(),
            );
            scheduler.schedule_push();
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn mcp_delete_server(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let path = McpServerStore::default_file(&state.config_dir);
    {
        let mut store = state.mcp_store.write().await;
        let mut candidate = store.clone();
        candidate.delete(&id)?;
        candidate.save_to_path(&path)?;
        *store = candidate;
    }
    state.mcp_manager.clear_cache(&id).await;

    // 触发跨设备同步：mcpServers 删除
    if let Some(ref scheduler) = state.sync_scheduler {
        if let Some(ref engine) = state.sync_engine {
            let _ = engine.record_local_delete(&format!("mcpServers.{}", id));
            scheduler.schedule_push();
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn mcp_toggle_server(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let path = McpServerStore::default_file(&state.config_dir);
    let updated = {
        let mut store = state.mcp_store.write().await;
        let mut candidate = store.clone();
        candidate.toggle(&id)?;
        let updated = candidate
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::Config(format!("MCP server not found: {}", id)))?;
        candidate.save_to_path(&path)?;
        *store = candidate;
        updated
    };
    // enabled 不进 tools cache key；Agent 只注册 store 里 enabled 的 server。
    // 不清 cache，避免关/开闪空与无意义重刷。

    // 触发跨设备同步：mcpServers 变更（toggle 改变 enabled 状态）
    if let Some(ref scheduler) = state.sync_scheduler {
        if let Some(ref engine) = state.sync_engine {
            let _ = engine.record_local_change(
                &format!("mcpServers.{}", id),
                &serde_json::to_string(&updated).unwrap_or_default(),
            );
            scheduler.schedule_push();
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn mcp_refresh_tools(
    state: State<'_, AppState>,
    id: String,
) -> Result<Vec<McpToolInfo>, AppError> {
    let server = {
        let store = state.mcp_store.read().await;
        store
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::Config(format!("MCP server not found: {}", id)))?
    };
    state.mcp_manager.refresh_tools(&server).await
}

#[tauri::command]
pub async fn mcp_call_tool(
    state: State<'_, AppState>,
    id: String,
    tool_name: String,
    arguments: serde_json::Value,
) -> Result<String, AppError> {
    let server = {
        let store = state.mcp_store.read().await;
        store
            .get(&id)
            .cloned()
            .ok_or_else(|| AppError::Config(format!("MCP server not found: {}", id)))?
    };
    state
        .mcp_manager
        .call_tool(&server, &tool_name, arguments)
        .await
}
