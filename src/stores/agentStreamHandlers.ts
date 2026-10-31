import type {
  AgentMessage,
  ToolResultPayload,
  AgentTaskPlan,
  ContextUsageEvent,
  ModelApprovalStartPayload,
  ModelApprovalDonePayload,
} from '@/lib/types';
import { applyCompactionSplice } from './messageConversion';
import { extractPartialStringField, createJsonStreamTracker, feedJsonChunk, isJsonComplete, type JsonStreamTracker } from '@/lib/partialJson';
import { toolPartialPreview } from '@/lib/toolCatalog';
import { estimateTextTokens } from '@/lib/tokenUsage';
import { useConversationStore } from './conversationStore';
import { useTaskStore } from './taskStore';

// ---------------------------------------------------------------------------
// StreamHandler interface
// ---------------------------------------------------------------------------

export interface StreamHandler {
  updateMessages(conversationId: string, updater: (msgs: AgentMessage[]) => AgentMessage[]): void;
  updateTaskStatus(taskId: string, status: string): void;
  getTaskStatus(taskId: string): string | undefined;
  getMessages(conversationId: string): AgentMessage[];
  clearActiveTaskIf(taskId: string): void;
  setPlan(taskId: string, plan: AgentTaskPlan): void;
  /** 查一条 task 的关键字段（子 agent 需要父任务的 session/conversation 才能继承）。
   *  返回 undefined 表示内存里没有这条任务（常见于重启后只读到部分历史）。 */
  getTask(taskId: string): { conversationId: string; sessionId: string; status: string } | undefined;
  /** 查一条 conversation 的归属信息（子对话注册时需要 connectionId）。 */
  getConversation(conversationId: string): { connectionId?: string; id: string } | undefined;
  /** 登记一条子任务。子任务是流编排创建的（不是 `taskStore.startTask` 那条主任务路径），
   *  所以由这里单独暴露一个写入口，而不是让 manager 直接 setState。 */
  registerSubTask(task: {
    id: string;
    sessionId: string;
    conversationId: string;
    prompt: string;
    mode: string;
    status: string;
    parentTaskId: string;
  }): void;
  /** 注册一个子对话条目（流开始时显示骨架）。参数顺序对齐 `conversationStore.registerSubConversation`。 */
  registerSubConversation(args: {
    conversationId: string;
    connectionId: string;
    title: string;
    subTaskId: string;
    prompt: string;
    parentConversationId: string;
  }): string | null;
  /**
   * 记一轮的用量读数（`contextUsage` 事件）：按**事件所属会话**分桶，
   * 覆盖不累加（事件带的是后端写库后的累计值，见 `lib/tokenUsage.ts`）。
   */
  recordContextUsage(conversationId: string, ev: ContextUsageEvent): void;
  /** 流式增量文本（正文 / 思考 / 工具参数）：累加「运行中任务的输出 token」估算。 */
  recordOutputDelta(conversationId: string, text: string): void;
  /**
   * 同上，但给的是**已按片估算好的数字**：rAF 合帧路径一帧只做一次 store
   * 写入（逐 delta 直写会绕过合帧、每个 delta 一次 zustand set）。
   */
  recordOutputTokens(conversationId: string, tokens: number): void;
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
  loadingAssistantId = '',
) {
  const messageId = crypto.randomUUID();
  const toolMessage: AgentMessage = {
    id: messageId,
    role: 'tool',
    content: '',
    timestamp: new Date().toISOString(),
    isExecuting: true,
    // 有流式预览的工具（render_html）本来就靠卡片实时展示撰写过程，不走气泡
    isComposing: !toolPartialPreview(ev.name),
    toolResult: {
      toolName: ev.name,
      summary: '',
      result: '',
      success: true,
      blocked: false,
      toolCallId: ev.id,
    },
  };

  // Tool call starts: flush any not-yet-rendered TEXT delta into the message
  // list BEFORE discarding the ephemeral thinking buffer.
  //
  // Reasoning text before a tool call is ephemeral — the agent_loop does not
  // persist it, and handleToolCallStart clears reasoningContent from the last
  // assistant message below, so the thinking buffer can be dropped safely.
  //
  // The content (text) delta is REAL assistant output and must NOT be dropped:
  // providers emit the final content chunk and the first tool-call chunk inside
  // the SAME SSE chunk (openai.rs process_chunk sends TextDelta then
  // ToolCallStart back-to-back), so ToolCallStart can arrive before the
  // scheduled rAF flush runs.  Clearing pendingTextDelta here permanently
  // discarded the sentence tail — the UI showed messages cut off mid-sentence
  // right before the tool call card while the DB (and reload) kept the full
  // text.  Flush text first (synchronous, also cancels the rAF handle), then
  // only the thinking buffer is dropped.
  const state = getStreamState(taskId);
  state.pendingThinkingDelta = '';
  if (state.pendingTextDelta || state.flushRafId != null) {
    flushPendingDeltas(handler, taskId, conversationId, loadingAssistantId);
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

    // 记下发出这次调用的那条 assistant 消息（同一轮 LLM 调用写下的正文）：
    // 「跳转到提问前的结论」据此做结构定位，不靠往前找文本。本轮没写正文 = 没有。
    const callerId = getStreamState(taskId).assistantMessageId;
    if (callerId && newMsgs.some((m) => m.id === callerId && m.role === 'assistant')) {
      toolMessage.callerMessageId = callerId;
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

  streamState.pendingOutputTokens += estimateTextTokens(ev.argumentsDelta);
  const prev = streamState.pendingToolArgs.get(ev.id) ?? '';
  const accumulated = prev + ev.argumentsDelta;
  streamState.pendingToolArgs.set(ev.id, accumulated);
  setStreamState(taskId, streamState);

  // 增量完整性追踪：只扫新增字符，语法完整才值得 JSON.parse 一次。
  // 旧实现在这里对每个 delta 全量 parse（Θ(B²)，长参数流式期间全是
  // 注定失败的 SyntaxError）；150ms 节流只护预览、护不了 parse。
  let tracker = argTrackers.get(ev.id);
  if (!tracker) {
    tracker = { state: createJsonStreamTracker(), decided: null };
    argTrackers.set(ev.id, tracker);
  }
  feedJsonChunk(tracker.state, ev.argumentsDelta);

  let parsed: Record<string, unknown> | null = null;
  if (tracker.decided === null && isJsonComplete(tracker.state)) {
    try {
      parsed = JSON.parse(accumulated);
    } catch {
      parsed = null;
    }
    // 「完整但 parse 失败」（坏转义等）同样定局：不再反复 parse，预览
    // 照常走，最终参数由 toolResult 权威收尾。
    tracker.decided = parsed === null ? 'failed' : 'parsed';
    // 参数写完（不论能否 parse）：「正在撰写」气泡到此为止，卡片登场。
    // parsed 的话下面回填参数那一笔会顺带落旗；failed 没有回填，单独落。
    if (parsed === null) settleComposing(handler, conversationId, pendingMsgId);
  }
  if (tracker.decided === 'parsed') {
    // 完整参数已在到达那一刻发布（末片即时，不受下面 150ms 门影响）。
    // 之后同 id 再来的尾巴（空白/重传）不回填、不退回预览草稿。
    if (parsed === null) {
      partialFlushAt.delete(ev.id);
      return;
    }
    partialFlushAt.delete(ev.id);
  } else if (tracker.decided === 'failed') {
    parsed = null;
  }

  // 长字符串参数（render_html 的 fragment）在整个流式期间 JSON 都不完整，
  // 完整 parse 要到最后一刻才成功——卡片会一直空白，用户会以为死掉。
  // 对这类工具走 partial 提取：把已生成的字段前缀实时喂给预览卡片。
  // 节流 ~120ms：delta 高速到达时避免每个 delta 都触发全量消息列表渲染
  //（最终完整参数由 parse 成功分支 / toolResult 兜底，不怕丢尾巴）。
  if (parsed === null) {
    const preview = toolPartialPreview(
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
      // 完整参数到达 = 撰写结束；partial 预览（__streaming）阶段仍在撰写
      ...(tracker.decided === 'parsed' ? { isComposing: false } : {}),
      toolResult: { ...msg.toolResult, arguments: finalArgs },
    };
    return newMsgs;
  });
}

/**
 * 撰写态收尾：`messageId` 给定只收这一条，省略则收该会话所有还在撰写的工具卡。
 * 没有变化时原样返回消息数组，不引发多余渲染。
 *
 * 为什么需要「收全部」的兜底：无参数工具可能一个 delta 都没有，卡片永远等不到
 * 「参数写完」；这类调用靠本轮结束信号（contextUsage / 首条工具输出 / 审批 /
 * 子 agent 启动 / 终态）收尾，保证工具一旦开始执行就一定看得到卡片。
 */
export function settleComposing(handler: StreamHandler, conversationId: string, messageId?: string) {
  handler.updateMessages(conversationId, (convMsgs) => {
    if (!convMsgs.some((m) => m.isComposing && (!messageId || m.id === messageId))) return convMsgs;
    return convMsgs.map((m) =>
      m.isComposing && (!messageId || m.id === messageId) ? { ...m, isComposing: false } : m,
    );
  });
}

/** toolCallId → 上次 partial 提取刷新的时间戳（节流用）。 */
const partialFlushAt: Map<string, number> = new Map();

/** toolCallId → 增量完整性追踪状态与 parse 定局（parsed/failed）。 */
const argTrackers: Map<string, { state: JsonStreamTracker; decided: 'parsed' | 'failed' | null }> =
  new Map();

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
  if (!chunk) return;
  const state = getStreamState(taskId);
  const messageId = state.pendingToolCalls.get(toolCallId);
  if (!messageId) return;
  state.pendingToolOutput.set(messageId, (state.pendingToolOutput.get(messageId) ?? '') + chunk);
  scheduleFlush(handler, taskId, conversationId, '');
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
  pendingToolOutput: Map<string, string>;
  // 攒在帧里的输出 token 估算（三个 delta 通道各自按片估算后累加，flush 时
  // 一次 recordOutputTokens 提交——替代旧的逐 delta 直写 taskStore）。
  pendingOutputTokens: number;
  flushRafId: number | null;
  /** 上下文压缩占位消息 id（compactionStart → done/未完成 原位更新） */
  compactionMessageId: string | null;
  /** 本次压缩的触发来源（pressure / context-overflow / manual）：
   *  Done 事件据此走手动队尾语义或自动 id 定位。 */
  compactionTrigger: string | null;
  /** 摘要实时文本的合帧缓冲（累计全文，只留最新一份）。压缩恰恰发生在会话
   *  最大的时候，逐事件提交 = 每个 token 拷贝一遍整份对话并重渲染。 */
  pendingCompactionText: string | null;
  compactionRafId: number | null;
  /**
   * 本轮流式输出的起点标记（流中途断线重试要据此撤掉半截内容）。
   * 在本轮第一次提交正文/思考时懒记录；工具结果落定（轮结束）时清空，
   * 即使没清也会在下一轮建新气泡时被覆盖，不会指向旧轮。
   */
  roundMark: RoundMark | null;
}

