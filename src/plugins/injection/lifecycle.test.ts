import { describe, it, expect, beforeEach } from 'vitest';
import {
  createSandboxedExecutor,
  registerRuntime,
  getRuntime,
  removeRuntime,
  runCleanup,
  reportError,
  onStatusChange,
  getRuntimesByPlugin,
} from './lifecycle';
import type { InjectionRuntime, PluginApi } from './types';

function makeRuntime(id: string): InjectionRuntime {
  return {
    pluginId: 'plug',
    injectionId: id,
    def: {
      id: id.split('.')[1] ?? id,
      matches: ['*'],
      styles: [],
      scripts: [],
      runAt: 'instant',
      order: 100,
    },
    styleElements: [],
    cleanupFns: [],
    error: null,
    active: true,
  };
}

function makeMockApi(): PluginApi {
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
  };
  return {
    pluginId: 'plug',
    injectionId: 'plug.main',
    dom: {} as PluginApi['dom'],
    overlay: {} as PluginApi['overlay'],
    ipc: { call: async () => undefined },
    events: { on: () => () => {}, emit: () => {} },
    onCleanup: (fn: () => void) => {
      const rt = getRuntime('plug.main');
      if (rt) rt.cleanupFns.push(fn);
    },
    log,
  } as unknown as PluginApi;
}

describe('injection lifecycle', () => {
  // Clean the registry between tests so module state doesn't leak.
  beforeEach(() => {
    for (const rt of getRuntimesByPlugin('plug')) {
      removeRuntime(rt.injectionId);
    }
  });

  it('sandboxed executor runs code with the marcel api', async () => {
    const rt = makeRuntime('plug.main');
    registerRuntime(rt);
    let captured: string | null = null;
    const api = makeMockApi();
    (api as { log: { info: (s: string) => void } }).log.info = (s: string) => {
      captured = s;
    };
    const executor = createSandboxedExecutor('plug', 'plug.main');
    await executor('marcel.log.info("hello")', api);
    expect(captured).toBe('hello');
    expect(rt.error).toBeNull();
  });

  it('sandboxed executor catches sync throws and reports error', async () => {
    const rt = makeRuntime('plug.main');
    registerRuntime(rt);
    const executor = createSandboxedExecutor('plug', 'plug.main');
    await executor('throw new Error("boom-sync")', makeMockApi());
    expect(rt.error).toContain('boom-sync');
  });

  it('sandboxed executor catches async rejections and reports error', async () => {
    const rt = makeRuntime('plug.main');
    registerRuntime(rt);
    const executor = createSandboxedExecutor('plug', 'plug.main');
    await executor('await Promise.reject(new Error("boom-async"))', makeMockApi());
    expect(rt.error).toContain('boom-async');
  });

  it('runCleanup runs fns in LIFO order', () => {
    const rt = makeRuntime('plug.main');
    const calls: string[] = [];
    rt.cleanupFns.push(() => calls.push('a'));
    rt.cleanupFns.push(() => calls.push('b'));
    rt.cleanupFns.push(() => calls.push('c'));
    runCleanup(rt);
    // LIFO: last registered (c) runs first.
    expect(calls).toEqual(['c', 'b', 'a']);
    // cleanupFns cleared after run.
    expect(rt.cleanupFns).toEqual([]);
    expect(rt.active).toBe(false);
  });

  it('runCleanup continues when a cleanup fn throws', () => {
    const rt = makeRuntime('plug.main');
    const calls: string[] = [];
    rt.cleanupFns.push(() => calls.push('a'));
    rt.cleanupFns.push(() => {
      calls.push('b-throws');
      throw new Error('cleanup boom');
    });
    rt.cleanupFns.push(() => calls.push('c'));
    runCleanup(rt);
    // LIFO: c, then b (throws, caught), then a.
    expect(calls).toEqual(['c', 'b-throws', 'a']);
  });

  it('reportError sets error and notifies status listeners', () => {
    const rt = makeRuntime('plug.main');
    registerRuntime(rt);
    let notified = 0;
    const off = onStatusChange(() => {
      notified++;
    });
    reportError('plug', 'plug.main', new Error('reported'));
    expect(rt.error).toContain('reported');
    expect(notified).toBeGreaterThan(0);
    off();
  });

  it('onCleanup registers into the runtime cleanupFns', () => {
    const rt = makeRuntime('plug.main');
    registerRuntime(rt);
    const api = makeMockApi();
    api.onCleanup(() => {});
    expect(rt.cleanupFns).toHaveLength(1);
  });
});
