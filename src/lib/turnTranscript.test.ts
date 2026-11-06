import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { composeUserInput } from '@/lib/userInput';
import {
  buildTurnTranscript,
  formatTurnElapsed,
  turnElapsedMs,
  turnFooters,
} from './turnTranscript';

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

function user(id: string, content = `user ${id}`, sec = 0): AgentMessage {
  return { id, role: 'user', content, timestamp: at(sec) };
}
function reply(id: string, content: string, sec: number): AgentMessage {
  return { id, role: 'assistant', content, timestamp: at(sec) };
}
function tool(
  id: string,
  name: string,
  sec: number,
  over: Partial<NonNullable<AgentMessage['toolResult']>> = {},
): AgentMessage {
  return {
    id,
    role: 'tool',
    content: '',
    timestamp: at(sec),
    toolResult: {
      toolName: name,
      summary: '',
      result: `out of ${id}`,
      success: true,
      blocked: false,
      arguments: { command: `run ${id}` },
      toolCallId: `call-${id}`,
      ...over,
    },
  };
}

describe('turnFooters：收尾条挂在哪', () => {
  it('已结束的任务：挂在模型说的最后一段话下面', () => {
    const msgs = [user('u1'), reply('a1', '先看一下', 2), tool('t1', 'bash', 3), reply('a2', '搞定了', 9)];
    const footers = turnFooters(msgs, { tailActive: false });
    expect([...footers.keys()]).toEqual(['a2']);
    expect(footers.get('a2')!.turn).toHaveLength(4);
    expect(footers.get('a2')!.elapsedMs).toBe(9000);
  });

  it('每个已结束的任务各有一条', () => {
    const msgs = [user('u1'), reply('a1', '一', 3), user('u2', 'q2', 10), reply('a2', '二', 14)];
    const footers = turnFooters(msgs, { tailActive: false });
    expect([...footers.keys()]).toEqual(['a1', 'a2']);
    expect(footers.get('a1')!.elapsedMs).toBe(3000);
    expect(footers.get('a2')!.elapsedMs).toBe(4000);
  });

  it('任务还在跑：尾回合不挂（用时对没结束的任务不成立），之前的照挂', () => {
    const msgs = [user('u1'), reply('a1', '一', 3), user('u2', 'q2', 10), reply('a2', '写到一半', 12)];
    const footers = turnFooters(msgs, { tailActive: true });
    expect([...footers.keys()]).toEqual(['a1']);
  });

  it('回合里还有执行中的工具 / 加载骨架：不挂', () => {
    const running = { ...tool('t1', 'bash', 3), isExecuting: true };
    expect(turnFooters([user('u1'), reply('a0', '来了', 2), running], { tailActive: false }).size).toBe(0);
    const loading: AgentMessage = { id: 'l', role: 'assistant', content: '', timestamp: at(4), isLoading: true };
    expect(turnFooters([user('u1'), reply('a0', '来了', 2), loading], { tailActive: false }).size).toBe(0);
  });

  it('任务在工具调用中途被停止（最后一段话之后还有工具）：不挂，免得夹在工具卡中间', () => {
    const msgs = [user('u1'), reply('a1', '我来执行', 2), tool('t1', 'bash', 3)];
    expect(turnFooters(msgs, { tailActive: false }).size).toBe(0);
  });

  it('结论后面跟着小建议卡片（suggest_next 的结果）：照挂，复制 / 分叉不能因为出了卡片就没了', () => {
    const carrier: AgentMessage = {
      ...reply('a1', '搞定了', 9),
      toolCalls: [{ id: 'c-s', name: 'suggest_next', arguments: {}, disposition: 'Auto' as never }],
    };
    const msgs = [user('u1'), reply('a0', '先看一下', 2), tool('t1', 'bash', 3), carrier, tool('s1', 'suggest_next', 10)];
    const footers = turnFooters(msgs, { tailActive: false });
    expect([...footers.keys()]).toEqual(['a1']);
  });

  it('小建议卡片之前还有别的工具在最后一段话之后：仍按「被打断」不挂', () => {
    const msgs = [user('u1'), reply('a1', '我来执行', 2), tool('t1', 'bash', 3), tool('s1', 'suggest_next', 4)];
    expect(turnFooters(msgs, { tailActive: false }).size).toBe(0);
  });

  it('上次崩溃留下的 running 回合没有可信终点：不挂', () => {
    const anchor = { ...user('u1'), turnState: 'running' as const };
    expect(turnFooters([anchor, reply('a1', '半截', 5)], { tailActive: false }).size).toBe(0);
  });

  it('被手动停止 / 失败的回合照挂（复制已有的输出仍有用）', () => {
    const anchor = { ...user('u1'), turnState: 'cancelled' as const };
    expect(turnFooters([anchor, reply('a1', '说到一半', 5)], { tailActive: false }).size).toBe(1);
  });

  it('模型一句话都没说 / 只有思考：不挂', () => {
    const thinkingOnly: AgentMessage = { ...reply('a1', '', 3), reasoningContent: '想想' };
    expect(turnFooters([user('u1'), thinkingOnly], { tailActive: false }).size).toBe(0);
    expect(turnFooters([user('u1')], { tailActive: false }).size).toBe(0);
  });

  it('不以回合起点开头的孤立消息不构成任务', () => {
    expect(turnFooters([reply('a1', '孤儿', 1)], { tailActive: false }).size).toBe(0);
  });

  it('notice（作业结算告知）起头的自动继续回合，同样算一个任务', () => {
    const notice: AgentMessage = { id: 'n1', role: 'notice', content: '作业完成', timestamp: at(0) };
    const footers = turnFooters([notice, reply('a1', '作业结果如下', 4)], { tailActive: false });
    expect(footers.get('a1')!.elapsedMs).toBe(4000);
  });
});

