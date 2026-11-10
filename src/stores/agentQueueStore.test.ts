// @vitest-environment jsdom
// 需要 jsdom：sessionStore 间接引入终端单例（xterm 在 import 期就取 `self`）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listenMock, agentStartTask, agentDeleteMessageImage, agentStopTask } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  agentStartTask: vi.fn(),
  agentDeleteMessageImage: vi.fn(),
  agentStopTask: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/lib/tauri', () => ({
  agentStartTask,
  agentStopTask,
  agentDeleteMessageImage,
  agentSaveUserMessage: vi.fn().mockResolvedValue(undefined),
  agentSaveMessageImages: vi.fn().mockResolvedValue(['/saved/new.webp']),
  agentReadMessageImage: vi.fn(),
  agentGetLocalFileName: vi.fn(),
  agentReadLocalFile: vi.fn(),
}));

import {
  MAX_QUEUED_MESSAGES,
  drainQueue,
  initAgentQueue,
  useAgentQueueStore,
} from '@/stores/agentQueueStore';
import { draftKeyFor, resetAgentDrafts, useAgentDraftStore } from '@/stores/agentDraftStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useTaskStore } from '@/stores/taskStore';
import type { AgentTask } from '@/lib/types';
import type { DetachedDraft } from '@/stores/agentDraftStore';

const CONV = 'conv-a';
const SESSION = 's1';

function detached(text: string, extra: Partial<DetachedDraft> = {}): DetachedDraft {
  return {
    text,
    images: [],
    textAttachments: [],
    skills: [],
    userInput: { version: 1, text, textAttachments: [] },
    ...extra,
  };
}

function queue(text: string, extra: Partial<DetachedDraft> = {}) {
  return useAgentQueueStore.getState().enqueue({
    conversationId: CONV,
    sessionId: SESSION,
    connectionId: 'cfg-1',
    draft: detached(text, extra),
  });
}

function seedConversation() {
  useConversationStore.setState((s) => ({
    conversations: {
      ...s.conversations,
      [CONV]: {
        id: CONV,
        connectionId: 'cfg-1',
        title: '会话',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
    messages: {
      ...s.messages,
      [CONV]: [
        { id: 'm1', role: 'user', content: '开头', timestamp: new Date().toISOString() },
      ],
    },
    activeConversationId: CONV,
  }));
}

function seedSession(status: 'connected' | 'disconnected' = 'connected') {
  useSessionStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [SESSION]: {
        id: SESSION,
        connectionId: 'conn-1',
        configId: 'cfg-1',
        status,
        createdAt: new Date().toISOString(),
      },
    },
  }));
}

