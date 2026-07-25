import { useMemo } from 'react';
import type { TreeCache } from './fileTreeModel';
import { canExpandPath, canWalkChildren, normalizeRemotePath } from './fileTreeModel';

interface FileTreeSidebarProps {
  cache: TreeCache;
  expanded: Set<string>;
  selectedPath: string;
  onToggleExpand: (path: string) => void;
  onNavigate: (path: string) => void;
  onRetry: (path: string) => void;
}

interface FlatRow {
  path: string;
  name: string;
  depth: number;
  isSymlink: boolean;
  isRoot: boolean;
}

function buildVisibleRows(cache: TreeCache, expanded: Set<string>): FlatRow[] {
  const rows: FlatRow[] = [{ path: '/', name: '/', depth: 0, isSymlink: false, isRoot: true }];

  const walk = (parentPath: string, depth: number) => {
    if (!expanded.has(parentPath)) return;
    const entry = cache[parentPath];
    if (!canWalkChildren(entry)) return;
    for (const child of entry!.dirs) {
      rows.push({
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

const INDENT_PX = 14;

export default function FileTreeSidebar({
  cache,
  expanded,
  selectedPath,
  onToggleExpand,
  onNavigate,
  onRetry,
}: FileTreeSidebarProps) {
  const selected = normalizeRemotePath(selectedPath);
  const rows = useMemo(() => buildVisibleRows(cache, expanded), [cache, expanded]);

  return (
    <div
      className="h-full overflow-y-auto overflow-x-hidden bg-zinc-900/40 select-none"
      data-file-tree="true"
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
          const isSelected = selected === row.path;
          const expandable = row.isRoot || canExpandPath(row.path);
          const isLoading = entry?.status === 'loading';
          const isError = entry?.status === 'error';
          const hasChildren = entry?.status === 'loaded' ? entry.dirs.length > 0 : true;

          return (
            <div
              key={row.path}
              className={`group flex items-center gap-0.5 pr-2 min-h-[28px] cursor-pointer transition-colors ${
                isSelected
                  ? 'bg-indigo-500/10 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200'
              }`}
              style={{ paddingLeft: 6 + row.depth * INDENT_PX }}
              onClick={() => onNavigate(row.path)}
              title={row.path}
            >
              <button
                type="button"
                className={`flex-shrink-0 w-4 h-4 flex items-center justify-center ${
                  expandable && hasChildren
                    ? 'text-zinc-600 hover:text-zinc-400'
                    : 'text-transparent pointer-events-none'
                }`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (!expandable) return;
                  onToggleExpand(row.path);
                }}
                tabIndex={expandable && hasChildren ? 0 : -1}
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
                    ? 'text-zinc-500'
                    : isSelected
                      ? 'text-zinc-400'
                      : 'text-zinc-600 group-hover:text-zinc-500'
                }`}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.5}
                viewBox="0 0 24 24"
                aria-hidden
              >
                {row.isSymlink ? (
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

              <span className="ml-1.5 min-w-0 flex-1 truncate text-xs leading-none">
                {row.isRoot ? '/' : row.name}
              </span>

              {isError && (
                <button
                  type="button"
                  className="flex-shrink-0 text-[10px] text-zinc-500 hover:text-red-400 px-1"
                  title={entry?.error ?? '加载失败'}
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
