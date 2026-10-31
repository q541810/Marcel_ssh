import { create } from 'zustand';
import * as tauri from '@/lib/tauri';
import { subscribeTauriEvent } from '@/lib/tauriEvent';
import { getErrorMessage } from '@/lib/errors';
import { handleSyncDataApplied } from '@/lib/syncRefresh';
import type {
  SyncCreateResult,
  SyncDataAppliedPayload,
  SyncDevice,
  SyncHistoryEntry,
  SyncStatus,
  SyncStorageConfig,
  TierEstimate,
} from '@/lib/types';

/**
 * 跨设备同步的前端 manager：同步状态、设备列表、同步记录，以及对后端 `sync_*` 命令的编排。
 *
 * 它**协调**多件事（后端状态推送、别的设备改动落地后刷新各个 store、窗口回到前台时触发同步），
 * 所以是 manager 而不是纯功能。几条取舍：
 *
 * - **机密不进状态**：恢复密钥 / 同步码 / 存储密码只经函数返回值交给调用方（向导的局部状态），
 *   store 里不留、也不打日志；
 * - **后端是权威**：每个动作成功后都重新拉一次 `sync_get_status`，不在前端拼状态；
 *   `sync-status` 事件只是让它更及时；
 * - **后端暂时不可用也能正常显示**：命令报错时 `statusError` 记下原因，界面给出重试，
 *   不影响设置页其它部分；
 * - **前台触发的同步节流 10 秒**：窗口反复获得焦点不能把存储（坚果云免费版有频率限制）打爆。
 */

/** 前台触发同步（窗口获得焦点 / 手机回到前台）的最小间隔。 */
export const SYNC_FOREGROUND_THROTTLE_MS = 10_000;

/** 同步记录一次最多拉多少条。 */
export const SYNC_HISTORY_LIMIT = 100;

interface SyncStoreState {
  /** null = 还没拿到（或命令不可用）。 */
  status: SyncStatus | null;
  /** 读取状态失败的原因（后端未就绪 / 命令报错）；成功后清空。 */
  statusError: string | null;
  devices: SyncDevice[];
  devicesLoading: boolean;
  devicesError: string | null;
  history: SyncHistoryEntry[];
  historyLoading: boolean;
  historyError: string | null;
  /** 「立即同步」正在进行。 */
  syncingNow: boolean;

  refreshStatus: () => Promise<void>;
  loadDevices: () => Promise<void>;
  loadHistory: () => Promise<void>;

  /** 立即同步（用户点按钮）：失败抛出可直接展示的错误。 */
  syncNow: () => Promise<void>;
  /** 前台 / 定时触发：节流、失败不打扰（状态由后端推送）。返回是否真的发出了请求。 */
  requestSync: (now?: number) => boolean;

  testStorage: (storage: SyncStorageConfig, secret: string | null) => Promise<void>;
  create: (storage: SyncStorageConfig, secret: string | null) => Promise<SyncCreateResult>;
  join: (syncCode: string) => Promise<void>;
  joinManual: (
    storage: SyncStorageConfig,
    secret: string | null,
    recoveryKey: string,
  ) => Promise<void>;

  /** 机密：直接返回，不进 store。 */
  getSyncCode: () => Promise<string>;
  getRecoveryKey: () => Promise<string>;

  setDeviceName: (name: string) => Promise<void>;
  /** 打开 / 关闭某一档（`"conversation"` / `"secret"`）。成功后刷新状态。 */
  setTier: (tier: string, enabled: boolean) => Promise<void>;
  /** 某一档的规模估算（只有数量与名称）。 */
  tierEstimate: (tier: string) => Promise<TierEstimate>;
  undo: (entryId: string) => Promise<void>;
  confirmHeld: (accept: boolean) => Promise<void>;
  disable: (wipeRemote: boolean) => Promise<void>;
}

