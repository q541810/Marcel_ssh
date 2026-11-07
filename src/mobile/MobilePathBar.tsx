import { useEffect, useRef, useState } from 'react';

interface MobilePathBarProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

/**
 * Touch-first path bar: big tap targets per segment, auto-scrolls to the
 * current directory, long-press free edit via a dedicated edit button.
 */
export default function MobilePathBar({
  currentPath,
  onNavigate,
}: MobilePathBarProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const pathParts = currentPath.split('/').filter(Boolean);

  // Keep the deepest segment visible.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [currentPath]);

  const commitEdit = () => {
    const p = editValue.trim() || '/';
    setEditing(false);
    if (p !== currentPath) onNavigate(p);
  };

  if (editing) {
    return (
      <input
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commitEdit();
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={commitEdit}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        className="min-w-0 flex-1 rounded-lg border-indigo-500 field px-3 py-1.5 font-mono text-body text-fg"
        autoFocus
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div
        ref={scrollRef}
        className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap rounded-lg bg-surface/60 px-1 py-0.5 [scrollbar-width:none]"
      >
        <button
          type="button"
          onClick={() => onNavigate('/')}
          className={`flex-shrink-0 rounded-md px-2.5 py-1.5 font-mono text-body active:bg-state-soft ${
            pathParts.length === 0
              ? 'font-semibold text-fg'
              : 'text-fg-secondary'
          }`}
        >
          /
        </button>
        {pathParts.map((part, i) => {
          const isLast = i === pathParts.length - 1;
          return (
            <span key={i} className="flex flex-shrink-0 items-center">
              {i > 0 && <span className="text-zinc-700">/</span>}
              <button
                type="button"
                onClick={() =>
                  onNavigate('/' + pathParts.slice(0, i + 1).join('/'))
                }
                className={`rounded-md px-2 py-1.5 font-mono text-body active:bg-state-soft ${
                  isLast ? 'font-semibold text-fg' : 'text-fg-secondary'
                }`}
              >
                {part}
              </button>
            </span>
          );
        })}
      </div>
      <button
        type="button"
        onClick={() => {
          setEditValue(currentPath);
          setEditing(true);
        }}
        className="flex-shrink-0 rounded-md px-2 py-1.5 text-meta text-fg-tertiary active:bg-state-soft"
        aria-label="编辑路径"
      >
        编辑
      </button>
    </div>
  );
}
