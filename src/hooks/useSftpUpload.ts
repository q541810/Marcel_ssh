import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { sftpUploadFolderStream, sftpUploadStream } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/sftp-helpers';
import { formatFolderUploadStatus, type FolderUploadPhase } from './sftpUploadStatus';
import { useTransferStore, type UploadState } from '@/stores/transferStore';

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

  const uploadFolder = useCallback(async () => {
    const { setFolderUpload, setActiveFolderUploadId } = useTransferStore.getState();
    try {
      const folderPath = await open({
        directory: true,
        title: '选择文件夹',
      });
      if (!folderPath) return;

      const path = Array.isArray(folderPath) ? folderPath[0] : folderPath;
      const folderName = path.split(/[/\\]/).pop() || 'upload';
      const uploadId = `${Date.now()}`;

      setActiveFolderUploadId(uploadId);
      setFolderUpload(
        formatFolderUploadStatus({ uploadId, phase: 'checking' as FolderUploadPhase, percent: 0 }),
      );

      const targetPath = remotePath === '/' ? `/${folderName}` : `${remotePath}/${folderName}`;
      try {
        await sftpUploadFolderStream(sessionId, path, targetPath, uploadId);
      } finally {
        setFolderUpload(null);
        setActiveFolderUploadId(null);
      }
    } catch (e) {
      setFolderUpload(null);
      setActiveFolderUploadId(null);
      throw e;
    }
  }, [sessionId, remotePath]);

  return { uploadFile, uploadFolder, uploadState, folderStatus };
}

export type { UploadState };
