import type { ReactNode } from 'react';

interface ListPanelProps {
  title: string;
  onAdd?: () => void;
  addButtonTitle?: string;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchPlaceholder?: string;
  status?: ReactNode;
  children: ReactNode;
  /** Forwarded to the root div (e.g. `data-region`). */
  [key: string]: unknown;
}

export default function ListPanel({
  title,
  onAdd,
  addButtonTitle = `新建${title}`,
  searchQuery,
  onSearchChange,
  searchPlaceholder = '搜索...',
  status,
  children,
  ...rest
}: ListPanelProps) {
  return (
    <div {...rest} className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800">
        <h2 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
          {title}
        </h2>
        {onAdd && (
          <button
            onClick={onAdd}
            className="p-1 rounded-lg hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 transition-colors"
            title={addButtonTitle}
            aria-label={addButtonTitle}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 4v16m8-8H4"
              />
            </svg>
          </button>
        )}
      </div>

      {/* Search */}
      <div className="p-2 border-b border-zinc-800">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full rounded-lg bg-zinc-800 border border-zinc-700 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-indigo-500"
        />
      </div>

      {/* Status */}
      {status && (
        <div className="px-3 py-1.5 border-b border-zinc-800/50 text-xs text-zinc-500">
          {status}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2">{children}</div>
    </div>
  );
}
