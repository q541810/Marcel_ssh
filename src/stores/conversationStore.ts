import { create } from 'zustand';
import type {
  AgentMessage,
  AgentConversation,
  StoredMessage,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { storedMessageToAgentMessage, clearIntermediateReasoning } from './messageConversion';
import { useTaskStore } from './taskStore';
import { useSettingsStore } from './settingsStore';
import {
  COMPACT_MAX_CONTEXT_TOKENS,
  COMPACT_AGGRESSIVE_TOKENS,
  COMPACT_MIN_ROUNDS,
  COMPACT_MAX_LINES,
  COMPACT_HEAD_TAIL_LINES,
  COMPACT_TRUNCATION_MSG,
  CHARS_PER_TOKEN,
} from '@/lib/constants';

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
  clearAllAssistantFlags: () => void;
  clearExecutingToolFlags: () => void;
  markAbortedToolFlags: () => void;
  buildLlmHistory: (conversationId: string) => Array<{
    role: string;
    content: string;
    reasoningContent?: string;
    toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
    toolCallId?: string;
    imagePaths?: string[];
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
  if (rememberedId && conversations[rememberedId]?.connectionId === connectionId) {
    return rememberedId;
  }
  const sorted = Object.values(conversations)
    .filter((c) => c.connectionId === connectionId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  return sorted[0]?.id ?? null;
}

/** 快速切换 SSH tab 时丢弃过期的 sync 结果 */
let syncActiveGeneration = 0;

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
    return id;
  },

  switchConversation: async (conversationId: string) => {
    const [stored, storedPlans] = await Promise.all([
      tauri.agentLoadConversation(conversationId),
      tauri.agentLoadPlansByConversation(conversationId),
    ]);
    const msgs: AgentMessage[] = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
    set((state) => {
      const connectionId = state.conversations[conversationId]?.connectionId;
      return {
        messages: { ...state.messages, [conversationId]: msgs },
        activeConversationId: conversationId,
        activeConversationByConnection: connectionId
          ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, conversationId)
          : state.activeConversationByConnection,
      };
    });
    useTaskStore.getState().loadPersistedPlans(conversationId, storedPlans);
    useTaskStore.getState().clearActiveTask();
  },

  loadConversation: async (conversationId: string) => {
    const [stored, storedPlans] = await Promise.all([
      tauri.agentLoadConversation(conversationId),
      tauri.agentLoadPlansByConversation(conversationId),
    ]);
    const msgs: AgentMessage[] = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
    set((state) => {
      const connectionId = state.conversations[conversationId]?.connectionId;
      return {
        messages: { ...state.messages, [conversationId]: msgs },
        activeConversationId: conversationId,
        activeConversationByConnection: connectionId
          ? rememberActiveForConnection(state.activeConversationByConnection, connectionId, conversationId)
          : state.activeConversationByConnection,
      };
    });
    useTaskStore.getState().loadPersistedPlans(conversationId, storedPlans);
    useTaskStore.getState().clearActiveTask();
  },

  deleteConversation: async (conversationId: string) => {
    await tauri.agentDeleteConversation(conversationId);
    set((state) => {
      const removed = state.conversations[conversationId];
      const { [conversationId]: _, ...conversations } = state.conversations;
      const { [conversationId]: __, ...messages } = state.messages;
      const byConnection = { ...state.activeConversationByConnection };
      if (removed && byConnection[removed.connectionId] === conversationId) {
        delete byConnection[removed.connectionId];
      }
      let nextActive = state.activeConversationId;
      if (state.activeConversationId === conversationId) {
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
    // 级联清理 taskStore 中该 conversation 的 plans 和 tasks
    useTaskStore.getState().clearPlansByConversation(conversationId);
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
        .filter((c) => c.connectionId === connectionId && !incomingConvIds.has(c.id))
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
      useTaskStore.getState().clearActiveTask();
      const running = Object.values(useTaskStore.getState().tasks).find(
        (t) =>
          t.conversationId === conversationId &&
          !!t.sessionId &&
          (t.status === 'planning' ||
            t.status === 'executing' ||
            t.status === 'waiting_approval'),
      );
      if (running) {
        useTaskStore.setState({ activeTaskId: running.id });
      }
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
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: [...(state.messages[conversationId] || []), ...messages],
      },
    }));
  },

  updateConversationMessages: (conversationId: string, updater: (messages: AgentMessage[]) => AgentMessage[]) => {
    set((state) => ({
      messages: {
        ...state.messages,
        [conversationId]: updater(state.messages[conversationId] || []),
      },
    }));
  },

  clearAllAssistantFlags: () => {
    set((state) => ({
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

  markAbortedToolFlags: () => {
    // 用户点停止时调用。把所有正在执行的 tool 卡片标记为「已中断」：
    // - isExecuting=false, modelApproval 清除
    // - wasAborted=true
    // - 流式工具（execute_command，前端通过 toolOutput 事件已累积部分 result）：
    //   追加「远端命令可能已执行完成或仍在后台运行」提示
    // - 非流式工具（前端 result 为空）：用「工具可能已执行完成」提示
    // 与后端 agent_loop 检查点4 的中断文案保持一致，确保 UI 与 LLM 视角同步。
    // 注意：非流式工具后端有完整 output 但前端不可能收到（listener 已卸载），
    // 这里只反映用户视角的 UI 状态；LLM 历史由后端持久化保证完整。
    set((state) => ({
      messages: Object.fromEntries(
        Object.entries(state.messages).map(([convId, msgs]) => [
          convId,
          msgs.map((m) => {
            if (m.role !== 'tool' || !(m.isExecuting || m.modelApproval)) return m;
            const isStreaming = m.toolResult?.toolName === 'execute_command';
            const STREAMING_SUFFIX = '\n\n[用户手动中断，已停止等待结果；远端命令可能已执行完成或仍在后台运行]';
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
          }),
        ]),
      ),
    }));
  },

  buildLlmHistory: (conversationId: string) => {
    const msgs = get().messages[conversationId] || [];
    const settings = useSettingsStore.getState().settings;
    const { compactContext } = settings.agentModeSettings;

    const output: ReturnType<ConversationState['buildLlmHistory']> = [];
    let pendingAssistantIndex: number | null = null;
    /** 为 true 时，后续连续 tool 消息追加到同一条 assistant 的 toolCalls */
    let openToolGroup = false;
    let roundCount = 0;
    let cumulativeTokens = 0;
    let prevOutputRole: string | null = null;

    function estimateTokens(text: string): number {
      return Math.ceil(text.length / CHARS_PER_TOKEN);
    }

    function compressToolContent(rawContent: string, toolName: string): string {
      if (!compactContext) return rawContent;

      // skill 是用户自定义内容，压缩时绝不裁剪
      if (toolName.startsWith('skill_')) return rawContent;

      if (cumulativeTokens > COMPACT_AGGRESSIVE_TOKENS) {
        return COMPACT_TRUNCATION_MSG;
      }

      if (cumulativeTokens > COMPACT_MAX_CONTEXT_TOKENS && roundCount > COMPACT_MIN_ROUNDS) {
        const lines = rawContent.split('\n');
        if (lines.length > COMPACT_MAX_LINES) {
          const head = lines.slice(0, COMPACT_HEAD_TAIL_LINES).join('\n');
          const tail = lines.slice(-COMPACT_HEAD_TAIL_LINES).join('\n');
          return head + '\n' + COMPACT_TRUNCATION_MSG + '\n' + tail;
        }
      }

      return rawContent;
    }

    for (const m of msgs) {
      if (m.isLoading) continue;

      if (m.role === 'system') continue;

      if (m.role === 'user') {
        if (prevOutputRole !== 'user') roundCount++;
        const item: ReturnType<ConversationState['buildLlmHistory']>[number] = {
          role: 'user',
          content: m.content,
        };
        if (m.imagePaths && m.imagePaths.length > 0) {
          item.imagePaths = m.imagePaths;
        }
        output.push(item);
        pendingAssistantIndex = null;
        openToolGroup = false;
        cumulativeTokens += estimateTokens(m.content);
        prevOutputRole = 'user';
        continue;
      }

      if (m.role === 'assistant') {
        cumulativeTokens += estimateTokens(m.content);
        const fullCalls =
          m.toolCalls && m.toolCalls.length > 0
            ? m.toolCalls
            : m.toolCall
              ? [m.toolCall]
              : null;

        if (fullCalls) {
          output.push({
            role: 'assistant',
            content: m.content,
            toolCalls: fullCalls.map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: tc.arguments || {},
            })),
          });
          // assistant 已带完整 tool_calls，后续 tool 只负责 result
          pendingAssistantIndex = null;
          openToolGroup = true;
        } else {
          const item: ReturnType<ConversationState['buildLlmHistory']>[number] = {
            role: 'assistant',
            content: m.content,
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
        const rawToolContent = m.toolResult.result || m.content;
        cumulativeTokens += estimateTokens(rawToolContent);
        const toolContent = compressToolContent(rawToolContent, m.toolResult.toolName);
        const callEntry = {
          id: m.toolResult.toolCallId,
          name: m.toolResult.toolName,
          arguments: m.toolResult.arguments || {},
        };

        if (pendingAssistantIndex != null) {
          // 纯文案 assistant 后的第一个 tool：把 toolCalls 挂上去
          const preamble = output[pendingAssistantIndex].content;
          output[pendingAssistantIndex] = {
            role: 'assistant',
            content: preamble,
            toolCalls: [callEntry],
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
        });
        prevOutputRole = 'tool';
      } else {
        openToolGroup = false;
      }
    }

    return output;
  },
}));
