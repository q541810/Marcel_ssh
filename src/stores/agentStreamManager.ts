import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  LlmStreamEvent,
  ToolResultPayload,
  PlanStreamEvent,
  ModelApprovalStartPayload,
  ModelApprovalDonePayload,
  ContextUsageEvent,
  SubTaskStartPayload,
  SubTaskResultMetadata,
  AgentTask,
} from '@/lib/types';
import {
  handleToolResult,
  handleToolCallStart,
  handleTextDelta,
  handleThinkingDelta,
  handleDone,
  handleCancelled,
  handleAwaitingParent,
  handleError,
  handleRetrying,
  handleToolOutput,
  handleToolCallDelta,
  settleComposing,
  markRoundEnded,
  handleModelApprovalStart,
  handleModelApprovalDone,
  handleCompactionStart,
  handleCompactionProgress,
  handleCompactionDone,
  handleCompactionSkipped,
  handleMessageSaved,
  type MessageSavedEvent,
  type StreamHandler,
  cleanupStreamState,
} from './agentStreamHandlers';
import { createDefaultStreamHandler } from './storeStreamAdapter';
import { storedMessageToAgentMessage, clearIntermediateReasoning } from './messageConversion';
import { onTurnFinished } from './jobWake';
import { isAskParentTool } from '@/lib/toolCatalog';
import * as tauri from '@/lib/tauri';

// ---------------------------------------------------------------------------
// Listener maps
// ---------------------------------------------------------------------------

const streamListeners: Map<string, UnlistenFn> = new Map();
const planListeners: Map<string, UnlistenFn> = new Map();
const streamHandlers: Map<string, StreamHandler> = new Map();

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isToolResultPayload(ev: any): ev is ToolResultPayload {
  return 'toolCallId' in ev && 'toolName' in ev && 'success' in ev;
}

function hasEventType<T extends string>(ev: any, type: T): ev is { type: T } & Record<string, unknown> {
  return 'type' in ev && ev.type === type;
}

// ---------------------------------------------------------------------------
// Subagent (task tool) wiring
// ---------------------------------------------------------------------------

function subTaskTerminalStatus(status: SubTaskResultMetadata['status']): AgentTask['status'] {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
  }
}

/** 注册子agent上下文（对话条目 + 骨架消息 + 子agent task 记录）。 */
export function registerSubTaskContext(
  handler: StreamHandler,
  parentTaskId: string,
  subTaskId: string,
  subConversationId: string,
  description: string,
  prompt: string,
  status: AgentTask['status'],
  parentConversationId = '',
  explicitConnectionId?: string,
  subSessionId?: string,
  subMode?: AgentTask['mode'],
  answersAsk = false,
): string | null {
  if (handler.getTask(subTaskId)) return null;

  const parent = handler.getTask(parentTaskId);
  const parentConv = parent ? handler.getConversation(parent.conversationId) : undefined;
  // 重启恢复兜底路径（toolResult 触发）父任务不在内存，用 agentGetConversation
  // 返回的 connectionId 补齐，避免子对话条目 connectionId 落空。
  // 多机：live 路径显式传子 agent 真实运行机器的 connectionId（≠ 父推断值）。
  const connectionId = explicitConnectionId ?? parentConv?.connectionId ?? '';
  // 多机：子 agent 运行在目标机器 session（≠ 父 session）；缺省时继承父。
  const sessionId = subSessionId || parent?.sessionId || '';

  const loadingId = handler.registerSubConversation({
    conversationId: subConversationId,
    connectionId,
    title: `${description}（子agent）`,
    subTaskId,
    prompt,
    parentConversationId,
    answersAsk,
  });

  // 把子任务登记进 taskStore —— 子任务是流编排创建的（不走 `taskStore.startTask`
  // 那条主任务路径），所以经 handler 的 `registerSubTask` 写入，manager 不直接碰 store。
  handler.registerSubTask({
    id: subTaskId,
    sessionId,
    conversationId: subConversationId,
    prompt,
    mode: subMode ?? 'plan',
    status,
    parentTaskId,
  });

  return loadingId;
}

