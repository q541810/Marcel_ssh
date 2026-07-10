import { invoke } from '@tauri-apps/api/core';
import type {
  ConnectionConfig,
  SavedConnection,
  AppSettings,
  AgentConversation,
  StoredMessage,
  AgentTaskPlan,
  Skill,
  QuickCommand,
  QuickCommandInput,
  QuickCommandPatch,
  McpServer,
  McpServerInput,
  McpServerListResponse,
  McpTool,
  UpdateCheckResult,
  ParsedSkill,
  CommandCheckResult,
  SftpFileEntry,
  ModelInfo,
  PluginManifest,
  PluginHttpRequest,
  PluginHttpResponse,
  ReloadDiff,
} from './types';

// SSH commands

export async function sshConnect(config: ConnectionConfig): Promise<string> {
  return invoke<string>('ssh_connect', { config });
}

export async function sshDisconnect(sessionId: string): Promise<void> {
  return invoke('ssh_disconnect', { sessionId });
}

export async function sshSendInput(sessionId: string, data: string): Promise<void> {
  return invoke('ssh_send_input', { sessionId, data });
}

export async function sshResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke('ssh_resize', { sessionId, cols, rows });
}

export async function sshListSessions(): Promise<string[]> {
  return invoke<string[]>('ssh_list_sessions');
}

export async function sshExec(sessionId: string, command: string): Promise<string> {
  return invoke<string>('ssh_exec', { sessionId, command });
}

export async function sshListProcesses(sessionId: string): Promise<string> {
  return invoke<string>('ssh_exec', {
    sessionId,
    command: 'ps -eo pid,user,pcpu,pmem,etime,comm,args --no-headers 2>/dev/null || ps -eo pid,user,pcpu,pmem,etime,comm,args --no-headers',
  });
}

// Agent commands

export async function agentStartTask(
  sessionId: string,
  prompt: string,
  mode: string,
  conversationId: string,
  history: {
    role: string;
    content: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolCallId?: string;
    reasoningContent?: string;
  }[],
): Promise<string> {
  return invoke<string>('agent_start_task', { sessionId, prompt, mode, conversationId, history });
}

export async function agentStopTask(taskId: string): Promise<void> {
  return invoke('agent_stop_task', { taskId });
}

export async function agentApproveOperation(
  taskId: string,
  operationId: string,
): Promise<void> {
  return invoke('agent_approve_operation', { taskId, operationId });
}

export async function agentRejectOperation(
  taskId: string,
  operationId: string,
): Promise<void> {
  return invoke('agent_reject_operation', { taskId, operationId });
}

export async function agentAnswerQuestion(
  taskId: string,
  questionId: string,
  answers: { selected: string[]; custom: string }[],
): Promise<void> {
  return invoke('agent_answer_question', { taskId, questionId, answers });
}

// Conversation management commands

export async function agentCreateConversation(
  sessionId: string,
  title?: string,
): Promise<string> {
  return invoke<string>('agent_create_conversation', { sessionId, title });
}

export async function agentListConversations(sessionId: string): Promise<AgentConversation[]> {
  return invoke<AgentConversation[]>('agent_list_conversations', { sessionId });
}

export async function agentListConversationsByConnection(connectionId: string): Promise<AgentConversation[]> {
  return invoke<AgentConversation[]>('agent_list_conversations_by_connection', { connectionId });
}

export async function agentLoadConversation(conversationId: string): Promise<StoredMessage[]> {
  return invoke<StoredMessage[]>('agent_load_conversation', { conversationId });
}

export async function agentLoadPlansByConversation(
  conversationId: string,
): Promise<{ taskId: string; plan: AgentTaskPlan; updatedAt: string }[]> {
  return invoke<{ taskId: string; plan: AgentTaskPlan; updatedAt: string }[]>(
    'agent_load_plans_by_conversation',
    { conversationId },
  );
}

export async function agentDeleteConversation(conversationId: string): Promise<void> {
  return invoke('agent_delete_conversation', { conversationId });
}

export async function agentTruncateConversation(
  conversationId: string,
  fromTimestamp: string,
): Promise<number> {
  return invoke<number>('agent_truncate_conversation', { conversationId, fromTimestamp });
}

export async function agentDeleteConversationsBySession(sessionId: string): Promise<void> {
  return invoke('agent_delete_conversations_by_session', { sessionId });
}

