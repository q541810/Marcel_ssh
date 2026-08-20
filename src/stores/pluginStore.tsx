import { create } from 'zustand';
import { Plug } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import type { PluginManifest, PluginViewDef, ReloadDiff, ViewProvider } from '@/lib/types';
import { useViewStore } from '@/stores/viewStore';
import { useSettingsStore } from '@/stores/settingsStore';
import * as tauri from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import { satisfiesMinVersion } from '@/lib/semver';
import {
  destroyAll as destroyAllWebviews,
  destroyByPlugin as destroyWebviewByPlugin,
  resync as resyncWebviewPool,
} from '@/plugins/pluginWebviewPool';
import {
  activatePluginInjections,
  deactivatePluginInjections,
  deactivateAllInjections,
  rehydratePluginInjections,
  getAllRuntimes,
} from '@/plugins/injection';
import { removePluginSubscriptions } from '@/plugins/ipc/eventFanout';

const DEFAULT_PLUGIN_ICON = { kind: 'react' as const, node: <Plug className="w-5 h-5" /> };

function resolvePluginIcon(manifest: PluginManifest, view: PluginViewDef): ViewProvider['icon'] {
  if (!view.icon) return DEFAULT_PLUGIN_ICON;

  if (view.icon.kind === 'svg') {
    return { kind: 'svg', path: `plugin://${manifest.id}/${view.icon.src}` };
  }

  if (view.icon.kind === 'img') {
    return { kind: 'img', src: `plugin://${manifest.id}/${view.icon.src}` };
  }

  // 'emoji' kind: no dedicated ViewIcon variant yet; fall back to default.
  return DEFAULT_PLUGIN_ICON;
}

