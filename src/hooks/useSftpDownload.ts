import { useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { sftpCancelDownload, sftpDownloadStream } from '@/lib/tauri';
import type { SftpFileEntry } from '@/lib/types';
import { getErrorMessage } from '@/lib/sftp-helpers';
import { useTransferStore, type DownloadState } from '@/stores/transferStore';

const CANCELLED_MSG = '下载已取消';

function createTransferId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useSftpDownload(sessionId: string) {
  const downloadState = useTransferStore((s) => s.download);

  const startDownload = useCallback(
    async (entry: SftpFileEntry, remotePath: string) => {
      const { setDownload, setActiveDownloadId, clearDownloadAfter } = useTransferStore.getState();

      const savePath = await save({
        defaultPath: entry.name,
        title: '保存文件',
      });
      if (!savePath) return;

      const fileSize = entry.size;
      const downloadId = createTransferId();

      setActiveDownloadId(downloadId);
      setDownload({
        status: 'downloading',
        fileName: entry.name,
        written: 0,
        total: fileSize,
        statusText: `正在下载 ${entry.name} ...`,
      });

      try {
        await sftpDownloadStream(sessionId, remotePath, savePath, downloadId);
        const state = useTransferStore.getState();
        if (state.activeDownloadId === downloadId && state.download?.status !== 'downloading') {
          setActiveDownloadId(null);
        }
      } catch (err) {
        const msg = getErrorMessage(err);
        const state = useTransferStore.getState();
        if (state.activeDownloadId !== downloadId) return;

        if (msg === CANCELLED_MSG) {
          setDownload({
            status: 'cancelled',
            fileName: entry.name,
            written: 0,
            total: fileSize,
            statusText: `${entry.name} 下载已取消`,
          });
        } else {
          setDownload({
            status: 'error',
            fileName: entry.name,
            written: 0,
            total: fileSize,
            statusText: `下载失败：${msg}`,
          });
        }
        setActiveDownloadId(null);
        clearDownloadAfter(4000);
      }
    },
    [sessionId],
  );

  const cancelCurrentDownload = useCallback(async () => {
    const { activeDownloadId, download, setDownload } = useTransferStore.getState();
    if (!activeDownloadId || !download) return;

    setDownload({
      status: 'cancelled',
      fileName: download.fileName,
      written: download.written,
      total: download.total,
      statusText: `正在取消 ${download.fileName} ...`,
    });

    try {
      await sftpCancelDownload(activeDownloadId);
    } catch {
      // ignore cancel errors
    }
  }, []);

  return { downloadState, startDownload, cancelCurrentDownload };
}

export type { DownloadState };
