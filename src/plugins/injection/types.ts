import type { PluginInjectionDef, PluginManifest } from '@/lib/types';

/**
 * The `marcel` runtime object injected into each content script as the
 * sole argument. Plugins call `marcel.dom.querySelector(...)`,
 * `marcel.ipc.call(...)`, etc.
 *
 * Design notes:
 *  - IPC calls reuse the existing `plugin-request` / `plugin-response-<id>`
 *    pipeline, so capability checks in `pluginIpc.ts` still apply. A content
 *    script cannot bypass authorization.
 *  - `dom` is a thin wrapper around the real DOM; plugins can also reach
 *    `window` / `document` directly since the script runs in the main window.
 *    The wrapper exists for ergonomics and to ease future sandboxing.
 *  - `events.on` unifies UI bridge events (`ui:*`, local bus) and backend
 *    events (`ssh://status/*` etc., auto-subscribed + forwarded).
 */
/** Parameters for `marcel.window.create`. */
export interface WindowCreateParams {
  label: string;
  /** HTML path relative to the plugin root (served via `plugin://`). */
  entry: string;
  width: number;
  height: number;
  x: number;
  y: number;
  decorations?: boolean;
  transparent?: boolean;
  alwaysOnTop?: boolean;
  skipTaskbar?: boolean;
  resizable?: boolean;
}

/** A single native context-menu item. */
export interface MenuItemDef {
  /** Stable id returned via the `menu://clicked/*` event on click. */
  actionId: string;
  label: string;
  disabled?: boolean;
  /** Insert a separator before this item. */
  separatorBefore?: boolean;
}

export interface PluginApi {
  readonly pluginId: string;
  readonly injectionId: string;

  dom: {
    querySelector: (selector: string) => Element | null;
    querySelectorAll: (selector: string) => Element[];
    /** Shorthand for `document.body`. */
    readonly body: HTMLElement;
    /** Shorthand for `document.head`. */
    readonly head: HTMLHeadElement;
    /** Run a callback on the next idle callback (or setTimeout fallback). */
    ready: (cb: () => void) => void;
    /** Wait for a `[data-region=...]` element to appear, with timeout. */
    waitForRegion: (region: string, timeoutMs?: number) => Promise<HTMLElement | null>;
  };

  overlay: {
    /** Create a floating div appended to the shared overlay container.
     *  The div is tagged with `data-plugin-id` so it's cleaned up on
     *  deactivation. Returns the raw element for the plugin to style/fill. */
    create: (opts?: { className?: string }) => HTMLDivElement;
    /** Remove a previously created overlay element. No-op if not a child. */
    dismiss: (el: HTMLElement) => void;
  };

  ipc: {
    /** Call a plugin IPC command. Goes through the capability-checked
     *  `plugin-request` pipeline — unauthorized commands reject. */
    call: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  };

  events: {
    /** Subscribe to an event. UI bridge events (`ui:*`) and plugin-emitted
     *  events are local. Backend event patterns (`ssh://status/*` etc.)
     *  are auto-subscribed via `events.subscribe` IPC and forwarded here.
     *  Returns an unsubscribe function. */
    on: (eventName: string, cb: (data: unknown) => void) => () => void;
    /** Emit a local event to the bus (other plugins / self). Does NOT reach
     *  the backend. Use a namespaced name like `<pluginId>:<event>` to avoid
     *  collisions. */
    emit: (eventName: string, data?: unknown) => void;
  };

  /** Independent OS-level window control (desktop only). Requires the
   *  `window.create` capability; sensitive flags (`transparent`,
   *  `alwaysOnTop`, `skipTaskbar`) require their own capabilities. */
  window: {
    create: (params: WindowCreateParams) => Promise<void>;
    show: (label: string) => Promise<void>;
    hide: (label: string) => Promise<void>;
    close: (label: string) => Promise<void>;
    focus: (label: string) => Promise<void>;
    setPosition: (label: string, x: number, y: number) => Promise<void>;
    setSize: (label: string, width: number, height: number) => Promise<void>;
    setAlwaysOnTop: (label: string, alwaysOnTop: boolean) => Promise<void>;
    setIgnoreCursorEvents: (label: string, ignore: boolean) => Promise<void>;
  };

  /** Native context-menu registration. Requires the `context_menu` capability. */
  menu: {
    register: (items: MenuItemDef[]) => Promise<void>;
    update: (items: MenuItemDef[]) => Promise<void>;
    unregister: () => Promise<void>;
    /** Pop up the registered menu on one of the plugin's owned windows. */
    popup: (label: string) => Promise<void>;
  };

  /** Register a cleanup callback. Called when the injection is deactivated
   *  (plugin disabled, refreshed, or app teardown). Plugins should remove
   *  any DOM nodes / listeners / timers they added here. */
  onCleanup: (fn: () => void) => void;

  log: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

/** Internal record of one active injection. */
export interface InjectionRuntime {
  pluginId: string;
  /** Full id: `${pluginId}.${def.id}`. */
  injectionId: string;
  def: PluginInjectionDef;
  styleElements: HTMLStyleElement[];
  cleanupFns: Array<() => void>;
  /** Last error caught during execution / cleanup. Null if healthy. */
  error: string | null;
  active: boolean;
  /** Cancel pending idle-scheduled activation (requestIdleCallback / setTimeout). */
  cancelPending?: () => void;
}

/** Snapshot of a plugin's injection status, surfaced to the settings UI. */
export interface InjectionStatus {
  pluginId: string;
  pluginName: string;
  injections: Array<{
    id: string;
    styles: number;
    scripts: number;
    active: boolean;
    error: string | null;
  }>;
}

/** Subset of the manifest the injector needs. */
export type InjectionManifest = Pick<PluginManifest, 'id' | 'name' | 'injections'>;
