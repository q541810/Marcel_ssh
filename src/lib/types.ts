import type { ComponentType, ReactNode } from 'react';

// View Registry types

// 视图挂载点。对外可用的只有 sidebar 和 bottom：
// - sidebar: 左侧面板，由 NavRail 切换
// - bottom: 终端底部 tab，由 BottomTabBar 切换
// center 和 agent 被 builtin 常驻挤占（见 App.tsx 渲染逻辑 + builtinViews.tsx），插件实际无法使用。
export type MountPoint = 'sidebar' | 'center' | 'bottom' | 'agent';
export type NavGroup = 'top' | 'bottom';

export type ViewIcon =
  | { kind: 'react'; node: ReactNode }
  | { kind: 'svg'; path: string }
  | { kind: 'img'; src: string };

export interface ViewProvider {
  id: string;
  pluginId: string;
  mount: MountPoint;
  title: string;
  icon: ViewIcon;
  navGroup?: NavGroup;
  order: number;
  exclusive?: boolean;
  component: () => Promise<{ default: ComponentType }>;
  webviewEntry?: string;
}

// Plugin manifest types

export type IconKind = 'svg' | 'img' | 'emoji';
export type ToolKind = 'ssh' | 'local';
export type RunAt = 'idle' | 'instant';
export type PluginViewMount = 'sidebar' | 'settings';

export interface PluginIconDef {
  kind: IconKind;
  src: string;
}

export interface PluginViewDef {
  id: string;
  mount: PluginViewMount;
  title: string;
  icon?: PluginIconDef;
  navGroup?: NavGroup;
  order: number;
  entry: string;
  exclusive?: boolean;
}

export interface PluginAgentToolDef {
  name: string;
  description: string;
  command: string;
  kind?: ToolKind;
  handler?: string;
  parameters?: unknown;
  riskLevel?: RiskLevel;
}

/**
 * A content-script injection entry. The plugin's JS runs inside the main
 * window and can manipulate the DOM freely (IPC calls still go through the
 * capability-checked proxy). CSS is injected as a global `<style>` tag.
 */
export interface PluginInjectionDef {
  /** Unique id within the plugin (e.g. "main-ui"). */
  id: string;
  /**
   * Which main-UI regions this injection targets. Values match `data-region`
   * attributes: "sidebar" / "center" / "agent" / "terminal" / "settings" /
   * "sessions" / "skills" / "mcp" / "agent-panel". "*" means always inject.
   */
  matches: string[];
  /** CSS file paths relative to the plugin root, injected as `<style>` tags. */
  styles: string[];
  /** JS file paths relative to the plugin root, executed with the `marcel`
   *  runtime API as the argument. */
  scripts: string[];
  /** When to inject: "idle" (default) or "instant". */
  runAt: RunAt;
  /** Sort weight for multi-plugin ordering (lower = earlier). */
  order: number;
}

export interface PluginManifest {
  id: string;
  version: string;
  name: string;
  publisher?: string;
  description?: string;
  capabilities: string[];
  views: PluginViewDef[];
  agentTools: PluginAgentToolDef[];
  configView?: string;
  /** Content-script injections. Requires the `ui.inject` capability. */
  injections: PluginInjectionDef[];
}

export interface PluginHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface PluginHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  url: string;
}

/**
 * Diff returned by `plugin_reload` / emitted via `plugin-registry-changed`.
 * `changed` lists plugin ids whose manifest or enabled-state changed since the
 * previous reload; `removed` lists ids no longer on disk. Callers should
 * destroy/recreate webviews + injections for these plugins only (incremental
 * refresh instead of nuke-and-rebuild).
 */
export interface ReloadDiff {
  allIds: string[];
  changed: string[];
  removed: string[];
}

// Connection types

export interface JumpConfig {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
}

export interface ConnectionConfig {
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  /** Saved connection ID, used by Agent tools for password lookup (sudo auto-fill). */
  connectionId?: string;
  /**
   * User has explicitly opted to trust a new (mismatching) host key. Only set
   * after the user confirms the HostKeyMismatch modal. Drives the backend to
   * `KnownHostsStore::replace` instead of rejecting the handshake.
   */
  trustNewHostKey?: boolean;
  /** Optional ProxyJump hop. */
  jump?: JumpConfig;
}

export type AuthMethod =
  | { type: 'Password'; password: string }
  | { type: 'PrivateKey'; keyPath: string; passphrase?: string }
  | { type: 'Agent' };

/** Jump auth mode stored on SavedConnection (not runtime credentials). */
export type JumpAuthMethod = 'withTarget' | 'Password' | 'PrivateKey';

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
  /** ProxyJump — missing on old data means disabled. */
  useJump?: boolean;
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  jumpAuthMethod?: JumpAuthMethod;
  jumpKeyPath?: string;
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

