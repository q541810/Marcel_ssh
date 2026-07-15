import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  activatePluginInjections,
  deactivatePluginInjections,
  deactivateAllInjections,
  retryInjection,
  getInjectionStatuses,
  rehydratePluginInjections,
} from './injector';
import { getRuntime, getRuntimesByPlugin, removeRuntime, onStatusChange } from './lifecycle';
import type { InjectionManifest } from './types';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (cmd: string, args?: { pluginId: string; path: string }) => {
    const path = args?.path ?? '';
    if (path.endsWith('style.css')) return 'body { color: red; }';
    if (path.endsWith('content.js')) return 'marcel.onCleanup(() => { globalThis.__injCleaned = true; })';
    throw new Error(`invoke plugin_fs_read failed for ${path}`);
  }),
}));

/**
 * Minimal document stub for the injector's DOM touches. The test environment
 * is `node` (no jsdom), so we provide just enough surface: a head that
 * records appended style elements, and an empty overlay container lookup.
 */
interface StubStyle {
  tagName: 'STYLE';
  textContent: string;
  attrs: Record<string, string>;
  removed: boolean;
  setAttribute(key: string, value: string): void;
  remove(): void;
}

function makeStubDocument() {
  const headChildren: StubStyle[] = [];
  const head = {
    appendChild(el: StubStyle) {
      headChildren.push(el);
    },
  };
  return {
    head,
    headChildren,
    createElement(_tag: string): StubStyle {
      const el: StubStyle = {
        tagName: 'STYLE',
        textContent: '',
        attrs: {},
        removed: false,
        setAttribute(key: string, value: string) {
          el.attrs[key] = value;
        },
        remove() {
          el.removed = true;
        },
      };
      return el;
    },
    getElementById(_id: string) {
      return null;
    },
    querySelectorAll(_sel: string): Element[] {
      return [];
    },
    querySelector(_sel: string): Element | null {
      return null;
    },
    body: {} as HTMLElement,
  };
}

const manifest: InjectionManifest = {
  id: 'test-plug',
  name: 'Test Plugin',
  injections: [
    {
      id: 'main',
      matches: ['*'],
      styles: ['style.css'],
      scripts: ['content.js'],
      runAt: 'instant',
      order: 100,
    },
  ],
};

