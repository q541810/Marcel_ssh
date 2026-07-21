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
        className="min-w-0 flex-1 rounded-lg border border-indigo-500 bg-zinc-800 px-3 py-1.5 font-mono text-sm text-zinc-100 outline-none"
        autoFocus
      />
    );
  }

  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <div
        ref={scrollRef}
        className="flex min-w-0 flex-1 items-center overflow-x-auto whitespace-nowrap rounded-lg bg-zinc-900/60 px-1 py-0.5 [scrollbar-width:none]"
      >
        <button
          type="button"
          onClick={() => onNavigate('/')}
          className={`flex-shrink-0 rounded-md px-2.5 py-1.5 font-mono text-sm active:bg-zinc-800 ${
            pathParts.length === 0
              ? 'font-semibold text-zinc-100'
              : 'text-zinc-400'
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
                className={`rounded-md px-2 py-1.5 font-mono text-sm active:bg-zinc-800 ${
                  isLast ? 'font-semibold text-zinc-100' : 'text-zinc-400'
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
        className="flex-shrink-0 rounded-md px-2 py-1.5 text-xs text-zinc-500 active:bg-zinc-800"
        aria-label="编辑路径"
      >
        编辑
      </button>
    </div>
  );
}
