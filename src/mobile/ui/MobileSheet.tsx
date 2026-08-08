import { useEffect, useRef, useCallback, type ReactNode } from 'react';
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

const CLOSE_POSITION_THRESHOLD_PX = 72;
const CLOSE_VELOCITY_THRESHOLD_PX_S = 500;
const RUBBERBAND_DIMENSION = 300;
const RUBBERBAND_CONSTANT = 0.55;
const VELOCITY_HISTORY_MAX = 5;

/**
 * 渐进阻力：超出边界越远，跟随越少（Apple §9 橡皮筋效果）。
 * dimension 越大，前期阻力越小；constant 控制曲线斜率。
 */
function rubberband(
  overshoot: number,
  dimension: number,
  constant = RUBBERBAND_CONSTANT,
): number {
  return (
    (overshoot * dimension * constant) /
    (dimension + constant * Math.abs(overshoot))
  );
}

/**
 * Bottom sheet for the mobile shell: full-width, slides from the bottom,
 * safe-area aware, swipe-down on the grab handle to dismiss.
 *
 * Improvements over touch events:
 * - Pointer Events + setPointerCapture（Apple §2 直接操控：1:1 跟随）
 * - 橡皮筋渐进阻力（Apple §9）
 * - 速度采样 + 动量推算决定关闭/回弹（Apple §5, §6）
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragStartYRef = useRef<number | null>(null);
  const dragDeltaRef = useRef(0);
  const velocitySamplesRef = useRef<Array<{ y: number; t: number }>>([]);
  const capturedPointerIdRef = useRef<number | null>(null);
  const presence = useAnimatedPresence(open);

  // Reset any in-flight drag when closed.
  useEffect(() => {
    if (!open) {
      dragStartYRef.current = null;
      dragDeltaRef.current = 0;
      velocitySamplesRef.current = [];
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
  useEffect(() => {
    if (!open) return;
    return registerBackHandler(dismissible ? onClose : () => {});
  }, [open, dismissible, onClose]);

  const applyDragOffset = useCallback((rawDelta: number) => {
    const el = sheetRef.current;
    if (!el) return;
    // 只允许向下拖
    if (rawDelta <= 0) {
      dragDeltaRef.current = 0;
      el.style.transform = '';
      el.style.transition = '';
      return;
    }
    // 橡皮筋：渐进阻力，而非 1:1
    const dampened = rubberband(rawDelta, RUBBERBAND_DIMENSION);
    dragDeltaRef.current = dampened;
    el.style.transform = `translateY(${dampened}px)`;
    el.style.transition = 'none';
  }, []);

  const snapBack = useCallback(() => {
    const el = sheetRef.current;
    if (!el) return;
    el.style.transition =
      'transform 300ms cubic-bezier(0.22, 1, 0.36, 1)';
    el.style.transform = '';
  }, []);

  const cleanupDrag = useCallback(() => {
    dragStartYRef.current = null;
    dragDeltaRef.current = 0;
    velocitySamplesRef.current = [];
    if (capturedPointerIdRef.current != null && sheetRef.current) {
      try {
        sheetRef.current.releasePointerCapture(capturedPointerIdRef.current);
      } catch {
        /* pointer already released */
      }
      capturedPointerIdRef.current = null;
    }
  }, []);

  /** 计算释放时的瞬时速度（px/s），基于最近几次采样。 */
  const computeReleaseVelocity = useCallback((): number => {
    const samples = velocitySamplesRef.current;
    if (samples.length < 2) return 0;
    const last = samples[samples.length - 1];
    const first = samples[0];
    const dt = last.t - first.t;
    if (dt <= 0) return 0;
    return (last.y - first.y) / (dt / 1000); // px/s
  }, []);

  const endDrag = useCallback(() => {
    const el = sheetRef.current;
    const delta = dragDeltaRef.current;
    const velocity = computeReleaseVelocity();
    cleanupDrag();
    if (!el) return;

    if (!dismissible) {
      snapBack();
      return;
    }

    // Apple §6：速度符号决定方向，不仅看位置。
    // 位置超过阈值 或 速度超过阈值 → 关闭；否则弹回。
    if (
      delta > CLOSE_POSITION_THRESHOLD_PX ||
      velocity > CLOSE_VELOCITY_THRESHOLD_PX_S
    ) {
      // 保持当前拖拽偏移，退出动画从这里继续（Apple §3 可中断性）
      onClose();
      return;
    }

    snapBack();
  }, [dismissible, onClose, computeReleaseVelocity, cleanupDrag, snapBack]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!dismissible || e.pointerType !== 'touch') return;
      const el = sheetRef.current;
      if (!el) return;
      // Apple §2：setPointerCapture 确保指针离开元素后仍能跟踪
      el.setPointerCapture(e.pointerId);
      capturedPointerIdRef.current = e.pointerId;
      dragStartYRef.current = e.clientY;
      dragDeltaRef.current = 0;
      velocitySamplesRef.current = [{ y: e.clientY, t: e.timeStamp }];
    },
    [dismissible],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragStartYRef.current == null) return;
      const delta = e.clientY - dragStartYRef.current;
      // 记录速度采样（Apple §2：保留速度/位置历史）
      const samples = velocitySamplesRef.current;
      samples.push({ y: e.clientY, t: e.timeStamp });
      if (samples.length > VELOCITY_HISTORY_MAX) samples.shift();
      applyDragOffset(delta);
    },
    [applyDragOffset],
  );

  const handlePointerUp = useCallback(() => {
    endDrag();
  }, [endDrag]);

  const handlePointerCancel = useCallback(() => {
    snapBack();
    cleanupDrag();
  }, [snapBack, cleanupDrag]);

  if (!presence.mounted) return null;
  const exiting = presence.phase === 'exit';

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
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
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
