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
      question: '推送吗？', options: ['好的', '不需要'],
    });
    expect(parseSuggestion({ question: '', options: ['a'] })).toBeNull();
    expect(parseSuggestion({ question: 'q', options: [] })).toBeNull();
    expect(parseSuggestion({ question: 'q' })).toBeNull();
    expect(parseSuggestion(undefined)).toBeNull();
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