/**
 * 续派是在回答 ask_parent：子对话里那次还停着的调用立刻落成「已回答」（答案就是这次续派的
 * `prompt`），不必等子 agent 的 toolResult 回来 —— 气泡和底部的「正在等待」条当场收起。
 * 旧任务（停在 awaiting_parent 的那个）同时收掉，任务中心里不会留两条。
 * 之后到达的权威 toolResult（如果有）会按调用 id 覆盖这条，无冲突。
 */
function settleAnsweredAsk(handler: StreamHandler, ev: SubTaskStartPayload) {
  const askId = ev.answersAsk;
  if (!askId) return;
  handler.updateMessages(ev.subConversationId, (msgs) =>
    msgs.map((m) =>
      m.role === 'tool' && m.isExecuting && !!m.toolResult && isAskParentTool(m.toolResult.toolName) && m.toolResult.toolCallId === askId
        ? {
            ...m,
            isExecuting: false,
            isComposing: false,
            toolResult: { ...m.toolResult, result: ev.prompt, success: true, metadata: { kind: 'parentAnswer' } },
          }
        : m,
    ),
  );
  // 续派是一个新任务：旧的、停在提问上的任务到此为止
  handler.retireAwaitingParent(ev.subConversationId, ev.subTaskId);
}

/** subTaskStart 事件：注册子对话并挂载子agent实时流 listener。 */
export function handleSubTaskStart(handler: StreamHandler, parentTaskId: string, ev: SubTaskStartPayload) {
  const loadingId = registerSubTaskContext(
    handler,
    parentTaskId,
    ev.subTaskId,
    ev.subConversationId,
    ev.description,
    ev.prompt,
    'planning',
    ev.parentConversationId,
    ev.connectionId,
    ev.sessionId,
    ev.mode,
    !!ev.answersAsk,
  );
  if (ev.answersAsk) settleAnsweredAsk(handler, ev);
  if (loadingId) {
    // 子agent仍在运行：挂 listener 消费实时流事件。
    void attachStreamListener(ev.subTaskId, ev.subConversationId, loadingId);
  }
  // 把子对话 id 挂到主对话的 subagent 工具卡片上：运行中即可"查看"实时过程
  // （toolResult 完成后会被后端 metadata 覆盖，无冲突）。
  const parentTask = handler.getTask(parentTaskId);
  if (parentTask) {
    handler.updateMessages(parentTask.conversationId, (msgs) =>
      msgs.map((m) =>
        m.role === 'tool' && m.isExecuting && m.toolResult?.toolCallId === ev.toolCallId
          ? {
                ...m,
                toolResult: m.toolResult
                  ? {
                      ...m.toolResult,
                      metadata: {
                        subTaskId: ev.subTaskId,
                        subConversationId: ev.subConversationId,
                        status: 'running',
                      },
                    }
                  : m.toolResult,
              }
            : m,
        ),
    );
  }
}

/**
 * toolResult 兜底：子agent（subagent 工具）必然已终态（后端同步等待），
 * 若此前未注册（应用重启 / subTaskStart 事件丢失），从 DB 加载完整消息，
 * 并补齐对话元数据（parentConversationId / connectionId）保证"返回主对话"可用。
 * 已注册（live 路径）时也收敛任务终态：防 done 事件在 listener 挂载前
 * 丢失导致子任务永久停留在 planning + 骨架 loading 转圈。
 */
