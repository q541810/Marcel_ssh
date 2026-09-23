import { beforeEach, describe, expect, it, vi } from 'vitest';

const { cleanupTaskListenersMock } = vi.hoisted(() => ({
  cleanupTaskListenersMock: vi.fn(),
}));

vi.mock('@/components/terminal/TerminalInstanceManager', () => ({
  terminalInstanceManager: {
    prepareReconnect: vi.fn(),
    onReconnected: vi.fn(),
    showDisconnectBanner: vi.fn(),
    setStdinEnabled: vi.fn(),
  },
}));

// taskStore 的收尾要经 cleanupTaskListeners 拆通道；这里只观察「有没有走收尾」，
// 真实通道行为的验证在 agentStreamLifecycle.test.ts。
vi.mock('@/stores/agentStreamManager', () => ({
  attachStreamListener: vi.fn(),
  attachPlanListener: vi.fn(),
  cleanupTaskListeners: cleanupTaskListenersMock,
}));

vi.mock('@/lib/tauri', () => ({
  agentListConversationsByConnection: vi.fn(),
  agentLoadConversation: vi.fn(),
  agentLoadActiveMessages: vi.fn().mockResolvedValue({ messages: [], hasEarlier: false, checkpointId: null }),
  agentLoadEarlierMessages: vi.fn().mockResolvedValue([]),
  agentLoadPlansByConversation: vi.fn(),
  agentGetConversation: vi.fn(),
  agentCreateConversation: vi.fn(),
  agentRenameConversation: vi.fn(),
  agentDeleteConversation: vi.fn(),
  agentTruncateConversation: vi.fn(),
}));

import { useSessionStore } from '@/stores/sessionStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { sessionConversationBindingManager } from '@/stores/sessionConversationBindingManager';
import type { Session, AgentConversation, AgentMessage, AgentTask } from '@/lib/types';
import * as tauri from '@/lib/tauri';

function makeSession(id: string, configId = 'conn-1'): Session {
  return { id, connectionId: 'hostA', status: 'connected', createdAt: '', configId };
}

function makeTask(overrides: Partial<AgentTask>): AgentTask {
  return {
    id: 'task',
    sessionId: 'sess-a',
    conversationId: 'conv-a',
    prompt: 'p',
    mode: 'agent',
    status: 'executing',
    createdAt: '',
    ...overrides,
  };
}

