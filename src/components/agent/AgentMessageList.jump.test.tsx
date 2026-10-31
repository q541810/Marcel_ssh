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
  default: ({ message }: { message: AgentMessage }) => (
    <div>
      <p>{message.content}</p>
      <h2>方案对比</h2>
      <p><strong>风险</strong></p>
    </div>
  ),
}));
vi.mock('@/stores/memoryStore', () => ({
  useMemoryStore: Object.assign(
    (selector: (s: unknown) => unknown) => selector({ notes: {} }),
    { getState: () => ({ loadNotes: () => {} }) },
  ),
}));
vi.mock('./ToolCallCard', () => ({ default: () => <div>tool</div> }));
vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (s: unknown) => unknown) =>
    selector({ settings: { foldCompletedTurns: true } }),
}));

const ts = '2026-10-31T00:00:00Z';
const tool = (id: string): AgentMessage => ({
  id, role: 'tool', content: '', timestamp: ts,
  toolResult: { toolName: 'bash', summary: '', result: '', success: true, blocked: false, toolCallId: id },
});
const MESSAGES: AgentMessage[] = [
  { id: 'u1', role: 'user', content: '开始', timestamp: ts, turnState: 'completed' },
  tool('t1'), tool('t2'), tool('t3'),
  { id: 'mid', dbId: 'db-mid', role: 'assistant', content: '中间的结论', timestamp: ts },
  tool('t4'),
  { id: 'final', role: 'assistant', content: '最终答案', timestamp: ts },
];

let host: HTMLDivElement;
let root: Root;
let scrollIntoView: ReturnType<typeof vi.fn>;

beforeEach(() => {
  host = document.createElement('div');
  host.className = 'overflow-y-auto';
  document.body.appendChild(host);
  root = createRoot(host);
  scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView as unknown as typeof Element.prototype.scrollIntoView;
  Element.prototype.scrollBy = vi.fn() as unknown as typeof Element.prototype.scrollBy;
  useTurnFoldStore.setState({ expanded: {} });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

describe('AgentMessageList.jumpToMessage', () => {
  it('目标藏在已折叠的完成回合里：先展开该回合，再滚过去并闪一下标题块；dbId 同样能定位', async () => {
    const handle = createRef<AgentMessageListHandle>();
    act(() => root.render(
      <AgentMessageList messages={MESSAGES} conversationId="c1" listRef={handle} foldTurns />,
    ));
    expect(host.querySelector('[data-message-id="mid"]')).toBeNull();

    let ok = false;
    act(() => { ok = handle.current!.jumpToMessage('db-mid', '风险'); });
    expect(ok).toBe(true);
    expect(useTurnFoldStore.getState().expanded.c1?.['u:u1']).toBe(true);

    await wait(500);
    const target = host.querySelector('[data-message-id="mid"]');
    expect(target).not.toBeNull();
    expect(scrollIntoView).toHaveBeenCalled();
    // 有 anchor 且找得到标题 → 闪的是那个标题块，不是整条消息
    const flashed = host.querySelector('.jump-flash');
    expect(flashed?.tagName).toBe('P');
    expect(flashed?.textContent).toBe('风险');
  });

  it('anchor 找不到 → 退回闪整条消息（正文开头）', async () => {
    const handle = createRef<AgentMessageListHandle>();
    act(() => root.render(
      <AgentMessageList messages={MESSAGES} conversationId="c1" listRef={handle} foldTurns />,
    ));
    act(() => { handle.current!.jumpToMessage('mid', '不存在的标题'); });
    await wait(500);
    expect(host.querySelector('.jump-flash')?.getAttribute('data-message-id')).toBe('mid');
  });

  it('消息不存在 → 返回 false，不展开也不滚', () => {
    const handle = createRef<AgentMessageListHandle>();
    act(() => root.render(
      <AgentMessageList messages={MESSAGES} conversationId="c1" listRef={handle} foldTurns />,
    ));
    let ok = true;
    act(() => { ok = handle.current!.jumpToMessage('nope'); });
    expect(ok).toBe(false);
    expect(useTurnFoldStore.getState().expanded.c1).toBeUndefined();
  });
});
