import type { InjectionRuntime, PluginApi } from './types';

/**
 * Module-level registry of active injections, keyed by full injection id
 * (`${pluginId}.${def.id}`). The injector adds/removes entries; pluginApi
 * reads the "current" runtime to register cleanup fns; the settings UI reads
 * status snapshots.
 *
 * A module-level singleton is used (rather than React state) because:
 *  1. Content scripts mutate it from outside React's render cycle.
 *  2. The settings UI polls/subscribes rather than driving re-renders on
 *     every cleanup registration.
 */
const registry = new Map<string, InjectionRuntime>();

/** Listener set fired whenever an injection's status changes (error set,
 *  activated, deactivated). The settings UI subscribes to refresh. */
type StatusListener = () => void;
const statusListeners = new Set<StatusListener>();

export function registerRuntime(rt: InjectionRuntime): void {
  registry.set(rt.injectionId, rt);
  notifyStatus();
}

export function getRuntime(injectionId: string): InjectionRuntime | undefined {
  return registry.get(injectionId);
}

export function getRuntimesByPlugin(pluginId: string): InjectionRuntime[] {
  const out: InjectionRuntime[] = [];
  for (const rt of registry.values()) {
    if (rt.pluginId === pluginId) out.push(rt);
  }
  return out;
}

export function removeRuntime(injectionId: string): void {
  registry.delete(injectionId);
  notifyStatus();
}

export function getAllRuntimes(): InjectionRuntime[] {
  return Array.from(registry.values());
}

export function onStatusChange(cb: StatusListener): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

function notifyStatus(): void {
  for (const cb of statusListeners) {
    try {
      cb();
    } catch (err) {
      console.error('[injection] status listener error', err);
    }
  }
}

/**
 * Mark an injection as errored. Subsequent cleanup still runs on
 * deactivation. The settings UI surfaces this via `onStatusChange`.
 */
export function reportError(pluginId: string, injectionId: string, err: unknown): void {
  const rt = registry.get(injectionId);
  if (!rt) {
    console.error(`[injection] error for unknown injection ${injectionId}:`, err);
    return;
  }
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  rt.error = msg;
  console.error(`[injection] ${pluginId}/${injectionId} error:`, err);
  notifyStatus();
}

/**
 * Run all registered cleanup fns for an injection in reverse registration
 * order (LIFO — last registered cleans first, mirroring stack semantics for
 * nested resources). Each fn is guarded so one failing cleanup doesn't block
 * the rest.
 */
export function runCleanup(rt: InjectionRuntime): void {
  rt.active = false;
  const fns = rt.cleanupFns;
  rt.cleanupFns = [];
  for (let i = fns.length - 1; i >= 0; i--) {
    try {
      fns[i]();
    } catch (err) {
      console.error(`[injection] cleanup error ${rt.injectionId}:`, err);
    }
  }
}

/**
 * Create a sandboxed executor for a plugin injection. The plugin source runs
 * inside a `new Function` with the `marcel` API as its sole argument — no
 * `with`, no implicit globals beyond what the function scope provides.
 *
 * Errors (sync throw + unhandled rejection from the async wrapper) are routed
 * to `reportError`. Note: a plugin's own loose `setTimeout(async ...)` or
 * free-standing `fetch` rejections are NOT caught here — those go to the
 * browser's default `unhandledrejection` handler. This is an intentional
 * boundary documented in the plugin guide.
 */
export function createSandboxedExecutor(pluginId: string, injectionId: string) {
  return async (code: string, api: PluginApi): Promise<void> => {
    try {
      // `new Function` gives an isolated function scope. Strict mode keeps
      // accidental globals from leaking. The async IIFE lets top-level await
      // work in the plugin source.
      const fn = new Function(
        'marcel',
        `"use strict";\nreturn (async () => {\n${code}\n})();`,
      );
      await fn(api);
    } catch (err) {
      reportError(pluginId, injectionId, err);
    }
  };
}
