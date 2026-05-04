import { invoke } from '@tauri-apps/api/core';
import type { ConnectionConfig, SavedConnection, AppSettings, AgentConversation, StoredMessage, RiskLevel } from './types';

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

// Agent commands

export async function agentStartTask(
  sessionId: string,
  prompt: string,
  mode: string,
  conversationId: string,
  history: { role: string; content: string }[],
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

export async function agentDeleteConversation(conversationId: string): Promise<void> {
  return invoke('agent_delete_conversation', { conversationId });
}

export async function agentDeleteConversationsBySession(sessionId: string): Promise<void> {
  return invoke('agent_delete_conversations_by_session', { sessionId });
}

export interface CommandCheckResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  riskLevel: RiskLevel;
  reason: string;
}

/**
 * Evaluate a command against the current agent-mode settings (server-side).
 * Useful for "test command" UI in the Settings page or pre-flight checks.
 */
export async function agentCheckCommand(
  command: string,
  mode: 'chat' | 'agent' | 'auto',
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

export async function getSettings(): Promise<AppSettings> {
  return invoke<AppSettings>('config_get_settings');
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  return invoke('config_save_settings', { settings });
}

// Password / keychain commands

export async function savePassword(
  connectionId: string,
  password: string,
): Promise<void> {
  return invoke('config_save_password', { connectionId, password });
}

export async function getPassword(connectionId: string): Promise<string | null> {
  return invoke<string | null>('config_get_password', { connectionId });
}

export async function deletePassword(connectionId: string): Promise<void> {
  return invoke('config_delete_password', { connectionId });
}

// LLM API Key management

export async function saveLlmApiKey(apiKey: string): Promise<void> {
  return invoke('config_save_llm_api_key', { apiKey });
}

export async function getLlmApiKey(): Promise<string | null> {
  return invoke('config_get_llm_api_key');
}

export async function deleteLlmApiKey(): Promise<void> {
  return invoke('config_delete_llm_api_key');
}

