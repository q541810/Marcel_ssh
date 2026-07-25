import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { enqueueTransfer, createTransferId } from '@/stores/transferScheduler';

export type FolderUploadMode = 'folder' | 'flat';

export interface PickedFolder {
  localPath: string;
  folderName: string;
}

export function useSftpUpload(sessionId: string, remotePath: string) {
  const uploadFile = useCallback(
    (localPath: string, fileName: string, targetPath: string, onFinished?: () => void) => {
      enqueueTransfer(
        {
          id: createTransferId(),
          kind: 'upload',
          sessionId,
          fileName,
          localPath,
          remotePath: targetPath,
          written: 0,
          total: 0,
          statusText: '排队中',
          createdAt: Date.now(),
        },
        onFinished,
      );
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
    (localPath: string, folderName: string, mode: FolderUploadMode, onFinished?: () => void) => {
      const flat = mode === 'flat';
      const targetPath = flat
        ? remotePath
        : remotePath === '/'
          ? `/${folderName}`
          : `${remotePath}/${folderName}`;

      enqueueTransfer(
        {
          id: createTransferId(),
          kind: 'folder-upload',
          sessionId,
          fileName: folderName,
          localPath,
          remotePath: targetPath,
          flat,
          written: 0,
          total: 0,
          statusText: '排队中',
          createdAt: Date.now(),
        },
        onFinished,
      );
    },
    [sessionId, remotePath],
  );

  return { uploadFile, pickFolder, uploadFolder };
}
