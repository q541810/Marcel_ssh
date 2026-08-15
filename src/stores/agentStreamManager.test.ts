import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTaskStore } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import {
  handleSubTaskStart,
  handleSubTaskFallback,
  extractSubTaskMeta,
} from '@/stores/agentStreamManager';
import type { ToolResultPayload } from '@/lib/types';

const { agentLoadConversation, agentGetConversation } = vi.hoisted(() => ({
  agentLoadConversation: vi.fn(),
  agentGetConversation: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  agentLoadConversation,
  agentGetConversation,
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock('@/stores/agentStreamHandlers', () => ({
  handleToolResult: vi.fn(),
  handleToolCallStart: vi.fn(),
  handleTextDelta: vi.fn(),
  handleThinkingDelta: vi.fn(),
  handleDone: vi.fn(),
  handleError: vi.fn(),
  handleRetrying: vi.fn(),
  handleToolOutput: vi.fn(),
  handleToolCallDelta: vi.fn(),
  handleModelApprovalStart: vi.fn(),
  handleModelApprovalDone: vi.fn(),
  handleQuestionRequest: vi.fn(),
  cleanupStreamState: vi.fn(),
}));
vi.mock('@/stores/storeStreamAdapter', () => ({
  createDefaultStreamHandler: vi.fn(() => ({
    updateMessages: vi.fn(),
    updateTaskStatus: vi.fn(),
    setPendingApproval: vi.fn(),
    setPendingQuestion: vi.fn(),
    getTaskStatus: vi.fn(),
    getMessages: vi.fn(() => []),
    clearActiveTaskIf: vi.fn(),
    setPlan: vi.fn(),
  })),
}));
// attachStreamListener 在 handleSubTaskStart 里被调用：mock 掉避免真的 listen
vi.mock('@/stores/agentStreamManager', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@/stores/agentStreamManager')>();
  return {
    ...mod,
    attachStreamListener: vi.fn(),
  };
});

function makeToolResult(overrides: Partial<ToolResultPayload> = {}): ToolResultPayload {
  return {
    type: 'toolResult',
    toolCallId: 'call-1',
    toolName: 'task',
    summary: '子agent完成：x',
    result: 'done',
    success: true,
    blocked: false,
    arguments: { description: 'x', prompt: 'p' },
    ...overrides,
  };
}

function seedParentTask(parentTaskId = 'parent-1', conversationId = 'main-conv') {
  useTaskStore.setState({
    tasks: {
      [parentTaskId]: {
        id: parentTaskId,
        sessionId: 's1',
        conversationId,
        prompt: 'main',
        mode: 'agent',
        status: 'executing',
        createdAt: new Date().toISOString(),
      },
    },
    activeTaskId: parentTaskId,
  });
  useConversationStore.setState({
    conversations: {
      [conversationId]: {
        id: conversationId,
        connectionId: 'conn-1',
        title: 'main',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
    messages: {},
    activeConversationId: conversationId,
  });
}

describe('subagent wiring', () => {
  beforeEach(() => {
    useTaskStore.setState({ tasks: {}, activeTaskId: null });
    useConversationStore.setState({ conversations: {}, messages: {}, activeConversationId: null });
    vi.clearAllMocks();
  });

  it('extractSubTaskMeta returns null for non-subtask results', () => {
    expect(extractSubTaskMeta(makeToolResult({ toolName: 'execute_command' }))).toBeNull();
    expect(extractSubTaskMeta(makeToolResult({ metadata: { foo: 1 } }))).toBeNull();
    expect(
      extractSubTaskMeta(
        makeToolResult({ metadata: { subTaskId: 't', subConversationId: 'c', status: 'running' } }),
      ),
    ).toBeNull();
  });

  it('extractSubTaskMeta parses completed metadata', () => {
    const meta = extractSubTaskMeta(
      makeToolResult({
        metadata: { subTaskId: 't1', subConversationId: 'c1', status: 'completed' },
      }),
    );
    expect(meta).toEqual({ subTaskId: 't1', subConversationId: 'c1', status: 'completed' });
  });

  it('subTaskStart registers conversation skeleton, task record and returns loading id', () => {
    seedParentTask();
    handleSubTaskStart('parent-1', {
      type: 'subTaskStart',
      toolCallId: 'call-1',
      subTaskId: 'sub-1',
      subConversationId: 'sub-conv-1',
      description: 'explore nginx',
      prompt: 'look at /etc/nginx',
      parentConversationId: 'main-conv',
    });

    const taskStore = useTaskStore.getState();
    expect(taskStore.tasks['sub-1']).toMatchObject({
      id: 'sub-1',
      conversationId: 'sub-conv-1',
      mode: 'plan',
      status: 'planning',
      parentTaskId: 'parent-1',
      sessionId: 's1',
      prompt: 'look at /etc/nginx',
    });

    const convStore = useConversationStore.getState();
    expect(convStore.conversations['sub-conv-1']).toMatchObject({
      connectionId: 'conn-1',
      title: 'explore nginx（子agent）',
    });
    const msgs = convStore.messages['sub-conv-1'];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('look at /etc/nginx');
    expect(msgs[1].isLoading).toBe(true);
  });

  it('subTaskStart attaches sub-conversation link to the running task tool card', () => {
    seedParentTask();
    useConversationStore.setState({
      conversations: {
        'main-conv': {
          id: 'main-conv',
          connectionId: 'conn-1',
          title: 'main',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
      messages: {
        'main-conv': [
          {
            id: 'tool-msg-1',
            role: 'tool',
            content: '',
            timestamp: new Date().toISOString(),
            isExecuting: true,
            toolResult: {
              toolName: 'task',
              summary: '',
              result: '',
              success: true,
              blocked: false,
              toolCallId: 'call-1',
            },
          },
        ],
      },
      activeConversationId: 'main-conv',
    });

    handleSubTaskStart('parent-1', {
      type: 'subTaskStart',
      toolCallId: 'call-1',
      subTaskId: 'sub-1',
      subConversationId: 'sub-conv-1',
      description: 'explore nginx',
      prompt: 'look at /etc/nginx',
      parentConversationId: 'main-conv',
    });

    const msg = useConversationStore.getState().messages['main-conv'][0];
    expect(msg.toolResult?.metadata).toEqual({
      subTaskId: 'sub-1',
      subConversationId: 'sub-conv-1',
      status: 'running',
    });
    // 不匹配 toolCallId 的消息不被触碰
    useConversationStore.setState({
      messages: {
        'main-conv': [
          {
            id: 'tool-msg-2',
            role: 'tool',
            content: '',
            timestamp: new Date().toISOString(),
            isExecuting: true,
            toolResult: {
              toolName: 'execute_command',
              summary: '',
              result: '',
              success: true,
              blocked: false,
              toolCallId: 'other-call',
            },
          },
        ],
      },
    });
    handleSubTaskStart('parent-1', {
      type: 'subTaskStart',
      toolCallId: 'call-1',
      subTaskId: 'sub-9',
      subConversationId: 'sub-conv-9',
      description: 'x',
      prompt: 'p',
      parentConversationId: 'main-conv',
    });
    const other = useConversationStore.getState().messages['main-conv'][0];
    expect(other.toolResult?.metadata).toBeUndefined();
  });

  it('subTaskStart is idempotent for already registered subtask', () => {
    seedParentTask();
    handleSubTaskStart('parent-1', {
      type: 'subTaskStart',
      toolCallId: 'call-1',
      subTaskId: 'sub-1',
      subConversationId: 'sub-conv-1',
      description: 'explore nginx',
      prompt: 'look at /etc/nginx',
      parentConversationId: 'main-conv',
    });
    handleSubTaskStart('parent-1', {
      type: 'subTaskStart',
      toolCallId: 'call-1',
      subTaskId: 'sub-1',
      subConversationId: 'sub-conv-1',
      description: 'explore nginx',
      prompt: 'look at /etc/nginx',
      parentConversationId: 'main-conv',
    });

    const convStore = useConversationStore.getState();
    expect(convStore.messages['sub-conv-1']).toHaveLength(2);
  });

  it('toolResult fallback loads full messages from DB when subtask was never registered', async () => {
    seedParentTask();
    agentGetConversation.mockResolvedValue({
      id: 'sub-conv-2',
      connectionId: 'conn-1',
      title: 'explore nginx（子agent）',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      parentConversationId: 'main-conv',
    });
    agentLoadConversation.mockResolvedValue([
      {
        id: 'm1',
        conversationId: 'sub-conv-1',
        role: 'user',
        content: 'look at /etc/nginx',
        timestamp: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'm2',
        conversationId: 'sub-conv-1',
        role: 'assistant',
        content: 'nginx listens on 80',
        timestamp: '2026-01-01T00:00:01Z',
        createdAt: '2026-01-01T00:00:01Z',
      },
    ]);

    await handleSubTaskFallback(
      'parent-1',
      { subTaskId: 'sub-2', subConversationId: 'sub-conv-2', status: 'completed' },
      'explore nginx',
      'look at /etc/nginx',
    );

    const taskStore = useTaskStore.getState();
    expect(taskStore.tasks['sub-2'].status).toBe('completed');
    expect(taskStore.tasks['sub-2'].parentTaskId).toBe('parent-1');

    const convStore = useConversationStore.getState();
    // 兜底注册时从 DB 补齐 parentConversationId（"返回主对话"可用）
    expect(convStore.conversations['sub-conv-2'].parentConversationId).toBe('main-conv');
    const msgs = convStore.messages['sub-conv-2'];
    expect(msgs).toHaveLength(2);
    expect(msgs[0].content).toBe('look at /etc/nginx');
    expect(msgs[1].content).toBe('nginx listens on 80');
    expect(agentLoadConversation).toHaveBeenCalledWith('sub-conv-2');
  });

  it('toolResult fallback maps cancelled status', async () => {
    seedParentTask();
    agentLoadConversation.mockResolvedValue([]);

    await handleSubTaskFallback(
      'parent-1',
      { subTaskId: 'sub-3', subConversationId: 'sub-conv-3', status: 'cancelled' },
      'x',
      'p',
    );

    expect(useTaskStore.getState().tasks['sub-3'].status).toBe('cancelled');
  });

  it('toolResult fallback converges terminal status for already-registered subtask', async () => {
    // 子任务已由 subTaskStart 注册（planning）但 done 事件在 listener 挂载前
    // 丢失：fallback 必须把状态收敛为终态，而不是因为「已注册」直接跳过。
    seedParentTask();
    handleSubTaskStart('parent-1', {
      type: 'subTaskStart',
      toolCallId: 'call-1',
      subTaskId: 'sub-4',
      subConversationId: 'sub-conv-4',
      description: 'explore nginx',
      prompt: 'look at /etc/nginx',
      parentConversationId: 'main-conv',
    });
    agentGetConversation.mockResolvedValue({
      id: 'sub-conv-4',
      connectionId: 'conn-1',
      title: 'explore nginx（子agent）',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      parentConversationId: 'main-conv',
    });
    agentLoadConversation.mockResolvedValue([
      {
        id: 'm1',
        conversationId: 'sub-conv-4',
        role: 'user',
        content: 'look at /etc/nginx',
        timestamp: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'm2',
        conversationId: 'sub-conv-4',
        role: 'assistant',
        content: 'nginx listens on 80',
        timestamp: '2026-01-01T00:00:01Z',
        createdAt: '2026-01-01T00:00:01Z',
      },
    ]);

    await handleSubTaskFallback(
      'parent-1',
      { subTaskId: 'sub-4', subConversationId: 'sub-conv-4', status: 'completed' },
      'explore nginx',
      'look at /etc/nginx',
    );

    expect(useTaskStore.getState().tasks['sub-4'].status).toBe('completed');
    // 骨架 loading 还在 → 从 DB 全量替换，骨架被清理
    const msgs = useConversationStore.getState().messages['sub-conv-4'];
    expect(msgs.some((m) => m.isLoading)).toBe(false);
    expect(msgs).toHaveLength(2);
    expect(msgs[1].content).toBe('nginx listens on 80');
  });

  it('toolResult fallback does not overwrite live-streamed messages when skeleton is gone', async () => {
    // 正常 live 路径：骨架已被流事件消费（无 isLoading），fallback 不应覆盖
    // 已有的实时消息（工具结果到达时子任务已终态，但避免无谓的全量重载）。
    seedParentTask();
    useConversationStore.setState({
      conversations: {
        'sub-conv-5': {
          id: 'sub-conv-5',
          connectionId: 'conn-1',
          title: 'x（子agent）',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          parentConversationId: 'main-conv',
        },
      },
      messages: {
        'sub-conv-5': [
          {
            id: 'live-1',
            role: 'user',
            content: 'p',
            timestamp: new Date().toISOString(),
          },
          {
            id: 'live-2',
            role: 'assistant',
            content: 'live streamed conclusion',
            timestamp: new Date().toISOString(),
          },
        ],
      },
    });
    useTaskStore.setState({
      tasks: {
        'sub-5': {
          id: 'sub-5',
          sessionId: 's1',
          conversationId: 'sub-conv-5',
          prompt: 'p',
          mode: 'plan',
          status: 'planning',
          createdAt: new Date().toISOString(),
          parentTaskId: 'parent-1',
        },
      },
    });
    agentLoadConversation.mockResolvedValue([
      {
        id: 'db-1',
        conversationId: 'sub-conv-5',
        role: 'assistant',
        content: 'db version of conclusion',
        timestamp: '2026-01-01T00:00:00Z',
        createdAt: '2026-01-01T00:00:00Z',
      },
    ]);

    await handleSubTaskFallback(
      'parent-1',
      { subTaskId: 'sub-5', subConversationId: 'sub-conv-5', status: 'failed' },
      'x',
      'p',
    );

    expect(useTaskStore.getState().tasks['sub-5'].status).toBe('failed');
    const msgs = useConversationStore.getState().messages['sub-conv-5'];
    // 无 isLoading 骨架 → 保留实时消息
    expect(msgs[1].content).toBe('live streamed conclusion');
  });

  it('toolResult fallback fills connectionId from conversation meta when parent task is missing', async () => {
    // 重启恢复场景：父任务不在前端内存（tasks 为空），connectionId 从
    // agentGetConversation 补齐，子对话条目不落空。
    agentGetConversation.mockResolvedValue({
      id: 'sub-conv-6',
      connectionId: 'conn-9',
      title: 'x（子agent）',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      parentConversationId: 'main-conv',
    });
    agentLoadConversation.mockResolvedValue([]);

    await handleSubTaskFallback(
      'parent-1',
      { subTaskId: 'sub-6', subConversationId: 'sub-conv-6', status: 'completed' },
      'x',
      'p',
    );

    expect(
      useConversationStore.getState().conversations['sub-conv-6'].connectionId,
    ).toBe('conn-9');
    expect(
      useConversationStore.getState().conversations['sub-conv-6'].parentConversationId,
    ).toBe('main-conv');
  });
});
