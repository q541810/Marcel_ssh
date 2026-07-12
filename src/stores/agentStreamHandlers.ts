import type {
  AgentMessage,
  ToolResultPayload,
  ApprovalRequestPayload,
  AgentTaskPlan,
  ModelApprovalStartPayload,
  ModelApprovalDonePayload,
  QuestionRequestPayload,
} from '@/lib/types';

// ---------------------------------------------------------------------------
// StreamHandler interface
// ---------------------------------------------------------------------------

export interface StreamHandler {
  updateMessages(conversationId: string, updater: (msgs: AgentMessage[]) => AgentMessage[]): void;
  updateTaskStatus(taskId: string, status: string): void;
  setPendingApproval(approval: ApprovalRequestPayload | null): void;
  setPendingQuestion(question: QuestionRequestPayload | null): void;
  getTaskStatus(taskId: string): string | undefined;
  getMessages(conversationId: string): AgentMessage[];
  clearActiveTaskIf(taskId: string): void;
  setPlan(taskId: string, plan: AgentTaskPlan): void;
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
      toolCallId: ev.id,
    },
  };

  // Tool call starts: discard pending delta buffer.
  // Thinking text before a tool call is ephemeral — the agent_loop
  // does not persist it and handleToolCallStart clears reasoningContent
  // from the last assistant message.  If deltas are still buffered
  // (not yet flushed via rAF), they would otherwise survive as a
  // stale isThinking=true message, auto-expanding every tool card
  // mid-execution with "no output".  Clearing the buffer and
  // cancelling the scheduled rAF prevents that.
  const state = getStreamState(taskId);
  state.pendingTextDelta = '';
  state.pendingThinkingDelta = '';
  if (state.flushRafId != null) {
    cancelAnimationFrame(state.flushRafId);
    state.flushRafId = null;
  }

  handler.updateMessages(conversationId, (convMsgs) => {
    convMsgs = convMsgs.filter((m) => !(m.role === 'system' && m.isRetrying));
    const newMsgs = [...convMsgs];

    for (let i = newMsgs.length - 1; i >= 0; i--) {
      const m = newMsgs[i];
      if (m.role === 'assistant' && m.reasoningContent) {
        newMsgs[i] = { ...m, reasoningContent: undefined, isThinking: false };
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
// Tool arguments delta — accumulates streamed arguments and backfills tool message
// ---------------------------------------------------------------------------

export function handleToolCallDelta(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: { type: 'toolCallDelta'; id: string; argumentsDelta: string },
) {
  const streamState = getStreamState(taskId);
  const pendingMsgId = streamState.pendingToolCalls.get(ev.id);
  if (!pendingMsgId) return;

  const prev = streamState.pendingToolArgs.get(ev.id) ?? '';
  const accumulated = prev + ev.argumentsDelta;
  streamState.pendingToolArgs.set(ev.id, accumulated);
  setStreamState(taskId, streamState);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(accumulated);
  } catch {
    return;
  }

  handler.updateMessages(conversationId, (convMsgs) => {
    const idx = convMsgs.findIndex((m) => m.id === pendingMsgId);
    if (idx === -1) return convMsgs;
    const msg = convMsgs[idx];
    if (!msg.toolResult) return convMsgs;
    const newMsgs = [...convMsgs];
    newMsgs[idx] = {
      ...msg,
      toolResult: { ...msg.toolResult, arguments: parsed },
    };
    return newMsgs;
  });
}

// ---------------------------------------------------------------------------
// Tool output stream — updates the result field incrementally
// ---------------------------------------------------------------------------

export function handleToolOutput(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  toolCallId: string,
  chunk: string,
) {
  handler.updateMessages(conversationId, (convMsgs) => {
    const newMsgs = [...convMsgs];
    const streamState = getStreamState(taskId);
    const pendingMsgId = streamState.pendingToolCalls.get(toolCallId);
    if (pendingMsgId) {
      const pendingIdx = newMsgs.findIndex((m) => m.id === pendingMsgId);
      if (pendingIdx !== -1) {
        const msg = newMsgs[pendingIdx];
        newMsgs[pendingIdx] = {
          ...msg,
          toolResult: {
            ...msg.toolResult!,
            result: (msg.toolResult!.result || '') + chunk,
          },
        };
      }
    }
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
  pendingToolArgs: Map<string, string>; // toolCallId → accumulated arguments string
  // ── rAF-batched delta buffer ──
  // LLM streaming 在高速场景下每秒可能产生几十到上百个 delta，
  // 直接 updateMessages 会触发等量的 React 渲染，配合 react-markdown
  // 的高亮插件会把 DOM 解析跑成单线程瓶颈，最终导致 token 任务堆积、
  // 通知弹窗先于内容渲染完成到达。把 delta 先攒进 buffer，
  // 用 requestAnimationFrame 把同帧内全部 delta 合并成一次提交。
  pendingTextDelta: string;
  pendingThinkingDelta: string;
  flushRafId: number | null;
}

const taskStreamState: Map<string, TaskStreamState> = new Map();

export function getStreamState(taskId: string): TaskStreamState {
  return taskStreamState.get(taskId) ?? {
    assistantMessageId: null,
    messageIndex: -1,
    loadingCleared: false,
    toolResultCount: 0,
    pendingToolCalls: new Map(),
    pendingToolArgs: new Map(),
    pendingTextDelta: '',
    pendingThinkingDelta: '',
    flushRafId: null,
  };
}

export function cleanupStreamState(taskId: string) {
  const state = taskStreamState.get(taskId);
  if (state?.flushRafId != null) {
    cancelAnimationFrame(state.flushRafId);
  }
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
          modelApproval: undefined,
          toolResult: {
            toolName: tr.toolName,
            summary: tr.summary,
            result: tr.result,
            success: tr.success,
            blocked: tr.blocked,
            wasTimeout: tr.wasTimeout,
            wasAborted: tr.wasAborted,
            arguments: tr.arguments,
            toolCallId: tr.toolCallId,
            metadata: tr.metadata,
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
        wasAborted: tr.wasAborted,
        arguments: tr.arguments,
        toolCallId: tr.toolCallId,
        metadata: tr.metadata,
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

// ---------------------------------------------------------------------------
// rAF-batched delta flush
// ---------------------------------------------------------------------------

/**
 * 把 task 累积的 pending delta 合并提交到 store。
 * 由 scheduleFlush（rAF 触发）或 handleDone（强制同步）调用。
 * 同步执行：调用后 buffer 清空，rAF 句柄释放。
 */
function flushPendingDeltas(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
) {
  const state = getStreamState(taskId);
  const { pendingTextDelta, pendingThinkingDelta } = state;

  // 清空 buffer 和 raf 句柄 —— 必须在 updateMessages 之前完成，
  // 否则 updater 闭包里对 state 的写入会丢失。
  state.pendingTextDelta = '';
  state.pendingThinkingDelta = '';
  if (state.flushRafId != null) {
    cancelAnimationFrame(state.flushRafId);
    state.flushRafId = null;
  }

  if (!pendingTextDelta && !pendingThinkingDelta) return;

  handler.updateMessages(conversationId, (convMsgs) => {
    convMsgs = convMsgs.filter((m) => !(m.role === 'system' && m.isRetrying));
    const newMsgs = [...convMsgs];
    const targetId = state.assistantMessageId;
    let idx = targetId
      ? newMsgs.findIndex((m) => m.id === targetId)
      : -1;

    if (idx === -1) {
      // 第一次 flush：清掉 loading 占位符并建一条 assistant 消息
      if (!state.loadingCleared) {
        const loadingIdx = newMsgs.findIndex((m) => m.id === loadingAssistantId);
        if (loadingIdx !== -1) {
          newMsgs.splice(loadingIdx, 1);
          state.loadingCleared = true;
        }
      }
      const newMsg: AgentMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: pendingTextDelta,
        reasoningContent: pendingThinkingDelta || undefined,
        isThinking: !!pendingThinkingDelta && !pendingTextDelta,
        timestamp: new Date().toISOString(),
      };
      newMsgs.push(newMsg);
      state.assistantMessageId = newMsg.id;
      state.messageIndex = newMsgs.length - 1;
    } else {
      const msg = newMsgs[idx];
      newMsgs[idx] = {
        ...msg,
        content: msg.content + pendingTextDelta,
        reasoningContent: pendingThinkingDelta
          ? (msg.reasoningContent || '') + pendingThinkingDelta
          : msg.reasoningContent,
        isThinking: pendingThinkingDelta && !msg.content ? true : false,
      };
    }
    return newMsgs;
  });
}

/**
 * 把一次 delta 调度到下一帧再提交。同一帧内多次调用只会真正 flush 一次。
 * 如果已调度则直接返回（O(1) 短路）。
 */
function scheduleFlush(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
) {
  const state = getStreamState(taskId);
  if (state.flushRafId != null) return;
  state.flushRafId = requestAnimationFrame(() => {
    flushPendingDeltas(handler, taskId, conversationId, loadingAssistantId);
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
  state.pendingTextDelta += streamEv.text;
  setStreamState(taskId, state);
  scheduleFlush(handler, taskId, conversationId, loadingAssistantId);

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
  state.pendingThinkingDelta += streamEv.text;
  setStreamState(taskId, state);
  scheduleFlush(handler, taskId, conversationId, loadingAssistantId);
}

export function handleDone(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
) {
  // LLM 流结束：把尚未 flush 的 delta 同步提交。
  // 不依赖 rAF 是因为 rAF 在某些边缘场景（页面已失活等）可能延迟到下一帧，
  // 而 Done 之后没新事件进来了，残留 delta 会卡住不渲染。
  flushPendingDeltas(handler, taskId, conversationId, loadingAssistantId);

  handler.updateTaskStatus(taskId, 'completed');

  handler.updateMessages(conversationId, (convMsgs) => {
    const newMsgs = convMsgs.filter((m) => {
      // Remove the loading placeholder
      if (m.id === loadingAssistantId) return false;
      // Remove empty assistant messages without content, tool calls, or reasoning
      if (m.role === 'assistant' && m.content === '' && !m.toolCall && !m.toolCalls?.length && !m.reasoningContent) return false;
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

  // 不在此处清空 activeTaskId：保留它让 PlanList 能继续展示已完成的计划。
  // activeTaskId 会在用户发新消息（agentStartTask 生成新 taskId）或切换会话
  // （conversationStore.switchConversation → clearActiveTask）时自然更新。
  handler.setPendingApproval(null);
}

export function handleError(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
  errEv: { type: 'error'; message: string },
) {
  // 错误发生：丢掉 buffer，不渲染残缺流式内容。rAF 句柄一并取消避免泄漏。
  const state = getStreamState(taskId);
  if (state.flushRafId != null) {
    cancelAnimationFrame(state.flushRafId);
    state.flushRafId = null;
  }
  state.pendingTextDelta = '';
  state.pendingThinkingDelta = '';

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

  // 不在此处清空 activeTaskId（同 handleDone 的理由）
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
        content: '',
        timestamp: new Date().toISOString(),
        isRetrying: true,
        retryAttempt: ev.attempt - 1,
        retryMaxAttempts: ev.maxAttempts - 1,
        retryTotalDelaySecs: ev.delaySecs,
        retryLastError: ev.lastError,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Model approval progress handlers
// ---------------------------------------------------------------------------

export function handleModelApprovalStart(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: ModelApprovalStartPayload,
) {
  handler.updateMessages(conversationId, (convMsgs) => {
    const streamState = getStreamState(taskId);
    const pendingMsgId = streamState.pendingToolCalls.get(ev.toolCallId);
    if (!pendingMsgId) return convMsgs;
    const idx = convMsgs.findIndex((m) => m.id === pendingMsgId);
    if (idx === -1) return convMsgs;
    const newMsgs = [...convMsgs];
    newMsgs[idx] = {
      ...newMsgs[idx],
      modelApproval: { status: 'checking' },
    };
    return newMsgs;
  });
}

export function handleModelApprovalDone(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: ModelApprovalDonePayload,
) {
  handler.updateMessages(conversationId, (convMsgs) => {
    const streamState = getStreamState(taskId);
    const pendingMsgId = streamState.pendingToolCalls.get(ev.toolCallId);
    if (!pendingMsgId) return convMsgs;
    const idx = convMsgs.findIndex((m) => m.id === pendingMsgId);
    if (idx === -1) return convMsgs;
    const newMsgs = [...convMsgs];
    if (ev.decision === 'approve' || ev.decision === 'error') {
      // Approve: clear the indicator — execution continues.
      // Error: clear — the tool result will show the error message.
      newMsgs[idx] = { ...newMsgs[idx], modelApproval: undefined };
    } else {
      // route_to_human / block: keep the indicator visible.
      newMsgs[idx] = {
        ...newMsgs[idx],
        modelApproval: {
          status: 'done' as const,
          decision: ev.decision as 'route_to_human' | 'block',
          reasons: ev.reasons,
        },
      };
    }
    return newMsgs;
  });
}

// ---------------------------------------------------------------------------
// Question request handler
// ---------------------------------------------------------------------------

export function handleQuestionRequest(
  handler: StreamHandler,
  ev: QuestionRequestPayload,
) {
  handler.setPendingQuestion(ev);
}
