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
      expect(toolMsg.toolResult?.result).toContain('用户中断');
      expect(toolMsg.toolResult?.result).toContain('已停止等待输出并向远端发送 close');

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

      // 第一次 stopTask 已把 task-1 置 cancelled；新逻辑对已终态任务不再重复
      // mark/cleanup，这里重置为运行中再验证顺序。
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

      expect(clearOrder.indexOf('mark')).toBeLessThan(clearOrder.indexOf('cleanup'));
      expect(cleanupTaskListenersMock).toHaveBeenCalledWith('task-1');
      // 恢复被覆盖的 action，避免污染后续测试（zustand setState 会覆盖 store action）
      useConversationStore.setState({ markAbortedToolFlags: origMark });
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

    it('only marks tool cards in the stopped task conversation (subagents stay intact)', async () => {
      agentStopTask.mockResolvedValue(undefined);
      const conv1Tool: AgentMessage = {
        id: 'tool-a',
        role: 'tool',
        content: '',
        timestamp: new Date().toISOString(),
        isExecuting: true,
        toolResult: {
          toolName: 'execute_command',
          summary: '',
          result: '',
          success: true,
          blocked: false,
        },
      };
      const conv2Tool: AgentMessage = {
        id: 'tool-b',
        role: 'tool',
        content: '',
        timestamp: new Date().toISOString(),
        isExecuting: true,
        toolResult: {
          toolName: 'task',
          summary: '',
          result: '',
          success: true,
          blocked: false,
        },
      };
      useConversationStore.setState({
        activeConversationId: 'conv-1',
        messages: {
          'conv-1': [conv1Tool],
          'conv-2': [conv2Tool],
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

      await useTaskStore.getState().stopTask('task-1');

      const conv1Msg = useConversationStore.getState().messages['conv-1'][0];
      expect(conv1Msg.toolResult?.wasAborted).toBe(true);
      // Other conversation's in-flight card must NOT be marked aborted
      const conv2Msg = useConversationStore.getState().messages['conv-2'][0];
      expect(conv2Msg.isExecuting).toBe(true);
      expect(conv2Msg.toolResult?.wasAborted).toBeUndefined();
    });

    it('cascades to running subtasks: marks, unlistens and cancels them', async () => {
      agentStopTask.mockResolvedValue(undefined);
      const mainTool: AgentMessage = {
        id: 'tool-main',
        role: 'tool',
        content: '',
        timestamp: new Date().toISOString(),
        isExecuting: true,
        toolResult: {
          toolName: 'task',
          summary: '',
          result: '',
          success: true,
          blocked: false,
        },
      };
      const subTool: AgentMessage = {
        id: 'tool-sub',
        role: 'tool',
        content: '',
        timestamp: new Date().toISOString(),
        isExecuting: true,
        toolResult: {
          toolName: 'execute_command',
          summary: '',
          result: 'partial',
          success: true,
          blocked: false,
        },
      };
      useConversationStore.setState({
        activeConversationId: 'main-conv',
        messages: { 'main-conv': [mainTool], 'sub-conv': [subTool] },
      });
      useTaskStore.setState({
        tasks: {
          'main-1': {
            id: 'main-1',
            sessionId: 's1',
            conversationId: 'main-conv',
            prompt: 'p',
            mode: 'agent',
            status: 'executing',
            createdAt: new Date().toISOString(),
          },
          'sub-1': {
            id: 'sub-1',
            sessionId: 's1',
            conversationId: 'sub-conv',
            prompt: 'research',
            mode: 'plan',
            status: 'planning',
            createdAt: new Date().toISOString(),
            parentTaskId: 'main-1',
          },
        },
        activeTaskId: 'main-1',
      });

      await useTaskStore.getState().stopTask('main-1');

      const tasks = useTaskStore.getState().tasks;
      expect(tasks['main-1'].status).toBe('cancelled');
      // 子任务必须同步标记 cancelled（否则后端级联取消后 Done 事件会被
      // 残留 listener 消费，handleDone 误标 completed）
      expect(tasks['sub-1'].status).toBe('cancelled');
      // 主 + 子 listener 都被清理
      expect(cleanupTaskListenersMock).toHaveBeenCalledWith('main-1');
      expect(cleanupTaskListenersMock).toHaveBeenCalledWith('sub-1');
      // 子对话执行中的工具卡片也被标记中断
      const subMsg = useConversationStore.getState().messages['sub-conv'][0];
      expect(subMsg.toolResult?.wasAborted).toBe(true);
    });

    it('does not overwrite terminal subtask status when stopping parent', async () => {
      agentStopTask.mockResolvedValue(undefined);
      // 子任务已自然完成、主任务仍在等 task 工具结果 → 停止主任务时
      // 子任务保持 completed，不能被误标成 cancelled。
      useTaskStore.setState({
        tasks: {
          'main-1': {
            id: 'main-1',
            sessionId: 's1',
            conversationId: 'main-conv',
            prompt: 'p',
            mode: 'agent',
            status: 'executing',
            createdAt: new Date().toISOString(),
          },
          'sub-1': {
            id: 'sub-1',
            sessionId: 's1',
            conversationId: 'sub-conv',
            prompt: 'research',
            mode: 'plan',
            status: 'completed',
            createdAt: new Date().toISOString(),
            parentTaskId: 'main-1',
          },
        },
        activeTaskId: 'main-1',
      });

      await useTaskStore.getState().stopTask('main-1');

      const tasks = useTaskStore.getState().tasks;
      expect(tasks['main-1'].status).toBe('cancelled');
      expect(tasks['sub-1'].status).toBe('completed');
      // 已终态子任务不做 listener 清理（其 listener 早已在 done 分支卸载）
      expect(cleanupTaskListenersMock).toHaveBeenCalledTimes(1);
      expect(cleanupTaskListenersMock).toHaveBeenCalledWith('main-1');
    });
  });
});
