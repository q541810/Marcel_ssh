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

import { initJobWake, maybeContinueForConversation, onTurnFinished } from '@/stores/jobWake';
import { useConversationStore } from '@/stores/conversationStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useTaskStore } from '@/stores/taskStore';
import { MAX_AUTO_CONTINUES, __resetAllAutoContinues } from '@/stores/wakeBudget';
import { LOCAL_SESSION_SENTINEL } from '@/lib/toolCatalog';
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

/**
 * 把某条对话绑定到一条在线会话上 —— 本机作业要唤醒靠的就是这份绑定
 * （`sessionConversationBindingManager.findOccupyingSession` 的第 2 步）。
 */
function bindConversationToSession(sessionId = SESSION, conversationId = CONV) {
  useConversationStore.setState((s) => ({
    activeConversationBySession: { ...s.activeConversationBySession, [sessionId]: conversationId },
  }));
}

/**
 * 一条已收尾的本机子任务（`sessionId` 是哨兵，归属对话由参数给）。
 *
 * 默认 `completed`：`onTurnFinished` 是在 `handleDone` 把任务收敛成终态**之后**
 * 才调的，终态才不会把「对话有任务在跑」这条挡住。
 */
function seedLocalSubTask(conversationId = CONV, id = 'sub-local'): AgentTask {
  const task: AgentTask = {
    id,
    sessionId: LOCAL_SESSION_SENTINEL,
    conversationId,
    prompt: '本机调研',
    mode: 'plan',
    status: 'completed',
    createdAt: new Date().toISOString(),
    parentTaskId: 'task-parent',
  };
  useTaskStore.setState((s) => ({ tasks: { ...s.tasks, [task.id]: task } }));
  return task;
}

/**
 * 把一条 `job://updated` 按**后端真实载荷**投递给 jobWake 的监听器。
 *
 * 载荷形状照抄后端 `JobInfo` 的 serde 输出（snake_case，无 camelCase 别名）——
 * 与 `jobStore.mapJob` 的注释写的是同一条契约。
 */
