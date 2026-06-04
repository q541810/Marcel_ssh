import { useState, useCallback, useRef, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { readDir } from '@tauri-apps/plugin-fs';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { zip } from 'fflate';
import { sftpUploadFolder, sftpUploadStream } from '@/lib/tauri';
import { formatSize, getErrorMessage } from '@/lib/sftp-helpers';

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

async function collectFiles(dirPath: string, basePath: string): Promise<{ name: string; data: Uint8Array }[]> {
  const items: { name: string; data: Uint8Array }[] = [];
  const dirEntries = await readDir(dirPath);
  for (const entry of dirEntries) {
    const fullPath = `${dirPath}/${entry.name}`;
    const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      const subItems = await collectFiles(fullPath, relativePath);
      items.push(...subItems);
    } else if (entry.isFile) {
      const { readFile: readFileData } = await import('@tauri-apps/plugin-fs');
      const data = await readFileData(fullPath);
      items.push({ name: relativePath, data });
    }
  }
  return items;
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

      setFolderStatus('正在读取文件...');
      const files = await collectFiles(path, '');
      if (files.length === 0) {
        setFolderStatus(null);
        return;
      }

      setFolderStatus(`正在压缩 ${files.length} 个文件...`);
      const fileMap: Record<string, Uint8Array> = {};
      for (const f of files) {
        fileMap[f.name] = f.data;
      }
      const zipped = await new Promise<Uint8Array>((resolve, reject) => {
        zip(fileMap, { level: 6 }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });

      const MAX_SIZE = 32 * 1024 * 1024;
      if (zipped.length > MAX_SIZE) {
        setFolderStatus(null);
        throw new Error(`压缩包过大 (${formatSize(zipped.length)})，最大支持 32MB`);
      }

      setFolderStatus(`正在上传 ${formatSize(zipped.length)}...`);
      const targetPath = remotePath === '/' ? `/${folderName}` : `${remotePath}/${folderName}`;
      await sftpUploadFolder(sessionId, targetPath, Array.from(zipped));
      setFolderStatus(null);
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