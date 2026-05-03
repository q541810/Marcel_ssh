import { useEffect, useCallback, type ReactNode } from 'react';

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
}

export default function Modal({ open, onClose, title, children }: Props) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open) {
        onClose();
      }
    },
    [open, onClose],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Content */}
      <div className="relative w-full max-w-lg mx-4 rounded-2xl bg-zinc-800 border border-zinc-700 shadow-2xl">
        {/* Header */}
        {title && (
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-700">
            <h2 className="text-lg font-semibold text-zinc-100">{title}</h2>
            <button
              onClick={onClose}
              className="text-zinc-400 hover:text-zinc-200 text-xl leading-none"
              aria-label="关闭"
            >
              &times;
            </button>
          </div>
        )}

        {/* Body */}
        <div className={title ? '' : 'pt-4'}>{children}</div>
      </div>
    </div>
  );
}
