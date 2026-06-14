import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { formatSize } from '@/lib/sftp-helpers';
import {
  formatFolderUploadStatus,
  type FolderStatusPayload,
  type FolderUploadPhase,
} from '@/hooks/sftpUploadStatus';
import { useTransferStore } from './transferStore';

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Attach module-level listeners for SFTP upload/download progress events.
 *  Idempotent: subsequent calls are no-ops. */
export async function attachTransferListeners() {
  if (attached) return;
  attached = true;

  progressUnlisten = await listen<ProgressPayload>(
    'sftp-upload-progress',
    (event) => {
      const { uploadId, written, total } = event.payload;
      const state = useTransferStore.getState();
      const pct = total > 0 ? Math.round((written * 100) / total) : 0;
      const fmt = `上传 ${formatSize(written)} / ${formatSize(total)} (${pct}%)`;

      if (uploadId === state.activeUploadId) {
        const current = state.upload;
        if (!current) return;
        state.setUpload({
          status: 'uploading',
          fileName: current.fileName,
          written,
          total,
          statusText: fmt,
        });
      } else if (uploadId === state.activeFolderUploadId) {
        state.setFolderUpload(
          formatFolderUploadStatus({
            uploadId,
            phase: 'uploading' as FolderUploadPhase,
            written,
            total,
          }),
        );
      }
    },
  );

  doneUnlisten = await listen<DonePayload>(
    'sftp-upload-done',
    (event) => {
      const { uploadId } = event.payload;
      const state = useTransferStore.getState();
      if (uploadId === state.activeUploadId) {
        const current = state.upload;
        if (!current) return;
        state.setUpload({
          status: 'done',
          fileName: current.fileName,
          written: 0,
          total: 0,
          statusText: `${current.fileName} 上传完成`,
        });
        state.clearUploadAfter(3000);
      } else if (uploadId === state.activeFolderUploadId) {
        state.setFolderUpload(null);
        state.setActiveFolderUploadId(null);
      }
    },
  );

  folderStatusUnlisten = await listen<FolderStatusPayload>(
    'sftp-folder-upload-status',
    (event) => {
      const { uploadId } = event.payload;
      const state = useTransferStore.getState();
      if (uploadId !== state.activeFolderUploadId) return;
      state.setFolderUpload(formatFolderUploadStatus(event.payload));
    },
  );

  downloadProgressUnlisten = await listen<DownloadProgressPayload>(
    'sftp-download-progress',
    (event) => {
      const { downloadId, written, total } = event.payload;
      const state = useTransferStore.getState();
      if (downloadId !== state.activeDownloadId) return;
      const current = state.download;
      if (!current) return;
      const pct = total > 0 ? Math.round((written * 100) / total) : 0;
      state.setDownload({
        status: 'downloading',
        fileName: current.fileName,
        written,
        total,
        statusText: `下载 ${formatSize(written)} / ${formatSize(total)} (${pct}%)`,
      });
    },
  );

  downloadDoneUnlisten = await listen<DownloadDonePayload>(
    'sftp-download-done',
    (event) => {
      const { downloadId } = event.payload;
      const state = useTransferStore.getState();
      if (downloadId !== state.activeDownloadId) return;
      const current = state.download;
      if (!current) return;
      state.setDownload({
        status: 'done',
        fileName: current.fileName,
        written: current.total,
        total: current.total,
        statusText: `${current.fileName} 下载完成`,
      });
      state.clearDownloadAfter(3000);
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
