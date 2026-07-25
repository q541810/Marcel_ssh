import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/tauri', () => ({
  sftpUploadStream: vi.fn(),
  sftpUploadFolderStream: vi.fn(),
  sftpDownloadStream: vi.fn(),
  sftpCancelUpload: vi.fn(async () => {}),
  sftpCancelDownload: vi.fn(async () => {}),
}));

vi.mock('@/stores/sessionStore', async () => {
  const { create } = await import('zustand');
  const useSessionStore = create(() => ({ sessions: {}, activeSessionId: null }));
  return { useSessionStore };
});

import {
  sftpUploadStream,
  sftpDownloadStream,
  sftpCancelUpload,
  sftpCancelDownload,
} from '@/lib/tauri';
import { useSessionStore } from '@/stores/sessionStore';
import { useTransferStore, type TransferItem } from '@/stores/transferStore';
import {
  enqueueTransfer,
  cancelTransfer,
  initTransferScheduler,
  _resetForTests,
} from '@/stores/transferScheduler';

type Deferred = { resolve: () => void; reject: (e: unknown) => void };

function deferredMock(fn: ReturnType<typeof vi.fn>): Deferred[] {
  const deferred: Deferred[] = [];
  fn.mockImplementation(
    () =>
      new Promise<void>((resolve, reject) => {
        deferred.push({ resolve, reject });
      }),
  );
  return deferred;
}

let seq = 0;
function makeItem(patch: Partial<TransferItem> = {}): TransferItem {
  seq += 1;
  return {
    id: `t-${seq}`,
    kind: 'upload',
    sessionId: 's1',
    fileName: `file-${seq}.txt`,
    localPath: `C:/tmp/file-${seq}.txt`,
    remotePath: `/srv/file-${seq}.txt`,
    written: 0,
    total: 100,
    statusText: '排队中',
    createdAt: seq,
    ...patch,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function status(id: string) {
  return useTransferStore.getState().items[id]?.status;
}

describe('transferScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
    useTransferStore.setState({ items: {}, order: [] });
    useSessionStore.setState({
      sessions: { s1: { id: 's1', status: 'connected' } },
    } as never);
  });

  it('runs upload lane FIFO serially and starts next after resolve', async () => {
    const uploads = deferredMock(sftpUploadStream as ReturnType<typeof vi.fn>);
    const a = makeItem();
    const b = makeItem();
    enqueueTransfer(a);
    enqueueTransfer(b);

    expect(status(a.id)).toBe('active');
    expect(status(b.id)).toBe('queued');
    expect(sftpUploadStream).toHaveBeenCalledTimes(1);

    uploads[0].resolve();
    await flush();
    expect(status(a.id)).toBe('done');
    expect(status(b.id)).toBe('active');
    expect(sftpUploadStream).toHaveBeenCalledTimes(2);
  });

  it('runs upload and download lanes concurrently', async () => {
    deferredMock(sftpUploadStream as ReturnType<typeof vi.fn>);
    deferredMock(sftpDownloadStream as ReturnType<typeof vi.fn>);
    const up = makeItem();
    const down = makeItem({ kind: 'download' });
    enqueueTransfer(up);
    enqueueTransfer(down);
    expect(status(up.id)).toBe('active');
    expect(status(down.id)).toBe('active');
  });

  it('starts next item after rejection and marks error', async () => {
    const uploads = deferredMock(sftpUploadStream as ReturnType<typeof vi.fn>);
    const a = makeItem();
    const b = makeItem();
    enqueueTransfer(a);
    enqueueTransfer(b);

    uploads[0].reject(new Error('网络错误'));
    await flush();
    expect(status(a.id)).toBe('error');
    expect(useTransferStore.getState().items[a.id].statusText).toContain('上传失败');
    expect(status(b.id)).toBe('active');
  });

  it('cancel of queued item marks cancelled without calling Rust', () => {
    deferredMock(sftpUploadStream as ReturnType<typeof vi.fn>);
    const a = makeItem();
    const b = makeItem();
    enqueueTransfer(a);
    enqueueTransfer(b);

    cancelTransfer(b.id);
    expect(status(b.id)).toBe('cancelled');
    expect(sftpCancelUpload).not.toHaveBeenCalled();
  });

  it('cancel of active item calls cancel command; final state from rejection', async () => {
    const downloads = deferredMock(sftpDownloadStream as ReturnType<typeof vi.fn>);
    const a = makeItem({ kind: 'download' });
    enqueueTransfer(a);

    cancelTransfer(a.id);
    expect(status(a.id)).toBe('cancelling');
    expect(sftpCancelDownload).toHaveBeenCalledWith(a.id);

    downloads[0].reject('下载已取消');
    await flush();
    expect(status(a.id)).toBe('cancelled');
  });

  it('fails queued items whose session is not alive at start', () => {
    deferredMock(sftpUploadStream as ReturnType<typeof vi.fn>);
    const a = makeItem({ sessionId: 'gone' });
    const b = makeItem();
    enqueueTransfer(a);
    enqueueTransfer(b);

    expect(status(a.id)).toBe('error');
    expect(useTransferStore.getState().items[a.id].statusText).toContain('会话已断开');
    expect(status(b.id)).toBe('active');
  });

  it('session disconnect fails its queued items via subscription', async () => {
    initTransferScheduler();
    const uploads = deferredMock(sftpUploadStream as ReturnType<typeof vi.fn>);
    const a = makeItem();
    const b = makeItem();
    enqueueTransfer(a);
    enqueueTransfer(b);
    expect(status(b.id)).toBe('queued');

    useSessionStore.setState({
      sessions: { s1: { id: 's1', status: 'disconnected' } },
    } as never);
    await flush();
    expect(status(b.id)).toBe('error');

    // active 项由命令 reject 落地
    uploads[0].reject(new Error('连接已关闭'));
    await flush();
    expect(status(a.id)).toBe('error');
  });

  it('invokes onFinished callback once with final item', async () => {
    const uploads = deferredMock(sftpUploadStream as ReturnType<typeof vi.fn>);
    const a = makeItem();
    const onFinished = vi.fn();
    enqueueTransfer(a, onFinished);

    uploads[0].resolve();
    await flush();
    expect(onFinished).toHaveBeenCalledTimes(1);
    expect(onFinished.mock.calls[0][0].status).toBe('done');
  });
});
