// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SavedConnection } from '@/lib/types';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** MobileSheet 用它量滚动区；jsdom 不实现。 */
(globalThis as Record<string, unknown>).ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const mocks = vi.hoisted(() => ({
  privacy: false,
  connections: [] as SavedConnection[],
}));

vi.mock('@/hooks/usePrivacyMode', () => ({
  usePrivacyMode: () => mocks.privacy,
}));

vi.mock('@/stores/connectionStore', () => ({
  useConnectionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ connections: mocks.connections, fetchConnections: vi.fn() }),
}));

vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      sessions: { s1: { id: 's1', configId: 'c1', connectionId: 'c1', status: 'connected' } },
      activeSessionId: 's1',
    }),
}));

vi.mock('@/stores/settingsStore', () => ({
  DEFAULT_EXPERIMENTAL_SETTINGS: { multiHostConnectionIds: [] },
  useSettingsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      settings: { experimentalSettings: { multiHostConnectionIds: [] } },
      update: vi.fn(),
    }),
}));

import MobileMultiHostPicker from './MobileMultiHostPicker';

const CURRENT: SavedConnection = {
  id: 'c1',
  name: '生产机',
  host: '10.0.0.1',
  port: 22,
  username: 'root',
  authMethod: 'Password',
};

/** 当前机之外的另一台：多机清单里就是它漏掉了脱敏。 */
const OTHER: SavedConnection = {
  id: 'c2',
  name: '备份机',
  host: 'db.internal',
  port: 2222,
  username: 'deploy',
  authMethod: 'PrivateKey',
};

let container: HTMLDivElement;
let root: Root;

async function openPicker() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<MobileMultiHostPicker />);
  });
  const trigger = Array.from(container.querySelectorAll('button')).find((b) =>
    (b.textContent ?? '').includes('生产机'),
  );
  if (!trigger) throw new Error('找不到目标机器按钮');
  await act(async () => {
    trigger.click();
  });
  await act(async () => {});
}

beforeEach(() => {
  mocks.privacy = false;
  mocks.connections = [CURRENT, OTHER];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  // Sheet 用 createPortal 挂到 body，卸载后清掉残留容器
  document.body.innerHTML = '';
});

/**
 * 隐私模式：移动端目标机器浮层里的 `user@host:port` 也要脱敏，与桌面
 * MultiHostPicker、连接列表同一口径（lib/privacy 的 formatConnLabel 是唯一来源）。
 */
describe('移动端多机目标清单的隐私模式', () => {
  it('关闭时显示真实地址', async () => {
    await openPicker();

    expect(document.body.textContent).toContain('root@10.0.0.1:22');
    expect(document.body.textContent).toContain('deploy@db.internal:2222');
  });

  it('开启时主机与端口都脱敏，且不泄漏真实值', async () => {
    mocks.privacy = true;
    await openPicker();

    expect(document.body.textContent).toContain('root@***:****');
    expect(document.body.textContent).toContain('deploy@***:****');
    expect(document.body.textContent).not.toContain('10.0.0.1');
    expect(document.body.textContent).not.toContain('db.internal');
    expect(document.body.textContent).not.toContain('2222');
  });
});
