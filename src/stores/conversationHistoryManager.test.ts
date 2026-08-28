import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tauri', () => ({
  agentListConversationsByConnection: vi.fn(),
  agentLoadConversation: vi.fn(),
  agentSearchConversations: vi.fn(),
  agentRenameConversation: vi.fn(),
  agentDeleteConversation: vi.fn(),
  agentCreateConversation: vi.fn(),
  agentLoadActiveMessages: vi.fn().mockResolvedValue({ messages: [], hasEarlier: false, checkpointId: null }),
  agentLoadEarlierMessages: vi.fn().mockResolvedValue([]),
  agentLoadPlansByConversation: vi.fn(),
  agentGetConversation: vi.fn(),
  agentTruncateConversation: vi.fn(),
}));

import {
  useConversationHistoryStore,
  groupSearchResultsByConnection,
  formatMatchCountLabel,
} from './conversationHistoryManager';
import { useConversationStore } from './conversationStore';
import * as tauri from '@/lib/tauri';
import type { SavedConnection, ConversationSearchResult, StoredMessage } from '@/lib/types';

describe('ConversationHistoryManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    useConversationHistoryStore.getState().reset();
    useConversationStore.setState({
      conversations: {},
      messages: {},
      activeConversationId: null,
    });
  });

  it('loads conversations for all connections', async () => {
    const connections: SavedConnection[] = [
      { id: 'conn-1', name: 'Server 1', host: '1.1.1.1', port: 22, username: 'root' },
      { id: 'conn-2', name: 'Server 2', host: '2.2.2.2', port: 22, username: 'root' },
    ];

    (tauri.agentListConversationsByConnection as any).mockImplementation(async (connId: string) => {
      if (connId === 'conn-1') {
        return [
          { id: 'c1', connectionId: 'conn-1', title: 'Conv 1', createdAt: '', updatedAt: '' },
        ];
      }
      return [
        { id: 'c2', connectionId: 'conn-2', title: 'Conv 2', createdAt: '', updatedAt: '' },
      ];
    });

    await useConversationHistoryStore.getState().loadAllConnections(connections);

    const state = useConversationHistoryStore.getState();
    expect(state.conversationsByConn['conn-1']).toHaveLength(1);
    expect(state.conversationsByConn['conn-2']).toHaveLength(1);
    expect(state.conversationsByConn['conn-1'][0].title).toBe('Conv 1');
    expect(state.loadingConvs).toBe(false);
  });

  it('selects conversation and loads messages', async () => {
    const mockStored: StoredMessage[] = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: 'hello',
        timestamp: '2026-01-01',
        createdAt: '2026-01-01',
      },
      {
        id: 'm2',
        conversationId: 'c1',
        role: 'assistant',
        content: 'hi',
        timestamp: '2026-01-01',
        createdAt: '2026-01-01',
      },
    ];
    (tauri.agentLoadConversation as any).mockResolvedValue(mockStored);

    await useConversationHistoryStore.getState().selectConversation({
      id: 'c1',
      connectionId: 'conn-1',
      title: 'Conv 1',
      createdAt: '',
      updatedAt: '',
    });

    const state = useConversationHistoryStore.getState();
    expect(state.selectedConvId).toBe('c1');
    expect(state.selectedConv?.title).toBe('Conv 1');
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].content).toBe('hello');
    expect(state.loadingMsgs).toBe(false);
  });

  it('performs debounced search and sets results', async () => {
    vi.useFakeTimers();

    const mockResults: ConversationSearchResult[] = [
      {
        conversationId: 'c1',
        connectionId: 'conn-1',
        title: 'Conv 1',
        matchedSnippet: 'found text',
        matchCount: 3,
        matchedMessageIds: ['m1', 'm2', 'm3'],
        updatedAt: '2026-01-01',
      },
    ];
    (tauri.agentSearchConversations as any).mockResolvedValue(mockResults);

    useConversationHistoryStore.getState().setSearchInput('test query');
    expect(useConversationHistoryStore.getState().searchInput).toBe('test query');

    // 还没过 300ms
    expect(tauri.agentSearchConversations).not.toHaveBeenCalled();

    // 快进 300ms
    await vi.advanceTimersByTimeAsync(300);

    expect(tauri.agentSearchConversations).toHaveBeenCalledWith('test query');
    const state = useConversationHistoryStore.getState();
    expect(state.searchResults).toHaveLength(1);
    expect(state.searchResults[0].conversationId).toBe('c1');
    expect(state.loadingSearch).toBe(false);
  });

  it('opens search result and navigates matches', async () => {
    const mockResult: ConversationSearchResult = {
      conversationId: 'c1',
      connectionId: 'conn-1',
      title: 'Conv 1',
      matchedSnippet: 'snippet',
      matchCount: 2,
      matchedMessageIds: ['m1', 'm2'],
      updatedAt: '2026-01-01',
    };

    (tauri.agentLoadConversation as any).mockResolvedValue([
      { id: 'm1', conversationId: 'c1', role: 'user', content: 'match 1', timestamp: '', createdAt: '' },
      { id: 'm2', conversationId: 'c1', role: 'user', content: 'match 2', timestamp: '', createdAt: '' },
    ]);

    await useConversationHistoryStore.getState().openSearchResult(mockResult);

    let state = useConversationHistoryStore.getState();
    expect(state.selectedConvId).toBe('c1');
    expect(state.activeMatchIds).toEqual(['m1', 'm2']);
    expect(state.matchIndex).toBe(0);
    expect(state.highlightMessageId).toBe('m1');

    // 下一条匹配
    useConversationHistoryStore.getState().goMatch(1);
    state = useConversationHistoryStore.getState();
    expect(state.matchIndex).toBe(1);
    expect(state.highlightMessageId).toBe('m2');

    // 超出上限不越界
    useConversationHistoryStore.getState().goMatch(1);
    state = useConversationHistoryStore.getState();
    expect(state.matchIndex).toBe(1);

    // 上一条匹配
    useConversationHistoryStore.getState().goMatch(-1);
    state = useConversationHistoryStore.getState();
    expect(state.matchIndex).toBe(0);
    expect(state.highlightMessageId).toBe('m1');
  });

  it('confirms rename and syncs conversationsByConn, searchResults and conversationStore', async () => {
    useConversationHistoryStore.setState({
      conversationsByConn: {
        'conn-1': [
          { id: 'c1', connectionId: 'conn-1', title: 'Old Title', createdAt: '', updatedAt: '' },
        ],
      },
      searchResults: [
        {
          conversationId: 'c1',
          connectionId: 'conn-1',
          title: 'Old Title',
          matchedSnippet: '',
          matchCount: 1,
          matchedMessageIds: ['m1'],
          updatedAt: '',
        },
      ],
      selectedConv: { id: 'c1', connectionId: 'conn-1', title: 'Old Title', createdAt: '', updatedAt: '' },
    });

    (tauri.agentRenameConversation as any).mockResolvedValue(undefined);

    const success = await useConversationHistoryStore.getState().confirmRename('c1', 'New Title');
    expect(success).toBe(true);
    expect(tauri.agentRenameConversation).toHaveBeenCalledWith('c1', 'New Title');

    const state = useConversationHistoryStore.getState();
    expect(state.conversationsByConn['conn-1'][0].title).toBe('New Title');
    expect(state.searchResults[0].title).toBe('New Title');
    expect(state.selectedConv?.title).toBe('New Title');
  });

  it('deletes conversation and removes from history state', async () => {
    useConversationHistoryStore.setState({
      conversationsByConn: {
        'conn-1': [
          { id: 'c1', connectionId: 'conn-1', title: 'Conv 1', createdAt: '', updatedAt: '' },
          { id: 'c2', connectionId: 'conn-1', title: 'Conv 2', createdAt: '', updatedAt: '' },
        ],
      },
      searchResults: [
        {
          conversationId: 'c1',
          connectionId: 'conn-1',
          title: 'Conv 1',
          matchedSnippet: '',
          matchCount: 1,
          matchedMessageIds: ['m1'],
          updatedAt: '',
        },
      ],
      selectedConvId: 'c1',
      selectedConv: { id: 'c1', connectionId: 'conn-1', title: 'Conv 1', createdAt: '', updatedAt: '' },
      messages: [{ id: 'm1', role: 'user', content: 'test', timestamp: '' }],
    });

    (tauri.agentDeleteConversation as any).mockResolvedValue(undefined);

    await useConversationHistoryStore.getState().deleteConversation('c1');

    const state = useConversationHistoryStore.getState();
    expect(state.conversationsByConn['conn-1']).toHaveLength(1);
    expect(state.conversationsByConn['conn-1'][0].id).toBe('c2');
    expect(state.searchResults).toHaveLength(0);
    expect(state.selectedConvId).toBeNull();
    expect(state.messages).toEqual([]);
  });

  it('correctly groups search results and formats match label', () => {
    const connNames = new Map([
      ['conn-1', 'Server Alpha'],
      ['conn-2', 'Server Beta'],
    ]);

    const results: ConversationSearchResult[] = [
      {
        conversationId: 'c1',
        connectionId: 'conn-1',
        title: 'Title 1',
        matchedSnippet: 'snippet 1',
        matchCount: 5,
        matchedMessageIds: ['m1'],
        updatedAt: '2026-01-01',
      },
      {
        conversationId: 'c2',
        connectionId: 'conn-1',
        title: 'Title 2',
        matchedSnippet: 'snippet 2',
        matchCount: 2,
        matchedMessageIds: ['m2'],
        updatedAt: '2026-01-01',
      },
      {
        conversationId: 'c3',
        connectionId: 'conn-2',
        title: 'Title 3',
        matchedSnippet: 'snippet 3',
        matchCount: 250,
        matchedMessageIds: ['m3'],
        updatedAt: '2026-01-01',
      },
    ];

    const grouped = groupSearchResultsByConnection(results, connNames);
    expect(grouped).toHaveLength(2);
    expect(grouped[0].connectionId).toBe('conn-1');
    expect(grouped[0].label).toBe('Server Alpha');
    expect(grouped[0].items).toHaveLength(2);

    expect(grouped[1].connectionId).toBe('conn-2');
    expect(grouped[1].label).toBe('Server Beta');
    expect(grouped[1].items).toHaveLength(1);

    expect(formatMatchCountLabel(5)).toBe('共 5 条匹配');
    expect(formatMatchCountLabel(250)).toBe('共 200+ 条匹配');
  });
});
