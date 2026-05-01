import { useCallback } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import type { AgentMode } from '@/lib/types';

export function useAgent() {
  const messages = useAgentStore((s) => s.messages);
  const tasks = useAgentStore((s) => s.tasks);
  const activeTaskId = useAgentStore((s) => s.activeTaskId);
  const mode = useAgentStore((s) => s.mode);
  const pendingApproval = useAgentStore((s) => s.pendingApproval);
  const startTaskAction = useAgentStore((s) => s.startTask);
  const stopTaskAction = useAgentStore((s) => s.stopTask);
  const approveAction = useAgentStore((s) => s.approveOperation);
  const rejectAction = useAgentStore((s) => s.rejectOperation);
  const setModeAction = useAgentStore((s) => s.setMode);
  const setPendingApprovalAction = useAgentStore((s) => s.setPendingApproval);

  const activeTask = activeTaskId ? tasks[activeTaskId] ?? null : null;
  const isRunning =
    activeTask?.status === 'planning' ||
    activeTask?.status === 'executing' ||
    activeTask?.status === 'waiting_approval';

  const startTask = useCallback(
    async (sessionId: string, prompt: string) => {
      return startTaskAction(sessionId, prompt);
    },
    [startTaskAction],
  );

  const stopTask = useCallback(
    async (taskId: string) => {
      return stopTaskAction(taskId);
    },
    [stopTaskAction],
  );

  const approve = useCallback(
    async (taskId: string, operationId: string) => {
      setPendingApprovalAction(null);
      return approveAction(taskId, operationId);
    },
    [approveAction, setPendingApprovalAction],
  );

  const reject = useCallback(
    async (taskId: string, operationId: string) => {
      setPendingApprovalAction(null);
      return rejectAction(taskId, operationId);
    },
    [rejectAction, setPendingApprovalAction],
  );

  const setMode = useCallback(
    (newMode: AgentMode) => {
      setModeAction(newMode);
    },
    [setModeAction],
  );

  return {
    startTask,
    stopTask,
    approve,
    reject,
    messages,
    activeTask,
    mode,
    setMode,
    isRunning,
    pendingApproval,
  };
}
