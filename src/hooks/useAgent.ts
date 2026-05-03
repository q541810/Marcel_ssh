import { useCallback } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import type { AgentMode } from '@/lib/types';

export function useAgent() {
  const conversations = useAgentStore((s) => s.conversations);
  const activeConversationId = useAgentStore((s) => s.activeConversationId);
  const getCurrentMessages = useAgentStore((s) => s.getCurrentMessages);
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
  const newConversationAction = useAgentStore((s) => s.newConversation);
  const switchConversationAction = useAgentStore((s) => s.switchConversation);
  const loadConversationAction = useAgentStore((s) => s.loadConversation);
  const deleteConversationAction = useAgentStore((s) => s.deleteConversation);
  const loadSessionConversationsAction = useAgentStore((s) => s.loadConnectionConversations);

  const messages = getCurrentMessages();

  const activeTask = activeTaskId ? tasks[activeTaskId] ?? null : null;
  const isRunning =
    activeTask?.status === 'planning' ||
    activeTask?.status === 'executing' ||
    activeTask?.status === 'waiting_approval';

  const startTask = useCallback(
    async (sessionId: string, prompt: string, connectionId?: string) => {
      return startTaskAction(sessionId, prompt, connectionId);
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

  const newConversation = useCallback(
    async (sessionId: string, connectionId: string) => {
      return newConversationAction(sessionId, connectionId);
    },
    [newConversationAction],
  );

  const switchConversation = useCallback(
    async (conversationId: string) => {
      return switchConversationAction(conversationId);
    },
    [switchConversationAction],
  );

  const loadConversation = useCallback(
    async (conversationId: string) => {
      return loadConversationAction(conversationId);
    },
    [loadConversationAction],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      return deleteConversationAction(conversationId);
    },
    [deleteConversationAction],
  );

  const loadConnectionConversations = useCallback(
    async (connectionId: string) => {
      return loadSessionConversationsAction(connectionId);
    },
    [loadSessionConversationsAction],
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
    conversations,
    activeConversationId,
    newConversation,
    switchConversation,
    loadConversation,
    deleteConversation,
    loadConnectionConversations,
  };
}
