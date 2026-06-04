import { useState, useCallback, useRef, useEffect } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { sftpDownloadStream } from '@/lib/tauri';
import type { SftpFileEntry } from '@/lib/types';
import { formatSize, getErrorMessage } from '@/lib/sftp-helpers';

export interface DownloadState {
  status: 'idle' | 'downloading' | 'done' | 'error';
  fileName: string;
  written: number;
  total: number;
  statusText: string;
}

interface ProgressPayload {
  downloadId: string;
  written: number;
  total: number;
}

interface DonePayload {
  downloadId: string;
}

export function useSftpDownload(sessionId: string) {
  const [downloadState, setDownloadState] = useState<DownloadState | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const cleanup = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    clearTimer();
  }, [clearTimer]);

  const startDownload = useCallback(
    async (entry: SftpFileEntry, remotePath: string) => {
      cleanup();

      const savePath = await save({
        defaultPath: entry.name,
        title: '保存文件',
      });
      if (!savePath) return;

      const fileSize = entry.size;
      const downloadId = `${Date.now()}`;

      const unlistenProgress = await listen<ProgressPayload>(
        'sftp-download-progress',
        (event) => {
          if (event.payload.downloadId !== downloadId) return;
          const pct =
            event.payload.total > 0
              ? Math.round((event.payload.written * 100) / event.payload.total)
              : 0;
          setDownloadState({
            status: 'downloading',
            fileName: entry.name,
            written: event.payload.written,
            total: event.payload.total,
            statusText: `下载 ${formatSize(event.payload.written)} / ${formatSize(event.payload.total)} (${pct}%)`,
          });
        },
      );

      const unlistenDone = await listen<DonePayload>(
        'sftp-download-done',
        (event) => {
          if (event.payload.downloadId !== downloadId) return;
          setDownloadState({
            status: 'done',
            fileName: entry.name,
            written: fileSize,
            total: fileSize,
            statusText: `${entry.name} 下载完成`,
          });
          clearTimer();
          timeoutRef.current = setTimeout(() => setDownloadState(null), 3000);
          cleanup();
        },
      );

      unlistenRef.current = () => {
        unlistenProgress();
        unlistenDone();
      };

      try {
        setDownloadState({
          status: 'downloading',
          fileName: entry.name,
          written: 0,
          total: fileSize,
          statusText: `正在下载 ${entry.name} ...`,
        });

        await sftpDownloadStream(sessionId, remotePath, savePath, downloadId);
      } catch (err) {
        setDownloadState({
          status: 'error',
          fileName: entry.name,
          written: 0,
          total: fileSize,
          statusText: `下载失败：${getErrorMessage(err)}`,
        });
        clearTimer();
        timeoutRef.current = setTimeout(() => setDownloadState(null), 4000);
        cleanup();
      }
    },
    [sessionId, cleanup],
  );

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return { downloadState, startDownload };
}
