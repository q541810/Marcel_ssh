import { beforeEach, describe, it, expect, vi } from 'vitest';
import { usePluginStore } from '@/stores/pluginStore';
import { useViewStore } from '@/stores/viewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import type { PluginManifest } from '@/lib/types';

vi.mock('@/lib/tauri', () => ({
  pluginList: vi.fn(),
}));

import * as tauri from '@/lib/tauri';

const testManifests: PluginManifest[] = [
  {
    id: 'hello',
    version: '0.1.0',
    name: 'Hello',
    publisher: 'test',
    description: 'test plugin',
    capabilities: [],
    views: [
      { id: 'v1', mount: 'sidebar', title: 'Hello', order: 10, entry: 'index.html' },
    ],
    agentTools: [],
    injections: [],
  },
  {
    id: 'world',
    version: '0.2.0',
    name: 'World',
    publisher: 'test',
    description: 'another plugin',
    capabilities: [],
    views: [
      { id: 'v1', mount: 'settings', title: 'World', order: 20, entry: 'index.html' },
    ],
    agentTools: [],
    injections: [],
  },
];

const testManifestWithIcons: PluginManifest = {
  id: 'icon-test',
  version: '1.0.0',
  name: 'Icon Test',
  publisher: 'test',
  description: '',
  capabilities: [],
  views: [
    { id: 'svg', mount: 'sidebar', title: 'SVG', order: 10, entry: 'i.html', icon: { kind: 'svg', src: 'icon.svg' } },
    { id: 'img', mount: 'sidebar', title: 'IMG', order: 20, entry: 'i.html', icon: { kind: 'img', src: 'icon.png' } },
    { id: 'unknown', mount: 'sidebar', title: 'UNK', order: 30, entry: 'i.html', icon: { kind: 'emoji', src: '🎉' } },
    { id: 'none', mount: 'sidebar', title: 'NONE', order: 40, entry: 'i.html' },
  ],
  agentTools: [],
  injections: [],
};

describe('pluginStore', () => {
  beforeEach(() => {
    vi.mocked(tauri.pluginList).mockReset();
    useViewStore.setState({ providers: [] });
    usePluginStore.setState({ manifests: [], loading: false, error: null });
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, disabledPlugins: [] },
    });
  });

  it('fetchPlugins registers enabled plugins as view providers', async () => {
    vi.mocked(tauri.pluginList).mockResolvedValue(testManifests);
    await usePluginStore.getState().fetchPlugins();

    const providerIds = useViewStore.getState().providers.map((p) => p.id);
    expect(providerIds).toContain('hello.v1');
    expect(providerIds).toContain('world.v1');
  });

  it('fetchPlugins skips disabled plugins', async () => {
    vi.mocked(tauri.pluginList).mockResolvedValue(testManifests);
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, disabledPlugins: ['hello'] },
    });
    await usePluginStore.getState().fetchPlugins();

    const providerIds = useViewStore.getState().providers.map((p) => p.id);
    expect(providerIds).not.toContain('hello.v1');
    expect(providerIds).toContain('world.v1');
  });

  it('fetchPlugins unregisters providers when a plugin becomes disabled', async () => {
    vi.mocked(tauri.pluginList).mockResolvedValue(testManifests);
    // Simulate startup race: first fetch with empty disabled list.
    await usePluginStore.getState().fetchPlugins();
    expect(useViewStore.getState().providers.map((p) => p.id)).toContain('hello.v1');

    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, disabledPlugins: ['hello'] },
    });
    await usePluginStore.getState().fetchPlugins();

    const providerIds = useViewStore.getState().providers.map((p) => p.id);
    expect(providerIds).not.toContain('hello.v1');
    expect(providerIds).toContain('world.v1');
  });

  it('fetchPlugins re-registers providers when a plugin is re-enabled', async () => {
    vi.mocked(tauri.pluginList).mockResolvedValue(testManifests);
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, disabledPlugins: ['hello'] },
    });
    await usePluginStore.getState().fetchPlugins();
    expect(useViewStore.getState().providers.map((p) => p.id)).not.toContain('hello.v1');

    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, disabledPlugins: [] },
    });
    await usePluginStore.getState().fetchPlugins();

    expect(useViewStore.getState().providers.map((p) => p.id)).toContain('hello.v1');
  });

  it('fetchPlugins stores all manifests regardless of disabled state', async () => {
    vi.mocked(tauri.pluginList).mockResolvedValue(testManifests);
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, disabledPlugins: ['hello'] },
    });
    await usePluginStore.getState().fetchPlugins();

    expect(usePluginStore.getState().manifests).toHaveLength(2);
    expect(usePluginStore.getState().manifests.map((m) => m.id)).toEqual(['hello', 'world']);
  });

  it('fetchPlugins clears old non-builtin providers before registering', async () => {
    useViewStore.getState().register({
      id: 'old-plugin.view',
      pluginId: 'old-plugin',
      mount: 'sidebar',
      title: 'old',
      icon: { kind: 'react', node: null },
      order: 10,
      component: async () => ({ default: () => null }),
    });

    vi.mocked(tauri.pluginList).mockResolvedValue(testManifests);
    await usePluginStore.getState().fetchPlugins();

    const providerIds = useViewStore.getState().providers.map((p) => p.id);
    expect(providerIds).not.toContain('old-plugin.view');
    expect(providerIds).toContain('hello.v1');
  });

  it('fetchPlugins sets error on failure', async () => {
    vi.mocked(tauri.pluginList).mockRejectedValue(new Error('network error'));
    await usePluginStore.getState().fetchPlugins();

    expect(usePluginStore.getState().error).toBeTruthy();
    expect(usePluginStore.getState().loading).toBe(false);
  });

  it('fetchPlugins resolves plugin icons by kind', async () => {
    vi.mocked(tauri.pluginList).mockResolvedValue([testManifestWithIcons]);
    await usePluginStore.getState().fetchPlugins();

    const providers = useViewStore.getState().providers;
    const svg = providers.find((p) => p.id === 'icon-test.svg');
    const img = providers.find((p) => p.id === 'icon-test.img');
    const unk = providers.find((p) => p.id === 'icon-test.unknown');
    const none = providers.find((p) => p.id === 'icon-test.none');

    expect(svg?.icon).toEqual({ kind: 'svg', path: 'plugin://icon-test/icon.svg' });
    expect(img?.icon).toEqual({ kind: 'img', src: 'plugin://icon-test/icon.png' });
    expect(unk?.icon).toEqual({ kind: 'react', node: expect.anything() });
    expect(none?.icon).toEqual({ kind: 'react', node: expect.anything() });
  });
});
