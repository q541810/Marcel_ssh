/**
 * 请求桌面终端底栏切到某个标签（文件管理、进程…）。
 *
 * 底栏的「当前标签」是 `useTerminalBottomPanel` 里的本地状态，别的地方（agent 的文件链接、
 * 交付卡片）够不着它，所以走事件；同时直接写它的 localStorage 记忆——万一事件发出时终端
 * 视图没挂载（或底栏随会话切换重建），下次挂载读到的也是这个标签，请求不会丢。
 */
export const BOTTOM_TAB_STORAGE_KEY = 'marcel:terminalActiveTab';
export const OPEN_BOTTOM_TAB_EVENT = 'marcel:open-bottom-tab';

export function requestBottomTab(tab: string): void {
  try {
    localStorage.setItem(BOTTOM_TAB_STORAGE_KEY, tab);
  } catch {
    // WebView 里 localStorage 不可用时只靠事件
  }
  window.dispatchEvent(new CustomEvent(OPEN_BOTTOM_TAB_EVENT, { detail: { tab } }));
}
