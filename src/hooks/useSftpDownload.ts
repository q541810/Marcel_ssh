import { useCallback } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import type { SftpFileEntry } from '@/lib/types';
import { enqueueTransfer, createTransferId } from '@/stores/transferScheduler';

export function useSftpDownload(sessionId: string) {
  const startDownload = useCallback(
    async (entry: SftpFileEntry, remotePath: string, onFinished?: () => void) => {
      const savePath = await save({
        defaultPath: entry.name,
        title: '保存文件',
      });
      if (!savePath) return;

      enqueueTransfer(
        {
          id: createTransferId(),
          kind: 'download',
          sessionId,
          fileName: entry.name,
          localPath: savePath,
          remotePath,
          written: 0,
          total: entry.size,
          statusText: '排队中',
          createdAt: Date.now(),
        },
        onFinished,
      );
    },
    [sessionId],
  );

  return { startDownload };
}