function manifestViewToProvider(
  manifest: PluginManifest,
  view: PluginViewDef,
): ViewProvider | null {
  // viewStore / NavRail only host MountPoint mounts; plugin `settings` views
  // are not registered here (configView + settings UI handle configuration).
  if (view.mount !== 'sidebar') return null;
  return {
    id: `${manifest.id}.${view.id}`,
    pluginId: manifest.id,
    mount: 'sidebar',
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

/**
 * 计算因版本不兼容而应视为禁用的插件集合。
 * 必须在任何视图注册/注入激活之前执行，保证首装不兼容插件永不加载。
 * 复用 disabled 语义：不兼容 == 关闭，用户升级后需手动开启。
 */
function getIncompatibleIds(manifests: PluginManifest[], appVersion: string): Set<string> {
  const out = new Set<string>();
  if (!appVersion) return out;
  for (const m of manifests) {
    const min = m.minAppVersion;
    if (min && !satisfiesMinVersion(appVersion, min)) {
      out.add(m.id);
    }
  }
  return out;
}

function getEffectiveDisabled(manifests: PluginManifest[], appVersion: string): Set<string> {
  const disabled = getDisabledPlugins();
  const incompatible = getIncompatibleIds(manifests, appVersion);
  for (const id of incompatible) disabled.add(id);
  return disabled;
}

let cachedAppVersion: string | null = null;
async function resolveAppVersion(): Promise<string> {
  if (cachedAppVersion !== null) return cachedAppVersion;
  try {
    const v = await getVersion();
    cachedAppVersion = v;
    return v;
  } catch {
    cachedAppVersion = '';
    return '';
  }
}

// test-only helpers
export function __setCachedAppVersionForTest(v: string | null): void {
  cachedAppVersion = v;
}
export function __resetCachedAppVersionForTest(): void {
  cachedAppVersion = null;
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
  /** 更新单个 manifest 的版本（用于插件更新后回填，避免全量 fetch 触发闪烁）。 */
  patchManifest: (id: string, patch: Partial<PluginManifest>) => void;
  /** Reconcile active content-script injections with current manifests +
    *  settings. Deactivates injections for disabled/unauthorized plugins,
    *  activates for newly-enabled ones. Called after fetchPlugins and on
    *  settings changes (disabledPlugins / disableAllInjections /
    *  authorizedCapabilities). */
  syncInjections: () => void | Promise<void>;
  /** Re-run already-active injections after React remounts a region and destroys
    *  plugin-owned DOM nodes. Unlike syncInjections, this is only for remount
    *  recovery and intentionally re-executes existing runtimes. */
  rehydrateInjections: () => void | Promise<void>;
}

/**
 * Incremental diff refresh: destroy/recreate webviews, injections and view
 * providers only for plugins whose manifest changed or were removed/disabled.
 * Unchanged plugins keep their live webviews and injected scripts, avoiding
 * the flicker of the previous nuke-and-rebuild `fetchPlugins`.
 */
function applyPluginDiff(
  oldManifests: PluginManifest[],
  newManifests: PluginManifest[],
  disabled: Set<string>,
): void {
  const oldById = new Map(oldManifests.map((m) => [m.id, m]));
  const newById = new Map(newManifests.map((m) => [m.id, m]));

  // Destroy + unregister for: removed, disabled, or changed plugins.
  // Always re-read viewStore — unregister/register mutate the store; a
  // snapshot taken at the start would be stale for later sweeps.
  for (const [id, oldM] of oldById) {
    const newM = newById.get(id);
    const manifestChanged =
      !newM || JSON.stringify(newM) !== JSON.stringify(oldM);
    const nowDisabled = disabled.has(id);
    if (manifestChanged || nowDisabled) {
      destroyWebviewByPlugin(id).catch(console.error);
      try {
        deactivatePluginInjections(id);
      } catch (err) {
        console.error(`[pluginStore] deactivate injections failed for ${id}:`, err);
      }
      removePluginSubscriptions(id);
      useViewStore.getState().unregister(id);
    }
  }

  // Resync the webview pool: drop webviews whose plugin is no longer live.
  const liveIds = new Set<string>();
  for (const m of newManifests) {
    if (!disabled.has(m.id)) liveIds.add(m.id);
  }
  resyncWebviewPool(liveIds).catch(console.error);

  // Final-consistency sweep: drop any non-builtin view provider whose plugin
  // is no longer in the live (enabled) set. This catches providers registered
  // by a previous `fetchPlugins` whose plugin has since been deleted/disabled,
  // even if the manifest diff missed them (e.g. store was reset mid-flight).
  for (const p of useViewStore.getState().providers) {
    if (p.pluginId === 'builtin') continue;
    if (!liveIds.has(p.pluginId)) {
      removePluginSubscriptions(p.pluginId);
      useViewStore.getState().unregister(p.pluginId);
    }
  }

  // Register view providers for enabled plugins that are not yet registered.
  // Covers: newly added, re-enabled (manifest unchanged so old diff missed them),
  // and re-register after manifest change (first loop already unregistered).
  const registeredPluginIds = new Set(
    useViewStore.getState().providers.map((p) => p.pluginId),
  );
  for (const [id, m] of newById) {
    if (disabled.has(id)) continue;
    if (registeredPluginIds.has(id)) continue;
    for (const v of m.views) {
      const provider = manifestViewToProvider(m, v);
      if (provider) useViewStore.getState().register(provider);
    }
    registeredPluginIds.add(id);
  }
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
      const appVersion = await resolveAppVersion();
      const effectiveDisabled = getEffectiveDisabled(manifests, appVersion);
      const oldManifests = get().manifests;

      // Diff: only destroy/recreate webviews + injections + view providers
      // for plugins whose manifest changed or were removed/disabled. This
      // avoids the flicker / state-loss of the previous nuke-and-rebuild.
      // 关键时序：版本不兼容在注册前已并入 effectiveDisabled，保证首装不兼容永不加载。
      applyPluginDiff(oldManifests, manifests, effectiveDisabled);

      set({ manifests, loading: false, refreshKey: Date.now() });

      // 持久化：不兼容插件直接写入 disabledPlugins，复用关闭语义，兼容后需用户手动开启
      if (appVersion) {
        const disabledNow = getDisabledPlugins();
        const incompatible = getIncompatibleIds(manifests, appVersion);
        const toPersist: string[] = [];
        for (const id of incompatible) {
          if (!disabledNow.has(id)) toPersist.push(id);
        }
        if (toPersist.length > 0) {
          const nextDisabled = Array.from(effectiveDisabled);
          // fire-and-forget，避免与当前 reload 锁死
          useSettingsStore.getState().update({ disabledPlugins: nextDisabled }).catch(console.error);
        }
      }

      // Activate injections for eligible plugins (fire-and-forget; resource
      // fetches happen asynchronously).
      get().syncInjections();
    } catch (err) {
      set({ error: getErrorMessage(err), loading: false });
    }
  },

  patchManifest: (id, patch) => {
    const cur = get().manifests;
    const next = cur.map((m) => (m.id === id ? { ...m, ...patch } : m));
    // 仅更新 manifests 数据，不触发 applyPluginDiff / webview 重建（重启后生效）
    set({ manifests: next });
  },

  syncInjections: async () => {
    const manifests = get().manifests;
    // 保证版本检查在任何注入激活前完成；首装时序关键路径
    const appVersion = cachedAppVersion !== null ? cachedAppVersion : await resolveAppVersion();
    const effectiveDisabled = getEffectiveDisabled(manifests, appVersion);
    const desired = new Set<string>();

    for (const m of manifests) {
      if (effectiveDisabled.has(m.id)) continue;
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

  rehydrateInjections: async () => {
    const manifests = get().manifests;
    const appVersion = cachedAppVersion !== null ? cachedAppVersion : await resolveAppVersion();
    const effectiveDisabled = getEffectiveDisabled(manifests, appVersion);
    const activePluginIds = new Set(getAllRuntimes().map((rt) => rt.pluginId));
    for (const m of manifests) {
      if (!activePluginIds.has(m.id)) continue;
      if (effectiveDisabled.has(m.id)) continue;
      if (!isInjectionsAuthorized(m)) continue;
      rehydratePluginInjections(m).catch((err) => {
        console.error(`[pluginStore] rehydration failed for ${m.id}:`, err);
      });
    }
  },
}));

// ── Registry-changed event subscription ───────────────────────────────────
//
// The backend emits `plugin-registry-changed` after every registry reload
// (startup, settings save, explicit `plugin_reload`). We react by re-fetching
// the manifest list — the diff refresh inside `fetchPlugins` ensures only
// changed/removed plugins disturb their live webviews/injections.
//
// Subscribed once at module load; safe to call during tests (the listener is
// idempotent and the store starts empty so the first event just populates it).

let registryListenerRegistered = false;

export function ensurePluginRegistryListener(): void {
  if (registryListenerRegistered) return;
  registryListenerRegistered = true;
  listen<ReloadDiff>('plugin-registry-changed', () => {
    // Fire-and-forget: the diff refresh handles incremental destroy/recreate.
    usePluginStore.getState().fetchPlugins().catch((err) => {
      console.error('[pluginStore] fetchPlugins after registry-changed failed:', err);
    });
  }).catch((err) => {
    console.error('[pluginStore] failed to listen for plugin-registry-changed:', err);
  });
}
