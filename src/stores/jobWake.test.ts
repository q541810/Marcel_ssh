// @vitest-environment jsdom
// 需要 jsdom：sessionStore 间接引入终端单例（xterm 在 import 期就取 `self`）。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { listenMock, agentStartTask, jobPendingNotice, jobAckNotice } = vi.hoisted(() => ({
  listenMock: vi.fn(),
  agentStartTask: vi.fn(),
  jobPendingNotice: vi.fn(),
  jobAckNotice: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({ listen: listenMock }));
vi.mock('@/lib/tauri', () => ({ agentStartTask, jobPendingNotice, jobAckNotice }));

import { maybeContinueForConversation } from '@/stores/jobWake';
import { useConversationStore } from '@/stores/conversationStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useTaskStore } from '@/stores/taskStore';
import { MAX_AUTO_CONTINUES, __resetAllAutoContinues } from '@/stores/wakeBudget';
import type { AgentMessage, AgentTask } from '@/lib/types';

/**
 * 作业跑完的**自动继续**：作业结算 → 给那条会话开一轮把结局交给模型。
 *
 * 用真实 store（conversation / session / task），只把 Tauri IPC 换成受控桩 ——
 * 要验的正是「会不会开这一轮」以及开轮之后的三件事（落一条 notice 消息、
 * 确认已读、不抢 activeTaskId），mock 掉 store 就什么都验不到。
 */

const CONV = 'conv-a';
const SESSION = 's1';

