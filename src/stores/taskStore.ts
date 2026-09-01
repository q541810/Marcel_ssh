import { create } from "zustand";
import type {
  AgentTask,
  AgentMessage,
  AgentMode,
  ApprovalRequestPayload,
  AgentTaskPlan,
  QuestionRequestPayload,
  QuestionAnswer,
  TokenUsage,
} from "@/lib/types";
import * as tauri from "@/lib/tauri";
import { getErrorMessage } from "@/lib/errors";
import { currentVision } from "@/lib/llmRegistry";
import {
  attachStreamListener,
  attachPlanListener,
  cleanupTaskListeners,
} from "./agentStreamManager";
import { useConversationStore } from "./conversationStore";
import { useSettingsStore } from "./settingsStore";

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
  unreadCompletedConversations: string[];

  startTask: (
    sessionId: string,
    prompt: string,
    connectionId?: string,
    imageDataUrls?: string[],
    /** 撤回恢复图重发成功后要删除的旧落盘路径 */
    replaceImagePaths?: string[],
  ) => Promise<string>;
  stopTask: (taskId: string) => Promise<void>;
  approveOperation: (taskId: string, operationId: string) => Promise<void>;
  rejectOperation: (taskId: string, operationId: string) => Promise<void>;
  setMode: (mode: AgentMode) => void;
  /** 支持函数式更新（追加文本附件用 `(prev) => ...`）。 */
  setInputDraft: (text: string | ((prev: string) => string)) => void;
  updateTaskStatus: (taskId: string, status: AgentTask["status"]) => void;
  setPendingApproval: (approval: ApprovalRequestPayload | null) => void;
  setPendingQuestion: (question: QuestionRequestPayload | null) => void;
  answerQuestion: (
    taskId: string,
    questionId: string,
    answers: QuestionAnswer[],
  ) => Promise<void>;
  setPlan: (taskId: string, plan: AgentTaskPlan) => void;
  getActivePlan: () => AgentTaskPlan | null;
  loadPersistedPlans: (
    conversationId: string,
    storedPlans: { taskId: string; plan: AgentTaskPlan; updatedAt: string }[],
  ) => void;
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
  markConversationUnreadCompleted: (conversationId: string) => void;
  clearConversationUnreadCompleted: (conversationId: string) => void;
}

