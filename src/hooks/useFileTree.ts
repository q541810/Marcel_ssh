import { useCallback, useEffect, useRef, useState } from 'react';
import { sftpListDir } from '@/lib/tauri';
import { getErrorMessage } from '@/lib/sftp-helpers';
import {
  ancestorPaths,
  canExpandPath,
  filterDirEntries,
  invalidateCacheAt,
  isCacheFresh,
  normalizeRemotePath,
  seedCacheFromListing,
  type TreeCache,
  type TreeCacheEntry,
} from '@/components/sftp/fileTreeModel';

interface UseFileTreeOptions {
  sessionId: string;
  showHidden: boolean;
  currentPath: string;
}

export function useFileTree({ sessionId, showHidden, currentPath }: UseFileTreeOptions) {
  const [cache, setCache] = useState<TreeCache>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/']));
  const loadSeqRef = useRef<Record<string, number>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const showHiddenRef = useRef(showHidden);
  showHiddenRef.current = showHidden;
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const loadNode = useCallback(async (rawPath: string, force = false) => {
    const path = normalizeRemotePath(rawPath);
    if (!canExpandPath(path) && path !== '/') return;

    const existing = cacheRef.current[path];
    if (!force && isCacheFresh(existing)) {
      return;
    }

    const seq = (loadSeqRef.current[path] ?? 0) + 1;
    loadSeqRef.current[path] = seq;

    // SWR: keep previous dirs while reloading so the tree does not flash empty.
    setCache((prev) => ({
      ...prev,
      [path]: {
        status: 'loading',
        dirs: prev[path]?.dirs ?? [],
        error: undefined,
      },
    }));

    try {
      const items = await sftpListDir(sessionIdRef.current, path);
      if (loadSeqRef.current[path] !== seq) return;
      const dirs = filterDirEntries(items, path, showHiddenRef.current);
      const entry: TreeCacheEntry = { status: 'loaded', dirs };
      setCache((prev) => ({ ...prev, [path]: entry }));
    } catch (err) {
      if (loadSeqRef.current[path] !== seq) return;
      setCache((prev) => ({
        ...prev,
        [path]: {
          status: 'error',
          dirs: prev[path]?.dirs ?? [],
          error: getErrorMessage(err),
        },
      }));
    }
  }, []);

  /** Right-side list success → tree cache, 0 network on later expand. */
  const seedFromListing = useCallback(
    (rawPath: string, entries: { name: string; is_dir: boolean; is_symlink: boolean }[]) => {
      const path = normalizeRemotePath(rawPath);
      // Cancel any in-flight list for this path so stale responses cannot overwrite seed.
      loadSeqRef.current[path] = (loadSeqRef.current[path] ?? 0) + 1;
      setCache((prev) => seedCacheFromListing(prev, path, entries, showHiddenRef.current));
    },
    [],
  );

  const toggleExpand = useCallback(
    (rawPath: string) => {
      const path = normalizeRemotePath(rawPath);
      if (!canExpandPath(path) && path !== '/') return;

      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
          void loadNode(path);
        }
        return next;
      });
    },
    [loadNode],
  );

  const expandPath = useCallback(
    (rawPath: string) => {
      const path = normalizeRemotePath(rawPath);
      if (!canExpandPath(path) && path !== '/') return;
      setExpanded((prev) => {
        if (prev.has(path)) return prev;
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      void loadNode(path);
    },
    [loadNode],
  );

  const invalidate = useCallback((rawPath?: string) => {
    if (rawPath == null) {
      setCache({});
      return;
    }
    const path = normalizeRemotePath(rawPath);
    setCache((prev) => invalidateCacheAt(prev, path));
  }, []);

  /** Reload a single path (SWR). Used after mutations / toolbar refresh. */
  const reloadNode = useCallback(
    (rawPath: string) => {
      void loadNode(rawPath, true);
    },
    [loadNode],
  );

  /** Global force-refresh of every expanded node — only for session/filter reset. */
  const refreshExpanded = useCallback(() => {
    setExpanded((prev) => {
      for (const p of prev) {
        void loadNode(p, true);
      }
      return prev;
    });
  }, [loadNode]);

  // Session / hidden-filter change: drop cache and reload expanded.
  useEffect(() => {
    setCache({});
    loadSeqRef.current = {};
    setExpanded((prev) => {
      for (const p of prev) {
        void loadNode(p, true);
      }
      return prev;
    });
  }, [sessionId, showHidden, loadNode]);

  // Right-side path change → expand ancestor chain; load only missing nodes.
  useEffect(() => {
    const chain = ancestorPaths(currentPath);
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const p of chain) {
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
    for (const p of chain) {
      void loadNode(p);
    }
  }, [currentPath, loadNode]);

  return {
    cache,
    expanded,
    selectedPath: normalizeRemotePath(currentPath),
    toggleExpand,
    expandPath,
    loadNode,
    seedFromListing,
    invalidate,
    reloadNode,
    refreshExpanded,
  };
}
