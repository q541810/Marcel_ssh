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

  // If the message has persisted tool_calls JSON, reconstruct the first toolCall.
  if (m.toolCallsJson) {
    try {
      const persistedCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
        risk_level: RiskLevel;
      }> = JSON.parse(m.toolCallsJson);
      if (persistedCalls.length > 0) {
        base.toolCall = {
          id: persistedCalls[0].id,
          name: persistedCalls[0].name,
          arguments: persistedCalls[0].arguments,
          riskLevel: persistedCalls[0].risk_level,
        };
      }
    } catch {
      // ignore parse error
    }
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
      currentAssistantMessageId.delete(taskId);
      assistantMessageIndex.delete(taskId);
      inThinkingState.delete(taskId);
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

/** Maps taskId to { messageId, messageIndex } for O(1) textDelta updates */
const assistantMessageIndex: Map<string, { messageId: string; index: number }> = new Map();

/** Maps taskId to whether we're inside a thinking block (defense-in-depth) */
const inThinkingState: Map<string, boolean> = new Map();

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

async function attachStreamListener(taskId: string, conversationId: string, loadingAssistantId: string) {
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
          // Clear the loading state on the loading assistant message
          const loadingMsgIdx = convMsgs.findIndex((m) => m.id === loadingAssistantId);
          let newMsgs = [...convMsgs];

          // If the loading message has no content, remove it entirely to avoid
          // displaying an empty assistant bubble before the tool result.
          if (loadingMsgIdx !== -1 && newMsgs[loadingMsgIdx].content === '') {
            newMsgs = [...convMsgs.slice(0, loadingMsgIdx), ...convMsgs.slice(loadingMsgIdx + 1)];
          } else if (loadingMsgIdx !== -1) {
            newMsgs[loadingMsgIdx] = {
              ...newMsgs[loadingMsgIdx],
              isLoading: false,
            };
          }

          // Insert tool message after the assistant slot
          const insertIdx = loadingMsgIdx !== -1 ? loadingMsgIdx : newMsgs.length;
          if (assistantMessageId) {
            const assistantIdx = newMsgs.findIndex((m) => m.id === assistantMessageId);
            if (assistantIdx !== -1) {
              newMsgs.splice(assistantIdx + 1, 0, toolMessage);
              return { messages: { ...state.messages, [conversationId]: newMsgs } };
            }
          }
          return { messages: { ...state.messages, [conversationId]: [...newMsgs, toolMessage] } };
        });

        currentAssistantMessageId.delete(taskId);
        assistantMessageIndex.delete(taskId);
        inThinkingState.delete(taskId);
        return;
      }

      switch (ev.type) {
        case 'textDelta': {
          let thinking = inThinkingState.get(taskId) ?? false;
          const [filteredText, newThinking] = filterThinkingTags(ev.text, thinking);
          inThinkingState.set(taskId, newThinking);

          // Skip update when still inside a thinking block.
          // When thinking just ended (newThinking === false) but filteredText is empty,
          // we still update the message to clear isLoading so the user sees the transition.
          if (newThinking && filteredText.length === 0) return;

          let cached = assistantMessageIndex.get(taskId);
          if (!cached) {
            useAgentStore.setState((state) => {
              const convMsgs = state.messages[conversationId] || [];
              const idx = convMsgs.findIndex((m) => m.id === loadingAssistantId);
              if (idx === -1) return state;
              const newMsgs = [...convMsgs];
              newMsgs[idx] = {
                ...newMsgs[idx],
                content: filteredText,
                isLoading: false,
              };
              return { messages: { ...state.messages, [conversationId]: newMsgs } };
            });
            assistantMessageIndex.set(taskId, { messageId: loadingAssistantId, index: 0 });
            currentAssistantMessageId.set(taskId, loadingAssistantId);
            cached = { messageId: loadingAssistantId, index: 0 };
          } else {
            useAgentStore.setState((state) => {
              const convMsgs = state.messages[conversationId] || [];
              let { index: idx } = cached!;
              if (idx >= convMsgs.length || convMsgs[idx].id !== cached!.messageId) {
                idx = convMsgs.findIndex((m) => m.id === cached!.messageId);
                if (idx === -1) return state;
                cached!.index = idx;
              }
              const newMsgs = [...convMsgs];
              newMsgs[idx] = { ...newMsgs[idx], content: newMsgs[idx].content + filteredText };
              return { messages: { ...state.messages, [conversationId]: newMsgs } };
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
          useAgentStore.setState((state) => {
            const convMsgs = state.messages[conversationId] || [];
            const loadingMsgIdx = convMsgs.findIndex((m) => m.id === loadingAssistantId);
            let newMsgs = [...convMsgs];
            // Clean up the loading message: if it has content, clear isLoading;
            // otherwise remove it entirely.
            if (loadingMsgIdx !== -1 && newMsgs[loadingMsgIdx].content === '') {
              newMsgs = [...convMsgs.slice(0, loadingMsgIdx), ...convMsgs.slice(loadingMsgIdx + 1)];
            } else if (loadingMsgIdx !== -1) {
              newMsgs[loadingMsgIdx] = { ...newMsgs[loadingMsgIdx], isLoading: false };
            }
            return {
              messages: { ...state.messages, [conversationId]: newMsgs },
              activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
            };
          });
          currentAssistantMessageId.delete(taskId);
          assistantMessageIndex.delete(taskId);
          inThinkingState.delete(taskId);
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
          break;
        }
        case 'error': {
          store.updateTaskStatus(taskId, 'failed');
          useAgentStore.setState((state) => {
            const convMsgs = state.messages[conversationId] || [];
            return {
              messages: {
                ...state.messages,
                [conversationId]: convMsgs
                  .filter((m) => m.id !== loadingAssistantId)
                  .concat([
                    {
                      id: crypto.randomUUID(),
                      role: 'system',
                      content: `LLM 错误：${ev.message}`,
                      timestamp: new Date().toISOString(),
                    },
                  ]),
              },
              activeTaskId:
                state.activeTaskId === taskId ? null : state.activeTaskId,
            };
          });
          currentAssistantMessageId.delete(taskId);
          assistantMessageIndex.delete(taskId);
          inThinkingState.delete(taskId);
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
          break;
        }
      }
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
