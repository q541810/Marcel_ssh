import { beforeEach, describe, it, expect } from 'vitest';
import {
  handleToolCallStart,
  handleToolCallDelta,
  handleToolResult,
  handleDone,
  handleError,
  handleRetrying,
  handleCompactionStart,
  handleCompactionProgress,
  handleCompactionDone,
  handleCompactionSkipped,
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
  _pendingQuestions: unknown[];
  _plans: Record<string, AgentTaskPlan>;
} {
  const msgs = { ...messages };
  const taskStatuses: Record<string, string> = {};
  let _pendingApproval: unknown = null;
  let _pendingQuestion: unknown = null;
  const plans: Record<string, AgentTaskPlan> = {};

  return {
    _messages: msgs,
    _taskStatuses: taskStatuses,
    _pendingApprovals: [],
    _pendingQuestions: [],
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
    setPendingQuestion(question: unknown | null) {
      _pendingQuestion = question;
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
        pendingToolArgs: new Map(),
        pendingTextDelta: '',
        pendingThinkingDelta: '',
        flushRafId: null,
        compactionMessageId: null,
        compactionTrigger: null,
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
      expect(msgs[0].toolResult?.toolCallId).toBe('tc-start-1');
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
      expect(msgs[0].toolResult?.toolCallId).toBe('tc-match-1');
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
      expect(handler._messages[convId][0].toolResult?.toolCallId).toBe('tc-timeout-1');
    });

    it('creates fallback message when no pending match', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolResult(handler, taskId, convId, 'loading-1', makeToolResult({
        toolCallId: 'no-match',
      }));

      const msgs = handler._messages[convId];
      expect(msgs.length).toBeGreaterThanOrEqual(1);
      expect(msgs.some((m) => m.role === 'tool')).toBe(true);
      const toolMsg = msgs.find((m) => m.role === 'tool');
      expect(toolMsg?.toolResult?.toolCallId).toBe('no-match');
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

    it('removes retrying messages when error arrives', () => {
      const handler = mockHandler({ [convId]: [] });

      // First, add a retrying message
      handleRetrying(handler, taskId, convId, {
        type: 'retrying',
        attempt: 2,
        maxAttempts: 4,
        delaySecs: 5,
        lastError: 'timeout',
      });
      expect(handler._messages[convId].some((m) => m.isRetrying)).toBe(true);

      // Then handleError — retrying messages should be cleared
      handleError(handler, taskId, convId, 'loading-err', {
        type: 'error',
        message: 'final error',
      });
      expect(handler._messages[convId].some((m) => m.isRetrying)).toBe(false);
    });
  });

  describe('handleRetrying', () => {
    it('adds a structured retrying message and clears previous ones', () => {
      const handler = mockHandler({ [convId]: [] });

      handleRetrying(handler, taskId, convId, {
        type: 'retrying',
        attempt: 2,
        maxAttempts: 4,
        delaySecs: 5,
        lastError: 'LLM 返回错误 429: rate limit',
      });

      const msgs = handler._messages[convId];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe('system');
      expect(msgs[0].isRetrying).toBe(true);
      expect(msgs[0].retryAttempt).toBe(1);
      expect(msgs[0].retryMaxAttempts).toBe(3);
      expect(msgs[0].retryTotalDelaySecs).toBe(5);
      expect(msgs[0].retryLastError).toBe('LLM 返回错误 429: rate limit');
      // content is now empty — UI composes the text from structured fields
      expect(msgs[0].content).toBe('');
    });

    it('does not alter other messages in the conversation', () => {
      const handler = mockHandler({
        [convId]: [
          {
            id: 'user-1',
            role: 'user',
            content: 'hello',
            timestamp: new Date().toISOString(),
          },
        ],
      });

      handleRetrying(handler, taskId, convId, {
        type: 'retrying',
        attempt: 1,
        maxAttempts: 2,
        delaySecs: 3,
        lastError: 'timeout',
      });

      const msgs = handler._messages[convId];
      expect(msgs).toHaveLength(2);
      expect(msgs[0].role).toBe('user');
      expect(msgs[0].content).toBe('hello');
      expect(msgs[1].role).toBe('system');
      expect(msgs[1].isRetrying).toBe(true);
      expect(msgs[1].retryAttempt).toBe(0);
    });

    it('deduplicates: only keeps one retrying message with latest attempt', () => {
      const handler = mockHandler({ [convId]: [] });

      handleRetrying(handler, taskId, convId, {
        type: 'retrying',
        attempt: 1,
        maxAttempts: 3,
        delaySecs: 5,
        lastError: 'timeout',
      });
      handleRetrying(handler, taskId, convId, {
        type: 'retrying',
        attempt: 2,
        maxAttempts: 3,
        delaySecs: 5,
        lastError: 'LLM 返回错误 502: bad gateway',
      });

      const msgs = handler._messages[convId];
      expect(msgs).toHaveLength(1);
      expect(msgs[0].retryAttempt).toBe(1);
      expect(msgs[0].retryLastError).toBe('LLM 返回错误 502: bad gateway');
    });
  });

  describe('handleToolCallDelta', () => {
    it('accumulates argument deltas and backfills when JSON is complete', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-delta-1',
        name: 'execute_command',
      });

      const msgs = handler._messages[convId];
      expect(msgs[0].toolResult?.arguments).toBeUndefined();

      // Partial JSON — not yet parseable
      handleToolCallDelta(handler, taskId, convId, {
        type: 'toolCallDelta',
        id: 'tc-delta-1',
        argumentsDelta: '{"command":',
      });
      expect(handler._messages[convId][0].toolResult?.arguments).toBeUndefined();

      // Complete JSON — should backfill
      handleToolCallDelta(handler, taskId, convId, {
        type: 'toolCallDelta',
        id: 'tc-delta-1',
        argumentsDelta: ' "ls -la"}',
      });
      expect(handler._messages[convId][0].toolResult?.arguments).toEqual({ command: 'ls -la' });
    });

    it('ignores delta for unknown tool call id', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallDelta(handler, taskId, convId, {
        type: 'toolCallDelta',
        id: 'unknown-id',
        argumentsDelta: '{"x":1}',
      });
      expect(handler._messages[convId]).toHaveLength(0);
    });
  });

  describe('compaction handlers', () => {
    it('inserts a running indicator on start', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'pressure',
      });
      expect(handler._messages[convId]).toHaveLength(1);
      expect(handler._messages[convId][0].role).toBe('system');
      expect(handler._messages[convId][0].compaction?.status).toBe('running');
    });

    it('done splices by tailDbId pointer and originals stay', () => {
      const u1: AgentMessage = { id: 'u1', role: 'user', content: 'u1', timestamp: '', dbId: 'row-1' };
      const a1: AgentMessage = { id: 'a1', role: 'assistant', content: 'a1', timestamp: '', dbId: 'row-2' };
      const t1: AgentMessage = {
        id: 't1', role: 'tool', content: 'out', timestamp: '', dbId: 'row-3',
        toolResult: { toolName: 'x', summary: '', result: 'out', success: true, blocked: false, toolCallId: 'X1' },
      };
      const u2: AgentMessage = { id: 'u2', role: 'user', content: 'u2', timestamp: '', dbId: 'row-4' };
      const handler = mockHandler({ [convId]: [u1, a1, t1, u2] });

      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'pressure',
      });
      const runningId = handler._messages[convId][4].id; // 运行中卡在尾部
      expect(getStreamState(taskId).compactionMessageId).toBe(runningId);
      expect(getStreamState(taskId).compactionTrigger).toBe('pressure');

      handleCompactionDone(handler, taskId, convId, {
        type: 'compactionDone',
        summary: '## Primary Request\n- do the thing',
        shadowedMessages: 3,
        shadowedTokens: 34_000,
        tailDbId: 'row-3',
      });

      // 原文全保留；卡片插在被压区间末条（t1）之后；运行中卡被移除
      expect(handler._messages[convId]).toHaveLength(5);
      const done = handler._messages[convId][3];
      expect(done.role).toBe('system');
      expect(done.compaction?.status).toBe('done');
      expect(done.compaction?.summary).toContain('do the thing');
      expect(done.compaction?.shadowedMessages).toBe(3);
      expect(done.compaction?.shadowedTokens).toBe(34_000);
      expect(handler._messages[convId].map((m) => m.id)).toEqual(['u1', 'a1', 't1', done.id, 'u2']);
      // 完成后释放占位 id
      expect(getStreamState(taskId).compactionMessageId).toBeNull();
    });

    it('a later compaction absorbs the previous done card, originals stay', () => {
      const u1: AgentMessage = { id: 'u1', role: 'user', content: 'u1', timestamp: '', dbId: 'row-1' };
      const a1: AgentMessage = { id: 'a1', role: 'assistant', content: 'a1', timestamp: '', dbId: 'row-2' };
      const t1: AgentMessage = {
        id: 't1', role: 'tool', content: 'out', timestamp: '', dbId: 'row-3',
        toolResult: { toolName: 'x', summary: '', result: 'out', success: true, blocked: false, toolCallId: 'X1' },
      };
      const u2: AgentMessage = { id: 'u2', role: 'user', content: 'u2', timestamp: '', dbId: 'row-4' };
      const handler = mockHandler({ [convId]: [u1, a1, t1, u2] });

      // 第一次压缩 → [u1, a1, t1, card1, u2]
      handleCompactionStart(handler, taskId, convId, { type: 'compactionStart', trigger: 'pressure' });
      handleCompactionDone(handler, taskId, convId, {
        type: 'compactionDone',
        summary: '## Primary Request\n- first round',
        shadowedMessages: 3,
        shadowedTokens: 1_000,
        tailDbId: 'row-3',
      });
      expect(handler._messages[convId]).toHaveLength(5);
      const firstCardId = handler._messages[convId][3].id;

      // 第二次压缩：区间到 u2 → 吸收 card1、新卡插在 u2 后（队尾）
      handleCompactionStart(handler, taskId, convId, { type: 'compactionStart', trigger: 'pressure' });
      expect(handler._messages[convId]).toHaveLength(6);
      expect(handler._messages[convId][5].compaction?.status).toBe('running'); // 运行中卡在尾部
      expect(getStreamState(taskId).compactionMessageId).toBe(handler._messages[convId][5].id);

      handleCompactionDone(handler, taskId, convId, {
        type: 'compactionDone',
        summary: '## Primary Request\n- second round',
        shadowedMessages: 2,
        shadowedTokens: 2_000,
        tailDbId: 'row-4',
      });
      // 原文 4 条全保留；旧卡被吸收；新卡在 u2 之后（区间末尾）
      expect(handler._messages[convId]).toHaveLength(5);
      const ids = handler._messages[convId].map((m) => m.id);
      expect(ids.slice(0, 4)).toEqual(['u1', 'a1', 't1', 'u2']);
      expect(ids).not.toContain(firstCardId); // 旧卡被吸收
      const done = handler._messages[convId][4];
      expect(done.compaction?.summary).toContain('second round');
    });

    it('degrades to a plain notice when tailDbId cannot be located (no done card, originals preserved)', () => {
      const u1: AgentMessage = { id: 'u1', role: 'user', content: 'u1', timestamp: '', dbId: 'row-1' };
      const a1: AgentMessage = { id: 'a1', role: 'assistant', content: 'a1', timestamp: '', dbId: 'row-2' };
      const t1: AgentMessage = {
        id: 't1', role: 'tool', content: 'out', timestamp: '', dbId: 'row-3',
        toolResult: { toolName: 'x', summary: '', result: 'out', success: true, blocked: false, toolCallId: 'X1' },
      };
      const u2: AgentMessage = { id: 'u2', role: 'user', content: 'u2', timestamp: '', dbId: 'row-4' };
      const handler = mockHandler({ [convId]: [u1, a1, t1, u2] });

      handleCompactionStart(handler, taskId, convId, { type: 'compactionStart', trigger: 'pressure' });
      const runningId = handler._messages[convId][4].id;
      // tailDbId 悬空（该消息在前端 store 无 dbId 的极端窗口）→ 降级
      handleCompactionDone(handler, taskId, convId, {
        type: 'compactionDone',
        summary: '## Primary Request\n- degrade',
        shadowedMessages: 3,
        shadowedTokens: 1_000,
        tailDbId: 'ghost-row',
      });

      // 不产生 done 卡（请求不屏蔽、原文保留）：运行中卡原位转普通提示
      expect(handler._messages[convId]).toHaveLength(5);
      expect(handler._messages[convId].map((m) => m.id)).toEqual(['u1', 'a1', 't1', 'u2', runningId]);
      expect(handler._messages[convId][4].compaction).toBeUndefined();
      expect(handler._messages[convId][4].content).toContain('上下文已压缩');
      expect(getStreamState(taskId).compactionMessageId).toBeNull();
    });

    it('manual done with null tailDbId appends the card at the tail (no dbId needed)', () => {
      // 全新会话：消息全无 dbId（本会话产生），手动压缩 = 队尾语义
      const u1: AgentMessage = { id: 'u1', role: 'user', content: 'u1', timestamp: '' };
      const a1: AgentMessage = { id: 'a1', role: 'assistant', content: 'a1', timestamp: '' };
      const handler = mockHandler({ [convId]: [u1, a1] });

      handleCompactionStart(handler, taskId, convId, { type: 'compactionStart', trigger: 'manual' });
      expect(getStreamState(taskId).compactionTrigger).toBe('manual');
      const runningId = handler._messages[convId][2].id;

      handleCompactionDone(handler, taskId, convId, {
        type: 'compactionDone',
        summary: '## Primary Request\n- manual round',
        shadowedMessages: 2,
        shadowedTokens: 1_000,
        tailDbId: null,
      });

      // 原文全保留 + 卡片在队尾；运行中卡被移除
      expect(handler._messages[convId]).toHaveLength(3);
      const done = handler._messages[convId][2];
      expect(done.compaction?.status).toBe('done');
      expect(done.compaction?.summary).toContain('manual round');
      expect(handler._messages[convId].map((m) => m.id)).toEqual(['u1', 'a1', done.id]);
      expect(handler._messages[convId].some((m) => m.id === runningId)).toBe(false);
      expect(getStreamState(taskId).compactionTrigger).toBeNull();
    });

    it('manual done absorbs the previous done card and stays single-card', () => {
      const u1: AgentMessage = { id: 'u1', role: 'user', content: 'u1', timestamp: '', dbId: 'row-1' };
      const a1: AgentMessage = { id: 'a1', role: 'assistant', content: 'a1', timestamp: '', dbId: 'row-2' };
      const u2: AgentMessage = { id: 'u2', role: 'user', content: 'u2', timestamp: '', dbId: 'row-3' };
      const handler = mockHandler({ [convId]: [u1, a1, u2] });

      // 第一次手动 → [u1, a1, u2, card1]
      handleCompactionStart(handler, taskId, convId, { type: 'compactionStart', trigger: 'manual' });
      handleCompactionDone(handler, taskId, convId, {
        type: 'compactionDone',
        summary: 's1',
        shadowedMessages: 3,
        shadowedTokens: 100,
        tailDbId: null,
      });
      expect(handler._messages[convId]).toHaveLength(4);
      const firstCardId = handler._messages[convId][3].id;

      // 第二次手动（又有新消息）→ 吸收旧卡，新卡在队尾，恒单卡
      const u4: AgentMessage = { id: 'u4', role: 'user', content: 'u4', timestamp: '' };
      handler._messages[convId].push(u4);
      handleCompactionStart(handler, taskId, convId, { type: 'compactionStart', trigger: 'manual' });
      handleCompactionDone(handler, taskId, convId, {
        type: 'compactionDone',
        summary: 's2',
        shadowedMessages: 4,
        shadowedTokens: 200,
        tailDbId: null,
      });
      expect(handler._messages[convId]).toHaveLength(5);
      expect(handler._messages[convId].some((m) => m.id === firstCardId)).toBe(false);
      const dones = handler._messages[convId].filter((m) => m.compaction?.status === 'done');
      expect(dones).toHaveLength(1);
      expect(handler._messages[convId][handler._messages[convId].length - 1].id).toBe(dones[0].id);
    });

    it('streams live summary text into the running card on progress', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'pressure',
      });
      const runningId = handler._messages[convId][0].id;

      handleCompactionProgress(handler, taskId, convId, {
        type: 'compactionProgress',
        text: '## Primary Request',
      });
      handleCompactionProgress(handler, taskId, convId, {
        type: 'compactionProgress',
        text: '## Primary Request\n- build a terminal',
      });

      expect(handler._messages[convId]).toHaveLength(1);
      const live = handler._messages[convId][0];
      expect(live.id).toBe(runningId);
      expect(live.compaction?.status).toBe('running');
      // 累计文本直接替换（后端重试会从头重发，替换语义可自愈）
      expect(live.compaction?.summary).toBe('## Primary Request\n- build a terminal');
      // content 同步为实时文本，驱动外层列表跟随滚动
      expect(live.content).toBe('## Primary Request\n- build a terminal');
    });

    it('ignores progress without a prior running card', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionProgress(handler, taskId, convId, {
        type: 'compactionProgress',
        text: 'orphan',
      });
      expect(handler._messages[convId]).toHaveLength(0);
    });

    it('turns the card into a plain notice when summarization was attempted but failed', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'context-overflow',
      });
      const runningId = handler._messages[convId][0].id;
      expect(getStreamState(taskId).compactionMessageId).toBe(runningId);

      handleCompactionSkipped(handler, taskId, convId, {
        type: 'compactionSkipped',
        reason: '生成的摘要未比原文更短，已放弃本次压缩',
        attempted: true,
      });

      expect(handler._messages[convId]).toHaveLength(1);
      const notice = handler._messages[convId][0];
      expect(notice.id).toBe(runningId); // 原位转文本，不跳位
      expect(notice.compaction).toBeUndefined();
      expect(notice.content).toContain('上下文压缩未完成');
      expect(notice.content).toContain('未比原文更短');
      expect(getStreamState(taskId).compactionMessageId).toBeNull();
    });

    it('removes the card entirely when skipped before summarization (no trace)', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'pressure',
      });
      const runningId = handler._messages[convId][0].id;
      expect(getStreamState(taskId).compactionMessageId).toBe(runningId);

      handleCompactionSkipped(handler, taskId, convId, {
        type: 'compactionSkipped',
        reason: '没有可压缩的早期历史区间',
        attempted: false,
      });

      expect(handler._messages[convId]).toHaveLength(0);
      expect(getStreamState(taskId).compactionMessageId).toBeNull();
    });

    it('ignores an orphan skipped event without a prior start', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionSkipped(handler, taskId, convId, {
        type: 'compactionSkipped',
        reason: 'no compactable range',
        attempted: false,
      });
      expect(handler._messages[convId]).toHaveLength(0);
      expect(getStreamState(taskId).compactionMessageId).toBeNull();
    });

    it('can start a fresh card after a skip', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'pressure',
      });
      handleCompactionSkipped(handler, taskId, convId, {
        type: 'compactionSkipped',
        reason: 'cancelled',
        attempted: true,
      });
      // attempted=true → 原地转普通文本，消息还在但不是卡片
      expect(handler._messages[convId]).toHaveLength(1);
      expect(handler._messages[convId][0].compaction).toBeUndefined();

      // 后续再触发压缩 → 新卡片，不复用旧 id
      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'pressure',
      });
      expect(handler._messages[convId]).toHaveLength(2);
      const card = handler._messages[convId][1];
      expect(card.compaction?.status).toBe('running');
      expect(getStreamState(taskId).compactionMessageId).toBe(card.id);
    });
  });
});
