import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useTaskStore } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import { cleanupTaskListeners } from '@/stores/agentStreamManager';
import type { AgentTaskPlan, AgentMessage } from '@/lib/types';

const { agentStopTask, cleanupTaskListenersMock } = vi.hoisted(() => ({
  agentStopTask: vi.fn(),
  cleanupTaskListenersMock: vi.fn(),
}));

vi.mock('@/lib/tauri', () => ({
  agentStopTask,
}));
vi.mock('@/stores/agentStreamManager', () => ({
  attachStreamListener: vi.fn(),
  attachPlanListener: vi.fn(),
  cleanupTaskListeners: cleanupTaskListenersMock,
}));

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
    useConversationStore.setState({
      conversations: {},
      messages: {},
      activeConversationId: null,
    });
    vi.clearAllMocks();
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

    useTaskStore.getState().setMode('plan');
    expect(useTaskStore.getState().mode).toBe('plan');
  });

  it('updateTaskStatus updates existing task', () => {
    useTaskStore.setState({
      tasks: {
        'task-1': {
          id: 'task-1',
          sessionId: 's1',
          conversationId: 'conv-1',
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

  describe('stopTask', () => {
    it('marks executing tool messages as aborted before unlistening stream events', async () => {
      agentStopTask.mockResolvedValue(undefined);
      const runningTool: AgentMessage = {
        id: 'tool-1',
        role: 'tool',
        content: 'executing',
        timestamp: new Date().toISOString(),
        isExecuting: true,
        toolResult: {
          toolName: 'execute_command',
          summary: '',
          result: 'partial output',
          success: true,
          blocked: false,
        },
      };
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: { 'conv-1': [runningTool] },
      });
      useTaskStore.setState({
        tasks: {
          'task-1': {
            id: 'task-1',
            sessionId: 's1',
            conversationId: 'conv-1',
            prompt: 'p',
            mode: 'agent',
            status: 'executing',
            createdAt: new Date().toISOString(),
          },
        },
        activeTaskId: 'task-1',
      });

      await useTaskStore.getState().stopTask('task-1');

      // Tool message was marked aborted: isExecuting cleared, wasAborted set,
      // result appended with streaming interruption note.
      const toolMsg = useConversationStore.getState().messages['conv-1'][0];
      expect(toolMsg.isExecuting).toBe(false);
      expect(toolMsg.toolResult?.wasAborted).toBe(true);
      expect(toolMsg.toolResult?.success).toBe(false);
      expect(toolMsg.toolResult?.result).toContain('用户手动中断');
      expect(toolMsg.toolResult?.result).toContain('远端命令');

      // The mark happened BEFORE cleanupTaskListeners
      const clearOrder: string[] = [];
      cleanupTaskListenersMock.mockImplementation(() => {
        clearOrder.push('cleanup');
      });
      const origMark = useConversationStore.getState().markAbortedToolFlags;
      useConversationStore.setState({
        markAbortedToolFlags: () => {
          clearOrder.push('mark');
          origMark();
        },
      });

      await useTaskStore.getState().stopTask('task-1');

      expect(clearOrder.indexOf('mark')).toBeLessThan(clearOrder.indexOf('cleanup'));
      expect(cleanupTaskListenersMock).toHaveBeenCalledWith('task-1');
    });

    it('marks non-streaming tool messages as aborted with non-streaming note', async () => {
      agentStopTask.mockResolvedValue(undefined);
      const runningTool: AgentMessage = {
        id: 'tool-2',
        role: 'tool',
        content: '',
        timestamp: new Date().toISOString(),
        isExecuting: true,
        toolResult: {
          toolName: 'read_file',
          summary: '',
          result: '',
          success: true,
          blocked: false,
        },
      };
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: { 'conv-1': [runningTool] },
      });
      useTaskStore.setState({
        tasks: {
          'task-1': {
            id: 'task-1',
            sessionId: 's1',
            conversationId: 'conv-1',
            prompt: 'p',
            mode: 'agent',
            status: 'executing',
            createdAt: new Date().toISOString(),
          },
        },
        activeTaskId: 'task-1',
      });

      await useTaskStore.getState().stopTask('task-1');

      const toolMsg = useConversationStore.getState().messages['conv-1'][0];
      expect(toolMsg.toolResult?.wasAborted).toBe(true);
      expect(toolMsg.toolResult?.result).toContain('用户手动中断');
      expect(toolMsg.toolResult?.result).toContain('工具可能已执行完成');
      // Should NOT mention remote command phrasing
      expect(toolMsg.toolResult?.result).not.toContain('远端命令');
    });

    it('marks the task as cancelled and clears active', async () => {
      agentStopTask.mockResolvedValue(undefined);
      useTaskStore.setState({
        tasks: {
          'task-1': {
            id: 'task-1',
            sessionId: 's1',
            conversationId: 'conv-1',
            prompt: 'p',
            mode: 'agent',
            status: 'executing',
            createdAt: new Date().toISOString(),
          },
        },
        activeTaskId: 'task-1',
      });

      await useTaskStore.getState().stopTask('task-1');

      const task = useTaskStore.getState().tasks['task-1'];
      expect(task.status).toBe('cancelled');
      expect(useTaskStore.getState().activeTaskId).toBeNull();
    });

    it('marks tool messages even when agentStopTask throws', async () => {
      agentStopTask.mockRejectedValue(new Error('backend gone'));
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [
            {
              id: 'tool-1',
              role: 'tool',
              content: 'executing',
              timestamp: new Date().toISOString(),
              isExecuting: true,
              toolResult: {
                toolName: 'execute_command',
                summary: '',
                result: '',
                success: true,
                blocked: false,
              },
            },
          ],
        },
      });
      useTaskStore.setState({
        tasks: {
          'task-1': {
            id: 'task-1',
            sessionId: 's1',
            conversationId: 'conv-1',
            prompt: 'p',
            mode: 'agent',
            status: 'executing',
            createdAt: new Date().toISOString(),
          },
        },
        activeTaskId: 'task-1',
      });

      await expect(useTaskStore.getState().stopTask('task-1')).rejects.toThrow('backend gone');

      const toolMsg = useConversationStore.getState().messages['conv-1'][0];
      expect(toolMsg.isExecuting).toBe(false);
      expect(toolMsg.toolResult?.wasAborted).toBe(true);
      expect(cleanupTaskListenersMock).toHaveBeenCalledWith('task-1');
    });
  });
});
