import { beforeEach, describe, it, expect, vi } from 'vitest';
import { isAuthorized } from './auth';
import { registerStatefulVirtualCommands, ALL_COMMANDS } from './commandRegistry';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { PluginManifest } from '@/lib/types';

vi.mock('@/lib/tauri', () => ({
  pluginList: vi.fn(),
}));

// sessionStore → TerminalInstanceManager → @xterm/* 在 node 环境会因 `self`
// 未定义而崩溃。commandRegistry 间接依赖 sessionStore，这里 mock 掉以让
// 测试可在 node 下运行。
vi.mock('@/stores/sessionStore', () => ({
  useSessionStore: {
    getState: () => ({ sessions: {}, activeSessionId: null }),
  },
}));
vi.mock('@/components/terminal/TerminalInstanceManager', () => ({
  terminalInstanceManager: { getTerminal: vi.fn(), onTerminalCreated: vi.fn() },
}));

const helloManifest: PluginManifest = {
  id: 'hello',
  version: '0.1.0',
  name: 'Hello',
  publisher: 'test',
  description: '',
  capabilities: ['ssh.list', 'events', 'fs.read', 'fs.write'],
  views: [],
  agentTools: [],
  injections: [],
};

describe('isAuthorized', () => {
  beforeEach(() => {
    usePluginStore.setState({ manifests: [helloManifest], loading: false, error: null });
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        disabledPlugins: [],
        authorizedCapabilities: {},
      },
    });
  });

  it('allows declared capability when plugin is enabled', () => {
    expect(isAuthorized('hello', 'session.active').ok).toBe(true);
  });

  it('denies when plugin is in disabledPlugins', () => {
    useSettingsStore.setState({
      settings: {
        ...useSettingsStore.getState().settings,
        disabledPlugins: ['hello'],
      },
    });
    const result = isAuthorized('hello', 'session.active');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/disabled/);
  });

  it('still denies unknown plugins', () => {
    const result = isAuthorized('missing', 'session.active');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/manifest not found/);
  });
});

describe('registerStatefulVirtualCommands / ALL_COMMANDS', () => {
  it('registers stateful virtual commands into ALL_COMMANDS (so isAuthorized accepts them)', () => {
    registerStatefulVirtualCommands(
      (pid, events) => events,
      (pid, events) => events,
      () => undefined,
    );

    for (const cmd of ['events.subscribe', 'events.unsubscribe', 'config.read', 'config.write', 'config.saved']) {
      expect(ALL_COMMANDS.has(cmd), `${cmd} should be in ALL_COMMANDS`).toBe(true);
      const result = isAuthorized('hello', cmd);
      expect(result.ok, `${cmd} should be authorized: ${result.reason}`).toBe(true);
    }
  });
});
