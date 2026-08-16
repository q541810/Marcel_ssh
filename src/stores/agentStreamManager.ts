import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  LlmStreamEvent,
  ToolResultPayload,
  ApprovalRequestPayload,
  PlanStreamEvent,
  ModelApprovalStartPayload,
  ModelApprovalDonePayload,
  QuestionRequestPayload,
  TokenUsage,
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
  handleError,
  handleRetrying,
  handleToolOutput,
  handleToolCallDelta,
  handleModelApprovalStart,
  handleModelApprovalDone,
  handleQuestionRequest,
  handleCompactionStart,
  handleCompactionProgress,
  handleCompactionDone,
  handleCompactionSkipped,
  type StreamHandler,
  cleanupStreamState,
} from './agentStreamHandlers';
import { createDefaultStreamHandler } from './storeStreamAdapter';
import { useTaskStore } from './taskStore';
import { useConversationStore } from './conversationStore';
import { storedMessageToAgentMessage, clearIntermediateReasoning } from './messageConversion';
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
  parentTaskId: string,
  subTaskId: string,
  subConversationId: string,
  description: string,
  prompt: string,
  status: AgentTask['status'],
  parentConversationId = '',
  explicitConnectionId?: string,
): string | null {
  const taskStore = useTaskStore.getState();
  if (taskStore.tasks[subTaskId]) return null;

  const parent = taskStore.tasks[parentTaskId];
  const parentConv = parent
    ? useConversationStore.getState().conversations[parent.conversationId]
    : undefined;
  // 重启恢复兜底路径（toolResult 触发）父任务不在内存，用 agentGetConversation
  // 返回的 connectionId 补齐，避免子对话条目 connectionId 落空。
  const connectionId = explicitConnectionId ?? parentConv?.connectionId ?? '';

  const loadingId = useConversationStore.getState().registerSubConversation(
    subConversationId,
    connectionId,
    `${description}（子agent）`,
    subTaskId,
    prompt,
    parentConversationId,
  );

  useTaskStore.setState((s) => ({
    tasks: {
      ...s.tasks,
      [subTaskId]: {
        id: subTaskId,
        sessionId: parent?.sessionId ?? '',
        conversationId: subConversationId,
        prompt,
        mode: 'plan',
        status,
        createdAt: new Date().toISOString(),
        parentTaskId,
      },
    },
  }));

  return loadingId;
}

