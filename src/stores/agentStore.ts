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
} from '@/lib/types';
import * as tauri from '@/lib/tauri';

interface AgentState {
  tasks: Record<string, AgentTask>;
  activeTaskId: string | null;
  conversations: Record<string, AgentConversation>;
  messages: Record<string, AgentMessage[]>;
  activeConversationId: string | null;
  mode: AgentMode;
  pendingApproval: ApprovalRequestPayload | null;

  startTask: (sessionId: string, prompt: string) => Promise<string>;
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

  startTask: async (sessionId: string, prompt: string) => {
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
            connectionId: '',
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
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId as string]: [...(state.messages[conversationId as string] || []), userMessage],
      },
    }));

    let taskId: string;
    try {
      const llmHistory = get()
        .messages[conversationId as string]
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));

      taskId = await tauri.agentStartTask(sessionId, prompt, mode, conversationId as string, llmHistory);
    } catch (err) {
      set((state) => ({
        messages: {
          ...state.messages,
          [conversationId as string]: [
            ...(state.messages[conversationId as string] || []),
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

    void attachStreamListener(taskId, conversationId as string);

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
      currentAssistantMessageId.delete(taskId);
      set((state) => {
        const task = state.tasks[taskId];
        if (!task) return state;
        return {
          tasks: { ...state.tasks, [taskId]: { ...task, status: 'cancelled' } },
          activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
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
    const msgs: AgentMessage[] = stored.map((m: StoredMessage) => ({
      id: m.id,
      role: m.role as AgentMessage['role'],
      content: m.content,
      timestamp: m.timestamp,
    }));
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
      activeConversationId: conversationId,
    }));
  },

  loadConversation: async (conversationId: string) => {
    const stored = await tauri.agentLoadConversation(conversationId);
    const msgs: AgentMessage[] = stored.map((m: StoredMessage) => ({
      id: m.id,
      role: m.role as AgentMessage['role'],
      content: m.content,
      timestamp: m.timestamp,
    }));
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
      activeConversationId: conversationId,
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
      loadedMessages[conv.id] = stored.map((m: StoredMessage) => ({
        id: m.id,
        role: m.role as AgentMessage['role'],
        content: m.content,
        timestamp: m.timestamp,
      }));
    }

    set((state) => {
      const newConversations: Record<string, AgentConversation> = {};
      const newMessages: Record<string, AgentMessage[]> = { ...state.messages };

      for (const conv of convs) {
        newConversations[conv.id] = conv;
        newMessages[conv.id] = loadedMessages[conv.id];
      }

      // Select the most recent conversation
      const firstConvId = convs.length > 0 ? convs[0].id : null;

      return {
        conversations: newConversations,
        messages: newMessages,
        activeConversationId: firstConvId || state.activeConversationId || null,
      };
    });
  },

  getCurrentMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return [];
    return get().messages[convId] || [];
  },
}));

const streamListeners: Map<string, UnlistenFn> = new Map();

async function attachStreamListener(taskId: string, conversationId: string) {
  if (streamListeners.has(taskId)) return;

  const unlisten = await listen<LlmStreamEvent | ToolResultPayload | ApprovalRequestPayload>(
    `agent://stream/${taskId}`,
    (event) => {
      const ev = event.payload;
      const store = useAgentStore.getState();
      const assistantMessageId = currentAssistantMessageId.get(taskId);

      if ('type' in ev && ev.type === 'approvalRequest') {
        const approval = ev as ApprovalRequestPayload;
        store.setPendingApproval(approval);
        return;
      }

      if ('toolCallId' in ev) {
        const tr = ev as ToolResultPayload;
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
          },
        };

        useAgentStore.setState((state) => {
          const convMsgs = state.messages[conversationId] || [];
          if (assistantMessageId) {
            const assistantIdx = convMsgs.findIndex((m) => m.id === assistantMessageId);
            if (assistantIdx !== -1) {
              const newMsgs = [...convMsgs];
              newMsgs.splice(assistantIdx + 1, 0, toolMessage);
              return { messages: { ...state.messages, [conversationId]: newMsgs } };
            }
          }
          return { messages: { ...state.messages, [conversationId]: [...convMsgs, toolMessage] } };
        });

        currentAssistantMessageId.delete(taskId);
        return;
      }

      switch (ev.type) {
        case 'textDelta': {
          if (!assistantMessageId) {
            const newAssistantMessageId = crypto.randomUUID();
            const newAssistantMessage: AgentMessage = {
              id: newAssistantMessageId,
              role: 'assistant',
              content: ev.text,
              timestamp: new Date().toISOString(),
            };

            useAgentStore.setState((state) => ({
              messages: {
                ...state.messages,
                [conversationId]: [...(state.messages[conversationId] || []), newAssistantMessage],
              },
            }));

            currentAssistantMessageId.set(taskId, newAssistantMessageId);
          } else {
            useAgentStore.setState((state) => {
              const convMsgs = state.messages[conversationId] || [];
              return {
                messages: {
                  ...state.messages,
                  [conversationId]: convMsgs.map((m) =>
                    m.id === assistantMessageId
                      ? { ...m, content: m.content + ev.text }
                      : m,
                  ),
                },
              };
            });
          }

          if (store.tasks[taskId]?.status === 'planning') {
            store.updateTaskStatus(taskId, 'executing');
          }
          break;
        }
        case 'toolCallStart':
        case 'toolCallDelta': {
          console.debug('[agent] tool event', ev);
          break;
        }
        case 'done': {
          store.updateTaskStatus(taskId, 'completed');
          useAgentStore.setState((state) => ({
            activeTaskId:
              state.activeTaskId === taskId ? null : state.activeTaskId,
          }));
          currentAssistantMessageId.delete(taskId);
          const fn = streamListeners.get(taskId);
          if (fn) {
            fn();
            streamListeners.delete(taskId);
          }
          break;
        }
        case 'error': {
          store.updateTaskStatus(taskId, 'failed');
          useAgentStore.setState((state) => {
            const convMsgs = state.messages[conversationId] || [];
            return {
              messages: {
                ...state.messages,
                [conversationId]: [
                  ...convMsgs,
                  {
                    id: crypto.randomUUID(),
                    role: 'system',
                    content: `LLM 错误：${ev.message}`,
                    timestamp: new Date().toISOString(),
                  },
                ],
              },
              activeTaskId:
                state.activeTaskId === taskId ? null : state.activeTaskId,
            };
          });
          currentAssistantMessageId.delete(taskId);
          const fn = streamListeners.get(taskId);
          if (fn) {
            fn();
            streamListeners.delete(taskId);
          }
          break;
        }
      }
    },
  );
  streamListeners.set(taskId, unlisten);
}
