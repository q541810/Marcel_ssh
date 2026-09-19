import { useCallback, useEffect } from 'react';
import { useAgentStore } from '@/stores/agentStore';
import { bus } from '@/plugins/injection/bus';
import { isTaskBusy } from '@/lib/agentStatus';
import type { AgentMode } from '@/lib/types';

export function useAgent() {
  const store = useAgentStore((s) => ({
    conversations: s.conversations,
    activeConversationId: s.activeConversationId,
    messagesMap: s.messages,
    tasks: s.tasks,
    activeTaskId: s.activeTaskId,
    mode: s.mode,
    inputDraft: s.inputDraft,
    taskTokenUsage: s.taskTokenUsage,
    startTask: s.startTask,
    stopTask: s.stopTask,
    setMode: s.setMode,
    setInputDraft: s.setInputDraft,
    newConversation: s.newConversation,
    switchConversation: s.switchConversation,
    loadConversation: s.loadConversation,
    renameConversation: s.renameConversation,
    deleteConversation: s.deleteConversation,
    setConversationModel: s.setConversationModel,
    setConversationEffort: s.setConversationEffort,
    rollbackToMessage: s.rollbackToMessage,
    loadConnectionConversations: s.loadConnectionConversations,
    syncActiveToConnection: s.syncActiveToConnection,
    syncActiveToSession: s.syncActiveToSession,
  }));

  const activeTask = store.activeTaskId ? (store.tasks[store.activeTaskId] ?? null) : null;

  const messages = store.activeConversationId
    ? (store.messagesMap[store.activeConversationId] ?? [])
    : [];

  const isRunning = activeTask ? isTaskBusy(activeTask.status) : false;

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
    async (connectionId: string, sessionId?: string) => {
      return store.syncActiveToConnection(connectionId, sessionId);
    },
    [store.syncActiveToConnection],
  );

  const syncActiveToSession = useCallback(
    async (sessionId: string, connectionId: string) => {
      return store.syncActiveToSession(sessionId, connectionId);
    },
    [store.syncActiveToSession],
  );

  return {
    messages,
    activeTask,
    isRunning,
    mode: store.mode,
    inputDraft: store.inputDraft,
    taskTokenUsage: store.taskTokenUsage,
    conversations: store.conversations,
    activeConversationId: store.activeConversationId,
    sendPrompt,
    stopActiveTask,
    setMode,
    setInputDraft: store.setInputDraft,
    newConversation,
    switchConversation,
    loadConversation,
    renameConversation,
    deleteConversation,
    setConversationModel: store.setConversationModel,
    setConversationEffort: store.setConversationEffort,
    rollbackToMessage,
    loadConnectionConversations,
    syncActiveToConnection,
    syncActiveToSession,
  };
}
