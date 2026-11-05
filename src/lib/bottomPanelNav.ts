/**
 * 请求桌面终端底栏切到某个标签（文件管理、进程…），收着就先展开。
 *
 * 底栏的「当前标签」是 `useTerminalBottomPanel` 里的本地状态，别的地方（agent 的文件链接、
 * 工具卡路径芯片）够不着它，所以走事件，由那个 hook 监听、展开并切标签（展开 / 收起的过渡与
 * 终端行数协调由 `Terminal.tsx` 按「是否有当前标签」自己接，这里不碰）。同时直接写它的
 * localStorage 记忆——事件发出时终端视图没挂载（Agent 占主区域且右侧栏收着；底栏随会话切换重建）
 * 时，下次挂载读到的就是这个标签，请求不会丢。
 *
 * 另外登记「底栏宿主是否在场」：没有宿主时点「在文件管理中显示」不会有任何反应，菜单据此把
 * 这类项藏起来，而不是留一个点了没反应的按钮（见 `fileNav.canShowFileManager`）。
 */
export const BOTTOM_TAB_STORAGE_KEY = 'marcel:terminalActiveTab';
export const OPEN_BOTTOM_TAB_EVENT = 'marcel:open-bottom-tab';

let mountedHosts = 0;

/** 终端底栏挂载时登记（返回注销函数）。同时可能有多个（切换视图的过渡期），用计数。 */
export function registerBottomPanelHost(): () => void {
  mountedHosts += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mountedHosts = Math.max(0, mountedHosts - 1);
  };
}

/** 终端底栏现在是否挂载（= 发出请求后有人接）。 */
export function isBottomPanelMounted(): boolean {
  return mountedHosts > 0;
}

export function requestBottomTab(tab: string): void {
  try {
    localStorage.setItem(BOTTOM_TAB_STORAGE_KEY, tab);
  } catch {
    // WebView 里 localStorage 不可用时只靠事件
  }
  window.dispatchEvent(new CustomEvent(OPEN_BOTTOM_TAB_EVENT, { detail: { tab } }));
}
