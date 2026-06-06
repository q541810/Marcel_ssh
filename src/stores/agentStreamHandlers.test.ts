import { beforeEach, describe, it, expect } from 'vitest';
import {
  handleToolCallStart,
  handleToolResult,
  handleDone,
  handleError,
  getStreamState,
  cleanupStreamState,
  setStreamState,
  type StreamHandler,
} from '@/stores/agentStreamHandlers';
import type { AgentMessage, AgentTaskPlan, ToolResultPayload } from '@/lib/types';

function mockHandler(messages: Record<string, AgentMessage[]> = {}): StreamHandler & {
  _messages: Record<string, AgentMessage[]>;
  _taskStatuses: Record<string, string>;
  _pendingApprovals: unknown[];
  _plans: Record<string, AgentTaskPlan>;
} {
  const msgs = { ...messages };
  const taskStatuses: Record<string, string> = {};
  let _pendingApproval: unknown = null;
  const plans: Record<string, AgentTaskPlan> = {};

  return {
    _messages: msgs,
    _taskStatuses: taskStatuses,
    _pendingApprovals: [],
    _plans: plans,
    updateMessages(convId: string, updater: (msgs: AgentMessage[]) => AgentMessage[]) {
      msgs[convId] = updater(msgs[convId] || []);
    },
    updateTaskStatus(taskId: string, status: string) {
      taskStatuses[taskId] = status;
    },
    setPendingApproval(approval: unknown | null) {
      _pendingApproval = approval;
    },
    getTaskStatus(taskId: string) {
      return taskStatuses[taskId];
    },
    getMessages(convId: string) {
      return msgs[convId] || [];
    },
    clearActiveTaskIf(_taskId: string) {},
    setPlan(taskId: string, plan: AgentTaskPlan) {
      plans[taskId] = plan;
    },
    updatePlanItem(_taskId: string, _itemId: string, _status: string, _error?: string) {},
    getPlan(taskId: string) {
      return plans[taskId];
    },
  };
}

const taskId = 'task-1';
const convId = 'conv-1';

function makeToolResult(overrides: Partial<ToolResultPayload> = {}): ToolResultPayload {
  const { type: _type, ...rest } = overrides;

  return {
    type: 'toolResult',
    toolCallId: 'tc-1',
    toolName: 'execute_command',
    summary: '$ ls',
    result: 'file.txt\ndir/',
    success: true,
    blocked: false,
    arguments: { command: 'ls' },
    ...rest,
  };
}

describe('agentStreamHandlers', () => {
  beforeEach(() => {
    cleanupStreamState(taskId);
  });

  describe('getStreamState / setStreamState / cleanupStreamState', () => {
    it('returns default state for unknown task', () => {
      const state = getStreamState('unknown');
      expect(state.assistantMessageId).toBeNull();
      expect(state.messageIndex).toBe(-1);
      expect(state.loadingCleared).toBe(false);
    });

    it('persists and retrieves state', () => {
      setStreamState(taskId, {
        assistantMessageId: 'msg-1',
        messageIndex: 3,
        loadingCleared: true,
        toolResultCount: 2,
        pendingToolCalls: new Map(),
      });
      const state = getStreamState(taskId);
      expect(state.assistantMessageId).toBe('msg-1');
      expect(state.messageIndex).toBe(3);
    });

    it('cleanup removes state', () => {
      setStreamState(taskId, getStreamState(taskId));
      cleanupStreamState(taskId);
      expect(getStreamState(taskId).assistantMessageId).toBeNull();
    });
  });

  describe('handleToolCallStart', () => {
    it('creates an in-progress tool message', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-start-1',
        name: 'execute_command',
      });

      const msgs = handler._messages[convId];
      expect(msgs.length).toBe(1);
      expect(msgs[0].role).toBe('tool');
      expect(msgs[0].isExecuting).toBe(true);
      expect(msgs[0].toolResult?.toolName).toBe('execute_command');
    });

    it('clears reasoning from last assistant message', () => {
      const handler = mockHandler({
        [convId]: [
          {
            id: 'assist-1',
            role: 'assistant',
            content: '',
            timestamp: '',
            reasoningContent: 'thinking...',
            isThinking: true,
          },
        ],
      });

      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-1',
        name: 'read_file',
      });

      const msgs = handler._messages[convId];
      expect(msgs[0].reasoningContent).toBeUndefined();
      expect(msgs[0].isThinking).toBe(false);
    });
  });

  describe('handleToolResult', () => {
    it('updates matching pending tool message', () => {
      const handler = mockHandler({ [convId]: [] });
      const loadingId = 'loading-1';

      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-match-1',
        name: 'read_file',
      });

      handleToolResult(handler, taskId, convId, loadingId, makeToolResult({
        toolCallId: 'tc-match-1',
        toolName: 'read_file',
        summary: 'read done',
      }));

      const msgs = handler._messages[convId];
      expect(msgs[0].isExecuting).toBe(false);
      expect(msgs[0].toolResult?.summary).toBe('read done');
    });

    it('passes wasTimeout flag', () => {
      const handler = mockHandler({ [convId]: [] });
      const loadingId = 'loading-2';

      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-timeout-1',
        name: 'execute_command',
      });

      handleToolResult(handler, taskId, convId, loadingId, makeToolResult({
        toolCallId: 'tc-timeout-1',
        wasTimeout: true,
      }));

      expect(handler._messages[convId][0].toolResult?.wasTimeout).toBe(true);
    });

    it('creates fallback message when no pending match', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolResult(handler, taskId, convId, 'loading-1', makeToolResult({
        toolCallId: 'no-match',
      }));

      const msgs = handler._messages[convId];
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      expect(msgs.some((m) => m.role === 'tool')).toBe(true);
    });
  });

  describe('handleDone', () => {
    it('marks task completed and cleans up', () => {
      const handler = mockHandler({ [convId]: [] });
      const loadingId = 'loading-done';

      handleDone(handler, taskId, convId, loadingId);

      expect(handler._taskStatuses[taskId]).toBe('completed');
    });

    it('removes loading placeholder', () => {
      const handler = mockHandler({
        [convId]: [
          { id: 'loading-done', role: 'assistant', content: '', timestamp: '', isLoading: true },
          { id: 'keep-me', role: 'user', content: 'hello', timestamp: '' },
        ],
      });

      handleDone(handler, taskId, convId, 'loading-done');

      const msgs = handler._messages[convId];
      expect(msgs.find((m) => m.id === 'loading-done')).toBeUndefined();
      expect(msgs.find((m) => m.id === 'keep-me')).toBeDefined();
    });
  });

  describe('handleError', () => {
    it('sets task to failed and adds system error message', () => {
      const handler = mockHandler({ [convId]: [] });

      handleError(handler, taskId, convId, 'loading-err', {
        type: 'error',
        message: 'something broke',
      });

      expect(handler._taskStatuses[taskId]).toBe('failed');
      const msgs = handler._messages[convId];
      expect(msgs.some((m) => m.role === 'system' && m.content.includes('something broke'))).toBe(true);
    });
  });
});
