import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/components/terminal/TerminalInstanceManager', () => ({
  terminalInstanceManager: {
    prepareReconnect: vi.fn(),
    onReconnected: vi.fn(),
    showDisconnectBanner: vi.fn(),
    setStdinEnabled: vi.fn(),
  },
}));

vi.mock('@/stores/sftpTransferManager', () => ({
  attachTransferListeners: vi.fn(),
  detachTransferListeners: vi.fn(),
}));

import {
  resolveBootstrapMode,
  runMobileBootstrap,
  type MobileBootstrapDeps,
} from './bootstrap';

describe('resolveBootstrapMode', () => {
  it('returns valid agent modes', () => {
    expect(resolveBootstrapMode('plan')).toBe('plan');
    expect(resolveBootstrapMode('agent')).toBe('agent');
    expect(resolveBootstrapMode('auto')).toBe('auto');
  });

  it('returns null for missing or invalid modes', () => {
    expect(resolveBootstrapMode(undefined)).toBeNull();
    expect(resolveBootstrapMode('')).toBeNull();
    expect(resolveBootstrapMode('hack')).toBeNull();
  });
});

describe('runMobileBootstrap', () => {
  let deps: MobileBootstrapDeps;

  beforeEach(() => {
    deps = {
      appReady: vi.fn().mockResolvedValue(undefined),
      loadSettings: vi.fn().mockResolvedValue(undefined),
      getDefaultAgentMode: vi.fn().mockReturnValue('auto'),
      setMode: vi.fn(),
      fetchSkills: vi.fn().mockResolvedValue(undefined),
      attachTransferListeners: vi.fn().mockResolvedValue(undefined),
      startForegroundServiceIfEnabled: vi.fn(),
    };
  });

  it('shows window first, then loads settings/mode/skills/transfers', async () => {
    const order: string[] = [];
    deps.appReady = vi.fn(async () => {
      order.push('appReady');
    });
    deps.loadSettings = vi.fn(async () => {
      order.push('loadSettings');
    });
    deps.startForegroundServiceIfEnabled = vi.fn(() => {
      order.push('startForegroundServiceIfEnabled');
    });

    await runMobileBootstrap(deps);

    expect(deps.appReady).toHaveBeenCalledOnce();
    expect(deps.loadSettings).toHaveBeenCalledOnce();
    expect(deps.getDefaultAgentMode).toHaveBeenCalledOnce();
    expect(deps.setMode).toHaveBeenCalledWith('auto');
    expect(deps.startForegroundServiceIfEnabled).toHaveBeenCalledOnce();
    expect(deps.fetchSkills).toHaveBeenCalledOnce();
    expect(deps.attachTransferListeners).toHaveBeenCalledOnce();
    expect(order).toEqual(['appReady', 'loadSettings', 'startForegroundServiceIfEnabled']);
  });

  it('still boots when appReady rejects (browser preview)', async () => {
    deps.appReady = vi.fn().mockRejectedValue(new Error('no tauri'));
    await runMobileBootstrap(deps);
    expect(deps.loadSettings).toHaveBeenCalledOnce();
  });

  it('skips setMode when defaultAgentMode is invalid', async () => {
    deps.getDefaultAgentMode = vi.fn().mockReturnValue('nope');
    await runMobileBootstrap(deps);
    expect(deps.setMode).not.toHaveBeenCalled();
    expect(deps.fetchSkills).toHaveBeenCalledOnce();
    expect(deps.attachTransferListeners).toHaveBeenCalledOnce();
  });

  it('still attaches listeners when fetchSkills rejects', async () => {
    deps.fetchSkills = vi.fn().mockRejectedValue(new Error('skills down'));
    await runMobileBootstrap(deps);
    expect(deps.attachTransferListeners).toHaveBeenCalledOnce();
  });

  // 更新提示的职责已移出 bootstrap：后端 updater 自查并 emit `update://state`，
  // 前端由 useUpdateStore 统一镜像（两端同一判定），判定逻辑的测试见
  // src/stores/updateStore.test.ts。
});
