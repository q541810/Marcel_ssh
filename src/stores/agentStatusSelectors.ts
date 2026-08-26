import type { AgentTask } from '@/lib/types';
import type { AgentVisualStatus } from '@/components/agent/AgentStatusIndicator';
import { useConversationStore } from '@/stores/conversationStore';

/**
 * 计算单个 Agent Task 的视觉状态
 */
export function getTaskVisualStatus(task?: AgentTask | null): AgentVisualStatus {
  if (!task) return 'idle';
  if (task.status === 'waiting_approval') return 'waiting_approval';
  if (task.status === 'planning' || task.status === 'executing') return 'running';
  return 'idle';
}

/**
 * 计算指定对话（Conversation）的综合 Agent 状态（含其挂载的所有子对话/子Agent任务）
 */
export function getConversationAgentStatus(
  conversationId: string,
  tasks: Record<string, AgentTask>,
  unreadCompletedConvIds: string[] = [],
): AgentVisualStatus {
  // 查找属于该主对话的所有子对话 ID（以及主对话本身）
  const allConversations = useConversationStore.getState().conversations;
  const targetConvIds = new Set<string>([conversationId]);
  for (const conv of Object.values(allConversations)) {
    if (conv.parentConversationId === conversationId) {
      targetConvIds.add(conv.id);
    }
  }

  const convTasks = Object.values(tasks).filter(
    (t) => targetConvIds.has(t.conversationId) && !!t.sessionId,
  );

  // 1. 如果有等待审批的任务，优先级最高（需要人工介入）
  if (convTasks.some((t) => t.status === 'waiting_approval')) {
    return 'waiting_approval';
  }

  // 2. 如果有正在运行的任务（planning 或 executing）
  if (convTasks.some((t) => t.status === 'planning' || t.status === 'executing')) {
    return 'running';
  }

  // 3. 如果在该对话（或其子对话）标记为未读完成列表中
  if (unreadCompletedConvIds.some((id) => targetConvIds.has(id))) {
    return 'unread_completed';
  }

  return 'idle';
}

/**
 * 计算指定 SSH 会话（Session）下的综合 Agent 状态
 */
export function getSessionAgentStatus(
  sessionId: string,
  tasks: Record<string, AgentTask>,
  unreadCompletedConvIds: string[] = [],
): AgentVisualStatus {
  const sessionTasks = Object.values(tasks).filter(
    (t) => t.sessionId === sessionId,
  );

  if (sessionTasks.some((t) => t.status === 'waiting_approval')) {
    return 'waiting_approval';
  }

  if (sessionTasks.some((t) => t.status === 'planning' || t.status === 'executing')) {
    return 'running';
  }

  // 检查属于该 session 的任务所在的 conversation 是否有未读完成
  const hasUnread = sessionTasks.some((t) =>
    unreadCompletedConvIds.includes(t.conversationId),
  );
  if (hasUnread) {
    return 'unread_completed';
  }

  return 'idle';
}

/**
 * 获取全局所有运行中的任务（用于多 Agent 抽屉与计数胶囊）
 */
export function getActiveRunningTasks(tasks: Record<string, AgentTask>): AgentTask[] {
  return Object.values(tasks).filter(
    (t) =>
      !!t.sessionId &&
      (t.status === 'planning' || t.status === 'executing' || t.status === 'waiting_approval'),
  );
}