function seedRunningTask(id = 'task-1'): AgentTask {
  const task: AgentTask = {
    id,
    sessionId: SESSION,
    conversationId: CONV,
    prompt: '正在跑',
    mode: 'agent',
    status: 'executing',
    createdAt: new Date().toISOString(),
  };
  useTaskStore.setState((s) => ({ tasks: { ...s.tasks, [id]: task } }));
  return task;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

let detach: () => void;

beforeEach(() => {
  vi.clearAllMocks();
  listenMock.mockResolvedValue(() => {});
  agentStartTask.mockResolvedValue(undefined);
  agentStopTask.mockResolvedValue(undefined);
  agentDeleteMessageImage.mockResolvedValue(undefined);
  useAgentQueueStore.setState({ items: {}, paused: {} });
  useTaskStore.setState({ tasks: {}, activeTaskId: null, compacting: {} });
  resetAgentDrafts();
  seedConversation();
  seedSession();
  detach = initAgentQueue();
});

afterEach(() => detach());

describe('发送队列：自然结束后自动发', () => {
  it('任务 completed 后发出队首，队列清空', async () => {
    seedRunningTask();
    queue('第二件事');
    useTaskStore.getState().updateTaskStatus('task-1', 'completed');
    await vi.waitFor(() => expect(agentStartTask).toHaveBeenCalledTimes(1));
    expect(agentStartTask.mock.calls[0][1]).toBe('第二件事');
    expect(useAgentQueueStore.getState().items[CONV]).toBeUndefined();
  });

  it('先进先出：一次只发一条，下一条等新一轮结束', async () => {
    seedRunningTask();
    queue('甲');
    queue('乙');
    useTaskStore.getState().updateTaskStatus('task-1', 'completed');
    await vi.waitFor(() => expect(agentStartTask).toHaveBeenCalledTimes(1));
    await settle();
    expect(agentStartTask).toHaveBeenCalledTimes(1);
    expect(useAgentQueueStore.getState().items[CONV]?.map((m) => m.draft.text)).toEqual(['乙']);

    // 甲这一轮收尾 → 乙发出
    const newTaskId = Object.keys(useTaskStore.getState().tasks).find((id) => id !== 'task-1')!;
    useTaskStore.getState().updateTaskStatus(newTaskId, 'completed');
    await vi.waitFor(() => expect(agentStartTask).toHaveBeenCalledTimes(2));
    expect(agentStartTask.mock.calls[1][1]).toBe('乙');
  });

  it('带文本附件/skill 的条目按原样把 userInput 交给 startTask', async () => {
    seedRunningTask();
    const userInput = {
      version: 1 as const,
      text: '看下',
      textAttachments: [{ id: 'a', name: 'x.txt', content: 'port=22' }],
    };
    queue('看下', { textAttachments: userInput.textAttachments, userInput });
    useTaskStore.getState().updateTaskStatus('task-1', 'completed');
    await vi.waitFor(() => expect(agentStartTask).toHaveBeenCalledTimes(1));
    // 第 9 个参数是 userInput；prompt 是拼装后的完整输入
    expect(agentStartTask.mock.calls[0][8]).toEqual(userInput);
    expect(agentStartTask.mock.calls[0][1]).toContain('port=22');
  });
});

describe('发送队列：停止 / 出错 / 断连 → 暂停而不是替用户做主', () => {
  it('停止请求尚未返回就自然完成，也不自动发出下一条消息', async () => {
    seedRunningTask();
    queue('排着的');
    let confirm!: () => void;
    agentStopTask.mockReturnValueOnce(new Promise<void>((resolve) => { confirm = resolve; }));

    const stopping = useTaskStore.getState().stopTask('task-1');
    try {
      useTaskStore.getState().updateTaskStatus('task-1', 'completed');
      await settle();

      expect(agentStartTask).not.toHaveBeenCalled();
      expect(useAgentQueueStore.getState().paused[CONV]).toEqual({ kind: 'stopped' });
      expect(useAgentQueueStore.getState().items[CONV]).toHaveLength(1);
    } finally {
      confirm();
      await stopping;
    }
  });

  it('用户停止 → 暂停，不自动发；点继续后才发', async () => {
    seedRunningTask();
    queue('排着的');
    useTaskStore.getState().updateTaskStatus('task-1', 'cancelled');
    await settle();
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(useAgentQueueStore.getState().paused[CONV]).toEqual({ kind: 'stopped' });
    expect(useAgentQueueStore.getState().items[CONV]).toHaveLength(1);

    useAgentQueueStore.getState().resume(CONV);
    await vi.waitFor(() => expect(agentStartTask).toHaveBeenCalledTimes(1));
    expect(useAgentQueueStore.getState().paused[CONV]).toBeUndefined();
  });

  it('任务失败 → 暂停并标明原因', async () => {
    seedRunningTask();
    queue('排着的');
    useTaskStore.getState().updateTaskStatus('task-1', 'failed');
    await settle();
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(useAgentQueueStore.getState().paused[CONV]).toEqual({ kind: 'failed' });
  });

  it('SSH 会话已断开 → 条目保留并暂停', async () => {
    seedRunningTask();
    queue('排着的');
    seedSession('disconnected');
    useTaskStore.getState().updateTaskStatus('task-1', 'completed');
    await vi.waitFor(() =>
      expect(useAgentQueueStore.getState().paused[CONV]).toEqual({ kind: 'disconnected' }),
    );
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(useAgentQueueStore.getState().items[CONV]).toHaveLength(1);
  });

  it('后端启动失败 → 暂停并带上原因，不继续灌下一条', async () => {
    seedRunningTask();
    queue('甲');
    queue('乙');
    agentStartTask.mockRejectedValueOnce(new Error('后端炸了'));
    useTaskStore.getState().updateTaskStatus('task-1', 'completed');
    await vi.waitFor(() => expect(useAgentQueueStore.getState().paused[CONV]).toBeDefined());
    const reason = useAgentQueueStore.getState().paused[CONV];
    expect(reason?.kind).toBe('startFailed');
    expect(agentStartTask).toHaveBeenCalledTimes(1);
    expect(useAgentQueueStore.getState().items[CONV]?.map((m) => m.draft.text)).toEqual(['乙']);
  });

  it('子 agent 的终态不触发队列', async () => {
    seedRunningTask();
    useTaskStore.setState((s) => ({
      tasks: {
        ...s.tasks,
        sub: {
          id: 'sub',
          sessionId: SESSION,
          conversationId: CONV,
          prompt: '子任务',
          mode: 'plan',
          status: 'executing',
          createdAt: new Date().toISOString(),
          parentTaskId: 'task-1',
        } satisfies AgentTask,
      },
    }));
    queue('排着的');
    useTaskStore.getState().updateTaskStatus('sub', 'completed');
    await settle();
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(useAgentQueueStore.getState().paused[CONV]).toBeUndefined();
  });
});

describe('发送队列：管理操作', () => {
  it('drainQueue 在会话忙时什么都不做', async () => {
    seedRunningTask();
    queue('排着的');
    await drainQueue(CONV);
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(useAgentQueueStore.getState().items[CONV]).toHaveLength(1);
  });

  it('超过上限拒绝入队', () => {
    for (let i = 0; i < MAX_QUEUED_MESSAGES; i++) expect(queue(`m${i}`)).toBe(true);
    expect(queue('多的一条')).toBe(false);
  });

  it('移除条目回收它落盘的图片；清空同理', () => {
    const image = { id: 'i', name: 'a.png', dataUrl: 'data:image/png;base64,AA==', persistedPath: '/saved/a.webp' };
    queue('带图', { images: [image] });
    const id = useAgentQueueStore.getState().items[CONV][0].id;
    useAgentQueueStore.getState().remove(CONV, id);
    expect(agentDeleteMessageImage).toHaveBeenCalledWith('/saved/a.webp');
    expect(useAgentQueueStore.getState().items[CONV]).toBeUndefined();
  });

  it('删除会话时队列随之清空', () => {
    queue('排着的');
    useConversationStore.setState((s) => {
      const conversations = { ...s.conversations };
      delete conversations[CONV];
      return { conversations };
    });
    expect(useAgentQueueStore.getState().items[CONV]).toBeUndefined();
  });

  it('取回编辑：条目回到该会话的草稿，队列移除', () => {
    queue('要改的话');
    const id = useAgentQueueStore.getState().items[CONV][0].id;
    expect(useAgentQueueStore.getState().pullBack(CONV, id)).toBe(true);
    expect(useAgentQueueStore.getState().items[CONV]).toBeUndefined();
    expect(useAgentDraftStore.getState().getDraft(draftKeyFor(CONV, null)).text).toBe('要改的话');
  });
});

describe('草稿脱离 / 还原', () => {
  it('takeDetachedDraft 不留下「正在发送」计数，restoreDetached 原样放回', () => {
    const key = draftKeyFor(CONV, SESSION);
    const drafts = useAgentDraftStore.getState();
    drafts.setText(key, '一段话');
    drafts.addSkill(key, { skillId: 'sk', name: 'deploy', content: '步骤' });
    const taken = drafts.takeDetachedDraft(key, true);
    expect(taken?.text).toBe('一段话');
    expect(taken?.skills).toHaveLength(1);
    expect(useAgentDraftStore.getState().sending[key]).toBeUndefined();
    expect(useAgentDraftStore.getState().getDraft(key).text).toBe('');

    useAgentDraftStore.getState().restoreDetached(key, taken!);
    const back = useAgentDraftStore.getState().getDraft(key);
    expect(back.text).toBe('一段话');
    expect(back.skills.map((s) => s.name)).toEqual(['deploy']);
  });

  it('空草稿取不到', () => {
    expect(useAgentDraftStore.getState().takeDetachedDraft(draftKeyFor(CONV, SESSION), true)).toBeNull();
  });
});
