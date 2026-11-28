// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelConfig, LlmRegistry } from '@/lib/types';
import { emptyRegistry } from '@/lib/llmRegistry';
import ChannelEditModal from './ChannelEditModal';

const tauriMocks = vi.hoisted(() => ({
  deleteLlmChannelApiKey: vi.fn(async () => undefined),
}));

vi.mock('@/lib/tauri', () => ({
  getLlmChannelHeaders: vi.fn(async () => ({})),
  saveLlmChannelHeaders: vi.fn(async () => undefined),
  deleteLlmChannelApiKey: tauriMocks.deleteLlmChannelApiKey,
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  tauriMocks.deleteLlmChannelApiKey.mockClear();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.querySelectorAll('[role="dialog"]').forEach((el) => el.remove());
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  return [...document.body.querySelectorAll('button')].find((el) => el.textContent === label) as HTMLButtonElement;
}

describe('渠道 API Key 清除', () => {
  const channel: ChannelConfig = {
    id: 'c1',
    name: 'Kimi',
    baseUrl: 'https://api.kimi.com/v1',
    enabled: true,
  };
  const registry = (): LlmRegistry => ({ ...emptyRegistry(), channels: [channel] });

  it('点「清除」后保存才会删密钥，输入框本身可清空而不是弹回掩码', async () => {
    const saved: ChannelConfig[] = [];
    await act(async () => root.render(
      <ChannelEditModal
        open
        onClose={() => {}}
        channel={channel}
        registry={registry()}
        channelHasKey
        onSave={(ch) => saved.push(ch)}
        onDelete={() => {}}
      />,
    ));
    await act(async () => { await Promise.resolve(); });

    const keyInput = document.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(keyInput.value).toBe('');
    expect(keyInput.placeholder).toContain('已保存密钥');

    await act(async () => button('清除').click());
    expect(tauriMocks.deleteLlmChannelApiKey).not.toHaveBeenCalled();

    await act(async () => { button('保存渠道').click(); });
    expect(tauriMocks.deleteLlmChannelApiKey).toHaveBeenCalledWith('c1');
    expect(saved[0].apiKey).toBe('');
  });

  it('清除后取消编辑不删密钥', async () => {
    await act(async () => root.render(
      <ChannelEditModal
        open
        onClose={() => {}}
        channel={channel}
        registry={registry()}
        channelHasKey
        onSave={() => {}}
        onDelete={() => {}}
      />,
    ));
    await act(async () => { await Promise.resolve(); });
    await act(async () => button('清除').click());
    await act(async () => button('取消').click());
    expect(tauriMocks.deleteLlmChannelApiKey).not.toHaveBeenCalled();
  });
});
