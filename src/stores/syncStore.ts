/**
 * 同步状态管理（Zustand store）。
 *
 * 职责：
 * - 持有同步配置摘要（SyncSummary）
 * - 持有已配对设备列表
 * - 提供 pair / disable / updateProfile / pushNow / pullNow 等 action
 * - 监听 Tauri Event 'sync-state-changed' 自动更新状态
 *
 * 不持有：
 * - 配置数据本身（在 settingsStore / connectionStore 等里）
 * - 加密密钥（在 keychain）
 */

import { create } from 'zustand';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  SyncSummary,
  SyncProfile,
  SyncDeviceInfo,
  SyncQuota,
  SyncStateEvent,
  SyncCategory,
  SyncPendingConflict,
  SyncConflictAction,
  SyncConflictsEvent,
} from '../lib/types';
import {
  syncGetSummary,
  syncPairFirst,
  syncPairJoin,
  syncUpdateProfile,
  syncPushNow,
  syncPullNow,
  syncListDevices,
  syncGetQuota,
  syncRemoveDevice,
  syncResetAccount,
  syncDisable,
  syncGetPendingConflicts,
  syncResolveConflict,
  syncResolveAllConflicts,
  syncAddExcludedKey,
  syncRemoveExcludedKey,
  syncGetExcludedKeys,
} from '../lib/tauri';
import { getErrorMessage } from '../lib/errors';
import { collectSyncApplied } from '../lib/syncRefresh';

/** 默认 sync_profile（与后端 profile.rs SyncProfile::default() 对齐） */
export const DEFAULT_SYNC_CATEGORIES: SyncCategory[] = [
  'connections',
  'quickCommands',
  'skills',
  'mcpServers',
  'conversations',
  'terminalSettings',
  'modelService',
  'agentPolicy',
  'displaySettings',
  'agentTools',
  // secrets 默认关
];

/** 与后端 SYNC_PROFILE_SCHEMA_VERSION 对齐 */
export const SYNC_PROFILE_SCHEMA_VERSION = 2;

interface SyncStoreState {
  /** 是否已加载过 summary */
  loaded: boolean;
  /** 同步配置摘要 */
  summary: SyncSummary | null;
  /** 已配对设备列表 */
  devices: SyncDeviceInfo[];
  /** 账户配额使用情况（null = 未拉取/旧服务端无此端点/未配置） */
  quota: SyncQuota | null;
  /** 操作中（pair / disable / reset 等） */
  actionLoading: boolean;
  /** 最近错误 */
  error: string | null;
  /** 待解决的冲突列表（pull 后产生，用户解决后清空） */
  pendingConflicts: SyncPendingConflict[];
  /** 冲突 UI 是否展开（桌面端 Modal / 移动端 Sheet） */
  conflictModalOpen: boolean;
  /** 永久跳过项列表（用户选 SkipForever 时加入，跨重启生效） */
  excludedKeys: string[];
  /** 事件监听器取消函数（sync-state-changed） */
  _unlisten?: UnlistenFn;
  /** 事件监听器取消函数（sync-data-applied） */
  _unlistenDataApplied?: UnlistenFn;
  /** 事件监听器取消函数（sync-batch-applied） */
  _unlistenBatchApplied?: UnlistenFn;
  /** 事件监听器取消函数（sync-conflicts-detected） */
  _unlistenConflicts?: UnlistenFn;
}

