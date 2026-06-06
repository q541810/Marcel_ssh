import { useState, useCallback, useRef, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { sftpUploadFolderStream, sftpUploadStream } from '@/lib/tauri';
import { formatSize, getErrorMessage } from '@/lib/sftp-helpers';
import { formatFolderUploadStatus, type FolderStatusPayload } from './sftpUploadStatus';

interface ProgressPayload {
  uploadId: string;
  written: number;
  total: number;
}

interface DonePayload {
  uploadId: string;
}

export interface UploadState {
  status: 'uploading' | 'done' | 'error';
  fileName: string;
  written: number;
  total: number;
  statusText: string;
}

export function useSftpUpload(sessionId: string, remotePath: string) {
  const [uploadState, setUploadState] = useState<UploadState | null>(null);
  const [folderStatus, setFolderStatus] = useState<string | null>(null);
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

  const uploadFile = useCallback(
    async (localPath: string, fileName: string, targetPath: string) => {
      cleanup();

      const uploadId = `${Date.now()}`;

      const unlistenProgress = await listen<ProgressPayload>(
        'sftp-upload-progress',
        (event) => {
          if (event.payload.uploadId !== uploadId) return;
          const pct =
            event.payload.total > 0
              ? Math.round((event.payload.written * 100) / event.payload.total)
              : 0;
          setUploadState({
            status: 'uploading',
            fileName,
            written: event.payload.written,
            total: event.payload.total,
            statusText: `上传 ${formatSize(event.payload.written)} / ${formatSize(event.payload.total)} (${pct}%)`,
          });
        },
      );

      const unlistenDone = await listen<DonePayload>(
        'sftp-upload-done',
        (event) => {
          if (event.payload.uploadId !== uploadId) return;
          setUploadState({
            status: 'done',
            fileName,
            written: 0,
            total: 0,
            statusText: `${fileName} 上传完成`,
          });
          clearTimer();
          timeoutRef.current = setTimeout(() => setUploadState(null), 3000);
          cleanup();
        },
      );

      unlistenRef.current = () => {
        unlistenProgress();
        unlistenDone();
      };

      try {
        setUploadState({
          status: 'uploading',
          fileName,
          written: 0,
          total: 0,
          statusText: `正在上传 ${fileName} ...`,
        });

        await sftpUploadStream(sessionId, targetPath, localPath, uploadId);
      } catch (err) {
        setUploadState({
          status: 'error',
          fileName,
          written: 0,
          total: 0,
          statusText: `上传失败：${getErrorMessage(err)}`,
        });
        clearTimer();
        timeoutRef.current = setTimeout(() => setUploadState(null), 4000);
        cleanup();
      }
    },
    [sessionId, cleanup, clearTimer],
  );

  const uploadFolder = useCallback(async () => {
    try {
      const folderPath = await open({
        directory: true,
        title: '选择文件夹',
      });
      if (!folderPath) return;

      const path = Array.isArray(folderPath) ? folderPath[0] : folderPath;
      const folderName = path.split(/[/\\]/).pop() || 'upload';

      const uploadId = `${Date.now()}`;

      const unlistenProgress = await listen<ProgressPayload>(
        'sftp-upload-progress',
        (event) => {
          if (event.payload.uploadId !== uploadId) return;
          setFolderStatus(
            formatFolderUploadStatus({
              uploadId,
              phase: 'uploading',
              written: event.payload.written,
              total: event.payload.total,
            }),
          );
        },
      );

      const unlistenStatus = await listen<FolderStatusPayload>(
        'sftp-folder-upload-status',
        (event) => {
          if (event.payload.uploadId !== uploadId) return;
          setFolderStatus(formatFolderUploadStatus(event.payload));
        },
      );

      const unlistenDone = await listen<DonePayload>(
        'sftp-upload-done',
        (event) => {
          if (event.payload.uploadId !== uploadId) return;
          setFolderStatus(null);
        },
      );

      try {
        setFolderStatus(formatFolderUploadStatus({ uploadId, phase: 'checking', percent: 0 }));
        const targetPath = remotePath === '/' ? `/${folderName}` : `${remotePath}/${folderName}`;
        await sftpUploadFolderStream(sessionId, path, targetPath, uploadId);
      } finally {
        setFolderStatus(null);
        unlistenProgress();
        unlistenStatus();
        unlistenDone();
      }
    } catch (e) {
      setFolderStatus(null);
      throw e;
    }
  }, [sessionId, remotePath]);

  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return { uploadFile, uploadFolder, uploadState, folderStatus };
}
