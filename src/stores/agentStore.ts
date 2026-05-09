import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AgentTask,
  AgentMessage,
  AgentMode,
  LlmStreamEvent,
  ToolResultPayload,
  ApprovalRequestPayload,
  AgentConversation,
  StoredMessage,
  RiskLevel,
  AgentTaskPlan,
  PlanItem,
  PlanStreamEvent,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';

/** Deserialize a StoredMessage into an AgentMessage, reconstructing toolCall info if present. */
function storedMessageToAgentMessage(m: StoredMessage): AgentMessage {
  const base: AgentMessage = {
    id: m.id,
    role: m.role as AgentMessage['role'],
    content: m.content,
    timestamp: m.timestamp,
  };

  // Handle tool role messages without toolCallsJson (legacy data)
  if (m.role === 'tool' && !m.toolCallsJson) {
    const content = m.content || '';
    // Extract tool name from content if possible, or default
    let toolName = 'execute_command';
    const toolNameMatch = content.match(/^\[(\w+)\]\s/);
    if (toolNameMatch) {
      toolName = toolNameMatch[1];
    }
    base.toolResult = {
      toolName,
      summary: content.length > 60 ? content.slice(0, 60) + '...' : content || '(done)',
      result: content,
      success: !content.startsWith('BLOCKED:') && !content.startsWith('tool error:'),
      blocked: content.startsWith('BLOCKED:'),
    };
    return base;
  }

  if (!m.toolCallsJson) return base;

  try {
    const raw = JSON.parse(m.toolCallsJson);

    if (m.role === 'assistant') {
      // Assistant message: tool_calls_json is PersistedToolCall[] (array with flatten)
      const persistedCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        risk_level: RiskLevel;
      }> = Array.isArray(raw) ? raw : [raw];

      if (persistedCalls.length > 0) {
        base.toolCall = {
          id: persistedCalls[0].id,
          name: persistedCalls[0].name,
          arguments: persistedCalls[0].arguments,
          riskLevel: persistedCalls[0].risk_level,
        };
      }
    } else if (m.role === 'tool') {
      // Tool result: tool_calls_json is a single PersistedToolResult object
      const tr = raw as {
        id?: string;
        name?: string;
        arguments?: Record<string, unknown>;
        risk_level?: RiskLevel;
        summary?: string;
        success?: boolean;
        blocked?: boolean;
      };

      // New format: PersistedToolResult with summary/success/blocked
      if (tr.name) {
        base.toolResult = {
          toolName: tr.name,
          summary: tr.summary || m.content.slice(0, 120) || '(done)',
          result: m.content,
          success: tr.success ?? true,
          blocked: tr.blocked ?? false,
          arguments: tr.arguments,
        };
      }
      // Legacy format: PersistedToolCall[] array (backward compat)
      else if (Array.isArray(raw) && raw.length > 0) {
        base.toolResult = {
          toolName: raw[0].name,
          summary: m.content.length > 120 ? m.content.slice(0, 120) + '...' : m.content || '(done)',
          result: m.content,
          success: !m.content.startsWith('BLOCKED:') && !m.content.startsWith('tool error:'),
          blocked: m.content.startsWith('BLOCKED:'),
          arguments: raw[0].arguments,
        };
      }
    }
  } catch {
    // ignore parse error
  }

  return base;
}

interface AgentState {
  tasks: Record<string, AgentTask>;
  activeTaskId: string | null;
  conversations: Record<string, AgentConversation>;
  messages: Record<string, AgentMessage[]>;
  activeConversationId: string | null;
  mode: AgentMode;
  pendingApproval: ApprovalRequestPayload | null;
  plans: Record<string, AgentTaskPlan>;
  /** Toggle flag to force-react to plan changes via shallow subscription */
  plansDirty: boolean;

  startTask: (sessionId: string, prompt: string, connectionId?: string) => Promise<string>;
  stopTask: (taskId: string) => Promise<void>;
  approveOperation: (taskId: string, operationId: string) => Promise<void>;
  rejectOperation: (taskId: string, operationId: string) => Promise<void>;
  addMessage: (message: AgentMessage) => void;
  setMode: (mode: AgentMode) => void;
  clearMessages: () => void;
  updateTaskStatus: (taskId: string, status: AgentTask['status']) => void;
  setPendingApproval: (approval: ApprovalRequestPayload | null) => void;
  newConversation: (sessionId: string, connectionId: string) => Promise<string>;
  switchConversation: (conversationId: string) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  clearConnectionConversations: (connectionId: string) => void;
  loadConnectionConversations: (connectionId: string) => Promise<void>;
  getCurrentMessages: () => AgentMessage[];
  setPlan: (taskId: string, plan: AgentTaskPlan) => void;
  updatePlanItem: (taskId: string, itemId: string, status: PlanItem['status'], error?: string) => void;
  getActivePlan: () => AgentTaskPlan | null;
}

