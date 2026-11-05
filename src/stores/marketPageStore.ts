import { create } from 'zustand';

/**
 * 「插件市场」二级页的开关（桌面设置 →「工具与扩展」里再推一层）。
 *
 * 市场是浏览型界面，要整页全宽显示，不套设置项卡片；它原来是设置左栏的独立分类，
 * 现在收进「工具与扩展」下面，入口是「插件」卡片里的「浏览插件市场」。做法与
 * 「内置风险规则」二级页一致：打开时替换分类内容，换分类 / 点返回即关。
 */
interface MarketPageState {
  open: boolean;
  openPage: () => void;
  closePage: () => void;
}

export const useMarketPageStore = create<MarketPageState>((set) => ({
  open: false,
  openPage: () => set({ open: true }),
  closePage: () => set({ open: false }),
}));
