import { getErrorMessage as baseGetErrorMessage } from './errors';
import { IMAGE_EXTENSIONS } from './constants';

export function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function getFileExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx).toLowerCase() : '';
}

/** 判断文件是否为浏览器可预览的图片格式（与后端 50MB 限制配合使用）。 */
export function isPreviewableImage(fileName: string): boolean {
  return IMAGE_EXTENSIONS.has(getFileExtension(fileName));
}

export function modeToString(mode: number): string {
  const isDir = (mode & 0o170000) === 0o040000;
  const isLink = (mode & 0o170000) === 0o120000;
  const chars = isDir ? 'd' : isLink ? 'l' : '-';
  const perms = [
    mode & 0o400 ? 'r' : '-',
    mode & 0o200 ? 'w' : '-',
    mode & 0o100 ? 'x' : '-',
    mode & 0o040 ? 'r' : '-',
    mode & 0o020 ? 'w' : '-',
    mode & 0o010 ? 'x' : '-',
    mode & 0o004 ? 'r' : '-',
    mode & 0o002 ? 'w' : '-',
    mode & 0o001 ? 'x' : '-',
  ].join('');
  return chars + perms;
}

/**
 * Android 上 dialog 插件在用户取消文件选择/保存对话框时 reject
 * （桌面是返回 null），用于把"用户取消"与真实错误区分开。
 */
export function isDialogCancelled(err: unknown): boolean {
  const msg =
    typeof err === 'string'
      ? err
      : err instanceof Error
        ? err.message
        : String(err ?? '');
  return msg.includes('File picker cancelled');
}

export function getErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const obj = err as Record<string, unknown>;
    if (typeof obj.code === 'number') {
      const sftpCodes: Record<number, string> = {
        2: '文件或目录不存在',
        3: '权限不足',
        4: '操作失败',
        5: '错误的文件句柄',
      };
      const hint = sftpCodes[obj.code];
      if (hint) {
        const msg = typeof obj.message === 'string' ? obj.message : baseGetErrorMessage(err);
        return `${msg}（${hint}）`;
      }
    }
  }
  return baseGetErrorMessage(err);
}
