import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import {
  segmentTurns,
  turnFoldLabel,
  TOOL_FOLD_MIN,
  type TurnSegment,
} from '@/lib/agentTurnFold';

function user(id: string, content = `user ${id}`): AgentMessage {
  return { id, role: 'user', content, timestamp: new Date().toISOString() };
}
function assistantText(id: string, content: string): AgentMessage {
  return { id, role: 'assistant', content, timestamp: new Date().toISOString() };
}
function assistantThinking(id: string, reasoningContent: string): AgentMessage {
  return { id, role: 'assistant', content: '', reasoningContent, timestamp: new Date().toISOString() };
}
function assistantToolCalls(id: string, n: number): AgentMessage {
  return {
    id, role: 'assistant', content: '', timestamp: new Date().toISOString(),
    toolCalls: Array.from({ length: n }, (_, i) => ({
      id: `${id}-c${i}`, name: 'bash',
      arguments: { command: 'ls' }, riskLevel: 'Moderate' as const,
    })),
  };
}
function tool(id: string, toolName = 'bash', opts: { subagent?: boolean } = {}): AgentMessage {
  return {
    id, role: 'tool', content: 'ok', timestamp: new Date().toISOString(),
    toolResult: {
      toolName, summary: '', result: 'ok', success: true, blocked: false,
      toolCallId: `${id}-call`,
      ...(opts.subagent ? { metadata: { __subagent: true } } : {}),
    },
  };
}

