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
pub async fn mcp_list_servers(state: State<'_, AppState>) -> Result<McpServerListResponse, AppError> {
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
    store.add(server);
    store.save_to_path(&path)?;
    Ok(cloned)
}

#[tauri::command]
pub async fn mcp_update_server(
    state: State<'_, AppState>,
    id: String,
    input: McpServerInput,
) -> Result<(), AppError> {
    let path = McpServerStore::default_file(&state.config_dir);
    {
        let mut store = state.mcp_store.write().await;
        store.update(&id, input)?;
        store.save_to_path(&path)?;
    }
    state.mcp_manager.clear_cache(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_delete_server(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let path = McpServerStore::default_file(&state.config_dir);
    {
        let mut store = state.mcp_store.write().await;
        store.delete(&id)?;
        store.save_to_path(&path)?;
    }
    state.mcp_manager.clear_cache(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_toggle_server(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    let path = McpServerStore::default_file(&state.config_dir);
    {
        let mut store = state.mcp_store.write().await;
        store.toggle(&id)?;
        store.save_to_path(&path)?;
    }
    state.mcp_manager.clear_cache(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_refresh_tools(state: State<'_, AppState>, id: String) -> Result<Vec<McpToolInfo>, AppError> {
    let server = {
        let store = state.mcp_store.read().await;
        store.get(&id).cloned().ok_or_else(|| AppError::Config(format!("MCP server not found: {}", id)))?
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
        store.get(&id).cloned().ok_or_else(|| AppError::Config(format!("MCP server not found: {}", id)))?
    };
    state.mcp_manager.call_tool(&server, &tool_name, arguments).await
}
