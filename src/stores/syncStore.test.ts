// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as tauri from '@/lib/tauri';
import { resetEventChannelsForTest } from '@/lib/tauriEvent';
import type { SyncStatus } from '@/lib/types';
import {
  SYNC_FOREGROUND_THROTTLE_MS,
  initSync,
  resetSyncThrottleForTest,
  useSyncStore,
} from './syncStore';

vi.mock('@/lib/tauri', () => ({
  syncGetStatus: vi.fn(),
  syncNow: vi.fn(),
  syncTestStorage: vi.fn(),
  syncCreate: vi.fn(),
  syncJoin: vi.fn(),
  syncJoinManual: vi.fn(),
  syncGetSyncCode: vi.fn(),
  syncGetRecoveryKey: vi.fn(),
  syncSetDeviceName: vi.fn(),
  syncListDevices: vi.fn(),
  syncListHistory: vi.fn(),
  syncUndo: vi.fn(),
  syncConfirmHeld: vi.fn(),
  syncDisable: vi.fn(),
}));

const handleApplied = vi.hoisted(() => vi.fn());
vi.mock('@/lib/syncRefresh', () => ({ handleSyncDataApplied: handleApplied }));

/** 假的事件总线：listen 把回调记下来，测试里手动 emit。 */
const bus = vi.hoisted(() => ({ handlers: new Map<string, Array<(e: { payload: unknown }) => void>>() }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, cb: (e: { payload: unknown }) => void) => {
    const list = bus.handlers.get(name) ?? [];
    list.push(cb);
    bus.handlers.set(name, list);
    return () => {
      bus.handlers.set(
        name,
        (bus.handlers.get(name) ?? []).filter((h) => h !== cb),
      );
    };
  }),
}));

function emit(name: string, payload: unknown) {
  for (const handler of bus.handlers.get(name) ?? []) handler({ payload });
}

function status(partial: Partial<SyncStatus> = {}): SyncStatus {
  return {
    enabled: true,
    state: 'idle',
    lastSyncAt: null,
    lastError: null,
    pendingCount: 0,
    deviceId: 'd1',
    deviceName: '我的电脑',
    storage: null,
    held: null,
    tiers: { config: true, conversation: false, secret: false },
    streams: [],
    ...partial,
  };
}

const initialState = useSyncStore.getState();

