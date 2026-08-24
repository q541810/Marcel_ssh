import { create } from 'zustand';
import type {
  AgentMessage,
  AgentConversation,
  StoredMessage,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import type { AgentCompactResult } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import {
  storedMessageToAgentMessage,
  clearIntermediateReasoning,
  compactionCheckpoint,
} from './messageConversion';
import { useTaskStore } from './taskStore';
import { attachStreamListener, cleanupTaskListeners } from './agentStreamManager';
import { getStreamState, setStreamState } from './agentStreamHandlers';

export interface ConversationState {
  conversations: Record<string, AgentConversation>;
  messages: Record<string, AgentMessage[]>;
  activeConversationId: string | null;
  /** 每个 connection 上次选中的对话，切 SSH 会话时恢复 */
  activeConversationByConnection: Record<string, string>;

  addMessage: (message: AgentMessage) => void;
  clearMessages: () => void;
  newConversation: (sessionId: string, connectionId: string) => Promise<string>;
  switchConversation: (conversationId: string) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  rollbackToMessage: (
    conversationId: string,
    messageId: string,
  ) => Promise<{ prompt: string; removedCount: number; imagePaths: string[] }>;
  clearConnectionConversations: (connectionId: string) => void;
  loadConnectionConversations: (connectionId: string) => Promise<void>;
  /** 将 UI 上的 active 对话切换到指定 connection（SSH tab 切换时调用） */
  syncActiveToConnection: (connectionId: string) => Promise<void>;
  getCurrentMessages: () => AgentMessage[];

  ensureConversation: (sessionId: string, connectionId: string, fallbackTitle: string) => Promise<string>;
  appendMessages: (conversationId: string, messages: AgentMessage[]) => void;
  updateConversationMessages: (conversationId: string, updater: (messages: AgentMessage[]) => AgentMessage[]) => void;
  /**
   * 手动压缩上下文（命令面板「压缩上下文」）：调用后端触发一次原有压缩
   * 管线，返回统计结果。压缩只在后端内存副本上发生、**不写 DB**（原始
   * 历史保留）。前端在消息列表插入"压缩中"占位，完成后原位更新为
   * 压缩完成卡片（复用 CompactionCard）/ 未完成文案 / 失败文案。
   */
  compactConversation: (conversationId: string) => Promise<AgentCompactResult>;
  /**
   * 注册 task 工具派发的子agent对话：插入 conversation 条目 + 骨架消息
   * （user=prompt、assistant=loading 占位）。子agent流式 listener 挂上后
   * 会实时更新该对话；不改变当前 active 对话。
   * 返回骨架 loading 消息 id（供 attachStreamListener 使用）；已注册过时返回 null。
   */
  registerSubConversation: (
    conversationId: string,
    connectionId: string,
    title: string,
    subTaskId: string,
    prompt: string,
    parentConversationId: string,
  ) => string | null;
  clearAllAssistantFlags: (conversationId?: string) => void;
  clearExecutingToolFlags: () => void;
  markAbortedToolFlags: (conversationId?: string) => void;
  buildLlmHistory: (conversationId: string) => Array<{
    role: string;
    content: string;
    reasoningContent?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolCallId?: string;
    imagePaths?: string[];
    dbId?: string;
  }>;
}

function rememberActiveForConnection(
  byConnection: Record<string, string>,
  connectionId: string,
  conversationId: string,
): Record<string, string> {
  if (byConnection[connectionId] === conversationId) return byConnection;
  return { ...byConnection, [connectionId]: conversationId };
}

function pickPreferredConversationId(
  conversations: Record<string, AgentConversation>,
  connectionId: string,
  rememberedId: string | undefined,
): string | null {
  // 排除子agent对话：切 SSH tab 时不自动恢复进子对话
  if (
    rememberedId &&
    conversations[rememberedId]?.connectionId === connectionId &&
    !conversations[rememberedId]?.parentConversationId
  ) {
    return rememberedId;
  }
  const sorted = Object.values(conversations)
    .filter((c) => c.connectionId === connectionId && !c.parentConversationId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sorted[0]?.id ?? null;
}

type LlmHistoryItem = {
  role: string;
  content: string;
  reasoningContent?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  toolCallId?: string;
  imagePaths?: string[];
  /** 持久化消息的 DB row id（统一 id 域）：后端据此给 loop 消息带 db_id，
   *  压缩的 tail_db_id 指针依赖它（load 的消息必有；运行中消息由后端 save 回填）。 */
  dbId?: string;
};

/**
 * LLM 协议要求：assistant 消息的 tool_calls 必须全部被紧随的 tool 消息回复。
 * 应用重启/崩溃（tool 执行中进程退出）会在历史里留下未闭合的 tool_calls ——
 * assistant(tool_calls) 后没有对应 tool 回复，直接发送会 400
 * ("must be followed by tool messages responding to each tool_call_id")。
 * 发送前做一次闭合校验：
 * - 全部已回复（正常历史 / 用户停止任务后后端补的 aborted tool 消息）：原样保留
 * - 部分已回复：toolCalls 过滤为已回复子集（按 id 匹配，保持原顺序）
 * - 全部未回复且 content 非空：移除 toolCalls，降级为纯 assistant 文本
 * - 全部未回复且 content 为空：整条移除（避免空消息）
 */
function closeToolCallGroups(output: LlmHistoryItem[]): LlmHistoryItem[] {
  const result: LlmHistoryItem[] = [];
  let openIdx: number | null = null;
  let replied = new Set<string>();

  const settle = () => {
    if (openIdx == null) return;
    // 先保存局部 idx 与 replied 快照：openIdx/replied 重置后再用会导致
    // result[null] 附加 'null' 属性（JSON 不可见但 toEqual 失败）以及
    // kept 恒为空（闭合组被误判未闭合而误裁剪）。
    const idx = openIdx;
    const item = result[idx];
    const calls = item.toolCalls;
    const repliedSnapshot = replied;
    openIdx = null;
    replied = new Set();
    if (!calls || calls.length === 0) return;
    const kept = calls.filter((c) => repliedSnapshot.has(c.id));
    if (kept.length === calls.length) return;
    if (kept.length > 0) {
      result[idx] = { ...item, toolCalls: kept };
    } else if (item.content.trim() === '' && !item.reasoningContent) {
      result.splice(idx, 1);
    } else {
      const { toolCalls: _drop, ...rest } = item;
      result[idx] = rest;
    }
  };

  for (const item of output) {
    if (item.role === 'assistant' && item.toolCalls && item.toolCalls.length > 0) {
      // 新组开始：结算上一组（若未闭合则裁剪）
      settle();
      openIdx = result.length;
      replied = new Set();
      result.push(item);
      continue;
    }
    if (item.role === 'tool' && openIdx != null && item.toolCallId) {
      replied.add(item.toolCallId);
    }
    if (item.role === 'user') {
      settle();
    }
    result.push(item);
  }
  settle();
  return result;
}

/**
 * 协议合法性最后防线：确保每条 tool 消息都有前置的 assistant(tool_calls)，
 * 且每个 assistant 的 tool_calls 都被回复。
 * 裁剪（closeToolCallGroups）可能导致 tool 消息失去前置 assistant——
 * 孤立 tool 属于异常数据（正常历史中 tool 必跟在 assistant(tool_calls) 后），
 * 直接移除，不合成新消息（合成的空 content assistant 在 DeepSeek thinking
 * 模式下会触发 "reasoning_content must be passed back" 400）。
 */
function enforceToolProtocol(output: LlmHistoryItem[]): LlmHistoryItem[] {
  const result: LlmHistoryItem[] = [];
  let hasOpenCalls = false;
  for (const item of output) {
    if (item.role === 'assistant' && item.toolCalls && item.toolCalls.length > 0) {
      hasOpenCalls = true;
      result.push(item);
      continue;
    }
    if (item.role === 'tool' && item.toolCallId) {
      if (!hasOpenCalls) {
        // 孤立 tool 消息（无前置 assistant(tool_calls)）：异常数据，直接丢弃
        continue;
      }
      result.push(item);
      continue;
    }
    if (item.role === 'assistant') {
      // 纯 assistant 文本：结束当前 tool 组（tool 消息必须紧跟 assistant(tool_calls)）
      hasOpenCalls = false;
    }
    result.push(item);
  }
  return result;
}

/** 快速切换 SSH tab 时丢弃过期的 sync 结果 */
let syncActiveGeneration = 0;

/**
 * 该对话下是否存在正在运行的任务（主 agent 或子 agent）。
 * sessionId 非空排除重启恢复的占位 task。
 */
export function conversationHasRunningTask(conversationId: string): boolean {
  return Object.values(useTaskStore.getState().tasks).some(
    (t) =>
      t.conversationId === conversationId &&
      !!t.sessionId &&
      (t.status === 'planning' || t.status === 'executing' || t.status === 'waiting_approval'),
  );
}

/**
 * 切换对话后恢复"当前活动任务"：
 * 该对话有 running task（主 agent / 子 agent）→ 设为 activeTaskId（停止按钮、
 * isRunning 随之恢复）；否则清空。
 */
function restoreRunningTaskForConversation(conversationId: string) {
  const taskStore = useTaskStore.getState();
  taskStore.clearActiveTask();
  const running = Object.values(taskStore.tasks).find(
    (t) =>
      t.conversationId === conversationId &&
      !!t.sessionId &&
      (t.status === 'planning' || t.status === 'executing' || t.status === 'waiting_approval'),
  );
  if (running) {
    useTaskStore.setState({ activeTaskId: running.id });
  }
}

function reorderByUpdatedAt(convs: Record<string, AgentConversation>): Record<string, AgentConversation> {
  const sorted = Object.values(convs).sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
  const reordered: Record<string, AgentConversation> = {};
  for (const c of sorted) reordered[c.id] = c;
  return reordered;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: {},
  messages: {},
  activeConversationId: null,
  activeConversationByConnection: {},

  addMessage: (message: AgentMessage) => {
    const convId = get().activeConversationId;
    if (!convId) return;
    set((state) => ({
      messages: {
        ...state.messages,
        [convId]: [...(state.messages[convId] || []), message],
      },
    }));
  },

  clearMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return;
    set((state) => ({
      messages: { ...state.messages, [convId]: [] },
    }));
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
      activeConversationByConnection: rememberActiveForConnection(
        state.activeConversationByConnection,
        connectionId,
        id,
      ),
    }));
    await get().loadConnectionConversations(connectionId);
    useTaskStore.getState().clearConversationUnreadCompleted(id);
    return id;
  },

  switchConversation: async (conversationId: string) => {
    // map 缺失时（如重启后从 task 卡片跳转子对话）补拉元数据，
    // 保证输入区能识别子对话并渲染"返回主对话"条。
    const known = get().conversations[conversationId];
    // 运行中的对话（主 agent / 子 agent 在跑）：跳过 DB 重载，保留内存消息
    // （运行中的 tool 卡片等流式状态尚未落库，重载会导致卡片消失）。
    const running = conversationHasRunningTask(conversationId);
    const [stored, storedPlans, meta] = await Promise.all([
      running ? Promise.resolve(null) : tauri.agentLoadConversation(conversationId),
      running ? Promise.resolve(null) : tauri.agentLoadPlansByConversation(conversationId),
      known ? Promise.resolve(null) : tauri.agentGetConversation(conversationId).catch(() => null),
    ]);
    const msgs: AgentMessage[] = running
      ? (get().messages[conversationId] ?? [])
      : clearIntermediateReasoning((stored ?? []).map(storedMessageToAgentMessage));
    set((state) => {
      const connectionId = state.conversations[conversationId]?.connectionId;
      return {
        conversations: meta ? { ...state.conversations, [meta.id]: meta } : state.conversations,
        messages: { ...state.messages, [conversationId]: msgs },
        activeConversationId: conversationId,
        activeConversationByConnection: connectionId
          ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, conversationId)
          : state.activeConversationByConnection,
      };
    });
    if (!running) {
      useTaskStore.getState().loadPersistedPlans(conversationId, storedPlans ?? []);
    }
    // 恢复该对话的运行中任务（主 agent / 子 agent），保证停止按钮与 isRunning 状态正确
    restoreRunningTaskForConversation(conversationId);
    // 切入对话后，自动清除该对话的未读完成小绿点标记
    useTaskStore.getState().clearConversationUnreadCompleted(conversationId);
  },

  loadConversation: async (conversationId: string) => {
    const known = get().conversations[conversationId];
    const running = conversationHasRunningTask(conversationId);
    const [stored, storedPlans, meta] = await Promise.all([
      running ? Promise.resolve(null) : tauri.agentLoadConversation(conversationId),
      running ? Promise.resolve(null) : tauri.agentLoadPlansByConversation(conversationId),
      known ? Promise.resolve(null) : tauri.agentGetConversation(conversationId).catch(() => null),
    ]);
    const msgs: AgentMessage[] = running
      ? (get().messages[conversationId] ?? [])
      : clearIntermediateReasoning((stored ?? []).map(storedMessageToAgentMessage));
    set((state) => {
      const connectionId = state.conversations[conversationId]?.connectionId;
      return {
        conversations: meta ? { ...state.conversations, [meta.id]: meta } : state.conversations,
        messages: { ...state.messages, [conversationId]: msgs },
        activeConversationId: conversationId,
        activeConversationByConnection: connectionId
          ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, conversationId)
          : state.activeConversationByConnection,
      };
    });
    if (!running) {
      useTaskStore.getState().loadPersistedPlans(conversationId, storedPlans ?? []);
    }
    restoreRunningTaskForConversation(conversationId);
    useTaskStore.getState().clearConversationUnreadCompleted(conversationId);
  },

  renameConversation: async (conversationId: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    await tauri.agentRenameConversation(conversationId, trimmed);
    const now = new Date().toISOString();
    set((state) => {
      const conv = state.conversations[conversationId];
      if (!conv) return state;
      const updated = { ...conv, title: trimmed, updatedAt: now };
      return {
        conversations: reorderByUpdatedAt({
          ...state.conversations,
          [conversationId]: updated,
        }),
      };
    });
  },

  deleteConversation: async (conversationId: string) => {
    await tauri.agentDeleteConversation(conversationId);
    // 级联：主对话 + 其全部子agent对话（后端已级联删 DB）。
    // 在 set 之前从当前 map 快照收集（set 后子对话条目已不存在）。
    const ids = [
      conversationId,
      ...Object.values(get().conversations)
        .filter((c) => c.parentConversationId === conversationId)
        .map((c) => c.id),
    ];
    set((state) => {
      const conversations = { ...state.conversations };
      const messages = { ...state.messages };
      const byConnection = { ...state.activeConversationByConnection };
      for (const id of ids) {
        const removed = conversations[id];
        delete conversations[id];
        delete messages[id];
        if (removed && byConnection[removed.connectionId] === id) {
          delete byConnection[removed.connectionId];
        }
      }
      let nextActive = state.activeConversationId;
      if (state.activeConversationId != null && ids.includes(state.activeConversationId)) {
        const removed = state.conversations[conversationId];
        nextActive = removed
          ? pickPreferredConversationId(conversations, removed.connectionId, byConnection[removed.connectionId])
          : Object.keys(conversations)[0] || null;
        if (nextActive && removed) {
          byConnection[removed.connectionId] = nextActive;
        }
      }
      return {
        conversations,
        messages,
        activeConversationId: nextActive,
        activeConversationByConnection: byConnection,
      };
    });
    // 级联清理 taskStore 中这些 conversation 的 plans 和 tasks
    for (const id of ids) {
      useTaskStore.getState().clearPlansByConversation(id);
    }
  },

  rollbackToMessage: async (conversationId: string, messageId: string) => {
    const msgs = get().messages[conversationId] || [];
    const index = msgs.findIndex((m) => m.id === messageId);
    if (index < 0) {
      throw new Error('消息不存在');
    }

    const target = msgs[index];
    if (target.role !== 'user') {
      throw new Error('只能撤回用户消息');
    }

    const removedCount = msgs.length - index;
    const truncateResult = await tauri.agentTruncateConversation(
      conversationId,
      target.timestamp,
    );

    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: (state.messages[conversationId] || []).slice(0, index),
      },
    }));

    // 仅当后端按快照调整过 plan 时同步 UI；旧数据无快照则不动 plan
    if (truncateResult.planAdjusted) {
      useTaskStore.getState().applyPlanAfterTruncate(
        conversationId,
        truncateResult.plan ?? null,
        truncateResult.planTaskId ?? null,
      );
    }

    return {
      prompt: target.content,
      removedCount: truncateResult.deletedMessages || removedCount,
      imagePaths: target.imagePaths ?? [],
    };
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
      const byConnection = { ...state.activeConversationByConnection };
      delete byConnection[connectionId];
      return {
        conversations,
        messages,
        activeConversationId:
          state.activeConversationId && toRemove.includes(state.activeConversationId)
            ? Object.keys(conversations)[0] || null
            : state.activeConversationId,
        activeConversationByConnection: byConnection,
      };
    });
  },

  loadConnectionConversations: async (connectionId: string) => {
    const convs = await tauri.agentListConversationsByConnection(connectionId);
    let activeConversationId: string | null = null;

    set((state) => {
      const incomingConvIds = new Set(convs.map((c) => c.id));

      const toRemove = Object.values(state.conversations)
        .filter(
          (c) =>
            c.connectionId === connectionId &&
            !incomingConvIds.has(c.id) &&
            // 子agent对话被后端列表接口过滤（不在 incoming 中），不是多余项
            !c.parentConversationId,
        )
        .map((c) => c.id);

      const newConversations: Record<string, AgentConversation> = { ...state.conversations };
      const newMessages: Record<string, AgentMessage[]> = { ...state.messages };
      const byConnection = { ...state.activeConversationByConnection };

      for (const id of toRemove) {
        delete newConversations[id];
        delete newMessages[id];
        if (byConnection[connectionId] === id) {
          delete byConnection[connectionId];
        }
      }

      for (const conv of convs) {
        newConversations[conv.id] = conv;
        newMessages[conv.id] = state.messages[conv.id] ?? [];
      }

      // 仅当「当前 active 属于本 connection」时保留；跨 connection 的 active 不抢（由 syncActiveToConnection 切换）
      const currentActive = state.activeConversationId;
      const activeBelongsHere =
        !!currentActive && newConversations[currentActive]?.connectionId === connectionId;
      const preferred = pickPreferredConversationId(
        newConversations,
        connectionId,
        byConnection[connectionId],
      );
      const firstConvId = convs.length > 0 ? convs[0].id : null;

      if (!currentActive || activeBelongsHere) {
        activeConversationId = activeBelongsHere
          ? currentActive!
          : preferred || firstConvId || null;
        if (activeConversationId) {
          byConnection[connectionId] = activeConversationId;
        }
      } else {
        // 当前 UI 在别的 connection 上：只合并本 connection 的列表
        activeConversationId = currentActive;
        if (preferred) {
          byConnection[connectionId] = preferred;
        } else if (firstConvId) {
          byConnection[connectionId] = firstConvId;
        }
      }

      return {
        conversations: reorderByUpdatedAt(newConversations),
        messages: newMessages,
        activeConversationId,
        activeConversationByConnection: byConnection,
      };
    });

    if (activeConversationId && !get().messages[activeConversationId]?.length) {
      const activeConv = get().conversations[activeConversationId];
      if (activeConv?.connectionId === connectionId) {
        await get().loadConversation(activeConversationId);
      }
    }
  },

  syncActiveToConnection: async (connectionId: string) => {
    const myGeneration = ++syncActiveGeneration;
    const stillTarget = () => syncActiveGeneration === myGeneration;

    const restoreActiveTaskForConversation = (conversationId: string) => {
      if (!stillTarget()) return;
      restoreRunningTaskForConversation(conversationId);
    };

    const applyActive = (conversationId: string, msgs?: AgentMessage[]) => {
      if (!stillTarget()) return false;
      set((s) => ({
        ...(msgs
          ? { messages: { ...s.messages, [conversationId]: msgs } }
          : {}),
        activeConversationId: conversationId,
        activeConversationByConnection: rememberActiveForConnection(
          s.activeConversationByConnection,
          connectionId,
          conversationId,
        ),
      }));
      return stillTarget();
    };

    const state = get();
    const current = state.activeConversationId
      ? state.conversations[state.activeConversationId]
      : null;
    if (current?.connectionId === connectionId) {
      if (state.activeConversationId && stillTarget()) {
        set({
          activeConversationByConnection: rememberActiveForConnection(
            state.activeConversationByConnection,
            connectionId,
            state.activeConversationId,
          ),
        });
      }
      return;
    }

    await get().loadConnectionConversations(connectionId);
    if (!stillTarget()) return;

    const afterLoad = get();
    const preferred = pickPreferredConversationId(
      afterLoad.conversations,
      connectionId,
      afterLoad.activeConversationByConnection[connectionId],
    );

    if (!preferred) {
      // 该 connection 无对话：清空 active，避免仍显示其它主机的聊天
      if (afterLoad.activeConversationId && stillTarget()) {
        const stillOther =
          afterLoad.conversations[afterLoad.activeConversationId]?.connectionId !== connectionId;
        if (stillOther) {
          set({ activeConversationId: null });
          useTaskStore.getState().clearActiveTask();
        }
      }
      return;
    }

    const cached = afterLoad.messages[preferred];
    if (cached?.length) {
      if (!applyActive(preferred)) return;
      restoreActiveTaskForConversation(preferred);
      return;
    }

    // 不走 loadConversation：它会无条件改 active，竞态下会盖掉更新的 tab
    const [stored, storedPlans] = await Promise.all([
      tauri.agentLoadConversation(preferred),
      tauri.agentLoadPlansByConversation(preferred),
    ]);
    if (!stillTarget()) return;
    const msgs: AgentMessage[] = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
    if (!applyActive(preferred, msgs)) return;
    useTaskStore.getState().loadPersistedPlans(preferred, storedPlans);
    restoreActiveTaskForConversation(preferred);
  },

  getCurrentMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return [];
    return get().messages[convId] || [];
  },

  ensureConversation: async (sessionId: string, connectionId: string, fallbackTitle: string) => {
    const { activeConversationId, conversations } = get();
    const activeConv = activeConversationId ? conversations[activeConversationId] : null;
    const activeMatches =
      !!activeConversationId &&
      !!activeConv &&
      (!connectionId || activeConv.connectionId === connectionId);

    let conversationId: string;

    if (!activeMatches) {
      // 优先复用本 connection 已有对话（记忆 / 最近），避免跨主机写错历史
      const preferred = connectionId
        ? pickPreferredConversationId(
            conversations,
            connectionId,
            get().activeConversationByConnection[connectionId],
          )
        : null;

      if (preferred) {
        conversationId = preferred;
        set((state) => ({
          activeConversationId: preferred,
          activeConversationByConnection: connectionId
            ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, preferred)
            : state.activeConversationByConnection,
        }));
        // 复用已有对话时若本地无消息，先从 DB 拉齐，避免 LLM 历史为空
        if (!get().messages[preferred]?.length) {
          const stored = await tauri.agentLoadConversation(preferred);
          if (get().activeConversationId === preferred) {
            const msgs = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
            set((state) => ({
              messages: { ...state.messages, [preferred]: msgs },
            }));
          }
        }
      } else {
        const newTitle = fallbackTitle.slice(0, 30);
        const newId = await tauri.agentCreateConversation(sessionId, newTitle);
        conversationId = newId;
        set((state) => ({
          conversations: reorderByUpdatedAt({
            ...state.conversations,
            [newId]: {
              id: newId,
              connectionId,
              title: newTitle,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }),
          messages: { ...state.messages, [newId]: [] },
          activeConversationId: newId,
          activeConversationByConnection: connectionId
            ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, newId)
            : state.activeConversationByConnection,
        }));
      }
    } else {
      conversationId = activeConversationId!;
      const conv = get().conversations[conversationId];
      if (conv && conv.title === '新会话') {
        const newTitle = fallbackTitle.slice(0, 30);
        set((state) => ({
          conversations: {
            ...state.conversations,
            [conversationId]: { ...conv, title: newTitle },
          },
        }));
      }
    }

    return conversationId;
  },

  appendMessages: (conversationId: string, messages: AgentMessage[]) => {
    const now = new Date().toISOString();
    set((state) => {
      const conv = state.conversations[conversationId];
      const nextConvs = conv
        ? reorderByUpdatedAt({
            ...state.conversations,
            [conversationId]: { ...conv, updatedAt: now },
          })
        : state.conversations;
      return {
        conversations: nextConvs,
        messages: {
          ...state.messages,
          [conversationId]: [...(state.messages[conversationId] || []), ...messages],
        },
      };
    });
  },

  updateConversationMessages: (conversationId: string, updater: (messages: AgentMessage[]) => AgentMessage[]) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: updater(state.messages[conversationId] || []),
      },
    }));
  },

  compactConversation: async (conversationId: string) => {
    // busy 守卫（与后端一致）：运行中不允许手动压缩（'/' 菜单运行中也不唤出）。
    // 守卫在 listener 建立之前，事件路径不可达 → 直接给可见提示再拒绝。
    if (conversationHasRunningTask(conversationId)) {
      const err = new Error('会话正在运行任务，请等待任务结束或停止后再压缩');
      get().updateConversationMessages(conversationId, (msgs) => [
        ...msgs,
        {
          id: crypto.randomUUID(),
          role: 'system',
          content: getErrorMessage(err),
          timestamp: new Date().toISOString(),
        },
      ]);
      throw err;
    }
    const taskId = crypto.randomUUID();
    // 压缩对象 = buildLlmHistory 产物（与 agent_start_task 同源，tool 协议
    // 已闭合修正，避免中断遗留的未闭合 tool 调用组导致无法压缩）
    const history = get().buildLlmHistory(conversationId);
    try {
      // 完整复用现有 stream 监听：后端把压缩事件实时转发到
      // `agent://stream/{taskId}`，经 attachStreamListener 分发到
      // handleCompactionStart/Progress/Done/Skipped —— 进行中卡片、原位替换、
      // attempted 区分、进度实时文本全在其中。
      await attachStreamListener(taskId, conversationId, '');
      const result = await tauri.agentCompactConversation(conversationId, history, taskId);
      // live store 的原位插入由 Done 事件路径（handleCompactionDone）负责；
      // 结果路径不再操作 store——原文全保留，事件丢失时缺的只是卡片标记
      // （DB 已由后端落库，重载可见），无副作用风险。
      if (result.compacted) {
        // 压缩已由后端持久化；前端 live 视图靠事件更新。
      } else {
        // compacted:false 兜底：Skipped 事件可能已处理或已丢失，按残留状态收尾
        const state = getStreamState(taskId);
        const cardId = state.compactionMessageId;
        if (cardId) {
          // 残留 running 卡 = Skipped 事件丢失：结果路径兜底，
          // 语义与 handleCompactionSkipped 一致（attempted → 转文本；否则移除）。
          state.compactionMessageId = null;
          setStreamState(taskId, state);
          get().updateConversationMessages(conversationId, (msgs) => {
            const idx = msgs.findIndex((m) => m.id === cardId);
            if (idx === -1) return msgs;
            const newMsgs = [...msgs];
            if (result.attempted) {
              newMsgs[idx] = {
                ...newMsgs[idx],
                content: `上下文压缩未完成：${result.reason ?? '压缩未完成'}`,
                compaction: undefined,
              };
            } else {
              newMsgs.splice(idx, 1);
            }
            return newMsgs;
          });
        } else if (!result.attempted) {
          // 无可压区间 / 区间过小（attempted=false）：事件路径刻意不留痕，
          // 结果路径给手动场景可见提示（普通 system 通知，不落库）。
          get().updateConversationMessages(conversationId, (msgs) => [
            ...msgs,
            {
              id: crypto.randomUUID(),
              role: 'system',
              content: `无需压缩：${result.reason ?? '没有可压缩的早期历史区间'}`,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
        // attempted=true 且无残留卡 = 事件已正常处理（卡已转"未完成"文本）→ 不重复插入
      }
      return result;
    } catch (err) {
      // 命令失败（未配置 LLM / 任务运行中 等）：进行中卡片转错误文本（若有）；
      // 无卡时插入普通 system 失败提示，避免静默无反馈。
      const cardId = getStreamState(taskId).compactionMessageId;
      if (cardId) {
        get().updateConversationMessages(conversationId, (msgs) =>
          msgs.map((m) =>
            m.id === cardId ? { ...m, content: `上下文压缩失败：${getErrorMessage(err)}` } : m,
          ),
        );
      } else {
        get().updateConversationMessages(conversationId, (msgs) => [
          ...msgs,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `上下文压缩失败：${getErrorMessage(err)}`,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
      throw err;
    } finally {
      cleanupTaskListeners(taskId);
    }
  },

  registerSubConversation: (conversationId, connectionId, title, subTaskId, prompt, parentConversationId) => {
    const now = new Date().toISOString();
    const loadingId = `sub-loading-${subTaskId}`;
    let result: string | null = loadingId;
    set((state) => {
      // 幂等：已注册过（可能由 toolResult 兜底路径先注册）则不再覆盖骨架，
      // 避免把已有实时流式消息冲掉。
      if (state.conversations[conversationId]) {
        result = null;
        return state;
      }
      return {
        conversations: {
          ...state.conversations,
          [conversationId]: {
            id: conversationId,
            connectionId,
            title,
            createdAt: now,
            updatedAt: now,
            parentConversationId,
          },
        },
        messages: {
          ...state.messages,
          [conversationId]: [
            {
              id: `sub-user-${subTaskId}`,
              role: 'user',
              content: prompt,
              timestamp: now,
            },
            {
              id: loadingId,
              role: 'assistant',
              content: '',
              timestamp: now,
              isLoading: true,
            },
          ],
        },
      };
    });
    return result;
  },

  clearAllAssistantFlags: (conversationId?: string) => {
    set((state) => ({
      messages: Object.fromEntries(
        Object.entries(state.messages).map(([convId, msgs]) => [
          convId,
          !conversationId || convId === conversationId
            ? msgs.map((m) =>
                m.role === 'assistant' && (m.isThinking || m.isLoading)
                  ? { ...m, isThinking: false, isLoading: false }
                  : m,
              )
            : msgs,
        ]),
      ),
    }));
  },

  clearExecutingToolFlags: () => {
    set((state) => ({
      messages: Object.fromEntries(
        Object.entries(state.messages).map(([convId, msgs]) => [
          convId,
          msgs.map((m) =>
            m.role === 'tool' && (m.isExecuting || m.modelApproval) ? { ...m, isExecuting: false, modelApproval: undefined } : m,
          ),
        ]),
      ),
    }));
  },

  markAbortedToolFlags: (conversationId?: string) => {
    // 用户点停止时调用。把所有正在执行的 tool 卡片标记为「已中断」：
    // - isExecuting=false, modelApproval 清除
    // - wasAborted=true
    // - 流式工具（execute_command，前端通过 toolOutput 事件已累积部分 result）：
    //   追加「系统未停止进程，但已停止等待输出」提示
    // - 非流式工具（前端 result 为空）：用「工具可能已执行完成」提示
    // 与后端 agent_loop 检查点4 的中断文案保持一致，确保 UI 与 LLM 视角同步。
    // 注意：非流式工具后端有完整 output 但前端不可能收到（listener 已卸载），
    // 这里只反映用户视角的 UI 状态；LLM 历史由后端持久化保证完整。
    // conversationId 参数：子agent存在后，停止某个任务只标记该任务所属对话的
    // 卡片，避免误伤其他对话（主/子对话）并行执行中的工具卡片。
    set((state) => ({
      messages: Object.fromEntries(
        Object.entries(state.messages).map(([convId, msgs]) => [
          convId,
          !conversationId || convId === conversationId
            ? msgs.map((m) => {
                if (m.role !== 'tool' || !(m.isExecuting || m.modelApproval)) return m;
                const isStreaming = m.toolResult?.toolName === 'execute_command';
                const STREAMING_SUFFIX = '\n\n[用户手动触发中断，系统未停止进程，但已停止等待输出。这不代表进程已经停止，远端进程可能仍在运行。]';
                const NON_STREAMING_SUFFIX = '\n\n[用户手动中断，已停止等待结果；工具可能已执行完成]';
                const existing = m.toolResult?.result ?? '';
                // 已有流式输出时追加，否则整体替换为提示
                const result = isStreaming
                  ? (existing ? existing + STREAMING_SUFFIX : STREAMING_SUFFIX.trimStart())
                  : (existing ? existing + NON_STREAMING_SUFFIX : NON_STREAMING_SUFFIX.trimStart());
                return {
                  ...m,
                  isExecuting: false,
                  modelApproval: undefined,
                  toolResult: m.toolResult
                    ? { ...m.toolResult, wasAborted: true, success: false, result }
                    : m.toolResult,
                };
              })
            : msgs,
        ]),
      ),
    }));
  },

  buildLlmHistory: (conversationId: string) => {
    const msgs = get().messages[conversationId] || [];

    const output: ReturnType<ConversationState['buildLlmHistory']> = [];
    let pendingAssistantIndex: number | null = null;
    /** 为 true 时，后续连续 tool 消息追加到同一条 assistant 的 toolCalls */
    let openToolGroup = false;
    let prevOutputRole: string | null = null;

    // 请求侧屏蔽：最后一张 done 卡（被压区间末尾的边界标记）之前的所有内容
    // 不进 LLM 请求（原文仍全部可见，仅请求屏蔽）。卡片由 live splice /
    // 持久化 created_at 定位在 span 末尾 → "卡前"恰为被压区间（手动压到最末时
    // 卡在对话末尾 → 全部屏蔽 → 请求只剩 checkpoint）。旧卡已被吸收，恒单卡。
    let lastCardIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === 'system' && msgs[i].compaction?.status === 'done') {
        lastCardIdx = i;
        break;
      }
    }

    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.isLoading) continue;
      if (i < lastCardIdx) continue; // 屏蔽卡前内容（被压区间 + 通知）

      if (m.role === 'system') {
        // 压缩 done 卡 → user 角色 checkpoint（framing 与后端逐字节一致，
        // 二次压缩的 PRIOR checkpoint 识别依赖它），让模型把压缩历史当作
        // 既有背景；其余 system（通知/运行中卡）照旧跳过。
        const checkpoint = compactionCheckpoint(m);
        if (checkpoint) {
          output.push(checkpoint);
          pendingAssistantIndex = null;
          openToolGroup = false;
          prevOutputRole = 'user';
        }
        continue;
      }

      if (m.role === 'user') {
        const item: ReturnType<ConversationState['buildLlmHistory']>[number] = {
          role: 'user',
          content: m.content,
          ...(m.dbId ? { dbId: m.dbId } : {}),
        };
        if (m.imagePaths && m.imagePaths.length > 0) {
          item.imagePaths = m.imagePaths;
        }
        output.push(item);
        pendingAssistantIndex = null;
        openToolGroup = false;
        prevOutputRole = 'user';
        continue;
      }

      if (m.role === 'assistant') {
        const fullCalls =
          m.toolCalls && m.toolCalls.length > 0
            ? m.toolCalls
            : m.toolCall
              ? [m.toolCall]
              : null;

        if (fullCalls) {
          const item: ReturnType<ConversationState['buildLlmHistory']>[number] = {
            role: 'assistant',
            content: m.content,
            toolCalls: fullCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments || {},
            })),
            ...(m.dbId ? { dbId: m.dbId } : {}),
          };
          // DeepSeek thinking 模式：带 tool_calls 的 assistant 必须回传
          // reasoning_content（落库已保留，重载后这里原样带上）
          if (m.reasoningContent) {
            item.reasoningContent = m.reasoningContent;
          }
          output.push(item);
          // assistant 已带完整 tool_calls，后续 tool 只负责 result
          pendingAssistantIndex = null;
          openToolGroup = true;
        } else {
          const item: ReturnType<ConversationState['buildLlmHistory']>[number] = {
            role: 'assistant',
            content: m.content,
            ...(m.dbId ? { dbId: m.dbId } : {}),
          };
          if (m.reasoningContent) {
            item.reasoningContent = m.reasoningContent;
          }
          output.push(item);
          pendingAssistantIndex = output.length - 1;
          openToolGroup = false;
        }
        prevOutputRole = 'assistant';
        continue;
      }

      if (m.role === 'tool' && m.toolResult && m.toolResult.toolCallId) {
        const toolContent = m.toolResult.result || m.content;
        const callEntry = {
          id: m.toolResult.toolCallId,
          name: m.toolResult.toolName,
          arguments: m.toolResult.arguments || {},
        };

        if (pendingAssistantIndex != null) {
          // 纯文案 assistant 后的第一个 tool：把 toolCalls 挂上去。
          // reasoningContent 一并带上（DeepSeek thinking 模式回传要求）；
          // dbId 保留（压缩定位锚点）。
          const prev = output[pendingAssistantIndex];
          output[pendingAssistantIndex] = {
            role: 'assistant',
            content: prev.content,
            toolCalls: [callEntry],
            ...(prev.reasoningContent ? { reasoningContent: prev.reasoningContent } : {}),
            ...(prev.dbId ? { dbId: prev.dbId } : {}),
          };
          pendingAssistantIndex = null;
          openToolGroup = true;
        } else if (openToolGroup) {
          // 并行/连续 tool：追加到最近一条带 toolCalls 的 assistant
          for (let i = output.length - 1; i >= 0; i--) {
            const prev = output[i];
            if (prev.role === 'assistant' && prev.toolCalls) {
              const exists = prev.toolCalls.some((tc) => tc.id === callEntry.id);
              if (!exists) {
                prev.toolCalls = [...prev.toolCalls, callEntry];
              }
              break;
            }
            if (prev.role === 'user') break;
          }
        } else {
          // 孤立 tool（UI store 里没有前导 assistant）：合成一条单 call 的 assistant
          output.push({
            role: 'assistant',
            content: '',
            toolCalls: [callEntry],
          });
          openToolGroup = true;
        }

        output.push({
          role: 'tool',
          content: toolContent,
          toolCallId: m.toolResult.toolCallId,
          ...(m.dbId ? { dbId: m.dbId } : {}),
        });
        prevOutputRole = 'tool';
      } else {
        openToolGroup = false;
      }
    }

    // 协议闭合校验：裁剪重启/崩溃残留的未闭合 tool_calls，避免 LLM 400
    return enforceToolProtocol(closeToolCallGroups(output));
  },
}));
