import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import {
  deriveSubagentMessages,
  pendingAskParent,
  pendingAskMessageId,
  resolveSubagentThreadMessageId,
  resolveToolCallMessageId,
  threadSummaryLabel,
} from '@/lib/subagentThread';
import { segmentTurns, turnStopVetoed } from '@/lib/agentTurnFold';
import { summarizeToolCalls } from '@/lib/toolCallSummary';
import { resolveJumpRequest } from '@/lib/jumpResolve';
import { completeQuestionSource, readSourceSubagentId, subagentDisplayTitle } from '@/lib/subagentNav';

const ts = '2026-11-01T00:00:00Z';
const SUB = 'sub-conv-1';

const user = (id: string): AgentMessage => ({ id, role: 'user', content: id, timestamp: ts });
const text = (id: string, content = '总结'): AgentMessage => ({ id, role: 'assistant', content, timestamp: ts });

function dispatch(
  id: string,
  metadata?: Record<string, unknown>,
  over: Partial<AgentMessage> = {},
  name = 'subagent',
): AgentMessage {
  return {
    id, role: 'tool', content: '', timestamp: ts,
    toolResult: {
      toolName: name, summary: '', result: '子任务结果', success: true, blocked: false,
      toolCallId: `${id}-call`,
      arguments: { description: '查日志', prompt: '去查 nginx 日志' },
      metadata,
    },
    ...over,
  };
}
const asked = (id: string, question = '用哪个目录？', context: string | null = '背景'): AgentMessage =>
  dispatch(id, { kind: 'subagentAsk', subConversationId: SUB, askToolCallId: 'ask-1', question, context });
const cont = (id: string, prompt: string, metadata?: Record<string, unknown>, over: Partial<AgentMessage> = {}): AgentMessage => ({
  ...dispatch(id, metadata, over),
  toolResult: {
    toolName: 'subagent', summary: '', result: '继续后的结果', success: true, blocked: false,
    toolCallId: `${id}-call`, arguments: { continue_id: SUB, prompt }, metadata,
  },
  ...over,
});
const done = { subTaskId: 't', subConversationId: SUB, status: 'completed' };

describe('deriveSubagentMessages 分组', () => {
  it('单次派发（没有提问、没有续派）原样返回，工具卡不受影响', () => {
    const m = [user('u'), dispatch('d1', done), text('a')];
    const r = deriveSubagentMessages(m, { tailActive: false });
    expect(r.threads.size).toBe(0);
    expect(r.messages).toEqual(m);
    expect(r.messages[1]).toBe(m[1]);
  });

  it('首次派发 + 回答续派 并成一张卡，续派卡被吸收，锚点留在第一张的位置', () => {
    const d1 = asked('d1');
    const d2 = cont('d2', '用 /var/log', done);
    const r = deriveSubagentMessages([user('u'), d1, text('mid'), d2, text('end')], { tailActive: false });
    expect(r.messages.map((m) => m.id)).toEqual(['u', 'd1', 'mid', 'end']);
    expect(r.absorbed.get('d2')).toBe('d1');
    const thread = r.messages[1].subagentThread!;
    expect(thread.subConversationId).toBe(SUB);
    expect(thread.title).toBe('查日志');
    expect(thread.askCount).toBe(1);
    expect(thread.state).toBe('completed');
    expect(thread.items.map((i) => i.kind)).toEqual(['dispatch', 'ask', 'answer', 'outcome']);
    const answer = thread.items[2];
    expect(answer.kind === 'answer' && answer.text).toBe('用 /var/log');
    const ask = thread.items[1];
    expect(ask.kind === 'ask' && ask.state).toBe('answered');
    expect(ask.kind === 'ask' && ask.question).toBe('用哪个目录？');
  });

  it('续派不是回答（上一次是正常完成）→ 追问，不是回答', () => {
    const r = deriveSubagentMessages([user('u'), dispatch('d1', done), cont('d2', '再查下 error', done)], { tailActive: false });
    const items = r.messages[1].subagentThread!.items;
    expect(items.map((i) => i.kind)).toEqual(['dispatch', 'outcome', 'followUp', 'outcome']);
    expect(r.messages[1].subagentThread!.askCount).toBe(0);
    // 没提问的续派仍并成一张卡，但不产生「问过」摘要
    expect(threadSummaryLabel(r.messages[1].subagentThread)).toBeNull();
  });

  it('多次提问：问过 N 次，摘要标签里带上', () => {
    const d1 = asked('d1', 'Q1');
    const d2 = cont('d2', 'A1', { kind: 'subagentAsk', subConversationId: SUB, askToolCallId: 'ask-2', question: 'Q2', context: null });
    const d3 = cont('d3', 'A2', done);
    const r = deriveSubagentMessages([user('u'), d1, d2, d3], { tailActive: false });
    const thread = r.messages[1].subagentThread!;
    expect(thread.askCount).toBe(2);
    expect(thread.items.map((i) => i.kind)).toEqual(['dispatch', 'ask', 'answer', 'ask', 'answer', 'outcome']);
    expect(threadSummaryLabel(thread)).toBe('子 Agent · 查日志（问过 2 次）');
  });

  it('分组只看子对话 id：两个不同子 agent 互不吞并', () => {
    const other: AgentMessage = dispatch('x1', { subConversationId: 'sub-2', status: 'completed' });
    const r = deriveSubagentMessages([user('u'), asked('d1'), other], { tailActive: true });
    expect(r.messages.map((m) => m.id)).toEqual(['u', 'd1', 'x1']);
    expect(r.messages[2]).toBe(other);
  });

  it('local_subagent 与 subagent 通过同一个子对话 id 也能并组（按 continue_id）', () => {
    const d1 = dispatch('d1', { kind: 'subagentAsk', subConversationId: SUB, askToolCallId: 'a', question: 'q', context: null }, {}, 'local_subagent');
    const d2: AgentMessage = {
      ...cont('d2', '答', done),
      toolResult: { ...cont('d2', '答', done).toolResult!, toolName: 'local_subagent' },
    };
    const r = deriveSubagentMessages([user('u'), d1, d2], { tailActive: false });
    expect(r.messages).toHaveLength(2);
    expect(r.messages[1].subagentThread!.items.map((i) => i.kind)).toEqual(['dispatch', 'ask', 'answer', 'outcome']);
  });

  it('续派调用还在执行（metadata 尚未回填）：靠 continue_id 就能并进去，整张卡为执行中', () => {
    const d1 = asked('d1');
    const d2 = cont('d2', '答', undefined, { isExecuting: true });
    const r = deriveSubagentMessages([user('u'), d1, d2], { tailActive: true });
    const anchor = r.messages[1];
    expect(anchor.isExecuting).toBe(true);
    expect(anchor.subagentThread!.state).toBe('running');
    expect(anchor.subagentThread!.items[anchor.subagentThread!.items.length - 1]).toMatchObject({ kind: 'outcome', state: 'running' });
  });

  it('结果 metadata 里的子对话 id 与参数 continue_id 重载后同样分组', () => {
    // 重载：没有 isExecuting，都靠 metadata
    const r = deriveSubagentMessages([user('u'), asked('d1'), cont('d2', '答', done)], { tailActive: false });
    expect(r.threads.has('d1')).toBe(true);
  });
});

