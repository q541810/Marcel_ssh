import { beforeEach, describe, it, expect } from 'vitest';
import { useViewStore, byMount, byNavGroup } from '@/stores/viewStore';
import type { ViewProvider } from '@/lib/types';

function makeProvider(overrides: Partial<ViewProvider> & { id: string; pluginId: string }): ViewProvider {
  return {
    mount: 'sidebar',
    title: overrides.id,
    icon: { kind: 'react', node: null },
    order: 10,
    component: async () => ({ default: () => null }),
    ...overrides,
  };
}

describe('viewStore', () => {
  beforeEach(() => {
    useViewStore.setState({ providers: [] });
  });

  it('register adds a new provider', () => {
    const p = makeProvider({ id: 'a', pluginId: 'plug' });
    useViewStore.getState().register(p);
    expect(useViewStore.getState().providers).toHaveLength(1);
    expect(useViewStore.getState().providers[0].id).toBe('a');
  });

  it('register overwrites existing provider with same id', () => {
    const p1 = makeProvider({ id: 'a', pluginId: 'plug', title: 'old' });
    const p2 = makeProvider({ id: 'a', pluginId: 'plug', title: 'new' });
    useViewStore.getState().register(p1);
    useViewStore.getState().register(p2);
    expect(useViewStore.getState().providers).toHaveLength(1);
    expect(useViewStore.getState().providers[0].title).toBe('new');
  });

  it('unregister removes all providers for a pluginId', () => {
    useViewStore.getState().register(makeProvider({ id: 'a1', pluginId: 'plug-a' }));
    useViewStore.getState().register(makeProvider({ id: 'a2', pluginId: 'plug-a' }));
    useViewStore.getState().register(makeProvider({ id: 'b1', pluginId: 'plug-b' }));
    useViewStore.getState().unregister('plug-a');
    const ids = useViewStore.getState().providers.map((p) => p.id);
    expect(ids).toEqual(['b1']);
  });

  it('unregister is a no-op for unknown pluginId', () => {
    useViewStore.getState().register(makeProvider({ id: 'a', pluginId: 'plug' }));
    useViewStore.getState().unregister('nonexistent');
    expect(useViewStore.getState().providers).toHaveLength(1);
  });
});

describe('byMount', () => {
  it('filters by mount and sorts by order', () => {
    const providers: ViewProvider[] = [
      makeProvider({ id: 'a', pluginId: 'p', mount: 'sidebar', order: 30 }),
      makeProvider({ id: 'b', pluginId: 'p', mount: 'center', order: 10 }),
      makeProvider({ id: 'c', pluginId: 'p', mount: 'sidebar', order: 10 }),
    ];
    const result = byMount(providers, 'sidebar');
    expect(result.map((p) => p.id)).toEqual(['c', 'a']);
  });

  it('returns empty for no matches', () => {
    const providers: ViewProvider[] = [
      makeProvider({ id: 'a', pluginId: 'p', mount: 'sidebar', order: 10 }),
    ];
    expect(byMount(providers, 'center')).toEqual([]);
  });
});

describe('byNavGroup', () => {
  it('filters by navGroup and sorts by order', () => {
    const providers: ViewProvider[] = [
      makeProvider({ id: 'a', pluginId: 'p', navGroup: 'top', order: 20 }),
      makeProvider({ id: 'b', pluginId: 'p', navGroup: 'bottom', order: 10 }),
      makeProvider({ id: 'c', pluginId: 'p', navGroup: 'top', order: 5 }),
    ];
    const result = byNavGroup(providers, 'top');
    expect(result.map((p) => p.id)).toEqual(['c', 'a']);
  });

  it('excludes providers without navGroup', () => {
    const providers: ViewProvider[] = [
      makeProvider({ id: 'a', pluginId: 'p', order: 10 }),
      makeProvider({ id: 'b', pluginId: 'p', navGroup: 'top', order: 10 }),
    ];
    expect(byNavGroup(providers, 'top')).toHaveLength(1);
  });
});
