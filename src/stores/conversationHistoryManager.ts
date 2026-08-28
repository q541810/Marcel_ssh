import { create } from 'zustand';
import type {
  SavedConnection,
  AgentConversation,
  AgentMessage,
  ConversationSearchResult,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';
import {
  storedMessageToAgentMessage,
  clearIntermediateReasoning,
} from './messageConversion';
import { useTaskStore } from './taskStore';
import { useConversationStore } from './conversationStore';
import { getErrorMessage } from '@/lib/errors';

export interface GroupedSearchResults {
  connectionId: string;
  label: string;
  items: ConversationSearchResult[];
}

export interface ConversationHistoryState {
  // 1. 全局连接与会话索引
  conversationsByConn: Record<string, AgentConversation[]>;
  loadingConvs: boolean;

  // 2. 当前选中连接与会话详情
  selectedConnId: string | null;
  selectedConvId: string | null;
  selectedConv: AgentConversation | null;
  messages: AgentMessage[];
  loadingMsgs: boolean;

  // 3. 全文检索状态
  searchInput: string;
  debouncedQuery: string;
  searchResults: ConversationSearchResult[];
  loadingSearch: boolean;

  // 4. 搜索结果匹配项定位与高亮导航
  activeMatchIds: string[];
  matchIndex: number;
  highlightMessageId: string | null;

  // 5. 重命名操作状态（移动端/桌面端通用）
  renameTarget: AgentConversation | null;
  renameInput: string;
}

export interface ConversationHistoryActions {
  // 索引加载
  loadAllConnections: (connections: SavedConnection[]) => Promise<void>;
  loadConnectionConversations: (connectionId: string) => Promise<AgentConversation[]>;

  // 视图选择与消息拉取
  setSelectedConnId: (connId: string | null) => void;
  selectConversation: (conv: AgentConversation | string | null, connId?: string | null) => Promise<void>;
  openSearchResult: (result: ConversationSearchResult) => Promise<void>;
  clearSelectedConversation: () => void;

  // 搜索相关
  setSearchInput: (input: string) => void;
  performSearch: (query: string) => Promise<void>;
  clearSearch: () => void;

  // 搜索匹配定位与导航
  goMatch: (delta: number) => void;
  setMatchIndex: (index: number) => void;

  // 重命名与删除（保持四层一致性）
  startRename: (conv: AgentConversation) => void;
  setRenameInput: (input: string) => void;
  cancelRename: () => void;
  confirmRename: (convId?: string, newTitle?: string) => Promise<boolean>;
  deleteConversation: (conversationId: string) => Promise<void>;

  // 重置全部状态（关闭历史面板时调用）
  reset: () => void;
}

export type ConversationHistoryStore = ConversationHistoryState & ConversationHistoryActions;

let searchTimer: ReturnType<typeof setTimeout> | null = null;
let searchSeq = 0;
let loadMsgsSeq = 0;
let loadConvsSeq = 0;

export const useConversationHistoryStore = create<ConversationHistoryStore>((set, get) => ({
  conversationsByConn: {},
  loadingConvs: false,

  selectedConnId: null,
  selectedConvId: null,
  selectedConv: null,
  messages: [],
  loadingMsgs: false,

  searchInput: '',
  debouncedQuery: '',
  searchResults: [],
  loadingSearch: false,

  activeMatchIds: [],
  matchIndex: 0,
  highlightMessageId: null,

  renameTarget: null,
  renameInput: '',

  loadAllConnections: async (connections: SavedConnection[]) => {
    if (connections.length === 0) {
      set({ conversationsByConn: {}, loadingConvs: false });
      return;
    }
    set({ loadingConvs: true });
    const seq = ++loadConvsSeq;
    const byConn: Record<string, AgentConversation[]> = {};
    for (const conn of connections) {
      try {
        const convs = await tauri.agentListConversationsByConnection(conn.id);
        byConn[conn.id] = convs;
      } catch {
        byConn[conn.id] = [];
      }
    }
    if (seq === loadConvsSeq) {
      set({ conversationsByConn: byConn, loadingConvs: false });
    }
  },

  loadConnectionConversations: async (connectionId: string) => {
    try {
      const convs = await tauri.agentListConversationsByConnection(connectionId);
      set((state) => ({
        conversationsByConn: {
          ...state.conversationsByConn,
          [connectionId]: convs,
        },
      }));
      return convs;
    } catch (err) {
      console.error('[ConversationHistoryManager] loadConnectionConversations failed:', err);
      return [];
    }
  },

  setSelectedConnId: (connId: string | null) => {
    set({
      selectedConnId: connId,
      selectedConvId: null,
      selectedConv: null,
      messages: [],
      activeMatchIds: [],
      matchIndex: 0,
      highlightMessageId: null,
    });
  },

  selectConversation: async (convInput: AgentConversation | string | null, connId?: string | null) => {
    if (!convInput) {
      set({
        selectedConvId: null,
        selectedConv: null,
        messages: [],
        loadingMsgs: false,
        activeMatchIds: [],
        matchIndex: 0,
        highlightMessageId: null,
        ...(connId !== undefined ? { selectedConnId: connId } : {}),
      });
      return;
    }

    const state = get();
    const convId = typeof convInput === 'string' ? convInput : convInput.id;
    let conv: AgentConversation | null = typeof convInput === 'object' ? convInput : null;

    if (!conv) {
      const targetConnId = connId ?? state.selectedConnId;
      if (targetConnId && state.conversationsByConn[targetConnId]) {
        conv = state.conversationsByConn[targetConnId].find((c) => c.id === convId) || null;
      }
      if (!conv) {
        const searchItem = state.searchResults.find((r) => r.conversationId === convId);
        if (searchItem) {
          conv = {
            id: searchItem.conversationId,
            connectionId: searchItem.connectionId,
            title: searchItem.title,
            createdAt: searchItem.updatedAt,
            updatedAt: searchItem.updatedAt,
          };
        }
      }
      if (!conv) {
        conv = useConversationStore.getState().conversations[convId] || null;
      }
    }

    const nextConnId = conv?.connectionId ?? connId ?? state.selectedConnId;

    set({
      selectedConvId: convId,
      selectedConv: conv,
      selectedConnId: nextConnId,
      loadingMsgs: true,
      activeMatchIds: [],
      matchIndex: 0,
      highlightMessageId: null,
    });

    useTaskStore.getState().clearConversationUnreadCompleted(convId);

    const seq = ++loadMsgsSeq;
    try {
      const stored = await tauri.agentLoadConversation(convId);
      if (seq === loadMsgsSeq) {
        const msgs = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
        set({ messages: msgs, loadingMsgs: false });
      }
    } catch {
      if (seq === loadMsgsSeq) {
        set({ messages: [], loadingMsgs: false });
      }
    }
  },

  openSearchResult: async (result: ConversationSearchResult) => {
    const conv: AgentConversation = {
      id: result.conversationId,
      connectionId: result.connectionId,
      title: result.title,
      createdAt: result.updatedAt,
      updatedAt: result.updatedAt,
    };

    set({
      selectedConnId: result.connectionId,
      selectedConvId: result.conversationId,
      selectedConv: conv,
      activeMatchIds: result.matchedMessageIds,
      matchIndex: 0,
      highlightMessageId: null,
      loadingMsgs: true,
    });

    useTaskStore.getState().clearConversationUnreadCompleted(result.conversationId);

    const seq = ++loadMsgsSeq;
    try {
      const stored = await tauri.agentLoadConversation(result.conversationId);
      if (seq === loadMsgsSeq) {
        const msgs = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
        set({
          messages: msgs,
          loadingMsgs: false,
          highlightMessageId: result.matchedMessageIds.length > 0 ? result.matchedMessageIds[0] : null,
        });
      }
    } catch {
      if (seq === loadMsgsSeq) {
        set({ messages: [], loadingMsgs: false });
      }
    }
  },

  clearSelectedConversation: () => {
    set({
      selectedConvId: null,
      selectedConv: null,
      messages: [],
      loadingMsgs: false,
      activeMatchIds: [],
      matchIndex: 0,
      highlightMessageId: null,
    });
  },

  setSearchInput: (input: string) => {
    set({ searchInput: input });

    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }

    const trimmed = input.trim();
    if (!trimmed) {
      set({
        debouncedQuery: '',
        searchResults: [],
        loadingSearch: false,
        activeMatchIds: [],
        matchIndex: 0,
        highlightMessageId: null,
      });
      return;
    }

    searchTimer = setTimeout(() => {
      void get().performSearch(trimmed);
    }, 300);
  },

  performSearch: async (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) {
      set({
        debouncedQuery: '',
        searchResults: [],
        loadingSearch: false,
        activeMatchIds: [],
        matchIndex: 0,
        highlightMessageId: null,
      });
      return;
    }

    const seq = ++searchSeq;
    set({ debouncedQuery: trimmed, loadingSearch: true });

    try {
      const results = await tauri.agentSearchConversations(trimmed);
      if (seq === searchSeq) {
        set({ searchResults: results, loadingSearch: false });
      }
    } catch {
      if (seq === searchSeq) {
        set({ searchResults: [], loadingSearch: false });
      }
    }
  },

  clearSearch: () => {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    searchSeq++;
    set({
      searchInput: '',
      debouncedQuery: '',
      searchResults: [],
      loadingSearch: false,
      activeMatchIds: [],
      matchIndex: 0,
      highlightMessageId: null,
    });
  },

  goMatch: (delta: number) => {
    const { activeMatchIds, matchIndex } = get();
    if (activeMatchIds.length === 0) return;
    const next = matchIndex + delta;
    if (next < 0 || next >= activeMatchIds.length) return;
    set({
      matchIndex: next,
      highlightMessageId: activeMatchIds[next],
    });
  },

  setMatchIndex: (index: number) => {
    const { activeMatchIds } = get();
    if (index < 0 || index >= activeMatchIds.length) return;
    set({
      matchIndex: index,
      highlightMessageId: activeMatchIds[index],
    });
  },

  startRename: (conv: AgentConversation) => {
    set({ renameTarget: conv, renameInput: conv.title });
  },

  setRenameInput: (input: string) => {
    set({ renameInput: input });
  },

  cancelRename: () => {
    set({ renameTarget: null, renameInput: '' });
  },

  confirmRename: async (convIdArg?: string, newTitleArg?: string) => {
    const state = get();
    const targetId = convIdArg ?? state.renameTarget?.id;
    const currentTitle = convIdArg
      ? state.conversationsByConn[state.selectedConnId ?? '']?.find((c) => c.id === convIdArg)?.title ?? ''
      : state.renameTarget?.title ?? '';
    const newTitle = (newTitleArg ?? state.renameInput).trim();

    if (!targetId || !newTitle || newTitle === currentTitle) {
      set({ renameTarget: null, renameInput: '' });
      return false;
    }

    try {
      await useConversationStore.getState().renameConversation(targetId, newTitle);
      const now = new Date().toISOString();

      set((s) => {
        const nextConvsByConn: Record<string, AgentConversation[]> = {};
        for (const [connId, convs] of Object.entries(s.conversationsByConn)) {
          nextConvsByConn[connId] = convs.map((c) =>
            c.id === targetId ? { ...c, title: newTitle, updatedAt: now } : c,
          );
        }

        const nextSearchResults = s.searchResults.map((r) =>
          r.conversationId === targetId ? { ...r, title: newTitle } : r,
        );

        const nextSelectedConv =
          s.selectedConv?.id === targetId
            ? { ...s.selectedConv, title: newTitle, updatedAt: now }
            : s.selectedConv;

        return {
          conversationsByConn: nextConvsByConn,
          searchResults: nextSearchResults,
          selectedConv: nextSelectedConv,
          renameTarget: null,
          renameInput: '',
        };
      });
      return true;
    } catch (err) {
      console.error('[ConversationHistoryManager] confirmRename failed:', getErrorMessage(err));
      set({ renameTarget: null, renameInput: '' });
      return false;
    }
  },

  deleteConversation: async (conversationId: string) => {
    try {
      await useConversationStore.getState().deleteConversation(conversationId);

      set((s) => {
        const nextConvsByConn: Record<string, AgentConversation[]> = {};
        for (const [connId, convs] of Object.entries(s.conversationsByConn)) {
          nextConvsByConn[connId] = convs.filter((c) => c.id !== conversationId);
        }

        const nextSearchResults = s.searchResults.filter((r) => r.conversationId !== conversationId);

        const isCurrentSelected = s.selectedConvId === conversationId;

        return {
          conversationsByConn: nextConvsByConn,
          searchResults: nextSearchResults,
          ...(isCurrentSelected
            ? {
                selectedConvId: null,
                selectedConv: null,
                messages: [],
                activeMatchIds: [],
                matchIndex: 0,
                highlightMessageId: null,
              }
            : {}),
        };
      });
    } catch (err) {
      console.error('[ConversationHistoryManager] deleteConversation failed:', getErrorMessage(err));
    }
  },

  reset: () => {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
    searchSeq++;
    loadMsgsSeq++;
    loadConvsSeq++;

    set({
      conversationsByConn: {},
      loadingConvs: false,

      selectedConnId: null,
      selectedConvId: null,
      selectedConv: null,
      messages: [],
      loadingMsgs: false,

      searchInput: '',
      debouncedQuery: '',
      searchResults: [],
      loadingSearch: false,

      activeMatchIds: [],
      matchIndex: 0,
      highlightMessageId: null,

      renameTarget: null,
      renameInput: '',
    });
  },
}));