const currentAssistantMessageId: Map<string, string> = new Map();

export const useAgentStore = create<AgentState>((set, get) => ({
  tasks: {},
  activeTaskId: null,
  conversations: {},
  messages: {},
  activeConversationId: null,
  mode: 'agent',
  pendingApproval: null,
  plans: {},
  plansDirty: false,

  startTask: async (sessionId: string, prompt: string, connectionId?: string) => {
    const { mode } = get();
    let conversationId = get().activeConversationId;

    if (!conversationId) {
      const newTitle = prompt.slice(0, 30);
      const newId = await tauri.agentCreateConversation(sessionId, newTitle);
      conversationId = newId;
      set((state) => ({
        conversations: {
          ...state.conversations,
          [newId]: {
            id: newId,
            connectionId: connectionId ?? '',
            title: newTitle,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
        messages: { ...state.messages, [newId]: [] },
        activeConversationId: newId,
      }));
    } else {
      const conv = get().conversations[conversationId as string];
      if (conv && conv.title === '新会话') {
        const newTitle = prompt.slice(0, 30);
        set((state) => ({
          conversations: {
            ...state.conversations,
            [conversationId as string]: { ...conv, title: newTitle },
          },
        }));
      }
    }

    const userMessage: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      timestamp: new Date().toISOString(),
    };
    
    const loadingAssistantId = crypto.randomUUID();
    const loadingAssistantMessage: AgentMessage = {
      id: loadingAssistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      isLoading: true,
    };
    
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId as string]: [...(state.messages[conversationId as string] || []), userMessage, loadingAssistantMessage],
      },
    }));

    let taskId: string;
    try {
      const llmHistory = get()
        .messages[conversationId as string]
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.isLoading)
        .map((m) => ({ role: m.role, content: m.content }));

      taskId = await tauri.agentStartTask(sessionId, prompt, mode, conversationId as string, llmHistory);
    } catch (err) {
      set((state) => ({
        messages: {
          ...state.messages,
          [conversationId as string]: [
            ...(state.messages[conversationId as string] || []).filter((m) => m.id !== loadingAssistantId),
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `启动任务失败：${String(err)}`,
              timestamp: new Date().toISOString(),
            },
          ],
        },
      }));
      throw err;
    }

    const task: AgentTask = {
      id: taskId,
      sessionId,
      prompt,
      mode,
      status: 'planning',
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      tasks: { ...state.tasks, [taskId]: task },
      activeTaskId: taskId,
    }));

    void attachStreamListener(taskId, conversationId as string, loadingAssistantId);
    void attachPlanListener(taskId);

    return taskId;
  },

  stopTask: async (taskId: string) => {
    try {
      await tauri.agentStopTask(taskId);
    } finally {
      const fn = streamListeners.get(taskId);
      if (fn) {
        fn();
        streamListeners.delete(taskId);
      }
      const planFn = planListeners.get(taskId);
      if (planFn) {
        planFn();
        planListeners.delete(taskId);
      }
      cleanupStreamState(taskId);
      set((state) => {
        const task = state.tasks[taskId];
        if (!task) return state;
        return {
          tasks: { ...state.tasks, [taskId]: { ...task, status: 'cancelled' } },
          activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
          // Clear any pending approval when task is stopped
          pendingApproval: null,
        };
      });
    }
  },

  approveOperation: async (taskId: string, operationId: string) => {
    await tauri.agentApproveOperation(taskId, operationId);
  },

  rejectOperation: async (taskId: string, operationId: string) => {
    await tauri.agentRejectOperation(taskId, operationId);
  },

  addMessage: (message: AgentMessage) => {
    const convId = get().activeConversationId;
    if (!convId) return;
    set((state) => ({
      messages: {
        ...state.messages,
        [convId]: [...state.messages[convId], message],
      },
    }));
  },

  setMode: (mode: AgentMode) => {
    set({ mode });
  },

  clearMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return;
    set((state) => ({
      messages: { ...state.messages, [convId]: [] },
    }));
  },

  updateTaskStatus: (taskId: string, status: AgentTask['status']) => {
    set((state) => {
      const task = state.tasks[taskId];
      if (!task) return state;
      return {
        tasks: { ...state.tasks, [taskId]: { ...task, status } },
      };
    });
  },

  setPendingApproval: (approval: ApprovalRequestPayload | null) => {
    set({ pendingApproval: approval });
  },

  newConversation: async (sessionId: string, connectionId: string) => {
    const id = await tauri.agentCreateConversation(sessionId);
    const now = new Date().toISOString();
    set((state) => ({
      conversations: {
        ...state.conversations,
        [id]: {
          id,
          connectionId,
          title: '新会话',
          createdAt: now,
          updatedAt: now,
        },
      },
      messages: { ...state.messages, [id]: [] },
      activeConversationId: id,
    }));
    return id;
  },

  switchConversation: async (conversationId: string) => {
    const stored = await tauri.agentLoadConversation(conversationId);
    const msgs: AgentMessage[] = stored.map(storedMessageToAgentMessage);
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
      activeConversationId: conversationId,
      activeTaskId: null,
    }));
  },

  loadConversation: async (conversationId: string) => {
    const stored = await tauri.agentLoadConversation(conversationId);
    const msgs: AgentMessage[] = stored.map(storedMessageToAgentMessage);
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
      activeConversationId: conversationId,
      activeTaskId: null,
    }));
  },

  deleteConversation: async (conversationId: string) => {
    await tauri.agentDeleteConversation(conversationId);
    set((state) => {
      const { [conversationId]: _, ...conversations } = state.conversations;
      const { [conversationId]: __, ...messages } = state.messages;
      return {
        conversations,
        messages,
        activeConversationId:
          state.activeConversationId === conversationId
            ? Object.keys(conversations)[0] || null
            : state.activeConversationId,
      };
    });
  },

  clearConnectionConversations: (connectionId: string) => {
    const convs = get().conversations;
    const toRemove = Object.values(convs)
      .filter((c) => c.connectionId === connectionId)
      .map((c) => c.id);
    set((state) => {
      const conversations = { ...state.conversations };
      const messages = { ...state.messages };
      for (const id of toRemove) {
        delete conversations[id];
        delete messages[id];
      }
      return {
        conversations,
        messages,
        activeConversationId:
          state.activeConversationId && toRemove.includes(state.activeConversationId)
            ? Object.keys(conversations)[0] || null
            : state.activeConversationId,
      };
    });
  },

  loadConnectionConversations: async (connectionId: string) => {
    const convs = await tauri.agentListConversationsByConnection(connectionId);

    // Load messages for all conversations
    const loadedMessages: Record<string, AgentMessage[]> = {};
    for (const conv of convs) {
      const stored = await tauri.agentLoadConversation(conv.id);
      loadedMessages[conv.id] = stored.map(storedMessageToAgentMessage);
    }

    set((state) => {
      // Find conversations that belong to this connection and should be replaced
      const existingConvIds = new Set(Object.keys(state.conversations));
      const incomingConvIds = new Set(convs.map((c) => c.id));
      
      // Remove old conversations that belong to this connection (identified by connectionId match)
      const toRemove = Object.values(state.conversations)
        .filter((c) => c.connectionId === connectionId && !incomingConvIds.has(c.id))
        .map((c) => c.id);

      const newConversations: Record<string, AgentConversation> = { ...state.conversations };
      const newMessages: Record<string, AgentMessage[]> = { ...state.messages };

      // Remove stale conversations for this connection
      for (const id of toRemove) {
        delete newConversations[id];
        delete newMessages[id];
      }

      // Add/update conversations for this connection
      for (const conv of convs) {
        newConversations[conv.id] = conv;
        newMessages[conv.id] = loadedMessages[conv.id];
      }

      // Select the most recent conversation (only if no active one exists)
      const firstConvId = convs.length > 0 ? convs[0].id : null;
      const isActiveStillValid = state.activeConversationId && newConversations[state.activeConversationId];

      return {
        conversations: newConversations,
        messages: newMessages,
        activeConversationId: isActiveStillValid ? state.activeConversationId : (firstConvId || state.activeConversationId || null),
      };
    });
  },

  getCurrentMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return [];
    return get().messages[convId] || [];
  },

  setPlan: (taskId: string, plan: AgentTaskPlan) => {
    set((state) => ({
      plans: { ...state.plans, [taskId]: plan },
      plansDirty: !state.plansDirty,
    }));
  },

  updatePlanItem: (taskId: string, itemId: string, status: PlanItem['status'], error?: string) => {
    set((state) => {
      const plan = state.plans[taskId];
      if (!plan) return state;
      const updatedItems = plan.items.map((item) =>
        item.id === itemId ? { ...item, status, error: error ?? item.error } : item
      );
      return {
        plans: { ...state.plans, [taskId]: { ...plan, items: updatedItems } },
        plansDirty: !state.plansDirty,
      };
    });
  },

  getActivePlan: () => {
    const activeTaskId = get().activeTaskId;
    if (!activeTaskId) return null;
    return get().plans[activeTaskId] || null;
  },
}));

