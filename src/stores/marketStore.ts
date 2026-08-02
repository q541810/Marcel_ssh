import { create } from 'zustand';
import { marketList } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import type { MarketPlugin } from '@/lib/types';

/** 内置默认源：jsDelivr CDN 镜像优先（国内可达、上架 Action 会 purge 缓存保持实时）；
 *  GitHub raw 作为后端兜底源。后端 `market_list` 按"自定义源 → 镜像 → raw"顺序尝试。 */
export const MARKET_DEFAULT_SOURCE =
  'https://cdn.jsdelivr.net/gh/q541810/marcel-ssh-plugins@main/index.json';

const SOURCE_STORAGE_KEY = 'marcel.market.source';

function loadSavedSource(): string {
  try {
    return localStorage.getItem(SOURCE_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

interface MarketState {
  /** 当前源 URL（空 = 内置默认源，镜像优先、GitHub raw 兜底）。持久化在 localStorage，不进 AppSettings。 */
  sourceUrl: string;
  plugins: MarketPlugin[];
  loading: boolean;
  error: string | null;
  /** 最近一次成功拉取的时间戳（用于列表"已加载"状态提示）。 */
  loadedAt: number | null;
  fetch: () => Promise<void>;
  setSource: (url: string) => void;
}

export const useMarketStore = create<MarketState>((set, get) => ({
  sourceUrl: loadSavedSource(),
  plugins: [],
  loading: false,
  error: null,
  loadedAt: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const index = await marketList(get().sourceUrl || undefined);
      set({ plugins: index.plugins ?? [], loading: false, loadedAt: Date.now() });
    } catch (e) {
      set({ loading: false, error: getErrorMessage(e) });
    }
  },

  setSource: (url) => {
    const trimmed = url.trim();
    set({ sourceUrl: trimmed });
    try {
      if (trimmed) {
        localStorage.setItem(SOURCE_STORAGE_KEY, trimmed);
      } else {
        localStorage.removeItem(SOURCE_STORAGE_KEY);
      }
    } catch {
      // localStorage 不可用时仅内存生效
    }
  },
}));
