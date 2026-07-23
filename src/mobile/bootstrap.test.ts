import { describe, it, expect, vi, beforeEach } from 'vitest';
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
      checkUpdate: vi.fn().mockResolvedValue({
        hasUpdate: false,
        latestVersion: '',
        releaseUrl: '',
      }),
      onUpdateAvailable: vi.fn(),
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

  it('notifies when an update is available', async () => {
    deps.checkUpdate = vi.fn().mockResolvedValue({
      hasUpdate: true,
      latestVersion: '9.9.9',
      releaseUrl: 'https://example.com/releases',
    });
    await runMobileBootstrap(deps);
    expect(deps.onUpdateAvailable).toHaveBeenCalledWith(
      '9.9.9',
      'https://example.com/releases',
    );
  });

  it('stays silent when no update or the check fails', async () => {
    await runMobileBootstrap(deps);
    expect(deps.onUpdateAvailable).not.toHaveBeenCalled();

    deps.checkUpdate = vi.fn().mockRejectedValue(new Error('offline'));
    await runMobileBootstrap(deps);
    expect(deps.onUpdateAvailable).not.toHaveBeenCalled();
  });
});
