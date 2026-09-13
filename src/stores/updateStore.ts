import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import {
  getUpdateState,
  installUpdateNow,
  startUpdateDownload,
  updateCapabilities,
} from '@/lib/tauri';
import { getErrorMessage } from '@/lib/errors';
import type { UpdateCapabilities, UpdateState } from '@/lib/types';

const UPDATE_STATE_EVENT = 'update://state';

interface UpdateStoreState {
  /** 后端更新器状态机镜像（全平台统一：Windows 装 exe / Android 装 apk / 其他平台只提示） */
  state: UpdateState;
  /** 本机平台能力（挂载时拉取一次；null = 还没拿到） */
  capabilities: UpdateCapabilities | null;
  /**
   * 已「稍后」的版本号。只影响本会话的 UI 展示，不改变后端行为：
   * - Windows 退出时仍会自动安装；
   * - Android 仍会在下次启动时再问一次（不装就是没更新）。
   * 记版本号而不是布尔值：出现了更新的一版时要重新提醒。
   */
  dismissedVersion: string | null;
  /** 自动更新失败提示是否已关闭（只影响本次展示） */
  failureDismissed: boolean;
  /** 挂载时调用：拉取能力与当前状态 + 订阅 update://state（幂等） */
  init: () => Promise<void>;
  /** 立即安装（Agent/SSH 活跃时的确认由组件层负责）；失败时抛出可直接展示的文案 */
  installNow: () => Promise<void>;
  /** 手动触发后台下载（手机端会绕过「仅非计量网络」限制）；失败时抛出文案 */
  download: () => Promise<void>;
  /** 用户点「稍后」：只隐藏本次提示 */
  dismiss: (version: string) => void;
  /** 关闭自动更新失败提示 */
  dismissFailure: () => void;
}

let initPromise: Promise<void> | null = null;

function isDismissed(state: UpdateState, dismissedVersion: string | null): boolean {
  if (!dismissedVersion) return false;
  return 'version' in state && state.version === dismissedVersion;
}

/** 当前是否应展示更新提示（药丸 / 移动端浮层 / 设置页共用同一判定）。 */
export function isUpdateVisible(
  state: UpdateState,
  dismissedVersion: string | null,
  failureDismissed: boolean,
): boolean {
  if (state.status === 'idle') return false;
  if (state.status === 'failed') return !failureDismissed;
  // 下载中始终可见：用户需要知道流量/进度正在发生
  if (state.status === 'downloading') return true;
  return !isDismissed(state, dismissedVersion);
}

export const useUpdateStore = create<UpdateStoreState>((set, get) => ({
  state: { status: 'idle' },
  capabilities: null,
  dismissedVersion: null,
  failureDismissed: false,

  init: async () => {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      // 先订阅再拉快照：反序会在两次调用之间丢掉事件，留下陈旧状态。
      try {
        await listen<UpdateState>(UPDATE_STATE_EVENT, (event) => {
          const next = event.payload;
          set({
            state: next,
            failureDismissed:
              next.status === 'failed' ? get().failureDismissed : false,
          });
        });
      } catch {
        // 事件通道不可用（浏览器预览 / 后端未就绪）：允许下次挂载时重试，
        // 否则这一整个会话都收不到更新事件。
        initPromise = null;
        return;
      }
      try {
        set({ capabilities: await updateCapabilities() });
      } catch {
        // 老后端或异常：按「不支持后台更新」处理，UI 只保留跳浏览器路径
        set({ capabilities: null });
      }
      try {
        set({ state: await getUpdateState() });
      } catch {
        // 保持 idle（后续事件仍会推进状态）
      }
    })();
    return initPromise;
  },

  installNow: async () => {
    try {
      await installUpdateNow();
      // 成功即进入安装流程（Windows 退出 / Android 拉起系统安装器），无需再更新状态
    } catch (e) {
      // 必须上抛：调用方要展示失败原因（此前这里吞掉异常，用户点了没反应也无提示）
      throw new Error(getErrorMessage(e));
    }
  },

  download: async () => {
    try {
      await startUpdateDownload();
    } catch (e) {
      throw new Error(getErrorMessage(e));
    }
  },

  dismiss: (version) => set({ dismissedVersion: version }),

  dismissFailure: () => set({ failureDismissed: true }),
}));
