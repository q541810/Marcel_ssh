import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import type { AgentMessage } from '@/lib/types';

const { agentListConversationsByConnection, agentLoadConversation, agentTruncateConversation } = vi.hoisted(() => ({
  agentListConversationsByConnection: vi.fn(),
  agentLoadConversation: vi.fn(),
  agentTruncateConversation: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  agentListConversationsByConnection,
  agentLoadConversation,
  agentTruncateConversation,
}));

describe('conversationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useConversationStore.setState({
      conversations: {},
      messages: {},
      activeConversationId: null,
    });
  });

  function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
    return {
      id: crypto.randomUUID ? crypto.randomUUID() : 'msg-' + Date.now(),
      role: 'user',
      content: 'hello',
      timestamp: new Date().toISOString(),
      ...overrides,
    };
  }

  it('has correct initial state', () => {
    const state = useConversationStore.getState();
    expect(state.activeConversationId).toBeNull();
    expect(Object.keys(state.conversations)).toHaveLength(0);
    expect(Object.keys(state.messages)).toHaveLength(0);
  });

  it('addMessage does nothing without active conversation', () => {
    useConversationStore.getState().addMessage(makeMessage());
    expect(Object.keys(useConversationStore.getState().messages)).toHaveLength(0);
  });

  it('addMessage appends to active conversation', () => {
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: { 'conv-1': [] },
    });

    useConversationStore.getState().addMessage(makeMessage({ content: 'first' }));
    useConversationStore.getState().addMessage(makeMessage({ content: 'second' }));

    const msgs = useConversationStore.getState().messages['conv-1'];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('first');
    expect(msgs[1].content).toBe('second');
  });

  it('clearMessages clears active conversation messages', () => {
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: { 'conv-1': [makeMessage(), makeMessage()], 'conv-2': [makeMessage()] },
    });

    useConversationStore.getState().clearMessages();

    expect(useConversationStore.getState().messages['conv-1']).toHaveLength(0);
    expect(useConversationStore.getState().messages['conv-2']).toHaveLength(1);
  });

  it('getCurrentMessages returns active messages', () => {
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: { 'conv-1': [makeMessage({ content: 'a' }), makeMessage({ content: 'b' })] },
    });

    expect(useConversationStore.getState().getCurrentMessages()).toHaveLength(2);
  });

  it('getCurrentMessages returns empty when no active conversation', () => {
    expect(useConversationStore.getState().getCurrentMessages()).toEqual([]);
  });

  it('clearConnectionConversations removes matching conversations', () => {
    useConversationStore.setState({
      conversations: {
        'c1': { id: 'c1', connectionId: 'conn-a', title: 'A1', createdAt: '', updatedAt: '' },
        'c2': { id: 'c2', connectionId: 'conn-a', title: 'A2', createdAt: '', updatedAt: '' },
        'c3': { id: 'c3', connectionId: 'conn-b', title: 'B1', createdAt: '', updatedAt: '' },
      },
      messages: {
        'c1': [makeMessage()],
        'c2': [makeMessage()],
        'c3': [makeMessage()],
      },
      activeConversationId: 'c2',
    });

    useConversationStore.getState().clearConnectionConversations('conn-a');

    const state = useConversationStore.getState();
    expect(Object.keys(state.conversations)).toHaveLength(1);
    expect(state.conversations['c3']).toBeDefined();
    expect(state.messages['c3']).toBeDefined();
    expect(state.messages['c1']).toBeUndefined();
    expect(state.messages['c2']).toBeUndefined();
  });

  it('clearConnectionConversations resets active when removed', () => {
    useConversationStore.setState({
      conversations: {
        'c1': { id: 'c1', connectionId: 'conn-a', title: 'A', createdAt: '', updatedAt: '' },
        'c2': { id: 'c2', connectionId: 'conn-a', title: 'B', createdAt: '', updatedAt: '' },
      },
      messages: { 'c1': [], 'c2': [] },
      activeConversationId: 'c1',
    });

    useConversationStore.getState().clearConnectionConversations('conn-a');

    // Active was c1 which got removed; should be null since nothing left
    expect(useConversationStore.getState().activeConversationId).toBeNull();
  });

  it('loads messages for the restored latest conversation', async () => {
    agentListConversationsByConnection.mockResolvedValue([
      { id: 'latest', connectionId: 'conn-a', title: 'Latest', createdAt: '', updatedAt: '2026-01-02T00:00:00Z' },
      { id: 'older', connectionId: 'conn-a', title: 'Older', createdAt: '', updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    agentLoadConversation.mockResolvedValue([
      {
        id: 'msg-1',
        conversationId: 'latest',
        role: 'user',
        content: 'previous message',
        timestamp: '2026-01-02T00:00:00Z',
        createdAt: '2026-01-02T00:00:00Z',
      },
    ]);

    await useConversationStore.getState().loadConnectionConversations('conn-a');

    const state = useConversationStore.getState();
    expect(state.activeConversationId).toBe('latest');
    expect(state.messages.latest).toHaveLength(1);
    expect(state.messages.latest[0].content).toBe('previous message');
    expect(agentLoadConversation).toHaveBeenCalledWith('latest');
  });

  it('rolls back a user message and deletes it plus later messages', async () => {
    agentTruncateConversation.mockResolvedValue(3);
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: {
        'conv-1': [
          makeMessage({ id: 'm1', role: 'user', content: 'keep', timestamp: '2026-01-01T00:00:00Z' }),
          makeMessage({ id: 'm2', role: 'user', content: 'rewrite me', timestamp: '2026-01-01T00:01:00Z' }),
          makeMessage({ id: 'm3', role: 'assistant', content: 'answer', timestamp: '2026-01-01T00:02:00Z' }),
          makeMessage({ id: 'm4', role: 'tool', content: 'tool output', timestamp: '2026-01-01T00:03:00Z' }),
        ],
      },
    });

    const result = await useConversationStore.getState().rollbackToMessage('conv-1', 'm2');

    expect(result).toEqual({ prompt: 'rewrite me', removedCount: 3 });
    expect(agentTruncateConversation).toHaveBeenCalledWith('conv-1', '2026-01-01T00:01:00Z');
    expect(useConversationStore.getState().messages['conv-1'].map((m) => m.id)).toEqual(['m1']);
  });

  it('rejects rollback for non-user messages', async () => {
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: {
        'conv-1': [makeMessage({ id: 'm1', role: 'assistant', content: 'answer' })],
      },
    });

    await expect(useConversationStore.getState().rollbackToMessage('conv-1', 'm1')).rejects.toThrow('只能撤回用户消息');
    expect(agentTruncateConversation).not.toHaveBeenCalled();
  });

  it('does not mutate messages when persistent rollback fails', async () => {
    agentTruncateConversation.mockRejectedValue(new Error('db failed'));
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: {
        'conv-1': [
          makeMessage({ id: 'm1', role: 'user', content: 'rewrite me', timestamp: '2026-01-01T00:01:00Z' }),
          makeMessage({ id: 'm2', role: 'assistant', content: 'answer', timestamp: '2026-01-01T00:02:00Z' }),
        ],
      },
    });

    await expect(useConversationStore.getState().rollbackToMessage('conv-1', 'm1')).rejects.toThrow('db failed');
    expect(useConversationStore.getState().messages['conv-1'].map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  describe('clearExecutingToolFlags', () => {
    it('clears isExecuting on tool messages across all conversations', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({ id: 'm1', role: 'user', content: 'hi' }),
            makeMessage({ id: 'm2', role: 'tool', content: 'running', isExecuting: true }),
          ],
          'conv-2': [
            makeMessage({ id: 'm3', role: 'tool', content: 'also running', isExecuting: true }),
          ],
        },
      });

      useConversationStore.getState().clearExecutingToolFlags();

      const state = useConversationStore.getState();
      expect(state.messages['conv-1'][0].isExecuting).toBeUndefined();
      expect(state.messages['conv-1'][1].isExecuting).toBe(false);
      expect(state.messages['conv-2'][0].isExecuting).toBe(false);
    });

    it('leaves completed tool messages untouched', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({ id: 'm1', role: 'tool', content: 'done', isExecuting: false }),
          ],
        },
      });

      useConversationStore.getState().clearExecutingToolFlags();

      const state = useConversationStore.getState();
      expect(state.messages['conv-1'][0].isExecuting).toBe(false);
    });

    it('clears modelApproval on tool messages', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({ id: 'm1', role: 'tool', content: 'checking', modelApproval: { status: 'checking' } }),
            makeMessage({ id: 'm2', role: 'tool', content: 'block', modelApproval: { status: 'done', decision: 'block', reasons: ['x'] } }),
            makeMessage({ id: 'm3', role: 'tool', content: 'clean' }),
          ],
        },
      });

      useConversationStore.getState().clearExecutingToolFlags();

      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs[0].modelApproval).toBeUndefined();
      expect(msgs[1].modelApproval).toBeUndefined();
      expect(msgs[2].modelApproval).toBeUndefined();
    });

    it('does not touch non-tool messages', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({ id: 'm1', role: 'user', content: 'hi' }),
            makeMessage({ id: 'm2', role: 'assistant', content: 'reply', isLoading: true }),
          ],
        },
      });

      useConversationStore.getState().clearExecutingToolFlags();

      const state = useConversationStore.getState();
      expect(state.messages['conv-1'][0].isLoading).toBeUndefined();
      expect(state.messages['conv-1'][1].isLoading).toBe(true);
    });
  });
});
