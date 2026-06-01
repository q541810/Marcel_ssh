import type { AgentMessage, ApprovalRequestPayload, AgentTaskPlan, AgentStatus, PlanItemStatus } from '@/lib/types';
import { useTaskStore } from './taskStore';
import { useConversationStore } from './conversationStore';
import type { StreamHandler } from './agentStreamHandlers';

export function createDefaultStreamHandler(): StreamHandler {
  return {
    updateMessages(conversationId, updater) {
      useConversationStore.setState((state) => ({
        messages: { ...state.messages, [conversationId]: updater(state.messages[conversationId] || []) },
      }));
    },
    updateTaskStatus(taskId, status) {
      useTaskStore.getState().updateTaskStatus(taskId, status as AgentStatus);
    },
    setPendingApproval(approval) {
      useTaskStore.getState().setPendingApproval(approval);
    },
    getTaskStatus(taskId) {
      return useTaskStore.getState().tasks[taskId]?.status;
    },
    getMessages(conversationId) {
      return useConversationStore.getState().messages[conversationId] || [];
    },
    clearActiveTaskIf(taskId) {
      useTaskStore.setState((state) => ({
        activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
      }));
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
