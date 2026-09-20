import { create } from 'zustand';
import { subscribeTauriEvent } from '@/lib/tauriEvent';
import type { ActiveInteractionPayload, QuestionAnswer } from '@/lib/types';
import * as tauri from '@/lib/tauri';
import { useTaskStore } from '@/stores/taskStore';

export interface InteractionState {
  currentInteraction: ActiveInteractionPayload | null;
  setCurrentInteraction: (interaction: ActiveInteractionPayload | null) => void;
  approve: (taskId: string, toolCallId: string) => Promise<void>;
  reject: (taskId: string, toolCallId: string, reason?: string) => Promise<void>;
  answerQuestion: (taskId: string, questionId: string, answers: QuestionAnswer[]) => Promise<void>;
}

export const useInteractionStore = create<InteractionState>((set, get) => ({
  currentInteraction: null,

  setCurrentInteraction: (interaction) => {
    const prev = get().currentInteraction;
    set({ currentInteraction: interaction });

    const taskStore = useTaskStore.getState();

    // 联动 taskStore 状态指示器：
    if (interaction?.taskId) {
      // 1. 点亮当前活动交互所属 task 为 waiting_approval
      taskStore.updateTaskStatus(interaction.taskId, 'waiting_approval');
    }

    // 2. 当没有活动交互或交互切换时：若内存中仍有其他 task 残留 waiting_approval，
    // 但此时并没有对应的活动交互在等待它，将其恢复为 executing（避免孤儿橙点）
    const activeTaskId = interaction?.taskId;
    for (const [id, task] of Object.entries(taskStore.tasks)) {
      if (task.status === 'waiting_approval' && id !== activeTaskId) {
        taskStore.updateTaskStatus(id, 'executing');
      }
    }
  },

  approve: async (taskId: string, toolCallId: string) => {
    try {
      await tauri.agentApproveOperation(taskId, toolCallId);
    } catch (err) {
      console.error('Failed to approve operation:', err);
    }
  },

  reject: async (taskId: string, toolCallId: string, reason?: string) => {
    try {
      await tauri.agentRejectOperation(taskId, toolCallId, reason);
    } catch (err) {
      console.error('Failed to reject operation:', err);
    }
  },

  answerQuestion: async (taskId: string, questionId: string, answers: QuestionAnswer[]) => {
    try {
      await tauri.agentAnswerQuestion(taskId, questionId, answers);
    } catch (err) {
      console.error('Failed to answer question:', err);
    }
  },
}));

let detachInteractionListeners: (() => void) | null = null;

/**
 * 订阅全局交互事件（幂等）。
 *
 * 旧实现是 `async`，幂等守卫写在两个 `await` 之前：两次并发调用都能通过守卫，
 * 后完成的那次覆盖前一次的 unlisten，前一条监听就泄漏了；而且当时没有任何退订
 * 入口。`subscribeTauriEvent` 同步返回取消函数，守卫因此在第一次调用返回前就已
 * 生效，StrictMode 的双挂载也拦得住。
 *
 * 返回值是退订函数，供 React effect 的 cleanup 使用。
 */
export function initInteractionListener(): () => void {
  if (detachInteractionListeners) return detachInteractionListeners;

  const offActive = subscribeTauriEvent<ActiveInteractionPayload>(
    'agent://interaction-active',
    (payload) => {
      useInteractionStore.getState().setCurrentInteraction(payload);
    },
  );
  const offCleared = subscribeTauriEvent('agent://interaction-cleared', () => {
    useInteractionStore.getState().setCurrentInteraction(null);
  });

  detachInteractionListeners = () => {
    detachInteractionListeners = null;
    offActive();
    offCleared();
  };
  return detachInteractionListeners;
}
