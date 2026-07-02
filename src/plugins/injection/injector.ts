import type { InjectionManifest, InjectionRuntime, InjectionStatus, PluginApi } from './types';
import { buildPluginApi } from './pluginApi';
import {
  createSandboxedExecutor,
  getRuntimesByPlugin,
  registerRuntime,
  removeRuntime,
  reportError,
  runCleanup,
  getAllRuntimes,
} from './lifecycle';
import { invoke } from '@tauri-apps/api/core';

const OVERLAY_CONTAINER_ID = 'marcel-overlays';

/**
 * Fetch a plugin resource as text via the IPC `plugin_fs_read` command.
 * The command reads files from the plugin's own directory with path-traversal
 * protection. Uses `invoke` instead of `fetch('plugin://...')` because the
 * main window's origin (`tauri://localhost`) is different from the `plugin://`
 * URI scheme origin, which would cause a CORS error.
 */
async function fetchPluginResource(pluginId: string, path: string): Promise<string> {
  return invoke<string>('plugin_fs_read', { pluginId, path });
}

/** Inject one CSS file as a `<style>` tag. Returns the element (or null on
 *  error). Tagged with data attributes for later removal. */
async function injectStyle(pluginId: string, injectionId: string, stylePath: string): Promise<HTMLStyleElement | null> {
  let css: string;
  try {
    css = await fetchPluginResource(pluginId, stylePath);
  } catch (err) {
    reportError(pluginId, injectionId, `style load failed (${stylePath}): ${err}`);
    return null;
  }
  const style = document.createElement('style');
  style.setAttribute('data-plugin-id', pluginId);
  style.setAttribute('data-injection-id', injectionId);
  style.textContent = css;
  document.head.appendChild(style);
  return style;
}

/** Inject + execute one JS file with the sandboxed executor. */
async function injectScript(pluginId: string, injectionId: string, scriptPath: string, api: PluginApi): Promise<void> {
  let code: string;
  try {
    code = await fetchPluginResource(pluginId, scriptPath);
  } catch (err) {
    reportError(pluginId, injectionId, `script load failed (${scriptPath}): ${err}`);
    return;
  }
  const executor = createSandboxedExecutor(pluginId, injectionId);
  await executor(code, api);
}

/** Remove overlay children belonging to a plugin (safety net for plugins
 *  that forgot to clean up in `onCleanup`). */
function sweepPluginOverlays(pluginId: string): void {
  const container = document.getElementById(OVERLAY_CONTAINER_ID);
  if (!container) return;
  container.querySelectorAll(`[data-plugin-id="${pluginId}"]`).forEach((el) => el.remove());
}

/** Activate all injections declared by a plugin. Idempotent: re-activating
 *  an already-active injection is a no-op. Respects `runAt` timing. */
