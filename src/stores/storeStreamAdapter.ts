import type { AgentMode, AgentStatus } from '@/lib/types';
import { isTaskBusy } from '@/lib/agentStatus';
import { newTaskOutputEntry, useTaskStore } from './taskStore';
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
        // 子 agent 与主任务一样是「一个在跑的任务」：要有自己的输出计数条目，
        // 否则它的状态条永远是 0。已是终态的（重启恢复兜底登记）不会再有流，不建。
        taskOutputByConversation: isTaskBusy(task.status as AgentStatus)
          ? { ...s.taskOutputByConversation, [task.conversationId]: newTaskOutputEntry(task.conversationId) }
          : s.taskOutputByConversation,
      }));
    },
    retireAwaitingParent(conversationId, exceptTaskId) {
      const { tasks, updateTaskStatus } = useTaskStore.getState();
      for (const t of Object.values(tasks)) {
        if (t.conversationId === conversationId && t.id !== exceptTaskId && t.status === 'awaiting_parent') {
          updateTaskStatus(t.id, 'completed');
        }
      }
    },
    registerSubConversation(args) {
      return useConversationStore.getState().registerSubConversation(
        args.conversationId,
        args.connectionId,
        args.title,
        args.subTaskId,
        args.prompt,
        args.parentConversationId,
        args.answersAsk,
      );
    },
    recordContextUsage(conversationId, ev) {
      useTaskStore.getState().recordContextUsage(conversationId, ev);
    },
    recordOutputDelta(conversationId, text) {
      useTaskStore.getState().recordOutputDelta(conversationId, text);
    },
    recordOutputTokens(conversationId, tokens) {
      useTaskStore.getState().recordOutputTokens(conversationId, tokens);
    },
  };
}
