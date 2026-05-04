// Connection types

export interface ConnectionConfig {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** Saved connection ID, used by Agent tools for password lookup (sudo auto-fill). */
  connectionId?: string;
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
  /** The saved connection config ID (persistent across restarts) */
  configId?: string;
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
  /** True when waiting for LLM response */
  isLoading?: boolean;
  /** True when the LLM is outputting thinking/reasoning content */
  isThinking?: boolean;
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  riskLevel: RiskLevel;
  approved?: boolean;
}

export type RiskLevel = 'ReadOnly' | 'LowRisk' | 'Moderate' | 'HighRisk' | 'Destructive';

// Settings

export type CommandListMode = 'allowlist' | 'denylist';

export interface AgentModeSettings {
  listMode: CommandListMode;
  commandList: string[];
  confirmEachCommand: boolean;
}

export type LlmProviderType = 'openai';

export interface LlmConfig {
  providerType: LlmProviderType;
  apiKey?: string;  // Optional - loaded from keychain, not persisted to JSON
  model: string;
  baseUrl?: string | null;
  maxTokens: number;
  temperature: number;
  allowInvalidCerts: boolean;
}

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export interface ExperimentalSettings {
  enableWebSearch: boolean;
  enableHttpFetch: boolean;
}

export interface AppSettings {
  terminalColors: TerminalColors;
  fontSize: number;
  fontFamily: string;
  defaultAgentMode: string;
  llmConfig?: LlmConfig | null;
  agentModeSettings: AgentModeSettings;
  experimentalSettings?: ExperimentalSettings;
}

// LLM stream events
export type LlmStreamEvent =
  | { type: 'textDelta'; text: string }
  | { type: 'toolCallStart'; id: string; name: string }
  | { type: 'toolCallDelta'; id: string; argumentsDelta: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  // Tool result — emitted as a separate event on the same channel
  | { type: 'toolResult' } & ToolResultPayload
  // Approval request — emitted when user confirmation is needed
  | ApprovalRequestPayload;

export interface ToolResultPayload {
  type: 'toolResult';
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

// Conversation types

export interface AgentConversation {
  id: string;
  connectionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredMessage {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  timestamp: string;
  createdAt: string;
  toolCallsJson?: string | null;
}

// Plan / Todolist types

export type PlanItemStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped';

export interface PlanItem {
  id: string;
  title: string;
  status: PlanItemStatus;
  error?: string | null;
}

export interface AgentTaskPlan {
  taskId: string;
  items: PlanItem[];
  currentIndex: number;
}

export type PlanStreamEvent =
  | { type: 'plan-created'; items: PlanItem[] }
  | { type: 'plan-item-started'; itemId: string; title: string; index: number; total: number }
  | { type: 'plan-item-completed'; itemId: string; title: string; index: number; total: number }
  | { type: 'plan-item-failed'; itemId: string; title: string; error: string; index: number; total: number }
  | { type: 'plan-completed'; completed: number; total: number; failed: number };
