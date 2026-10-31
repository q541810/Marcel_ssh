/** Pure helpers / types for the desktop file-manager directory tree. */

import { compareFileNames } from '@/lib/sftpFileOpen';

export const FILE_TREE_MIN_WIDTH = 140;
export const FILE_TREE_MAX_WIDTH = 360;
export const FILE_TREE_DEFAULT_WIDTH = 200;
/** Panel width below this hides the tree (panel self-width, not window). */
export const FILE_TREE_SHOW_THRESHOLD = 680;
export const FILE_TREE_ANIM_MS = 220;
/** Hard depth cap for symlink / deep nests (cycle safety without realpath). */
export const FILE_TREE_MAX_DEPTH = 32;

export type TreeNodeStatus = 'idle' | 'loading' | 'loaded' | 'error';

export interface TreeDirChild {
  name: string;
  path: string;
  isSymlink: boolean;
}

export interface TreeCacheEntry {
  status: TreeNodeStatus;
  dirs: TreeDirChild[];
  error?: string;
}

export type TreeCache = Record<string, TreeCacheEntry>;

export function normalizeRemotePath(path: string): string {
  if (!path || path === '/') return '/';
  const parts = path.split('/').filter(Boolean);
  return `/${parts.join('/')}`;
}

export function joinRemotePath(parent: string, name: string): string {
  const base = normalizeRemotePath(parent);
  if (base === '/') return `/${name}`;
  return `${base}/${name}`;
}

/** Ancestors including self: `/home/user` → `['/', '/home', '/home/user']`. */
export function ancestorPaths(path: string): string[] {
  const normalized = normalizeRemotePath(path);
  if (normalized === '/') return ['/'];
  const parts = normalized.split('/').filter(Boolean);
  const result: string[] = ['/'];
  for (let i = 0; i < parts.length; i++) {
    result.push(`/${parts.slice(0, i + 1).join('/')}`);
  }
  return result;
}

export function pathDepth(path: string): number {
  const normalized = normalizeRemotePath(path);
  if (normalized === '/') return 0;
  return normalized.split('/').filter(Boolean).length;
}

export function canExpandPath(path: string): boolean {
  return pathDepth(path) < FILE_TREE_MAX_DEPTH;
}

export function clampTreeWidth(width: number): number {
  return Math.min(FILE_TREE_MAX_WIDTH, Math.max(FILE_TREE_MIN_WIDTH, Math.round(width)));
}

export function sortDirChildren(dirs: TreeDirChild[]): TreeDirChild[] {
  return [...dirs].sort((a, b) => compareFileNames(a.name, b.name));
}

export function filterDirEntries(
  entries: { name: string; is_dir: boolean; is_symlink: boolean }[],
  parentPath: string,
  showHidden: boolean,
): TreeDirChild[] {
  const dirs: TreeDirChild[] = [];
  for (const e of entries) {
    if (!e.is_dir) continue;
    if (e.name === '.' || e.name === '..') continue;
    if (!showHidden && e.name.startsWith('.')) continue;
    dirs.push({
      name: e.name,
      path: joinRemotePath(parentPath, e.name),
      isSymlink: e.is_symlink,
    });
  }
  return sortDirChildren(dirs);
}

/** Paths that should be dropped from cache when `path` changes (self + descendants). */
export function cacheKeysUnder(cache: TreeCache, path: string): string[] {
  const normalized = normalizeRemotePath(path);
  if (normalized === '/') return Object.keys(cache);
  const prefix = `${normalized}/`;
  return Object.keys(cache).filter((k) => {
    const n = normalizeRemotePath(k);
    return n === normalized || n.startsWith(prefix);
  });
}

/** True when expand/navigate must not hit the network. */
export function isCacheFresh(entry: TreeCacheEntry | undefined): boolean {
  return entry != null && (entry.status === 'loaded' || entry.status === 'loading');
}

/**
 * Seed a path from an already-fetched listing (e.g. right-side file list).
 * Marks the node loaded so tree expand needs no extra listDir.
 */
export function seedCacheFromListing(
  cache: TreeCache,
  path: string,
  entries: { name: string; is_dir: boolean; is_symlink: boolean }[],
  showHidden: boolean,
): TreeCache {
  const normalized = normalizeRemotePath(path);
  const dirs = filterDirEntries(entries, normalized, showHidden);
  return {
    ...cache,
    [normalized]: { status: 'loaded', dirs },
  };
}

/**
 * 某个祖先目录列不出来（共享主机的 `/` 没有读权限）时，目录树里它下面的链条会断：
 * 缓存里没有它的子目录，树就没法往下走到用户正在看的目录。这里按「当前目录」补出
 * 这条链上的下一级——它至少是存在的，因为用户此刻就在它下面。
 * `failedPath` 不是 `currentPath` 的真祖先（或就是它自己）时返回 null。
 */