function emitJobUpdated(payload: Record<string, unknown>) {
  const call = listenMock.mock.calls.find(([name]) => name === 'job://updated');
  if (!call) throw new Error('job://updated 没有订阅者');
  (call[1] as (event: { payload: unknown }) => void)({ payload });
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
    useTaskStore.setState({ tasks: {}, activeTaskId: null, compacting: {} });
    useConversationStore.setState({
      conversations: {},
      messages: {},
      activeConversationBySession: {},
    });
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

  it('事件载荷是后端真实形状（snake_case）时也要唤醒', async () => {
    // 这条是实况 bug 的回归：后端 `JobInfo` 是 serde 默认的 snake_case，事件里
    // 发出来的是 `owner_conversation_id` / `session_id`，没有 camelCase 别名。
    // 按 camelCase 读 → 字段全是 undefined → 撞上「无归属 → 不唤醒」的早退，
    // 作业跑完什么都不发生（没有系统告知卡、结局也交不回模型）。
    // 上面的用例直接调 maybeContinueForConversation 传 camelCase 参数，碰不到
    // 这条边，所以它一直是绿的。
    const unsub = initJobWake();
    try {
      emitJobUpdated({
        job_id: 'job_1',
        session_id: SESSION,
        task_id: 'task-1',
        owner_conversation_id: CONV,
        description: '构建',
        command: 'pnpm build',
        status: 'completed',
        started_at_millis: 1000,
        finished_at_millis: 2000,
        total_output_bytes: 42,
      });

      await vi.waitFor(() => expect(agentStartTask).toHaveBeenCalledTimes(1));
      // 开出去的那一轮仍是「作业告知」身份
      expect(agentStartTask.mock.calls[0][7]).toBe('job_notice');
      expect(jobAckNotice).toHaveBeenCalledWith(['job_1']);
    } finally {
      unsub();
    }
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

  it('会话正在压缩上下文 → 不开轮（这一轮写进去的告知会被压缩卡盖到后面）', async () => {
    // 压缩不是任务，只看 tasks 时它完全隐形：而压缩卡按「提交那一刻的队尾」落位，
    // 这条自动继续写进去的告知会被卡片盖到后面、被归档边界从后续请求里抹掉 ——
    // 而且这条路径不需要用户做任何操作，漏掉就是静默丢上下文。
    useTaskStore.setState({ compacting: { [CONV]: true } });

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

  /**
   * 本机作业（`local_bash(run_in_background: true)`，id 形如 `local_job_N`）：
   * `sessionId` 是哨兵值，没有 SSH 会话可查。后端两台 manager 的待播报结局是
   * 合并的（本机作业照样「活得比回合久」），前端这一格过去拿哨兵去
   * `sessionIsConnected` 查连接 → 必然 `connected: false` → 静默早退，整条自动
   * 继续在本机作业上端到端断掉（没有告知卡、结局也交不回模型）。
   */
  describe('本机作业（sessionId 是哨兵）', () => {
    it('对话绑着活跃会话 → 按那条真会话唤醒（不是拿哨兵去开轮）', async () => {
      bindConversationToSession();

      await maybeContinueForConversation(CONV, LOCAL_SESSION_SENTINEL);

      expect(agentStartTask).toHaveBeenCalledTimes(1);
      const call = agentStartTask.mock.calls[0];
      expect(call[0], '开轮必须挂在真会话上，不能是哨兵').toBe(SESSION);
      expect(call[3]).toBe(CONV);
      expect(call[7]).toBe('job_notice');
      expect(jobAckNotice).toHaveBeenCalledWith(['job_1']);
    });

    it('事件路径（后端载荷 session_id="local"）同样唤醒', async () => {
      // 事件路径是本机作业的常规入口：handleJobEvent 把哨兵原样往下传，
      // 由 resolveWakeSessionId 按归属对话解析，不能在这里被吞掉。
      bindConversationToSession();
      const unsub = initJobWake();
      try {
        emitJobUpdated({
          job_id: 'local_job_1',
          session_id: LOCAL_SESSION_SENTINEL,
          owner_conversation_id: CONV,
          description: '本机构建',
          command: 'pnpm build',
          status: 'completed',
          started_at_millis: 1000,
          finished_at_millis: 2000,
          total_output_bytes: 42,
        });

        await vi.waitFor(() => expect(agentStartTask).toHaveBeenCalledTimes(1));
        expect(agentStartTask.mock.calls[0][0]).toBe(SESSION);
      } finally {
        unsub();
      }
    });

    it('那条对话没绑定任何活跃会话 → 不唤醒，也不抛错（不伪造会话）', async () => {
      // 用户没在任何标签里看那条对话（或会话已断）：没有「哪条会话属于它」的
      // 事实可用，宁可不开轮 —— 结局留在后台等用户下次开口。
      await expect(
        maybeContinueForConversation(CONV, LOCAL_SESSION_SENTINEL),
      ).resolves.toBeUndefined();

      expect(agentStartTask).not.toHaveBeenCalled();
      expect(jobPendingNotice).not.toHaveBeenCalled();
    });

    it('绑定会话已断开 → 不唤醒（拿到会话也不等于能开轮）', async () => {
      bindConversationToSession();
      seedSession('disconnected');

      await maybeContinueForConversation(CONV, LOCAL_SESSION_SENTINEL);

      expect(agentStartTask).not.toHaveBeenCalled();
      expect(jobPendingNotice).not.toHaveBeenCalled();
    });
  });

  describe('onTurnFinished 的哨兵 guard 按「归属对话」而不是「作业 session」判定', () => {
    it('用户已请求停止时，早到的终态事件不重新唤醒任务', async () => {
      bindConversationToSession();
      const task = seedLocalSubTask(CONV);
      useTaskStore.setState((state) => ({
        tasks: { ...state.tasks, [task.id]: { ...task, stopRequested: true } },
      }));

      onTurnFinished(CONV, task.id);
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(jobPendingNotice).not.toHaveBeenCalled();
      expect(agentStartTask).not.toHaveBeenCalled();
    });

    it('本机子任务收尾、其归属对话绑着活跃会话 → 照样唤醒', async () => {
      // 作业的 session 是哨兵，对话的会话是真的：唤醒资格属于后者。
      bindConversationToSession();
      const task = seedLocalSubTask(CONV);

      onTurnFinished(CONV, task.id);

      await vi.waitFor(() => expect(agentStartTask).toHaveBeenCalledTimes(1));
      expect(agentStartTask.mock.calls[0][0]).toBe(SESSION);
    });

    it('本机子任务自己的子对话（在 store 里但没有会话绑定）→ 不唤醒，也不抛错', async () => {
      // 子对话是隐藏对话：它不在 `activeConversationBySession` 里（那里面记的是
      // 每个 Tab 当前打开的对话），所以在它名下解析不出任何 SSH 会话 —— 放弃，
      // 而不是把哨兵当会话开一轮。
      const sub = 'conv-sub';
      useConversationStore.setState((s) => ({
        conversations: {
          ...s.conversations,
          [sub]: {
            id: sub,
            connectionId: 'conn-1',
            title: '本机子agent',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        },
        messages: {
          ...s.messages,
          [sub]: [
            {
              id: 'm-sub',
              role: 'user',
              content: '本机调研',
              timestamp: new Date().toISOString(),
            } satisfies AgentMessage,
          ],
        },
      }));
      const task = seedLocalSubTask(sub, 'sub-local-2');

      onTurnFinished(sub, task.id);
      await expect(
        maybeContinueForConversation(sub, LOCAL_SESSION_SENTINEL),
      ).resolves.toBeUndefined();

      expect(agentStartTask).not.toHaveBeenCalled();
      expect(jobPendingNotice).not.toHaveBeenCalled();
    });

    it('重启恢复的占位 task（sessionId 是空串）→ 仍然什么都不做', async () => {
      bindConversationToSession();
      useTaskStore.setState({
        tasks: {
          'task-placeholder': {
            id: 'task-placeholder',
            sessionId: '',
            conversationId: CONV,
            prompt: '重启残留',
            mode: 'agent',
            status: 'executing',
            createdAt: new Date().toISOString(),
          },
        },
      });

      onTurnFinished(CONV, 'task-placeholder');

      await Promise.resolve();
      expect(agentStartTask).not.toHaveBeenCalled();
    });
  });
});
