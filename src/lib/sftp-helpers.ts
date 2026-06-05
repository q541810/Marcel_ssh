export function formatSize(bytes: number): string {
  if (bytes === 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
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

import { getErrorMessage as baseGetErrorMessage } from './errors';

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