type RoundMark =
  | { id: string; created: true }
  | { id: string; created: false; contentLen: number; reasoningLen: number };

const taskStreamState: Map<string, TaskStreamState> = new Map();

/**
 * 该任务挂起 delta 的写入口（由 `scheduleFlush` 记录），收尾时用它补最后一笔。
 *
 * 记的是**攒下这批 delta 的那条通道本身**（handler + 对话 + 启动骨架 id），
 * 不是收尾时按 taskId 反查：`cleanupStreamState` 是唯一保证会跑的收尾点，
 * 它拿不到 handler，也不能假设任务还在 taskStore 里（手动压缩用的就是临时 id）。
 */
const taskStreamWriters: Map<
  string,
  { handler: StreamHandler; conversationId: string; loadingAssistantId: string }
> = new Map();

export function getStreamState(taskId: string): TaskStreamState {
  return taskStreamState.get(taskId) ?? {
    assistantMessageId: null,
    messageIndex: -1,
    toolResultCount: 0,
    pendingToolCalls: new Map(),
    pendingToolArgs: new Map(),
    pendingTextDelta: '',
    pendingThinkingDelta: '',
    pendingToolOutput: new Map(),
    pendingOutputTokens: 0,
    flushRafId: null,
    compactionMessageId: null,
    compactionTrigger: null,
    pendingCompactionText: null,
    compactionRafId: null,
    roundMark: null,
  };
}

