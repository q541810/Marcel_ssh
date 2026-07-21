import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import { registerBackHandler } from '../backHandler';

interface MobileSheetProps {
  open: boolean;
  onClose: () => void;
  /** Sheet body. Rendered inside a scrollable area capped to maxHeight. */
  children: ReactNode;
  title?: ReactNode;
  /** Tailwind max-height class for the sheet, default 85dvh. */
  maxHeightClassName?: string;
  /** Allow tapping backdrop / swiping down to dismiss. Default true. */
  dismissible?: boolean;
  /** Optional footer pinned below the scroll area (action buttons). */
  footer?: ReactNode;
}

const SWIPE_CLOSE_THRESHOLD_PX = 72;

/**
 * Bottom sheet for the mobile shell: full-width, slides from the bottom,
 * safe-area aware, swipe-down on the grab handle to dismiss.
 */
export default function MobileSheet({
  open,
  onClose,
  children,
  title,
  maxHeightClassName = 'max-h-[85dvh]',
  dismissible = true,
  footer,
}: MobileSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragDeltaRef = useRef(0);
  const presence = useAnimatedPresence(open);

  // Reset any in-flight drag when closed.
  useEffect(() => {
    if (!open) {
      dragStartYRef.current = null;
      dragDeltaRef.current = 0;
    }
  }, [open]);

  // Android back gesture: dismissible sheets close; modal sheets still
  // consume the press (no-op) so the system doesn't finish the activity
  // out from under a mandatory interaction.
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(dismissible ? onClose : () => {});
  }, [open, dismissible, onClose]);

  if (!presence.mounted) return null;
  const exiting = presence.phase === 'exit';

  const setDragOffset = (offset: number) => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transform = offset > 0 ? `translateY(${offset}px)` : '';
    el.style.transition = 'none';
  };

  const endDrag = () => {
    const el = sheetRef.current;
    const delta = dragDeltaRef.current;
    dragStartYRef.current = null;
    dragDeltaRef.current = 0;
    if (!el) return;
    el.style.transition = '';
    if (dismissible && delta > SWIPE_CLOSE_THRESHOLD_PX) {
      // Keep the dragged offset; the exit animation picks up from the
      // current position instead of snapping back to 0 first.
      onClose();
      return;
    }
    el.style.transform = '';
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div
        className={`absolute inset-0 bg-black/60 ${
          exiting ? 'mobile-backdrop-exit' : 'mobile-backdrop-enter'
        }`}
        onClick={dismissible ? onClose : undefined}
      />
      <div
        ref={sheetRef}
        onAnimationEnd={presence.onAnimationEnd}
        className={`relative flex w-full flex-col rounded-t-2xl border-t border-zinc-700 bg-zinc-900 shadow-2xl ${
          exiting ? 'mobile-sheet-exit' : 'mobile-sheet-enter'
        } ${maxHeightClassName}`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="flex flex-shrink-0 flex-col items-stretch"
          onTouchStart={(e) => {
            if (!dismissible || e.touches.length !== 1) return;
            dragStartYRef.current = e.touches[0].clientY;
            dragDeltaRef.current = 0;
          }}
          onTouchMove={(e) => {
            if (dragStartYRef.current == null) return;
            const delta = e.touches[0].clientY - dragStartYRef.current;
            dragDeltaRef.current = delta;
            setDragOffset(delta);
          }}
          onTouchEnd={endDrag}
          onTouchCancel={endDrag}
        >
          <div className="flex justify-center pb-1 pt-2" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-zinc-600" />
          </div>
          {title != null && (
            <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-1">
              <div className="min-w-0 flex-1 text-sm font-semibold text-zinc-100">
                {title}
              </div>
              {dismissible && (
                <button
                  type="button"
                  onClick={onClose}
                  className="-mr-1 rounded-lg px-2 py-1 text-xs text-zinc-400 active:bg-zinc-800"
                >
                  关闭
                </button>
              )}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {children}
        </div>
        {footer != null && (
          <div className="flex-shrink-0 border-t border-zinc-800 px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