export async function agentCheckCommand(
  command: string,
  mode: 'plan' | 'agent' | 'auto',
): Promise<CommandCheckResult> {
  return invoke<CommandCheckResult>('agent_check_command', { command, mode });
}

// Config commands

export async function getConnections(): Promise<SavedConnection[]> {
  return invoke<SavedConnection[]>('config_get_connections');
}

export async function saveConnection(connection: SavedConnection): Promise<string> {
  return invoke<string>('config_save_connection', { connection });
}

export async function deleteConnection(id: string): Promise<void> {
  return invoke('config_delete_connection', { id });
}

export async function getSettings(): Promise<{ settings: AppSettings; hasApiKey: boolean; warning?: string }> {
  return invoke('config_get_settings');
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke('config_save_settings', { settings });
}

export async function validateCustomProtectedPaths(paths: string[]): Promise<string | null> {
  try {
    await invoke('config_validate_custom_protected_paths', { paths });
    return null;
  } catch (e) {
    return String(e);
  }
}

// Password / keychain commands

export async function savePassword(
  connectionId: string,
  password: string,
): Promise<void> {
  return invoke('config_save_password', { connectionId, password });
}

export async function hasPassword(connectionId: string): Promise<boolean> {
  return invoke<boolean>('config_has_password', { connectionId });
}

export async function connectWithSavedPassword(
  connectionId: string,
  trustNewHostKey = false,
): Promise<string> {
  return invoke<string>('ssh_connect_with_saved_password', { connectionId, trustNewHostKey });
}

export async function connectWithSavedPassphrase(
  connectionId: string,
  trustNewHostKey = false,
): Promise<string> {
  return invoke<string>('ssh_connect_with_saved_passphrase', { connectionId, trustNewHostKey });
}

export async function deletePassword(connectionId: string): Promise<void> {
  return invoke('config_delete_password', { connectionId });
}

export async function sshReconnect(
  sessionId: string,
  connectionId: string,
  trustNewHostKey = false,
): Promise<void> {
  return invoke('ssh_reconnect', { sessionId, connectionId, trustNewHostKey });
}

export async function savePassphrase(
  connectionId: string,
  passphrase: string,
): Promise<void> {
  return invoke('config_save_passphrase', { connectionId, passphrase });
}

export async function hasPassphrase(connectionId: string): Promise<boolean> {
  return invoke<boolean>('config_has_passphrase', { connectionId });
}

export async function deletePassphrase(connectionId: string): Promise<void> {
  return invoke('config_delete_passphrase', { connectionId });
}

// Quick command commands

export async function quickCommandList(sessionKey?: string | null): Promise<QuickCommand[]> {
  return invoke<QuickCommand[]>('quick_command_list', { sessionKey: sessionKey ?? null });
}

export async function quickCommandAdd(command: QuickCommandInput): Promise<QuickCommand> {
  return invoke<QuickCommand>('quick_command_add', { command });
}

export async function quickCommandUpdate(id: string, patch: QuickCommandPatch): Promise<void> {
  return invoke('quick_command_update', { id, patch });
}

export async function quickCommandDelete(id: string): Promise<void> {
  return invoke('quick_command_delete', { id });
}

// MCP commands

export async function mcpListServers(): Promise<McpServerListResponse> {
  return invoke<McpServerListResponse>('mcp_list_servers');
}

export async function mcpAddServer(input: McpServerInput): Promise<McpServer> {
  return invoke<McpServer>('mcp_add_server', { input });
}

export async function mcpUpdateServer(id: string, input: McpServerInput): Promise<void> {
  return invoke('mcp_update_server', { id, input });
}

export async function mcpDeleteServer(id: string): Promise<void> {
  return invoke('mcp_delete_server', { id });
}

export async function mcpToggleServer(id: string): Promise<void> {
  return invoke('mcp_toggle_server', { id });
}

export async function mcpRefreshTools(id: string): Promise<McpTool[]> {
  return invoke<McpTool[]>('mcp_refresh_tools', { id });
}

// LLM API Key management

export async function saveLlmApiKey(apiKey: string): Promise<void> {
  return invoke('config_save_llm_api_key', { apiKey });
}

export async function deleteLlmApiKey(): Promise<void> {
  return invoke('config_delete_llm_api_key');
}

// LLM model discovery

