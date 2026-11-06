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

import { onUiThemeChrome, type UiThemeChrome } from '@/lib/uiTheme';

interface AndroidBridgeRaw {
  startForegroundService(title: string, body: string): void;
  stopForegroundService(): void;
  updateForegroundNotification(title: string, body: string): void;
  /** 返回 true 发送成功，false 权限未授予 */
  sendAgentNotification(id: number, title: string, body: string): boolean;
  isNotificationPermissionGranted(): boolean;
  /** 异步弹出系统权限对话框，结果通过 window.__marcelNotificationPermissionResult 回调 */
  requestNotificationPermission(): void;
  /** "ime,nav"（CSS 长度）；旧版 APK 没有这个方法，调用前必须判空 */
  getInsetBottoms?(): string;
  /** 外框底色（#RRGGBB）+ 是否浅色主题：原生据此设系统栏图标明暗与窗口底色，并记下供下次冷启动用。旧版 APK 没有 */
  setSystemChrome?(background: string, light: boolean): void;
  /**
   * 预见式返回：网页层是否有可消费返回的东西（决定原生接管手势还是交给系统播返回桌面动画）。
   * 只由 `backHandler.ts` 调用——它不 import 本文件，免得每个 mock 了 mobileBridge 的测试都得补这一项。
   */
  setBackIntercept?(enabled: boolean): void;
  /** 实时活动：推一条内容（JSON，字段见 LiveActivityContent）。旧版 APK 没有 */
  setLiveActivity?(json: string): void;
  /** 实时活动：撤掉。旧版 APK 没有 */
  clearLiveActivity?(): void;
  /** 实时活动：当前手机的支持程度（LiveActivitySupport）。旧版 APK 没有 */
  getLiveActivitySupport?(): string;
  /** 实时活动：跳到系统里放行本 App 的页面。旧版 APK 没有 */
  openLiveActivitySettings?(): void;
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

/**
 * 把原生当前的键盘 / 导航栏高度写进 `--ime-bottom` / `--nav-bar-bottom`。
 *
 * 原生侧只在 insets 变化时推送，而页面载入前推过去的值会随旧文档丢掉；三键导航下导航栏
 * 高度恒定、不会再变，页面就一直拿不到值，底栏被导航键盖住。所以页面载入后自己拉一次。
 */
export function syncSystemInsets(): void {
  try {
    const raw = window.AndroidBridge?.getInsetBottoms?.();
    if (!raw) return;
    const [ime, nav] = raw.split(',');
    const style = document.documentElement.style;
    if (ime) style.setProperty('--ime-bottom', ime);
    if (nav) style.setProperty('--nav-bar-bottom', nav);
  } catch (e) {
    console.warn('[mobileBridge] syncSystemInsets failed:', e);
  }
}

/**
 * 把主题的外框信息交给原生：状态栏 / 导航栏图标跟着明暗翻（浅色主题下白图标压在白底上
 * 看不见），窗口与 WebView 底色跟着外框色走。原生同时把它记下来，下次冷启动在页面出来
 * 之前就用对的底色，不再先闪一块深色。
 */
export function setSystemChrome(chrome: UiThemeChrome): void {
  try {
    window.AndroidBridge?.setSystemChrome?.(
      chrome.background,
      chrome.scheme === 'light',
    );
  } catch (e) {
    console.warn('[mobileBridge] setSystemChrome failed:', e);
  }
}

/** 两次推给原生的最短间隔：拖自定义颜色时外框底色每帧都在变，原生每次都要动系统窗口，
 *  不限流会拖垮拖动的跟手度。首次立即推，间隔内的后续变化只保留最后一个。 */
const CHROME_PUSH_MIN_INTERVAL_MS = 250;
let chromeLastPushAt = 0;
let chromePending: UiThemeChrome | null = null;
let chromePushTimer: ReturnType<typeof setTimeout> | null = null;

function pushChromeThrottled(chrome: UiThemeChrome): void {
  const wait = chromeLastPushAt + CHROME_PUSH_MIN_INTERVAL_MS - Date.now();
  if (wait <= 0 && !chromePushTimer) {
    chromeLastPushAt = Date.now();
    setSystemChrome(chrome);
    return;
  }
  chromePending = chrome;
  if (chromePushTimer) return;
  chromePushTimer = setTimeout(() => {
    chromePushTimer = null;
    const latest = chromePending;
    chromePending = null;
    if (!latest) return;
    chromeLastPushAt = Date.now();
    setSystemChrome(latest);
  }, Math.max(wait, 0));
}

/** 订阅主题外框：此后每次主题落定都同步给原生（订阅时会回放当前的）。幂等。 */
let chromeUnsubscribe: (() => void) | null = null;
export function bindSystemChromeToTheme(): void {
  if (chromeUnsubscribe || !isAndroidBridgeAvailable()) return;
  chromeUnsubscribe = onUiThemeChrome(pushChromeThrottled);
}

/** 启动前台保活服务。已运行则更新通知文案。 */
export function startForegroundService(title: string, body: string): void {
  try {
    window.AndroidBridge?.startForegroundService(title, body);
  } catch (e) {
    console.warn('[mobileBridge] startForegroundService failed:', e);
  }
}

function rawStopForegroundService(): void {
  try {
    window.AndroidBridge?.stopForegroundService();
  } catch (e) {
    console.warn('[mobileBridge] stopForegroundService failed:', e);
  }
}

/**
 * 有「必须一直活着」的功能（如 MCP 服务）时登记在这里：key → 常驻通知文案。
 *
 * 前台服务本来只有「用户保活开关」和「临时保活」两类使用者，各自 start/stop。
 * MCP 服务开着时，它们任何一方 stop 都会把服务一并关掉、进程随后被系统回收。
 * 所有 stop 都经 [stopForegroundService]，所以在那里统一拦截，比让每个调用点
 * 各自去问「MCP 还开着吗」更不容易漏。
 */
const foregroundHolds = new Map<string, { title: string; body: string }>();

/** 登记一项保活需求并确保前台服务在跑（重复登记同一个 key 只更新通知文案）。 */
export function holdForeground(key: string, title: string, body: string): void {
  foregroundHolds.set(key, { title, body });
  startForegroundService(title, body);
}

/**
 * 释放一项保活需求。
 *
 * 还有别的需求时只刷新通知；没有了才看用户自己的保活开关——开着就恢复默认文案，
 * 关着才真正停服务。
 */
export function releaseForeground(
  key: string,
  keepAliveEnabled: boolean,
): void {
  if (!foregroundHolds.delete(key)) return;
  const remaining = [...foregroundHolds.values()].pop();
  if (remaining) {
    startForegroundService(remaining.title, remaining.body);
  } else if (keepAliveEnabled) {
    startForegroundService('Marcel SSH', '运行中');
  } else {
    rawStopForegroundService();
  }
}

/** 停止前台保活服务。仍有保活需求（见 [holdForeground]）时不停，只把通知文案换回那一项。 */
export function stopForegroundService(): void {
  const remaining = [...foregroundHolds.values()].pop();
  if (remaining) {
    startForegroundService(remaining.title, remaining.body);
    return;
  }
  rawStopForegroundService();
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
export function updateForegroundNotification(
  title: string,
  body: string,
): void {
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
export function sendAgentNotification(
  id: number,
  title: string,
  body: string,
): boolean {
  try {
    return (
      window.AndroidBridge?.sendAgentNotification(id, title, body) ?? false
    );
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

// ---------- 实时活动（状态栏胶囊 / 灵动岛 / 超级岛） ----------

/**
 * 这台手机能不能显示实时活动：
 * - `ready`：系统会提升本 App 的通知（Android 16 实时活动，或小米放行了焦点通知）
 * - `needsEnable`：系统有这个功能，但没放行本 App，用户可以去系统设置里打开
 * - `unsupported`：系统没有这个功能（含旧版 APK、非 Android），什么都不会发
 */
export type LiveActivitySupport = 'ready' | 'needsEnable' | 'unsupported';

export function getLiveActivitySupport(): LiveActivitySupport {
  try {
    const raw = window.AndroidBridge?.getLiveActivitySupport?.();
    if (raw === 'ready' || raw === 'needsEnable') return raw;
  } catch (e) {
    console.warn('[mobileBridge] getLiveActivitySupport failed:', e);
  }
  return 'unsupported';
}

/** 推送一条实时活动内容。旧版 APK / 非 Android 静默 no-op。 */
export function setLiveActivity(content: unknown): void {
  try {
    window.AndroidBridge?.setLiveActivity?.(JSON.stringify(content));
  } catch (e) {
    console.warn('[mobileBridge] setLiveActivity failed:', e);
  }
}

/** 撤掉实时活动。 */
export function clearLiveActivity(): void {
  try {
    window.AndroidBridge?.clearLiveActivity?.();
  } catch (e) {
    console.warn('[mobileBridge] clearLiveActivity failed:', e);
  }
}

/** 跳到系统里放行本 App 实时活动的页面（解析不到就是通知设置页）。 */
export function openLiveActivitySettings(): void {
  try {
    window.AndroidBridge?.openLiveActivitySettings?.();
  } catch (e) {
    console.warn('[mobileBridge] openLiveActivitySettings failed:', e);
  }
}