describe('SessionConversationBindingManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStore.setState({
      sessions: {},
      activeSessionId: null,
    });
    useConversationStore.setState({
      conversations: {},
      messages: {},
      activeConversationId: null,
      activeConversationByConnection: {},
      activeConversationBySession: {},
    });
    useTaskStore.setState({
      tasks: {},
      activeTaskId: null,
      unreadCompletedConversations: [],
    });
  });

  it('detects occupying session via running task', () => {
    const sessionA: Session = {
      id: 'sess-a',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    useSessionStore.setState({
      sessions: { 'sess-a': sessionA },
      activeSessionId: 'sess-a',
    });

    const task: AgentTask = {
      id: 'task-1',
      sessionId: 'sess-a',
      conversationId: 'conv-n',
      prompt: 'do work',
      mode: 'agent',
      status: 'executing',
      createdAt: '',
    };
    useTaskStore.setState({
      tasks: { 'task-1': task },
    });

    const occupying = sessionConversationBindingManager.findOccupyingSession('conv-n');
    expect(occupying).not.toBeNull();
    expect(occupying?.sessionId).toBe('sess-a');
  });

  it('detects occupying session via activeConversationBySession', () => {
    const sessionA: Session = {
      id: 'sess-a',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    useSessionStore.setState({
      sessions: { 'sess-a': sessionA },
      activeSessionId: 'sess-a',
    });

    useConversationStore.setState({
      activeConversationBySession: { 'sess-a': 'conv-n' },
    });

    const occupying = sessionConversationBindingManager.findOccupyingSession('conv-n');
    expect(occupying).not.toBeNull();
    expect(occupying?.sessionId).toBe('sess-a');
  });

  it('jumps to session A when clicking conversation N from session B', async () => {
    const sessionA: Session = {
      id: 'sess-a',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    const sessionB: Session = {
      id: 'sess-b',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    useSessionStore.setState({
      sessions: { 'sess-a': sessionA, 'sess-b': sessionB },
      activeSessionId: 'sess-b',
    });

    useConversationStore.setState({
      conversations: {
        'conv-n': {
          id: 'conv-n',
          connectionId: 'conn-1',
          title: 'Conv N',
          createdAt: '',
          updatedAt: '',
        },
      },
      activeConversationBySession: { 'sess-a': 'conv-n' },
      activeConversationId: 'conv-other',
    });

    (tauri.agentLoadConversation as any).mockResolvedValue([]);
    (tauri.agentLoadPlansByConversation as any).mockResolvedValue([]);

    const result = await sessionConversationBindingManager.selectOrJumpToConversation(
      'conv-n',
      'sess-b',
    );

    expect(result.switchedSession).toBe(true);
    expect(result.targetSessionId).toBe('sess-a');
    expect(useSessionStore.getState().activeSessionId).toBe('sess-a');
    expect(useConversationStore.getState().activeConversationId).toBe('conv-n');
  });

  it('allocates a fresh conversation on connect when all existing conversations are occupied by other live tabs', async () => {
    const sessionA: Session = {
      id: 'sess-a',
      connectionId: 'hostA',
      status: 'connected',
      createdAt: '',
      configId: 'conn-1',
    };
    useSessionStore.setState({
      sessions: { 'sess-a': sessionA },
      activeSessionId: 'sess-a',
    });

    useConversationStore.setState({
      conversations: {
        'conv-n': {
          id: 'conv-n',
          connectionId: 'conn-1',
          title: 'Conv N',
          createdAt: '',
          updatedAt: '2026-01-01',
        },
      },
      activeConversationBySession: { 'sess-a': 'conv-n' },
    });

    (tauri.agentListConversationsByConnection as any).mockResolvedValue([
      {
        id: 'conv-n',
        connectionId: 'conn-1',
        title: 'Conv N',
        createdAt: '',
        updatedAt: '2026-01-01',
      },
    ]);
    (tauri.agentCreateConversation as any).mockResolvedValue('conv-b-fresh');

    const allocatedId = await sessionConversationBindingManager.onSessionConnected('conn-1', 'sess-b');
    expect(allocatedId).toBe('conv-b-fresh');
    expect(useConversationStore.getState().activeConversationBySession['sess-b']).toBe('conv-b-fresh');
    expect(useConversationStore.getState().activeConversationBySession['sess-a']).toBe('conv-n');
  });

  it('cleans up session binding upon disconnect', () => {
    useConversationStore.setState({
      activeConversationBySession: { 'sess-a': 'conv-n' },
    });

    sessionConversationBindingManager.onSessionDisconnected('sess-a');
    expect(useConversationStore.getState().activeConversationBySession['sess-a']).toBeUndefined();
  });

  describe('onSessionDisconnected 的任务收尾', () => {
    it('断开走统一收尾：拆通道、标记在飞卡片、落回合状态（不是就地改 status）', () => {
      useSessionStore.setState({
        sessions: { 'sess-a': makeSession('sess-a') },
        activeSessionId: 'sess-a',
      });
      const inFlightTool: AgentMessage = {
        id: 'tool-a',
        role: 'tool',
        content: '',
        timestamp: '',
        isExecuting: true,
        toolResult: {
          toolName: 'execute_command',
          summary: '$ sleep 100',
          result: 'partial',
          success: true,
          blocked: false,
          toolCallId: 'call-1',
        },
      };
      useConversationStore.setState({
        activeConversationId: 'conv-a',
        messages: {
          'conv-a': [
            { id: 'u1', role: 'user', content: '跑一下', timestamp: '' },
            inFlightTool,
          ],
        },
      });
      useTaskStore.setState({
        tasks: {
          'task-a': makeTask({ id: 'task-a', status: 'executing' }),
          // 等待审批同样占用席位，断连后不能留着橙点
          'task-approval': makeTask({ id: 'task-approval', status: 'waiting_approval' }),
          // 别的 session 的在飞任务不受影响
          'task-b': makeTask({ id: 'task-b', sessionId: 'sess-b', conversationId: 'conv-b' }),
        },
        activeTaskId: 'task-a',
      });

      sessionConversationBindingManager.onSessionDisconnected('sess-a', 'conn-1');

      const tasks = useTaskStore.getState().tasks;
      expect(tasks['task-a'].status).toBe('cancelled');
      expect(tasks['task-approval'].status).toBe('cancelled');
      expect(tasks['task-b'].status).toBe('executing');
      // 用户再也没有停止入口 → activeTaskId 必须一起清掉
      expect(useTaskStore.getState().activeTaskId).toBeNull();
      // 收尾三件套：拆通道 / 标记在飞卡片 / 落回合收尾状态
      expect(cleanupTaskListenersMock).toHaveBeenCalledWith('task-a');
      expect(cleanupTaskListenersMock).toHaveBeenCalledWith('task-approval');
      expect(cleanupTaskListenersMock).not.toHaveBeenCalledWith('task-b');
      const msgs = useConversationStore.getState().messages['conv-a'];
      expect(msgs[1].isExecuting).toBe(false);
      expect(msgs[1].toolResult?.wasAborted).toBe(true);
      expect(msgs[0].turnState).toBe('cancelled');
    });

    it('级联收尾该 session 的运行中子任务，已终态的跳过', () => {
      useSessionStore.setState({ sessions: { 'sess-a': makeSession('sess-a') } });
      useTaskStore.setState({
        tasks: {
          'main-1': makeTask({ id: 'main-1', status: 'executing' }),
          'sub-running': makeTask({
            id: 'sub-running',
            conversationId: 'sub-conv',
            status: 'planning',
            parentTaskId: 'main-1',
          }),
          'sub-done': makeTask({
            id: 'sub-done',
            conversationId: 'sub-conv',
            status: 'completed',
            parentTaskId: 'main-1',
          }),
        },
      });

      sessionConversationBindingManager.onSessionDisconnected('sess-a', 'conn-1');

      const tasks = useTaskStore.getState().tasks;
      expect(tasks['main-1'].status).toBe('cancelled');
      expect(tasks['sub-running'].status).toBe('cancelled');
      // 已自然完成的子任务不能被断连误标成取消
      expect(tasks['sub-done'].status).toBe('completed');
      expect(cleanupTaskListenersMock).toHaveBeenCalledWith('sub-running');
      expect(cleanupTaskListenersMock).not.toHaveBeenCalledWith('sub-done');
    });
  });
});
