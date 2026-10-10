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
import { resetAgentDrafts, useAgentDraftStore } from '@/stores/agentDraftStore';
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function seedDeletionRecovery(withFreeConversation = false) {
  const makeConversation = (id: string, updatedAt: string): AgentConversation => ({
    id, connectionId: 'conn-1', title: id, createdAt: updatedAt, updatedAt,
  });
  useSessionStore.setState({
    activeSessionId: 'sess-a',
    sessions: { 'sess-a': makeSession('sess-a'), 'sess-b': makeSession('sess-b') },
  });
  useConversationStore.setState({
    activeConversationId: 'conv-a',
    activeConversationBySession: { 'sess-a': 'conv-a', 'sess-b': 'conv-b' },
    activeConversationByConnection: { 'conn-1': 'conv-a' },
    conversations: {
      'conv-a': makeConversation('conv-a', '2026-01-03T00:00:00Z'),
      'conv-b': makeConversation('conv-b', '2026-01-02T00:00:00Z'),
      ...(withFreeConversation ? { 'conv-free': makeConversation('conv-free', '2026-01-01T00:00:00Z') } : {}),
    },
    messages: { 'conv-a': [], 'conv-b': [], ...(withFreeConversation ? { 'conv-free': [] } : {}) },
  });
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

  describe('删除后恢复当前在线标签的绑定', () => {
    beforeEach(() => {
      resetAgentDrafts();
      useTaskStore.setState({ tasks: {}, activeTaskId: null, plans: {}, compacting: {} });
      vi.mocked(tauri.agentDeleteConversation).mockResolvedValue(undefined);
      vi.mocked(tauri.agentCreateConversation).mockResolvedValue('conv-replacement');
      vi.mocked(tauri.agentLoadActiveMessages).mockResolvedValue({ messages: [], hasEarlier: false, checkpointId: null });
      vi.mocked(tauri.agentLoadPlansByConversation).mockResolvedValue([]);
      vi.mocked(tauri.agentListConversationsByConnection).mockImplementation(async () =>
        Object.values(useConversationStore.getState().conversations));
    });

    it('删除当前会话后绑定空闲历史，跳过其他在线标签占用的会话', async () => {
      seedDeletionRecovery(true);
      const cached: AgentMessage = { id: 'cached', role: 'user', content: '已有历史', timestamp: '' };
      useConversationStore.setState((state) => ({ messages: { ...state.messages, 'conv-free': [cached] } }));

      await useConversationStore.getState().deleteConversation('conv-a');

      const state = useConversationStore.getState();
      expect(state.activeConversationBySession).toEqual({ 'sess-a': 'conv-free', 'sess-b': 'conv-b' });
      expect(state.activeConversationId).toBe('conv-free');
      expect(state.activeConversationByConnection['conn-1']).toBe('conv-free');
      expect(state.messages['conv-free']).toEqual([cached]);
      expect(tauri.agentCreateConversation).not.toHaveBeenCalled();
      expect(tauri.agentLoadActiveMessages).not.toHaveBeenCalled();
    });

    it('删除当前会话后剩余历史全被占用，创建并绑定独立新会话', async () => {
      seedDeletionRecovery();

      await useConversationStore.getState().deleteConversation('conv-a');

      expect(tauri.agentCreateConversation).toHaveBeenCalledWith('sess-a');
      const state = useConversationStore.getState();
      expect(state.activeConversationBySession).toEqual({ 'sess-a': 'conv-replacement', 'sess-b': 'conv-b' });
      expect(state.activeConversationId).toBe('conv-replacement');
      expect(state.conversations['conv-replacement']).toMatchObject({ connectionId: 'conn-1', title: '新会话' });
      expect(state.messages['conv-replacement']).toEqual([]);
    });

    it('恢复冷历史时加载正文和附件元数据，完成前不把占用会话绑定给当前标签', async () => {
      seedDeletionRecovery(true);
      vi.mocked(tauri.agentLoadActiveMessages).mockResolvedValue({
        messages: [{
          id: 'stored', conversationId: 'conv-free', role: 'user', content: '原文',
          timestamp: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z',
          userInputJson: '{"version":1,"text":"原文","textAttachments":[]}',
        }],
        hasEarlier: true, checkpointId: null,
      });

      await useConversationStore.getState().deleteConversation('conv-a');

      expect(tauri.agentLoadActiveMessages).toHaveBeenCalledWith('conv-free');
      expect(tauri.agentLoadPlansByConversation).toHaveBeenCalledWith('conv-free');
      expect(useConversationStore.getState().messages['conv-free'][0]).toMatchObject({
        content: '原文', userInput: { version: 1, text: '原文', textAttachments: [] },
      });
      expect(useConversationStore.getState().hasEarlierMessages['conv-free']).toBe(true);
    });

    it.each(['switch-tab', 'disconnect', 'select-other'] as const)(
      '删除等待期间 %s，清理成功后不抢用户的新页面', async (action) => {
        seedDeletionRecovery(true);
        const pending = deferred<void>();
        vi.mocked(tauri.agentDeleteConversation).mockReturnValueOnce(pending.promise);
        const deletion = useConversationStore.getState().deleteConversation('conv-a');
        if (action === 'switch-tab') {
          useSessionStore.setState({ activeSessionId: 'sess-b' });
          useConversationStore.setState({ activeConversationId: 'conv-b' });
        } else if (action === 'disconnect') {
          useSessionStore.setState((state) => ({ sessions: {
            ...state.sessions, 'sess-a': { ...state.sessions['sess-a'], status: 'disconnected' },
          } }));
        } else {
          await useConversationStore.getState().switchConversation('conv-free', 'sess-a');
        }
        pending.resolve(undefined);
        await deletion;

        expect(tauri.agentCreateConversation).not.toHaveBeenCalled();
        if (action === 'switch-tab') {
          expect(useSessionStore.getState().activeSessionId).toBe('sess-b');
          expect(useConversationStore.getState().activeConversationId).toBe('conv-b');
        } else if (action === 'select-other') {
          expect(useConversationStore.getState().activeConversationId).toBe('conv-free');
          expect(useConversationStore.getState().activeConversationBySession['sess-a']).toBe('conv-free');
        } else {
          expect(useConversationStore.getState().activeConversationBySession['sess-a']).toBeUndefined();
        }
      },
    );

    it('自动新建等待期间用户自己新建，迟到自动结果不覆盖手动选择', async () => {
      seedDeletionRecovery();
      const pending = deferred<string>();
      vi.mocked(tauri.agentCreateConversation).mockReturnValueOnce(pending.promise).mockResolvedValueOnce('manual-new');
      const deletion = useConversationStore.getState().deleteConversation('conv-a');
      await vi.waitFor(() => expect(tauri.agentCreateConversation).toHaveBeenCalledTimes(1));
      await useConversationStore.getState().newConversation('sess-a', 'conn-1');
      pending.resolve('late-auto-new');
      await deletion;

      expect(useConversationStore.getState().activeConversationId).toBe('manual-new');
      expect(useConversationStore.getState().activeConversationBySession['sess-a']).toBe('manual-new');
    });

    it('用户已点击另一个会话但尚未加载完成时，旧恢复结果也作废', async () => {
      seedDeletionRecovery(true);
      const recoveryLoad = deferred<Awaited<ReturnType<typeof tauri.agentLoadActiveMessages>>>();
      const manualLoad = deferred<Awaited<ReturnType<typeof tauri.agentLoadActiveMessages>>>();
      vi.mocked(tauri.agentLoadActiveMessages).mockImplementation((id) =>
        id === 'conv-free' ? recoveryLoad.promise : manualLoad.promise);
      const deletion = useConversationStore.getState().deleteConversation('conv-a');
      await vi.waitFor(() => expect(tauri.agentLoadActiveMessages).toHaveBeenCalledWith('conv-free'));
      const selection = useConversationStore.getState().switchConversation('conv-b', 'sess-a');
      recoveryLoad.resolve({ messages: [], hasEarlier: false, checkpointId: null });
      await deletion;
      expect(useConversationStore.getState().activeConversationBySession['sess-a']).toBeUndefined();
      manualLoad.resolve({ messages: [], hasEarlier: false, checkpointId: null });
      await selection;
      expect(useConversationStore.getState().activeConversationId).toBe('conv-b');
    });

    it('候选加载期间被别的在线标签占用，重新分配而不双重绑定', async () => {
      seedDeletionRecovery(true);
      const pending = deferred<Awaited<ReturnType<typeof tauri.agentLoadActiveMessages>>>();
      vi.mocked(tauri.agentLoadActiveMessages).mockReturnValueOnce(pending.promise);
      const deletion = useConversationStore.getState().deleteConversation('conv-a');
      await vi.waitFor(() => expect(tauri.agentLoadActiveMessages).toHaveBeenCalledWith('conv-free'));
      useSessionStore.setState((state) => ({ sessions: { ...state.sessions, 'sess-c': makeSession('sess-c') } }));
      useConversationStore.getState().bindConversationToSession('sess-c', 'conv-free', 'conn-1');
      pending.resolve({ messages: [], hasEarlier: false, checkpointId: null });
      await deletion;

      expect(useConversationStore.getState().activeConversationBySession).toEqual({
        'sess-a': 'conv-replacement', 'sess-b': 'conv-b', 'sess-c': 'conv-free',
      });
    });

    it('当前空闲候选加载期间又被删除，继续恢复且不重建已删历史', async () => {
      seedDeletionRecovery(true);
      useConversationStore.setState((state) => ({ conversations: {
        ...state.conversations,
        'conv-free': { ...state.conversations['conv-free'], updatedAt: '2026-01-04T00:00:00Z' },
      } }));
      const pending = deferred<Awaited<ReturnType<typeof tauri.agentLoadActiveMessages>>>();
      vi.mocked(tauri.agentLoadActiveMessages).mockReturnValueOnce(pending.promise);
      const deletion = useConversationStore.getState().deleteConversation('conv-a');
      await vi.waitFor(() => expect(tauri.agentLoadActiveMessages).toHaveBeenCalledWith('conv-free'));
      expect(useConversationStore.getState().activeConversationId).toBe('conv-free');
      await useConversationStore.getState().deleteConversation('conv-free');
      pending.resolve({ messages: [], hasEarlier: false, checkpointId: null });
      await deletion;

      const state = useConversationStore.getState();
      expect(state.activeConversationBySession).toEqual({ 'sess-a': 'conv-replacement', 'sess-b': 'conv-b' });
      expect(state.activeConversationId).toBe('conv-replacement');
      expect(state.conversations['conv-free']).toBeUndefined();
      expect(state.messages['conv-free']).toBeUndefined();
    });

    it('恢复失败不把已成功删除报告成失败，并保留可操作的原因', async () => {
      seedDeletionRecovery();
      vi.mocked(tauri.agentCreateConversation).mockRejectedValueOnce({ kind: 'Io', message: '数据库暂不可用' });

      await expect(useConversationStore.getState().deleteConversation('conv-a')).resolves.toBeUndefined();

      expect(useConversationStore.getState().conversations['conv-a']).toBeUndefined();
      expect(useAgentDraftStore.getState().getDraft('session:sess-a').notice).toContain('数据库暂不可用');
      expect(useAgentDraftStore.getState().getDraft('session:sess-a').notice).toContain('新建');
    });

    it('离线历史删除和非当前会话删除维持原行为，不启动自动分配', async () => {
      seedDeletionRecovery(true);
      await useConversationStore.getState().deleteConversation('conv-free');
      expect(useConversationStore.getState().activeConversationId).toBe('conv-a');
      useSessionStore.setState({ activeSessionId: null, sessions: {} });
      await useConversationStore.getState().deleteConversation('conv-a');
      expect(tauri.agentCreateConversation).not.toHaveBeenCalled();
      expect(tauri.agentLoadActiveMessages).not.toHaveBeenCalled();
    });
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
