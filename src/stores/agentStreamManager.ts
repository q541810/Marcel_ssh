import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AgentMessage,
  LlmStreamEvent,
  ToolResultPayload,
  ApprovalRequestPayload,
  AgentTaskPlan,
  PlanStreamEvent,
} from '@/lib/types';
import { useAgentStore } from './agentStore';

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

function getStreamState(taskId: string): TaskStreamState {
  return taskStreamState.get(taskId) ?? {
    assistantMessageId: null,
    messageIndex: -1,
    loadingCleared: false,
    toolResultCount: 0,
  };
}

function cleanupStreamState(taskId: string) {
  taskStreamState.delete(taskId);
}

// ---------------------------------------------------------------------------
// Listener maps
// ---------------------------------------------------------------------------

const streamListeners: Map<string, UnlistenFn> = new Map();
const planListeners: Map<string, UnlistenFn> = new Map();

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
// Helpers
// ---------------------------------------------------------------------------

/** Insert a tool message at the end of the array (after the latest user prompt
 * and any prior assistant/tool messages). The loading assistant message has
 * already been removed by the caller, so pushing to the end puts the tool
 * card in the correct chronological position. */
function insertToolMessageAfterAssistant(newMsgs: AgentMessage[], toolMessage: AgentMessage): AgentMessage[] {
  newMsgs.push(toolMessage);
  return newMsgs;
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/** Handle toolResult events: create tool message and clear loading */
function handleToolResult(taskId: string, conversationId: string, loadingAssistantId: string, tr: ToolResultPayload) {
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

  useAgentStore.setState((state) => {
    const convMsgs = state.messages[conversationId] || [];
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

    taskStreamState.set(taskId, streamState);

    return { messages: { ...state.messages, [conversationId]: newMsgs } };
  });
}

/** Handle textDelta events: append to or create assistant message.
 *  Backend already filters thinking tags in openai.rs, so no frontend filtering needed. */
function handleTextDelta(taskId: string, conversationId: string, loadingAssistantId: string, streamEv: { type: 'textDelta'; text: string }) {
  const state = getStreamState(taskId);

  if (state.assistantMessageId) {
    useAgentStore.setState((state2) => {
      const convMsgs = state2.messages[conversationId] || [];
      let { messageIndex: idx } = state;
      if (idx >= convMsgs.length || convMsgs[idx]?.id !== state.assistantMessageId) {
        idx = convMsgs.findIndex((m) => m.id === state.assistantMessageId);
        if (idx === -1) return state2;
      }
      const newMsgs = [...convMsgs];
      newMsgs[idx] = { ...newMsgs[idx], content: newMsgs[idx].content + streamEv.text };
      return { messages: { ...state2.messages, [conversationId]: newMsgs } };
    });
  } else {
    let loadingCleared = state.loadingCleared;
    let newAssistantId = '';
    let newMsgIndex = -1;

    useAgentStore.setState((state2) => {
      const convMsgs = state2.messages[conversationId] || [];
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

      return { messages: { ...state2.messages, [conversationId]: newMsgs } };
    });

    const finalState = getStreamState(taskId);
    taskStreamState.set(taskId, {
      assistantMessageId: newAssistantId,
      messageIndex: newMsgIndex,
      loadingCleared,
      toolResultCount: finalState.toolResultCount,
    });
  }

  const store = useAgentStore.getState();
  if (store.tasks[taskId]?.status === 'planning') {
    store.updateTaskStatus(taskId, 'executing');
  }
}

/** Handle done events: cleanup and mark task completed */
function handleDone(taskId: string, conversationId: string, loadingAssistantId: string) {
  useAgentStore.getState().updateTaskStatus(taskId, 'completed');

  useAgentStore.setState((state2) => {
    const convMsgs = state2.messages[conversationId] || [];
    const newMsgs = convMsgs.filter((m) => {
      if (m.id === loadingAssistantId) return false;
      if (m.role === 'assistant' && m.content === '' && !m.toolCall) return false;
      return true;
    });
    return {
      messages: { ...state2.messages, [conversationId]: newMsgs },
      activeTaskId: state2.activeTaskId === taskId ? null : state2.activeTaskId,
      pendingApproval: null,
    };
  });

  cleanupTaskListeners(taskId);
}

/** Handle error events: show error message and mark task failed */
function handleError(taskId: string, conversationId: string, loadingAssistantId: string, errEv: { type: 'error'; message: string }) {
  useAgentStore.getState().updateTaskStatus(taskId, 'failed');

  useAgentStore.setState((state2) => {
    const convMsgs = state2.messages[conversationId] || [];
    const newMsgs = convMsgs.filter((m) => m.id !== loadingAssistantId);
    return {
      messages: {
        ...state2.messages,
        [conversationId]: [
          ...newMsgs,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `LLM 错误：${errEv.message}`,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      activeTaskId: state2.activeTaskId === taskId ? null : state2.activeTaskId,
      pendingApproval: null,
    };
  });

  cleanupTaskListeners(taskId);
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
  cleanupStreamState(taskId);
}

export async function attachStreamListener(taskId: string, conversationId: string, loadingAssistantId: string) {
  if (streamListeners.has(taskId)) return;

  const unlisten = await listen<LlmStreamEvent | ToolResultPayload | ApprovalRequestPayload>(
    `agent://stream/${taskId}`,
    (event) => {
      const ev = event.payload;

      if (isToolResultPayload(ev)) {
        handleToolResult(taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'approvalRequest')) {
        useAgentStore.getState().setPendingApproval(ev);
        return;
      }

      if (hasEventType(ev, 'textDelta')) {
        handleTextDelta(taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      if (hasEventType(ev, 'toolCallStart') || hasEventType(ev, 'toolCallDelta')) {
        console.debug('[agent] tool event', ev);
        return;
      }

      if (hasEventType(ev, 'done')) {
        handleDone(taskId, conversationId, loadingAssistantId);
        return;
      }

      if (hasEventType(ev, 'error')) {
        handleError(taskId, conversationId, loadingAssistantId, ev);
        return;
      }

      console.warn('[agent] unknown event type', ev);
    },
  );
  streamListeners.set(taskId, unlisten);
}

export async function attachPlanListener(taskId: string) {
  if (planListeners.has(taskId)) return;

  const unlisten = await listen<PlanStreamEvent>(
    `agent://plan/${taskId}`,
    (event) => {
      const ev = event.payload;
      const store = useAgentStore.getState();

      switch (ev.type) {
        case 'plan-created': {
          const plan: AgentTaskPlan = {
            taskId,
            items: ev.items,
            currentIndex: 0,
          };
          store.setPlan(taskId, plan);
          break;
        }
        case 'plan-item-started': {
          store.updatePlanItem(taskId, ev.itemId, 'in_progress');
          break;
        }
        case 'plan-item-completed': {
          store.updatePlanItem(taskId, ev.itemId, 'completed');
          const latestPlan = useAgentStore.getState().plans[taskId];
          if (latestPlan) {
            const nextIndex = latestPlan.items.findIndex(
              (item, index) => index > latestPlan.currentIndex && item.status === 'pending'
            );
            const newCurrentIndex = nextIndex !== -1 ? nextIndex : latestPlan.currentIndex;
            store.setPlan(taskId, { ...latestPlan, currentIndex: newCurrentIndex });
          }
          break;
        }
        case 'plan-item-failed': {
          store.updatePlanItem(taskId, ev.itemId, 'failed', ev.error);
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
