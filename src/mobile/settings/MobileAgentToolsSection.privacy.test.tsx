// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AppSettings, SavedConnection } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  privacy: false,
  connections: [] as SavedConnection[],
  update: vi.fn(),
}));

vi.mock('@/hooks/usePrivacyMode', () => ({
  usePrivacyMode: () => mocks.privacy,
}));

vi.mock('@/stores/connectionStore', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ connections: mocks.connections, fetchConnections: vi.fn() }),
}));

vi.mock('@/stores/settingsStore', () => ({
  DEFAULT_EXPERIMENTAL_SETTINGS: {
    enableWebSearch: false,
    enableHttpFetch: false,
    multiHostConnectionIds: [],
  },
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ hasWebSearchApiKey: false }),
}));

import { MobileAgentToolsSection } from './MobileAgentToolsSection';
import { SettingsActionsProvider } from '@/components/settings/SettingsActionsContext';

const CURRENT: SavedConnection = {
  id: 'c1',
  name: '生产机',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authMethod: 'Password',
};

let container: HTMLDivElement;
let root: Root;

async function render() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const value = {
    settings: {
      experimentalSettings: { multiHostConnectionIds: [] },
      privacyMode: mocks.privacy,
    } as unknown as AppSettings,
    update: mocks.update,
    setPreview: vi.fn(),
    saving: false,
    saveError: null,
    validationErrors: [],
    registerValidator: () => () => {},
    clearValidationErrors: () => {},
  };
  await act(async () => {
    root.render(
      <SettingsActionsProvider value={value}>
        <MobileAgentToolsSection />
      </SettingsActionsProvider>,
    );
  });
}

beforeEach(() => {
  mocks.privacy = false;
  mocks.connections = [CURRENT];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

/**
 * 隐私模式：设置页「多机操控目标」清单里的 `user@host:port` 也要脱敏
 * （与连接列表、多机选择器同一口径 —— lib/privacy 的 formatConnLabel）。
 */
describe('移动端 Agent 工具设置的多机清单隐私模式', () => {
  it('关闭时显示真实地址', async () => {
    await render();

    expect(container.textContent).toContain('root@10.0.0.1:22');
  });

  it('开启时脱敏，且不泄漏真实主机与端口', async () => {
    mocks.privacy = true;
    await render();

    expect(container.textContent).toContain('root@***:****');
    expect(container.textContent).not.toContain('10.0.0.1');
  });
});