describe('turnElapsedMs：任务用时', () => {
  it('live：以锚点上记的结束时刻为终点（assistant 的时间戳是开始流式的时刻，不能当终点）', () => {
    const turn = [
      { ...user('u1'), turnFinishedAt: at(75) },
      reply('a1', '长回答', 20), // 20s 开始输出，流了很久才结束
    ];
    expect(turnElapsedMs(turn)).toBe(75_000);
  });

  it('重载后没有 turnFinishedAt：回落到回合里最后一条消息的时间戳', () => {
    expect(turnElapsedMs([user('u1'), reply('a1', 'x', 30), tool('t1', 'bash', 41)])).toBe(41_000);
  });

  it('回落时跳过 system 消息（压缩卡 / 重试提示不是任务终点）', () => {
    const card: AgentMessage = { id: 's', role: 'system', content: '压缩', timestamp: at(500) };
    expect(turnElapsedMs([user('u1'), reply('a1', 'x', 30), card])).toBe(30_000);
  });

  it('时间戳坏掉 / 倒挂：算不出来就是 null，不编一个数', () => {
    expect(turnElapsedMs([{ ...user('u1'), timestamp: 'not-a-date' }, reply('a1', 'x', 3)])).toBeNull();
    expect(turnElapsedMs([user('u1', 'q', 50), reply('a1', 'x', 3)])).toBeNull();
    expect(turnElapsedMs([])).toBeNull();
    expect(turnElapsedMs([{ ...user('u1'), turnFinishedAt: 'garbage' }])).toBeNull();
  });
});

describe('formatTurnElapsed', () => {
  it.each([
    [200, '不到 1 秒'],
    [1_000, '1 秒'],
    [42_400, '42 秒'],
    [59_600, '1 分 0 秒'],
    [134_000, '2 分 14 秒'],
    [3_600_000, '1 小时 0 分'],
    [3_900_000, '1 小时 5 分'],
  ])('%d ms → %s', (ms, expected) => {
    expect(formatTurnElapsed(ms)).toBe(expected);
  });
});

