// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '@/lib/types';
import { emptyRegistry } from '@/lib/llmRegistry';
import { SettingsActionsProvider } from '@/components/settings/SettingsActionsContext';
import { MobileModelSection } from './MobileModelSection';

vi.mock('@/lib/tauri', () => ({
  llmListModels: vi.fn(async () => [{ id: 'kimi-k3' }]),
  getLlmChannelHeaders: vi.fn(async () => ({})),
  saveLlmChannelHeaders: vi.fn(async () => undefined),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.querySelectorAll('[role="dialog"]').forEach((el) => el.remove());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Android 新增模型自动填充', () => {
  it('从模型列表预选时立即填表，保存仍是已有 ModelEntry', async () => {
    const updates: Partial<AppSettings>[] = [];
    const registry = emptyRegistry();
    registry.channels.push({ id: 'channel', name: 'Kimi', baseUrl: 'https://api.kimi.com/coding/v1', enabled: true });
    await act(async () => root.render(
      <SettingsActionsProvider value={{
        settings: { llmRegistry: registry } as AppSettings,
        update: (patch) => updates.push(patch),
        setPreview: () => {}, saving: false, saveError: null, validationErrors: [],
        registerValidator: () => () => {}, clearValidationErrors: () => {},
      }}>
        <MobileModelSection />
      </SettingsActionsProvider>,
    ));
    await act(async () => [...document.body.querySelectorAll('button')].find((el) => el.textContent?.includes('Kimi'))!.click());
    await act(async () => [...document.body.querySelectorAll('button')].find((el) => el.textContent === '获取列表')!.click());
    await act(async () => { await Promise.resolve(); });
    await act(async () => [...document.body.querySelectorAll('button')].find((el) => el.textContent === 'kimi-k3')!.click());
    await act(async () => { vi.advanceTimersByTime(450); });
    const dialog = [...document.body.querySelectorAll('[role="dialog"]')].find((el) => el.textContent?.includes('API 模型名'))!;
    const context = dialog.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
    expect(context?.value).toBe('1048576');
    await act(async () => [...dialog.querySelectorAll('button')].find((el) => el.textContent === '保存')!.click());
    // 模型先进入渠道草稿，保存渠道时才进入既有设置更新链路。
    await act(async () => [...document.body.querySelectorAll('button')].find((el) => el.textContent === '保存渠道')!.click());
    const model = updates[updates.length - 1]?.llmRegistry?.models[0];
    expect(model).toMatchObject({ modelName: 'kimi-k3', contextWindow: 1048576, vision: true, reasoningEfforts: ['low', 'high', 'max'] });
  });
});