describe('提问状态：等回答 / 未回答', () => {
  it('主 Agent 这一轮还在跑 → 等待回答', () => {
    const r = deriveSubagentMessages([user('u'), asked('d1')], { tailActive: true });
    const t = r.messages[1].subagentThread!;
    expect(t.state).toBe('waiting');
    expect(t.items[1]).toMatchObject({ kind: 'ask', state: 'waiting' });
  });

  it('主 Agent 这一轮结束了还没回答 → 未回答（不是「运行中」）', () => {
    const r = deriveSubagentMessages([user('u'), asked('d1'), text('end', '我先停在这')], { tailActive: false });
    const t = r.messages[1].subagentThread!;
    expect(t.state).toBe('unanswered');
    expect(t.items[1]).toMatchObject({ state: 'unanswered' });
  });

  it('旧回合里没回答的提问，即使现在有新一轮在跑，也是未回答', () => {
    const r = deriveSubagentMessages([user('u1'), asked('d1'), text('a1'), user('u2'), text('a2')], { tailActive: true });
    expect(r.messages[1].subagentThread!.state).toBe('unanswered');
  });
});

describe('折叠与计数', () => {
  it('时间线卡在回合折叠里只算一个过程项（subagentCount 1）', () => {
    const msgs = [
      user('u'),
      dispatch('t1', done, {}, 'bash'),
      dispatch('t2', done, {}, 'bash'),
      asked('d1'),
      cont('d2', '答', done),
      text('end'),
    ];
    const r = deriveSubagentMessages(msgs, { tailActive: false });
    const [seg] = segmentTurns(r.messages, { tailActive: false });
    expect(seg.toolCallCount).toBe(3);
    expect(seg.subagentCount).toBe(1);
    expect(seg.foldable).toBe(true);
  });

  it('折叠摘要里写「子 Agent · 标题（问过 N 次）」', () => {
    const r = deriveSubagentMessages([user('u'), asked('d1'), cont('d2', '答', done)], { tailActive: false });
    expect(summarizeToolCalls(r.messages)).toEqual([{ toolName: '子 Agent · 查日志（问过 1 次）', count: 1 }]);
  });

  it('没有提问的子 agent 摘要仍叫 subagent', () => {
    const r = deriveSubagentMessages([user('u'), dispatch('d1', done)], { tailActive: false });
    expect(summarizeToolCalls(r.messages)).toEqual([{ toolName: 'subagent', count: 1 }]);
  });

  it('awaiting_parent 的回合不折叠（非正常结束）', () => {
    expect(turnStopVetoed('awaiting_parent')).toBe(true);
  });
});

