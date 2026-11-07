import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';

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
      <div className="flex items-center justify-between px-3 py-2">
        <h2 className="text-meta font-semibold text-fg-secondary uppercase tracking-wider">
          {title}
        </h2>
        {onAdd && (
          <button
            onClick={onAdd}
            className="pressable focus-ring flex h-6 w-6 items-center justify-center rounded-md text-fg-secondary hover:bg-state-soft hover:text-fg"
            title={addButtonTitle}
            aria-label={addButtonTitle}
          >
            <Plus size={16} strokeWidth={1.5} />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="px-2 pb-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="w-full h-7 rounded-lg bg-field border border-edge px-3 text-body text-fg placeholder:text-fg-tertiary focus:outline-none focus:border-indigo-500 transition-colors duration-120"
        />
      </div>

      {/* Status */}
      {status && (
        <div className="px-3 py-1.5 text-meta text-fg-tertiary">
          {status}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-2">{children}</div>
    </div>
  );
}
