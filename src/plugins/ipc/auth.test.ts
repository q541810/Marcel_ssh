import { beforeEach, describe, it, expect, vi } from 'vitest';
import { isAuthorized } from './auth';
import { usePluginStore } from '@/stores/pluginStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { PluginManifest } from '@/lib/types';

vi.mock('@/lib/tauri', () => ({
  pluginList: vi.fn(),
}));

const helloManifest: PluginManifest = {
  id: 'hello',
  version: '0.1.0',
  name: 'Hello',
  publisher: 'test',
  description: '',
  capabilities: ['ssh.list', 'events'],
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