interface SyncStoreActions {
  /** 加载同步摘要 + 设备列表 + 配额 + 永久跳过项 */
  load: () => Promise<void>;
  /** 第一台设备配对（需账户密码） */
  pairFirst: (serverUrl: string, password: string) => Promise<string | null>;
  /** 后续设备加入（密码可空：兼容旧账户） */
  pairJoin: (serverUrl: string, configCode: string, password: string) => Promise<void>;
  /** 更新 sync_profile */
  updateProfile: (profile: SyncProfile) => Promise<void>;
  /** 手动 push */
  pushNow: () => Promise<void>;
  /** 手动 pull */
  pullNow: () => Promise<void>;
  /** 刷新设备列表 */
  refreshDevices: () => Promise<void>;
  /** 删除某设备 */
  removeDevice: (deviceId: string) => Promise<void>;
  /** 账户重置 */
  resetAccount: (configCode: string) => Promise<void>;
  /** 关闭同步 */
  disable: () => Promise<void>;
  /** 启动事件监听 */
  startListening: () => Promise<void>;
  /** 停止事件监听 */
  stopListening: () => void;
  /** 清除错误 */
  clearError: () => void;
  // ── 冲突解决 ──
  /** 从后端拉取最新 pending conflicts（手动刷新用） */
  refreshPendingConflicts: () => Promise<void>;
  /** 解决单个冲突（自动从 pendingConflicts 移除并视情况关闭 modal） */
  resolveConflict: (key: string, action: SyncConflictAction) => Promise<void>;
  /** 批量解决所有冲突（actions 按 key 索引） */
  resolveAllConflicts: (actions: Record<string, SyncConflictAction>) => Promise<void>;
  /** 打开冲突 UI */
  openConflictModal: () => void;
  /** 关闭冲突 UI（不解决冲突，pendingConflicts 保留） */
  closeConflictModal: () => void;
  // ── 永久跳过 ──
  /** 添加永久跳过项（持久化 + 同步到本机 SyncProfile） */
  addExcludedKey: (key: string) => Promise<void>;
  /** 移除永久跳过项 */
  removeExcludedKey: (key: string) => Promise<void>;
  /** 从后端拉取最新 excludedKeys */
  refreshExcludedKeys: () => Promise<void>;
}

export type SyncStore = SyncStoreState & SyncStoreActions;