/** subTaskStart 事件：注册子对话并挂载子agent实时流 listener。 */
export function handleSubTaskStart(parentTaskId: string, ev: SubTaskStartPayload) {
  const loadingId = registerSubTaskContext(
    parentTaskId,
    ev.subTaskId,
    ev.subConversationId,
    ev.description,
    ev.prompt,
    'planning',
    ev.parentConversationId,
  );
  if (loadingId) {
    // 子agent仍在运行：挂 listener 消费实时流事件。
    void attachStreamListener(ev.subTaskId, ev.subConversationId, loadingId);
  }
  // 把子对话 id 挂到主对话的 task 工具卡片上：运行中即可"查看"实时过程
  // （toolResult 完成后会被后端 metadata 覆盖，无冲突）。
  const parentTask = useTaskStore.getState().tasks[parentTaskId];
  if (parentTask) {
    useConversationStore.getState().updateConversationMessages(
      parentTask.conversationId,
      (msgs) =>
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
 * toolResult 兜底：子agent（task 工具）必然已终态（后端同步等待），
 * 若此前未注册（应用重启 / subTaskStart 事件丢失），从 DB 加载完整消息，
 * 并补齐对话元数据（parentConversationId / connectionId）保证"返回主对话"可用。
 * 已注册（live 路径）时也收敛任务终态：防 done 事件在 listener 挂载前
 * 丢失导致子任务永久停留在 planning + 骨架 loading 转圈。
 */
export async function handleSubTaskFallback(
  parentTaskId: string,
  meta: SubTaskResultMetadata,
  description: string,
  prompt: string,
) {
  const conv = await tauri
    .agentGetConversation(meta.subConversationId)
    .catch(() => null);
  registerSubTaskContext(
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
  const existing = useTaskStore.getState().tasks[meta.subTaskId];
  if (existing && existing.status !== subTaskTerminalStatus(meta.status)) {
    useTaskStore.getState().updateTaskStatus(meta.subTaskId, subTaskTerminalStatus(meta.status));
  }
  // 骨架残留防御：仅当骨架 loading 消息还在时从 DB 全量替换
  // （toolResult 到达 = 子任务已终态；实时流已消费骨架的正常路径不覆盖）。
  try {
    const stored = await tauri.agentLoadConversation(meta.subConversationId);
    const msgs = clearIntermediateReasoning(stored.map(storedMessageToAgentMessage));
    useConversationStore.getState().updateConversationMessages(meta.subConversationId, (cur) => {
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
  cleanupStreamState(taskId);
}

export async function attachStreamListener(taskId: string, conversationId: string, loadingAssistantId: string) {
  if (streamListeners.has(taskId)) return;

  const handler = createDefaultStreamHandler();
  streamHandlers.set(taskId, handler);

  const unlisten = await listen<LlmStreamEvent | ToolResultPayload | ApprovalRequestPayload>(
    `agent://stream/${taskId}`,
    (event) => {
      const ev = event.payload;

      if (isToolResultPayload(ev)) {
        // 子agent（task 工具）结果：若此前从未注册（重启/事件丢失），
        // 兜底注册子对话并从 DB 加载终态消息。
        const subMeta = extractSubTaskMeta(ev);
        if (subMeta) {
          const description =
            typeof ev.arguments?.description === 'string' ? ev.arguments.description : '';
          const prompt = typeof ev.arguments?.prompt === 'string' ? ev.arguments.prompt : '';
          void handleSubTaskFallback(taskId, subMeta, description, prompt);
        }
        handleToolResult(handler, taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'subTaskStart')) {
        handleSubTaskStart(taskId, ev as unknown as SubTaskStartPayload);
        return;
      }

      if (hasEventType(ev, 'approvalRequest')) {
        handler.setPendingApproval({
          ...(ev as unknown as ApprovalRequestPayload),
          taskId,
        });
        return;
      }

      if (hasEventType(ev, 'questionRequest')) {
        handleQuestionRequest(handler, {
          ...(ev as unknown as QuestionRequestPayload),
          taskId,
        } as QuestionRequestPayload);
        return;
      }

      if (hasEventType(ev, 'modelApprovalStart')) {
        handleModelApprovalStart(handler, taskId, conversationId, ev as unknown as ModelApprovalStartPayload);
        return;
      }

      if (hasEventType(ev, 'modelApprovalDone')) {
        handleModelApprovalDone(handler, taskId, conversationId, ev as unknown as ModelApprovalDonePayload);
        return;
      }

      if (hasEventType(ev, 'textDelta')) {
        handleTextDelta(handler, taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'thinkingDelta')) {
        handleThinkingDelta(handler, taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'toolCallStart')) {
        handleToolCallStart(handler, taskId, conversationId, ev);
        return;
      }

      if (hasEventType(ev, 'toolOutput')) {
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
        handleDone(handler, taskId, conversationId, loadingAssistantId);
        cleanupTaskListeners(taskId);
        return;
      }

      if (hasEventType(ev, 'error')) {
        handleError(handler, taskId, conversationId, loadingAssistantId, ev);
        cleanupTaskListeners(taskId);
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

      if (hasEventType(ev, 'usage')) {
        const usageEv = ev as unknown as { type: 'usage'; usage: TokenUsage };
        useTaskStore.getState().accumulateTokenUsage(usageEv.usage);
        return;
      }

      console.warn('[agent] unknown event type', ev);
    },
  );
  streamListeners.set(taskId, unlisten);
}

export async function attachPlanListener(taskId: string) {
  if (planListeners.has(taskId)) return;

  let handler = streamHandlers.get(taskId);
  if (!handler) {
    handler = createDefaultStreamHandler();
    streamHandlers.set(taskId, handler);
  }

  const unlisten = await listen<PlanStreamEvent>(
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

  planListeners.set(taskId, unlisten);
}
