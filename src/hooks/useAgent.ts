import { useCallback } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import type { AgentMode, QuestionAnswer } from '@/lib/types';

export function useAgent() {
  const store = useAgentStore((s) => ({
    conversations: s.conversations,
    activeConversationId: s.activeConversationId,
    messagesMap: s.messages,
    tasks: s.tasks,
    activeTaskId: s.activeTaskId,
    mode: s.mode,
    inputDraft: s.inputDraft,
    pendingApproval: s.pendingApproval,
    pendingQuestion: s.pendingQuestion,
    sessionTokenUsage: s.sessionTokenUsage,
    taskTokenUsage: s.taskTokenUsage,
    startTask: s.startTask,
    stopTask: s.stopTask,
    approveOperation: s.approveOperation,
    rejectOperation: s.rejectOperation,
    setMode: s.setMode,
    setInputDraft: s.setInputDraft,
    setPendingApproval: s.setPendingApproval,
    setPendingQuestion: s.setPendingQuestion,
    answerQuestion: s.answerQuestion,
    newConversation: s.newConversation,
    switchConversation: s.switchConversation,
    loadConversation: s.loadConversation,
    deleteConversation: s.deleteConversation,
    rollbackToMessage: s.rollbackToMessage,
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

  const submitAnswer = useCallback(
    async (questionId: string, answers: QuestionAnswer[]) => {
      store.setPendingQuestion(null);
      if (activeTask) {
        return store.answerQuestion(activeTask.id, questionId, answers);
      }
    },
    [activeTask, store.answerQuestion, store.setPendingQuestion],
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

  const rollbackToMessage = useCallback(
    async (conversationId: string, messageId: string) => {
      return store.rollbackToMessage(conversationId, messageId);
    },
    [store.rollbackToMessage],
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
    pendingQuestion: store.pendingQuestion,
    mode: store.mode,
    inputDraft: store.inputDraft,
    sessionTokenUsage: store.sessionTokenUsage,
    taskTokenUsage: store.taskTokenUsage,
    conversations: store.conversations,
    activeConversationId: store.activeConversationId,
    sendPrompt,
    stopActiveTask,
    approveCurrent,
    rejectCurrent,
    submitAnswer,
    setMode,
    setInputDraft: store.setInputDraft,
    newConversation,
    switchConversation,
    loadConversation,
    deleteConversation,
    rollbackToMessage,
    loadConnectionConversations,
  };
}
