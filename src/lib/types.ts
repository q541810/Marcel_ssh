// Connection types

export interface ConnectionConfig {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
}

export type AuthMethod =
  | { type: 'Password'; password: string }
  | { type: 'PrivateKey'; keyPath: string; passphrase?: string }
  | { type: 'Agent' };

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  keyPath?: string;
  group?: string;
  lastConnected?: string;
}

// Session types

export interface Session {
  id: string;
  connectionId: string;
  status: SessionStatus;
  createdAt: string;
}

export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// Agent types

export type AgentMode = 'chat' | 'agent' | 'auto';

export type AgentStatus =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'waiting_approval'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentTask {
  id: string;
  sessionId: string;
  prompt: string;
  mode: AgentMode;
  status: AgentStatus;
  createdAt: string;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: string;
  toolCall?: ToolCallInfo;
  /** Populated for role==='tool' messages created from ToolResultPayload */
  toolResult?: {
    toolName: string;
    summary: string;
    result: string;
    success: boolean;
    blocked: boolean;
  };
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  riskLevel: RiskLevel;
  approved?: boolean;
}

export type RiskLevel = 'readonly' | 'low_risk' | 'moderate' | 'high_risk' | 'destructive';

// Settings

export type CommandListMode = 'allowlist' | 'denylist';

export interface AgentModeSettings {
  listMode: CommandListMode;
  commandList: string[];
  confirmEachCommand: boolean;
}

export type LlmProviderType = 'openai' | 'anthropic' | 'ollama';

export interface LlmConfig {
  providerType: LlmProviderType;
  apiKey?: string;  // Optional - loaded from keychain, not persisted to JSON
  model: string;
  baseUrl?: string | null;
  maxTokens: number;
  temperature: number;
  allowInvalidCerts: boolean;
}

export interface AppSettings {
  theme: string;
  fontSize: number;
  fontFamily: string;
  defaultAgentMode: string;
  llmConfig?: LlmConfig | null;
  agentModeSettings: AgentModeSettings;
}

// LLM stream events
export type LlmStreamEvent =
  | { type: 'textDelta'; text: string }
  | { type: 'toolCallStart'; id: string; name: string }
  | { type: 'toolCallDelta'; id: string; argumentsDelta: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  // Tool result — emitted as a separate event on the same channel
  | ToolResultPayload
  // Approval request — emitted when user confirmation is needed
  | ApprovalRequestPayload;

export interface ToolResultPayload {
  toolCallId: string;
  toolName: string;
  summary: string;
  result: string;
  success: boolean;
  blocked: boolean;
}

export interface ApprovalRequestPayload {
  type: 'approvalRequest';
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: RiskLevel;
}
