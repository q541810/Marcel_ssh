import { create } from "zustand";
import type {
  AgentTask,
  AgentMessage,
  AgentMode,
  AgentTaskPlan,
  ConversationUsage,
  ContextUsageEvent,
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
import { resetAutoContinues } from "./wakeBudget";
import { isTaskBusy } from "@/lib/agentStatus";
import { useSettingsStore } from "./settingsStore";
import { usageFromContextEvent } from "@/lib/tokenUsage";

/** 一个会话的 token 用量读数（实时事件写进来，重启后由会话数据兜底）。 */
export interface ConversationUsageEntry {
  usage: ConversationUsage;
  /** 生效上下文窗口（0 = 未配置）。后端 overlay 给的，前端不自己解析。 */
  windowTokens: number;
}

export interface TaskState {
  tasks: Record<string, AgentTask>;
  activeTaskId: string | null;
  mode: AgentMode;
  inputDraft: string;
  plans: Record<string, AgentTaskPlan>;
  plansDirty: boolean;
  /**
   * 各会话的 token 用量读数，key = conversationId。
   *
   * 只装**实时事件**写进来的值（按会话分桶，子 agent 的事件进它自己的子会话
   * 桶）；重启后打开会话时读的是会话数据里的落库用量，由
   * `lib/tokenUsage.ts` 的 `conversationUsageView` 做「事件优先、落库兜底」的合成。
   *
   * 为什么只覆盖不累加：事件带的是**后端写库后**的累计值（与重启后读到的
   * 是同一个数字），累加会把每一轮算两遍。
   *
   * 刻意不做删除清理：条目大小约百字节、会话 id 不复用，上限就是「本次运行
   * 跑过任务的会话数」。
   */
  usageByConversation: Record<string, ConversationUsageEntry>;
  unreadCompletedConversations: string[];

  startTask: (
    sessionId: string,
    prompt: string,
    connectionId?: string,
    imageDataUrls?: string[],
    /** 撤回恢复图重发成功后要删除的旧落盘路径 */
    replaceImagePaths?: string[],
    /**
     * 开一轮的附加语义：
     * - `conversationId`：**指定**开在哪条会话，跳过 `ensureConversation` 的
     *   「当前活跃会话」启发式。自动继续必须用它：作业归属的会话可能不是
     *   用户此刻正在看的那条，走启发式会开错会话、还会把界面劫持过去。
     * - `jobNotice`：这一轮的 prompt 是系统替后台作业写的结算告知。它落库
     *   role=notice（界面上是独立告知卡），且**不算用户输入**（自动继续的
     *   额度只由真的用户输入重置）。
     */
    options?: { conversationId?: string; jobNotice?: boolean },
  ) => Promise<string>;
  stopTask: (taskId: string) => Promise<void>;
  setMode: (mode: AgentMode) => void;
  /** 支持函数式更新（追加文本附件用 `(prev) => ...`）。 */
  setInputDraft: (text: string | ((prev: string) => string)) => void;
  updateTaskStatus: (taskId: string, status: AgentTask["status"]) => void;
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
  /**
   * 记一轮 LLM 请求后的用量快照（`contextUsage` 事件）。
   *
   * `conversationId` 来自**订阅该任务那条流时**用的会话 id（子 agent 是它自己
   * 的子会话），所以父子天然分桶、不重不漏。只覆盖不累加 —— 事件带的是后端
   * 写库后的累计值，前端的活就是把它显示出来。
   */
  recordContextUsage: (conversationId: string, ev: ContextUsageEvent) => void;

  clearActiveTask: () => void;
  clearActiveTaskIf: (taskId: string) => void;
  markConversationUnreadCompleted: (conversationId: string) => void;
  clearConversationUnreadCompleted: (conversationId: string) => void;
}

const currentAssistantMessageId: Map<string, string> = new Map();

/**
 * 任务本地收尾（**唯一入口**）。
 *
 * 任何改写任务终态的路径都必须走它 —— 就地 `setState` 改 `status` 会同时
 * 绕过收尾契约的三件事（历史教训：绕开 `stopTask` 去改任务状态 = 绕过收尾）：
 * 1. `markAbortedToolFlags`：在飞的工具卡片标成「已中断」，否则永久转圈；
 * 2. `cleanupTaskListeners`：拆流通道。不拆的话晚到的终态事件仍会被当成模型
 *    自然结束处理（把回合写成 completed、把新任务正在飞的工具卡删掉）；
 * 3. `markTailTurnState`：落回合收尾状态（只有 completed 允许折叠回合，
 *    不写就只能拿 running 去猜）。后端也会落库，但收尾时通道已拆、
 *    前端收不到任何事件，**这里必须自己写**。
 *
 * 级联：连同该任务的全部后代子任务（subagent 工具派发）一起收尾 —— 后端
 * 取消/断连是整条线一起的，漏掉子任务会让它的终态事件被残留 listener 消费
 * 而误标 completed。
 * 幂等：只处理仍在运行中的任务，已终态的跳过（避免把「子任务已自然完成、
 * 主任务仍在等结果」误标成取消）。
 *
 * 用它收尾的是「前端自己决定的终态」（用户停止 / 会话断连）；后端回灌的
 * 权威结论不经这里 —— 那是各 `handleXxx` 事件处理器的职责，它们的卡片与
 * 回合语义与本函数不同（completed 不算中断、failed 不是用户中断）。
 *
 * @returns 真正被收尾的 taskId（含级联到的子任务）
 */
export function finalizeTaskLocally(
  taskId: string,
  status: Extract<AgentTask["status"], "cancelled" | "failed">,
): string[] {
  // 收集该任务及其全部后代（BFS；每轮重读 tasks，子链可以任意深）
  const ids = [taskId];
  let i = 0;
  while (i < ids.length) {
    const parent = ids[i++];
    for (const [id, t] of Object.entries(useTaskStore.getState().tasks)) {
      if (t.parentTaskId === parent && !ids.includes(id)) ids.push(id);
    }
  }

  // 只处理运行中的任务（限定到各自所属对话，不误伤其他对话的工具卡片）
  const runningIds: string[] = [];
  for (const id of ids) {
    const task = useTaskStore.getState().tasks[id];
    if (!task || !isTaskBusy(task.status)) continue;
    runningIds.push(id);
    const convStore = useConversationStore.getState();
    // 顺序：先标记在飞卡片（拆通道之后就拿不到 toolResult 了），再拆通道，
    // 最后落回合收尾状态。
    convStore.markAbortedToolFlags(task.conversationId);
    cleanupTaskListeners(id);
    convStore.clearAllAssistantFlags(task.conversationId);
    convStore.markTailTurnState(task.conversationId, status);
  }

  if (runningIds.length === 0) return runningIds;
  useTaskStore.setState((state) => {
    const tasks = { ...state.tasks };
    let nextActive = state.activeTaskId;
    for (const id of runningIds) {
      const task = tasks[id];
      if (!task) continue;
      tasks[id] = { ...task, status };
      if (state.activeTaskId === id) nextActive = null;
    }
    return { tasks, activeTaskId: nextActive };
  });
  return runningIds;
}

export const useTaskStore = create<TaskState>((set, get) => ({
  tasks: {},
  activeTaskId: null,
  mode: "agent",
  inputDraft: "",
  plans: {},
  plansDirty: false,
  usageByConversation: {},
  unreadCompletedConversations: [],

  startTask: async (
    sessionId: string,
    prompt: string,
    connectionId?: string,
    imageDataUrls?: string[],
    replaceImagePaths?: string[],
    options?: { conversationId?: string; jobNotice?: boolean },
  ) => {
    const { mode } = get();
    const isJobNotice = options?.jobNotice === true;
    const conversationStore = useConversationStore.getState();
    // 先按全局兜底模型判断能否附图（新会话 title 需要）；ensure 拿到真实
    // 会话后按「会话记忆 → 全局最近使用」的生效模型再精算一次。
    const settingsStore = useSettingsStore.getState();
    const vision = currentVision(settingsStore.settings.llmRegistry);
    const images = vision ? (imageDataUrls ?? []).slice(0, 5) : [];

    const titleSeed = prompt.trim() || (images.length > 0 ? "[image]" : "");
    // 指定会话（自动继续）时不走 ensureConversation：它的选择依据是「当前
    // 活跃会话」，会给别的会话开轮时开错地方，并把界面切过去。
    const conversationId =
      options?.conversationId ??
      (await conversationStore.ensureConversation(
        sessionId,
        connectionId ?? "",
        titleSeed || "新会话",
      ));
    // 用户真的说了一句话 → 自动继续的额度回满（对齐 DSH：只有人的输入回填
    // 额度，系统自己写的结算告知不算，否则上限会被自己的通知一次次解封）。
    if (!isJobNotice) {
      resetAutoContinues(conversationId);
    }

    // 精算：当前会话实际生效模型的视觉能力（会话记忆 → 全局最近使用）
    const conv = useConversationStore.getState().conversations[conversationId];
    const effectiveVision = currentVision(
      useSettingsStore.getState().settings.llmRegistry,
      conv?.modelId ?? null,
    );
    const allowedImages = effectiveVision ? (imageDataUrls ?? []).slice(0, 5) : [];

    const userMessageId = crypto.randomUUID();
    let imagePaths: string[] | undefined;
    if (allowedImages.length > 0) {
      try {
        imagePaths = await tauri.agentSaveMessageImages(
          conversationId,
          userMessageId,
          allowedImages,
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
      // 自动继续那一轮：这条是系统替作业写的告知，不是用户打的字。
      role: isJobNotice ? "notice" : "user",
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
      hasPlan: false,
      createdAt: new Date().toISOString(),
    };
    // 自动继续给**别的**会话开轮时，不能抢 `activeTaskId`：它是全局单槽，
    // 「正在跑的任务」的发送/停止按钮与回滚禁用都看它 —— 抢过来会把用户
    // 正在看的会话变成「运行中」，按回车被静默吞掉（正是这次要修掉的那种
    // 困惑）。给当前会话开轮（用户自己发消息）照旧占槽。
    const conversationIsActive =
      useConversationStore.getState().activeConversationId === conversationId;
    set((state) => ({
      tasks: { ...state.tasks, [taskId]: task },
      activeTaskId: conversationIsActive ? taskId : state.activeTaskId,
      // 用量读数**不在这里清**：它是按会话累计的落库值（跨任务接着算），
      // 新一轮的第一个 `contextUsage` 事件会带着后端算好的累计值覆盖过来。
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
        isJobNotice ? "job_notice" : undefined,
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
    // ── 先同步收尾（标记在飞的卡片 + 拆通道 + 落回合状态），**再**发停止命令 ──
    // 顺序不能反，两条理由都是「晚到的终态事件收不得」：
    // 1. 后端取消路径也会发终态事件（`StreamEvent::Cancelled`）。它要是抢在拆通道
    //    之前落地，就会被当成模型自然结束处理：在飞的工具卡片按"没跑完的调用"
    //    删掉、回合收尾状态写成 completed（→ 回合可折叠 → 过程卡片从界面上消失，
    //    而模型侧其实仍看得到）。拆通道必须赶在它前面。
    // 2. 晚到的 `toolResult` 同理收不到，卡片状态只能在这里同步写。
    //
    // 两条收尾时机（都要求这里同步标记，理由不同）：
    // - 走 command_exec 的命令（agent bash）：后端会**立刻**打断 ——
    //   agent_stop_task → cancel_with_reason(Task) → executor 的 select! 是
    //   `biased`，取消优先于数据与超时，工具以「命令已取消」返回。
    // - 其他工具（读文件 / 联网 / 子 agent / 插件…）：无法在飞途中打断，要等它
    //   返回后循环才在收尾检查点停下。
    //
    // 后端也会把同样的中断说明持久化进 LLM 历史，保证对话链完整。
    // 级联（任务及其全部后代子 agent）与「只动运行中任务」的判定都在
    // `finalizeTaskLocally` 里 —— 会话断连等路径共用同一份收尾，见其注释。
    finalizeTaskLocally(taskId, "cancelled");
    // 本地已收尾，命令失败照旧上抛（界面不会卡在「正在停止」）。
    await tauri.agentStopTask(taskId);
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

  recordContextUsage: (conversationId, ev) => {
    set((state) => ({
      usageByConversation: {
        ...state.usageByConversation,
        [conversationId]: {
          usage: usageFromContextEvent(ev),
          windowTokens: ev.contextWindow,
        },
      },
    }));
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
