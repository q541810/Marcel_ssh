// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import AgentMessage from '@/components/agent/AgentMessage';
import type { AgentMessage as AgentMessageType } from '@/lib/types';

vi.mock('@/components/terminal/TerminalInstanceManager', () => ({ terminalInstanceManager: { get: () => undefined } }));
vi.mock('@/stores/settingsStore', () => ({ useSettingsStore: () => false }));
vi.mock('@/lib/externalLinks', () => ({ openExternalLink: vi.fn() }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function retrying(over: Partial<AgentMessageType> = {}): AgentMessageType {
  return {
    id: 'r1', role: 'system', content: '', timestamp: new Date().toISOString(),
    isRetrying: true, retryAttempt: 1, retryMaxAttempts: 3, retryTotalDelaySecs: 1,
    retryLastError: 'HTTP 502 Bad Gateway: upstream connect error', ...over,
  };
}

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('重试指示条：详情默认收起，点开才看到原始错误', () => {
  it('点「详情」展开 / 再点收起', () => {
    act(() => root.render(<AgentMessage message={retrying()} />));
    expect(container.textContent).not.toContain('HTTP 502');
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '详情')!;
    act(() => btn.click());
    expect(container.querySelector('[data-testid="retry-details"]')?.textContent).toContain('HTTP 502 Bad Gateway');
    expect(container.textContent).toContain('最多重试 3 次');
    act(() => btn.click());
    expect(container.querySelector('[data-testid="retry-details"]')).toBeNull();
  });

  it('有半截文字时不进无障碍树（只是视觉参照），状态行仍是 status', () => {
    act(() => root.render(<AgentMessage message={retrying({ retryPartialText: '半截', retryMidStream: true })} />));
    expect(container.querySelector('[data-testid="retry-partial"]')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[role="status"]')?.textContent).toContain('网络中断');
  });
});
