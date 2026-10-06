import { formatSize } from '@/lib/sftp-helpers';
import type { Session, SftpFileEntry } from '@/lib/types';
import type { StoredTransferItem, TransferKind } from '@/stores/transferStore';

// 列表排序 / 路径拼接 / 打开方式判定 / 压缩目标路径与桌面共用同一份实现，
// 已晋升到 @/lib/sftpFileOpen；这里 re-export 保持 mobile 内部 import 路径不破。
export {
  sortFileEntries,
  joinRemotePath,
  isImageFileName,
  isProbablyTextFileName,
  openFileKind,
  defaultArchiveTargetPath,
} from '@/lib/sftpFileOpen';
export type { OpenFileKind, ArchiveFormat } from '@/lib/sftpFileOpen';

export type FilesEmptyStateReason =
  | 'no-session'
  | 'connecting'
  | 'disconnected'
  | 'error'
  | 'ready';

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

/**
 * 条目能否被「打开」（预览 / 编辑）。
 *
 * 后端 list_dir 的 `is_file` 是 `is_regular()`，而 readdir 走 lstat 语义 ——
 * 软链接即使指向普通文件也是 `is_file=false, is_symlink=true`。列表却按
 * `!is_dir` 把它渲染成文件，只按 `is_file` 判定就会得到一个点了没反应的
 * 死按钮（桌面 handleNavigate 同样只认 is_dir / is_file，这里不再对齐它的沉默，
 * 直接按「非目录即可尝试打开」，真正的目录/超大文件由后端明确报错兜底）。
 */
export function canOpenEntry(entry: SftpFileEntry): boolean {
  return !entry.is_dir && (entry.is_file || entry.is_symlink);
}

/** 列表副标题：目录 / 软链接 / 普通文件大小。 */
export function entrySubtitle(entry: SftpFileEntry): string {
  if (entry.is_dir) return '目录';
  if (entry.is_symlink) return `符号链接 · ${formatSize(entry.size)}`;
  return formatSize(entry.size);
}

/** 列表徽标：DIR / LINK / FILE（软链接单独标出，避免被当成普通文件）。 */
export function entryBadge(entry: SftpFileEntry): 'DIR' | 'LINK' | 'FILE' {
  if (entry.is_dir) return 'DIR';
  if (entry.is_symlink) return 'LINK';
  return 'FILE';
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

/**
 * 选择模式里恰好选中一个条目时取回它（否则 null）。
 *
 * 目录在移动端「点按 = 进入」是主交互，于是它永远不会成为 selectedEntry
 * （只有非目录分支会 setSelectedEntry），单选操作条里的「压缩 / 重命名」
 * 对目录就成了死代码。长按进入的选择模式是目录唯一的单项操作入口：单选时
 * 把这两项动作暴露出来，对齐桌面对目录的右键菜单（打开/压缩为/重命名/复制路径/删除）。
 */
export function soleSelectedEntry(
  entries: readonly SftpFileEntry[],
  selected: ReadonlySet<string>,
): SftpFileEntry | null {
  if (selected.size !== 1) return null;
  return entries.find((e) => selected.has(e.name)) ?? null;
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

// ──────────── 传输成功提示（移动端无传输中心，完成态需就地可见） ────────────

/** 完成提示的显示时长（短暂可见，不打断操作）。 */
export const TRANSFER_COMPLETION_BANNER_MS = 8000;

/**
 * 只提示「刚刚完成」的任务：切走标签页/换会话回来时不补播历史完成记录。
 * 传输本身可能跑几分钟，窗口给足，但远小于「上次用应用」的间隔。
 */
export const TRANSFER_COMPLETION_FRESH_MS = 120_000;

export interface TransferCompletionInfo {
  id: string;
  kind: TransferKind;
  fileName: string;
  /** 上传=本地源路径；下载=保存路径（Android SAF 下是 content:// URI） */
  localPath: string;
  /** 上传=远端目标路径；下载=远端源路径 */
  remotePath: string;
  finishedAt: number;
}

export interface TransferCompletionNotice {
  text: string;
  /** 可复制/查看的路径（上传给远端、下载给本地） */
  path: string;
}

/**
 * 取当前会话最近一次**成功**的传输任务（按 order 逆序扫描）。
 *
 * 与 latestTransferFailure 同源：移动端没有传输中心，顶部活动条只认
 * active/cancelling，条目一到 done 就整条消失 —— 用户既不知道成没成，
 * 也拿不到「文件在哪」。sysopen 任务由后端状态事件驱动、自带语义，不在此提示。
 */
export function latestTransferCompletion(
  items: Record<string, StoredTransferItem>,
  order: readonly string[],
  sessionId: string,
): TransferCompletionInfo | null {
  if (!sessionId) return null;
  for (let i = order.length - 1; i >= 0; i--) {
    const item = items[order[i]];
    if (!item || item.sessionId !== sessionId) continue;
    if (item.id.startsWith('sysopen-')) continue;
    if (item.status !== 'done') continue;
    return {
      id: item.id,
      kind: item.kind,
      fileName: item.fileName,
      localPath: item.localPath,
      remotePath: item.remotePath,
      finishedAt: item.finishedAt ?? 0,
    };
  }
  return null;
}

/** 完成提示文案与可复制路径：下载「已保存到」、上传「已上传到」。 */
export function transferCompletionNotice(
  info: TransferCompletionInfo,
): TransferCompletionNotice {
  if (info.kind === 'download') {
    const path = info.localPath || info.fileName;
    return { text: `已保存到 ${path}`, path };
  }
  const path = info.remotePath || info.fileName;
  return { text: `已上传到 ${path}`, path };
}

// ──────────── 压缩 ────────────
// ArchiveFormat / defaultArchiveTargetPath 已晋升到 @/lib/sftpFileOpen，
// 与桌面 CompressModal 的默认目标路径推导共用同一份实现（文件顶部统一 re-export）。
