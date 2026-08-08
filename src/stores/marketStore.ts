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
  /**
   * 安装/卸载覆盖状态（会话级内存态，不持久化）。
   *
   * 市场安装/卸载后前端**不刷新**插件列表（保持「重启后生效」设计），
   * 而 `pluginStore.manifests` 在本次会话内不会更新。此覆盖表让「已安装」
   * 状态在重启前跨页面进出保持一致：`true` = 本会话内安装过，
   * `false` = 本会话内卸载过。重启后 `manifests` 重拉即为真实来源。
   */
  installedOverrides: Record<string, boolean>;
  /** 记录一次安装（覆盖未安装状态）。 */
  markInstalled: (id: string) => void;
  /** 记录一次卸载（覆盖已安装状态）。 */
  markUninstalled: (id: string) => void;
  fetch: () => Promise<void>;
  setSource: (url: string) => void;
}

export const useMarketStore = create<MarketState>((set, get) => ({
  sourceUrl: loadSavedSource(),
  plugins: [],
  loading: false,
  error: null,
  installedOverrides: {},

  markInstalled: (id) =>
    set((s) => ({ installedOverrides: { ...s.installedOverrides, [id]: true } })),
  markUninstalled: (id) =>
    set((s) => ({ installedOverrides: { ...s.installedOverrides, [id]: false } })),

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
