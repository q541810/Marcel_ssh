import { useState } from 'react';

interface PathBreadcrumbProps {
  currentPath: string;
  onNavigate: (path: string) => void;
}

export default function PathBreadcrumb({ currentPath, onNavigate }: PathBreadcrumbProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState('');

  const pathParts = currentPath.split('/').filter(Boolean);

  if (editing) {
    return (
      <input
        type="text"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const p = editValue.trim() || '/';
            setEditing(false);
            onNavigate(p);
          }
          if (e.key === 'Escape') setEditing(false);
        }}
        onBlur={() => {
          const p = editValue.trim() || '/';
          setEditing(false);
          if (p !== currentPath) onNavigate(p);
        }}
        className="flex-1 rounded-md bg-zinc-800 border border-zinc-700 px-2 py-0.5 text-xs text-zinc-100 outline-none focus:border-indigo-500 font-mono"
        autoFocus
      />
    );
  }

  return (
    <div
      className="flex-1 flex items-center gap-0.5 text-xs text-zinc-400 overflow-x-auto whitespace-nowrap cursor-text rounded-md px-2 py-0.5 hover:bg-zinc-800 transition-colors"
      onClick={() => {
        setEditValue(currentPath);
        setEditing(true);
      }}
      title="点击编辑路径"
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onNavigate('/');
        }}
        className="text-zinc-400 hover:text-indigo-400 transition-colors px-0.5"
        title="根目录"
      >
        /
      </button>
      {pathParts.map((part, i) => (
        <span key={i} className="flex items-center">
          <span className="text-zinc-600">&gt;</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onNavigate('/' + pathParts.slice(0, i + 1).join('/'));
            }}
            className="hover:text-indigo-400 transition-colors px-1"
          >
            {part}
          </button>
        </span>
      ))}
    </div>
  );
}
