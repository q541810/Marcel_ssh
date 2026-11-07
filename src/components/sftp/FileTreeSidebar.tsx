import { useEffect, useMemo, useRef, useState } from 'react';
import type { TreeCache, FlatRow, TreeNavKey } from './fileTreeModel';
import {
  buildVisibleRows,
  canExpandPath,
  navigateTreeKey,
  normalizeRemotePath,
} from './fileTreeModel';
import { TREE_PATH_ATTR } from './fileTreeDrop';

interface FileTreeSidebarProps {
  cache: TreeCache;
  expanded: Set<string>;
  selectedPath: string;
  /** 远端主目录；给出且不是 `/` 时在树顶放一条「主目录」快捷项。 */
  homePath?: string | null;
  /** 右键菜单正指向的节点（菜单开着时给一个轻量高亮）。 */
  contextPath?: string | null;
  /** 本机文件拖拽时正悬停的节点（松手即上传到它）。 */
  dropHoverPath?: string | null;
  onToggleExpand: (path: string) => void;
  onNavigate: (path: string) => void;
  onRetry: (path: string) => void;
  /** 右键 / 菜单键：x、y 为菜单锚点（视口坐标）。 */
  onContextMenu?: (path: string, x: number, y: number) => void;
  /** F2。 */
  onRename?: (path: string) => void;
  /** Delete。 */
  onDelete?: (path: string) => void;
}

const INDENT_PX = 14;
const NAV_KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

