import { create } from 'zustand';
import type {
  AgentTask,
  AgentMessage,
  AgentMode,
  ApprovalRequestPayload,
  AgentTaskPlan,
  QuestionRequestPayload,
  QuestionAnswer,
  TokenUsage,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { attachStreamListener, attachPlanListener, cleanupTaskListeners } from './agentStreamManager';
import { useConversationStore } from './conversationStore';
import { useSettingsStore } from './settingsStore';

export interface TaskState {
  tasks: Record<string, AgentTask>;
  activeTaskId: string | null;
  mode: AgentMode;
  inputDraft: string;
  pendingApproval: ApprovalRequestPayload | null;
  pendingQuestion: QuestionRequestPayload | null;
  plans: Record<string, AgentTaskPlan>;
  plansDirty: boolean;
  taskTokenUsage: TokenUsage | null;

  startTask: (sessionId: string, prompt: string, connectionId?: string) => Promise<string>;
  stopTask: (taskId: string) => Promise<void>;
  approveOperation: (taskId: string, operationId: string) => Promise<void>;
  rejectOperation: (taskId: string, operationId: string) => Promise<void>;
  setMode: (mode: AgentMode) => void;
  setInputDraft: (text: string) => void;
  updateTaskStatus: (taskId: string, status: AgentTask['status']) => void;
  setPendingApproval: (approval: ApprovalRequestPayload | null) => void;
  setPendingQuestion: (question: QuestionRequestPayload | null) => void;
  answerQuestion: (taskId: string, questionId: string, answers: QuestionAnswer[]) => Promise<void>;
  setPlan: (taskId: string, plan: AgentTaskPlan) => void;
  getActivePlan: () => AgentTaskPlan | null;
  loadPersistedPlans: (conversationId: string, storedPlans: { taskId: string; plan: AgentTaskPlan; updatedAt: string }[]) => void;
  clearPlansByConversation: (conversationId: string) => void;
  /** 撤回消息后应用后端返回的 plan（null = 清空该对话 plan） */
  applyPlanAfterTruncate: (
    conversationId: string,
    plan: AgentTaskPlan | null,
    planTaskId: string | null,
  ) => void;
  accumulateTokenUsage: (usage: TokenUsage) => void;

  clearActiveTask: () => void;
  clearActiveTaskIf: (taskId: string) => void;
}

const currentAssistantMessageId: Map<string, string> = new Map();

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: {},
  activeTaskId: null,
  mode: 'agent',
  inputDraft: '',
  pendingApproval: null,
  pendingQuestion: null,
  plans: {},
  plansDirty: false,
  taskTokenUsage: null,

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
      conversationId,
      prompt,
      mode,
      status: 'planning',
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      tasks: { ...state.tasks, [taskId]: task },
      activeTaskId: taskId,
      taskTokenUsage: null,
    }));

    void attachStreamListener(taskId, conversationId, loadingAssistantId);
    void attachPlanListener(taskId);

    return taskId;
  },

  stopTask: async (taskId: string) => {
    try {
      await tauri.agentStopTask(taskId);
    } finally {
      // Mark in-flight tool cards as aborted before unlistening. The backend only
      // sends a cancel signal — exec_streamed does not watch it, so the in-progress
      // tool keeps running until it finishes or times out; only then does the agent
      // loop hit its post-exec cancellation checkpoint and stop. Meanwhile the
      // listener cleanup below closes the channel before the late toolResult event
      // (or StreamEvent::Done) would arrive, so we synchronously mark the card here
      // with wasAborted + an interruption note. The backend persists the same note
      // separately, keeping the LLM history chain complete.
      useConversationStore.getState().markAbortedToolFlags();
      cleanupTaskListeners(taskId);
      set((state) => {
        const task = state.tasks[taskId];
        if (!task) return state;
        return {
          tasks: { ...state.tasks, [taskId]: { ...task, status: 'cancelled' } },
          activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
          pendingApproval: null,
          pendingQuestion: null,
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
    const settingsStore = useSettingsStore.getState();
    if (settingsStore.loaded && settingsStore.settings.defaultAgentMode !== mode) {
      settingsStore.update({ defaultAgentMode: mode }).catch((err) => {
        console.error('[taskStore] persist defaultAgentMode failed', err);
      });
    }
  },

  setInputDraft: (text: string) => {
    set({ inputDraft: text });
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

  setPendingQuestion: (question: QuestionRequestPayload | null) => {
    set({ pendingQuestion: question });
  },

  answerQuestion: async (taskId: string, questionId: string, answers: QuestionAnswer[]) => {
    set({ pendingQuestion: null });
    await tauri.agentAnswerQuestion(taskId, questionId, answers);
  },

  setPlan: (taskId: string, plan: AgentTaskPlan) => {
    set((state) => ({
      plans: { ...state.plans, [taskId]: plan },
      plansDirty: !state.plansDirty,
    }));
  },

  getActivePlan: () => {
    const activeTaskId = get().activeTaskId;
    if (!activeTaskId) return null;
    return get().plans[activeTaskId] || null;
  },

  loadPersistedPlans: (conversationId, storedPlans) => {
    set((state) => {
      const newPlans = { ...state.plans };
      const newTasks = { ...state.tasks };
      // 先清理当前 conversationId 下的旧占位 task 和对应 plan，
      // 避免切换对话时旧数据累积。真实 task（sessionId 非空）保留。
      for (const [tid, t] of Object.entries(newTasks)) {
        if (t.conversationId === conversationId && !t.sessionId) {
          delete newTasks[tid];
          delete newPlans[tid];
        }
      }
      for (const sp of storedPlans) {
        // 原样加载 plan，完全还原重启前状态（包括 in_progress item 的旋转
        // 图标——这符合事实，task 确实中断在那一步）。
        newPlans[sp.taskId] = sp.plan;
        // 为重启前的 task 创建轻量占位条目，使 PlanList selector 能按
        // conversationId 找到对应 plan。sessionId 用空字符串标记占位 task，
        // PlanList 据此跳过"task 完成 + plan 全终态 → 隐藏"检查。
        if (!newTasks[sp.taskId]) {
          newTasks[sp.taskId] = {
            id: sp.taskId,
            sessionId: '',
            conversationId,
            prompt: '',
            mode: 'agent',
            status: 'completed',
            createdAt: sp.updatedAt,
          };
        }
      }
      return { plans: newPlans, tasks: newTasks };
    });
  },

  clearPlansByConversation: (conversationId) => {
    set((state) => {
      const newPlans = { ...state.plans };
      const newTasks = { ...state.tasks };
      let changed = false;
      for (const [tid, t] of Object.entries(newTasks)) {
        if (t.conversationId === conversationId) {
          delete newTasks[tid];
          delete newPlans[tid];
          changed = true;
        }
      }
      return changed ? { plans: newPlans, tasks: newTasks } : state;
    });
  },

  applyPlanAfterTruncate: (conversationId, plan, planTaskId) => {
    set((state) => {
      const newPlans = { ...state.plans };
      const newTasks = { ...state.tasks };
      for (const [tid, t] of Object.entries(newTasks)) {
        if (t.conversationId === conversationId) {
          delete newTasks[tid];
          delete newPlans[tid];
        }
      }
      if (plan && planTaskId) {
        const restored = { ...plan, taskId: planTaskId };
        newPlans[planTaskId] = restored;
        if (!newTasks[planTaskId]) {
          newTasks[planTaskId] = {
            id: planTaskId,
            sessionId: '',
            conversationId,
            prompt: '',
            mode: 'agent',
            status: 'completed',
            createdAt: new Date().toISOString(),
          };
        } else {
          newTasks[planTaskId] = {
            ...newTasks[planTaskId],
            conversationId,
          };
        }
      }
      return { plans: newPlans, tasks: newTasks, plansDirty: !state.plansDirty };
    });
  },

  accumulateTokenUsage: (usage: TokenUsage) => {
    set((state) => {
      const taskUsage = state.taskTokenUsage
        ? {
            promptTokens: state.taskTokenUsage.promptTokens + usage.promptTokens,
            completionTokens: state.taskTokenUsage.completionTokens + usage.completionTokens,
            totalTokens: state.taskTokenUsage.totalTokens + usage.totalTokens,
            reasoningTokens:
              state.taskTokenUsage.reasoningTokens !== undefined || usage.reasoningTokens !== undefined
                ? (state.taskTokenUsage.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0)
                : undefined,
            cachedReadTokens:
              state.taskTokenUsage.cachedReadTokens !== undefined || usage.cachedReadTokens !== undefined
                ? (state.taskTokenUsage.cachedReadTokens ?? 0) + (usage.cachedReadTokens ?? 0)
                : undefined,
          }
        : { ...usage };
      return { taskTokenUsage: taskUsage };
    });
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
