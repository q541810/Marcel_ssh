/**
 * 文件管理器「作用在某个绝对路径上」的动作所用的纯函数与类型。
 *
 * 右侧列表与左侧目录树共用同一批动作（`useFileActions`）：动作只认绝对路径，
 * 不再依赖「当前目录 + 条目名」，这样树上任意节点（不是当前目录的子项）也能操作。
 * 只放纯函数，方便单测。
 */

import { joinRemotePath, normalizeRemotePath } from './fileTreeModel';
import type { SftpFileEntry } from '@/lib/types';

export interface FileTarget {
  /** 绝对路径（已规范化）。 */
  path: string;
  name: string;
  isDir: boolean;
  size?: number;
}

/** 目录路径的父目录：`/a/b` → `/a`，`/a` → `/`，`/` → `/`。 */
export function parentDir(path: string): string {
  const normalized = normalizeRemotePath(path);
  if (normalized === '/') return '/';
  const idx = normalized.lastIndexOf('/');
  return idx <= 0 ? '/' : normalized.slice(0, idx);
}

/** 路径最后一段（根目录返回 `/`）。 */
export function baseName(path: string): string {
  const normalized = normalizeRemotePath(path);
  if (normalized === '/') return '/';
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

/** 列表条目 → 动作目标。 */
export function targetFromEntry(parent: string, entry: SftpFileEntry): FileTarget {
  return {
    path: joinRemotePath(parent, entry.name),
    name: entry.name,
    isDir: entry.is_dir,
    size: entry.size,
  };
}

/** 目录树节点 → 动作目标（树上只有目录）。 */
export function targetFromTreePath(path: string): FileTarget {
  const normalized = normalizeRemotePath(path);
  return { path: normalized, name: baseName(normalized), isDir: true };
}

/** `a` 是不是 `b` 本身或它的子孙路径。 */
export function isSameOrUnder(a: string, b: string): boolean {
  const pa = normalizeRemotePath(a);
  const pb = normalizeRemotePath(b);
  if (pa === pb) return true;
  if (pb === '/') return true;
  return pa.startsWith(`${pb}/`);
}

/** 在终端中打开某目标：目录进它自己，文件进它所在目录。 */
export function terminalDirOf(target: Pick<FileTarget, 'path' | 'isDir'>): string {
  return target.isDir ? normalizeRemotePath(target.path) : parentDir(target.path);
}