export const useSyncStore = create<SyncStore>((set, get) => ({
  loaded: false,
  summary: null,
  devices: [],
  quota: null,
  actionLoading: false,
  error: null,
  pendingConflicts: [],
  conflictModalOpen: false,
  excludedKeys: [],

  async load() {
    try {
      // summary / excludedKeys 是本机数据，必须成功；devices / quota 走网络，失败不阻塞主界面
      const [summaryResult, devicesResult, excludedResult, quotaResult] =
        await Promise.allSettled([
          syncGetSummary(),
          syncListDevices(),
          syncGetExcludedKeys(),
          syncGetQuota(),
        ]);

      if (summaryResult.status === 'rejected') {
        set({
          loaded: true,
          error: getErrorMessage(summaryResult.reason),
        });
        return;
      }

      const summary = summaryResult.value;
      const devices =
        devicesResult.status === 'fulfilled' ? devicesResult.value : [];
      const excludedKeys =
        excludedResult.status === 'fulfilled' ? excludedResult.value : [];
      // quota 静默降级：旧版服务端无此端点（404）/网络失败时不展示配额行，
      // 不置 error——否则旧服务端用户进同步页就看到错误红条
      const quota =
        quotaResult.status === 'fulfilled' ? quotaResult.value : null;
      const networkError =
        devicesResult.status === 'rejected'
          ? getErrorMessage(devicesResult.reason)
          : excludedResult.status === 'rejected'
            ? getErrorMessage(excludedResult.reason)
            : null;

      set({
        summary,
        devices,
        excludedKeys,
        quota,
        loaded: true,
        error: networkError,
      });
      // 启动时也同步一下 pending conflicts（重启后恢复未解决的冲突）
      await get().refreshPendingConflicts();
      // 启动时若有未解决冲突，自动打开 Modal/Sheet 提示用户处理
      // （冲突必须解决才能继续正常同步，不应藏在状态指示器里）
      if (get().pendingConflicts.length > 0) {
        set({ conflictModalOpen: true });
      }
    } catch (e) {
      set({ loaded: true, error: getErrorMessage(e) });
    }
  },

  async pairFirst(serverUrl, password) {
    set({ actionLoading: true, error: null });
    try {
      const result = await syncPairFirst(serverUrl, password);
      // 第一台设备会返回配置码
      const configCode = result.configCode;
      // 配对后重新加载摘要
      await get().load();
      set({ actionLoading: false });
      return configCode;
    } catch (e) {
      set({ actionLoading: false, error: getErrorMessage(e) });
      throw e;
    }
  },

  async pairJoin(serverUrl, configCode, password) {
    set({ actionLoading: true, error: null });
    try {
      await syncPairJoin(serverUrl, configCode, password);
      // 配对后重新加载摘要
      await get().load();
      set({ actionLoading: false });
    } catch (e) {
      set({ actionLoading: false, error: getErrorMessage(e) });
      throw e;
    }
  },

  async updateProfile(profile) {
    try {
      // 合并现有 excludedKeys（防止前端构造 profile 时丢失永久跳过项）
      const currentExcluded = get().excludedKeys;
      const merged: SyncProfile = {
        enabledCategories: profile.enabledCategories,
        excludedKeys: profile.excludedKeys ?? currentExcluded,
        // 老数据（无版本号）按当前版本提交，后端不会误判为 v1 迁移
        schemaVersion: profile.schemaVersion ?? SYNC_PROFILE_SCHEMA_VERSION,
      };
      await syncUpdateProfile(merged);
      // 更新本地 summary + excludedKeys
      const summary = get().summary;
      if (summary) {
        set({
          summary: { ...summary, profile: merged },
          excludedKeys: merged.excludedKeys,
        });
      }
    } catch (e) {
      set({ error: getErrorMessage(e) });
      throw e;
    }
  },

  async pushNow() {
    try {
      await syncPushNow();
      // push 会改变服务端存储用量，推送后刷新配额（失败静默：旧服务端无此端点时保持旧值）
      try {
        const quota = await syncGetQuota();
        set({ quota });
      } catch (e) {
        console.warn('[syncStore] 刷新配额失败:', e);
      }
    } catch (e) {
      set({ error: getErrorMessage(e) });
      throw e;
    }
  },

  async pullNow() {
    try {
      await syncPullNow();
    } catch (e) {
      set({ error: getErrorMessage(e) });
      throw e;
    }
  },

  async refreshDevices() {
    try {
      const devices = await syncListDevices();
      set({ devices, error: null });
    } catch (e) {
      set({ error: getErrorMessage(e) });
    }
  },

  async removeDevice(deviceId) {
    try {
      await syncRemoveDevice(deviceId);
      // 刷新设备列表
      await get().refreshDevices();
    } catch (e) {
      set({ error: getErrorMessage(e) });
      throw e;
    }
  },

  async resetAccount(configCode) {
    set({ actionLoading: true, error: null });
    try {
      await syncResetAccount(configCode);
      // 重置后重新加载（应显示未配置状态）
      await get().load();
      set({ actionLoading: false });
    } catch (e) {
      set({ actionLoading: false, error: getErrorMessage(e) });
      throw e;
    }
  },

  async disable() {
    set({ actionLoading: true, error: null });
    try {
      await syncDisable();
      await get().load();
      set({ actionLoading: false });
    } catch (e) {
      set({ actionLoading: false, error: getErrorMessage(e) });
      throw e;
    }
  },

  async startListening() {
    if (get()._unlisten) return;

    try {
      // 1. 监听同步状态变更（pushing/pulling/idle/error + pull 进度）
      const unlisten = await listen<SyncStateEvent>('sync-state-changed', (event) => {
        const payload = event.payload;
        const summary = get().summary;
        if (summary) {
          set({
            summary: {
              ...summary,
              state: payload.state,
              pendingCount: payload.pendingCount,
              error: payload.error,
              progress: payload.progress ?? null,
            },
          });
        }
      });
      set({ _unlisten: unlisten });

      // 2. 监听同步数据应用事件（远程 pull 后应用到本地）
      // 单 key 事件（Fork 等）与批量事件都进统一收集器，debounce 后只刷新一轮
      const unlistenDataApplied = await listen<{ key: string; deleted: boolean }>(
        'sync-data-applied',
        (event) => {
          collectSyncApplied(event.payload.key, event.payload.deleted);
        },
      );
      set({ _unlistenDataApplied: unlistenDataApplied });

      // 3. 监听批量应用事件（pull 主路径：一次 pull 只发一个事件）
      const unlistenBatchApplied = await listen<{
        applied: { key: string; deleted: boolean }[];
      }>('sync-batch-applied', (event) => {
        for (const item of event.payload.applied ?? []) {
          collectSyncApplied(item.key, item.deleted);
        }
      });
      set({ _unlistenBatchApplied: unlistenBatchApplied });

      // 4. 监听冲突检测事件（pull 后发现有冲突时 emit）
      const unlistenConflicts = await listen<SyncConflictsEvent>(
        'sync-conflicts-detected',
        (event) => {
          const { conflicts, count } = event.payload;
          if (count > 0) {
            set({
              pendingConflicts: conflicts,
              conflictModalOpen: true,
            });
          }
        },
      );
      set({ _unlistenConflicts: unlistenConflicts });
    } catch (e) {
      // 事件监听失败不致命（可能是非 Tauri 环境）
      console.warn('[syncStore] 事件监听启动失败:', e);
    }
  },

  stopListening() {
    const unlisten = get()._unlisten;
    if (unlisten) {
      unlisten();
      set({ _unlisten: undefined });
    }
    const unlistenDataApplied = get()._unlistenDataApplied;
    if (unlistenDataApplied) {
      unlistenDataApplied();
      set({ _unlistenDataApplied: undefined });
    }
    const unlistenBatchApplied = get()._unlistenBatchApplied;
    if (unlistenBatchApplied) {
      unlistenBatchApplied();
      set({ _unlistenBatchApplied: undefined });
    }
    const unlistenConflicts = get()._unlistenConflicts;
    if (unlistenConflicts) {
      unlistenConflicts();
      set({ _unlistenConflicts: undefined });
    }
  },

  clearError() {
    set({ error: null });
  },

  // ── 冲突解决 ──

  async refreshPendingConflicts() {
    try {
      const conflicts = await syncGetPendingConflicts();
      set({ pendingConflicts: conflicts });
      // 不自动开 modal——让用户通过 UI 提示主动打开
      // 已有冲突时由 SyncStatusIndicator 显示徽标
    } catch (e) {
      console.warn('[syncStore] 刷新 pending conflicts 失败:', e);
    }
  },

  async resolveConflict(key, action) {
    try {
      await syncResolveConflict(key, action);
      // 从 pendingConflicts 移除已解决的
      const remaining = get().pendingConflicts.filter((c) => c.key !== key);
      const isExcluded = action.type === 'skipForever';
      const newExcludedKeys = isExcluded
        ? Array.from(new Set([...get().excludedKeys, key]))
        : get().excludedKeys;
      set({
        pendingConflicts: remaining,
        conflictModalOpen: remaining.length > 0 ? get().conflictModalOpen : false,
        excludedKeys: newExcludedKeys,
      });
      // 同步刷新 summary（pendingCount 可能变化）
      const summary = get().summary;
      if (summary) {
        set({ summary: { ...summary, pendingCount: remaining.length } });
      }
    } catch (e) {
      set({ error: getErrorMessage(e) });
      throw e;
    }
  },

  async resolveAllConflicts(actions) {
    try {
      await syncResolveAllConflicts(actions);
      // 所有冲突已解决，清空 pendingConflicts
      // 收集被永久跳过的 key
      const newlyExcluded: string[] = [];
      for (const [key, action] of Object.entries(actions)) {
        if (action.type === 'skipForever') {
          newlyExcluded.push(key);
        }
      }
      const newExcludedKeys = Array.from(
        new Set([...get().excludedKeys, ...newlyExcluded]),
      );
      set({
        pendingConflicts: [],
        conflictModalOpen: false,
        excludedKeys: newExcludedKeys,
      });
      // 同步刷新 summary
      const summary = get().summary;
      if (summary) {
        set({ summary: { ...summary, pendingCount: 0 } });
      }
    } catch (e) {
      set({ error: getErrorMessage(e) });
      throw e;
    }
  },

  openConflictModal() {
    if (get().pendingConflicts.length > 0) {
      set({ conflictModalOpen: true });
    }
  },

  closeConflictModal() {
    set({ conflictModalOpen: false });
  },

  // ── 永久跳过 ──

  async addExcludedKey(key) {
    try {
      await syncAddExcludedKey(key);
      const newExcluded = Array.from(new Set([...get().excludedKeys, key]));
      set({ excludedKeys: newExcluded });
      // 同步更新 summary.profile.excludedKeys
      const summary = get().summary;
      if (summary) {
        set({
          summary: {
            ...summary,
            profile: { ...summary.profile, excludedKeys: newExcluded },
          },
        });
      }
    } catch (e) {
      set({ error: getErrorMessage(e) });
      throw e;
    }
  },

  async removeExcludedKey(key) {
    try {
      await syncRemoveExcludedKey(key);
      const newExcluded = get().excludedKeys.filter((k) => k !== key);
      set({ excludedKeys: newExcluded });
      // 同步更新 summary.profile.excludedKeys
      const summary = get().summary;
      if (summary) {
        set({
          summary: {
            ...summary,
            profile: { ...summary.profile, excludedKeys: newExcluded },
          },
        });
      }
    } catch (e) {
      set({ error: getErrorMessage(e) });
      throw e;
    }
  },

  async refreshExcludedKeys() {
    try {
      const excludedKeys = await syncGetExcludedKeys();
      set({ excludedKeys });
      const summary = get().summary;
      if (summary) {
        set({
          summary: {
            ...summary,
            profile: { ...summary.profile, excludedKeys },
          },
        });
      }
    } catch (e) {
      console.warn('[syncStore] 刷新 excludedKeys 失败:', e);
    }
  },
}));
