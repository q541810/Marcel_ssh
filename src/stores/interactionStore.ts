import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { ActiveInteractionPayload, QuestionAnswer } from '@/lib/types';
import * as tauri from '@/lib/tauri';

export interface InteractionState {
  currentInteraction: ActiveInteractionPayload | null;
  setCurrentInteraction: (interaction: ActiveInteractionPayload | null) => void;
  approve: (taskId: string, toolCallId: string) => Promise<void>;
  reject: (taskId: string, toolCallId: string) => Promise<void>;
  answerQuestion: (taskId: string, questionId: string, answers: QuestionAnswer[]) => Promise<void>;
}

export const useInteractionStore = create<InteractionState>((set, get) => ({
  currentInteraction: null,

  setCurrentInteraction: (interaction) => {
    set({ currentInteraction: interaction });
  },

  approve: async (taskId: string, toolCallId: string) => {
    try {
      await tauri.agentApproveOperation(taskId, toolCallId);
    } catch (err) {
      console.error('Failed to approve operation:', err);
    }
  },

  reject: async (taskId: string, toolCallId: string) => {
    try {
      await tauri.agentRejectOperation(taskId, toolCallId);
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

let globalUnlistenActive: UnlistenFn | null = null;
let globalUnlistenCleared: UnlistenFn | null = null;

export async function initInteractionListener() {
  if (globalUnlistenActive && globalUnlistenCleared) return;

  globalUnlistenActive = await listen<ActiveInteractionPayload>(
    'agent://interaction-active',
    (event) => {
      useInteractionStore.getState().setCurrentInteraction(event.payload);
    },
  );

  globalUnlistenCleared = await listen('agent://interaction-cleared', () => {
    useInteractionStore.getState().setCurrentInteraction(null);
  });
}
