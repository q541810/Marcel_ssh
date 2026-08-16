import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { getStreamState, setStreamState } from './agentStreamHandlers';
import type { AgentMessage, AgentTask } from '@/lib/types';

const {
  agentListConversationsByConnection,
  agentLoadConversation,
  agentTruncateConversation,
  agentLoadPlansByConversation,
  agentCreateConversation,
  agentDeleteConversation,
  agentGetConversation,
  agentCompactConversation,
  listen,
} = vi.hoisted(() => ({
  agentListConversationsByConnection: vi.fn(),
  agentLoadConversation: vi.fn(),
  agentTruncateConversation: vi.fn(),
  agentLoadPlansByConversation: vi.fn(),
  agentCreateConversation: vi.fn(),
  agentDeleteConversation: vi.fn(),
  agentGetConversation: vi.fn(),
  agentCompactConversation: vi.fn(),
  listen: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  agentListConversationsByConnection,
  agentLoadConversation,
  agentTruncateConversation,
  agentLoadPlansByConversation,
  agentCreateConversation,
  agentDeleteConversation,
  agentGetConversation,
  agentCompactConversation,
}));

// compactConversation 经 attachStreamListener 订阅 `agent://stream/{taskId}`；
// 测试环境无 Tauri 事件系统，mock listen 返回 no-op unlisten。
vi.mock('@tauri-apps/api/event', () => ({
  listen,
}));

