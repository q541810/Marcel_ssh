/** Pure helpers / types for the desktop file-manager directory tree. */

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
  return [...dirs].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
  );
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
