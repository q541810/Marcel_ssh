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
import { getErrorMessage } from '@/lib/errors';
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

  clearActiveTask: () => void;
  clearActiveTaskIf: (taskId: string) => void;
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
    const conversationStore = useConversationStore.getState();

    const conversationId = await conversationStore.ensureConversation(sessionId, connectionId ?? '', prompt);

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

    conversationStore.appendMessages(conversationId, [userMessage, loadingAssistantMessage]);

    let taskId: string;
    try {
      const llmHistory = conversationStore.buildLlmHistory(conversationId);

      taskId = await tauri.agentStartTask(sessionId, prompt, mode, conversationId, llmHistory);
    } catch (err) {
      conversationStore.updateConversationMessages(conversationId, (msgs) => [
        ...msgs.filter((m) => m.id !== loadingAssistantId),
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: `启动任务失败：${getErrorMessage(err)}`,
          timestamp: new Date().toISOString(),
        },
      ]);
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

    void attachStreamListener(taskId, conversationId, loadingAssistantId);
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
      useConversationStore.getState().clearAllAssistantFlags();
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

  clearActiveTask: () => {
    set({ activeTaskId: null });
  },

  clearActiveTaskIf: (taskId: string) => {
    set((state) => ({
      activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
    }));
  },
}));
