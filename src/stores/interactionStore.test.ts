import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useInteractionStore } from './interactionStore';
import * as tauri from '@/lib/tauri';
import type { ActiveInteractionPayload } from '@/lib/types';

vi.mock('@/lib/tauri', () => ({
  agentApproveOperation: vi.fn(),
  agentRejectOperation: vi.fn(),
  agentAnswerQuestion: vi.fn(),
}));

describe('interactionStore', () => {
  beforeEach(() => {
    useInteractionStore.setState({ currentInteraction: null });
    vi.clearAllMocks();
  });

  it('sets and clears current interaction', () => {
    const payload: ActiveInteractionPayload = {
      type: 'interactionActive',
      interactionId: 'approval:c1',
      kind: 'approval',
      taskId: 't1',
      sessionId: 's1',
      conversationId: 'conv1',
      sessionName: 'Ubuntu Server',
      conversationTitle: 'Fix issue',
      queueLength: 2,
      approval: {
        toolCallId: 'c1',
        toolName: 'execute_command',
        arguments: { command: 'ls -la' },
        riskLevel: 'Moderate',
      },
    };

    useInteractionStore.getState().setCurrentInteraction(payload);
    expect(useInteractionStore.getState().currentInteraction).toEqual(payload);

    useInteractionStore.getState().setCurrentInteraction(null);
    expect(useInteractionStore.getState().currentInteraction).toBeNull();
  });

  it('delegates approve to tauri.agentApproveOperation', async () => {
    await useInteractionStore.getState().approve('t1', 'c1');
    expect(tauri.agentApproveOperation).toHaveBeenCalledWith('t1', 'c1');
  });

  it('delegates reject to tauri.agentRejectOperation', async () => {
    await useInteractionStore.getState().reject('t1', 'c1');
    expect(tauri.agentRejectOperation).toHaveBeenCalledWith('t1', 'c1');
  });

  it('delegates answerQuestion to tauri.agentAnswerQuestion', async () => {
    const answers = [{ selected: ['opt1'], custom: '' }];
    await useInteractionStore.getState().answerQuestion('t1', 'q1', answers);
    expect(tauri.agentAnswerQuestion).toHaveBeenCalledWith('t1', 'q1', answers);
  });
});
