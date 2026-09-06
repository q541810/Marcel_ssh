import { BINARY_EXTENSIONS } from '@/lib/constants';
import { getFileExtension, isPreviewableImage } from '@/lib/sftp-helpers';
import type { Session, SftpFileEntry } from '@/lib/types';
import type { StoredTransferItem } from '@/stores/transferStore';

export type FilesEmptyStateReason =
  | 'no-session'
  | 'connecting'
  | 'disconnected'
  | 'error'
  | 'ready';

export function sortFileEntries(
  entries: SftpFileEntry[],
  showHidden = true,
): SftpFileEntry[] {
  const result = showHidden
    ? [...entries]
    : entries.filter((e) => !e.name.startsWith('.'));
  result.sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, {
      sensitivity: 'base',
      numeric: true,
    });
  });
  return result;
}

export function joinRemotePath(parent: string, name: string): string {
  const base = parent.replace(/\/+$/, '') || '';
  if (!base || base === '') return `/${name}`;
  return `${base}/${name}`;
}

export function parentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  if (!normalized || normalized === '') return '/';
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return '/';
  return normalized.slice(0, idx);
}

export function filesEmptyStateReason(
  session: Session | null | undefined,
): FilesEmptyStateReason {
  if (!session) return 'no-session';
  switch (session.status) {
    case 'connecting':
      return 'connecting';
    case 'disconnected':
      return 'disconnected';
    case 'error':
      return 'error';
    case 'connected':
      return 'ready';
    default:
      return 'no-session';
  }
}

export function resolveFilesSessionIds(
  session: Session | null | undefined,
): { sessionId: string; connectionKey: string | null } | null {
  if (!session?.id || session.status !== 'connected') return null;
  return {
    sessionId: session.id,
    connectionKey: session.configId ?? null,
  };
}

export function resolveRememberedPath(
  connectionKey: string | null,
  fileManagerPaths: Record<string, string> | undefined,
  fallback = '/',
): string {
  if (!connectionKey) return fallback;
  const stored = fileManagerPaths?.[connectionKey];
  if (typeof stored !== 'string' || !stored.trim()) return fallback;
  return stored;
}

/** Only persist cwd after settings loaded and restore finished — avoid wiping memory with "/". */
export function shouldPersistFileManagerPath(opts: {
  settingsLoaded: boolean;
  pathReady: boolean;
  connectionKey: string | null;
}): boolean {
  return opts.settingsLoaded && opts.pathReady && !!opts.connectionKey;
}

export function buildFileManagerPathsPatch(
  existing: Record<string, string> | undefined,
  connectionKey: string,
  currentPath: string,
): Record<string, string> {
  return {
    ...(existing ?? {}),
    [connectionKey]: currentPath,
  };
}

export function transferProgressPercent(
  written: number,
  total: number,
): number {
  if (total <= 0) return 0;
  const pct = Math.round((written * 100) / total);
  if (pct < 0) return 0;
  if (pct > 100) return 100;
  return pct;
}

/** Loading UX for file list: empty spinner vs keep-list overlay. */
export type FilesListLoadingMode = 'none' | 'empty' | 'overlay';

export function filesListLoadingMode(
  loading: boolean,
  entryCount: number,
): FilesListLoadingMode {
  if (!loading) return 'none';
  return entryCount === 0 ? 'empty' : 'overlay';
}

export type OpenFileKind = 'image' | 'text' | 'binary';

/**
 * Image open/preview by extension (mirrors desktop isPreviewableImage / IMAGE_EXTENSIONS).
 * Kept as mobile pure helper so UI + tests do not import desktop panel.
 */
export function isImageFileName(name: string): boolean {
  return isPreviewableImage(name);
}

/**
 * Heuristic: not a known binary extension → probably text/code (including no-extension).
 * Images are not text even though desktop BINARY_EXTENSIONS also lists them.
 */
export function isProbablyTextFileName(name: string): boolean {
  if (isImageFileName(name)) return false;
  const ext = getFileExtension(name);
  if (!ext) return true;
  return !BINARY_EXTENSIONS.has(ext);
}

/** How mobile should open a file on primary action. */
export function openFileKind(name: string): OpenFileKind {
  if (isImageFileName(name)) return 'image';
  if (isProbablyTextFileName(name)) return 'text';
  return 'binary';
}

// ──────────── 多选 / 批量删除 ────────────

/** Toggle a name in a selection set (immutable, for select mode checkboxes). */
export function toggleSelectionName(
  selected: ReadonlySet<string>,
  name: string,
): Set<string> {
  const next = new Set(selected);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

/**
 * Quick delete (rm via shell) entry semantics, mirrors desktop delete confirm:
 * offered when targets contain at least one directory (desktop: single dir;
 * mobile extends to batches that include directories).
 */
export function canQuickDelete(targets: readonly SftpFileEntry[]): boolean {
  return targets.some((t) => t.is_dir);
}

/** Progress text for batch delete feedback bar. */
export function batchDeleteProgressText(
  current: number,
  total: number,
  quick: boolean,
): string {
  return `${quick ? '正在快速删除' : '正在删除'} ${current}/${total}…`;
}

// ──────────── 传输失败提示（移动端无传输中心，失败终态需就地可见） ────────────

export interface TransferFailureInfo {
  id: string;
  fileName: string;
  statusText: string;
}

/**
 * 取当前 session 最近一次失败的传输任务（按 order 逆序扫描）。
 * sysopen 任务（id 以 sysopen- 开头）由后端状态事件驱动、自带卡片语义，
 * 不在这里提示。返回 null 表示当前没有失败任务。
 */
export function latestTransferFailure(
  items: Record<string, StoredTransferItem>,
  order: string[],
  sessionId: string,
): TransferFailureInfo | null {
  for (let i = order.length - 1; i >= 0; i--) {
    const item = items[order[i]];
    if (!item || item.sessionId !== sessionId) continue;
    if (item.id.startsWith('sysopen-')) continue;
    if (item.status !== 'error') continue;
    return {
      id: item.id,
      fileName: item.fileName,
      statusText: item.statusText,
    };
  }
  return null;
}

// ──────────── 压缩（mirrors desktop CompressModal.defaultTargetPath） ────────────

export type ArchiveFormat = 'tar.gz' | 'zip';

/** 从 remoteDir 推导默认压缩目标路径：父目录/basename.{ext}，避免递归包含。 */
export function defaultArchiveTargetPath(
  remoteDir: string,
  format: ArchiveFormat,
): string {
  const trimmed = remoteDir.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  const basename = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  const parent = lastSlash >= 0 ? trimmed.slice(0, lastSlash) : '/';
  const joinedParent = parent === '' ? '/' : parent;
  return joinedParent === '/'
    ? `/${basename}.${format}`
    : `${joinedParent}/${basename}.${format}`;
}
