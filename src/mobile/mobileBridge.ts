/**
 * 安卓原生桥接封装（window.AndroidBridge）。
 *
 * Android 端 MainActivity 在 onWebViewCreate 时通过 `webView.addJavascriptInterface`
 * 注入 MobileBridge 实例，暴露为 `window.AndroidBridge`。所有方法用
 * `@JavascriptInterface` 注解，跑在 WebView 的 JS 线程。
 *
 * 桌面端 / 非移动端环境 `window.AndroidBridge` 不存在，所有方法安全降级：
 * - 通知/服务相关调用静默 no-op
 * - 权限检查返回 true（桌面端默认授予）
 * - 权限请求直接 resolve(true)
 *
 * 这样上层调用方不需要关心平台差异。
 */

interface AndroidBridgeRaw {
  startForegroundService(title: string, body: string): void;
  stopForegroundService(): void;
  updateForegroundNotification(title: string, body: string): void;
  /** 返回 true 发送成功，false 权限未授予 */
  sendAgentNotification(id: number, title: string, body: string): boolean;
  isNotificationPermissionGranted(): boolean;
  /** 异步弹出系统权限对话框，结果通过 window.__marcelNotificationPermissionResult 回调 */
  requestNotificationPermission(): void;
}

declare global {
  interface Window {
    AndroidBridge?: AndroidBridgeRaw;
    /** 由 MainActivity.notifyPermissionResult 调用，回传权限请求结果 */
    __marcelNotificationPermissionResult?: (granted: boolean) => void;
  }
}

/** 是否在注入了 AndroidBridge 的环境（即 Android 端）。 */
export function isAndroidBridgeAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.AndroidBridge;
}

/** 启动前台保活服务。已运行则更新通知文案。 */
export function startForegroundService(title: string, body: string): void {
  try {
    window.AndroidBridge?.startForegroundService(title, body);
  } catch (e) {
    console.warn('[mobileBridge] startForegroundService failed:', e);
  }
}

/** 停止前台保活服务。 */
export function stopForegroundService(): void {
  try {
    window.AndroidBridge?.stopForegroundService();
  } catch (e) {
    console.warn('[mobileBridge] stopForegroundService failed:', e);
  }
}

/**
 * 在调用可能触发系统级全屏 Activity（文件选择器、SAV 文件管理器等）的
 * 异步操作期间，临时开启前台保活服务，避免 Android OEM 电池优化在
 * MainActivity.onPause 时冻结进程、回收网络，导致 SSH 长连接被掐断。
 *
 * 关键策略：
 * - 只在用户未开启保活（keepAliveEnabled=false）时临时启动，已开启则不动
 * - 操作结束后（成功/失败/取消都算）都恢复关闭，try/finally 保证异常也释放
 * - 桌面端 / 非移动端环境整体静默 no-op，无需平台分支
 */
export async function withForegroundKeepAlive<T>(
  shouldKeepAlive: boolean,
  action: () => Promise<T>,
): Promise<T> {
  if (!isAndroidBridgeAvailable() || shouldKeepAlive) {
    return action();
  }
  startForegroundService('Marcel SSH', '运行中');
  try {
    return await action();
  } finally {
    stopForegroundService();
  }
}

/** 更新常驻通知文案（服务必须已启动）。 */
export function updateForegroundNotification(title: string, body: string): void {
  try {
    window.AndroidBridge?.updateForegroundNotification(title, body);
  } catch (e) {
    console.warn('[mobileBridge] updateForegroundNotification failed:', e);
  }
}

/**
 * 发送 Agent 事件通知（走 marcel_agent channel，无声，弹横幅）。
 * @returns true 发送成功；false 权限未授予或非 Android 环境
 */
export function sendAgentNotification(id: number, title: string, body: string): boolean {
  try {
    return window.AndroidBridge?.sendAgentNotification(id, title, body) ?? false;
  } catch (e) {
    console.warn('[mobileBridge] sendAgentNotification failed:', e);
    return false;
  }
}

/** 检查 POST_NOTIFICATIONS 权限。非 Android 环境返回 true。 */
export function isNotificationPermissionGranted(): boolean {
  try {
    return window.AndroidBridge?.isNotificationPermissionGranted() ?? true;
  } catch (e) {
    console.warn('[mobileBridge] isNotificationPermissionGranted failed:', e);
    return true;
  }
}

/**
 * 请求 POST_NOTIFICATIONS 权限（Android 13+）。
 * 异步：弹出系统权限对话框。
 * @returns Promise<boolean> 用户是否授予
 */
export function requestNotificationPermission(): Promise<boolean> {
  if (!isAndroidBridgeAvailable()) {
    return Promise.resolve(true);
  }
  return new Promise<boolean>((resolve) => {
    // 设置一次性回调，MainActivity.notifyPermissionResult 会调用
    const cleanup = () => {
      window.__marcelNotificationPermissionResult = undefined;
    };
    window.__marcelNotificationPermissionResult = (granted: boolean) => {
      cleanup();
      resolve(granted);
    };
    // 超时兜底：10 秒后若未收到回调（极端情况），按当前权限状态 resolve
    setTimeout(() => {
      if (window.__marcelNotificationPermissionResult) {
        cleanup();
        resolve(isNotificationPermissionGranted());
      }
    }, 10000);

    try {
      window.AndroidBridge?.requestNotificationPermission();
    } catch (e) {
      console.warn('[mobileBridge] requestNotificationPermission failed:', e);
      cleanup();
      resolve(isNotificationPermissionGranted());
    }
  });
}
