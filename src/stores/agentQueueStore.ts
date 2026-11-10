/**
 * Agent 发送队列（**manager**）：任务还在跑时先把下一条消息排好，这一轮自然结束后自动发出。
 *
 * 它要协调四个互不知情的东西——草稿（`agentDraftStore`，取走输入与附件）、任务
 * （`taskStore`，感知终态、开新一轮）、会话（`conversationStore`，忙闲与删除）、SSH 会话
 * （连接是否还在）——所以放在 store 层、挂全局订阅，**不依赖任何面板是否挂载**：
 * 用户切到别的对话/标签后，这条队列照样按时发出。
 *
 * 规矩（改动前先读）：
 * 1. **只在回合「自然结束」（completed）后自动发下一条。** 用户点了停止、任务出错、连接断开
 *    都意味着「这条路走不通/用户想改主意」，此时自动灌入排好的话是在替用户做决定——
 *    改为**暂停**，条目原样保留，由用户在队列条上点「继续」或清掉。
 * 2. **同一会话 FIFO。** 队列非空且未暂停时，新消息哪怕恰好撞上空窗也进队尾，不插队。
 * 3. **出队先摘后发**：发送失败（没写进对话）放回队首并暂停，绝不静默丢用户写的话；
 *    失败发生在 `start_task` 阶段（消息已进对话）视为已发出。
 * 4. 模式取**发出那一刻**的当前模式、模型取会话当前设置（排队期间用户改了就按新的来），
 *    与「现在发」一致，不在入队时冻结。
 * 5. 只存内存：应用重启后队列清空（图片动辄数 MB，且重启后连接也要重连，续发没有意义）。
 *    入队时给过用户的承诺只有「这一轮结束后发」，不是「无论如何都发」。
 */

import { create } from "zustand";
import type { UserInputMetadata } from "@/lib/types";
import { deletePersistedImagePaths } from "@/lib/imageAttach";
import { agentDeleteMessageImage } from "@/lib/tauri";
import { getErrorMessage } from "@/lib/errors";
import { isTaskBusy } from "@/lib/agentStatus";
import {
  draftKeyFor,
  useAgentDraftStore,
  type DetachedDraft,
} from "./agentDraftStore";
import { conversationIsBusy, useConversationStore } from "./conversationStore";
import { useTaskStore } from "./taskStore";

/** 每个会话最多排几条（图片都在内存里，别让队列无限长大）。 */
export const MAX_QUEUED_MESSAGES = 10;

export type QueuePauseReason =
  | { kind: "stopped" }
  | { kind: "failed" }
  | { kind: "disconnected" }
  | { kind: "startFailed"; detail: string };

export interface QueuedMessage {
  id: string;
  conversationId: string;
  /** 入队时输入区所在的 SSH 会话；出队时若已不在线，会改按对话当前绑定的会话找。 */
  sessionId: string;
  /** 入队时的已保存连接配置 id。 */
  connectionId?: string;
  draft: DetachedDraft;
  createdAt: number;
}

/** 暂停横幅的文案（桌面与移动端共用）。 */
export function queuePauseText(reason: QueuePauseReason): string {
  switch (reason.kind) {
    case "stopped":
      return "排队的消息已暂停";
    case "failed":
      return "任务异常结束，排队的消息已暂停";
    case "disconnected":
      return "连接已断开，排队的消息已暂停";
    case "startFailed":
      return `发送失败：${reason.detail}，排队的消息已暂停`;
  }
}

interface QueueState {
  items: Record<string, QueuedMessage[]>;
  paused: Record<string, QueuePauseReason>;
  /** 入队；已满返回 false（调用方须把草稿放回去）。 */
  enqueue: (message: Omit<QueuedMessage, "id" | "createdAt">) => boolean;
  /** 删掉一条并回收它的落盘图片。 */
  remove: (conversationId: string, id: string) => void;
  /** 清空整个会话的队列（并回收落盘图片、解除暂停）。 */
  clear: (conversationId: string) => void;
  /** 取回一条放进输入区（编辑）。成功返回 true。 */
  pullBack: (conversationId: string, id: string) => boolean;
  /** 解除暂停；会话此刻空闲就立刻发队首。 */
  resume: (conversationId: string) => void;
}

/** 空队列必须引用稳定，否则 Zustand 快照会不断变化。 */
export const EMPTY_QUEUE: QueuedMessage[] = Object.freeze([]) as unknown as QueuedMessage[];