export async function handleSubTaskFallback(
  handler: StreamHandler,
  parentTaskId: string,
  meta: SubTaskResultMetadata,
  description: string,
  prompt: string,
) {
  const conv = await tauri
    .agentGetConversation(meta.subConversationId)
    .catch(() => null);
  registerSubTaskContext(
    handler,
    parentTaskId,
    meta.subTaskId,
    meta.subConversationId,
    description,
    prompt,
    subTaskTerminalStatus(meta.status),
    conv?.parentConversationId ?? '',
    conv?.connectionId ?? undefined,
  );
  // 无论是否新注册，都把任务状态收敛为 toolResult 携带的终态（幂等）。
  // 走 handler：`updateTaskStatus` 本来就是 StreamHandler 的成员（它转发到
  // taskStore），manager 没有理由绕过它直接读 store。
  const existing = handler.getTask(meta.subTaskId);
  if (existing && existing.status !== subTaskTerminalStatus(meta.status)) {
    handler.updateTaskStatus(meta.subTaskId, subTaskTerminalStatus(meta.status));
  }
  // 收敛到终态后这个子任务不会再有事件：终态 = 拆通道（与 stopTask 同一条
  // 契约）。子任务的终态事件丢在 listener 挂载之前（重启 / 注册竞态）时，
  // 不拆就会留下一条永远收不到事件、也没人再摘的监听器。
  // 骨架残留由下面的 DB 全量替换兜（此路径不依赖后续事件）。
  cleanupTaskListeners(meta.subTaskId);
  // 骨架残留防御：仅当骨架 loading 消息还在时从 DB 全量替换
  // （toolResult 到达 = 子任务已终态；实时流已消费骨架的正常路径不覆盖）。
  try {
    const stored = await tauri.agentLoadConversation(meta.subConversationId);
    const msgs = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
    handler.updateMessages(meta.subConversationId, (cur) => {
      if (!msgs.length || !cur.some((m) => m.isLoading)) return cur;
      return msgs;
    });
  } catch (err) {
    console.warn('[agent] failed to load sub-conversation messages', err);
  }
}

