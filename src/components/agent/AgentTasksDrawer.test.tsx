// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LOCAL_SESSION_SENTINEL } from '@/lib/toolCatalog';
import type { AgentTask, JobInfo } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  tasks: {} as Record<string, AgentTask>,
  jobs: {} as Record<string, JobInfo>,
  sessions: {} as Record<string, { id: string; configId?: string; connectionId: string }>,
  connections: [] as Array<{ id: string; name: string }>,
  conversations: {} as Record<string, { id: string; connectionId?: string; title?: string }>,
  setActiveSession: vi.fn(),
  switchConversation: vi.fn(async () => {}),
  activeConversationId: null as string | null,
  activeSessionId: null as string | null,
  markInterruptedJobsRead: vi.fn(),
}));

// 只替换数据来源：本用例断言的是「标签怎么显示」，与被替换的 store 实现无关。
vi.mock('@/stores/taskStore', () => ({
  useTaskStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ tasks: mocks.tasks }),
}));
vi.mock('@/stores/jobStore', () => ({
  useJobStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      jobs: mocks.jobs,
      killJob: vi.fn(),
      markInterruptedJobsRead: mocks.markInterruptedJobsRead,
    }),
}));
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      sessions: mocks.sessions,
      setActiveSession: mocks.setActiveSession,
      activeSessionId: mocks.activeSessionId,
    }),
}));
vi.mock('@/stores/connectionStore', () => ({
  useConnectionStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({ connections: mocks.connections }),
}));
vi.mock('@/stores/conversationStore', () => ({
  useConversationStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      conversations: mocks.conversations,
      switchConversation: mocks.switchConversation,
      activeConversationId: mocks.activeConversationId,
    }),
}));

import { AgentTasksDrawer } from './AgentTasksDrawer';

const TS = '2026-09-28T10:00:00.000Z';

/** 本机子任务的契约：`sessionId` 是哨兵值（用 toolCatalog 的常量，不抄字面量）。 */
function localSubTask(overrides: Partial<AgentTask> = {}): AgentTask {
  return {
    id: 'sub-local',
    sessionId: LOCAL_SESSION_SENTINEL,
    conversationId: 'sub',
    prompt: '看一下构建脚本',
    mode: 'plan',
    status: 'executing',
    createdAt: TS,
    parentTaskId: 'parent',
    ...overrides,
  };
}

/**
 * 一条后台作业。本机作业的契约：id 形如 `local_job_N`、`sessionId` 是哨兵
 * （后端 `command_exec::job` 的本机侧恒发这个）。
 */
function jobInfo(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    jobId: 'local_job_1',
    sessionId: LOCAL_SESSION_SENTINEL,
    taskId: null,
    description: '本机构建',
    command: 'pnpm build',
    status: 'running',
    ownerConversationId: 'conv-main',
    detail: null,
    startedAtMillis: 1000,
    finishedAtMillis: null,
    totalOutputBytes: 42,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tasks = {};
  mocks.jobs = {};
  mocks.sessions = {};
  mocks.connections = [];
  mocks.conversations = {};
  mocks.activeConversationId = null;
  mocks.activeSessionId = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** 打开抽屉并等首次渲染落定。 */
async function render(tab: 'agents' | 'jobs' = 'agents') {
  await act(async () => {
    root.render(<AgentTasksDrawer open={true} onClose={() => {}} initialTab={tab} />);
  });
}

describe('任务与作业中心（桌面）· 本机作业的会话标签', () => {
  it('本机作业（local_job_N，sessionId 是哨兵）标「本机」，不说「会话已关闭」', async () => {
    // 漏了哨兵特判时走的是 `sessions[sentinel]` 查不到那条分支 →
    // 「local（该任务对应会话已关闭）」：把一条**正在跑**的本机作业说成会话已
    // 关闭，用户会以为它废了。与移动端 MobileActiveAgentsSheet 同一口径。
    mocks.jobs = { local_job_1: jobInfo() };

    await render('jobs');

    const text = container.textContent ?? '';
    expect(text).toContain('本机');
    expect(text).not.toContain('该任务对应会话已关闭');
  });

  it('远端作业的会话已关闭 → 仍旧照实提示（既有行为不变）', async () => {
    mocks.jobs = {
      job_1: jobInfo({ jobId: 'job_1', sessionId: 'session-gone', command: 'make -j8' }),
    };

    await render('jobs');

    expect(container.textContent ?? '').toContain('session-gone（该任务对应会话已关闭）');
  });

  it('会话在 store 里时照旧显示连接名（既有行为不变）', async () => {
    mocks.jobs = { job_2: jobInfo({ jobId: 'job_2', sessionId: 'session-1' }) };
    mocks.sessions = {
      'session-1': { id: 'session-1', configId: 'conn-1', connectionId: 'conn-1' },
    };
    mocks.connections = [{ id: 'conn-1', name: '生产机' }];

    await render('jobs');

    expect(container.textContent ?? '').toContain('生产机');
  });
});

describe('任务与作业中心（桌面）· 本机子任务的会话标签', () => {
  it('本机子任务显示「本机」，不显示未知会话', async () => {
    mocks.tasks = { 'sub-local': localSubTask() };

    await render('agents');

    const text = container.textContent ?? '';
    expect(text).toContain('本机');
    expect(text).not.toContain('未知会话');
  });
});

describe('任务与作业中心（桌面）· interrupted 作业的已读记账', () => {
  it('Jobs 页签亮出来时把作业列表交给已读记账（警示只数未读的依据）', async () => {
    mocks.jobs = {
      job_i: jobInfo({ jobId: 'job_i', status: 'interrupted' }),
      job_r: jobInfo({ jobId: 'job_r', status: 'running' }),
    };

    await render('jobs');

    expect(mocks.markInterruptedJobsRead).toHaveBeenCalledTimes(1);
    expect(mocks.markInterruptedJobsRead).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ jobId: 'job_i' }),
        expect.objectContaining({ jobId: 'job_r' }),
      ]),
    );
  });

  it('开在「Agent 任务」页签不记账（没看到作业就不算看过）', async () => {
    mocks.jobs = { job_i: jobInfo({ jobId: 'job_i', status: 'interrupted' }) };

    await render('agents');

    expect(mocks.markInterruptedJobsRead).not.toHaveBeenCalled();
  });
});
