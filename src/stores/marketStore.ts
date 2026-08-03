import { create } from 'zustand';
import { marketList } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import type { MarketPlugin } from '@/lib/types';

/** 镜像配置语义（2026-08 升级）：空 = 内置默认（jsDelivr 拉索引 + 内置
 *  镜像列表下载 + GitHub 直连兜底）；填写 GitHub 加速镜像前缀（如
 *  `https://ghfast.top`）后，市场列表 / 详情 / 图片 / 插件下载统一走该镜像。
 *  兼容旧配置：以 `index.json` 结尾的旧值仍按完整索引源解析（仅索引生效）。 */
export const MARKET_DEFAULT_SOURCE = '';

const SOURCE_STORAGE_KEY = 'marcel.market.source';

function loadSavedSource(): string {
  try {
    return localStorage.getItem(SOURCE_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

interface MarketState {
  /** 当前镜像前缀 URL（空 = 内置默认镜像）。持久化在 localStorage，不进 AppSettings。 */
  sourceUrl: string;
  plugins: MarketPlugin[];
  loading: boolean;
  error: string | null;
  fetch: () => Promise<void>;
  setSource: (url: string) => void;
}

export const useMarketStore = create<MarketState>((set, get) => ({
  sourceUrl: loadSavedSource(),
  plugins: [],
  loading: false,
  error: null,

  fetch: async () => {
    set({ loading: true, error: null });
    try {
      const index = await marketList(get().sourceUrl || undefined);
      set({ plugins: index.plugins ?? [], loading: false });
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
