import type { ReactNode } from 'react';
import WinIcon from '@/components/ui/WinIcon';

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
            className="win-icon-btn win-icon-btn--sm"
            title={addButtonTitle}
            aria-label={addButtonTitle}
          >
            <WinIcon glyph="add" size={16} />
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
          className="win-input"
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
