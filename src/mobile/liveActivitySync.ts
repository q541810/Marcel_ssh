/**
 * 实时活动同步层：Agent 任务表变化 → 推给原生的那条岛通知。
 *
 * 只做「什么时候推」：归约在 `lib/liveActivity`，怎么发在原生 `LiveActivity.kt`。
 * 三个约束：
 * - 内容没变不重推（任务进度每个 tick 都在改 store，岛不该跟着闪）；
 * - 两次推送至少隔 `MIN_INTERVAL_MS`，间隔内的变化只保留最后一个；
 * - 有内容时每 `HEARTBEAT_MS` 重推一次：原生那条通知带超时自动消失，页面被冻结 /
 *   进程死了就不会再有人撤它，超时兜底免得「干活中」一直挂在状态栏上。
 */

import {
  liveActivityOf,
  sameLiveActivity,
  type LiveActivityContent,
} from '@/lib/liveActivity';
import { useTaskStore } from '@/stores/taskStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  clearLiveActivity,
  isAndroidBridgeAvailable,
  setLiveActivity,
} from './mobileBridge';

/** 两次推送的最短间隔。 */
export const MIN_INTERVAL_MS = 600;
/** 有内容时的重推周期（须明显短于原生侧的超时）。 */
export const HEARTBEAT_MS = 4 * 60 * 1000;

export interface LiveActivitySyncDeps {
  /** 此刻应该显示什么；开关关着时返回 null。 */
  current: () => LiveActivityContent | null;
  /** 订阅「可能变了」的信号，返回退订函数。 */
  subscribe: (onChange: () => void) => () => void;
  push: (content: LiveActivityContent) => void;
  clear: () => void;
}

/** 启动同步，返回停止函数（停止时撤掉岛）。 */
export function startLiveActivitySync(deps: LiveActivitySyncDeps): () => void {
  let sent: LiveActivityContent | null = null;
  let lastSendAt = 0;
  let trailing: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const send = (target: LiveActivityContent | null) => {
    lastSendAt = Date.now();
    sent = target;
    if (target) deps.push(target);
    else deps.clear();
  };

  const flush = (force = false) => {
    if (stopped) return;
    const target = deps.current();
    if (!force && sameLiveActivity(target, sent)) return;
    // 撤岛不节流：任务一结束就该消失，不必等间隔。
    if (target === null) {
      if (trailing) {
        clearTimeout(trailing);
        trailing = null;
      }
      send(null);
      return;
    }
    const wait = lastSendAt + MIN_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      if (trailing) {
        clearTimeout(trailing);
        trailing = null;
      }
      send(target);
      return;
    }
    if (trailing) return;
    trailing = setTimeout(() => {
      trailing = null;
      flush();
    }, wait);
  };

  const off = deps.subscribe(() => flush());
  const heartbeat = setInterval(() => {
    if (sent) flush(true);
  }, HEARTBEAT_MS);
  flush();

  return () => {
    stopped = true;
    off();
    clearInterval(heartbeat);
    if (trailing) clearTimeout(trailing);
    if (sent) deps.clear();
    sent = null;
  };
}

let stopApp: (() => void) | null = null;

/** App 级启动（幂等）。非 Android 环境 no-op。 */
export function initLiveActivitySync(): void {
  if (stopApp || !isAndroidBridgeAvailable()) return;
  stopApp = startLiveActivitySync({
    current: () => {
      if (
        !useSettingsStore.getState().settings.mobileNotificationSettings
          .liveActivityEnabled
      ) {
        return null;
      }
      const titles: Record<string, string | undefined> = {};
      for (const [id, conv] of Object.entries(
        useConversationStore.getState().conversations,
      )) {
        titles[id] = conv.title;
      }
      return liveActivityOf(useTaskStore.getState().tasks, titles);
    },
    subscribe: (onChange) => {
      const offs = [
        useTaskStore.subscribe(onChange),
        useConversationStore.subscribe(onChange),
        useSettingsStore.subscribe(onChange),
      ];
      return () => offs.forEach((off) => off());
    },
    push: setLiveActivity,
    clear: clearLiveActivity,
  });
}

export function stopLiveActivitySyncForTests(): void {
  stopApp?.();
  stopApp = null;
}
