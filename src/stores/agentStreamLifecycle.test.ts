import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listenMock, agentGetConversation, agentLoadConversation, agentStopTask } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  agentGetConversation: vi.fn(),
  agentLoadConversation: vi.fn(),
  agentStopTask: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/lib/tauri', () => ({ agentGetConversation, agentLoadConversation, agentStopTask }));

import {
  attachPlanListener,
  attachStreamListener,
  cleanupTaskListeners,
  handleSubTaskFallback,
} from '@/stores/agentStreamManager';
import { createDefaultStreamHandler } from '@/stores/storeStreamAdapter';
import { finalizeTaskLocally, useTaskStore } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import type { AgentMessage, AgentTask } from '@/lib/types';

/**
 * 流通道的生命周期与收尾（收尾前 flush / 取消句柄同步可用）。
 *
 * 这里用**真实**的 `agentStreamManager` + `agentStreamHandlers` + store，
 * 只把 Tauri 的 `listen` 换成受控事件总线 —— 要验的正是「注册往返」这个窗口
 * 与「收尾」之间的先后关系，mock 掉任一侧就什么都验不到。
 */

type BusListener = (event: { payload: unknown }) => void;

/** 事件名 → 已落地的回调（模拟 Tauri 事件总线：只在注册往返完成后才有）。 */
let bus: Map<string, BusListener>;
/** 已实际调用过的 unlisten（用来观察监听器有没有被摘掉）。 */
let unlistenCalls: string[];
/** 注册往返的手动闸门：`listen` 挂起不 resolve，直到 `flushDeferred()`。 */
let deferred: Array<() => void>;
let deferRegistration: boolean;
/** rAF 回调（node 环境没有 rAF，手动收集、手动跑）。 */
let rafCallbacks: Array<() => void>;

function flushDeferred() {
  const pending = deferred;
  deferred = [];
  for (const resolve of pending) resolve();
}

function emit(eventName: string, payload: unknown) {
  bus.get(eventName)?.({ payload });
}

