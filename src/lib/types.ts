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
  errorMessage?: string;
  /** The saved connection config ID (persistent across restarts) */
  configId?: string;
}

export type SessionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

// Quick command types

export type QuickCommandScope = 'global' | 'session';

export interface QuickCommand {
  id: string;
  scope: QuickCommandScope;
  sessionKey?: string | null;
  name: string;
  commands: string[];
  intervalMs: number;
  createdAt: string;
  updatedAt: string;
}

export interface QuickCommandInput {
  scope: QuickCommandScope;
  sessionKey?: string | null;
  name: string;
  commands: string[];
  intervalMs: number;
}

export interface QuickCommandPatch {
  scope?: QuickCommandScope;
  sessionKey?: string | null;
  name?: string;
  commands?: string[];
  intervalMs?: number;
}

// MCP types

export interface McpServer {
  id: string;
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  trusted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerInput {
  name: string;
  url: string;
  headers: Record<string, string>;
  enabled: boolean;
  trusted: boolean;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
}

export interface McpServerRuntimeStatus {
  serverId: string;
  tools: McpTool[];
  error?: string | null;
}

export interface McpServerListResponse {
  servers: McpServer[];
  statuses: McpServerRuntimeStatus[];
}

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
    wasTimeout?: boolean;
    /** Tool call arguments, for display in the tool card */
    arguments?: Record<string, unknown>;
  };
  /** True when waiting for LLM response */
  isLoading?: boolean;
  /** True when the LLM is outputting thinking/reasoning content */
  isThinking?: boolean;
  /** Tool call is currently executing, show loading spinner */
  isExecuting?: boolean;
  /** Whether this system message is a retrying indicator (auto-removed on success) */
  isRetrying?: boolean;
  /** Reasoning/thinking content from the model (DeepSeek thinking mode). Passed back to API. */
  reasoningContent?: string;
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
  systemPrompt: string;
}

export type LlmProviderType = 'openai';

export interface LlmConfig {
  providerType: LlmProviderType;
  apiKey?: string;  // Optional - loaded from keychain, not persisted to JSON
  model: string;
  baseUrl?: string | null;
  temperature: number;
  maxRetries: number;
  retryDelaySecs: number;
  retryHttpStatuses: string;
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
  enableCloudPage: boolean;
}

export interface NotificationSettings {
  agentApproval: boolean;
  agentTaskDone: boolean;
  agentTaskFailed: boolean;
}

export interface WorkspaceLayoutSettings {
  sidebarBaseWidth: number;
  agentBaseWidth: number;
  sidebarRatio?: number;
  agentRatio?: number;
  sidebarOpen: boolean;
  agentOpen: boolean;
}

export interface AppSettings {
  terminalColors: TerminalColors;
  fontSize: number;
  fontFamily: string;
  defaultAgentMode: string;
  llmConfig?: LlmConfig | null;
  agentModeSettings: AgentModeSettings;
  experimentalSettings?: ExperimentalSettings;
  fileManagerPath: string;
  fileManagerPaths: Record<string, string>;
  fileManagerShowHidden: boolean;
  folderUploadCompressionLevel: number;
  panelHeight: number;
  /** Whether to hide thinking/reasoning content in the UI */
  hideThinkingDisplay: boolean;
  /** Whether to enable the whip button in the Agent input area */
  whipEnabled: boolean;
  /** Tip velocity threshold for whip crack detection; lower is more sensitive */
  whipCrackSpeed: number;
  /** Whether a whip crack appends text to the Agent input */
  whipAutoInputEnabled: boolean;
  /** User-editable phrases appended when the whip cracks */
  whipPhrases: string[];
  notificationSettings: NotificationSettings;
  workspaceLayout: WorkspaceLayoutSettings;
  /** User-defined protected paths. Writes to anything under these paths
   * require explicit user approval, same as built-in `/etc`, `/boot`, etc. */
  customProtectedPaths: string[];
}

// LLM stream events
export type LlmStreamEvent =
  | { type: 'textDelta'; text: string }
  | { type: 'thinkingDelta'; text: string }
  | { type: 'toolCallStart'; id: string; name: string }
  | { type: 'toolCallDelta'; id: string; argumentsDelta: string }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'retrying'; attempt: number; maxAttempts: number; delaySecs: number; lastError: string }
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
  wasTimeout?: boolean;
  arguments: Record<string, unknown>;
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
  reasoningContent?: string | null;
}

// Update check types

export interface UpdateCheckResult {
  hasUpdate: boolean;
  latestVersion: string;
  releaseUrl: string;
}

export interface CommandCheckResult {
  allowed: boolean;
  requiresConfirmation: boolean;
  riskLevel: RiskLevel;
  reason: string;
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
  | { type: 'plan-item-skipped'; itemId: string; title: string; index: number; total: number }
  | { type: 'plan-completed'; completed: number; total: number; failed: number };

// File manager types

export type FileType = 'file' | 'directory' | 'symlink' | 'pipe' | 'socket' | 'block' | 'character' | 'unknown';

export interface FileEntry {
  name: string;
  path: string;
  type: FileType;
  size: number;
  permissions: string;
  owner: string;
  group: string;
  modifiedAt: string;
  isHidden: boolean;
  linkTarget?: string;
}

export interface SftpFileEntry {
  name: string;
  is_dir: boolean;
  is_file: boolean;
  is_symlink: boolean;
  size: number;
  mode: number;
}

// Skill types

export interface ParsedSkill {
  name: string;
  description: string;
  prompt: string;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  prompt: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