function seedConversationLoaded(withMessages = true) {
  useConversationStore.setState((s) => ({
    conversations: {
      ...s.conversations,
      [CONV]: {
        id: CONV,
        connectionId: 'conn-1',
        title: '构建',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    },
    messages: {
      ...s.messages,
      [CONV]: withMessages
        ? [
            {
              id: 'm1',
              role: 'user',
              content: '帮我构建',
              timestamp: new Date().toISOString(),
            } satisfies AgentMessage,
          ]
        : [],
    },
  }));
}

function seedSession(status: 'connected' | 'disconnected' = 'connected') {
  useSessionStore.setState((s) => ({
    sessions: {
      ...s.sessions,
      [SESSION]: {
        id: SESSION,
        connectionId: 'conn-1',
        status,
        createdAt: new Date().toISOString(),
      },
    },
  }));
}

function seedBusyTask() {
  const task: AgentTask = {
    id: 'task-busy',
    sessionId: SESSION,
    conversationId: CONV,
    prompt: '别的活',
    mode: 'agent',
    status: 'executing',
    createdAt: new Date().toISOString(),
  };
  useTaskStore.setState((s) => ({ tasks: { ...s.tasks, [task.id]: task } }));
}

describe('jobWake（作业跑完自动继续）', () => {
  beforeEach(() => {
    __resetAllAutoContinues();
    listenMock.mockResolvedValue(() => {});
    agentStartTask.mockResolvedValue('task-auto');
    jobAckNotice.mockResolvedValue(1);
    jobPendingNotice.mockResolvedValue({
      text: '后台作业 job_1（构建）已完成\n用 job_output 读取其输出并纳入结论。',
      jobIds: ['job_1'],
    });
    useTaskStore.setState({ tasks: {}, activeTaskId: null });
    useConversationStore.setState({ conversations: {}, messages: {} });
    useSessionStore.setState({ sessions: {}, activeSessionId: null });
    seedConversationLoaded();
    seedSession();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('有可交付的结局 → 自动开一轮，并把告知作为 notice 落到会话里', async () => {
    await maybeContinueForConversation(CONV, SESSION);

    expect(agentStartTask).toHaveBeenCalledTimes(1);
    const call = agentStartTask.mock.calls[0];
    expect(call[0]).toBe(SESSION);
    expect(call[3]).toBe(CONV);
    // 最后一个参数是 prompt 来源：这条不是用户打的字
    expect(call[7]).toBe('job_notice');

    const msgs = useConversationStore.getState().messages[CONV] ?? [];
    const notice = msgs.find((m) => m.role === 'notice');
    expect(notice, '告知要以 notice 身份落进会话（不是用户气泡）').toBeTruthy();
    expect(notice?.content).toContain('job_1');

    // 真的开出去了才确认已读（送不出去就不算已读）
    expect(jobAckNotice).toHaveBeenCalledWith(['job_1']);
  });

  it('给别的会话自动继续**不抢** activeTaskId（不打扰用户正在看的会话）', async () => {
    // 用户此刻在别的会话里（activeConversationId 不是 CONV）
    useConversationStore.setState({ activeConversationId: 'conv-other' });

    await maybeContinueForConversation(CONV, SESSION);

    expect(agentStartTask).toHaveBeenCalledTimes(1);
    expect(useTaskStore.getState().activeTaskId).toBeNull();
  });

  it('会话里已经有任务在跑 → 不开轮（那一边会把结局注入进去）', async () => {
    seedBusyTask();
    await maybeContinueForConversation(CONV, SESSION);
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(jobAckNotice).not.toHaveBeenCalled();
  });

  it('连接断了 → 不开轮，结局留着等用户下次开口', async () => {
    seedSession('disconnected');
    await maybeContinueForConversation(CONV, SESSION);
    expect(agentStartTask).not.toHaveBeenCalled();
    expect(jobPendingNotice).not.toHaveBeenCalled();
  });

  it('会话消息没加载 → 不开轮（否则模型拿到的是空历史）', async () => {
    useConversationStore.setState((s) => ({ messages: { ...s.messages, [CONV]: [] } }));
    await maybeContinueForConversation(CONV, SESSION);
    expect(agentStartTask).not.toHaveBeenCalled();
  });

  it('开轮失败 → 不确认已读、不花额度（结局下一轮还能交出去）', async () => {
    agentStartTask.mockRejectedValueOnce(new Error('boom'));
    await maybeContinueForConversation(CONV, SESSION);

    expect(jobAckNotice).not.toHaveBeenCalled();

    // 额度没被花掉：下一次结算还能开轮
    await maybeContinueForConversation(CONV, SESSION);
    expect(agentStartTask).toHaveBeenCalledTimes(2);
    expect(jobAckNotice).toHaveBeenCalledTimes(1);
  });

  it('额度封顶：连开 3 轮之后不再自动开（结局留着等用户开口）', async () => {
    for (let i = 0; i < MAX_AUTO_CONTINUES; i += 1) {
      // 每轮都要先把上一轮的任务收掉，否则「有任务在跑」先把它挡住
      useTaskStore.setState({ tasks: {}, activeTaskId: null });
      await maybeContinueForConversation(CONV, SESSION);
      expect(agentStartTask).toHaveBeenCalledTimes(i + 1);
    }

    useTaskStore.setState({ tasks: {}, activeTaskId: null });
    await maybeContinueForConversation(CONV, SESSION);
    expect(agentStartTask).toHaveBeenCalledTimes(MAX_AUTO_CONTINUES);
  });

  it('用户说一句话 → 额度回满（只有人的输入能回填）', async () => {
    // 先花光额度
    for (let i = 0; i < MAX_AUTO_CONTINUES; i += 1) {
      useTaskStore.setState({ tasks: {}, activeTaskId: null });
      await maybeContinueForConversation(CONV, SESSION);
    }
    useTaskStore.setState({ tasks: {}, activeTaskId: null });
    await maybeContinueForConversation(CONV, SESSION);
    expect(agentStartTask).toHaveBeenCalledTimes(MAX_AUTO_CONTINUES);

    // 用户在该会话里真的发了句话（走非 job_notice 的普通路径）
    useConversationStore.setState({ activeConversationId: CONV });
    await useTaskStore.getState().startTask(SESSION, '接着上次说', 'conn-1');
    useTaskStore.setState({ tasks: {}, activeTaskId: null });

    await maybeContinueForConversation(CONV, SESSION);
    expect(agentStartTask).toHaveBeenCalledTimes(MAX_AUTO_CONTINUES + 2);
  });

  it('后端说没有待交付的结局 → 什么都别做', async () => {
    jobPendingNotice.mockResolvedValue(null);
    await maybeContinueForConversation(CONV, SESSION);
    expect(agentStartTask).not.toHaveBeenCalled();
  });
});
