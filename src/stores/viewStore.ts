import { create } from 'zustand';
import type { MountPoint, NavGroup, ViewProvider } from '@/lib/types';

interface ViewState {
  providers: ViewProvider[];
  /** 当前激活的视图 ID。提升到 store 后，任意组件都可触发视图切换
   *  （例如 SyncStatusIndicator 点击后跳转到设置页）。 */
  activeId: string;
  setActiveId: (id: string) => void;
  register: (p: ViewProvider) => void;
  unregister: (pluginId: string) => void;
}

export const useViewStore = create<ViewState>((set) => ({
  providers: [],
  activeId: 'builtin.sessions',
  setActiveId: (id) => set({ activeId: id }),
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
