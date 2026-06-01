import { useCallback } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import type { AgentMode } from '@/lib/types';

export function useAgent() {
  const store = useAgentStore((s) => ({
    conversations: s.conversations,
    activeConversationId: s.activeConversationId,
    messagesMap: s.messages,
    tasks: s.tasks,
    activeTaskId: s.activeTaskId,
    mode: s.mode,
    pendingApproval: s.pendingApproval,
    startTask: s.startTask,
    stopTask: s.stopTask,
    approveOperation: s.approveOperation,
    rejectOperation: s.rejectOperation,
    setMode: s.setMode,
    setPendingApproval: s.setPendingApproval,
    newConversation: s.newConversation,
    switchConversation: s.switchConversation,
    loadConversation: s.loadConversation,
    deleteConversation: s.deleteConversation,
    loadConnectionConversations: s.loadConnectionConversations,
  }));

  const activeTask = store.activeTaskId ? (store.tasks[store.activeTaskId] ?? null) : null;

  const messages = store.activeConversationId
    ? (store.messagesMap[store.activeConversationId] ?? [])
    : [];

  const isRunning =
    activeTask?.status === 'planning' ||
    activeTask?.status === 'executing' ||
    activeTask?.status === 'waiting_approval';

  const sendPrompt = useCallback(
    async (sessionId: string, prompt: string, connectionId?: string) => {
      return store.startTask(sessionId, prompt, connectionId);
    },
    [store.startTask],
  );

  const stopActiveTask = useCallback(async () => {
    if (activeTask) {
      return store.stopTask(activeTask.id);
    }
  }, [activeTask, store.stopTask]);

  const approveCurrent = useCallback(
    async (operationId: string) => {
      store.setPendingApproval(null);
      if (activeTask) {
        return store.approveOperation(activeTask.id, operationId);
      }
    },
    [activeTask, store.approveOperation, store.setPendingApproval],
  );

  const rejectCurrent = useCallback(
    async (operationId: string) => {
      store.setPendingApproval(null);
      if (activeTask) {
        return store.rejectOperation(activeTask.id, operationId);
      }
    },
    [activeTask, store.rejectOperation, store.setPendingApproval],
  );

  const setMode = useCallback(
    (newMode: AgentMode) => {
      store.setMode(newMode);
    },
    [store.setMode],
  );

  const newConversation = useCallback(
    async (sessionId: string, connectionId: string) => {
      return store.newConversation(sessionId, connectionId);
    },
    [store.newConversation],
  );

  const switchConversation = useCallback(
    async (conversationId: string) => {
      return store.switchConversation(conversationId);
    },
    [store.switchConversation],
  );

  const loadConversation = useCallback(
    async (conversationId: string) => {
      return store.loadConversation(conversationId);
    },
    [store.loadConversation],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      return store.deleteConversation(conversationId);
    },
    [store.deleteConversation],
  );

  const loadConnectionConversations = useCallback(
    async (connectionId: string) => {
      return store.loadConnectionConversations(connectionId);
    },
    [store.loadConnectionConversations],
  );

  return {
    messages,
    activeTask,
    isRunning,
    pendingApproval: store.pendingApproval,
    mode: store.mode,
    conversations: store.conversations,
    activeConversationId: store.activeConversationId,
    sendPrompt,
    stopActiveTask,
    approveCurrent,
    rejectCurrent,
    setMode,
    newConversation,
    switchConversation,
    loadConversation,
    deleteConversation,
    loadConnectionConversations,
  };
}