const streamListeners: Map<string, UnlistenFn> = new Map();

/** Per-task tracking of stream state */
interface TaskStreamState {
  /** ID of the current assistant message being written to */
  assistantMessageId: string | null;
  /** Index of that message in the conversation array */
  messageIndex: number;
  /** Whether we're inside a thinking block */
  inThinking: boolean;
  /** Whether the loading message has been cleared */
  loadingCleared: boolean;
  /** Count of toolResults received in this round */
  toolResultCount: number;
}

const taskStreamState: Map<string, TaskStreamState> = new Map();

function getStreamState(taskId: string): TaskStreamState {
  return taskStreamState.get(taskId) ?? {
    assistantMessageId: null,
    messageIndex: -1,
    inThinking: false,
    loadingCleared: false,
    toolResultCount: 0,
  };
}

/** Safely update taskStreamState by merging with the current state, avoiding stale snapshots */
function updateStreamState(taskId: string, partial: Partial<TaskStreamState>): void {
  const current = getStreamState(taskId);
  taskStreamState.set(taskId, { ...current, ...partial });
}

const THINKING_START_TAGS = ['<thinking>', '<Thought>', '<think>'];
const THINKING_END_TAGS = ['</thinking>', '</Thought>', '</think>'];

function filterThinkingTags(input: string, inThinking: boolean): [string, boolean] {
  if (!inThinking) {
    let earliestStart: number | null = null;
    let earliestIdx = input.length;

    for (const tag of THINKING_START_TAGS) {
      const pos = input.indexOf(tag);
      if (pos !== -1 && pos < earliestIdx) {
        earliestIdx = pos;
        earliestStart = pos;
      }
    }

    if (earliestStart !== null) {
      return [input.slice(0, earliestStart), true];
    }
    return [input, false];
  } else {
    let earliestEnd: number | null = null;
    let earliestIdx = input.length;

    for (const tag of THINKING_END_TAGS) {
      const pos = input.indexOf(tag);
      if (pos !== -1 && pos < earliestIdx) {
        earliestIdx = pos + tag.length;
        earliestEnd = pos + tag.length;
      }
    }

    if (earliestEnd !== null) {
      return [input.slice(earliestEnd), false];
    }
    return ['', true];
  }
}