/**
 * Data carried by an AppError whose `kind === "HostKeyMismatch"` (see error.rs
 * Serialize impl). Frontend branches on this to show the trust-new-key modal
 * instead of a plain error string.
 */
export interface HostKeyMismatchData {
  host: string;
  port: number;
  storedAlgorithm: string;
  storedFingerprint: string;
  presentedAlgorithm: string;
  presentedFingerprint: string;
}

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
  /** True when tools have been probed at least once (cache entry exists). */
  discovered: boolean;
}

export interface McpServerListResponse {
  servers: McpServer[];
  statuses: McpServerRuntimeStatus[];
}

// Agent types

export type AgentMode = 'plan' | 'agent' | 'auto';

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
  conversationId: string;
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
  /** 本轮 assistant 的完整并行 tool_calls（reload / 重建 LLM history 用） */
  toolCalls?: ToolCallInfo[];
  /** Populated for role==='tool' messages created from ToolResultPayload */
  toolResult?: {
    toolName: string;
    summary: string;
    result: string;
    success: boolean;
    blocked: boolean;
    wasTimeout?: boolean;
    wasAborted?: boolean;
    /** Tool call arguments, for display in the tool card */
    arguments?: Record<string, unknown>;
    /** Tool call ID from the LLM, used to reconstruct LLM context history */
    toolCallId?: string;
    /** Backend metadata (e.g. line_position, file_content for edit_file) */
    metadata?: Record<string, unknown>;
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
  /** Relative paths under config images/ for user-attached images */
  imagePaths?: string[];
  /** Current retry attempt number (1-based) for isRetrying messages */
  retryAttempt?: number;
  /** Max retry attempts for isRetrying messages */
  retryMaxAttempts?: number;
  /** Total delay seconds before next retry; UI counts down from timestamp + this */
  retryTotalDelaySecs?: number;
  /** Last error message that triggered the retry */
  retryLastError?: string;
  /** Model approval phase — shown as a distinct progress step on the tool card. */
  modelApproval?: {
    status: 'checking' | 'done';
    decision?: 'approve' | 'route_to_human' | 'block';
    reasons?: string[];
  };
}

export interface ToolCallInfo {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: string;
  riskLevel: RiskLevel;
  approved?: boolean;
  /** Reasons from the model approval step, shown when the model routed to human. */
  reasons?: string[];
  /** Preview metadata for approval (e.g. edit_file file_content). */
  metadata?: Record<string, unknown>;
}

export type RiskLevel = 'ReadOnly' | 'LowRisk' | 'Moderate' | 'HighRisk' | 'Destructive';

// Settings

export type CommandListMode = 'allowlist' | 'denylist';

export interface AgentModeSettings {
  listMode: CommandListMode;
  commandList: string[];
  confirmEachCommand: boolean;
  enableModelCommandApproval: boolean;
  /** Model name override for the approval step. Empty = use main model. */
  modelApprovalModel: string;
  /** Custom system prompt for the approval step. Empty = use built-in prompt. */
  modelApprovalPrompt: string;
  systemPrompt: string;
  maxToolRounds: number;
  /** Enable LLM context compression to stay within model window limits */
  compactContext: boolean;
  confirmEditFile: boolean;
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
  /** Whether the model accepts image inputs (multimodal / vision). Default false. */
  vision?: boolean;
}

/** A model entry returned by the provider's /models endpoint. */
export interface ModelInfo {
  id: string;
  ownedBy?: string | null;
  created?: number | null;
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

export type WebSearchMode = 'browser' | 'api' | 'html';
export type HttpFetchMode = 'browser' | 'html';
export type WebSearchApiProvider = 'brave' | 'tavily';

export interface ExperimentalSettings {
  enableWebSearch: boolean;
  enableHttpFetch: boolean;
  enableCloudPage: boolean;
  /** web_search backend; default browser */
  webSearchMode?: WebSearchMode;
  /** used when webSearchMode === 'api' */
  webSearchApiProvider?: WebSearchApiProvider;
  /** http_get backend; independent of webSearchMode; default browser */
  httpFetchMode?: HttpFetchMode;
}



export interface NotificationSettings {
  agentApproval: boolean;
  agentQuestion: boolean;
  agentTaskDone: boolean;
  agentTaskFailed: boolean;
  notificationVolume: number;
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
  notificationSettings: NotificationSettings;
  workspaceLayout: WorkspaceLayoutSettings;
  /** User-defined protected paths. Writes to anything under these paths
   * require explicit user approval, same as built-in `/etc`, `/boot`, etc. */
  customProtectedPaths: string[];
  /** Command execution timeout in seconds for Agent tools. */
  commandTimeoutSecs: number;
  /** Whether the user has completed the onboarding wizard. */
  hasCompletedOnboarding: boolean;
  /** Disabled plugin IDs. Plugins listed here are scanned but not loaded. */
  disabledPlugins: string[];
  /**
   * Per-plugin authorized capability IDs.
   * If a plugin is not in the map, all declared capabilities are authorized (backward compatible).
   * If a plugin IS in the map, only the listed capabilities are authorized.
   */
  authorizedCapabilities: Record<string, string[]>;
  /** Safe-mode switch: when true, skip all content-script injections on
   *  startup. Used to recover from a plugin whose injected JS hangs the
   *  main window. */
  disableAllInjections: boolean;
}

// LLM token usage — returned by the LLM provider in its API response
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cachedReadTokens?: number;
}

