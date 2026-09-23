import { describe, it, expect, vi } from 'vitest';
import type { AgentTask, JobInfo } from '@/lib/types';
import { useConversationStore } from '@/stores/conversationStore';
import {
  getTaskVisualStatus,
  getConversationAgentStatus,
  getSessionAgentStatus,
  getActiveRunningTasks,
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
  });
});
