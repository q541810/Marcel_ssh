import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listenMock, agentGetConversation, agentLoadConversation } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  agentGetConversation: vi.fn(),
  agentLoadConversation: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/lib/tauri', () => ({ agentGetConversation, agentLoadConversation }));

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
    useTaskStore.setState({ tasks: {}, activeTaskId: null });
    useConversationStore.setState({ conversations: {}, messages: {}, activeConversationId: null });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
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
