import type {
  AgentMessage,
  ToolResultPayload,
  ApprovalRequestPayload,
  AgentTaskPlan,
  AgentStatus,
  PlanItemStatus,
} from '@/lib/types';
import { useAgentStore } from './agentStore';

// ---------------------------------------------------------------------------
// StreamHandler interface
// ---------------------------------------------------------------------------

export interface StreamHandler {
  updateMessages(conversationId: string, updater: (msgs: AgentMessage[]) => AgentMessage[]): void;
  updateTaskStatus(taskId: string, status: string): void;
  setPendingApproval(approval: ApprovalRequestPayload | null): void;
  getTaskStatus(taskId: string): string | undefined;
  getMessages(conversationId: string): AgentMessage[];
  clearActiveTaskIf(taskId: string): void;
  setPlan(taskId: string, plan: AgentTaskPlan): void;
  updatePlanItem(taskId: string, itemId: string, status: string, error?: string): void;
  getPlan(taskId: string): AgentTaskPlan | undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertToolMessageAfterAssistant(newMsgs: AgentMessage[], toolMessage: AgentMessage): AgentMessage[] {
  newMsgs.push(toolMessage);
  return newMsgs;
}

// ---------------------------------------------------------------------------
// Per-task stream state tracking
// ---------------------------------------------------------------------------

interface TaskStreamState {
  assistantMessageId: string | null;
  messageIndex: number;
  loadingCleared: boolean;
  toolResultCount: number;
}

const taskStreamState: Map<string, TaskStreamState> = new Map();

export function getStreamState(taskId: string): TaskStreamState {
  return taskStreamState.get(taskId) ?? {
    assistantMessageId: null,
    messageIndex: -1,
    loadingCleared: false,
    toolResultCount: 0,
  };
}

export function cleanupStreamState(taskId: string) {
  taskStreamState.delete(taskId);
}

export function setStreamState(taskId: string, state: TaskStreamState) {
  taskStreamState.set(taskId, state);
}

// ---------------------------------------------------------------------------
// Event handlers — accept StreamHandler instead of direct store access
// ---------------------------------------------------------------------------

export function handleToolResult(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
  tr: ToolResultPayload,
) {
  const toolMessage: AgentMessage = {
    id: crypto.randomUUID(),
    role: 'tool',
    content: '',
    timestamp: new Date().toISOString(),
    toolResult: {
      toolName: tr.toolName,
      summary: tr.summary,
      result: tr.result,
      success: tr.success,
      blocked: tr.blocked,
      arguments: tr.arguments,
    },
  };

  handler.updateMessages(conversationId, (convMsgs) => {
    const newMsgs = [...convMsgs];
    const streamState = getStreamState(taskId);

    if (!streamState.loadingCleared) {
      const loadingIdx = newMsgs.findIndex((m) => m.id === loadingAssistantId);
      if (loadingIdx !== -1) {
        newMsgs.splice(loadingIdx, 1);
        streamState.loadingCleared = true;
      }
    }

    streamState.toolResultCount++;

    insertToolMessageAfterAssistant(newMsgs, toolMessage);

    streamState.assistantMessageId = null;
    streamState.messageIndex = -1;
    streamState.toolResultCount = 0;

    setStreamState(taskId, streamState);

    return newMsgs;
  });
}

export function handleTextDelta(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
  streamEv: { type: 'textDelta'; text: string },
) {
  const state = getStreamState(taskId);

  if (state.assistantMessageId) {
    handler.updateMessages(conversationId, (convMsgs) => {
      let { messageIndex: idx } = state;
      if (idx >= convMsgs.length || convMsgs[idx]?.id !== state.assistantMessageId) {
        idx = convMsgs.findIndex((m) => m.id === state.assistantMessageId);
        if (idx === -1) return convMsgs;
      }
      const newMsgs = [...convMsgs];
      newMsgs[idx] = { ...newMsgs[idx], content: newMsgs[idx].content + streamEv.text };
      return newMsgs;
    });
  } else {
    let loadingCleared = state.loadingCleared;
    let newAssistantId = '';
    let newMsgIndex = -1;

    handler.updateMessages(conversationId, (convMsgs) => {
      let newMsgs = [...convMsgs];
      if (!loadingCleared) {
        const loadingIdx = newMsgs.findIndex((m) => m.id === loadingAssistantId);
        if (loadingIdx !== -1) {
          newMsgs.splice(loadingIdx, 1);
          loadingCleared = true;
        }
      }

      const newMsg: AgentMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: streamEv.text,
        timestamp: new Date().toISOString(),
      };
      newMsgs.push(newMsg);
      newAssistantId = newMsg.id;
      newMsgIndex = newMsgs.length - 1;

      return newMsgs;
    });

    const finalState = getStreamState(taskId);
    setStreamState(taskId, {
      assistantMessageId: newAssistantId,
      messageIndex: newMsgIndex,
      loadingCleared,
      toolResultCount: finalState.toolResultCount,
    });
  }

  if (handler.getTaskStatus(taskId) === 'planning') {
    handler.updateTaskStatus(taskId, 'executing');
  }
}

export function handleDone(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
) {
  handler.updateTaskStatus(taskId, 'completed');

  handler.updateMessages(conversationId, (convMsgs) => {
    const newMsgs = convMsgs.filter((m) => {
      if (m.id === loadingAssistantId) return false;
      if (m.role === 'assistant' && m.content === '' && !m.toolCall) return false;
      return true;
    });
    return newMsgs;
  });

  handler.clearActiveTaskIf(taskId);
  handler.setPendingApproval(null);
}

export function handleError(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
  errEv: { type: 'error'; message: string },
) {
  handler.updateTaskStatus(taskId, 'failed');

  handler.updateMessages(conversationId, (convMsgs) => {
    const newMsgs = convMsgs.filter((m) => m.id !== loadingAssistantId);
    return [
      ...newMsgs,
      {
        id: crypto.randomUUID(),
        role: 'system',
        content: `LLM 错误：${errEv.message}`,
        timestamp: new Date().toISOString(),
      },
    ];
  });

  handler.clearActiveTaskIf(taskId);
  handler.setPendingApproval(null);
}

// ---------------------------------------------------------------------------
// Default StreamHandler backed by useAgentStore
// ---------------------------------------------------------------------------

export function createDefaultStreamHandler(): StreamHandler {
  return {
    updateMessages(conversationId, updater) {
      useAgentStore.setState((state: { messages: Record<string, AgentMessage[]> }) => ({
        messages: { ...state.messages, [conversationId]: updater(state.messages[conversationId] || []) },
      }));
    },

    updateTaskStatus(taskId, status) {
      useAgentStore.getState().updateTaskStatus(taskId, status as AgentStatus);
    },

    setPendingApproval(approval) {
      useAgentStore.getState().setPendingApproval(approval);
    },

    getTaskStatus(taskId) {
      return useAgentStore.getState().tasks[taskId]?.status;
    },

    getMessages(conversationId) {
      return useAgentStore.getState().messages[conversationId] || [];
    },

    clearActiveTaskIf(taskId) {
      useAgentStore.setState((state: { activeTaskId: string | null }) => ({
        activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
      }));
    },

    setPlan(taskId, plan) {
      useAgentStore.getState().setPlan(taskId, plan);
    },

    updatePlanItem(taskId, itemId, status, error) {
      useAgentStore.getState().updatePlanItem(taskId, itemId, status as PlanItemStatus, error);
    },

    getPlan(taskId) {
      return useAgentStore.getState().plans[taskId];
    },
  };
}
