import { describe, it, expect, vi } from 'vitest';
import type { AgentTask, JobInfo } from '@/lib/types';
import { useConversationStore } from '@/stores/conversationStore';
import {
  getTaskVisualStatus,
  getConversationAgentStatus,
  buildConversationAgentStatusMap,
  getSessionAgentStatus,
  getActiveRunningTasks,
  getListedTasks,
  taskCenterEntry,
} from './agentStatusSelectors';

describe('agentStatusSelectors', () => {
  const mockTask = (overrides: Partial<AgentTask> = {}): AgentTask => ({
    id: 'task-1',
    sessionId: 'session-1',
    conversationId: 'conv-1',
    prompt: 'test prompt',
    mode: 'agent',
    status: 'executing',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  describe('getTaskVisualStatus', () => {
    it('returns idle for null/undefined task or completed task', () => {
      expect(getTaskVisualStatus(null)).toBe('idle');
      expect(getTaskVisualStatus(undefined)).toBe('idle');
      expect(getTaskVisualStatus(mockTask({ status: 'completed' }))).toBe('idle');
      expect(getTaskVisualStatus(mockTask({ status: 'failed' }))).toBe('idle');
    });

    it('returns running for planning / executing tasks', () => {
      expect(getTaskVisualStatus(mockTask({ status: 'planning' }))).toBe('running');
      expect(getTaskVisualStatus(mockTask({ status: 'executing' }))).toBe('running');
    });

    it('awaiting_parent → asking_parent（独立于 running / waiting_approval）', () => {
      expect(getTaskVisualStatus(mockTask({ status: 'awaiting_parent' }))).toBe('asking_parent');
    });

    it('returns waiting_approval for waiting_approval status', () => {
      expect(getTaskVisualStatus(mockTask({ status: 'waiting_approval' }))).toBe('waiting_approval');
    });
  });

  describe('getConversationAgentStatus', () => {
    it('prioritizes waiting_approval over running and unread', () => {
      const tasks: Record<string, AgentTask> = {
        't1': mockTask({ id: 't1', conversationId: 'conv-1', status: 'executing' }),
        't2': mockTask({ id: 't2', conversationId: 'conv-1', status: 'waiting_approval' }),
      };
      expect(getConversationAgentStatus('conv-1', tasks, ['conv-1'])).toBe('waiting_approval');
    });

    it('returns running when a task is executing', () => {
      const tasks: Record<string, AgentTask> = {
        't1': mockTask({ id: 't1', conversationId: 'conv-1', status: 'executing' }),
      };
      expect(getConversationAgentStatus('conv-1', tasks, ['conv-1'])).toBe('running');
    });

    it('returns unread_completed when in unread list and no active tasks', () => {
      const tasks: Record<string, AgentTask> = {
        't1': mockTask({ id: 't1', conversationId: 'conv-1', status: 'completed' }),
      };
      expect(getConversationAgentStatus('conv-1', tasks, ['conv-1'])).toBe('unread_completed');
      expect(getConversationAgentStatus('conv-2', tasks, ['conv-1'])).toBe('idle');
    });

    it('cascades subagent task status to parent conversation status', () => {
      useConversationStore.setState({
        conversations: {
          'main-conv': { id: 'main-conv', connectionId: 'c1', title: 'Main', createdAt: '', updatedAt: '' },
          'sub-conv': { id: 'sub-conv', connectionId: 'c1', title: 'Sub', createdAt: '', updatedAt: '', parentConversationId: 'main-conv' },
        },
      });

      const tasks: Record<string, AgentTask> = {
        'sub-task-1': mockTask({ id: 'sub-task-1', conversationId: 'sub-conv', status: 'waiting_approval' }),
      };

      expect(getConversationAgentStatus('main-conv', tasks)).toBe('waiting_approval');
    });
  });

  describe('buildConversationAgentStatusMap', () => {
    it('与单查版逐条等价（子对话任务/未读归并到父，优先级一致）', () => {
      useConversationStore.setState({
        conversations: {
          'main-a': { id: 'main-a', connectionId: 'c1', title: 'A', createdAt: '', updatedAt: '' },
          'main-b': { id: 'main-b', connectionId: 'c1', title: 'B', createdAt: '', updatedAt: '' },
          'main-c': { id: 'main-c', connectionId: 'c1', title: 'C', createdAt: '', updatedAt: '' },
          'sub-a1': { id: 'sub-a1', connectionId: 'c1', title: 'A1', createdAt: '', updatedAt: '', parentConversationId: 'main-a' },
          'sub-a2': { id: 'sub-a2', connectionId: 'c1', title: 'A2', createdAt: '', updatedAt: '', parentConversationId: 'main-a' },
          'sub-b1': { id: 'sub-b1', connectionId: 'c1', title: 'B1', createdAt: '', updatedAt: '', parentConversationId: 'main-b' },
        },
      });
      const tasks: Record<string, AgentTask> = {
        // main-a：子对话在跑 + 主对话已完成 → running
        'a-run': mockTask({ id: 'a-run', conversationId: 'sub-a1', status: 'executing' }),
        // main-b：子对话等审批 → waiting_approval（压过 running/unread）
        'b-approve': mockTask({ id: 'b-approve', conversationId: 'sub-b1', status: 'waiting_approval' }),
        'b-run': mockTask({ id: 'b-run', conversationId: 'main-b', status: 'planning' }),
        // 占位 task（sessionId 空）不得计入
        'ghost': mockTask({ id: 'ghost', conversationId: 'main-c', sessionId: '', status: 'executing' }),
      };
      const unread = ['sub-a2', 'main-c'];

      // 列表只渲染主对话（子对话不进历史列表），映射也按主对话口径：
      // 主对话行的结果必须与单查版逐条一致。
      const map = buildConversationAgentStatusMap(tasks, unread);
      for (const id of ['main-a', 'main-b', 'main-c']) {
        expect(map.get(id) ?? 'idle', `映射版与单查版在 ${id} 上不一致`).toBe(
          getConversationAgentStatus(id, tasks, unread),
        );
      }
      // 子对话不占条目（它们的任务/未读已归并进父对话）。
      expect(map.has('sub-a1')).toBe(false);
      expect(map.has('sub-b1')).toBe(false);
      // 关键档位抽查：归并与优先级都正确
      expect(map.get('main-a')).toBe('running');
      expect(map.get('main-b')).toBe('waiting_approval');
      expect(map.get('main-c')).toBe('unread_completed');
      expect(map.get('does-not-exist') ?? 'idle').toBe('idle');
    });
  });

  describe('getSessionAgentStatus', () => {
    it('calculates aggregate session status correctly', () => {
      const tasks: Record<string, AgentTask> = {
        't1': mockTask({ id: 't1', sessionId: 's-1', conversationId: 'conv-1', status: 'executing' }),
        't2': mockTask({ id: 't2', sessionId: 's-2', conversationId: 'conv-2', status: 'completed' }),
      };
      expect(getSessionAgentStatus('s-1', tasks, [])).toBe('running');
      expect(getSessionAgentStatus('s-2', tasks, ['conv-2'])).toBe('unread_completed');
      expect(getSessionAgentStatus('s-3', tasks, [])).toBe('idle');
    });
  });

  describe('getActiveRunningTasks', () => {
    it('filters only tasks with valid sessionId and active status', () => {
      const tasks: Record<string, AgentTask> = {
        't1': mockTask({ id: 't1', sessionId: 's-1', status: 'executing' }),
        't2': mockTask({ id: 't2', sessionId: 's-1', status: 'waiting_approval' }),
        't3': mockTask({ id: 't3', sessionId: 's-2', status: 'completed' }),
        't4': mockTask({ id: 't4', sessionId: '', status: 'executing' }), // restored placeholder
      };
      const active = getActiveRunningTasks(tasks);
      expect(active.map((t) => t.id)).toEqual(['t1', 't2']);
    });

    it('停在 ask_parent 上的子任务：列表里仍列出（标「提问中」），但不算「在跑」——不点亮入口、不让对话 / 会话变忙', () => {
      const tasks: Record<string, AgentTask> = {
        t1: mockTask({ id: 't1', status: 'awaiting_parent', parentTaskId: 'p', conversationId: 'sub' }),
      };
      expect(getActiveRunningTasks(tasks)).toEqual([]);
      expect(getListedTasks(tasks).map((t) => t.id)).toEqual(['t1']);
      expect(taskCenterEntry(tasks, {}, null).visible).toBe(false);
      expect(getSessionAgentStatus('session-1', tasks)).toBe('idle');
      expect(getConversationAgentStatus('sub', tasks)).toBe('idle');
    });
  });

  describe('taskCenterEntry', () => {
    const mockJob = (overrides: Partial<JobInfo> = {}): JobInfo => ({
      jobId: 'job-1',
      sessionId: 'session-1',
      description: 'npm run build',
      command: 'npm run build',
      status: 'running',
      startedAtMillis: 1,
      totalOutputBytes: 0,
      ...overrides,
    });

    it('空闲且没有需要注意的作业时不显示入口', () => {
      const entry = taskCenterEntry({}, {}, 'conv-1');
      expect(entry.visible).toBe(false);
      const withFinishedJobs = taskCenterEntry(
        {},
        {
          'j1': mockJob({ jobId: 'j1', status: 'completed' }),
          'j2': mockJob({ jobId: 'j2', status: 'failed' }),
          'j3': mockJob({ jobId: 'j3', status: 'killed' }),
        },
        'conv-1',
      );
      expect(withFinishedJobs.visible).toBe(false);
    });

    it('当前对话里唯一一个运行中任务不显示（现状语义不变）', () => {
      const tasks = { 't1': mockTask({ id: 't1', conversationId: 'conv-1', status: 'executing' }) };
      expect(taskCenterEntry(tasks, {}, 'conv-1').visible).toBe(false);
    });

    it('只有一个运行中任务但在别的对话 / 有后台作业时显示，并停在对应页签', () => {
      const tasks = { 't1': mockTask({ id: 't1', conversationId: 'conv-2', status: 'executing' }) };
      const otherConv = taskCenterEntry(tasks, {}, 'conv-1');
      expect(otherConv.visible).toBe(true);
      expect(otherConv.initialTab).toBe('agents');

      const onlyJobs = taskCenterEntry({}, { 'j1': mockJob() }, 'conv-1');
      expect(onlyJobs.visible).toBe(true);
      // 只有作业可看时停在作业页，别把用户丢在空的「Agent 任务」页
      expect(onlyJobs.initialTab).toBe('jobs');
    });

    it('只有重启恢复出来的 interrupted 作业也显示入口（空闲状态下的唯一入口）', () => {
      const entry = taskCenterEntry(
        {},
        {
          'j1': mockJob({ jobId: 'j1', status: 'interrupted' }),
          'j2': mockJob({ jobId: 'j2', status: 'completed' }),
        },
        null,
      );
      expect(entry.visible).toBe(true);
      expect(entry.attentionJobs.map((j) => j.jobId)).toEqual(['j1']);
      expect(entry.initialTab).toBe('jobs');
    });

    it('已读的 interrupted 不计入警示：空闲且全部读过时入口消失', () => {
      const jobs = {
        'j1': mockJob({ jobId: 'j1', status: 'interrupted' }),
        'j2': mockJob({ jobId: 'j2', status: 'interrupted', startedAtMillis: 2 }),
      };
      const entry = taskCenterEntry({}, jobs, null, { j1: 1, j2: 2 });
      expect(entry.visible).toBe(false);
      expect(entry.attentionJobs).toEqual([]);
    });

    it('只读过一部分时，未读的照旧触发琥珀警示', () => {
      const jobs = {
        'j1': mockJob({ jobId: 'j1', status: 'interrupted' }),
        'j2': mockJob({ jobId: 'j2', status: 'interrupted', startedAtMillis: 2 }),
      };
      const entry = taskCenterEntry({}, jobs, null, { j1: 1 });
      expect(entry.visible).toBe(true);
      expect(entry.attentionJobs.map((j) => j.jobId)).toEqual(['j2']);
      expect(entry.initialTab).toBe('jobs');
    });
  });
});