let lastForegroundRequestAt = -Infinity;

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  status: null,
  statusError: null,
  devices: [],
  devicesLoading: false,
  devicesError: null,
  history: [],
  historyLoading: false,
  historyError: null,
  syncingNow: false,

  refreshStatus: async () => {
    try {
      const status = await tauri.syncGetStatus();
      set({ status, statusError: null });
    } catch (err) {
      set({ statusError: getErrorMessage(err) });
    }
  },

  loadDevices: async () => {
    set({ devicesLoading: true });
    try {
      const devices = await tauri.syncListDevices();
      set({ devices, devicesError: null });
    } catch (err) {
      set({ devicesError: getErrorMessage(err) });
    } finally {
      set({ devicesLoading: false });
    }
  },

  loadHistory: async () => {
    set({ historyLoading: true });
    try {
      const history = await tauri.syncListHistory(SYNC_HISTORY_LIMIT);
      set({ history, historyError: null });
    } catch (err) {
      set({ historyError: getErrorMessage(err) });
    } finally {
      set({ historyLoading: false });
    }
  },

  syncNow: async () => {
    if (get().syncingNow) return;
    set({ syncingNow: true });
    try {
      await tauri.syncNow();
    } finally {
      set({ syncingNow: false });
      // 无论成败都以后端状态为准（失败原因在 status.lastError 里）。
      await get().refreshStatus();
    }
  },

  requestSync: (now = Date.now()) => {
    if (!get().status?.enabled) return false;
    if (now - lastForegroundRequestAt < SYNC_FOREGROUND_THROTTLE_MS) return false;
    lastForegroundRequestAt = now;
    tauri.syncNow().catch((err) => {
      // 后台触发的同步失败不弹任何东西：后端会把原因写进 status.lastError 并推送。
      console.warn('[sync] 前台触发的同步失败:', getErrorMessage(err));
    });
    return true;
  },

  testStorage: (storage, secret) => tauri.syncTestStorage(storage, secret),

  create: async (storage, secret) => {
    const result = await tauri.syncCreate(storage, secret);
    await get().refreshStatus();
    void get().loadDevices();
    return result;
  },

  join: async (syncCode) => {
    await tauri.syncJoin(syncCode);
    await get().refreshStatus();
    void get().loadDevices();
    void get().loadHistory();
  },

  joinManual: async (storage, secret, recoveryKey) => {
    await tauri.syncJoinManual(storage, secret, recoveryKey);
    await get().refreshStatus();
    void get().loadDevices();
    void get().loadHistory();
  },

  getSyncCode: () => tauri.syncGetSyncCode(),
  getRecoveryKey: () => tauri.syncGetRecoveryKey(),

  setDeviceName: async (name) => {
    await tauri.syncSetDeviceName(name.trim());
    await Promise.all([get().refreshStatus(), get().loadDevices()]);
  },

  setTier: async (tier, enabled) => {
    await tauri.syncSetTier(tier, enabled);
    // 打开某一档会先导出本机数据再追进度，状态（tiers / streams）以后端为准。
    await get().refreshStatus();
    void get().loadDevices();
  },

  tierEstimate: (tier) => tauri.syncTierEstimate(tier),

  undo: async (entryId) => {
    await tauri.syncUndo(entryId);
    await Promise.all([get().refreshStatus(), get().loadHistory()]);
  },

  confirmHeld: async (accept) => {
    await tauri.syncConfirmHeld(accept);
    await get().refreshStatus();
  },

  disable: async (wipeRemote) => {
    await tauri.syncDisable(wipeRemote);
    // 停止后设备 / 记录都不再有意义，先清掉再拉状态，避免面板重新展开时闪出旧数据。
    set({ devices: [], history: [], devicesError: null, historyError: null });
    await get().refreshStatus();
  },
}));

/** 测试用：把节流计时清零。 */
export function resetSyncThrottleForTest(): void {
  lastForegroundRequestAt = -Infinity;
}

/**
 * 挂载同步的全局监听（桌面 `App` / 手机 `MobileApp` 各调一次，返回退订函数）：
 *
 * - `sync-status`：后端推送状态变化；
 * - `sync-data-applied`：别的设备的改动落到了本机 → 刷新对应前端 store（见 `lib/syncRefresh.ts`）；
 * - 窗口获得焦点 / 页面重新可见 / 手机回到前台 → 请求一次同步（节流）；
 * - **挂载后主动拉一次状态，并（已开启同步时）触发首轮**：后端启动时故意不落地，等前端订阅好
 *   `sync-data-applied` 之后的那次 `sync_now` 才跑首轮——否则启动期落地的改动发出的刷新事件
 *   前端收不到，界面停在旧数据上，下一次保存还会把旧数据整份存回去。15 秒兜底只是「前端一直不来」
 *   时的保险（窗口没打开），不该是常态。
 *
 * 桌面窗口焦点用 DOM 的 `focus` / `visibilitychange`，手机用 `App` 派发的 `mobile:foreground`：
 * 三个信号都映射到同一个 `requestSync`，平台差异不进 store。
 */
export function initSync(): () => void {
  const unsubStatus = subscribeTauriEvent<SyncStatus>('sync-status', (status) => {
    useSyncStore.setState({ status, statusError: null });
  });
  const unsubApplied = subscribeTauriEvent<SyncDataAppliedPayload>('sync-data-applied', (payload) => {
    // 对话流会带上这一批落地改到的会话 id：当前打开的那段据此决定要不要重读。
    void handleSyncDataApplied(payload.source, payload.conversationIds ?? []);
  });

  const onForeground = () => {
    useSyncStore.getState().requestSync();
  };
  const onVisibility = () => {
    if (document.visibilityState === 'visible') onForeground();
  };
  window.addEventListener('focus', onForeground);
  window.addEventListener('mobile:foreground', onForeground);
  document.addEventListener('visibilitychange', onVisibility);

  // 订阅先就位，再拉状态 / 触发首轮（顺序不能反）。
  void (async () => {
    await useSyncStore.getState().refreshStatus();
    if (useSyncStore.getState().status?.enabled) {
      // 首轮不受 10 秒节流限制：它就是「解除后端等待闸门」的那一次
      try {
        await tauri.syncNow();
      } catch (err) {
        console.warn('[sync] 首轮同步失败:', getErrorMessage(err));
      }
    }
  })();

  return () => {
    unsubStatus();
    unsubApplied();
    window.removeEventListener('focus', onForeground);
    window.removeEventListener('mobile:foreground', onForeground);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