const currentAssistantMessageId: Map<string, string> = new Map();

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: {},
  activeTaskId: null,
  mode: "agent",
  inputDraft: "",
  pendingApproval: null,
  pendingQuestion: null,
  plans: {},
  plansDirty: false,
  taskTokenUsage: null,
  unreadCompletedConversations: [],

  startTask: async (
    sessionId: string,
    prompt: string,
    connectionId?: string,
    imageDataUrls?: string[],
    replaceImagePaths?: string[],
  ) => {
    const { mode } = get();
    const conversationStore = useConversationStore.getState();
    const vision = currentVision(useSettingsStore.getState().settings.llmRegistry);
    const images = vision ? (imageDataUrls ?? []).slice(0, 5) : [];

    const titleSeed = prompt.trim() || (images.length > 0 ? "[image]" : "");
    const conversationId = await conversationStore.ensureConversation(
      sessionId,
      connectionId ?? "",
      titleSeed || "新会话",
    );

    const userMessageId = crypto.randomUUID();
    let imagePaths: string[] | undefined;
    if (images.length > 0) {
      try {
        imagePaths = await tauri.agentSaveMessageImages(
          conversationId,
          userMessageId,
          images,
        );
        // 新图已落盘：旧撤回路径可删（start 失败也不回滚新图）
        if (replaceImagePaths?.length) {
          await Promise.all(
            [...new Set(replaceImagePaths)].map(async (p) => {
              try {
                await tauri.agentDeleteMessageImage(p);
              } catch {
                // best-effort
              }
            }),
          );
        }
      } catch (err) {
        conversationStore.updateConversationMessages(conversationId, (msgs) => [
          ...msgs,
          {
            id: crypto.randomUUID(),
            role: "system",
            content: `保存图片失败：${getErrorMessage(err)}`,
            timestamp: new Date().toISOString(),
          },
        ]);
        const e = err instanceof Error ? err : new Error(getErrorMessage(err));
        (e as Error & { stage?: string }).stage = "save_images";
        throw e;
      }
    }

    const userMessage: AgentMessage = {
      id: userMessageId,
      role: "user",
      content: prompt,
      timestamp: new Date().toISOString(),
      imagePaths,
    };

    const loadingAssistantId = crypto.randomUUID();
    const loadingAssistantMessage: AgentMessage = {
      id: loadingAssistantId,
      role: "assistant",
      content: "",
      timestamp: new Date().toISOString(),
      isLoading: true,
    };

    conversationStore.appendMessages(conversationId, [
      userMessage,
      loadingAssistantMessage,
    ]);

    // 先生成 taskId 并挂载事件 listener，再启动后端任务，消除 startTask 返回前
    // 后端已发出首批事件或终态事件的竞态。
    const taskId = crypto.randomUUID();
    const task: AgentTask = {
      id: taskId,
      sessionId,
      conversationId,
      prompt,
      mode,
      status: "planning",
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      tasks: { ...state.tasks, [taskId]: task },
      activeTaskId: taskId,
      taskTokenUsage: null,
    }));

    try {
      await Promise.all([
        attachStreamListener(taskId, conversationId, loadingAssistantId),
        attachPlanListener(taskId),
      ]);
      const llmHistory = conversationStore.buildLlmHistory(conversationId);
      // 会话级模型选择：当前 conversation 的 modelId（无 = 跟随全局默认）
      const convModelId =
        useConversationStore.getState().conversations[conversationId]?.modelId ?? null;
      await tauri.agentStartTask(
        sessionId,
        prompt,
        mode,
        conversationId,
        llmHistory,
        taskId,
        convModelId,
      );
    } catch (err) {
      cleanupTaskListeners(taskId);
      set((state) => {
        const tasks = { ...state.tasks };
        delete tasks[taskId];
        return {
          tasks,
          activeTaskId:
            state.activeTaskId === taskId ? null : state.activeTaskId,
        };
      });
      // start 失败时 agent_loop 不会落库 user 消息；补写 DB，避免重载丢消息/孤儿图
      try {
        await tauri.agentSaveUserMessage(
          conversationId,
          prompt,
          userMessage.timestamp,
          imagePaths,
        );
      } catch (persistErr) {
        console.warn(
          "Failed to persist user message after start_task error:",
          persistErr,
        );
      }
      conversationStore.updateConversationMessages(conversationId, (msgs) => [
        ...msgs.filter((m) => m.id !== loadingAssistantId),
        {
          id: crypto.randomUUID(),
          role: "system",
          content: `启动任务失败：${getErrorMessage(err)}`,
          timestamp: new Date().toISOString(),
        },
      ]);
      const e = err instanceof Error ? err : new Error(getErrorMessage(err));
      (e as Error & { stage?: string }).stage = "start_task";
      throw e;
    }

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
      // 级联：收集该任务及其全部后代子agent（task 工具派发）。停止主任务会
      // 级联停掉子任务，前端必须同步清理子任务 listener 并标记取消——否则
      // 子任务收到 Done 会被 handleDone 误标为 completed（实际是被取消的）。
      const ids = [taskId];
      let i = 0;
      while (i < ids.length) {
        const parent = ids[i++];
        for (const [id, t] of Object.entries(get().tasks)) {
          if (t.parentTaskId === parent && !ids.includes(id)) ids.push(id);
        }
      }
      // 只处理运行中的任务（限定到各自所属对话，不误伤其他对话的工具卡片）。
      // 已终态的任务跳过：避免把「子任务已自然完成、主任务仍在等结果」误标成取消。
      const runningIds: string[] = [];
      for (const id of ids) {
        const t = get().tasks[id];
        if (
          !t ||
          !["planning", "executing", "waiting_approval"].includes(t.status)
        )
          continue;
        runningIds.push(id);
        useConversationStore.getState().markAbortedToolFlags(t.conversationId);
        cleanupTaskListeners(id);
        useConversationStore
          .getState()
          .clearAllAssistantFlags(t.conversationId);
      }
      set((state) => {
        const tasks = { ...state.tasks };
        let nextActive = state.activeTaskId;
        let found = false;
        for (const id of runningIds) {
          const task = tasks[id];
          if (!task) continue;
          tasks[id] = { ...task, status: "cancelled" };
          found = true;
          if (state.activeTaskId === id) nextActive = null;
        }
        if (!found) return state;
        return {
          tasks,
          activeTaskId: nextActive,
          pendingApproval: null,
          pendingQuestion: null,
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

  setMode: (mode: AgentMode) => {
    set({ mode });
    const settingsStore = useSettingsStore.getState();
    if (
      settingsStore.loaded &&
      settingsStore.settings.defaultAgentMode !== mode
    ) {
      settingsStore.update({ defaultAgentMode: mode }).catch((err) => {
        console.error("[taskStore] persist defaultAgentMode failed", err);
      });
    }
  },

  setInputDraft: (text: string | ((prev: string) => string)) => {
    set((state) => ({
      inputDraft:
        typeof text === "function" ? text(state.inputDraft) : text,
    }));
  },

  updateTaskStatus: (taskId: string, status: AgentTask["status"]) => {
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

  answerQuestion: async (
    taskId: string,
    questionId: string,
    answers: QuestionAnswer[],
  ) => {
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
            sessionId: "",
            conversationId,
            prompt: "",
            mode: "agent",
            status: "completed",
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
            sessionId: "",
            conversationId,
            prompt: "",
            mode: "agent",
            status: "completed",
            createdAt: new Date().toISOString(),
          };
        } else {
          newTasks[planTaskId] = {
            ...newTasks[planTaskId],
            conversationId,
          };
        }
      }
      return {
        plans: newPlans,
        tasks: newTasks,
        plansDirty: !state.plansDirty,
      };
    });
  },

  accumulateTokenUsage: (usage: TokenUsage) => {
    set((state) => {
      const taskUsage = state.taskTokenUsage
        ? {
            promptTokens:
              state.taskTokenUsage.promptTokens + usage.promptTokens,
            completionTokens:
              state.taskTokenUsage.completionTokens + usage.completionTokens,
            totalTokens: state.taskTokenUsage.totalTokens + usage.totalTokens,
            reasoningTokens:
              state.taskTokenUsage.reasoningTokens !== undefined ||
              usage.reasoningTokens !== undefined
                ? (state.taskTokenUsage.reasoningTokens ?? 0) +
                  (usage.reasoningTokens ?? 0)
                : undefined,
            cachedReadTokens:
              state.taskTokenUsage.cachedReadTokens !== undefined ||
              usage.cachedReadTokens !== undefined
                ? (state.taskTokenUsage.cachedReadTokens ?? 0) +
                  (usage.cachedReadTokens ?? 0)
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

  markConversationUnreadCompleted: (conversationId: string) => {
    set((state) => {
      if (state.unreadCompletedConversations.includes(conversationId)) return state;
      return {
        unreadCompletedConversations: [
          ...state.unreadCompletedConversations,
          conversationId,
        ],
      };
    });
  },

  clearConversationUnreadCompleted: (conversationId: string) => {
    set((state) => {
      if (!state.unreadCompletedConversations.includes(conversationId)) return state;
      return {
        unreadCompletedConversations: state.unreadCompletedConversations.filter(
          (id) => id !== conversationId,
        ),
      };
    });
  },
}));
