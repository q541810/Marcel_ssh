import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { AgentMessage, AgentTask } from '@/lib/types';

const {
  agentListConversationsByConnection,
  agentLoadConversation,
  agentTruncateConversation,
  agentLoadPlansByConversation,
  agentCreateConversation,
  agentDeleteConversation,
  agentGetConversation,
} = vi.hoisted(() => ({
  agentListConversationsByConnection: vi.fn(),
  agentLoadConversation: vi.fn(),
  agentTruncateConversation: vi.fn(),
  agentLoadPlansByConversation: vi.fn(),
  agentCreateConversation: vi.fn(),
  agentDeleteConversation: vi.fn(),
  agentGetConversation: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  agentListConversationsByConnection,
  agentLoadConversation,
  agentTruncateConversation,
  agentLoadPlansByConversation,
  agentCreateConversation,
  agentDeleteConversation,
  agentGetConversation,
}));

describe('conversationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentLoadPlansByConversation.mockResolvedValue([]);
    useConversationStore.setState({
      conversations: {},
      messages: {},
      activeConversationId: null,
      activeConversationByConnection: {},
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

  it('loadConnectionConversations does not keep active from another connection', async () => {
    agentListConversationsByConnection.mockResolvedValue([
      { id: 'b1', connectionId: 'conn-b', title: 'B', createdAt: '', updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    agentLoadConversation.mockResolvedValue([]);
    useConversationStore.setState({
      conversations: {
        a1: { id: 'a1', connectionId: 'conn-a', title: 'A', createdAt: '', updatedAt: '' },
      },
      messages: { a1: [makeMessage({ content: 'on A' })] },
      activeConversationId: 'a1',
      activeConversationByConnection: { 'conn-a': 'a1' },
    });

    await useConversationStore.getState().loadConnectionConversations('conn-b');

    const state = useConversationStore.getState();
    // load 合并列表但不抢 active（仍在 conn-a）
    expect(state.activeConversationId).toBe('a1');
    expect(state.conversations.b1).toBeDefined();
    expect(state.activeConversationByConnection['conn-b']).toBe('b1');
    expect(agentLoadConversation).not.toHaveBeenCalled();
  });

  it('syncActiveToConnection switches active conversation to target connection', async () => {
    agentListConversationsByConnection.mockResolvedValue([
      { id: 'b1', connectionId: 'conn-b', title: 'B', createdAt: '', updatedAt: '2026-01-02T00:00:00Z' },
    ]);
    agentLoadConversation.mockResolvedValue([
      {
        id: 'msg-b',
        conversationId: 'b1',
        role: 'user',
        content: 'on B',
        timestamp: '2026-01-02T00:00:00Z',
        createdAt: '2026-01-02T00:00:00Z',
      },
    ]);
    useConversationStore.setState({
      conversations: {
        a1: { id: 'a1', connectionId: 'conn-a', title: 'A', createdAt: '', updatedAt: '' },
      },
      messages: { a1: [makeMessage({ content: 'on A' })] },
      activeConversationId: 'a1',
      activeConversationByConnection: { 'conn-a': 'a1' },
    });

    await useConversationStore.getState().syncActiveToConnection('conn-b');

    const state = useConversationStore.getState();
    expect(state.activeConversationId).toBe('b1');
    expect(state.messages.b1?.[0]?.content).toBe('on B');
    expect(state.activeConversationByConnection['conn-b']).toBe('b1');
  });

  it('syncActiveToConnection restores remembered conversation for connection', async () => {
    agentListConversationsByConnection.mockResolvedValue([
      { id: 'b-new', connectionId: 'conn-b', title: 'newer', createdAt: '', updatedAt: '2026-01-03T00:00:00Z' },
      { id: 'b-old', connectionId: 'conn-b', title: 'older', createdAt: '', updatedAt: '2026-01-01T00:00:00Z' },
    ]);
    agentLoadConversation.mockResolvedValue([]);
    useConversationStore.setState({
      conversations: {
        a1: { id: 'a1', connectionId: 'conn-a', title: 'A', createdAt: '', updatedAt: '' },
        'b-old': { id: 'b-old', connectionId: 'conn-b', title: 'older', createdAt: '', updatedAt: '2026-01-01T00:00:00Z' },
        'b-new': { id: 'b-new', connectionId: 'conn-b', title: 'newer', createdAt: '', updatedAt: '2026-01-03T00:00:00Z' },
      },
      messages: {
        a1: [makeMessage({ content: 'A' })],
        'b-old': [makeMessage({ content: 'remembered B' })],
        'b-new': [makeMessage({ content: 'latest B' })],
      },
      activeConversationId: 'a1',
      activeConversationByConnection: { 'conn-a': 'a1', 'conn-b': 'b-old' },
    });

    await useConversationStore.getState().syncActiveToConnection('conn-b');

    expect(useConversationStore.getState().activeConversationId).toBe('b-old');
  });

  it('ensureConversation does not reuse active conversation from another connection', async () => {
    agentCreateConversation.mockResolvedValue('b-new');
    useConversationStore.setState({
      conversations: {
        a1: { id: 'a1', connectionId: 'conn-a', title: 'A', createdAt: '', updatedAt: '' },
      },
      messages: { a1: [] },
      activeConversationId: 'a1',
      activeConversationByConnection: { 'conn-a': 'a1' },
    });

    const id = await useConversationStore.getState().ensureConversation('sess-b', 'conn-b', 'hello on B');

    expect(id).toBe('b-new');
    expect(agentCreateConversation).toHaveBeenCalledWith('sess-b', 'hello on B');
    expect(useConversationStore.getState().activeConversationId).toBe('b-new');
    expect(useConversationStore.getState().conversations['b-new']?.connectionId).toBe('conn-b');
  });

  it('ensureConversation reuses matching conversation on same connection', async () => {
    useConversationStore.setState({
      conversations: {
        b1: { id: 'b1', connectionId: 'conn-b', title: 'B', createdAt: '', updatedAt: '' },
      },
      messages: { b1: [] },
      activeConversationId: 'b1',
      activeConversationByConnection: { 'conn-b': 'b1' },
    });

    const id = await useConversationStore.getState().ensureConversation('sess-b', 'conn-b', 'hello');

    expect(id).toBe('b1');
    expect(agentCreateConversation).not.toHaveBeenCalled();
  });

  it('rolls back a user message and deletes it plus later messages', async () => {
    agentTruncateConversation.mockResolvedValue({
      deletedMessages: 3,
      planAdjusted: false,
      plan: null,
      planTaskId: null,
    });
    useConversationStore.setState({
      activeConversationId: 'conv-1',
      messages: {
        'conv-1': [
          makeMessage({ id: 'm1', role: 'user', content: 'keep', timestamp: '2026-01-01T00:00:00Z' }),
          makeMessage({
            id: 'm2',
            role: 'user',
            content: 'rewrite me',
            timestamp: '2026-01-01T00:01:00Z',
            imagePaths: ['conv-1/m2_0.webp'],
          }),
          makeMessage({ id: 'm3', role: 'assistant', content: 'answer', timestamp: '2026-01-01T00:02:00Z' }),
          makeMessage({ id: 'm4', role: 'tool', content: 'tool output', timestamp: '2026-01-01T00:03:00Z' }),
        ],
      },
    });

    const result = await useConversationStore.getState().rollbackToMessage('conv-1', 'm2');

    expect(result).toEqual({
      prompt: 'rewrite me',
      removedCount: 3,
      imagePaths: ['conv-1/m2_0.webp'],
    });
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

  describe('markAbortedToolFlags', () => {
    it('marks executing streaming tool messages with wasAborted and streaming note', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({
              id: 'm1',
              role: 'tool',
              content: '',
              isExecuting: true,
              toolResult: {
                toolName: 'execute_command',
                summary: '',
                result: 'partial stdout',
                success: true,
                blocked: false,
              },
            }),
          ],
        },
      });

      useConversationStore.getState().markAbortedToolFlags();

      const m = useConversationStore.getState().messages['conv-1'][0];
      expect(m.isExecuting).toBe(false);
      expect(m.toolResult?.wasAborted).toBe(true);
      expect(m.toolResult?.success).toBe(false);
      expect(m.toolResult?.result).toContain('partial stdout');
      expect(m.toolResult?.result).toContain('用户手动中断');
      expect(m.toolResult?.result).toContain('远端命令');
    });

    it('marks executing non-streaming tool messages with non-streaming note', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({
              id: 'm2',
              role: 'tool',
              content: '',
              isExecuting: true,
              toolResult: {
                toolName: 'read_file',
                summary: '',
                result: '',
                success: true,
                blocked: false,
              },
            }),
          ],
        },
      });

      useConversationStore.getState().markAbortedToolFlags();

      const m = useConversationStore.getState().messages['conv-1'][0];
      expect(m.toolResult?.wasAborted).toBe(true);
      expect(m.toolResult?.success).toBe(false);
      expect(m.toolResult?.result).toContain('用户手动中断');
      expect(m.toolResult?.result).toContain('工具可能已执行完成');
      expect(m.toolResult?.result).not.toContain('远端命令');
    });

    it('clears modelApproval in addition to isExecuting', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({
              id: 'm3',
              role: 'tool',
              content: '',
              isExecuting: false,
              modelApproval: { status: 'checking' },
              toolResult: {
                toolName: 'execute_command',
                summary: '',
                result: '',
                success: true,
                blocked: false,
              },
            }),
          ],
        },
      });

      useConversationStore.getState().markAbortedToolFlags();

      const m = useConversationStore.getState().messages['conv-1'][0];
      expect(m.modelApproval).toBeUndefined();
      expect(m.toolResult?.wasAborted).toBe(true);
    });

    it('leaves completed tool messages untouched', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({ id: 'm4', role: 'tool', content: 'done', isExecuting: false, toolResult: { toolName: 'list_directory', summary: '', result: 'a\nb', success: true, blocked: false } }),
          ],
        },
      });

      useConversationStore.getState().markAbortedToolFlags();

      const m = useConversationStore.getState().messages['conv-1'][0];
      expect(m.toolResult?.wasAborted).toBeUndefined();
      expect(m.toolResult?.result).toBe('a\nb');
    });

    it('handles tool messages without toolResult without crashing', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({ id: 'm5', role: 'tool', content: 'running', isExecuting: true }),
          ],
        },
      });

      useConversationStore.getState().markAbortedToolFlags();

      const m = useConversationStore.getState().messages['conv-1'][0];
      expect(m.isExecuting).toBe(false);
      // No toolResult so wasAborted can't be set; just no crash
    });

    it('only marks cards in the targeted conversation when conversationId is passed', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({
              id: 'm6',
              role: 'tool',
              content: '',
              isExecuting: true,
              toolResult: { toolName: 'execute_command', summary: '', result: '', success: true, blocked: false },
            }),
          ],
          'conv-2': [
            makeMessage({
              id: 'm7',
              role: 'tool',
              content: '',
              isExecuting: true,
              toolResult: { toolName: 'execute_command', summary: '', result: '', success: true, blocked: false },
            }),
          ],
        },
      });

      useConversationStore.getState().markAbortedToolFlags('conv-1');

      const m1 = useConversationStore.getState().messages['conv-1'][0];
      expect(m1.toolResult?.wasAborted).toBe(true);
      const m2 = useConversationStore.getState().messages['conv-2'][0];
      expect(m2.toolResult?.wasAborted).toBeUndefined();
      expect(m2.isExecuting).toBe(true);
    });

    it('keeps other conversations intact when conversationId is passed', () => {
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            makeMessage({ id: 'm8', role: 'tool', content: '', isExecuting: true }),
          ],
          'conv-2': [
            makeMessage({ id: 'm9', role: 'assistant', content: 'hi', isLoading: true }),
          ],
        },
      });

      useConversationStore.getState().markAbortedToolFlags('conv-1');

      const m2 = useConversationStore.getState().messages['conv-2'][0];
      expect(m2.isLoading).toBe(true);
    });
  });

  describe('switchConversation with running tasks', () => {
    const now = new Date().toISOString();

    function seedConversation(convId: string, msgs: AgentMessage[]) {
      useConversationStore.setState({
        conversations: {
          [convId]: {
            id: convId,
            connectionId: 'conn-1',
            title: convId,
            createdAt: now,
            updatedAt: now,
          },
        },
        messages: { [convId]: msgs },
        activeConversationId: convId,
        activeConversationByConnection: { 'conn-1': convId },
      });
    }

    function seedTask(taskId: string, convId: string, status: AgentTask['status']) {
      useTaskStore.setState({
        tasks: {
          [taskId]: {
            id: taskId,
            sessionId: 's1',
            conversationId: convId,
            prompt: 'p',
            mode: 'agent',
            status,
            createdAt: now,
          },
        },
        activeTaskId: taskId,
      });
    }

    it('keeps in-memory messages and restores the running task (no DB reload)', async () => {
      agentLoadConversation.mockResolvedValue([
        { id: 'db-msg', conversationId: 'conv-1', role: 'user', content: 'from-db', timestamp: now, createdAt: now },
      ]);
      agentLoadPlansByConversation.mockResolvedValue([]);
      const memoryMsg = makeMessage({ id: 'mem-msg', content: 'in-memory' });
      seedConversation('conv-1', [memoryMsg]);
      seedTask('task-1', 'conv-1', 'executing');

      await useConversationStore.getState().switchConversation('conv-1');

      // 运行中：不重载 DB，内存消息保留
      expect(agentLoadConversation).not.toHaveBeenCalled();
      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe('mem-msg');
      // 运行中任务恢复为 activeTaskId（停止按钮 / isRunning 可用）
      expect(useTaskStore.getState().activeTaskId).toBe('task-1');
    });

    it('reloads from DB and clears active task when no task is running', async () => {
      agentLoadConversation.mockResolvedValue([
        { id: 'db-msg', conversationId: 'conv-1', role: 'user', content: 'from-db', timestamp: now, createdAt: now },
      ]);
      agentLoadPlansByConversation.mockResolvedValue([]);
      seedConversation('conv-1', [makeMessage({ id: 'mem-msg', content: 'stale' })]);
      seedTask('task-1', 'conv-1', 'completed');

      await useConversationStore.getState().switchConversation('conv-1');

      expect(agentLoadConversation).toHaveBeenCalledWith('conv-1');
      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe('from-db');
      // 无运行中任务 → activeTaskId 清空
      expect(useTaskStore.getState().activeTaskId).toBeNull();
    });

    it('subagent (plan-mode) running task is restored after switching to its conversation', async () => {
      agentLoadConversation.mockResolvedValue([]);
      agentLoadPlansByConversation.mockResolvedValue([]);
      seedConversation('sub-conv-1', [makeMessage({ id: 'skel' })]);
      useTaskStore.setState({
        tasks: {
          'parent-1': {
            id: 'parent-1',
            sessionId: 's1',
            conversationId: 'conv-1',
            prompt: 'p',
            mode: 'agent',
            status: 'executing',
            createdAt: now,
          },
          'sub-1': {
            id: 'sub-1',
            sessionId: 's1',
            conversationId: 'sub-conv-1',
            prompt: 'p',
            mode: 'plan',
            status: 'planning',
            createdAt: now,
            parentTaskId: 'parent-1',
          },
        },
        activeTaskId: 'parent-1',
      });

      await useConversationStore.getState().switchConversation('sub-conv-1');

      // 切到子对话：恢复子任务为 activeTaskId（而不是清空）
      expect(useTaskStore.getState().activeTaskId).toBe('sub-1');
      // 子对话运行中也不重载
      expect(agentLoadConversation).not.toHaveBeenCalled();
    });

    it('loadConversation behaves the same for running conversations', async () => {
      agentLoadConversation.mockResolvedValue([
        { id: 'db-msg', conversationId: 'conv-1', role: 'user', content: 'from-db', timestamp: now, createdAt: now },
      ]);
      agentLoadPlansByConversation.mockResolvedValue([]);
      seedConversation('conv-1', [makeMessage({ id: 'mem-msg' })]);
      seedTask('task-1', 'conv-1', 'waiting_approval');

      await useConversationStore.getState().loadConversation('conv-1');

      expect(agentLoadConversation).not.toHaveBeenCalled();
      expect(useConversationStore.getState().messages['conv-1'][0].id).toBe('mem-msg');
      expect(useTaskStore.getState().activeTaskId).toBe('task-1');
    });
  });

  describe('registerSubConversation', () => {
    it('registers a sub-conversation with skeleton messages and parent link', () => {
      useConversationStore.setState({
        conversations: {},
        messages: {},
        activeConversationId: null,
      });

      const loadingId = useConversationStore.getState().registerSubConversation(
        'sub-conv-1',
        'conn-1',
        'explore nginx（子agent）',
        'sub-task-1',
        'look at /etc/nginx',
        'main-conv-1',
      );

      const state = useConversationStore.getState();
      expect(loadingId).toBe('sub-loading-sub-task-1');
      expect(state.conversations['sub-conv-1']).toMatchObject({
        id: 'sub-conv-1',
        connectionId: 'conn-1',
        title: 'explore nginx（子agent）',
        parentConversationId: 'main-conv-1',
      });
      const msgs = state.messages['sub-conv-1'];
      expect(msgs).toHaveLength(2);
      expect(msgs[0]).toMatchObject({ role: 'user', content: 'look at /etc/nginx' });
      expect(msgs[1]).toMatchObject({ role: 'assistant', isLoading: true, id: loadingId });
    });

    it('is idempotent: returns null and keeps existing messages when already registered', () => {
      useConversationStore.setState({
        conversations: {},
        messages: {},
        activeConversationId: null,
      });
      const first = useConversationStore.getState().registerSubConversation(
        'sub-conv-1',
        'conn-1',
        't',
        'sub-task-1',
        'prompt',
        'main-conv-1',
      );
      expect(first).not.toBeNull();

      const second = useConversationStore.getState().registerSubConversation(
        'sub-conv-1',
        'conn-1',
        't',
        'sub-task-1',
        'prompt',
        'main-conv-1',
      );
      expect(second).toBeNull();
      expect(useConversationStore.getState().messages['sub-conv-1']).toHaveLength(2);
    });

    it('does not touch the active conversation', () => {
      useConversationStore.setState({
        conversations: {},
        messages: {},
        activeConversationId: 'main-conv',
      });

      useConversationStore.getState().registerSubConversation(
        'sub-conv-2',
        'conn-1',
        't',
        'sub-task-2',
        'prompt',
        'main-conv',
      );

      const state = useConversationStore.getState();
      expect(state.activeConversationId).toBe('main-conv');
      expect(state.messages['main-conv']).toBeUndefined();
    });
  });

  describe('deleteConversation cascade', () => {
    it('deletes the conversation and all its sub-conversations from the store', async () => {
      agentDeleteConversation.mockResolvedValue(undefined);
      const now = new Date().toISOString();
      useConversationStore.setState({
        activeConversationId: 'main-conv',
        conversations: {
          'main-conv': {
            id: 'main-conv',
            connectionId: 'conn-1',
            title: 'Main',
            createdAt: now,
            updatedAt: now,
          },
          'sub-conv-1': {
            id: 'sub-conv-1',
            connectionId: 'conn-1',
            title: 'Sub1（子agent）',
            createdAt: now,
            updatedAt: now,
            parentConversationId: 'main-conv',
          },
          'sub-conv-2': {
            id: 'sub-conv-2',
            connectionId: 'conn-1',
            title: 'Sub2（子agent）',
            createdAt: now,
            updatedAt: now,
            parentConversationId: 'main-conv',
          },
          'other-conv': {
            id: 'other-conv',
            connectionId: 'conn-1',
            title: 'Other',
            createdAt: now,
            updatedAt: now,
          },
        },
        messages: {
          'main-conv': [makeMessage({ id: 'm1' })],
          'sub-conv-1': [makeMessage({ id: 'm2' })],
        },
      });

      await useConversationStore.getState().deleteConversation('main-conv');

      const state = useConversationStore.getState();
      expect(state.conversations['main-conv']).toBeUndefined();
      expect(state.conversations['sub-conv-1']).toBeUndefined();
      expect(state.conversations['sub-conv-2']).toBeUndefined();
      expect(state.conversations['other-conv']).toBeDefined();
      expect(state.messages['main-conv']).toBeUndefined();
      expect(state.messages['sub-conv-1']).toBeUndefined();
      // active 被删除 → 切换到其他主对话
      expect(state.activeConversationId).toBe('other-conv');
    });

    it('keeps parent when deleting a sub-conversation only', async () => {
      agentDeleteConversation.mockResolvedValue(undefined);
      const now = new Date().toISOString();
      useConversationStore.setState({
        activeConversationId: 'main-conv',
        conversations: {
          'main-conv': {
            id: 'main-conv',
            connectionId: 'conn-1',
            title: 'Main',
            createdAt: now,
            updatedAt: now,
          },
          'sub-conv-1': {
            id: 'sub-conv-1',
            connectionId: 'conn-1',
            title: 'Sub1（子agent）',
            createdAt: now,
            updatedAt: now,
            parentConversationId: 'main-conv',
          },
        },
        messages: {},
      });

      await useConversationStore.getState().deleteConversation('sub-conv-1');

      const state = useConversationStore.getState();
      expect(state.conversations['sub-conv-1']).toBeUndefined();
      expect(state.conversations['main-conv']).toBeDefined();
      expect(state.activeConversationId).toBe('main-conv');
    });
  });

  describe('buildLlmHistory', () => {
    it('returns empty array for unknown conversation', () => {
      useConversationStore.setState({ messages: {}, activeConversationId: null });
      const history = useConversationStore.getState().buildLlmHistory('nonexistent');
      expect(history).toEqual([]);
    });

    it('returns plain user+assistant conversation unchanged', () => {
      useConversationStore.setState({
        messages: {
          'conv-1': [
            makeMessage({ id: 'm1', role: 'user', content: 'hello' }),
            makeMessage({ id: 'm2', role: 'assistant', content: 'hi there', reasoningContent: 'thought' }),
            makeMessage({ id: 'm3', role: 'user', content: 'what is 2+2?' }),
            makeMessage({ id: 'm4', role: 'assistant', content: '4' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-1');
      expect(history).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there', reasoningContent: 'thought' },
        { role: 'user', content: 'what is 2+2?' },
        { role: 'assistant', content: '4' },
      ]);
    });

    it('excludes loading messages', () => {
      useConversationStore.setState({
        messages: {
          'conv-2': [
            makeMessage({ id: 'm1', role: 'user', content: 'run task' }),
            makeMessage({ id: 'm2', role: 'assistant', content: '', isLoading: true }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-2');
      expect(history).toEqual([{ role: 'user', content: 'run task' }]);
    });

    it('excludes system messages', () => {
      useConversationStore.setState({
        messages: {
          'conv-3': [
            makeMessage({ id: 'm1', role: 'user', content: 'hi' }),
            makeMessage({ id: 'm2', role: 'system', content: 'retrying...' }),
            makeMessage({ id: 'm3', role: 'assistant', content: 'answer' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-3');
      expect(history).toEqual([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'answer' },
      ]);
    });

    it('synthesizes assistant(tool_calls)+tool from tool message with preceding assistant text', () => {
      useConversationStore.setState({
        messages: {
          'conv-4': [
            makeMessage({ id: 'm1', role: 'user', content: 'list files' }),
            makeMessage({ id: 'm2', role: 'assistant', content: 'Let me check the directory...' }),
            makeMessage({
              id: 'm3',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'execute_command',
                summary: '$ ls',
                result: 'file.txt\ndir/',
                success: true,
                blocked: false,
                arguments: { command: 'ls' },
                toolCallId: 'call-1',
              },
            }),
            makeMessage({ id: 'm4', role: 'assistant', content: 'Found 2 items.' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-4');
      expect(history).toEqual([
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: 'Let me check the directory...',
          toolCalls: [{ id: 'call-1', name: 'execute_command', arguments: { command: 'ls' } }],
        },
        { role: 'tool', content: 'file.txt\ndir/', toolCallId: 'call-1' },
        { role: 'assistant', content: 'Found 2 items.' },
      ]);
    });

    it('synthesizes with empty content when no preceding assistant', () => {
      useConversationStore.setState({
        messages: {
          'conv-5': [
            makeMessage({ id: 'm1', role: 'user', content: 'do thing' }),
            makeMessage({
              id: 'm2',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'read_file',
                summary: 'done',
                result: 'content here',
                success: true,
                blocked: false,
                arguments: { path: '/tmp/x' },
                toolCallId: 'call-2',
              },
            }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-5');
      expect(history).toEqual([
        { role: 'user', content: 'do thing' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call-2', name: 'read_file', arguments: { path: '/tmp/x' } }],
        },
        { role: 'tool', content: 'content here', toolCallId: 'call-2' },
      ]);
    });

    it('skips tool message without toolCallId', () => {
      useConversationStore.setState({
        messages: {
          'conv-6': [
            makeMessage({ id: 'm1', role: 'user', content: 'do' }),
            makeMessage({
              id: 'm2',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'old_tool',
                summary: '',
                result: 'legacy',
                success: true,
                blocked: false,
              },
            }),
            makeMessage({ id: 'm3', role: 'assistant', content: 'done' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-6');
      expect(history).toEqual([
        { role: 'user', content: 'do' },
        { role: 'assistant', content: 'done' },
      ]);
    });

    it('handles multiple tool calls in one conversation', () => {
      useConversationStore.setState({
        messages: {
          'conv-7': [
            makeMessage({ id: 'm1', role: 'user', content: 'check files' }),
            makeMessage({ id: 'm2', role: 'assistant', content: 'Checking...' }),
            makeMessage({
              id: 'm3',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'execute_command',
                summary: '$ ls',
                result: 'a.txt\nb.txt',
                success: true,
                blocked: false,
                arguments: { command: 'ls' },
                toolCallId: 'call-a',
              },
            }),
            makeMessage({ id: 'm4', role: 'assistant', content: 'Now reading...' }),
            makeMessage({
              id: 'm5',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'read_file',
                summary: 'done',
                result: 'content of a.txt',
                success: true,
                blocked: false,
                arguments: { path: 'a.txt' },
                toolCallId: 'call-b',
              },
            }),
            makeMessage({ id: 'm6', role: 'assistant', content: 'All done!' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-7');
      expect(history).toEqual([
        { role: 'user', content: 'check files' },
        {
          role: 'assistant',
          content: 'Checking...',
          toolCalls: [{ id: 'call-a', name: 'execute_command', arguments: { command: 'ls' } }],
        },
        { role: 'tool', content: 'a.txt\nb.txt', toolCallId: 'call-a' },
        {
          role: 'assistant',
          content: 'Now reading...',
          toolCalls: [{ id: 'call-b', name: 'read_file', arguments: { path: 'a.txt' } }],
        },
        { role: 'tool', content: 'content of a.txt', toolCallId: 'call-b' },
        { role: 'assistant', content: 'All done!' },
      ]);
    });

    it('并行 tool 保留在同一条 assistant（live UI：文案 assistant + 连续 tool）', () => {
      useConversationStore.setState({
        messages: {
          'conv-parallel': [
            makeMessage({ id: 'm1', role: 'user', content: 'check both' }),
            makeMessage({ id: 'm2', role: 'assistant', content: 'Checking...' }),
            makeMessage({
              id: 'm3',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'execute_command',
                summary: '$ ls',
                result: 'a.txt',
                success: true,
                blocked: false,
                arguments: { command: 'ls' },
                toolCallId: 'call-a',
              },
            }),
            makeMessage({
              id: 'm4',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'read_file',
                summary: 'done',
                result: 'file body',
                success: true,
                blocked: false,
                arguments: { path: 'a.txt' },
                toolCallId: 'call-b',
              },
            }),
            makeMessage({ id: 'm5', role: 'assistant', content: 'Done.' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-parallel');
      expect(history).toEqual([
        { role: 'user', content: 'check both' },
        {
          role: 'assistant',
          content: 'Checking...',
          toolCalls: [
            { id: 'call-a', name: 'execute_command', arguments: { command: 'ls' } },
            { id: 'call-b', name: 'read_file', arguments: { path: 'a.txt' } },
          ],
        },
        { role: 'tool', content: 'a.txt', toolCallId: 'call-a' },
        { role: 'tool', content: 'file body', toolCallId: 'call-b' },
        { role: 'assistant', content: 'Done.' },
      ]);
    });

    it('reload 后使用 assistant.toolCalls，不把并行 tool 拆成多条 assistant', () => {
      useConversationStore.setState({
        messages: {
          'conv-reload': [
            makeMessage({ id: 'm1', role: 'user', content: 'go' }),
            makeMessage({
              id: 'm2',
              role: 'assistant',
              content: 'Running...',
              toolCalls: [
                {
                  id: 'call-a',
                  name: 'execute_command',
                  arguments: { command: 'ls' },
                  riskLevel: 'LowRisk',
                },
                {
                  id: 'call-b',
                  name: 'system_info',
                  arguments: { category: 'os' },
                  riskLevel: 'ReadOnly',
                },
              ],
            }),
            makeMessage({
              id: 'm3',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'execute_command',
                summary: '$ ls',
                result: 'ok',
                success: true,
                blocked: false,
                arguments: { command: 'ls' },
                toolCallId: 'call-a',
              },
            }),
            makeMessage({
              id: 'm4',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'system_info',
                summary: 'system_info os',
                result: 'Linux',
                success: true,
                blocked: false,
                arguments: { category: 'os' },
                toolCallId: 'call-b',
              },
            }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-reload');
      expect(history).toEqual([
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'Running...',
          toolCalls: [
            { id: 'call-a', name: 'execute_command', arguments: { command: 'ls' } },
            { id: 'call-b', name: 'system_info', arguments: { category: 'os' } },
          ],
        },
        { role: 'tool', content: 'ok', toolCallId: 'call-a' },
        { role: 'tool', content: 'Linux', toolCallId: 'call-b' },
      ]);
      // 两个 tool 之间不得再合成一条空 content 的 assistant
      expect(history.filter((m) => m.role === 'assistant')).toHaveLength(1);
    });

    it('uses toolResult.arguments for toolCalls, falling back to empty object', () => {
      useConversationStore.setState({
        messages: {
          'conv-9': [
            makeMessage({ id: 'm1', role: 'user', content: 'go' }),
            makeMessage({ id: 'm2', role: 'assistant', content: 'Running...' }),
            makeMessage({
              id: 'm3',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'web_search',
                summary: 'searched',
                result: 'search results',
                success: true,
                blocked: false,
                toolCallId: 'call-3',
              },
            }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-9');
      expect(history[1].toolCalls![0].arguments).toEqual({});
    });

    it('handles tool with toolResult.result taking precedence over tool message content', () => {
      useConversationStore.setState({
        messages: {
          'conv-10': [
            makeMessage({ id: 'm1', role: 'user', content: 'hi' }),
            makeMessage({
              id: 'm2',
              role: 'tool',
              content: 'stale content',
              toolResult: {
                toolName: 'cmd',
                summary: '',
                result: 'fresh result',
                success: true,
                blocked: false,
                toolCallId: 'call-4',
              },
            }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-10');
      expect(history[1].toolCalls![0].arguments).toEqual({});
      expect(history[2].content).toBe('fresh result');
    });
  });

  describe('buildLlmHistory compression', () => {
    function makeRoundMessages(
      round: number,
      toolResultContent: string,
    ): AgentMessage[] {
      return [
        makeMessage({ id: `u${round}`, role: 'user', content: `prompt ${round}` }),
        makeMessage({ id: `a${round}`, role: 'assistant', content: `Let me check round ${round}...` }),
        makeMessage({
          id: `t${round}`,
          role: 'tool',
          content: '',
          toolResult: {
            toolName: 'execute_command',
            summary: `$ cmd ${round}`,
            result: toolResultContent,
            success: true,
            blocked: false,
            arguments: { command: `ls ${round}` },
            toolCallId: `call-${round}`,
          },
        }),
        makeMessage({ id: `a2-${round}`, role: 'assistant', content: `Result for round ${round} done.` }),
      ];
    }

    function enableCompactContext() {
      const current = useSettingsStore.getState().settings;
      useSettingsStore.setState({
        settings: {
          ...current,
          agentModeSettings: {
            ...current.agentModeSettings,
            compactContext: true,
          },
        },
      });
    }

    function disableCompactContext() {
      const current = useSettingsStore.getState().settings;
      useSettingsStore.setState({
        settings: {
          ...current,
          agentModeSettings: {
            ...current.agentModeSettings,
            compactContext: false,
          },
        },
      });
    }

    it('does not compress when compactContext is off', () => {
      disableCompactContext();
      const manyLines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
      const msgs = [
        ...makeRoundMessages(1, manyLines),
      ];
      useConversationStore.setState({ messages: { 'comp-1': msgs } });

      const history = useConversationStore.getState().buildLlmHistory('comp-1');
      const toolMsg = history.find((m) => m.role === 'tool');
      expect(toolMsg!.content).toBe(manyLines);
      expect(toolMsg!.content).not.toContain('旧Tool Result');
    });

    it('does not compress when cumulative tokens under 80k', () => {
      enableCompactContext();
      const manyLines = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
      useConversationStore.setState({
        messages: {
          'comp-2': [
            makeMessage({ id: 'u1', role: 'user', content: 'go' }),
            makeMessage({ id: 'a1', role: 'assistant', content: 'OK' }),
            makeMessage({
              id: 't1',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'cmd',
                summary: '',
                result: manyLines,
                success: true,
                blocked: false,
                toolCallId: 'call-x',
              },
            }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('comp-2');
      const toolMsg = history.find((m) => m.role === 'tool');
      expect(toolMsg!.content).toBe(manyLines);
    });

    it('does not compress when rounds <= 5 even if over 80k', () => {
      enableCompactContext();
      // Need > 80k tokens = 320_001+ chars
      const bigToolResult = 'x'.repeat(320_100);

      useConversationStore.setState({
        messages: {
          'comp-3': [
            makeMessage({ id: 'u1', role: 'user', content: 'r1' }),
            makeMessage({ id: 'a1', role: 'assistant', content: 'Check...' }),
            makeMessage({
              id: 't1',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'cmd',
                summary: '',
                result: bigToolResult,
                success: true,
                blocked: false,
                toolCallId: 'call-b1',
              },
            }),
            makeMessage({ id: 'a1b', role: 'assistant', content: 'Done round 1.' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('comp-3');
      // Only 1 round, cumulative > 80k but rounds <= 5 → no compression
      const toolMsg = history.find((m) => m.role === 'tool');
      expect(toolMsg!.content).toBe(bigToolResult);
    });

    it('truncates tool result when over 80k and over 5 rounds and content > 20 lines', () => {
      enableCompactContext();
      // 6 rounds, each with a big tool result so cumulative > 80k
      // Total: 6 * 55k = 330k chars = 82.5k tokens > 80k
      const roundToolContent = 'x'.repeat(55_000);

      const msgs: AgentMessage[] = [];
      for (let r = 1; r <= 6; r++) {
        msgs.push(...makeRoundMessages(r, roundToolContent));
      }
      useConversationStore.setState({ messages: { 'comp-4': msgs } });

      const history = useConversationStore.getState().buildLlmHistory('comp-4');

      // Tool results from rounds 1-5: under 80k threshold during build → not compressed
      // Last round: cumulative passed 80k and rounds > 5 → but content is 1 line (not > 20) → not compressed
      // So verify the last tool result is also not compressed (single line)
      const toolMsgs = history.filter((m) => m.role === 'tool');
      expect(toolMsgs.length).toBe(6);
      // All tool results are single-line (one long 'x'...) → no truncation
      for (const tm of toolMsgs) {
        expect(tm.content).not.toContain('旧Tool Result');
      }
    });

    it('truncates multi-line tool result when over 80k and over 5 rounds', () => {
      enableCompactContext();
      // 6 rounds, each with multi-line content so cumulative > 80k
      const multiLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
      const multiLineChars = multiLines.length; // ~250 chars
      // Need total > 320k chars: each round has ~250 chars in tool result + ~50 chars other
      // 320k / 300 = ~1067 rounds. That's way too many.
      // Let's make the tool result longer.
      // Use multi-line with long lines: 30 lines * 200 chars/line = 6000 chars per tool result
      const longLine = 'x'.repeat(200);
      const longMultiLines = Array.from({ length: 30 }, (_, i) => `${longLine} ${i}`).join('\n');
      // ~6000 chars per tool result. Need 320k / 6200 ≈ 52 rounds. Still too many.
      
      // Better approach: pad with a long prefix to reach threshold quickly
      // 3 rounds of pad + 3 rounds of actual content (total 6 rounds below threshold line for earlier ones)
      // Actually, let me think differently. The cumulative builds up over ALL messages.
      // I'll use 6 rounds × ~55k chars = 330k chars
      const padContent = 'x'.repeat(55_000 - 500); // most of this is a single long line
      const multiLineContent = [
        padContent + '\n',
        ...Array.from({ length: 30 }, (_, i) => `result line ${i + 1}`),
      ].join('\n');

      const msgs: AgentMessage[] = [];
      for (let r = 1; r <= 6; r++) {
        msgs.push(...makeRoundMessages(r, multiLineContent));
      }
      useConversationStore.setState({ messages: { 'comp-5': msgs } });

      const history = useConversationStore.getState().buildLlmHistory('comp-5');

      // Rounds 1-5: cumulative < 80k until round 6
      // Round 6: cumulative > 80k, rounds = 6 > 5, lines = 31 > 20 → truncated
      const lastTool = [...history].reverse().find((m) => m.role === 'tool');
      expect(lastTool!.content).toContain('旧Tool Result，部分内容已清除');
      expect(lastTool!.content).toContain('result line 1');
      expect(lastTool!.content).toContain('result line 30');
    });

    it('replaces tool result completely when cumulative exceeds aggressive threshold', () => {
      enableCompactContext();
      // Need > 130k tokens = 520_001+ chars. 6 rounds × 90k = 540k.
      const roundContent = 'x'.repeat(90_000);

      const msgs: AgentMessage[] = [];
      for (let r = 1; r <= 6; r++) {
        msgs.push(...makeRoundMessages(r, roundContent));
      }
      useConversationStore.setState({ messages: { 'comp-6': msgs } });

      const history = useConversationStore.getState().buildLlmHistory('comp-6');

      // Last tool result: cumulative > 130k (aggressive threshold) → replaced
      const lastTool = [...history].reverse().find((m) => m.role === 'tool');
      expect(lastTool!.content).toBe('旧Tool Result，部分内容已清除');
      // Assistant tool_calls message should still exist
      const assistants = history.filter((m) => m.role === 'assistant' && m.toolCalls);
      expect(assistants.length).toBe(6);
    });

    it('consecutive user messages do not increase round count', () => {
      enableCompactContext();
      const bigContent = 'x'.repeat(320_000);
      useConversationStore.setState({
        messages: {
          'comp-7': [
            makeMessage({ id: 'u1', role: 'user', content: 'rounds here' }),
            makeMessage({ id: 'u2', role: 'user', content: 'still same round' }),
            makeMessage({ id: 'a1', role: 'assistant', content: 'OK...' }),
            makeMessage({
              id: 't1',
              role: 'tool',
              content: '',
              toolResult: {
                toolName: 'cmd',
                summary: '',
                result: bigContent,
                success: true,
                blocked: false,
                toolCallId: 'call-zz',
              },
            }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('comp-7');
      // Only 1 round (2 consecutive user messages count as 1)
      // Cumulative > 80k but rounds = 1 ≤ 5 → no compression
      const toolMsg = history.find((m) => m.role === 'tool');
      expect(toolMsg!.content).toBe(bigContent);
    });

    it('never compresses skill tool results regardless of thresholds', () => {
      enableCompactContext();
      // Push way past aggressive threshold
      const content = 'x'.repeat(200_000);

      // 6 rounds to cross everything
      const msgs: AgentMessage[] = [];
      for (let r = 1; r <= 6; r++) {
        msgs.push(
          makeMessage({ id: `u${r}`, role: 'user', content: `p ${r}` }),
          makeMessage({ id: `a${r}`, role: 'assistant', content: `OK ${r}` }),
          makeMessage({
            id: `ts${r}`,
            role: 'tool',
            content: '',
            toolResult: {
              toolName: `skill_my_skill`,
              summary: '',
              result: content,
              success: true,
              blocked: false,
              toolCallId: `call-sk-${r}`,
            },
          }),
          makeMessage({ id: `a2-${r}`, role: 'assistant', content: `done ${r}` }),
        );
      }
      useConversationStore.setState({ messages: { 'comp-8': msgs } });

      const history = useConversationStore.getState().buildLlmHistory('comp-8');
      const toolMsgs = history.filter((m) => m.role === 'tool');
      for (const tm of toolMsgs) {
        expect(tm.content).toBe(content);
        expect(tm.content).not.toContain('旧Tool Result');
      }
    });

    // ── 未闭合 tool_calls 裁剪（应用重启/崩溃后残留）──

    function makeAssistantWithCalls(id: string, content: string, callIds: string[]): AgentMessage {
      return makeMessage({
        id,
        role: 'assistant',
        content,
        toolCalls: callIds.map((cid, i) => ({
          id: cid,
          name: `tool_${i}`,
          arguments: { x: i },
          riskLevel: 'LowRisk' as const,
        })),
      });
    }

    function makeToolResultMsg(id: string, callId: string, result = 'ok'): AgentMessage {
      return makeMessage({
        id,
        role: 'tool',
        content: '',
        toolResult: {
          toolName: 'read_file',
          summary: '',
          result,
          success: true,
          blocked: false,
          toolCallId: callId,
        },
      });
    }

    it('strips dangling tool_calls at the end (app restart mid-tool)', () => {
      useConversationStore.setState({
        messages: {
          'open-1': [
            makeMessage({ id: 'u1', role: 'user', content: '调研一下' }),
            makeAssistantWithCalls('a1', '让我看看', ['call-1']),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('open-1');
      expect(history).toEqual([
        { role: 'user', content: '调研一下' },
        { role: 'assistant', content: '让我看看' }, // toolCalls 被移除，文本保留
      ]);
    });

    it('removes empty assistant whose tool_calls were all stripped', () => {
      useConversationStore.setState({
        messages: {
          'open-2': [
            makeMessage({ id: 'u1', role: 'user', content: 'x' }),
            makeAssistantWithCalls('a1', '', ['call-1', 'call-2']),
            makeMessage({ id: 'u2', role: 'user', content: '继续' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('open-2');
      expect(history).toEqual([
        { role: 'user', content: 'x' },
        { role: 'user', content: '继续' },
      ]);
    });

    it('keeps only replied tool_calls when partially replied', () => {
      useConversationStore.setState({
        messages: {
          'open-3': [
            makeMessage({ id: 'u1', role: 'user', content: 'x' }),
            makeAssistantWithCalls('a1', '开始', ['call-1', 'call-2', 'call-3']),
            makeToolResultMsg('t1', 'call-1'),
            makeToolResultMsg('t2', 'call-3'),
            makeMessage({ id: 'u2', role: 'user', content: '继续' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('open-3');
      const assistant = history.find((m) => m.role === 'assistant' && m.toolCalls);
      expect(assistant?.toolCalls?.map((c) => c.id)).toEqual(['call-1', 'call-3']);
      // tool 消息都保留（两条都有对应回复）
      expect(history.filter((m) => m.role === 'tool')).toHaveLength(2);
    });

    it('keeps closed groups untouched (normal stop + user follow-up)', () => {
      useConversationStore.setState({
        messages: {
          'open-4': [
            makeMessage({ id: 'u1', role: 'user', content: 'x' }),
            makeAssistantWithCalls('a1', '开始', ['call-1', 'call-2']),
            makeToolResultMsg('t1', 'call-1'),
            makeToolResultMsg('t2', 'call-2'),
            makeMessage({ id: 'u2', role: 'user', content: '继续' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('open-4');
      const assistant = history.find((m) => m.role === 'assistant' && m.toolCalls);
      expect(assistant?.toolCalls?.map((c) => c.id)).toEqual(['call-1', 'call-2']);
      expect(history.filter((m) => m.role === 'tool')).toHaveLength(2);
    });

    it('settles groups independently: open group stripped, closed group kept', () => {
      useConversationStore.setState({
        messages: {
          'open-5': [
            makeMessage({ id: 'u1', role: 'user', content: 'x' }),
            makeAssistantWithCalls('a1', '第一步', ['call-a']),
            // 组1 未闭合（call-a 无回复）
            makeAssistantWithCalls('a2', '第二步', ['call-b']),
            makeToolResultMsg('t1', 'call-b'),
            makeMessage({ id: 'u2', role: 'user', content: '继续' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('open-5');
      const withCalls = history.filter((m) => m.role === 'assistant' && m.toolCalls);
      expect(withCalls).toHaveLength(1);
      expect(withCalls[0].toolCalls?.map((c) => c.id)).toEqual(['call-b']);
      // 组1 的 assistant 文本保留
      const texts = history.filter((m) => m.role === 'assistant').map((m) => m.content);
      expect(texts).toContain('第一步');
      expect(texts).toContain('第二步');
    });

    it('strips tool_calls when user message interrupts an open group', () => {
      useConversationStore.setState({
        messages: {
          'open-6': [
            makeMessage({ id: 'u1', role: 'user', content: 'x' }),
            makeAssistantWithCalls('a1', '开始', ['call-1']),
            makeMessage({ id: 'u2', role: 'user', content: '手动打断' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('open-6');
      expect(history).toEqual([
        { role: 'user', content: 'x' },
        { role: 'assistant', content: '开始' },
        { role: 'user', content: '手动打断' },
      ]);
    });

    // ── 协议合法性 fuzz：任意历史形态（含重启/中断残留）输出必须协议合法 ──

    /** 校验输出符合 LLM tool_calls 协议：assistant(tool_calls) 全部被回复，tool 消息都有前置 */
    function assertProtocolValid(history: Array<Record<string, unknown>>) {
      let openCalls: Set<string> | null = null;
      for (const m of history) {
        if (m.role === 'assistant') {
          const calls = m.toolCalls as Array<{ id: string }> | undefined;
          if (calls && calls.length > 0) {
            openCalls = new Set(calls.map((c) => c.id));
          } else {
            openCalls = null;
          }
        } else if (m.role === 'tool') {
          expect(openCalls, `tool ${m.toolCallId} must have preceding assistant(tool_calls)`).not.toBeNull();
          expect(openCalls!.has(m.toolCallId as string), `tool ${m.toolCallId} must match open calls`).toBe(true);
          // tool 回复后从开放组移除（组内全部回复即闭合）
          openCalls!.delete(m.toolCallId as string);
        }
      }
      // 结尾仍开放的组（还有未回复的 calls）→ 协议非法（LLM 400）
      if (openCalls && openCalls.size > 0) {
        throw new Error('dangling tool_calls at end: ' + [...openCalls].join(','));
      }
    }

    it('fuzz: every message shape produces protocol-valid history', () => {
      // 穷举形态组合：未闭合结尾 / 部分回复 / 跨组 / user 打断 / 无 toolCallId / 孤立 tool
      const shapes: AgentMessage[][] = [
        // 1. 重启在工具执行中：assistant(tool_calls) 结尾
        [
          makeMessage({ id: 'u', role: 'user', content: 'x' }),
          makeAssistantWithCalls('a1', '开始', ['c1']),
        ],
        // 2. 并行 calls 部分完成
        [
          makeMessage({ id: 'u', role: 'user', content: 'x' }),
          makeAssistantWithCalls('a1', '开始', ['c1', 'c2', 'c3']),
          makeToolResultMsg('t1', 'c1'),
          makeToolResultMsg('t2', 'c2'),
        ],
        // 3. 组1 闭合 + 组2 未闭合（重启在第二个工具执行中）
        [
          makeMessage({ id: 'u', role: 'user', content: 'x' }),
          makeAssistantWithCalls('a1', '一', ['c1']),
          makeToolResultMsg('t1', 'c1'),
          makeAssistantWithCalls('a2', '二', ['c2']),
        ],
        // 4. 未闭合组被 user 打断
        [
          makeMessage({ id: 'u', role: 'user', content: 'x' }),
          makeAssistantWithCalls('a1', '一', ['c1']),
          makeMessage({ id: 'u2', role: 'user', content: '打断' }),
          makeMessage({ id: 'u3', role: 'user', content: '继续' }),
        ],
        // 5. 空 content 的未闭合 assistant
        [
          makeMessage({ id: 'u', role: 'user', content: 'x' }),
          makeAssistantWithCalls('a1', '', ['c1']),
          makeMessage({ id: 'u2', role: 'user', content: '继续' }),
        ],
        // 6. 无 toolCallId 的 tool 消息（legacy 损坏形态）
        [
          makeMessage({ id: 'u', role: 'user', content: 'x' }),
          makeAssistantWithCalls('a1', '开始', ['c1']),
          makeMessage({
            id: 't-legacy',
            role: 'tool',
            content: 'legacy',
            toolResult: { toolName: 'read_file', summary: '', result: 'r', success: true, blocked: false },
          }),
          makeMessage({ id: 'u2', role: 'user', content: '继续' }),
        ],
        // 7. 孤立 tool（无前置 assistant）
        [
          makeMessage({ id: 'u', role: 'user', content: 'x' }),
          makeToolResultMsg('t-orphan', 'c9'),
          makeMessage({ id: 'u2', role: 'user', content: '继续' }),
        ],
        // 8. 完整正常历史（不应被改动）
        [
          makeMessage({ id: 'u', role: 'user', content: 'x' }),
          makeAssistantWithCalls('a1', '一', ['c1', 'c2']),
          makeToolResultMsg('t1', 'c1'),
          makeToolResultMsg('t2', 'c2'),
          makeMessage({ id: 'a2', role: 'assistant', content: '完成' }),
          makeMessage({ id: 'u2', role: 'user', content: '继续' }),
        ],
        // 9. 连续多轮混合：闭合组 + 未闭合组交错
        [
          makeMessage({ id: 'u', role: 'user', content: 'x' }),
          makeAssistantWithCalls('a1', '一', ['c1']),
          makeToolResultMsg('t1', 'c1'),
          makeMessage({ id: 'a2', role: 'assistant', content: '中间文本' }),
          makeAssistantWithCalls('a3', '二', ['c2', 'c3']),
          makeToolResultMsg('t2', 'c2'),
          makeMessage({ id: 'u2', role: 'user', content: '继续' }),
        ],
      ];

      shapes.forEach((msgs, i) => {
        useConversationStore.setState({ messages: { [`fuzz-${i}`]: msgs } });
        const history = useConversationStore.getState().buildLlmHistory(`fuzz-${i}`);
        assertProtocolValid(history);
      });
    });

    it('fuzz: closed groups are never modified (byte-identical toolCalls)', () => {
      // 完全闭合的历史：输出应与未裁剪的 buildLlmHistory 一致
      const msgs = [
        makeMessage({ id: 'u', role: 'user', content: 'x' }),
        makeAssistantWithCalls('a1', '一', ['c1', 'c2']),
        makeToolResultMsg('t1', 'c1'),
        makeToolResultMsg('t2', 'c2'),
        makeMessage({ id: 'a2', role: 'assistant', content: '完成' }),
      ];
      useConversationStore.setState({ messages: { 'closed-1': msgs } });
      const history = useConversationStore.getState().buildLlmHistory('closed-1');

      const assistant = history.find((m) => m.role === 'assistant' && m.toolCalls);
      expect(assistant?.toolCalls?.map((c) => c.id)).toEqual(['c1', 'c2']);
      // user + assistant(tool_calls) + tool + tool + assistant = 5 条
      expect(history).toHaveLength(5);
      expect(history.filter((m) => m.role === 'tool')).toHaveLength(2);
    });

    // ── reasoning_content 回传保留（DeepSeek thinking 模式）──

    it('carries reasoningContent on assistant(tool_calls) messages', () => {
      useConversationStore.setState({
        messages: {
          'reason-1': [
            makeMessage({ id: 'u', role: 'user', content: 'x' }),
            makeMessage({
              id: 'a1',
              role: 'assistant',
              content: '让我看看',
              toolCalls: [
                { id: 'call-1', name: 'execute_command', arguments: { command: 'ls' }, riskLevel: 'LowRisk' as const },
              ],
              reasoningContent: '先列目录',
            }),
            makeToolResultMsg('t1', 'call-1'),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('reason-1');
      const assistant = history.find((m) => m.role === 'assistant' && m.toolCalls);
      expect(assistant?.reasoningContent).toBe('先列目录');
      expect(assistant?.toolCalls).toHaveLength(1);
    });

    it('carries reasoningContent when tool is mounted onto a plain assistant', () => {
      useConversationStore.setState({
        messages: {
          'reason-2': [
            makeMessage({ id: 'u', role: 'user', content: 'x' }),
            makeMessage({
              id: 'a1',
              role: 'assistant',
              content: '开始检查',
              reasoningContent: '思考中...',
            }),
            makeToolResultMsg('t1', 'call-1'),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('reason-2');
      const assistant = history.find((m) => m.role === 'assistant' && m.toolCalls);
      expect(assistant?.reasoningContent).toBe('思考中...');
    });

    it('keeps reasoningContent on plain assistant messages unchanged', () => {
      useConversationStore.setState({
        messages: {
          'reason-3': [
            makeMessage({ id: 'u', role: 'user', content: 'x' }),
            makeMessage({
              id: 'a1',
              role: 'assistant',
              content: '完成',
              reasoningContent: '思考结论',
            }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('reason-3');
      expect(history[1]).toMatchObject({ role: 'assistant', content: '完成', reasoningContent: '思考结论' });
    });
  });
});