export function chainChildToward(failedPath: string, currentPath: string): TreeDirChild | null {
  const from = normalizeRemotePath(failedPath);
  const to = normalizeRemotePath(currentPath);
  if (from === to) return null;
  const prefix = from === '/' ? '/' : `${from}/`;
  if (!to.startsWith(prefix)) return null;
  const name = to.slice(prefix.length).split('/')[0];
  if (!name) return null;
  return { name, path: joinRemotePath(from, name), isSymlink: false };
}

/** Drop self + descendants; leave siblings intact. */
export function invalidateCacheAt(cache: TreeCache, path: string): TreeCache {
  const keys = cacheKeysUnder(cache, path);
  if (keys.length === 0) return cache;
  const next = { ...cache };
  for (const k of keys) delete next[k];
  return next;
}

/** Whether a tree walk should still render children (SWR: keep stale dirs while reloading). */
export function canWalkChildren(entry: TreeCacheEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.dirs.length > 0) return true;
  return entry.status === 'loaded';
}

/** 目录树里一行的扁平描述（渲染与键盘导航共用）。 */
export interface FlatRow {
  /** 行的唯一 key：主目录快捷项与树里同路径的节点不能撞 key。 */
  key: string;
  path: string;
  name: string;
  depth: number;
  isSymlink: boolean;
  isRoot: boolean;
  /** 置顶的「主目录」快捷项：只导航，不展开。 */
  shortcut?: boolean;
}

/**
 * 把缓存 + 展开集展开成可见行。`homePath` 给出时在最上面放一条主目录快捷项
 * （主目录就是根目录时不放，免得重复）。
 */
export function buildVisibleRows(
  cache: TreeCache,
  expanded: Set<string>,
  homePath?: string | null,
): FlatRow[] {
  const rows: FlatRow[] = [];
  const home = homePath ? normalizeRemotePath(homePath) : null;
  if (home && home !== '/') {
    rows.push({
      key: `home:${home}`,
      path: home,
      name: '主目录',
      depth: 0,
      isSymlink: false,
      isRoot: false,
      shortcut: true,
    });
  }
  rows.push({ key: '/', path: '/', name: '/', depth: 0, isSymlink: false, isRoot: true });

  const walk = (parentPath: string, depth: number) => {
    if (!expanded.has(parentPath)) return;
    const entry = cache[parentPath];
    if (!canWalkChildren(entry)) return;
    for (const child of entry!.dirs) {
      rows.push({
        key: child.path,
        path: child.path,
        name: child.name,
        depth: depth + 1,
        isSymlink: child.isSymlink,
        isRoot: false,
      });
      walk(child.path, depth + 1);
    }
  };

  walk('/', 0);
  return rows;
}

export type TreeNavKey = 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

export interface TreeNavResult {
  /** 焦点应移到的行下标（不动则等于当前）。 */
  index: number;
  /** 需要切换展开状态的路径。 */
  toggle?: string;
}

/**
 * 目录树方向键语义（WAI-ARIA tree）：
 * 右：未展开 → 展开；已展开 → 到第一个子节点。左：已展开 → 收起；否则到父节点。
 * 快捷项（主目录）不参与展开/父子关系。
 */
export function navigateTreeKey(
  rows: FlatRow[],
  index: number,
  key: TreeNavKey,
  expanded: Set<string>,
  isExpandable: (row: FlatRow) => boolean,
  hasChildren: (row: FlatRow) => boolean,
): TreeNavResult {
  const row = rows[index];
  if (!row) return { index: Math.max(0, Math.min(index, rows.length - 1)) };
  switch (key) {
    case 'ArrowDown':
      return { index: Math.min(rows.length - 1, index + 1) };
    case 'ArrowUp':
      return { index: Math.max(0, index - 1) };
    case 'Home':
      return { index: 0 };
    case 'End':
      return { index: rows.length - 1 };
    case 'ArrowRight': {
      if (row.shortcut || !isExpandable(row) || !hasChildren(row)) return { index };
      if (!expanded.has(row.path)) return { index, toggle: row.path };
      const next = rows[index + 1];
      return next && next.depth === row.depth + 1 && !next.shortcut ? { index: index + 1 } : { index };
    }
    case 'ArrowLeft': {
      if (row.shortcut) return { index };
      if (expanded.has(row.path) && hasChildren(row) && !row.isRoot) return { index, toggle: row.path };
      if (row.isRoot) return expanded.has(row.path) ? { index, toggle: row.path } : { index };
      for (let i = index - 1; i >= 0; i--) {
        if (!rows[i].shortcut && rows[i].depth === row.depth - 1) return { index: i };
      }
      return { index };
    }
  }
}
