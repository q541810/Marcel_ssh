import { bus } from './bus';

/**
 * UI region bridge. The main app tags key layout areas with `data-region`
 * attributes (e.g. `<aside data-region="sidebar">`). This module:
 *
 *  1. Emits `ui:region-mounted` / `ui:region-unmounted` when a tagged node
 *     appears/disappears in the DOM (React mounts/unmounts sub-trees).
 *  2. Exposes `notifyNavChange(from, to)` for App.tsx to call when the
 *     active view switches, emitting `ui:nav-change`.
 *
 * Content scripts subscribe via `marcel.events.on('ui:nav-change', cb)` etc.
 * Events flow through the shared in-memory `bus` (no Tauri event round-trip).
 */

let initialized = false;
let observer: MutationObserver | null = null;

/** Region names a plugin may match against. Exported for docs/tests. */
export const REGION_NAMES = [
  'sidebar',
  'center',
  'agent',
  'terminal',
  'settings',
  'sessions',
  'skills',
  'mcp',
  'agent-panel',
] as const;

export type RegionName = (typeof REGION_NAMES)[number];

function emitRegionMounted(el: Element): void {
  const region = el.getAttribute('data-region');
  if (!region) return;
  bus.emit('ui:region-mounted', { region, el });
}

function emitRegionUnmounted(el: Element): void {
  const region = el.getAttribute('data-region');
  if (!region) return;
  bus.emit('ui:region-unmounted', { region, el });
}

/** Scan existing `[data-region]` nodes and emit `ui:region-mounted` for each.
 *  Called once on init so plugins injected after the UI is up learn about
 *  regions that already exist. */
function scanExisting(): void {
  document.querySelectorAll('[data-region]').forEach(emitRegionMounted);
}

/** Start observing the document body for region mount/unmount. Idempotent. */
export function initRegionBridge(): void {
  if (initialized) return;
  initialized = true;

  // Defer the existing-region scan until the body is populated (App.tsx has
  // mounted). A short rAF loop retries until regions appear or a timeout
  // elapses — covers the race where plugins load before the React tree.
  const start = performance.now();
  const tryScan = () => {
    if (document.querySelectorAll('[data-region]').length > 0 || performance.now() - start > 5000) {
      scanExisting();
      return;
    }
    requestAnimationFrame(tryScan);
  };
  requestAnimationFrame(tryScan);

  observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.hasAttribute?.('data-region')) emitRegionMounted(el);
        el.querySelectorAll?.('[data-region]').forEach(emitRegionMounted);
      }
      for (const node of m.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const el = node as Element;
        if (el.hasAttribute?.('data-region')) emitRegionUnmounted(el);
        el.querySelectorAll?.('[data-region]').forEach(emitRegionUnmounted);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/** Tear down the bridge (used in tests / full reset). */
export function teardownRegionBridge(): void {
  observer?.disconnect();
  observer = null;
  initialized = false;
}

/** Called by App.tsx when the active view switches. */
export function notifyNavChange(from: string | null, to: string): void {
  bus.emit('ui:nav-change', { from, to });
}