describe('syncStore', () => {
  beforeEach(() => {
    useSyncStore.setState(initialState, true);
    resetSyncThrottleForTest();
    resetEventChannelsForTest();
    bus.handlers.clear();
    handleApplied.mockReset();
    for (const fn of Object.values(tauri)) {
      if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
    }
    vi.mocked(tauri.syncGetStatus).mockResolvedValue(status());
    vi.mocked(tauri.syncNow).mockResolvedValue(undefined);
    vi.mocked(tauri.syncListDevices).mockResolvedValue([]);
    vi.mocked(tauri.syncListHistory).mockResolvedValue([]);
  });

  afterEach(() => {
    resetEventChannelsForTest();
  });

  describe('状态读取', () => {
    it('refreshStatus 写入后端状态', async () => {
      await useSyncStore.getState().refreshStatus();
      expect(useSyncStore.getState().status?.deviceName).toBe('我的电脑');
      expect(useSyncStore.getState().statusError).toBeNull();
    });

    it('后端命令不可用：statusError 记下可读原因，status 保持 null，界面据此显示重试', async () => {
      vi.mocked(tauri.syncGetStatus).mockRejectedValue({ kind: 'Other', message: '同步模块未就绪' });
      await useSyncStore.getState().refreshStatus();
      expect(useSyncStore.getState().status).toBeNull();
      expect(useSyncStore.getState().statusError).toBe('同步模块未就绪');
      // 恢复后清掉错误
      vi.mocked(tauri.syncGetStatus).mockResolvedValue(status());
      await useSyncStore.getState().refreshStatus();
      expect(useSyncStore.getState().statusError).toBeNull();
    });

    it('设备 / 记录读取失败只影响各自的区块', async () => {
      vi.mocked(tauri.syncListDevices).mockRejectedValue(new Error('读设备失败'));
      await useSyncStore.getState().loadDevices();
      expect(useSyncStore.getState().devicesError).toBe('读设备失败');
      expect(useSyncStore.getState().devicesLoading).toBe(false);
      await useSyncStore.getState().loadHistory();
      expect(useSyncStore.getState().historyError).toBeNull();
    });
  });

  describe('requestSync（前台触发，节流 10 秒）', () => {
    it('没开启同步时不发请求', () => {
      useSyncStore.setState({ status: status({ enabled: false, state: 'off' }) });
      expect(useSyncStore.getState().requestSync(1_000_000)).toBe(false);
      expect(tauri.syncNow).not.toHaveBeenCalled();
    });

    it('10 秒内重复触发只发一次，过了间隔再发', () => {
      useSyncStore.setState({ status: status() });
      const t0 = 1_000_000;
      expect(useSyncStore.getState().requestSync(t0)).toBe(true);
      expect(useSyncStore.getState().requestSync(t0 + 1_000)).toBe(false);
      expect(useSyncStore.getState().requestSync(t0 + SYNC_FOREGROUND_THROTTLE_MS - 1)).toBe(false);
      expect(useSyncStore.getState().requestSync(t0 + SYNC_FOREGROUND_THROTTLE_MS)).toBe(true);
      expect(tauri.syncNow).toHaveBeenCalledTimes(2);
    });

    it('后台触发失败不抛、不改界面状态', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(tauri.syncNow).mockRejectedValue(new Error('网络不通'));
      useSyncStore.setState({ status: status() });
      expect(() => useSyncStore.getState().requestSync(2_000_000)).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
      expect(useSyncStore.getState().statusError).toBeNull();
      warn.mockRestore();
    });
  });

  describe('syncNow（用户点按钮）', () => {
    it('成功后重新拉状态', async () => {
      vi.mocked(tauri.syncGetStatus).mockResolvedValue(status({ lastSyncAt: '2026-10-29T12:00:00Z' }));
      await useSyncStore.getState().syncNow();
      expect(useSyncStore.getState().status?.lastSyncAt).toBe('2026-10-29T12:00:00Z');
      expect(useSyncStore.getState().syncingNow).toBe(false);
    });

    it('失败：抛出可展示的错误，并且仍以后端状态为准刷新（原因在 lastError 里）', async () => {
      vi.mocked(tauri.syncNow).mockRejectedValue({ kind: 'Network', message: '连不上坚果云' });
      vi.mocked(tauri.syncGetStatus).mockResolvedValue(status({ state: 'error', lastError: '连不上坚果云' }));
      await expect(useSyncStore.getState().syncNow()).rejects.toMatchObject({ message: '连不上坚果云' });
      expect(useSyncStore.getState().status?.state).toBe('error');
      expect(useSyncStore.getState().syncingNow).toBe(false);
    });

    it('进行中再点不会重复发', async () => {
      let release: () => void = () => {};
      vi.mocked(tauri.syncNow).mockImplementation(() => new Promise<void>((r) => (release = r)));
      const first = useSyncStore.getState().syncNow();
      await useSyncStore.getState().syncNow();
      expect(tauri.syncNow).toHaveBeenCalledTimes(1);
      release();
      await first;
    });
  });

  describe('机密不进状态', () => {
    it('create 把恢复密钥 / 同步码只交给调用方，store 里搜不到', async () => {
      vi.mocked(tauri.syncCreate).mockResolvedValue({
        recoveryKey: 'abcd2345efgh6789jkmnpqrstuvwxyz2',
        syncCode: 'MSYNC1-secretpayload',
      });
      const result = await useSyncStore.getState().create({ kind: 'sftp', connectionId: 'c1', root: 'marcel-sync' }, null);
      expect(result.recoveryKey).toBe('abcd2345efgh6789jkmnpqrstuvwxyz2');
      const serialized = JSON.stringify(useSyncStore.getState());
      expect(serialized).not.toContain('abcd2345efgh6789jkmnpqrstuvwxyz2');
      expect(serialized).not.toContain('secretpayload');
    });

    it('getSyncCode / getRecoveryKey 直接透传', async () => {
      vi.mocked(tauri.syncGetSyncCode).mockResolvedValue('MSYNC1-x');
      vi.mocked(tauri.syncGetRecoveryKey).mockResolvedValue('k');
      expect(await useSyncStore.getState().getSyncCode()).toBe('MSYNC1-x');
      expect(await useSyncStore.getState().getRecoveryKey()).toBe('k');
    });
  });

  describe('操作之后的状态跟进', () => {
    it('join / joinManual 成功后拉状态、设备、记录', async () => {
      vi.mocked(tauri.syncJoin).mockResolvedValue(undefined);
      vi.mocked(tauri.syncJoinManual).mockResolvedValue(undefined);
      await useSyncStore.getState().join('MSYNC1-x');
      await useSyncStore.getState().joinManual({ kind: 'sftp', connectionId: 'c', root: 'r' }, null, 'key');
      expect(tauri.syncGetStatus).toHaveBeenCalledTimes(2);
      expect(tauri.syncListDevices).toHaveBeenCalledTimes(2);
      expect(tauri.syncListHistory).toHaveBeenCalledTimes(2);
    });

    it('disable 清空设备与记录再拉状态', async () => {
      useSyncStore.setState({
        devices: [{ id: 'd', name: 'n', platform: 'desktop', appVersion: '1', lastSeenAt: 'x', isSelf: true, tiers: { config: true, conversation: false, secret: false } }],
        history: [
          {
            id: 'h',
            at: 'x',
            deviceName: 'n',
            source: 'settings',
            path: 'p',
            oldValue: null,
            newValue: null,
            kind: 'change',
            undone: false,
          },
        ],
      });
      vi.mocked(tauri.syncDisable).mockResolvedValue(undefined);
      vi.mocked(tauri.syncGetStatus).mockResolvedValue(status({ enabled: false, state: 'off' }));
      await useSyncStore.getState().disable(true);
      expect(tauri.syncDisable).toHaveBeenCalledWith(true);
      expect(useSyncStore.getState().devices).toEqual([]);
      expect(useSyncStore.getState().history).toEqual([]);
      expect(useSyncStore.getState().status?.enabled).toBe(false);
    });

    it('setDeviceName 去首尾空白', async () => {
      vi.mocked(tauri.syncSetDeviceName).mockResolvedValue(undefined);
      await useSyncStore.getState().setDeviceName('  书房电脑 ');
      expect(tauri.syncSetDeviceName).toHaveBeenCalledWith('书房电脑');
    });

    it('confirmHeld / undo 之后刷新', async () => {
      vi.mocked(tauri.syncConfirmHeld).mockResolvedValue(undefined);
      vi.mocked(tauri.syncUndo).mockResolvedValue(undefined);
      await useSyncStore.getState().confirmHeld(false);
      expect(tauri.syncConfirmHeld).toHaveBeenCalledWith(false);
      await useSyncStore.getState().undo('h1');
      expect(tauri.syncUndo).toHaveBeenCalledWith('h1');
      expect(tauri.syncListHistory).toHaveBeenCalled();
    });
  });

  describe('initSync 全局监听', () => {
    it('sync-status 事件更新状态', async () => {
      const detach = initSync();
      await vi.waitFor(() => expect(bus.handlers.get('sync-status')?.length).toBe(1));
      emit('sync-status', status({ state: 'needsUpgrade' }));
      expect(useSyncStore.getState().status?.state).toBe('needsUpgrade');
      detach();
    });

    it('sync-data-applied 事件交给刷新表处理', async () => {
      const detach = initSync();
      await vi.waitFor(() => expect(bus.handlers.get('sync-data-applied')?.length).toBe(1));
      emit('sync-data-applied', { source: 'connections' });
      expect(handleApplied).toHaveBeenCalledWith('connections');
      detach();
    });

    it('窗口获得焦点 / 手机回到前台 / 页面重新可见 都触发一次（节流）同步', async () => {
      const detach = initSync();
      // initSync 在订阅好之后会主动跑一次首轮（解除后端「等前端」的闸门），先把它等掉
      await vi.waitFor(() => expect(tauri.syncNow).toHaveBeenCalledTimes(1));
      resetSyncThrottleForTest();

      window.dispatchEvent(new Event('focus'));
      expect(tauri.syncNow).toHaveBeenCalledTimes(2);
      window.dispatchEvent(new CustomEvent('mobile:foreground'));
      document.dispatchEvent(new Event('visibilitychange'));
      expect(tauri.syncNow).toHaveBeenCalledTimes(2); // 节流窗口内
      detach();
    });

    it('订阅好事件之后主动跑一次首轮，把后端的等待闸门打开', async () => {
      const detach = initSync();
      await vi.waitFor(() => expect(tauri.syncNow).toHaveBeenCalledTimes(1));
      // 顺序不能反：首轮要发在订阅之后，否则启动期落地的 sync-data-applied 会丢
      expect(bus.handlers.get('sync-data-applied')?.length).toBe(1);
      expect(bus.handlers.get('sync-status')?.length).toBe(1);
      detach();
    });

    it('没开启同步时不会去调 sync_now', async () => {
      vi.mocked(tauri.syncGetStatus).mockResolvedValue(status({ enabled: false, state: 'off' }));
      const detach = initSync();
      await vi.waitFor(() => expect(useSyncStore.getState().status?.enabled).toBe(false));
      expect(tauri.syncNow).not.toHaveBeenCalled();
      detach();
    });

    it('退订后不再响应', async () => {
      const detach = initSync();
      await vi.waitFor(() => expect(tauri.syncNow).toHaveBeenCalledTimes(1)); // 首轮
      detach();
      resetSyncThrottleForTest();
      window.dispatchEvent(new Event('focus'));
      expect(tauri.syncNow).toHaveBeenCalledTimes(1);
    });
  });
});