describe('buildTurnTranscript：整个任务的可复制文本', () => {
  it('按发生顺序包含用户、助手、工具调用与返回', () => {
    const text = buildTurnTranscript([
      user('u1', '看看磁盘'),
      reply('a1', '好的，我来查', 2),
      tool('t1', 'bash', 3),
      reply('a2', '磁盘还剩 40G', 9),
    ]);
    const order = ['**用户**', '看看磁盘', '**助手**', '好的，我来查', '**工具调用 · bash**', 'run t1', '**工具返回 · bash**', 'out of t1', '磁盘还剩 40G'];
    let cursor = -1;
    for (const part of order) {
      const idx = text.indexOf(part, cursor + 1);
      expect(idx, `应按顺序出现：${part}`).toBeGreaterThan(cursor);
      cursor = idx;
    }
  });

  it('不含模型思维链，也不含 system 消息', () => {
    const thought: AgentMessage = { ...reply('a1', '结论', 2), reasoningContent: '绝密的思考过程' };
    const sys: AgentMessage = { id: 's', role: 'system', content: '上下文已压缩', timestamp: at(3) };
    const text = buildTurnTranscript([user('u1'), thought, sys]);
    expect(text).toContain('结论');
    expect(text).not.toContain('绝密的思考过程');
    expect(text).not.toContain('上下文已压缩');
  });

  it('发出了调用但没有返回（中途被停止）：补一条「没有返回结果」，有返回的不重复', () => {
    const calls: AgentMessage = {
      ...reply('a1', '执行两个', 2),
      toolCalls: [
        { id: 'call-t1', name: 'bash', arguments: { command: 'run t1' }, disposition: 'Allow' },
        { id: 'call-x', name: 'read_file', arguments: { path: '/etc/hosts' }, disposition: 'Allow' },
      ],
    };
    const text = buildTurnTranscript([user('u1'), calls, tool('t1', 'bash', 3)]);
    expect(text.match(/\*\*工具调用 · bash\*\*/g)).toHaveLength(1);
    expect(text).toContain('**工具调用 · read_file**');
    expect(text).toContain('/etc/hosts');
    expect(text).toContain('（没有返回结果）');
  });

  it('失败 / 拦截 / 超时 / 中止的返回会标注', () => {
    const t = (over: Partial<NonNullable<AgentMessage['toolResult']>>) =>
      buildTurnTranscript([user('u1'), tool('t1', 'bash', 1, over)]);
    expect(t({ success: false })).toContain('**工具返回 · bash**（失败）');
    expect(t({ blocked: true, success: false })).toContain('（已被拦截）');
    expect(t({ wasTimeout: true, success: false })).toContain('（超时）');
    expect(t({ wasAborted: true, success: false })).toContain('（已中止）');
    expect(t({})).not.toContain('（');
  });

  it('工具输出里带 ``` 时围栏自动加长，不会提前闭合', () => {
    const text = buildTurnTranscript([
      user('u1'),
      tool('t1', 'bash', 1, { result: 'before\n```\ncode\n```\nafter' }),
    ]);
    expect(text).toContain('````\nbefore\n```\ncode\n```\nafter\n````');
  });

  it('用户消息：只写文字与附件名，不把附件正文塞进来', () => {
    // content 必须是元数据无损重组的结果，否则 validateUserInput 会（正确地）拒用元数据
    const input = {
      version: 1 as const,
      text: '总结一下',
      textAttachments: [{ id: 'f1', name: 'notes.md', content: '附件正文很长很长' }],
    };
    const msg: AgentMessage = {
      ...user('u1', composeUserInput(input)),
      userInput: input,
      imagePaths: ['a.png', 'b.png'],
    };
    const text = buildTurnTranscript([msg]);
    expect(text).toContain('总结一下');
    expect(text).toContain('（附件：notes.md）');
    expect(text).toContain('（图片 2 张）');
    expect(text).not.toContain('附件正文很长');
  });

  it('notice 回合起点写成「系统告知」，不冒充用户', () => {
    const notice: AgentMessage = { id: 'n1', role: 'notice', content: '作业 j1 已完成', timestamp: at(0) };
    const text = buildTurnTranscript([notice, reply('a1', '收到', 1)]);
    expect(text).toContain('**系统告知**\n\n作业 j1 已完成');
    expect(text).not.toContain('**用户**');
  });
});
