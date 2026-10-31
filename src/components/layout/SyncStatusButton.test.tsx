// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useSyncStore } from '@/stores/syncStore';
import type { SyncStatus } from '@/lib/types';
import SyncStatusButton from './SyncStatusButton';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const openSyncSettings = vi.hoisted(() => vi.fn());
vi.mock('@/lib/syncNav', () => ({ openSyncSettings }));
vi.mock('@/lib/tauri', () => ({}));

function status(state: SyncStatus['state'], enabled = true): SyncStatus {
  return {
    enabled,
    state,
    lastSyncAt: null,
    lastError: state === 'error' ? '连不上服务器' : null,
    pendingCount: 0,
    deviceId: 'd',
    deviceName: 'n',
    storage: null,
    held: null,
    tiers: { config: true, conversation: false, secret: false },
    streams: [],
  };
}

describe('SyncStatusButton（桌面顶栏）', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    openSyncSettings.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(s: SyncStatus | null) {
    useSyncStore.setState({ status: s });
    act(() => root.render(<SyncStatusButton />));
  }

  it.each<SyncStatus['state']>(['idle', 'syncing', 'off'])('正常 / 同步中 / 未开启（%s）：不占位不打扰', (state) => {
    render(status(state, state !== 'off'));
    expect(container.querySelector('button')).toBeNull();
  });

  it('还没拿到状态：不显示', () => {
    render(null);
    expect(container.querySelector('button')).toBeNull();
  });

  it.each<SyncStatus['state']>(['error', 'needsConfirm', 'needsUpgrade'])('%s：出现图标，点开跳到同步分区', (state) => {
    render(status(state));
    const button = container.querySelector('button')!;
    expect(button).not.toBeNull();
    expect(button.getAttribute('aria-label')).toContain('跨设备同步');
    act(() => button.click());
    expect(openSyncSettings).toHaveBeenCalledTimes(1);
  });

  it('出错用红色、其余用琥珀色', () => {
    render(status('error'));
    expect(container.querySelector('button')!.className).toContain('text-red-400');
    render(status('needsUpgrade'));
    expect(container.querySelector('button')!.className).toContain('text-amber-400');
  });
});
