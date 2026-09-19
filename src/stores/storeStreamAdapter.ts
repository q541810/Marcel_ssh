import type { AgentMode, AgentStatus, TokenUsage } from '@/lib/types';
import { useTaskStore } from './taskStore';
import { useConversationStore } from './conversationStore';
import type { StreamHandler } from './agentStreamHandlers';

export function createDefaultStreamHandler(): StreamHandler {
  return {
    updateMessages(conversationId, updater) {
      useConversationStore.getState().updateConversationMessages(conversationId, updater);
    },
    updateTaskStatus(taskId, status) {
      useTaskStore.getState().updateTaskStatus(taskId, status as AgentStatus);
    },
    getTaskStatus(taskId) {
      return useTaskStore.getState().tasks[taskId]?.status;
    },
    getMessages(conversationId) {
      return useConversationStore.getState().messages[conversationId] || [];
    },
    clearActiveTaskIf(taskId) {
      useTaskStore.getState().clearActiveTaskIf(taskId);
    },
    setPlan(taskId, plan) {
      useTaskStore.getState().setPlan(taskId, plan);
    },
    getTask(taskId) {
      const t = useTaskStore.getState().tasks[taskId];
      if (!t) return undefined;
      return { conversationId: t.conversationId, sessionId: t.sessionId, status: t.status };
    },
    getConversation(conversationId) {
      const c = useConversationStore.getState().conversations[conversationId];
      if (!c) return undefined;
      return { connectionId: c.connectionId, id: c.id };
    },
    registerSubTask(task) {
      useTaskStore.setState((s) => ({
        tasks: {
          ...s.tasks,
          [task.id]: {
            id: task.id,
            sessionId: task.sessionId,
            conversationId: task.conversationId,
            prompt: task.prompt,
            mode: task.mode as AgentMode,
            status: task.status as AgentStatus,
            createdAt: new Date().toISOString(),
            parentTaskId: task.parentTaskId,
          },
        },
      }));
    },
    registerSubConversation(args) {
      return useConversationStore.getState().registerSubConversation(
        args.conversationId,
        args.connectionId,
        args.title,
        args.subTaskId,
        args.prompt,
        args.parentConversationId,
      );
    },
    accumulateTokenUsage(usage: TokenUsage) {
      useTaskStore.getState().accumulateTokenUsage(usage);
    },
  };
}
