import { useEffect, useLayoutEffect, useRef, useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAnimatedPresence } from '@/hooks/useAnimatedPresence';
import { registerBackHandler } from '../backHandler';
import { createSheetMotion } from '../sheetMotion';

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

/**
 * Bottom sheet for the mobile shell: full-width, rises from the bottom,
 * safe-area aware, swipe-down on the grab handle to dismiss.
 *
 * 所有进出都归 sheetMotion.ts 一个人管：打开、点「关闭」、点遮罩、拖横条下拉、
 * 系统返回手势——同一套弹簧，从当前位置、带着当前速度「老老实实」沿来路收回去，
 * 背后的遮罩跟着面板位置变暗/变亮。这里只负责把触摸事件交给它。
 */
export default function MobileSheet({
  open,
  onClose,
  children,
  title,
  maxHeightClassName = 'max-h-[min(85dvh,calc(100dvh-var(--ime-bottom,0px)))]',
  dismissible = true,
  footer,
}: MobileSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStartYRef = useRef<number | null>(null);
  const capturedPointerIdRef = useRef<number | null>(null);
  const presence = useAnimatedPresence(open);
  const [motion] = useState(() =>
    createSheetMotion(
      () => sheetRef.current,
      () => backdropRef.current,
    ),
  );

  // Open: rise into place. Close (any way): sink back, the backdrop clearing with it.
  // Runs before paint, so the CSS entrance / exit never shows a frame.
  const mounted = presence.mounted;
  useLayoutEffect(() => {
    if (!mounted) return;
    if (open) motion.enter();
    else motion.exit();
  }, [open, mounted, motion]);
  useEffect(() => {
    if (!mounted) return;
    return () => motion.dispose();
  }, [mounted, motion]);

  // Reset any in-flight drag when closed.
  useEffect(() => {
    if (!open) {
      dragStartYRef.current = null;
      capturedPointerIdRef.current = null;
    }
  }, [open]);

  // Keep the focused input visible when the scroll area resizes (the IME
  // opening shrinks it): the browser does not always scroll the focused
  // field back into view after such a layout jump.
  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      const active = document.activeElement;
      if (active instanceof HTMLElement && el.contains(active)) {
        active.scrollIntoView({ block: 'nearest' });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);

  // Android back gesture: dismissible sheets close; modal sheets still
  // consume the press (no-op) so the system doesn't finish the activity
  // out from under a mandatory interaction.
  //
  // onClose goes through a ref so an unstable callback identity doesn't
  // re-register the layer: that would reshuffle the back stack and, mid
  // predictive-back gesture, drop the in-flight preview.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    if (!dismissible) return registerBackHandler(() => {});
    return registerBackHandler(() => onCloseRef.current(), motion.preview);
  }, [open, dismissible, motion]);

  const releasePointer = useCallback(() => {
    dragStartYRef.current = null;
    if (capturedPointerIdRef.current != null && sheetRef.current) {
      try {
        sheetRef.current.releasePointerCapture(capturedPointerIdRef.current);
      } catch {
        /* pointer already released */
      }
      capturedPointerIdRef.current = null;
    }
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!dismissible || e.pointerType !== 'touch') return;
      const el = sheetRef.current;
      if (!el) return;
      // Apple §2：setPointerCapture 确保指针离开元素后仍能跟踪
      el.setPointerCapture(e.pointerId);
      capturedPointerIdRef.current = e.pointerId;
      dragStartYRef.current = e.clientY;
    },
    [dismissible],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragStartYRef.current == null) return;
      motion.drag.move(e.clientY - dragStartYRef.current);
    },
    [motion],
  );

  const handlePointerUp = useCallback(() => {
    if (dragStartYRef.current == null) return;
    releasePointer();
    // 位置 + 松手速度推算落点决定关还是弹回（Apple §6）；关的飞行已经在播了。
    if (motion.drag.end() === 'close') onCloseRef.current();
  }, [motion, releasePointer]);

  const handlePointerCancel = useCallback(() => {
    releasePointer();
    motion.drag.cancel();
  }, [motion, releasePointer]);

  if (!presence.mounted) return null;
  const exiting = presence.phase === 'exit';

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <div
        ref={backdropRef}
        className={`absolute inset-0 bg-black/60 ${
          exiting ? 'mobile-backdrop-exit' : 'mobile-backdrop-enter'
        }`}
        onClick={dismissible ? onClose : undefined}
      />
      <div
        ref={sheetRef}
        onAnimationEnd={presence.onAnimationEnd}
        className={`relative flex w-full flex-col rounded-t-2xl border-t border-edge-subtle bg-surface shadow-overlay ${
          exiting ? 'mobile-sheet-exit' : 'mobile-sheet-enter'
        } ${maxHeightClassName}`}
        style={{
          marginBottom: 'var(--ime-bottom, 0px)',
          paddingBottom:
            'max(env(safe-area-inset-bottom, 0px), var(--nav-bar-bottom, 0px))',
        }}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="flex flex-shrink-0 flex-col items-stretch touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
        >
          <div className="flex justify-center pb-1 pt-2" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-edge-strong" />
          </div>
          {title != null && (
            <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-1">
              <div className="min-w-0 flex-1 text-title text-fg">
                {title}
              </div>
              {dismissible && (
                <button
                  type="button"
                  onClick={onClose}
                  className="-mr-2 flex items-center rounded-lg px-3 text-caption text-fg-secondary pressable active:bg-state-soft hit-area"
                >
                  关闭
                </button>
              )}
            </div>
          )}
        </div>
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {children}
        </div>
        {footer != null && (
          <div className="flex-shrink-0 border-t border-edge-subtle px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
