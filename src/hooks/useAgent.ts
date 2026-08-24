import { useCallback, useEffect } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import { bus } from '@/plugins/injection/bus';
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
    renameConversation: s.renameConversation,
    deleteConversation: s.deleteConversation,
    rollbackToMessage: s.rollbackToMessage,
    loadConnectionConversations: s.loadConnectionConversations,
    syncActiveToConnection: s.syncActiveToConnection,
  }));

  const activeTask = store.activeTaskId ? (store.tasks[store.activeTaskId] ?? null) : null;

  const messages = store.activeConversationId
    ? (store.messagesMap[store.activeConversationId] ?? [])
    : [];

  const isRunning =
    activeTask?.status === 'planning' ||
    activeTask?.status === 'executing' ||
    activeTask?.status === 'waiting_approval';

  // ── Plugin agent-activity bridge ─────────────────────────────────────
  // Emits `ui://agent-activity` (running bool only — never task content) so
  // plugins (e.g. a desktop pet) can mirror the main UI's run indicator
  // (the red stop button). Same source as the button: task status is
  // non-terminal (planning / executing / waiting_approval). Fires on
  // mount and whenever the running state changes.
  useEffect(() => {
    bus.emit('ui://agent-activity', { running: isRunning });
  }, [isRunning]);

  const sendPrompt = useCallback(
    async (
      sessionId: string,
      prompt: string,
      connectionId?: string,
      imageDataUrls?: string[],
      replaceImagePaths?: string[],
    ) => {
      return store.startTask(sessionId, prompt, connectionId, imageDataUrls, replaceImagePaths);
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
      // 优先用事件来源 taskId（子agent在独立通道上运行，activeTaskId 可能仍是父任务）
      const taskId = store.pendingApproval?.taskId ?? activeTask?.id;
      if (taskId) {
        return store.approveOperation(taskId, operationId);
      }
    },
    [activeTask?.id, store.approveOperation, store.setPendingApproval, store.pendingApproval],
  );

  const rejectCurrent = useCallback(
    async (operationId: string) => {
      store.setPendingApproval(null);
      const taskId = store.pendingApproval?.taskId ?? activeTask?.id;
      if (taskId) {
        return store.rejectOperation(taskId, operationId);
      }
    },
    [activeTask?.id, store.rejectOperation, store.setPendingApproval, store.pendingApproval],
  );

  const submitAnswer = useCallback(
    async (questionId: string, answers: QuestionAnswer[]) => {
      store.setPendingQuestion(null);
      const taskId = store.pendingQuestion?.taskId ?? activeTask?.id;
      if (taskId) {
        return store.answerQuestion(taskId, questionId, answers);
      }
    },
    [activeTask?.id, store.answerQuestion, store.setPendingQuestion, store.pendingQuestion],
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

  const renameConversation = useCallback(
    async (conversationId: string, title: string) => {
      return store.renameConversation(conversationId, title);
    },
    [store.renameConversation],
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

  const syncActiveToConnection = useCallback(
    async (connectionId: string) => {
      return store.syncActiveToConnection(connectionId);
    },
    [store.syncActiveToConnection],
  );

  return {
    messages,
    activeTask,
    isRunning,
    pendingApproval: store.pendingApproval,
    pendingQuestion: store.pendingQuestion,
    mode: store.mode,
    inputDraft: store.inputDraft,
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
    renameConversation,
    deleteConversation,
    rollbackToMessage,
    loadConnectionConversations,
    syncActiveToConnection,
  };
}
