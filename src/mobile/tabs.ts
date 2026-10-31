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

export function isMobileTab(id: string): id is MobileTabId {
  return MOBILE_TABS.some((tab) => tab.id === id);
}
