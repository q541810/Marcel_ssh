import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resetEventChannelsForTest,
  subscriberCount,
} from '@/lib/tauriEvent';

/**
 * 守的是「重复 attach 会不会重复注册」这件事。
 *
 * 旧实现把 `attached = true` 写在 8 个 `await listen` 之后：StrictMode 的两次
 * 并发调用都能通过守卫，于是 8 条监听变成 16 条，先到的那批还永远没人回收。
 * 这个 bug 在真机上只表现为「事件被处理两遍」，所以必须靠单测钉住订阅条数。
 */

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));
vi.mock('@/lib/tauri', () => ({
  sftpDownload: vi.fn(),
  sftpDownloadCancel: vi.fn(),
  sftpPreviewCleanup: vi.fn(),
  sftpRemove: vi.fn(),
}));
// 传输调度器会起定时器，本测试只关心订阅，不关心调度。
vi.mock('./transferScheduler', () => ({
  initTransferScheduler: vi.fn(),
  enqueueTransfer: vi.fn(),
}));
vi.mock('./transferFlyAnimation', () => ({
  flyToTransferCenter: vi.fn(),
}));

const PROGRESS_EVENTS = [
  'sftp-upload-progress',
  'sftp-upload-done',
  'sftp-folder-upload-status',
  'sftp-download-progress',
  'sftp-download-done',
  'sftp-sysopen-state',
  'agent-transfer-start',
  'agent-transfer-finished',
];

describe('sftpTransferManager 的订阅生命周期', () => {
  beforeEach(async () => {
    // 先 detach 再清通道：`resetEventChannelsForTest` 只清订阅原语的通道表，
    // **不会**重置本模块的 attach 守卫。不 detach 的话，本文件一旦加第二个用例，
    // 前一个用例留下的守卫会让 attach 直接 early-return，断言就会以
    // 「订阅条数不对」的形式报出来 —— 方向完全错误的那种失败。
    const { detachTransferListeners } = await import('./sftpTransferManager');
    detachTransferListeners();
    resetEventChannelsForTest();
  });

  it('重复 attach 不会重复注册（StrictMode 双挂载），detach 后归零', async () => {
    const { attachTransferListeners, detachTransferListeners } = await import(
      './sftpTransferManager'
    );

    attachTransferListeners();
    attachTransferListeners();
    attachTransferListeners();

    for (const name of PROGRESS_EVENTS) {
      expect(subscriberCount(name), `${name} 应恰好一条监听`).toBe(1);
    }

    detachTransferListeners();
    for (const name of PROGRESS_EVENTS) {
      expect(subscriberCount(name), `${name} 卸载后应无残留`).toBe(0);
    }

    // detach 之后可以重新 attach（StrictMode 的第二轮挂载走的就是这条路）。
    attachTransferListeners();
    expect(subscriberCount('sftp-upload-progress')).toBe(1);
    detachTransferListeners();
    expect(subscriberCount('sftp-upload-progress')).toBe(0);
  });
});
