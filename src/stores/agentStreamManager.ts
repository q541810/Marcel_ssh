import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  LlmStreamEvent,
  ToolResultPayload,
  ApprovalRequestPayload,
  PlanStreamEvent,
} from '@/lib/types';
import {
  handleToolResult,
  handleToolCallStart,
  handleTextDelta,
  handleThinkingDelta,
  handleDone,
  handleError,
  handleRetrying,
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

      if (hasEventType(ev, 'toolCallDelta')) {
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

  const handler = streamHandlers.get(taskId);
  if (!handler) return;

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
        case 'plan-item-started': {
          handler.updatePlanItem(taskId, ev.itemId, 'in_progress');
          break;
        }
        case 'plan-item-completed': {
          handler.updatePlanItem(taskId, ev.itemId, 'completed');
          const latestPlan = handler.getPlan(taskId);
          if (latestPlan) {
            const nextIndex = latestPlan.items.findIndex(
              (item, index) => index > latestPlan.currentIndex && item.status === 'pending'
            );
            const newCurrentIndex = nextIndex !== -1 ? nextIndex : latestPlan.currentIndex;
            handler.setPlan(taskId, { ...latestPlan, currentIndex: newCurrentIndex });
          }
          break;
        }
        case 'plan-item-failed': {
          handler.updatePlanItem(taskId, ev.itemId, 'failed', ev.error);
          break;
        }
        case 'plan-item-skipped': {
          handler.updatePlanItem(taskId, ev.itemId, 'skipped');
          break;
        }
        case 'plan-completed': {
          console.log(`[agent] Plan completed for task ${taskId}: ${ev.completed}/${ev.total}`);
          break;
        }
      }
    },
  );

  planListeners.set(taskId, unlisten);
}
