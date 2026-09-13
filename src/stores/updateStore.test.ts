import { beforeEach, describe, it, expect, vi } from 'vitest';
import { isUpdateVisible, useUpdateStore } from '@/stores/updateStore';
import type { UpdateState } from '@/lib/types';

const getUpdateState = vi.fn();
const installUpdateNow = vi.fn();
const startUpdateDownload = vi.fn();
const updateCapabilities = vi.fn();

vi.mock('@/lib/tauri', () => ({
  getUpdateState: () => getUpdateState(),
  installUpdateNow: () => installUpdateNow(),
  startUpdateDownload: () => startUpdateDownload(),
  updateCapabilities: () => updateCapabilities(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

describe('isUpdateVisible', () => {
  const available: UpdateState = {
    status: 'available',
    version: '1.5.0',
    releaseUrl: 'https://example.com/tag/v1.5.0',
  };
  const ready: UpdateState = { status: 'ready', version: '1.5.0' };
  const downloading: UpdateState = {
    status: 'downloading',
    version: '1.5.0',
    downloaded: 10,
    total: 100,
  };

  it('idle 不展示任何提示', () => {
    expect(isUpdateVisible({ status: 'idle' }, null, false)).toBe(false);
  });

  it('available / ready 在未「稍后」时展示', () => {
    expect(isUpdateVisible(available, null, false)).toBe(true);
    expect(isUpdateVisible(ready, null, false)).toBe(true);
  });

  it('「稍后」只对同一版本生效：出现更新的一版要重新提醒', () => {
    expect(isUpdateVisible(available, '1.5.0', false)).toBe(false);
    expect(isUpdateVisible(available, '1.6.0', false)).toBe(true);
    expect(isUpdateVisible({ status: 'ready', version: '1.6.0' }, '1.5.0', false)).toBe(
      true,
    );
  });

  it('下载中始终可见（流量正在消耗，用户有权知道）', () => {
    expect(isUpdateVisible(downloading, '1.5.0', false)).toBe(true);
  });

  it('失败提示可关闭，且与版本无关', () => {
    const failed: UpdateState = { status: 'failed', message: '磁盘空间不足' };
    expect(isUpdateVisible(failed, null, false)).toBe(true);
    expect(isUpdateVisible(failed, null, true)).toBe(false);
  });
});

describe('updateStore', () => {
  beforeEach(() => {
    getUpdateState.mockReset();
    installUpdateNow.mockReset();
    startUpdateDownload.mockReset();
    updateCapabilities.mockReset();
    useUpdateStore.setState({
      state: { status: 'idle' },
      capabilities: null,
      dismissedVersion: null,
      failureDismissed: false,
    });
  });

  it('installNow 把失败原因上抛给调用方（不能吞掉，否则用户点了没有任何反馈）', async () => {
    installUpdateNow.mockRejectedValue({ kind: 'Other', message: '暂无已就绪的更新' });
    await expect(useUpdateStore.getState().installNow()).rejects.toThrow(
      '暂无已就绪的更新',
    );
  });

  it('installNow 成功时不抛错', async () => {
    installUpdateNow.mockResolvedValue(undefined);
    await expect(useUpdateStore.getState().installNow()).resolves.toBeUndefined();
  });

  it('download 把失败原因上抛', async () => {
    startUpdateDownload.mockRejectedValue({
      kind: 'Other',
      message: '该版本未提供自动更新包，请前往下载页手动安装',
    });
    await expect(useUpdateStore.getState().download()).rejects.toThrow(
      '该版本未提供自动更新包',
    );
  });

  it('dismiss 记版本号，dismissFailure 独立生效', () => {
    useUpdateStore.getState().dismiss('1.5.0');
    expect(useUpdateStore.getState().dismissedVersion).toBe('1.5.0');
    useUpdateStore.getState().dismissFailure();
    expect(useUpdateStore.getState().failureDismissed).toBe(true);
  });
});