export default function FileTreeSidebar({
  cache,
  expanded,
  selectedPath,
  homePath,
  contextPath,
  dropHoverPath,
  onToggleExpand,
  onNavigate,
  onRetry,
  onContextMenu,
  onRename,
  onDelete,
}: FileTreeSidebarProps) {
  const selected = normalizeRemotePath(selectedPath);
  const rows = useMemo(() => buildVisibleRows(cache, expanded, homePath), [cache, expanded, homePath]);
  const containerRef = useRef<HTMLDivElement>(null);
  // 漫游 tabindex：整棵树只有一个 tab 停靠点。键盘移动后记在这里；
  // 没动过就停在当前目录那一行。
  const [focusKey, setFocusKey] = useState<string | null>(null);

  const isExpandable = (row: FlatRow) => row.isRoot || canExpandPath(row.path);
  const rowHasChildren = (row: FlatRow) => {
    const entry = cache[row.path];
    return entry?.status === 'loaded' ? entry.dirs.length > 0 : true;
  };

  const tabStopKey = useMemo(() => {
    if (focusKey && rows.some((r) => r.key === focusKey)) return focusKey;
    const current = rows.find((r) => !r.shortcut && r.path === selected);
    return (current ?? rows[0])?.key ?? null;
  }, [focusKey, rows, selected]);

  const focusRow = (key: string) => {
    setFocusKey(key);
    const el = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [],
    ).find((node) => node.dataset.rowKey === key);
    el?.focus();
  };

  // 当前目录变化（点右侧列表、面包屑、后退……）时把对应树行滚进视野；
  // 行还没出现（祖先链异步加载中）就等它出现的那一次。
  const scrolledForRef = useRef<string | null>(null);
  const selectedRowPresent = rows.some((r) => !r.shortcut && r.path === selected);
  useEffect(() => {
    if (!selectedRowPresent) return;
    if (scrolledForRef.current === selected) return;
    scrolledForRef.current = selected;
    const el = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>('[data-row-key]') ?? [],
    ).find((node) => node.dataset.rowKey === selected);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [selected, selectedRowPresent]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>('[data-row-key]');
    if (!rowEl) return;
    const index = rows.findIndex((r) => r.key === rowEl.dataset.rowKey);
    if (index < 0) return;
    const row = rows[index];

    if (NAV_KEYS.has(e.key)) {
      e.preventDefault();
      const result = navigateTreeKey(
        rows,
        index,
        e.key as TreeNavKey,
        expanded,
        isExpandable,
        rowHasChildren,
      );
      if (result.toggle) onToggleExpand(result.toggle);
      if (result.index !== index) focusRow(rows[result.index].key);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onNavigate(row.path);
      return;
    }
    if (e.key === 'F2' && !row.isRoot && !row.shortcut) {
      e.preventDefault();
      onRename?.(row.path);
      return;
    }
    if (e.key === 'Delete' && !row.isRoot && !row.shortcut) {
      e.preventDefault();
      onDelete?.(row.path);
      return;
    }
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      const rect = rowEl.getBoundingClientRect();
      onContextMenu?.(row.path, rect.left + 24, rect.bottom);
    }
  };

  return (
    <div
      ref={containerRef}
      role="tree"
      aria-label="目录树"
      className="h-full overflow-y-auto overflow-x-hidden bg-surface/40 select-none"
      data-file-tree="true"
      onKeyDown={handleKeyDown}
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="py-0.5 min-w-0">
        {rows.map((row) => {
          const isExpanded = expanded.has(row.path);
          const entry = cache[row.path];
          const isSelected = !row.shortcut && selected === row.path;
          const expandable = !row.shortcut && (row.isRoot || canExpandPath(row.path));
          const isLoading = entry?.status === 'loading';
          const isError = entry?.status === 'error';
          // 只有「已加载且确实没有子目录」才收起箭头；没加载过先当有（点开才知道）。
          const hasChildren = rowHasChildren(row);
          const showChevron = expandable && hasChildren;
          const isContext = contextPath != null && !row.shortcut && contextPath === row.path;
          const isDropHover = dropHoverPath != null && dropHoverPath === row.path;

          return (
            <div
              key={row.key}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={isSelected}
              aria-expanded={showChevron ? isExpanded : undefined}
              data-row-key={row.key}
              {...{ [TREE_PATH_ATTR]: row.path }}
              tabIndex={tabStopKey === row.key ? 0 : -1}
              className={`group flex items-center gap-0.5 pr-2 h-7 cursor-pointer transition-colors outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-indigo-500/60 ${
                isDropHover
                  ? 'bg-indigo-500/25 text-fg ring-1 ring-inset ring-indigo-400/70'
                  : isContext
                    ? 'bg-state-mid text-fg'
                    : isSelected
                      ? 'bg-indigo-500/10 text-fg'
                      : 'text-fg-secondary hover:bg-state-soft/50 hover:text-fg'
              }`}
              style={{ paddingLeft: 6 + row.depth * INDENT_PX }}
              onClick={() => {
                setFocusKey(row.key);
                onNavigate(row.path);
              }}
              onContextMenu={(e) => {
                if (!onContextMenu) return;
                e.preventDefault();
                e.stopPropagation();
                onContextMenu(row.path, e.clientX, e.clientY);
              }}
              title={row.path}
            >
              <button
                type="button"
                className={`flex-shrink-0 w-4 h-4 flex items-center justify-center ${
                  showChevron
                    ? 'text-fg-disabled hover:text-fg-secondary'
                    : 'text-transparent pointer-events-none'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!expandable) return;
                  onToggleExpand(row.path);
                }}
                tabIndex={-1}
                aria-label={isExpanded ? '收起' : '展开'}
              >
                {isLoading && !entry?.dirs.length ? (
                  <span className="block w-1.5 h-1.5 rounded-full bg-zinc-600 animate-pulse" />
                ) : (
                  <svg
                    className="w-2.5 h-2.5 transition-transform duration-100"
                    fill="currentColor"
                    viewBox="0 0 16 16"
                    style={{ transform: isExpanded ? 'rotate(90deg)' : 'none' }}
                  >
                    <path d="M6 3.5L11 8l-5 4.5V3.5z" />
                  </svg>
                )}
              </button>

              {/* monochrome folder — low contrast, matches list density */}
              <svg
                className={`w-3.5 h-3.5 flex-shrink-0 ${
                  row.isSymlink
                    ? 'text-fg-tertiary'
                    : isSelected
                      ? 'text-fg-secondary'
                      : 'text-fg-disabled group-hover:text-fg-tertiary'
                }`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                viewBox="0 0 24 24"
                aria-hidden
              >
                {row.shortcut ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 12l9-8 9 8M5 10v9a1 1 0 001 1h3v-6h6v6h3a1 1 0 001-1v-9"
                  />
                ) : row.isSymlink ? (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                  />
                ) : (
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 7a2 2 0 012-2h3.172a2 2 0 011.414.586l1.828 1.828A2 2 0 0012.828 8H19a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"
                  />
                )}
              </svg>

              <span className="ml-1.5 min-w-0 flex-1 truncate text-body leading-none">
                {row.isRoot ? '/' : row.name}
              </span>

              {isError && (
                <button
                  type="button"
                  className="flex-shrink-0 text-caption text-fg-tertiary hover:text-red-400 px-1"
                  title={entry?.error ?? '加载失败'}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRetry(row.path);
                  }}
                >
                  重试
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
