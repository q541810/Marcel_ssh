import { create } from 'zustand';
import type {
  AgentTask,
  AgentMessage,
  AgentMode,
  ApprovalRequestPayload,
  AgentConversation,
  StoredMessage,
  RiskLevel,
  AgentTaskPlan,
  PlanItem,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { attachStreamListener, attachPlanListener, cleanupTaskListeners } from './agentStreamManager';

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
      cleanupTaskListeners(taskId);
      set((state) => {
        const task = state.tasks[taskId];
        if (!task) return state;
        return {
          tasks: { ...state.tasks, [taskId]: { ...task, status: 'cancelled' } },
          activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
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
