import { useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import WinIcon from '@/components/ui/WinIcon';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';

type ModalSize = 'sm' | 'md' | 'lg' | 'xl';

const SIZE_CLASSES: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl h-[80vh] flex flex-col',
};

interface Props {
  open: boolean;
  onClose: () => void;
  title?: string;
  size?: ModalSize;
  children: ReactNode;
  /** When false, block backdrop / Escape / header close (e.g. mandatory disclaimer). Default true. */
  dismissible?: boolean;
  /** Extra classes appended to the content panel (e.g. `!max-w-[340px]`). */
  contentClassName?: string;
}

export default function Modal({
  open,
  onClose,
  title,
  size = 'md',
  children,
  dismissible = true,
  contentClassName = '',
}: Props) {
  const presence = useAnimatedPresence(open);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open && dismissible) {
        onClose();
      }
    },
    [open, onClose, dismissible],
  );

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  if (!presence.mounted) return null;
  const exiting = presence.phase === 'exit';

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/30 backdrop-blur-sm ${exiting ? 'win-dialog-backdrop-exit' : 'win-dialog-backdrop-enter'}`}
        onClick={dismissible ? onClose : undefined}
      />

      {/* Content */}
      <div
        role="dialog"
        aria-modal="true"
        onAnimationEnd={presence.onAnimationEnd}
        className={`win-dialog relative w-full mx-4 max-h-[90vh] flex flex-col ${exiting ? 'win-dialog-exit' : 'win-dialog-enter'} ${SIZE_CLASSES[size]} ${contentClassName}`}
      >
        {/* Header */}
        {title && (
          <div className="win-dialog-header flex items-center justify-between px-5 py-4 flex-shrink-0">
            <h2 className="win-dialog-title">{title}</h2>
            {dismissible && (
              <button
                onClick={onClose}
                className="win-icon-btn win-icon-btn--sm"
                aria-label="关闭"
              >
                <WinIcon glyph="close" size={14} />
              </button>
            )}
          </div>
        )}

        {/* Body：表单变高时可滚动，避免跳板块把密码/按钮裁剪掉 */}
        <div
          className={`${title ? '' : 'pt-4'} ${size === 'xl' ? 'flex-1 overflow-hidden flex flex-col min-h-0' : 'overflow-y-auto min-h-0'}`}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