export function cleanupStreamState(taskId: string) {
  const state = taskStreamState.get(taskId);
  // 压缩进度缓冲不补最后一笔：收尾 = Done/Skipped/取消，卡片内容由那些事件定稿。
  if (state?.compactionRafId != null) {
    cancelAnimationFrame(state.compactionRafId);
  }
  // 收尾前的最后一笔：把还没进 store 的 delta 同步提交。
  // 收尾之后不会再有事件来触发 rAF flush，下面直接丢掉缓冲 —— 不补这一笔，
  // 用户会看到刚停下的那个回合在最后一句中途截断（DB 与重新加载都是完整的，
  // 缺的只有界面这句尾巴）。
  // 放在这里而不是各条收尾路径里：**所有**收尾路径都经过本函数（手动停止 /
  // 会话断连 / 终态事件 / 启动失败 / 手动压缩），补在别处漏一条就漏一处截断。
  if (state) flushLeftoverDeltas(taskId, state);
  if (state?.flushRafId != null) {
    cancelAnimationFrame(state.flushRafId);
  }
  // 清掉本任务未落定 tool call 的 partial 节流时间戳与 parse 追踪，避免 Map 泄漏
  if (state) {
    for (const toolCallId of state.pendingToolCalls.keys()) {
      partialFlushAt.delete(toolCallId);
      argTrackers.delete(toolCallId);
    }
  }
  taskStreamState.delete(taskId);
  taskStreamWriters.delete(taskId);
}