function cleanupStreamState(taskId: string) {
  taskStreamState.delete(taskId);
}

/** Insert a tool message at the end of the array (after the latest user prompt
 * and any prior assistant/tool messages). The loading assistant message has
 * already been removed by the caller, so pushing to the end puts the tool
 * card in the correct chronological position. */
function insertToolMessageAfterAssistant(newMsgs: AgentMessage[], toolMessage: AgentMessage): AgentMessage[] {
  newMsgs.push(toolMessage);
  return newMsgs;
}

/** Type guard: check if event is a ToolResultPayload */
function isToolResultPayload(ev: any): ev is ToolResultPayload {
  return 'toolCallId' in ev && 'toolName' in ev && 'success' in ev;
}

/** Type guard: check if event has a specific type field */
function hasEventType<T extends string>(ev: any, type: T): ev is { type: T } & Record<string, unknown> {
  return 'type' in ev && ev.type === type;
}

/** Clear all listeners and stream state for a task */
function cleanupTaskListeners(taskId: string) {
  const streamFn = streamListeners.get(taskId);
  if (streamFn) {
    streamFn();
    streamListeners.delete(taskId);
  }
  const planFn = planListeners.get(taskId);
  if (planFn) {
    planFn();
    planListeners.delete(taskId);
  }
  cleanupStreamState(taskId);
}

