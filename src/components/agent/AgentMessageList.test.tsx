import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentMessageList, { alignedWindowStart } from '@/components/agent/AgentMessageList';
import type { AgentMessage } from '@/lib/types';

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector?: (s: unknown) => unknown) =>
    selector?.({ settings: { foldCompletedTurns: false } }) ?? { settings: { foldCompletedTurns: false } },
}));

vi.mock('@/lib/externalLinks', () => ({
  openExternalLink: vi.fn(),
}));

function createMockMessages(count: number): AgentMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `msg-${i + 1}`,
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: `Message content ${i + 1}`,
    timestamp: new Date(Date.now() + i * 1000).toISOString(),
  }));
}

describe('alignedWindowStart', () => {
  // user 在偶数下标（0,2,4...），assistant 在奇数下标 —— 模拟真实回合。
  it('起点是 user 时保持不变', () => {
    const msgs = createMockMessages(10);
    expect(alignedWindowStart(msgs, 4)).toBe(6); // msg-7(user) 在 idx6
  });

  it('起点切在回合中间（非 user）时前移到该回合的 user', () => {
    const msgs = createMockMessages(10);
    // 取 5 条 → start=5（assistant，回合中间）→ 前移到 idx4(user)
    expect(alignedWindowStart(msgs, 5)).toBe(4);
  });

  it('消息流以非 user 开头且找不到更早 user 时保持原起点（半截兜底）', () => {
    const msgs = createMockMessages(10).slice(1); // 从 assistant 开始
    // start=0（取全部）→ 不越界返回 0
    expect(alignedWindowStart(msgs, 10)).toBe(0);
    // 9 条：idx6 是 assistant → 前移找 user 到 idx5
    expect(alignedWindowStart(msgs, 3)).toBe(5);
  });

  it('窗口覆盖全量时起点为 0', () => {
    const msgs = createMockMessages(10);
    expect(alignedWindowStart(msgs, 10)).toBe(0);
    expect(alignedWindowStart(msgs, 99)).toBe(0);
  });
});

describe('AgentMessageList Pagination & Infinite Scroll', () => {
  it('renders all messages when total count <= 50', () => {
    const messages = createMockMessages(30);
    const html = renderToStaticMarkup(
      <AgentMessageList
        messages={messages}
        isThinking={false}
      />
    );

    expect(html).not.toContain('加载更早消息...');
    expect(html).toContain('Message content 1');
    expect(html).toContain('Message content 30');
  });

  it('slices to latest 50 messages when total count > 50', () => {
    const messages = createMockMessages(80);
    const html = renderToStaticMarkup(
      <AgentMessageList
        messages={messages}
        isThinking={false}
      />
    );

    // 顶部出现加载更早提示
    expect(html).toContain('加载更早消息...');
    // 早期消息未在 DOM 中渲染 (msg-1 到 msg-30)
    expect(html).not.toContain('Message content 1');
    expect(html).not.toContain('Message content 30');
    // 最近 50 条已渲染 (msg-31 到 msg-80)
    expect(html).toContain('Message content 31');
    expect(html).toContain('Message content 80');
  });

  it('renders target message when highlightMessageId targets an earlier message', () => {
    const messages = createMockMessages(120);
    const html = renderToStaticMarkup(
      <AgentMessageList
        messages={messages}
        isThinking={false}
        highlightMessageId="msg-10"
      />
    );

    // 含有 highlightMessageId="msg-10" 时自动扩展包含早期消息
    expect(html).toContain('Message content 10');
    expect(html).toContain('Message content 120');
  });
});
