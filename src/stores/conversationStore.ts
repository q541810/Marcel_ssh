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

  addMessage: (message: AgentMessage) => void;
  clearMessages: () => void;
  newConversation: (sessionId: string, connectionId: string) => Promise<string>;
  switchConversation: (conversationId: string) => Promise<void>;
  loadConversation: (conversationId: string) => Promise<void>;
  deleteConversation: (conversationId: string) => Promise<void>;
  rollbackToMessage: (conversationId: string, messageId: string) => Promise<{ prompt: string; removedCount: number }>;
  clearConnectionConversations: (connectionId: string) => void;
  loadConnectionConversations: (connectionId: string) => Promise<void>;
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
  }>;
}

export const useConversationStore = create<ConversationState>((set, get) => ({
  conversations: {},
  messages: {},
  activeConversationId: null,

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
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
      activeConversationId: conversationId,
    }));
    useTaskStore.getState().loadPersistedPlans(conversationId, storedPlans);
    useTaskStore.getState().clearActiveTask();
  },

  loadConversation: async (conversationId: string) => {
    const [stored, storedPlans] = await Promise.all([
      tauri.agentLoadConversation(conversationId),
      tauri.agentLoadPlansByConversation(conversationId),
    ]);
    const msgs: AgentMessage[] = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
    set((state) => ({
      messages: { ...state.messages, [conversationId]: msgs },
      activeConversationId: conversationId,
    }));
    useTaskStore.getState().loadPersistedPlans(conversationId, storedPlans);
    useTaskStore.getState().clearActiveTask();
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
    let activeConversationId: string | null = null;

    set((state) => {
      const incomingConvIds = new Set(convs.map((c) => c.id));

      const toRemove = Object.values(state.conversations)
        .filter((c) => c.connectionId === connectionId && !incomingConvIds.has(c.id))
        .map((c) => c.id);

      const newConversations: Record<string, AgentConversation> = { ...state.conversations };
      const newMessages: Record<string, AgentMessage[]> = { ...state.messages };

      for (const id of toRemove) {
        delete newConversations[id];
        delete newMessages[id];
      }

      for (const conv of convs) {
        newConversations[conv.id] = conv;
        newMessages[conv.id] = state.messages[conv.id] ?? [];
      }

      const firstConvId = convs.length > 0 ? convs[0].id : null;
      const isActiveStillValid = state.activeConversationId && newConversations[state.activeConversationId];
      activeConversationId = isActiveStillValid ? state.activeConversationId : (firstConvId || state.activeConversationId || null);

      return {
        conversations: newConversations,
        messages: newMessages,
        activeConversationId,
      };
    });

    if (activeConversationId && !get().messages[activeConversationId]?.length) {
      await get().loadConversation(activeConversationId);
    }
  },

  getCurrentMessages: () => {
    const convId = get().activeConversationId;
    if (!convId) return [];
    return get().messages[convId] || [];
  },

  ensureConversation: async (sessionId: string, connectionId: string, fallbackTitle: string) => {
    const { activeConversationId } = get();
    let conversationId: string;

    if (!activeConversationId) {
      const newTitle = fallbackTitle.slice(0, 30);
      const newId = await tauri.agentCreateConversation(sessionId, newTitle);
      conversationId = newId;
      set((state) => ({
        conversations: {
          ...state.conversations,
          [newId]: {
            id: newId,
            connectionId,
            title: newTitle,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
        messages: { ...state.messages, [newId]: [] },
        activeConversationId: newId,
      }));
    } else {
      conversationId = activeConversationId;
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
        output.push({ role: 'user', content: m.content });
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
