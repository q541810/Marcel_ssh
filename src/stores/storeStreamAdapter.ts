import type { AgentMessage, ApprovalRequestPayload, QuestionRequestPayload, AgentTaskPlan, AgentStatus, PlanItemStatus } from '@/lib/types';
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
    setPendingApproval(approval) {
      useTaskStore.getState().setPendingApproval(approval);
    },
    setPendingQuestion(question) {
      useTaskStore.getState().setPendingQuestion(question);
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
    updatePlanItem(taskId, itemId, status, error) {
      useTaskStore.getState().updatePlanItem(taskId, itemId, status as PlanItemStatus, error);
    },
    getPlan(taskId) {
      return useTaskStore.getState().plans[taskId];
    },
  };
}