function seedTask(overrides: Partial<AgentTask> = {}): AgentTask {
  const task: AgentTask = {
    id: 'task-1',
    sessionId: 's1',
    conversationId: 'conv-1',
    prompt: 'p',
    mode: 'agent',
    status: 'executing',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
  useTaskStore.setState((s) => ({ tasks: { ...s.tasks, [task.id]: task } }));
  return task;
}

function seedMessages(conversationId: string, msgs: AgentMessage[]) {
  useConversationStore.setState((s) => ({
    messages: { ...s.messages, [conversationId]: msgs },
  }));
}

describe('agentStreamLifecycle', () => {
  beforeEach(() => {
    deferRegistration = false;
    rafCallbacks = [];
    // 通道表是模块级状态、跨用例存活：先收掉上一个用例留下的通道，
    // 再重置观测数组（收尾动作本身也会写 unlistenCalls）。
    cleanupTaskListeners('task-1');
    cleanupTaskListeners('sub-1');
    bus = new Map();
    unlistenCalls = [];
    deferred = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    listenMock.mockImplementation((eventName: string, cb: BusListener) => {
      const register = () => {
        bus.set(eventName, cb);
        return () => {
          bus.delete(eventName);
          unlistenCalls.push(eventName);
        };
      };
      if (deferRegistration) {
        return new Promise<() => void>((resolve) => {
          deferred.push(() => resolve(register()));
        });
      }
      return Promise.resolve(register());
    });
    agentGetConversation.mockResolvedValue(null);
    agentLoadConversation.mockResolvedValue([]);
    agentStopTask.mockResolvedValue(undefined);
    useTaskStore.setState({ tasks: {}, activeTaskId: null });
    useConversationStore.setState({ conversations: {}, messages: {}, activeConversationId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('停止请求与实际退出', () => {
    async function runningTask() {
      seedTask();
      useTaskStore.setState({ activeTaskId: 'task-1' });
      seedMessages('conv-1', [
        { id: 'u1', role: 'user', content: '跑一下', timestamp: '', turnState: 'running' },
      ]);
      await attachStreamListener('task-1', 'conv-1', 'loading-1');
    }

    it('停止请求失败后仍能看到运行状态、继续接收输出并重新停止', async () => {
      await runningTask();
      agentStopTask.mockRejectedValueOnce({ kind: 'Agent', message: '停止请求未送达' });

      await expect(useTaskStore.getState().stopTask('task-1')).rejects.toMatchObject({
        message: '停止请求未送达',
      });

      expect(useTaskStore.getState().activeTaskId).toBe('task-1');
      expect(useTaskStore.getState().tasks['task-1'].status).toBe('executing');
      expect(bus.has('agent://stream/task-1')).toBe(true);
      expect(useConversationStore.getState().messages['conv-1'][0].turnState).toBe('running');
      emit('agent://stream/task-1', { type: 'textDelta', text: '任务仍在运行' });
      rafCallbacks.forEach((cb) => cb());
      const messages = useConversationStore.getState().messages['conv-1'];
      expect(messages[messages.length - 1]?.content).toBe('任务仍在运行');

      await useTaskStore.getState().stopTask('task-1');
      expect(agentStopTask).toHaveBeenCalledTimes(2);
    });

    it('停止请求尚未确认时保留停止入口和流监听', async () => {
      await runningTask();
      let confirm!: () => void;
      agentStopTask.mockReturnValueOnce(new Promise<void>((resolve) => { confirm = resolve; }));

      const stopping = useTaskStore.getState().stopTask('task-1');
      try {
        expect(useTaskStore.getState().activeTaskId).toBe('task-1');
        expect(useTaskStore.getState().tasks['task-1'].status).toBe('executing');
        expect(bus.has('agent://stream/task-1')).toBe(true);
      } finally {
        confirm();
        await stopping;
      }
    });

    it('停止命令已返回但工具尚未退出时保留按钮、卡片和监听，仍可重新停止', async () => {
      await runningTask();
      emit('agent://stream/task-1', { type: 'toolCallStart', id: 'call-1', name: 'bash' });

      await useTaskStore.getState().stopTask('task-1');

      expect(useTaskStore.getState().tasks['task-1']).toMatchObject({
        status: 'executing', stopRequested: true, stopping: true,
      });
      expect(useTaskStore.getState().activeTaskId).toBe('task-1');
      expect(bus.has('agent://stream/task-1')).toBe(true);
      expect(useConversationStore.getState().messages['conv-1'].find((m) => m.role === 'tool')?.isExecuting).toBe(true);
      await useTaskStore.getState().stopTask('task-1');
      expect(agentStopTask).toHaveBeenCalledTimes(2);

      emit('agent://stream/task-1', { type: 'cancelled' });

      expect(useTaskStore.getState().tasks['task-1'].status).toBe('cancelled');
      expect(useConversationStore.getState().messages['conv-1'][0].turnState).toBe('cancelled');
      expect(bus.has('agent://stream/task-1')).toBe(false);
    });

    it('重试已送达时，旧停止请求晚到的失败不会覆盖新请求状态', async () => {
      await runningTask();
      let reject!: (error: unknown) => void;
      agentStopTask.mockReturnValueOnce(new Promise<void>((_, fail) => { reject = fail; }));
      const oldRequest = useTaskStore.getState().stopTask('task-1');
      await useTaskStore.getState().stopTask('task-1');

      reject({ kind: 'Agent', message: '旧请求超时' });
      await oldRequest;

      expect(useTaskStore.getState().tasks['task-1']).toMatchObject({
        status: 'executing', stopping: true,
      });
      emit('agent://stream/task-1', { type: 'cancelled' });
      expect(useTaskStore.getState().tasks['task-1'].status).toBe('cancelled');
    });

    it('主任务退出不会提前拆掉仍在收尾的子任务监听', async () => {
      await runningTask();
      seedTask({ id: 'sub-1', parentTaskId: 'task-1', conversationId: 'sub-conv-1' });
      await attachStreamListener('sub-1', 'sub-conv-1', '');
      await useTaskStore.getState().stopTask('task-1');

      emit('agent://stream/task-1', { type: 'cancelled' });

      expect(useTaskStore.getState().tasks['sub-1'].status).toBe('executing');
      expect(bus.has('agent://stream/sub-1')).toBe(true);
      emit('agent://stream/sub-1', { type: 'cancelled' });
      expect(useTaskStore.getState().tasks['sub-1'].status).toBe('cancelled');
      expect(bus.has('agent://stream/sub-1')).toBe(false);
    });

    it('取消事件先于停止命令返回时保留中断工具卡，回合不会被当成自然完成', async () => {
      await runningTask();
      emit('agent://stream/task-1', { type: 'toolCallStart', id: 'call-1', name: 'bash' });
      agentStopTask.mockImplementationOnce(async () => {
        emit('agent://stream/task-1', { type: 'cancelled' });
      });

      await useTaskStore.getState().stopTask('task-1');

      const messages = useConversationStore.getState().messages['conv-1'];
      expect(messages[0].turnState).toBe('cancelled');
      expect(messages.find((m) => m.toolResult?.toolCallId === 'call-1')?.toolResult?.wasAborted).toBe(true);
      expect(useTaskStore.getState().tasks['task-1'].status).toBe('cancelled');
      expect(bus.has('agent://stream/task-1')).toBe(false);
    });

    it('旧停止请求晚返回时不影响已经开始的新回合', async () => {
      await runningTask();
      let confirm!: () => void;
      agentStopTask.mockReturnValueOnce(new Promise<void>((resolve) => { confirm = resolve; }));
      const stopping = useTaskStore.getState().stopTask('task-1');
      emit('agent://stream/task-1', { type: 'done' });
      seedTask({ id: 'task-2' });
      useTaskStore.setState({ activeTaskId: 'task-2' });
      seedMessages('conv-1', [
        { id: 'u2', role: 'user', content: '新任务', timestamp: '', turnState: 'running' },
      ]);

      confirm();
      await stopping;

      expect(useTaskStore.getState().tasks['task-1'].status).toBe('completed');
      expect(useTaskStore.getState().tasks['task-2'].status).toBe('executing');
      expect(useTaskStore.getState().activeTaskId).toBe('task-2');
      expect(useConversationStore.getState().messages['conv-1'][0].turnState).toBe('running');
    });
  });

  describe('attach 的顺序契约与取消', () => {
    it('注册往返未落地就收尾：晚到的监听当场回收，事件不再写进 store', async () => {
      deferRegistration = true;
      const attaching = attachStreamListener('task-1', 'conv-1', 'loading-1');

      // 取消赶在注册之前（任务刚发出去就被停止 / 会话断连）
      cleanupTaskListeners('task-1');
      expect(unlistenCalls).toEqual([]); // 注册还没落地，没有可摘的监听器

      flushDeferred();
      await attaching;

      // 注册比取消晚到 → 必须当场 unlisten。押到 await 之后再入表的旧写法
      // 会让这条监听器永远留在事件总线上（没人再调用它的 unlisten）。
      expect(unlistenCalls).toEqual(['agent://stream/task-1']);

      // 用户可见的后果：已收尾的任务不该再有文本回魂
      emit('agent://stream/task-1', { type: 'textDelta', text: '回魂了' });
      rafCallbacks.forEach((cb) => cb());
      expect(useConversationStore.getState().messages['conv-1']).toBeUndefined();
    });

    it('返回时底层注册已完成（startTask「先订阅、再启动」的顺序契约）', async () => {
      deferRegistration = true;
      let ready = false;
      const attaching = attachStreamListener('task-1', 'conv-1', '').then(() => {
        ready = true;
      });
      await Promise.resolve();
      expect(ready).toBe(false); // 注册往返还没结束
      expect(bus.has('agent://stream/task-1')).toBe(false);

      flushDeferred();
      await attaching;
      expect(ready).toBe(true);
      expect(bus.has('agent://stream/task-1')).toBe(true);
    });

    it('plan 通道同形：注册往返未落地就收尾也不留孤儿监听', async () => {
      deferRegistration = true;
      const attaching = attachPlanListener('task-1');
      cleanupTaskListeners('task-1');
      flushDeferred();
      await attaching;
      expect(unlistenCalls).toEqual(['agent://plan/task-1']);
    });
  });

  describe('收尾前的最后一笔 flush', () => {
    it('cleanupTaskListeners 把挂起的 delta 提交（界面不截断半句）', async () => {
      await attachStreamListener('task-1', 'conv-1', 'loading-1');
      emit('agent://stream/task-1', { type: 'textDelta', text: '最后半句' });
      // 同一帧内就被收尾：rAF 还没跑，delta 仍在缓冲里
      expect(rafCallbacks.length).toBeGreaterThan(0);
      expect(useConversationStore.getState().messages['conv-1']).toBeUndefined();

      cleanupTaskListeners('task-1');

      const msgs = useConversationStore.getState().messages['conv-1'];
      expect(msgs[msgs.length - 1]?.content).toBe('最后半句');
    });

    it('共用的收尾入口（finalizeTaskLocally）走同一条路：flush + 拆通道 + 落回合状态', async () => {
      seedTask({ id: 'task-1', conversationId: 'conv-1', status: 'executing' });
      useTaskStore.setState({ activeTaskId: 'task-1' });
      seedMessages('conv-1', [
        { id: 'u1', role: 'user', content: '跑一下', timestamp: '2026-01-01T00:00:00Z' },
      ]);
      await attachStreamListener('task-1', 'conv-1', 'loading-1');
      emit('agent://stream/task-1', { type: 'textDelta', text: '尾巴' });

      finalizeTaskLocally('task-1', 'cancelled');

      const convStore = useConversationStore.getState();
      const msgs = convStore.messages['conv-1'];
      expect(msgs[msgs.length - 1]?.content).toBe('尾巴');
      expect(convStore.messages['conv-1'][0].turnState).toBe('cancelled');
      expect(useTaskStore.getState().tasks['task-1'].status).toBe('cancelled');
      expect(useTaskStore.getState().activeTaskId).toBeNull();
      expect(unlistenCalls).toEqual(['agent://stream/task-1']);
    });
  });

  describe('子agent 兜底收敛', () => {
    it('收敛到终态后拆掉子任务通道（终态事件丢在挂载前也不留孤儿监听）', async () => {
      await attachStreamListener('sub-1', 'sub-conv-1', '');
      expect(bus.has('agent://stream/sub-1')).toBe(true);

      await handleSubTaskFallback(
        createDefaultStreamHandler(),
        'parent-1',
        { subTaskId: 'sub-1', subConversationId: 'sub-conv-1', status: 'completed' },
        'x',
        'p',
      );

      expect(unlistenCalls).toEqual(['agent://stream/sub-1']);
      expect(bus.has('agent://stream/sub-1')).toBe(false);
    });
  });
});