/**
 * 辅助函数：将搜索结果按连接聚合分组
 */
export function groupSearchResultsByConnection(
  searchResults: ConversationSearchResult[],
  connNameById: Map<string, string>,
): GroupedSearchResults[] {
  const groups: GroupedSearchResults[] = [];
  const indexMap = new Map<string, number>();

  for (const r of searchResults) {
    let idx = indexMap.get(r.connectionId);
    if (idx === undefined) {
      idx = groups.length;
      indexMap.set(r.connectionId, idx);
      groups.push({
        connectionId: r.connectionId,
        label: connNameById.get(r.connectionId) || r.connectionId,
        items: [],
      });
    }
    groups[idx].items.push(r);
  }

  return groups;
}

/**
 * 格式化匹配数文案
 */
export function formatMatchCountLabel(count: number): string {
  return count > 200 ? '共 200+ 条匹配' : `共 ${count} 条匹配`;
}

export const conversationHistoryManager = {
  getState: () => useConversationHistoryStore.getState(),
  setState: useConversationHistoryStore.setState,
  subscribe: useConversationHistoryStore.subscribe,
  loadAllConnections: (connections: SavedConnection[]) =>
    useConversationHistoryStore.getState().loadAllConnections(connections),
  loadConnectionConversations: (connectionId: string) =>
    useConversationHistoryStore.getState().loadConnectionConversations(connectionId),
  selectConversation: (conv: AgentConversation | string | null, connId?: string | null) =>
    useConversationHistoryStore.getState().selectConversation(conv, connId),
  openSearchResult: (result: ConversationSearchResult) =>
    useConversationHistoryStore.getState().openSearchResult(result),
  setSearchInput: (input: string) =>
    useConversationHistoryStore.getState().setSearchInput(input),
  clearSearch: () =>
    useConversationHistoryStore.getState().clearSearch(),
  goMatch: (delta: number) =>
    useConversationHistoryStore.getState().goMatch(delta),
  startRename: (conv: AgentConversation) =>
    useConversationHistoryStore.getState().startRename(conv),
  confirmRename: (convId?: string, newTitle?: string) =>
    useConversationHistoryStore.getState().confirmRename(convId, newTitle),
  deleteConversation: (conversationId: string) =>
    useConversationHistoryStore.getState().deleteConversation(conversationId),
  reset: () =>
    useConversationHistoryStore.getState().reset(),
};
