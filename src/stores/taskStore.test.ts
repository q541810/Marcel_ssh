import { describe, it, expect, beforeEach } from 'vitest';
import { useTaskStore } from '@/stores/taskStore';
import type { AgentTaskPlan } from '@/lib/types';

describe('taskStore', () => {
  beforeEach(() => {
    useTaskStore.setState({
      tasks: {},
      activeTaskId: null,
      mode: 'agent',
      pendingApproval: null,
      plans: {},
      plansDirty: false,
    });
  });

  it('has correct initial state', () => {
    const state = useTaskStore.getState();
    expect(state.mode).toBe('agent');
    expect(state.activeTaskId).toBeNull();
    expect(state.pendingApproval).toBeNull();
    expect(Object.keys(state.tasks)).toHaveLength(0);
  });

  it('setMode changes agent mode', () => {
    useTaskStore.getState().setMode('auto');
    expect(useTaskStore.getState().mode).toBe('auto');

    useTaskStore.getState().setMode('chat');
    expect(useTaskStore.getState().mode).toBe('chat');
  });

  it('updateTaskStatus updates existing task', () => {
    useTaskStore.setState({
      tasks: {
        'task-1': {
          id: 'task-1',
          sessionId: 's1',
          prompt: 'test',
          mode: 'agent',
          status: 'planning',
          createdAt: new Date().toISOString(),
        },
      },
    });

    useTaskStore.getState().updateTaskStatus('task-1', 'executing');
    expect(useTaskStore.getState().tasks['task-1'].status).toBe('executing');
  });

  it('updateTaskStatus does nothing for unknown task', () => {
    useTaskStore.getState().updateTaskStatus('nonexistent', 'executing');
    // No crash, no state change for non-existent
    expect(useTaskStore.getState().tasks['nonexistent']).toBeUndefined();
  });

  it('setPendingApproval updates approval', () => {
    const approval = {
      type: 'approvalRequest' as const,
      toolCallId: 'op1',
      toolName: 'execute_command',
      arguments: { command: 'ls' },
      riskLevel: 'LowRisk' as const,
    };
    useTaskStore.getState().setPendingApproval(approval);
    expect(useTaskStore.getState().pendingApproval).toEqual(approval);

    useTaskStore.getState().setPendingApproval(null);
    expect(useTaskStore.getState().pendingApproval).toBeNull();
  });

  it('setPlan stores plan', () => {
    const plan: AgentTaskPlan = {
      taskId: 'task-1',
      currentIndex: 0,
      items: [{ id: 'item-1', title: 'Do thing', status: 'pending' }],
    };
    useTaskStore.getState().setPlan('task-1', plan);
    const stored = useTaskStore.getState().plans['task-1'];
    expect(stored).toEqual(plan);
    expect(stored.items[0].status).toBe('pending');
  });

  it('updatePlanItem updates item status', () => {
    const plan: AgentTaskPlan = {
      taskId: 'task-1',
      currentIndex: 0,
      items: [
        { id: 'item-1', title: 'Step 1', status: 'pending' },
        { id: 'item-2', title: 'Step 2', status: 'pending' },
      ],
    };
    useTaskStore.getState().setPlan('task-1', plan);

    useTaskStore.getState().updatePlanItem('task-1', 'item-1', 'completed');
    const items = useTaskStore.getState().plans['task-1'].items;
    expect(items[0].status).toBe('completed');
    expect(items[1].status).toBe('pending');
  });

  it('updatePlanItem sets error', () => {
    const plan: AgentTaskPlan = {
      taskId: 'task-1',
      currentIndex: 0,
      items: [{ id: 'item-1', title: 'Step', status: 'pending' }],
    };
    useTaskStore.getState().setPlan('task-1', plan);

    useTaskStore.getState().updatePlanItem('task-1', 'item-1', 'failed', 'oops');
    const item = useTaskStore.getState().plans['task-1'].items[0];
    expect(item.status).toBe('failed');
    expect(item.error).toBe('oops');
  });

  it('getActivePlan returns plan for active task', () => {
    const plan: AgentTaskPlan = {
      taskId: 'task-1',
      currentIndex: 0,
      items: [{ id: 'item-1', title: 'Step', status: 'pending' }],
    };
    useTaskStore.setState({ activeTaskId: 'task-1' });
    useTaskStore.getState().setPlan('task-1', plan);

    expect(useTaskStore.getState().getActivePlan()?.taskId).toBe('task-1');
  });

  it('getActivePlan returns null when no active task', () => {
    expect(useTaskStore.getState().getActivePlan()).toBeNull();
  });
});
