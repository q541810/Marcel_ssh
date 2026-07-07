import { formatSize } from '@/lib/sftp-helpers';

export type FolderUploadPhase = 'checking' | 'zipping' | 'uploading' | 'extracting';

export interface FolderStatusPayload {
  uploadId: string;
  phase: FolderUploadPhase;
  written?: number;
  total?: number;
  percent?: number;
}

const PHASE_LABELS: Record<FolderUploadPhase, string> = {
  checking: '正在检查远端解压工具',
  zipping: '正在压缩文件夹',
  uploading: '正在上传压缩包',
  extracting: '正在远端解压，暂不可取消',
};

export function formatFolderUploadStatus(payload: FolderStatusPayload): string {
  const label = PHASE_LABELS[payload.phase] ?? payload.phase;
  const percent = typeof payload.percent === 'number' ? ` ${payload.percent}%` : '';

  if (
    payload.phase === 'uploading' &&
    typeof payload.written === 'number' &&
    typeof payload.total === 'number' &&
    payload.total > 0
  ) {
    return `${label} ${formatSize(payload.written)} / ${formatSize(payload.total)}${percent}`;
  }

  return `${label}${percent}`;
}
