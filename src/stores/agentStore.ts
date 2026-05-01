import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AgentTask,
  AgentMessage,
  AgentMode,
  LlmStreamEvent,
  ToolResultPayload,
  ApprovalRequestPayload,
} from '@/lib/types';
import * as tauri from '@/lib/tauri';

interface AgentState {
  tasks: Record<string, AgentTask>;
  activeTaskId: string | null;
  messages: AgentMessage[];
  mode: AgentMode;
  pendingApproval: ApprovalRequestPayload | null;

  startTask: (sessionId: string, prompt: string) => Promise<string>;
  stopTask: (taskId: string) => Promise<void>;
  approveOperation: (taskId: string, operationId: string) => Promise<void>;
  rejectOperation: (taskId: string, operationId: string) => Promise<void>;
  addMessage: (message: AgentMessage) => void;
  setMode: (mode: AgentMode) => void;
  clearMessages: () => void;
  updateTaskStatus: (taskId: string, status: AgentTask['status']) => void;
  setPendingApproval: (approval: ApprovalRequestPayload | null) => void;
}

// Track the current assistant message ID for each task
const currentAssistantMessageId: Map<string, string> = new Map();

export const useAgentStore = create<AgentState>((set, get) => ({
  tasks: {},
  activeTaskId: null,
  messages: [],
  mode: 'agent',
  pendingApproval: null,

  startTask: async (sessionId: string, prompt: string) => {
    const { mode } = get();

    // Push the user message immediately so the UI feels responsive.
    const userMessage: AgentMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      timestamp: new Date().toISOString(),
    };
    set((state) => ({
      messages: [...state.messages, userMessage],
    }));

    let taskId: string;
    try {
      // Convert our message history to the format the backend expects.
      // Only include user + assistant messages (skip system — backend injects its own).
      const llmHistory = get()
        .messages.filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content }));

      taskId = await tauri.agentStartTask(sessionId, prompt, mode, llmHistory);
    } catch (err) {
      // Add a system error message.
      set((state) => ({
        messages: [
          ...state.messages,
          {
            id: crypto.randomUUID(),
            role: 'system',
            content: `启动任务失败：${String(err)}`,
            timestamp: new Date().toISOString(),
          },
        ],
      }));
      throw err;
    }

    const task: AgentTask = {
      id: taskId,
      sessionId,
      prompt,
      mode,
      status: 'planning',
      createdAt: new Date().toISOString(),
    };
    set((state) => ({
      tasks: { ...state.tasks, [taskId]: task },
      activeTaskId: taskId,
    }));

    // Subscribe to streaming events for this task.
    // Don't pre-create assistant message - wait for first textDelta
    void attachStreamListener(taskId);

    return taskId;
  },

  stopTask: async (taskId: string) => {
    try {
      await tauri.agentStopTask(taskId);
    } finally {
      // Best-effort cleanup of any active listener for this task
      const fn = streamListeners.get(taskId);
      if (fn) {
        fn();
        streamListeners.delete(taskId);
      }
      currentAssistantMessageId.delete(taskId);
      set((state) => {
        const task = state.tasks[taskId];
        if (!task) return state;
        return {
          tasks: { ...state.tasks, [taskId]: { ...task, status: 'cancelled' } },
          activeTaskId: state.activeTaskId === taskId ? null : state.activeTaskId,
        };
      });
    }
  },

  approveOperation: async (taskId: string, operationId: string) => {
    await tauri.agentApproveOperation(taskId, operationId);
  },

  rejectOperation: async (taskId: string, operationId: string) => {
    await tauri.agentRejectOperation(taskId, operationId);
  },

  addMessage: (message: AgentMessage) => {
    set((state) => ({ messages: [...state.messages, message] }));
  },

  setMode: (mode: AgentMode) => {
    set({ mode });
  },

  clearMessages: () => {
    set({ messages: [] });
  },

  updateTaskStatus: (taskId: string, status: AgentTask['status']) => {
    set((state) => {
      const task = state.tasks[taskId];
      if (!task) return state;
      return {
        tasks: { ...state.tasks, [taskId]: { ...task, status } },
      };
    });
  },

  setPendingApproval: (approval: ApprovalRequestPayload | null) => {
    set({ pendingApproval: approval });
  },
}));

