import { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'danger';
  divider?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export default function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  useEffect(() => {
    window.addEventListener('click', onClose);
    return () => window.removeEventListener('click', onClose);
  }, [onClose]);

  return createPortal(
    <div
      role="menu"
      className="context-menu-enter fixed z-50 bg-zinc-800 border border-zinc-700 rounded-xl shadow-lg py-1 min-w-32"
      style={{ top: y, left: x }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, idx) =>
        item.divider ? (
          <hr key={idx} className="border-zinc-700 my-1" />
        ) : (
          <button
            key={idx}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`w-full text-left px-3 py-1.5 text-sm hover:bg-zinc-700 transition-colors ${
              item.variant === 'danger' ? 'text-red-400' : 'text-zinc-200'
            }`}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
