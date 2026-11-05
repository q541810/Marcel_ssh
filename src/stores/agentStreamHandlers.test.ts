import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import {
  handleToolCallStart,
  handleToolCallDelta,
  settleComposing,
  handleToolResult,
  handleTextDelta,
  handleThinkingDelta,
  handleDone,
  handleCancelled,
  handleAwaitingParent,
  handleError,
  handleRetrying,
  markRoundEnded,
  handleCompactionStart,
  handleCompactionProgress,
  handleCompactionDone,
  handleCompactionSkipped,
  handleMessageSaved,
  getStreamState,
  cleanupStreamState,
  setStreamState,
  type StreamHandler,
} from '@/stores/agentStreamHandlers';
import type { AgentMessage, AgentTaskPlan, ToolResultPayload } from '@/lib/types';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { createDefaultStreamHandler } from '@/stores/storeStreamAdapter';
import { segmentTurns } from '@/lib/agentTurnFold';
import { mockHandler } from './streamHandlerMock';


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
  let rafCalls: (() => void)[];

  beforeEach(() => {
    cleanupStreamState(taskId);
    rafCalls = [];
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      rafCalls.push(cb);
      return rafCalls.length;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getStreamState / setStreamState / cleanupStreamState', () => {
    it('returns default state for unknown task', () => {
      const state = getStreamState('unknown');
      expect(state.assistantMessageId).toBeNull();
      expect(state.messageIndex).toBe(-1);
      expect(state.toolResultCount).toBe(0);
    });

    it('persists and retrieves state', () => {
      setStreamState(taskId, {
        assistantMessageId: 'msg-1',
        messageIndex: 3,
        toolResultCount: 2,
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

    it('参数撰写期间标记 isComposing，写完整参数后落旗；兜底可一次收全部', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, { type: 'toolCallStart', id: 'tc-c1', name: 'execute_command' });
      expect(handler._messages[convId][0].isComposing).toBe(true);

      handleToolCallDelta(handler, taskId, convId, { type: 'toolCallDelta', id: 'tc-c1', argumentsDelta: '{"command":"l' });
      expect(handler._messages[convId][0].isComposing).toBe(true);

      handleToolCallDelta(handler, taskId, convId, { type: 'toolCallDelta', id: 'tc-c1', argumentsDelta: 's"}' });
      expect(handler._messages[convId][0].isComposing).toBe(false);
      expect(handler._messages[convId][0].toolResult?.arguments).toEqual({ command: 'ls' });

      // 无参数工具没有 delta：靠兜底收尾
      handleToolCallStart(handler, taskId, convId, { type: 'toolCallStart', id: 'tc-c2', name: 'execute_command' });
      expect(handler._messages[convId][1].isComposing).toBe(true);
      settleComposing(handler, convId);
      expect(handler._messages[convId][1].isComposing).toBe(false);
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

    it('removes the waiting skeleton once the model decides to call a tool', () => {
      const handler = mockHandler({
        [convId]: [
          { id: 'loading-1', role: 'assistant', content: '', timestamp: '', isLoading: true },
        ],
      });

      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-1',
        name: 'execute_command',
      });

      const msgs = handler._messages[convId];
      expect(msgs.find((m) => m.isLoading)).toBeUndefined();
      expect(msgs.some((m) => m.role === 'tool')).toBe(true);
    });

    it('keeps buffered text tail when tool call starts in the same frame (regression: 半句截断)', () => {
      const handler = mockHandler({ [convId]: [] });
      const loadingId = 'loading-tail-1';

      // 正文尾巴尚未被 rAF flush（模拟同帧内 ToolCallStart 先到）
      handleTextDelta(handler, taskId, convId, loadingId, {
        type: 'textDelta',
        text: '确认 /adm_panel 是否被外部探测/爆破过——这是判定攻击面"是否被利用"的关键证据。',
      });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-tail-1',
        name: 'bash',
      });

      const msgs = handler._messages[convId];
      const assistant = msgs.find((m) => m.role === 'assistant');
      expect(assistant).toBeDefined();
      // 正文尾巴必须保留，不能停在半句
      expect(assistant?.content).toContain('是否被外部探测/爆破过');
      // 工具卡紧随其后
      const toolMsg = msgs.find((m) => m.role === 'tool');
      expect(toolMsg).toBeDefined();
      expect(msgs.indexOf(assistant!)).toBeLessThan(msgs.indexOf(toolMsg!));
      // buffer 已清空，无悬挂 rAF
      expect(getStreamState(taskId).pendingTextDelta).toBe('');
      expect(getStreamState(taskId).flushRafId).toBeNull();
    });

    it('drops only thinking buffer, keeps text tail, when both arrive before flush', () => {
      const handler = mockHandler({ [convId]: [] });
      const loadingId = 'loading-mixed-1';

      // 模拟：thinking 尾 + 正文尾 同帧未 flush，随后 ToolCallStart
      handleThinkingDelta(handler, taskId, convId, loadingId, {
        type: 'thinkingDelta',
        text: '这是临时思考，不应显示',
      });
      handleTextDelta(handler, taskId, convId, loadingId, {
        type: 'textDelta',
        text: '现在执行命令',
      });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-mixed-1',
        name: 'execute_command',
      });

      const msgs = handler._messages[convId];
      const assistant = msgs.find((m) => m.role === 'assistant');
      expect(assistant).toBeDefined();
      // 正文保留
      expect(assistant?.content).toBe('现在执行命令');
      // thinking 不显示（设计意图保留：临时思考在 tool call 前不残留）
      expect(assistant?.reasoningContent).toBeUndefined();
      expect(assistant?.isThinking).toBe(false);
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

    it('re-inserts a loading skeleton after the tool result (waiting for next round)', () => {
      const handler = mockHandler({ [convId]: [] });

      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-reinsert',
        name: 'read_file',
      });
      handleToolResult(handler, taskId, convId, 'loading-1', makeToolResult({
        toolCallId: 'tc-reinsert',
        toolName: 'read_file',
        summary: 'read done',
      }));

      const msgs = handler._messages[convId];
      expect(msgs.some((m) => m.role === 'tool')).toBe(true);
      const skeleton = msgs.find((m) => m.role === 'assistant' && m.isLoading);
      expect(skeleton).toBeDefined();
      // 骨架在消息流末尾：UI 上位于工具卡之后
      expect(msgs[msgs.length - 1]).toBe(skeleton);
    });

    it('keeps a single skeleton across parallel tool results', () => {
      const handler = mockHandler({ [convId]: [] });

      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-a',
        name: 'read_file',
      });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-b',
        name: 'read_file',
      });
      handleToolResult(handler, taskId, convId, 'loading-1', makeToolResult({ toolCallId: 'tc-a' }));
      handleToolResult(handler, taskId, convId, 'loading-1', makeToolResult({ toolCallId: 'tc-b' }));

      const skeletons = handler._messages[convId].filter(
        (m) => m.role === 'assistant' && m.isLoading,
      );
      expect(skeletons).toHaveLength(1);
    });

    it('consumes the re-inserted skeleton when next-round text arrives', () => {
      const handler = mockHandler({ [convId]: [] });

      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-flush',
        name: 'read_file',
      });
      handleToolResult(handler, taskId, convId, 'loading-1', makeToolResult({
        toolCallId: 'tc-flush',
        toolName: 'read_file',
      }));
      expect(handler._messages[convId].some((m) => m.isLoading)).toBe(true);

      handleTextDelta(handler, taskId, convId, 'loading-1', { type: 'textDelta', text: '结果' });
      rafCalls.forEach((cb) => cb());

      const msgs = handler._messages[convId];
      const assistant = msgs.find((m) => m.role === 'assistant');
      expect(assistant?.content).toBe('结果');
      expect(msgs.some((m) => m.isLoading)).toBe(false);
    });
  });

  describe('handleMessageSaved（落库 id 回填 live 消息）', () => {
    it('user 行：回填到最后一条还没 dbId 的 user 消息', () => {
      const handler = mockHandler({
        [convId]: [
          { id: 'u1', role: 'user', content: '第一轮', timestamp: '', dbId: 'db-u1' },
          { id: 'a1', role: 'assistant', content: '好了', timestamp: '', dbId: 'db-a1' },
          { id: 'u2', role: 'user', content: '第二轮', timestamp: '' },
        ],
      });

      handleMessageSaved(handler, taskId, convId, {
        type: 'messageSaved',
        conversationId: convId,
        role: 'user',
        dbId: 'db-u2',
      });

      const msgs = handler._messages[convId];
      expect(msgs.find((m) => m.id === 'u2')?.dbId).toBe('db-u2');
      // 只填空位，别的消息不动
      expect(msgs.find((m) => m.id === 'u1')?.dbId).toBe('db-u1');
      expect(msgs.find((m) => m.id === 'a1')?.dbId).toBe('db-a1');
    });

    it('assistant 行：回填到本轮正在写的文本消息（assistantMessageId）', () => {
      const handler = mockHandler({
        [convId]: [
          { id: 'u1', role: 'user', content: '跑', timestamp: '' },
          { id: 'a1', role: 'assistant', content: '第一段', timestamp: '' },
        ],
      });
      setStreamState(taskId, { ...getStreamState(taskId), assistantMessageId: 'a1' });

      handleMessageSaved(handler, taskId, convId, {
        type: 'messageSaved',
        conversationId: convId,
        role: 'assistant',
        dbId: 'db-a1',
      });

      expect(handler._messages[convId].find((m) => m.id === 'a1')?.dbId).toBe('db-a1');
    });

    it('纯工具轮（assistantMessageId 指着已回填的上一轮）：不覆盖已有 dbId', () => {
      const handler = mockHandler({
        [convId]: [
          { id: 'a1', role: 'assistant', content: '上一轮', timestamp: '', dbId: 'db-a1' },
        ],
      });
      setStreamState(taskId, { ...getStreamState(taskId), assistantMessageId: 'a1' });

      handleMessageSaved(handler, taskId, convId, {
        type: 'messageSaved',
        conversationId: convId,
        role: 'assistant',
        dbId: 'db-a2',
      });

      expect(handler._messages[convId].find((m) => m.id === 'a1')?.dbId).toBe('db-a1');
    });

    it('tool 行：按 toolCallId 定位工具卡片回填', () => {
      const handler = mockHandler({
        [convId]: [
          {
            id: 't1',
            role: 'tool',
            content: '',
            timestamp: '',
            toolResult: { toolName: 'read_file', summary: '', result: 'ok', success: true, blocked: false, toolCallId: 'call-7' },
          },
        ],
      });

      handleMessageSaved(handler, taskId, convId, {
        type: 'messageSaved',
        conversationId: convId,
        role: 'tool',
        dbId: 'db-t1',
        toolCallId: 'call-7',
      });

      expect(handler._messages[convId].find((m) => m.id === 't1')?.dbId).toBe('db-t1');
    });

    it('子 agent 的流（conversationId 不匹配）不写进当前会话', () => {
      const handler = mockHandler({ [convId]: [{ id: 'u1', role: 'user', content: 'x', timestamp: '' }] });

      handleMessageSaved(handler, taskId, convId, {
        type: 'messageSaved',
        conversationId: 'sub-conv-9',
        role: 'user',
        dbId: 'db-other',
      });

      expect(handler._messages[convId].find((m) => m.id === 'u1')?.dbId).toBeUndefined();
    });

    it('没有可定位的消息（如空回合）：不动消息列表', () => {
      const handler = mockHandler({ [convId]: [] });

      handleMessageSaved(handler, taskId, convId, {
        type: 'messageSaved',
        conversationId: convId,
        role: 'assistant',
        dbId: 'db-x',
      });

      expect(handler._messages[convId]).toEqual([]);
    });
  });

  describe('handleDone', () => {
    it('marks task completed and cleans up', () => {
      const handler = mockHandler({ [convId]: [] });
      const loadingId = 'loading-done';

      handleDone(handler, taskId, convId, loadingId);

      expect(handler._taskStatuses[taskId]).toBe('completed');
    });

    it('把尾回合标成 completed（覆盖重载留下的 running，回合才能正常折叠）', () => {
      // 任务跑着的时候重载过会话 → 锚点上是从库里读到的 running
      useConversationStore.setState({
        messages: {
          [convId]: [
            { id: 'u1', role: 'user', content: '跑一下', timestamp: '', turnState: 'running' },
            { id: 'a1', role: 'assistant', content: '好了', timestamp: '' },
          ],
        },
      });

      handleDone(mockHandler({ [convId]: [] }), taskId, convId, 'loading-done');

      expect(useConversationStore.getState().messages[convId][0].turnState).toBe('completed');
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

    it('removes per-round skeletons (rebuilt after tool results) on done', () => {
      const handler = mockHandler({
        [convId]: [
          {
            id: 'tool-1',
            role: 'tool',
            content: '',
            timestamp: '',
            toolResult: {
              toolName: 'read_file',
              summary: '',
              result: 'ok',
              success: true,
              blocked: false,
            },
          },
          { id: 'skeleton-2', role: 'assistant', content: '', timestamp: '', isLoading: true },
        ],
      });

      handleDone(handler, taskId, convId, 'loading-done');

      const msgs = handler._messages[convId];
      expect(msgs.find((m) => m.id === 'skeleton-2')).toBeUndefined();
    });
  });

  describe('handleError', () => {
    it('把尾回合标成 failed —— 出错停的回合不折叠（错误提示不会被折叠吞掉）', () => {
      useConversationStore.setState({
        messages: {
          [convId]: [
            { id: 'u1', role: 'user', content: '跑一下', timestamp: '' },
            { id: 'a1', role: 'assistant', content: '半截文本', timestamp: '' },
          ],
        },
      });

      handleError(mockHandler({ [convId]: [] }), taskId, convId, 'loading-err', {
        type: 'error',
        message: 'boom',
      });

      const msgs = useConversationStore.getState().messages[convId];
      expect(msgs[0].turnState).toBe('failed');
      expect(msgs[1].turnState).toBeUndefined();
    });

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

    it('removes per-round skeletons on error', () => {
      const handler = mockHandler({
        [convId]: [
          { id: 'skeleton-3', role: 'assistant', content: '', timestamp: '', isLoading: true },
        ],
      });

      handleError(handler, taskId, convId, 'loading-err', {
        type: 'error',
        message: 'boom',
      });

      expect(handler._messages[convId].find((m) => m.isLoading)).toBeUndefined();
    });
  });

  describe('handleRetrying discardPartial', () => {
    const flush = () => rafCalls.splice(0).forEach((cb) => cb());
    const ev = { type: 'retrying' as const, attempt: 2, maxAttempts: 4, delaySecs: 1, lastError: 'net', discardPartial: true };

    it('removes the assistant bubble created this round and shows skeleton', () => {
      const handler = mockHandler({ [convId]: [{ id: 'u1', role: 'user', content: 'hi', timestamp: '' }] });
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: 'half' });
      flush();
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: ' more' });
      handleRetrying(handler, taskId, convId, ev);
      const msgs = handler._messages[convId];
      expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'system']);
      expect(msgs[1].isLoading).toBe(true);
      expect(msgs[2].isRetrying).toBe(true);
      expect(getStreamState(taskId).assistantMessageId).toBeNull();
      // 缓冲未提交
      flush();
      expect(handler._messages[convId].some((m) => m.content.includes('more'))).toBe(false);
    });

    it('被丢弃的半截正文留在重试指示消息上（淡出显示用），不留在对话消息里', () => {
      const handler = mockHandler({ [convId]: [{ id: 'u1', role: 'user', content: 'hi', timestamp: '' }] });
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: '读到一半' });
      flush();
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: '的内容' });
      handleRetrying(handler, taskId, convId, ev);
      const msgs = handler._messages[convId];
      const indicator = msgs.find((m) => m.isRetrying)!;
      expect(indicator.retryPartialText).toBe('读到一半');
      expect(indicator.retryMidStream).toBe(true);
      // 其余消息里没有半截（不会入库 / 进模型历史 / 与新输出重复）
      expect(msgs.filter((m) => !m.isRetrying).some((m) => m.content.includes('读到一半'))).toBe(false);
    });

    it('追加进已有气泡的那一段：只淡出本轮追加的尾巴，前面已提交的不动', () => {
      const handler = mockHandler({
        [convId]: [{ id: 'a0', role: 'assistant', content: '上一轮的正文', timestamp: '' }],
      });
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: '本轮半截' });
      flush();
      handleRetrying(handler, taskId, convId, ev);
      const msgs = handler._messages[convId];
      expect(msgs.find((m) => m.id === 'a0')?.content).toBe('上一轮的正文');
      expect(msgs.find((m) => m.isRetrying)?.retryPartialText).toBe('本轮半截');
    });

    it('连续重试中间没有新输出：沿用上一次的半截，不丢', () => {
      const handler = mockHandler({ [convId]: [] });
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: '半截' });
      flush();
      handleRetrying(handler, taskId, convId, ev);
      handleRetrying(handler, taskId, convId, { ...ev, attempt: 3 });
      const indicators = handler._messages[convId].filter((m) => m.isRetrying);
      expect(indicators).toHaveLength(1);
      expect(indicators[0].retryPartialText).toBe('半截');
      expect(indicators[0].retryAttempt).toBe(2);
    });

    it('重试后的新输出开始上屏：指示消息（连同半截）被替换，只剩新输出', () => {
      const handler = mockHandler({ [convId]: [] });
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: '旧半截' });
      flush();
      handleRetrying(handler, taskId, convId, ev);
      expect(handler._messages[convId].some((m) => m.retryPartialText === '旧半截')).toBe(true);

      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: '新输出' });
      flush();
      const msgs = handler._messages[convId];
      expect(msgs.some((m) => m.isRetrying)).toBe(false);
      expect(msgs.some((m) => m.retryPartialText)).toBe(false);
      expect(msgs.filter((m) => m.role === 'assistant' && !m.isLoading).map((m) => m.content)).toEqual(['新输出']);
    });

    it('没有半截（还没出字就断了）：指示消息不带 retryPartialText', () => {
      const handler = mockHandler({ [convId]: [] });
      handleRetrying(handler, taskId, convId, ev);
      const indicator = handler._messages[convId].find((m) => m.isRetrying)!;
      expect(indicator.retryPartialText).toBeUndefined();
    });

    it('drops tool cards opened this round', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, { type: 'toolCallStart', id: 'tc-d1', name: 'execute_command' });
      handleRetrying(handler, taskId, convId, ev);
      const msgs = handler._messages[convId];
      expect(msgs.some((m) => m.role === 'tool')).toBe(false);
      expect(getStreamState(taskId).pendingToolCalls.size).toBe(0);
    });

    it('markRoundEnded keeps a finished tool-less round out of the next round retry', () => {
      const handler = mockHandler({ [convId]: [{ id: 'u1', role: 'user', content: 'hi', timestamp: '' }] });
      // 第一轮：纯文本，无工具，尾巴还在缓冲里就收到本轮结束
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: 'round1' });
      flush();
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: '-tail' });
      markRoundEnded(taskId);
      expect(getStreamState(taskId).roundMark).toBeNull();
      // 第二轮续写同一气泡，随后流中途重试
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: ' round2' });
      flush();
      handleRetrying(handler, taskId, convId, ev);
      const assistant = handler._messages[convId].find((m) => m.role === 'assistant' && !m.isLoading);
      expect(assistant?.content).toBe('round1-tail');
    });

    it('does not discard when flag is absent', () => {
      const handler = mockHandler({ [convId]: [] });
      handleTextDelta(handler, taskId, convId, '', { type: 'textDelta', text: 'keep' });
      flush();
      handleRetrying(handler, taskId, convId, { ...ev, discardPartial: false });
      expect(handler._messages[convId].some((m) => m.content === 'keep')).toBe(true);
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

    it('render_html: 流式期间从不完整 JSON 提取 partial fragment 实时预览', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-html-1',
        name: 'render_html',
      });

      handleToolCallDelta(handler, taskId, convId, {
        type: 'toolCallDelta',
        id: 'tc-html-1',
        argumentsDelta: '{"title":"CPU 图表","mode":"wide","fragment":"<section><h1>CPU',
      });

      const args = handler._messages[convId][0].toolResult?.arguments;
      expect(args).toBeDefined();
      expect(args?.title).toBe('CPU 图表');
      expect(args?.mode).toBe('wide');
      expect(args?.fragment).toBe('<section><h1>CPU');
      expect(args?.__streaming).toBe(true);
    });

    it('render_html: JSON 完整后走完整 parse，__streaming 标记消失', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-html-2',
        name: 'render_html',
      });

      handleToolCallDelta(handler, taskId, convId, {
        type: 'toolCallDelta',
        id: 'tc-html-2',
        argumentsDelta: '{"title":"t","fragment":"<p>done</p>"}',
      });

      const args = handler._messages[convId][0].toolResult?.arguments;
      expect(args).toEqual({ title: 't', fragment: '<p>done</p>' });
      expect(args?.__streaming).toBeUndefined();
    });

    it('非白名单工具不做 partial 提取（不完整 JSON 仍不回填）', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-wf-1',
        name: 'write_file',
      });

      handleToolCallDelta(handler, taskId, convId, {
        type: 'toolCallDelta',
        id: 'tc-wf-1',
        argumentsDelta: '{"path":"/tmp/x","html":"<div>',
      });
      expect(handler._messages[convId][0].toolResult?.arguments).toBeUndefined();
    });

    it('长参数只 parse 到语法完整为止：parse 次数不随分片数增长', () => {
      // 旧实现每个 delta 都对累计全文 JSON.parse（Θ(B²)）；
      // 回归门槛：完整前 0 次、完整时 1 次，parse 输入总量 ≈ 参数本身大小。
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-big-1',
        name: 'write_file',
      });

      const content = `x${'y'.repeat(128 * 1024)}`;
      const fullArgs = JSON.stringify({ path: '/tmp/big.txt', content });
      const chunkSize = 64;
      const parseCalls: number[] = [];
      const parseSpy = vi.spyOn(JSON, 'parse');
      const recordCalls = () => parseSpy.mock.calls.forEach((c) => parseCalls.push((c[0] as string).length));
      try {
        for (let i = 0; i < fullArgs.length; i += chunkSize) {
          handleToolCallDelta(handler, taskId, convId, {
            type: 'toolCallDelta',
            id: 'tc-big-1',
            argumentsDelta: fullArgs.slice(i, i + chunkSize),
          });
        }
        recordCalls();
      } finally {
        parseSpy.mockRestore();
      }

      expect(parseCalls).toHaveLength(1);
      expect(parseCalls[0]).toBe(fullArgs.length);
      const args = handler._messages[convId][0].toolResult?.arguments as {
        path: string;
        content: string;
      };
      expect(args.path).toBe('/tmp/big.txt');
      expect(args.content).toBe(content);
    });

    it('render_html: 末片完整参数即时发布，不被 150ms 节流门延迟', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-html-3',
        name: 'render_html',
      });

      // 第一帧先建立预览（同样时刻），第二帧带着闭合括号到达 —— 两者在同一毫秒，
      // 节流门若是罩住了完整 parse 分支，参数就会滞留在 __streaming 草稿上。
      handleToolCallDelta(handler, taskId, convId, {
        type: 'toolCallDelta',
        id: 'tc-html-3',
        argumentsDelta: '{"title":"t","fragment":"<p>tail',
      });
      expect(handler._messages[convId][0].toolResult?.arguments?.__streaming).toBe(true);

      handleToolCallDelta(handler, taskId, convId, {
        type: 'toolCallDelta',
        id: 'tc-html-3',
        argumentsDelta: '</p>"}',
      });
      const args = handler._messages[convId][0].toolResult?.arguments;
      expect(args).toEqual({ title: 't', fragment: '<p>tail</p>' });
      expect(args?.__streaming).toBeUndefined();
    });

    it('语法完整但 parse 失败（坏转义）不进入反复 parse，预览照常', () => {
      const handler = mockHandler({ [convId]: [] });
      handleToolCallStart(handler, taskId, convId, {
        type: 'toolCallStart',
        id: 'tc-bad-1',
        name: 'render_html',
      });

      const parseSpy = vi.spyOn(JSON, 'parse');
      try {
        // \u 后面跟着非 hex：语法完整（引号与括号都闭合）但 JSON.parse 必失败
        handleToolCallDelta(handler, taskId, convId, {
          type: 'toolCallDelta',
          id: 'tc-bad-1',
          argumentsDelta: '{"title":"\\uZZ","fragment":"<p>x</p>"}',
        });
        const parseCallsAfterComplete = parseSpy.mock.calls.length;
        expect(parseCallsAfterComplete).toBeLessThanOrEqual(1);

        // 后续 delta（provider 尾巴/重传）不再触发第二次 parse
        handleToolCallDelta(handler, taskId, convId, {
          type: 'toolCallDelta',
          id: 'tc-bad-1',
          argumentsDelta: ' ',
        });
        expect(parseSpy.mock.calls.length).toBe(parseCallsAfterComplete);
      } finally {
        parseSpy.mockRestore();
      }
      // 失败后参数不回填，等 toolResult 收尾
      expect(handler._messages[convId][0].toolResult?.arguments).toBeUndefined();
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
      // 合帧：进度攒到下一帧才提交
      rafCalls.forEach((cb) => cb());

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

    it('coalesces many progress events within a frame into a single store commit', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'pressure',
      });
      const original = handler.updateMessages;
      const commits = vi.fn(original);
      handler.updateMessages = commits;

      for (let i = 1; i <= 200; i++) {
        handleCompactionProgress(handler, taskId, convId, {
          type: 'compactionProgress',
          text: `summary ${i}`,
        });
      }
      // 帧还没到：一次都没碰 store，且只排了一个 rAF
      expect(commits).not.toHaveBeenCalled();
      expect(rafCalls).toHaveLength(1);

      rafCalls.forEach((cb) => cb());
      expect(commits).toHaveBeenCalledTimes(1);
      expect(handler._messages[convId][0].compaction?.summary).toBe('summary 200');
      expect(getStreamState(taskId).compactionRafId).toBeNull();
      expect(getStreamState(taskId).pendingCompactionText).toBeNull();
    });

    it('drops un-flushed progress when the card is finalized, so a late frame cannot revive it', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'manual',
      });
      handleCompactionProgress(handler, taskId, convId, {
        type: 'compactionProgress',
        text: 'half a summary',
      });
      handleCompactionDone(handler, taskId, convId, {
        type: 'compactionDone',
        summary: 'final summary',
        shadowedMessages: 4,
        shadowedTokens: 1200,
        tailDbId: null,
      });
      // 定稿后迟到的那一帧（真实 rAF 已被取消；这里模拟最坏情况它仍被调用）
      rafCalls.forEach((cb) => cb());

      const cards = handler._messages[convId].filter((m) => m.compaction);
      expect(cards).toHaveLength(1);
      expect(cards[0].compaction?.status).toBe('done');
      expect(cards[0].compaction?.summary).toBe('final summary');
      expect(cancelAnimationFrame).toHaveBeenCalled();
    });

    it('cleanup cancels the pending progress frame', () => {
      const handler = mockHandler({ [convId]: [] });
      handleCompactionStart(handler, taskId, convId, {
        type: 'compactionStart',
        trigger: 'pressure',
      });
      handleCompactionProgress(handler, taskId, convId, {
        type: 'compactionProgress',
        text: 'partial',
      });
      cleanupStreamState(taskId);
      expect(cancelAnimationFrame).toHaveBeenCalled();
      expect(getStreamState(taskId).pendingCompactionText).toBeNull();
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

  /**
   * 取消终止（`StreamEvent::Cancelled`）：后端取消路径发的终态事件。
   * 与 `handleDone` 的差别必须钉住 —— 把取消当自然结束处理就会出现
   * 「卡片没了但 agent 还能看到」：在飞卡片被删 + 回合被标 completed 折叠。
   *
   * 这一段用**真实 adapter + 真实 store**（不用 mockHandler）：本特性的要害正是
   * 「在飞卡片 / 回合收尾状态 / 任务状态」三处落到同一份真实状态上，假 handler
   * 会把它们分别记在私有 map 里，测不到真实装配。
   */
  describe('handleAwaitingParent', () => {
    function seed() {
      useConversationStore.setState({
        messages: {
          [convId]: [
            { id: 'u1', role: 'user', content: '查日志', timestamp: '' },
            { id: 'a1', role: 'assistant', content: '我先看看。', timestamp: '' },
            {
              id: 'ask', role: 'tool', content: '', timestamp: '', isExecuting: true, isComposing: true,
              toolResult: { toolName: 'ask_parent', summary: '', result: '', success: true, blocked: false, toolCallId: 'ask-1', arguments: { question: 'Q' } },
            },
            { id: 'skel', role: 'assistant', content: '', timestamp: '', isLoading: true },
          ],
        },
        activeConversationId: convId,
      });
      useTaskStore.setState({
        tasks: {
          [taskId]: { id: taskId, sessionId: 's1', conversationId: convId, prompt: 'p', mode: 'plan', status: 'executing', createdAt: '' },
        },
      });
    }
    const msgs = () => useConversationStore.getState().messages[convId];

    it('保留在等回答的 ask_parent 卡片（不当成没跑完的调用删掉），撰写态收掉让气泡登场', () => {
      seed();
      handleAwaitingParent(createDefaultStreamHandler(), taskId, convId, 'skel');
      const ask = msgs().find((m) => m.id === 'ask')!;
      expect(ask).toBeDefined();
      expect(ask.isExecuting).toBe(true);
      expect(ask.isComposing).toBe(false);
      expect(msgs().some((m) => m.isLoading)).toBe(false);
    });

    it('任务记 awaiting_parent（不占席位）；回合写 awaiting_parent，不折叠、不是 completed', () => {
      seed();
      handleAwaitingParent(createDefaultStreamHandler(), taskId, convId, 'skel');
      expect(useTaskStore.getState().tasks[taskId].status).toBe('awaiting_parent');
      expect(msgs()[0].turnState).toBe('awaiting_parent');
      expect(segmentTurns(msgs(), { tailActive: false })[0].foldable).toBe(false);
    });
  });

  describe('handleCancelled', () => {
    /** 停止瞬间的真实形态：过场正文与工具卡交替，最后一张在飞。 */
    function stoppedTurnMessages(): AgentMessage[] {
      const tool = (id: string, executing: boolean): AgentMessage => ({
        id,
        role: 'tool',
        content: '',
        timestamp: '',
        isExecuting: executing,
        toolResult: {
          toolName: 'bash',
          summary: '$ ls',
          result: '',
          success: true,
          blocked: false,
          toolCallId: `call-${id}`,
        },
      });
      return [
        { id: 'u1', role: 'user', content: '改版本号', timestamp: '' },
        { id: 'a1', role: 'assistant', content: '先看仓库。', timestamp: '' },
        tool('t1', false),
        { id: 'a2', role: 'assistant', content: '再看提交记录。', timestamp: '' },
        tool('t2', false),
        tool('t3', false),
        { id: 'a4', role: 'assistant', content: '再看打包脚本。', timestamp: '' },
        tool('t4', true), // 在飞
        { id: 'skel', role: 'assistant', content: '', timestamp: '', isLoading: true },
      ];
    }

    function seedStopMoment() {
      useConversationStore.setState({
        messages: { [convId]: stoppedTurnMessages() },
        activeConversationId: convId,
      });
      useTaskStore.setState({
        tasks: {
          [taskId]: {
            id: taskId,
            sessionId: 's1',
            conversationId: convId,
            prompt: 'p',
            mode: 'agent',
            status: 'executing',
            createdAt: '',
          },
        },
      });
    }

    const convMsgs = () => useConversationStore.getState().messages[convId];

    function tailFoldable(): boolean {
      const segs = segmentTurns(convMsgs(), { tailActive: false });
      return segs[segs.length - 1].foldable;
    }

    it('保留在飞的工具卡片（标成已中断）而不是删掉', () => {
      seedStopMoment();

      handleCancelled(createDefaultStreamHandler(), taskId, convId, 'skel');

      const inFlight = convMsgs().find((m) => m.id === 't4');
      expect(inFlight).toBeDefined();
      expect(inFlight!.isExecuting).toBe(false);
      expect(inFlight!.toolResult?.wasAborted).toBe(true);
      expect(inFlight!.toolResult?.result).toContain('已停止等待输出并关闭 SSH 通道');
    });

    it('回合收尾状态写 cancelled → 过程不被折叠吞掉；任务记 cancelled', () => {
      seedStopMoment();

      handleCancelled(createDefaultStreamHandler(), taskId, convId, 'skel');

      expect(convMsgs()[0].turnState).toBe('cancelled');
      expect(useTaskStore.getState().tasks[taskId].status).toBe('cancelled');
      // 长回合（>= 3 张工具卡）本来"长得像"可以折叠 —— 收尾状态必须否决它
      expect(tailFoldable()).toBe(false);
    });

    it('留下正文、清掉骨架与空 assistant 残留（与 Done 同一套清理）', () => {
      seedStopMoment();

      handleCancelled(createDefaultStreamHandler(), taskId, convId, 'skel');

      expect(convMsgs().some((m) => m.isLoading)).toBe(false);
      expect(convMsgs().some((m) => m.id === 'skel')).toBe(false);
      expect(convMsgs().find((m) => m.id === 'a4')?.content).toBe('再看打包脚本。');
    });

    it('对照：同形态下 Done（模型自然结束）才收走卡片、标 completed、允许折叠', () => {
      seedStopMoment();

      handleDone(createDefaultStreamHandler(), taskId, convId, 'skel');

      expect(convMsgs().some((m) => m.id === 't4')).toBe(false); // 在飞卡片被删
      expect(convMsgs()[0].turnState).toBe('completed');
      expect(useTaskStore.getState().tasks[taskId].status).toBe('completed');
      expect(tailFoldable()).toBe(true);
    });
  });
});
