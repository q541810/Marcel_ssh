import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { formatSize } from '@/lib/sftp-helpers';
import {
  formatFolderUploadStatus,
  type FolderStatusPayload,
} from '@/hooks/sftpUploadStatus';
import { useTransferStore } from './transferStore';
import { initTransferScheduler } from './transferScheduler';

// ---------------------------------------------------------------------------
// Listener handles (module-level, persist across component unmounts)
// ---------------------------------------------------------------------------

let progressUnlisten: UnlistenFn | null = null;
let doneUnlisten: UnlistenFn | null = null;
let folderStatusUnlisten: UnlistenFn | null = null;
let downloadProgressUnlisten: UnlistenFn | null = null;
let downloadDoneUnlisten: UnlistenFn | null = null;

let attached = false;

interface ProgressPayload {
  uploadId: string;
  written: number;
  total: number;
}

interface DonePayload {
  uploadId: string;
}

interface DownloadProgressPayload {
  downloadId: string;
  written: number;
  total: number;
}

interface DownloadDonePayload {
  downloadId: string;
}

function progressText(action: '上传' | '下载', written: number, total: number): string {
  const pct = total > 0 ? Math.round((written * 100) / total) : 0;
  return `${action} ${formatSize(written)} / ${formatSize(total)} (${pct}%)`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Attach module-level listeners for SFTP upload/download progress events.
 *  Idempotent: subsequent calls are no-ops. */
export async function attachTransferListeners() {
  if (attached) return;
  attached = true;

  initTransferScheduler();

  progressUnlisten = await listen<ProgressPayload>(
    'sftp-upload-progress',
    (event) => {
      const { uploadId, written, total } = event.payload;
      const state = useTransferStore.getState();
      const item = state.items[uploadId];
      if (!item || (item.status !== 'active' && item.status !== 'cancelling')) return;

      if (item.kind === 'upload') {
        state.updateItem(uploadId, {
          written,
          total,
          statusText: progressText('上传', written, total),
        });
      } else if (item.kind === 'folder-upload') {
        state.updateItem(uploadId, {
          written,
          total,
          statusText: formatFolderUploadStatus({
            uploadId,
            phase: 'uploading',
            written,
            total,
          }),
        });
      }
    },
  );

  doneUnlisten = await listen<DonePayload>(
    'sftp-upload-done',
    (event) => {
      const { uploadId } = event.payload;
      const state = useTransferStore.getState();
      const item = state.items[uploadId];
      // folder-upload 以命令 resolve 为完成信号（done 事件只代表压缩包上传完毕）
      if (!item || item.kind !== 'upload' || item.status !== 'active') return;
      state.updateItem(uploadId, {
        status: 'done',
        written: item.total,
        statusText: `${item.fileName} 上传完成`,
        finishedAt: Date.now(),
      });
    },
  );

  folderStatusUnlisten = await listen<FolderStatusPayload>(
    'sftp-folder-upload-status',
    (event) => {
      const { uploadId, phase } = event.payload;
      const state = useTransferStore.getState();
      const item = state.items[uploadId];
      if (!item || item.kind !== 'folder-upload') return;
      if (item.status !== 'active' && item.status !== 'cancelling') return;
      state.updateItem(uploadId, {
        phase,
        statusText: formatFolderUploadStatus(event.payload),
      });
    },
  );

  downloadProgressUnlisten = await listen<DownloadProgressPayload>(
    'sftp-download-progress',
    (event) => {
      const { downloadId, written, total } = event.payload;
      const state = useTransferStore.getState();
      const item = state.items[downloadId];
      if (!item || item.kind !== 'download') return;
      if (item.status !== 'active' && item.status !== 'cancelling') return;
      state.updateItem(downloadId, {
        written,
        total,
        statusText: progressText('下载', written, total),
      });
    },
  );

  downloadDoneUnlisten = await listen<DownloadDonePayload>(
    'sftp-download-done',
    (event) => {
      const { downloadId } = event.payload;
      const state = useTransferStore.getState();
      const item = state.items[downloadId];
      if (!item || item.kind !== 'download' || item.status !== 'active') return;
      state.updateItem(downloadId, {
        status: 'done',
        written: item.total,
        statusText: `${item.fileName} 下载完成`,
        finishedAt: Date.now(),
      });
    },
  );
}

/** Detach all module-level listeners. Call only on app teardown. */
export function detachTransferListeners() {
  progressUnlisten?.();
  doneUnlisten?.();
  folderStatusUnlisten?.();
  downloadProgressUnlisten?.();
  downloadDoneUnlisten?.();
  progressUnlisten = null;
  doneUnlisten = null;
  folderStatusUnlisten = null;
  downloadProgressUnlisten = null;
  downloadDoneUnlisten = null;
  attached = false;
}