/* -------- Stream listener wiring -------- */

const streamListeners: Map<string, UnlistenFn> = new Map();

async function attachStreamListener(taskId: string) {
  if (streamListeners.has(taskId)) return;

  const unlisten = await listen<LlmStreamEvent | ToolResultPayload | ApprovalRequestPayload>(
    `agent://stream/${taskId}`,
    (event) => {
      const ev = event.payload;
      const store = useAgentStore.getState();
      const assistantMessageId = currentAssistantMessageId.get(taskId);

      // Check if this is an approval request
      if ('type' in ev && ev.type === 'approvalRequest') {
        const approval = ev as ApprovalRequestPayload;
        store.setPendingApproval(approval);
        return;
      }

      // Check if this is a tool result event (has toolCallId field)
      if ('toolCallId' in ev) {
        const tr = ev as ToolResultPayload;
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
          },
        };
        
        // If there's a current assistant message, insert tool message after it
        // Otherwise just append to the end
        useAgentStore.setState((state) => {
          if (assistantMessageId) {
            const assistantIdx = state.messages.findIndex(m => m.id === assistantMessageId);
            if (assistantIdx !== -1) {
              const newMessages = [...state.messages];
              newMessages.splice(assistantIdx + 1, 0, toolMessage);
              return { messages: newMessages };
            }
          }
          return { messages: [...state.messages, toolMessage] };
        });
        
        // Clear the current assistant message ID - we'll create a new one on next textDelta
        currentAssistantMessageId.delete(taskId);
        return;
      }

      // Otherwise it's a standard stream event
      switch (ev.type) {
        case 'textDelta': {
          // If we don't have an assistant message yet, create one
          if (!assistantMessageId) {
            const newAssistantMessageId = crypto.randomUUID();
            const newAssistantMessage: AgentMessage = {
              id: newAssistantMessageId,
              role: 'assistant',
              content: ev.text,
              timestamp: new Date().toISOString(),
            };
            
            useAgentStore.setState((state) => ({
              messages: [...state.messages, newAssistantMessage],
            }));
            
            currentAssistantMessageId.set(taskId, newAssistantMessageId);
          } else {
            // Append delta to the existing assistant message
            useAgentStore.setState((state) => ({
              messages: state.messages.map((m) =>
                m.id === assistantMessageId
                  ? { ...m, content: m.content + ev.text }
                  : m,
              ),
            }));
          }
          
          // Mark task as executing on first delta
          if (store.tasks[taskId]?.status === 'planning') {
            store.updateTaskStatus(taskId, 'executing');
          }
          break;
        }
        case 'toolCallStart':
        case 'toolCallDelta': {
          // Tool calls aren't fully wired yet — just log.
          // Phase 2 will translate these into ApprovalDialog interactions.
          console.debug('[agent] tool event', ev);
          break;
        }
        case 'done': {
          store.updateTaskStatus(taskId, 'completed');
          useAgentStore.setState((state) => ({
            activeTaskId:
              state.activeTaskId === taskId ? null : state.activeTaskId,
          }));
          currentAssistantMessageId.delete(taskId);
          const fn = streamListeners.get(taskId);
          if (fn) {
            fn();
            streamListeners.delete(taskId);
          }
          break;
        }
        case 'error': {
          store.updateTaskStatus(taskId, 'failed');
          useAgentStore.setState((state) => ({
            messages: [
              ...state.messages,
              {
                id: crypto.randomUUID(),
                role: 'system',
                content: `LLM 错误：${ev.message}`,
                timestamp: new Date().toISOString(),
              },
            ],
            activeTaskId:
              state.activeTaskId === taskId ? null : state.activeTaskId,
          }));
          currentAssistantMessageId.delete(taskId);
          const fn = streamListeners.get(taskId);
          if (fn) {
            fn();
            streamListeners.delete(taskId);
          }
          break;
        }
      }
    },
  );
  streamListeners.set(taskId, unlisten);
}
