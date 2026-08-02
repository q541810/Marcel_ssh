import { emit, listen, type UnlistenFn } from '@tauri-apps/api/event';
import { bus, type Handler } from './bus';
import { getRuntime } from './lifecycle';
import { matchPattern } from '../pattern';
import type { PluginApi } from './types';

// ── Shared overlay container ──────────────────────────────────────────
// App.tsx mounts `<div id="marcel-overlays">` at body end. Lazy-create as a
// fallback so content scripts work even before the React node exists.

const OVERLAY_CONTAINER_ID = 'marcel-overlays';

function getOverlayContainer(): HTMLElement {
  let el = document.getElementById(OVERLAY_CONTAINER_ID);
  if (!el) {
    el = document.createElement('div');
    el.id = OVERLAY_CONTAINER_ID;
    el.style.position = 'fixed';
    el.style.inset = '0';
    el.style.pointerEvents = 'none';
    el.style.zIndex = '99998';
    document.body.appendChild(el);
  }
  return el;
}

// ── Backend event dispatcher (per plugin) ─────────────────────────────
// One Tauri listener per plugin on `plugin-event-<pluginId>`, dispatching to
// all registered pattern handlers. Avoids N listeners for N subscriptions.

interface BackendDispatcher {
  unlisten: UnlistenFn | null;
  patterns: Map<string, Set<Handler>>;
}

const backendDispatchers = new Map<string, BackendDispatcher>();

async function subscribeBackendEvent(pluginId: string, pattern: string, cb: Handler): Promise<() => void> {
  let disp = backendDispatchers.get(pluginId);
  if (!disp) {
    disp = { unlisten: null, patterns: new Map() };
    backendDispatchers.set(pluginId, disp);
  }

  let set = disp.patterns.get(pattern);
  if (!set) {
    set = new Set();
    disp.patterns.set(pattern, set);
  }
  set.add(cb);

  // Lazily install the single Tauri listener the first time a pattern is
  // registered for this plugin.
  if (!disp.unlisten) {
    const eventName = `plugin-event-${pluginId}`;
    disp.unlisten = await listen<{ event: string; data: unknown }>(eventName, (e) => {
      const d = backendDispatchers.get(pluginId);
      if (!d) return;
      const evName = e.payload?.event;
      const evData = e.payload?.data;
      if (!evName) return;
      for (const [pat, handlers] of d.patterns) {
        if (matchPattern(pat, evName)) {
          for (const h of handlers) {
            try {
              h(evData);
            } catch (err) {
              console.error(`[injection] backend event handler error ${pluginId}/${pat}`, err);
            }
          }
        }
      }
    });
  }

  // Register the subscription with the backend so it starts forwarding.
  // Errors here are non-fatal — the listener still works for local events.
  emit('plugin-request', {
    id: `sub-${pluginId}-${pattern}-${Date.now()}`,
    pluginId,
    cmd: 'events.subscribe',
    args: { events: [pattern] },
  }).catch(() => {});

  // Return unsubscribe
  return () => {
    const d = backendDispatchers.get(pluginId);
    if (!d) return;
    const s = d.patterns.get(pattern);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) {
      d.patterns.delete(pattern);
      emit('plugin-request', {
        id: `unsub-${pluginId}-${pattern}-${Date.now()}`,
        pluginId,
        cmd: 'events.unsubscribe',
        args: { events: [pattern] },
      }).catch(() => {});
    }
    if (d.patterns.size === 0 && d.unlisten) {
      d.unlisten();
      backendDispatchers.delete(pluginId);
    }
  };
}

// ── IPC call counter (per main window) ─────────────────────────────────
let ipcCounter = 0;

// ── Build the marcel API for a given injection ────────────────────────