export function extractSubTaskMeta(ev: ToolResultPayload): SubTaskResultMetadata | null {
  const meta = ev.metadata as Partial<SubTaskResultMetadata> | undefined;
  if (
    meta?.subTaskId &&
    meta.subConversationId &&
    (meta.status === 'completed' || meta.status === 'failed' || meta.status === 'cancelled')
  ) {
    return { subTaskId: meta.subTaskId, subConversationId: meta.subConversationId, status: meta.status };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Clear all listeners and stream state for a task */
export function cleanupTaskListeners(taskId: string) {
  const streamFn = streamListeners.get(taskId);
  if (streamFn) {
    streamFn();
    streamListeners.delete(taskId);
  }
  const planFn = planListeners.get(taskId);
  if (planFn) {
    planFn();
    planListeners.delete(taskId);
  }
  streamHandlers.delete(taskId);
  // 收尾前的最后一笔 flush 在 cleanupStreamState 里（所有收尾路径都经过它）。
  cleanupStreamState(taskId);
}

export async function attachStreamListener(taskId: string, conversationId: string, loadingAssistantId: string) {
  if (streamListeners.has(taskId)) return;

  const handler = createDefaultStreamHandler();
  streamHandlers.set(taskId, handler);

  // 退订句柄必须**同步**可用：`listen()` 是异步的，注册往返还没完成时任务就
  // 可能被收尾（刚发出去就点停止 / 会话断连）。旧写法把 unlisten 押到 await
  // 之后才入表，那次清理便只能删 handler、摘不掉监听器 —— 之后才入表的
  // unlisten 再没人调用，监听器永久留在事件总线上，被取消的任务继续把事件
  // 写进 store（已停任务的文本与卡片回魂）。
  // `tauriEvent.ts` 的 `subscribeTauriEvent` 正是为这一类坑写的原语，这里用
  // 同构的 disposed 标志兜住；差别只在于本函数还必须**等注册往返结束**才返回：
  // 调用方（startTask）依赖「订阅已就绪」才去发会立刻产生事件的后端命令。
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  streamListeners.set(taskId, () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  });

  const fn = await listen<LlmStreamEvent | ToolResultPayload>(
    `agent://stream/${taskId}`,
    (event) => {
      const ev = event.payload;

      if (isToolResultPayload(ev)) {
        // 子agent（subagent 工具）结果：若此前从未注册（重启/事件丢失），
        // 兜底注册子对话并从 DB 加载终态消息。
        const subMeta = extractSubTaskMeta(ev);
        if (subMeta) {
          const description =
            typeof ev.arguments?.description === 'string' ? ev.arguments.description : '';
          const prompt = typeof ev.arguments?.prompt === 'string' ? ev.arguments.prompt : '';
          void handleSubTaskFallback(handler, taskId, subMeta, description, prompt);
        }
        handleToolResult(handler, taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'subTaskStart')) {
        settleComposing(handler, conversationId);
        handleSubTaskStart(handler, taskId, ev as unknown as SubTaskStartPayload);
        return;
      }

      if (hasEventType(ev, 'awaitingParent')) {
        // 子 agent 停在 ask_parent 上等主 agent 回答：这一轮到此为止（流已结束），但不是完成。
        handleAwaitingParent(handler, taskId, conversationId, loadingAssistantId);
        cleanupTaskListeners(taskId);
        onTurnFinished(conversationId, taskId);
        return;
      }

      if (hasEventType(ev, 'modelApprovalStart')) {
        settleComposing(handler, conversationId);
        handleModelApprovalStart(handler, taskId, conversationId, ev as unknown as ModelApprovalStartPayload);
        return;
      }

      if (hasEventType(ev, 'modelApprovalDone')) {
        handleModelApprovalDone(handler, taskId, conversationId, ev as unknown as ModelApprovalDonePayload);
        return;
      }

      if (hasEventType(ev, 'textDelta')) {
        // 输出 token 估算随 rAF 合帧一并记账（见 agentStreamHandlers 的
        // pendingOutputTokens），不再逐 delta 直写 taskStore。
        handleTextDelta(handler, taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'thinkingDelta')) {
        handleThinkingDelta(handler, taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'toolCallStart')) {
        handleToolCallStart(handler, taskId, conversationId, ev, loadingAssistantId);
        return;
      }

      if (hasEventType(ev, 'toolOutput')) {
        settleComposing(handler, conversationId);
        const outputEv = ev as unknown as { type: 'toolOutput'; toolCallId: string; chunk: string };
        handleToolOutput(handler, taskId, conversationId, outputEv.toolCallId, outputEv.chunk);
        return;
      }

      if (hasEventType(ev, 'toolCallDelta')) {
        const deltaEv = ev as unknown as { type: 'toolCallDelta'; id: string; argumentsDelta: string };
        handleToolCallDelta(handler, taskId, conversationId, deltaEv);
        return;
      }

      if (hasEventType(ev, 'done')) {
        settleComposing(handler, conversationId);
        handleDone(handler, taskId, conversationId, loadingAssistantId);
        cleanupTaskListeners(taskId);
        onTurnFinished(conversationId, taskId);
        return;
      }

      if (hasEventType(ev, 'cancelled')) {
        settleComposing(handler, conversationId);
        // 取消终止（后端取消路径）：**不能**走 handleDone——那会把在飞的工具
        // 卡片当成"没跑完的调用"删掉、把回合写成 completed 进而折叠。
        handleCancelled(handler, taskId, conversationId, loadingAssistantId);
        cleanupTaskListeners(taskId);
        onTurnFinished(conversationId, taskId);
        return;
      }

      if (hasEventType(ev, 'error')) {
        settleComposing(handler, conversationId);
        handleError(handler, taskId, conversationId, loadingAssistantId, ev);
        cleanupTaskListeners(taskId);
        onTurnFinished(conversationId, taskId);
        return;
      }

      if (hasEventType(ev, 'retrying')) {
        handleRetrying(handler, taskId, conversationId, ev);
        return;
      }

      if (hasEventType(ev, 'compactionStart')) {
        handleCompactionStart(handler, taskId, conversationId, ev as unknown as { type: 'compactionStart'; trigger: string });
        return;
      }

      if (hasEventType(ev, 'compactionProgress')) {
        handleCompactionProgress(handler, taskId, conversationId, ev as unknown as { type: 'compactionProgress'; text: string });
        return;
      }

      if (hasEventType(ev, 'compactionDone')) {
        handleCompactionDone(handler, taskId, conversationId, ev as unknown as {
          type: 'compactionDone';
          summary: string;
          shadowedMessages: number;
          shadowedTokens: number;
          tailDbId: string | null;
        });
        return;
      }

      if (hasEventType(ev, 'compactionSkipped')) {
        handleCompactionSkipped(handler, taskId, conversationId, ev as unknown as { type: 'compactionSkipped'; reason: string; attempted: boolean });
        return;
      }

      if (hasEventType(ev, 'messageSaved')) {
        handleMessageSaved(handler, taskId, conversationId, ev as unknown as MessageSavedEvent);
        return;
      }

      if (hasEventType(ev, 'usage')) {
        // provider 报的**单轮原始用量**：只透传给插件（`plugin://events`），
        // 不再进界面统计。界面的数字来自 `contextUsage`（后端写库后的会话累计）
        // —— 两条路各算一遍，迟早会漂。
        return;
      }

      if (hasEventType(ev, 'contextUsage')) {
        // 本轮模型输出已结束：还没写完标记的（无参数工具）此刻必须亮出卡片
        settleComposing(handler, conversationId);
        // 本轮撤销标记作废：下一轮若续写同一气泡，流中途重试不能截到上一轮
        markRoundEnded(taskId);
        // 按**订阅这条流时用的会话 id**落桶：子 agent 的流订阅时用的是它自己
        // 的子会话 id，所以父子天然分开；而后端给的读数里子会话已经并进父会话，
        // 这里再累加就会算两遍。
        handler.recordContextUsage(conversationId, ev as unknown as ContextUsageEvent);
        return;
      }

      console.warn('[agent] unknown event type', ev);
    },
  );

  if (disposed) {
    // 取消比注册先到：当场回收，不给已经不存在的调用方留监听器
    // （也不能把 unlisten 写回表里 —— 那条任务已被收尾）。
    fn();
    return;
  }
  unlisten = fn;
}

export async function attachPlanListener(taskId: string) {
  if (planListeners.has(taskId)) return;

  let handler = streamHandlers.get(taskId);
  if (!handler) {
    handler = createDefaultStreamHandler();
    streamHandlers.set(taskId, handler);
  }

  // 与 attachStreamListener 同构：同步登记取消句柄，注册落地时若已取消则当场回收。
  let unlisten: UnlistenFn | null = null;
  let disposed = false;
  planListeners.set(taskId, () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  });

  const fn = await listen<PlanStreamEvent>(
    `agent://plan/${taskId}`,
    (event) => {
      const ev = event.payload;

      switch (ev.type) {
        case 'plan-created': {
          handler.setPlan(taskId, {
            taskId,
            items: ev.items,
            currentIndex: 0,
          });
          break;
        }
        case 'plan-item-started':
        case 'plan-item-completed':
        case 'plan-item-failed':
        case 'plan-item-skipped':
        case 'plan-completed':
        case 'plan-edited': {
          // 全量推送：后端在每个 plan-* 事件里都带完整 items 和 currentIndex，
          // 前端直接 setPlan 覆盖，无需增量合并，避免状态不一致。
          handler.setPlan(taskId, {
            taskId,
            items: ev.items,
            currentIndex: ev.currentIndex,
          });
          break;
        }
      }
    },
  );

  if (disposed) {
    // 同上：注册比取消晚到，当场回收。
    fn();
    return;
  }
  unlisten = fn;
}
