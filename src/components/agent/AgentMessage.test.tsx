import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import AgentMessage from '@/components/agent/AgentMessage';
import type { AgentMessage as AgentMessageType } from '@/lib/types';

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: () => false,
}));

vi.mock('@/lib/externalLinks', () => ({
  openExternalLink: vi.fn(),
}));

function makeUserMessage(overrides: Partial<AgentMessageType> = {}): AgentMessageType {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'rollback this prompt',
    timestamp: '2026-01-01T00:01:00Z',
    ...overrides,
  };
}

function makeRetryingMessage(overrides: Partial<AgentMessageType> = {}): AgentMessageType {
  return {
    id: 'retry-1',
    role: 'system',
    content: '',
    timestamp: new Date().toISOString(),
    isRetrying: true,
    retryAttempt: 2,
    retryMaxAttempts: 4,
    retryTotalDelaySecs: 5,
    retryLastError: 'HTTP 429 Too Many Requests',
    ...overrides,
  };
}

describe('AgentMessage user actions', () => {
  it('renders user message metadata and action buttons', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeUserMessage()}
        onRollback={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    expect(html).toContain('rollback this prompt');
    expect(html).toContain('title="撤回到这条消息"');
    expect(html).toContain('title="复制消息"');
  });

  it('disables rollback while an agent task is running', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeUserMessage()}
        rollbackDisabled
        onRollback={vi.fn()}
        onCopy={vi.fn()}
      />,
    );

    expect(html).toContain('title="任务运行中，暂不能撤回"');
    expect(html).toContain('disabled=""');
  });
});

describe('AgentMessage retry indicator', () => {
  it('shows countdown and attempt count in waiting phase', () => {
    // timestamp = now, so remaining ≈ full 5s → waiting phase
    const html = renderToStaticMarkup(
      <AgentMessage message={makeRetryingMessage()} />,
    );

    // waiting phase: shows "Ns 后重试 (2/4)"
    expect(html).toMatch(/\d+s 后重试/);
    expect(html).toContain('(2/4)');
    // clock icon present (waiting), not spinner-only
    expect(html).toContain('cx="12" cy="12" r="9"');
  });

  it('shows retrying phase when countdown has elapsed', () => {
    // timestamp 10s ago, delay 5s → remaining = 0 → retrying phase
    const tenSecondsAgo = new Date(Date.now() - 10_000).toISOString();
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeRetryingMessage({ timestamp: tenSecondsAgo })}
      />,
    );

    expect(html).toContain('正在重试请求');
    expect(html).toContain('(2/4)');
    expect(html).toContain('animate-spin');
  });

  it('shows error summary and is expandable when error is long', () => {
    const longError = 'x'.repeat(120);
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeRetryingMessage({ retryLastError: longError })}
      />,
    );

    // summary truncated to 80 chars + ellipsis
    expect(html).toContain('x'.repeat(80) + '…');
    // expandable: has title attribute for toggle
    expect(html).toContain('点击展开完整错误');
  });

  it('shows full short error inline without expand control', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeRetryingMessage({ retryLastError: 'timeout' })}
      />,
    );

    expect(html).toContain('timeout');
    // short error: no expand title
    expect(html).not.toContain('点击展开完整错误');
  });

  it('hides attempt count when maxAttempts is 0', () => {
    const html = renderToStaticMarkup(
      <AgentMessage
        message={makeRetryingMessage({ retryMaxAttempts: 0 })}
      />,
    );

    expect(html).not.toContain('(2/0)');
    expect(html).not.toContain('(2/');
  });
});