/** Handle toolResult events: create tool message and clear loading */
function handleToolResult(taskId: string, conversationId: string, loadingAssistantId: string, tr: ToolResultPayload) {
  const toolMessage: AgentMessage = {
    id: crypto.randomUUID(),
    role: 'tool',
    content: '',
    timestamp: new Date().toISOString(),
    toolResult: {
      toolName: tr.toolName,
      summary: tr.summary,
      result: tr.result,
      success: tr.success,
      blocked: tr.blocked,
      arguments: tr.arguments,
    },
  };

  useAgentStore.setState((state) => {
    const convMsgs = state.messages[conversationId] || [];
    const newMsgs = [...convMsgs];

    const streamState = getStreamState(taskId);

    // Clear loading on the loading assistant message only once
    if (!streamState.loadingCleared) {
      const loadingIdx = newMsgs.findIndex((m) => m.id === loadingAssistantId);
      if (loadingIdx !== -1) {
        newMsgs.splice(loadingIdx, 1);
        streamState.loadingCleared = true;
      }
    }

    // Increment tool result count
    streamState.toolResultCount++;

    insertToolMessageAfterAssistant(newMsgs, toolMessage);

    // A tool result ends the current assistant text segment. The next textDelta
    // should create a new assistant message after the tool card.
    streamState.assistantMessageId = null;
    streamState.messageIndex = -1;
    streamState.toolResultCount = 0;
    
    // Update stream state inside setState for consistency
    taskStreamState.set(taskId, streamState);
    
    return { messages: { ...state.messages, [conversationId]: newMsgs } };
  });
}

/** Handle textDelta events: append to or create assistant message */
function handleTextDelta(taskId: string, conversationId: string, loadingAssistantId: string, streamEv: { type: 'textDelta'; text: string }) {
  const state = getStreamState(taskId);
  const [filteredText, newThinking] = filterThinkingTags(streamEv.text, state.inThinking);

  // Skip while still inside a thinking block
  if (state.inThinking && filteredText.length === 0) {
    updateStreamState(taskId, { inThinking: newThinking });
    return;
  }

  updateStreamState(taskId, { inThinking: newThinking });

  if (state.assistantMessageId) {
    // Append to existing assistant message
    useAgentStore.setState((state2) => {
      const convMsgs = state2.messages[conversationId] || [];
      let { messageIndex: idx } = state;
      if (idx >= convMsgs.length || convMsgs[idx]?.id !== state.assistantMessageId) {
        idx = convMsgs.findIndex((m) => m.id === state.assistantMessageId);
        if (idx === -1) return state2;
      }
      const newMsgs = [...convMsgs];
      newMsgs[idx] = { ...newMsgs[idx], content: newMsgs[idx].content + filteredText };
      return { messages: { ...state2.messages, [conversationId]: newMsgs } };
    });
  } else {
    // First text — create new assistant message.
    // Bug4 fix: declare mutable captures outside setState so the closure stays pure.
    let loadingCleared = state.loadingCleared;
    let newAssistantId = '';
    let newMsgIndex = -1;

    useAgentStore.setState((state2) => {
      const convMsgs = state2.messages[conversationId] || [];
      let newMsgs = [...convMsgs];
      if (!loadingCleared) {
        const loadingIdx = newMsgs.findIndex((m) => m.id === loadingAssistantId);
        if (loadingIdx !== -1) {
          newMsgs.splice(loadingIdx, 1);
          loadingCleared = true;
        }
      }

      const newMsg: AgentMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: filteredText,
        timestamp: new Date().toISOString(),
      };
      newMsgs.push(newMsg);
      newAssistantId = newMsg.id;
      newMsgIndex = newMsgs.length - 1;

      return { messages: { ...state2.messages, [conversationId]: newMsgs } };
    });

    // Bug4 fix: update taskStreamState outside setState to keep the closure pure.
    // Use fresh state reads to ensure consistency in async context.
    const finalState = getStreamState(taskId);
    taskStreamState.set(taskId, {
      assistantMessageId: newAssistantId,
      messageIndex: newMsgIndex,
      inThinking: newThinking,
      loadingCleared,
      toolResultCount: finalState.toolResultCount,
    });
  }

  // Update task status from planning to executing
  const store = useAgentStore.getState();
  if (store.tasks[taskId]?.status === 'planning') {
    store.updateTaskStatus(taskId, 'executing');
  }
}

