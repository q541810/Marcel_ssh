import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { sftpUploadFolderStream, sftpUploadStream } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/sftp-helpers';
import { formatFolderUploadStatus, type FolderUploadPhase } from './sftpUploadStatus';
import { useTransferStore, type UploadState } from '@/stores/transferStore';

export type FolderUploadMode = 'folder' | 'flat';

export interface PickedFolder {
  localPath: string;
  folderName: string;
}

export function useSftpUpload(sessionId: string, remotePath: string) {
  const uploadState = useTransferStore((s) => s.upload);
  const folderStatus = useTransferStore((s) => s.folderUpload);

  const uploadFile = useCallback(
    async (localPath: string, fileName: string, targetPath: string) => {
      const { setUpload, setActiveUploadId, clearUploadAfter } = useTransferStore.getState();
      const uploadId = `${Date.now()}`;

      setActiveUploadId(uploadId);
      setUpload({
        status: 'uploading',
        fileName,
        written: 0,
        total: 0,
        statusText: `正在上传 ${fileName} ...`,
      });

      try {
        await sftpUploadStream(sessionId, targetPath, localPath, uploadId);
      } catch (err) {
        setUpload({
          status: 'error',
          fileName,
          written: 0,
          total: 0,
          statusText: `上传失败：${getErrorMessage(err)}`,
        });
        clearUploadAfter(4000);
      }
    },
    [sessionId],
  );

  const pickFolder = useCallback(async (): Promise<PickedFolder | null> => {
    const folderPath = await open({
      directory: true,
      title: '选择文件夹',
    });
    if (!folderPath) return null;

    const path = Array.isArray(folderPath) ? folderPath[0] : folderPath;
    const folderName = path.split(/[/\\]/).pop() || 'upload';
    return { localPath: path, folderName };
  }, []);

  const uploadFolder = useCallback(
    async (localPath: string, folderName: string, mode: FolderUploadMode) => {
      const { setFolderUpload, setActiveFolderUploadId } = useTransferStore.getState();
      const uploadId = `${Date.now()}`;
      const flat = mode === 'flat';
      const targetPath = flat
        ? remotePath
        : remotePath === '/'
          ? `/${folderName}`
          : `${remotePath}/${folderName}`;

      setActiveFolderUploadId(uploadId);
      setFolderUpload(
        formatFolderUploadStatus({ uploadId, phase: 'checking' as FolderUploadPhase, percent: 0 }),
      );

      try {
        await sftpUploadFolderStream(sessionId, localPath, targetPath, uploadId, flat);
      } finally {
        setFolderUpload(null);
        setActiveFolderUploadId(null);
      }
    },
    [sessionId, remotePath],
  );

  return { uploadFile, pickFolder, uploadFolder, uploadState, folderStatus };
}

export type { UploadState };
