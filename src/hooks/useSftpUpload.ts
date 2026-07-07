import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { sftpUploadFolderStream, sftpUploadStream, sftpCancelUpload } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/sftp-helpers';
import { formatFolderUploadStatus, type FolderUploadPhase } from './sftpUploadStatus';
import { useTransferStore, type UploadState } from '@/stores/transferStore';

export type FolderUploadMode = 'folder' | 'flat';

export interface PickedFolder {
  localPath: string;
  folderName: string;
}

const CANCELLED_MSG = '上传已取消';

function createTransferId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function useSftpUpload(sessionId: string, remotePath: string) {
  const uploadState = useTransferStore((s) => s.upload);
  const folderStatus = useTransferStore((s) => s.folderUpload);

  const uploadFile = useCallback(
    async (localPath: string, fileName: string, targetPath: string) => {
      const { setUpload, setActiveUploadId, clearUploadAfter } = useTransferStore.getState();
      const uploadId = createTransferId();

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
        const state = useTransferStore.getState();
        if (state.activeUploadId === uploadId && state.upload?.status !== 'uploading') {
          setActiveUploadId(null);
        }
      } catch (err) {
        const msg = getErrorMessage(err);
        if (msg === CANCELLED_MSG) {
          setUpload({
            status: 'cancelled',
            fileName,
            written: 0,
            total: 0,
            statusText: `${fileName} 上传已取消`,
          });
        } else {
          setUpload({
            status: 'error',
            fileName,
            written: 0,
            total: 0,
            statusText: `上传失败：${msg}`,
          });
        }
        setActiveUploadId(null);
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
      const uploadId = createTransferId();
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
      } catch (err) {
        const msg = getErrorMessage(err);
        if (msg === CANCELLED_MSG) {
          setFolderUpload('上传已取消');
          setTimeout(() => {
            setFolderUpload(null);
            setActiveFolderUploadId(null);
          }, 3000);
          return;
        }
        throw err;
      } finally {
        const state = useTransferStore.getState();
        if (state.folderUpload !== '上传已取消') {
          setFolderUpload(null);
          setActiveFolderUploadId(null);
        }
      }
    },
    [sessionId, remotePath],
  );

  const cancelCurrentUpload = useCallback(async () => {
    const { activeUploadId, activeFolderUploadId, setUpload, upload } = useTransferStore.getState();
    const id = upload?.status === 'uploading' ? activeUploadId : activeFolderUploadId;
    if (!id) return;

    if (activeUploadId && upload) {
      setUpload({
        status: 'cancelled',
        fileName: upload.fileName,
        written: 0,
        total: 0,
        statusText: `正在取消 ${upload.fileName} ...`,
      });
    }

    try {
      await sftpCancelUpload(id);
    } catch {
      // ignore cancel errors
    }
  }, []);

  const isUploading = uploadState !== null && uploadState.status === 'uploading';
  const isFolderUploading = folderStatus !== null && !folderStatus.includes('已取消');

  return {
    uploadFile,
    pickFolder,
    uploadFolder,
    cancelCurrentUpload,
    isUploading,
    isFolderUploading,
    uploadState,
    folderStatus,
  };
}

export type { UploadState };