export async function activatePluginInjections(manifest: InjectionManifest): Promise<void> {
  const injections = [...manifest.injections].sort((a, b) => a.order - b.order);

  for (const def of injections) {
    const injectionId = `${manifest.id}.${def.id}`;

    // Skip if already active (e.g. partial activation before a refresh).
    const existing = getRuntimesByPlugin(manifest.id).find((rt) => rt.injectionId === injectionId);
    if (existing && existing.active) continue;

    const rt: InjectionRuntime = {
      pluginId: manifest.id,
      injectionId,
      def,
      styleElements: [],
      cleanupFns: [],
      error: null,
      active: true,
    };
    registerRuntime(rt);

    const api = buildPluginApi(manifest.id, injectionId);

    const run = async () => {
      // CSS first so the script sees its styles applied.
      for (const stylePath of def.styles) {
        const el = await injectStyle(manifest.id, injectionId, stylePath);
        if (el) rt.styleElements.push(el);
      }
      for (const scriptPath of def.scripts) {
        await injectScript(manifest.id, injectionId, scriptPath, api);
      }
    };

    if (def.runAt === 'instant') {
      await run();
    } else {
      // 'idle' (default) — defer to idle callback so plugin JS doesn't block
      // the first paint of the main UI.
      const scheduleIdle = (cb: () => void) => {
        if ('requestIdleCallback' in window) {
          (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(cb);
        } else {
          setTimeout(cb, 1);
        }
      };
      scheduleIdle(() => {
        run().catch((err) => reportError(manifest.id, injectionId, err));
      });
    }
  }
}

/** Re-activate all registered injections for a plugin, re-injecting style
 *  and script elements into the current DOM. Intended for region remount —
 *  e.g., when navigating away and back to the agent panel, the old DOM
 *  subtree was destroyed; this re-creates the injected elements.
 *
 *  Safe to call on a non-active or already-active plugin (no-ops for
 *  non-active, deactivates + re-activates for active ones). */
export async function rehydratePluginInjections(manifest: InjectionManifest): Promise<void> {
  const runtimes = getRuntimesByPlugin(manifest.id);
  if (runtimes.length === 0) return;

  // Deactivate without removing the registry entry — we keep the runtime
  // metadata (cleanup fns, errors, etc.) but re-run the actual injection.
  for (const rt of runtimes) {
    runCleanup(rt);
    // Remove old style elements
    for (const style of rt.styleElements) style.remove();
    rt.styleElements = [];
  }

  // Re-run injection (re-fetches resources, re-creates DOM nodes)
  await activatePluginInjections(manifest);
}

/** Deactivate all injections for a plugin: run cleanups, remove styles,
 *  sweep overlays, drop from registry. Safe to call on a non-active plugin. */
export function deactivatePluginInjections(pluginId: string): void {
  for (const rt of getRuntimesByPlugin(pluginId)) {
    runCleanup(rt);
    for (const style of rt.styleElements) {
      style.remove();
    }
    rt.styleElements = [];
    removeRuntime(rt.injectionId);
  }
  sweepPluginOverlays(pluginId);
}

/** Deactivate everything (app teardown / full reset). */
export function deactivateAllInjections(): void {
  const pluginIds = new Set(getAllRuntimes().map((rt) => rt.pluginId));
  for (const pluginId of pluginIds) {
    deactivatePluginInjections(pluginId);
  }
}

/** Retry a single injection that previously errored. Tears down existing
 *  state for that injection and re-activates it. The manifest is required
 *  because the injector needs the def to re-fetch resources. */
export async function retryInjection(manifest: InjectionManifest, injectionLocalId: string): Promise<void> {
  const injectionId = `${manifest.id}.${injectionLocalId}`;
  const rt = getRuntimesByPlugin(manifest.id).find((r) => r.injectionId === injectionId);
  if (rt) {
    runCleanup(rt);
    for (const style of rt.styleElements) style.remove();
    rt.styleElements = [];
    removeRuntime(injectionId);
  }
  // Re-activate the whole plugin; already-active injections are skipped, so
  // only the just-removed one reruns.
  await activatePluginInjections(manifest);
}

/** Snapshot of all injection statuses for the settings UI. */
export function getInjectionStatuses(): InjectionStatus[] {
  const byPlugin = new Map<string, InjectionRuntime[]>();
  for (const rt of getAllRuntimes()) {
    const arr = byPlugin.get(rt.pluginId) ?? [];
    arr.push(rt);
    byPlugin.set(rt.pluginId, arr);
  }
  const out: InjectionStatus[] = [];
  for (const [pluginId, runtimes] of byPlugin) {
    out.push({
      pluginId,
      pluginName: runtimes[0]?.pluginId ?? pluginId, // name filled by caller
      injections: runtimes.map((rt) => ({
        id: rt.def.id,
        styles: rt.def.styles.length,
        scripts: rt.def.scripts.length,
        active: rt.active,
        error: rt.error,
      })),
    });
  }
  return out;
}
