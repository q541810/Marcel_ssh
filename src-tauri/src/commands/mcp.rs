use serde::Serialize;
use tauri::State;

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
    let mut servers = state.mcp_store.read().await.list().to_vec();
    // headers 存在密钥链里；列表要能编辑，所以这里把它们填回返回值（**唯一**允许把
    // 鉴权头交给前端的路径，其余地方一律经 `effective_headers` 在 Rust 侧用）。
    for server in &mut servers {
        server.headers = McpServerStore::effective_headers(server);
    }
    let statuses = state.mcp_manager.statuses(&servers).await;
    Ok(McpServerListResponse { servers, statuses })
}

#[tauri::command]
pub async fn mcp_add_server(
    state: State<'_, AppState>,
    input: McpServerInput,
) -> Result<McpServerConfig, AppError> {
    let mut server = McpServerConfig::new(input)?;
    // 鉴权头只进密钥链：JSON 里留空，免得「可能含令牌的字段」明文落在配置目录里
    let headers = std::mem::take(&mut server.headers);
    McpServerStore::save_headers_to_keychain(&server.id, &headers)?;
    let cloned = server.clone();
    state
        .mcp_store
        .mutate(|store| {
            store.add(server);
            Ok(())
        })
        .await?;

    Ok(cloned)
}

#[tauri::command]
pub async fn mcp_update_server(
    state: State<'_, AppState>,
    id: String,
    input: McpServerInput,
) -> Result<(), AppError> {
    let mut input = input;
    let headers = std::mem::take(&mut input.headers);
    McpServerStore::save_headers_to_keychain(&id, &headers)?;
    state
        .mcp_store
        .mutate(|store| store.update(&id, input))
        .await?;
    // 落盘之后才清缓存：写盘失败时配置没变，缓存也该留着。
    state.mcp_manager.clear_cache(&id).await;

    Ok(())
}

#[tauri::command]
pub async fn mcp_delete_server(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.mcp_store.mutate(|store| store.delete(&id)).await?;
    McpServerStore::clear_headers_from_keychain(&id);
    state.mcp_manager.clear_cache(&id).await;

    Ok(())
}

#[tauri::command]
pub async fn mcp_toggle_server(state: State<'_, AppState>, id: String) -> Result<(), AppError> {
    state.mcp_store.mutate(|store| store.toggle(&id)).await?;
    // enabled 不进 tools cache key；Agent 只注册 store 里 enabled 的 server。
    // 不清 cache，避免关/开闪空与无意义重刷。

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
