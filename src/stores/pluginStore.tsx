import { create } from 'zustand';
import { Plug } from 'lucide-react';
import type { PluginManifest, PluginViewDef, ViewProvider } from '@/lib/types';
import { useViewStore } from '@/stores/viewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { destroyAll as destroyAllWebviews } from '@/plugins/pluginWebviewPool';

const DEFAULT_PLUGIN_ICON = { kind: 'react' as const, node: <Plug className="w-5 h-5" /> };

function resolvePluginIcon(manifest: PluginManifest, view: PluginViewDef): ViewProvider['icon'] {
  if (!view.icon) return DEFAULT_PLUGIN_ICON;

  if (view.icon.kind === 'svg') {
    return { kind: 'svg', path: `plugin://${manifest.id}/${view.icon.src}` };
  }

  if (view.icon.kind === 'img') {
    return { kind: 'img', src: `plugin://${manifest.id}/${view.icon.src}` };
  }

  return DEFAULT_PLUGIN_ICON;
}

function manifestViewToProvider(
  manifest: PluginManifest,
  view: PluginViewDef,
): ViewProvider {
  return {
    id: `${manifest.id}.${view.id}`,
    pluginId: manifest.id,
    mount: view.mount,
    title: view.title,
    icon: resolvePluginIcon(manifest, view),
    navGroup: view.navGroup,
    order: view.order,
    exclusive: view.exclusive,
    webviewEntry: view.entry,
    component: async () => ({ default: () => null }),
  };
}

function getDisabledPlugins(): Set<string> {
  return new Set(useSettingsStore.getState().settings.disabledPlugins ?? []);
}

interface PluginState {
  manifests: PluginManifest[];
  loading: boolean;
  error: string | null;
  refreshKey: number;

  fetchPlugins: () => Promise<void>;
}

export const usePluginStore = create<PluginState>((set) => ({
  manifests: [],
  loading: false,
  error: null,
  refreshKey: 0,

  fetchPlugins: async () => {
    set({ loading: true, error: null });
    try {
      const manifests = await tauri.pluginList();
      const disabled = getDisabledPlugins();

      // 销毁所有池中 WebView，插件刷新时强制重建
      await destroyAllWebviews();

      const viewState = useViewStore.getState();
      const oldPluginIds = new Set(
        viewState.providers
          .filter((p) => p.pluginId !== 'builtin')
          .map((p) => p.pluginId),
      );
      oldPluginIds.forEach((id) => {
        viewState.unregister(id);
      });

      for (const m of manifests) {
        if (disabled.has(m.id)) continue;
        for (const v of m.views) {
          viewState.register(manifestViewToProvider(m, v));
        }
      }

      set({ manifests, loading: false, refreshKey: Date.now() });
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },
}));