describe('injection injector', () => {
  let originalDocument: Document | undefined;
  let stub: ReturnType<typeof makeStubDocument>;

  beforeEach(() => {
    // Tear down any leftover runtimes from other test files.
    for (const rt of getRuntimesByPlugin('test-plug')) {
      removeRuntime(rt.injectionId);
    }
    originalDocument = globalThis.document;
    stub = makeStubDocument();
    (globalThis as { document: unknown }).document = stub;
    (globalThis as { __injCleaned?: boolean }).__injCleaned = false;
  });

  afterEach(() => {
    (globalThis as { document: unknown }).document = originalDocument;
    for (const rt of getRuntimesByPlugin('test-plug')) {
      removeRuntime(rt.injectionId);
    }
  });

  it('activatePluginInjections injects a style tag and runs the script', async () => {
    await activatePluginInjections(manifest);
    // Style: one style appended to head.
    expect(stub.headChildren).toHaveLength(1);
    expect(stub.headChildren[0].textContent).toBe('body { color: red; }');
    // Script: onCleanup registered → runtime has one cleanup fn.
    const rt = getRuntime('test-plug.main');
    expect(rt).toBeDefined();
    expect(rt!.cleanupFns).toHaveLength(1);
    expect(rt!.active).toBe(true);
    expect(rt!.error).toBeNull();
  });

  it('deactivatePluginInjections runs cleanup and removes styles', async () => {
    await activatePluginInjections(manifest);
    const styleEl = stub.headChildren[0];
    deactivatePluginInjections('test-plug');
    // Cleanup fn ran.
    expect((globalThis as { __injCleaned?: boolean }).__injCleaned).toBe(true);
    // Style element removed.
    expect(styleEl.removed).toBe(true);
    // Registry cleared.
    expect(getRuntime('test-plug.main')).toBeUndefined();
  });

  it('deactivateAllInjections clears everything', async () => {
    await activatePluginInjections(manifest);
    const styleEl = stub.headChildren[0];
    deactivateAllInjections();
    expect((globalThis as { __injCleaned?: boolean }).__injCleaned).toBe(true);
    expect(styleEl.removed).toBe(true);
    expect(getRuntime('test-plug.main')).toBeUndefined();
  });

  it('fetch failure reports an error on the runtime', async () => {
    const badManifest: InjectionManifest = {
      id: 'test-plug',
      name: 'Test Plugin',
      injections: [
        {
          id: 'main',
          matches: ['*'],
          styles: ['missing.css'],
          scripts: [],
          runAt: 'instant',
          order: 100,
        },
      ],
    };
    // Simulate an invoke failure for the missing file.
    const { invoke } = await import('@tauri-apps/api/core');
    vi.mocked(invoke).mockRejectedValueOnce(new Error('invoke failed for missing.css'));
    await activatePluginInjections(badManifest);
    const rt = getRuntime('test-plug.main');
    expect(rt).toBeDefined();
    expect(rt!.error).toContain('style load failed');
  });

  it('retryInjection re-activates a deactivated injection', async () => {
    await activatePluginInjections(manifest);
    deactivatePluginInjections('test-plug');
    expect(getRuntime('test-plug.main')).toBeUndefined();
    // Reset the cleanup sentinel so we can observe the re-run.
    (globalThis as { __injCleaned?: boolean }).__injCleaned = false;
    await retryInjection(manifest, 'main');
    const rt = getRuntime('test-plug.main');
    expect(rt).toBeDefined();
    expect(rt!.active).toBe(true);
    expect(rt!.cleanupFns).toHaveLength(1);
  });

  it('rehydratePluginInjections re-runs an active injection', async () => {
    await activatePluginInjections(manifest);
    const styleEl = stub.headChildren[0];
    const rtBefore = getRuntime('test-plug.main');
    expect(rtBefore).toBeDefined();
    expect(rtBefore!.cleanupFns).toHaveLength(1);

    await rehydratePluginInjections(manifest);

    const rtAfter = getRuntime('test-plug.main');
    expect(rtAfter).toBeDefined();
    expect(rtAfter!.active).toBe(true);
    expect(rtAfter!.cleanupFns).toHaveLength(1);
    expect(styleEl.removed).toBe(true);
    expect(stub.headChildren).toHaveLength(2);
    expect(stub.headChildren[1].textContent).toBe('body { color: red; }');
  });

  it('getInjectionStatuses reflects activation state', async () => {
    await activatePluginInjections(manifest);
    const statuses = getInjectionStatuses();
    const s = statuses.find((x) => x.pluginId === 'test-plug');
    expect(s).toBeDefined();
    expect(s!.injections).toHaveLength(1);
    expect(s!.injections[0].id).toBe('main');
    expect(s!.injections[0].styles).toBe(1);
    expect(s!.injections[0].scripts).toBe(1);
  });

  it('onStatusChange fires on activation and deactivation', async () => {
    const events: number[] = [];
    let count = 0;
    const off = onStatusChange(() => {
      count++;
      events.push(count);
    });
    await activatePluginInjections(manifest);
    deactivatePluginInjections('test-plug');
    // At least two notifications (register + remove).
    expect(events.length).toBeGreaterThanOrEqual(2);
    off();
  });

  it('deactivate cancels pending idle injection before run', async () => {
    vi.useFakeTimers();
    const idleManifest: InjectionManifest = {
      id: 'test-plug',
      name: 'Test Plugin',
      injections: [
        {
          id: 'main',
          matches: ['*'],
          styles: ['style.css'],
          scripts: ['content.js'],
          runAt: 'idle',
          order: 100,
        },
      ],
    };

    // No requestIdleCallback in node — falls back to setTimeout(1).
    const activatePromise = activatePluginInjections(idleManifest);
    // activate returns after scheduling idle work (no await on run).
    await activatePromise;
    expect(getRuntime('test-plug.main')).toBeDefined();
    expect(stub.headChildren).toHaveLength(0);

    deactivatePluginInjections('test-plug');
    expect(getRuntime('test-plug.main')).toBeUndefined();

    await vi.runAllTimersAsync();
    // Idle callback was cancelled — no styles injected after deactivate.
    expect(stub.headChildren).toHaveLength(0);
    vi.useRealTimers();
  });
});
