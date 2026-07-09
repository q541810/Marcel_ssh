import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  LlmStreamEvent,
  ToolResultPayload,
  ApprovalRequestPayload,
  PlanStreamEvent,
  ModelApprovalStartPayload,
  ModelApprovalDonePayload,
  QuestionRequestPayload,
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
  type StreamHandler,
  cleanupStreamState,
} from './agentStreamHandlers';
import { createDefaultStreamHandler } from './storeStreamAdapter';

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
        handleToolResult(handler, taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'approvalRequest')) {
        handler.setPendingApproval(ev);
        return;
      }

      if (hasEventType(ev, 'questionRequest')) {
        handleQuestionRequest(handler, ev as unknown as QuestionRequestPayload);
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