// LLM stream events
export type LlmStreamEvent =
  | { type: 'textDelta'; text: string }
  | { type: 'thinkingDelta'; text: string }
  | { type: 'toolCallStart'; id: string; name: string }
  | { type: 'toolCallDelta'; id: string; argumentsDelta: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'retrying'; attempt: number; maxAttempts: number; delaySecs: number; lastError: string }
  // Tool result — emitted as a separate event on the same channel
  | { type: 'toolResult' } & ToolResultPayload
  // Approval request — emitted when user confirmation is needed
  | ApprovalRequestPayload
  // Model approval progress — shows a distinct step on the tool card
  | ModelApprovalStartPayload
  | ModelApprovalDonePayload
  // Question request — agent asks user for input
  | QuestionRequestPayload;

export interface ToolResultPayload {
  type: 'toolResult';
  toolCallId: string;
  toolName: string;
  summary: string;
  result: string;
  success: boolean;
  blocked: boolean;
  wasTimeout?: boolean;
  wasAborted?: boolean;
  arguments: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface ApprovalRequestPayload {
  type: 'approvalRequest';
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  riskLevel: RiskLevel;
  /** Reasons from the model approval step (when it routed to human). */
  reasons?: string[];
  /** Preview metadata (e.g. edit_file file_content / line_position). */
  metadata?: Record<string, unknown>;
}

export interface ModelApprovalStartPayload {
  type: 'modelApprovalStart';
  toolCallId: string;
}

export interface ModelApprovalDonePayload {
  type: 'modelApprovalDone';
  toolCallId: string;
  decision: 'approve' | 'route_to_human' | 'block' | 'error';
  reasons: string[];
}

// Question tool types

export interface QuestionOption {
  label: string;
  description: string;
}

export interface QuestionItem {
  question: string;
  header: string;
  options?: QuestionOption[];
  multiple: boolean;
}

export interface QuestionRequestPayload {
  type: 'questionRequest';
  questionId: string;
  questions: QuestionItem[];
}

export interface QuestionAnswer {
  selected: string[];
  custom: string;
}

// -- stream event --

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
  /** JSON array of relative image paths */
  imagePathsJson?: string | null;
}

/** 聊天历史全文搜索的单条会话聚合结果 */
export interface ConversationSearchResult {
  conversationId: string;
  title: string;
  connectionId: string;
  matchedSnippet: string;
  matchCount: number;
  /** 匹配消息 id，按时间升序，最多 200 条 */
  matchedMessageIds: string[];
  updatedAt: string;
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
  /** 下一个新增 item 的序号（后端持久化字段，前端可选） */
  nextItemSeq?: number;
  /** 反思提醒是否已触发（后端持久化字段，前端可选） */
  reflectionReminded?: boolean;
}

/** 撤回消息后后端返回：消息截断 + 可选 plan 调整 */
export interface TruncateConversationResult {
  deletedMessages: number;
  /** true：已按快照恢复或清空；false：旧数据无快照，plan 未动 */
  planAdjusted: boolean;
  plan: AgentTaskPlan | null;
  planTaskId: string | null;
}

export type PlanStreamEvent =
  | { type: 'plan-created'; items: PlanItem[] }
  | { type: 'plan-item-started'; itemId: string; title: string; index: number; total: number; items: PlanItem[]; currentIndex: number }
  | { type: 'plan-item-completed'; itemId: string; title: string; index: number; total: number; items: PlanItem[]; currentIndex: number }
  | { type: 'plan-item-failed'; itemId: string; title: string; error: string; index: number; total: number; items: PlanItem[]; currentIndex: number }
  | { type: 'plan-item-skipped'; itemId: string; title: string; index: number; total: number; items: PlanItem[]; currentIndex: number }
  | { type: 'plan-completed'; completed: number; total: number; failed: number; items: PlanItem[]; currentIndex: number }
  | { type: 'plan-edited'; ops: unknown[]; items: PlanItem[]; currentIndex: number };

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
