export type MobileTabId = 'terminal' | 'agent' | 'files' | 'settings';

export interface MobileTab {
  id: MobileTabId;
  label: string;
}

export const MOBILE_TABS: readonly MobileTab[] = [
  { id: 'terminal', label: '终端' },
  { id: 'agent', label: 'Agent' },
  { id: 'files', label: '文件' },
  { id: 'settings', label: '设置' },
] as const;

export const DEFAULT_MOBILE_TAB: MobileTabId = 'terminal';

/** 其他页面请求切换底部 Tab（文件页「在终端中打开」后跳过去）。 */
export const MOBILE_SWITCH_TAB_EVENT = 'mobile:switch-tab';

export function requestMobileTab(id: MobileTabId): void {
  window.dispatchEvent(new CustomEvent(MOBILE_SWITCH_TAB_EVENT, { detail: { tab: id } }));
}

let currentTab: MobileTabId = DEFAULT_MOBILE_TAB;

/** 壳层（`mobile/App`）每次切页签时登记，让别处能问「用户此刻在哪一页」（见 `currentMobileTab`）。 */
export function reportMobileTab(id: MobileTabId): void {
  currentTab = id;
}

/**
 * 此刻显示的页签。跨页跳转（agent 对话里点路径 → 文件页）要据此记下「从哪来」，
 * 到了那边才能给出「返回」——别的页签可见时不会有人去问，所以不是响应式的。
 */
export function currentMobileTab(): MobileTabId {
  return currentTab;
}

export function isMobileTab(id: string): id is MobileTabId {
  return MOBILE_TABS.some((tab) => tab.id === id);
}
