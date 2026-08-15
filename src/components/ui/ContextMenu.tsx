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
      className="win-flyout win-flyout-enter fixed z-50 py-1 min-w-32"
      style={{ top: y, left: x }}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((item, idx) =>
        item.divider ? (
          <hr key={idx} className="win-menu-divider" />
        ) : (
          <button
            key={idx}
            onClick={() => {
              item.onClick();
              onClose();
            }}
            className={`win-menu-item ${item.variant === 'danger' ? 'win-menu-item--danger' : ''}`}
          >
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}
