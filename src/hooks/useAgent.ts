import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useConversationStore, useTaskStore } from "@/stores/agentStore";
import type { AgentMode, QuestionAnswer } from "@/lib/types";

export function useAgent() {
  const taskStore = useTaskStore(
    useShallow((s) => ({
      tasks: s.tasks,
      activeTaskId: s.activeTaskId,
      mode: s.mode,
      inputDraft: s.inputDraft,
      pendingApproval: s.pendingApproval,
      pendingQuestion: s.pendingQuestion,
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
    })),
  );
  const conversationStore = useConversationStore(
    useShallow((s) => ({
      conversations: s.conversations,
      activeConversationId: s.activeConversationId,
      messagesMap: s.messages,
      newConversation: s.newConversation,
      switchConversation: s.switchConversation,
      loadConversation: s.loadConversation,
      deleteConversation: s.deleteConversation,
      rollbackToMessage: s.rollbackToMessage,
      loadConnectionConversations: s.loadConnectionConversations,
      syncActiveToConnection: s.syncActiveToConnection,
    })),
  );

  const activeTask = taskStore.activeTaskId
    ? (taskStore.tasks[taskStore.activeTaskId] ?? null)
    : null;

  const messages = conversationStore.activeConversationId
    ? (conversationStore.messagesMap[conversationStore.activeConversationId] ??
      [])
    : [];

  const isRunning =
    activeTask?.status === "planning" ||
    activeTask?.status === "executing" ||
    activeTask?.status === "waiting_approval";

  const sendPrompt = useCallback(
    async (
      sessionId: string,
      prompt: string,
      connectionId?: string,
      imageDataUrls?: string[],
      replaceImagePaths?: string[],
    ) => {
      return taskStore.startTask(
        sessionId,
        prompt,
        connectionId,
        imageDataUrls,
        replaceImagePaths,
      );
    },
    [taskStore.startTask],
  );

  const stopActiveTask = useCallback(async () => {
    if (activeTask) {
      return taskStore.stopTask(activeTask.id);
    }
  }, [activeTask, taskStore.stopTask]);

  const approveCurrent = useCallback(
    async (operationId: string) => {
      taskStore.setPendingApproval(null);
      if (activeTask) {
        return taskStore.approveOperation(activeTask.id, operationId);
      }
    },
    [activeTask, taskStore.approveOperation, taskStore.setPendingApproval],
  );

  const rejectCurrent = useCallback(
    async (operationId: string) => {
      taskStore.setPendingApproval(null);
      if (activeTask) {
        return taskStore.rejectOperation(activeTask.id, operationId);
      }
    },
    [activeTask, taskStore.rejectOperation, taskStore.setPendingApproval],
  );

  const submitAnswer = useCallback(
    async (questionId: string, answers: QuestionAnswer[]) => {
      taskStore.setPendingQuestion(null);
      if (activeTask) {
        return taskStore.answerQuestion(activeTask.id, questionId, answers);
      }
    },
    [activeTask, taskStore.answerQuestion, taskStore.setPendingQuestion],
  );

  const setMode = useCallback(
    (newMode: AgentMode) => {
      taskStore.setMode(newMode);
    },
    [taskStore.setMode],
  );

  const newConversation = useCallback(
    async (sessionId: string, connectionId: string) => {
      return conversationStore.newConversation(sessionId, connectionId);
    },
    [conversationStore.newConversation],
  );

  const switchConversation = useCallback(
    async (conversationId: string) => {
      return conversationStore.switchConversation(conversationId);
    },
    [conversationStore.switchConversation],
  );

  const loadConversation = useCallback(
    async (conversationId: string) => {
      return conversationStore.loadConversation(conversationId);
    },
    [conversationStore.loadConversation],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      return conversationStore.deleteConversation(conversationId);
    },
    [conversationStore.deleteConversation],
  );

  const rollbackToMessage = useCallback(
    async (conversationId: string, messageId: string) => {
      return conversationStore.rollbackToMessage(conversationId, messageId);
    },
    [conversationStore.rollbackToMessage],
  );

  const loadConnectionConversations = useCallback(
    async (connectionId: string) => {
      return conversationStore.loadConnectionConversations(connectionId);
    },
    [conversationStore.loadConnectionConversations],
  );

  const syncActiveToConnection = useCallback(
    async (connectionId: string) => {
      return conversationStore.syncActiveToConnection(connectionId);
    },
    [conversationStore.syncActiveToConnection],
  );

  return {
    messages,
    activeTask,
    isRunning,
    pendingApproval: taskStore.pendingApproval,
    pendingQuestion: taskStore.pendingQuestion,
    mode: taskStore.mode,
    inputDraft: taskStore.inputDraft,
    taskTokenUsage: taskStore.taskTokenUsage,
    conversations: conversationStore.conversations,
    activeConversationId: conversationStore.activeConversationId,
    sendPrompt,
    stopActiveTask,
    approveCurrent,
    rejectCurrent,
    submitAnswer,
    setMode,
    setInputDraft: taskStore.setInputDraft,
    newConversation,
    switchConversation,
    loadConversation,
    deleteConversation,
    rollbackToMessage,
    loadConnectionConversations,
    syncActiveToConnection,
  };
}