describe('conversationStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listen.mockResolvedValue(() => {});
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

    it('loads the backend-compacted conversation with originals preserved and card at span end', async () => {
      // 后端落库后 load_messages 返回：原文全保留 + 卡片在 span 末尾（created_at 定位）——
      // 前端原样展示，不需要任何回放/位置修正。
      agentLoadConversation.mockResolvedValue([
        { id: 'm1', conversationId: 'conv-1', role: 'user', content: 'u1', timestamp: now, createdAt: now },
        { id: 'm2', conversationId: 'conv-1', role: 'assistant', content: 'a1', timestamp: now, createdAt: now },
        { id: 'm3', conversationId: 'conv-1', role: 'tool', content: 'out', timestamp: now, createdAt: now },
        {
          id: 'card1',
          conversationId: 'conv-1',
          role: 'system',
          content: '【上下文已压缩】已整理 3 条历史消息（约 1000 tokens）\n\n## Primary Request\n- s1',
          timestamp: now,
          createdAt: now,
        },
        { id: 'm4', conversationId: 'conv-1', role: 'user', content: 'u2', timestamp: now, createdAt: now },
      ]);
      agentLoadPlansByConversation.mockResolvedValue([]);
      seedConversation('conv-1', []);
      seedTask('task-1', 'conv-1', 'completed');

      await useConversationStore.getState().switchConversation('conv-1');

      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'card1', 'm4']);
      expect(msgs[3].compaction?.status).toBe('done');
      expect(msgs[3].compaction?.summary).toContain('s1');
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

    it('emits a user checkpoint for a done compaction card, positioned at the card site', () => {
      useConversationStore.setState({
        messages: {
          'conv-cp': [
            makeMessage({
              id: 'card1',
              role: 'system',
              content: '【上下文已压缩】已整理 3 条历史消息（约 1000 tokens）',
              compaction: { status: 'done', summary: '## Primary Request\n- build a terminal', shadowedMessages: 3, shadowedTokens: 1000 },
            }),
            makeMessage({ id: 'm4', role: 'user', content: 'continue' }),
            makeMessage({ id: 'm5', role: 'assistant', content: 'ok' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-cp');
      expect(history).toHaveLength(3);
      // checkpoint 是 user 角色、framing 与后端逐字节一致
      expect(history[0].role).toBe('user');
      expect(history[0].content).toContain('<compacted-summary>');
      expect(history[0].content).toContain('## Primary Request\n- build a terminal');
      expect(history[0].content.startsWith('This is an automatically generated checkpoint')).toBe(true);
      expect(history[1]).toEqual({ role: 'user', content: 'continue' });
      expect(history[2]).toEqual({ role: 'assistant', content: 'ok' });
    });

    it('skips running compaction cards and other system notices in history', () => {
      useConversationStore.setState({
        messages: {
          'conv-cp2': [
            makeMessage({ id: 'u1', role: 'user', content: 'go' }),
            makeMessage({ id: 'rc', role: 'system', content: '上下文压缩中…', compaction: { status: 'running' } }),
            makeMessage({ id: 'a1', role: 'assistant', content: 'done' }),
          ],
        },
      });

      const history = useConversationStore.getState().buildLlmHistory('conv-cp2');
      expect(history).toEqual([
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'done' },
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

  describe('buildLlmHistory protocol closure', () => {

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

  describe('compactConversation 手动压缩反馈', () => {
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

    function mockCompactResult(overrides: Record<string, unknown>) {
      agentCompactConversation.mockResolvedValue({
        compacted: false,
        summary: null,
        shadowedMessages: 0,
        shadowedTokens: 0,
        tailDbId: null,
        reason: null,
        attempted: false,
        ...overrides,
      });
    }

    it('无可压区间（attempted=false）时插入"无需压缩"通知', async () => {
      mockCompactResult({ reason: '没有可压缩的早期历史区间' });
      seedConversation('conv-1', [makeMessage({ id: 'u1', content: 'go' })]);
      seedTask('task-1', 'conv-1', 'completed');

      const result = await useConversationStore.getState().compactConversation('conv-1');

      expect(result.compacted).toBe(false);
      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs).toHaveLength(2);
      const notice = msgs[1];
      expect(notice.role).toBe('system');
      expect(notice.content).toBe('无需压缩：没有可压缩的早期历史区间');
      expect(notice.compaction).toBeUndefined();
    });

    it('摘要失败且 Skipped 事件丢失（attempted=true + 残留 running 卡）时把卡转为未完成文本', async () => {
      mockCompactResult({
        attempted: true,
        reason: '生成的摘要未比原文更短（约 200 ≥ 100 tokens），已放弃本次压缩',
      });
      seedConversation('conv-1', [
        makeMessage({ id: 'u1', content: 'go' }),
        {
          id: 'running-1',
          role: 'system',
          content: '上下文压缩中…',
          timestamp: now,
          compaction: { status: 'running' },
        },
      ]);
      seedTask('task-1', 'conv-1', 'completed');

      // 固定 taskId（compactConversation 内部用 crypto.randomUUID 生成），
      // 预置残留的 running 卡占位 id，模拟 Skipped 事件在 listener 清理前丢失。
      const uuid = '00000000-0000-4000-8000-000000000000';
      const uuidSpy = vi
        .spyOn(crypto, 'randomUUID')
        .mockReturnValue(uuid as `${string}-${string}-${string}-${string}-${string}`);
      setStreamState(uuid, { ...getStreamState(uuid), compactionMessageId: 'running-1' });
      try {
        await useConversationStore.getState().compactConversation('conv-1');
      } finally {
        uuidSpy.mockRestore();
      }

      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs).toHaveLength(2); // 不新增消息
      const card = msgs.find((m) => m.id === 'running-1');
      expect(card?.content).toContain('上下文压缩未完成');
      expect(card?.content).toContain('已放弃本次压缩');
      expect(card?.compaction).toBeUndefined(); // 转普通 system 文本
      expect(getStreamState(uuid).compactionMessageId).toBeNull(); // 占位 id 释放
    });

    it('摘要失败但事件已正常处理（attempted=true + 无残留卡）时不重复插入', async () => {
      mockCompactResult({ attempted: true, reason: '摘要被输出长度上限截断（生成不完整），已放弃本次压缩' });
      seedConversation('conv-1', [
        makeMessage({ id: 'u1', content: 'go' }),
        // 事件路径已把 running 卡转成普通 system 文本（compaction 字段清除、占位 id 释放）
        { id: 'card-1', role: 'system', content: '上下文压缩未完成：摘要被输出长度上限截断（生成不完整），已放弃本次压缩', timestamp: now },
      ]);
      seedTask('task-1', 'conv-1', 'completed');

      await useConversationStore.getState().compactConversation('conv-1');

      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs).toHaveLength(2); // 不新增任何消息（防重复）
      expect(msgs.map((m) => m.id)).toEqual(['u1', 'card-1']);
    });

    it('命令失败（未配置 LLM）且无 running 卡时插入失败提示', async () => {
      agentCompactConversation.mockRejectedValue(new Error('尚未配置 LLM，请前往设置填写'));
      seedConversation('conv-1', [makeMessage({ id: 'u1', content: 'go' })]);
      seedTask('task-1', 'conv-1', 'completed');

      await expect(useConversationStore.getState().compactConversation('conv-1')).rejects.toThrow(
        '尚未配置 LLM',
      );
      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs).toHaveLength(2);
      expect(msgs[1].role).toBe('system');
      expect(msgs[1].content).toBe('上下文压缩失败：尚未配置 LLM，请前往设置填写');
      expect(msgs[1].compaction).toBeUndefined();
    });

    it('会话有运行中任务时插入提示并拒绝压缩', async () => {
      seedConversation('conv-1', [makeMessage({ id: 'u1', content: 'go' })]);
      seedTask('task-1', 'conv-1', 'executing');

      await expect(useConversationStore.getState().compactConversation('conv-1')).rejects.toThrow(
        '会话正在运行任务',
      );
      // 不调用后端（守卫在调用前拦截）
      expect(agentCompactConversation).not.toHaveBeenCalled();
      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs).toHaveLength(2);
      expect(msgs[1].role).toBe('system');
      expect(msgs[1].content).toContain('会话正在运行任务');
    });

    it('压缩成功时结果路径不操作 store（live 更新由 Done 事件负责，原文全保留）', async () => {
      mockCompactResult({
        compacted: true,
        summary: '## Primary Request\n- build',
        shadowedMessages: 2,
        shadowedTokens: 100,
        tailDbId: 'row-2',
      });
      seedConversation('conv-1', [
        makeMessage({ id: 'u1', content: 'go' }),
        makeMessage({ id: 'a1', role: 'assistant', content: 'ok' }),
        makeMessage({ id: 'u2', content: 'next' }),
      ]);
      seedTask('task-1', 'conv-1', 'completed');

      await useConversationStore.getState().compactConversation('conv-1');

      // 结果路径不改 store：压缩由后端落库 + Done 事件更新 live 视图；
      // 原文一条不少（无隐藏）。
      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
    });
  });
});
