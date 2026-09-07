/**
 * turnFoldStore.ts — 已结束回合「过程折叠」的展开状态（前端内存态）。
 *
 * 四层对齐：本状态只影响 UI 展示（后端内存/持久化无对应物 —— 折叠是纯
 * 展示层，不改变消息本身）。key = 回合首条 user 消息 id（稳定，窗口滑动 /
 * 上翻加载不失效）；会话切换用 conversationId 隔离。
 */

import { create } from 'zustand';

export interface TurnFoldState {
  /** conversationId → turnKey → 是否展开。缺省 = 折叠（长回合默认收起）。 */
  expanded: Record<string, Record<string, boolean>>;
  /** 切换某回合展开态。返回新值（供调用方必要时同步）。 */
  toggleTurn: (conversationId: string, turnKey: string) => void;
  /** 强制某回合展开（搜索命中 / beforematch 唤回）。 */
  expandTurn: (conversationId: string, turnKey: string) => void;
  /** 会话删除/切换时清理，防泄漏。 */
  clearConversation: (conversationId: string) => void;
}

export const useTurnFoldStore = create<TurnFoldState>((set) => ({
  expanded: {},
  toggleTurn: (conversationId, turnKey) =>
    set((state) => {
      const conv = state.expanded[conversationId];
      const wasOpen = conv?.[turnKey] ?? false;
      return {
        expanded: {
          ...state.expanded,
          [conversationId]: {
            ...(conv ?? {}),
            [turnKey]: !wasOpen,
          },
        },
      };
    }),
  expandTurn: (conversationId, turnKey) =>
    set((state) => {
      const conv = state.expanded[conversationId];
      if (conv?.[turnKey]) return state; // 已展开，无变更
      return {
        expanded: {
          ...state.expanded,
          [conversationId]: {
            ...(conv ?? {}),
            [turnKey]: true,
          },
        },
      };
    }),
  clearConversation: (conversationId) =>
    set((state) => {
      if (!(conversationId in state.expanded)) return state;
      const next = { ...state.expanded };
      delete next[conversationId];
      return { expanded: next };
    }),
}));