export function buildPluginApi(pluginId: string, injectionId: string): PluginApi {
  const logPrefix = `[plugin:${pluginId}/${injectionId}]`;

  const dom: PluginApi['dom'] = {
    querySelector: (sel) => document.querySelector(sel),
    querySelectorAll: (sel) => Array.from(document.querySelectorAll(sel)),
    get body() {
      return document.body;
    },
    get head() {
      return document.head;
    },
    ready: (cb) => {
      if ('requestIdleCallback' in window) {
        (window as unknown as { requestIdleCallback: (cb: () => void) => number }).requestIdleCallback(cb);
      } else {
        setTimeout(cb, 1);
      }
    },
    waitForRegion: (region, timeoutMs = 5000) =>
      new Promise<HTMLElement | null>((resolve) => {
        const sel = `[data-region="${region}"]`;
        const existing = document.querySelector<HTMLElement>(sel);
        if (existing) {
          resolve(existing);
          return;
        }
        const start = performance.now();
        const ro = new MutationObserver(() => {
          const el = document.querySelector<HTMLElement>(sel);
          if (el) {
            ro.disconnect();
            resolve(el);
          } else if (performance.now() - start > timeoutMs) {
            ro.disconnect();
            resolve(null);
          }
        });
        ro.observe(document.body, { childList: true, subtree: true });
        // Safety timeout in case no mutation happens after the element appears.
        setTimeout(() => {
          ro.disconnect();
          resolve(document.querySelector<HTMLElement>(sel) ?? null);
        }, timeoutMs);
      }),
  };

  const overlay: PluginApi['overlay'] = {
    create: (opts) => {
      const container = getOverlayContainer();
      const el = document.createElement('div');
      el.setAttribute('data-plugin-id', pluginId);
      if (opts?.className) el.className = opts.className;
      el.style.pointerEvents = 'auto';
      container.appendChild(el);
      return el;
    },
    dismiss: (el) => {
      if (el.parentElement?.id === OVERLAY_CONTAINER_ID) {
        el.remove();
      }
    },
  };

  const ipc: PluginApi['ipc'] = {
    call: (cmd, args = {}) =>
      new Promise((resolve, reject) => {
        const id = `inj-${++ipcCounter}`;
        // Hold the unlisten fn in a closure so both the response callback
        // and the emit-failure path can release it. `listen` resolves before
        // any event arrives, so this is set by the time the callback fires.
        let unlisten: (() => void) | null = null;
        listen<{ ok: boolean; data: unknown }>(`plugin-response-${id}`, (e) => {
          if (unlisten) {
            unlisten();
            unlisten = null;
          }
          if (e.payload?.ok) resolve(e.payload.data);
          else reject(new Error(String(e.payload?.data ?? 'unknown error')));
        })
          .then((fn) => {
            unlisten = fn;
          })
          .catch(reject);
        emit('plugin-request', { id, pluginId, cmd, args }).catch((err) => {
          if (unlisten) {
            unlisten();
            unlisten = null;
          }
          reject(err);
        });
      }),
  };

  const events: PluginApi['events'] = {
    on: (eventName, cb) => {
      // UI bridge + local events go through the in-memory bus.
      if (eventName.startsWith('ui:') || eventName.startsWith(`${pluginId}:`)) {
        return bus.on(eventName, cb);
      }
      // Backend event patterns: auto-subscribe + forward.
      const unsub = subscribeBackendEvent(pluginId, eventName, cb);
      // `subscribeBackendEvent` is async; bridge to a sync-returning unsub.
      let realUnsub: (() => void) | null = null;
      let done = false;
      unsub.then((fn) => {
        realUnsub = fn;
        if (done) fn();
      });
      return () => {
        done = true;
        if (realUnsub) realUnsub();
      };
    },
    emit: (eventName, data) => {
      bus.emit(eventName, data);
    },
  };

  const onCleanup: PluginApi['onCleanup'] = (fn) => {
    const rt = getRuntime(injectionId);
    if (!rt) {
      console.warn(`${logPrefix} onCleanup called for unregistered injection`);
      return;
    }
    rt.cleanupFns.push(fn);
  };

  const log: PluginApi['log'] = {
    // eslint-disable-next-line no-console
    info: (...args) => console.info(logPrefix, ...args),
    warn: (...args) => console.warn(logPrefix, ...args),
    error: (...args) => console.error(logPrefix, ...args),
  };

  const void_ = () => undefined;

  const windowApi: PluginApi['window'] = {
    // 后端 plugin_window_create 接收 `params: PluginWindowCreateParams`（struct），
    // 必须包成 { params } 嵌套传递（与 plugin_webview_create 一致），平铺会反序列化失败。
    create: (params) =>
      ipc.call('window.create', { params }).then(void_),
    show: (label) => ipc.call('window.show', { label }).then(void_),
    hide: (label) => ipc.call('window.hide', { label }).then(void_),
    close: (label) => ipc.call('window.close', { label }).then(void_),
    focus: (label) => ipc.call('window.focus', { label }).then(void_),
    setPosition: (label, x, y) => ipc.call('window.set_position', { label, x, y }).then(void_),
    setSize: (label, width, height) =>
      ipc.call('window.set_size', { label, width, height }).then(void_),
    setAlwaysOnTop: (label, alwaysOnTop) =>
      ipc.call('window.set_always_on_top', { label, alwaysOnTop }).then(void_),
    setIgnoreCursorEvents: (label, ignore) =>
      ipc.call('window.set_ignore_cursor_events', { label, ignore }).then(void_),
  };

  const menuApi: PluginApi['menu'] = {
    register: (items) => ipc.call('menu.register', { items }).then(void_),
    update: (items) => ipc.call('menu.update', { items }).then(void_),
    unregister: () => ipc.call('menu.unregister', {}).then(void_),
    popup: (label) => ipc.call('menu.popup', { label }).then(void_),
  };

  return { pluginId, injectionId, dom, overlay, ipc, events, window: windowApi, menu: menuApi, onCleanup, log };
}
