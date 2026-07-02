import { create } from 'zustand';
import { Plug } from 'lucide-react';
import type { PluginManifest, PluginViewDef, ViewProvider } from '@/lib/types';
import { useViewStore } from '@/stores/viewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { destroyAll as destroyAllWebviews } from '@/plugins/pluginWebviewPool';
import {
  activatePluginInjections,
  deactivatePluginInjections,
  deactivateAllInjections,
  rehydratePluginInjections,
  getAllRuntimes,
} from '@/plugins/injection';

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

/** Whether a plugin is allowed to inject content scripts. Requires:
 *  - declares `ui.inject` capability
 *  - has at least one injection def
 *  - global safe-mode (`disableAllInjections`) is off
 *  - the `ui.inject` capability is authorized for this plugin */
function isInjectionsAuthorized(m: PluginManifest): boolean {
  if (m.injections.length === 0) return false;
  if (!m.capabilities.includes('ui.inject')) return false;
  const settings = useSettingsStore.getState().settings;
  if (settings.disableAllInjections) return false;
  const authorizedMap = settings.authorizedCapabilities ?? {};
  if (!(m.id in authorizedMap)) return true; // backward compat: all declared authorized
  return (authorizedMap[m.id] ?? []).includes('ui.inject');
}

interface PluginState {
  manifests: PluginManifest[];
  loading: boolean;
  error: string | null;
  refreshKey: number;

  fetchPlugins: () => Promise<void>;
  /** Reconcile active content-script injections with current manifests +
   *  settings. Deactivates injections for disabled/unauthorized plugins,
   *  activates for newly-enabled ones. Called after fetchPlugins and on
   *  settings changes (disabledPlugins / disableAllInjections /
   *  authorizedCapabilities). */
  syncInjections: () => void;
  /** Re-run already-active injections after React remounts a region and destroys
   *  plugin-owned DOM nodes. Unlike syncInjections, this is only for remount
   *  recovery and intentionally re-executes existing runtimes. */
  rehydrateInjections: () => void;
}

export const usePluginStore = create<PluginState>((set, get) => ({
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
      // 同样销毁所有 content-script 注入，刷新时按需重建
      deactivateAllInjections();

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

      // Activate injections for eligible plugins (fire-and-forget; resource
      // fetches happen asynchronously).
      get().syncInjections();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },

  syncInjections: () => {
    const manifests = get().manifests;
    const disabled = getDisabledPlugins();
    const desired = new Set<string>();

    for (const m of manifests) {
      if (disabled.has(m.id)) continue;
      if (!isInjectionsAuthorized(m)) continue;
      desired.add(m.id);
    }

    // Deactivate plugins that are no longer desired.
    // (We can't enumerate active plugin IDs cheaply here without importing
    //  getAllRuntimes; the injection module tracks that. Instead, check each
    //  manifest that previously had injections.)
    for (const m of manifests) {
      if (!desired.has(m.id) && m.injections.length > 0) {
        deactivatePluginInjections(m.id);
      }
    }

    // Activate desired plugins. Already-active injections are skipped by the
    // injector, so repeated sync calls during startup/settings changes are safe.
    for (const id of desired) {
      const m = manifests.find((mm) => mm.id === id);
      if (m) {
        // Fire-and-forget; errors are reported via the lifecycle registry.
        activatePluginInjections(m).catch((err) => {
          console.error(`[pluginStore] injection activation failed for ${id}:`, err);
        });
      }
    }
  },

  rehydrateInjections: () => {
    const manifests = get().manifests;
    const activePluginIds = new Set(getAllRuntimes().map((rt) => rt.pluginId));
    for (const m of manifests) {
      if (!activePluginIds.has(m.id)) continue;
      if (getDisabledPlugins().has(m.id)) continue;
      if (!isInjectionsAuthorized(m)) continue;
      rehydratePluginInjections(m).catch((err) => {
        console.error(`[pluginStore] rehydration failed for ${m.id}:`, err);
      });
    }
  },
}));
