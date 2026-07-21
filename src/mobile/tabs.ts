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

export function isMobileTab(id: string): id is MobileTabId {
  return MOBILE_TABS.some((tab) => tab.id === id);
}
