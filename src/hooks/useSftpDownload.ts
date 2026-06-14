import { useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { sftpDownloadStream } from '@/lib/tauri';
import type { SftpFileEntry } from '@/lib/types';
import { getErrorMessage } from '@/lib/sftp-helpers';
import { useTransferStore, type DownloadState } from '@/stores/transferStore';

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
      const downloadId = `${Date.now()}`;

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
      } catch (err) {
        setDownload({
          status: 'error',
          fileName: entry.name,
          written: 0,
          total: fileSize,
          statusText: `下载失败：${getErrorMessage(err)}`,
        });
        clearDownloadAfter(4000);
      }
    },
    [sessionId],
  );

  return { downloadState, startDownload };
}

export type { DownloadState };
