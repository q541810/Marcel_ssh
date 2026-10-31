import { useCallback } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { enqueueTransfer, createTransferId } from '@/stores/transferScheduler';
import { useSettingsStore } from '@/stores/settingsStore';
import { withForegroundKeepAlive } from '@/mobile/mobileBridge';

export type FolderUploadMode = 'folder' | 'flat';

export interface PickedFolder {
  localPath: string;
  folderName: string;
}

export function useSftpUpload(sessionId: string, remotePath: string) {
  const keepAliveEnabled = useSettingsStore(
    (s) => s.settings.mobileBackgroundSettings.keepAliveEnabled,
  );
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
    const folderPath = await withForegroundKeepAlive(keepAliveEnabled, () =>
      open({
        directory: true,
        title: '选择文件夹',
      }),
    );
    if (!folderPath) return null;

    const path = Array.isArray(folderPath) ? folderPath[0] : folderPath;
    const folderName = path.split(/[/\\]/).pop() || 'upload';
    return { localPath: path, folderName };
  }, [keepAliveEnabled]);

  const uploadFolder = useCallback(
    (
      localPath: string,
      folderName: string,
      mode: FolderUploadMode,
      onFinished?: () => void,
      /** 目标目录；缺省 = hook 创建时的 remotePath（目录树上传到别的目录时传入）。 */
      destDir: string = remotePath,
    ) => {
      const flat = mode === 'flat';
      const targetPath = flat
        ? destDir
        : destDir === '/'
          ? `/${folderName}`
          : `${destDir}/${folderName}`;

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
