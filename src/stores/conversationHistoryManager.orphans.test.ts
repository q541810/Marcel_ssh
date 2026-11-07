import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tauri', () => ({
  agentListOrphanConversationGroups: vi.fn(),
  agentListOrphanConversations: vi.fn(),
  agentReassignOrphanConversations: vi.fn(),
  agentDeleteOrphanConversations: vi.fn(),
  agentListConversationsByConnection: vi.fn().mockResolvedValue([]),
  agentListArchivedConversations: vi.fn().mockResolvedValue([]),
}));

import * as tauri from '@/lib/tauri';
import { useConversationHistoryStore } from './conversationHistoryManager';
import type { AgentConversation, OrphanConversationGroup } from '@/lib/types';

const group = (id: string, extra: Partial<OrphanConversationGroup> = {}): OrphanConversationGroup => ({
  connectionId: id,
  name: id,
  host: null,
  deletedAt: null,
  conversationCount: 1,
  lastUpdatedAt: '2026-11-01T00:00:00Z',
  lastTitle: 't',
  ...extra,
});

const conv = (id: string, connectionId: string): AgentConversation => ({
  id,
  connectionId,
  title: id,
  createdAt: '',
  updatedAt: '',
});

describe('ConversationHistoryManager · 已删除的服务器', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationHistoryStore.getState().reset();
  });

  it('拉分组；失败当没有，不抛出', async () => {
    (tauri.agentListOrphanConversationGroups as any).mockResolvedValueOnce([group('gone')]);
    await useConversationHistoryStore.getState().loadOrphanGroups();
    expect(useConversationHistoryStore.getState().orphanGroups).toHaveLength(1);

    (tauri.agentListOrphanConversationGroups as any).mockRejectedValueOnce(new Error('boom'));
    await expect(useConversationHistoryStore.getState().loadOrphanGroups()).resolves.toEqual([]);
    expect(useConversationHistoryStore.getState().orphanGroups).toEqual([]);
  });

  it('孤儿对话单独存放，不混进 conversationsByConn', async () => {
    (tauri.agentListOrphanConversations as any).mockResolvedValue([conv('c1', 'gone')]);
    await useConversationHistoryStore.getState().loadOrphanConversations('gone');
    const s = useConversationHistoryStore.getState();
    expect(s.orphanConversations['gone']).toHaveLength(1);
    expect(s.conversationsByConn['gone']).toBeUndefined();
  });

  it('转移：刷新目标服务器的 live 列表，分组重拉，选中项与搜索结果里属于来源的清掉', async () => {
    (tauri.agentReassignOrphanConversations as any).mockResolvedValue(2);
    (tauri.agentListOrphanConversationGroups as any).mockResolvedValue([]);
    useConversationHistoryStore.setState({
      orphanGroups: [group('gone')],
      orphanConversations: { gone: [conv('c1', 'gone')] },
      selectedConnId: 'gone',
      selectedConvId: 'c1',
      searchResults: [
        {
          conversationId: 'c1',
          connectionId: 'gone',
          title: 't',
          updatedAt: '',
          matchedSnippet: '',
          matchCount: 1,
          matchedMessageIds: [],
        } as any,
      ],
    });

    const moved = await useConversationHistoryStore.getState().reassignOrphan('gone', 'new');

    expect(moved).toBe(2);
    expect(tauri.agentReassignOrphanConversations).toHaveBeenCalledWith('gone', 'new');
    // 目标服务器的 live 列表与归档缓存被刷新。
    expect(tauri.agentListConversationsByConnection).toHaveBeenCalledWith('new');
    expect(tauri.agentListArchivedConversations).toHaveBeenCalledWith('new');
    const s = useConversationHistoryStore.getState();
    expect(s.orphanGroups).toEqual([]);
    expect(s.orphanConversations['gone']).toBeUndefined();
    expect(s.selectedConnId).toBeNull();
    expect(s.selectedConvId).toBeNull();
    expect(s.searchResults).toEqual([]);
  });

  it('转移失败向上抛，本地状态不动', async () => {
    (tauri.agentReassignOrphanConversations as any).mockRejectedValue(new Error('目标服务器不存在'));
    useConversationHistoryStore.setState({ orphanGroups: [group('gone')] });
    await expect(
      useConversationHistoryStore.getState().reassignOrphan('gone', 'nope'),
    ).rejects.toThrow('目标服务器不存在');
    expect(useConversationHistoryStore.getState().orphanGroups).toHaveLength(1);
  });

  it('彻底删除：清掉该分组的对话与选中项，并重拉分组', async () => {
    (tauri.agentDeleteOrphanConversations as any).mockResolvedValue(3);
    (tauri.agentListOrphanConversationGroups as any).mockResolvedValue([]);
    useConversationHistoryStore.setState({
      orphanGroups: [group('gone')],
      orphanConversations: { gone: [conv('c1', 'gone')] },
      selectedConnId: 'gone',
      selectedConvId: 'c1',
    });

    await useConversationHistoryStore.getState().deleteOrphan('gone');

    expect(tauri.agentDeleteOrphanConversations).toHaveBeenCalledWith('gone');
    const s = useConversationHistoryStore.getState();
    expect(s.orphanGroups).toEqual([]);
    expect(s.orphanConversations['gone']).toBeUndefined();
    expect(s.selectedConnId).toBeNull();
  });

  it('reset 清掉已删除服务器的状态', () => {
    useConversationHistoryStore.setState({
      orphanGroups: [group('gone')],
      orphanConversations: { gone: [] },
    });
    useConversationHistoryStore.getState().reset();
    const s = useConversationHistoryStore.getState();
    expect(s.orphanGroups).toEqual([]);
    expect(s.orphanConversations).toEqual({});
  });
});
