import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { create } from 'zustand';
import { collectSyncApplied, flush } from '@/lib/syncRefresh';
import { useSettingsStore } from '@/stores/settingsStore';
import { useConnectionStore } from '@/stores/connectionStore';
import { useQuickCommandStore } from '@/stores/quickCommandStore';
import { useSkillStore } from '@/stores/skillStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSessionStore } from '@/stores/sessionStore';

// sessionStore 顶层 import 了 TerminalInstanceManager（xterm），node 环境无法加载；
// syncRefresh 只用它的 sessions/activeSessionId，mock 一个最小 store 即可。
// vi.mock 会被 hoisted，即使写在 import 之后也先于模块加载执行。
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: create(() => ({ sessions: {}, activeSessionId: null })),
}));

function mockStores() {
  useSettingsStore.setState({
    load: vi.fn().mockResolvedValue(undefined),
    hasWebSearchApiKey: false,
  });
  useConnectionStore.setState({ fetchConnections: vi.fn().mockResolvedValue(undefined) });
  useQuickCommandStore.setState({ load: vi.fn().mockResolvedValue(undefined) });
  useSkillStore.setState({ fetchSkills: vi.fn().mockResolvedValue(undefined) });
  useMcpStore.setState({ fetchServers: vi.fn().mockResolvedValue(undefined) });
  useConversationStore.setState({
    loadConversation: vi.fn().mockResolvedValue(undefined),
    loadConnectionConversations: vi.fn().mockResolvedValue(undefined),
    activeConversationId: null,
  });
  useSessionStore.setState({ activeSessionId: null, sessions: {} });
}

describe('syncRefresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockStores();
  });

  afterEach(async () => {
    // 清掉可能残留的 debounce timer，避免跨测试污染
    await flush();
    vi.useRealTimers();
  });

  it('合并多个会话事件为一次列表刷新 + active 会话一次消息加载', async () => {
    useConversationStore.setState({ activeConversationId: 'conv-a' });
    useSessionStore.setState({
      activeSessionId: 's1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessions: { s1: { configId: 'c1' } } as any,
    });

    collectSyncApplied('conversations.conv-a', false);
    collectSyncApplied('conversations.conv-b', false);
    collectSyncApplied('conversations.conv-c', true); // 删除
    await vi.advanceTimersByTimeAsync(120);

    const state = useConversationStore.getState();
    expect(state.loadConversation).toHaveBeenCalledTimes(1);
    expect(state.loadConversation).toHaveBeenCalledWith('conv-a');
    expect(state.loadConnectionConversations).toHaveBeenCalledTimes(1);
    expect(state.loadConnectionConversations).toHaveBeenCalledWith('c1');
  });

  it('多个连接事件合并为一次 fetch', async () => {
    collectSyncApplied('connections.conn-1', false);
    collectSyncApplied('connections.conn-2', false);
    await vi.advanceTimersByTimeAsync(120);

    expect(useConnectionStore.getState().fetchConnections).toHaveBeenCalledTimes(1);
  });

  it('settings 字段事件合并为一次 load(true)，webSearchApiKey 取最后值', async () => {
    collectSyncApplied('settings.fontSize', false);
    collectSyncApplied('settings.fontFamily', false);
    collectSyncApplied('secrets.webSearchApiKey', true); // 远程删除
    await vi.advanceTimersByTimeAsync(120);

    expect(useSettingsStore.getState().load).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().load).toHaveBeenCalledWith(true);
    expect(useSettingsStore.getState().hasWebSearchApiKey).toBe(false);
  });

  it('非 active 会话不加载消息，但仍刷新一次列表', async () => {
    useConversationStore.setState({ activeConversationId: 'other' });
    useSessionStore.setState({
      activeSessionId: 's1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sessions: { s1: { configId: 'c1' } } as any,
    });

    collectSyncApplied('conversations.conv-x', false);
    await vi.advanceTimersByTimeAsync(120);

    const state = useConversationStore.getState();
    expect(state.loadConversation).not.toHaveBeenCalled();
    expect(state.loadConnectionConversations).toHaveBeenCalledTimes(1);
  });

  it('无激活会话时不触发任何会话刷新', async () => {
    collectSyncApplied('conversations.conv-x', false);
    await vi.advanceTimersByTimeAsync(120);

    const state = useConversationStore.getState();
    expect(state.loadConversation).not.toHaveBeenCalled();
    expect(state.loadConnectionConversations).not.toHaveBeenCalled();
  });

  it('debounce 窗口内新事件重置计时器（合并为一轮）', async () => {
    collectSyncApplied('connections.a', false);
    await vi.advanceTimersByTimeAsync(60); // 未到 120ms
    collectSyncApplied('connections.b', false);
    await vi.advanceTimersByTimeAsync(60); // 又未到（被重置）
    collectSyncApplied('connections.c', false);
    await vi.advanceTimersByTimeAsync(120);

    expect(useConnectionStore.getState().fetchConnections).toHaveBeenCalledTimes(1);
  });
});