/** Handle done events: cleanup and mark task completed */
function handleDone(taskId: string, conversationId: string, loadingAssistantId: string) {
  useAgentStore.getState().updateTaskStatus(taskId, 'completed');
  
  useAgentStore.setState((state2) => {
    const convMsgs = state2.messages[conversationId] || [];
    const newMsgs = convMsgs.filter((m) => {
      // Remove loading messages
      if (m.id === loadingAssistantId) return false;
      // Remove truly orphan empty assistant messages, but keep those that
      // carry a toolCall (tool-call-only messages have empty content by design).
      if (m.role === 'assistant' && m.content === '' && !m.toolCall) return false;
      return true;
    });
    return {
      messages: { ...state2.messages, [conversationId]: newMsgs },
      activeTaskId: state2.activeTaskId === taskId ? null : state2.activeTaskId,
      // Clear any pending approval when task finishes normally
      pendingApproval: null,
    };
  });
  
  cleanupTaskListeners(taskId);
}

/** Handle error events: show error message and mark task failed */
function handleError(taskId: string, conversationId: string, loadingAssistantId: string, errEv: { type: 'error'; message: string }) {
  useAgentStore.getState().updateTaskStatus(taskId, 'failed');
  
  useAgentStore.setState((state2) => {
    const convMsgs = state2.messages[conversationId] || [];
    const newMsgs = convMsgs.filter((m) => m.id !== loadingAssistantId);
    return {
      messages: {
        ...state2.messages,
        [conversationId]: [
          ...newMsgs,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `LLM 错误：${errEv.message}`,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      activeTaskId: state2.activeTaskId === taskId ? null : state2.activeTaskId,
      // Clear any pending approval when task fails
      pendingApproval: null,
    };
  });
  
  cleanupTaskListeners(taskId);
}

async function attachStreamListener(taskId: string, conversationId: string, loadingAssistantId: string) {
  if (streamListeners.has(taskId)) return;

  const unlisten = await listen<LlmStreamEvent | ToolResultPayload | ApprovalRequestPayload>(
    `agent://stream/${taskId}`,
    (event) => {
      const ev = event.payload;

      if (isToolResultPayload(ev)) {
        handleToolResult(taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'approvalRequest')) {
        useAgentStore.getState().setPendingApproval(ev);
        return;
      }

      if (hasEventType(ev, 'textDelta')) {
        handleTextDelta(taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'toolCallStart') || hasEventType(ev, 'toolCallDelta')) {
        console.debug('[agent] tool event', ev);
        return;
      }

      if (hasEventType(ev, 'done')) {
        handleDone(taskId, conversationId, loadingAssistantId);
        return;
      }

      if (hasEventType(ev, 'error')) {
        handleError(taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      console.warn('[agent] unknown event type', ev);
    },
  );
  streamListeners.set(taskId, unlisten);
}

const planListeners: Map<string, UnlistenFn> = new Map();

async function attachPlanListener(taskId: string) {
  if (planListeners.has(taskId)) return;

  const unlisten = await listen<PlanStreamEvent>(
    `agent://plan/${taskId}`,
    (event) => {
      const ev = event.payload;
      const store = useAgentStore.getState();

      switch (ev.type) {
        case 'plan-created': {
          const plan: AgentTaskPlan = {
            taskId,
            items: ev.items,
            currentIndex: 0,
          };
          store.setPlan(taskId, plan);
          break;
        }
        case 'plan-item-started': {
          store.updatePlanItem(taskId, ev.itemId, 'in_progress');
          break;
        }
        case 'plan-item-completed': {
          store.updatePlanItem(taskId, ev.itemId, 'completed');
          // Update currentIndex using the latest state
          const latestPlan = useAgentStore.getState().plans[taskId];
          if (latestPlan) {
            const nextIndex = latestPlan.items.findIndex(
              (item, index) => index > latestPlan.currentIndex && item.status === 'pending'
            );
            const newCurrentIndex = nextIndex !== -1 ? nextIndex : latestPlan.currentIndex;
            store.setPlan(taskId, { ...latestPlan, currentIndex: newCurrentIndex });
          }
          break;
        }
        case 'plan-item-failed': {
          store.updatePlanItem(taskId, ev.itemId, 'failed', ev.error);
          break;
        }
        case 'plan-completed': {
          console.log(`[agent] Plan completed for task ${taskId}: ${ev.completed}/${ev.total}`);
          break;
        }
      }
    },
  );

  planListeners.set(taskId, unlisten);
}
