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
