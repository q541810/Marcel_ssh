import type {
  AgentMessage,
  ToolResultPayload,
  ApprovalRequestPayload,
  AgentTaskPlan,
} from '@/lib/types';

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
// Tool call start handler — creates an in-progress tool message immediately
// ---------------------------------------------------------------------------

export function handleToolCallStart(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: { type: 'toolCallStart'; id: string; name: string },
) {
  const messageId = crypto.randomUUID();
  const toolMessage: AgentMessage = {
    id: messageId,
    role: 'tool',
    content: '',
    timestamp: new Date().toISOString(),
    isExecuting: true,
    toolResult: {
      toolName: ev.name,
      summary: '',
      result: '',
      success: true,
      blocked: false,
    },
  };

  handler.updateMessages(conversationId, (convMsgs) => {
    convMsgs = convMsgs.filter((m) => !(m.role === 'system' && m.isRetrying));
    const newMsgs = [...convMsgs];

    // Clear reasoningContent from the last assistant message (same as before)
    for (let i = newMsgs.length - 1; i >= 0; i--) {
      if (newMsgs[i].role === 'assistant' && newMsgs[i].reasoningContent) {
        newMsgs[i] = { ...newMsgs[i], reasoningContent: undefined, isThinking: false };
        break;
      }
    }

    newMsgs.push(toolMessage);

    // Register the mapping so handleToolResult can find it later
    const streamState = getStreamState(taskId);
    streamState.pendingToolCalls.set(ev.id, messageId);
    setStreamState(taskId, streamState);

    return newMsgs;
  });
}

// ---------------------------------------------------------------------------
// Per-task stream state tracking
// ---------------------------------------------------------------------------

interface TaskStreamState {
  assistantMessageId: string | null;
  messageIndex: number;
  loadingCleared: boolean;
  toolResultCount: number;
  pendingToolCalls: Map<string, string>; // toolCallId → message.id
}

const taskStreamState: Map<string, TaskStreamState> = new Map();

export function getStreamState(taskId: string): TaskStreamState {
  return taskStreamState.get(taskId) ?? {
    assistantMessageId: null,
    messageIndex: -1,
    loadingCleared: false,
    toolResultCount: 0,
    pendingToolCalls: new Map(),
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

    // Clear reasoningContent from the assistant message that triggered this tool call
    for (let i = newMsgs.length - 1; i >= 0; i--) {
      if (newMsgs[i].role === 'assistant' && newMsgs[i].reasoningContent) {
        newMsgs[i] = { ...newMsgs[i], reasoningContent: undefined, isThinking: false };
        break;
      }
    }

    // Try to find the in-progress tool message created by handleToolCallStart
    const pendingMsgId = streamState.pendingToolCalls.get(tr.toolCallId);
    if (pendingMsgId) {
      const pendingIdx = newMsgs.findIndex((m) => m.id === pendingMsgId);
      if (pendingIdx !== -1) {
        newMsgs[pendingIdx] = {
          ...newMsgs[pendingIdx],
          isExecuting: false,
          toolResult: {
            toolName: tr.toolName,
            summary: tr.summary,
            result: tr.result,
            success: tr.success,
            blocked: tr.blocked,
            wasTimeout: tr.wasTimeout,
            arguments: tr.arguments,
          },
        };
        streamState.pendingToolCalls.delete(tr.toolCallId);
        streamState.assistantMessageId = null;
        streamState.messageIndex = -1;
        streamState.toolResultCount = 0;
        setStreamState(taskId, streamState);
        return newMsgs;
      }
    }

    // Fallback: create a new tool message (no matching in-progress message found)
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
        wasTimeout: tr.wasTimeout,
        arguments: tr.arguments,
      },
    };

    newMsgs.push(toolMessage);

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
      convMsgs = convMsgs.filter((m) => !(m.role === 'system' && m.isRetrying));
      let { messageIndex: idx } = state;
      if (idx >= convMsgs.length || convMsgs[idx]?.id !== state.assistantMessageId) {
        idx = convMsgs.findIndex((m) => m.id === state.assistantMessageId);
      }
      const newMsgs = [...convMsgs];
      if (idx === -1) {
        // Fallback: target message not found, create new
        const newMsg: AgentMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: streamEv.text,
          timestamp: new Date().toISOString(),
        };
        newMsgs.push(newMsg);
        setStreamState(taskId, {
          ...getStreamState(taskId),
          assistantMessageId: newMsg.id,
          messageIndex: newMsgs.length - 1,
        });
      } else {
        newMsgs[idx] = { ...newMsgs[idx], isThinking: false, content: newMsgs[idx].content + streamEv.text };
      }
      return newMsgs;
    });
  } else {
    const initialLoadingCleared = state.loadingCleared;

    handler.updateMessages(conversationId, (convMsgs) => {
      convMsgs = convMsgs.filter((m) => !(m.role === 'system' && m.isRetrying));
      let newMsgs = [...convMsgs];
      let loadingCleared = initialLoadingCleared;

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

      setStreamState(taskId, {
        assistantMessageId: newMsg.id,
        messageIndex: newMsgs.length - 1,
        loadingCleared,
        toolResultCount: getStreamState(taskId).toolResultCount,
        pendingToolCalls: getStreamState(taskId).pendingToolCalls,
      });

      return newMsgs;
    });
  }

  if (handler.getTaskStatus(taskId) === 'planning') {
    handler.updateTaskStatus(taskId, 'executing');
  }
}

