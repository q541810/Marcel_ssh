import { useEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      /**
       * 软键盘适配：Android 侧不会为 IME resize 窗口，只把键盘高度写进
       * `--ime-bottom`（挂在 documentElement 上，所以 portal 出去也读得到）。
       * 这里让出键盘占的高度、并把面板最大高度压进剩余空间，否则键盘一弹起就会
       * 盖住输入框和按钮——移动端连接时输私钥密码走的正是这个浮层。
       */
      style={{ paddingBottom: 'var(--ime-bottom, 0px)' }}
    >
      {/* Backdrop */}
      <div
        className={`absolute inset-0 bg-black/50 ${
          exiting ? 'modal-backdrop-exit' : 'modal-backdrop-enter'
        }`}
        onClick={dismissible ? onClose : undefined}
      />

      {/* Content */}
      <div
        role="dialog"
        aria-modal="true"
        onAnimationEnd={presence.onAnimationEnd}
        className={`relative w-full mx-4 rounded-2xl surface-glass max-h-[min(90vh,calc(100dvh-var(--ime-bottom,0px)-2rem))] flex flex-col ${
          exiting ? 'modal-panel-exit' : 'modal-panel-enter'
        } ${SIZE_CLASSES[size]} ${contentClassName}`}
      >
        {/* Header */}
        {title && (
          <div className="flex items-center justify-between px-4 py-3 flex-shrink-0">
            <h2 className="text-title text-fg">{title}</h2>
            {dismissible && (
              <button
                onClick={onClose}
                className="pressable focus-ring flex h-6 w-6 items-center justify-center rounded-md text-fg-secondary hover:bg-state-soft hover:text-fg"
                aria-label="关闭"
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            )}
          </div>
        )}

        {/* Body：表单变高时可滚动，避免跳板等区块把密码/按钮裁切掉 */}
        <div
          className={`${title ? '' : 'pt-4'} ${
            size === 'xl'
              ? 'flex-1 overflow-hidden flex flex-col min-h-0'
              : 'overflow-y-auto min-h-0'
          }`}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}
