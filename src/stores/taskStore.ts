import { create } from 'zustand';
import type {
  AgentTask,
  AgentMessage,
  AgentMode,
  ApprovalRequestPayload,
  AgentTaskPlan,
  PlanItem,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { attachStreamListener, attachPlanListener, cleanupTaskListeners } from './agentStreamManager';
import { useConversationStore } from './conversationStore';

export interface TaskState {
  tasks: Record<string, AgentTask>;
  activeTaskId: string | null;
  mode: AgentMode;
  pendingApproval: ApprovalRequestPayload | null;
  plans: Record<string, AgentTaskPlan>;
  plansDirty: boolean;

  startTask: (sessionId: string, prompt: string, connectionId?: string) => Promise<string>;
  stopTask: (taskId: string) => Promise<void>;
  approveOperation: (taskId: string, operationId: string) => Promise<void>;
  rejectOperation: (taskId: string, operationId: string) => Promise<void>;
  setMode: (mode: AgentMode) => void;
  updateTaskStatus: (taskId: string, status: AgentTask['status']) => void;
  setPendingApproval: (approval: ApprovalRequestPayload | null) => void;
  setPlan: (taskId: string, plan: AgentTaskPlan) => void;
  updatePlanItem: (taskId: string, itemId: string, status: PlanItem['status'], error?: string) => void;
  getActivePlan: () => AgentTaskPlan | null;
}

const currentAssistantMessageId: Map<string, string> = new Map();

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: {},
  activeTaskId: null,
  mode: 'agent',
  pendingApproval: null,
  plans: {},
  plansDirty: false,

  startTask: async (sessionId: string, prompt: string, connectionId?: string) => {
    const { mode } = get();
    let conversationId = useConversationStore.getState().activeConversationId;

    if (!conversationId) {
      const newTitle = prompt.slice(0, 30);
      const newId = await tauri.agentCreateConversation(sessionId, newTitle);
      conversationId = newId;
      useConversationStore.setState((state) => ({
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
      const conv = useConversationStore.getState().conversations[conversationId as string];
      if (conv && conv.title === '新会话') {
        const newTitle = prompt.slice(0, 30);
        useConversationStore.setState((state) => ({
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

    useConversationStore.setState((state) => ({
      messages: {
        ...state.messages,
        [conversationId as string]: [...(state.messages[conversationId as string] || []), userMessage, loadingAssistantMessage],
      },
    }));

    let taskId: string;
    try {
      const llmHistory = useConversationStore
        .getState()
        .messages[conversationId as string]
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.isLoading)
        .map((m) => ({ role: m.role, content: m.content, reasoningContent: m.reasoningContent }));

      taskId = await tauri.agentStartTask(sessionId, prompt, mode, conversationId as string, llmHistory);
    } catch (err) {
      useConversationStore.setState((state) => ({
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
      useConversationStore.setState((state) => ({
        messages: Object.fromEntries(
          Object.entries(state.messages).map(([convId, msgs]) => [
            convId,
            msgs.map((m) =>
              m.role === 'assistant' && (m.isThinking || m.isLoading)
                ? { ...m, isThinking: false, isLoading: false }
                : m,
            ),
          ]),
        ),
      }));
    }
  },

  approveOperation: async (taskId: string, operationId: string) => {
    await tauri.agentApproveOperation(taskId, operationId);
  },

  rejectOperation: async (taskId: string, operationId: string) => {
    await tauri.agentRejectOperation(taskId, operationId);
  },

  setMode: (mode: AgentMode) => {
    set({ mode });
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
