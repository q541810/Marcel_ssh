// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import {
  findAnchorHeading,
  isHeadingLike,
  messageMatchesId,
  normalizeHeadingText,
  resolveQuestionJump,
  resolveQuestionTextMessage,
} from './questionJump';

describe('normalizeHeadingText（与后端 normalize_heading 同口径）', () => {
  it.each([
    ['**方案对比**', '方案对比'],
    ['__方案对比__', '方案对比'],
    ['  `命令`  结果  ', '命令 结果'],
    ['方案对比：', '方案对比'],
    ['方案对比:', '方案对比'],
    ['**方案对比：**', '方案对比'],
    ['方案   对\t比', '方案 对 比'],
    ['标题 ：', '标题'],
    ['***', ''],
    ['', ''],
  ])('%j → %j', (input, want) => {
    expect(normalizeHeadingText(input)).toBe(want);
  });
});

function html(markup: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = markup;
  return root;
}

describe('isHeadingLike / findAnchorHeading', () => {
  it('h1–h6 都算小标题', () => {
    const root = html('<h1>a</h1><h3>b</h3><h6>c</h6>');
    for (const el of Array.from(root.children)) expect(isHeadingLike(el)).toBe(true);
  });

  it('整段只有一个加粗的段落算（冒号可在加粗外）', () => {
    const root = html('<p><strong>结论</strong></p><p><strong>结论</strong>：</p><p><strong>结论：</strong></p>');
    for (const el of Array.from(root.children)) expect(isHeadingLike(el)).toBe(true);
  });

  it('加粗夹在正文里 / 多段加粗 / 空段落 不算', () => {
    const root = html(
      '<p>前面 <strong>结论</strong></p><p><strong>a</strong><strong>b</strong></p><p></p><p><em>斜体</em></p>',
    );
    for (const el of Array.from(root.children)) expect(isHeadingLike(el)).toBe(false);
  });

  it('按归一化后相等找标题，anchor 自己也要归一化（历史重建时是模型原文）', () => {
    const root = html('<p>前言</p><h2>方案  对比</h2><p><strong>风险</strong>:</p><p>正文</p>');
    expect(findAnchorHeading(root, '**方案 对比**：')?.tagName).toBe('H2');
    expect(findAnchorHeading(root, '风险')?.tagName).toBe('P');
  });

  it('普通段落即使文字相同也不算标题；找不到 / 空 anchor 返回 null', () => {
    const root = html('<p>方案对比</p><h2>别的</h2>');
    expect(findAnchorHeading(root, '方案对比')).toBeNull();
    expect(findAnchorHeading(root, '不存在')).toBeNull();
    expect(findAnchorHeading(root, '  **  ')).toBeNull();
    expect(findAnchorHeading(root, undefined)).toBeNull();
  });
});

function msg(partial: Partial<AgentMessage> & Pick<AgentMessage, 'id' | 'role'>): AgentMessage {
  return { content: '', timestamp: '2026-10-31T00:00:00Z', ...partial };
}

const call = (id: string) => ({ id, name: 'ask_user', arguments: {}, disposition: 'Allow' as const });
const askResult = (id: string) => ({
  toolName: 'ask_user', summary: '', result: '', success: true, blocked: false, toolCallId: id,
});

describe('resolveQuestionTextMessage（结构定位，不搜文字）', () => {
  it('落库后：assistant 消息自带 toolCalls，按调用 id 反查它的正文', () => {
    const messages = [
      msg({ id: 'u', role: 'user', content: '开始' }),
      msg({ id: 'a1', role: 'assistant', content: '前一段', toolCalls: [call('other')] }),
      msg({ id: 'a2', role: 'assistant', content: '结论如下', toolCalls: [call('q1')] }),
      msg({ id: 't', role: 'tool', toolResult: askResult('q1') }),
    ];
    expect(resolveQuestionTextMessage(messages, 'q1')?.id).toBe('a2');
  });

  it('live 阶段：assistant 没有 toolCalls，经 tool 消息的 callerMessageId 指回', () => {
    const messages = [
      msg({ id: 'a-old', role: 'assistant', content: '更早的一段话' }),
      msg({ id: 'a-now', role: 'assistant', content: '结论' }),
      msg({ id: 't', role: 'tool', callerMessageId: 'a-now', isExecuting: true, toolResult: askResult('q1') }),
    ];
    expect(resolveQuestionTextMessage(messages, 'q1')?.id).toBe('a-now');
  });

  it('本轮没写正文（没有 callerMessageId）→ null，绝不往前翻找别的文本', () => {
    const messages = [
      msg({ id: 'a-old', role: 'assistant', content: '上一轮的话' }),
      msg({ id: 't', role: 'tool', toolResult: askResult('q1') }),
    ];
    expect(resolveQuestionTextMessage(messages, 'q1')).toBeNull();
  });

  it('发出调用的 assistant 正文为空 → null', () => {
    const messages = [msg({ id: 'a', role: 'assistant', content: '  ', toolCalls: [call('q1')] })];
    expect(resolveQuestionTextMessage(messages, 'q1')).toBeNull();
  });

  it('调用 id 不存在 / 为空 → null', () => {
    expect(resolveQuestionTextMessage([], 'q1')).toBeNull();
    const m = msg({ id: 'a', role: 'assistant', content: 'x', toolCalls: [call('q1')] });
    expect(resolveQuestionTextMessage([m], '')).toBeNull();
  });
});

describe('resolveQuestionJump', () => {
  const messages = [msg({ id: 'a', role: 'assistant', content: '结论', toolCalls: [call('q1')] })];

  it('无 anchor → 只有消息（跳到正文开头）', () => {
    const t = resolveQuestionJump(messages, 'q1');
    expect(t?.message.id).toBe('a');
    expect(t?.anchor).toBeUndefined();
  });

  it('anchor 归一化后带上；归一化后为空视为没填', () => {
    expect(resolveQuestionJump(messages, 'q1', '**方案：**')?.anchor).toBe('方案');
    expect(resolveQuestionJump(messages, 'q1', ' ** ')?.anchor).toBeUndefined();
  });

  it('没有可跳的正文 → null', () => {
    expect(resolveQuestionJump([], 'q1', '方案')).toBeNull();
  });
});

describe('messageMatchesId（live id / 库 id 两个域）', () => {
  it('id 或 dbId 任一相等都命中', () => {
    const m = msg({ id: 'live', role: 'assistant', dbId: 'db' });
    expect(messageMatchesId(m, 'live')).toBe(true);
    expect(messageMatchesId(m, 'db')).toBe(true);
    expect(messageMatchesId(m, 'x')).toBe(false);
  });
});