/**
 * Fetch the list of models available on the configured provider.
 * Pass the current draft baseUrl/apiKey so the request reflects the UI state;
 * the backend falls back to the keychain when apiKey is empty or masked.
 */
export async function llmListModels(
  baseUrl?: string | null,
  apiKey?: string | null,
): Promise<ModelInfo[]> {
  return invoke<ModelInfo[]>('llm_list_models', {
    baseUrl: baseUrl ?? null,
    apiKey: apiKey ?? null,
  });
}

// Skill commands

export async function skillList(): Promise<Skill[]> {
  return invoke<Skill[]>('skill_list');
}

export async function skillAdd(
  name: string,
  description: string,
  prompt: string,
): Promise<Skill> {
  return invoke<Skill>('skill_add', { name, description, prompt });
}

export async function skillUpdate(
  id: string,
  name?: string,
  description?: string,
  prompt?: string,
): Promise<void> {
  return invoke('skill_update', { id, name, description, prompt });
}

export async function skillToggle(id: string): Promise<void> {
  return invoke('skill_toggle', { id });
}

export async function skillDelete(id: string): Promise<void> {
  return invoke('skill_delete', { id });
}

export async function importSkillFile(fileData: string, fileName: string): Promise<ParsedSkill> {
  return invoke<ParsedSkill>('import_skill_file', { fileData, fileName });
}

// App lifecycle

export async function appReady(): Promise<void> {
  return invoke('app_ready');
}

// Update check

export async function checkUpdate(): Promise<UpdateCheckResult> {
  return invoke<UpdateCheckResult>('check_update');
}

// SFTP commands

export async function sftpListDir(sessionId: string, path: string): Promise<SftpFileEntry[]> {
  return invoke<SftpFileEntry[]>('sftp_list_dir', { sessionId, path });
}

export async function sftpUpload(sessionId: string, remotePath: string, data: number[]): Promise<void> {
  return invoke('sftp_upload', { sessionId, remotePath, data });
}

export async function sftpDownload(sessionId: string, remotePath: string): Promise<number[]> {
  return invoke<number[]>('sftp_download', { sessionId, remotePath });
}

export async function sftpMkdir(sessionId: string, path: string): Promise<void> {
  return invoke('sftp_mkdir', { sessionId, path });
}

export async function sftpRemove(sessionId: string, path: string, isDir: boolean): Promise<void> {
  return invoke('sftp_remove', { sessionId, path, isDir });
}

export async function sftpRemoveViaShell(sessionId: string, path: string, isDir: boolean): Promise<void> {
  return invoke('sftp_remove_via_shell', { sessionId, path, isDir });
}

export async function sftpRename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
  return invoke('sftp_rename', { sessionId, oldPath, newPath });
}

export async function sftpUploadFolder(sessionId: string, remotePath: string, archiveData: number[]): Promise<string> {
  return invoke<string>('sftp_upload_folder', { sessionId, remotePath, archiveData });
}

export async function sftpReadFile(sessionId: string, path: string): Promise<{ content: string; mtime: number }> {
  return invoke<{ content: string; mtime: number }>('sftp_read_file', { sessionId, path });
}

export async function sftpGetMtime(sessionId: string, path: string): Promise<number> {
  return invoke<number>('sftp_get_mtime', { sessionId, path });
}

export async function sftpWriteFile(sessionId: string, path: string, content: string): Promise<void> {
  return invoke('sftp_write_file', { sessionId, path, content });
}

export async function sftpDownloadStream(sessionId: string, remotePath: string, localPath: string, downloadId: string): Promise<void> {
  return invoke('sftp_download_stream', { sessionId, remotePath, localPath, downloadId });
}

export async function sftpUploadStream(sessionId: string, remotePath: string, localPath: string, uploadId: string): Promise<void> {
  return invoke('sftp_upload_stream', { sessionId, remotePath, localPath, uploadId });
}

export async function sftpCancelUpload(uploadId: string): Promise<void> {
  return invoke('sftp_cancel_upload', { uploadId });
}

export async function sftpCancelDownload(downloadId: string): Promise<void> {
  return invoke('sftp_cancel_download', { downloadId });
}

// ──────────── 图片预览（下载到临时目录后由 WebView 通过 asset 协议加载） ────────────

export interface SftpPreviewImageResult {
  localPath: string;
}

