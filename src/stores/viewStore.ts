import { create } from 'zustand';
import type { MountPoint, NavGroup, ViewProvider } from '@/lib/types';

interface ViewState {
  providers: ViewProvider[];
  register: (p: ViewProvider) => void;
  unregister: (pluginId: string) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  providers: [],
  register: (p) =>
    set((state) => {
      const idx = state.providers.findIndex((x) => x.id === p.id);
      if (idx === -1) return { providers: [...state.providers, p] };
      const next = state.providers.slice();
      next[idx] = p;
      return { providers: next };
    }),
  unregister: (pluginId) =>
    set((state) => ({
      providers: state.providers.filter((p) => p.pluginId !== pluginId),
    })),
}));

export function byMount(providers: ViewProvider[], m: MountPoint): ViewProvider[] {
  return providers
    .filter((p) => p.mount === m)
    .sort((a, b) => a.order - b.order);
}

export function byNavGroup(providers: ViewProvider[], g: NavGroup): ViewProvider[] {
  return providers
    .filter((p) => p.navGroup === g)
    .sort((a, b) => a.order - b.order);
}