describe('子对话一侧：未回答的 ask_parent', () => {
  const issuer: AgentMessage = {
    id: 'a1', role: 'assistant', content: '', timestamp: ts,
    toolCalls: [{ id: 'ask-1', name: 'ask_parent', arguments: { question: '路径？', context: '背景' }, disposition: 'Allow' }],
  };

  it('重载后只有 toolCalls、没有结果行：补一条占位 tool 消息（执行中）', () => {
    const r = deriveSubagentMessages([user('u'), issuer], { tailActive: false });
    expect(r.messages.map((m) => m.id)).toEqual(['u', 'a1', pendingAskMessageId('ask-1')]);
    expect(r.messages[2].isExecuting).toBe(true);
    expect(r.messages[2].toolResult?.arguments?.question).toBe('路径？');
  });

  it('已回答（有结果行）不补占位', () => {
    const answered: AgentMessage = {
      id: 't1', role: 'tool', content: '', timestamp: ts,
      toolResult: { toolName: 'ask_parent', summary: '', result: '用 /var', success: true, blocked: false, toolCallId: 'ask-1', arguments: {}, metadata: { kind: 'parentAnswer' } },
    };
    const r = deriveSubagentMessages([user('u'), issuer, answered], { tailActive: false });
    expect(r.messages).toHaveLength(3);
    expect(pendingAskParent([user('u'), issuer, answered])).toBeNull();
  });

  it('pendingAskParent：live 的执行中 tool 消息 / 重载的 toolCalls 都认；其后有新回合就不算', () => {
    const live: AgentMessage = {
      id: 't1', role: 'tool', content: '', timestamp: ts, isExecuting: true,
      toolResult: { toolName: 'ask_parent', summary: '', result: '', success: true, blocked: false, toolCallId: 'ask-1', arguments: { question: 'Q' } },
    };
    expect(pendingAskParent([user('u'), live])?.question).toBe('Q');
    expect(pendingAskParent([user('u'), issuer])?.toolCallId).toBe('ask-1');
    expect(pendingAskParent([user('u'), issuer, user('u2')])).toBeNull();
  });
});

describe('跳转解析', () => {
  it('tool：按调用 id 找 tool 行；子对话里未回答的用占位 id', () => {
    const t = dispatch('d1', done);
    expect(resolveToolCallMessageId([t], 'd1-call')).toBe('d1');
    const issuer: AgentMessage = {
      id: 'a1', role: 'assistant', content: '', timestamp: ts,
      toolCalls: [{ id: 'ask-1', name: 'ask_parent', arguments: {}, disposition: 'Allow' }],
    };
    expect(resolveToolCallMessageId([issuer], 'ask-1')).toBe(pendingAskMessageId('ask-1'));
    expect(resolveToolCallMessageId([issuer], 'nope')).toBeNull();
  });

  it('thread：按子对话 id 找原始消息里最早的那条（= 时间线卡锚点）', () => {
    const msgs = [user('u'), asked('d1'), cont('d2', '答', done)];
    expect(resolveSubagentThreadMessageId(msgs, SUB)).toBe('d1');
    expect(resolveSubagentThreadMessageId(msgs, 'zzz')).toBeNull();
  });

  it('resolveJumpRequest 两种 kind；找不到返回 null', () => {
    const msgs = [user('u'), asked('d1')];
    expect(resolveJumpRequest(msgs, { kind: 'thread', toolCallId: SUB })).toEqual({ id: 'd1' });
    expect(resolveJumpRequest(msgs, { kind: 'tool', toolCallId: 'd1-call' })).toEqual({ id: 'd1' });
    expect(resolveJumpRequest(msgs, { kind: 'tool', toolCallId: 'q-none' })).toBeNull();
  });
});

describe('ask_user 的 source_subagent', () => {
  it('参数是子对话 id 字符串（兼容对象写法）；没有就是空', () => {
    expect(readSourceSubagentId({ source_subagent: ' sub-1 ' })).toBe('sub-1');
    expect(readSourceSubagentId({ source_subagent: { conversationId: 'sub-2' } })).toBe('sub-2');
    expect(readSourceSubagentId({})).toBe('');
    expect(readSourceSubagentId(undefined)).toBe('');
  });

  it('补全：标题取子对话标题，ask_parent 调用 id 取子对话里最后一次提问', () => {
    const msgs: AgentMessage[] = [
      user('u'),
      { id: 'a', role: 'assistant', content: '', timestamp: ts, toolCalls: [{ id: 'ask-9', name: 'ask_parent', arguments: {}, disposition: 'Allow' }] },
    ];
    expect(completeQuestionSource('sub-1', '查日志（子agent）', msgs)).toEqual({ conversationId: 'sub-1', title: '查日志（子agent）', askToolCallId: 'ask-9' });
    expect(completeQuestionSource('sub-1', undefined, undefined).askToolCallId).toBe('');
  });

  it('展示标题去掉登记时加的（子agent）后缀', () => {
    expect(subagentDisplayTitle('查日志（子agent）')).toBe('查日志');
    expect(subagentDisplayTitle('')).toBe('子 Agent');
  });
});