/**
 * 一轮模型输出结束（后端每轮流结束后发 `contextUsage`）：先把缓冲里的 delta 提交，
 * 再清掉本轮的撤销标记。不清的话，没有工具的一轮（工具结果才清标记）之后若同一气泡
 * 又被下一轮续写（如作业通知唤醒的新一轮），下一轮流中途断线重试会按上一轮留下的
 * 标记把上一轮的正文也截掉。必须先提交缓冲：尾巴晚于清标记落下的话，会按「尾巴之前」
 * 的长度重新记标记，同样把尾巴划进下一轮。
 */
export function markRoundEnded(taskId: string) {
  const state = taskStreamState.get(taskId);
  if (!state) return;
  flushLeftoverDeltas(taskId, state);
  state.roundMark = null;
}

/** 收尾补笔：把缓冲里剩下的 delta 写到它们本就该去的那个对话。 */
function flushLeftoverDeltas(taskId: string, state: TaskStreamState) {
  if (!state.pendingTextDelta && !state.pendingThinkingDelta && state.pendingToolOutput.size === 0) return;
  const writer = taskStreamWriters.get(taskId);
  // 没攒过 delta 就没有写入口 —— 也没东西可写。
  if (!writer) return;
  flushPendingDeltas(writer.handler, taskId, writer.conversationId, writer.loadingAssistantId);
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
  // Commit streamed output before the authoritative result replaces it.
  flushPendingDeltas(handler, taskId, conversationId, loadingAssistantId);
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
          isComposing: false,
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
        argTrackers.delete(tr.toolCallId);
        streamState.assistantMessageId = null;
        streamState.messageIndex = -1;
        streamState.toolResultCount = 0;
        streamState.roundMark = null;
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
    streamState.roundMark = null;

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
 * 由 scheduleFlush（rAF 触发）/ handleDone（强制同步）/ **收尾路径**
 * （`cleanupStreamState`，见那里的注释）调用。
 * 同步执行：调用后 buffer 清空，rAF 句柄释放。
 */
function flushPendingDeltas(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
) {
  const state = getStreamState(taskId);
  const { pendingTextDelta, pendingThinkingDelta, pendingToolOutput } = state;
  const pendingOutputTokens = state.pendingOutputTokens;

  // 清空 buffer 和 raf 句柄 —— 必须在 updateMessages 之前完成，
  // 否则 updater 闭包里对 state 的写入会丢失。
  state.pendingTextDelta = '';
  state.pendingThinkingDelta = '';
  state.pendingToolOutput = new Map();
  state.pendingOutputTokens = 0;
  if (state.flushRafId != null) {
    cancelAnimationFrame(state.flushRafId);
    state.flushRafId = null;
  }

  if (!pendingTextDelta && !pendingThinkingDelta && pendingToolOutput.size === 0) return;

  // 输出 token 估算随帧一并提交（live 只增不减、最终被 contextUsage 事件
  // 覆盖的语义不变——只是从逐 delta 直写并入合帧路径）。
  if (pendingOutputTokens > 0) {
    handler.recordOutputTokens(conversationId, pendingOutputTokens);
  }

  handler.updateMessages(conversationId, (convMsgs) => {
    const hasText = !!(pendingTextDelta || pendingThinkingDelta);
    const newMsgs = hasText
      ? convMsgs.filter((m) => !(m.role === 'system' && m.isRetrying))
      : [...convMsgs];
    if (pendingToolOutput.size > 0) {
      for (let i = 0; i < newMsgs.length; i++) {
        const message = newMsgs[i];
        const chunk = pendingToolOutput.get(message.id);
        if (chunk && message.toolResult) {
          newMsgs[i] = {
            ...message,
            toolResult: { ...message.toolResult, result: (message.toolResult.result || '') + chunk },
          };
        }
      }
    }
    if (!hasText) return newMsgs;
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
      state.roundMark = { id: newMsg.id, created: true };
    } else {
      const msg = newMsgs[idx];
      if (!state.roundMark || state.roundMark.id !== msg.id) {
        state.roundMark = {
          id: msg.id,
          created: false,
          contentLen: msg.content.length,
          reasoningLen: msg.reasoningContent?.length ?? 0,
        };
      }
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
  // 先记下写入口：收尾路径（cleanupStreamState）要在 rAF 被取消、handler 已
  // 从 manager 的表里摘掉之后，靠它把残留 delta 补齐。
  taskStreamWriters.set(taskId, { handler, conversationId, loadingAssistantId });
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
  state.pendingOutputTokens += estimateTextTokens(streamEv.text);
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
  state.pendingOutputTokens += estimateTextTokens(streamEv.text);
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

  // 回合收尾状态：Done = 模型自然结束（后端的收尾写入也会落成 completed），
  // 该回合按正常路径折叠。**写在这里是为了覆盖「任务跑着的时候重载过会话」**
  // 的情形 —— 那种情况下锚点上带着从库里读到的 running，不覆盖就会永远不折叠。
  useConversationStore.getState().markTailTurnState(conversationId, 'completed');

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
}

/**
 * 取消终止：agent loop 因**取消**退出（手动停止 / 拒绝并停止 / 会话级联取消），
 * 不是模型自然结束。
 *
 * 与 `handleDone` 的差别只在三处「自然结束」的假设上：
 * 1. 在飞的工具卡片**保留**并标成已中断（`handleDone` 按「没跑完的调用」删掉它；
 *    取消时那张卡片是用户正盯着看的，后端也已为它落了「已中断」的 tool 行）；
 * 2. 回合收尾状态写 `cancelled`（不是 `completed`）—— 回合折叠据此否决折叠，
 *    否则停止的回合会被收成一行控制条、过程卡片从界面上消失，而模型侧其实
 *    仍看得到（这正是「卡片没了但 agent 能看到」）；
 * 3. 任务记 `cancelled`、不点未读完成绿点。
 *
 * 骨架 / 空 assistant / retrying 指示的清理与 `handleDone` 相同（纯展示残留）。
 * delta 同样先 flush：取消之后不会再有新事件，残留 buffer 会卡住不渲染。
 */
export function handleCancelled(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  loadingAssistantId: string,
) {
  flushPendingDeltas(handler, taskId, conversationId, loadingAssistantId);

  handler.updateTaskStatus(taskId, 'cancelled');
  // 在飞工具卡片 → 已中断（与停止按钮 markAbortedToolFlags 同一份文案）
  useConversationStore.getState().markAbortedToolFlags(conversationId);
  useConversationStore.getState().markTailTurnState(conversationId, 'cancelled');

  handler.updateMessages(conversationId, (convMsgs) => {
    const newMsgs = convMsgs.filter((m) => {
      // 等待首字/等待下一轮的骨架：取消后不会再有内容填进来
      if (m.role === 'assistant' && m.isLoading) return false;
      // 空 assistant（骨架被清掉标志后的残留）
      if (m.role === 'assistant' && m.content === '' && !m.toolCall && !m.toolCalls?.length && !m.reasoningContent) return false;
      // 注意：**不**删 `m.role === 'tool' && m.isExecuting` 的卡片（见函数头 1.）
      if (m.role === 'system' && m.isRetrying) return false;
      return true;
    });
    return newMsgs.map((m) => {
      if (m.role === 'assistant' && (m.isThinking || m.isLoading)) {
        return { ...m, isThinking: false, isLoading: false };
      }
      return m;
    });
  });

  // 不在此处清空 activeTaskId（同 handleDone 的理由）。
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
  flushPendingDeltas(handler, taskId, conversationId, loadingAssistantId);

  handler.updateTaskStatus(taskId, 'failed');

  // 回合收尾状态：这一轮是**出错停的**，不是模型自然结束 —— 过程不收起来。
  // 顺带解决一个老问题：如果折叠判定只看消息形态，末条「长得像答案」的
  // assistant（错误前流出的那半截文本）会让整个回合折叠，而折叠态下
  // 答案之后的消息（就是下面这条错误提示）根本不渲染 —— 错误会凭空消失。
  useConversationStore.getState().markTailTurnState(conversationId, 'failed');

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
}

export function handleRetrying(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: {
    type: 'retrying';
    attempt: number;
    maxAttempts: number;
    delaySecs: number;
    lastError: string;
    discardPartial?: boolean;
  },
) {
  const discard = ev.discardPartial === true;
  if (discard) discardRoundPartial(taskId);
  handler.updateMessages(conversationId, (convMsgs) => {
    let newMsgs = convMsgs
      .filter((m) => !(m.role === 'system' && m.isRetrying));
    if (discard) newMsgs = dropRoundPartial(taskId, newMsgs);
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

/**
 * 流中途断线重试：先丢掉还没提交的缓冲（不提交——那是被丢弃那次尝试的内容）。
 * 消息列表上的撤销在 `dropRoundPartial`，由 updater 一并完成。
 */
function discardRoundPartial(taskId: string) {
  const state = getStreamState(taskId);
  state.pendingTextDelta = '';
  state.pendingThinkingDelta = '';
  state.pendingOutputTokens = 0;
  if (state.flushRafId != null) {
    cancelAnimationFrame(state.flushRafId);
    state.flushRafId = null;
  }
}

/**
 * 撤掉本轮已上屏的半截内容：新建的助手气泡整条删，追加的截回起点；
 * 本轮已开出的工具卡（流式期间一个都没执行过）删掉并清追踪表；
 * 最后保证有一条 loading 骨架，让界面回到「等待模型」。
 */
function dropRoundPartial(taskId: string, msgs: AgentMessage[]): AgentMessage[] {
  const state = getStreamState(taskId);
  let out = msgs;
  const mark = state.roundMark;
  if (mark) {
    if (mark.created) {
      out = out.filter((m) => m.id !== mark.id);
      state.assistantMessageId = null;
      state.messageIndex = -1;
    } else {
      out = out.map((m) =>
        m.id === mark.id
          ? {
              ...m,
              content: m.content.slice(0, mark.contentLen),
              reasoningContent: m.reasoningContent
                ? m.reasoningContent.slice(0, mark.reasoningLen) || undefined
                : m.reasoningContent,
              isThinking: false,
            }
          : m,
      );
    }
    state.roundMark = null;
  }
  if (state.pendingToolCalls.size > 0) {
    const ids = new Set(state.pendingToolCalls.values());
    out = out.filter((m) => !ids.has(m.id));
    for (const toolCallId of state.pendingToolCalls.keys()) {
      state.pendingToolArgs.delete(toolCallId);
      partialFlushAt.delete(toolCallId);
      argTrackers.delete(toolCallId);
    }
    state.pendingToolCalls.clear();
  }
  if (!findLoadingSkeleton(out)) out = [...out, makeLoadingSkeleton()];
  setStreamState(taskId, state);
  return out;
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
  if (!state.compactionMessageId) return; // 没有进行中的压缩卡片（正常情况 start 必先于 progress）
  // 合帧：text 是累计全文，帧内后到的覆盖先到的，一帧只提交一次（普通回复的
  // delta 同理，见 scheduleFlush）。不合帧时每个 token 都会拷贝整份对话数组
  // 并触发重渲染，大会话里压缩期间主线程被打满、事件在 IPC 队列里越堆越多。
  state.pendingCompactionText = ev.text;
  setStreamState(taskId, state);
  if (state.compactionRafId != null) return;
  state.compactionRafId = requestAnimationFrame(() => {
    flushCompactionProgress(handler, taskId, conversationId);
  });
}

function flushCompactionProgress(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
) {
  const state = getStreamState(taskId);
  const text = state.pendingCompactionText;
  const id = state.compactionMessageId;
  state.pendingCompactionText = null;
  state.compactionRafId = null;
  if (text === null || !id) return;
  handler.updateMessages(conversationId, (convMsgs) => {
    const idx = convMsgs.findIndex((m) => m.id === id);
    if (idx === -1) return convMsgs;
    const newMsgs = [...convMsgs];
    newMsgs[idx] = {
      ...newMsgs[idx],
      // content 同步为实时文本：让 AgentPanel 的 lastMessageSize 变化，
      // 外层列表跟随卡片增长滚动到底（与 assistant 流式同一机制）
      content: text,
      compaction: {
        ...(newMsgs[idx].compaction ?? {}),
        status: 'running',
        // text 为累计全文，直接替换（后端重试时会从头重发，替换可自愈）
        summary: text,
      },
    };
    return newMsgs;
  });
}

/** Done / Skipped 定稿卡片前丢掉还没提交的进度：否则迟到的一帧会把定稿卡片写回「进行中」。 */
function dropPendingCompactionProgress(state: TaskStreamState) {
  state.pendingCompactionText = null;
  if (state.compactionRafId != null) {
    cancelAnimationFrame(state.compactionRafId);
    state.compactionRafId = null;
  }
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
  dropPendingCompactionProgress(state);
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
  dropPendingCompactionProgress(state);
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
// MessageSaved：live 消息对上库内身份
// ---------------------------------------------------------------------------

/** 后端 `messageSaved` 事件的载荷（见 Rust `StreamEvent::MessageSaved`）。 */
export interface MessageSavedEvent {
  type: 'messageSaved';
  conversationId: string;
  role: string;
  dbId: string;
  toolCallId?: string;
}

/**
 * 一条消息已落库：把 DB row id 回填到 live 消息的 `dbId` 上。
 *
 * live 消息的 id 是前端临时 UUID、与库内 id 不同域；不回填的话，「拿 live
 * 消息定位」的功能（分叉锚点、压缩插卡）在会话重载前永远解析不到。
 *
 * 定位规则（按 role）：
 * - `user` / `notice`：回合首条消息，事件在任务启动那一刻发出——找 store 里
 *   **最后一条**同角色且还没 `dbId` 的消息（哑火补问 / 计划提醒这类后端内部
 *   注入不广播，不会误命中）；
 * - `assistant`：回填本轮正在写的文本消息（`assistantMessageId`）。纯工具轮
 *   （无正文）前端没有对应文本消息，`assistantMessageId` 还指着上一轮——那条
 *   已有自己的 `dbId`，按「已回填不动」跳过；
 * - `tool`：按 `toolCallId` 定位工具卡片（toolCallId 与后端同一 id 域）。
 *
 * 任何情况都**只填空位、不覆盖**已有 `dbId`：事件晚到 / 乱序时宁可漏填
 * （分叉还有时间戳兜底），不能把 A 消息改成指向 B 行。
 */
export function handleMessageSaved(
  handler: StreamHandler,
  taskId: string,
  conversationId: string,
  ev: MessageSavedEvent,
) {
  // 子 agent 的流不该写进父会话的 live store（订阅这条流用的会话 id 是父的）
  if (ev.conversationId !== conversationId) return;

  handler.updateMessages(conversationId, (convMsgs) => {
    const idx = (() => {
      if (ev.role === 'user' || ev.role === 'notice') {
        for (let i = convMsgs.length - 1; i >= 0; i -= 1) {
          if (convMsgs[i].role === ev.role && !convMsgs[i].dbId) return i;
        }
        return -1;
      }
      if (ev.role === 'assistant') {
        const targetId = getStreamState(taskId).assistantMessageId;
        if (!targetId) return -1;
        return convMsgs.findIndex((m) => m.id === targetId);
      }
      if (ev.role === 'tool') {
        if (!ev.toolCallId) return -1;
        return convMsgs.findIndex(
          (m) => m.toolResult?.toolCallId === ev.toolCallId,
        );
      }
      return -1;
    })();
    if (idx === -1) return convMsgs;
    if (convMsgs[idx].dbId) return convMsgs;
    const newMsgs = [...convMsgs];
    newMsgs[idx] = { ...newMsgs[idx], dbId: ev.dbId };
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
          // 判定元信息只用于展示（「Jev 判定」标注 + 分布集中度）。
          // 它不参与任何判定分支——低置信度不会改变这里的 decision。
          engine: ev.engine,
          confidence: ev.confidence,
        },
      };
    }
    return newMsgs;
  });
}

