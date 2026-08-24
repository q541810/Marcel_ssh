import type {
  AgentMessage,
  ToolResultPayload,
  ApprovalRequestPayload,
  AgentTaskPlan,
  ModelApprovalStartPayload,
  ModelApprovalDonePayload,
  QuestionRequestPayload,
} from '@/lib/types';
import { applyCompactionSplice } from './messageConversion';
import { extractPartialStringField } from '@/lib/partialJson';
import { useConversationStore } from './conversationStore';
import { useTaskStore } from './taskStore';

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

/**
 * 查找当前最新的 loading 骨架（等待模型首字的占位消息）。
 * 骨架在任务启动时创建，也会在每轮工具结果后重建，因此不依赖固定 id，
 * 统一按 `role==='assistant' && isLoading` 动态定位。
 */
function findLoadingSkeleton(msgs: AgentMessage[]): AgentMessage | undefined {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].isLoading) return msgs[i];
  }
  return undefined;
}

/** 构造一条等待模型首字的 loading 骨架消息。 */
function makeLoadingSkeleton(): AgentMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    content: '',
    timestamp: new Date().toISOString(),
    isLoading: true,
  };
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
    // 模型已决定调用工具（首决策已出）：移除等待首字的 loading 骨架，
    // 避免"转圈 + 工具卡"并存造成"还在思考却已在执行"的困惑。
    convMsgs = convMsgs
      .filter((m) => !(m.role === 'system' && m.isRetrying))
      .filter((m) => !(m.role === 'assistant' && m.isLoading));
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

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(accumulated);
  } catch {
    parsed = null;
  }

  // 长字符串参数（render_html 的 fragment）在整个流式期间 JSON 都不完整，
  // 完整 parse 要到最后一刻才成功——卡片会一直空白，用户会以为死掉。
  // 对这类工具走 partial 提取：把已生成的字段前缀实时喂给预览卡片。
  // 节流 ~120ms：delta 高速到达时避免每个 delta 都触发全量消息列表渲染
  //（最终完整参数由 parse 成功分支 / toolResult 兜底，不怕丢尾巴）。
  if (parsed === null) {
    const preview = PARTIAL_PREVIEW_TOOLS.get(
      getPendingToolName(handler, conversationId, pendingMsgId) ?? '',
    );
    if (!preview) return;

    const now = Date.now();
    const last = partialFlushAt.get(ev.id) ?? 0;
    // Keep the message list responsive under providers that emit many tiny
    // argument deltas. The first delta is immediate; later updates are
    // leading-edge throttled and the settled tool result supplies the tail.
    if (now - last < 150) return;
    const primary = extractPartialStringField(accumulated, preview.primary);
    if (primary === null) return;
    partialFlushAt.set(ev.id, now);
    const draft: Record<string, unknown> = {};
    for (const field of preview.companions) {
      const value = extractPartialStringField(accumulated, field);
      if (value !== null) draft[field] = value;
    }
    draft[preview.primary] = primary;
    draft.__streaming = true;
    parsed = draft;
  } else {
    partialFlushAt.delete(ev.id);
  }

  const finalArgs = parsed;
  handler.updateMessages(conversationId, (convMsgs) => {
    const idx = convMsgs.findIndex((m) => m.id === pendingMsgId);
    if (idx === -1) return convMsgs;
    const msg = convMsgs[idx];
    if (!msg.toolResult) return convMsgs;
    const newMsgs = [...convMsgs];
    newMsgs[idx] = {
      ...msg,
      toolResult: { ...msg.toolResult, arguments: finalArgs },
    };
    return newMsgs;
  });
}

/**
 * 支持流式部分参数预览的工具 → 要提取的字段。
 *
 * `primary` 是驱动预览的长字符串字段：提取不到就不发预览。
 * `companions` 是顺带提取的短字段（标题、模式等），缺失时直接省略。
 * 字段名跟着工具登记在这里，提取逻辑本身不认识任何具体工具。
 */
const PARTIAL_PREVIEW_TOOLS: Map<string, { primary: string; companions: string[] }> = new Map([
  ['render_html', { primary: 'fragment', companions: ['title', 'mode'] }],
]);

/** toolCallId → 上次 partial 提取刷新的时间戳（节流用）。 */
const partialFlushAt: Map<string, number> = new Map();

/** 从消息列表反查 pending 工具消息的 toolName。 */
function getPendingToolName(
  handler: StreamHandler,
  conversationId: string,
  messageId: string,
): string | undefined {
  const msgs = handler.getMessages(conversationId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].id === messageId) return msgs[i].toolResult?.toolName;
  }
  return undefined;
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
  /** 上下文压缩占位消息 id（compactionStart → done/未完成 原位更新） */
  compactionMessageId: string | null;
  /** 本次压缩的触发来源（pressure / context-overflow / manual）：
   *  Done 事件据此走手动队尾语义或自动 id 定位。 */
  compactionTrigger: string | null;
}