export function handleThinkingDelta(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
  streamEv: { type: 'thinkingDelta'; text: string },
) {
  const state = getStreamState(taskId);

  if (state.assistantMessageId) {
    handler.updateMessages(conversationId, (convMsgs) => {
      let { messageIndex: idx } = state;
      if (idx >= convMsgs.length || convMsgs[idx]?.id !== state.assistantMessageId) {
        idx = convMsgs.findIndex((m) => m.id === state.assistantMessageId);
      }
      const newMsgs = [...convMsgs];
      if (idx === -1) {
        // Fallback: target message not found, create new
        const newMsg: AgentMessage = {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: '',
          reasoningContent: streamEv.text,
          isThinking: true,
          timestamp: new Date().toISOString(),
        };
        newMsgs.push(newMsg);
        setStreamState(taskId, {
          ...getStreamState(taskId),
          assistantMessageId: newMsg.id,
          messageIndex: newMsgs.length - 1,
        });
      } else {
        const msg = newMsgs[idx];
        newMsgs[idx] = {
          ...msg,
          reasoningContent: (msg.reasoningContent || '') + streamEv.text,
          isThinking: true,
        };
      }
      return newMsgs;
    });
  } else {
    const initialLoadingCleared = state.loadingCleared;

    handler.updateMessages(conversationId, (convMsgs) => {
      let newMsgs = [...convMsgs];
      let loadingCleared = initialLoadingCleared;

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
        content: '',
        reasoningContent: streamEv.text,
        isThinking: true,
        timestamp: new Date().toISOString(),
      };
      newMsgs.push(newMsg);

      setStreamState(taskId, {
        assistantMessageId: newMsg.id,
        messageIndex: newMsgs.length - 1,
        loadingCleared,
        toolResultCount: getStreamState(taskId).toolResultCount,
        pendingToolCalls: getStreamState(taskId).pendingToolCalls,
      });

      return newMsgs;
    });
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
      // Remove the loading placeholder
      if (m.id === loadingAssistantId) return false;
      // Remove empty assistant messages without content, tool calls, or reasoning
      if (m.role === 'assistant' && m.content === '' && !m.toolCall && !m.reasoningContent) return false;
      // Remove tool messages that are still executing (tool call never completed)
      if (m.role === 'tool' && m.isExecuting) return false;
      // Remove retrying indicator (stale if we got a final response)
      if (m.role === 'system' && m.isRetrying) return false;
      return true;
    });
    // Clear isThinking and isLoading flags on all assistant messages
    return newMsgs.map((m) => {
      if (m.role === 'assistant' && (m.isThinking || m.isLoading)) {
        return { ...m, isThinking: false, isLoading: false };
      }
      return m;
    });
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
    const newMsgs = convMsgs
      .filter((m) => m.id !== loadingAssistantId)
      .filter((m) => !(m.role === 'tool' && m.isExecuting))
      .filter((m) => !(m.role === 'system' && m.isRetrying))
      .map((m) =>
        m.role === 'assistant' && (m.isThinking || m.isLoading)
          ? { ...m, isThinking: false, isLoading: false }
          : m,
      );
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

export function handleRetrying(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: { type: 'retrying'; attempt: number; maxAttempts: number; delaySecs: number; lastError: string },
) {
  handler.updateMessages(conversationId, (convMsgs) => {
    const newMsgs = convMsgs
      .filter((m) => !(m.role === 'system' && m.isRetrying));
    return [
      ...newMsgs,
      {
        id: crypto.randomUUID(),
        role: 'system',
        content: `正在重试 (${ev.attempt}/${ev.maxAttempts})，等待 ${ev.delaySecs}s...`,
        timestamp: new Date().toISOString(),
        isRetrying: true,
      },
    ];
  });
}


