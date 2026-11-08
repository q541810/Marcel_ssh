import { describe, expect, it } from 'vitest';
import type { AgentMessage } from './types';
import { composeUserInput, validateUserInput } from './userInput';
import { parseSuggestion, suggestionState } from './suggestNext';

const ts = '2026-11-05T00:00:00Z';
const tool = (id: string): AgentMessage => ({
  id: `t-${id}`, role: 'tool', content: '', timestamp: ts,
  toolResult: { toolName: 'suggest_next', summary: '', result: '', success: true, blocked: false, toolCallId: id, arguments: {} },
});
const user = (content: string, userInput?: AgentMessage['userInput']): AgentMessage => ({
  id: `u-${content}`, role: 'user', content, timestamp: ts, ...(userInput ? { userInput } : {}),
});
const reply = (toolCallId: string, question: string, text: string): AgentMessage => {
  const input = { version: 1 as const, text, textAttachments: [], replyTo: { toolCallId, question } };
  return user(composeUserInput(input), input);
};

describe('parseSuggestion', () => {
  it('trims and drops blank options; needs a question and at least one option', () => {
    expect(parseSuggestion({ question: ' 推送吗？ ', options: [' 好的 ', '', 3, '不需要'] })).toEqual({
      question: '推送吗？', options: [{ text: '好的' }, { text: '不需要' }],
    });
    expect(parseSuggestion({ question: '', options: ['a'] })).toBeNull();
    expect(parseSuggestion({ question: 'q', options: [] })).toBeNull();
    expect(parseSuggestion({ question: 'q' })).toBeNull();
    expect(parseSuggestion(undefined)).toBeNull();
  });

  it('reads an optional target mode; an unknown mode is ignored rather than trusted', () => {
    expect(parseSuggestion({
      question: '执行吗？',
      options: [{ text: '执行', mode: 'agent' }, { text: '全自动', mode: ' auto ' }, { text: '改改', mode: 'yolo' }, '不用'],
    })?.options).toEqual([
      { text: '执行', mode: 'agent' }, { text: '全自动', mode: 'auto' }, { text: '改改' }, { text: '不用' },
    ]);
    // 没有文字的对象选项占不了名额
    expect(parseSuggestion({ question: 'q', options: [{ mode: 'agent' }] })).toBeNull();
  });
});

describe('回信记录切过的模式', () => {
  it('composes a note the model can read, and survives validation', () => {
    const input = {
      version: 1 as const, text: '按计划执行', textAttachments: [],
      replyTo: { toolCallId: 'c1', question: '执行吗？', switchedTo: 'agent' as const },
    };
    const content = composeUserInput(input);
    expect(content).toContain('已把运行模式切换为 Agent 模式');
    expect(validateUserInput(content, input)).toEqual(input);
    // 没切过就一个字也不多说；坏模式名不采信元数据
    const plain = { ...input, replyTo: { toolCallId: 'c1', question: '执行吗？' } };
    expect(composeUserInput(plain)).not.toContain('运行模式');
    expect(validateUserInput(content, { ...input, replyTo: { ...input.replyTo, switchedTo: 'yolo' } })).toBeUndefined();
  });
});

describe('suggestionState', () => {
  it('is active until the user says something after the call', () => {
    expect(suggestionState([user('做个事'), tool('c1')], 'c1')).toBe('active');
  });
  it('is answered when a later user message replies to this very call', () => {
    expect(suggestionState([tool('c1'), reply('c1', '推送吗？', '好的')], 'c1')).toBe('answered');
  });
  it('expires when the user types something else instead', () => {
    expect(suggestionState([tool('c1'), user('先别推')], 'c1')).toBe('expired');
  });
  it('a reply to another card does not answer this one', () => {
    expect(suggestionState([tool('c1'), reply('c2', 'x', '好')], 'c1')).toBe('expired');
  });
  it('ignores user messages from before the call', () => {
    expect(suggestionState([user('旧话'), tool('c1')], 'c1')).toBe('active');
  });
});

describe('replyTo in user input', () => {
  it('prefixes the model input with a note naming the card, and survives validation', () => {
    const input = { version: 1 as const, text: '好的', textAttachments: [], replyTo: { toolCallId: 'c1', question: '推送吗？' } };
    const content = composeUserInput(input);
    expect(content).toContain('「推送吗？」');
    expect(content.endsWith('好的')).toBe(true);
    expect(validateUserInput(content, input)).toEqual(input);
  });
  it('rejects a malformed replyTo and a content that no longer matches', () => {
    const base = { version: 1, text: 'x', textAttachments: [] };
    expect(validateUserInput('x', { ...base, replyTo: { toolCallId: '', question: 'q' } })).toBeUndefined();
    expect(validateUserInput('x', { ...base, replyTo: { toolCallId: 'c', question: 'q' } })).toBeUndefined();
  });
});