const taskStreamState: Map<string, TaskStreamState> = new Map();

export function getStreamState(taskId: string): TaskStreamState {
  return taskStreamState.get(taskId) ?? {
    assistantMessageId: null,
    messageIndex: -1,
    toolResultCount: 0,
    pendingToolCalls: new Map(),
    pendingToolArgs: new Map(),
    pendingTextDelta: '',
    pendingThinkingDelta: '',
    flushRafId: null,
    compactionMessageId: null,
    compactionTrigger: null,
  };
}

export function cleanupStreamState(taskId: string) {
  const state = taskStreamState.get(taskId);
  if (state?.flushRafId != null) {
    cancelAnimationFrame(state.flushRafId);
  }
  // 清掉本任务未落定 tool call 的 partial 节流时间戳，避免 Map 泄漏
  if (state) {
    for (const toolCallId of state.pendingToolCalls.keys()) {
      partialFlushAt.delete(toolCallId);
    }
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

    // 工具结果落定：本轮 LLM 调用已结束。删掉残留的 loading 骨架并插入
    // 一条新的（等待下一轮 LLM 首字），让"思考中"转圈在工具之后重新出现。
    // 同一轮并行 tool calls 时逐条重建，恒保持单骨架。
    const reinsertSkeleton = () => {
      const skeleton = findLoadingSkeleton(newMsgs);
      if (skeleton) newMsgs.splice(newMsgs.indexOf(skeleton), 1);
      newMsgs.push(makeLoadingSkeleton());
    };

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
        partialFlushAt.delete(tr.toolCallId);
        streamState.assistantMessageId = null;
        streamState.messageIndex = -1;
        streamState.toolResultCount = 0;
        setStreamState(taskId, streamState);
        reinsertSkeleton();
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

    reinsertSkeleton();

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
    const idx = targetId
      ? newMsgs.findIndex((m) => m.id === targetId)
      : -1;

    if (idx === -1) {
      // 骨架（等待首字的 loading 占位）在首个 delta 到达时被消费：按 isLoading
      // 动态查找并移除。骨架会随每轮工具结果重建，不能依赖一次性标志或固定 id，
      // 固定 loadingAssistantId 仅作为启动骨架的 id 兜底。
      let removeIdx = newMsgs.findIndex((m) => m.role === 'assistant' && m.isLoading);
      if (removeIdx === -1) {
        removeIdx = newMsgs.findIndex((m) => m.id === loadingAssistantId);
      }
      if (removeIdx !== -1) {
        newMsgs.splice(removeIdx, 1);
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

  // 若完成的不是用户当前正在看的对话，将该对话标记为未读完成（展示小绿点）
  const activeConvId = useConversationStore.getState().activeConversationId;
  if (activeConvId !== conversationId) {
    useTaskStore.getState().markConversationUnreadCompleted(conversationId);
  }

  handler.updateMessages(conversationId, (convMsgs) => {
    const newMsgs = convMsgs.filter((m) => {
      // Remove loading skeletons: task-start placeholder + per-round rebuilds
      // (工具后的骨架同样在此清理，防止终态后残留转圈)
      if (m.role === 'assistant' && m.isLoading) return false;
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
      .filter((m) => m.id !== loadingAssistantId && !(m.role === 'assistant' && m.isLoading))
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
// Context compaction handlers — visibility for LLM summarization
// ---------------------------------------------------------------------------

function upsertCompactionMessage(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  patch: {
    content: string;
    compaction: NonNullable<AgentMessage['compaction']>;
  },
) {
  const state = getStreamState(taskId);
  const existingId = state.compactionMessageId;
  handler.updateMessages(conversationId, (convMsgs) => {
    const existingIdx = existingId
      ? convMsgs.findIndex((m) => m.id === existingId)
      : -1;
    if (existingIdx !== -1) {
      // 原位更新：保持消息位置与组件实例（不删旧建新），
      // 避免完成瞬间卡片跳位、实时文本原地消失
      const newMsgs = [...convMsgs];
      newMsgs[existingIdx] = {
        ...newMsgs[existingIdx],
        content: patch.content,
        compaction: patch.compaction,
      };
      return newMsgs;
    }
    const id = crypto.randomUUID();
    state.compactionMessageId = id;
    setStreamState(taskId, state);
    return [
      ...convMsgs,
      {
        id,
        role: 'system',
        content: patch.content,
        timestamp: new Date().toISOString(),
        compaction: patch.compaction,
      },
    ];
  });
}

export function handleCompactionStart(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: { type: 'compactionStart'; trigger: string },
) {
  const state = getStreamState(taskId);
  state.compactionTrigger = ev.trigger;
  setStreamState(taskId, state);
  upsertCompactionMessage(handler, taskId, conversationId, {
    content: '上下文压缩中…正在总结早期历史以释放上下文空间，请稍候',
    compaction: { status: 'running', trigger: ev.trigger },
  });
}

export function handleCompactionProgress(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: { type: 'compactionProgress'; text: string },
) {
  const state = getStreamState(taskId);
  const id = state.compactionMessageId;
  if (!id) return; // 没有进行中的压缩卡片（正常情况 start 必先于 progress）
  handler.updateMessages(conversationId, (convMsgs) => {
    const idx = convMsgs.findIndex((m) => m.id === id);
    if (idx === -1) return convMsgs;
    const newMsgs = [...convMsgs];
    newMsgs[idx] = {
      ...newMsgs[idx],
      // content 同步为实时文本：让 AgentPanel 的 lastMessageSize 变化，
      // 外层列表跟随卡片增长滚动到底（与 assistant 流式同一机制）
      content: ev.text,
      compaction: {
        ...(newMsgs[idx].compaction ?? {}),
        status: 'running',
        // text 为累计全文，直接替换（后端重试时会从头重发，替换可自愈）
        summary: ev.text,
      },
    };
    return newMsgs;
  });
}

export function handleCompactionDone(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: {
    type: 'compactionDone';
    summary: string;
    shadowedMessages: number;
    shadowedTokens: number;
    tailDbId: string | null;
  },
) {
  const state = getStreamState(taskId);
  const runningCardId = state.compactionMessageId;
  // 手动（compactConversation）→ 队尾语义（不依赖 dbId）；自动 → id 定位。
  // 防御：trigger 缺失时按 tailDbId 是否为 null 推断（null 只可能来自手动）。
  const isManual = state.compactionTrigger === 'manual' || ev.tailDbId === null;
  // 完成后释放占位 id：本次完成卡独立存在，不占用"进行中"槽位。
  state.compactionMessageId = null;
  state.compactionTrigger = null;
  setStreamState(taskId, state);

  const header = `【上下文已压缩】已整理 ${ev.shadowedMessages} 条历史消息（约 ${ev.shadowedTokens} tokens）`;
  const card: AgentMessage = {
    id: crypto.randomUUID(),
    role: 'system',
    content: header,
    timestamp: new Date().toISOString(),
    compaction: {
      status: 'done',
      summary: ev.summary,
      shadowedMessages: ev.shadowedMessages,
      shadowedTokens: ev.shadowedTokens,
    },
  };

  handler.updateMessages(conversationId, (convMsgs) => {
    const result = applyCompactionSplice(
      convMsgs,
      { tailDbId: ev.tailDbId },
      card,
      runningCardId,
      { manual: isManual },
    );
    if (result.applied) {
      // 手动：卡片在对话末尾；自动：卡片在被压区间末条之后（原文可见）。
      // 持久化由后端结构化落库（手动按最后一行、自动按 id），前端不落库。
      return result.msgs;
    }
    // 自动 id 指针未命中（该消息在前端 store 无 dbId = 运行中消息的极端窗口）：
    // 降级——**不产生 done 卡**，运行中卡转普通提示（后端已按 id 落库，
    // 重启 load 后可见；原文保留、请求不屏蔽）。
    console.warn('[agent] compaction splice failed to locate tail dbId; originals preserved', {
      tailDbId: ev.tailDbId,
    });
    const notice = '上下文已压缩（本会话结束后显示压缩摘要）';
    if (runningCardId) {
      return convMsgs.map((m) =>
        m.id === runningCardId ? { ...m, content: notice, compaction: undefined } : m,
      );
    }
    return [
      ...convMsgs,
      {
        id: crypto.randomUUID(),
        role: 'system',
        content: notice,
        timestamp: new Date().toISOString(),
      },
    ];
  });
}

export function handleCompactionSkipped(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: { type: 'compactionSkipped'; reason: string; attempted: boolean },
) {
  const state = getStreamState(taskId);
  const id = state.compactionMessageId;
  if (!id) return; // 孤儿 skip（无进行中卡片）直接忽略
  state.compactionMessageId = null;
  setStreamState(taskId, state);
  handler.updateMessages(conversationId, (convMsgs) => {
    const idx = convMsgs.findIndex((m) => m.id === id);
    if (idx === -1) return convMsgs;
    const newMsgs = [...convMsgs];
    if (ev.attempted) {
      // 摘要已跑但失败：低调交代——占位卡转普通 system 文本（不再有卡片边框），
      // 避免"压缩跑完了却什么都没留下"的困惑
      newMsgs[idx] = {
        ...newMsgs[idx],
        content: `上下文压缩未完成：${ev.reason}`,
        compaction: undefined,
      };
    } else {
      // 未开始就跳过（无区间/结构异常）：不留痕迹
      newMsgs.splice(idx, 1);
    }
    return newMsgs;
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