/** 下载远程图片到 marcel-previews/{previewId}/ 临时目录，返回本地路径。 */
export async function sftpPreviewImage(
  sessionId: string,
  remotePath: string,
  previewId: string,
): Promise<SftpPreviewImageResult> {
  return invoke<SftpPreviewImageResult>('sftp_preview_image', {
    sessionId,
    remotePath,
    previewId,
  });
}

/**
 * 清理预览临时文件。
 * - 传入 localPath：仅清理该文件及其所在 {uuid} 目录
 * - 不传：扫描整个 marcel-previews 根（应用启动时调用）
 */
export async function sftpPreviewCleanup(localPath?: string): Promise<void> {
  return invoke('sftp_preview_cleanup', { localPath: localPath ?? null });
}

export async function sftpUploadFolderStream(sessionId: string, localPath: string, remotePath: string, uploadId: string, flat: boolean): Promise<void> {
  return invoke('sftp_upload_folder_stream', { sessionId, localPath, remotePath, uploadId, flat });
}

export async function sftpPrepareDragUpload(filePaths: string[]): Promise<string> {
  return invoke<string>('sftp_prepare_drag_upload', { filePaths });
}

export async function sftpCleanupTempDir(tempDir: string): Promise<void> {
  return invoke('sftp_cleanup_temp_dir', { tempDir });
}

export async function sftpExtractArchive(sessionId: string, remotePath: string, targetDir: string): Promise<void> {
  return invoke('sftp_extract_archive', { sessionId, remotePath, targetDir });
}

/**
 * 压缩远程目录为 tar.gz 或 zip 归档。
 * 进度通过 `ssh-long-output` 事件实时透传，取消调 `sshExecLongCancel(taskId)`。
 */
export async function sftpCompressArchive(
  sessionId: string,
  remoteDir: string,
  format: 'tar.gz' | 'zip',
  targetPath: string,
  overwrite: boolean,
  taskId: string,
): Promise<void> {
  return invoke('sftp_compress_archive', {
    sessionId,
    remoteDir,
    format,
    targetPath,
    overwrite,
    taskId,
  });
}

/** 取消正在运行的 ssh_exec_long / sftp_compress_archive 任务。 */
export async function sshExecLongCancel(taskId: string): Promise<void> {
  return invoke('ssh_exec_long_cancel', { taskId });
}

// Plugin webview commands

export async function pluginWebviewCreate(
  label: string,
  pluginId: string,
  entry: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke('plugin_webview_create', { params: { label, pluginId, entry, x, y, width, height } });
}

export async function pluginWebviewSetBounds(
  label: string,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  return invoke('plugin_webview_set_bounds', { label, x, y, width, height });
}

export async function pluginWebviewClose(label: string): Promise<void> {
  return invoke('plugin_webview_close', { label });
}

export async function pluginList(): Promise<PluginManifest[]> {
  return invoke<PluginManifest[]>('plugin_list');
}

/** Fetch the command→capability map from the Rust single source of truth.
 *  Used by `pluginIpc.ts` to build `COMMAND_TO_CAPABILITY` at init time. */
export async function pluginCapabilityMap(): Promise<Record<string, string>> {
  return invoke<Record<string, string>>('plugin_capability_map');
}

/** Trigger a registry reload on the backend. Returns the diff so the caller
 *  can react to per-plugin changes (destroy/recreate only changed webviews +
 *  injections). The backend also emits `plugin-registry-changed` separately. */
export async function pluginReload(): Promise<ReloadDiff> {
  return invoke<ReloadDiff>('plugin_reload');
}

export async function getPluginDir(): Promise<string> {
  return invoke<string>('get_plugin_dir');
}

export async function openPluginDir(): Promise<void> {
  return invoke('open_plugin_dir');
}

export async function pluginFsRead(pluginId: string, path: string): Promise<string> {
  return invoke<string>('plugin_fs_read', { pluginId, path });
}

export async function pluginFsWrite(pluginId: string, path: string, content: string): Promise<void> {
  return invoke('plugin_fs_write', { pluginId, path, content });
}

export async function pluginHttpRequest(request: PluginHttpRequest): Promise<PluginHttpResponse> {
  return invoke<PluginHttpResponse>('plugin_http_request', { request });
}

export async function pluginSendNotification(pluginId: string, title: string, body: string): Promise<void> {
  return invoke('plugin_send_notification', { pluginId, title, body });
}
