// @vitest-environment jsdom
import { createRef } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage } from '@/lib/types';
import { useTurnFoldStore } from '@/stores/turnFoldStore';
import AgentMessageList, { type AgentMessageListHandle } from './AgentMessageList';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./AgentMessage', () => ({
  default: ({ message }: { message: AgentMessage }) => <p>{message.content}</p>,
}));
vi.mock('@/stores/memoryStore', () => ({
  useMemoryStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ notes: {} }),
    { getState: () => ({ loadNotes: () => {} }) },
  ),
}));
vi.mock('./ToolCallCard', () => ({ default: ({ message }: { message: AgentMessage }) => <div data-testid="plain-tool-card">{message.id}</div> }));
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { foldCompletedTurns: true } }),
}));

const ts = '2026-11-01T00:00:00Z';
const SUB = 'sub-1';
const sub = (id: string, args: Record<string, unknown>, metadata?: Record<string, unknown>): AgentMessage => ({
  id, role: 'tool', content: '', timestamp: ts,
  toolResult: { toolName: 'subagent', summary: '', result: 'r', success: true, blocked: false, toolCallId: `${id}-c`, arguments: args, metadata },
});
const MESSAGES: AgentMessage[] = [
  { id: 'u1', role: 'user', content: '开始', timestamp: ts, turnState: 'completed' },
  sub('d1', { description: '查日志', prompt: 'p' }, { kind: 'subagentAsk', subConversationId: SUB, askToolCallId: 'ask-1', question: 'Q?', context: null }),
  { id: 'mid', role: 'assistant', content: '我来想想', timestamp: ts },
  sub('d2', { continue_id: SUB, prompt: '答案' }, { subTaskId: 't', subConversationId: SUB, status: 'completed' }),
  { id: 'final', role: 'assistant', content: '最终答案', timestamp: ts },
];

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'overflow-y-auto';
  document.body.appendChild(host);
  root = createRoot(host);
  Element.prototype.scrollIntoView = vi.fn() as unknown as typeof Element.prototype.scrollIntoView;
  Element.prototype.scrollBy = vi.fn() as unknown as typeof Element.prototype.scrollBy;
  useTurnFoldStore.setState({ expanded: {} });
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('AgentMessageList 里的子 agent 时间线卡', () => {
  it('同一个子对话的两次调用只渲染一张卡（留在第一次派发的位置），续派卡被吸收', () => {
    act(() => root.render(<AgentMessageList messages={MESSAGES} conversationId="c1" foldTurns={false} />));
    expect(host.querySelectorAll('[data-testid="subagent-thread"]')).toHaveLength(1);
    expect(host.querySelector('[data-message-id="d1"] [data-testid="subagent-thread"]')).not.toBeNull();
    expect(host.querySelector('[data-message-id="d2"]')).toBeNull();
    expect(host.querySelector('[data-testid="plain-tool-card"]')).toBeNull();
    // 顺序：卡在「我来想想」之前
    const order = Array.from(host.querySelectorAll('[data-message-id]')).map((n) => n.getAttribute('data-message-id'));
    expect(order.indexOf('d1')).toBeLessThan(order.indexOf('mid'));
  });

  it('跳转到被吸收的续派行（d2）会落到时间线卡本身（d1）', async () => {
    const handle = createRef<AgentMessageListHandle>();
    act(() => root.render(<AgentMessageList messages={MESSAGES} conversationId="c1" listRef={handle} foldTurns={false} />));
    let ok = false;
    act(() => { ok = handle.current!.jumpToMessage('d2'); });
    expect(ok).toBe(true);
  });

  it('单次派发（没提问、没续派）仍是原来的通用工具卡', () => {
    const single: AgentMessage[] = [MESSAGES[0], sub('x1', { description: 'a', prompt: 'b' }, { subTaskId: 't', subConversationId: 'other', status: 'completed' })];
    act(() => root.render(<AgentMessageList messages={single} conversationId="c1" foldTurns={false} />));
    expect(host.querySelector('[data-testid="subagent-thread"]')).toBeNull();
    expect(host.querySelector('[data-testid="plain-tool-card"]')).not.toBeNull();
  });
});