function reclaimImages(messages: QueuedMessage[]): void {
  const paths = messages.flatMap((m) =>
    m.draft.images.flatMap((image) => (image.persistedPath ? [image.persistedPath] : [])),
  );
  if (paths.length > 0) void deletePersistedImagePaths(paths, agentDeleteMessageImage);
}

function setItems(
  conversationId: string,
  update: (list: QueuedMessage[]) => QueuedMessage[],
): void {
  useAgentQueueStore.setState((state) => {
    const next = update(state.items[conversationId] ?? EMPTY_QUEUE);
    const items = { ...state.items };
    if (next.length === 0) delete items[conversationId];
    else items[conversationId] = next;
    // 队列空了，暂停标记也没有意义了。
    if (next.length === 0 && state.paused[conversationId]) {
      const paused = { ...state.paused };
      delete paused[conversationId];
      return { items, paused };
    }
    return { items };
  });
}

function pauseQueue(conversationId: string, reason: QueuePauseReason): void {
  useAgentQueueStore.setState((state) => ({
    paused: { ...state.paused, [conversationId]: reason },
  }));
}

export const useAgentQueueStore = create<QueueState>((set, get) => ({
  items: {},
  paused: {},
  enqueue: (message) => {
    const list = get().items[message.conversationId] ?? EMPTY_QUEUE;
    if (list.length >= MAX_QUEUED_MESSAGES) return false;
    const entry: QueuedMessage = {
      ...message,
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    setItems(message.conversationId, (current) => [...current, entry]);
    return true;
  },
  remove: (conversationId, id) => {
    const target = get().items[conversationId]?.find((m) => m.id === id);
    if (!target) return;
    setItems(conversationId, (list) => list.filter((m) => m.id !== id));
    reclaimImages([target]);
  },
  clear: (conversationId) => {
    const list = get().items[conversationId];
    if (!list) return;
    setItems(conversationId, () => []);
    reclaimImages(list);
  },
  pullBack: (conversationId, id) => {
    const target = get().items[conversationId]?.find((m) => m.id === id);
    if (!target) return false;
    // 落盘图的所有权随之回到草稿（草稿资源会在发送成功后回收），这里只摘条目、不删文件。
    setItems(conversationId, (list) => list.filter((m) => m.id !== id));
    useAgentDraftStore
      .getState()
      .restoreDetached(draftKeyFor(conversationId, null), target.draft);
    return true;
  },
  resume: (conversationId) => {
    if (!get().paused[conversationId]) return;
    set((state) => {
      const paused = { ...state.paused };
      delete paused[conversationId];
      return { paused };
    });
    void drainQueue(conversationId);
  },
}));

// ── 出队 ────────────────────────────────────────────────────────────────

/** 正在出队的会话（防同一会话并发开出两轮）。 */
const draining = new Set<string>();

/**
 * 找出队用的 SSH 会话：入队时那条还在线就用它；否则按对话当前的绑定找
 * （重连后会话 id 会变）。**惰性 import**：sessionStore 静态引入终端单例（xterm 在
 * import 阶段取 `self`），静态引会把它拖进所有 import 本模块的 node 环境测试。
 */
async function resolveTarget(
  message: QueuedMessage,
): Promise<{ sessionId: string; connectionId?: string } | null> {
  const { useSessionStore } = await import("./sessionStore");
  const sessions = useSessionStore.getState().sessions;
  const own = sessions[message.sessionId];
  if (own?.status === "connected") {
    return { sessionId: own.id, connectionId: own.configId ?? message.connectionId };
  }
  const { sessionConversationBindingManager } = await import(
    "./sessionConversationBindingManager"
  );
  const bound = sessionConversationBindingManager.findOccupyingSession(
    message.conversationId,
  );
  if (!bound || bound.session.status !== "connected") return null;
  return {
    sessionId: bound.sessionId,
    connectionId: bound.session.configId ?? message.connectionId,
  };
}

function userInputOf(draft: DetachedDraft): UserInputMetadata | undefined {
  return draft.textAttachments.length > 0 || draft.skills.length > 0
    ? draft.userInput
    : undefined;
}

/**
 * 尝试发出某会话队首的一条。不满足条件（暂停 / 会话忙 / 队列空）就什么都不做——
 * 下一次回合结束或用户点「继续」会再来。幂等，随便调。
 */
export async function drainQueue(conversationId: string): Promise<void> {
  if (draining.has(conversationId)) return;
  const initial = useAgentQueueStore.getState();
  if (initial.paused[conversationId] || !initial.items[conversationId]?.length) return;
  if (conversationIsBusy(conversationId)) return;

  draining.add(conversationId);
  try {
    const head = initial.items[conversationId][0];
    const target = await resolveTarget(head);
    // await 期间用户可能删了/编辑了这条、暂停了队列、或另一条路径已开了新一轮。
    const now = useAgentQueueStore.getState();
    if (
      now.items[conversationId]?.[0]?.id !== head.id ||
      now.paused[conversationId] ||
      conversationIsBusy(conversationId)
    ) {
      return;
    }
    if (!target) {
      pauseQueue(conversationId, { kind: "disconnected" });
      return;
    }
    // 先摘后发；落盘图归 startTask 的 replaceImagePaths 回收，不能走 remove（会提前删文件）。
    setItems(conversationId, (list) => list.slice(1));
    const { draft } = head;
    try {
      await useTaskStore.getState().startTask(
        target.sessionId,
        draft.text,
        target.connectionId,
        draft.images.map((image) => image.dataUrl),
        draft.images.flatMap((image) => (image.persistedPath ? [image.persistedPath] : [])),
        { conversationId, userInput: userInputOf(draft) },
      );
    } catch (error) {
      const committed =
        !!error && typeof error === "object" && (error as { stage?: string }).stage === "start_task";
      if (!committed) {
        // 没写进对话：放回队首，别让用户写的话凭空消失。
        useAgentQueueStore.setState((state) => ({
          items: { ...state.items, [conversationId]: [head, ...(state.items[conversationId] ?? [])] },
        }));
      } else {
        reclaimImages([head]);
      }
      pauseQueue(conversationId, { kind: "startFailed", detail: getErrorMessage(error) });
    }
  } finally {
    draining.delete(conversationId);
  }
}

// ── 全局订阅 ────────────────────────────────────────────────────────────

/**
 * 挂上队列的全局监听（桌面与移动端各在 App 启动时调一次）。返回退订函数。
 *
 * 任务表的同一条订阅同时看停止请求和「忙 → 非忙」跳变：停止请求先暂停队列，
 * 终态再收尾，避免等待后端确认期间自然完成而自动发出下一条。不能只靠流事件，
 * 因为本地收尾与断连可能已拆掉事件通道。
 */
export function initAgentQueue(): () => void {
  const unsubTasks = useTaskStore.subscribe((state, prev) => {
    if (state.tasks === prev.tasks) return;
    const queues = useAgentQueueStore.getState().items;
    for (const [id, task] of Object.entries(state.tasks)) {
      const before = prev.tasks[id];
      // 子 agent 在自己的子对话里跑；sessionId 为空是重启恢复的占位任务。
      if (task.parentTaskId || !task.sessionId) continue;
      if (!queues[task.conversationId]?.length) continue;
      if (task.stopRequested && !before?.stopRequested) {
        pauseQueue(task.conversationId, { kind: "stopped" });
        continue;
      }
      if (!before || !isTaskBusy(before.status) || isTaskBusy(task.status)) continue;
      if (task.status === "completed" && !task.stopRequested) {
        // 推迟到本次事件的同步收尾（清标记、拆通道、落回合状态）全部做完再开下一轮。
        const conversationId = task.conversationId;
        setTimeout(() => void drainQueue(conversationId), 0);
      } else {
        pauseQueue(task.conversationId, {
          kind: task.status === "failed" ? "failed" : "stopped",
        });
      }
    }
  });

  // 会话被删除：队列和它占的图片一并回收。只认「上一刻在、这一刻不在」的真删除跳变，
  // 列表整体重载时的瞬时缺席不算。
  const unsubConversations = useConversationStore.subscribe((state, prev) => {
    if (state.conversations === prev.conversations) return;
    for (const conversationId of Object.keys(useAgentQueueStore.getState().items)) {
      if (prev.conversations[conversationId] && !state.conversations[conversationId]) {
        useAgentQueueStore.getState().clear(conversationId);
      }
    }
  });

  return () => {
    unsubTasks();
    unsubConversations();
  };
}
