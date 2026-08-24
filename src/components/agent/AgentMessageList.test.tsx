import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentMessageList from '@/components/agent/AgentMessageList';
import type { AgentMessage } from '@/lib/types';

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => false,
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