describe('segmentTurns', () => {
  it('把 user 到 user 切成独立回合，短回合不可折叠', () => {
    const u1 = user('u1');
    const a1 = assistantText('a1', 'hi');
    const u2 = user('u2');
    const a2 = assistantText('a2', 'ok');
    const segs = segmentTurns([u1, a1, u2, a2]);
    expect(segs).toHaveLength(2);
    expect(segs[0].messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(segs[1].messages.map((m) => m.id)).toEqual(['u2', 'a2']);
    expect(segs[0].foldable).toBe(false);
    expect(segs[1].foldable).toBe(false);
  });

  it('长回合（tool 数 >= 阈值）折叠，并正确计数', () => {
    const u = user('u');
    const calls = assistantToolCalls('a-tc', 5);
    const tools = Array.from({ length: 5 }, (_, i) => tool(`t${i}`));
    const answer = assistantText('a', '完成');
    const segs = segmentTurns([u, calls, ...tools, answer]);
    expect(segs).toHaveLength(1);
    const seg = segs[0];
    expect(seg.foldable).toBe(true);
    expect(seg.answerIndex).toBe(7);
    expect(seg.toolCallCount).toBe(5);
    // assistant(tool_calls) 有 toolCalls 且无正文 → 算 1 条消息
    expect(seg.messageCount).toBe(1);
    expect(seg.subagentCount).toBe(0);
    // 折叠成员 = tool 5 条 + 该 assistant 1 条
    expect(seg.foldMembers).toHaveLength(6);
  });

  it('tool 数小于阈值不折叠', () => {
    const u = user('u');
    const tools = [tool('t0'), tool('t1')];
    const answer = assistantText('a', 'done');
    const segs = segmentTurns([u, ...tools, answer]);
    expect(segs[0].foldable).toBe(false);
  });

  it('subagent（subagent 工具）单独计数，且不计入普通工具数', () => {
    const u = user('u');
    const tasks = [tool('s0', 'subagent', { subagent: true }), tool('s1', 'subagent', { subagent: true })];
    const bash = tool('b0', 'bash');
    const answer = assistantText('a', 'done');
    const seg = segmentTurns([u, ...tasks, bash, answer])[0];
    expect(seg.toolCallCount).toBe(3); // 普通工具数不含 subagent
    expect(seg.subagentCount).toBe(2);
  });

  it('兼容历史 task 工具名：仍计为 subagent', () => {
    const u = user('u');
    const legacy = tool('s0', 'task', { subagent: true });
    const bash = tool('b0', 'bash');
    const answer = assistantText('a', 'done');
    const seg = segmentTurns([u, legacy, bash, answer])[0];
    expect(seg.subagentCount).toBe(1);
  });

  it('纯 thinking 过程（无 tool）只算消息数', () => {
    const u = user('u');
    const think1 = assistantThinking('th1', '推理一');
    const think2 = assistantThinking('th2', '推理二');
    const answer = assistantText('a', '结论');
    const seg = segmentTurns([u, think1, think2, answer])[0];
    expect(seg.foldable).toBe(false); // tool 0 条
    expect(seg.messageCount).toBe(2);
    expect(seg.foldMembers).toHaveLength(2);
  });

  it('半截回合（无纯文本答案）不可折叠', () => {
    const u = user('u');
    const calls = assistantToolCalls('a-tc', 3);
    const tools = Array.from({ length: 3 }, (_, i) => tool(`t${i}`));
    // 回合以 tool 收尾，没有纯文本 assistant → 正在流/被打断
    const seg = segmentTurns([u, calls, ...tools])[0];
    expect(seg.answerIndex).toBeNull();
    expect(seg.foldable).toBe(false);
  });

  it('带 tool_calls 的 assistant 不算答案；其后的纯文本才算', () => {
    const u = user('u');
    const calls = assistantToolCalls('a-tc', 1);
    const t = tool('t0');
    const final = assistantText('a', '收尾');
    const seg = segmentTurns([u, calls, t, final])[0];
    expect(seg.answerIndex).toBe(3);
    expect(seg.toolCallCount).toBe(1);
    expect(seg.foldMembers.map((m) => m.id)).toEqual(['a-tc', 't0']);
  });

  it('compaction / system 并入其前 user 回合；无答案则该回合不可折叠（不被隐藏）', () => {
    const u1 = user('u1');
    const comp = {
      id: 'comp', role: 'system' as const, content: '摘要…',
      timestamp: new Date().toISOString(),
      compaction: { status: 'done' as const, summary: 'x' },
    };
    const u2 = user('u2');
    const a2 = assistantText('a2', 'ok');
    const segs = segmentTurns([u1, comp, u2, a2]);
    // u1 + comp 无纯文本答案 → 1 段（不可折叠，comp 不会被隐藏）
    expect(segs).toHaveLength(2);
    expect(segs[0].messages.map((m) => m.id)).toEqual(['u1', 'comp']);
    expect(segs[0].foldable).toBe(false);
  });

  it('长回合中间夹 compaction：该回合不折叠（comp 锚点永显）', () => {
    const u = user('u');
    const calls1 = assistantToolCalls('a-tc1', 2);
    const tools1 = [tool('t0'), tool('t1')];
    const comp = {
      id: 'comp', role: 'system' as const, content: '摘要…',
      timestamp: new Date().toISOString(),
      compaction: { status: 'done' as const, summary: 'x' },
    };
    const calls2 = assistantToolCalls('a-tc2', 2);
    const tools2 = [tool('t2'), tool('t3')];
    const answer = assistantText('a', '最终答复');
    const seg = segmentTurns([u, calls1, ...tools1, comp, calls2, ...tools2, answer])[0];
    // tool 数 >= 阈值，但因过程夹 system → 放弃折叠，完整可见
    expect(seg.foldable).toBe(false);
    expect(seg.toolCallCount).toBe(4);
  });

  it('连续多个长回合各自独立分段', () => {
    const mkTurn = (uid: string, aid: string, toolN: number) => {
      const u = user(uid);
      const calls = assistantToolCalls(`${aid}-tc`, toolN);
      const tools = Array.from({ length: toolN }, (_, i) => tool(`${aid}-t${i}`));
      const answer = assistantText(aid, `answer ${aid}`);
      return [u, calls, ...tools, answer] as AgentMessage[];
    };
    const segs = segmentTurns([...mkTurn('u1', 'a1', 4), ...mkTurn('u2', 'a2', 3)]);
    expect(segs).toHaveLength(2);
    expect(segs[0].foldable).toBe(true);
    expect(segs[1].foldable).toBe(true);
    expect(segs[0].toolCallCount).toBe(4);
    expect(segs[1].toolCallCount).toBe(3);
  });

  it('任务运行中：尾回合（最后 user 之后）即使有纯文本也不折叠 —— 不“干一半收起”', () => {
    // 模型在 tool 之间输出了纯文本前言（独立 assistant 消息），任务仍在跑
    // （无后续 user 封顶）。此时最后一条是纯文本 assistant，但 tailActive=true
    // → 不能折叠 —— 模型可能继续输出 tool。
    const u = user('u');
    const calls = assistantToolCalls('a-tc', 3);
    const tools = Array.from({ length: 3 }, (_, i) => tool(`t${i}`));
    const midText = assistantText('mid', '我先看看，这一步完成了，继续…'); // 任务中途插话
    const segs = segmentTurns([u, calls, ...tools, midText], { tailActive: true });
    expect(segs).toHaveLength(1);
    expect(segs[0].toolCallCount).toBe(3);
    // 关键：任务在跑 → 尾回合不可折叠
    expect(segs[0].foldable).toBe(false);
  });

  it('任务结束后：同一尾回合才可折叠', () => {
    const u = user('u');
    const calls = assistantToolCalls('a-tc', 3);
    const tools = Array.from({ length: 3 }, (_, i) => tool(`t${i}`));
    const midText = assistantText('mid', '我先看看，这一步完成了，继续…');
    // 任务已结束（isRunning=false）→ 尾回合按正常规则（tool 数达标）折叠
    const segs = segmentTurns([u, calls, ...tools, midText], { tailActive: false });
    expect(segs[0].foldable).toBe(true);
  });

  it('任务运行中只影响尾回合；被后续 user 封顶的旧回合照常可折叠', () => {
    const mkTurn = (uid: string, aid: string, toolN: number) => {
      const u = user(uid);
      const calls = assistantToolCalls(`${aid}-tc`, toolN);
      const tools = Array.from({ length: toolN }, (_, i) => tool(`${aid}-t${i}`));
      const answer = assistantText(aid, `answer ${aid}`);
      return [u, calls, ...tools, answer] as AgentMessage[];
    };
    // 回合1（完成、被 user2 封顶）+ 回合2（当前任务在跑、只有过程无答案）
    const r1 = mkTurn('u1', 'a1', 4);
    const r2start = [user('u2'), assistantToolCalls('a2-tc', 3)];
    const tools2 = Array.from({ length: 3 }, (_, i) => tool(`u2-t${i}`));
    const segs = segmentTurns([...r1, ...r2start, ...tools2], { tailActive: true });
    expect(segs).toHaveLength(2);
    // 回合1 已封顶 → 折叠不受运行态影响
    expect(segs[0].foldable).toBe(true);
    // 回合2 是尾回合且任务在跑 → 不折叠（半截也无答案）
    expect(segs[1].foldable).toBe(false);
  });
});

describe('turnFoldLabel', () => {
  it('工具+消息 → “已执行 n 步 · 共 m 条消息”', () => {
    expect(turnFoldLabel({ toolCallCount: 5, messageCount: 2, subagentCount: 0 }))
      .toBe('已执行 5 步 · 共 2 条消息');
  });
  it('有 subagent → 追加“n 个任务”', () => {
    expect(turnFoldLabel({ toolCallCount: 3, messageCount: 1, subagentCount: 2 }))
      .toBe('已执行 3 步 · 2 个任务 · 共 1 条消息');
  });
  it('只有消息 → “共 m 条消息”', () => {
    expect(turnFoldLabel({ toolCallCount: 0, messageCount: 2, subagentCount: 0 }))
      .toBe('共 2 条消息');
  });
  it('全空 → “查看过程”', () => {
    expect(turnFoldLabel({ toolCallCount: 0, messageCount: 0, subagentCount: 0 }))
      .toBe('查看过程');
  });
});
