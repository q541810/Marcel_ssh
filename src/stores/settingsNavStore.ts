import { create } from 'zustand';

/**
 * 设置页 category 跳转意图中转。
 *
 * 用途：当全局 UI（如 AppHeader 中的 SyncStatusIndicator）需要打开设置页并
 * 直接定位到某个 category 时，调用 `requestNavigate` 写入意图；Settings 组件
 * 通过 `subscribe` 或 `consume` 读取并应用，应用后立即清空。
 *
 * 设计上保持单次消费语义：写入一次 -> 消费一次 -> 清空，避免残留状态影响
 * 后续手动切换。
 */
interface SettingsNavState {
  /** 待消费的 category 跳转意图；null 表示无待处理请求。 */
  pendingCategory: string | null;
  /** 写入跳转意图。Settings 组件挂载后会消费。 */
  requestNavigate: (category: string) => void;
  /** 读取并清空意图（单次消费）。 */
  consume: () => string | null;
}

export const useSettingsNavStore = create<SettingsNavState>((set, get) => ({
  pendingCategory: null,
  requestNavigate: (category) => set({ pendingCategory: category }),
  consume: () => {
    const v = get().pendingCategory;
    if (v !== null) set({ pendingCategory: null });
    return v;
  },
}));
